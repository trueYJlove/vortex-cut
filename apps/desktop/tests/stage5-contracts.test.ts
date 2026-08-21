import {
  CONTRACT_VERSION,
  isShotRequirementTimelineAssembly,
  isShotRequirementTimelineAssemblyApplyInput,
  isShotRequirementTimelineAssemblyApplyResponse,
  isShotRequirementTimelineAssemblyPage,
  isShotRequirementTimelineAssemblyPrepareInput,
  isShotRequirementTimelineAssemblyPreview,
} from "@aivideo/contracts";
import { describe, expect, it } from "vitest";

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

describe("Stage 5 契约", () => {
  it("冻结 stage5-v1 且严格校验 Prepare 与 Apply", () => {
    expect(CONTRACT_VERSION).toBe("stage6r-v1");
    expect(isShotRequirementTimelineAssemblyPrepareInput({
      expected_adoption_id: "adoption_1", base_timeline_revision_id: "timeline_1",
      at_index: 0, duration_us: null, layout: "fit",
    })).toBe(true);
    expect(isShotRequirementTimelineAssemblyPrepareInput({
      expected_adoption_id: "adoption_1", base_timeline_revision_id: "timeline_1",
      at_index: 0, duration_us: 499_999, layout: "fit",
    })).toBe(false);
    expect(isShotRequirementTimelineAssemblyApplyInput({
      assembly_preview_id: "preview_1", proposed_document_sha256: sha, confirmed: true,
    })).toBe(true);
    expect(isShotRequirementTimelineAssemblyApplyInput({
      assembly_preview_id: "preview_1", proposed_document_sha256: sha, confirmed: false,
    })).toBe(false);
  });

  it("DTO 精确白名单并拒绝正文、路径、Document 和 Provider 字段", () => {
    expect(isShotRequirementTimelineAssemblyPreview(preview)).toBe(true);
    for (const leak of [
      { prompt: "private" }, { absolute_path: "C:/private.png" },
      { document: { clips: [] } }, { provider: "remote" },
    ]) expect(isShotRequirementTimelineAssemblyPreview({ ...preview, ...leak })).toBe(false);
    expect(isShotRequirementTimelineAssembly({ ...assembly })).toBe(true);
    expect(isShotRequirementTimelineAssembly({ ...assembly, caption: "private" })).toBe(false);
    expect(isShotRequirementTimelineAssemblyApplyResponse({ assembly, reused: false })).toBe(true);
    expect(isShotRequirementTimelineAssemblyPage({ items: [assembly], next_cursor: null })).toBe(true);
  });
});
