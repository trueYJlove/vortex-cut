/**
 * 时间线抽帧 worker（filmstrip）：共享合成预览的 BMFF demux + Range 字节源
 * 底层件（bmff-demux / sample-index / range-source），协议按缩略图语义设计
 * ——与 preview/decode-worker.worker.ts 的差异：
 *  - 按微秒寻址（decode-at {timeUs}），定位"最近采样"且**无容差拒绝**——
 *    抽帧格本就按 56px 档位量化，取相邻解码帧视觉等价，33ms 级容差判定
 *    只会把长 GOP 素材的合法请求变成失败。
 *  - worker 内 createImageBitmap 缩到 ≤160px 宽回传（transferable）——
 *    全分辨率 VideoFrame 不出 worker，主线程零缩放开销。
 *  - 无帧缓存（缩略图自身有 canvas LRU）；串行 decode-at 队列一次一个，
 *    与预览 worker 相同的串行约束（单解码器状态机）。
 * 解码器状态机复刻 decode-worker.worker.ts 的实证纪律：GOP 锚帧持有、
 * 中间帧延迟关闭环（D3D11 表面池复用竞态）、冷启整例重建（reset 残留花屏）。
 */

import { buildSampleIndex, keyframeAtOrBefore, locateByPts, type SampleIndex } from "../preview/sample-index.js";
import { demuxRange, type DemuxResult, type DemuxSample } from "../preview/bmff-demux.js";
import { HttpRangeSource, type RangeSource } from "../preview/range-source.js";

export type FilmstripInbound =
  | { type: "init"; url: string; refreshTicket: boolean }
  | { type: "decode-at"; id: number; timeUs: number }
  | { type: "ticket-refresh-response"; id: number; refreshUrl?: string; refreshError?: string }
  | { type: "close" };

export type FilmstripOutbound =
  | { type: "ready"; width: number; height: number; durationUs: number; sampleCount: number; hardware: string | null }
  | { type: "bitmap"; id: number; timeUs: number; bitmap: ImageBitmap; width: number; height: number }
  | { type: "error"; id: number | null; message: string }
  | { type: "ticket-refresh-request"; id: number };

const post = (message: FilmstripOutbound, transfer: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(message, transfer);
};

/** 抽帧格宽档位上限（与 TimelineCanvas 绘制消费一致，per-frame ≈57KB）。 */
export const FILMSTRIP_MAX_WIDTH = 160;

let demuxResult: DemuxResult | null = null;
let sampleIndex: SampleIndex | null = null;
let rangeSource: RangeSource | null = null;
let decoder: VideoDecoder | null = null;
let decoderConfig: VideoDecoderConfig | null = null;
let hardware: string | null = null;

/** 解码请求串行队列（一次一个；同 decode-worker.worker.ts 的约束）。 */
interface DecodeRequest { id: number; timeUs: number; sample: number }
const decodeQueue: DecodeRequest[] = [];
let activeRequest: DecodeRequest | null = null;
let fedIndex = -1;
let ptsCursor = -1;

const intermediateRing: VideoFrame[] = [];
const INTERMEDIATE_RING = 3;
let gopAnchor: VideoFrame | null = null;
let pendingAnchorPts = -1;

function holdOrCloseIntermediate(frame: VideoFrame): void {
  if (intermediateRing.length >= INTERMEDIATE_RING) {
    const oldest = intermediateRing.shift();
    if (oldest) oldest.close();
  }
  intermediateRing.push(frame);
}

function drainIntermediateRing(): void {
  for (const frame of intermediateRing.splice(0)) frame.close();
}

function holdGopAnchor(frame: VideoFrame): void {
  try { gopAnchor?.close(); } catch { /* 已关闭 */ }
  gopAnchor = frame;
}

function releaseGopAnchor(): void {
  try { gopAnchor?.close(); } catch { /* 已关闭 */ }
  gopAnchor = null;
  pendingAnchorPts = -1;
}

/** worker 内等比缩放：目标宽 ≤ FILMSTRIP_MAX_WIDTH（源更窄则原样）。 */
export function bitmapSizeFor(width: number, height: number): { resizeWidth: number; resizeHeight: number } {
  if (width <= 0 || height <= 0) return { resizeWidth: Math.max(2, width), resizeHeight: Math.max(2, height) };
  if (width <= FILMSTRIP_MAX_WIDTH) return { resizeWidth: width, resizeHeight: height };
  const scale = FILMSTRIP_MAX_WIDTH / width;
  return { resizeWidth: FILMSTRIP_MAX_WIDTH, resizeHeight: Math.max(2, Math.round(height * scale)) };
}

