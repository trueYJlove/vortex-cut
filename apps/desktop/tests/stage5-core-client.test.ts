import { describe, expect, it, vi } from "vitest";
import { CoreClient } from "../src/lib/core-client.js";

const now = "2026-08-20T00:00:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
const hashC = `sha256:${"c".repeat(64)}`;
function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}
const asset = {
  asset_id: "asset_1", kind: "image", availability: "available",
  fingerprint: hashA, width: 1024, height: 1024,
};
const preview = {
  preview_id: "assembly_preview_1", project_id: "project_1",
  shot_list_revision_id: "shot_revision_1", shot_requirement_id: "requirement_1",
  adoption_id: "adoption_1", asset,
  base_timeline_revision_id: "timeline_revision_1", base_document_sha256: hashA,
  proposed_clip_id: "clip_stage5_1", at_index: 1, duration_us: 3_000_000,
  layout: "fit", proposed_document_sha256: hashB, preview_sha256: hashC,
  clip_count_before: 1, shifted_clip_count: 0, shifted_caption_count: 0,
  duration_before_us: 5_000_000, duration_after_us: 8_000_000,
  expires_at: now, created_at: now,
};
const assembly = {
  assembly_id: "assembly_1", project_id: "project_1",
  shot_list_revision_id: "shot_revision_1", shot_requirement_id: "requirement_1",
  adoption_id: "adoption_1", asset_id: "asset_1",
  assembly_preview_id: "assembly_preview_1",
  base_timeline_revision_id: "timeline_revision_1",
  output_timeline_revision_id: "timeline_revision_2",
  proposed_clip_id: "clip_stage5_1", proposed_document_sha256: hashB,
  created_at: now,
};

describe("Stage 5 CoreClient", () => {
  it("使用五条冻结路由，Prepare/Apply 仅发送冻结字段", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(preview))
      .mockResolvedValueOnce(response({ assembly, reused: false }))
      .mockResolvedValueOnce(response(preview))
      .mockResolvedValueOnce(response(assembly))
      .mockResolvedValueOnce(response({ items: [assembly], next_cursor: null }));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    const projectId = "project_1" as never;
    const requirementId = "requirement_1" as never;

    await client.prepareShotRequirementTimelineAssembly(projectId, requirementId, {
      expected_adoption_id: "adoption_1" as never,
      base_timeline_revision_id: "timeline_revision_1" as never,
      at_index: 1, duration_us: 3_000_000, layout: "fit",
    });
    await client.applyShotRequirementTimelineAssembly(projectId, requirementId, {
      assembly_preview_id: "assembly_preview_1" as never,
      proposed_document_sha256: hashB, confirmed: true,
    });
    await client.getShotRequirementTimelineAssemblyPreview("assembly_preview_1");
    await client.getShotRequirementTimelineAssembly("assembly_1");
    await client.listShotRequirementTimelineAssemblies(projectId, requirementId, { limit: 20, cursor: "2" });

    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
      "http://127.0.0.1:4000/api/v1/projects/project_1/shot-requirements/requirement_1/timeline-assemblies/prepare",
      "http://127.0.0.1:4000/api/v1/projects/project_1/shot-requirements/requirement_1/timeline-assemblies",
      "http://127.0.0.1:4000/api/v1/shot-requirement-timeline-assembly-previews/assembly_preview_1",
      "http://127.0.0.1:4000/api/v1/shot-requirement-timeline-assemblies/assembly_1",
      "http://127.0.0.1:4000/api/v1/projects/project_1/shot-requirements/requirement_1/timeline-assemblies?limit=20&cursor=2",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({
      expected_adoption_id: "adoption_1", base_timeline_revision_id: "timeline_revision_1",
      at_index: 1, duration_us: 3_000_000, layout: "fit",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1].body))).toEqual({
      assembly_preview_id: "assembly_preview_1", proposed_document_sha256: hashB, confirmed: true,
    });
    expect(JSON.stringify(fetchImpl.mock.calls.slice(0, 2))).not.toMatch(/prompt|document"|absolute_path|provider/i);
  });

  it("响应先清敏，且不向 Renderer 返回 Document、路径或正文", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({
        ...preview, document: { private: true }, absolute_path: "C:\\private\\image.png",
        prompt: "PROMPT_SENTINEL_STAGE5", raw_exception: { message: "private" },
      }))
      .mockResolvedValueOnce(response({ items: [{ ...assembly, transcript: "PRIVATE_TRANSCRIPT" }], next_cursor: null }));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    const prepared = await client.prepareShotRequirementTimelineAssembly("project_1" as never, "requirement_1" as never, {
      expected_adoption_id: "adoption_1" as never,
      base_timeline_revision_id: "timeline_revision_1" as never,
      at_index: 1, duration_us: 3_000_000, layout: "fit",
    });
    const page = await client.listShotRequirementTimelineAssemblies("project_1" as never, "requirement_1" as never);
    const rendererValue = JSON.stringify({ prepared, page });
    expect(rendererValue).not.toMatch(/PROMPT_SENTINEL|PRIVATE_TRANSCRIPT|private\\image|raw_exception|document"/i);
  });
});
