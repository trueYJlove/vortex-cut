import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShotRequirementImageAdoption } from "@aivideo/contracts";
import type { DesktopApi } from "../electron/preload/index.js";
import { ShotRequirementTimelineAssemblyPanel } from "../src/app/shot-requirements/ShotRequirementTimelineAssemblyPanel.js";

const now = "2026-08-20T00:00:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
const hashC = `sha256:${"c".repeat(64)}`;
const adoption: ShotRequirementImageAdoption = {
  adoption_id: "adoption_1" as never, project_id: "project_1" as never,
  shot_list_revision_id: "shot_revision_1" as never,
  shot_requirement_id: "requirement_1" as never,
  generation_link_id: "link_1" as never, task_id: "task_1" as never,
  asset_id: "asset_1" as never, adoption_ordinal: 1,
  previous_adoption_id: null, created_at: now,
};
const timeline = {
  project_id: "project_1",
  current_revision: {
    timeline_revision_id: "timeline_revision_1",
    document: { clips: [{ clip_id: "clip_1" }, { clip_id: "clip_2" }] },
  },
};
const preview = {
  preview_id: "assembly_preview_1", project_id: "project_1",
  shot_list_revision_id: "shot_revision_1", shot_requirement_id: "requirement_1",
  adoption_id: "adoption_1",
  asset: { asset_id: "asset_1", kind: "image", availability: "available", fingerprint: hashA, width: 1024, height: 1024 },
  base_timeline_revision_id: "timeline_revision_1", base_document_sha256: hashA,
  proposed_clip_id: "clip_stage5_1", at_index: 1, duration_us: 4_500_000,
  layout: "crop_fill", proposed_document_sha256: hashB, preview_sha256: hashC,
  clip_count_before: 2, shifted_clip_count: 1, shifted_caption_count: 2,
  duration_before_us: 5_000_000, duration_after_us: 9_500_000,
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
function api(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    getTimeline: vi.fn().mockResolvedValue(timeline),
    listShotRequirementTimelineAssemblies: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    prepareShotRequirementTimelineAssembly: vi.fn().mockResolvedValue(preview),
    applyShotRequirementTimelineAssembly: vi.fn().mockResolvedValue({ assembly, reused: false }),
    ...overrides,
  } as unknown as DesktopApi;
}
function mount(desktop = api(), props: { available?: boolean; readOnly?: boolean } = {}) {
  window.desktop = desktop;
  render(<ShotRequirementTimelineAssemblyPanel
    projectId={"project_1" as never} requirementId={"requirement_1" as never}
    adoption={adoption} available={props.available ?? true} readOnly={props.readOnly ?? false}
  />);
  return desktop;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Stage 5 已采用图片时间线装配 UI", () => {
  it("加载当前 Timeline，并显示本地零 Provider 与非自动渲染边界", async () => {
    const desktop = mount();
    expect(await screen.findByRole("button", { name: "准备时间线装配" })).toBeEnabled();
    expect(screen.getByLabelText("时间线插入位置").querySelectorAll("option")).toHaveLength(3);
    expect(screen.getByText(/Provider 调用、网络外传和费用增量均为 0/)).toBeVisible();
    expect(screen.getByText(/不会自动预览、渲染或导出/)).toBeVisible();
    expect(desktop.getTimeline).toHaveBeenCalledWith("project_1");
    expect(desktop.listShotRequirementTimelineAssemblies).toHaveBeenCalledWith({
      project_id: "project_1", requirement_id: "requirement_1", limit: 100,
    });
  });

  it("Prepare 冻结 Adoption、Timeline、位置、时长和布局，并展示安全影响摘要", async () => {
    const desktop = mount();
    await screen.findByRole("button", { name: "准备时间线装配" });
    fireEvent.change(screen.getByLabelText("时间线插入位置"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("装配图片时长"), { target: { value: "4.5" } });
    fireEvent.change(screen.getByLabelText("装配图片布局"), { target: { value: "crop_fill" } });
    fireEvent.click(screen.getByRole("button", { name: "准备时间线装配" }));
    await waitFor(() => expect(desktop.prepareShotRequirementTimelineAssembly).toHaveBeenCalledWith({
      project_id: "project_1", requirement_id: "requirement_1",
      request: {
        expected_adoption_id: "adoption_1", base_timeline_revision_id: "timeline_revision_1",
        at_index: 1, duration_us: 4_500_000, layout: "crop_fill",
      },
    }));
    const dialog = await screen.findByRole("dialog", { name: "确认时间线装配" });
    expect(dialog).toHaveTextContent("现有 Clip 2 个，位移 1 个，字幕位移 2 个");
    expect(dialog).toHaveTextContent("5s → 9.5s");
    expect(desktop.applyShotRequirementTimelineAssembly).not.toHaveBeenCalled();
  });

  it("只有显式确认后才 Apply，且只发送 Preview ID、hash 和 confirmed", async () => {
    const desktop = mount();
    fireEvent.click(await screen.findByRole("button", { name: "准备时间线装配" }));
    expect(await screen.findByRole("dialog", { name: "确认时间线装配" })).toBeVisible();
    expect(desktop.applyShotRequirementTimelineAssembly).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "显式确认装配" }));
    await waitFor(() => expect(desktop.applyShotRequirementTimelineAssembly).toHaveBeenCalledWith({
      project_id: "project_1", requirement_id: "requirement_1",
      request: { assembly_preview_id: "assembly_preview_1", proposed_document_sha256: hashB, confirmed: true },
    }));
    expect(await screen.findByText("图片已装配为新的 Timeline Revision。请前往时间线查看。")).toBeVisible();
    expect(desktop.getTimeline).toHaveBeenCalledTimes(2);
  });

  it("重放显示复用；冲突和原始异常仅显示固定安全错误", async () => {
    const reused = api({ applyShotRequirementTimelineAssembly: vi.fn().mockResolvedValue({ assembly, reused: true }) });
    mount(reused);
    fireEvent.click(await screen.findByRole("button", { name: "准备时间线装配" }));
    fireEvent.click(await screen.findByRole("button", { name: "显式确认装配" }));
    expect(await screen.findByText("已复用既有装配结果。")).toBeVisible();
    cleanup();

    const rejected = api({
      prepareShotRequirementTimelineAssembly: vi.fn().mockRejectedValue(
        new Error("STAGE5_TIMELINE_CONFLICT C:\\private\\media.png PRIVATE_TRANSCRIPT"),
      ),
    });
    mount(rejected);
    fireEvent.click(await screen.findByRole("button", { name: "准备时间线装配" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("时间线装配未完成；请刷新时间线和采用结果后重试。");
    expect(document.body.textContent).not.toMatch(/private\\media|PRIVATE_TRANSCRIPT|STAGE5_TIMELINE_CONFLICT/i);
    expect(rejected.prepareShotRequirementTimelineAssembly).toHaveBeenCalledTimes(1);
  });

  it("图片不可用或历史只读时 fail closed，不发起写请求", async () => {
    const unavailable = mount(api(), { available: false });
    expect(await screen.findByText("当前采用图片不可用，不能装配。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "准备时间线装配" })).not.toBeInTheDocument();
    expect(unavailable.prepareShotRequirementTimelineAssembly).not.toHaveBeenCalled();
    cleanup();

    const readOnly = mount(api({ listShotRequirementTimelineAssemblies: vi.fn().mockResolvedValue({ items: [assembly], next_cursor: null }) }), { readOnly: true });
    expect(await screen.findByText("历史装配：1 条（只读）")).toBeVisible();
    expect(screen.queryByRole("button", { name: "准备时间线装配" })).not.toBeInTheDocument();
    expect(readOnly.prepareShotRequirementTimelineAssembly).not.toHaveBeenCalled();
    expect(readOnly.applyShotRequirementTimelineAssembly).not.toHaveBeenCalled();
  });
});
