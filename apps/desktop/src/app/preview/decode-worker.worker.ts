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
  | { type: "frame"; id: number; frameN: number; timestampUs: number; fromCache: boolean; samplesFed: number; fromKeyframe: number; allocationSize: number; timing: DecodeTiming | null; frame: VideoFrame }
  | { type: "done"; id: number | null; note: string }
  | { type: "error"; id: number | null; message: string }
  | { type: "ticket-refresh-request"; id: number };

/** 解码 RTT 分段计时（P33 规划门 §3.1；decodeTiming=true 时随 frame 消息捎带，
 *  默认关、生产零开销）。两段均为 worker 时钟内的**时长**（跨线程时钟原点
 *  不同，不传绝对时间戳、不做跨钟合成——客户端以自身 RTT 总量减两段得
 *  「排队 + 双跳传输」残差）：
 *  - feedMs: 出队开始处理 → 最后一批喂包提交（Range 读 + 批间让步）；
 *  - outputMs: 喂包提交 → 匹配输出到达（解码器吐帧滞后；flush 救援亦归此段）。
 *  缓存/stash 回填路径两段均为 0（由 fromCache/samplesFed 区分路径）。 */
interface DecodeTiming {
  feedMs: number;
  outputMs: number;
}

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

/** 临时诊断钩子（VERIFY_TRACE=1 时输出解码决策/输出到达事件——真机定位用；
 *  生产默认关闭零开销）。 */
let VERIFY_TRACE = false;
const trace = (event: string, detail: Record<string, unknown> = {}): void => {
  if (!VERIFY_TRACE) return;
  // eslint-disable-next-line no-console
  console.log(`[trace] ${event} ${JSON.stringify(detail)}`);
  post({ type: "trace", event, detail } as never);
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
  /** P33 分段计时基点：pumpQueue 出队开始处理时刻（worker 时钟 ms；-1 = 未计时）。 */
  startedMs: number;
  /** 最后一批喂包提交时刻（feedMs 终点 = outputMs 起点；-1 = 未喂包）。 */
  fedMs: number;
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
    // 附带 worker 状态快照：真机复现「无匹配输出」时直接看到 stash/游标/队列，
    // 免去二次复现定位（2026-09-28 真机 frame4 挂起即靠该快照核验路径）。
    const snapshot = `stash=[${[...readyByPts.keys()].join(",")}] lastFed=${lastFedSample} fedIndex=${fedIndex} queue=${decodeQueue.length} dqSize=${decoder?.decodeQueueSize ?? -1}`;
    post({ type: "error", id: request.id, message: `decode worker watchdog: frame ${request.frameN} 无匹配输出（pts=${request.samplePtsUs}）；${snapshot}` });
    pumpQueue();
  }, ACTIVE_REQUEST_TIMEOUT_MS);
}
let fedIndex = -1; // 最近一次**请求目标**（顺序判定用；勿与已喂采样游标混用）
/** 已喂入解码器的最大采样索引（含 B 帧 lookahead；顺序请求从 lastFedSample+1 续喂）。 */
let lastFedSample = -1;
/** 喂包代际（并发守卫）：feedSamples 是异步批循环（网络读/批间让步点
 *  多处 await），本请求匹配完成后 pumpQueue 会立即启动下一请求的
 *  decodeSamples——若旧批循环不终止，两个喂包流会交错喂同一解码器，
 *  包序错乱破坏参考链（真浏览器实验：输出停在排序位 9 后永久停止）。
 *  每次启动/重启动喂包前递增；批循环每步检查代际，不同代立即退出。 */
let feedGeneration = 0;
/** flush 救援进行中（救援→reset→续队的窗口期）：pumpQueue 在此期间不启动
 *  新请求——flush 后解码器「需关键帧」，新请求的 delta 喂包会同步抛错。 */
let flushRecovering = false;
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
 *  容量须覆盖素材重排深度，但**必须计入解码器输出背压**：未 close 的
 *  VideoFrame 总量（stash + gopAnchor + intermediateRing）超过阈值后
 *  Chrome 解码器停止吐帧（真浏览器实测 ~13 帧：stash 9+anchor 1+环 3
 *  → 输出永久停滞；裸解码器逐帧 close 无此问题）。
 *  容量公式：min(BACKPRESSURE_CAP, max(4, 回跳深度+2))——重排覆盖由
 *  feedEndFor 的排序空间喂包终点保证，stash 只兜「已释放待请求」帧。 */
