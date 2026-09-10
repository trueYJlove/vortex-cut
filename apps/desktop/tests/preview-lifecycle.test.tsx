/** A01 生命周期回归（创建失败/取消清理）：decode/compositor worker 握手失败、
 *  AbortSignal、PreviewSession.create 中途失败逆序 dispose、组件 create 中卸载/
 *  连续切项目后 worker/pending 计数回基线。jsdom 无真实 worker —— 用
 *  FakeWorker（与 perf-compositor.test.ts 同模式）控制 init 握手结果。 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompositorWorkerClient } from "../src/app/preview/compositor-worker.js";
import { DecodeWorker } from "../src/app/preview/decode-worker.js";
import { editorPerf } from "../src/app/preview/perf-metrics.js";
import { PreviewSession, type SegmentAudioConfig } from "../src/app/preview/preview-session.js";
import { SyntheticPreview } from "../src/app/preview/SyntheticPreview.js";
import { PREVIEW_INIT_TIMEOUT_MS, throwIfAborted } from "../src/app/preview/worker-lifecycle.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";
import type { Ir } from "../src/app/preview/ir.js";

/** 可脚本化握手的假 Worker：默认回 ready，可按 worker 实例定制行为。 */
class ScriptedWorker extends EventTarget {
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
type WorkerPlan = "ready" | "error" | "timeout" | "fatal" | "hang";
/** 装载 Worker stub：planFn 收到"这是本测试第几个 worker"，返回该实例行为。
 *  hang = 握手成功但对 decode/upload 请求永不回应。 */
function installWorkers(planFn: (index: number) => WorkerPlan = () => "ready"): void {
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
function stubOffscreenCanvas(): void {
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    const element = original(tagName as keyof HTMLElementTagNameMap);
    if (tagName.toLowerCase() === "canvas") Object.assign(element, { transferControlToOffscreen: () => ({}) });
    return element;
  }) as typeof document.createElement);
}

/** 握手超时是 15s 常量：真实等待会让测试挂死，fake timers 直接跳过。
 *  其余异步（microtask 消息泵）保持真实定时器。 */
