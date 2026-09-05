/**
 * M3-0 P3 帧寻址探针（冻结方案 §7.3，YeJing 范围）。
 *
 * 三路对比（同口径 t0/t1 与 PTS 校验 ≤1 帧；同一目标集）：
 *   A. HTML5 video.currentTime + rVFC（现状寻址路径）
 *   B. WebCodecs（VideoDecoder + DedicatedWorker，手写 BMFF demux）
 *   C. WebCodecs + 长帧缓存（LRU VideoFrame 缓存）
 * 100 个目标 = 92 个固定种子均匀采样 + 8 个关键帧边界邻域目标（关键帧表由
 * worker 解析 stss 报告）；另测相邻帧 ±1 步进延迟 30 次。冷/热分开报告。
 * 素材：1080p 与 ≤960p 自产各一组 + 生产 proxy 口径参考（VFR 源转出）。
 */
import { probeBridge } from "./common/bridge.js";
import { setupProbe, createVideo, waitVideoReady, collectEnvironment, videoDecoderSupportEvidence } from "./common/shell.js";
import { mulberry32, summarize, P3_SEED } from "./common/stats.js";

interface Target { frame: number; kind: "uniform" | "keyframe_boundary" }

interface PathResult {
  path: string;
  material: string;
  samples: Array<Record<string, number>>;
  latency_ms_all: ReturnType<typeof summarize>;
  latency_ms_cold: ReturnType<typeof summarize>;
  latency_ms_hot: ReturnType<typeof summarize>;
  latency_ms_step: ReturnType<typeof summarize>;
  pts_dev_over_1frame: number;
  failures: number;
  black_frames: number;
  worker_stats?: { hits: number; misses: number; evictions: number; size: number; bytes: number };
  hardware?: string | null;
}

const MATERIALS = [
  { entity: "m3mat_a_540", label: "540p (960x540 自产)" },
  { entity: "m3mat_a_1080", label: "1080p (1920x1080 自产)" },
  { entity: "m3proxy_ref_vfr", label: "proxy ≤960p (VFR 源转出)" },
];
const FPS = 30;
const TARGETS = 100;
const STEPS = 30;

function buildTargets(keyframes: number[], durationFrames: number): Target[] {
  const rng = mulberry32(P3_SEED);
  const targets: Target[] = [];
  for (let index = 0; index < TARGETS - 8; index++) {
    targets.push({ frame: Math.min(durationFrames - 1, Math.floor(rng() * durationFrames)), kind: "uniform" });
  }
  const nonZero = keyframes.filter(frame => frame > 0).slice(0, 2);
  for (const keyframe of nonZero) {
    for (const delta of [-1, 0, 1, 2]) {
      const frame = keyframe + delta;
      if (frame >= 1 && frame < durationFrames) targets.push({ frame, kind: "keyframe_boundary" });
    }
  }
  while (targets.length < TARGETS) targets.push({ frame: Math.floor(rng() * durationFrames), kind: "uniform" });
  return targets.slice(0, TARGETS);
}

type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
};

/** 路径 A：currentTime seek → rVFC 呈现（现状寻址路径，video 元素可见）。 */
async function runHtml5Path(video: HTMLVideoElement, targets: Target[]): Promise<PathResult> {
  const samples: Array<Record<string, number>> = [];
  const stepLatencies: number[] = [];
  let failures = 0;
  let ptsOver = 0;

  const seekOnce = (targetFrame: number): Promise<number> =>
    new Promise(resolve => {
      const targetS = targetFrame / FPS;
      const t0 = performance.now();
      let settled = false;
      const finish = (mediaTime: number) => {
        if (settled) return;
        settled = true;
        const dev = Math.abs(mediaTime - targetS) * FPS;
        if (dev > 1.02) ptsOver += 1;
        resolve(performance.now() - t0);
      };
      const onPresent = (_now: number, meta: { mediaTime: number }) => {
        if (settled) return;
        if (Math.abs(meta.mediaTime - targetS) <= 1.02 / FPS) finish(meta.mediaTime);
        else (video as RvfcVideo).requestVideoFrameCallback(onPresent);
      };
      if ("requestVideoFrameCallback" in video) (video as RvfcVideo).requestVideoFrameCallback(onPresent);
      window.setTimeout(() => {
        if (!settled) { settled = true; failures += 1; resolve(-1); }
      }, 5000);
      video.currentTime = targetS;
    });

  for (const target of targets) {
    const latency = await seekOnce(target.frame);
    samples.push({ index: samples.length, target_frame: target.frame, kind: target.kind === "uniform" ? 0 : 1, latency_ms: Math.round(latency * 1000) / 1000 });
  }
  let current = targets[Math.floor(targets.length / 2)]!.frame;
  for (let step = 0; step < STEPS; step++) {
    current = Math.max(0, current + (step % 2 === 0 ? 1 : -1));
    stepLatencies.push(await seekOnce(current));
  }
  const latencies = samples.map(sample => sample.latency_ms).filter(value => value >= 0);
  return {
    path: "html5_currentTime_rVFC", material: "", samples,
    latency_ms_all: summarize(latencies),
    latency_ms_cold: summarize(latencies.slice(0, 10)),
    latency_ms_hot: summarize(latencies.slice(10)),
    latency_ms_step: summarize(stepLatencies.filter(value => value >= 0)),
    pts_dev_over_1frame: ptsOver, failures, black_frames: 0,
  };
}