const READY_BY_PTS_MIN = 4;
const READY_BY_PTS_BACKPRESSURE_CAP = 6;
let readyByPtsMax = READY_BY_PTS_MIN;

/** 最近一次请求的目标 pts（智能驱逐锚：B 帧交错流的下一个请求目标大概率
 *  在其邻域——FIFO 驱逐恰好先丢掉 pts 最老的回跳目标，是 miss 频发的根源）。 */
let lastRequestPtsUs = -1;

function stashByPts(frame: VideoFrame): void {
  if (readyByPts.size >= readyByPtsMax) {
    // 驱逐「距当前请求目标最远」的暂存帧（而非 FIFO 最老）：保住目标邻域，
    // 回跳请求的输出几乎总能命中，miss 只剩真异常（flush 救援兜底）。
    let worstKey = -1;
    let worstDist = -1;
    for (const key of readyByPts.keys()) {
      const dist = Math.abs(key - lastRequestPtsUs);
      if (dist > worstDist) { worstDist = dist; worstKey = key; }
    }
    if (worstKey >= 0) {
      const old = readyByPts.get(worstKey);
      readyByPts.delete(worstKey);
      try { old?.close(); if (old) resClosed += 1; } catch { /* 已关闭 */ }
    }
  }
  readyByPts.set(frame.timestamp, frame);
  trace("stash_put", { pts: frame.timestamp, size: readyByPts.size, cap: readyByPtsMax });
}

function takeByPts(ptsUs: number): VideoFrame | null {
  const hit = readyByPts.get(ptsUs);
  if (hit) { readyByPts.delete(ptsUs); trace("take_hit_exact", { ptsUs }); return hit; }
  // 浮点容差 ±1ms
  for (const [pts, frame] of readyByPts) {
    if (Math.abs(pts - ptsUs) <= 1_000) {
      readyByPts.delete(pts);
      return frame;
    }
  }
  return null;
}

/** P33 分段计时开关（init 消息注入；默认关，生产零开销）。 */
let decodeTiming = false;