async function withTimeout<T>(fn: () => Promise<T>): Promise<T> {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  vi.useFakeTimers();
  try {
    const promise = fn();
    await vi.advanceTimersByTimeAsync(PREVIEW_INIT_TIMEOUT_MS + 100);
    return await promise;
  } finally {
    vi.useRealTimers();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

function freshIr(): Ir {
  return JSON.parse(JSON.stringify(fixturePreviewIr())) as Ir;
}

/** 2 视频输入 IR（第 2 输入用于"中途失败"场景：第 1 输入 worker 已建成功）。 */
function twoInputIr(): Ir {
  const ir = freshIr();
  ir.inputs.push({ ...ir.inputs[0]!, input_id: "in_2", asset_id: "asset_video_2" });
  ir.segments.push({ ...ir.segments[0]!, clip_id: "clip_2", input_id: "in_2" });
  return ir;
}

const TICKETS = new Map([["asset_video", "aivideo://media/one"], ["asset_video_2", "aivideo://media/two"]]);

/** 计数断言：active worker（未 terminate）应回基线 0。 */
function activeWorkers(): number {
  return ScriptedWorker.instances.filter(worker => !worker.terminated).length;
}

beforeEach(() => {
  ScriptedWorker.instances = [];
  installWorkers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  editorPerf.enabled = false;
  editorPerf.reset();
  cleanup();
  delete (window as { desktop?: unknown }).desktop;
});

describe("A01 worker 创建失败清理", () => {
  it("握手错误消息：terminate 自身 + 抛错", async () => {
    installWorkers(() => "error");
    await expect(DecodeWorker.create("aivideo://media/one")).rejects.toThrow("init failed");
    expect(activeWorkers()).toBe(0);
  });

  it("握手超时：统一 15s 上限，清理监听器并 terminate", async () => {
    installWorkers(() => "timeout");
    await withTimeout(() => expect(DecodeWorker.create("aivideo://media/one")).rejects.toThrow("preview worker init timeout"));
    expect(activeWorkers()).toBe(0);
  });

  it("abort signal：create 前已中止 → 立即抛 AbortError 不拉起 worker", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(DecodeWorker.create("aivideo://media/one", controller.signal))
      .rejects.toThrow("Preview creation aborted");
    expect(ScriptedWorker.instances.length).toBe(0);
  });

  it("握手中途 abort：workerReady 立刻失败并 terminate", async () => {
    installWorkers(() => "timeout");
    const controller = new AbortController();
    const created = DecodeWorker.create("aivideo://media/one", controller.signal);
    controller.abort();
    await expect(created).rejects.toThrow("Preview creation aborted");
    expect(activeWorkers()).toBe(0);
  });

  it("compositor initError：客户端自清理后抛错", async () => {
    class InitErrorWorker extends ScriptedWorker {
      postMessage(message: any) {
        this.messages.push(message);
        if (message.type === "init") queueMicrotask(() => this.reply({ type: "initError", message: "no webgl2" }));
      }
    }
    vi.stubGlobal("Worker", InitErrorWorker);
    const canvas = document.createElement("canvas");
    Object.assign(canvas, { transferControlToOffscreen: () => ({}) });
    await expect(CompositorWorkerClient.create(canvas, { inputs: [], ringDepth: 3, canvasWidth: 16, canvasHeight: 16, captionStyles: {} }))
      .rejects.toThrow("no webgl2");
    expect(ScriptedWorker.instances.every(worker => worker.terminated)).toBe(true);
  });

  it("运行时 worker error（握手成功后崩溃）：pending 全拒绝、terminate 幂等、迟到消息不炸", async () => {
    installWorkers(() => "fatal");
    const instance = await DecodeWorker.create("aivideo://media/one");
    // decode 请求发出前 worker 崩溃（fatal：ready + error 事件同批）
    const decodePromise = instance.decode(5, 30);
    await expect(decodePromise).rejects.toThrow();
    expect(() => instance.terminate()).not.toThrow();
    const second = instance.decode(6, 30);
    await expect(second).rejects.toThrow("decode worker disposed");
    // 迟到消息（terminated 后 worker 再回复）不炸；监听器已摘除 → 帧由
    // 监听路径之外持有，断言 only 检查"不炸"（close 责任在摘除监听前的
    // terminate 拒绝路径，见 upload/帧所有权用例）。
    const frame = { close: vi.fn() };
    const worker = ScriptedWorker.instances[0]!;
    expect(() => worker.reply({ type: "frame", id: 999, frame })).not.toThrow();
  });

  it("B12 回归锁：init/decode 消息不得包含函数值（postMessage 无法克隆闭包）；续票走消息往返", async () => {
    installWorkers();
    let refreshCount = 0;
    const instance = await DecodeWorker.create("aivideo://media/one", undefined, async () => { refreshCount++; return "aivideo://media/two"; });
    const worker = ScriptedWorker.instances[0]!;
    // init 消息只带布尔标志，不带任何函数值——结构化克隆可序列化。
    const initMessage = worker.messages.find(message => message.type === "init");
    expect(initMessage).toBeTruthy();
    expect(initMessage.refreshTicket).toBe(true);
    const containsFunction = (value: unknown): boolean => {
      if (typeof value === "function") return true;
      if (value && typeof value === "object") return Object.values(value).some(containsFunction);
      return false;
    };
    expect(containsFunction(worker.messages)).toBe(false);
    // Worker 发 ticket-refresh-request → 客户端调主线程回调 → 回发新 URL。
    worker.reply({ type: "ticket-refresh-request", id: 7 });
    await vi.waitFor(() => expect(refreshCount).toBe(1));
    const response = worker.messages.find(message => message.type === "ticket-refresh-response");
    expect(response).toMatchObject({ type: "ticket-refresh-response", id: 7, refreshUrl: "aivideo://media/two" });
    instance.terminate();
  });
});

describe("A01 PreviewSession.create 资源栈", () => {
  it("第 2 个输入失败：第 1 个输入的 worker + compositor 全部销毁后抛错", async () => {
    // worker 创建顺序：compositor(0) → in_1(1) → in_2(2)
    installWorkers(index => (index === 2 ? "error" : "ready"));
    stubOffscreenCanvas();
    const container = document.createElement("div");
    await expect(PreviewSession.create(container, twoInputIr(), TICKETS)).rejects.toThrow("init failed");
    expect(ScriptedWorker.instances.every(worker => worker.terminated)).toBe(true);
    // 容器内会话自建 canvas 已被移除
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.childElementCount).toBe(0);
  });

  it("B13 档位注入：conservative 4+ 视频输入环深收 5，compositor init 收到 ringDepth=5", async () => {
    installWorkers();
    stubOffscreenCanvas();
    const container = document.createElement("div");
    // 4 视频输入 IR（twoInputIr ×2 扩展）
    const ir = twoInputIr();
    for (let i = 3; i <= 4; i++) {
      ir.inputs.push({ ...ir.inputs[0]!, input_id: `in_${i}`, asset_id: `asset_video_${i}` });
      ir.segments.push({ ...ir.segments[0]!, clip_id: `clip_${i}`, input_id: `in_${i}` });
    }
    const session = await PreviewSession.create(container, ir, new Map([
      ["asset_video", "aivideo://media/one"], ["asset_video_2", "aivideo://media/two"],
      ["asset_video_3", "aivideo://media/three"], ["asset_video_4", "aivideo://media/four"],
    ]), undefined, undefined, null, "conservative");
    // compositor = 第 0 个 worker：init 消息的 ringDepth 已按档位收缩
    const compositor = ScriptedWorker.instances[0]!;
    const init = compositor.messages.find(m => m.type === "init");
    expect(init.ringDepth).toBe(5);
    session.dispose();
  });

  it("B13 档位注入：balanced 档环深保持 8（默认行为不变）", async () => {
    installWorkers();
    stubOffscreenCanvas();
    const container = document.createElement("div");
    const session = await PreviewSession.create(container, freshIr(), TICKETS, undefined, undefined, null, "balanced");
    const compositor = ScriptedWorker.instances[0]!;
    const init = compositor.messages.find(m => m.type === "init");
    expect(init.ringDepth).toBe(8);
    session.dispose();
  });

  it("B13 输入池驱动：create 注册视频输入；dispose 释放（compositor 收 releaseInput）", async () => {
    installWorkers();
    stubOffscreenCanvas();
    const container = document.createElement("div");
    const session = await PreviewSession.create(container, freshIr(), TICKETS, undefined, undefined, null, "balanced");
    const compositor = ScriptedWorker.instances[0]!;
    // dispose：全部注册输入走 releaseInput（worker 纹理删除 + 记账）
    session.dispose();
    const releases = compositor.messages.filter(m => m.type === "releaseInput");
    expect(releases.length).toBeGreaterThanOrEqual(1);
    const inputIds = releases.map(m => m.inputId);
    expect(inputIds).toContain("in_1");
  });

  it("B13 Range 缓存预算：档位值传入 decode worker init（conservative = 64MiB）", async () => {
    installWorkers();
    stubOffscreenCanvas();
    const container = document.createElement("div");
    const session = await PreviewSession.create(container, freshIr(), TICKETS, undefined, undefined, null, "conservative");
    // decode worker = 第 1 个实例（compositor 之后）
    const decode = ScriptedWorker.instances[1]!;
    const init = decode.messages.find(m => m.type === "init");
    expect(init.cacheCapBytes).toBe(64 * 1024 * 1024);
    session.dispose();
  });

  it("create 成功后 dispose：全部 worker terminate、canvas 移除、二次 dispose 幂等", async () => {
    stubOffscreenCanvas();
    const container = document.createElement("div");
    const session = await PreviewSession.create(container, freshIr(), TICKETS);
    expect(activeWorkers()).toBe(2); // compositor + decode
    expect(container.querySelector("canvas")).not.toBeNull();
    session.dispose();
    session.dispose(); // 幂等
    expect(activeWorkers()).toBe(0);
    expect(container.childElementCount).toBe(0);
    // dispose 后回调被摘除（结果只能释放，不更新 UI）
    expect(session.onTimeUs).toBeNull();
    expect(session.onEnded).toBeNull();
    // dispose 后 seek/播放只返回静默值，不触 worker
    expect(await session.seekToFrame(3)).toBe(-1);
    session.play();
    expect(session.isPlaying).toBe(false);
    const messages = ScriptedWorker.instances.flatMap(worker => worker.messages.map(m => m.type));
    expect(messages).not.toContain("compose");
  });

  it("create 中 abort：外部 signal 中止 → 会话清理并抛 AbortError", async () => {
    stubOffscreenCanvas();
    // compositor 握手挂起：abort 发生在握手等待期（decode worker 尚未创建）
    installWorkers(() => "timeout");
    const controller = new AbortController();
    const container = document.createElement("div");
    const creating = PreviewSession.create(container, freshIr(), TICKETS, undefined, controller.signal);
    await vi.waitFor(() => expect(ScriptedWorker.instances.length).toBeGreaterThanOrEqual(1));
    controller.abort();
    await expect(creating).rejects.toThrow();
    expect(ScriptedWorker.instances.every(worker => worker.terminated)).toBe(true);
    expect(container.childElementCount).toBe(0);
  }, 20_000);

  it("create 中超时（无 abort）：15s 握手上限触发全会话清理", async () => {
    stubOffscreenCanvas();
    installWorkers(() => "timeout");
    const container = document.createElement("div");
    const creating = PreviewSession.create(container, freshIr(), TICKETS);
    await withTimeout(() => expect(creating).rejects.toThrow("preview worker init timeout"));
    expect(ScriptedWorker.instances.every(worker => worker.terminated)).toBe(true);
    expect(container.childElementCount).toBe(0);
  });

  it("seek 在途 dispose：上传任务被作废，不产生 compose", async () => {
    // decode worker 握手成功但 decode 请求永不回应（挂起）
    installWorkers(() => "hang");
    stubOffscreenCanvas();
    const container = document.createElement("div");
    const session = await PreviewSession.create(container, freshIr(), TICKETS);
    const seek = session.seekToFrame(10);
    await Promise.resolve(); // 让 uploadRing 任务进入链尾
    session.dispose();
    // dispose 后 seek 被 epoch 作废：解码任务在 dispose 检查处直接作废
    //（decodeInFlight 计数也已回收，不挂死、不 compose）。
    await expect(seek).rejects.toThrow();
    const messages = ScriptedWorker.instances.flatMap(worker => worker.messages.map(m => m.type));
    expect(messages).not.toContain("compose");
  });

  it("loadCaptionFont 对已 dispose 会话静默", async () => {
    stubOffscreenCanvas();
    const container = document.createElement("div");
    const session = await PreviewSession.create(container, freshIr(), TICKETS);
    session.dispose();
    expect(() => session.loadCaptionFont(new ArrayBuffer(8))).not.toThrow();
  });
});

