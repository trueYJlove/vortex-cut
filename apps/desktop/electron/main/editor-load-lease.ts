/**
 * B16b 编辑器负载 lease 心跳（Main → Core admin 通道，1s 自重调度）。
 *
 * 约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B16）：
 * - lease 模式 playing/scrubbing/idle；TTL 3s（Core 侧）——心跳停止（应用
 *   退出/Renderer 崩溃/网络断）= 过期 = idle：不会永久饿死后台任务。
 * - window owner 由 Main 注入（单窗口应用：launch 稳定 id）。
 * - 上次请求结束后再 setTimeout（自重调度，不 setInterval 堆叠）；Core
 *   不可达时退避（最大 5s）并在恢复后回到 1s——诊断通道不放大故障。
 * - Renderer 崩溃 = Main 收不到 preview:load-state → 本地状态保持最后值，
 *   但心跳持续（idle 上报）——lease 过期语义只由 Core TTL 承担；主进程
 *   退出 = 心跳停止 = 同样过期回 idle。
 * - 心跳失败静默重试（诊断/调度辅助通道，不弹 UI 错误）。
 */

export type EditorLoadMode = "playing" | "scrubbing" | "idle";

import { randomBytes } from "node:crypto";

export interface LeaseDeps {
  windowId: string;
  /** Core admin 心跳（reportEditorLoadLease）。 */
  report: (input: { window_id: string; mode: EditorLoadMode }) => Promise<unknown>;
  /** 定时器（测试注入）。 */
  schedule: (delayMs: number, callback: () => void) => () => void;
}

const HEARTBEAT_INTERVAL_MS = 1_000;
const HEARTBEAT_MAX_INTERVAL_MS = 5_000;

export class EditorLoadLeaseHeartbeat {
  private mode: EditorLoadMode = "idle";
  private stopped = false;
  private timerStop: (() => void) | null = null;
  private beatCount = 0;
  private failureCount = 0;

  constructor(private readonly deps: LeaseDeps) {}

  /** Renderer 推送负载状态（转换即时 + 1s 保活；无推送维持最后值）。 */
  updateMode(mode: EditorLoadMode): void {
    if (mode === "playing" || mode === "scrubbing" || mode === "idle") {
      this.mode = mode;
    }
  }

  get currentMode(): EditorLoadMode {
    return this.mode;
  }

  get heartbeatCount(): number {
    return this.beatCount;
  }

  /** 启动自重调度循环（幂等）。 */
  start(): void {
    if (this.stopped || this.timerStop) return;
    this.scheduleNext();
  }

  /** 停止（shutdownRuntime；Core TTL 3s 兜底过期）。 */
  stop(): void {
    this.stopped = true;
    this.timerStop?.();
    this.timerStop = null;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const interval = this.failureCount > 0
      ? Math.min(HEARTBEAT_MAX_INTERVAL_MS, HEARTBEAT_INTERVAL_MS * this.failureCount)
      : HEARTBEAT_INTERVAL_MS;
    this.timerStop = this.deps.schedule(interval, () => {
      void this.beat();
    });
  }

  private async beat(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.deps.report({ window_id: this.deps.windowId, mode: this.mode });
      this.beatCount += 1;
      this.failureCount = 0;
    } catch {
      // Core 不可达：退避重试（lease TTL 由 Core 侧兜底——不放大故障）
      this.failureCount = Math.min(5, this.failureCount + 1);
    }
    this.timerStop = null;
    this.scheduleNext();
  }
}

/** 窗口 owner id（launch 稳定：进程 pid + 随机后缀，会话内不变）。 */
export function makeWindowOwnerId(): string {
  return `win-${process.pid}-${randomBytes(4).toString("hex")}`;
}
