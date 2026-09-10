import { describe, expect, it, vi } from "vitest";
import { registerPerformanceIpc } from "../electron/main/performance-ipc.js";

const now = "2026-09-09T00:00:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;

const readyEntry = {
  cache_key: hashA, kind: "waveform", status: "ready", size_bytes: 4096,
  created_at: now, last_accessed_at: now,
};

type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
function setup() {
  const handlers = new Map<string, Handler>();
  const fetchWithUi = vi.fn();
  const resolveDerived = vi.fn();
  const resolvePreviewSourceMedia = vi.fn();
  const resolveWaveformMedia = vi.fn();
  const resolvePcmChunkMedia = vi.fn();
  const registerDerivedMedia = vi.fn(() => "aivideo://media/ticket-url-value");
  registerPerformanceIpc({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    fetchWithUi,
    resolveDerived,
    resolvePreviewSourceMedia,
    resolveWaveformMedia,
    resolvePcmChunkMedia,
    registerDerivedMedia,
  });
  return { handlers, fetchWithUi, resolveDerived, resolvePreviewSourceMedia, resolveWaveformMedia, resolvePcmChunkMedia, registerDerivedMedia };
}

describe("B10 derived media IPC", () => {
  it("只注册十二个白名单 channel（B10×3 + B11×3 + B14×2 + B15×2 + C20×2）", () => {
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual([
      "derived-media:lookup",
      "derived-media:stats",
      "derived-media:media",
      "preview-source:get",
      "preview-source:jobs",
      "preview-source:media",
      "waveform:get",
      "waveform:media",
      "pcm-chunk:ensure",
      "pcm-chunk:media",
      "preview-ir-v2:manifest",
      "preview-ir-v2:window",
    ]);
  });

  it("lookup 走 UI 通道并校验请求体", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce(readyEntry);
    const result = await handlers.get("derived-media:lookup")?.({}, {
      project_id: "project_1", asset_id: "asset_1", kind: "waveform",
      params: { sample_rate: "8000" },
    });
    expect(fetchWithUi).toHaveBeenCalledWith(
      "/api/v1/projects/project_1/derived-media/lookup",
      { method: "POST", body: JSON.stringify({ project_id: "project_1", asset_id: "asset_1", kind: "waveform", params: { sample_rate: "8000" } }) },
    );
    expect(result).toEqual(readyEntry);
  });

  it("stats 走 UI 通道且非法响应被拒", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({ total_ready_bytes: 10, ready_count: 1, disk_budget_bytes: 100 });
    await handlers.get("derived-media:stats")?.({}, { project_id: "project_1" });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/derived-media/stats", undefined);
    fetchWithUi.mockReset();
    fetchWithUi.mockResolvedValueOnce({ total_ready_bytes: 10, ready_count: 1, disk_budget_bytes: 100, extra: "field" });
    await expect(handlers.get("derived-media:stats")?.({}, { project_id: "project_1" })).rejects.toThrow();
  });

  it("media 经 admin resolve 换票据：Renderer 只拿 URL，不拿路径", async () => {
    const { handlers, fetchWithUi, resolveDerived, registerDerivedMedia } = setup();
    const path = "C:\\data\\cache\\derived\\waveform\\aa\\key\\waveform.bin";
    resolveDerived.mockResolvedValueOnce({ cache_key: hashA, status: "ready", path, size_bytes: 4096 });
    const result = await handlers.get("derived-media:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1", kind: "waveform",
      params: { sample_rate: "8000" },
    }) as { media_url: string; cache_key: string; status: string; size_bytes: number };
    expect(fetchWithUi).not.toHaveBeenCalled(); // media 不走 UI 通道
    expect(registerDerivedMedia).toHaveBeenCalledWith(hashA, path);
    expect(result.media_url).toBe("aivideo://media/ticket-url-value");
    expect(result.cache_key).toBe(hashA);
    expect(result.status).toBe("ready");
    expect(JSON.stringify(result)).not.toContain("C:");
  });

  it("media 未 ready 或 resolve 失败返回白名单错误，不泄路径", async () => {
    const { handlers, resolveDerived, registerDerivedMedia } = setup();
    resolveDerived.mockResolvedValueOnce({ cache_key: hashA, status: "building", path: "C:/private", size_bytes: 0 });
    await expect(handlers.get("derived-media:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1", kind: "waveform", params: {},
    })).rejects.toThrow("DERIVED_NOT_FOUND");
    registerDerivedMedia.mockClear();
    resolveDerived.mockRejectedValueOnce(Object.assign(new Error("private"), { code: "ASSET_CHANGED" }));
    await expect(handlers.get("derived-media:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1", kind: "waveform", params: {},
    })).rejects.toThrow("ASSET_CHANGED");
    expect(registerDerivedMedia).not.toHaveBeenCalled();
  });

  it("lookup 严格拒绝未知键/非法 ID/非法参数", async () => {
    const { handlers, fetchWithUi } = setup();
    await expect(handlers.get("derived-media:lookup")?.({}, { project_id: "project_1", asset_id: "asset_1", kind: "waveform", params: {}, extra: 1 })).rejects.toThrow();
    await expect(handlers.get("derived-media:lookup")?.({}, { project_id: "../private", asset_id: "asset_1", kind: "waveform", params: {} })).rejects.toThrow("Invalid project_id");
    await expect(handlers.get("derived-media:lookup")?.({}, { project_id: "project_1", asset_id: "asset_1", kind: "bogus", params: {} })).rejects.toThrow();
    await expect(handlers.get("derived-media:lookup")?.({}, { project_id: "project_1", asset_id: "asset_1", kind: "waveform", params: { "BAD-KEY": "x" } })).rejects.toThrow();
    await expect(handlers.get("derived-media:lookup")?.({}, { project_id: "project_1", asset_id: "asset_1", kind: "waveform", params: { a: "C:\\windows\\system32" } })).rejects.toThrow();
    await expect(handlers.get("derived-media:stats")?.({}, { project_id: "project_1", extra: 1 })).rejects.toThrow();
    expect(fetchWithUi).not.toHaveBeenCalled();
  });

  it("lookup 响应剥离路径形态字段后经契约校验", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({ ...readyEntry, path: "C:\\private\\file.bin", uri: "file:///private" });
    const result = await handlers.get("derived-media:lookup")?.({}, {
      project_id: "project_1", asset_id: "asset_1", kind: "waveform", params: {},
    }) as Record<string, unknown>;
    expect(result.path).toBeUndefined();
    expect(result.uri).toBeUndefined();
    expect(result.cache_key).toBe(hashA);
  });
});

