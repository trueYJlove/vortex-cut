/** M3-2 scrub 基准探针：用生产 PreviewSession（合成预览同一编排代码）在
 * M3-0 固定时间线上测 100 次种子化随机 seek 的延迟，闭合 P1 遗留的 scrub 判据
 * （多路顺序寻址 565–592ms → 并行编排后目标 p95 ≤ 100ms）。另测拖拽快速档
 * 行为与 ±1 步进。 */
import { parseIr } from "../app/preview/ir.js";
import { PreviewSession } from "../app/preview/preview-session.js";
import { mulberry32, summarize } from "./common/stats.js";
import { setupProbe, collectEnvironment } from "./common/shell.js";
import { probeBridge } from "./common/bridge.js";

const SEED = 20260906;
const TARGETS = 100;
const DRAG_SEEKS = 30;

interface Sample { index: number; target_frame: number; latency_ms: number; drag: number; rendered: number }

export async function runProbe(): Promise<void> {
  const shell = await setupProbe("m3p4");
  try {
    const { ir, session: sessionMeta } = shell;
    const bridge = probeBridge();

    // 画布元素由会话自建（transferControlToOffscreen 每元素仅一次）
    const container = document.createElement("div");
    container.style.cssText = "width:540px;";
    document.body.append(container);

    shell.status("m3p4: creating PreviewSession");
    const tickets = new Map<string, string>();
    for (const input of ir.inputs) {
      const ticket = shell.tickets.get(input.asset_id);
      if (!ticket) throw new Error(`no ticket for ${input.asset_id}`);
      tickets.set(input.asset_id, await bridge.mediaTicket(input.asset_id));
    }
    const session = await PreviewSession.create(container, ir, tickets);
    await session.seekToFrame(0);

    // 种子化目标集（mulberry32，与 P3 同实现）
    const rng = mulberry32(SEED);
    const targets: number[] = [];
    for (let index = 0; index < TARGETS; index++) {
      targets.push(Math.min(ir.canvas.duration_frames - 1, Math.floor(rng() * ir.canvas.duration_frames)));
    }

    // 100 次随机 seek（暂停态，生产 seekToFrame：并行解码 + latest-wins）
    const samples: Sample[] = [];
    for (let index = 0; index < targets.length; index++) {
      shell.status(`m3p4: seek ${index + 1}/${TARGETS}`);
      const t0 = performance.now();
      const rendered = await session.seekToFrame(targets[index]!);
      const t1 = performance.now();
      samples.push({ index, target_frame: targets[index]!, latency_ms: Math.round((t1 - t0) * 1000) / 1000, drag: 0, rendered });
      await new Promise<void>(resolve => setTimeout(resolve, 60)); // 模拟拖拽停顿
    }

    // 拖拽模拟：快速连续 seek（无停顿），验证 latest-wins 合并
    const dragSamples: Array<Record<string, number>> = [];
    let dragDropped = 0;
    let dragStart = Math.floor(ir.canvas.duration_frames / 2);
    for (let step = 0; step < DRAG_SEEKS; step++) {
      dragStart = Math.max(0, Math.min(ir.canvas.duration_frames - 1, dragStart + (step % 2 === 0 ? 7 : -5)));
      const t0 = performance.now();
      const rendered = await session.seekToFrame(dragStart);
      const t1 = performance.now();
      if (rendered === -1) dragDropped += 1;
      dragSamples.push({ index: step, target_frame: dragStart, latency_ms: Math.round((t1 - t0) * 1000) / 1000, rendered: rendered === -1 ? 0 : 1 });
    }

    // ±1 步进（30 次）
    const stepSamples: number[] = [];
    let current = targets[Math.floor(targets.length / 2)]!;
    for (let step = 0; step < 30; step++) {
      current = Math.max(0, Math.min(ir.canvas.duration_frames - 1, current + (step % 2 === 0 ? 1 : -1)));
      const t0 = performance.now();
      await session.seekToFrame(current);
      stepSamples.push(performance.now() - t0);
    }

    const latencies = samples.map(sample => sample.latency_ms);
    const dragLatencies = dragSamples.map(sample => sample.latency_ms);
    const result = {
      probe: "m3p4",
      session: "PreviewSession（生产合成预览编排，与 SyntheticPreview 同代码）",
      seed: SEED,
      targets: TARGETS,
      seek_ms: summarize(latencies),
      seek_samples: samples,
      drag_coalesce: { seeks: DRAG_SEEKS, superseded: dragDropped, latency_ms: summarize(dragLatencies) },
      step_ms: summarize(stepSamples.filter(value => value >= 0)),
      session_metrics: session.metrics(),
      skipped_uploads: session.skippedUploads,
      upload_split: (() => {
        const split = session.uploadSplitDebug;
        const pick = (key: "copyToMs" | "texMs") => {
          const values = split.map(item => item[key]).sort((a, b) => a - b);
          return { p50: values.length ? values[Math.floor(values.length * 0.5)] : 0, p95: values.length ? values[Math.floor(values.length * 0.95)] : 0 };
        };
        return { copyTo: pick("copyToMs"), tex: pick("texMs"), samples: split.length };
      })(),
      materials: [...tickets.keys()],
      environment: await collectEnvironment(),
      versions: sessionMeta.versions,
      criteria: "生产编排 seekToFrame：100 次随机跳转 p95 ≤ 100ms（P1 遗留 scrub 判据闭合）",
    };
    await (window as unknown as { probeDesktop: { writeArtifact: (name: string, content: unknown) => Promise<string> } }).probeDesktop
      .writeArtifact("m3p4_result.json", JSON.stringify(result, null, 1));
    await shell.finish({
      probe: "m3p4",
      seek_p95_ms: result.seek_ms.p95,
      drag_superseded: dragDropped,
    });
  } catch (error) {
    await shell.fail(error);
  }
}
