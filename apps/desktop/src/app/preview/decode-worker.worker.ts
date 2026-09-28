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
  | { type: "ready"; sampleCount: number; durationUs: number; timescale: number; keyframes: number[]; width: number; height: number; hardware: string | null; cacheEnabled: boolean; cacheCap: number; hasBFrames: boolean }
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

/** 错误消息带上结构化 code 前缀（`CODE: message`）——SyntheticPreview 按
 *  子串识别域码；无 code 的错误保持原 message。 */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0 ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}


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
/** B13-R 判别开关（init 消息 forceSwDecode 注入；worker 作用域无宿主全局）。 */
let forceSwDecode = false;
/** 解码请求队列（M3-2.2）：旧实现单 pendingResolve——新请求到达即置空旧引用，
 * 旧 promise 永不落定（客户端 15s 超时 → "decode timeout"），且允许后发请求被
 * 前一帧的输出按容差错配解决（系统性早一帧）。现改为严格串行队列：一次只
 * 处理一个请求，输出按**选中采样 PTS**匹配（不是 targetUs——VFR/29.97/HEVC
 * 上最近邻采样可偏离 targetUs 达 33ms，按 targetUs 半帧匹配会永不命中而超时），
 * 完成后自动续队。 */
interface DecodeRequest {
  id: number;
  frameN: number;
  targetUs: number;
  sampleIndex: number;
  /** 选中采样的真实 PTS（输出匹配锚点）。 */
  samplePtsUs: number;
}
const decodeQueue: DecodeRequest[] = [];
let activeRequest: DecodeRequest | null = null;
/** 在途请求看门狗：客户端超时后若 worker 仍占着 activeRequest，后续请求会
 *  永久排队（真机：一次 timeout 后全部 decode timeout）。到点强制清占并报错。 */
let activeRequestTimer: ReturnType<typeof setTimeout> | null = null;
const ACTIVE_REQUEST_TIMEOUT_MS = 45_000;

function clearActiveRequestTimer(): void {
  if (activeRequestTimer !== null) {
    clearTimeout(activeRequestTimer);
    activeRequestTimer = null;
  }
}

function armActiveRequestTimer(request: DecodeRequest): void {
  clearActiveRequestTimer();
  activeRequestTimer = setTimeout(() => {
    if (activeRequest?.id !== request.id) return;
    activeRequest = null;
    clearActiveRequestTimer();
    post({ type: "error", id: request.id, message: `decode worker watchdog: frame ${request.frameN} 无匹配输出（pts=${request.samplePtsUs}）` });
    pumpQueue();
  }, ACTIVE_REQUEST_TIMEOUT_MS);
}
let fedIndex = -1; // 最近一次**请求目标**（顺序判定用；勿与已喂采样游标混用）
/** 已喂入解码器的最大采样索引（含 B 帧 lookahead；顺序请求从 lastFedSample+1 续喂）。 */
let lastFedSample = -1;
/** 最近一次请求**目标采样**所在 GOP 的关键帧索引（GOP 连续性判定锚）。
 *  绝不能用 lastFedSample（含 +LOOKAHEAD 前瞻）做该判定：目标+3 越过下一
 *  GOP 关键帧时，keyframeAtOrBefore(lastFedSample) 已落在下个 GOP——真实
 *  请求流仍在本 GOP 内回跳（B 帧重排，最大回跳 6 采样），误判"跨 GOP"即
 *  冷启重建：整 GOP（真机 88 采样）重解 + clearReadyByPts 丢弃全部已解
 *  暂存 → 连环重建风暴（每 GOP 边界 3 次、每 2.93s 卡一下的根因）。 */
let lastTargetKey = -1;
/** A03 顺播定位游标：上次 locateByPts 命中的排序位置（目标单调时局部推进）。 */
let ptsCursor = -1;
let samplesFed = 0;
let fromKeyframe = -1;

/** 解码器工厂：output 按选中采样 PTS 匹配；其余输出按 PTS 暂存供后续请求取用
 *  （lookahead 会提前解出后续帧，若当时丢弃则下个请求等不到 → decode timeout）。 */
const readyByPts = new Map<number, VideoFrame>();
/** B 帧重排暂存窗（lookahead 已解出、等待后续请求取用的输出）。
 *  容量必须 ≥ 素材重排深度（呈现序回跳距离）+ LOOKAHEAD：小于它，
 *  FIFO 驱逐会丢掉"即将被请求"的输出 → 请求无包可喂 → 看门狗/超时。
 *  定长常量无法覆盖所有编码器（本仓真机素材 maxBackstep=6 旧值=4 丢帧）；
 *  init 按 ctts 计算实际深度并抬高（见 init）。上限守住 D3D11 输出表面池。 */
