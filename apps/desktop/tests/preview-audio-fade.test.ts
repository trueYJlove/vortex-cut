/** 预览音频淡入/淡出（fade_in_us / fade_out_us）：**与导出侧逐条对齐**。
 *
 * 本文件钉住三件事：
 *  1. 纯函数 `resolveAudioFade` 与 `services/core/src/aivs_core/rendering/ffmpeg.py::_fade_us`
 *     **同一组输入、同一组输出**（含跨语言实跑比对，见 parity 用例）；
 *  2. 包络自动化只作用于 now 之后（seek 到段中间不重放淡入、播放中改设置不跳变）；
 *  3. `setAudioByClip` 改 fade 时**不重建音源**（只重排 GainNode 自动化）。
 *
 * 负向对照（还原即红，各自独立）：
 *  - 去掉淡入 ramp ⇒ "包络"与"调度曲线"用例红；
 *  - 上限收缩改成钳 0 / 钳段长 ⇒ parity 与收缩用例红；
 *  - setAudioByClip 改成重建音源 ⇒ "不重建"用例红。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  audioFadeEnvelope,
  planGainAutomation,
  resolveAudioFade,
  type AudioFadeSpan,
  type GainAutomationStep,
} from "../src/app/preview/audio-fade.js";
import { PreviewSession, type SegmentAudioConfig } from "../src/app/preview/preview-session.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";
import type { Ir } from "../src/app/preview/ir.js";

/** 导出侧 `_fade_us` 的金标准表：`services/core` 实跑产出。
 *  重算命令（仓库根，改 ffmpeg.py 后必须重跑并同步本表）：
 *    .venv/Scripts/python.exe -c "import sys;sys.path.insert(0,'services/core/src');
 *      from aivs_core.rendering.ffmpeg import _fade_us as f;print([f({'fade_in_us':a,'fade_out_us':b},d) for a,b,d in ...])"
 *  下面的 `parity` 用例还会**现场**跑一次 Python 与 TS 对拍（解释器可定位时），
 *  所以本表不是唯一防线。 */
const EXPORT_GOLDEN: Array<{ in: number; out: number; dur: number; expect: [number, number] }> = [
  { in: 500_000, out: 0, dur: 2_000_000, expect: [500_000, 0] },
  { in: 0, out: 250_000, dur: 2_000_000, expect: [0, 250_000] },
  { in: 500_000, out: 250_000, dur: 2_000_000, expect: [500_000, 250_000] },
  { in: 0, out: 0, dur: 2_000_000, expect: [0, 0] },
  { in: 700_000, out: 300_000, dur: 1_000_000, expect: [700_000, 300_000] },
  { in: 1_000_000, out: 1_000_000, dur: 2_000_000, expect: [1_000_000, 1_000_000] },
  { in: 1, out: 0, dur: 3, expect: [1, 0] },
  { in: 3, out: 5, dur: 4, expect: [1, 3] },
  { in: 123_456, out: 654_321, dur: 1_000_000, expect: [123_456, 654_321] },
  { in: 250_000, out: 0, dur: 500_000, expect: [250_000, 0] },
  { in: 499_999, out: 500_001, dur: 1_000_000, expect: [499_999, 500_001] },
  { in: 1_000_000, out: 0, dur: 1_000_000, expect: [1_000_000, 0] },
  { in: 0, out: 1_000_000, dur: 1_000_000, expect: [0, 1_000_000] },
  { in: 1, out: 1, dur: 5, expect: [1, 1] },
  // 超限：按比例收缩到恰好占满
  { in: 5_000_000, out: 5_000_000, dur: 2_000_000, expect: [1_000_000, 1_000_000] },
  { in: 2_000_000, out: 4_000_000, dur: 3_000_000, expect: [1_000_000, 2_000_000] },
  { in: 0, out: 5_000_000, dur: 2_000_000, expect: [0, 2_000_000] },
  { in: 5_000_000, out: 0, dur: 2_000_000, expect: [2_000_000, 0] },
];

const asPair = (span: AudioFadeSpan): [number, number] => [span.fadeInUs, span.fadeOutUs];

