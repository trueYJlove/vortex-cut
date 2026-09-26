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
      return new WebCodecsMediaDecoder(worker, input.codec);
    }
    // 后端 B（FfmpegFrameDecoder）属 H3；此处明确失败以触发次选/回退，禁止静默。
    throw Object.assign(new Error("FFmpeg frame backend not ready (H3)"), { code: "DECODE_BACKEND_UNAVAILABLE" });
  }
}
