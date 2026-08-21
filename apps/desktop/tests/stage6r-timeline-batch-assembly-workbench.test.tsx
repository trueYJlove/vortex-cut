import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShotRequirement } from "@aivideo/contracts";
import type { DesktopApi } from "../electron/preload/index.js";
import { ShotRequirementTimelineBatchAssemblyPanel } from "../src/app/shot-requirements/ShotRequirementTimelineBatchAssemblyPanel.js";

const now = "2026-08-21T00:00:00.000Z";
const sha = `sha256:${"a".repeat(64)}`;
const requirements: ShotRequirement[] = [
  {
    shot_requirement_id: "requirement_000000000001" as never,
    shot_list_revision_id: "shot_revision_1" as never,
    ordinal: 0,
    title: "PRIVATE_TITLE_1",
    visual_direction: "PRIVATE_VISUAL_1",
    target_duration_us: null,
    visual: { requirement_kind: "image", source_asset_id: null },
    narration: null,
  },
  {
    shot_requirement_id: "requirement_000000000002" as never,
    shot_list_revision_id: "shot_revision_1" as never,
    ordinal: 1,
    title: "PRIVATE_TITLE_2",
    visual_direction: "PRIVATE_VISUAL_2",
    target_duration_us: null,
    visual: { requirement_kind: "image", source_asset_id: null },
    narration: null,
  },
];
function adoption(index: number) {
  return {
    adoption_id: `adoption_${index}` as never,
    project_id: "project_1" as never,
    shot_list_revision_id: "shot_revision_1" as never,
    shot_requirement_id: `requirement_00000000000${index}` as never,
    generation_link_id: `link_${index}` as never,
    task_id: `task_${index}` as never,
    asset_id: `asset_${index}` as never,
    adoption_ordinal: 1,
    previous_adoption_id: null,
    created_at: now,
  };
}
const timeline = {
  project_id: "project_1",
  current_revision: {
    timeline_revision_id: "timeline_revision_1",
    document: { clips: [{ clip_id: "clip_1" }, { clip_id: "clip_2" }] },
  },
};
const preview = {
  preview_id: "batch_preview_1",
  project_id: "project_1",
  shot_list_revision_id: "shot_revision_1",
  base_timeline_revision_id: "timeline_revision_1",
  base_document_sha256: sha,
  at_index: 1,
  item_count: 2,
  items: [0, 1].map(index => ({
    item_index: index,
    shot_requirement_id: `requirement_00000000000${index + 1}`,
    adoption_id: `adoption_${index + 1}`,
    asset: {
      asset_id: `asset_${index + 1}`, kind: "image", availability: "available",
      fingerprint: sha, width: 1024, height: 1024,
    },
    proposed_clip_id: `batch_clip_${index + 1}`,
    duration_us: 2_000_000,
    layout: "fit",
    item_sha256: sha,
    created_at: now,
  })),
  proposed_document_sha256: sha,
  preview_sha256: sha,
  clip_count_before: 2,
  clip_count_after: 4,
  shifted_clip_count: 1,
  shifted_caption_count: 2,
  duration_before_us: 5_000_000,
  duration_after_us: 9_000_000,
  expires_at: now,
  created_at: now,
};
const assembly = {
  batch_assembly_id: "batch_1",
  project_id: "project_1",
  shot_list_revision_id: "shot_revision_1",
  batch_preview_id: "batch_preview_1",
  base_timeline_revision_id: "timeline_revision_1",
  output_timeline_revision_id: "timeline_revision_2",
  proposed_document_sha256: sha,
  item_count: 2,
  created_at: now,
};
function desktopApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    getTimeline: vi.fn().mockResolvedValue(timeline),
    getShotRequirementImageFulfillment: vi.fn().mockImplementation(async (_input: { requirement_id: string }) => ({
      currently_confirmed: true,
      current_asset_availability: "available",
      current_adoption: adoption(Number(_input.requirement_id.slice(-1))),
    })),
    prepareShotRequirementTimelineBatchAssembly: vi.fn().mockResolvedValue(preview),
    applyShotRequirementTimelineBatchAssembly: vi.fn().mockResolvedValue({ assembly, reused: false }),
    ...overrides,
  } as unknown as DesktopApi;
}
function mount(desktop = desktopApi()) {
  window.desktop = desktop;
  render(<ShotRequirementTimelineBatchAssemblyPanel
    projectId={"project_1" as never}
    revisionId={"shot_revision_1" as never}
    requirements={requirements}
  />);
  return desktop;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Stage 6-R 已采用图片批量时间线装配 UI", () => {
  it("仅列出当前已确认且可用的 Adoption，并显示零副作用与 all-or-nothing 边界", async () => {
    const desktop = mount();
    expect(await screen.findByRole("button", { name: "准备批量时间线装配" })).toBeDisabled();
    expect(screen.getByText(/Provider 调用、网络外传和费用增量均为 0/)).toBeVisible();
    expect(screen.getByText(/all-or-nothing：任一条失败则全部不装配/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/PRIVATE_TITLE|PRIVATE_VISUAL/);
    expect(desktop.getShotRequirementImageFulfillment).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "准备批量时间线装配" })).toBeDisabled();
  });

  it("用户显式选择、排序、设置参数后，Prepare 只提交安全字段且不自动 Apply", async () => {
    const desktop = mount();
    fireEvent.click(await screen.findByRole("checkbox", { name: /requir.*0001/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /requir.*0002/ }));
    fireEvent.click(screen.getByRole("button", { name: "准备批量时间线装配" }));
    await waitFor(() => expect(desktop.prepareShotRequirementTimelineBatchAssembly).toHaveBeenCalledTimes(1));
    const request = vi.mocked(desktop.prepareShotRequirementTimelineBatchAssembly).mock.calls[0][0].request;
    expect(Object.keys(request)).toEqual(["base_timeline_revision_id", "at_index", "items"]);
    expect(request.items.map((item: { requirement_id: string }) => item.requirement_id)).toEqual([
      "requirement_000000000001", "requirement_000000000002",
    ]);
    expect(JSON.stringify(request)).not.toMatch(/prompt|document|caption|absolute_path/i);
    expect(desktop.applyShotRequirementTimelineBatchAssembly).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog", { name: "确认批量时间线装配" })).toHaveTextContent(
      "将以一个事务装配 2 个图片 Clip；任一条失败则全部不装配",
    );
  });

  it("用户显式排序后，Prepare 按新顺序提交并保持无正文输出", async () => {
    const desktop = mount();
    fireEvent.click(await screen.findByRole("checkbox", { name: /requir.*0001/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /requir.*0002/ }));
    fireEvent.click(screen.getByRole("button", { name: /下移 requir.*0001/ }));
    fireEvent.change(screen.getByLabelText("批量时间线起始插入位置"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/批量图片时长 requir.*0001/), { target: { value: "4.5" } });
    fireEvent.change(screen.getByLabelText(/批量图片布局 requir.*0001/), { target: { value: "crop_fill" } });
    fireEvent.click(screen.getByRole("button", { name: "准备批量时间线装配" }));
    await waitFor(() => expect(desktop.prepareShotRequirementTimelineBatchAssembly).toHaveBeenCalledTimes(1));
    expect(vi.mocked(desktop.prepareShotRequirementTimelineBatchAssembly).mock.calls[0][0].request).toEqual({
      base_timeline_revision_id: "timeline_revision_1",
      at_index: 1,
      items: [
        { requirement_id: "requirement_000000000002", expected_adoption_id: "adoption_2", duration_us: 3_000_000, layout: "fit" },
        { requirement_id: "requirement_000000000001", expected_adoption_id: "adoption_1", duration_us: 4_500_000, layout: "crop_fill" },
      ],
    });
    expect(document.body.textContent).not.toMatch(/PRIVATE_TITLE|PRIVATE_VISUAL/);
  });

  it("Prepare 后仍需显式确认 Apply，成功后刷新 Timeline；失败只显示固定安全错误", async () => {
    const desktop = mount();
    fireEvent.click(await screen.findByRole("checkbox", { name: /requir.*0001/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /requir.*0002/ }));
    fireEvent.click(screen.getByRole("button", { name: "准备批量时间线装配" }));
    expect(await screen.findByRole("dialog", { name: "确认批量时间线装配" })).toBeVisible();
    expect(desktop.applyShotRequirementTimelineBatchAssembly).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "显式确认批量装配" }));
    await waitFor(() => expect(desktop.applyShotRequirementTimelineBatchAssembly).toHaveBeenCalledWith({
      project_id: "project_1",
      request: {
        batch_preview_id: "batch_preview_1",
        proposed_document_sha256: sha,
        confirmed: true,
      },
    }));
    expect(await screen.findByText("批量图片已装配为一个新 Timeline Revision。请前往时间线查看。")).toBeVisible();
    expect(desktop.getTimeline).toHaveBeenCalledTimes(2);
    cleanup();

    const rejected = desktopApi({
      prepareShotRequirementTimelineBatchAssembly: vi.fn().mockRejectedValue(
        new Error("STAGE6_BATCH_TIMELINE_CONFLICT C:\\private\\media.png PRIVATE_PROMPT"),
      ),
    });
    mount(rejected);
    fireEvent.click(await screen.findByRole("checkbox", { name: /requir.*0001/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /requir.*0002/ }));
    fireEvent.click(screen.getByRole("button", { name: "准备批量时间线装配" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("批量时间线装配未完成；请刷新时间线和采用结果后重试。");
    expect(document.body.textContent).not.toMatch(/private\\media|PRIVATE_PROMPT|STAGE6_BATCH_TIMELINE_CONFLICT/i);
  });
});




