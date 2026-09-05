/** M3-0 探针公共：页面壳、环境取证、视频元素与就绪辅助。 */
import { probeBridge, fetchAssetBlobUrl, type ProbeSession } from "./bridge.js";
import { parseIr, type Ir } from "./ir.js";

export interface ProbeShell {
  session: ProbeSession;
  ir: Ir;
  tickets: Map<string, string>;
  canvas: HTMLCanvasElement;
  status: (text: string) => void;
  finish: (summary: Record<string, unknown>) => Promise<never>;
  fail: (error: unknown) => Promise<never>;
}

export async function setupProbe(expectedProbe: "m3p1" | "m3p2" | "m3p3"): Promise<ProbeShell> {
  document.title = `M3-0 probe ${expectedProbe}`;
  document.body.style.cssText = "margin:0;background:#000;color:#9aa4ad;font:12px monospace;";
  const canvas = document.createElement("canvas");
  const statusDiv = document.createElement("div");
  statusDiv.style.cssText = "position:fixed;left:8px;top:8px;white-space:pre;z-index:9;";
  document.body.append(statusDiv, canvas);

  const bridge = probeBridge();
  const session = await bridge.session();
  if (session.probe !== expectedProbe) throw new Error(`probe mismatch: ${session.probe} != ${expectedProbe}`);
  const ir = parseIr(session.ir ?? "");
  canvas.width = ir.canvas.width;
  canvas.height = ir.canvas.height;
  canvas.style.cssText = "display:block;width:auto;height:auto;image-rendering:auto;margin:0 auto;";
  // 视频缩略图条：Chromium 对离屏 video 节流（seek 后新帧不呈现 → 纹理冻结），
  // 探针的视频必须可见 —— 以小缩略图排在画布下方（实测校准第 0 步发现并修复）。
  const strip = document.createElement("div");
  strip.id = "probe-video-strip";
  strip.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;justify-content:center;";
  document.body.append(statusDiv, canvas, strip);

  const tickets = new Map<string, string>();
  for (const asset of session.assets) {
    tickets.set(asset.entity_id, await fetchAssetBlobUrl(bridge, asset.entity_id));
  }

  return {
    session, ir, tickets, canvas,
    status: text => { statusDiv.textContent = text; },
    finish: async summary => {
      statusDiv.textContent = `probe ${expectedProbe} done — writing artifacts`;
      await bridge.done(summary);
      return await new Promise<never>(() => undefined);
    },
    fail: async error => {
      statusDiv.textContent = `probe ${expectedProbe} FAILED: ${String(error)}`;
      try { await bridge.writeArtifact("error.txt", String(error instanceof Error ? error.stack ?? error.message : error)); } catch { /* ignore */ }
      try { await bridge.done({ failed: true, error: String(error) }); } catch { /* ignore */ }
      return await new Promise<never>(() => undefined);
    },
  };
}

export function createVideo(ticket: string, options: { visible?: boolean } = {}): HTMLVideoElement {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = ticket;
  const strip = document.getElementById("probe-video-strip");
  if (options.visible) {
    video.style.cssText = "display:block;width:480px;margin:4px;";
    document.body.append(video);
  } else {
    // 缩略图（可见、小面积）：保证解码/呈现不被节流
    video.style.cssText = "display:block;width:200px;margin:0;";
    (strip ?? document.body).append(video);
  }
  return video;
}

export async function waitVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2) return;
  await new Promise<void>((resolve, reject) => {
    video.addEventListener("loadeddata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error(`video load error: ${video.src.slice(0, 40)}`)), { once: true });
  });
}

export async function firstPresented(video: HTMLVideoElement): Promise<number> {
  return await new Promise(resolve => {
    type RvfcVideo = HTMLVideoElement & {
      requestVideoFrameCallback: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    };
    const rvfc = (video as Partial<RvfcVideo>).requestVideoFrameCallback;
    if (typeof rvfc === "function") {
      rvfc.call(video, (_now, meta) => resolve(meta.mediaTime));
    } else {
      resolve(video.currentTime);
    }
  });
}

export async function collectEnvironment(): Promise<Record<string, unknown>> {
  const bridge = probeBridge();
  let gpuInfo: Record<string, unknown> = {};
  let envInfo: Record<string, unknown> = {};
  try { gpuInfo = await bridge.gpu() as unknown as Record<string, unknown>; } catch { /* ignore */ }
  try { envInfo = await bridge.env() as unknown as Record<string, unknown>; } catch { /* ignore */ }
  return {
    user_agent: navigator.userAgent,
    device_pixel_ratio: window.devicePixelRatio,
    hardware_concurrency: navigator.hardwareConcurrency,
    ...gpuInfo,
    ...envInfo,
  };
}

/** WebCodecs 硬解路径证据（冻结方案 §7.1/§7.3）。 */
export async function videoDecoderSupportEvidence(mimeType: string, codedWidth: number, codedHeight: number): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { codec: mimeType.slice(0, 24) };
  const config: VideoDecoderConfig = {
    codec: mimeType, codedWidth, codedHeight, optimizeForLatency: true,
  };
  for (const preference of ["prefer-hardware", "no-preference"] as const) {
    try {
      const support = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: preference });
      result[`isConfigSupported_${preference}`] = { supported: support.supported, config: support.config?.codec ?? null };
    } catch (error) {
      result[`isConfigSupported_${preference}`] = String(error);
    }
  }
  return result;
}
