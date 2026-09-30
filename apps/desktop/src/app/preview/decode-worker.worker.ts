/**
 * M3-0 P3 WebCodecs 寻址 Worker：手写 BMFF(MP4) demuxer + VideoDecoder。
 *
 * demuxer 决策（冻结方案 §7.3"开工时定并写入报告"）：**手写 BMFF 解析**，
 * 不引入 mp4box.js —— 探针素材为自带 faststart 单视频轨 H.264（无 B 帧，
 * openh264），仅需 stsd/stts/stss/stsc/stsz/stco/co64/ctts 八张表；
 * ctts 仍按规范解析以兼容生成 proxy 产物）。
 * 长帧缓存模式：LRU 缓存已解码 VideoFrame（close() 纪律 + 内存记账）。
 * A03：demux 后构建 sample-index（PTS 排序索引 + 关键帧二分），seek 定位
 * 由 O(N) 线性扫描改二分——解码喂包顺序不变（索引只改查找）。
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
  | { type: "ticket-refresh-request"; id: number }
  | { type: "trace"; event: string; detail: Record<string, unknown> };

/** 解码 RTT 分段计时（P33 规划门 §3.1；decodeTiming=true 时随 frame 消息捎带，
 *  默认关、生产零开销）。两段均为 worker 时钟内的**时长**（跨线程时钟原点
 *  不同，不传绝对时间戳、不做跨钟合成——客户端以自身 RTT 总量减两段得
 *  「排队 + 双跳传输」残差）。
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
 * 上最近邻采样可偏离 targetUs 达 33ms，按 targetUs 半帧匹配会永不命中而超时）。
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
  /** 消息到达 worker（onmessage 入口）时刻：`startedMs - arrivedMs` = **排队等待**
   *  ——即本请求在 worker 侧等前一个请求处理完的时间。它不属于 feed/output 任何
   *  一段，是客户端「残差」里唯一能在 worker 内拆出来的部分。
   *  2026-09-30 真机 dev 实测：残差 p95 53.2ms 而 feed 0 / output 3.9ms，需要它来
   *  判定「worker 排队」与「主线程投递/调度」各占多少。 */
  arrivedMs: number;
  /** 最后一批喂包提交时刻（feedMs 终点 = outputMs 起点；-1 = 未喂包）。 */
  fedMs: number;
  /** 停摆自恢复标记：喂到文件尾仍不匹配时允许「重置解码器 + 重锚关键帧」重试
   *  一次（防同一请求无限重试）。 */
  retried?: boolean;
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
 *  容量公式：min(HARD_CAP, max(MIN, 回跳深度+2, 实测喂包超前量+2))——重排覆盖
 *  feedEndFor 的排序空间喂包终点保证，stash 只兜「已释放待请求」帧。 */
const READY_BY_PTS_MIN = 6;
/** 持有窗硬上限。P33 后续（hevc-b-afterfix-r2 trace）：B3 金字塔的 stash 需求窗 =
 *  LOOKAHEAD(3) + 回跳深(6) + 余量 1 ≈ 10 帧，容量 6 时驱逐策略再优也必然
 *  miss（target 535/985：目标 pts 在两次请求间隔内被容量挤压驱逐 →
 *  missingStuck 冷启整 GOP → 3-4 帧空窗）。
 *  2026-09-30（repro-user-h264-3440-r1 trace）：**上界的真正决定因素是解码器
 *  输出管线深度**，不是重排深度。用户原素材 3440x1440 H.264（无 B 帧）实测
 *  「喂到 target+11 才吐第一帧」，而旧公式按回跳深度 0 算得窗 4 → 刚吐出的
 *  后续帧被自己的容量挤掉 → 客户端下一个顺序请求就是 miss → missingStuck
 *  冷启整 GOP（154 次/41s、每次 ~300ms 空窗）→ 丢帧 242/1241、合成间隔
 *  p95 200ms（探针）/丢帧 452（App 内）。
 *  冷启第一批共 ~11-15 帧必须全部留住（客户端随后逐个顺序取用），所以持有窗
 *  本身可以要得很宽；**但真正不可越过的上限是解码器表面池**：见下方
 *  `UNCLOSED_FRAME_BUDGET`（未 close 的 VideoFrame 总量超阈值后解码器既不吐
 *  输出也不再消费输入）。两个约束由「窗自适应增长 + 全局预算强制驱逐」共同
 *  满足。 */
const READY_BY_PTS_HARD_CAP = 12;
let readyByPtsMax = READY_BY_PTS_MIN;
/** **自适应未 close 持有帧预算**（持有窗 + GOP 锚 + LRU 缓存三者合计）。
 *
 *  为什么必须有全局口径：2026-09-30 seek→play 复测抓到真实停摆——窗自适应扩到
 *  16 后（窗 16 + 缓存 3 + 锚 1 = 20 帧未 close），解码器**既不吐输出也不再消费
 *  输入**：`dq`（decodeQueueSize）单调攀升、目标永不吐、客户端时间码冻结、指标条
 *  `解码 p95 1502ms`；把预算压到 6 后同一 spec 六档跳转全部通过。这与历史实测
 *  「未 close 持有 >~13 帧 → 输出永久停滞」一致：**只按持有窗设上限是不够的，
 *  缓存与锚同样占用表面池**，而且**池大小随编解码/分辨率而变**（3440x1440 H.264
 *  容得下 13+，720x1280 HEVC 在 10 就停摆）。
 *
 *  所以上限不能写死：初始保守（8），只在**未观察到背压**时按需逐级上调（最多
 *  MAX），一旦在喂包循环里观察到 `dq > 0` 的静默积压（＝表面池告急）立即回落到
 *  当前水位之下并让出表面。增长靠 growHoldCapFor、收缩靠 shrinkForBackpressure。 */
