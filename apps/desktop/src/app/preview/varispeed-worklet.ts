/**
 * 变速不变调（pitch-preserving varispeed）AudioWorklet：WSOLA 颗粒时域拉伸。
 *
 * 设计（M3-2.2 验收回归"声音变了"的对齐项——交互预览 HTMLMediaElement 默认
 * preservesPitch=true，合成预览 playbackRate 直调会变调；对齐剪映默认）：
 * - 合成跳步 Hs = W/2 固定（输出域），分析跳步 Ha = speed×Hs（输入域）；
 *   每颗粒以原速（rate 1）读取输入 → 输出音高 = 原始音高，时长压缩 speed 倍；
 * - 周期 Hann 窗在 50% 重叠处 COLA 恒等于 1：speed=1 时输出 ≡ 输入（透明，
 *   且 speed=1 走免搜索直通），speed≠1 时窗内仍按 rate 1 播放 → 不变调；
 * - **WSOLA 对齐**：纯 OLA 在 speed≠1 时颗粒边界波形相位不连续（周期性
 *   相位台阶 → 音调内容测得 ±4~10% 漂移、听感发毛）。每颗粒在容差
 *   δ=240 采样（5ms）内做两阶段（步长 4 粗搜 + 步长 1 精修）平方误差
 *   最小搜索，让新颗粒首段 ≈ 上一颗粒尾段的自然延续 → 交叉淡化区相位
 *   连续；偏移逐颗粒独立、不累加（时间映射抖动 ≤δ，远小于会话 80ms
 *   漂移校正阈值）。参考 = 上一颗粒未加窗尾段（hop 采样，声道 0）；
 * - speed 变更从下一颗粒生效（输入位置连续，无重启毛刺）；play(position)
 *   重定位（清 OLA 累加器与 WSOLA 参考，~W/2 静音过渡，仅入场/重锚触达）。
 *
 * B15 流式模式（沿 set-buffer 兼容新增）：configure(generation) 切入流式，
 * 输入 PCM 来自 appendChunk 的 2 秒块（96000 样本网格拼接，块为消费者
 * transfer 副本）；readAt 跨块按绝对样本坐标读取；块未到 → 静默颗粒 +
 * underrun 计数（缺口去重）+ needRange 消息上抛（渲染线程喂块——音频线程
 * 不做 I/O）；releaseBefore(sample) 丢弃旧块（保留 WSOLA 回读余量）；
 * 世代隔离（appendChunk 携带 generation，旧代迟到块丢弃）；越过已知流
 * 末端 → drained 上报。旧 set-buffer 全量模式语义不变（A02 小素材回退）。
 *
 * 单一真源：processor 源码以本字符串常量存放（Blob URL addModule 加载），
 * 单测（tests/varispeed-worklet.test.ts）直接求值同一份代码断言音高/时长/
 * 变速切换/seek；探针 m3p5 在真实 Chromium 音频线程（OfflineAudioContext）
 * 复验同一份源码。源码内禁用反引号与模板插值（宿主为 TS 模板字符串）。
 */

export const VARISPEED_WORKLET_NAME = "varispeed-stretcher";

