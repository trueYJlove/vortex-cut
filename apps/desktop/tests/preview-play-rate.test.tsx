/** 全局播放倍速（倍速菜单 → SyntheticPreview → PreviewSession）回归。
 *
 *  四条守卫线（回退任意一条即红）：
 *   1. 纯时钟算术：tick 目标帧与音频目标 µs 按 playRate 缩放；playRate = 1
 *      时与旧式逐位同式（常速零漂移红线）；夹取域 [0.25, 4]，非数值归 1；
 *   2. setPlayRate 语义：同率无操作（不重锚）；播放态重锚到当前帧；暂停态
 *      只存储、下次 play 直接按新速率推进；
 *   3. 音频合速：rig.speed = 段速 × 全局倍速；播放中换率对发声源是「按旧速
 *      率当前位置先停后重启」（源域位置连续），空闲 rig 原位换速率；
 *   4. 组件转发：playbackRate prop → setPlayRate；会话重建（load.status）
 *      后补发；未提供 prop = 不调用（旧版行为）。
 *
 *  会话层用例走 preview-audio-fade 的 bareSession + FakeCtx 先例（不装配
 *  worker/AudioContext，私有字段经类型断言注入）；组件层用例走
 *  proxy-switch-on-pause 的 fakeSession 先例（v1 路径短路 create）。
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyntheticPreview } from "../src/app/preview/SyntheticPreview.js";
import { PreviewSession, clampPlayRate, playAudioTargetUs, playTickTarget, type SegmentAudioConfig } from "../src/app/preview/preview-session.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";
import { installWorkers } from "./fixtures/preview-worker-stubs.js";
import type { Ir } from "../src/app/preview/ir.js";

// ── 1. 纯时钟算术 ────────────────────────────────────────────────────────

describe("playTickTarget：tick 目标帧按倍速缩放", () => {
  const fps = 30;

  it("rate 1：与旧式 Math.floor(anchor + delta / (1000/fps)) 逐位同式", () => {
    for (const delta of [0, 1, 16.6, 33.333, 100, 1000.5, 2500.75]) {
      const legacy = Math.floor(120 + delta / (1000 / fps));
      expect(playTickTarget(120, delta, fps, 1)).toBe(legacy);
    }
  });

  it("rate 2：同一墙钟增量的目标帧翻倍（倍速菜单的核心算术）", () => {
    // 选无浮点残差的增量（1000ms 在 30fps 帧边界上有 1e-13 残差，floor 后掉帧——
    // 与旧式一致的行为，不是缺陷：常速同式性另有专门用例钉住）。
    expect(playTickTarget(0, 2500, fps, 1)).toBe(75);
    expect(playTickTarget(0, 2500, fps, 2)).toBe(150);
    expect(playTickTarget(0, 2500, fps, 4)).toBe(300);
    expect(playTickTarget(0, 10000, fps, 0.25)).toBe(75);
    expect(playTickTarget(120, 500, fps, 2)).toBe(150); // 120 + 30 帧
  });

  it("含 anchorFrame 偏移：增量部分按倍速缩放，锚点不变", () => {
    expect(playTickTarget(300, 1000, fps, 2)).toBe(360);
    expect(playTickTarget(300, 1000, fps, 1)).toBe(330);
  });
});

describe("playAudioTargetUs：音频墙钟目标按倍速缩放", () => {
  const fps = 30;

  it("rate 1：与旧式 Math.round(anchor*1e6/fps + delta*1000) 逐位同式", () => {
    for (const delta of [0, 16.6, 33.333, 100, 1000.5]) {
      const legacy = Math.round(120 * (1e6 / fps) + delta * 1000);
      expect(playAudioTargetUs(120, delta, fps, 1)).toBe(legacy);
    }
  });

  it("rate 2：墙钟增量项翻倍（音频图跟随同一缩放时钟）", () => {
    expect(playAudioTargetUs(0, 1000, fps, 1)).toBe(1_000_000);
    expect(playAudioTargetUs(0, 1000, fps, 2)).toBe(2_000_000);
    expect(playAudioTargetUs(120, 500, fps, 2)).toBe(120 * (1e6 / 30) + 1_000_000);
  });
});

describe("clampPlayRate：合法域与非数值兜底", () => {
  it("夹取 [0.25, 4]；非数值/NaN/Infinity 归 1", () => {
    expect(clampPlayRate(1)).toBe(1);
    expect(clampPlayRate(0.25)).toBe(0.25);
    expect(clampPlayRate(4)).toBe(4);
    expect(clampPlayRate(0.1)).toBe(0.25);
    expect(clampPlayRate(8)).toBe(4);
    expect(clampPlayRate(2)).toBe(2);
    expect(clampPlayRate(Number.NaN)).toBe(1);
    expect(clampPlayRate(Infinity)).toBe(1);
  });
});

// ── 会话层共享先例（preview-audio-fade.test.ts 的 bareSession 模式）──────

interface GainEvent { kind: "set" | "ramp" | "cancel"; value: number; atS: number }

class FakeGainParam {
  value = 1;
  events: GainEvent[] = [];
  setValueAtTime(value: number, atS: number) { this.value = value; this.events.push({ kind: "set", value, atS }); }
  linearRampToValueAtTime(value: number, atS: number) { this.value = value; this.events.push({ kind: "ramp", value, atS }); }
  cancelScheduledValues() { this.events.push({ kind: "cancel", value: Number.NaN, atS: 0 }); }
}

class FakeGainNode {
  gain = new FakeGainParam();
  connect() { /* no-op */ }
  disconnect() { /* no-op */ }
}

