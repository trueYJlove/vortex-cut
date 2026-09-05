/**
 * M3-0 P1 合成性能探针（冻结方案 §7.1，YeJing 范围）。
 *
 * WebGL2 主路径：V1 主轨 + 2 条覆盖轨（PiP 语义）+ 1 条字幕层，消费 Core IR
 * 逐帧数值表，rAF 驱动 30fps 内容帧节奏；连续播放 3 轮（每轮 1800 帧）+ 固定
 * 种子随机 scrub 100 次。WebGPU 对照路径仅记录数据，不计入通过判定。
 * 判据适用对象：WebGL2 主路径。
 */
import { probeBridge } from "./common/bridge.js";
import { setupProbe, createVideo, waitVideoReady, collectEnvironment, videoDecoderSupportEvidence } from "./common/shell.js";
import { Compositor, assertHardwareRenderer } from "./common/compositor.js";
import { activeInputIds, sourceFrameAt, type Ir } from "./common/ir.js";
import { mulberry32, summarize, P1_SCRUB_SEED } from "./common/stats.js";

const FRAME_BUDGET_MS = 1000 / 30;
const ROUND_FRAMES = 1800;
const ROUNDS = 3;

interface InputWindow { inputId: string; startFrame: number; endFrame: number; startSrcFrame: number; rate: number }

function computeInputWindows(ir: Ir): InputWindow[] {
  const windows: InputWindow[] = [];
  const rateByInput = new Map<string, number>();
  for (const segment of ir.segments) {
    if (!rateByInput.has(segment.input_id)) rateByInput.set(segment.input_id, segment.speed_milli / 1000);
  }
  for (const input of ir.inputs) {
    let start = -1;
    let startSrc = 0;
    let end = -1;
    for (const frame of ir.frames) {
      const src = sourceFrameAt(frame, input.input_id);
      if (src !== null) {
        if (start < 0) { start = frame.n; startSrc = src; }
        end = frame.n;
      } else if (start >= 0) {
        break; // 单窗口假设（固定测试时间线成立）
      }
    }
    if (start >= 0) {
      windows.push({ inputId: input.input_id, startFrame: start, endFrame: end, startSrcFrame: startSrc, rate: rateByInput.get(input.input_id) ?? 1 });
    }
  }
  return windows;
}

/** WebGPU 对照路径：单输入简化场景（无 mipmap/多轨），仅记录数据。 */
async function runWebGpuComparison(video: HTMLVideoElement, durationFrames: number): Promise<Record<string, unknown>> {
  const gpu = (navigator as Navigator).gpu;
  if (!gpu) return { available: false, reason: "navigator.gpu undefined" };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { available: false, reason: "no adapter" };
    const info: Record<string, unknown> = {};
    if (adapter.info) {
      info.adapter = {
        vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description,
      };
    }
    const device = await adapter.requestDevice();
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    const context = canvas.getContext("webgpu");
    const format = gpu.getPreferredCanvasFormat();
    if (!context) return { available: false, reason: "webgpu context unavailable", ...info };
    context.configure({ device, format, alphaMode: "opaque" });
    const module = device.createShaderModule({
      code: `
struct VsOut { @builtin(position) pos: vec4f, @location(0) box: vec2f };
@vertex fn vs(@location(0) p: vec2f) -> VsOut {
  var out: VsOut;
  out.pos = vec4f(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  out.box = p;
  return out;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  return textureSample(tex, samp, vec2f(in.box.x, 1.0 - in.box.y));
}`,
    });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module, entryPoint: "vs",
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" as GPUVertexFormat }] }],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-strip" },
    });
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const texture = device.createTexture({
      size: [960, 540], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: texture.createView() }],
    });
    const vertexBuffer = device.createBuffer({ size: 8 * 4, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
    new Float32Array(vertexBuffer.getMappedRange()).set([0, 0, 1, 0, 0, 1, 1, 1]);
    vertexBuffer.unmap();
    const taskMs: number[] = [];
    video.pause();
    await video.play().catch(() => undefined);
    for (let n = 0; n < Math.min(durationFrames, 900); n++) {
      const start = performance.now();
      device.queue.copyExternalImageToTexture({ source: video }, { texture }, [960, 540]);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, vertexBuffer);
      pass.setBindGroup(0, bindGroup);
      pass.draw(4);
      pass.end();
      device.queue.submit([encoder.finish()]);
      taskMs.push(performance.now() - start);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    video.pause();
    return {
      available: true,
      note: "对照路径为单输入简化场景（无 mipmap/多轨/字幕），仅记录数据，不计入通过判定",
      task_ms: summarize(taskMs),
      ...info,
    };
  } catch (error) {
    return { available: false, reason: String(error) };
  }
}