function createDecoder(): VideoDecoder {
  return new VideoDecoder({
    output: (frame: VideoFrame) => {
      resDecoded += 1;
      const request = activeRequest;
      trace("output", { pts: frame.timestamp, active: request ? request.samplePtsUs : null });
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
        const nowMs = performance.now();
        const timing = decodeTiming && request.startedMs >= 0 ? {
          feedMs: request.fedMs >= 0 ? Math.round((request.fedMs - request.startedMs) * 1000) / 1000 : 0,
          outputMs: request.fedMs >= 0 ? Math.round((nowMs - request.fedMs) * 1000) / 1000 : Math.round((nowMs - request.startedMs) * 1000) / 1000,
        } : null;
        if (cacheEnabled) {
          const clone = frame.clone();
          cachePut(request.sampleIndex, frame); // 缓存接管原始帧（保持开启）
          resCached += 1;
          resPosted += 1;
          post({ type: "frame", id: request.id, frameN: request.frameN, timestampUs: clone.timestamp, fromCache: false, samplesFed, fromKeyframe, allocationSize: clone.allocationSize(), timing, frame: clone }, [clone]);
        } else {
          // 直传原始帧（免 clone：每帧减一次 GPU 内存搬运；所有权随转移交出）
          resPosted += 1;
          post({ type: "frame", id: request.id, frameN: request.frameN, timestampUs: frame.timestamp, fromCache: false, samplesFed, fromKeyframe, allocationSize: frame.allocationSize(), timing, frame }, [frame]);
        }
        pumpQueue();
      } else if (Math.abs(frame.timestamp - pendingAnchorPts) <= 1_000) {
        pendingAnchorPts = -1;
        holdGopAnchor(frame); // GOP 锚 IDR：持有到下个关键帧冷启（绝不中途关闭）
      } else {
        // 非当前目标：优先按 PTS 暂存（lookahead 已解出的后续帧），否则进中间环
        stashByPts(frame);
      }
    },
    error: (error: DOMException) => {
      trace("decoder_error", { msg: errorText(error) });
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
const INTERMEDIATE_RING = 1; // 背压预算：stash(≤6) + gopAnchor(1) + 环(1) = 8 帧未 close（实测 ~13 帧触发解码器输出背压停摆）

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

async function init(url: string, cacheFrames: number, hasTicketRefresh: boolean, cacheCapBytes?: number, forceSwDecodeArg?: boolean, decodeTimingArg?: boolean): Promise<void> {
  forceSwDecode = forceSwDecodeArg === true;
  decodeTiming = decodeTimingArg === true;
  VERIFY_TRACE = (self as unknown as { VERIFY_TRACE?: boolean }).VERIFY_TRACE === true;
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
      readyByPtsMax = Math.min(READY_BY_PTS_BACKPRESSURE_CAP, Math.max(READY_BY_PTS_MIN, maxBackstep + 2));
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
  if (flushRecovering) return; // flush 救援窗口：reset 完成后续队
  while (!activeRequest && decodeQueue.length) {
    const request = decodeQueue.shift()!;
    if (decodeTiming) request.startedMs = performance.now(); // P33：出队开始处理
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
  /** 冷启重建（decoder 整例重建 + 关键帧重喂 + 清暂存 + 喂包换代）。
   *  代际必须在此递增：RESCUE/错误自愈都经由本函数重建解码器，任何
   *  在途旧批循环（await read 中）若不终止，会向**新解码器**交错喂
   *  旧区间的包，破坏包序与参考链（真浏览器实验：输出停在排序位 9
   *  后永久停止；裸解码器对照实验证明解码器本身无此问题）。 */
  const coldStart = (start: number): void => {
    // A03：关键帧回退二分（原逐样本线性回退，长 GOP 深 seek O(GOP)）
    releaseGopAnchor();
    drainIntermediateRing();
    clearReadyByPts();
    // 整例重建：reset() 无法清零长解码历史在 D3D11 会话内的残留状态
    //（实证：连续解码整片后 reset+关键帧重解仍产出花屏，新 Worker 实例则干净；
    // evidence/m3_2/playback-repro fixed10 vs fixed14/15 postmortem）。
    feedGeneration += 1; // 先换代：在途旧批循环在下一个 await 恢复点退出
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
  trace("decodeSamples", { target, keyTarget, sameGop, lastFedSample, lastTargetKey });
  if (!sameGop) {
    startSample = keyTarget;
    coldStart(startSample);
    samplesFed = 0;
    fromKeyframe = startSample;
    const generation = ++feedGeneration; // 换代：作废任何在途旧批循环
    void feedSamples(samples, startSample, target, timescale, request, generation);
    fedIndex = target;
    return;
  }
  // 同 GOP：从上次已喂游标续喂；target 已在已喂区间则只补 lookahead
  const needEnd = feedEndFor(target);
  if (lastFedSample + 1 > needEnd) {
    // P33 W2.5：已喂至文件尾且目标仍 miss —— 重排尾帧滞留且 flush 实测
    // 永不落定（eof-flush-r1..r3 定位：D3D11 硬解尾帧缺后续参考，flush()
    // promise 挂起 + reset 丢排队输出，重排队冷启再撞同一堵墙）。快速报错
    // （消息含 watchdog 命中降级正则）交 FFmpeg B 后端兜底，勿占 45s 看门狗。
    if (lastFedSample >= sampleIndex.count - 1) {
      trace("eof_reorder_stuck_rescue", { target, lastFedSample, needEnd, dq: decoder?.decodeQueueSize ?? -1 });
      activeRequest = null;
      clearActiveRequestTimer();
      post({ type: "error", id: request.id, message: `EOF reorder watchdog: frame ${request.frameN} 尾 GOP 重排输出滞留（pts=${request.samplePtsUs}）；已喂至文件尾 lastFedSample=${lastFedSample}` });
      pumpQueue();
      return;
    }
    // 目标的喂包覆盖已被之前的请求完成（B 帧交错流上回跳目标的排序覆盖
    // 常小于已喂边界），输出不在暂存（takeByPts 已 miss）＝输出滞留在
    // 解码器重排缓冲/输出管道里。
    // 【2026-09-28 真浏览器定位】旧救援=冷启重喂：每次 miss 都 close+重建
    // +从关键帧重喂（真机素材实测 60 帧触发 28 次、喂包量单调涨到 64 包），
    // 解码 p95 655ms、播放速率掉到 0.65x——「丢帧不多但非常卡」的元凶。
    // 且目标帧早已解码过，重喂同采样纯属浪费。正确救援 = decoder.flush()：
    // 强制吐出重排缓冲里的全部帧（含目标），~10ms 级。
    // flush 后解码器处于「需关键帧」态：用 flushRecovering 标志闸住
    // pumpQueue（flush 期间不启动新请求 → 无并发喂包 → 竞态安全），
    // flush 落定后 reset+configure+清热态游标 → 续队（下个请求自然冷启）。
    trace("rescue_flush", { target, lastFedSample, needEnd });
    activeRequest = request;
    armActiveRequestTimer(request);
    flushRecovering = true;
    feedGeneration += 1; // 作废任何残余批循环
    fedIndex = target;
    // P33 W2.5：flush 竞速 5s——flush 在部分驱动状态下 promise 永不落定，
    // 超时即按冷启收尾放行泵（输出已吐的进 stash，未吐的由降级路径兜底）。
    const flushed = Promise.race([
      decoder!.flush().catch(() => undefined),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("flush timeout")), 5_000)),
    ]);
    void flushed.catch(() => undefined).then(() => {
      try {
        decoder!.reset();
        decoder!.configure(decoderConfig as VideoDecoderConfig);
      } catch { /* reset 失败则后续请求自行暴露 */ }
      drainIntermediateRing();
      fedIndex = -1;
      lastFedSample = -1;
      lastTargetKey = -1;
      flushRecovering = false;
      pumpQueue();
    });
    return;
  }
  startSample = lastFedSample + 1;
  samplesFed = 0;
  fromKeyframe = startSample;
  const generation = ++feedGeneration; // 换代：作废任何在途旧批循环
  void feedSamples(samples, startSample, target, timescale, request, generation);
  fedIndex = target;
}

/** B12：按需读取采样区间并喂包（Range 源字节缓存合并连续读）。
 *  目标后额外喂 LOOKAHEAD 采样：HEVC/B 帧重排需要前方参考帧才吐目标输出。
 *  上限必须小：hold 住的 VideoFrame 占 D3D11 输出表面池（环 3 + 暂存 2 已接近
 *  硬件池边界，8 层实测解码停摆）。
 *  喂包终点（2026-09-28 真浏览器 trace 修正）：解码器释放滞后按 **pts 排序
 *  距离**计（D3D11 HEVC 实测：喂 N 包释放窗口内 pts 排序前 N−2 帧），不是
 *  采样索引距离。B 帧交错流上目标的 pts 排序位置可能远超其索引（真机素材：
 *  目标索引 5 的 pts 排序位 8——喂到索引 8 只释放排序前 7，目标永不释放 →
 *  45s 看门狗挂起）。终点改为覆盖「目标排序位置 + LOOKAHEAD」的全部原索引
 *  （sampleIndex.maxSampleIdxByRank 前缀最大；交错流上可能 > target+LA）。 */
const BFRAME_LOOKAHEAD = 3;

/** 喂包区间终点：覆盖目标 pts 排序位置 rank+偏移 以前的全部采样。
 *  偏移 = max(BFRAME_LOOKAHEAD, 交错跨度)：D3D11 释放滞后随 B 金字塔结构
 *  浮动（真浏览器 trace：同一素材 2~3+），交错跨度是其确定性上界。 */
function feedEndFor(target: number): number {
  if (!sampleIndex) return target;
  const pts = sampleIndex.ptsUs[target]!;
  // 目标的排序位置（lowerBound；pts 相同并列时取首位置即可——保守侧）
  let lo = 0;
  let hi = sampleIndex.sortedPtsUs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sampleIndex.sortedPtsUs[mid]! < pts) lo = mid + 1;
    else hi = mid;
  }
  const offset = Math.max(BFRAME_LOOKAHEAD, sampleIndex.maxStagger + 1);
  const rankEnd = Math.min(sampleIndex.count - 1, lo + offset);
  const idxEnd = sampleIndex.maxSampleIdxByRank[rankEnd]!;
  return Math.max(target, Math.min(sampleIndex.count - 1, idxEnd));
}

