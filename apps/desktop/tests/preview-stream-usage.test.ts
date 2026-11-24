import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewSession } from "../src/app/preview/preview-session.js";
import type { Ir } from "../src/app/preview/ir.js";
import { installWorkers, ScriptedWorker, stubOffscreenCanvas } from "./fixtures/preview-worker-stubs.js";

function streamUsageIr(input: Partial<Ir["inputs"][number]>, visualConsumer: boolean): Ir {
  const visualLayer = {
    clip_id: "clip_visual",
    input_id: "in_shared",
    src_n: 0,
    src_t_us: 0,
    box: { x: 0, y: 0, w: 1920, h: 1080 },
    rotation_deg: 0,
    alpha: 1,
  };
  const visualSegment = {
    clip_id: "clip_visual",
    track_id: "V1",
    input_id: "in_shared",
    source_start_us: 0,
    source_end_us: 1_000_000,
    timeline_start_us: 0,
    timeline_end_us: 1_000_000,
    layout: "fit",
    speed_milli: 1000,
  };
  const audioSegment = {
    clip_id: "clip_audio",
    track_id: "A1",
    input_id: "in_shared",
    source_start_us: 0,
    source_end_us: 1_000_000,
    timeline_start_us: 0,
    timeline_end_us: 1_000_000,
    layout: "fit",
    speed_milli: 1000,
  };
  return {
    schema: "preview-ir-v1",
    projector_version: "test-stream-usage",
    canvas: { width: 1920, height: 1080, fps: 30, duration_frames: 30, duration_us: 1_000_000, background: "#000000" },
    inputs: [{
      input_id: "in_shared",
      asset_id: "asset_shared",
      asset_kind: "video",
      duration_us: 1_000_000,
      has_audio: true,
      video_required: visualConsumer,
      audio_required: input.audio_required ?? true,
      geometry: { width: 1920, height: 1080, sar: 1 },
      ...input,
    }],
    segments: visualConsumer ? [visualSegment, audioSegment] : [audioSegment],
    captions: [],
    caption_styles: {},
    transition_windows: [],
    known_approximations: [],
    frames: [{
      n: 0,
      t_us: 0,
      main: visualConsumer ? {
        kind: "segment",
        clip_id: "clip_visual",
        input_id: "in_shared",
        src_n: 0,
        src_t_us: 0,
        content: { x: 0, y: 0, w: 1920, h: 1080 },
        shift: { dx: 0, dy: 0 },
        alpha: 1,
      } : { kind: "black" },
      layers: visualConsumer ? [visualLayer] : [],
      overlays: [],
      captions: [],
    }],
  };
}

const TICKET = "aivideo://media/original";
const PROXY = "aivideo://media/proxy";

function respondWithDecoderCounters(worker: ScriptedWorker, submitted: number, outputs: number): void {
  const original = worker.postMessage.bind(worker);
  worker.postMessage = (message: any) => {
    if (message.type !== "stats") return original(message);
    worker.messages.push(message);
    queueMicrotask(() => worker.reply({
      type: "done",
      id: null,
      note: JSON.stringify({ residency: {
        decoded: outputs,
        decode_submissions: submitted,
        output_callbacks: outputs,
        posted: outputs,
        cached: 0,
        closed: 0,
        live: 0,
        cacheBytes: 0,
        cacheSize: 0,
      } }),
    }));
  };
}

