/** 变速不变调核心（varispeed-worklet 的 WSOLA 颗粒拉伸）单元测试：直接求值线上
 *  同一份 processor 源码（evaluateVarispeedCore），断言——
 *  r=1 逐样本透明（COLA 恒等于 1 + 免搜索直通）、r≠1 音高不变（过零率，WSOLA
 *  相位对齐后过零率贴近原始频率）、时长按 speed 压缩、变速中途切换生效、
 *  seek 重定位、输出有界无 NaN、立体声/单声道复用。 */
import { describe, expect, it } from "vitest";
import { evaluateVarispeedCore } from "../src/app/preview/varispeed-worklet.js";

const SR = 48000;
const W = 2048;

interface Core {
  setBuffer(channels: Float32Array[]): void;
  setSpeed(value: number): void;
  play(positionSec: number, speed: number): void;
  stop(): void;
  process(out: Float32Array[]): boolean;
  // B15 流式模式
  configureStream(generation: number): void;
  appendChunk(generation: number, start: number, valid: number, channels: Float32Array[]): void;
  releaseBefore(sample: number): void;
  mode: string;
  speed: number;
  underruns: number;
  streamEnd: number;
  chunks: Array<{ start: number; valid: number; data: Float32Array[] }>;
  reporter: { needRange(from: number, to: number): void; underrun(count: number): void; drained(generation: number): void } | null;
}

function makeCore(channels = 1): Core {
  const Ctor = evaluateVarispeedCore() as new (sampleRate: number, channels: number) => Core;
  return new Ctor(SR, channels);
}

function render(core: Core, frames: number, chunk = 1024): Float32Array[] {
  const outs = [new Float32Array(frames), new Float32Array(frames)];
  let done = 0;
  while (done < frames) {
    const n = Math.min(chunk, frames - done);
    const view = [outs[0]!.subarray(done, done + n), outs[1]!.subarray(done, done + n)];
    core.process(view);
    done += n;
  }
  return outs;
}

function sine(freqHz: number, samples: number, amp = 0.5): Float32Array {
  const data = new Float32Array(samples);
  for (let i = 0; i < samples; i++) data[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / SR);
  return data;
}

/** 过零率 → 频率（WSOLA 相位对齐后颗粒交叉淡化不再引入相位台阶）。 */
function zeroCrossFreq(data: Float32Array, from: number, to: number): number {
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    if ((data[i]! >= 0) !== (data[i - 1]! >= 0)) crossings += 1;
  }
  return crossings / 2 / ((to - from) / SR);
}

function lastAudible(data: Float32Array, threshold = 1e-3): number {
  for (let i = data.length - 1; i >= 0; i--) {
    if (Math.abs(data[i]!) > threshold) return i;
  }
  return -1;
}