async function feedSamples(
  samples: Array<{ offset: number; size: number; dts: number; ctsOffset: number; sync: boolean }>,
  startSample: number,
  target: number,
  timescale: number,
  request: DecodeRequest,
  generation: number,
): Promise<void> {
  try {
    // 输出驱动的增量喂包（2026-09-28 真浏览器定位重构）：解码器释放滞后
    // 随 B 金字塔结构与驱动行为浮动（同素材实测 2~7+），任何静态喂包终点
    // 公式都无法保证目标输出必达——喂少了挂 45s 看门狗，懒 flush 又与
    // 后续喂包竞态（flush 后需关键帧）。改为按批喂包 + 每批后检查：
    // 目标匹配即停（正常帧 1~2 批），未匹配继续下一批直至目标达成或
    // 喂到文件尾（远端 EOF 时由看门狗兜底）。批大小取「交错跨度+1」
    // （maxStagger，见 sampleIndex）保证每批至少推进一个排序位。
    // 代际守卫（feedGeneration）：匹配完成/冷启重建都会使本循环失效——
    // 每步检查代际，不同代立即退出，绝不让两个喂包流交错喂同一解码器。
    const batch = Math.max(BFRAME_LOOKAHEAD, sampleIndex?.maxStagger ?? 0) + 1;
    const hardEnd = Math.min(samples.length - 1, feedEndFor(target));
    let fed = startSample - 1;
    while (fed < hardEnd) {
      const batchEnd = Math.min(hardEnd, fed + batch);
      for (let index = fed + 1; index <= batchEnd; index++) {
        if (generation !== feedGeneration) return; // 换代：让位新喂包流
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
        trace("feed", { index, batchEnd, gen: generation, dq: decoder?.decodeQueueSize ?? -1, stash: readyByPts.size });
      }
      fed = batchEnd;
      // 批间让步：输出回调在任务队列中落地后再检查占位。
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (generation !== feedGeneration) return; // 换代：让位新喂包流
      if (activeRequest?.id !== request.id) return; // 目标已匹配：立即停喂
    }
    // P33 W2.5 EOF 边界 flush（postmortem 1780/1783/1786/1789 看门狗定位）：
    // 尾 GOP 冷启喂到 hardEnd=文件尾（lastFedSample=最后采样）后，B 帧重排
    // 金字塔的尾帧滞留在解码器输出管道——没有后续采样驱动，也无人 flush，
    // 目标永不匹配 → 45s 看门狗。此处喂尽文件尾且目标未匹配时强制
    // decoder.flush() 吐出重排缓冲（与 rescue_flush 同收尾：flush 后解码器
    // 需关键帧，reset+configure+清热态游标，flushRecovering 闸泵）。
    // P33 W2.5 EOF 边界快速报错（postmortem 1780/1783/1786/1789 看门狗定位）：
    // 尾 GOP 冷启喂到文件尾（lastFedSample=最后采样）后，B 帧重排金字塔的
    // 尾帧滞留解码器输出管道——没有后续采样驱动。flush 救援实测无效
    // （eof-flush-r1..r3：D3D11 硬解尾帧缺后续参考时 flush() promise 永不
    // 落定、reset 丢弃排队输出，重排队后又冷启撞同一堵墙循环到客户端
    // 50s 超时）。改为立即报错（消息含 watchdog 词命中降级正则），由
    // preview-session maybeFallBackToFfmpeg 连续 2 次判定降级 FFmpeg
    // B 后端（窗口解码无此边界），把 45-50s 挂起压到秒级。
    if (activeRequest?.id === request.id && lastFedSample >= (sampleIndex?.count ?? 0) - 1) {
      trace("eof_reorder_stuck", { target: request.sampleIndex, lastFedSample, dq: decoder?.decodeQueueSize ?? -1 });
      activeRequest = null;
      clearActiveRequestTimer();
      post({ type: "error", id: request.id, message: `EOF reorder watchdog: frame ${request.frameN} 尾 GOP 重排输出滞留（pts=${request.samplePtsUs}）；已喂至文件尾 lastFedSample=${lastFedSample}` });
      pumpQueue();
      return;
    }
    // P33：喂包循环终点（outputMs 起点；request 已被匹配则忽略——正常批次
    // 输出在让步间隙到达，fedMs 仍记在提交完最后一批时，归属正确）。
    if (decodeTiming && activeRequest?.id === request.id) activeRequest.fedMs = performance.now();
  } catch (error) {
    // 喂包失败（Range 读失败等）必须立即释放 activeRequest 并续队：旧实现
    // 只 post error 不清占位——客户端已收到错误并继续发新请求，但 worker 的
    // 串行队列被死请求堵满 45s 直到看门狗（真机 2026-09-28「播放先卡住、
    // 过一会报 watchdog 无匹配输出、之后卡卡续播」的时间线根因）。
    if (activeRequest?.id === request.id) {
      activeRequest = null;
      clearActiveRequestTimer();
    }
    post({ type: "error", id: request.id, message: errorText(error) });
    pumpQueue();
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
    post({ type: "frame", id, frameN, timestampUs: cached.timestamp, fromCache: true, samplesFed: 0, fromKeyframe: target, allocationSize: cached.allocationSize(), timing: null, frame: cached }, [cached]);
    return;
  }
  // lookahead 提前解出的帧（readyByPts）：直接回填，不再进解码队列
  const samplePtsUs = sampleIndex.ptsUs[target]!;
  lastRequestPtsUs = samplePtsUs; // 智能驱逐锚（stashByPts 用）
  const staged = takeByPts(samplePtsUs);
  if (staged) {
    // 同步推进请求游标：否则后续跨关键帧误判需冷启（真机 2s 后卡死）。
    // GOP 锚同样推进（stash 回填 = 目标所在 GOP 与热态一致）。
    if (target > fedIndex) fedIndex = target;
    lastTargetKey = keyframeAtOrBefore(sampleIndex, target);
    resPosted += 1;
    if (cacheEnabled) {
      // LRU 接管原帧 + 回传 clone：stash 命中的帧也进缓存——3 路并发下
      // 同一 src_n 的重复请求（窗口重发/seek 回退/重锚）只有这里能秒回；
      // 否则第二发永远等不到已消费的输出 → 45s 看门狗（2026-09-28 真机定位）。
      const clone = staged.clone();
      cachePut(target, staged);
      resCached += 1;
      post({ type: "frame", id, frameN, timestampUs: clone.timestamp, fromCache: true, samplesFed: 0, fromKeyframe: target, allocationSize: clone.allocationSize(), timing: null, frame: clone }, [clone]);
      return;
    }
    post({ type: "frame", id, frameN, timestampUs: staged.timestamp, fromCache: true, samplesFed: 0, fromKeyframe: target, allocationSize: staged.allocationSize(), timing: null, frame: staged }, [staged]);
    return;
  }
  cacheMisses += cacheEnabled ? 1 : 0;
  trace("enqueue", { id, frameN, target, samplePtsUs });
  decodeQueue.push({ id, frameN, targetUs, sampleIndex: target, samplePtsUs, startedMs: -1, fedMs: -1 });
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
  const data = event.data as { type: string; url?: string; cacheFrames?: number; id?: number; frameN?: number; fps?: number; refreshTicket?: boolean; refreshUrl?: string; refreshError?: string; cacheCapBytes?: number; forceSwDecode?: boolean; decodeTiming?: boolean };
  try {
    if (data.type === "init" && data.url) {
      // DEFECT-4K60-SESSION-HANG：init 失败必须回发 error——旧实现 fire-and-forget
      // 的 rejection 在 worker 内被吞，客户端只能等满 15s 泛化超时拿不到真实错误。
      void init(data.url, data.cacheFrames ?? 0, data.refreshTicket === true, data.cacheCapBytes, data.forceSwDecode, data.decodeTiming)
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
