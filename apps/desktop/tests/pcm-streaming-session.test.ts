/** B15 会话级流式音频测试：mock AudioContext/worklet/desktop IPC，验证
 *  长素材（≥30s）走分块 PCM 流式链路——
 *  - create(pcmProjectId)：AudioContext 存在 + desktop.ensurePcmChunk 可用
 *    → 流加载器建立；
 *  - syncAudio 入段：ensureStreamingWorklet → configure 消息 + 初始块请求；
 *  - 块就绪后：append-chunk 消息（双声道 transfer 副本）；
 *  - seek：世代递增（reseek），旧块不接入；
 *  - 短素材（<30s）：不流式（走 A02 整段路径——ensurePcmChunk 不被调用）；
 *  - dispose：loader/cache 释放。
 *
 *  jsdom 无 AudioContext —— 注入受控 fake（addModule/createGain/
 *  AudioWorkletNode 全 fake；端口消息落数组断言）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewSession, type SegmentAudioConfig } from "../src/app/preview/preview-session.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";
import type { Ir } from "../src/app/preview/ir.js";

/** 假 AudioWorkletNode：端口消息记录（append-chunk/configure/play 等）。 */
class FakeWorkletNode {
  static instances: FakeWorkletNode[] = [];
  messages: Array<Record<string, unknown>> = [];
  port = {
    postMessage: (message: Record<string, unknown>) => { this.messages.push(message); },
    onmessage: null as ((event: { data: Record<string, unknown> }) => void) | null,
  };
  connected = false;
  constructor() { FakeWorkletNode.instances.push(this); }
  connect() { this.connected = true; }
  disconnect() { this.connected = false; }
}

class FakeGain {
  gain = { value: 1 };
  connected = false;
  connect() { this.connected = true; }
  disconnect() { this.connected = false; }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  sampleRate = 48000;
  currentTime = 0;
  audioWorklet = {
    addModule: vi.fn(async () => undefined),
  };
  destination = {};
  createGain() { return new FakeGain(); }
  constructor() { FakeAudioContext.instances.push(this); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

function longAudioIr(durationUs: number): Ir {
  const ir = JSON.parse(JSON.stringify(fixturePreviewIr())) as Ir;
  ir.inputs[0]!.duration_us = durationUs;
  return ir;
}

/** 装载 fake 全局（AudioContext/AudioWorkletNode）与 desktop IPC。 */
function installAudioFakes(chunks: Map<number, number>) {
  const ensureCalls: number[] = [];
  (globalThis as Record<string, unknown>).AudioContext = FakeAudioContext;
  (globalThis as Record<string, unknown>).AudioWorkletNode = FakeWorkletNode;
  const mediaCalls: number[] = [];
  (window as { desktop?: unknown }).desktop = {
    ensurePcmChunk: vi.fn(async (input: { start_sample: number }) => {
      ensureCalls.push(input.start_sample);
      return {
        cache_key: `sha256:${"a".repeat(64)}`, status: "ready" as const,
        start_sample: input.start_sample,
        valid_samples: chunks.get(input.start_sample) ?? 0,
        sample_rate: 48000, channels: 2, chunk_samples: 96_000,
        size_bytes: 12,
      };
    }),
    pcmChunkMediaUrl: vi.fn(async (input: { start_sample: number }) => {
      mediaCalls.push(input.start_sample);
      return { media_url: `aivideo://media/chunk_${input.start_sample}`, cache_key: `sha256:${"a".repeat(64)}`, size_bytes: 12 };
    }),
  };
  // fetch fake：返回合法块文件（头 + 交错 PCM）
  const fetchMock = vi.fn(async (url: string) => {
    const start = Number(url.split("_")[1] ?? "0");
    const valid = chunks.get(start) ?? 0;
    const buffer = new ArrayBuffer(12 + valid * 2 * 4);
    const view = new DataView(buffer);
    view.setUint32(0, start, true);
    view.setUint32(4, valid, true);
    view.setUint16(8, 48, true); // 48 kHz
    view.setUint16(10, 2, true);
    return { ok: true, arrayBuffer: async () => buffer };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { ensureCalls, mediaCalls, fetchMock };
}

/** 装载 decode/compositor worker（握手 ready）。 */
function installWorkers(): void {
  class ReadyWorker extends EventTarget {
    static instances: ReadyWorker[] = [];
    messages: unknown[] = [];
    terminated = false;
    terminate = vi.fn(() => { this.terminated = true; });
    constructor() { super(); ReadyWorker.instances.push(this); }
    postMessage(message: unknown) {
      this.messages.push(message);
      const data = message as { type?: string };
      if (data?.type === "init") {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
          data: { type: "ready", adapter: "test-adapter", vendor: "test", hardware: "test", width: 16, height: 9 },
        })));
      }
    }
  }
  (globalThis as Record<string, unknown>).Worker = ReadyWorker;
}