interface WorkerMessage {
  type: "ready" | "frame" | "done" | "error";
  sampleCount?: number; durationUs?: number; timescale?: number; keyframes?: number[];
  width?: number; height?: number; hardware?: string | null; cacheEnabled?: boolean; cacheCap?: number;
  id?: number; frameN?: number; timestampUs?: number; fromCache?: boolean; samplesFed?: number;
  fromKeyframe?: number; allocationSize?: number; frame?: VideoFrame;
  message?: string; note?: string;
}

/** 路径 B/C：WebCodecs worker 解码，主线程 rAF 内 drawImage 提交呈现。 */
async function runWebCodecsPath(
  ticket: string, cacheFrames: number, presentCanvas: HTMLCanvasElement, targets: Target[],
): Promise<{ result: PathResult; keyframes: number[]; durationFrames: number; hardware: string | null; codedWidth: number; codedHeight: number }> {
  const worker = new Worker(new URL("../app/preview/decode-worker.worker.ts", import.meta.url), { type: "module" });
  const ctx = presentCanvas.getContext("2d", { willReadFrequently: true })!;
  const samples: Array<Record<string, number>> = [];
  const stepLatencies: number[] = [];
  let failures = 0;
  let blackFrames = 0;
  let ptsOver = 0;
  let keyframes: number[] = [];
  let durationFrames = 0;
  let hardware: string | null = null;
  let codedWidth = 0;
  let codedHeight = 0;

  const ready = await new Promise<WorkerMessage>(resolve => {
    worker.addEventListener("message", function onReady(event: MessageEvent<WorkerMessage>) {
      if (event.data.type === "ready") { worker.removeEventListener("message", onReady); resolve(event.data); }
    });
    worker.postMessage({ type: "init", url: ticket, cacheFrames });
  });
  keyframes = ready.keyframes ?? [];
  durationFrames = Math.floor(((ready.durationUs ?? 0) / 1e6) * FPS);
  hardware = ready.hardware ?? null;
  codedWidth = ready.width ?? 0;
  codedHeight = ready.height ?? 0;

  let nextId = 0;
  const decodeOnce = (frameN: number): Promise<{ latencyMs: number; meta: WorkerMessage | null }> =>
    new Promise(resolve => {
      const id = nextId++;
      const t0 = performance.now();
      const timeout = window.setTimeout(() => {
        worker.removeEventListener("message", onMessage);
        failures += 1;
        resolve({ latencyMs: -1, meta: null });
      }, 8000);
      const onMessage = (event: MessageEvent<WorkerMessage>) => {
        const data = event.data;
        if (data.type === "error" && data.id === id) {
          window.clearTimeout(timeout);
          worker.removeEventListener("message", onMessage);
          failures += 1;
          resolve({ latencyMs: -1, meta: data });
        } else if (data.type === "frame" && data.id === id) {
          window.clearTimeout(timeout);
          worker.removeEventListener("message", onMessage);
          const frame = data.frame!;
          requestAnimationFrame(() => {
            if (presentCanvas.width !== codedWidth) { presentCanvas.width = codedWidth; presentCanvas.height = codedHeight; }
            ctx.drawImage(frame, 0, 0);
            const t1 = performance.now();
            const center = ctx.getImageData(codedWidth >> 1, codedHeight >> 1, 1, 1).data;
            if (center[0] === 0 && center[1] === 0 && center[2] === 0) blackFrames += 1;
            frame.close();
            resolve({ latencyMs: t1 - t0, meta: data });
          });
        }
      };
      worker.addEventListener("message", onMessage);
      worker.postMessage({ type: "decode", id, frameN, fps: FPS });
    });

  for (const target of targets) {
    const outcome = await decodeOnce(target.frame);
    if (outcome.latencyMs < 0 || !outcome.meta) {
      samples.push({ index: samples.length, target_frame: target.frame, kind: target.kind === "uniform" ? 0 : 1, latency_ms: -1, media_time_dev_frames: -1 });
      continue;
    }
    const dev = Math.abs((outcome.meta.timestampUs ?? 0) / 1e6 - target.frame / FPS) * FPS;
    if (dev > 1.02) ptsOver += 1;
    samples.push({
      index: samples.length, target_frame: target.frame, kind: target.kind === "uniform" ? 0 : 1,
      latency_ms: Math.round(outcome.latencyMs * 1000) / 1000,
      media_time_dev_frames: Math.round(dev * 1e6) / 1e6,
      from_cache: outcome.meta.fromCache ? 1 : 0,
      samples_fed: outcome.meta.samplesFed ?? 0,
      from_keyframe: outcome.meta.fromKeyframe ?? -1,
    });
  }
  if (targets.length > 0) {
    let current = targets[Math.floor(targets.length / 2)]!.frame;
    for (let step = 0; step < STEPS; step++) {
      current = Math.max(0, Math.min(durationFrames - 1, current + (step % 2 === 0 ? 1 : -1)));
      const outcome = await decodeOnce(current);
      stepLatencies.push(outcome.latencyMs);
    }
  }
  const stats = await new Promise<WorkerMessage>(resolve => {
    worker.addEventListener("message", function onStats(event: MessageEvent<WorkerMessage>) {
      if (event.data.type === "done" && event.data.note) { worker.removeEventListener("message", onStats); resolve(event.data); }
    });
    worker.postMessage({ type: "stats" });
  });
  let workerStats: PathResult["worker_stats"];
  try { workerStats = JSON.parse(stats.note ?? "{}"); } catch { workerStats = undefined; }
  worker.terminate();
  const latencies = samples.map(sample => sample.latency_ms).filter(value => value >= 0);
  return {
    result: {
      path: cacheFrames > 0 ? "webcodecs_worker_cache" : "webcodecs_worker",
      material: "", samples,
      latency_ms_all: summarize(latencies),
      latency_ms_cold: summarize(latencies.slice(0, 10)),
      latency_ms_hot: summarize(latencies.slice(10)),
      latency_ms_step: summarize(stepLatencies.filter(value => value >= 0)),
      pts_dev_over_1frame: ptsOver, failures, black_frames: blackFrames,
      worker_stats: workerStats, hardware,
    },
    keyframes, durationFrames, hardware, codedWidth, codedHeight,
  };
}

