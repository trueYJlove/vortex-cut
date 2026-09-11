/**
 * M3-0 P3 WebCodecs 寻址 Worker：手写 BMFF(MP4) demuxer + VideoDecoder。
 *
 * demuxer 决策（冻结方案 §7.3"开工时定并写入报告"）：**手写 BMFF 解析**，
 * 不引入 mp4box.js —— 探针素材为自产 faststart 单视频轨 H.264（无 B 帧，
 * openh264），仅需 stsd/stts/stss/stsc/stsz/stco/co64/ctts 八张表；
 * ctts 仍按规范解析以兼容生产 proxy 产物。
 * 长帧缓存模式：LRU 缓存已解码 VideoFrame（close() 纪律 + 内存记账）。
 * A03：demux 后构建 sample-index（PTS 排序索引 + 关键帧二分），seek 定位
 * 从 O(N) 线性扫描改二分——解码喂包顺序不变（索引只改查找）。
 */

import { buildSampleIndex, keyframeAtOrBefore, locateByPts, type SampleIndex } from "./sample-index.js";
import { demuxRange, type DemuxResult } from "./bmff-demux.js";
import { HttpRangeSource, type RangeSource } from "./range-source.js";

interface Sample {
  offset: number;
  size: number;
  dts: number;        // 媒体 timescale 单位
  ctsOffset: number;
  sync: boolean;
}


type Outbound =
  | { type: "ready"; sampleCount: number; durationUs: number; timescale: number; keyframes: number[]; width: number; height: number; hardware: string | null; cacheEnabled: boolean; cacheCap: number }
  | { type: "frame"; id: number; frameN: number; timestampUs: number; fromCache: boolean; samplesFed: number; fromKeyframe: number; allocationSize: number; frame: VideoFrame }
  | { type: "done"; id: number | null; note: string }
  | { type: "error"; id: number | null; message: string }
  | { type: "ticket-refresh-request"; id: number };

/** B13-R 驻留遥测（decode worker 侧）：输出帧去向计数。decoded = 解码器输出
 *  总数;posted = transfer 给客户端;cached = 转入 LRU（禁用时为 0）;closed =
 *  worker 内关闭（中间环/GOP 锚置换）;live = held - closed —— 持续增长即
 *  泄漏信号（含禁用缓存路径下被 close 的原始帧）。 */
interface DecodeResidency {
  decoded: number;
  posted: number;
  cached: number;
  closed: number;
  live: number;
  cacheBytes: number;
  cacheSize: number;
}
let resDecoded = 0;
let resPosted = 0;
let resCached = 0;
let resClosed = 0;
function decodeResidency(): DecodeResidency {
  return { decoded: resDecoded, posted: resPosted, cached: resCached, closed: resClosed, live: resDecoded - resPosted - resCached - resClosed, cacheBytes, cacheSize: cache.size };
}

const post = (message: Outbound, transfer: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(message, transfer);
};


let demuxResult: DemuxResult | null = null;
let sampleIndex: SampleIndex | null = null;
/** B12：Range 源（moov-only 解析 + 按需字节读取）。整文件 dataBytes 已移除。 */
let rangeSource: RangeSource | null = null;
let decoder: VideoDecoder | null = null;
let decoderConfig: VideoDecoderConfig | null = null;
let hardware: string | null = null;

let cacheEnabled = false;
let cacheCap = 0;
const cache = new Map<number, VideoFrame>(); // LRU：key = sample index
let cacheHits = 0;
let cacheMisses = 0;
let cacheEvictions = 0;
let cacheBytes = 0;
/** 解码请求队列（M3-2.2）：旧实现单 pendingResolve——新请求到达即置空旧引用，
 * 旧 promise 永不落定（客户端 15s 超时 → "decode timeout"），且允许后发请求被
 * 前一帧的输出按容差错配解决（系统性早一帧）。现改为严格串行队列：一次只
 * 处理一个请求，输出按其目标 PTS 匹配，完成后自动续队。 */
interface DecodeRequest { id: number; frameN: number; targetUs: number; sampleIndex: number }
const decodeQueue: DecodeRequest[] = [];
let activeRequest: DecodeRequest | null = null;
let fedIndex = -1; // 解码器已馈送的最后一个采样索引（热态顺序解码游标）
/** A03 顺播定位游标：上次 locateByPts 命中的排序位置（目标单调时局部推进）。 */
let ptsCursor = -1;
let samplesFed = 0;
let fromKeyframe = -1;

