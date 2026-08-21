import { describe, expect, it, vi } from "vitest";
import { registerStage6rIpc } from "../electron/main/stage6r-ipc.js";

const sha = `sha256:${"a".repeat(64)}`;
const now = "2026-08-21T00:00:00.000Z";
const asset = {
  asset_id: "asset_1", kind: "image", availability: "available",
  fingerprint: sha, width: 1024, height: 1024,
};
const previewItem = (index: number) => ({
  item_index: index, shot_requirement_id: `requirement_${index + 1}`,
  adoption_id: `adoption_${index + 1}`, asset, proposed_clip_id: `clip_${index + 1}`,
  duration_us: 2_000_000, layout: "fit", item_sha256: sha, created_at: now,
});
const preview = {
  preview_id: "preview_1", project_id: "project_1", shot_list_revision_id: "shot_revision_1",
  base_timeline_revision_id: "timeline_1", base_document_sha256: sha, at_index: 0,
  item_count: 2, items: [previewItem(0), previewItem(1)], proposed_document_sha256: sha,
  preview_sha256: sha, clip_count_before: 0, clip_count_after: 2,
  shifted_clip_count: 0, shifted_caption_count: 0, duration_before_us: 0,
  duration_after_us: 4_000_000, expires_at: now, created_at: now,
};
const assembly = {
  batch_assembly_id: "batch_1", project_id: "project_1",
  shot_list_revision_id: "shot_revision_1", batch_preview_id: "preview_1",
  base_timeline_revision_id: "timeline_1", output_timeline_revision_id: "timeline_2",
  proposed_document_sha256: sha, item_count: 2, created_at: now,
};
const assemblyItem = {
  item_index: 0, shot_requirement_id: "requirement_1", adoption_id: "adoption_1",
  asset_id: "asset_1", proposed_clip_id: "clip_1", duration_us: 2_000_000,
  layout: "fit", created_at: now,
};
const prepareRequest = {
  base_timeline_revision_id: "timeline_1", at_index: 0,
  items: [
    { requirement_id: "requirement_1", expected_adoption_id: "adoption_1", duration_us: 2_000_000, layout: "fit" },
    { requirement_id: "requirement_2", expected_adoption_id: "adoption_2", duration_us: 2_000_000, layout: "fit" },
  ],
};
const applyRequest = {
  batch_preview_id: "preview_1", proposed_document_sha256: sha, confirmed: true,
};
type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
function setup() {
  const handlers = new Map<string, Handler>();
  const fetchWithUi = vi.fn();
  registerStage6rIpc({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) }, fetchWithUi,
  });
  return { handlers, fetchWithUi };
}

describe("Stage 6-R Timeline Batch Assembly IPC", () => {
  it("只注册六个独立固定 channel", () => {
    expect([...setup().handlers.keys()]).toEqual([
      "stage6r:batch-assembly-prepare", "stage6r:batch-assembly-apply",
      "stage6r:batch-assembly-preview-get", "stage6r:batch-assembly-get",
      "stage6r:batch-assembly-list", "stage6r:batch-assembly-item-list",
    ]);
  });

  it("固定映射 Prepare、Apply、GET 和 list 路由", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ assembly, reused: false })
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(assembly)
      .mockResolvedValueOnce({ items: [assembly], next_cursor: null })
      .mockResolvedValueOnce({ items: [assemblyItem], next_cursor: null });
    await handlers.get("stage6r:batch-assembly-prepare")?.({}, { project_id: "project_1", request: prepareRequest });
    await handlers.get("stage6r:batch-assembly-apply")?.({}, { project_id: "project_1", request: applyRequest });
    await handlers.get("stage6r:batch-assembly-preview-get")?.({}, { preview_id: "preview_1" });
    await handlers.get("stage6r:batch-assembly-get")?.({}, { batch_id: "batch_1" });
    await handlers.get("stage6r:batch-assembly-list")?.({}, { project_id: "project_1", limit: 20, cursor: "0" });
    await handlers.get("stage6r:batch-assembly-item-list")?.({}, { batch_id: "batch_1", limit: 20, cursor: "0" });
    expect(fetchWithUi.mock.calls.map(call => call[0])).toEqual([
      "/api/v1/projects/project_1/shot-requirement-timeline-batch-assemblies/prepare",
      "/api/v1/projects/project_1/shot-requirement-timeline-batch-assemblies",
      "/api/v1/shot-requirement-timeline-batch-assembly-previews/preview_1",
      "/api/v1/shot-requirement-timeline-batch-assemblies/batch_1",
      "/api/v1/projects/project_1/shot-requirement-timeline-batch-assemblies?limit=20&cursor=0",
      "/api/v1/shot-requirement-timeline-batch-assemblies/batch_1/items?limit=20&cursor=0",
    ]);
    expect(JSON.parse(String(fetchWithUi.mock.calls[0][1].body))).not.toHaveProperty("prompt");
    expect(JSON.parse(String(fetchWithUi.mock.calls[1][1].body))).toEqual(applyRequest);
  });

  it("拒绝未知键、路径型 ID、Document、Prompt、非法分页和未确认 Apply", async () => {
    const { handlers, fetchWithUi } = setup();
    await expect(handlers.get("stage6r:batch-assembly-prepare")?.({}, {
      project_id: "project_1", extra: true, request: prepareRequest,
    })).rejects.toThrow();
    await expect(handlers.get("stage6r:batch-assembly-get")?.({}, {
      batch_id: "../private",
    })).rejects.toThrow("Invalid batch_id");
    await expect(handlers.get("stage6r:batch-assembly-item-list")?.({}, {
      batch_id: "batch_1", limit: 101,
    })).rejects.toThrow("Invalid limit");
    await expect(handlers.get("stage6r:batch-assembly-prepare")?.({}, {
      project_id: "project_1", request: { ...prepareRequest, document: {}, prompt: "private" },
    })).rejects.toThrow();
    await expect(handlers.get("stage6r:batch-assembly-apply")?.({}, {
      project_id: "project_1", request: { ...applyRequest, confirmed: false },
    })).rejects.toThrow();
    expect(fetchWithUi).not.toHaveBeenCalled();
  });

  it("清理响应敏感字段并仅透传稳定 Stage 6-R 错误码", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({
      ...preview, prompt: "PRIVATE", absolute_path: "C:/private.png", raw_exception: {},
    });
    const result = await handlers.get("stage6r:batch-assembly-prepare")?.({}, {
      project_id: "project_1", request: prepareRequest,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify(result)).not.toContain("private.png");
    fetchWithUi.mockRejectedValueOnce(Object.assign(new Error("raw"), {
      code: "STAGE6_BATCH_TIMELINE_CONFLICT",
    }));
    await expect(handlers.get("stage6r:batch-assembly-list")?.({}, { project_id: "project_1" }))
      .rejects.toThrow("STAGE6_BATCH_TIMELINE_CONFLICT");
    fetchWithUi.mockRejectedValueOnce(new Error("raw private exception"));
    await expect(handlers.get("stage6r:batch-assembly-list")?.({}, { project_id: "project_1" }))
      .rejects.toThrow("Core request failed");
  });
});
