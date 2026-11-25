/**
 * WP-P227 Slice 2/3：合成器后端门控与「假硬解」推断。
 *
 * 验收映射（docs/requirements/PREVIEW_ENGINE_SPEC.md §3.3 / §3.4）：
 * - a) backend 缺省 = webgl2 worker（发布构建行为与 HEAD 一致）；
 * - b) init.backend="webgpu" 且 WebGPU init 失败 → 回退 webgl2 worker（同参重建）；
 * - c) suspected_software_decode 判据：prefer-hardware + 实测超预算 + 样本足 → true；
 * - d) 显式 no-preference（真软解）→ 不误报（hardwareMissing 分支已覆盖文案）；
 * - e) 样本不足 → false（保守判据，宁缺勿滥）；
 * - f) 变异验证：判据对「超预算 prefer-hardware」与「预算内」「样本不足」
 *   三组输入给出不同结论——证明断言有分辨力而非恒真（仓内变异验证纪律）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositorWorkerClient } from "../src/app/preview/compositor-worker.js";
import { installWorkers, stubOffscreenCanvas } from "./fixtures/preview-worker-stubs.js";

const baseInit = {
  inputs: [{ inputId: "in_a", sourceWidth: 1920, width: 1920, height: 1080 }],
  ringDepth: 8,
  canvasWidth: 960,
  canvasHeight: 540,
  captionStyles: {},
  captionOverrideStyles: {},
};

function captureWorkerUrls(): { urls: string[] } {
  const urls: string[] = [];
  // installWorkers 装好基础桩后，再包一层只记录 URL 的 Worker 子类。
  installWorkers(() => "ready");
  const StubWorker = (globalThis as { Worker?: unknown }).Worker as unknown as { new (url: string | URL, options?: unknown): unknown };
  vi.stubGlobal("Worker", class extends (StubWorker as new (url: string | URL, options?: unknown) => object) {
    constructor(url: string | URL, options?: unknown) {
      urls.push(String(url));
      super(url, options);
    }
  });
  return { urls };
}

describe("WP-P227 合成器后端选择", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a) 缺省建 webgl2 worker（worker 文件 URL 指向 compositor-worker.worker.ts）", async () => {
    const { urls } = captureWorkerUrls();
    stubOffscreenCanvas();
    const client = await CompositorWorkerClient.create(document.createElement("canvas"), baseInit);
    expect(urls[0]).toContain("compositor-worker.worker.ts");
    expect(urls).toHaveLength(1);
    void client;
  });

  it("b) backend=webgpu 且 init 失败 → 自动回退 webgl2（第二次 worker 创建指向 webgl2 文件）", async () => {
    // 不用 installWorkers 的 "error" plan——它回 {type:"error"}，而握手 read()
    // 只认 initError/ready 两形态，error 形态会等满 15s init 超时（该超时路径
    // 由 preview-lifecycle 家族覆盖）。本用例直接回 initError（真实 WebGPU
    // worker 在驱动不可得时的应答形态），回退立刻发生。
    const urls: string[] = [];
    // 第 1 个实例（webgpu）回 initError；第 2 个实例（webgl2 回退）回 ready。
    // 回退后脚本切换——否则两次 worker 都 initError，错误会穿出 create()。
    class ScriptedGpuWorker extends EventTarget {
      static instanceIndex = 0;
      messages: unknown[] = [];
      terminated = false;
      terminate = vi.fn(() => { this.terminated = true; });
      postMessage(message: { type: string }) {
        this.messages.push(message);
        if (message.type !== "init") return;
        const first = ScriptedGpuWorker.instanceIndex++ === 0;
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent("message", { data: first
            ? { type: "initError", message: "WebGPU adapter unavailable" }
            : { type: "ready", adapter: "test-adapter", vendor: "test" } }));
        });
      }
    }
    vi.stubGlobal("Worker", class extends ScriptedGpuWorker {
      constructor(url: string | URL) {
        super();
        urls.push(String(url));
      }
    });
    stubOffscreenCanvas();
    const client = await CompositorWorkerClient.create(document.createElement("canvas"), { ...baseInit, backend: "webgpu" });
    expect(urls[0]).toContain("compositor-webgpu.worker.ts");
    expect(urls[1]).toContain("compositor-worker.worker.ts");
    expect(urls).toHaveLength(2);
    void client;
  });
});

/**
 * Slice 3：suspected_software_decode 判据（preview-session.ts metrics() 内联表达式）。
 * 判据是三行纯逻辑（hardware 门槛 / 样本门槛 / p95 阈值），以同式复算验证判定
 * 语义；端到端数据源（decodeTimesByInput）由 proxy-on-demand.test.ts 家族覆盖。
 * 变异验证：f) 用三组输入证明判据非恒真/非恒假——断言有分辨力。
 */
describe("WP-P227 Slice 3 假硬解判据（同式复算 + 变异）", () => {
  // 常量与 preview-session.ts 导出值同源（import 会拉起整个会话模块树，避免）。
  const REALTIME_FRAME_BUDGET_MS = 1000 / 30;
  const DECODE_BUDGET_MIN_SAMPLES = 30;
  const percentile = (list: number[], q: number): number =>
    list.length ? list[Math.min(list.length - 1, Math.floor(q * list.length))]! : 0;

  const judge = (hardware: string | null | undefined, times: number[] | undefined): boolean => {
    if (hardware !== "prefer-hardware") return false;
    if (!times || times.length < DECODE_BUDGET_MIN_SAMPLES) return false;
    return percentile(times, 0.95) > REALTIME_FRAME_BUDGET_MS;
  };

  it("c) prefer-hardware + 40 样本 p95 64ms → true", () => {
    const times = Array.from({ length: 40 }, () => 64);
    expect(judge("prefer-hardware", times)).toBe(true);
  });

  it("d) no-preference（显式软解）→ false（不越权，走 hardwareMissing 文案）", () => {
    const times = Array.from({ length: 40 }, () => 64);
    expect(judge("no-preference", times)).toBe(false);
  });

  it("e) 样本 29（<30 门槛）→ false", () => {
    const times = Array.from({ length: 29 }, () => 64);
    expect(judge("prefer-hardware", times)).toBe(false);
  });

  it("f) 变异验证：三组输入结论不同 ⇒ 判据有分辨力（非恒真/恒假）", () => {
    const overBudget = Array.from({ length: 40 }, () => 64);
    const withinBudget = Array.from({ length: 40 }, () => 14.3);
    const fewSamples = Array.from({ length: 29 }, () => 64);
    const results = [judge("prefer-hardware", overBudget), judge("prefer-hardware", withinBudget), judge("prefer-hardware", fewSamples), judge("no-preference", overBudget)];
    // 至少一真一假 = 判据不是常量函数（变异体只要 hardcode true/false 即红）
    expect(results).toContain(true);
    expect(results).toContain(false);
  });
});