/** 解码器工厂：output 按当前请求的目标 PTS 匹配（半帧容差），其余输出关闭。 */
function createDecoder(): VideoDecoder {
  return new VideoDecoder({
    output: (frame: VideoFrame) => {
      resDecoded += 1;
      const request = activeRequest;
      if (request && Math.abs(frame.timestamp - request.targetUs) <= 16_667) {
        // 半帧容差（旧实现 33_334 会把相邻帧错配 → 系统性早一帧）
        activeRequest = null;
        pendingAnchorPts = -1;
        if (cacheEnabled) {
          const clone = frame.clone();
          cachePut(request.sampleIndex, frame); // 缓存接管原始帧（保持开启）
          resCached += 1;
          resPosted += 1;
          post({ type: "frame", id: request.id, frameN: request.frameN, timestampUs: clone.timestamp, fromCache: false, samplesFed, fromKeyframe, allocationSize: clone.allocationSize(), frame: clone }, [clone]);
        } else {
          // 直传原始帧（免 clone：每帧减一次 GPU 内存搬运；所有权随转移交出）
          resPosted += 1;
          post({ type: "frame", id: request.id, frameN: request.frameN, timestampUs: frame.timestamp, fromCache: false, samplesFed, fromKeyframe, allocationSize: frame.allocationSize(), frame }, [frame]);
        }
        pumpQueue();
      } else if (frame.timestamp === pendingAnchorPts) {
        pendingAnchorPts = -1;
        holdGopAnchor(frame); // GOP 锚 IDR：持有到下个关键帧冷启（绝不中途关闭）
      } else {
        holdOrCloseIntermediate(frame); // 非当前目标（顺序喂入的中间帧/速度变换跳过帧）
      }
    },
    error: (error: DOMException) => {
      const request = activeRequest;
      activeRequest = null;
      // 解码器进入错误态后必须 reset 才可复用：重建配置、清热态游标
      try {
        decoder!.reset();
        decoder!.configure(decoderConfig as VideoDecoderConfig);
      } catch { /* reset 失败则后续请求自行暴露 */ }
      intermediateRing.length = 0;
      fedIndex = -1;
      if (request) post({ type: "error", id: request.id, message: `decoder error: ${error.message}` });
      else post({ type: "error", id: null, message: `decoder error: ${error.message}` });
      pumpQueue();
    },
  });
}

/** 立即关闭的解码输出会与 D3D11 解码器内部表面池的引用复用竞态：速度变换
 * 跳帧的中间输出若在输出回调里同步 close()，后续 GOP 实证出现确定性花屏
 * （fixed3/fixed11，evidence/m3_2/playback-repro）。改为延迟关闭——保留最近
 * K 个中间输出，新输出到来再关最旧；reset/回退时清空。 */
const intermediateRing: VideoFrame[] = [];
const INTERMEDIATE_RING = 3; // 环过大会耗尽 D3D11 输出表面池（实测 8 层 → 解码停摆）

function holdOrCloseIntermediate(frame: VideoFrame): void {
  if (intermediateRing.length >= INTERMEDIATE_RING) {
    const oldest = intermediateRing.shift();
    if (oldest) { oldest.close(); resClosed += 1; }
  }
  intermediateRing.push(frame);
}

function drainIntermediateRing(): void {
  for (const frame of intermediateRing.splice(0)) { frame.close(); resClosed += 1; }
}

/** GOP 锚帧：冷启回退所喂 IDR 的输出绝不在 GOP 中途关闭（其表面是整个 GOP
 * 的参考锚，关闭后 D3D11 表面池复用会破坏参考链 → 后续确定性花屏）。持有到
 * 下一个关键帧冷启时再释放。 */
let gopAnchor: VideoFrame | null = null;
let pendingAnchorPts = -1;

function holdGopAnchor(frame: VideoFrame): void {
  try { gopAnchor?.close(); if (gopAnchor) resClosed += 1; } catch { /* 已关闭 */ }
  gopAnchor = frame;
}

function releaseGopAnchor(): void {
  try { gopAnchor?.close(); if (gopAnchor) resClosed += 1; } catch { /* 已关闭 */ }
  gopAnchor = null;
  pendingAnchorPts = -1;
}

// B12 续票桥（bug 修复）：闭包/函数无法经 postMessage 结构化克隆，此前把
// 主线程的 refreshTicket 回调随 init 消息传入会直接抛 "could not be cloned"
// ——完整 App 合成预览不可用（B00 冒烟暴露）。改为消息往返：Worker 在
// 401/403 时发 ticket-refresh-request,客户端调主线程回调后回发
// ticket-refresh-response;Worker 侧以 pending map 挂起/恢复。
const ticketRefreshPending = new Map<number, { resolve: (url: string) => void; reject: (error: Error) => void }>();
let ticketRefreshSeq = 0;
function requestTicketRefresh(): Promise<string> {
  const id = ++ticketRefreshSeq;
  return new Promise<string>((resolve, reject) => {
    ticketRefreshPending.set(id, { resolve, reject });
    post({ type: "ticket-refresh-request", id });
  });
}