describe("A01 SyntheticPreview 组件生命周期", () => {
  const baseProps = () => ({
    projectId: "project_1",
    revisionId: "revision_1",
    outputRatio: "916",
    mediaUrls: new Map([["asset_video", "aivideo://media/one"]]),
    audioByClip: new Map<string, SegmentAudioConfig>([["clip_1", { enabled: true, gainDb: 0 }]]),
    playing: false,
    playheadUs: 0,
    onTimeUs: vi.fn(),
    onFallback: vi.fn(),
  });

  function stubDesktop(ir: Record<string, unknown>) {
    window.desktop = {
      getPreviewIr: vi.fn().mockResolvedValue({ schema_version: 1, ir }),
      captionFontUrl: vi.fn().mockResolvedValue("https://fonts.test/caption.woff2"),
    } as never;
  }

  beforeEach(() => {
    stubOffscreenCanvas();
    globalThis.fetch = vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })) as never;
  });

  it("create 中卸载（unmount during create）：不再挂 canvas/更新 UI，worker 回基线", async () => {
    stubDesktop(fixturePreviewIr());
    const props = baseProps();
    const { unmount } = render(<SyntheticPreview {...props} />);
    await waitFor(() => expect(ScriptedWorker.instances.length).toBe(2));
    unmount(); // create 完成前卸载
    await waitFor(() => expect(activeWorkers()).toBe(0));
    expect(props.onFallback).not.toHaveBeenCalled();
  });

  it("font fetch 失败：onFallback 触发且 worker 回基线", async () => {
    stubDesktop(fixturePreviewIr());
    globalThis.fetch = vi.fn(async () => new Response("gone", { status: 404 })) as never;
    const props = baseProps();
    render(<SyntheticPreview {...props} />);
    await waitFor(() => expect(props.onFallback).toHaveBeenCalled());
    expect(props.onFallback.mock.calls[0]![0]).toContain("caption font fetch failed");
    await waitFor(() => expect(activeWorkers()).toBe(0));
  });

  it("连续切项目 100 次压力：active worker 计数不泄漏（快速收敛）", async () => {
    stubDesktop(fixturePreviewIr());
    const props = baseProps();
    const { rerender } = render(<SyntheticPreview {...props} />);
    for (let i = 0; i < 100; i++) {
      rerender(<SyntheticPreview {...props} projectId={`project_${i % 10}`} />);
    }
    await waitFor(() => expect(activeWorkers()).toBe(0));
    expect(props.onFallback).not.toHaveBeenCalled();
  });

  it("同项目 revision 变更：会话保活（旧 worker 不销毁、不重建）", async () => {
    stubDesktop(fixturePreviewIr());
    const props = baseProps();
    const { rerender } = render(<SyntheticPreview {...props} />);
    await waitFor(() => expect(activeWorkers()).toBe(2));
    const initial = ScriptedWorker.instances;
    rerender(<SyntheticPreview {...props} revisionId="revision_2" />);
    await waitFor(() => {
      // 就地换表：旧会话 2 worker 仍活着，且没有新建 worker
      expect(initial.filter(worker => !worker.terminated)).toHaveLength(2);
      expect(ScriptedWorker.instances.length).toBe(initial.length);
    });
    expect(props.onFallback).not.toHaveBeenCalled();
  });

  it("切换项目：旧会话立即销毁（terminated 计数 ≥ 旧会话全部 worker）", async () => {
    stubDesktop(fixturePreviewIr());
    const props = baseProps();
    const { rerender } = render(<SyntheticPreview {...props} />);
    await waitFor(() => expect(activeWorkers()).toBe(2));
    rerender(<SyntheticPreview {...props} projectId="project_2" />);
    await waitFor(() => {
      const terminated = ScriptedWorker.instances.filter(worker => worker.terminated).length;
      expect(terminated).toBeGreaterThanOrEqual(2);
    });
    expect(props.onFallback).not.toHaveBeenCalled();
  });
});

