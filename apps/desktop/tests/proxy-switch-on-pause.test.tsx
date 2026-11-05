/** A2/A3 代理切换（2026-11 代理链路收口）：代理就绪后**不打断播放**地让预览
 *  最终切到代理，并给出弱提示。调度方已核实的链路约束（本用例的断言依据）：
 *  - sourceResolver.resolve 只在会话装配（PreviewSession.create）里跑一次，
 *    所以"不重建会话就换不了源"；
 *  - 会话重建的依赖是 [projectId, revisionId, outputRatio, mediaUrls]，
 *    代理就绪时四项都不变 ⇒ 必须再给一个重建信号（proxyEpoch）；
 *  - 重建会 dispose 当前会话（画面/音频当场中断）⇒ 播放中绝不能提交。
 *
 *  验收映射：
 *   a. 播放中代理就绪 ⇒ 不重建（epoch 挂起，PreviewSession.create 不再被调）；
 *   b. 暂停后生效 ⇒ 恰好重建 1 次（且不重复、不成环）；
 *   c. 提示：未就绪不显示 / 就绪且未切换显示 / 切换后消失；
 *   d. 不传新 prop ⇒ 行为与旧版一致（无重建、无提示）。 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyntheticPreview } from "../src/app/preview/SyntheticPreview.js";
import { PreviewSession } from "../src/app/preview/preview-session.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";
import { installWorkers } from "./fixtures/preview-worker-stubs.js";

/** jsdom 无 WebGL2/worker 环境：把装配换成"只记一次"的假会话——本用例断言的是
 *  「会话该不该重建」，不是装配本身（装配由 preview-lifecycle.test.tsx 覆盖）。 */
function fakeSession(onDispose: () => void) {
  const session = {
    disposed: false,
    isPlaying: false,
    ir: { canvas: { fps: 30, width: 1080, height: 1920 } },
    onTimeUs: null as ((us: number) => void) | null,
    onEnded: null as (() => void) | null,
    onBuffering: null as ((value: boolean) => void) | null,
    replaceIr: vi.fn(() => false),
    play: vi.fn(),
    pause: vi.fn(),
    resize: vi.fn(),
    dismissGesture: vi.fn(),
    seekToFrame: vi.fn(async () => undefined),
    refineAfterDrag: vi.fn(async () => undefined),
    loadCaptionFont: vi.fn(async () => undefined),
    setAudioByClip: vi.fn(),
    snapshotPng: vi.fn(async () => null),
    metrics: vi.fn(() => null),
    chainState: vi.fn(() => null),
    pipBoxes: vi.fn(() => []),
    pipView: vi.fn(() => ({})),
    setPipGeometry: vi.fn(),
    dispose: vi.fn(() => {
      session.disposed = true;
      onDispose();
    }),
  };
  return session;
}

const baseProps = () => ({
  projectId: "project_1",
  revisionId: "revision_1",
  outputRatio: "916",
  mediaUrls: new Map([["asset_video", "aivideo://media/one"]]),
  playing: false,
  playheadUs: 0,
  onTimeUs: vi.fn(),
  onFallback: vi.fn(),
});

const PROXY_NOTICE = "高清代理已就绪，暂停后自动切换";

