/** M3-2.2 播放探针：生产 PreviewSession（合成预览同一编排代码）在真实项目 IR 上
 * 播放全片，周期采样丢帧/合成帧/解码 RTT/解码链状态，并在关键时间点回读画布
 * PNG 取证（画中画内容、主轨几何、片尾逐帧对照）。与 m3p4（seek 基准）互补：
 * m3p4 测暂停态寻址，本探针测播放态吞吐——合成预览"卡顿/丢帧"的复现载体。
 * 附：变速不变调（WSOLA AudioWorklet）在真实 Chromium 音频线程的
 * OfflineAudioContext 复验（同一份线上源码），以及会话音频路径取证（audioDebug）。 */
import { parseIr } from "../app/preview/ir.js";
import { PreviewSession, type PreviewSessionMetrics, type SegmentAudioConfig } from "../app/preview/preview-session.js";
import { VARISPEED_WORKLET_NAME, createVarispeedWorkletUrl } from "../app/preview/varispeed-worklet.js";
import { setupProbe, collectEnvironment } from "./common/shell.js";
import { probeBridge } from "./common/bridge.js";

const SAMPLE_INTERVAL_MS = 250;
const READBACK_AT_S = [0.5, 3.5, 6.0, 9.5, 10.1, 10.4, 10.62];
const VARISPEED_WINDOW = 2048;

interface Sample {
  t_ms: number;
  content_us: number;
  composed: number;
  dropped: number;
  task_ms_p50: number;
  task_ms_p95: number;
  decode_ms_p50: number;
  decode_ms_p95: number;
  upload_ms_p95: number;
  decode_in_flight: number;
  last_error: string | null;
  chain?: Record<string, unknown>;
  /** P33 分段计时（VITE_AIVS_DECODE_TIMING=1 时出数，否则 null）。 */
  decode_seg?: PreviewSessionMetrics["decode_seg"];
}

/** 画布 PNG 取证（会话侧 readback：OffscreenCanvas worker convertToBlob →
 *  ArrayBuffer transfer 回主线程）。 */
async function snapshot(session: PreviewSession, bridge: ReturnType<typeof probeBridge>, name: string): Promise<void> {
  const buffer = await session.readbackPng();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  await bridge.writeArtifact(`${name}.png`, { base64: btoa(binary) });
}

function sampleOf(tMs: number, contentUs: number, metrics: PreviewSessionMetrics): Sample {
  return {
    t_ms: Math.round(tMs),
    content_us: contentUs,
    composed: metrics.composed_frames,
    dropped: metrics.dropped_frames,
    task_ms_p50: metrics.task_ms_p50,
    task_ms_p95: metrics.task_ms_p95,
    decode_ms_p50: metrics.decode_ms_p50,
    decode_ms_p95: metrics.decode_ms_p95,
    upload_ms_p95: metrics.upload_ms_p95,
    decode_in_flight: metrics.decode_in_flight,
    last_error: metrics.last_error,
    decode_seg: metrics.decode_seg ?? undefined,
  };
}

/** 变速不变调复验（真实音频线程）：OfflineAudioContext 渲染线上同源码 worklet，
 *  440Hz 正弦 @2x → 输出过零率应 ≈440（变调路径会是 880），时长压缩一半。
 *  初始状态走 processorOptions（同步构造——离线渲染批处理可能先于端口消息）。 */
