/**
 * M3-0 P2 逐帧一致性探针 · 合成端（冻结方案 §7.2）。
 *
 * 消费 Core 中立 IR（逐帧数值表 + 已解析转场窗口/offset + 已解析字幕样式），
 * 逐采样帧按 IR 指定的源帧号解码 → 上传纹理 → 合成 → RGBA8 回读 PNG 写入
 * 证据目录。字幕帧另出无字幕帧（文本 IoU 单独口径）。
 * 全程不做插值/借位计算 —— "Core 生成 IR、Renderer 只消费"（R4）。
 *
 * 帧源：WebCodecs VideoDecoder（worker，手写 BMFF demux），帧号精确寻址。
 * 实测记录：先以 <video>.currentTime 步进实现，呈现语义不透明（暂停视频
 * rVFC 不触发、texImage2D 取到陈旧帧，见验证报告"实现偏差记录"），故
 * P2 帧源改用 WebCodecs（帧号精确、colorSpace 钉死 bt709）；P1 仍用
 * <video>（实时播放语义正是其考察对象）。
 */
import { probeBridge } from "./common/bridge.js";
import { setupProbe, collectEnvironment } from "./common/shell.js";
import { Compositor, assertHardwareRenderer } from "./common/compositor.js";
import type { IrFrame } from "./common/ir.js";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

interface WorkerMessage {
  type: "ready" | "frame" | "done" | "error";
  id?: number;
  frame?: VideoFrame;
  timestampUs?: number;
  fromCache?: boolean;
  samplesFed?: number;
  fromKeyframe?: number;
  hardware?: string | null;
  width?: number;
  height?: number;
  message?: string;
  note?: string;
}

/** 单输入解码 worker：decode(frameN) → VideoFrame（compositor 上传后 close）。 */
class DecodeWorker {
  private readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (frame: VideoFrame) => void; reject: (error: Error) => void }>();
  hardware: string | null = null;
  width = 0;
  height = 0;

  private constructor() {
    this.worker = new Worker(new URL("./p3-worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      const data = event.data;
      if (data.type === "frame" && data.id !== undefined) {
        const pending = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.frame) pending?.resolve(data.frame);
        else pending?.reject(new Error("worker returned no frame"));
      } else if (data.type === "error" && data.id !== undefined) {
        const pending = this.pending.get(data.id);
        this.pending.delete(data.id);
        pending?.reject(new Error(data.message ?? "worker error"));
      }
    });
  }

  static async create(ticket: string): Promise<DecodeWorker> {
    const instance = new DecodeWorker();
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("worker init timeout")), 15000);
      instance.worker.addEventListener("message", function onReady(event: MessageEvent<WorkerMessage>) {
        if (event.data.type === "ready") {
          window.clearTimeout(timeout);
          instance.worker.removeEventListener("message", onReady);
          instance.hardware = event.data.hardware ?? null;
          instance.width = event.data.width ?? 0;
          instance.height = event.data.height ?? 0;
          resolve();
        } else if (event.data.type === "error") {
          window.clearTimeout(timeout);
          reject(new Error(event.data.message ?? "worker init error"));
        }
      });
      instance.worker.postMessage({ type: "init", url: ticket, cacheFrames: 0 });
    });
    return instance;
  }

  decode(frameN: number, fps: number): Promise<VideoFrame> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`decode timeout for frame ${frameN}`));
      }, 15000);
      this.pending.set(id, {
        resolve: frame => { window.clearTimeout(timeout); resolve(frame); },
        reject: error => { window.clearTimeout(timeout); reject(error); },
      });
      this.worker.postMessage({ type: "decode", id, frameN, fps });
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}

