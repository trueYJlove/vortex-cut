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
  const registerDerivedMedia = vi.fn(() => "aivideo://media/ticket-url-value");
  registerPerformanceIpc({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    fetchWithUi,
    resolveDerived,
    resolvePreviewSourceMedia,
    registerDerivedMedia,
  });
  return { handlers, fetchWithUi, resolveDerived, resolvePreviewSourceMedia, registerDerivedMedia };
}

describe("B10 derived media IPC", () => {
  it("只注册六个白名单 channel（B10 三个 + B11 三个）", () => {
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual([
      "derived-media:lookup",
      "derived-media:stats",
      "derived-media:media",
      "preview-source:get",
      "preview-source:jobs",
      "preview-source:media",
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
