/**
 * H1：解码能力探测 + MediaDecoderFactory（MEDIA_DECODER_HEVC_PLANNING_GATE §2.2 / §3 H1）。
 *
 * 判定顺序：WebCodecs isConfigSupported（软解是合法 A 路径）→ FFmpeg → 明确回退。
 * 「无硬解」不是 A 路径的否决项；硬解不可得时 FFmpeg 旁路才是代价项。
 */
import {
  DECODE_CAPABILITY_CODECS,
  type DecodeBackendId,
  type DecodeCapabilityCodec,
  type DecodeCapabilityRow,
  type DecodeCapabilityTable,
  type WebCodecsDecodeMode,
} from "@aivideo/contracts";
import { DecodeWorker, type DecodeResidencyInfo } from "./decode-worker.js";
import type {
  DecodedFrame,
  MediaDecoder,
  MediaDecoderFactory,
  MediaDecoderFactoryInput,
} from "./media-decoder.js";

/** RFC codec string 探测针（profile/tier/level 可能与实配 hvcC 错位——见规划门无硬解陷阱）。 */
const PROBE_CODEC_STRINGS: Record<DecodeCapabilityCodec, readonly string[]> = {
  avc: ["avc1.640028"],
  hevc: ["hvc1.1.6.L120.B0", "hev1.1.6.L120.B0"],
  av1: ["av01.0.04M.08"],
};

export function normalizeDecodeCodec(codec: string): DecodeCapabilityCodec | null {
  const lower = codec.toLowerCase();
  if (lower.startsWith("avc") || lower === "h264") return "avc";
  if (lower.startsWith("hvc") || lower.startsWith("hev") || lower === "hevc" || lower === "h265") return "hevc";
  if (lower.startsWith("av01") || lower === "av1") return "av1";
  return null;
}

function mapHardware(value: string | null | undefined): WebCodecsDecodeMode | null {
  if (value === "prefer-hardware" || value === "no-preference") return value;
  return null;
}

async function probeWebCodecsRow(codec: DecodeCapabilityCodec): Promise<Pick<DecodeCapabilityRow, "webcodecs_supported" | "webcodecs_mode">> {
  if (typeof VideoDecoder === "undefined" || typeof VideoDecoder.isConfigSupported !== "function") {
    return { webcodecs_supported: false, webcodecs_mode: null };
  }
  for (const codecString of PROBE_CODEC_STRINGS[codec]) {
    try {
      const preferred = await VideoDecoder.isConfigSupported({ codec: codecString, hardwareAcceleration: "prefer-hardware" });
      if (preferred.supported) return { webcodecs_supported: true, webcodecs_mode: "prefer-hardware" };
      const soft = await VideoDecoder.isConfigSupported({ codec: codecString });
      if (soft.supported) return { webcodecs_supported: true, webcodecs_mode: "no-preference" };
    } catch {
      // 探测异常视为该 codec string 不可用；继续下一候选
    }
  }
  return { webcodecs_supported: false, webcodecs_mode: null };
}

/**
 * 探测写入能力表。
 * `ffmpegSupported` 由 Core `ffmpeg -decoders` 侧提供（H3 接线前由调用方注入；
 * 缺省 avc/hevc/av1 均 false——禁止无探测就假定 FFmpeg 可解）。
 */
export async function probeDecodeCapability(
  ffmpegSupported: Partial<Record<DecodeCapabilityCodec, boolean>> = {},
  now: () => Date = () => new Date(),
): Promise<DecodeCapabilityTable> {
  const rows: DecodeCapabilityRow[] = [];
  for (const codec of DECODE_CAPABILITY_CODECS) {
    const web = await probeWebCodecsRow(codec);
    const ffmpeg_supported = ffmpegSupported[codec] === true;
    const preferred: DecodeBackendId = web.webcodecs_supported ? "webcodecs" : ffmpeg_supported ? "ffmpeg" : "webcodecs";
    rows.push({
      codec,
      webcodecs_supported: web.webcodecs_supported,
      webcodecs_mode: web.webcodecs_mode,
      ffmpeg_supported,
      preferred,
    });
  }
  return { rows, probed_at: now().toISOString() };
}

/** 按规范化 codec 取行；未知 codec 返回 null（调用方走明确回退）。 */
export function selectCapabilityRow(table: DecodeCapabilityTable, codec: string): DecodeCapabilityRow | null {
  const normalized = normalizeDecodeCodec(codec);
  if (!normalized) return null;
  return table.rows.find(row => row.codec === normalized) ?? null;
}

class WebCodecsMediaDecoder implements MediaDecoder {
  readonly backend = "webcodecs" as const;
  private disposed = false;

  constructor(
    private readonly worker: DecodeWorker,
    readonly codec: string,
  ) {}