describe("B11 preview-source IPC", () => {
  const sourceDescription = {
    source_id: `src_asset_1_preview-720-v1_original`,
    mode: "original", status: "ready", job_id: null, cache_key: null,
    asset_fingerprint: hashA, profile_id: "preview-720-v1", duration_us: 12_000_000,
    source_origin_us: 0, fps_num: 30, fps_den: 1,
    coded_width: 1920, coded_height: 1080, display_width: 1920, display_height: 1080,
    rotation: 0, codec: "h264", size_bytes: null,
  };

  it("get 走 UI 通道并返回契约校验后的描述（无路径字段）", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce(sourceDescription);
    const result = await handlers.get("preview-source:get")?.({}, {
      project_id: "project_1", asset_id: "asset_1", mode: "auto",
    });
    expect(fetchWithUi).toHaveBeenCalledWith(
      "/api/v1/projects/project_1/assets/asset_1/preview-source",
      { method: "POST", body: JSON.stringify({ mode: "auto" }) },
    );
    expect(result).toEqual(sourceDescription);
  });

  it("get 请求体严格白名单（profile/mode/generate 可选）", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce(sourceDescription);
    await handlers.get("preview-source:get")?.({}, {
      project_id: "project_1", asset_id: "asset_1",
      profile_id: "preview-540-v1", mode: "proxy", generate: true,
    });
    expect(fetchWithUi).toHaveBeenCalledWith(
      "/api/v1/projects/project_1/assets/asset_1/preview-source",
      { method: "POST", body: JSON.stringify({ profile_id: "preview-540-v1", mode: "proxy", generate: true }) },
    );
    // 非法档位/模式/未知键拒绝
    await expect(handlers.get("preview-source:get")?.({}, {
      project_id: "project_1", asset_id: "asset_1", profile_id: "preview-999-v1",
    })).rejects.toThrow();
    await expect(handlers.get("preview-source:get")?.({}, {
      project_id: "project_1", asset_id: "asset_1", mode: "bogus",
    })).rejects.toThrow();
    await expect(handlers.get("preview-source:get")?.({}, {
      project_id: "project_1", asset_id: "asset_1", extra: 1,
    })).rejects.toThrow();
    await expect(handlers.get("preview-source:get")?.({}, {
      project_id: "../private", asset_id: "asset_1",
    })).rejects.toThrow("Invalid project_id");
  });

  it("get 响应剥离路径形态字段后经契约校验", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({ ...sourceDescription, path: "C:\\private\\proxy.mp4", uri: "file:///private" });
    const result = await handlers.get("preview-source:get")?.({}, {
      project_id: "project_1", asset_id: "asset_1",
    }) as Record<string, unknown>;
    expect(result.path).toBeUndefined();
    expect(result.uri).toBeUndefined();
    expect(result.source_id).toBe(sourceDescription.source_id);
  });

  it("jobs 走 UI 通道登记作业并校验响应", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({ job_id: "job_1", cache_key: hashA, status: "queued" });
    const result = await handlers.get("preview-source:jobs")?.({}, {
      project_id: "project_1", asset_id: "asset_1",
    });
    expect(fetchWithUi).toHaveBeenCalledWith(
      "/api/v1/projects/project_1/assets/asset_1/preview-source/jobs",
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(result).toEqual({ job_id: "job_1", cache_key: hashA, status: "queued" });
    await expect(handlers.get("preview-source:jobs")?.({}, {
      project_id: "project_1", asset_id: "asset_1", extra: 1,
    })).rejects.toThrow();
  });

  it("media 经 admin resolve 换票据：Renderer 只拿 URL，不拿路径", async () => {
    const { handlers, fetchWithUi, resolvePreviewSourceMedia, registerDerivedMedia } = setup();
    const path = "C:\\data\\cache\\derived\\video_proxy\\aa\\key\\proxy.mp4";
    resolvePreviewSourceMedia.mockResolvedValueOnce({ cache_key: hashA, status: "ready", path, size_bytes: 4096 });
    const result = await handlers.get("preview-source:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1", profile_id: "preview-720-v1",
    }) as { media_url: string; cache_key: string; status: string; size_bytes: number };
    expect(fetchWithUi).not.toHaveBeenCalled(); // 不走 UI 通道
    expect(resolvePreviewSourceMedia).toHaveBeenCalledWith({
      project_id: "project_1", asset_id: "asset_1", profile_id: "preview-720-v1",
    });
    expect(registerDerivedMedia).toHaveBeenCalledWith(hashA, path);
    expect(result.media_url).toBe("aivideo://media/ticket-url-value");
    expect(result.status).toBe("ready");
    expect(JSON.stringify(result)).not.toContain("C:");
  });

  it("media 未 ready 或非法请求被拒，不泄路径", async () => {
    const { handlers, resolvePreviewSourceMedia, registerDerivedMedia } = setup();
    resolvePreviewSourceMedia.mockResolvedValueOnce({ cache_key: hashA, status: "building", path: "C:/private", size_bytes: 0 });
    await expect(handlers.get("preview-source:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1", profile_id: "preview-720-v1",
    })).rejects.toThrow("DERIVED_NOT_FOUND");
    registerDerivedMedia.mockClear();
    resolvePreviewSourceMedia.mockRejectedValueOnce(Object.assign(new Error("private"), { code: "DERIVED_NOT_FOUND" }));
    await expect(handlers.get("preview-source:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1", profile_id: "preview-720-v1",
    })).rejects.toThrow("DERIVED_NOT_FOUND");
    // 缺档位拒绝
    await expect(handlers.get("preview-source:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1",
    })).rejects.toThrow();
    expect(registerDerivedMedia).not.toHaveBeenCalled();
  });
});


