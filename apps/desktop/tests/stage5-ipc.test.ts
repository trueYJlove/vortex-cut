import { describe, expect, it, vi } from "vitest";
import { registerStage5Ipc } from "../electron/main/stage5-ipc.js";

const sha = `sha256:${"a".repeat(64)}`;
const now = "2026-08-20T00:00:00.000Z";
const asset = {
  asset_id: "asset_1", kind: "image", availability: "available",
  fingerprint: sha, width: 1024, height: 1024,
};
const preview = {
  preview_id: "preview_1", project_id: "project_1", shot_list_revision_id: "shot_revision_1",
  shot_requirement_id: "requirement_1", adoption_id: "adoption_1", asset,
  base_timeline_revision_id: "timeline_1", base_document_sha256: sha,
  proposed_clip_id: "clip_1", at_index: 0, duration_us: 2_000_000, layout: "fit",
  proposed_document_sha256: sha, preview_sha256: sha, clip_count_before: 0,
  shifted_clip_count: 0, shifted_caption_count: 0, duration_before_us: 0,
  duration_after_us: 2_000_000, expires_at: now, created_at: now,
};
const assembly = {
  assembly_id: "assembly_1", project_id: "project_1", shot_list_revision_id: "shot_revision_1",
  shot_requirement_id: "requirement_1", adoption_id: "adoption_1", asset_id: "asset_1",
  assembly_preview_id: "preview_1", base_timeline_revision_id: "timeline_1",
  output_timeline_revision_id: "timeline_2", proposed_clip_id: "clip_1",
  proposed_document_sha256: sha, created_at: now,
};
type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
function setup() {
  const handlers = new Map<string, Handler>();
  const fetchWithUi = vi.fn();
  registerStage5Ipc({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) }, fetchWithUi,
  });
  return { handlers, fetchWithUi };
}

describe("Stage 5 Timeline Assembly IPC", () => {
  it("只注册五个独立固定 channel", () => {
    expect([...setup().handlers.keys()]).toEqual([
      "stage5:assembly-prepare", "stage5:assembly-apply", "stage5:assembly-preview-get",
      "stage5:assembly-get", "stage5:assembly-list",
    ]);
  });

  it("固定映射 Prepare、Apply、GET 和 list 路由", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce(preview).mockResolvedValueOnce({ assembly, reused: false })
      .mockResolvedValueOnce(preview).mockResolvedValueOnce(assembly)
      .mockResolvedValueOnce({ items: [assembly], next_cursor: null });
    const identity = { project_id: "project_1", requirement_id: "requirement_1" };
    await handlers.get("stage5:assembly-prepare")?.({}, { ...identity, request: {
      expected_adoption_id: "adoption_1", base_timeline_revision_id: "timeline_1",
      at_index: 0, duration_us: null, layout: "fit",
    } });
    await handlers.get("stage5:assembly-apply")?.({}, { ...identity, request: {
      assembly_preview_id: "preview_1", proposed_document_sha256: sha, confirmed: true,
    } });
    await handlers.get("stage5:assembly-preview-get")?.({}, { preview_id: "preview_1" });
    await handlers.get("stage5:assembly-get")?.({}, { assembly_id: "assembly_1" });
    await handlers.get("stage5:assembly-list")?.({}, { ...identity, limit: 20, cursor: "0" });
    expect(fetchWithUi.mock.calls.map(call => call[0])).toEqual([
      "/api/v1/projects/project_1/shot-requirements/requirement_1/timeline-assemblies/prepare",
      "/api/v1/projects/project_1/shot-requirements/requirement_1/timeline-assemblies",
      "/api/v1/shot-requirement-timeline-assembly-previews/preview_1",
      "/api/v1/shot-requirement-timeline-assemblies/assembly_1",
      "/api/v1/projects/project_1/shot-requirements/requirement_1/timeline-assemblies?limit=20&cursor=0",
    ]);
    expect(JSON.parse(String(fetchWithUi.mock.calls[0][1].body))).not.toHaveProperty("prompt");
    expect(JSON.parse(String(fetchWithUi.mock.calls[1][1].body))).toEqual({
      assembly_preview_id: "preview_1", proposed_document_sha256: sha, confirmed: true,
    });
  });

  it("拒绝未知键、路径型 ID、Document、Prompt、非法分页和未确认 Apply", async () => {
    const { handlers, fetchWithUi } = setup();
    const identity = { project_id: "project_1", requirement_id: "requirement_1" };
    await expect(handlers.get("stage5:assembly-prepare")?.({}, { ...identity, extra: true,
      request: { expected_adoption_id: "adoption_1", base_timeline_revision_id: "timeline_1",
        at_index: 0, duration_us: null, layout: "fit" } })).rejects.toThrow();
    await expect(handlers.get("stage5:assembly-get")?.({}, {
      assembly_id: "../private",
    })).rejects.toThrow("Invalid assembly_id");
    await expect(handlers.get("stage5:assembly-list")?.({}, {
      ...identity, limit: 101,
    })).rejects.toThrow("Invalid limit");
    await expect(handlers.get("stage5:assembly-prepare")?.({}, { ...identity, request: {
      expected_adoption_id: "adoption_1", base_timeline_revision_id: "timeline_1", at_index: 0,
      duration_us: null, layout: "fit", document: {}, prompt: "private",
    } })).rejects.toThrow();
    await expect(handlers.get("stage5:assembly-apply")?.({}, { ...identity, request: {
      assembly_preview_id: "preview_1", proposed_document_sha256: sha, confirmed: false,
    } })).rejects.toThrow();
    expect(fetchWithUi).not.toHaveBeenCalled();
  });

  it("清理响应敏感字段并仅透传稳定 Stage 5 错误码", async () => {
    const { handlers, fetchWithUi } = setup();
    const identity = { project_id: "project_1", requirement_id: "requirement_1" };
    fetchWithUi.mockResolvedValueOnce({
      ...preview, prompt: "PRIVATE", absolute_path: "C:/private.png", raw_exception: {},
    });
    const result = await handlers.get("stage5:assembly-prepare")?.({}, { ...identity, request: {
      expected_adoption_id: "adoption_1", base_timeline_revision_id: "timeline_1",
      at_index: 0, duration_us: null, layout: "fit",
    } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify(result)).not.toContain("private.png");
    fetchWithUi.mockRejectedValueOnce(Object.assign(new Error("raw"), {
      code: "STAGE5_TIMELINE_CONFLICT",
    }));
    await expect(handlers.get("stage5:assembly-list")?.({}, identity))
      .rejects.toThrow("STAGE5_TIMELINE_CONFLICT");
    fetchWithUi.mockRejectedValueOnce(new Error("raw private exception"));
    await expect(handlers.get("stage5:assembly-list")?.({}, identity))
      .rejects.toThrow("Core request failed");
  });
});
