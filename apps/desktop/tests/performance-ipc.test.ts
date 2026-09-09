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
  const registerDerivedMedia = vi.fn(() => "aivideo://media/ticket-url-value");
  registerPerformanceIpc({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    fetchWithUi,
    resolveDerived,
    registerDerivedMedia,
  });
  return { handlers, fetchWithUi, resolveDerived, registerDerivedMedia };
}

describe("B10 derived media IPC", () => {
  it("只注册三个白名单 channel", () => {
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual([
      "derived-media:lookup",
      "derived-media:stats",
      "derived-media:media",
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