export async function runProbe(): Promise<void> {
  const shell = await setupProbe("m3p3");
  try {
    const bridge = probeBridge();
    const presentCanvas = document.createElement("canvas");
    presentCanvas.style.cssText = "position:fixed;left:8px;top:32px;width:480px;";
    document.body.append(presentCanvas);
    const results: PathResult[] = [];
    let decoderEvidence: Record<string, unknown> = {};

    for (const material of MATERIALS) {
      const ticket = shell.tickets.get(material.entity);
      if (!ticket) throw new Error(`no ticket for ${material.entity}`);

      // 先跑 worker(cache=0) 拿关键帧表与时长 → 三路共用同一目标集
      shell.status(`P3: ${material.entity} — webcodecs (target discovery + measured)`);
      const probeB = await runWebCodecsPath(ticket, 0, presentCanvas, []);
      const targets = buildTargets(probeB.keyframes, probeB.durationFrames || 900);
      // probeB 已用空 targets 空跑；用正确目标集重测一次（worker 预热状态记录在案）
      const probeB2 = await runWebCodecsPath(ticket, 0, presentCanvas, targets);
      probeB2.result.material = material.label;
      results.push(probeB2.result);
      if (material.entity === MATERIALS[0]!.entity) {
        decoderEvidence = await videoDecoderSupportEvidence(`avc1.640028`, probeB.codedWidth, probeB.codedHeight);
      }

      shell.status(`P3: ${material.entity} — webcodecs+cache`);
      const probeC = await runWebCodecsPath(ticket, 24, presentCanvas, targets);
      probeC.result.material = material.label;
      results.push(probeC.result);

      shell.status(`P3: ${material.entity} — html5`);
      const video = createVideo(ticket, { visible: true });
      video.style.cssText = "position:fixed;left:8px;top:32px;width:480px;";
      await waitVideoReady(video);
      const probeA = await runHtml5Path(video, targets);
      probeA.material = material.label;
      results.push(probeA);
      video.remove();

      // 空跑的 discovery 结果保留（冷启动证据）
      probeB.result.material = `${material.label} (discovery pass, cold)`;
      results.push(probeB.result);
    }

    const environment = await collectEnvironment();
    const output = {
      probe: "m3p3",
      seed: P3_SEED,
      targets_per_material: TARGETS,
      target_composition: "92 uniform (mulberry32 seeded) + keyframe-adjacent (stss-reported)",
      stepping_steps: STEPS,
      materials: MATERIALS,
      results,
      video_decoder_evidence: decoderEvidence,
      environment,
      versions: shell.session.versions,
      criteria: "WebCodecs 或 WebCodecs+缓存：100 次随机跳转出图延迟 p95 ≤ 100ms，且每次跳转首次呈现帧 PTS 偏差 ≤ 1 帧（100/100），解码失败/黑帧计数 0",
      present_note: "WebCodecs 路径 t1 = rAF 内 drawImage 提交完成；HTML5 路径 t1 = rVFC 呈现回调（口径差异记录在案）",
    };
    await bridge.writeArtifact("m3p3_result.json", JSON.stringify(output, null, 1));
    await shell.finish({
      probe: "m3p3",
      paths: results.map(result => `${result.path}@${result.material}: p95=${result.latency_ms_all.p95}ms fail=${result.failures}`),
    });
  } catch (error) {
    await shell.fail(error);
  }
}