async function init(url: string, cacheFrames: number, hasTicketRefresh: boolean, cacheCapBytes?: number): Promise<void> {
  // B12：Range 源初始化（bytes=0-65535 探测 + moov-only 解析）——整文件
  // arrayBuffer 下载已移除。票据 TTL 到期由 HttpRangeSource 受控续票
  //（有限一次，相同 range 重发）；续票经 ticket-refresh 消息往返桥接到
  // 主线程（会话持有 Main IPC 通道）。失败路径：Range/BMFF 不支持 →
  // 上抛结构化错误，由 DecodeWorker 客户端回退代理（不冒充已支持）。
  rangeSource = await HttpRangeSource.create(
    url, (input, init2) => fetch(input, init2), hasTicketRefresh ? requestTicketRefresh : null,
    { cacheCapBytes: cacheCapBytes ?? undefined }, undefined,
  );
  demuxResult = await demuxRange(rangeSource);
  const demuxed = demuxResult;
  sampleIndex = buildSampleIndex(demuxed.samples, demuxed.timescale); // A03：一次性索引
  ptsCursor = -1;
  cacheEnabled = cacheFrames > 0;
  cacheCap = cacheFrames;
  const config: VideoDecoderConfig = {
    codec: demuxed.codec,
    codedWidth: demuxed.width,
    codedHeight: demuxed.height,
    description: demuxed.avcC,
    optimizeForLatency: true,
    // 色彩矩阵钉死 BT.709（冻结方案 §7.2 比对口径；texImage2D(VideoFrame) 转换依此）
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
  const last = demuxed.samples.at(-1)!;
  post({
    type: "ready",
    sampleCount: demuxed.samples.length,
    durationUs: Math.round(((last.dts + last.ctsOffset) / demuxed.timescale) * 1e6),
    timescale: demuxed.timescale,
    keyframes: demuxed.samples.map((sample, index) => (sample.sync ? index : -1)).filter(index => index >= 0),
    width: demuxed.width, height: demuxed.height,
    hardware, cacheEnabled, cacheCap,
  });
}

function cachePut(sampleIndex: number, frame: VideoFrame): void {
  if (!cacheEnabled) return;
  if (cache.has(sampleIndex)) return;
  while (cache.size >= cacheCap) {
    const oldest = cache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    const evicted = cache.get(oldest)!;
    cacheBytes -= evicted.allocationSize();
    evicted.close();
    resClosed += 1;
    cache.delete(oldest);
    cacheEvictions += 1;
  }
  cache.set(sampleIndex, frame);
  cacheBytes += frame.allocationSize();
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

function decodeSamples(request: DecodeRequest): void {
  if (!demuxResult || !decoder || !rangeSource || !sampleIndex) throw new Error("worker not initialized");
  const { samples, timescale } = demuxResult;
  const target = request.sampleIndex;
  // 热态顺序解码（M3-2 播放架构）：目标在已馈送位置之前（含跨采样跳帧，如
  // speed≠1 的 1.25x 每 4 帧跳 1 采样）一律不 reset——顺序喂入中间采样即可
  // （中间输出按时间戳不匹配自动关闭）。仅回退（seek/换段回头）才 reset +
  // 关键帧重解。此前 sequential 条件是 target === fedIndex+1：任何跳帧都触发
  // 冷启 reset+关键帧重解，代价随 GOP 深度线性增长（1.25x 项目实测后半段
  // 每帧 50-60ms → 播放放慢 + 丢帧，evidence/m3_2/playback-repro 实证）。
  // 例外——热态跳帧跨关键帧时仍走冷启：该关键帧作为中间采样输出后被即刻
  // 关闭，实证会在部分硬件解码器上破坏后续参考链（src300 关键帧被跨跳后
  // src~303 起确定性花屏，两次运行 PNG 逐字节一致；冷启路径同位置干净）。
  let sequential = fedIndex >= 0 && target > fedIndex;
  if (sequential) {
    // 跨关键帧检查：目标之后的首个关键帧位置二分（≤ target 的最大关键帧
    // 与 ≤ fedIndex 的最大关键帧相同 → 区间无关键帧）
    const keyBeforeFed = keyframeAtOrBefore(sampleIndex, fedIndex);
    const keyBeforeTarget = keyframeAtOrBefore(sampleIndex, target);
    sequential = keyBeforeTarget === keyBeforeFed;
  }
  let startSample = target;
  if (!sequential) {
    // A03：关键帧回退二分（原逐样本线性回退，长 GOP 深 seek O(GOP)）
    startSample = keyframeAtOrBefore(sampleIndex, target);
    releaseGopAnchor();
    drainIntermediateRing();
    // 整例重建：reset() 无法清零长解码历史在 D3D11 会话内的残留状态
    //（实证：连续解码整片后 reset+关键帧重解仍产出花屏，新 Worker 实例则干净；
    // evidence/m3_2/playback-repro fixed10 vs fixed14/15 postmortem）。
    try { decoder.close(); } catch { /* 已关闭 */ }
    decoder = createDecoder();
    decoder.configure(decoderConfig as VideoDecoderConfig);
    fedIndex = -1;
    // 冷启首个输出 = 关键帧 IDR：持有为 GOP 锚（见 gopAnchor 注释）
    pendingAnchorPts = ((samples[startSample]!.dts + samples[startSample]!.ctsOffset) / timescale) * 1e6;
  }
  samplesFed = 0;
  fromKeyframe = sequential ? fedIndex + 1 : startSample;
  void feedSamples(samples, startSample, target, timescale, request);
}

/** B12：按需读取采样区间并喂包（Range 源字节缓存合并连续读）。 */
async function feedSamples(
  samples: Array<{ offset: number; size: number; dts: number; ctsOffset: number; sync: boolean }>,
  startSample: number,
  target: number,
  timescale: number,
  request: DecodeRequest,
): Promise<void> {
  try {
    for (let index = startSample; index <= target; index++) {
      const sample = samples[index]!;
      const chunkData = await rangeSource!.read(sample.offset, sample.size);
      const chunk = new EncodedVideoChunk({
        type: sample.sync ? "key" : "delta",
        timestamp: ((sample.dts + sample.ctsOffset) / timescale) * 1e6,
        data: chunkData,
      });
      decoder!.decode(chunk);
      samplesFed += 1;
      fedIndex = index;
    }
  } catch (error) {
    post({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

function decodeFrame(id: number, frameN: number, fps: number): void {
  if (!demuxResult || !decoder || !rangeSource || !sampleIndex) throw new Error("worker not initialized");
  const targetUs = (frameN / fps) * 1e6;
  // A03：PTS 定位走排序索引（二分/游标推进），替代 O(N) 线性扫描——
  // 旧实现在 ptsUs > targetUs + 100ms 处提前 break，B 帧非单调 CTS 流会
  // 漏掉更优解；索引路径与完整扫描 oracle 逐点一致（见 sample-index 测试）。
  const located = locateByPts(sampleIndex, targetUs, ptsCursor);
  const target = located.sample;
  const bestDiff = located.diffUs;
  if (target < 0 || bestDiff > 33_334) throw new Error(`no sample for frame ${frameN} (best diff ${bestDiff}us)`);
  // 游标推进：命中后记录其排序位置（单调目标走 O(1) 局部推进）
  ptsCursor = sampleIndex.sortedPtsUs.length > 0
    ? binarySearchPos(sampleIndex, sampleIndex.ptsUs[target]!)
    : -1;
  // 缓存命中先行（不触碰解码器状态）
  if (cacheEnabled && cache.has(target)) {
    cacheHits += 1;
    const cached = cache.get(target)!.clone();
    post({ type: "frame", id, frameN, timestampUs: cached.timestamp, fromCache: true, samplesFed: 0, fromKeyframe: target, allocationSize: cached.allocationSize(), frame: cached }, [cached]);
    return;
  }
  cacheMisses += cacheEnabled ? 1 : 0;
  decodeQueue.push({ id, frameN, targetUs, sampleIndex: target });
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
  const data = event.data as { type: string; url?: string; cacheFrames?: number; id?: number; frameN?: number; fps?: number; refreshTicket?: boolean; refreshUrl?: string; refreshError?: string; cacheCapBytes?: number };
  try {
    if (data.type === "init" && data.url) {
      void init(data.url, data.cacheFrames ?? 0, data.refreshTicket === true, data.cacheCapBytes);
    } else if (data.type === "ticket-refresh-response" && typeof data.id === "number") {
      const pending = ticketRefreshPending.get(data.id);
      if (!pending) return;
      ticketRefreshPending.delete(data.id);
      if (typeof data.refreshUrl === "string") pending.resolve(data.refreshUrl);
      else pending.reject(new Error(data.refreshError ?? "ticket refresh failed"));
    } else if (data.type === "decode" && typeof data.id === "number" && typeof data.frameN === "number") {
      decodeFrame(data.id, data.frameN, data.fps ?? 30);
    } else if (data.type === "close") {
      // B12：源关闭（seek 替换/会话销毁）——释放字节缓存与解码器状态
      rangeSource?.close();
      rangeSource = null;
    } else if (data.type === "stats") {
      post({ type: "done", id: null, note: JSON.stringify({ hits: cacheHits, misses: cacheMisses, evictions: cacheEvictions, size: cache.size, bytes: cacheBytes, residency: decodeResidency() }) });
    }
  } catch (error) {
    post({ type: "error", id: (data as { id?: number }).id ?? null, message: error instanceof Error ? error.message : String(error) });
  }
};