function createDecoder(): VideoDecoder {
  return new VideoDecoder({
    output: (frame: VideoFrame) => {
      const request = activeRequest;
      // 命中判定用半帧容差（±16_667µs），同 decode-worker.worker.ts：WebCodecs
      // 把 EncodedVideoChunk 时间戳截为整数微秒，浮点严格相等永远失配——输出
      // 会全部落进中间帧环被关闭，请求挂到超时（dev 验收实证：每帧 15s 超时
      // → 抽帧全空）。缩略图容差语义本就宽松（相邻帧视觉等价）。
      if (request && Math.abs(frame.timestamp - requestTargetPts(request)) <= 16_667) {
        activeRequest = null;
        pendingAnchorPts = -1;
        void deliverFrame(request, frame);
      } else if (pendingAnchorPts >= 0 && Math.abs(frame.timestamp - pendingAnchorPts) <= 16_667) {
        pendingAnchorPts = -1;
        holdGopAnchor(frame);
      } else {
        holdOrCloseIntermediate(frame);
      }
    },
    error: (error: DOMException) => {
      const request = activeRequest;
      activeRequest = null;
      try {
        decoder!.reset();
        decoder!.configure(decoderConfig as VideoDecoderConfig);
      } catch { /* reset 失败则后续请求自行暴露 */ }
      drainIntermediateRing();
      fedIndex = -1;
      post({ type: "error", id: request?.id ?? null, message: `decoder error: ${error.message}` });
      pumpQueue();
    },
  });
}

/** 请求目标采样的输出 PTS（µs）——输出回调匹配键。 */
function requestTargetPts(request: DecodeRequest): number {
  const sample = demuxResult!.samples[request.sample]!;
  return ((sample.dts + sample.ctsOffset) / demuxResult!.timescale) * 1e6;
}