const UNCLOSED_FRAME_BUDGET_MIN = 5;
/** 预算上限 = **实测安全水位，且按编解码分档**（见下表；通用解见实施记录 L8）。
 *
 *  | 素材 | 释放首帧所需喂入（管线深度） | 容得下的未 close 持有量 |
 *  |---|---|---|
 *  | 3440x1440 H.264（无 B 帧） | 11 | 13+ |
 *  | 720x1280 HEVC（B 帧） | ~8 | ~9-10 即停摆 |
 *
 *  单一水位两边都不讨好：取 8 → H.264 大素材冷启首批 11 帧装不下 → 驱逐 miss →
 *  偶发起播丢帧（实测 9~24 帧）；取 14 → HEVC 撞池后整段停摆（实测 210/1777）。
 *  故按 demux 得到的 codec 分档：HEVC 解码器内部参考面更多、表面池更紧，取 8；
 *  其余（H.264/AV1）取 12（覆盖 11 的管线深度 + 1 余量）。 */
const UNCLOSED_FRAME_BUDGET_MAX = 12;
const UNCLOSED_FRAME_BUDGET_HEVC = 8;
let unclosedBudget = 8;
/** 本会话是否已观察到解码器背压（一旦为真就不再上调预算：宁可多解码几次，
 *  也不能再撞池上限停摆）。 */
let backpressureSeen = false;
/** 连续成功交付的请求数（背压时清零）。预算上调要求**持续健康**——单次成功
 *  不足以证明池还有余量，而撞池的代价是永久停摆 + 用户可见错误横幅。 */
let healthyDeliveries = 0;
const HEALTHY_DELIVERIES_PER_RAISE = 3;
/** 实测「释放目标所需超前喂包量」峰值 = 解码器输出管线深度。
 *  持有窗前摄到该深度，保证解码器已经吐出、客户端即将顺序请求的帧不被驱逐。 */
let feedAheadPeak = 0;

/** 当前未 close 的持有帧总数（预算口径三处合计）。 */
function heldFrameCount(): number {
  return readyByPts.size + cache.size + (gopAnchor ? 1 : 0);
}

/** 预算内腾位置：**先丢 LRU 缓存最旧**（已交付过的帧，只服务重复请求），
 *  缓存空了再丢持有窗里展示序最新的帧（未交付帧里最不紧急的）。
 *  正常顺播不该触发（窗按实测超前量增长且 ≤ 硬上限）。 */
function releaseForBudget(): void {
  while (heldFrameCount() >= unclosedBudget) {
    if (cache.size > 0) {
      const oldest = cache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      const evicted = cache.get(oldest)!;
      cacheBytes -= evicted.allocationSize();
      try { evicted.close(); resClosed += 1; } catch { /* 已关闭 */ }
      cache.delete(oldest);
      cacheEvictions += 1;
      trace("budget_evict_cache", { key: oldest, held: heldFrameCount(), budget: unclosedBudget });
      continue;
    }
    if (readyByPts.size > 0) { evictNewestStashed(); continue; }
    break; // 只剩 GOP 锚：锚必须留（关掉会破坏参考链），到此为止
  }
}

/** 观察到解码器背压（静默 + dq>0）时的**收缩**：表面池告急，立即把预算压到当前
 *  水位之下并让出表面，同时冻结持有窗上限（不再前摄扩容）。返回释放的帧数。 */
function shrinkForBackpressure(): number {
  backpressureSeen = true;
  healthyDeliveries = 0;
  const before = heldFrameCount();
  unclosedBudget = Math.max(UNCLOSED_FRAME_BUDGET_MIN, Math.min(unclosedBudget, before - 2));
  readyByPtsMax = Math.max(2, Math.min(readyByPtsMax, unclosedBudget - 1));
  feedAheadPeak = Math.min(feedAheadPeak, readyByPtsMax);
  while (heldFrameCount() > unclosedBudget) {
    if (readyByPts.size > 0) { evictNewestStashed(); continue; }
    if (cache.size > 0) { releaseForBudget(); continue; }
    break;
  }
  const freed = before - heldFrameCount();
  trace("backpressure_shrink", { freed, held: heldFrameCount(), budget: unclosedBudget, cap: readyByPtsMax });
  return freed;
}

/** 持有窗按实测超前量即时扩容——必须发生在**输出回调之前**（喂包循环内调用），
 *  否则刚吐出的帧会先被旧容量驱逐。扩容要花预算：只有在本会话**未观察到背压**
 *  时才逐级上调预算（一次一级），否则只维持当前水位。 */
function growHoldCapFor(aheadSamples: number): void {
  if (aheadSamples <= feedAheadPeak) return;
  feedAheadPeak = aheadSamples;
  const want = Math.min(READY_BY_PTS_HARD_CAP, Math.max(READY_BY_PTS_MIN, aheadSamples + 2));
  if (want <= readyByPtsMax) return;
  const needed = want + cache.size + (gopAnchor ? 1 : 0);
  if (needed > unclosedBudget) {
    // 已见过背压、或还没积累到足够长的健康序列 → 不上调（宁多解码一次，
    // 不再撞池上限：撞池 = 解码器永久停摆 + 用户可见错误横幅）。
    if (backpressureSeen || healthyDeliveries < HEALTHY_DELIVERIES_PER_RAISE) return;
    unclosedBudget = Math.min(UNCLOSED_FRAME_BUDGET_MAX, unclosedBudget + 1);
    healthyDeliveries = 0;
    trace("budget_raise", { budget: unclosedBudget, want, ahead: aheadSamples });
  }
  readyByPtsMax = Math.min(want, unclosedBudget);
  trace("hold_cap", { cap: readyByPtsMax, ahead: aheadSamples, budget: unclosedBudget });
}

/** 客户端消费前沿 = 已请求的**最大**采样索引（展示序单调推进；冷启/回退重置）。
 *  客户端按展示序逐个往后取帧，所以前沿之前的帧已被取走（可安全驱逐），
 *  前沿之后的帧即将被请求（必须保留）。2026-09-30（repro-user-h264-3440-r1）：
 *  旧驱逐锚 = min(上一请求 pts, 新帧 pts) → 距锚最远者先丢 → 对**顺播直线流**
 *  （无 B 帧）恰好总是丢最新吐出的帧（客户端下一个要的），每 ~8 帧一次 miss
 *  → missingStuck 冷启整 GOP。锚定消费前沿后，驱逐只落在已消费侧。 */