  get width(): number { return this.worker.width; }
  get height(): number { return this.worker.height; }
  get hardware(): WebCodecsDecodeMode | null { return mapHardware(this.worker.hardware); }
  get lastFrameInfo() { return this.worker.lastFrameInfo; }
  get timingSamples() { return this.worker.timingSamples; }
  get hasBFrames(): boolean { return this.worker.hasBFrames; }

  async decode(frameN: number, fps: number, signal?: AbortSignal): Promise<DecodedFrame> {
    if (this.disposed) throw new Error("media decoder disposed");
    if (signal?.aborted) throw new Error("decode aborted");
    const frame = await this.worker.decode(frameN, fps);
    return {
      kind: "video_frame",
      frame,
      timestampUs: frame.timestamp,
      frameN,
      release: () => { try { frame.close(); } catch { /* 已关闭 */ } },
    };
  }

  residency(): Promise<DecodeResidencyInfo | null> {
    if (this.disposed) return Promise.resolve(null);
    return this.worker.queryResidency().catch(() => null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
  }
}

export class MediaDecoderFactoryImpl implements MediaDecoderFactory {
  constructor(private readonly table: DecodeCapabilityTable) {}

  async create(input: MediaDecoderFactoryInput, signal?: AbortSignal): Promise<MediaDecoder> {
    // codec="auto"：调用方未知编码（demux 会发现）——依次尝试 A/B。
    // 未识别的具体 codec 串仍明确拒绝（禁止静默当 auto）。
    if (input.codec === "auto" || input.preferBackend) {
      const order: DecodeBackendId[] = input.preferBackend === "ffmpeg"
        ? ["ffmpeg", "webcodecs"]
        : input.preferBackend === "webcodecs"
          ? ["webcodecs", "ffmpeg"]
          : ["webcodecs", "ffmpeg"];
      let firstError: unknown = null;
      let lastError: unknown = null;
      for (const backend of order) {
        try {
          return await this.createBackend(backend, input, signal);
        } catch (error) {
          if (firstError === null) firstError = error;
          lastError = error;
        }
      }
      // 优先抛首个后端错误（webcodecs/demux 诊断更有用）；若 ffmpeg 因未注入
      // decodeFrames 而失败，勿用它掩盖 webcodecs 的真实原因。
      if (firstError) throw firstError;
      if (lastError) throw lastError;
      throw Object.assign(new Error("BMFF_CODEC_UNSUPPORTED: 无可用解码后端"), {
        code: "BMFF_CODEC_UNSUPPORTED",
      });
    }
    const row = selectCapabilityRow(this.table, input.codec);
    if (!row) {
      throw Object.assign(new Error(`BMFF_CODEC_UNSUPPORTED: 无法识别的编码 ${input.codec}`), {
        code: "BMFF_CODEC_UNSUPPORTED",
      });
    }
    const order: DecodeBackendId[] = row.preferred === "ffmpeg"
      ? ["ffmpeg", "webcodecs"]
      : ["webcodecs", "ffmpeg"];
    let lastError: unknown = null;
    for (const backend of order) {
      if (backend === "ffmpeg" && !row.ffmpeg_supported) continue;
      if (backend === "webcodecs" && !row.webcodecs_supported) continue;
      try {
        return await this.createBackend(backend, input, signal);
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    throw Object.assign(new Error(`BMFF_CODEC_UNSUPPORTED: ${input.codec} 无可用解码后端`), {
      code: "BMFF_CODEC_UNSUPPORTED",
    });
  }

  private async createBackend(
    backend: DecodeBackendId,
    input: MediaDecoderFactoryInput,
    signal?: AbortSignal,
  ): Promise<MediaDecoder> {
    if (backend === "webcodecs") {
      const worker = await DecodeWorker.create(
        input.mediaUrl,
        signal,
        input.refreshTicket,
        input.cacheCapBytes,
      );
      // B 帧仍走 WebCodecs（硬解 + 已修 GOP 连续喂包）；仅当调用方强制
      // preferBackend=ffmpeg 时才不用 A。软解 FFmpeg 约 2s/帧，不能当主路径。
      return new WebCodecsMediaDecoder(worker, input.codec);
    }
    if (!input.decodeFrames) {
      throw Object.assign(new Error("DECODE_BACKEND_UNAVAILABLE: decodeFrames 未注入"), {
        code: "DECODE_BACKEND_UNAVAILABLE",
      });
    }
    return new FfmpegMediaDecoder(input.decodeFrames, input.codec, input.width, input.height);
  }
}

/** AIV1 紧凑二进制 → 平面帧列表（与 Core pack_nv12_response 对齐）。 */
export function unpackNv12Response(buffer: ArrayBuffer): Array<{
  frameN: number;
  width: number;
  height: number;
  strideY: number;
  strideUv: number;
  y: Uint8Array;
  uv: Uint8Array;
}> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12 || String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== "AIV1") {
    throw new Error("DECODE_PAYLOAD_INVALID: bad magic");
  }
  const count = view.getUint32(4, true);
  const noteCount = view.getUint32(8, true);
  let offset = 12;
  for (let i = 0; i < noteCount; i++) {
    const n = view.getUint16(offset, true);
    offset += 2 + n;
  }
  const frames: Array<{
    frameN: number;
    width: number;
    height: number;
    strideY: number;
    strideUv: number;
    y: Uint8Array;
    uv: Uint8Array;
  }> = [];
  for (let i = 0; i < count; i++) {
    const frameN = view.getUint32(offset, true);
    const width = view.getUint32(offset + 4, true);
    const height = view.getUint32(offset + 8, true);
    const strideY = view.getUint32(offset + 12, true);
    const strideUv = view.getUint32(offset + 16, true);
    const yLen = view.getUint32(offset + 20, true);
    const uvLen = view.getUint32(offset + 24, true);
    offset += 28;
    const y = bytes.subarray(offset, offset + yLen);
    offset += yLen;
    const uv = bytes.subarray(offset, offset + uvLen);
    offset += uvLen;
    frames.push({ frameN, width, height, strideY, strideUv, y, uv });
  }
  return frames;
}

class FfmpegMediaDecoder implements MediaDecoder {
  readonly backend = "ffmpeg" as const;
  readonly hardware = null;
  private disposed = false;
  private readonly ready = new Map<number, ReturnType<typeof unpackNv12Response>[number]>();
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly decodeFrames: NonNullable<MediaDecoderFactoryInput["decodeFrames"]>,
    readonly codec: string,
    readonly width: number,
    readonly height: number,
  ) {}

