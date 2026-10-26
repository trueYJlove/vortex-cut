/** C20a FrameSource：帧数据访问的统一适配层（计划第 7 节 C20）。
 *
 * v1 语义 = 数组直访的纯等价适配（getFrame/length 与 ir.frames[n] 逐点
 * 相同）；v2 窗口化（preview-ir-v2 的 manifest/window 协议）在后续接入时
 * 以 ensureRange + 按需窗口装配实现同一接口——消费方（preview-session/
 * probes）不感知帧数据是全量数组还是窗口缓存。
 *
 * 契约约束：
 * - getFrame 返回 undefined 表示帧未就绪（v1 下 = 越界，与数组语义一致）；
 * - v2 下 ensureRange 的 signal 用于取消未开始的窗口请求（AbortSignal
 *   语义），已就绪窗口缓存不受影响；
 * - 帧对象引用稳定性：同 n 重复 getFrame 必须返回同一对象引用（就地
 *   补丁 setPipGeometry 等手势路径依赖该可变性——对象身份即缓存键）。
 */

import type { Ir, IrFrame } from "./ir.js";
import { PREVIEW_IR_V2_MAX_WINDOW_FRAMES } from "@aivideo/contracts";
import { editorPerf } from "./perf-metrics.js";

export interface FrameSource {
  /** 帧数（v1 = ir.frames.length；v2 = manifest.total_frames）。 */
  readonly frameCount: number;
  /** 取帧；越界/未就绪返回 undefined（与 ir.frames[n] 数组语义一致）。 */
  getFrame(frame: number): IrFrame | undefined;
  /** v2 预留：确保 [start, endExclusive) 帧可用（v1 全量在场 = 立即完成）。 */
  ensureRange?(startFrame: number, endFrameExclusive: number, signal?: AbortSignal): Promise<void>;
  /** v2 预留：释放（v1 = 无操作——数组归 Ir 所有，随会话置换）。 */
  dispose?(): void;
  /** v2：窗口未就绪且不在途（显式 buffering 判定；v1 恒 false）。 */
  isBuffering?(frame: number): boolean;
  /** C20c-2：缓存窗口快照（换装迁移用；v1 不提供）。 */
  snapshotWindows?(): WindowSeed[];
}

/** v1 全量数组的 FrameSource 适配（零拷贝——帧对象即 ir.frames 元素）。 */
export function arrayFrameSource(ir: Ir): FrameSource {
  return {
    frameCount: ir.frames.length,
    getFrame: (frame: number): IrFrame | undefined =>
      frame >= 0 && frame < ir.frames.length ? ir.frames[frame] : undefined,
    ensureRange: () => Promise.resolve(),
    dispose: () => undefined,
    isBuffering: () => false,
  };
}

/** C20c-2：跨 manifest 迁移的缓存窗口（快照 = 种子；帧对象原引用共享）。 */
export interface WindowSeed {
  startFrame: number;
  /** startFrame -> frame（与来源缓存同 Map 引用——dispose 只清条目不清 Map）。 */
  frames: Map<number, IrFrame>;
}

/** v2 窗口帧源配置（Planning Gate 2026-09-11 §2.1：窗口 = Core 硬上限 300）。 */
export interface WindowedFrameSourceOptions {
  /** 取窗口响应（main 进程 getPreviewIrV2Window 的已 parse 结果）。 */
  fetchWindow(startFrame: number, frameCount: number, signal: AbortSignal): Promise<{ manifest_id: string; start_frame: number; frame_count: number; frames: Array<Record<string, unknown>> }>;
  /** 单帧估算字节（LRU 8MiB 记账；计划明示非 JS 堆精确值）。 */
  frameBytes?: (frame: IrFrame) => number;
  /** 缓存预算字节（默认 8MiB）。 */
  cacheBytes?: number;
  /** 在途窗口请求上限（默认 2，计划次序 4）。 */
  maxInFlight?: number;
  /** C20c-2：构造期种子窗口（manifest_id 相等 = 同投影，撤销/重做/空转
   *  revision 的缓存整体迁移；manifest_id 不等时不传——关键帧/预设版本对
   *  manifest 盲，无法证明未变，宁重算）。种子帧同样计入 LRU 记账。 */
  seedWindows?: WindowSeed[];
}