export async function runProbe(): Promise<void> {
  const shell = await setupProbe("m3p2");
  try {
    const { ir, session } = shell;
    const bridge = probeBridge();
    const compositor = new Compositor(shell.canvas, ir);
    const sampleFrames = session.sample?.sample_frames;
    // 字幕采样集由 IR 逐帧推导（任何字幕激活的采样帧都出无字幕对照帧）
    const captionFrames = new Set(
      (session.sample?.sample_frames ?? []).filter(n => (ir.frames[n]?.captions.length ?? 0) > 0));
    if (!sampleFrames?.length) throw new Error("missing sample frame list (AIVS_M3_PROBE_SAMPLE)");

    // 字幕字体经 aivideo:// 票据加载（与权威端 libass 同一字体文件）
    const fontTicket = shell.tickets.get("m3font");
    if (fontTicket) {
      const fontBuffer = await (await fetch(fontTicket)).arrayBuffer();
      await compositor.ensureCaptionFont(fontBuffer, "Probe Noto CJK");
    }

    shell.status("P2: starting WebCodecs decoders");
    const handles = new Map<string, ReturnType<Compositor["registerTextureOnly"]>>();
    const decoders = new Map<string, DecodeWorker>();
    for (const input of ir.inputs) {
      const ticket = shell.tickets.get(input.asset_id);
      if (!ticket) throw new Error(`no ticket for ${input.asset_id}`);
      handles.set(input.input_id, compositor.registerTextureOnly(input.input_id));
      const decoder = await DecodeWorker.create(ticket);
      decoders.set(input.input_id, decoder);
    }
    const sourceWidthByInput = new Map([...decoders.keys()].map(inputId => {
      const decoder = decoders.get(inputId)!;
      return [inputId, decoder.width || 1920];
    }));
    const [phaseX, phaseY] = (session.chroma_phase ?? "0,0").split(",").map(value => Number(value) || 0);
    compositor.chromaPhaseX = phaseX;
    compositor.chromaPhaseY = phaseY;
    const adapterInfo = compositor.gpuRendererInfo();
    const hardwareCheck = assertHardwareRenderer(adapterInfo.adapter);
    if (hardwareCheck.software) throw new Error(`software rendering detected (R7): ${adapterInfo.adapter}`);

    let diagDone = false;
    const uploadDecoded = async (inputId: string, srcN: number, shadow = false): Promise<void> => {
      const decoder = decoders.get(inputId);
      const handle = handles.get(inputId);
      if (!decoder || !handle) throw new Error(`no decoder for ${inputId}`);
      const videoFrame = await decoder.decode(srcN, ir.canvas.fps);
      if (!diagDone) {
        diagDone = true;
        // 一次性诊断：解码帧直出 PNG（绕过 GL），核对解码器输出几何
        const diag = document.createElement("canvas");
        diag.width = videoFrame.displayWidth; diag.height = videoFrame.displayHeight;
        diag.getContext("2d")!.drawImage(videoFrame, 0, 0);
        const blob = await new Promise<Blob>((resolve) => diag.toBlob(b => resolve(b!), "image/png"));
        await bridge.writeArtifact("diag_decoded_frame.png", { base64: await blobToBase64(blob) });
        await bridge.writeArtifact("diag_decoded_meta.json", JSON.stringify({
          displayWidth: videoFrame.displayWidth, displayHeight: videoFrame.displayHeight,
          codedWidth: videoFrame.codedWidth, codedHeight: videoFrame.codedHeight, format: videoFrame.format,
        }));
      }
      await compositor.uploadVideoFrame(handle, videoFrame, shadow);
    };

    const rows: Array<Record<string, unknown>> = [];
    let index = 0;
    for (const n of sampleFrames) {
      const frame: IrFrame | undefined = ir.frames[n];
      if (!frame) throw new Error(`sample frame ${n} outside IR duration`);
      const t0 = performance.now();
      const main = frame.main;
      if (main.kind === "segment") {
        await uploadDecoded(main.input_id, main.src_n);
      } else if (main.kind === "transition") {
        await uploadDecoded(main.left.input_id, main.left.src_n);
        await uploadDecoded(main.right.input_id, main.right.src_n, main.left.input_id === main.right.input_id);
      }
      for (const overlay of frame.overlays) {
        await uploadDecoded(overlay.input_id, overlay.src_n);
      }
      const decodeMs = performance.now() - t0;

      const c0 = performance.now();
      compositor.beginFrame();
      compositor.setSourceWidthScale(sourceWidthByInput);
      if (main.kind === "segment") compositor.drawMainSegment(main);
      else if (main.kind === "transition") {
        compositor.drawTransitionTextures(main, false, main.left.input_id === main.right.input_id);
      }
      compositor.drawOverlays(frame);
      compositor.drawCaptionsOf(frame);
      compositor.endFrame();
      const composeMs = performance.now() - c0;

      const png = await compositor.readbackPng();
      await bridge.writeArtifact(`gl/frame_${String(n).padStart(4, "0")}.png`, { base64: await blobToBase64(png) });
      if (captionFrames.has(n)) {
        compositor.beginFrame();
        compositor.setSourceWidthScale(sourceWidthByInput);
        if (main.kind === "segment") compositor.drawMainSegment(main);
        else if (main.kind === "transition") {
          compositor.drawTransitionTextures(main, false, main.left.input_id === main.right.input_id);
        }
        compositor.drawOverlays(frame);
        compositor.endFrame();
        const pngNocap = await compositor.readbackPng();
        await bridge.writeArtifact(`gl_nocap/frame_${String(n).padStart(4, "0")}.png`, { base64: await blobToBase64(pngNocap) });
      }
      rows.push({
        n, kind: main.kind, overlays: frame.overlays.length,
        caption: frame.captions.length > 0,
        decode_upload_ms: Math.round(decodeMs * 1000) / 1000,
        compose_ms: Math.round(composeMs * 1000) / 1000,
      });
      index += 1;
      shell.status(`P2: frame ${index}/${sampleFrames.length} (n=${n})`);
    }

    for (const decoder of decoders.values()) decoder.terminate();

    const environment = await collectEnvironment();
    const result = {
      probe: "m3p2",
      chroma_phase: [compositor.chromaPhaseX, compositor.chromaPhaseY],
      frame_source: "WebCodecs VideoDecoder (worker, hand-written BMFF demux), colorSpace pinned bt709",
      frame_source_note: "<video>.currentTime 步进呈现语义不透明（暂停视频 rVFC 不触发 / texImage2D 陈旧帧），P2 帧源改用 WebCodecs；P1 仍为 <video>",
      canvas: ir.canvas,
      adapter: adapterInfo,
      hardware_check: hardwareCheck,
      decoder_hardware: Object.fromEntries([...decoders].map(([inputId, decoder]) => [inputId, decoder.hardware])),
      sample_count: rows.length,
      caption_font_loaded: compositor.captionFontLoaded !== "",
      frames: rows,
      environment,
      versions: session.versions,
      note: "PNG 顺序 = sample_frames.json 顺序；compare_tool 按同一顺序映射两侧帧",
    };
    await bridge.writeArtifact("m3p2_result.json", JSON.stringify(result, null, 1));
    await shell.finish({ probe: "m3p2", frames: rows.length, adapter: adapterInfo.adapter });
  } catch (error) {
    await shell.fail(error);
  }
}