  private async ensureWindow(frameN: number, fps: number): Promise<void> {
    if (this.ready.has(frameN)) return;
    while (this.inflight) await this.inflight;
    if (this.ready.has(frameN)) return;
    // 大窗摊薄软解成本：一次取 30 帧（1s@30fps），避免每 8 帧就从关键帧重解
    const nums: number[] = [];
    for (let n = Math.max(0, frameN - 2); n <= frameN + 27; n++) if (!this.ready.has(n)) nums.push(n);
    if (!nums.length) return;
    this.inflight = (async () => {
      try {
        // 片尾预取窗可能越过素材末尾；Core 对整个窗口采用严格 PTS 校验，
        // 因此从尾部收缩到目标帧，避免一个不存在的未来帧使有效目标整体失败。
        let requestNumbers = nums.slice(0, 32);
        let payload: ArrayBuffer;
        for (;;) {
          try {
            payload = await this.decodeFrames({ frameNumbers: requestNumbers, fps });
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/DECODE_FRAME_NOT_FOUND|DECODE_COUNT_MISMATCH/.test(message) || requestNumbers.length <= 1 || !requestNumbers.includes(frameN)) throw error;
            requestNumbers = requestNumbers.slice(0, -1);
          }
        }
        for (const item of unpackNv12Response(payload)) this.ready.set(item.frameN, item);
        if (this.ready.size > 80) {
          for (const key of [...this.ready.keys()].sort((a, b) => a - b).slice(0, this.ready.size - 60)) {
            this.ready.delete(key);
          }
        }
      } finally {
        this.inflight = null;
      }
    })();
    await this.inflight;
  }

  async decode(frameN: number, fps: number, signal?: AbortSignal): Promise<DecodedFrame> {
    if (this.disposed) throw new Error("media decoder disposed");
    if (signal?.aborted) throw new Error("decode aborted");
    await this.ensureWindow(frameN, fps);
    const hit = this.ready.get(frameN);
    if (!hit) throw new Error(`DECODE_FRAME_NOT_FOUND: ${frameN}`);
    // 封装为 VideoFrame（NV12）：与 WebCodecs 路径同走 uploadToTextures。
    // 直接传平面会在 frameUploadMode=direct 时被当 RGBA 画 → 纯绿（真机现场）。
    const packed = new Uint8Array(hit.y.length + hit.uv.length);
    packed.set(hit.y, 0);
    packed.set(hit.uv, hit.y.length);
    const timestampUs = Math.round(frameN / fps * 1e6);
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(packed.buffer, {
        format: "NV12",
        codedWidth: hit.width,
        codedHeight: hit.height,
        timestamp: timestampUs,
      });
    } catch {
      // 回退 plane_payload（compositor 平面入口）
      const y = hit.y.slice();
      const uv = hit.uv.slice();
      let released = false;
      return {
        kind: "plane_payload",
        timestampUs,
        frameN: hit.frameN,
        width: hit.width,
        height: hit.height,
        planes: { y, uv },
        strideY: hit.strideY,
        strideUv: hit.strideUv,
        colorSpace: "bt709",
        release: () => { released = true; },
      };
    }
    return {
      kind: "video_frame",
      frame,
      timestampUs,
      frameN: hit.frameN,
      release: () => { try { frame.close(); } catch { /* 已关闭 */ } },
    };
  }

  residency(): Promise<DecodeResidencyInfo | null> {
    return Promise.resolve(null);
  }

  dispose(): void {
    this.disposed = true;
    this.ready.clear();
  }
}