describe("B14 waveform IPC", () => {
  const wfDescription = {
    cache_key: hashA, status: "queued", job_id: "job_wf", size_bytes: null,
    sample_rate: 8000, channels: 1, bucket: 256,
  };

  it("get 走 UI 通道并返回契约校验后的描述（无路径字段）", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce(wfDescription);
    const result = await handlers.get("waveform:get")?.({}, {
      project_id: "project_1", asset_id: "asset_1", generate: true,
    });
    expect(fetchWithUi).toHaveBeenCalledWith(
      "/api/v1/projects/project_1/assets/asset_1/waveform",
      { method: "POST", body: JSON.stringify({ generate: true }) },
    );
    expect(result).toEqual(wfDescription);
  });

  it("get 请求体严格白名单，非法值拒绝且不触发 fetch", async () => {
    const { handlers, fetchWithUi } = setup();
    await expect(handlers.get("waveform:get")?.({}, {
      project_id: "project_1", asset_id: "asset_1", extra: 1,
    })).rejects.toThrow();
    await expect(handlers.get("waveform:get")?.({}, {
      project_id: "../private", asset_id: "asset_1",
    })).rejects.toThrow("Invalid project_id");
    await expect(handlers.get("waveform:get")?.({}, {
      project_id: "project_1", asset_id: "asset_1", generate: "yes",
    })).rejects.toThrow();
    expect(fetchWithUi).not.toHaveBeenCalled();
  });

  it("get 响应剥离路径形态字段后经契约校验", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({ ...wfDescription, path: "C:\private\wf.bin", uri: "file:///private" });
    const result = await handlers.get("waveform:get")?.({}, {
      project_id: "project_1", asset_id: "asset_1",
    }) as Record<string, unknown>;
    expect(result.path).toBeUndefined();
    expect(result.uri).toBeUndefined();
    expect(result.cache_key).toBe(hashA);
  });

  it("media 经 admin resolve 换票据：Renderer 只拿 URL，不拿路径", async () => {
    const { handlers, fetchWithUi, resolveWaveformMedia, registerDerivedMedia } = setup();
    const path = "C:\data\cache\derived\waveforma\key\waveform.bin";
    resolveWaveformMedia.mockResolvedValueOnce({ cache_key: hashA, status: "ready", path, size_bytes: 4096 });
    const result = await handlers.get("waveform:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1",
    }) as { media_url: string; cache_key: string; status: string; size_bytes: number };
    expect(fetchWithUi).not.toHaveBeenCalled(); // 不走 UI 通道
    expect(resolveWaveformMedia).toHaveBeenCalledWith({
      project_id: "project_1", asset_id: "asset_1",
    });
    expect(registerDerivedMedia).toHaveBeenCalledWith(hashA, path);
    expect(result.media_url).toBe("aivideo://media/ticket-url-value");
    expect(result.status).toBe("ready");
    expect(JSON.stringify(result)).not.toContain("C:");
  });

  it("media 未 ready / 无音频 / 非法请求被拒，不泄路径", async () => {
    const { handlers, resolveWaveformMedia, registerDerivedMedia } = setup();
    resolveWaveformMedia.mockResolvedValueOnce({ cache_key: hashA, status: "building", path: "C:/private", size_bytes: 0 });
    await expect(handlers.get("waveform:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1",
    })).rejects.toThrow("DERIVED_NOT_FOUND");
    registerDerivedMedia.mockClear();
    resolveWaveformMedia.mockRejectedValueOnce(Object.assign(new Error("private"), { code: "MEDIA_NO_AUDIO" }));
    await expect(handlers.get("waveform:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1",
    })).rejects.toThrow("MEDIA_NO_AUDIO");
    // 未知键拒绝
    await expect(handlers.get("waveform:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1", kind: "waveform",
    })).rejects.toThrow();
    expect(registerDerivedMedia).not.toHaveBeenCalled();
  });
});