let requestFrontier = -1;
/** 已吐出的最大 pts 排序位（stash_put 即视为已吐出——cache/stash 驱逐后
 *  该输出永久不可达）。同 GOP 请求 miss 时用它区分「还在重排缓冲里」与
 *  「已吐出但被驱逐」：前者续喂等输出是正确姿势，后者续喂到文件尾也永远
 *  等不到（真机「seek 后播放卡住 45s 看门狗」形态，seek-play-simulation 仿真
 *  15/20 位置复现）。冷启重建从新起点重新计量（decodeSamples 同步）。 */
let emittedRankMax = -1;

/** 持有窗溢出时驱逐**展示序最新**（rank 最大）的帧。
 *  为什么丢最新而不是丢最老：客户端是**顺序消费者**——它从消费前沿起按展示序
 *  逐个取帧。丢掉最老 = 立刻丢掉它下一个请求的目标 → 当场 miss → 冷启重建
 *  （昂贵且连锁）；丢掉最新 = 损失落在最远处，前沿方向上仍保有**连续跑道**，
 *  客户端能继续顺畅消费，最坏也只是跑道尽头一次 miss。
 *  （2026-09-30 repro-user-h264-3440-r1：真正的病根是窗容量 < 解码器首帧前
 *  必须喂入的采样数（管线深度），导致溢出必然发生且每 ~8 帧一次。容量已由
 *  growHoldCapFor 按实测超前量前摄扩容；本函数只兜底，正常顺播不该触发。） */
function evictNewestStashed(): void {
  let worstKey = -1;
  let worstRank = -1;
  for (const key of readyByPts.keys()) {
    const rank = sampleIndex ? rankOfPts(key) : key;
    if (rank > worstRank) { worstRank = rank; worstKey = key; }
  }
  if (worstKey < 0) return;
  const old = readyByPts.get(worstKey);
  readyByPts.delete(worstKey);
      try { old?.close(); if (old) resClosed += 1; } catch { /* 已关闭 */ }
  trace("evict_newest", { pts: worstKey, rank: worstRank, frontier: requestFrontier, cap: readyByPtsMax });
}