describe("A2/A3 代理就绪后的自然切换", () => {
  let createCalls = 0;
  let disposed = 0;

  beforeEach(() => {
    createCalls = 0;
    disposed = 0;
    vi.stubEnv("VITE_AIVS_PREVIEW_IR_V2", "0");
    // 装配必然失败的既有回退路径（jsdom 无 WebGL2）：这里直接短路成假会话，
    // 让 create 的调用次数成为可断言的"会话重建次数"。
    vi.spyOn(PreviewSession, "create").mockImplementation((async () => {
      createCalls += 1;
      return fakeSession(() => { disposed += 1; }) as never;
    }) as never);
    installWorkers();
    window.desktop = {
      getPreviewIr: vi.fn().mockResolvedValue({ schema_version: 1, ir: fixturePreviewIr() }),
      captionFontUrl: vi.fn().mockResolvedValue("https://fonts.test/caption.woff2"),
      captionFontUrls: vi.fn().mockResolvedValue([{ family: "Noto Sans CJK SC", media_url: "" }]),
    } as never;
    globalThis.fetch = vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })) as never;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as { desktop?: unknown }).desktop;
  });

  it("a. 播放中代理就绪：不重建会话（epoch 挂起，等自然切换点）", async () => {
    const props = baseProps();
    const { rerender } = render(<SyntheticPreview {...props} playing proxyEpoch={0} />);
    await waitFor(() => expect(createCalls).toBe(1));

    // 播放中代理就绪（App 递增计数）：必须挂起——重建会当场 dispose 会话。
    rerender(<SyntheticPreview {...props} playing proxyEpoch={1} />);
    // 窗口足够长：若实现漏了 playing 闸门，重建早已发生。
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(createCalls).toBe(1);
    expect(disposed).toBe(0);
    // 已经能看出"就绪但没切" → 弱提示在场（A3 知情权）。
    expect(screen.getByRole("status").textContent).toContain(PROXY_NOTICE);
  });

  it("b. 暂停后生效：会话恰好重建 1 次，且不形成重建循环", async () => {
    const props = baseProps();
    const { rerender } = render(<SyntheticPreview {...props} playing proxyEpoch={0} />);
    await waitFor(() => expect(createCalls).toBe(1));

    rerender(<SyntheticPreview {...props} playing proxyEpoch={1} />);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(createCalls).toBe(1); // 播放中：挂起

    // 自然切换点：暂停 → 提交一次重建（新会话走 resolve，拿代理票据）。
    rerender(<SyntheticPreview {...props} playing={false} proxyEpoch={1} />);
    await waitFor(() => expect(createCalls).toBe(2));
    expect(disposed).toBe(1);
    // 计数单调 + 提交后即相等：再渲染若干次不得继续重建（无重建环）。
    for (let i = 0; i < 3; i += 1) {
      rerender(<SyntheticPreview {...props} playing={false} proxyEpoch={1} />);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(createCalls).toBe(2);
    // 切换完成 → 提示消失。
    expect(screen.queryByText(PROXY_NOTICE)).toBeNull();
  }, 30_000);

  it("c. 提示时序：未就绪不显示 → 就绪未切换显示 → 切换后消失", async () => {
    const props = baseProps();
    const { rerender } = render(<SyntheticPreview {...props} playing={false} proxyEpoch={0} />);
    await waitFor(() => expect(createCalls).toBe(1));
    expect(screen.queryByText(PROXY_NOTICE)).toBeNull();

    // 就绪 + 播放中挂起：提示在场（不打断、不抢焦点：role=status）。
    rerender(<SyntheticPreview {...props} playing proxyEpoch={1} />);
    await waitFor(() => expect(screen.queryByText(PROXY_NOTICE)).not.toBeNull());

    // 暂停即生效：提示消失。
    rerender(<SyntheticPreview {...props} playing={false} proxyEpoch={1} />);
    await waitFor(() => expect(screen.queryByText(PROXY_NOTICE)).toBeNull());
    expect(createCalls).toBe(2);
  }, 30_000);

  it("d. 不传新 prop：行为与旧版完全一致（不重建、不提示）", async () => {
    const props = baseProps();
    const { rerender } = render(<SyntheticPreview {...props} playing={false} />);
    await waitFor(() => expect(createCalls).toBe(1));
    for (let i = 0; i < 3; i += 1) {
      rerender(<SyntheticPreview {...props} playing={i % 2 === 0} />);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(createCalls).toBe(1);
    expect(disposed).toBe(0);
    expect(screen.queryByText(PROXY_NOTICE)).toBeNull();
  });
});
