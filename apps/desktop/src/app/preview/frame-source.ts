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
}

interface WindowEntry {
  startFrame: number;
  /** startFrame -> frame（同一对象引用直到整窗逐出——引用稳定性契约）。 */
  frames: Map<number, IrFrame>;
  estimatedBytes: number;
}

const DEFAULT_CACHE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 2;
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
 *   "既不在缓存也不在途"的帧区间；
 * - 已 abort 的 ensureRange 取消**未发出**的请求；已发出的请求照常
 *   完成（响应仍可入缓存——合法数据，只是调用方已不等待）。
 */
export function windowedFrameSource(
  manifestId: string,
  totalFrames: number,
  options: WindowedFrameSourceOptions,
): FrameSource & { readonly buffered: () => Array<[number, number]> } {
  const windowFrames = PREVIEW_IR_V2_MAX_WINDOW_FRAMES;
  const cacheBytes = options.cacheBytes ?? DEFAULT_CACHE_BYTES;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const frameBytesOf = options.frameBytes ?? (() => FALLBACK_FRAME_BYTES);
  const cache = new Map<number, WindowEntry>(); // LRU：Map 迭代序 = 最旧在前
  const inFlight = new Map<number, Promise<void>>();
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

  const loadWindow = (startFrame: number, signal?: AbortSignal): Promise<void> => {
    if (disposed || cache.has(startFrame) || inFlight.has(startFrame)) {
      return inFlight.get(startFrame) ?? Promise.resolve();
    }
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
      .finally(() => { inFlight.delete(startFrame); });
    inFlight.set(startFrame, promise);
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
      return !cache.has(start) && !inFlight.has(start);
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
      inFlight.clear();
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
  };
}