describe("VarispeedStretch（线上同源码求值）", () => {
  it("r=1 逐样本透明（周期 Hann 50% 重叠 COLA=1 + 免搜索直通；头尾淡入淡出除外）", () => {
    const core = makeCore();
    const input = sine(440, SR);
    core.setBuffer([input]);
    core.play(0, 1);
    const [out] = render(core, SR);
    let maxDiff = 0;
    for (let i = W; i < SR - W; i++) maxDiff = Math.max(maxDiff, Math.abs(out![i]! - input[i]!));
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it("r=2：音高不变（过零率 ≈440Hz，而非变调的 880Hz）且时长压缩一半", () => {
    const core = makeCore();
    const input = sine(440, SR);
    core.setBuffer([input]);
    core.play(0, 2);
    const [out] = render(core, SR);
    const freq = zeroCrossFreq(out!, Math.round(SR * 0.15), Math.round(SR * 0.35));
    expect(Math.abs(freq - 440)).toBeLessThan(440 * 0.03);
    const end = lastAudible(out!);
    expect(end).toBeGreaterThanOrEqual(SR / 2 - W / 2);
    expect(end).toBeLessThanOrEqual(SR / 2 + W);
  });

  it("r=0.5：音高不变且时长拉长一倍", () => {
    const core = makeCore();
    const input = sine(440, SR);
    core.setBuffer([input]);
    core.play(0, 0.5);
    const [out] = render(core, SR * 2 + 2 * W);
    const freq = zeroCrossFreq(out!, Math.round(SR * 0.3), Math.round(SR * 0.7));
    expect(Math.abs(freq - 440)).toBeLessThan(440 * 0.03);
    const end = lastAudible(out!);
    expect(end).toBeGreaterThanOrEqual(SR * 2 - W);
    expect(end).toBeLessThanOrEqual(SR * 2 + W);
  });

  it("r=4：颗粒间跳过输入，音高仍不变", () => {
    const core = makeCore();
    core.setBuffer([sine(440, SR)]);
    core.play(0, 4);
    const [out] = render(core, SR);
    const freq = zeroCrossFreq(out!, Math.round(SR * 0.1), Math.round(SR * 0.2));
    expect(Math.abs(freq - 440)).toBeLessThan(440 * 0.05);
  });

  it("变速中途切换（speed 消息）：切换后第二段以 ≈880Hz 原调播出且止点按 2x 压缩", () => {
    // 输入 = 频率步进连续音（前半 440Hz、后半 880Hz）：连续信号对 WSOLA 友好，
    // 频率步进充当时间标记（止点/过零率即可断言映射，不依赖脉冲检测）。
    const input = new Float32Array(SR * 2);
    for (let i = 0; i < input.length; i++) {
      const f = i < SR ? 440 : 880;
      input[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / SR);
    }
    const core = makeCore();
    core.setBuffer([input]);
    core.play(0, 1);
    const phase1 = render(core, SR)[0]!;
    core.setSpeed(2); // r=1 已消耗输入 ≈48128；切 2x 后消耗减半
    const phase2 = render(core, SR)[0]!;
    // phase1：r=1 透明 → 全程 440Hz
    const freq1 = zeroCrossFreq(phase1, Math.round(SR * 0.2), Math.round(SR * 0.8));
    expect(Math.abs(freq1 - 440)).toBeLessThan(440 * 0.03);
    // phase2：880Hz 段以原调播出（若变调则 ≈1760Hz；若未切速则止点在 48000 之后）
    const freq2 = zeroCrossFreq(phase2, 2000, 20000);
    expect(Math.abs(freq2 - 880)).toBeLessThan(880 * 0.05);
    // 止点：剩余输入 (96000−48128) 以 2x 消耗 → 23936（±窗）
    const end2 = lastAudible(phase2);
    expect(end2).toBeGreaterThan(23936 - W - 256);
    expect(end2).toBeLessThan(23936 + W + 256);
  });

  it("seek（play position）：0.5s 处 seek、r=2，880Hz 段止点 ≈12000（未 seek 则 ≈24000+）", () => {
    const input = new Float32Array(SR);
    for (let i = 0; i < input.length; i++) {
      const f = i < SR / 2 ? 440 : 880;
      input[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / SR);
    }
    const core = makeCore();
    core.setBuffer([input]);
    core.play(0.5, 2); // 源位置 24000 采样：880Hz 段 [24000,48000) → 输出 [0,12000)
    const [out] = render(core, SR);
    const freq = zeroCrossFreq(out!, 1000, 8000);
    expect(Math.abs(freq - 880)).toBeLessThan(880 * 0.05);
    const end = lastAudible(out!);
    expect(end).toBeGreaterThan(12000 - W - 256);
    expect(end).toBeLessThan(12000 + W + 256);
  });

  it("OpenFilm 浏览器音频速度域输出有界且无 NaN；越界夹到浏览器边界", () => {
    for (const speed of [1 / 16, 0.1, 0.25, 0.5, 1, 1.25, 2, 4, 8, 16, 32]) {
      const core = makeCore();
      core.setBuffer([sine(440, SR)]);
      core.play(0, speed);
      expect(core.speed).toBe(Math.min(16, Math.max(1 / 16, speed)));
      const [out] = render(core, SR + 2 * W);
      let allFinite = true;
      let maxAbs = 0;
      for (let i = 0; i < out!.length; i++) {
        if (!Number.isFinite(out![i]!)) allFinite = false;
        maxAbs = Math.max(maxAbs, Math.abs(out![i]!));
      }
      expect(allFinite).toBe(true);
      expect(maxAbs).toBeLessThanOrEqual(1.05);
    }
    const core = makeCore();
    core.setBuffer([sine(440, SR)]);
    core.play(0, 1);
    core.stop();
    const [out] = render(core, 4096);
    let maxAbs = 0;
    for (let i = 0; i < out!.length; i++) maxAbs = Math.max(maxAbs, Math.abs(out![i]!));
    expect(maxAbs).toBe(0);
  });

  it("立体声独立内容保持；单声道源双输出复用", () => {
    const core = makeCore(2);
    const left = sine(440, SR);
    const right = sine(880, SR);
    core.setBuffer([left, right]);
    core.play(0, 1);
    const [outL, outR] = render(core, SR);
    let maxDiffL = 0;
    let maxDiffR = 0;
    for (let i = W; i < SR - W; i++) {
      maxDiffL = Math.max(maxDiffL, Math.abs(outL![i]! - left[i]!));
      maxDiffR = Math.max(maxDiffR, Math.abs(outR![i]! - right[i]!));
    }
    expect(maxDiffL).toBeLessThan(1e-6);
    expect(maxDiffR).toBeLessThan(1e-6);
    const mono = makeCore(2);
    mono.setBuffer([sine(440, SR)]);
    mono.play(0, 1);
    const [m0, m1] = render(mono, SR);
    let maxDiffMono = 0;
    for (let i = W; i < SR - W; i++) maxDiffMono = Math.max(maxDiffMono, Math.abs(m0![i]! - m1![i]!));
    expect(maxDiffMono).toBeLessThan(1e-9);
  });
});


describe("VarispeedStretch B15 流式模式（线上同源码求值）", () => {
  const CHUNK = 96_000;

  function makeStreamCore(): Core {
    return makeCore(2);
  }

  function sineChunk(startSample: number, samples: number, freqHz = 440): Float32Array[] {
    // 连续正弦：跨块相位连续（k 从绝对样本起算）
    const data = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const k = startSample + i;
      data[i] = 0.5 * Math.sin((2 * Math.PI * freqHz * k) / SR);
    }
    return [data, data];
  }

  it("流式 1x：两块拼接输出 ≈ 同数据整段 buffer 模式（跨块无缝等价）", () => {
    // 金标准 = 同一份 PCM 走旧 set-buffer 路径（已验收语义）
    const whole = sineChunk(0, CHUNK * 2)[0]!;
    const reference = makeStreamCore();
    reference.setBuffer([whole, whole]);
    reference.play(0, 1);
    const [refOut] = render(reference, CHUNK + 4096);
    // 流式：同样 PCM 切两块喂入
    const core = makeStreamCore();
    core.configureStream(1);
    core.appendChunk(1, 0, CHUNK, sineChunk(0, CHUNK));
    core.appendChunk(1, CHUNK, CHUNK, sineChunk(CHUNK, CHUNK));
    core.play(0, 1);
    const [out] = render(core, CHUNK + 4096);
    // 逐样本对拍（中段 + 跨块边界邻域；差异上界 = 块边界颗粒过渡）
    let maxDelta = 0;
    for (let i = W; i < CHUNK + W; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(out![i]! - refOut![i]!));
    }
    expect(maxDelta).toBeLessThan(0.05);
    expect(core.underruns).toBe(0); // 数据齐 → 无缺口
  });

  it("流式 2x：音高不变（过零率 ≈440Hz）且推进速率翻倍", () => {
    const core = makeStreamCore();
    core.configureStream(1);
    const span = 480_000; // 10 秒输入 → 5 秒输出
    for (let c = 0; c < span / CHUNK; c++) {
      core.appendChunk(1, c * CHUNK, CHUNK, sineChunk(c * CHUNK, CHUNK));
    }
    core.play(0, 2);
    const [out] = render(core, span / 2);
    // 2x：1 秒输出消耗 2 秒输入——中段频率仍 ≈440Hz（不变调）
    const freq = zeroCrossFreq(out!, W, SR);
    expect(Math.abs(freq - 440)).toBeLessThan(30);
  });

  it("缺口：块未到 → 静默 + underrun 一次 + needRange 上抛；数据到达后恢复", () => {
    const core = makeStreamCore();
    const events: Array<{ type: string; from?: number; to?: number; count?: number; generation?: number }> = [];
    core.configureStream(1);
    core.reporter = {
      needRange: (from, to) => events.push({ type: "need-range", from, to }),
      underrun: count => events.push({ type: "underrun", count }),
      drained: generation => events.push({ type: "drained", generation }),
    };
    // 只有块 1（96k..192k）在场：起点 0 无块 → 缺口
    core.appendChunk(1, CHUNK, CHUNK, sineChunk(CHUNK, CHUNK));
    core.play(0, 1);
    const [gapOut] = render(core, 8192);
    expect(core.underruns).toBe(1); // 缺口去重（一次）
    const need = events.filter(e => e.type === "need-range");
    expect(need.length).toBe(1);
    expect((need[0] as { from: number }).from).toBe(0); // 从窗口起点要起
    let maxAbs = 0;
    for (let i = 0; i < gapOut!.length; i++) maxAbs = Math.max(maxAbs, Math.abs(gapOut![i]!));
    expect(maxAbs).toBe(0); // 缺口静默
    // 数据补到 → 恢复出声
    core.appendChunk(1, 0, CHUNK, sineChunk(0, CHUNK));
    const [okOut] = render(core, SR);
    let recovered = 0;
    for (let i = 0; i < okOut!.length; i++) recovered = Math.max(recovered, Math.abs(okOut![i]!));
    expect(recovered).toBeGreaterThan(0.3);
  });

  it("世代隔离：旧代 appendChunk 丢弃；drained 在越过流末端上报", () => {
    const core = makeStreamCore();
    const events: Array<{ type: string; generation?: number }> = [];
    core.configureStream(2); // 当代 = 2
    core.reporter = {
      needRange: () => undefined,
      underrun: () => undefined,
      drained: generation => events.push({ type: "drained", generation }),
    };
    core.appendChunk(1, 0, CHUNK, sineChunk(0, CHUNK)); // 旧代 → 丢弃
    core.appendChunk(2, 0, 1000, sineChunk(0, 1000)); // 当代短块（EOF 尾块）
    core.play(0, 1);
    // 当代块覆盖 0..1000：出声；越过 1000（streamEnd）→ drained 上报
    render(core, 8192);
    expect(core.underruns).toBe(0); // 当代块在 → 无缺口
    const drained = events.filter(e => e.type === "drained");
    expect(drained.length).toBeGreaterThanOrEqual(1);
    expect(drained[0]!.generation).toBe(2);
    // 旧代块确实被丢弃（chunks 只有当代一块）
    expect(core.chunks.length).toBe(1);
    expect(core.chunks[0].start).toBe(0);
  });

  it("releaseBefore：旧块丢弃后正确继续（位置前进不受影响）", () => {
    const core = makeStreamCore();
    core.configureStream(1);
    for (let c = 0; c < 6; c++) {
      core.appendChunk(1, c * CHUNK, CHUNK, sineChunk(c * CHUNK, CHUNK));
    }
    core.play(0, 1);
    render(core, CHUNK * 2); // 推进 ~2 秒
    core.releaseBefore(CHUNK); // 丢弃块 0（保留 WSOLA 回读余量）
    const [out] = render(core, CHUNK);
    // 位置已越过块 0 区间：继续出声（不因块 0 缺失而退化为静默缺口）
    let maxAbs = 0;
    for (let i = 0; i < out!.length; i++) maxAbs = Math.max(maxAbs, Math.abs(out![i]!));
    expect(maxAbs).toBeGreaterThan(0.3);
  });

  it("配置后 mode 切换；set-buffer 模式不受影响（A02 回退共存）", () => {
    const core = makeStreamCore();
    core.setBuffer([sine(440, SR)]);
    core.play(0, 1);
    expect(core.mode).toBe("buffer");
    const [bufOut] = render(core, 4096);
    let bufMax = 0;
    for (let i = 0; i < bufOut!.length; i++) bufMax = Math.max(bufMax, Math.abs(bufOut![i]!));
    expect(bufMax).toBeGreaterThan(0.3);
    // 切流式（sources 清空）
    core.configureStream(1);
    expect(core.mode).toBe("stream");
    core.play(0, 1);
    const [streamOut] = render(core, 4096);
    let streamMax = 0;
    for (let i = 0; i < streamOut!.length; i++) streamMax = Math.max(streamMax, Math.abs(streamOut![i]!));
    expect(streamMax).toBe(0); // 无块 → 静默（等待喂块）
  });
});