describe("B15 pcm-chunk IPC", () => {
  const chunkDescription = {
    cache_key: hashA, status: "ready" as const, start_sample: 96_000,
    valid_samples: 96_000, sample_rate: 48000, channels: 2,
    chunk_samples: 96_000, size_bytes: 768_012,
  };

  it("ensure 走 UI 通道并返回契约校验后的描述（无路径字段）", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce(chunkDescription);
    const result = await handlers.get("pcm-chunk:ensure")?.({}, {
      project_id: "project_1", asset_id: "asset_1", start_sample: 96_000,
    });
    expect(fetchWithUi).toHaveBeenCalledWith(
      "/api/v1/projects/project_1/assets/asset_1/pcm-chunks",
      { method: "POST", body: JSON.stringify({ start_sample: 96_000 }) },
    );
    expect(result).toEqual(chunkDescription);
  });

  it("ensure 严格拒绝未对齐/非法 start_sample 与未知键", async () => {
    const { handlers, fetchWithUi } = setup();
    await expect(handlers.get("pcm-chunk:ensure")?.({}, {
      project_id: "project_1", asset_id: "asset_1", start_sample: 12345,
    })).rejects.toThrow("Invalid start_sample");
    await expect(handlers.get("pcm-chunk:ensure")?.({}, {
      project_id: "project_1", asset_id: "asset_1", start_sample: -96_000,
    })).rejects.toThrow("Invalid start_sample");
    await expect(handlers.get("pcm-chunk:ensure")?.({}, {
      project_id: "project_1", asset_id: "asset_1", start_sample: 1.5,
    })).rejects.toThrow("Invalid start_sample");
    await expect(handlers.get("pcm-chunk:ensure")?.({}, {
      project_id: "project_1", asset_id: "asset_1", start_sample: 96_000, extra: 1,
    })).rejects.toThrow();
    await expect(handlers.get("pcm-chunk:ensure")?.({}, {
      project_id: "../private", asset_id: "asset_1", start_sample: 96_000,
    })).rejects.toThrow("Invalid project_id");
    expect(fetchWithUi).not.toHaveBeenCalled();
  });

  it("ensure 响应剥离路径形态字段后经契约校验", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({ ...chunkDescription, path: "C:\private\chunk.pcm" });
    const result = await handlers.get("pcm-chunk:ensure")?.({}, {
      project_id: "project_1", asset_id: "asset_1", start_sample: 96_000,
    }) as Record<string, unknown>;
    expect(result.path).toBeUndefined();
    expect(result.cache_key).toBe(hashA);
  });

  it("media 经 admin resolve 换票据：Renderer 只拿 URL，不拿路径", async () => {
    const { handlers, fetchWithUi, resolvePcmChunkMedia, registerDerivedMedia } = setup();
    const path = "C:\data\cache\derived\audio_pcm_chunk\aa\key\chunk.pcm";
    resolvePcmChunkMedia.mockResolvedValueOnce({ cache_key: hashA, status: "ready", path, size_bytes: 768_012 });
    const result = await handlers.get("pcm-chunk:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1", start_sample: 96_000,
    }) as { media_url: string; cache_key: string; status: string; size_bytes: number };
    expect(fetchWithUi).not.toHaveBeenCalled(); // 不走 UI 通道
    expect(resolvePcmChunkMedia).toHaveBeenCalledWith({
      project_id: "project_1", asset_id: "asset_1", start_sample: 96_000,
    });
    expect(registerDerivedMedia).toHaveBeenCalledWith(hashA, path);
    expect(result.media_url).toBe("aivideo://media/ticket-url-value");
    expect(result.status).toBe("ready");
    expect(JSON.stringify(result)).not.toContain("C:");
  });

  it("media 未 ready / 网格非法被拒，不泄路径", async () => {
    const { handlers, resolvePcmChunkMedia, registerDerivedMedia } = setup();
    resolvePcmChunkMedia.mockResolvedValueOnce({ cache_key: hashA, status: "building", path: "C:/private", size_bytes: 0 });
    await expect(handlers.get("pcm-chunk:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1", start_sample: 96_000,
    })).rejects.toThrow("DERIVED_NOT_FOUND");
    registerDerivedMedia.mockClear();
    resolvePcmChunkMedia.mockRejectedValueOnce(Object.assign(new Error("private"), { code: "PCM_CHUNK_OFFSET_INVALID" }));
    await expect(handlers.get("pcm-chunk:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1", start_sample: 96_000,
    })).rejects.toThrow("PCM_CHUNK_OFFSET_INVALID");
    await expect(handlers.get("pcm-chunk:media")?.({}, {
      project_id: "project_1", asset_id: "asset_1", start_sample: 42,
    })).rejects.toThrow("Invalid start_sample");
    expect(registerDerivedMedia).not.toHaveBeenCalled();
  });
});

