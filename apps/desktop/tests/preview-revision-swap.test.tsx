/** C20c-1（revision 换 manifest 沿用会话）单测：v2 数据面下同输入 revision
 *  切换不重建 worker/GL（replaceIr 就地换装），输入集合变化才整会话重建。
 *  断言对象是 worker 生命周期与 IPC 调用形状——ScriptedWorker 只应答 init，
 *  decode/upload 悬挂为预期（与 v1 生命周期组同口径），不等待 ready 态。 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyntheticPreview } from "../src/app/preview/SyntheticPreview.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";
import { activeWorkers, installWorkers, ScriptedWorker, stubOffscreenCanvas } from "./fixtures/preview-worker-stubs.js";

const SHA = "a".repeat(64);
const manifestIdOf = (revisionId: string) => `sha256:${SHA}@${revisionId}@test`;

/** v2 manifest 原始载荷（由 v1 夹具投影；inputChanged 模拟输入集合增删）。 */
function manifestRaw(revisionId: string, inputChanged = false): Record<string, unknown> {
  const ir = fixturePreviewIr() as Record<string, any>;
  if (inputChanged) {
    ir.inputs.push({ ...ir.inputs[0], input_id: "in_2", asset_id: "asset_video_2" });
    ir.segments.push({ ...ir.segments[0], clip_id: "clip_2", input_id: "in_2" });
  }
  return {
    schema: "preview-ir-v2",
    projector_version: 1,
    manifest_id: manifestIdOf(revisionId),
    timeline_revision_id: revisionId,
    content_fingerprint: `sha256:${SHA}`,
    fps_num: 30,
    fps_den: 1,
    total_frames: ir.canvas.duration_frames,
    duration_us: ir.canvas.duration_us,
    canvas: ir.canvas,
    inputs: ir.inputs,
    segments: ir.segments,
    captions: ir.captions,
    caption_styles: ir.caption_styles,
    transition_windows: ir.transition_windows,
    known_approximations: ir.known_approximations,
  };
}

/** v2 窗口原始载荷：最小 black 帧（main.kind="black" → mainNeeds 为空 →
 *  seekToFrame 不产生上传请求、立即完成——ScriptedWorker 不应答 decode/upload，
 *  完整帧会让装配悬挂在 seek、ready 永不置位、rerender 清理即拆会话）。 */
function windowRaw(manifestId: string, startFrame: number, frameCount: number): Record<string, unknown> {
  const frames = Array.from({ length: frameCount }, (_, i) => ({
    n: startFrame + i,
    t_us: Math.round(((startFrame + i) * 1_000_000) / 30),
    main: { kind: "black" },
    overlays: [],
    captions: [],
  }));
  return { schema: "preview-ir-v2", manifest_id: manifestId, start_frame: startFrame, frame_count: frames.length, frames };
}

/** v2 形状 desktop 桩：manifest/窗口按 revision 现算（manifest_id 随 revision 变化，
 *  旧 revision 的窗口响应对新帧源即"manifest_id 失配"样本）。 */
function stubDesktopV2(isInputChanged: (revisionId: string) => boolean = () => false) {
  window.desktop = {
    getPreviewIrV2Manifest: vi.fn((input: { timeline_revision_id?: string | null }) =>
      Promise.resolve(manifestRaw(input.timeline_revision_id ?? "revision_unknown", isInputChanged(input.timeline_revision_id ?? "")))),
    getPreviewIrV2Window: vi.fn((input: { start_frame: number; frame_count: number; timeline_revision_id?: string | null }) =>
      Promise.resolve(windowRaw(manifestIdOf(input.timeline_revision_id ?? "revision_unknown"), input.start_frame, input.frame_count))),
    captionFontUrl: vi.fn().mockResolvedValue("https://fonts.test/caption.woff2"),
  } as never;
}