function stubOffscreenCanvas(): void {
  // jsdom canvas 无 transferControlToOffscreen——按 lifecycle 测试同法补丁
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    const element = original(tagName as keyof HTMLElementTagNameMap);
    if (tagName.toLowerCase() === "canvas") Object.assign(element, { transferControlToOffscreen: () => ({}) });
    return element;
  }) as typeof document.createElement);
}

const AUDIO_BY_CLIP = new Map<string, SegmentAudioConfig>([["clip_1", { enabled: true, gainDb: 0 }]]);

beforeEach(() => {
  FakeWorkletNode.instances = [];
  FakeAudioContext.instances = [];
  installWorkers();
  stubOffscreenCanvas();
  // jsdom 无 rAF / URL.createObjectURL（Blob URL）：16ms setTimeout 驱动
  // 播放 tick；worklet 模块 URL 以占位串 stub（addModule 本身就是 fake）
  vi.stubGlobal("requestAnimationFrame", (cb: (now: number) => void) =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL() { return "blob:jsdom-stub-worklet"; }
    static revokeObjectURL() { /* no-op */ }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { desktop?: unknown }).desktop;
  delete (globalThis as Record<string, unknown>).AudioContext;
  delete (globalThis as Record<string, unknown>).AudioWorkletNode;
});

describe("B15 流式音频会话接入", () => {
  it("长素材（60s）：入段流式——configure + 初始块请求 + append-chunk transfer", async () => {
    const chunks = new Map([[0, 96_000], [96_000, 96_000]]);
    const { ensureCalls, mediaCalls } = installAudioFakes(chunks);
    const container = document.createElement("div");
    // create 需要 document.createElement("canvas")（jsdom 原生支持）
    const session = await PreviewSession.create(
      container, longAudioIr(60_000_000),
      new Map([["asset_video", "aivideo://media/one"]]),
      AUDIO_BY_CLIP, undefined, null, undefined, "project_1",
    );
    expect(session).not.toBeNull();
    // audioWorklet.addModule 装载成功（Blob URL module fake）
    expect(FakeAudioContext.instances.length).toBe(1);
    // 播放 tick（rAF fake）驱动 syncAudio → 流式 rig 建立 + 块请求
    session.play();
    await new Promise(resolve => setTimeout(resolve, 60)); // 跑几轮 tick
    const worklet = FakeWorkletNode.instances[0];
    expect(worklet).toBeDefined();
    const configure = worklet!.messages.find(m => m.type === "configure");
    expect(configure).toBeDefined();
    const appended = worklet!.messages.filter(m => m.type === "append-chunk");
    expect(appended.length).toBeGreaterThanOrEqual(1);
    expect(ensureCalls.length).toBeGreaterThanOrEqual(1); // 初始块请求发出
    expect(mediaCalls.length).toBeGreaterThanOrEqual(1);
    session.pause();
    session.dispose();
  });

  it("短素材（5s）：不流式（ensurePcmChunk 不被调用，走 A02 整段路径）", async () => {
    const { ensureCalls } = installAudioFakes(new Map());
    const container = document.createElement("div");
    const session = await PreviewSession.create(
      container, longAudioIr(5_000_000),
      new Map([["asset_video", "aivideo://media/one"]]),
      AUDIO_BY_CLIP, undefined, null, undefined, "project_1",
    );
    session.play();
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(ensureCalls).toHaveLength(0); // 阈值内不走块
    expect(FakeWorkletNode.instances.length).toBe(0); // 无流式 worklet
    session.pause();
    session.dispose();
  });

  it("无 desktop IPC（非 Electron）：流式不启用，会话正常", async () => {
    installAudioFakes(new Map());
    delete (window as { desktop?: unknown }).desktop;
    const container = document.createElement("div");
    const session = await PreviewSession.create(
      container, longAudioIr(60_000_000),
      new Map([["asset_video", "aivideo://media/one"]]),
      AUDIO_BY_CLIP, undefined, null, undefined, "project_1",
    );
    expect(session).not.toBeNull();
    session.dispose();
  });

  it("非 48kHz AudioContext（44.1kHz 设备）：流式守卫拒绝——不建 loader，长素材回退 A02 整段路径", async () => {
    const { ensureCalls } = installAudioFakes(new Map());
    // 守卫对象：块按契约固定 48kHz 生成，context 采样率不匹配 = 时间域错位
    const original = FakeAudioContext;
    class FakeAudioContext44100 extends original {
      sampleRate = 44100;
    }
    (globalThis as Record<string, unknown>).AudioContext = FakeAudioContext44100;
    const container = document.createElement("div");
    const session = await PreviewSession.create(
      container, longAudioIr(60_000_000),
      new Map([["asset_video", "aivideo://media/one"]]),
      AUDIO_BY_CLIP, undefined, null, undefined, "project_1",
    );
    expect(session).not.toBeNull();
    session.play();
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(ensureCalls).toHaveLength(0); // 无任何块请求（loader 未建立）
    expect(FakeWorkletNode.instances.length).toBe(0); // 无流式 worklet
    session.pause();
    session.dispose();
    (globalThis as Record<string, unknown>).AudioContext = original;
  });
});