describe("淡变语义：与导出侧 _fade_us 同表", () => {
  it("金标准表逐条一致（含超限收缩 / 0 / 缺省）", () => {
    for (const row of EXPORT_GOLDEN) {
      expect({ q: row, got: asPair(resolveAudioFade(row.in, row.out, row.dur)) })
        .toEqual({ q: row, got: row.expect });
    }
  });

  it("跨语言现场对拍：Python _fade_us 与本模块逐条相同", () => {
    const python = locatePython();
    if (!python) {
      // 仓库根 .venv 缺失时不断言跨语言一致性，但金标准表仍然把关（见上一条）。
      console.warn("[preview-audio-fade] 未找到 Python 解释器，跳过跨语言对拍");
      return;
    }
    const script = [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(resolve(process.cwd(), "..", "..", "services/core/src"))})`,
      "from aivs_core.rendering.ffmpeg import _fade_us",
      `cases = json.loads(${JSON.stringify(JSON.stringify(EXPORT_GOLDEN.map(r => [r.in, r.out, r.dur]))) })`,
      "print(json.dumps([list(_fade_us({'fade_in_us': a, 'fade_out_us': b}, d)) for a, b, d in cases]))",
    ].join("\n");
    const run = spawnSync(python, ["-c", script], { encoding: "utf8", timeout: 60_000 });
    expect(run.error).toBeUndefined();
    expect(run.stderr.trim()).toBe("");
    const exported = JSON.parse(run.stdout) as Array<[number, number]>;
    const local = EXPORT_GOLDEN.map(row => asPair(resolveAudioFade(row.in, row.out, row.dur)));
    expect(local).toEqual(exported);
  });

  it("缺省 / null / 非数值 ⇒ (0,0)：完全不淡（不是淡 0 秒）", () => {
    expect(asPair(resolveAudioFade(undefined, undefined, 2_000_000))).toEqual([0, 0]);
    expect(asPair(resolveAudioFade(null, null, 2_000_000))).toEqual([0, 0]);
    expect(asPair(resolveAudioFade(Number.NaN, 500_000, 2_000_000))).toEqual([0, 0]);
    expect(asPair(resolveAudioFade("500000", "0", 2_000_000))).toEqual([0, 0]);
    // 段时长 0/负：没有可淡的窗口
    expect(asPair(resolveAudioFade(500_000, 500_000, 0))).toEqual([0, 0]);
  });

  it("负数按 0 处理（与导出侧 max(int(x or 0), 0) 一致）", () => {
    expect(asPair(resolveAudioFade(-5, -7, 2_000_000))).toEqual([0, 0]);
    expect(asPair(resolveAudioFade(-500_000, 500_000, 2_000_000))).toEqual([0, 500_000]);
  });

  it("超限收缩保持比例且恰好占满（不是钳 0，也不是各自钳到段长）", () => {
    const span = resolveAudioFade(2_000_000, 4_000_000, 3_000_000);
    expect(asPair(span)).toEqual([1_000_000, 2_000_000]);
    expect(span.fadeInUs + span.fadeOutUs).toBe(3_000_000);
    // 钳 0 (0, dur) 或各自钳到 dur (dur, dur) 都会在这里露馅
    expect(span.fadeInUs).toBeGreaterThan(0);
    expect(span.fadeOutUs).toBeGreaterThan(0);
  });
});

describe("包络（段内时间）", () => {
  const span: AudioFadeSpan = { fadeInUs: 1_000_000, fadeOutUs: 2_000_000 };

  it("段首 0 ⇒ 0；淡入终点 ⇒ 1；中段恒 1；段尾 ⇒ 0", () => {
    expect(audioFadeEnvelope(span, 5_000_000, 0)).toBeCloseTo(0, 6);
    expect(audioFadeEnvelope(span, 5_000_000, 500_000)).toBeCloseTo(0.5, 6);
    expect(audioFadeEnvelope(span, 5_000_000, 1_000_000)).toBeCloseTo(1, 6);
    expect(audioFadeEnvelope(span, 5_000_000, 2_500_000)).toBeCloseTo(1, 6);
    expect(audioFadeEnvelope(span, 5_000_000, 4_000_000)).toBeCloseTo(0.5, 6);
    expect(audioFadeEnvelope(span, 5_000_000, 5_000_000)).toBeCloseTo(0, 6);
  });

  it("无淡变（(0,0)）⇒ 全程 1", () => {
    const none: AudioFadeSpan = { fadeInUs: 0, fadeOutUs: 0 };
    for (const pos of [0, 1_000, 2_500_000, 5_000_000]) {
      expect(audioFadeEnvelope(none, 5_000_000, pos)).toBe(1);
    }
  });
});

/** 把自动化步骤按线性插值采样：等价于 GainNode 对 set/linearRamp 的执行语义。
 *  用来断言"排出来的曲线 == 想听的包络"（不是真出声，见报告里的缺口说明）。 */
function sampleSchedule(steps: GainAutomationStep[], atS: number, fromValue = 0): number {
  let prevAt = 0;
  let prevValue = steps[0]?.kind === "set" ? steps[0].value : fromValue;
  if (steps[0] && steps[0].atS === 0) {
    prevValue = steps[0].value;
    if (steps.length === 1) return prevValue;
  }
  for (const step of steps.slice(1)) {
    if (atS <= step.atS) {
      const span = step.atS - prevAt;
      if (span <= 0) return step.value;
      return prevValue + (step.value - prevValue) * ((atS - prevAt) / span);
    }
    prevAt = step.atS;
    prevValue = step.value;
  }
  return prevValue;
}

describe("GainNode 自动化调度（只排 now 之后）", () => {
  const durationUs = 5_000_000;
  const span: AudioFadeSpan = { fadeInUs: 1_000_000, fadeOutUs: 1_000_000 };
  const level = 0.5;

  it("段首起播：0 → 淡入终点满增益 → 淡出终点 0", () => {
    const steps = planGainAutomation({ span, durationUs, positionUs: 0, level });
    expect(steps[0]).toEqual({ kind: "set", atS: 0, value: 0 });
    expect(steps).toContainEqual({ kind: "ramp", atS: 1, value: level });
    expect(steps[steps.length - 1]).toEqual({ kind: "ramp", atS: 5, value: 0 });
    // 调度曲线在若干采样点与解析包络一致
    for (const posUs of [0, 250_000, 500_000, 1_000_000, 2_500_000, 4_500_000, 5_000_000]) {
      expect(sampleSchedule(steps, posUs / 1_000_000))
        .toBeCloseTo(level * audioFadeEnvelope(span, durationUs, posUs), 5);
    }
  });

  it("seek 到段中间（淡入已过）：不重新从 0 淡入", () => {
    const steps = planGainAutomation({ span, durationUs, positionUs: 3_000_000, level });
    expect(steps[0]).toEqual({ kind: "set", atS: 0, value: level }); // 立即满增益
    expect(steps.some(step => step.kind === "ramp" && step.value === level)).toBe(false);
  });

  it("seek 到淡入途中：从该点的包络值接着淡，不回到 0", () => {
    const steps = planGainAutomation({ span, durationUs, positionUs: 250_000, level });
    expect(steps[0]).toEqual({ kind: "set", atS: 0, value: level * 0.25 });
    expect(steps).toContainEqual({ kind: "ramp", atS: 0.75, value: level });
  });

  it("seek 到淡出途中：只剩剩余淡出，不再安排淡入", () => {
    const steps = planGainAutomation({ span, durationUs, positionUs: 4_500_000, level });
    expect(steps[0]).toEqual({ kind: "set", atS: 0, value: level * 0.5 });
    expect(steps[steps.length - 1]).toEqual({ kind: "ramp", atS: 0.5, value: 0 });
    expect(steps).toHaveLength(2);
  });

  it("播放中改设置：先钉住当前音量再短滑过去（无跳变）", () => {
    const steps = planGainAutomation({
      span, durationUs, positionUs: 2_000_000, level,
      fromValue: 0.2, settleS: 0.02,
    });
    expect(steps[0]).toEqual({ kind: "set", atS: 0, value: 0.2 }); // = 改动前的音量
    expect(steps[1]).toEqual({ kind: "ramp", atS: 0.02, value: level });
    // 后续淡出步骤保留且不被压缩到滑动窗内
    expect(steps[steps.length - 1]).toEqual({ kind: "ramp", atS: 3, value: 0 });
  });

  it("播放中把淡入调到 0：当前音量滑到满增益，无台阶", () => {
    const steps = planGainAutomation({
      span: { fadeInUs: 0, fadeOutUs: 0 }, durationUs, positionUs: 2_000_000, level,
      fromValue: 0.1, settleS: 0.02,
    });
    expect(steps[0]).toEqual({ kind: "set", atS: 0, value: 0.1 });
    expect(steps[steps.length - 1]).toEqual({ kind: "ramp", atS: 0.02, value: level });
  });
});

// ── 会话层：setAudioByClip 不重建音源 ─────────────────────────────────────

interface GainEvent { kind: "set" | "ramp" | "cancel"; value: number; atS: number }

class FakeGainParam {
  value = 1;
  events: GainEvent[] = [];
  /** 真 WebAudio：cancelScheduledValues(now) 清掉 now 之后的自动化；这里只记录。 */
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
  lastGain: FakeGainNode | null = null;
  lastSource: FakeBufferSource | null = null;
  createGain() { this.lastGain = new FakeGainNode(); return this.lastGain; }
  createBufferSource() { this.lastSource = new FakeBufferSource(); return this.lastSource; }
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

const CFG: SegmentAudioConfig = { enabled: true, gainDb: 0, fadeInUs: 1_000_000, fadeOutUs: 1_000_000 };

function attach(session: PreviewSession, ctx: FakeCtx, rig: Rig, cfg: SegmentAudioConfig) {
  const internals = session as unknown as {
    audioCtx: unknown; audioByClip: Map<string, SegmentAudioConfig>;
    audioRigs: Map<string, Rig>; audioRigsSet: unknown;
  };
  internals.audioCtx = ctx;
  const map = new Map<string, SegmentAudioConfig>([["clip_1", cfg]]);
  internals.audioByClip = map;
  internals.audioRigs.set("clip_1", rig);
  return internals;
}

/** 用自动化步骤把一段正弦按 WebAudio 的 set/linearRamp 语义逐采样渲染。
 *
 *  与 OfflineAudioContext 的差别（**缺口，如实说明**）：这是包络域的等价渲染，
 *  证明"排出来的自动化作用于信号后首尾能量确实低"，但不经过浏览器 DSP。
 *  jsdom 无 AudioContext/OfflineAudioContext，仓库也没有 node-web-audio-api
 *  （引入依赖超出本次改动边界），因此没有做真 · OfflineAudioContext 渲染。 */
function renderWithSchedule(steps: GainAutomationStep[], seconds: number, rate = 48_000): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  // 先把步骤按 atS 升序摊成"段 + 斜率"（linearRamp 语义）
  const points = steps.filter(step => step.atS >= 0).map(step => ({ at: step.atS, value: step.value }));
  let seg = 0;
  for (let n = 0; n < out.length; n++) {
    const t = n / rate;
    while (seg + 1 < points.length && t > points[seg + 1]!.at) seg += 1;
    const cur = points[seg]!;
    const next = points[seg + 1];
    let gain: number;
    if (!next) gain = cur.value;
    else if (t <= cur.at) gain = cur.value;
    else gain = cur.value + ((next.value - cur.value) * (t - cur.at)) / Math.max(1e-9, next.at - cur.at);
    out[n] = Math.sin(2 * Math.PI * 440 * t) * gain;
  }
  return out;
}

function rms(samples: Float32Array, fromS: number, toS: number, rate = 48_000): number {
  const from = Math.max(0, Math.round(fromS * rate));
  const to = Math.min(samples.length, Math.round(toS * rate));
  let sum = 0;
  for (let n = from; n < to; n++) sum += samples[n]! * samples[n]!;
  return Math.sqrt(sum / Math.max(1, to - from));
}

describe("能量判据：首尾显著低于中段", () => {
  const durationUs = 6_000_000;
  const span: AudioFadeSpan = { fadeInUs: 1_000_000, fadeOutUs: 1_000_000 };
  const level = 0.8;

  it("渲出的波形：首 0.25s / 尾 0.25s 能量远低于中段", () => {
    const steps = planGainAutomation({ span, durationUs, positionUs: 0, level });
    const rendered = renderWithSchedule(steps, durationUs / 1_000_000);
    const head = rms(rendered, 0, 0.25);
    const tail = rms(rendered, 5.75, 6);
    const middle = rms(rendered, 2.5, 3.5);
    expect(middle).toBeGreaterThan(0.3); // 中段确实在出声
    expect(head).toBeLessThan(middle * 0.35);
    expect(tail).toBeLessThan(middle * 0.35);
    expect(head).toBeGreaterThan(0); // 是线性淡出而不是静音开关
  });

  it("无淡变（(0,0)）对照：首尾与中段等能量（证明能量差来自淡变本身）", () => {
    const steps = planGainAutomation({
      span: { fadeInUs: 0, fadeOutUs: 0 }, durationUs, positionUs: 0, level,
    });
    const rendered = renderWithSchedule(steps, durationUs / 1_000_000);
    expect(rms(rendered, 0, 0.25)).toBeCloseTo(rms(rendered, 2.5, 3.5), 3);
    expect(rms(rendered, 5.75, 6)).toBeCloseTo(rms(rendered, 2.5, 3.5), 3);
  });
});

describe("setAudioByClip：只重排包络，不重建音源", () => {
  it("改 fade 期间不 stop / 不断开 / 不重发 play", () => {
    const ctx = new FakeCtx();
    const source = new FakeBufferSource();
    const rig = rigWith(ctx, { source });
    const session = bareSession();
    const internals = attach(session, ctx, rig, CFG);

    session.setAudioByClip(new Map([["clip_1", { ...CFG, fadeInUs: 3_000_000, fadeOutUs: 0 }]]));

    expect(source.stop).not.toHaveBeenCalled();
    expect(source.disconnect).not.toHaveBeenCalled();
    expect(source.started).toHaveLength(0); // 没有重新 start
    expect(internals.audioRigs.get("clip_1")).toBe(rig); // 同一个 rig
    expect(rig.gain!.gain.events.filter(e => e.kind !== "cancel").length).toBeGreaterThan(0);
  });

  it("播放中把淡入从 1s 改到 3s：从当前音量滑过去，没有跳变点", () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 2.0; // 段内 2s（旧包络已经满增益）
    const rig = rigWith(ctx, {});
    rig.gain!.gain.value = 1; // 当前实际音量（旧包络值）
    const session = bareSession();
    attach(session, ctx, rig, { ...CFG, fadeInUs: 1_000_000 });

    session.setAudioByClip(new Map([["clip_1", { ...CFG, fadeInUs: 3_000_000, fadeOutUs: 0 }]]));

    const events = rig.gain!.gain.events.filter(e => e.kind !== "cancel");
    // 第一条 = 钉住"改动前"的音量：没有从 0.667 硬跳，也没有回到 0 重放淡入
    expect(events[0]).toEqual({ kind: "set", value: 1, atS: 2 });
    // 20ms 内滑到新包络此刻的值（3s 淡入在 2s 处 = 2/3），听不出台阶
    expect(events[1]!.kind).toBe("ramp");
    expect(events[1]!.atS - events[0]!.atS).toBeCloseTo(0.02, 6);
    expect(events[1]!.value).toBeCloseTo(2 / 3, 6);
    // 剩下 1s 继续按新包络升到满增益（只对"尚未播到的部分"调度）
    expect(events[2]).toEqual({ kind: "ramp", value: 1, atS: 3 });
  });

  it("改增益同样走包络（不再直写 gain.value 造成跳变）", () => {
    const ctx = new FakeCtx();
    const rig = rigWith(ctx, {});
    rig.gain!.gain.value = 1;
    const session = bareSession();
    attach(session, ctx, rig, CFG);
    session.setAudioByClip(new Map([["clip_1", { ...CFG, gainDb: -6 }]]));
    const events = rig.gain!.gain.events.filter(e => e.kind !== "cancel");
    const settled = Math.pow(10, -6 / 20);
    expect(events[0]).toEqual({ kind: "set", value: 1, atS: 0 }); // 先钉住当前音量
    // 滑到"新增益 × 此刻包络"；此处段内 0s、淡入 1s ⇒ 包络 0 ⇒ 目标是 0。
    // 用段中位置再验一次，确认目标确实是 -6dB（而不是 1 或 0 这类固定值）。
    expect(events[1]!.kind).toBe("ramp");
    expect(events[1]!.value).toBeCloseTo(0, 6);

    const ctx2 = new FakeCtx();
    ctx2.currentTime = 2.5; // 段内 2.5s：淡入已过、淡出未到 ⇒ 包络 1
    const rig2 = rigWith(ctx2, {});
    rig2.gain!.gain.value = 1;
    const session2 = bareSession();
    attach(session2, ctx2, rig2, CFG);
    session2.setAudioByClip(new Map([["clip_1", { ...CFG, gainDb: -6 }]]));
    const events2 = rig2.gain!.gain.events.filter(e => e.kind !== "cancel");
    expect(events2[1]!.value).toBeCloseTo(settled, 6);
    expect(events2[1]!.atS - events2[0]!.atS).toBeCloseTo(0.02, 6);
  });

  it("静音（enabled=false）仍然停声（既有语义不变）", () => {
    const ctx = new FakeCtx();
    const source = new FakeBufferSource();
    const rig = rigWith(ctx, { source });
    const session = bareSession();
    attach(session, ctx, rig, CFG);
    session.setAudioByClip(new Map([["clip_1", { ...CFG, enabled: false }]]));
    expect(source.stop).toHaveBeenCalled();
    expect(rig.source).toBeNull();
  });
});

describe("起播/重锚：淡变按段内位置接入", () => {
  it("从段首起播：0 起淡入", () => {
    const ctx = new FakeCtx();
    const rig = rigWith(ctx, {});
    const session = bareSession();
    const internals = attach(session, ctx, rig, CFG);
    (internals as unknown as {
      startAudioSource(rig: Rig, cfg: SegmentAudioConfig, segment: Ir["segments"][number], offset: number, speed: number): void;
    }).startAudioSource(rig, CFG, session.ir.segments[0]!, 0, 1);
    const events = rig.gain!.gain.events.filter(e => e.kind !== "cancel");
    expect(events[0]).toEqual({ kind: "set", value: 0, atS: 0 });
    expect(events[1]).toEqual({ kind: "ramp", value: 1, atS: 1 });
  });

  it("seek 到 3s 后起播：直接满增益，不从 0 淡入", () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 10; // 任意 ctx 时刻
    const rig = rigWith(ctx, {});
    const session = bareSession();
    const internals = attach(session, ctx, rig, CFG);
    (internals as unknown as {
      startAudioSource(rig: Rig, cfg: SegmentAudioConfig, segment: Ir["segments"][number], offset: number, speed: number): void;
    }).startAudioSource(rig, CFG, session.ir.segments[0]!, 3, 1);
    const events = rig.gain!.gain.events.filter(e => e.kind !== "cancel");
    expect(events[0]).toEqual({ kind: "set", value: 1, atS: 10 });
    expect(events.some(e => e.kind === "ramp" && e.value === 1)).toBe(false);
  });

  it("变速：淡变按**段内时间**推进，与墙钟 1:1（speed 不改变段内进度）", () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 2;
    const session = bareSession();
    const internals = attach(session, ctx, rigWith(ctx, {}), CFG);
    const posOf = (rig: Rig) => (internals as unknown as {
      segmentPositionUs(rig: Rig, segment: Ir["segments"][number]): number;
    }).segmentPositionUs(rig, session.ir.segments[0]!);

    // 同一墙钟增量下，1x 与 2x 的**段内**位置相同：speed 只改变源域消耗速率。
    // 这正是导出侧的口径——afade 作用在 atempo 之后，d= 是段内秒。
    expect(posOf(rigWith(ctx, { speed: 1, startedAt: 0, startOffset: 0 }))).toBe(2_000_000);
    expect(posOf(rigWith(ctx, { speed: 2, startedAt: 0, startOffset: 0 }))).toBe(2_000_000);
    expect(posOf(rigWith(ctx, { speed: 0.5, startedAt: 0, startOffset: 0 }))).toBe(2_000_000);
    // 源域 offset 才随 speed 换算：2x 下从源 2s 起播 = 段内已过 1s，再播 2s
    // 墙钟 ⇒ 段内 1+2 = 3s（若按源域秒当段内秒会得 4s，按墙钟缩放会得 5s）。
    expect(posOf(rigWith(ctx, { speed: 2, startedAt: 0, startOffset: 2 }))).toBe(3_000_000);
    expect(posOf(rigWith(ctx, { speed: 2, startedAt: 0, startOffset: 2 }))).not.toBe(4_000_000);
  });
});

/** 定位仓库 venv 的 Python（缺失时返回 null：跨语言对拍跳过，金标准表仍然把关）。 */
function locatePython(): string | null {
  const root = resolve(process.cwd(), "..", "..");
  const candidates = [
    resolve(root, ".venv/Scripts/python.exe"),
    resolve(root, ".venv/bin/python3"),
    resolve(root, ".venv/bin/python"),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  for (const name of ["python3", "python"]) {
    const probe = spawnSync(name, ["-c", "print(1)"], { encoding: "utf8", timeout: 20_000 });
    if (!probe.error && probe.status === 0) return name;
  }
  return null;
}