describe("A01 帧所有权（transfer 后不双重 close）", () => {
  /** 忽略 new Worker(url, opts) 构造参数（基类 script 形参会被 URL 占据）。 */
  class ReadyWorker extends ScriptedWorker {
    constructor() { super("ready"); }
  }
  function makeClient(WorkerClass?: typeof ScriptedWorker): Promise<CompositorWorkerClient> {
    vi.stubGlobal("Worker", WorkerClass ?? ReadyWorker);
    ScriptedWorker.instances = []; // makeClient 自带 ready 握手
    const canvas = document.createElement("canvas");
    Object.assign(canvas, { transferControlToOffscreen: () => ({}) });
    return CompositorWorkerClient.create(canvas, { inputs: [], ringDepth: 3, canvasWidth: 16, canvasHeight: 16, captionStyles: {} });
  }

  it("compositor dispose 后 upload：帧立即关闭 + 拒绝（不 post 已 dispose worker）", async () => {
    const client = await makeClient();
    const frame = { close: vi.fn() } as unknown as VideoFrame;
    client.terminate();
    await expect(client.upload("in_1", 0, 3, frame)).rejects.toThrow("compositor worker disposed");
    expect(frame.close).toHaveBeenCalledOnce();
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    client.uploadImage("in_1", bitmap); // dispose 后静默关闭
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("dispose 后 readback/compose/resize 不再触达 worker", async () => {
    const client = await makeClient();
    const worker = ScriptedWorker.instances[0]!;
    client.terminate();
    await expect(client.readback()).rejects.toThrow("compositor worker disposed");
    client.compose([]);
    client.resize(8, 8, 0, 0, 1);
    const types = worker.messages.map(m => m.type);
    expect(types).not.toContain("compose");
    expect(types).not.toContain("resize");
    expect(types).not.toContain("readback");
  });

  it("upload postMessage 抛错（序列化失败）：帧关闭 + pending 拒绝", async () => {
    class ThrowUploadWorker extends ScriptedWorker {
      postMessage(message: any) {
        this.messages.push(message);
        if (message.type === "init") queueMicrotask(() => this.reply({ type: "ready", adapter: "test", vendor: "test" }));
        else if (message.type === "upload") throw new Error("DataCloneError");
      }
    }
    const client = await makeClient(ThrowUploadWorker);
    const frame = { close: vi.fn() } as unknown as VideoFrame;
    await expect(client.upload("in_1", 0, 3, frame)).rejects.toThrow("DataCloneError");
    expect(frame.close).toHaveBeenCalledOnce();
  });
});

describe("worker-lifecycle 辅助", () => {
  it("throwIfAborted 语义", () => {
    expect(() => throwIfAborted()).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow("Preview creation aborted");
  });
});
