import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeDecodeCodec,
  probeDecodeCapability,
  selectCapabilityRow,
  MediaDecoderFactoryImpl,
} from "../src/app/preview/decode-capability.js";
import { DecodeWorker } from "../src/app/preview/decode-worker.js";
import { isDecodeConfigureFailure } from "../src/app/preview/decode-capability.js";
import type { DecodeCapabilityTable } from "@aivideo/contracts";

function tableWith(partial: Partial<DecodeCapabilityTable["rows"][number]> & { codec: "avc" | "hevc" | "av1" }): DecodeCapabilityTable {
  return {
    rows: [{
      webcodecs_supported: false,
      webcodecs_mode: null,
      ffmpeg_supported: false,
      preferred: "webcodecs",
      ...partial,
    }],
    probed_at: "2026-09-26T00:00:00.000Z",
  };
}

describe("normalizeDecodeCodec", () => {
  it("RFC codec string 与别名映射到规范化 codec", () => {
    expect(normalizeDecodeCodec("avc1.640028")).toBe("avc");
    expect(normalizeDecodeCodec("hvc1.1.6.L120.B0")).toBe("hevc");
    expect(normalizeDecodeCodec("hev1.1.6.L120.B0")).toBe("hevc");
    expect(normalizeDecodeCodec("av01.0.04M.08")).toBe("av1");
    expect(normalizeDecodeCodec("h264")).toBe("avc");
    expect(normalizeDecodeCodec("vp09")).toBeNull();
  });
});