const READY_BY_PTS_MIN = 4;
let readyByPtsMax = READY_BY_PTS_MIN;

function stashByPts(frame: VideoFrame): void {
  if (readyByPts.size >= readyByPtsMax) {
    const oldest = readyByPts.keys().next().value;
    if (oldest !== undefined) {
      const old = readyByPts.get(oldest);
      readyByPts.delete(oldest);
      try { old?.close(); if (old) resClosed += 1; } catch { /* 已关闭 */ }
    }
  }
  readyByPts.set(frame.timestamp, frame);
}

function takeByPts(ptsUs: number): VideoFrame | null {
  const hit = readyByPts.get(ptsUs);
  if (hit) { readyByPts.delete(ptsUs); return hit; }
  // 浮点容差 ±1ms
  for (const [pts, frame] of readyByPts) {
    if (Math.abs(pts - ptsUs) <= 1_000) {
      readyByPts.delete(pts);
      return frame;
    }
  }
  return null;
}

function createDecoder(): VideoDecoder {
  return new VideoDecoder({
    output: (frame: VideoFrame) => {
      resDecoded += 1;
      const request = activeRequest;
      // 半帧容差（一帧@30fps 的一半）：锚在 samplePtsUs（locateByPts 已完成
      // 最近邻选择）。历史教训两次：
      // - 33_334（整帧）容差 ≥ 相邻帧间距 33_333us：B 帧金字塔内先到的相邻
      //   输出会偷走匹配（activeRequest 拿到错帧、真目标输出被挤出暂存链）
      //   → 下个请求 miss → 同 GOP 无包可喂 → 看门狗超时（2026-09-28 边界
      //   仿真复现，tests/decode-reorder-playback.test.ts）。
      // - 1_000（1ms）容差在 HEVC/VFR 半帧窗上永不命中 → decode timeout
      //   （e9201e9 真机现场）。
      // 半帧是两者平衡：相邻帧间距 ≥ 33ms > 16.7ms，永不偷相邻；VFR 半帧
      // 偏移 16.7ms 仍可命中。
      if (request && Math.abs(frame.timestamp - request.samplePtsUs) <= 16_667) {
        activeRequest = null;
        clearActiveRequestTimer();
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
        // 非当前目标：优先按 PTS 暂存（lookahead 已解出的后续帧），否则进中间环
        stashByPts(frame);
      }
    },
    error: (error: DOMException) => {
      const request = activeRequest;
      activeRequest = null;
      clearActiveRequestTimer();
      // 解码器进入错误态后必须 reset 才可复用：重建配置、清热态游标
      try {
        decoder!.reset();
        decoder!.configure(decoderConfig as VideoDecoderConfig);
      } catch { /* reset 失败则后续请求自行暴露 */ }
      intermediateRing.length = 0;
      fedIndex = -1;
      lastFedSample = -1;
      lastTargetKey = -1; // reset 后热态游标失效：下个请求按 GOP 锚重新判定
      if (request) post({ type: "error", id: request.id, message: `decoder error: ${errorText(error)}` });
      else post({ type: "error", id: null, message: `decoder error: ${errorText(error)}` });
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

function clearReadyByPts(): void {
  for (const frame of readyByPts.values()) {
    try { frame.close(); resClosed += 1; } catch { /* 已关闭 */ }
  }
  readyByPts.clear();
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

async function init(url: string, cacheFrames: number, hasTicketRefresh: boolean, cacheCapBytes?: number, forceSwDecodeArg?: boolean): Promise<void> {
  forceSwDecode = forceSwDecodeArg === true;
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
  // 重排深度（呈现序回跳距离）：B 帧素材的显示序请求流会周期性回跳——已喂
  // 游标（含 LOOKAHEAD）到下一个待请求目标之间最多隔这么多个采样。暂存窗
  // 容量不足会 FIFO 驱逐即将被请求的输出（真机素材 ctts 回跳 6/旧容量 4 丢帧
  // → 每 GOP 边界连环冷启重建）。按实测深度抬高，上限守住 D3D11 表面池。
  // fps 此处未知（decode 调用才带）：按 sampleIndex 排序 PTS 的相邻差分近似
  // 帧率（VFR 下取 p50），误差只影响逐帧对齐精度——回跳深度上界由 LOOKAHEAD
  // 余量兜住。
  {
    const LOOKAHEAD = BFRAME_LOOKAHEAD;
    // 帧率近似：排序 PTS 相邻差分的中位数（VFR/ctts 单调场景稳健）。
    const gaps: number[] = [];
    for (let k = 1; k < sampleIndex.sortedPtsUs.length; k++) {
      gaps.push(sampleIndex.sortedPtsUs[k]! - sampleIndex.sortedPtsUs[k - 1]!);
    }
    gaps.sort((a, b) => a - b);
    const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 0;
    if (medianGap > 0) {
      let fedBoundary = -1;
      let maxBackstep = 0;
      for (let k = 0; k < sampleIndex.sortedPtsUs.length; k++) {
        const target = sampleIndex.sampleByPts[k]!;
        if (target < 0) continue;
        if (fedBoundary >= 0 && target < fedBoundary) {
          maxBackstep = Math.max(maxBackstep, fedBoundary - target);
        }
        fedBoundary = Math.max(fedBoundary, target + LOOKAHEAD);
      }
      readyByPtsMax = Math.min(16, Math.max(READY_BY_PTS_MIN, maxBackstep + LOOKAHEAD + 1));
    }
  }
  cacheEnabled = cacheFrames > 0;
  cacheCap = cacheFrames;
  const config: VideoDecoderConfig = {
    codec: demuxed.codec,
    codedWidth: demuxed.width,
    codedHeight: demuxed.height,
    description: demuxed.description,
    optimizeForLatency: true,
    // 色彩矩阵钉死 BT.709（冻结方案 §7.2 比对口径；texImage2D(VideoFrame) 转换依此）
    colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
  };
  // B13-R 判别诊断开关：强制软件解码（绕过 D3D11 硬解表面池，用于判别
  // Tab 常驻随 unique 解码帧增长的主体）。init 消息 forceSwDecode 下发。
  const preferHw = !forceSwDecode;
  const support = await VideoDecoder.isConfigSupported({
    ...(preferHw ? { ...config, hardwareAcceleration: "prefer-hardware" } : config),
  });
  if (support.supported && preferHw) {
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
    hasBFrames: demuxed.hasBFrames,
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
    armActiveRequestTimer(request);
    try {
      decodeSamples(request);
    } catch (error) {
      activeRequest = null;
      clearActiveRequestTimer();
      post({ type: "error", id: request.id, message: errorText(error) });
    }
  }
}

function decodeSamples(request: DecodeRequest): void {
  if (!demuxResult || !decoder || !rangeSource || !sampleIndex) throw new Error("worker not initialized");
  const { samples, timescale } = demuxResult;
  const target = request.sampleIndex;
  // 热态顺序解码：**同一 GOP 且已喂过 target 或可续喂** 即可，绝不能用
  // `target > fedIndex` 判顺序——HEVC/B 帧 ctts 使呈现序采样号上下跳
  // （fdf0f0e2 真机：frame1→sample3, frame2→sample2），每次回跳都冷启
  // 会把 720p 也解到超时。
  //
  // GOP 连续性锚定**请求目标的 GOP**（lastTargetKey），不用含 LOOKAHEAD 的
  // lastFedSample：目标+3 前瞻越过下个关键帧时 keyframeAtOrBefore(lastFedSample)
  // 已落在下个 GOP，而真实请求流仍在本 GOP 回跳（B 帧重排深度可达 6）——
  // 误判跨 GOP = 冷启重建整 GOP（真机 88 采样）+ clearReadyByPts 丢弃全部
  // 已解暂存，边界处连续 3 帧请求全部触发 → 每 2.93s 一次重建风暴（周期性
  // 卡顿根因；见 tests/decode-reorder-playback.test.ts 仿真）。
  const keyTarget = keyframeAtOrBefore(sampleIndex, target);
  const sameGop = lastTargetKey >= 0 && lastTargetKey === keyTarget;
  /** 冷启重建（decoder 整例重建 + 关键帧重喂 + 清暂存）。 */
  const coldStart = (start: number): void => {
    // A03：关键帧回退二分（原逐样本线性回退，长 GOP 深 seek O(GOP)）
    releaseGopAnchor();
    drainIntermediateRing();
    clearReadyByPts();
    // 整例重建：reset() 无法清零长解码历史在 D3D11 会话内的残留状态
    //（实证：连续解码整片后 reset+关键帧重解仍产出花屏，新 Worker 实例则干净；
    // evidence/m3_2/playback-repro fixed10 vs fixed14/15 postmortem）。
    try { decoder!.close(); } catch { /* 已关闭 */ }
    decoder = createDecoder();
    decoder.configure(decoderConfig as VideoDecoderConfig);
    fedIndex = -1;
    lastFedSample = start - 1;
    lastTargetKey = keyTarget;
    // 冷启首个输出 = 关键帧 IDR：持有为 GOP 锚（见 gopAnchor 注释）
    pendingAnchorPts = ((samples[start]!.dts + samples[start]!.ctsOffset) / timescale) * 1e6;
  };
  let startSample = target;
  if (!sameGop) {
    startSample = keyTarget;
    coldStart(startSample);
  } else {
    // 同 GOP：从上次已喂游标续喂；target 已在已喂区间则只补 lookahead
    startSample = lastFedSample + 1;
    const needEnd = target + BFRAME_LOOKAHEAD;
    if (startSample > needEnd) {
      // 目标采样已被喂过但输出不在暂存（容量驱逐 / 已被前次请求消费后重放）：
      // 旧行为静默 return → activeRequest 等一个不会来的输出 → 45s 看门狗。
      // 回跳距离超过暂存覆盖（任意 scrub/变速回退）时这是常态，改为按关键帧
      // 冷启重喂（一次性成本 ≤ GOP 长度，正确性优先——挂起换不来任何帧）。
      startSample = keyTarget;
      coldStart(startSample);
    }
  }
  samplesFed = 0;
  fromKeyframe = startSample;
  void feedSamples(samples, startSample, target, timescale, request);
  fedIndex = target;
}

/** B12：按需读取采样区间并喂包（Range 源字节缓存合并连续读）。
 *  目标后额外喂 LOOKAHEAD 采样：HEVC/B 帧重排需要前方参考帧才吐目标输出。
 *  上限必须小：hold 住的 VideoFrame 占 D3D11 输出表面池（环 3 + 暂存 2 已接近
 *  硬件池边界，8 层实测解码停摆）。 */
const BFRAME_LOOKAHEAD = 3;

async function feedSamples(
  samples: Array<{ offset: number; size: number; dts: number; ctsOffset: number; sync: boolean }>,
  startSample: number,
  target: number,
  timescale: number,
  request: DecodeRequest,
): Promise<void> {
  try {
    const end = Math.min(samples.length - 1, target + BFRAME_LOOKAHEAD);
    for (let index = startSample; index <= end; index++) {
      const sample = samples[index]!;
      const chunkData = await rangeSource!.read(sample.offset, sample.size);
      const chunk = new EncodedVideoChunk({
        type: sample.sync ? "key" : "delta",
        timestamp: ((sample.dts + sample.ctsOffset) / timescale) * 1e6,
        data: chunkData,
      });
      decoder!.decode(chunk);
      samplesFed += 1;
      lastFedSample = index;
    }
    // 不在此 flush()：VideoDecoder 在 flush 后要求下一包为关键帧，会打断
    // 同 GOP 顺序解码（真机报 "A key frame is required after configure() or
    // flush()"）。B 帧靠上方 LOOKAHEAD 前方参考帧即可吐出目标输出。
  } catch (error) {
    post({ type: "error", id: request.id, message: errorText(error) });
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
  // lookahead 提前解出的帧（readyByPts）：直接回填，不再进解码队列
  const samplePtsUs = sampleIndex.ptsUs[target]!;
  const staged = takeByPts(samplePtsUs);
  if (staged) {
    // 同步推进请求游标：否则后续跨关键帧误判需冷启（真机 2s 后卡死）。
    // GOP 锚同样推进（stash 回填 = 目标所在 GOP 与热态一致）。
    if (target > fedIndex) fedIndex = target;
    lastTargetKey = keyframeAtOrBefore(sampleIndex, target);
    resPosted += 1;
    post({ type: "frame", id, frameN, timestampUs: staged.timestamp, fromCache: true, samplesFed: 0, fromKeyframe: target, allocationSize: staged.allocationSize(), frame: staged }, [staged]);
    return;
  }
  cacheMisses += cacheEnabled ? 1 : 0;
  decodeQueue.push({ id, frameN, targetUs, sampleIndex: target, samplePtsUs });
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
  const data = event.data as { type: string; url?: string; cacheFrames?: number; id?: number; frameN?: number; fps?: number; refreshTicket?: boolean; refreshUrl?: string; refreshError?: string; cacheCapBytes?: number; forceSwDecode?: boolean };
  try {
    if (data.type === "init" && data.url) {
      // DEFECT-4K60-SESSION-HANG：init 失败必须回发 error——旧实现 fire-and-forget
      // 的 rejection 在 worker 内被吞，客户端只能等满 15s 泛化超时拿不到真实错误。
      void init(data.url, data.cacheFrames ?? 0, data.refreshTicket === true, data.cacheCapBytes, data.forceSwDecode)
        .catch(error => post({ type: "error", id: null, message: errorText(error) }));
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
    post({ type: "error", id: (data as { id?: number }).id ?? null, message: errorText(error) });
  }
};