class FakeBufferSource {
  buffer: unknown = null;
  playbackRate = { value: 1 };
  started: Array<{ when: number; offset: number }> = [];
  stop = vi.fn();
  disconnect = vi.fn();
  connect() { /* no-op */ }
  start(when: number, offset: number) { this.started.push({ when, offset }); }
}

class FakeCtx {
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  lastSource: FakeBufferSource | null = null;
  createGain() { return new FakeGainNode(); }
  createBufferSource() { this.lastSource = new FakeBufferSource(); return this.lastSource; }
  close() { return Promise.resolve(); }
}

const audioIr = (): Ir => JSON.parse(JSON.stringify(fixturePreviewIr())) as Ir;

function bareSession(): PreviewSession {
  const SessionCtor = PreviewSession as unknown as new (ir: Ir) => PreviewSession;
  return new SessionCtor(audioIr());
}

type Rig = {
  buffer: unknown; worklet: unknown; workletBuffer: boolean; workletActive: boolean;
  workletFailed: boolean; source: FakeBufferSource | null; gain: FakeGainNode | null;
  startedAt: number; startOffset: number; speed: number; streaming: boolean;
  streamGeneration: number; streamFed: Set<number>; gateKey: string;
};

function rigWith(ctx: FakeCtx, overrides: Partial<Rig> = {}): Rig {
  return {
    buffer: { length: 48000, numberOfChannels: 2 },
    worklet: null, workletBuffer: false, workletActive: false, workletFailed: true,
    source: null, gain: new FakeGainNode(), startedAt: 0, startOffset: 0, speed: 1,
    streaming: false, streamGeneration: 0, streamFed: new Set<number>(), gateKey: "",
    ...overrides,
  } as Rig;
}

const CFG: SegmentAudioConfig = { enabled: true, gainDb: 0 };

function attach(session: PreviewSession, ctx: FakeCtx, rig: Rig, cfg: SegmentAudioConfig) {
  const internals = session as unknown as {
    audioCtx: unknown; audioByClip: Map<string, SegmentAudioConfig>;
    audioRigs: Map<string, Rig>;
  };
  internals.audioCtx = ctx;
  internals.audioByClip = new Map([["clip_1", cfg]]);
  internals.audioRigs.set("clip_1", rig);
  return internals;
}

interface SessionInternals {
  playing: boolean;
  playRate: number;
  anchorFrame: number;
  anchorWall: number;
  currentFrame: number;
  lastAdvanceWall: number;
  syncAudio(tUs: number): void;
}

function internalsOf(session: PreviewSession): SessionInternals {
  return session as unknown as SessionInternals;
}

// ── 2. setPlayRate 语义 ──────────────────────────────────────────────────