interface WindowEntry {
  startFrame: number;
  /** startFrame -> frame（同一对象引用直到整窗逐出——引用稳定性契约）。 */
  frames: Map<number, IrFrame>;
  estimatedBytes: number;
}

const DEFAULT_CACHE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 2;
/** 在途窗口判定为「已悬挂」的阈值（毫秒）。
 *
 * 为什么是 3s（而不是更小或更大）：
 * - 正常一次窗口取数 = 单次 IPC + 已 parse 的投影结果，实测 ~50-70ms
 *   （preview-session.ts seek 路径同口径注释），3s 已是 40 倍开外；
 * - 在途上限默认只有 2，一个窗口悬挂就吃掉半数并发预算，其余 seek 会被
 *   直接拒绝排队（loadWindow 的在途上限分支）——所以"数秒不返回"不是
 *   "慢"，而是病态：解码/磁盘/IPC 已经卡死，等到地老天荒也不会自己好；
 * - 又不取更小值（如 1s）：整机抖动（GC、杀毒扫描、磁盘忙）会让个别窗口
 *   真的慢到几百毫秒，误报会把指示条点成常亮，比"没有提示"更糟。
 * 计时起点 = fetchWindow 发起的那一刻（不是首次被问到的时刻），因此判定
 * 与采样频率无关：采样得稀也不会让结论提前或推迟。 */
const WINDOW_IN_FLIGHT_STALL_MS = 3_000;
/** 帧估算兜底字节（无 frameBytes 时的保守常数；真实帧多为小对象，宁多记）。 */
const FALLBACK_FRAME_BYTES = 4096;

/**
 * C20 第二阶段：v2 窗口化 FrameSource（计划第 7 节 C20 次序 3–5）。
 *
 * - LRU 窗口缓存（字节记账，逐出整窗——窗口内帧对象共享生命周期，
 *   getFrame 同帧同引用直到逐出）；
 * - single-flight 按 start_frame 键；在途上限 maxInFlight，超出时
 *   ensureRange 仅等待既有请求（不排队第三个——seek 优先当前目标）；
 * - manifest_id 失配的响应整体丢弃（不进入当前帧源）；
 * - getFrame 未就绪返回 undefined（不伪造空帧），isBuffering 报告
 *   "既不在缓存也不在途"的帧区间；在途但**已悬挂超过阈值**同样算 buffering
 *   （见 WINDOW_IN_FLIGHT_STALL_MS：请求永不兑现 = 和没有请求同等的无声定格）；
 * - 已 abort 的 ensureRange 取消**未发出**的请求；已发出的请求照常
 *   完成（响应仍可入缓存——合法数据，只是调用方已不等待）。
 */
