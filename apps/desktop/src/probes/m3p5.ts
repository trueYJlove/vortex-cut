/** M3-2.2 播放探针：生产 PreviewSession（合成预览同一编排代码）在真实项目 IR 上
 * 播放全片，周期采样丢帧/合成帧/解码 RTT/解码链状态，并在关键时间点回读画布
 * PNG 取证（画中画内容、主轨几何、片尾逐帧对照）。与 m3p4（seek 基准）互补：
 * m3p4 测暂停态寻址，本探针测播放态吞吐——合成预览"卡顿/丢帧"的复现载体。 */
import { parseIr } from "../app/preview/ir.js";
import { PreviewSession, type PreviewSessionMetrics } from "../app/preview/preview-session.js";
import { setupProbe, collectEnvironment } from "./common/shell.js";
import { probeBridge } from "./common/bridge.js";

const SAMPLE_INTERVAL_MS = 250;
const READBACK_AT_S = [0.5, 3.5, 6.0, 9.5, 10.1, 10.4, 10.62];

interface Sample {
  t_ms: number;
  content_us: number;
  composed: number;
  dropped: number;
  task_ms_p50: number;
  task_ms_p95: number;
  decode_ms_p50: number;
  decode_ms_p95: number;
  decode_in_flight: number;
  last_error: string | null;
  chain?: Record<string, unknown>;
}

async function snapshot(canvas: HTMLCanvasElement, name: string): Promise<void> {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error(`toBlob failed for ${name}`);
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  const bridge = probeBridge();
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
    decode_in_flight: metrics.decode_in_flight,
    last_error: metrics.last_error,
  };
}

export async function runProbe(): Promise<void> {
  const shell = await setupProbe("m3p5");
  try {
    const { ir, session: sessionMeta } = shell;
    const bridge = probeBridge();

    const canvas = document.createElement("canvas");
    canvas.width = ir.canvas.width;
    canvas.height = ir.canvas.height;
    canvas.style.cssText = "display:block;width:auto;margin:0 auto;";
    document.body.append(canvas);

    shell.status("m3p5: creating PreviewSession");
    const tickets = new Map<string, string>();
    for (const input of ir.inputs) {
      const ticket = shell.tickets.get(input.asset_id);
      if (!ticket) throw new Error(`no ticket for ${input.asset_id}`);
      tickets.set(input.asset_id, await bridge.mediaTicket(input.asset_id));
    }
    const session = await PreviewSession.create(canvas, ir, tickets);
    const composeWallMs: number[] = [];
    let lastContentUs = -1;
    session.onTimeUs = (us: number) => { composeWallMs.push(performance.now()); lastContentUs = us; };

    await session.seekToFrame(0);
    await snapshot(canvas, "frame_000_seek0");

    const durationMs = ir.canvas.duration_frames * (1000 / ir.canvas.fps);
    const samples: Sample[] = [];
    const t0 = performance.now();
    session.play();
    let nextSampleAt = 0;
    let readbackIndex = 0;
    while (session.isPlaying && performance.now() - t0 < durationMs + 8000) {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      const now = performance.now();
      const elapsedS = (now - t0) / 1000;
      while (readbackIndex < READBACK_AT_S.length && elapsedS >= READBACK_AT_S[readbackIndex]!) {
        await snapshot(canvas, `frame_play_${Math.round(READBACK_AT_S[readbackIndex]! * 10)}`);
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
    await snapshot(canvas, "frame_999_end");
    // 事后取证：暂停态逐帧重解码+合成片尾区段（区分"解码坏帧"与"播放链路坏帧"）
    const postMortem: Array<Record<string, number>> = [];
    for (let n = Math.max(0, ir.canvas.duration_frames - 26); n < ir.canvas.duration_frames; n += 3) {
      const rendered = await session.seekToFrame(n);
      await snapshot(canvas, `postmortem_${String(n).padStart(3, "0")}`);
      postMortem.push({ n, rendered });
    }
    // 新会话对照：同一画布重建 PreviewSession（全新解码器/环形池）后直接 seek
    // 片尾——区分"解码器历史状态依赖"与"该流本身在此解码路径必然花屏"。
    session.dispose();
    const freshSession = await PreviewSession.create(canvas, ir, tickets);
    await freshSession.seekToFrame(ir.canvas.duration_frames - 1);
    await snapshot(canvas, "fresh_session_seek_end");
    // 复播回归：播放头已在片尾时再按播放，应回卷从头继续（"只能播一次"回归门）
    freshSession.play();
    await new Promise<void>(resolve => setTimeout(resolve, 1200));
    const replayOk = freshSession.isPlaying && freshSession.metrics().composed_frames > 10;
    freshSession.pause();
    freshSession.dispose();
    const finalMetrics = session.metrics();

    // 合成节奏：相邻合成帧的墙钟间隔分布（播放流畅度直接证据）
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
      compose_interval_ms: { p50: pick(0.5), p95: pick(0.95), max: sorted.length ? sorted[sorted.length - 1]! : 0 },
      last_error: finalMetrics.last_error,
      replay_after_end_ok: replayOk,
      samples,
      post_mortem: postMortem,
      materials: [...tickets.keys()],
      environment: await collectEnvironment(),
      versions: sessionMeta.versions,
      criteria: "播放态：全片合成帧数 ≈ duration_frames（±2），丢帧 ≈ 0，合成间隔 p95 ≤ 40ms",
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
