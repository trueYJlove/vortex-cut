/** 合成预览指标 HUD 的可见性边界（用户裁决 2026-10-27：发布版移除 HUD、降级仍须当场可见）。
 *
 * 守三件事（任何一条回退都该让本文件变红）：
 *  1. **性能数字块**只在 VITE_AIVS_PERF=1 诊断构建渲染——发布版对最终用户常驻显示
 *     每秒变动的 p50/p95/丢帧，既无可读价值又挡画面；
 *  2. **异常态提示**（真实错误 / 硬解不可得 / 解码降级到 FFmpeg）在**任何构建**都渲染。
 *     这是 SyntheticPreview 内既有注释划的线：「两者都必须当场可见，而不是靠终端日志
 *     推断」——把 HUD 整块删掉等于把它们一起删掉；
 *  3. **驻留预警独立通道**：它不再写 last_error，也不再整行替换指标文本（当年正是
 *     靠替换文本把长时线上的性能数字全挤没的）。
 *
 * jsdom 不加载样式表，窄窗口折行只能对规则文本设卡（同 .synthetic-buffering 的先例）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewSession } from "../src/app/preview/preview-session.js";
import { SyntheticPreview } from "../src/app/preview/SyntheticPreview.js";
import type { Ir } from "../src/app/preview/ir.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";
import { installWorkers, ScriptedWorker, stubOffscreenCanvas } from "./fixtures/preview-worker-stubs.js";

const TICKETS = new Map([["asset_video", "aivideo://media/one"]]);

/** 黑帧 IR：无输入 ⇒ 会话里没有解码 worker，decode_backend / decode_hardware 必为空串，
 *  用例不会被环境自带的降级提示污染（异常态用例要自己制造异常）。 */
function blackIr(totalFrames = 90, width = 1080, height = 1920): Ir {
  const ir = JSON.parse(JSON.stringify(fixturePreviewIr())) as Ir;
  ir.inputs = [];
  ir.segments = [];
  ir.frames = Array.from({ length: totalFrames }, (_, n) => ({
    n,
    t_us: Math.round((n * 1_000_000) / 30),
    main: { kind: "black" as const },
    overlays: [],
    captions: [],
  })) as Ir["frames"];
  ir.canvas = { ...ir.canvas, width, height, duration_frames: totalFrames, duration_us: Math.round((totalFrames * 1_000_000) / 30) };
  return ir;
}

/** 带真实输入素材的长 IR：既有解码 worker（可制造硬解不可得），
 *  又够长到触发驻留预警（1200 帧 × 320×180 在 conservative 档越预算）。 */
function residencyWithInputIr(totalFrames = 1_200): Ir {
  const ir = JSON.parse(JSON.stringify(fixturePreviewIr())) as Ir;
  const fps = 30;
  ir.frames = Array.from({ length: totalFrames }, (_, n) => ({
    n,
    t_us: Math.round((n * 1_000_000) / fps),
    main: { kind: "segment" as const, clip_id: "clip_1", input_id: "in_1", src_n: n,
      src_t_us: Math.round((n * 1_000_000) / fps),
      content: { x: 0, y: 0, w: 320, h: 180 }, shift: { dx: 0, dy: 0 }, alpha: 1 } as never,
    overlays: [],
    captions: [],
  })) as Ir["frames"];
  ir.canvas = { ...ir.canvas, width: 320, height: 180, duration_frames: totalFrames, duration_us: Math.round((totalFrames * 1_000_000) / fps) };
  return ir;
}

function stubDesktop(ir: Ir): void {
  window.desktop = {
    getPreviewIr: vi.fn().mockResolvedValue({ schema_version: 1, ir }),
    captionFontUrl: vi.fn().mockResolvedValue("https://fonts.test/caption.woff2"),
    captionFontUrls: vi.fn().mockResolvedValue([{ family: "Noto Sans CJK SC", media_url: "" }]),
  } as never;
}

/** 以 no-preference（软解）握手的 worker：硬解不可得是**任何构建都必须可见**的异常态，
 *  用它验证发布构建分支（与会话里 decode_hardware 的真实来源同一条链：worker 握手
 *  回 hardware → mapHardware 只认 prefer-hardware/no-preference → 其余落到 "null" 串）。 */