function baseProps() {
  return {
    projectId: "project_1",
    revisionId: "revision_1",
    outputRatio: "916",
    mediaUrls: new Map([["asset_video", "aivideo://media/one"], ["asset_video_2", "aivideo://media/two"]]),
    playing: false,
    playheadUs: 0,
    onTimeUs: vi.fn(),
    onFallback: vi.fn(),
  };
}

function manifestMock(): ReturnType<typeof vi.fn> {
  return (window.desktop as unknown as { getPreviewIrV2Manifest: ReturnType<typeof vi.fn> }).getPreviewIrV2Manifest;
}

beforeEach(() => {
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

describe("C20c-1 v2 revision 换装（会话沿用）", () => {
  it("同输入 revision 切换：worker 不销毁不重建，manifest 按新 revision 重取", async () => {
    stubDesktopV2();
    const props = baseProps();
    const { rerender } = render(<SyntheticPreview {...props} />);
    await waitFor(() => expect(ScriptedWorker.instances.length).toBe(2));
    rerender(<SyntheticPreview {...props} revisionId="revision_2" />);
    await waitFor(() => expect(manifestMock().mock.calls.length).toBe(2));
    expect(manifestMock().mock.calls[1]![0].timeline_revision_id).toBe("revision_2");
    // 会话沿用：恰为最初 2 个 worker 实例，无一 terminate（就地换装，零重建）
    expect(ScriptedWorker.instances.length).toBe(2);
    expect(ScriptedWorker.instances.every(worker => !worker.terminated)).toBe(true);
    expect(props.onFallback).not.toHaveBeenCalled();
  });

  it("输入集合变化：replaceIr 返 false → 整会话重建（旧 worker terminate、新会话 2 worker）", async () => {
    stubDesktopV2(revision => revision === "revision_2");
    const props = baseProps();
    const { rerender } = render(<SyntheticPreview {...props} />);
    await waitFor(() => expect(ScriptedWorker.instances.length).toBe(2));
    rerender(<SyntheticPreview {...props} revisionId="revision_2" />);
    await waitFor(() => expect(ScriptedWorker.instances.length).toBe(5));
    // 旧会话（1 输入 = compositor + 1 decode）2 worker 全 terminate；
    // 新会话（2 输入 = compositor + 2 decode）3 worker 存活。
    expect(ScriptedWorker.instances.slice(0, 2).every(worker => worker.terminated)).toBe(true);
    expect(activeWorkers()).toBe(3);
    expect(props.onFallback).not.toHaveBeenCalled();
  });

  it("连续 100 次混合 revision 切换：worker 计数收敛有界、无 fallback", async () => {
    stubDesktopV2(revision => revision.endsWith("-input-changed"));
    const props = baseProps();
    const { rerender } = render(<SyntheticPreview {...props} />);
    for (let i = 0; i < 100; i++) {
      const changed = i % 3 === 2;
      rerender(<SyntheticPreview {...props} revisionId={`revision_${i}${changed ? "-input-changed" : ""}`} />);
    }
    await waitFor(() => expect(manifestMock().mock.calls.length).toBe(101)); // 初始装配 + 100 次切换
    await waitFor(() => expect(props.onFallback).not.toHaveBeenCalled());
    // 快速切换下被取代的装配轮在首个 stale 检查点退出；收敛后 worker 有界
    // （至多当前会话 2 个），无泄漏、无回退。
    await waitFor(() => expect(activeWorkers()).toBeLessThanOrEqual(2));
  });

  it("换装后卸载：worker 回基线 0（会话 + 外部帧源一并释放）", async () => {
    stubDesktopV2();
    const props = baseProps();
    const { rerender, unmount } = render(<SyntheticPreview {...props} />);
    await waitFor(() => expect(ScriptedWorker.instances.length).toBe(2));
    rerender(<SyntheticPreview {...props} revisionId="revision_2" />);
    await waitFor(() => expect(manifestMock().mock.calls.length).toBe(2));
    unmount();
    await waitFor(() => expect(activeWorkers()).toBe(0));
  });
});