describe("C20 窗口化 IR v2 IPC", () => {
  const manifestId = `${hashA}@authoritative_preview@preview-169-v1`;
  const manifest = {
    schema: "preview-ir-v2", projector_version: 1, manifest_id: manifestId,
    timeline_revision_id: "rev_1", content_fingerprint: hashA,
    fps_num: 30, fps_den: 1, total_frames: 90, duration_us: 3_000_000,
    canvas: { width: 960, height: 540, fps: 30 },
    inputs: [{ input_id: "I0", asset_id: "asset_1", asset_kind: "video" }],
    segments: [], captions: [], caption_styles: {},
    transition_windows: [], known_approximations: [],
  };

  it("manifest 走 UI 通道并返回契约校验后的 DTO（无路径字段）", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce(manifest);
    const result = await handlers.get("preview-ir-v2:manifest")?.({}, {
      project_id: "project_1", timeline_revision_id: "rev_1", output_ratio: "169",
    });
    expect(fetchWithUi).toHaveBeenCalledWith(
      "/api/v1/projects/project_1/preview-ir-v2/manifest?timeline_revision_id=rev_1&output_ratio=169",
      undefined,
    );
    expect(result).toEqual(manifest);
  });

  it("window 走 UI 通道（start/frame_count query）并校验响应", async () => {
    const { handlers, fetchWithUi } = setup();
    const window = {
      schema: "preview-ir-v2", manifest_id: manifestId,
      start_frame: 30, frame_count: 2,
      frames: [{ n: 30, t_us: 1_000_000, main: { kind: "black" }, overlays: [], captions: [] },
               { n: 31, t_us: 1_033_333, main: { kind: "black" }, overlays: [], captions: [] }],
    };
    fetchWithUi.mockResolvedValueOnce(window);
    const result = await handlers.get("preview-ir-v2:window")?.({}, {
      project_id: "project_1", start_frame: 30, frame_count: 2,
    });
    expect(fetchWithUi).toHaveBeenCalledWith(
      "/api/v1/projects/project_1/preview-ir-v2/window?start_frame=30&frame_count=2",
      undefined,
    );
    expect(result).toEqual(window);
  });

  it("manifest/window 严格拒绝未知键/非法参数/越界 frame_count", async () => {
    const { handlers, fetchWithUi } = setup();
    await expect(handlers.get("preview-ir-v2:manifest")?.({}, {
      project_id: "project_1", extra: 1,
    })).rejects.toThrow();
    await expect(handlers.get("preview-ir-v2:manifest")?.({}, {
      project_id: "../private",
    })).rejects.toThrow("Invalid project_id");
    await expect(handlers.get("preview-ir-v2:window")?.({}, {
      project_id: "project_1", start_frame: -1, frame_count: 10,
    })).rejects.toThrow();
    await expect(handlers.get("preview-ir-v2:window")?.({}, {
      project_id: "project_1", start_frame: 0, frame_count: 301,
    })).rejects.toThrow();
    await expect(handlers.get("preview-ir-v2:window")?.({}, {
      project_id: "project_1", start_frame: 0, frame_count: 0,
    })).rejects.toThrow();
    await expect(handlers.get("preview-ir-v2:window")?.({}, {
      project_id: "project_1", start_frame: 0,
    })).rejects.toThrow("Invalid window parameters");
    expect(fetchWithUi).not.toHaveBeenCalled();
  });

  it("响应含路径形态字段被剥离（Renderer 不收路径）；非法形状被拒", async () => {
    const { handlers, fetchWithUi } = setup();
    // path 字段被 rendererSafe 剥离后通过契约校验（与 B10/B14/B15 通道同语义）
    fetchWithUi.mockResolvedValueOnce({ ...manifest, path: "C:\\private\\ir.json" });
    const result = await handlers.get("preview-ir-v2:manifest")?.({}, { project_id: "project_1" }) as Record<string, unknown>;
    expect(result.path).toBeUndefined();
    expect(result).toEqual(manifest);
    fetchWithUi.mockReset();
    // frames.length !== frame_count → 拒绝
    fetchWithUi.mockResolvedValueOnce({ schema: "preview-ir-v2", manifest_id: manifestId, start_frame: 0, frame_count: 2, frames: [] });
    await expect(handlers.get("preview-ir-v2:window")?.({}, {
      project_id: "project_1", start_frame: 0, frame_count: 2,
    })).rejects.toThrow();
    fetchWithUi.mockReset();
    // schema 不匹配（v1 形状冒充 v2）→ 拒绝
    fetchWithUi.mockResolvedValueOnce({ ...manifest, schema: "preview-ir-v1" });
    await expect(handlers.get("preview-ir-v2:manifest")?.({}, { project_id: "project_1" })).rejects.toThrow();
  });
});