export function windowedFrameSource(
  manifestId: string,
  totalFrames: number,
  options: WindowedFrameSourceOptions,
): FrameSource & { readonly buffered: () => Array<[number, number]>; readonly snapshotWindows: () => WindowSeed[] } {
  const windowFrames = PREVIEW_IR_V2_MAX_WINDOW_FRAMES;
  const cacheBytes = options.cacheBytes ?? DEFAULT_CACHE_BYTES;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const frameBytesOf = options.frameBytes ?? (() => FALLBACK_FRAME_BYTES);
  const cache = new Map<number, WindowEntry>(); // LRU：Map 迭代序 = 最旧在前
  /** 在途窗口：startFrame -> { promise, startedAt }。
   *
   *  **为什么把时间戳放进条目、而不是另开一张 startFrame -> timestamp 表**：
   *  悬挂判定要的是"在途**多久**"，而 inFlight 原本只回答"在途与否"。两张表
   *  看起来更省事，但它们的生命周期必须严格同步，而同步点有两处（.finally 落定、
   *  dispose）——任一处漏删就是一类缺陷：
   *   - 漏删时间戳 ⇒ 窗口重取时带着旧起点，一次正常取窗立刻被判成悬挂（误报）；
   *   - 漏删 inFlight ⇒ 原缺陷本身（悬挂记录永存，还占并发额度）。
   *  合成一条记录后，"加入/移除在途"与"记录/遗忘起点"是**同一个操作**，
   *  上述漂移在结构上不可能发生——不靠纪律，靠类型。 */
  const inFlight = new Map<number, { promise: Promise<void>; startedAt: number }>();
  const abortedStarts = new Set<number>();
  let disposed = false;
  let totalBytes = 0;

  const windowStartOf = (frame: number): number =>
    Math.min(Math.floor(frame / windowFrames) * windowFrames,
      Math.floor(Math.max(0, totalFrames - 1) / windowFrames) * windowFrames);

  const evictIfNeeded = (): void => {
    while (totalBytes > cacheBytes && cache.size > 1) {
      const oldest = cache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      const entry = cache.get(oldest);
      cache.delete(oldest);
      if (entry) totalBytes -= entry.estimatedBytes;
    }
  };

  // C20c-2：种子窗口装填（同 loadWindow 的记账口径；防御性过滤越界帧）。
  // manifest_id 相等 ⇒ 同指纹 ⇒ 同投影 ⇒ 种子帧即新 manifest 的投影结果
  // （对象引用共享 = 引用稳定性契约的自然延续）。
  for (const seed of options.seedWindows ?? []) {
    if (disposed || seed.startFrame < 0 || seed.startFrame >= totalFrames || cache.has(seed.startFrame)) continue;
    const frames = new Map<number, IrFrame>();
    let bytes = 0;
    for (const [n, frame] of seed.frames) {
      if (n < seed.startFrame || n >= Math.min(seed.startFrame + windowFrames, totalFrames)) continue;
      frames.set(n, frame);
      bytes += frameBytesOf(frame);
    }
    if (frames.size < 1) continue;
    cache.set(seed.startFrame, { startFrame: seed.startFrame, frames, estimatedBytes: bytes });
    totalBytes += bytes;
  }
  evictIfNeeded();

  const loadWindow = (startFrame: number, signal?: AbortSignal): Promise<void> => {
    if (disposed || cache.has(startFrame)) return Promise.resolve();
    // single-flight：同一窗口的第二次请求复用既有在途 promise（不重复发起）。
    const existing = inFlight.get(startFrame);
    if (existing) return existing.promise;
    if (signal?.aborted) return Promise.resolve();
    if (inFlight.size >= maxInFlight) {
      // 在途已满：不为该窗口排队（seek 优先当前目标；调用方下次 ensureRange 重试）。
      // 遥测 request=-1 标记"拒绝在途"（回放分析用：停滞窗口是否因在途满载未发起）。
      editorPerf.record("window_fetch", 0, 0, -1, 0, startFrame);
      return Promise.resolve();
    }
    const count = Math.min(windowFrames, totalFrames - startFrame);
    if (count < 1) return Promise.resolve();
    const fetchStart = performance.now();
    const promise = options.fetchWindow(startFrame, count, signal ?? new AbortController().signal)
      .then(response => {
        if (disposed) return;
        if (response.manifest_id !== manifestId) {
          editorPerf.record("window_fetch", performance.now() - fetchStart, 1, startFrame, 0, startFrame);
          return; // 失配丢弃
        }
        if (abortedStarts.has(startFrame)) { abortedStarts.delete(startFrame); return; }
        const frames = new Map<number, IrFrame>();
        let bytes = 0;
        for (const row of response.frames) {
          const frame = row as unknown as IrFrame;
          if (typeof frame.n !== "number") return; // 非法帧行整窗丢弃
          frames.set(frame.n, frame);
          bytes += frameBytesOf(frame);
        }
        if (cache.has(startFrame)) return;
        cache.set(startFrame, { startFrame, frames, estimatedBytes: bytes });
        totalBytes += bytes;
        evictIfNeeded();
        // duration = 端到端窗口取数耗时;frame = 窗口起始帧
        editorPerf.record("window_fetch", performance.now() - fetchStart, 2, startFrame, 0, startFrame);
      })
      .catch(() => {
        editorPerf.record("window_fetch", performance.now() - fetchStart, 3, startFrame, 0, startFrame);
      }) // 3 = fetch 失败（网络/契约）
      // 落定收摊：条目连同其中的起点一并消失（单条记录 ⇒ 不存在"删一半"）。
      // 漏了这一行会让该窗口永久停留在"在途"，既占并发额度，又在超过阈值后
      // 恒报 buffering——已到达的窗口反而显示"缓冲中"。
      .finally(() => { inFlight.delete(startFrame); });
    inFlight.set(startFrame, { promise, startedAt: fetchStart });
    return promise;
  };

  return {
    frameCount: totalFrames,
    getFrame: (frame: number): IrFrame | undefined => {
      if (frame < 0 || frame >= totalFrames) return undefined;
      const start = windowStartOf(frame);
      return cache.get(start)?.frames.get(frame);
    },
    isBuffering: (frame: number): boolean => {
      if (frame < 0 || frame >= totalFrames) return false;
      const start = windowStartOf(frame);
      if (cache.has(start)) return false; // 已就绪：无论别处怎样都不算缓冲
      // 在途窗口分两种，必须分开判：
      // - 刚发起（< WINDOW_IN_FLIGHT_STALL_MS）：正常的取窗在途，画面马上就来，
      //   报 buffering 会让每次普通 seek 都闪一下指示条（抗闪烁口径）；
      // - 久未返回（≥ 阈值）：请求已悬挂，它永远不会自己兑现，此时"在途"与
      //   "根本没有请求"对用户是同一件事——都是画面停住、且没有任何东西在
      //   路上能把它救回来。这正是"冻结但无声"的成因，必须报 true。
      const entry = inFlight.get(start);
      if (entry) return performance.now() - entry.startedAt >= WINDOW_IN_FLIGHT_STALL_MS;
      return true; // 既不在缓存也不在途：窗口未就绪（既有语义）
    },
    ensureRange: (startFrame: number, endFrameExclusive: number, signal?: AbortSignal): Promise<void> => {
      if (disposed || endFrameExclusive <= startFrame) return Promise.resolve();
      const first = Math.max(0, startFrame);
      const last = Math.min(totalFrames - 1, endFrameExclusive - 1);
      if (last < first) return Promise.resolve();
      const starts = new Set<number>();
      // 从 first 所在窗口的起点开始枚举（按 300 对齐）；从 first 原值起跳会
      // 跳过 first 所在窗口之后的下一个窗口（mid-window 起点 + 步长 300 的
      // 错位——G0 A/B F02 播放停滞的根因）。
      for (let start = windowStartOf(first); start <= last; start += windowFrames) {
        starts.add(start);
      }
      const pending = [...starts]
        .filter(start => !cache.has(start))
        .sort((a, b) => Math.abs(a - first) - Math.abs(b - first)); // 目标优先
      if (signal?.aborted) {
        for (const start of pending) if (!inFlight.has(start)) abortedStarts.add(start);
        return Promise.resolve();
      }
      return Promise.all(pending.map(start => loadWindow(start, signal))).then(() => undefined);
    },
    dispose: (): void => {
      disposed = true;
      cache.clear();
      inFlight.clear(); // 条目内含起点：清空即无残留（销毁后不得留下任何悬挂记录）
      abortedStarts.clear();
      totalBytes = 0;
    },
    buffered: (): Array<[number, number]> => {
      const ranges: Array<[number, number]> = [];
      for (const start of [...cache.keys()].sort((a, b) => a - b)) {
        const end = Math.min(start + windowFrames, totalFrames);
        const lastRange = ranges[ranges.length - 1];
        if (lastRange && lastRange[1] === start) lastRange[1] = end;
        else ranges.push([start, end]);
      }
      return ranges;
    },
    /** C20c-2：缓存窗口快照（换装迁移用）。帧 Map 原引用导出——旧源 dispose
     *  只清条目不清 Map，新源种子继续持有同一批帧对象（引用稳定性契约）。 */
    snapshotWindows: (): WindowSeed[] => {
      if (disposed) return [];
      return [...cache.values()].map(entry => ({ startFrame: entry.startFrame, frames: entry.frames }));
    },
  };
}

/** C20-T1：seek 落定后的预取窗序（纯函数，单测锁定）。
 * 目标窗自身由 seek 路径取，不重复；对称 ±k、同距对内先正向（顺播更常见，
 * 在途上限下先到先得）；起点去重并夹紧到合法窗口范围。 */
export function windowPrefetchStarts(target: number, span: number, windowFrames: number, totalFrames: number): number[] {
  if (span < 1 || windowFrames < 1 || totalFrames < 1) return [];
  const lastStart = Math.floor((totalFrames - 1) / windowFrames) * windowFrames;
  const startOf = (frame: number): number =>
    Math.min(Math.max(0, Math.floor(frame / windowFrames) * windowFrames), lastStart);
  const targetStart = startOf(target);
  const out: number[] = [];
  for (let k = 1; k <= span; k++) {
    for (const off of [k, -k]) {
      const start = startOf(target + off * windowFrames);
      if (start !== targetStart && !out.includes(start)) out.push(start);
    }
  }
  return out;
}