describe("setPlayRate：无操作守卫 / 重锚 / 暂停态存储", () => {
  it("同率调用是无操作：不重锚（常速菜单重复调用零扰动）", () => {
    const session = bareSession();
    const internals = internalsOf(session);
    internals.playing = true;
    internals.currentFrame = 42;
    internals.anchorFrame = 0;
    const beforeWall = internals.anchorWall = 12345;
    session.setPlayRate(1);
    expect(internals.playRate).toBe(1);
    expect(internals.anchorFrame).toBe(0); // 未重锚到当前帧
    expect(internals.anchorWall).toBe(beforeWall);
    session.dispose();
  });

  it("播放态换率：重锚到当前帧（anchorFrame = currentFrame），速率生效", () => {
    const session = bareSession();
    const internals = internalsOf(session);
    internals.playing = true;
    internals.currentFrame = 42;
    internals.anchorFrame = 0;
    session.setPlayRate(2);
    expect(internals.playRate).toBe(2);
    expect(internals.anchorFrame).toBe(42);
    session.dispose();
  });

  it("暂停态换率：只存储不重锚，play() 的锚点起按新速率推进", () => {
    const session = bareSession();
    const internals = internalsOf(session);
    internals.currentFrame = 10;
    session.setPlayRate(2); // 暂停态
    expect(internals.playRate).toBe(2);
    expect(internals.playing).toBe(false);
    expect(internals.anchorFrame).not.toBe(10); // 未被重锚
    session.dispose();
  });

  it("超界速率夹取后存储（8 → 4；0.1 → 0.25）", () => {
    const session = bareSession();
    session.setPlayRate(8);
    expect(internalsOf(session).playRate).toBe(4);
    session.setPlayRate(0.1);
    expect(internalsOf(session).playRate).toBe(0.25);
    session.dispose();
  });
});

// ── 3. 音频合速（rig.speed = 段速 × 全局倍速）────────────────────────────

describe("effectiveRigSpeed 与换率重启", () => {
  it("裸会话 effectiveRigSpeed：段速 × 全局倍速（1x 时与段速相等）", () => {
    const session = bareSession();
    const internals = session as unknown as { effectiveRigSpeed(segmentSpeed: number): number; playRate: number };
    expect(internals.effectiveRigSpeed(1)).toBe(1);
    internals.playRate = 2;
    expect(internals.effectiveRigSpeed(1)).toBe(2);
    expect(internals.effectiveRigSpeed(0.5)).toBe(1);
    internals.playRate = 0.5;
    expect(internals.effectiveRigSpeed(2)).toBe(1);
    session.dispose();
  });

  it("播放中换率：发声源按旧合速的当前位置先停后重启，新合速 = 段速 × 新倍速", () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 3;
    const source = new FakeBufferSource();
    const rig = rigWith(ctx, { source, startedAt: 0, startOffset: 1, speed: 1 });
    const session = bareSession();
    attach(session, ctx, rig, CFG);
    internalsOf(session).playing = true;
    internalsOf(session).currentFrame = 30;
    // 旧合速 1：源域位置 = 1 + 3×1 = 4s（连续换率）
    session.setPlayRate(2);
    expect(source.stop).toHaveBeenCalledTimes(1);
    expect(rig.source).not.toBe(source);
    expect(rig.speed).toBe(2);           // 段速 1 × 全局 2
    expect(rig.startedAt).toBe(3);
    expect(rig.startOffset).toBe(4);
    expect(rig.source!.playbackRate.value).toBe(2);
    session.dispose();
  });

  it("播放中换率：空闲 rig 原位换速率，不重启", () => {
    const ctx = new FakeCtx();
    const rig = rigWith(ctx, { source: null, workletActive: false, speed: 1 });
    const session = bareSession();
    attach(session, ctx, rig, CFG);
    internalsOf(session).playing = true;
    session.setPlayRate(4);
    expect(rig.speed).toBe(4);
    session.dispose();
  });

  it("暂停态换率：rig.speed 直接刷新，不触碰音源", () => {
    const ctx = new FakeCtx();
    const source = new FakeBufferSource();
    const rig = rigWith(ctx, { source, speed: 1 });
    const session = bareSession();
    attach(session, ctx, rig, CFG);
    session.setPlayRate(2);
    expect(rig.speed).toBe(2);
    expect(source.stop).not.toHaveBeenCalled();
    session.dispose();
  });

  it("syncAudio 重锚路径按合速起播（段速 2 × 全局 2 = 4，expected 夹段界）", () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 5;
    const rig = rigWith(ctx, { speed: 1, startedAt: 0, startOffset: 4 }); // 位置 4s，漂移 4s 超阈 → 重启
    const session = bareSession();
    session.ir.segments[0]!.speed_milli = 2000; // 段速 2（夹具默认 1）
    attach(session, ctx, rig, CFG);
    const internals = internalsOf(session);
    internals.playing = true;
    internals.playRate = 2;
    // 时间轴 3s：expected = 0 + 3×段速2 = 6s → 夹到段界 5s；合速 = 2×2 = 4
    internals.syncAudio(3_000_000);
    expect(rig.speed).toBe(4);
    expect(rig.source!.playbackRate.value).toBe(4);
    expect(rig.startOffset).toBe(5);
    session.dispose();
  });

  it("syncAudio 时间轴目标已含全局倍速：expected 只乘段速（不重复乘）", () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 4;
    const rig = rigWith(ctx, { speed: 1, startedAt: 4, startOffset: 1 });
    const session = bareSession();
    attach(session, ctx, rig, CFG);
    const internals = internalsOf(session);
    internals.playing = true;
    internals.playRate = 2;
    // tick 送来 tUs = 4s（时间轴域，含 2x 缩放）；段速 1 ⇒ expected = 0+4 = 4s；
    // rig 位置 = startOffset 1 + 墙钟 0 = 1 → 漂移 3s 超阈 → 重启于 4s。
    // 若实现误把全局倍速再乘一遍（expected = 8s），startOffset 会被夹到段界 5。
    internals.syncAudio(4_000_000);
    expect(rig.startOffset).toBe(4);
    expect(rig.speed).toBe(2);
    session.dispose();
  });

  it("同速无漂移分支保留段速×全局倍速，不把音源降回段速", () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 1;
    const source = new FakeBufferSource();
    const rig = rigWith(ctx, { source, startedAt: 0, startOffset: 0, speed: 4 });
    source.playbackRate.value = 4;
    const session = bareSession();
    session.ir.segments[0]!.speed_milli = 2000;
    attach(session, ctx, rig, CFG);
    const internals = internalsOf(session);
    internals.playing = true;
    internals.playRate = 2;
    // tUs=2s、段速=2、源域位置=4s：无漂移时仍应保持合速 4。
    internals.syncAudio(2_000_000);
    expect(source.stop).not.toHaveBeenCalled();
    expect(source.playbackRate.value).toBe(4);
    expect(rig.speed).toBe(4);
    session.dispose();
  });

  it("段速×全局速率超出浏览器区间时停止预览音频", () => {
    const ctx = new FakeCtx();
    const source = new FakeBufferSource();
    const rig = rigWith(ctx, { source, speed: 1 });
    const session = bareSession();
    session.ir.segments[0]!.speed_milli = 100_000;
    attach(session, ctx, rig, CFG);
    const internals = internalsOf(session);
    internals.playing = true;
    internals.syncAudio(0);
    expect(source.stop).toHaveBeenCalledTimes(1);
    expect(rig.source).toBeNull();
    session.dispose();
  });
});