describe("probeDecodeCapability", () => {
  it("无 VideoDecoder 时 webcodecs 不支持；ffmpeg 仅在显式注入时为 true", async () => {
    const original = (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
    try {
      delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
      const table = await probeDecodeCapability({ hevc: true }, () => new Date("2026-09-26T00:00:00.000Z"));
      expect(table.probed_at).toBe("2026-09-26T00:00:00.000Z");
      expect(table.rows).toHaveLength(3);
      const hevc = selectCapabilityRow(table, "hvc1.1.6.L120.B0");
      expect(hevc).toMatchObject({
        codec: "hevc",
        webcodecs_supported: false,
        ffmpeg_supported: true,
        preferred: "ffmpeg",
      });
      const avc = selectCapabilityRow(table, "avc1.640028");
      expect(avc).toMatchObject({ codec: "avc", webcodecs_supported: false, ffmpeg_supported: false });
    } finally {
      if (original === undefined) delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
      else (globalThis as { VideoDecoder?: unknown }).VideoDecoder = original;
    }
  });

  it("isConfigSupported 支持时 webcodecs 优先，软解记 no-preference", async () => {
    const original = (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
    try {
      (globalThis as { VideoDecoder?: unknown }).VideoDecoder = {
        isConfigSupported: vi.fn(async (config: { codec: string; hardwareAcceleration?: string }) => {
          if (config.codec.startsWith("hvc1") && config.hardwareAcceleration !== "prefer-hardware") {
            return { supported: true, config };
          }
          if (config.codec.startsWith("avc1")) return { supported: true, config };
          return { supported: false };
        }),
      };
      const table = await probeDecodeCapability({ hevc: true, avc: true });
      expect(selectCapabilityRow(table, "avc1.640028")).toMatchObject({
        webcodecs_supported: true,
        webcodecs_mode: "prefer-hardware",
        preferred: "webcodecs",
      });
      expect(selectCapabilityRow(table, "hevc")).toMatchObject({
        webcodecs_supported: true,
        webcodecs_mode: "no-preference",
        preferred: "webcodecs",
      });
    } finally {
      if (original === undefined) delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
      else (globalThis as { VideoDecoder?: unknown }).VideoDecoder = original;
    }
  });
});

describe("MediaDecoderFactoryImpl 判定顺序", () => {
  it("未知 codec 明确抛 BMFF_CODEC_UNSUPPORTED", async () => {
    const factory = new MediaDecoderFactoryImpl(tableWith({ codec: "hevc" }));
    await expect(factory.create({
      mediaUrl: "aivideo://t",
      codec: "vp09.00.10.08",
      width: 1,
      height: 1,
    })).rejects.toMatchObject({ code: "BMFF_CODEC_UNSUPPORTED" });
  });

  it("双后端均不可用时抛 BMFF_CODEC_UNSUPPORTED（明确回退，不静默）", async () => {
    const factory = new MediaDecoderFactoryImpl(tableWith({ codec: "hevc", webcodecs_supported: false, ffmpeg_supported: false }));
    await expect(factory.create({
      mediaUrl: "aivideo://t",
      codec: "hvc1.1.6.L120.B0",
      width: 1,
      height: 1,
    })).rejects.toMatchObject({ code: "BMFF_CODEC_UNSUPPORTED" });
  });

  it("仅 ffmpeg 可用时倾向 ffmpeg；无 decodeFrames 则明确失败", async () => {
    const factory = new MediaDecoderFactoryImpl(tableWith({
      codec: "hevc",
      webcodecs_supported: false,
      ffmpeg_supported: true,
      preferred: "ffmpeg",
    }));
    await expect(factory.create({
      mediaUrl: "aivideo://t",
      codec: "hevc",
      width: 1,
      height: 1,
    })).rejects.toMatchObject({ code: "DECODE_BACKEND_UNAVAILABLE" });
  });

  it("注入 decodeFrames 后后端 B 返回 plane_payload", async () => {
    const y = new Uint8Array([1, 2, 3, 4]);
    const uv = new Uint8Array([5, 6]);
    const header = new Uint8Array(12 + 28 + y.length + uv.length);
    const view = new DataView(header.buffer);
    header.set([0x41, 0x49, 0x56, 0x31], 0);
    view.setUint32(4, 1, true);
    view.setUint32(8, 0, true);
    view.setUint32(12, 3, true); // frame_n
    view.setUint32(16, 2, true);
    view.setUint32(20, 2, true);
    view.setUint32(24, 2, true);
    view.setUint32(28, 2, true);
    view.setUint32(32, y.length, true);
    view.setUint32(36, uv.length, true);
    header.set(y, 40);
    header.set(uv, 40 + y.length);
    const factory = new MediaDecoderFactoryImpl(tableWith({
      codec: "hevc",
      webcodecs_supported: false,
      ffmpeg_supported: true,
      preferred: "ffmpeg",
    }));
    const decoder = await factory.create({
      mediaUrl: "aivideo://t",
      codec: "hevc",
      width: 2,
      height: 2,
      decodeFrames: async () => header.buffer,
    });
    expect(decoder.backend).toBe("ffmpeg");
    const frame = await decoder.decode(3, 30);
    expect(frame.kind).toBe("plane_payload");
    if (frame.kind === "plane_payload") {
      expect(frame.frameN).toBe(3);
      expect(Array.from(frame.planes.y)).toEqual([1, 2, 3, 4]);
      frame.release();
      frame.release(); // 幂等
    }
    decoder.dispose();
  });
});

describe("P28 实配失败回写降级（防每素材反复试错）", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const configureError = () => Object.assign(new Error("configure boom"), { code: "DECODE_CONFIGURE_FAILED" });
  const factoryInput = {
    mediaUrl: "aivideo://t",
    codec: "hvc1.1.6.L120.B0",
    width: 2,
    height: 2,
    decodeFrames: async () => new ArrayBuffer(0),
  };

  it("分类器只认 DECODE_CONFIGURE_FAILED，瞬态错误不认", () => {
    expect(isDecodeConfigureFailure(new Error("DECODE_CONFIGURE_FAILED: x"))).toBe(true);
    expect(isDecodeConfigureFailure(configureError())).toBe(true);
    expect(isDecodeConfigureFailure(new Error("ticket expired"))).toBe(false);
    expect(isDecodeConfigureFailure(null)).toBe(false);
  });

  it("实配失败当次落次选后端且能力表回写降级，后续素材不再试错", async () => {
    const table = tableWith({ codec: "hevc", webcodecs_supported: true, webcodecs_mode: "prefer-hardware", ffmpeg_supported: true });
    const create = vi.spyOn(DecodeWorker, "create").mockRejectedValue(configureError());
    const factory = new MediaDecoderFactoryImpl(table);

    const first = await factory.create(factoryInput);
    expect(first.backend).toBe("ffmpeg");
    expect(create).toHaveBeenCalledTimes(1);
    expect(table.rows[0]).toMatchObject({ webcodecs_supported: false, webcodecs_mode: null, preferred: "ffmpeg" });

    const second = await factory.create(factoryInput);
    expect(second.backend).toBe("ffmpeg");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("瞬态失败不污染能力表，下一素材仍可尝试 webcodecs", async () => {
    const table = tableWith({ codec: "hevc", webcodecs_supported: true, webcodecs_mode: "no-preference", ffmpeg_supported: true });
    const create = vi.spyOn(DecodeWorker, "create")
      .mockRejectedValueOnce(new Error("ticket expired"))
      .mockResolvedValueOnce({ width: 2, height: 2 } as never);
    const factory = new MediaDecoderFactoryImpl(table);

    const first = await factory.create(factoryInput);
    expect(first.backend).toBe("ffmpeg");
    expect(table.rows[0]).toMatchObject({ webcodecs_supported: true, preferred: "webcodecs" });

    const second = await factory.create(factoryInput);
    expect(second.backend).toBe("webcodecs");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("确定性失败全部降级后明确失败，不静默", async () => {
    const table = tableWith({ codec: "hevc", webcodecs_supported: true, ffmpeg_supported: true });
    vi.spyOn(DecodeWorker, "create").mockRejectedValue(configureError());
    const factory = new MediaDecoderFactoryImpl(table);
    const noFallback = { ...factoryInput, decodeFrames: undefined };

    await expect(factory.create(noFallback)).rejects.toMatchObject({ code: "DECODE_BACKEND_UNAVAILABLE" });
    expect(table.rows[0]).toMatchObject({ webcodecs_supported: false });
    await expect(factory.create(noFallback)).rejects.toMatchObject({ code: "DECODE_BACKEND_UNAVAILABLE" });
  });
});

describe("P32 代理与能力表解耦（H5 收口）", () => {
  it("能力表模块不读代理状态：禁 import 代理模块、禁代理标识符", () => {
    // 规划门 §5：「代理只加速，能力表不读代理状态」。代理（preview_source）
    // 只替换解码输入；A/B 选择、探测与降级必须与代理就绪与否无关。
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../src/app/preview/decode-capability.ts"),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]!);
    const tainted = imports.filter(name => /proxy|preview[_-]?source|derived/i.test(name));
    expect(tainted, "能力表 import 了代理域模块").toEqual([]);
    // 标识符面（含注释）：耦合从"提一嘴"开始。
    expect(/proxy/i.test(source), "能力表模块出现代理标识符/注释").toBe(false);
  });
});

describe("P31 色彩矩阵钉死 BT.709", () => {
  it("B 路径 NV12 VideoFrame 与 A 路径/着色器同口径标注 bt709", async () => {
    const inits: Array<{ colorSpace?: Record<string, unknown> }> = [];
    class FakeVideoFrame {
      timestamp = 0;
      constructor(_data: unknown, init: { timestamp?: number; colorSpace?: Record<string, unknown> }) {
        inits.push(init);
        this.timestamp = init?.timestamp ?? 0;
      }
      close() {}
    }
    const original = (globalThis as { VideoFrame?: unknown }).VideoFrame;
    try {
      (globalThis as { VideoFrame?: unknown }).VideoFrame = FakeVideoFrame;
      const y = new Uint8Array([1, 2, 3, 4]);
      const uv = new Uint8Array([5, 6]);
      const header = new Uint8Array(12 + 28 + y.length + uv.length);
      const view = new DataView(header.buffer);
      header.set([0x41, 0x49, 0x56, 0x31], 0);
      view.setUint32(4, 1, true);
      view.setUint32(8, 0, true);
      view.setUint32(12, 3, true);
      view.setUint32(16, 2, true);
      view.setUint32(20, 2, true);
      view.setUint32(24, 2, true);
      view.setUint32(28, 2, true);
      view.setUint32(32, y.length, true);
      view.setUint32(36, uv.length, true);
      header.set(y, 40);
      header.set(uv, 40 + y.length);
      const factory = new MediaDecoderFactoryImpl(tableWith({
        codec: "hevc", webcodecs_supported: false, ffmpeg_supported: true, preferred: "ffmpeg",
      }));
      const decoder = await factory.create({
        mediaUrl: "aivideo://t", codec: "hevc", width: 2, height: 2,
        decodeFrames: async () => header.buffer,
      });
      const frame = await decoder.decode(3, 30);
      expect(frame.kind).toBe("video_frame");
      expect(inits[0]?.colorSpace).toMatchObject({
        matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false,
      });
      decoder.dispose();
    } finally {
      if (original === undefined) delete (globalThis as { VideoFrame?: unknown }).VideoFrame;
      else (globalThis as { VideoFrame?: unknown }).VideoFrame = original;
    }
  });
});