async function verifyVarispeedWorklet(): Promise<Record<string, unknown> | null> {
  if (typeof OfflineAudioContext === "undefined") return null;
  try {
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    await ctx.audioWorklet.addModule(createVarispeedWorkletUrl());
    const source = new Float32Array(48000);
    for (let i = 0; i < source.length; i++) source[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    const node = new AudioWorkletNode(ctx, VARISPEED_WORKLET_NAME, {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { channels: [source], play: true, position: 0, speed: 2 },
    });
    node.connect(ctx.destination);
    const rendered = await ctx.startRendering();
    const channel = rendered.getChannelData(0);
    let crossings = 0;
    for (let i = 2400; i < 19200; i++) {
      if ((channel[i]! >= 0) !== (channel[i - 1]! >= 0)) crossings += 1;
    }
    const freq = crossings / 2 / ((19200 - 2400) / 48000);
    let last = -1;
    for (let i = channel.length - 1; i >= 0; i--) {
      if (Math.abs(channel[i]!) > 1e-3) { last = i; break; }
    }
    return {
      input_freq_hz: 440, speed: 2, chipmunk_freq_hz: 880,
      output_freq_hz: Math.round(freq * 10) / 10,
      pitch_ok: Math.abs(freq - 440) < 440 * 0.03,
      output_end_sample: last,
      duration_ok: Math.abs(last - 24000) <= VARISPEED_WINDOW + 256,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runProbe(): Promise<void> {
  const shell = await setupProbe("m3p5");
  try {
    const { ir, session: sessionMeta } = shell;
    const bridge = probeBridge();

    // 画布元素由会话自建（transferControlToOffscreen 每元素仅一次）
    const container = document.createElement("div");
    container.style.cssText = "width:540px;";
    document.body.append(container);

    shell.status("m3p5: creating PreviewSession");
    const tickets = new Map<string, string>();
    for (const input of ir.inputs) {
      const ticket = shell.tickets.get(input.asset_id);
      if (!ticket) throw new Error(`no ticket for ${input.asset_id}`);
      tickets.set(input.asset_id, await bridge.mediaTicket(input.asset_id));
    }
    const session = await PreviewSession.create(container, ir, tickets,
      new Map([...ir.segments].map(segment => [segment.clip_id, { enabled: true, gainDb: 0 }] as [string, SegmentAudioConfig])));
    const composeWallMs: number[] = [];
    let lastContentUs = -1;
    // P33：合成间隔只计**播放段**（play() 起至自然停）——片尾 postmortem 的
    // 暂停态 seek 会拉出 45s 级伪间隔污染 p95/max（smoke1 实测 max=135s）。
    let playingWindow = false;
    session.onTimeUs = (us: number) => {
      lastContentUs = us;
      if (playingWindow) composeWallMs.push(performance.now());
    };
    // 首个推进事件不可见（onTimeUs 首发在 play() 内部首 tick），用 isPlaying
    // 轮询开窗；结束判定见播放 while 循环退出点。
    const playWindow = { open: (v: boolean) => { playingWindow = v; } };

    await session.seekToFrame(0);
    await snapshot(session, bridge, "frame_000_seek0");

    const durationMs = ir.canvas.duration_frames * (1000 / ir.canvas.fps);
    const samples: Sample[] = [];
    const t0 = performance.now();
    session.play();
    playWindow.open(true);
    let nextSampleAt = 0;
    let readbackIndex = 0;
    while (session.isPlaying && performance.now() - t0 < durationMs + 8000) {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      const now = performance.now();
      const elapsedS = (now - t0) / 1000;
      while (readbackIndex < READBACK_AT_S.length && elapsedS >= READBACK_AT_S[readbackIndex]!) {
        await snapshot(session, bridge, `frame_play_${Math.round(READBACK_AT_S[readbackIndex]! * 10)}`);
        readbackIndex += 1;
      }
      if (now - t0 >= nextSampleAt) {
        const sample = sampleOf(now - t0, lastContentUs, session.metrics());
        sample.chain = session.chainState();
        samples.push(sample);
        nextSampleAt += SAMPLE_INTERVAL_MS;
      }
    }
    session.pause();
    playWindow.open(false);
    await snapshot(session, bridge, "frame_999_end");
    // 事后取证：暂停态逐帧重解码+合成片尾区段（区分"解码坏帧"与"播放链路坏帧"）
    const postMortem: Array<Record<string, number>> = [];
    for (let n = Math.max(0, ir.canvas.duration_frames - 26); n < ir.canvas.duration_frames; n += 3) {
      const rendered = await session.seekToFrame(n);
      await snapshot(session, bridge, `postmortem_${String(n).padStart(3, "0")}`);
      postMortem.push({ n, rendered });
    }
    // 新会话对照：同一画布重建 PreviewSession（全新解码器/环形池）后直接 seek
    // 片尾——区分"解码器历史状态依赖"与"该流本身在此解码路径必然花屏"。
    const audioDebugSnapshot = session.audioDebug(); // dispose 清空 audioRigs，先取证
    // P33：分段表必须在 dispose 前**快照**——dispose 清空 rigs（worker 连同
    // timingSamples），事后 finalMetrics 的 decode_seg 恒为 None（timing-r1..r4
    // 实测踩坑）。播放段结束、postmortem 后的分段覆盖到此刻为止。
    const decodeSegSnapshot = session.metrics().decode_seg;
    session.dispose();
    // P33：session1（播放 60s+）+ postmortem（片尾 seek 看门狗挂起 4×45s）后
    // 距会话票签发已 ~250-290s，**贴着票据 TTL 5min**——freshSession 创建跨线
    // 即 init 404（fix-lag-r1..r13 实测；LAG=4 时 wall 略长更易压线，造成
    // 伪相关）。freshSession 前重签票（R8：票据可按需重发，实体注册保持）。
    for (const input of ir.inputs) tickets.set(input.asset_id, await bridge.mediaTicket(input.asset_id));
    const freshSession = await PreviewSession.create(container, ir, tickets);
    await freshSession.seekToFrame(ir.canvas.duration_frames - 1);
    await snapshot(freshSession, bridge, "fresh_session_seek_end");
    // 复播回归：播放头已在片尾时再按播放，应回卷从头继续（"只能播一次"回归门）
    freshSession.play();
    await new Promise<void>(resolve => setTimeout(resolve, 1200));
    const replayOk = freshSession.isPlaying && freshSession.metrics().composed_frames > 10;
    freshSession.pause();
    freshSession.dispose();
    const finalMetrics = session.metrics();

    // 合成节奏：相邻合成帧的墙钟间隔分布（播放流畅度直接证据；只含播放段）
    const intervals: number[] = [];
    for (let index = 1; index < composeWallMs.length; index++) {
      intervals.push(Math.round((composeWallMs[index]! - composeWallMs[index - 1]!) * 1000) / 1000);
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    const pick = (q: number): number => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;

    const result = {
      probe: "m3p5",
      session: "PreviewSession（生产合成预览编排，与 SyntheticPreview 同代码）",
      canvas: ir.canvas,
      inputs: ir.inputs.map(input => ({ input_id: input.input_id, asset_kind: input.asset_kind, geometry: input.geometry })),
      duration_ms: Math.round(durationMs),
      wall_ms: Math.round(performance.now() - t0),
      composed_frames: finalMetrics.composed_frames,
      dropped_frames: finalMetrics.dropped_frames,
      task_ms: { p50: finalMetrics.task_ms_p50, p95: finalMetrics.task_ms_p95 },
      decode_ms: { p50: finalMetrics.decode_ms_p50, p95: finalMetrics.decode_ms_p95 },
      // P33 解码 RTT 分段表（dispose 前快照；URL 参数 decodeTiming=1 出数）
      decode_seg: decodeSegSnapshot ?? finalMetrics.decode_seg,
      compose_interval_ms: { p50: pick(0.5), p95: pick(0.95), max: sorted.length ? sorted[sorted.length - 1]! : 0 },
      last_error: finalMetrics.last_error,
      replay_after_end_ok: replayOk,
      audio: {
        varispeed_offline: await verifyVarispeedWorklet(),
        session: audioDebugSnapshot,
      },
      samples,
      post_mortem: postMortem,
      materials: [...tickets.keys()],
      environment: await collectEnvironment(),
      versions: sessionMeta.versions,
      criteria: "播放态：全片合成帧数 ≈ duration_frames（±2），丢帧 ≈ 0，合成间隔 p95 ≤ 40ms；音频：变速不变调 pitch_ok/duration_ok",
    };
    await (window as unknown as { probeDesktop: { writeArtifact: (name: string, content: unknown) => Promise<string> } }).probeDesktop
      .writeArtifact("m3p5_result.json", JSON.stringify(result, null, 1));
    await shell.finish({
      probe: "m3p5",
      composed: finalMetrics.composed_frames,
      dropped: finalMetrics.dropped_frames,
      compose_interval_p95_ms: result.compose_interval_ms.p95,
    });
  } catch (error) {
    await shell.fail(error);
  }
}
