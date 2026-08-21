import {
  CONTRACT_VERSION,
  isShotRequirementTimelineBatchAssembly,
  isShotRequirementTimelineBatchAssemblyApplyInput,
  isShotRequirementTimelineBatchAssemblyApplyResponse,
  isShotRequirementTimelineBatchAssemblyItem,
  isShotRequirementTimelineBatchAssemblyItemPage,
  isShotRequirementTimelineBatchAssemblyPage,
  isShotRequirementTimelineBatchAssemblyPrepareInput,
  isShotRequirementTimelineBatchAssemblyPreview,
  isShotRequirementTimelineBatchAssemblyPreviewItem,
} from "@aivideo/contracts";
import { describe, expect, it } from "vitest";

const sha = `sha256:${"a".repeat(64)}`;
const now = "2026-08-21T00:00:00.000Z";
const asset = {
  asset_id: "asset_1",
  kind: "image",
  availability: "available",
  fingerprint: sha,
  width: 1024,
  height: 1024,
};
const itemInput = (index: number) => ({
  requirement_id: `requirement_${index}`,
  expected_adoption_id: `adoption_${index}`,
  duration_us: 2_000_000,
  layout: "fit",
});
const previewItem = (index: number) => ({
  item_index: index,
  shot_requirement_id: `requirement_${index}`,
  adoption_id: `adoption_${index}`,
  asset,
  proposed_clip_id: `clip_${index}`,
  duration_us: 2_000_000,
  layout: "fit",
  item_sha256: sha,
  created_at: now,
});
const prepareInput = {
  base_timeline_revision_id: "timeline_1",
  at_index: 0,
  items: [itemInput(1), itemInput(2)],
};
const preview = {
  preview_id: "preview_1",
  project_id: "project_1",
  shot_list_revision_id: "shot_revision_1",
  base_timeline_revision_id: "timeline_1",
  base_document_sha256: sha,
  at_index: 0,
  item_count: 2,
  items: [previewItem(0), previewItem(1)],
  proposed_document_sha256: sha,
  preview_sha256: sha,
  clip_count_before: 0,
  clip_count_after: 2,
  shifted_clip_count: 0,
  shifted_caption_count: 0,
  duration_before_us: 0,
  duration_after_us: 4_000_000,
  expires_at: now,
  created_at: now,
};
const assembly = {
  batch_assembly_id: "batch_1",
  project_id: "project_1",
  shot_list_revision_id: "shot_revision_1",
  batch_preview_id: "preview_1",
  base_timeline_revision_id: "timeline_1",
  output_timeline_revision_id: "timeline_2",
  proposed_document_sha256: sha,
  item_count: 2,
  created_at: now,
};
const assemblyItem = {
  item_index: 0,
  shot_requirement_id: "requirement_1",
  adoption_id: "adoption_1",
  asset_id: "asset_1",
  proposed_clip_id: "clip_1",
  duration_us: 2_000_000,
  layout: "fit",
  created_at: now,
};

describe("Stage 6-R 契约", () => {
  it("冻结 stage6r-v1 并校验批量数量、重复与输入边界", () => {
    expect(CONTRACT_VERSION).toBe("stage6r-v1");
    expect(isShotRequirementTimelineBatchAssemblyPrepareInput({
      ...prepareInput,
      items: Array.from({ length: 2 }, (_, index) => itemInput(index + 1)),
    })).toBe(true);
    expect(isShotRequirementTimelineBatchAssemblyPrepareInput({
      ...prepareInput,
      items: Array.from({ length: 24 }, (_, index) => itemInput(index + 1)),
    })).toBe(true);
    expect(isShotRequirementTimelineBatchAssemblyPrepareInput({
      ...prepareInput,
      items: [itemInput(1)],
    })).toBe(false);
    expect(isShotRequirementTimelineBatchAssemblyPrepareInput({
      ...prepareInput,
      items: Array.from({ length: 25 }, (_, index) => itemInput(index + 1)),
    })).toBe(false);
    expect(isShotRequirementTimelineBatchAssemblyPrepareInput({
      ...prepareInput,
      items: [itemInput(1), itemInput(1)],
    })).toBe(false);
    expect(isShotRequirementTimelineBatchAssemblyPrepareInput({
      ...prepareInput,
      items: [{ ...itemInput(1), duration_us: 499_999 }, itemInput(2)],
    })).toBe(false);
    expect(isShotRequirementTimelineBatchAssemblyPrepareInput({
      ...prepareInput,
      items: [{ ...itemInput(1), duration_us: 30_000_001 }, itemInput(2)],
    })).toBe(false);
    expect(isShotRequirementTimelineBatchAssemblyPrepareInput({
      ...prepareInput,
      items: [{ ...itemInput(1), layout: "centered" }, itemInput(2)],
    })).toBe(false);
  });

  it("Apply 必须显式确认且使用安全哈希", () => {
    const input = {
      batch_preview_id: "preview_1",
      proposed_document_sha256: sha,
      confirmed: true,
    };
    expect(isShotRequirementTimelineBatchAssemblyApplyInput(input)).toBe(true);
    expect(isShotRequirementTimelineBatchAssemblyApplyInput({ ...input, confirmed: false })).toBe(false);
    expect(isShotRequirementTimelineBatchAssemblyApplyInput({
      ...input,
      proposed_document_sha256: "not-a-sha",
    })).toBe(false);
  });

  it("Preview、Assembly、Apply 响应与分页使用严格白名单", () => {
    expect(isShotRequirementTimelineBatchAssemblyPreviewItem(previewItem(0))).toBe(true);
    expect(isShotRequirementTimelineBatchAssemblyPreview(preview)).toBe(true);
    expect(isShotRequirementTimelineBatchAssembly(assembly)).toBe(true);
    expect(isShotRequirementTimelineBatchAssemblyItem(assemblyItem)).toBe(true);
    expect(isShotRequirementTimelineBatchAssemblyApplyResponse({
      assembly,
      reused: false,
    })).toBe(true);
    expect(isShotRequirementTimelineBatchAssemblyPage({ items: [assembly], next_cursor: null })).toBe(true);
    expect(isShotRequirementTimelineBatchAssemblyItemPage({
      items: [assemblyItem],
      next_cursor: "1",
    })).toBe(true);

    expect(isShotRequirementTimelineBatchAssemblyPreview({
      ...preview,
      items: [{ ...previewItem(1), item_index: 2 }, previewItem(1)],
    })).toBe(false);
  });

  it("输出 DTO 拒绝正文、路径、Document 与原始异常字段", () => {
    for (const leak of [
      { prompt: "private" },
      { requirement: "private" },
      { absolute_path: "C:/private.png" },
      { caption: "private" },
      { document: { clips: [] } },
      { raw_exception: new Error("private") },
    ]) {
      expect(isShotRequirementTimelineBatchAssemblyPreview({ ...preview, ...leak })).toBe(false);
      expect(isShotRequirementTimelineBatchAssembly({ ...assembly, ...leak })).toBe(false);
      expect(isShotRequirementTimelineBatchAssemblyItem({ ...assemblyItem, ...leak })).toBe(false);
    }
  });
});
