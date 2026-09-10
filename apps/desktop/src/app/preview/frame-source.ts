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

export interface FrameSource {
  /** 帧数（v1 = ir.frames.length；v2 = manifest.total_frames）。 */
  readonly frameCount: number;
  /** 取帧；越界/未就绪返回 undefined（与 ir.frames[n] 数组语义一致）。 */
  getFrame(frame: number): IrFrame | undefined;
  /** v2 预留：确保 [start, endExclusive) 帧可用（v1 全量在场 = 立即完成）。 */
  ensureRange?(startFrame: number, endFrameExclusive: number, signal?: AbortSignal): Promise<void>;
  /** v2 预留：释放（v1 = 无操作——数组归 Ir 所有，随会话置换）。 */
  dispose?(): void;
}

/** v1 全量数组的 FrameSource 适配（零拷贝——帧对象即 ir.frames 元素）。 */
export function arrayFrameSource(ir: Ir): FrameSource {
  return {
    frameCount: ir.frames.length,
    getFrame: (frame: number): IrFrame | undefined =>
      frame >= 0 && frame < ir.frames.length ? ir.frames[frame] : undefined,
    ensureRange: () => Promise.resolve(),
    dispose: () => undefined,
  };
}