function stashByPts(frame: VideoFrame): void {
  while (readyByPts.size >= readyByPtsMax) evictNewestStashed();
  releaseForBudget(); // 全局预算（窗 + 缓存 + 锚）：超阈值解码器会停摆
  readyByPts.set(frame.timestamp, frame);
  if (sampleIndex) emittedRankMax = Math.max(emittedRankMax, rankOfPts(frame.timestamp));
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
      //   下个请求 miss → 同 GOP 无包可喂 → 看门狗超时（2026-09-28 边界
      //   仿真复现，tests/decode-reorder-playback.test.ts）。
      // - 1_000（1ms）容差在 HEVC/VFR 半帧窗上永不命中 → decode timeout
      //   （e9201e9 真机现场）。
      // 半帧是两者平衡：相邻帧间距 ≥ 33ms > 16.7ms，永不偷相邻；VFR 半帧
      // 偏移 16.7ms 仍可命中。
      if (request && Math.abs(frame.timestamp - request.samplePtsUs) <= 16_667) {
        activeRequest = null;
        clearActiveRequestTimer();
        pendingAnchorPts = -1;
        healthyDeliveries += 1; // 预算上调的健康计数（见 growHoldCapFor）
        if (sampleIndex) emittedRankMax = Math.max(emittedRankMax, rankOfPts(frame.timestamp));
        const nowMs = performance.now();
        const timing = decodeTiming && request.startedMs >= 0 ? {
          feedMs: request.fedMs >= 0 ? Math.round((request.fedMs - request.startedMs) * 1000) / 1000 : 0,
          outputMs: request.fedMs >= 0 ? Math.round((nowMs - request.fedMs) * 1000) / 1000 : Math.round((nowMs - request.startedMs) * 1000) / 1000,
          // **排队段**：消息到达 worker → 出队开始处理（等前一个请求跑完）。
          // 它不属于 feed/output，是客户端「残差」里唯一能在 worker 内拆出来的部分。
          queueMs: Math.round((request.startedMs - request.arrivedMs) * 1000) / 1000,
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
        // 诊断（2026-09-30 seek→play 挂起定位）：活动请求存在、但该输出落在
        // 半帧容差之外且 pts 邻近（±300ms）——即「解码器吐了邻近帧却没吐目标」，
        // 是喂包终点/重排释放的真实形状（区别于「目标根本没解出来」）。
        if (request && Math.abs(frame.timestamp - request.samplePtsUs) <= 300_000) {
          trace("unmatched_near", {
            out: frame.timestamp, want: request.samplePtsUs,
            deltaUs: Math.round(frame.timestamp - request.samplePtsUs),
            outRank: sampleIndex ? rankOfPts(frame.timestamp) : -1,
            wantRank: sampleIndex ? rankOfPts(request.samplePtsUs) : -1,
            wantSample: request.sampleIndex, held: heldFrameCount(),
          });
        }
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
        decoder?.reset();
        decoder?.configure(decoderConfig as VideoDecoderConfig);
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

/** 清空 LRU 缓存（冷启重建时调用：缓存帧属于已关闭的旧解码器）。 */
function clearCache(): void {
  for (const frame of cache.values()) {
    try { frame.close(); resClosed += 1; } catch { /* 已关闭 */ }
  }
  cache.clear();
  cacheBytes = 0;
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

async function init(url: string, cacheFrames: number, hasTicketRefresh: boolean, cacheCapBytes?: number, forceSwDecodeArg?: boolean, decodeTimingArg?: boolean, verifyTraceArg?: boolean): Promise<void> {
  forceSwDecode = forceSwDecodeArg === true;
  decodeTiming = decodeTimingArg === true;
  VERIFY_TRACE = verifyTraceArg === true || (self as unknown as { VERIFY_TRACE?: boolean }).VERIFY_TRACE === true;
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
  // 每 GOP 边界连环冷启重建）。按实测深度抬高，上限守住 D3D11 表面池。
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
      readyByPtsMax = Math.min(READY_BY_PTS_HARD_CAP, Math.max(READY_BY_PTS_MIN, maxBackstep + 2));
      // 持有窗真正的下界来自**解码器输出管线深度**（喂到 target+N 才吐目标），
      // 与重排深度无关——无 B 帧直线流 maxBackstep=0 也不能用窗 4（repro-user-h264
      // -3440-r1：窗 4 对管线深 11 → 客户端顺序请求连环 miss → 冷启 154 次）。
      // 该深度无法离线预知，由 growHoldCapFor 在喂包时按实测即时扩容（硬上限内）。
      feedAheadPeak = 0;
      trace("hold_cap_init", { cap: readyByPtsMax, backstep: maxBackstep });
    }
  }
  cacheEnabled = cacheFrames > 0;
  cacheCap = cacheFrames;
  // 预算按编解码分档（见 UNCLOSED_FRAME_BUDGET_MAX 的表）：HEVC 解码器表面池更紧。
  {
    const isHevc = /^h(ev|vc)/i.test(demuxed.codec ?? "");
    unclosedBudget = Math.max(UNCLOSED_FRAME_BUDGET_MIN, isHevc ? UNCLOSED_FRAME_BUDGET_HEVC : UNCLOSED_FRAME_BUDGET_MAX);
    trace("budget_init", { codec: demuxed.codec, budget: unclosedBudget, width: demuxed.width, height: demuxed.height });
  }
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
  releaseForBudget(); // 全局预算：缓存的帧也占解码器表面池
  cache.set(sampleIndex, frame);
  cacheBytes += frame.allocationSize();
}

/** P33 W2.6：EOF 重排滞留的定格替代（2026-09-29 真机「播放到尾再点播放无效」根修）。
 *  尾 GOP 截断素材（真机素材：88 帧 GOP 尾部仅 20 帧，最后 3 帧滞留 D3D11
 *  重排缓冲永不吐出）逐帧报错 → 片尾形成永久洞 → currentFrame 停在 last-3、
 *  播放靠 2s 停滞兜底结束，而 play() 回卷条件（currentFrame >= last）永不成立
 *  → 「再点播放无效」。改为贴标准播放器「尾帧定格」语义：取 stash/缓存中
 *  pts ≤ 目标的最近持有帧 clone 回填（不消耗持有者所有权；同时 cachePut 到
 *  目标位，后续同目标请求直接缓存命中）。无任何持有帧时返回 false，调用方
 *  回落原报错路径（strike/降级兜底）。 */
function postEofFreezeFrame(request: DecodeRequest): boolean {
  const targetPts = request.samplePtsUs;
  let donor: VideoFrame | null = null;
  let donorPts = -Infinity;
  for (const [pts, frame] of readyByPts) {
    if (pts <= targetPts + 1_000 && pts > donorPts) { donorPts = pts; donor = frame; }
  }
  if (!donor && cacheEnabled) {
    let donorIdx = -1;
    for (const key of cache.keys()) {
      if (key > request.sampleIndex || key <= donorIdx) continue;
      const pts = sampleIndex?.ptsUs[key];
      if (pts === undefined || pts <= targetPts + 1_000) donorIdx = key;
    }
    if (donorIdx >= 0) donor = cache.get(donorIdx) ?? null;
  }
  if (!donor) return false;
  activeRequest = null;
  clearActiveRequestTimer();
  trace("eof_freeze_frame", { target: request.sampleIndex, donorPts: donorPts === -Infinity ? null : donorPts });
  // 先 clone 出全部副本再触碰 cachePut：cachePut 满容驱逐可能恰好作用于
  // donor 的底层帧（同 pts 旧条目 close → 后续 donor.clone() 抛
  // "Cannot clone closed VideoFrame"，user-eof-r1 实测 frame 1774）。
  const out = donor.clone();
  let cached: VideoFrame | null = null;
  try { cached = donor.clone(); } catch { /* donor 已关闭：out 已在手，仅放弃缓存 */ }
  if (cached && cacheEnabled) cachePut(request.sampleIndex, cached);
  else cached?.close();
  resPosted += 1;
  post({ type: "frame", id: request.id, frameN: request.frameN, timestampUs: out.timestamp, fromCache: true, samplesFed: 0, fromKeyframe: request.sampleIndex, allocationSize: out.allocationSize(), timing: null, frame: out }, [out]);
  pumpQueue();
  return true;
}

function pumpQueue(): void {
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
  const coldStart = (start: number, generation: number): void => {
    // A03：关键帧回退二分（原逐样本线性回退，长 GOP 深 seek O(GOP)）
    releaseGopAnchor();
    drainIntermediateRing();
    clearReadyByPts();
    // 2026-09-30（seek→play 挂起根修）：缓存里的帧属于**已关闭的旧解码器**，
    // 必须一并释放——否则它们的表面一直占着 D3D11 池，新解码器分配不到表面。
    clearCache();
    // 整例重建 vs 实例内重置：**真机 D3D11 上 close()+createDecoder() 会让新实例
    // 静默停摆**——2026-09-30 seek→play 复测（3 轮同形）：新解码器收下 ~18-38 包后
    // 既不吐输出也不再消费输入（dq 20→48→80→112 单调攀升、目标永久不吐、客户端
    // 时间码冻结、指标条 `解码 p95 1502ms`）；此时 held 仅 9 帧、复活时 held=0，
    // 故与「我们持有太多帧」无关，是新实例本身起不来。改用 reset()+configure()：
    // 同一实例内重置，不重新申请硬件解码会话/表面池，无此失效模式。
    // 历史注记：旧实现选 close()+新建是因为「reset 后整片重解产出花屏」，
    // 该现象发生在**输出帧被 close() 与解码器表面池复用竞态**时期（fixed3/fixed11），
    // 现在输出帧靠持有窗/缓存管理并延迟关闭，花屏复现见 evidence 对照。
    try {
      decoder?.reset();
      decoder?.configure(decoderConfig as VideoDecoderConfig);
      trace("decoder_reset", { start, gen: generation, held: heldFrameCount() });
    } catch {
      // reset 失败（实例已坏死）→ 兜底整例重建
      try { decoder?.close(); } catch { /* 已关闭 */ }
      decoder = createDecoder();
      decoder.configure(decoderConfig as VideoDecoderConfig);
      trace("decoder_rebuilt", { start, gen: generation, held: heldFrameCount() });
    }
    fedIndex = -1;
    lastFedSample = start - 1;
    lastTargetKey = keyTarget;
    // 消费前沿随重建重置到冷启起点：重建后解码器只保证吐出 [start, ...] 的输出，
    // 前沿之前的帧已被驱逐/关闭，驱逐策略必须按新会话语义计量。
    requestFrontier = start;
    emittedRankMax = sampleIndex ? rankOfPts(((samples[start]!.dts + samples[start]!.ctsOffset) / timescale) * 1e6) - 1 : -1;
    // 冷启首个输出 = 关键帧 IDR：持有为 GOP 锚（见 gopAnchor 注释）
    pendingAnchorPts = ((samples[start]!.dts + samples[start]!.ctsOffset) / timescale) * 1e6;
  };
  let startSample = target;
  trace("decodeSamples", { target, keyTarget, sameGop, lastFedSample, lastTargetKey });
  // P33 W2.8（卡死 + 丢帧共同根因的统一决策）：冷启重建 = 解码器整例重建 +
  // 关键帧重喂（整 GOP 量级）+ clearReadyByPts 丢弃全部已解暂存——代价高昂，
  // 只在**确实必要**时做：
  //  1. neverFed：从未喂包（首请求）；
  //  2. missingStuck：目标输出**已吐出但被 cache/stash 驱逐**（decodeFrame
  //     两路均未命中才到本函数）——续喂到文件尾也永远等不到（真机「时间线
  //     跳转后点播放卡住 → 45s 看门狗」形态；seek-play-simulation 15/20 位置
  //     复现）。只有重建重解能拿到正确帧；
  //  3. farForward：远距前跳且关键帧重喂更便宜（比热态续喂省 >REBUILD_OVERHEAD
  //     个采样）。
  // 其余一律**热态续喂**：同 GOP 连续、跨 GOP 连续过界（展示序请求在 GOP
  // 边界天然以 ±maxStagger 采样回跳/过界，旧「非同 GOP 即冷启」在每 88 帧
  // 边界触发一次重建风暴 = 实测 1700 帧冷启 20 次、丢帧 115/152 的主源）、
  // 小后跳等重排缓冲释放——喂包从 lastFedSample+1 起**无缝衔接**，参考链
  // 不断，绝不重建。
  const targetRank = rankOfPts(request.samplePtsUs);
  const missingStuck = targetRank <= emittedRankMax;
  const neverFed = lastFedSample < 0;
  const forwardGap = target > lastFedSample ? target - lastFedSample : 0;
  const rebuildCost = Math.max(0, target - keyTarget);
  const farForward = target > lastFedSample && forwardGap > rebuildCost + REBUILD_OVERHEAD;
  // 目标远落在**已喂游标之后**（超出重排窗 + lookahead）：解码器不会再吐出它，
  // 而续喂只会朝前越走越远（实测形态：请求 525 却一路喂到文件尾 1776 仍不匹配，
  // 最后走 EOF 兜底报 watchdog 错误横幅）。此时唯一出路是按关键帧重解。
  const behindCursor = target + Math.max(2, sampleIndex?.maxStagger ?? 0) + BFRAME_LOOKAHEAD < lastFedSample;
  if (neverFed || missingStuck || farForward || behindCursor) {
    trace("cold_start", { target, keyTarget, neverFed, missingStuck, farForward, behindCursor, lastFedSample, emittedRankMax, targetRank });
    startSample = keyTarget;
    // 换代必须在 coldStart 之前且只增一次：coldStart 内的「延迟复活」要以
    // 本次请求的代际为准（之前的写法在 coldStart 内 +1、此处再 +1，复活时
    // 代际已过期 → 新解码器永不生产 → 首帧请求直接挂住）。
    const generation = ++feedGeneration;
    coldStart(startSample, generation);
    samplesFed = 0;
    fromKeyframe = startSample;
    fedIndex = target;
    void feedSamples(samples, startSample, target, timescale, request, generation);
    return;
  }
  // 热态续喂：GOP 锚推进到目标所在 GOP（跨 GOP 连续过界时锚随目标走）
  lastTargetKey = keyTarget;
  // 从已喂游标无缝续喂；target ≤ lastFedSample（小后跳/输出滞留重排缓冲）
  // 时本段可能无可喂区间——feedSamples 的增量延伸（EXTEND_STEP，dq 排空才
  // 延伸）负责等释放/补喂，绝不原地死等 45s 看门狗。
  const needEnd = feedEndFor(target);
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

/** P33 W2.8：冷启重建的固定代价（解码器整例重建 + 清暂存 + GOP 锚重建）折算
 *  采样数。前跳续喂成本 = forwardGap，重建成本 = rebuildCost + REBUILD_OVERHEAD
 *  ——只有重建显著更省才重建（远距 seek），否则热态续喂保参考链与暂存。 */
const REBUILD_OVERHEAD = 24;

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
  forcedEnd?: number,
): Promise<void> {
  try {
    // 输出驱动的增量喂包（2026-09-28 真浏览器定位重构）：解码器释放滞后
    // 随 B 金字塔结构与驱动行为浮动（同素材实测 2~7+），任何静态喂包终点
    // 公式都无法保证目标输出必达——喂少了挂 45s 看门狗，懒 flush 又与
    // 后续喂包竞态（flush 后需关键帧）。改为按批喂包 + 每批后检查：
    // 目标匹配即停（正常帧 1~2 批），未匹配继续下一批直至目标达成或
    // 喂到所在 GOP 终点（截断尾 GOP 目标 = 文件尾——见下方 W2.6 终版条件）。
    // 批大小取「交错跨度+1」（maxStagger，见 sampleIndex）保证每批至少
    // 推进一个排序位。
    // 代际守卫（feedGeneration）：匹配完成/冷启重建都会使本循环失效——
    // 每步检查代际，不同代立即退出，绝不让两个喂包流交错喂同一解码器。
    const batch = Math.max(BFRAME_LOOKAHEAD, sampleIndex?.maxStagger ?? 0) + 1;
    // P33 W2.6（user-eof-r6..r8 三轮 trace 定稿）：feedEndFor 启发式对
    // **截断尾 GOP**（真机素材最后 GOP 仅 20 帧）会估短——冷启喂完 hardEnd
    // 后目标仍滞留重排缓冲，原实现原地等输出 45s 看门狗。无差别的「miss 即
    // 延伸」被 r7/r8 证伪（中段请求 dq 积压期 miss 也延伸 → 整 GOP 狂喂、
    // 丢帧 343/900+ 定格）。终版条件：**延伸仅限目标位于最后一个 GOP**
    // （截断尾 GOP 是唯一启发式系统性低估的场景；r3 播放段零问题佐证），
    // 延伸终点 = 文件尾；且延伸前要求解码器队列已清空（dq==0——输出确实
    // 空转而非在路上）。中段 GOP 的 miss 仍走看门狗兜底（r3 实测零发生）。
    const lastGopKey = sampleIndex ? sampleIndex.keyframes[sampleIndex.keyframes.length - 1] ?? -1 : -1;
    const inLastGop = keyframeAtOrBefore(sampleIndex!, target) === lastGopKey;
    const hardEnd = forcedEnd ?? Math.min(samples.length - 1,
      inLastGop ? samples.length - 1 : feedEndFor(target));
    let fed = startSample - 1;
    let end = hardEnd;
    // P33 W2.7 主挂死根修（真机「时间线跳转后点播放卡住 45s 看门狗」）：喂包
    // 终点是启发式（feedEndFor 按排序位+偏移估算释放滞后），估短后旧实现
    // **原地等输出**直到 45s 看门狗——目标输出仍在重排缓冲里，只是没喂够
    // 参考帧不吐。改为喂完当前段仍未匹配时**增量延伸**（输出驱动、匹配即停），
    // 延伸到文件尾仍 miss = 永久不可达 → 下方 EOF 定格/报错（秒级，不再挂 45s）。
    /** EOF 判定前的排空预算（ms）：dq>0 时输出仍在途，最多等这么久才允许
     *  报「永久不可达」。真截断尾 GOP 喂尽后 dq 会归零（无新输入）；该预算
     *  只挡「输出慢」不挡「真滞留」——后者 dq 归零后立即报错。 */
    const EOF_DRAIN_BUDGET_MS = 1_500;
    // 2026-09-30（repro-user-h264-3440-r1 trace 定稿）：**dq 不能作为「输出已排空」
    // 的依据**——批间让步（setTimeout 0）期间解码器必把 input queue 抽干，
    // dq 归零只代表「输入已被接受」，输出仍可能在 D3D11 管线里（3440x1440 H.264
    // 实测喂到 target+11 才吐第一帧）。旧逻辑 `dq==0 → 延伸 32 采样` 因此几乎
    // 每次都命中：41s 内延伸 133 次、每次 flush 出 32 帧超前输出，持有窗（当时
    // 按回跳深度算得 4）装不下 → 客户端顺序请求 miss → 冷启整 GOP 154 次。
    // 现改为**输出活性驱动**：段末先等输出，只要还有输出在到达就继续等（管线深
    // = 正常），完全停滞 STALL_MS 才判定「喂得不够」，且每次只延伸一拍（几何
    // 放大到上限），把超前量压到解码器真实需要的最小值。
    // 2026-09-30 追加：停滞时还要看 dq——dq>0 表示输入积压（背压停摆），
    // 此时**只能等**不能喂（见段末三态判定）。
    const STALL_MS = 30;
    /** 背压（dq>0）静默时的最长等待：等解码器把积压输入消化掉再决定是否延伸。 */
    const BACKPRESSURE_WAIT_MS = 1_500;
    let extendStep = batch;
    // **单请求总预算**：喂包 + 延伸必须在这个墙钟内收敛，否则直接走
    // 定格/停摆兜底。没有它时，撞池停摆的请求会以「每轮等 1.5s 背压 + 小步延伸」
    // 一路喂到文件尾（1776 采样 ≈ 55 轮 ≈ 80s），先撞客户端 50s 超时 → 错误文案
    // 命中降级正则 → 整个输入被钉死在 FFmpeg IPC 慢路径（真机 dev 实测
    // 解码 p95 180.5ms、丢帧 95）。预算 6s 足够覆盖最长 GOP（4K 5s GOP）冷启。
    const REQUEST_FEED_BUDGET_MS = 6_000;
    const feedDeadline = performance.now() + REQUEST_FEED_BUDGET_MS;
    for (;;) {
      while (fed < end) {
        const batchEnd = Math.min(end, fed + batch);
        for (let index = fed + 1; index <= batchEnd; index++) {
        if (generation !== feedGeneration) return; // 换代：让位新喂包流
          if (!decoder) return; // 解码器已被回收（新冷启接管）
          const sample = samples[index]!;
          // P33 W2.7：Range 读单样本看门狗（10s）——读挂起（协议流停滞/票据
          // 续期挂死）时旧实现让 activeRequest 挂满 45s 看门狗才报错；快速失败
          // 走 catch（清占位 + 续队），把 I/O 类挂死从 45s 压到 10s 量级。
          const chunkData = await Promise.race([
            rangeSource!.read(sample.offset, sample.size),
            new Promise<never>((_, reject) => setTimeout(
              () => reject(new Error(`RANGE_READ_TIMEOUT: 采样 ${index} 字节读取超时（10s）`)), 10_000)),
          ]);
          if (!decoder) return; // 读期间被冷启回收
          const chunk = new EncodedVideoChunk({
            type: sample.sync ? "key" : "delta",
            timestamp: ((sample.dts + sample.ctsOffset) / timescale) * 1e6,
            data: chunkData,
          });
          decoder.decode(chunk);
          samplesFed += 1;
          lastFedSample = index;
          // 持有窗前摄扩容：**必须在输出回调之前**（输出在本函数让步点落地）——
          // 解码器已经吐出/即将吐出的后续帧正是客户端马上要请求的帧。
          growHoldCapFor(lastFedSample - request.sampleIndex);
          trace("feed", { index, batchEnd, gen: generation, dq: decoder?.decodeQueueSize ?? -1, stash: readyByPts.size });
        }
        fed = batchEnd;
      // 批间让步：输出回调在任务队列中落地后再检查占位。
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (generation !== feedGeneration) return; // 换代：让位新喂包流
        if (activeRequest?.id !== request.id) return; // 目标已匹配：立即停喂
      }
      // 本段喂完仍未匹配：已到文件尾 → 走下方 EOF 定格/报错；
      if (lastFedSample >= (sampleIndex?.count ?? 0) - 1) break;
      // 单请求预算耗尽：不再无限延伸，交给下方定格/停摆兜底（秒级收敛）。
      if (performance.now() >= feedDeadline) {
        trace("feed_budget_exhausted", { target: request.sampleIndex, fed: lastFedSample, dq: decoder?.decodeQueueSize ?? -1 });
        break;
      }
      // 段末三态判定（2026-09-30 seek→play 停摆实锤后定稿）：
      //  a) 有新输出持续到达 → 管线还在吐，继续等（管线深是正常，不喂）；
      //  b) 静默 **且 dq > 0** → 解码器输入积压（表面池/背压），**绝不能继续喂**：
      //     实测（窗扩到 16、未 close 20 帧）解码器既不吐输出也不消费输入，
      //     dq 单调攀升 60→312、目标永不吐——此时再喂只会加深停摆。等它排空；
      //  c) 静默 **且 dq == 0** → 解码器确实饿着（终点估短）→ 小步延伸。
      //   注：dq 在批间让步后归零是常态（输入已被接受），所以 (c) 必须以
      //   「静默 STALL_MS」为前提，否则会退化成「每次让步都延伸」的旧狂喂路径。
      let lastOutputCount = resDecoded;
      let lastOutputAt = performance.now();
      const waitStart = lastOutputAt;
      let backedUp = false;
      let shrunk = false;
      for (;;) {
        await new Promise<void>(resolve => setTimeout(resolve, 5));
        if (generation !== feedGeneration) return;
        if (activeRequest?.id !== request.id) return;
        const now = performance.now();
        if (resDecoded !== lastOutputCount) { lastOutputCount = resDecoded; lastOutputAt = now; }
        if (now - lastOutputAt < STALL_MS) continue; // (a) 仍在吐
        backedUp = (decoder?.decodeQueueSize ?? 0) > 0;
        if (!backedUp) break; // (c) 真饿着 → 延伸
        // (b) 输入积压 = 表面池告急：先把持有帧让出去（收缩预算），再等排空。
        if (!shrunk) { shrunk = true; shrinkForBackpressure(); }
        if (now - waitStart < BACKPRESSURE_WAIT_MS) continue;
        break;
      }
      if (backedUp) trace("feed_backpressure_wait", { target: request.sampleIndex, fed, dq: decoder?.decodeQueueSize ?? -1, held: heldFrameCount(), budget: unclosedBudget });
      // 停滞/超时仍无匹配 = 喂得不够：小步（几何放大）延伸，绝不一次 +32。
      const nextEnd = Math.min(samples.length - 1, fed + extendStep);
      if (nextEnd <= fed) break;
      trace("feed_extend", { target: request.sampleIndex, fed, dq: decoder?.decodeQueueSize ?? -1, nextEnd, step: extendStep, peak: feedAheadPeak, held: heldFrameCount() });
      extendStep = Math.min(32, extendStep * 2);
      end = nextEnd;
    }
    // P33 W2.6 EOF 边界（postmortem 1780/1783/1786/1789 看门狗定位；W2.5 的
    // flush 救援已废弃——eof-flush-r1..r3：D3D11 硬解尾帧缺后续参考时
    // flush() promise 永不落定、reset 丢弃排队输出，重排队后又冷启撞同一
    // 堵墙循环到客户端 50s 超时）。喂尽文件尾且目标未匹配（截断尾 GOP 的
    // 永久不可达帧，真机素材 1774-1776）：先试定格替代（尾帧定格语义）；
    // 无持有帧才立即报错（消息含 watchdog 词命中降级正则），由
    // preview-session maybeFallBackToFfmpeg 连续 2 次判定降级 FFmpeg B 后端
    // （窗口解码无此边界），把 45-50s 挂起压到秒级。
    // P33 W2.8 后续（无B帧回归修复）：报错/定格前必须 dq 真排空——dq>0 =
    // 输出仍在途（h264-nobf-r2 trace：dq=25 时报错，紧随其后 1770 IDR
    // 才开始吐）。最多再等 EOF_DRAIN_BUDGET_MS：真截断尾 GOP 的滞留帧
    // dq 会归零（喂尽后无新输入）；排队输出到达即正常匹配路径。
    // 收口条件：喂到文件尾（EOF 定格/报错路径）**或**单请求预算耗尽（停摆兜底）。
    const reachedEof = lastFedSample >= (sampleIndex?.count ?? 0) - 1;
    const budgetExhausted = !reachedEof && performance.now() >= feedDeadline;
    if (activeRequest?.id === request.id && reachedEof) {
      const drainDeadline = performance.now() + EOF_DRAIN_BUDGET_MS;
      while (activeRequest?.id === request.id
        && (decoder?.decodeQueueSize ?? 0) > 0
        && performance.now() < drainDeadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 5));
        if (generation !== feedGeneration) return;
      }
      if (activeRequest?.id !== request.id) return; // 等待期间匹配：正常完成
    }
    if (activeRequest?.id === request.id && (reachedEof || budgetExhausted)) {
      // **停摆 vs 真截断**的分水岭：排空预算用尽后 dq 仍 > 0 = 解码器收下输入却
      // 既不吐也不消费（表面池停摆，真截断尾 GOP 会 dq 归零）。
      //  - 停摆 → 重置解码器 + 按关键帧重喂 + **原地重试一次**（成功则静默交付，
      //    用户看不到错误横幅；这是 525/789 这类「喂到文件尾仍不匹配」的唯一出路）；
      //  - 真截断 → 走既有定格替代语义（尾帧定格），无持有帧才报错。
      const stalled = (decoder?.decodeQueueSize ?? 0) > 0;
      if (stalled && !request.retried && sampleIndex) {
        request.retried = true;
        // 重锚点 = 目标所在 GOP 的关键帧（与 decodeSamples 的 keyTarget 同源）
        const retryKey = keyframeAtOrBefore(sampleIndex, target);
        trace("stall_retry", { target, key: retryKey, dq: decoder?.decodeQueueSize ?? -1, held: heldFrameCount() });
        backpressureSeen = true;
        healthyDeliveries = 0;
        releaseGopAnchor();
        clearReadyByPts();
        clearCache();
        try {
          decoder?.reset();
          decoder?.configure(decoderConfig as VideoDecoderConfig);
        } catch { /* 实例已坏死：下面按新锚点再试 */ }
        fedIndex = -1;
        lastFedSample = retryKey - 1;
        lastTargetKey = retryKey;
        requestFrontier = retryKey;
        emittedRankMax = rankOfPts(((samples[retryKey]!.dts + samples[retryKey]!.ctsOffset) / timescale) * 1e6) - 1;
        pendingAnchorPts = ((samples[retryKey]!.dts + samples[retryKey]!.ctsOffset) / timescale) * 1e6;
        const retryGeneration = ++feedGeneration;
        fedIndex = target;
        void feedSamples(samples, retryKey, target, timescale, request, retryGeneration);
        return;
      }
      if (postEofFreezeFrame(request)) return;
      trace("eof_reorder_stuck", { target: request.sampleIndex, lastFedSample, dq: decoder?.decodeQueueSize ?? -1, held: heldFrameCount(), budget: unclosedBudget });
      activeRequest = null;
      clearActiveRequestTimer();
      // **停摆自恢复**：喂到文件尾仍不吐 = 解码器已死在池上限上（后续请求若沿用
      // 同一实例会全部复现同一失败：实测 525 失败后 789 同样喂到文件尾报错）。
      // 立即 reset 到干净状态，让**下一个**请求能重新锚定关键帧并正常解码；
      // 本次请求仍报错（客户端跳过该帧继续播），但**前缀标记为 FRAME_UNREACHABLE**：
      // 这是已自恢复的单帧缺口，不是「后端不可用」——preview-session 的降级闸门
      // 会跳过它，避免两次这样的单帧缺口就把整个输入钉死在 FFmpeg IPC 慢路径上
      // （真机 dev 运行实测：钉死后 解码 p95 180ms、丢帧 95）。
      backpressureSeen = true;
      healthyDeliveries = 0;
      releaseGopAnchor();
      clearReadyByPts();
      clearCache();
      try {
        decoder?.reset();
        decoder?.configure(decoderConfig as VideoDecoderConfig);
      } catch { /* 实例已坏死：下个请求会再撞同一路径并再次尝试 */ }
      fedIndex = -1;
      lastFedSample = -1;
      lastTargetKey = -1;
      trace("stall_recovered", { target: request.sampleIndex, held: heldFrameCount() });
      post({ type: "error", id: request.id, message: `FRAME_UNREACHABLE: 单帧停摆兜底（已重置解码器恢复）frame ${request.frameN} 尾 GOP 重排输出滞留（pts=${request.samplePtsUs}）；已喂至文件尾 lastFedSample=1776` });
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
  // **首/尾越界钳制**（2026-09-30 真机 dev 复现）：请求落在素材最后（或最前）
  // 采样之外 ≤2 帧时，交付最近的端帧而不是报错——播放器的标准语义就是「片尾
  // 定格在最后一帧」。真机 HEVC 素材 duration 59.233s 而最后 pts 59.2s，客户端
  // 会请求 59.2667s（再下一帧）→ 旧实现逐次抛 `no sample for frame`（FFmpeg
  // 路径表现为 Core `DECODE_FRAME_NOT_FOUND`），既刷错误横幅、又把降级闸门推向
  // 慢路径。真越界（>2 帧 / 非端帧）仍按原样报错。
  const EDGE_CLAMP_US = 2 * 33_334;
  const clampedToEdge = target >= 0 && bestDiff > 33_334 && bestDiff <= EDGE_CLAMP_US
    && (target === sampleIndex.count - 1 || target === 0);
  if (target < 0 || (bestDiff > 33_334 && !clampedToEdge)) {
    throw new Error(`no sample for frame ${frameN} (best diff ${bestDiff}us)`);
  }
  if (clampedToEdge) trace("edge_clamp", { frameN, target, bestDiff });
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
  // 客户端消费前沿单调推进（回退/seek 由 coldStart 重置）：驱逐策略以它为
  // 「已被取走 / 即将被请求」的分界。
  if (target > requestFrontier) requestFrontier = target;
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
  decodeQueue.push({ id, frameN, targetUs, sampleIndex: target, samplePtsUs, startedMs: -1, arrivedMs: performance.now(), fedMs: -1 });
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

/** pts → 排序位置（binarySearchPos 的非钳制版：missing_stuck 判定需要
 *  精确 lowerBound 而非夹到末位）。 */
function rankOfPts(ptsUs: number): number {
  const sorted = sampleIndex!.sortedPtsUs;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < ptsUs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data as { type: string; url?: string; cacheFrames?: number; id?: number; frameN?: number; fps?: number; refreshTicket?: boolean; refreshUrl?: string; refreshError?: string; cacheCapBytes?: number; forceSwDecode?: boolean; decodeTiming?: boolean; verifyTrace?: boolean };
  try {
    if (data.type === "init" && data.url) {
      // DEFECT-4K60-SESSION-HANG：init 失败必须回发 error——旧实现 fire-and-forget
      // 在 rejection 与 worker 内被吞，客户端只能等满 15s 泛化超时拿不到真实错误）。
      void init(data.url, data.cacheFrames ?? 0, data.refreshTicket === true, data.cacheCapBytes, data.forceSwDecode, data.decodeTiming, data.verifyTrace)
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