function installSoftwareOnlyWorkers(): void {
  class SoftwareOnlyWorker extends EventTarget {
    messages: unknown[] = [];
    terminate = vi.fn();
    postMessage(message: { type?: string; id?: number; seq?: number }) {
      this.messages.push(message);
      if (message.type === "init") {
        queueMicrotask(() => this.reply({ type: "ready", adapter: "test-adapter", vendor: "test", hardware: "no-preference", width: 16, height: 9 }));
      } else if (message.type === "decode") {
        // 有输入素材时装配尾段要真 seek 一次才置 ready：解码回最小帧、上传回 ack。
        queueMicrotask(() => this.reply({ type: "frame", id: message.id, frame: { close: () => undefined, timestamp: 0, duration: 0, codedWidth: 2, codedHeight: 2 } }));
      } else if (message.type === "upload") {
        queueMicrotask(() => this.reply({ type: "uploaded", seq: message.seq, copyToMs: 0, texMs: 0 }));
      }
    }
    private reply(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
  }
  vi.stubGlobal("Worker", SoftwareOnlyWorker);
}

function baseProps() {
  return {
    projectId: "project_1",
    revisionId: "revision_1",
    outputRatio: "916",
    mediaUrls: new Map([["asset_video", "aivideo://media/one"]]),
    playing: false,
    playheadUs: 0,
    onTimeUs: vi.fn(),
    onFallback: vi.fn(),
  };
}

/** 装出就绪的合成预览，并等到首轮指标快照落进组件（1Hz 轮询）。
 *  就绪判据不用 HUD 文本——性能块被门控掉时它本就不该出现，拿它当等待条件会自证空转。 */
async function renderReady(ir: Ir, extraProps: Record<string, unknown> = {}) {
  stubDesktop(ir);
  render(<SyntheticPreview {...baseProps()} {...extraProps} />);
  await waitFor(() => {
    const container = document.querySelector(".synthetic-preview > div") as HTMLElement | null;
    expect(container).not.toBeNull();
    expect(container!.style.display).toBe("block");
  }, { timeout: 8_000 });
  // 指标 1Hz：首轮快照到达前组件不渲染任何指标，"不存在"的断言会假绿。
  await new Promise(resolve => setTimeout(resolve, 1_300));
}

beforeEach(() => {
  ScriptedWorker.instances = [];
  vi.stubEnv("VITE_AIVS_PREVIEW_IR_V2", "0");
  installWorkers();
  stubOffscreenCanvas();
  globalThis.fetch = vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })) as never;
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (window as { desktop?: unknown }).desktop;
  // jsdom window 在同一文件内跨用例共享：诊断构建用例写下的全局不清掉，
  // 下一条「发布构建没有这个全局」的断言会拿到上一条的残留而假红。
  delete (window as { __aivsPreviewMetrics?: unknown }).__aivsPreviewMetrics;
});

describe("指标 HUD 门控（发布版不留常驻 HUD）", () => {
  it("无 VITE_AIVS_PERF：没异常就不渲染任何指标（性能数字块被门控掉）", async () => {
    vi.stubEnv("VITE_AIVS_PERF", "");
    await renderReady(blackIr());
    expect(document.querySelector(".synthetic-metrics")).toBeNull();
    expect(document.body.textContent).not.toContain("任务 p95");
    expect(document.body.textContent).not.toContain("画布");
  });

  it("无 VITE_AIVS_PERF：异常态提示仍然渲染（硬解不可得）", async () => {
    vi.stubEnv("VITE_AIVS_PERF", "");
    installSoftwareOnlyWorkers();
    await renderReady(fixturePreviewIr() as unknown as Ir);
    const hud = document.querySelector(".synthetic-metrics");
    expect(hud, "发布构建丢了降级提示 = 用户只能看到画面变幻灯、拿不到原因").not.toBeNull();
    expect(hud!.textContent).toContain("硬解不可用");
    // 性能数字仍然缺席：异常提示不是把整块 HUD 又放回来。
    expect(hud!.textContent).not.toContain("任务 p95");
  });

  it("有 VITE_AIVS_PERF=1：正常态即渲染性能数字块", async () => {
    vi.stubEnv("VITE_AIVS_PERF", "1");
    await renderReady(blackIr());
    const hud = document.querySelector(".synthetic-metrics");
    expect(hud).not.toBeNull();
    expect(hud!.textContent).toContain("合成预览 · 任务 p95");
    expect(hud!.textContent).toContain("画布");
  });
});

