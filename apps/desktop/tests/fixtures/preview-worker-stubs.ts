/** 合成预览 worker 生命周期测试桩（preview-lifecycle / preview-revision-swap
 *  共享）：可脚本化握手的假 Worker + 工厂 + OffscreenCanvas 补桩。
 *  从 preview-lifecycle.test.tsx 抽出（C20c-1 轮），语义不变。 */
import { vi } from "vitest";

/** 可脚本化握手的假 Worker：默认回 ready，可按 worker 实例定制行为。 */
export class ScriptedWorker extends EventTarget {
  static instances: ScriptedWorker[] = [];
  messages: any[] = [];
  terminated = false;
  terminate = vi.fn(() => { this.terminated = true; });
  /** 每实例握手脚本：收到 init 后的应答。 */
  script: "ready" | "error" | "timeout" | "fatal";
  constructor(script: "ready" | "error" | "timeout" | "fatal" = "ready") {
    super();
    this.script = script;
    ScriptedWorker.instances.push(this);
  }
  postMessage(message: any) {
    this.messages.push(message);
    if (message.type !== "init") return;
    if (this.script === "ready") queueMicrotask(() => this.reply({ type: "ready", adapter: "test-adapter", vendor: "test", hardware: "test", width: 16, height: 9 }));
    else if (this.script === "error") queueMicrotask(() => this.reply({ type: "error", message: "init failed" }));
    // timeout：不回任何消息（等待 15s 握手超时，测试用假定时器快进）。
    // fatal：先回 ready 再抛运行时错误事件（握手成功、运行中崩溃）。
    else if (this.script === "fatal") {
      queueMicrotask(() => {
        this.reply({ type: "ready", adapter: "test-adapter", vendor: "test", hardware: "test", width: 16, height: 9 });
        this.dispatchEvent(new ErrorEvent("error", { message: "runtime crash" }));
      });
    }
  }
  reply(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
}

/** worker 工厂脚本：按创建顺序给第 n 个 worker 分配行为。 */
export type WorkerPlan = "ready" | "error" | "timeout" | "fatal" | "hang";
/** 装载 Worker stub：planFn 收到"这是本测试第几个 worker"，返回该实例行为。
 *  hang = 握手成功但对 decode/upload 请求永不回应。 */
export function installWorkers(planFn: (index: number) => WorkerPlan = () => "ready"): void {
  let created = 0;
  class PlannedWorker extends ScriptedWorker {
    constructor() {
      const plan = planFn(created++);
      super(plan === "hang" ? "ready" : plan);
    }
    postMessage(message: any) {
      this.messages.push(message);
      if (message.type === "init") {
        if (this.script === "ready") queueMicrotask(() => this.reply({ type: "ready", adapter: "test-adapter", vendor: "test", hardware: "test", width: 16, height: 9 }));
        else if (this.script === "error") queueMicrotask(() => this.reply({ type: "error", message: "init failed" }));
        else if (this.script === "fatal") queueMicrotask(() => {
          this.reply({ type: "ready", adapter: "test-adapter", vendor: "test", hardware: "test", width: 16, height: 9 });
          this.dispatchEvent(new ErrorEvent("error", { message: "runtime crash" }));
        });
        // timeout / hang：init 不回消息
        return;
      }
      // hang：decode/upload 请求永不回应
      if ((this as PlannedWorker).plan === "hang") return;
    }
    plan: WorkerPlan = "ready";
  }
  vi.stubGlobal("Worker", PlannedWorker);
}

/** jsdom canvas 无 transferControlToOffscreen：补齐桩（会话/compositor 用）。 */
export function stubOffscreenCanvas(): void {
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    const element = original(tagName as keyof HTMLElementTagNameMap);
    if (tagName.toLowerCase() === "canvas") Object.assign(element, { transferControlToOffscreen: () => ({}) });
    return element;
  }) as typeof document.createElement);
}

/** 计数断言：active worker（未 terminate）应回基线 0。 */
export function activeWorkers(): number {
  return ScriptedWorker.instances.filter(worker => !worker.terminated).length;
}
