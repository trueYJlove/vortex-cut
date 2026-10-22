/** 音频淡入/淡出：**与导出侧同一份算法**的纯函数层。
 *
 * 语义来源（唯一权威）：`services/core/src/aivs_core/rendering/ffmpeg.py::_fade_us`。
 * 本模块逐条照抄该函数——不是"大约一致"，是同一份算术：
 *  - `fade_in_us` / `fade_out_us` 是**段内**时长（微秒），从段起点/终点算；
 *  - 两者之和超过段时长 ⇒ **按比例收缩到恰好占满**：
 *    `fade_in = trunc(fade_in * dur / (fade_in + fade_out))`，`fade_out = dur - fade_in`；
 *  - `0` / 缺省 / 非数值 ⇒ `(0, 0)`，即**完全不淡**（不是"淡 0 秒"）；
 *  - 负数按 0 处理（导出侧 `max(int(x or 0), 0)`）。
 *
 * 为什么是复制而不是共享：导出侧是 Python，预览侧是 TypeScript，跨语言没有
 * 零成本的共享模块。因此一致性靠**测试**钉住：`tests/preview-audio-fade.test.ts`
 * 用同一组输入分别跑 Python 的 `_fade_us` 与本函数并逐条比对（见 parityCases）。
 *
 * 包络本身是**乘性**的：GainNode 的值 = 10^(gainDb/20) × envelope(position)，
 * envelope ∈ [0, 1]。位置用**段内时间**（导出侧 afade 的 st/d 口径）。
 */

/** 已按段时长夹住的淡入/淡出时长（微秒）；`(0, 0)` 表示完全不淡。 */
export interface AudioFadeSpan {
  fadeInUs: number;
  fadeOutUs: number;
}

/** 归一化非负整数：与导出侧 `max(int(x or 0), 0)` + `except (TypeError, ValueError)` 等价。 */
function toNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(Math.trunc(value), 0);
}

/** 段时长内实际生效的 (淡入, 淡出)；与 `ffmpeg.py::_fade_us` 逐条等价。 */
export function resolveAudioFade(fadeInUs: unknown, fadeOutUs: unknown, durationUs: number): AudioFadeSpan {
  const fadeIn = toNonNegativeInt(fadeInUs);
  const fadeOut = toNonNegativeInt(fadeOutUs);
  if (fadeIn === null || fadeOut === null) return { fadeInUs: 0, fadeOutUs: 0 };
  const duration = Math.trunc(durationUs);
  if (!Number.isFinite(duration) || duration <= 0) return { fadeInUs: 0, fadeOutUs: 0 };
  if (fadeIn === 0 && fadeOut === 0) return { fadeInUs: 0, fadeOutUs: 0 };
  if (fadeIn + fadeOut > duration) {
    const shrunkIn = Math.trunc((fadeIn * duration) / (fadeIn + fadeOut));
    return { fadeInUs: shrunkIn, fadeOutUs: duration - shrunkIn };
  }
  return { fadeInUs: fadeIn, fadeOutUs: fadeOut };
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** 段内位置 `positionUs` 处的淡变系数（0..1）；无淡变恒为 1。 */
export function audioFadeEnvelope(span: AudioFadeSpan, durationUs: number, positionUs: number): number {
  if (span.fadeInUs > 0 && positionUs < span.fadeInUs) return clamp01(positionUs / span.fadeInUs);
  if (span.fadeOutUs > 0) {
    const outStartUs = durationUs - span.fadeOutUs;
    if (positionUs > outStartUs) return clamp01((durationUs - positionUs) / span.fadeOutUs);
  }
  return 1;
}

/** 一条 GainNode 自动化指令：`atS` 是**相对锚点**（= 调度时刻 "now"）的秒数。 */
export type GainAutomationStep =
  | { kind: "set"; atS: number; value: number }
  | { kind: "ramp"; atS: number; value: number };

/**
 * 从"当前段内位置"出发，把**尚未播到的部分**排成 GainNode 自动化。
 *
 * 关键性质（本任务的全部听觉要求都落在这三条上）：
 * 1. 第一条永远不会造成跳变：起播时它 `set` 成**当前包络值**（段首 = 0），
 *    播放中改设置时它 `set` 成**改动前的实际音量**再短滑过去（见 fromValue）；
 * 2. 过去的时间点一律不重排 ⇒ 已播过的部分不会被"重放淡入"；
 * 3. 时间单位是**段内秒**（与导出侧 afade 的 st/d 同域）。段内时间在预览里与
 *    AudioContext 墙钟 1:1 推进（speed 由音源自身消耗，只改变源域取样速度），
 *    所以 atS 可以直接当 ctx 秒偏移用——这正是导出侧"先 atempo 再 afade"的域。
 */
export function planGainAutomation(input: {
  span: AudioFadeSpan;
  durationUs: number;
  positionUs: number;
  level: number;
  /** 当前实际音量（播放中改设置时用；缺省 = 直接跳到包络值）。 */
  fromValue?: number;
  /** 从 fromValue 滑到包络值的时长（秒）；<=0 表示不滑（硬设，起播用）。 */
  settleS?: number;
}): GainAutomationStep[] {
  const { span, durationUs, level } = input;
  const positionUs = Number.isFinite(input.positionUs) ? input.positionUs : 0;
  const nowValue = level * audioFadeEnvelope(span, durationUs, positionUs);
  const steps: GainAutomationStep[] = [
    { kind: "set", atS: 0, value: nowValue },
  ];
  if (span.fadeInUs > 0 && positionUs < span.fadeInUs) {
    steps.push({ kind: "ramp", atS: (span.fadeInUs - positionUs) / 1_000_000, value: level });
  }
  if (span.fadeOutUs > 0) {
    const outStartUs = durationUs - span.fadeOutUs;
    const endS = (durationUs - positionUs) / 1_000_000;
    if (endS > 0) {
      if (positionUs < outStartUs) {
        // 先保持满增益到淡出起点（否则 linearRamp 会从淡入终点一路斜降）
        steps.push({ kind: "set", atS: (outStartUs - positionUs) / 1_000_000, value: level });
      }
      steps.push({ kind: "ramp", atS: endS, value: 0 });
    }
  }
  const settleS = input.settleS ?? 0;
  const fromValue = input.fromValue;
  if (settleS <= 0 || fromValue === undefined || Math.abs(fromValue - nowValue) < 1e-6) return steps;
  // 播放中改设置：不要硬跳。先在 now 处钉住**当前**音量，再用 settleS 滑到
  // 此刻应有的包络值；落在滑动窗内的后续步骤折进滑动终点（20ms 量级，
  // 听觉上等价于"顺着现有音量接过去"）。
  const rest = steps.slice(1).filter(step => step.atS > settleS);
  const folded = steps.slice(1).filter(step => step.atS <= settleS);
  const settleValue = folded.length ? folded[folded.length - 1]!.value : nowValue;
  return [
    { kind: "set", atS: 0, value: fromValue },
    { kind: "ramp", atS: settleS, value: settleValue },
    ...rest,
  ];
}