describe("驻留预警独立通道（不再顶掉指标文本）", () => {
  /** 保守档纹理预算 = 128MiB×8；320x180 落在「unique 帧律」区间，
   *  1200 帧的预测常驻 ≈ 400MiB + 1200×600KB ≈ 1.1GiB → 必然越过预算，
   *  与解码量无关（create 时按 IR 帧数算）。 */
  const residencyIr = () => blackIr(1_200, 320, 180);
  const advisory = { resourceTier: "conservative" as const };

  it("诊断构建：预警与性能数字同时可见（不再是整行替换）", async () => {
    vi.stubEnv("VITE_AIVS_PERF", "1");
    await renderReady(residencyIr(), advisory);
    const hud = document.querySelector(".synthetic-metrics");
    expect(hud).not.toBeNull();
    expect(hud!.textContent).toContain("长素材解码驻留预警");
    expect(hud!.textContent, "预警把指标数字顶掉了 = 回到本任务要修的缺陷").toContain("合成预览 · 任务 p95");
  });

  // 复核回改：预警**不进发布版**。它不是异常态，是 v1 全帧驻留经验律的估算——
  // 画布 960×540 时 balanced 档（App 默认）94s 就触发、conservative 档 36s 触发，
  // 而 v2 窗口化帧源下同一份 P196 证据里预测 15,675MiB、实测合成器驻留仅 75.6MiB
  // （约 200 倍高估）。让已知误报在发布版常驻 = 每条 1.5 分钟以上的时间线底部糊一块
  // 错字，且与「发布版移除 HUD」的裁决直接冲突。
  it("发布构建：预警不渲染（已知误报不得常驻发布版）", async () => {
    vi.stubEnv("VITE_AIVS_PERF", "");
    await renderReady(residencyIr(), advisory);
    expect(document.querySelector(".synthetic-metrics")).toBeNull();
    expect(document.body.textContent).not.toContain("长素材解码驻留预警");
    // 通道本身不受影响：诊断构建与 e2e 读的是 __aivsPreviewMetrics，不依赖 DOM。
    expect((window as unknown as { __aivsPreviewMetrics?: unknown }).__aivsPreviewMetrics ?? null).toBeNull();
  });

  /** 这条才是内层门控的**唯一决定因素**：让异常态（硬解不可得）把外层条件撑开，
   *  于是 HUD 一定会渲染，是否出现预警完全由 residency 自己的 perfHud 门控决定。
   *  没有它，「发布构建不渲染预警」上面那条是空转的——没有异常时外层条件已经把整块
   *  HUD 挡掉了，内层门控删掉也不会红（实测：M4 变异存活）。 */
  it("发布构建：异常态撑开 HUD 时，预警仍不出现（内层门控非空转）", async () => {
    vi.stubEnv("VITE_AIVS_PERF", "");
    installSoftwareOnlyWorkers();
    await renderReady(residencyWithInputIr(), advisory);
    const hud = document.querySelector(".synthetic-metrics");
    expect(hud, "异常态应当撑开 HUD（否则本用例没有检验内层门控）").not.toBeNull();
    expect(hud!.textContent).toContain("硬解不可用");
    expect(hud!.textContent, "发布构建下预警不得搭异常态的便车显示").not.toContain("长素材解码驻留预警");
  });

  it("预警走 __aivsPreviewMetrics.residency_warning，不进 last_error", async () => {
    vi.stubEnv("VITE_AIVS_PERF", "1");
    await renderReady(residencyIr(), advisory);
    const snapshot = (window as unknown as { __aivsPreviewMetrics?: Record<string, unknown> }).__aivsPreviewMetrics ?? null;
    expect(snapshot).not.toBeNull();
    expect(String(snapshot!.residency_warning)).toContain("长素材解码驻留预警");
    expect(snapshot!.last_error, "预警混进 last_error = 真实错误通道被非阻断提示占用").toBeNull();
  });
});

describe("窄窗口可读性（样式层，jsdom 不加载样式表 → 对规则文本设卡）", () => {
  it(".synthetic-metrics 允许折行、限宽、长串可断，且不吃指针事件", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    const rule = /\.synthetic-metrics \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule, "找不到 .synthetic-metrics 规则").not.toBe("");
    // 单行 nowrap + 无 max-width 是用户「窗口变小看不到完整调试信息」的直接成因。
    expect(rule).toContain("white-space: normal");
    expect(rule).toContain("max-width: calc(100% - 16px)");
    expect(rule).toContain("overflow-wrap: anywhere");
    // 画布上的 PiP 手势必须穿透：这条是硬约束，改折行时不许丢。
    expect(rule).toContain("pointer-events: none");
  });

  it("没有可聚焦/可滚动的 HUD 形态（滚动会与 pointer-events:none 冲突）", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    const rule = /\.synthetic-metrics \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).not.toContain("overflow: auto");
    expect(rule).not.toContain("overflow-y: auto");
  });
});

describe("驻留预警通道（会话侧语义）", () => {
  const IR = blackIr(1_200, 320, 180);

  it("预警写 residency_warning、last_error 保持 null；重复装配不叠加", async () => {
    const session = await PreviewSession.create(document.createElement("div"), IR, TICKETS, undefined, undefined, null, "conservative");
    const metrics = session.metrics();
    expect(String(metrics.residency_warning)).toContain("长素材解码驻留预警");
    expect(metrics.last_error, "预警混进 last_error = 真实错误通道被非阻断提示占用").toBeNull();
    session.dispose();
  });

  it("无资源档位（不预测）时不产生预警，两个通道都空", async () => {
    const session = await PreviewSession.create(document.createElement("div"), IR, TICKETS);
    const metrics = session.metrics();
    expect(metrics.residency_warning).toBeNull();
    expect(metrics.last_error).toBeNull();
    session.dispose();
  });
});