export async function runProbe(): Promise<void> {
  const shell = await setupProbe("m3p1");
  try {
    const { ir } = shell;
    const bridge = probeBridge();
    const compositor = new Compositor(shell.canvas, ir);
    shell.status("P1: loading videos");
    const videosByInput = new Map<string, HTMLVideoElement>();
    for (const input of ir.inputs) {
      const ticket = shell.tickets.get(input.asset_id);
      if (!ticket) throw new Error(`no ticket for ${input.asset_id}`);
      const video = createVideo(ticket);
      await waitVideoReady(video);
      compositor.registerVideo(input.input_id, video);
      videosByInput.set(input.input_id, video);
    }
    const windows = computeInputWindows(ir);
    const adapterInfo = compositor.gpuRendererInfo();
    const hardwareCheck = assertHardwareRenderer(adapterInfo.adapter);
    if (hardwareCheck.software) throw new Error(`software rendering detected (R7): ${adapterInfo.adapter}`);
    shell.status(`P1: adapter=${adapterInfo.adapter}`);

    const firstInput = ir.inputs[0]!;
    const decoderEvidence = await videoDecoderSupportEvidence("avc1.640028", firstInput.geometry.width, firstInput.geometry.height);

    const scrubRng = mulberry32(P1_SCRUB_SEED);
    const roundResults: Array<Record<string, unknown>> = [];
    const gpuMemorySamples: Array<{ t_s: number; gpu_process_ws_mb: number }> = [];

    for (let round = 1; round <= ROUNDS; round++) {
      for (const window of windows) {
        const handle = compositor.videos.get(window.inputId)!;
        if (!handle.video) continue;
        handle.video.pause();
        await compositor.seekVideo(handle, window.startSrcFrame);
      }
      const taskMs: number[] = [];
      const intervalMs: number[] = [];
      const contentIntervalMs: number[] = [];
      const rows: Array<Record<string, number>> = [];
      let lastProcessed = -1;
      let lastTaskStart = -1;
      let lastContentStart = -1;
      let skippedFrames = 0;
      let driftEvents = 0;
      let contextLostEvents = 0;
      compositor.contextLostResolvers.push(() => { contextLostEvents += 1; });
      // vsync 锁定合成器语义（测量语义修正，见报告 §1.2 注）：每个 rAF 提交一个
      // 合成任务（内容帧到期即换帧，未到期重绘最新帧），"相邻合成任务起始间隔"
      // 因此度量渲染循环节拍本身；内容帧间隔序列另存以与 75Hz 旧口径可比。
      await new Promise<void>(resolve => {
        const state = { startTime: 0 };
        const tick = () => {
          if (state.startTime === 0) state.startTime = performance.now();
          const now = performance.now();
          const target = Math.min(ROUND_FRAMES - 1, Math.floor(((now - state.startTime) * ir.canvas.fps) / 1000));
          if (target >= ROUND_FRAMES - 1 && lastProcessed >= ROUND_FRAMES - 1) { resolve(); return; }
          const isNewContentFrame = target > lastProcessed;
          for (const window of windows) {
            const handle = compositor.videos.get(window.inputId)!;
            if (!handle.video) continue;
            if (lastProcessed < window.startFrame && target >= window.startFrame) {
              handle.video.playbackRate = window.rate;
              void handle.video.play().catch(() => undefined);
            } else if (lastProcessed <= window.endFrame && target > window.endFrame) {
              handle.video.pause();
            }
          }
          const frame = ir.frames[target]!;
          for (const inputId of activeInputIds(frame)) {
            const handle = compositor.videos.get(inputId);
            if (!handle) continue;
            compositor.uploadVideo(handle, false);
            const expected = sourceFrameAt(frame, inputId);
            if (isNewContentFrame && expected !== null && Math.abs(handle.presentedMediaTimeS * ir.canvas.fps - expected) > 1.02) driftEvents += 1;
          }
          const taskStart = performance.now();
          compositor.composeFrame(frame, { drawCaptions: true });
          const taskEnd = performance.now();
          if (lastTaskStart >= 0) intervalMs.push(taskStart - lastTaskStart);
          if (isNewContentFrame && lastContentStart >= 0) contentIntervalMs.push(taskStart - lastContentStart);
          taskMs.push(taskEnd - taskStart);
          if (isNewContentFrame) {
            skippedFrames += Math.max(0, target - lastProcessed - 1);
            rows.push({ f: target, task_ms: Math.round((taskEnd - taskStart) * 1000) / 1000 });
          }
          lastProcessed = target;
          lastTaskStart = taskStart;
          if (isNewContentFrame) lastContentStart = taskStart;
          // 注意：GPU 指标采样不得在渲染循环内进行 —— getGPUInfo('complete')
          // 实测会造成 ~1s 级停顿污染节拍测量（60Hz 首轮实证），已移至轮次边界。
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      try {
        const gpu = await bridge.gpu();
        const gpuProcess = gpu.metrics.find(entry => entry.type === "GPU Process");
        gpuMemorySamples.push({ t_s: Math.round(round * 60), gpu_process_ws_mb: gpuProcess?.memory?.workingSetSize ?? -1 });
      } catch { /* ignore */ }

      const dropped = taskMs.filter(value => value > FRAME_BUDGET_MS).length + skippedFrames;
      roundResults.push({
        round,
        frames_attempted: ROUND_FRAMES,
        tasks: taskMs.length,
        dropped_count: dropped,
        drop_rate: Math.round((dropped / ROUND_FRAMES) * 100000) / 100000,
        task_ms: summarize(taskMs),
        task_interval_ms: summarize(intervalMs),
        content_interval_ms: summarize(contentIntervalMs),
        skipped_frames: skippedFrames,
        drift_events: driftEvents,
        context_lost_events: contextLostEvents,
        raw_task_ms: taskMs.map(value => Math.round(value * 1000) / 1000),
        raw_interval_ms: intervalMs.map(value => Math.round(value * 1000) / 1000),
      });
      shell.status(`P1: round ${round}/${ROUNDS} done drop_rate=${String(roundResults.at(-1)?.drop_rate)}`);
      await new Promise(resolve => setTimeout(resolve, 400));
    }

    shell.status("P1: scrub test");
    const durationFrames = ir.canvas.duration_frames;
    const scrubSamples: Array<Record<string, number>> = [];
    for (let index = 0; index < 100; index++) {
      const target = Math.min(durationFrames - 1, Math.floor(scrubRng() * durationFrames));
      const frame = ir.frames[target]!;
      const t0 = performance.now();
      let maxDev = 0;
      for (const inputId of activeInputIds(frame)) {
        const handle = compositor.videos.get(inputId);
        const expected = sourceFrameAt(frame, inputId);
        if (!handle || !handle.video || expected === null) continue;
        handle.video.pause();
        const presented = await compositor.seekVideo(handle, expected);
        maxDev = Math.max(maxDev, presented.devFrames);
      }
      compositor.composeFrame(frame, { drawCaptions: true });
      const t1 = performance.now();
      scrubSamples.push({ index, target_frame: target, latency_ms: Math.round((t1 - t0) * 1000) / 1000, media_time_dev_frames: Math.round(maxDev * 1000) / 1000 });
    }
    const scrubLatencies = scrubSamples.map(sample => sample.latency_ms);
    const devFramesAll = scrubSamples.map(sample => sample.media_time_dev_frames);
    const scrubSummary = {
      seed: P1_SCRUB_SEED,
      samples: scrubSamples,
      latency_ms_all: summarize(scrubLatencies),
      latency_ms_cold_first10: summarize(scrubLatencies.slice(0, 10)),
      latency_ms_hot_rest90: summarize(scrubLatencies.slice(10)),
      media_time_dev_frames_max: Math.max(...devFramesAll),
      media_time_dev_frames_over_1: devFramesAll.filter(value => value > 1.02).length,
    };

    shell.status("P1: WebGPU comparison path");
    const webgpu = await runWebGpuComparison(videosByInput.get(ir.inputs[0]!.input_id)!, durationFrames);

    const environment = await collectEnvironment();
    const result = {
      probe: "m3p1",
      path: "WebGL2 (main, gating) + WebGPU (comparison, data only)",
      no_mipmap_mode: new URLSearchParams(location.search).get("mipmap") === "0",
      canvas: ir.canvas,
      adapter: adapterInfo,
      hardware_check: hardwareCheck,
      video_decoder_evidence: decoderEvidence,
      rounds: roundResults,
      scrub: scrubSummary,
      gpu_memory_samples: gpuMemorySamples,
      environment,
      versions: shell.session.versions,
      criteria: {
        drop_rate: "每轮 掉帧数/1800 < 1%（33.3ms 预算，跳帧计入）",
        frame_time_p95: "相邻合成任务起始差值 p95 ≤ 33ms",
        scrub: "出图延迟 p95 ≤ 100ms（rVFC mediaTime 偏差 ≤ 1 帧）",
        rounds: "3 轮取中位与最差",
      },
    };
    await bridge.writeArtifact("m3p1_result.json", JSON.stringify(result, null, 1));
    await shell.finish({
      probe: "m3p1",
      drop_rates: roundResults.map(entry => entry.drop_rate),
      scrub_p95_ms: scrubSummary.latency_ms_all.p95,
      adapter: adapterInfo.adapter,
    });
  } catch (error) {
    await shell.fail(error);
  }
}