export const VARISPEED_PROCESSOR_SOURCE = String.raw`
"use strict";
var VARISPEED_WINDOW = 2048;
var VARISPEED_DELTA = 240;
class VarispeedStretch {
  constructor(sampleRate, channels) {
    this.sampleRate = sampleRate;
    this.window = VARISPEED_WINDOW;
    this.hop = this.window >> 1;
    this.delta = VARISPEED_DELTA;
    this.channels = channels;
    this.hann = new Float32Array(this.window);
    for (var n = 0; n < this.window; n++) {
      this.hann[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / this.window));
    }
    this.acc = [];
    for (var c = 0; c < channels; c++) this.acc.push(new Float32Array(this.window));
    this.accHead = 0;
    this.grainCountdown = 0;
    this.sources = null;
    this.srcLen = 0;
    this.pos = 0;
    this.speed = 1;
    this.running = false;
    this.prevTail = null;
    // B15 流式状态：输入来自 appendChunk 的 2 秒块（96000 样本网格拼接）
    this.mode = "buffer";
    this.chunks = [];
    this.streamEnd = -1;
    this.underruns = 0;
    this.inGap = false;
    this.reporter = null;
    this.generation = 0;
  }
  setBuffer(channels) {
    this.sources = channels;
    this.srcLen = channels.length && channels[0] ? channels[0].length : 0;
  }
  configureStream(generation) {
    this.mode = "stream";
    this.chunks = [];
    this.streamEnd = -1;
    this.sources = null;
    this.srcLen = 0;
    this.generation = generation || 0;
    this.underruns = 0;
    this.inGap = false;
  }
  appendChunk(generation, start, valid, channelData) {
    if (this.mode !== "stream") return;
    if (generation !== this.generation) return; // 旧代迟到块丢弃
    for (var i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i].start === start) return; // 幂等
    }
    var chunk = { start: start, valid: valid, data: channelData };
    var at = this.chunks.length;
    for (var k = 0; k < this.chunks.length; k++) {
      if (this.chunks[k].start > start) { at = k; break; }
    }
    this.chunks.splice(at, 0, chunk);
    var end = start + valid;
    if (end > this.streamEnd) this.streamEnd = end;
    this.inGap = false; // 数据到达：缺口复位（下一缺口再报）
  }
  releaseBefore(sample) {
    if (this.mode !== "stream") return;
    // 保留 sample 往前一个颗粒窗（WSOLA 参考仍可能回读 hop+delta）
    var keepBefore = sample - this.window - this.delta;
    for (var i = this.chunks.length - 1; i >= 0; i--) {
      if (this.chunks[i].start + this.chunks[i].valid <= keepBefore) this.chunks.splice(i, 1);
    }
  }
  readAt(channel, sample) {
    for (var i = 0; i < this.chunks.length; i++) {
      var chunk = this.chunks[i];
      if (sample < chunk.start) return NaN;
      if (sample < chunk.start + chunk.valid) {
        var data = chunk.data[channel < chunk.data.length ? channel : chunk.data.length - 1];
        return data[sample - chunk.start];
      }
    }
    return NaN;
  }
  readSource(channel, sample) {
    if (this.mode === "stream") return this.readAt(channel, sample);
    if (!this.sources) return NaN;
    if (sample < 0 || sample >= this.srcLen) return 0;
    return this.sources[Math.min(channel, this.sources.length - 1)][sample];
  }
  setSpeed(value) {
    var v = Number(value);
    if (!isFinite(v)) return;
    this.speed = Math.min(4, Math.max(0.25, v));
  }
  play(positionSec, speed) {
    this.setSpeed(speed);
    var p = Number(positionSec);
    this.pos = isFinite(p) && p > 0 ? p * this.sampleRate : 0;
    for (var c = 0; c < this.channels; c++) this.acc[c].fill(0);
    this.accHead = 0;
    this.grainCountdown = 0;
    this.prevTail = null;
    this.running = true;
  }
  stop() {
    this.running = false;
  }
  process(out) {
    var frames = out[0].length;
    var running = this.running;
    var w = this.window;
    var head = this.accHead;
    for (var i = 0; i < frames; i++) {
      if (running && this.grainCountdown === 0) {
        this.placeGrain();
        this.grainCountdown = this.hop;
      }
      for (var c = 0; c < this.channels; c++) {
        var ch = out[c] || out[0];
        ch[i] = running ? this.acc[c][head] : 0;
        this.acc[c][head] = 0;
      }
      head = (head + 1) % w;
      if (this.grainCountdown > 0) this.grainCountdown--;
    }
    this.accHead = head;
    return true;
  }
  bestOffset(start) {
    if (this.speed === 1 || !this.prevTail) return 0;
    var ref = this.prevTail;
    var hop = this.hop;
    var lo = Math.max(-this.delta, -start);
    var hi;
    if (this.mode === "stream") {
      hi = this.delta; // 流式无 srcLen 上界（块按需到达）
    } else {
      if (!this.sources) return 0;
      hi = Math.min(this.delta, this.srcLen - hop - start);
    }
    if (hi < lo) return 0;
    var src = this.mode === "stream" ? null : this.sources[0];
    var best = 0;
    var bestScore = Infinity;
    for (var pass = 0; pass < 2; pass++) {
      var step = pass === 0 ? 4 : 1;
      var from = pass === 0 ? lo : Math.max(lo, best - 4);
      var to = pass === 0 ? hi : Math.min(hi, best + 4);
      for (var o = from; o <= to; o += step) {
        var score = 0;
        for (var j = 0; j < hop; j += 2) {
          var d = (src ? src[start + o + j] : this.readAt(0, start + o + j)) - ref[j];
          if (d !== d) { score = Infinity; break; } // NaN（缺口）不参与
          score += d * d;
          if (score >= bestScore) break;
        }
        if (score < bestScore) {
          bestScore = score;
          best = o;
        }
      }
    }
    return best;
  }
  placeGrain() {
    var start = Math.round(this.pos);
    if (start < 0) start = 0;
    if (this.mode === "buffer" && (!this.sources || !this.srcLen)) return;
    // 流式末端判定：越过已知流末端（尾块/EOF 块有效区终点）→ drained 上报
    if (this.mode === "stream" && this.streamEnd >= 0 && start >= this.streamEnd) {
      this.pos += this.hop * this.speed;
      this.prevTail = null;
      if (this.reporter && this.running) this.reporter.drained(this.generation);
      return;
    }
    // 流式缺口判定：颗粒读窗起点无块覆盖 → 静默颗粒 + underrun（缺口去重）
    if (this.mode === "stream") {
      var probe = this.readAt(0, start);
      if (probe !== probe) {
        if (!this.inGap) {
          this.inGap = true;
          this.underruns += 1;
          if (this.reporter) {
            this.reporter.underrun(this.underruns);
            this.reporter.needRange(Math.max(0, start - this.window), start + this.window + this.delta);
          }
        }
        this.pos += this.hop * this.speed;
        this.prevTail = null;
        return;
      }
      this.inGap = false;
    } else if (start >= this.srcLen) {
      this.pos += this.hop * this.speed;
      this.prevTail = null;
      return;
    }
    start += this.bestOffset(start);
    var w = this.window;
    var head = this.accHead;
    for (var c = 0; c < this.channels; c++) {
      var acc = this.acc[c];
      for (var j = 0; j < w; j++) {
        var idx = start + j;
        if (this.mode === "buffer" && (idx < 0 || idx >= this.srcLen)) continue;
        var v = this.readSource(c, idx);
        if (v !== v) continue; // NaN（流式缺口）：窗内跳过（相邻颗粒 COLA 补）
        acc[(head + j) % w] += v * this.hann[j];
      }
    }
    if (!this.prevTail) this.prevTail = new Float32Array(this.hop);
    for (var t = 0; t < this.hop; t++) {
      var ti = start + this.hop + t;
      var tv = this.readSource(0, ti);
      this.prevTail[t] = tv === tv ? tv : 0;
    }
    this.pos += this.hop * this.speed;
  }
}
class VarispeedStretchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.core = new VarispeedStretch(sampleRate, 2);
    var self = this;
    this.port.onmessage = function (event) {
      var d = event.data || {};
      if (d.type === "set-buffer") self.core.setBuffer(d.channels);
      else if (d.type === "configure") self.core.configureStream(d.generation);
      else if (d.type === "append-chunk") self.core.appendChunk(d.generation, d.start, d.valid, d.channels);
      else if (d.type === "release-before") self.core.releaseBefore(d.sample);
      else if (d.type === "play") self.core.play(d.position, d.speed);
      else if (d.type === "speed") self.core.setSpeed(d.value);
      else if (d.type === "stop") self.core.stop();
    };
    // processorOptions 同步初始化（OfflineAudioContext 场景：渲染批处理可能在
    // 端口消息投递前完成，初始状态必须随节点构造到达，见 m3p5 复验）。
    var opts = options && options.processorOptions ? options.processorOptions : null;
    if (opts) {
      if (opts.channels) this.core.setBuffer(opts.channels);
      if (opts.configure) this.core.configureStream(opts.generation || 0);
      if (opts.play) this.core.play(opts.position || 0, opts.speed || 1);
    }
    // B15 事件上抛：needRange（渲染线程喂块）/ underrun（缺口计数）/
    // drained（越过流末端）。音频线程只发消息不做 I/O——加载在渲染侧。
    this.core.reporter = {
      needRange: function (from, to) {
        self.port.postMessage({ type: "need-range", from: from, to: to, generation: self.core.generation });
      },
      underrun: function (count) {
        self.port.postMessage({ type: "underrun", count: count, generation: self.core.generation });
      },
      drained: function (generation) {
        self.port.postMessage({ type: "drained", generation: generation });
      },
    };
  }
  process(inputs, outputs) {
    this.core.process(outputs[0]);
    return true;
  }
}
registerProcessor("varispeed-stretcher", VarispeedStretchProcessor);
`;

let workletUrlCache: string | null = null;

/** processor 源码 → Blob URL（addModule 按上下文求值；URL 可跨上下文复用）。 */
export function createVarispeedWorkletUrl(): string {
  if (!workletUrlCache) {
    workletUrlCache = URL.createObjectURL(new Blob([VARISPEED_PROCESSOR_SOURCE], { type: "application/javascript" }));
  }
  return workletUrlCache;
}

/** 测试/探针求值辅助：在无 AudioWorklet 全局的环境提取核心类（与线上同源码）。 */
export function evaluateVarispeedCore(): unknown {
  const factory = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    VARISPEED_PROCESSOR_SOURCE + "\n;return { VarispeedStretch: VarispeedStretch };",
  );
  const scope = factory(class {}, () => undefined) as { VarispeedStretch: unknown };
  return scope.VarispeedStretch;
}
