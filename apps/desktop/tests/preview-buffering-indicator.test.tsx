/** P196 缓冲指示（用户裁决：延迟显示）——会话侧观测 + 组件侧落地。
 *
 * 缺陷形态：v2 窗口帧源的当前目标窗未就绪且不在途时，合成直接跳过（画面
 * 停在上一帧），会话没有任何状态通道，UI 无从知道"用户正在等画面"。
 *
 * 这里守的三件事（任何一条回退都该让本文件变红）：
 *  1. **抗闪烁**：短于 BUFFERING_NOTICE_MS(300ms) 的缺帧不得出提示——快速
 *     seek 的取窗 ~50ms，立即提示会比没有提示更差；
 *  2. **抗风暴**：一次连续卡顿里 N 次 seek/tick 采样只产生一次 started、
 *     恢复时一次 ended（边沿触发 + 单 timer）；
 *  3. 未订阅的会话行为不变。
 *
 * 会话用例用假定时器推进（真等待 300ms 会拖慢并引入抖动），并按
 * preview-lifecycle 的先例装 ScriptedWorker/OffscreenCanvas 桩——jsdom 没有
 * 真 worker。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewSession } from "../src/app/preview/preview-session.js";
import { SyntheticPreview } from "../src/app/preview/SyntheticPreview.js";
import type { FrameSource } from "../src/app/preview/frame-source.js";
import type { Ir } from "../src/app/preview/ir.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";
import { installWorkers, ScriptedWorker, stubOffscreenCanvas } from "./fixtures/preview-worker-stubs.js";

const TICKETS = new Map([["asset_video", "aivideo://media/one"]]);

/** 黑帧 IR：main.kind="black" 不需要任何输入解码，seek/tick 都能走到判定点。 */
function blackIr(totalFrames = 900): Ir {
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
  ir.canvas = { ...ir.canvas, duration_frames: totalFrames, duration_us: Math.round((totalFrames * 1_000_000) / 30) };
  return ir;
}

/** 可控 v2 帧源：stalled = 目标窗未就绪且不在途（帧取不到 → 真正在缓冲）。
 *  ensureRange 默认悬挂——模拟窗口请求迟迟不返回（卡死形态），正是提示必须
 *  能自己冒出来的场景；resolveAll() 让在途取窗落定以验证"恢复"。 */
function controllableSource(totalFrames: number) {
  const state = { stalled: false, settles: [] as Array<() => void> };
  const source: FrameSource = {
    frameCount: totalFrames,
    getFrame: (n: number) => (state.stalled ? undefined : (n >= 0 && n < totalFrames ? { n, t_us: Math.round((n * 1_000_000) / 30), main: { kind: "black" }, overlays: [], captions: [] } as never : undefined)),
    isBuffering: () => state.stalled,
    ensureRange: () => new Promise<void>(resolve => { state.settles.push(() => resolve()); }),
    dispose: () => undefined,
  };
  return { source, state };
}

function newContainer(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

describe("P196 会话缓冲观测（边沿触发 + 300ms 延迟）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ScriptedWorker.instances = [];
    installWorkers();
    stubOffscreenCanvas();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
    document.body.innerHTML = "";
  });

  it("短于 300ms 的缺帧不出提示（快速 seek 的取窗 ~50ms 不得闪烁）", async () => {
    const ir = blackIr();
    const { source, state } = controllableSource(ir.frames.length);
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, source);
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;

    state.stalled = true;
    void session.seekToFrame(5);
    await vi.advanceTimersByTimeAsync(120); // 已经在 300ms 门槛之下
    expect(onBuffering).not.toHaveBeenCalled();

    state.stalled = false; // 窗口到位 → 立即恢复（不设迟滞）
    void session.seekToFrame(6);
    await vi.advanceTimersByTimeAsync(1_000); // 越过阈值继续推进：未启动的提示不得迟到补发
    expect(onBuffering).not.toHaveBeenCalled();
    session.dispose();
  });

  it("持续缺帧超过 300ms 出提示，帧可用后立即消失", async () => {
    const ir = blackIr();
    const { source, state } = controllableSource(ir.frames.length);
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, source);
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;

    state.stalled = true;
    void session.seekToFrame(5); // 取窗悬挂不返回：判定发生在 await 之前
    await vi.advanceTimersByTimeAsync(299);
    expect(onBuffering).not.toHaveBeenCalled(); // 阈值内静默
    await vi.advanceTimersByTimeAsync(2);
    expect(onBuffering.mock.calls).toEqual([[true]]); // 出现在阈值之后

    state.stalled = false;
    void session.seekToFrame(9);
    expect(onBuffering.mock.calls).toEqual([[true], [false]]); // 恢复立即消失
    session.dispose();
  });

  it("连续拖拽风暴：一次卡顿只报一次 started、恢复只报一次 ended", async () => {
    const ir = blackIr();
    const { source, state } = controllableSource(ir.frames.length);
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, source);
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;

    state.stalled = true;
    // 30 次连续 seek + 播放 tick 采样叠在同一段卡顿里（真机拖动风暴的形态）
    for (let i = 0; i < 30; i++) {
      void session.seekToFrame(100 + i);
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(onBuffering.mock.calls).toEqual([[true]]); // 恰好一次，不随采样次数增长

    await vi.advanceTimersByTimeAsync(2_000); // 长时间保持缓冲：不得重复报
    expect(onBuffering).toHaveBeenCalledTimes(1);

    state.stalled = false;
    void session.seekToFrame(300);
    expect(onBuffering.mock.calls).toEqual([[true], [false]]);
    session.dispose();
  });

  it("dispose 后取消未决计时且不再回调", async () => {
    const ir = blackIr();
    const { source, state } = controllableSource(ir.frames.length);
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, source);
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;

    state.stalled = true;
    void session.seekToFrame(5);
    await vi.advanceTimersByTimeAsync(100); // 计时中
    session.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onBuffering).not.toHaveBeenCalled();
  });

  it("没有订阅者的会话行为与引入前一致（v1 帧源不产生任何回调）", async () => {
    const ir = blackIr();
    const session = await PreviewSession.create(newContainer(), ir, TICKETS);
    expect(session.onBuffering).toBeNull();
    // v1 全量数组在场：多轮 seek 不抛错、不产生任何提示状态
    for (let i = 0; i < 5; i++) void session.seekToFrame(i);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.onBuffering).toBeNull();
    session.dispose();
  });
});