async function deliverFrame(request: DecodeRequest, frame: VideoFrame): Promise<void> {
  try {
    const size = bitmapSizeFor(frame.displayWidth, frame.displayHeight);
    const bitmap = await createImageBitmap(frame, {
      resizeWidth: size.resizeWidth,
      resizeHeight: size.resizeHeight,
      resizeQuality: "low",
    });
    post({ type: "bitmap", id: request.id, timeUs: request.timeUs, bitmap, width: bitmap.width, height: bitmap.height }, [bitmap]);
  } catch (error) {
    post({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
  } finally {
    frame.close();
    pumpQueue();
  }
}

function pumpQueue(): void {
  while (!activeRequest && decodeQueue.length) {
    const request = decodeQueue.shift()!;
    activeRequest = request;
    try {
      decodeSamples(request);
    } catch (error) {
      activeRequest = null;
      post({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** 解码计划（纯函数，导出供单测）：
 *  - 热态顺序：目标在已馈送位置之后且同 GOP → 从 fedIndex+1 顺序喂到
 *    target。中间参考帧必须逐个喂入——P/B 帧参考链断链时解码器按错误
 *    参考做错误隐藏，产出"时间戳对、内容错"的帧（缩略格间跳 ~14 采样
 *    @30fps，只喂目标帧即肉眼可见的内容错位，2026-09-23 问题1根因）。
 *  - 跨关键帧或回退（倒放/seek/换格回头）：关键帧冷启整例重建（实证纪律）。 */
export function planDecodeRange(
  index: SampleIndex,
  fedIndex: number,
  target: number,
): { startSample: number; sequential: boolean } {
  let sequential = fedIndex >= 0 && target > fedIndex;
  if (sequential) {
    sequential = keyframeAtOrBefore(index, fedIndex) === keyframeAtOrBefore(index, target);
  }
  return sequential
    ? { startSample: fedIndex + 1, sequential: true }
    : { startSample: keyframeAtOrBefore(index, target), sequential: false };
}

function decodeSamples(request: DecodeRequest): void {
  if (!demuxResult || !decoder || !rangeSource || !sampleIndex) throw new Error("worker not initialized");
  const { samples, timescale } = demuxResult;
  const plan = planDecodeRange(sampleIndex, fedIndex, request.sample);
  if (!plan.sequential) {
    releaseGopAnchor();
    drainIntermediateRing();
    try { decoder.close(); } catch { /* 已关闭 */ }
    decoder = createDecoder();
    decoder.configure(decoderConfig as VideoDecoderConfig);
    fedIndex = -1;
    pendingAnchorPts = ((samples[plan.startSample]!.dts + samples[plan.startSample]!.ctsOffset) / timescale) * 1e6;
  }
  void feedSamples(samples, plan.startSample, request.sample, timescale, request);
}

/** 喂包区间 [startSample, target] 闭区间：顺序路径从 fedIndex+1 补齐中间
 *  参考帧（startSample 已含 +1），冷启路径从关键帧喂到目标。
 *  中断守卫：每包喂前确认本请求仍是 activeRequest——error 回调会 reset
 *  解码器并启动下一请求，本循环若继续喂陈旧包会污染 reset 后的解码器，
 *  且陈旧 fedIndex 会污染下一请求的顺序判定（旧实现只喂 1 包窗口极小，
 *  顺序区间补齐后窗口放大到整段跳格距离，必须显式中断）。 */
async function feedSamples(
  samples: DemuxSample[],
  startSample: number,
  target: number,
  timescale: number,
  request: DecodeRequest,
): Promise<void> {
  try {
    for (let index = startSample; index <= target; index++) {
      if (activeRequest !== request) return; // 本请求已被 error 回调终结，停止喂包
      const sample = samples[index]!;
      const chunkData = await rangeSource!.read(sample.offset, sample.size);
      if (activeRequest !== request) return; // read await 期间状态可能已翻转
      const chunk = new EncodedVideoChunk({
        type: sample.sync ? "key" : "delta",
        timestamp: ((sample.dts + sample.ctsOffset) / timescale) * 1e6,
        data: chunkData,
      });
      decoder!.decode(chunk);
      fedIndex = index;
    }
  } catch (error) {
    post({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

/** 抽帧定位（纯函数，导出供单测）：最近采样，无容差拒绝。空索引返回 -1。 */
export function nearestSampleUs(index: SampleIndex, targetUs: number): number {
  if (index.sortedPtsUs.length === 0) return -1;
  return locateByPts(index, targetUs, ptsCursor).sample;
}

async function init(url: string, hasTicketRefresh: boolean): Promise<void> {
  rangeSource = await HttpRangeSource.create(
    url, (input, init2) => fetch(input, init2), hasTicketRefresh ? requestTicketRefresh : null,
    undefined, undefined,
  );
  demuxResult = await demuxRange(rangeSource);
  sampleIndex = buildSampleIndex(demuxResult.samples, demuxResult.timescale);
  ptsCursor = -1;
  const config: VideoDecoderConfig = {
    codec: demuxResult.codec,
    codedWidth: demuxResult.width,
    codedHeight: demuxResult.height,
    description: demuxResult.avcC,
    optimizeForLatency: true,
    colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
  };
  const support = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: "prefer-hardware" });
  if (support.supported) {
    decoderConfig = { ...config, hardwareAcceleration: "prefer-hardware" };
    hardware = "prefer-hardware";
  } else {
    decoderConfig = config;
    hardware = "no-preference";
  }
  decoder = createDecoder();
  decoder.configure(decoderConfig);
  const last = demuxResult.samples.at(-1)!;
  post({
    type: "ready",
    width: demuxResult.width,
    height: demuxResult.height,
    durationUs: Math.round(((last.dts + last.ctsOffset) / demuxResult.timescale) * 1e6),
    sampleCount: demuxResult.samples.length,
    hardware,
  });
}

// 续票消息往返（同 decode-worker.worker.ts：闭包无法结构化克隆）。
const ticketRefreshPending = new Map<number, { resolve: (url: string) => void; reject: (error: Error) => void }>();
let ticketRefreshSeq = 0;
function requestTicketRefresh(): Promise<string> {
  const id = ++ticketRefreshSeq;
  return new Promise<string>((resolve, reject) => {
    ticketRefreshPending.set(id, { resolve, reject });
    post({ type: "ticket-refresh-request", id });
  });
}

function decodeAt(id: number, timeUs: number): void {
  if (!demuxResult || !decoder || !rangeSource || !sampleIndex) throw new Error("worker not initialized");
  const target = nearestSampleUs(sampleIndex, timeUs);
  if (target < 0) throw new Error(`no sample for time ${timeUs}us`);
  ptsCursor = binarySearchPos(sampleIndex, sampleIndex.ptsUs[target]!);
  decodeQueue.push({ id, timeUs, sample: target });
  pumpQueue();
}

/** 原始 PTS → 排序位置（游标更新用；二分）。 */
function binarySearchPos(index: SampleIndex, ptsUs: number): number {
  const sorted = index.sortedPtsUs;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < ptsUs) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, sorted.length - 1);
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data as FilmstripInbound;
  try {
    if (data.type === "init" && data.url) {
      void init(data.url, data.refreshTicket === true)
        .catch(error => post({ type: "error", id: null, message: error instanceof Error ? error.message : String(error) }));
    } else if (data.type === "ticket-refresh-response" && typeof (data as { id?: number }).id === "number") {
      const pending = ticketRefreshPending.get((data as { id: number }).id);
      if (!pending) return;
      ticketRefreshPending.delete((data as { id: number }).id);
      if (typeof (data as { refreshUrl?: string }).refreshUrl === "string") pending.resolve((data as { refreshUrl: string }).refreshUrl);
      else pending.reject(new Error((data as { refreshError?: string }).refreshError ?? "ticket refresh failed"));
    } else if (data.type === "decode-at" && typeof data.id === "number") {
      decodeAt(data.id, data.timeUs);
    } else if (data.type === "close") {
      rangeSource?.close();
      rangeSource = null;
    }
  } catch (error) {
    post({ type: "error", id: (data as { id?: number }).id ?? null, message: error instanceof Error ? error.message : String(error) });
  }
};