describe("preview stream usage", () => {
  beforeEach(() => {
    ScriptedWorker.instances = [];
    installWorkers();
    stubOffscreenCanvas();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("audio-only silent video skips source lookup, compositor input, and decoder rig", async () => {
    const ir = streamUsageIr({ has_audio: false, audio_required: false, video_required: false, hdr: true, geometry: { width: 0, height: 0, sar: 1 } }, false);
    const resolver = { resolve: vi.fn() };
    const session = await PreviewSession.create(
      document.createElement("div"), ir, new Map(), undefined, undefined, resolver as never, "balanced",
    );

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(ScriptedWorker.instances).toHaveLength(1); // compositor only
    const compositorInit = ScriptedWorker.instances[0]!.messages.find(message => message.type === "init");
    expect(compositorInit.inputs).toEqual([]);
    expect(session.metrics().hdr_media).toBe(false);
    expect((session as unknown as { rigs: Map<string, unknown> }).rigs.has("in_shared")).toBe(false);
    await expect(session.decodeUsageCounters()).resolves.toEqual([expect.objectContaining({
      input_id: "in_shared",
      video_required: false,
      audio_required: false,
      has_audio: false,
      video_rig_created: false,
      source_resolve_requests: 0,
      proxy_resolutions: 0,
      decode_requests: 0,
      webcodecs_decode_submissions: 0,
      webcodecs_output_callbacks: 0,
    })]);
    session.dispose();
  });

  it("dual-use video resolves a proxy only for picture and retains the original audio ticket", async () => {
    const ir = streamUsageIr({ video_required: true, audio_required: true, has_audio: true }, true);
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        url: PROXY,
        isProxy: true,
        description: { coded_width: 640, coded_height: 360 },
      }),
    };
    const session = await PreviewSession.create(
      document.createElement("div"), ir, new Map([["asset_shared", TICKET]]), undefined, undefined, resolver as never, "balanced",
    );

    expect(resolver.resolve).toHaveBeenCalledWith("asset_shared", TICKET);
    expect((session as unknown as { tickets: Map<string, string> }).tickets.get("asset_shared")).toBe(TICKET);
    expect(ScriptedWorker.instances).toHaveLength(2);
    const compositorInit = ScriptedWorker.instances[0]!.messages.find(message => message.type === "init");
    expect(compositorInit.inputs).toEqual([expect.objectContaining({ inputId: "in_shared", sourceWidth: 640, height: 360 })]);
    const decoderWorker = ScriptedWorker.instances[1]!;
    expect(decoderWorker.messages.find(message => message.type === "init")?.url).toBe(PROXY);
    respondWithDecoderCounters(decoderWorker, 17, 13);

    await expect(session.decodeUsageCounters()).resolves.toEqual([expect.objectContaining({
      input_id: "in_shared",
      video_required: true,
      audio_required: true,
      has_audio: true,
      video_rig_created: true,
      source_resolve_requests: 1,
      proxy_resolutions: 1,
      webcodecs_decode_submissions: 17,
      webcodecs_output_callbacks: 13,
    })]);
    session.dispose();
  });

  it("counts requests and returned frames when the Core FFmpeg decoder is active", async () => {
    const session = await PreviewSession.create(
      document.createElement("div"),
      streamUsageIr({ video_required: true, audio_required: true, has_audio: true }, true),
      new Map([["asset_shared", TICKET]]),
    );
    const internals = session as unknown as {
      rigs: Map<string, { worker: { dispose(): void } | null }>;
      decodeInput: (rig: { worker: { dispose(): void } | null }, inputId: string, frameN: number) => Promise<unknown>;
    };
    const rig = internals.rigs.get("in_shared")!;
    rig.worker?.dispose();
    const ffmpegDecoder = {
      backend: "ffmpeg",
      decode: vi.fn().mockResolvedValue({ kind: "plane_payload", release: vi.fn() }),
      residency: vi.fn().mockResolvedValue(null),
      dispose: vi.fn(),
    };
    rig.worker = ffmpegDecoder;

    await internals.decodeInput(rig, "in_shared", 0);
    await expect(session.decodeUsageCounters()).resolves.toEqual([expect.objectContaining({
      input_id: "in_shared",
      ffmpeg_decode_requests: 1,
      ffmpeg_frames_returned: 1,
      webcodecs_decode_submissions: 0,
      webcodecs_output_callbacks: 0,
    })]);
    session.dispose();
  });
});