describe("P196 缓冲指示组件落地", () => {
  const SHA = "b".repeat(64);
  const manifestId = "sha256:" + SHA + "@rev@test";
  const TOTAL = 900;

  function manifestRaw(): Record<string, unknown> {
    const ir = fixturePreviewIr() as Record<string, any>;
    return {
      schema: "preview-ir-v2", projector_version: 1, manifest_id: manifestId,
      timeline_revision_id: "rev_1", content_fingerprint: "sha256:" + SHA,
      fps_num: 30, fps_den: 1, total_frames: TOTAL, duration_us: TOTAL * 33_333,
      canvas: { ...ir.canvas, duration_frames: TOTAL }, inputs: ir.inputs, segments: ir.segments,
      captions: ir.captions, caption_styles: ir.caption_styles, transition_windows: ir.transition_windows,
      known_approximations: ir.known_approximations,
    };
  }

  function windowRaw(startFrame: number, frameCount: number): Record<string, unknown> {
    const frames = Array.from({ length: frameCount }, (_, i) => ({
      n: startFrame + i, t_us: Math.round(((startFrame + i) * 1_000_000) / 30),
      main: { kind: "black" }, overlays: [], captions: [],
    }));
    return { schema: "preview-ir-v2", manifest_id: manifestId, start_frame: startFrame, frame_count: frames.length, frames };
  }

  /** 目标窗（≥600 起始）故意晚 1.1s 返回 = 一次"用户真在等"的连续缓冲；
   *  其余窗立即返回（装配不因此挂住）。 */
  function stubDesktop(): void {
    window.desktop = {
      getPreviewIrV2Manifest: vi.fn(() => Promise.resolve(manifestRaw())),
      getPreviewIrV2Window: vi.fn((input: { start_frame: number; frame_count: number }) =>
        input.start_frame >= 600
          ? new Promise(resolve => setTimeout(() => resolve(windowRaw(input.start_frame, input.frame_count)), 1_100))
          : Promise.resolve(windowRaw(input.start_frame, input.frame_count))),
      captionFontUrl: vi.fn().mockResolvedValue("https://fonts.test/caption.woff2"),
      captionFontUrls: vi.fn().mockResolvedValue([{ family: "Noto Sans CJK SC", media_url: "" }]),
    } as never;
  }

  beforeEach(() => {
    vi.useRealTimers();
    ScriptedWorker.instances = [];
    installWorkers();
    stubOffscreenCanvas();
    globalThis.fetch = vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })) as never;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as { desktop?: unknown }).desktop;
  });

  const baseProps = () => ({
    projectId: "project_1", revisionId: "rev_1", outputRatio: "916",
    mediaUrls: new Map([["asset_video", "aivideo://media/one"]]),
    playing: false, playheadUs: 0, onTimeUs: vi.fn(), onFallback: vi.fn(),
  });

  /** 从第 startFrame 帧起播（paused→playing 走会话 play()，不经过暂停态外部
   *  seek 的 250ms 精修，避免它取消目标 seek）。 */
  function playFrom(frame: number) {
    const props = baseProps();
    const playingProps = { ...props, playing: true, playheadUs: Math.round((frame * 1_000_000) / 30) };
    const view = render(<SyntheticPreview {...playingProps} />);
    return { ...view, props };
  }

  it("缓冲超过 300ms 渲染指示条，帧到位后移除（不挡指针）", async () => {
    stubDesktop();
    // 从 590 起播：再 10 帧（~0.33s）就到窗 600，而该窗 1.1s 才回——
    // 装配期只取到窗 300（首屏 0..599），这里描述的是真机"播到未装配窗口"。
    playFrom(590);
    const chip = await screen.findByRole("status", {}, { timeout: 8_000 });
    expect(chip).toHaveTextContent("缓冲中");
    expect(chip.className).toBe("synthetic-buffering");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), { timeout: 8_000 });
    // 不挡指针是样式层保证（会话画布上的 PiP 手势必须穿透），jsdom 不加载
    // 样式表，直接对规则文本设卡。
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(css).toMatch(/\.synthetic-buffering \{[^}]*pointer-events: none/);
  });

  it("短于 300ms 的缓冲不渲染指示条（抗闪烁，组件侧口径）", async () => {
    stubDesktop();
    // 短暂停滞 120ms：窗口先不回、随后补齐——提示不得闪一下
    (window.desktop as unknown as { getPreviewIrV2Window: ReturnType<typeof vi.fn> }).getPreviewIrV2Window
      .mockImplementation((input: { start_frame: number; frame_count: number }) =>
        input.start_frame >= 600
          ? new Promise(resolve => setTimeout(() => resolve(windowRaw(input.start_frame, input.frame_count)), 120))
          : Promise.resolve(windowRaw(input.start_frame, input.frame_count)));
    playFrom(590);
    // 全程盯住 DOM（含 120ms 停滞窗口内）：不是"最后不在"，而是"一直没出现"
    const seen: boolean[] = [];
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      seen.push(document.querySelector(".synthetic-buffering") !== null);
    }
    expect(seen.some(Boolean)).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

});