// ── 4. 组件转发 ──────────────────────────────────────────────────────────

const PROPS = () => ({
  projectId: "project_1",
  revisionId: "revision_1",
  outputRatio: "916",
  mediaUrls: new Map([["asset_video", "aivideo://media/one"]]),
  playing: false,
  playheadUs: 0,
  onTimeUs: vi.fn(),
  onFallback: vi.fn(),
});

/** v1 短路假会话（proxy-switch-on-pause 先例）：setPlayRate 调用可断言。 */
function fakeSession() {
  return {
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
    setPlayRate: vi.fn(),
    snapshotPng: vi.fn(async () => null),
    metrics: vi.fn(() => null),
    chainState: vi.fn(() => null),
    pipBoxes: vi.fn(() => []),
    pipView: vi.fn(() => ({})),
    setPipGeometry: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("SyntheticPreview：playbackRate 转发", () => {
  let sessions: ReturnType<typeof fakeSession>[];

  beforeEach(() => {
    sessions = [];
    vi.stubEnv("VITE_AIVS_PREVIEW_IR_V2", "0");
    vi.spyOn(PreviewSession, "create").mockImplementation((async () => {
      const session = fakeSession();
      sessions.push(session);
      return session as never;
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

  it("playbackRate prop 变化转发给活会话（1x → 2x → 1x）", async () => {
    const props = PROPS();
    const { rerender } = render(<SyntheticPreview {...props} playbackRate={1} />);
    await waitFor(() => expect(sessions.length).toBe(1));
    // 装配完成后（load.status ready）转发 effect 生效：初值 1 也必须送达
    // （会话重建后新会话以 1 起步——显式 prop 与缺省在此同口径）。
    await waitFor(() => expect(sessions[0]!.setPlayRate).toHaveBeenCalledWith(1));
    rerender(<SyntheticPreview {...props} playbackRate={2} />);
    await waitFor(() => expect(sessions[0]!.setPlayRate).toHaveBeenCalledWith(2));
    rerender(<SyntheticPreview {...props} playbackRate={1} />);
    await waitFor(() => expect(sessions[0]!.setPlayRate).toHaveBeenLastCalledWith(1));
  });

  it("未提供 playbackRate：不调用 setPlayRate（旧版行为不变）", async () => {
    const props = PROPS();
    render(<SyntheticPreview {...props} />);
    await waitFor(() => expect(sessions.length).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sessions[0]!.setPlayRate).not.toHaveBeenCalled();
  });
});
