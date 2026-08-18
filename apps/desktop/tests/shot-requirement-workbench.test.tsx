import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetPresentation, Project, ShotListRevisionDetail, ShotListRevisionSummary, ShotListState } from "@aivideo/contracts";
import type { DesktopApi } from "../electron/preload/index.js";
import { ShotRequirementWorkbench } from "../src/app/shot-requirements/ShotRequirementWorkbench.js";

const now = "2026-08-18T00:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;
const project = { project_id: "project_1", name: "项目一", status: "active", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 }, root_dir_name: "Demo", current_timeline_revision_id: null, created_at: now, updated_at: now, last_opened_at: now } as Project;
const asset = { asset: { asset_id: "asset_1", project_id: project.project_id, kind: "video", storage_mode: "external", display_name: "公开展示名.mp4", fingerprint: hash, size_bytes: 1, modified_at: now, availability: "available", media_info: null, created_at: now, updated_at: now }, media_url: null } as AssetPresentation;
const summary: ShotListRevisionSummary = { schema_version: 1, shot_list_revision_id: "revision_1" as never, shot_list_id: "shot_list_1" as never, project_id: project.project_id, parent_revision_id: null, title: "第一版", requirement_count: 1, document_sha256: hash, created_at: now };
const detail: ShotListRevisionDetail = { ...summary, summary: "人工摘要", requirements: [{ shot_requirement_id: "requirement_1" as never, shot_list_revision_id: summary.shot_list_revision_id, ordinal: 0, title: "历史镜头", visual_direction: "历史画面", target_duration_us: null, visual: { requirement_kind: "image", source_asset_id: null }, narration: null }] };
const drafted: ShotListState = { shot_list_id: summary.shot_list_id, project_id: project.project_id, lifecycle: "drafted", current_revision: detail, confirmed_revision: null };
const empty: ShotListState = { shot_list_id: null, project_id: project.project_id, lifecycle: "empty", current_revision: null, confirmed_revision: null };

function api(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    getShotList: vi.fn().mockResolvedValue(empty),
    listShotListRevisions: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    getShotListRevision: vi.fn().mockResolvedValue(detail),
    createShotListRevision: vi.fn().mockResolvedValue({ revision: detail, state: drafted, reused: false }),
    confirmShotListRevision: vi.fn().mockResolvedValue({ state: { ...drafted, lifecycle: "confirmed", confirmed_revision: summary }, reused: false }),
    ...overrides,
  } as unknown as DesktopApi;
}
function mount(desktop = api(), selectedProject = project) {
  window.desktop = desktop;
  return { desktop, ...render(<ShotRequirementWorkbench project={selectedProject} assets={[asset]} onClose={vi.fn()} />) };
}
async function fillFirstShot() {
  fireEvent.change(screen.getByLabelText("清单标题"), { target: { value: "新清单" } });
  fireEvent.change(screen.getByLabelText("镜头 1 标题"), { target: { value: "开场" } });
  fireEvent.change(screen.getByLabelText("镜头 1 画面要求"), { target: { value: "正面固定机位" } });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Stage 4C Shot Requirement Workbench", () => {
  it("展示空状态、零副作用边界并校验最小表单", async () => {
    mount();
    expect(await screen.findByText("人工规划素材需求；不会调用 Provider、不会生成媒体、不会写入时间线。")).toBeVisible();
    expect(screen.getByText("镜头（1/24）")).toBeVisible();
    expect(screen.getByRole("button", { name: "保存新 Revision" })).toBeDisabled();
    await fillFirstShot();
    expect(screen.getByRole("button", { name: "保存新 Revision" })).toBeEnabled();
  });

  it("将镜头数量严格限制为 1–24，达到上限后拒绝第 25 条", async () => {
    mount();
    await screen.findByText("镜头（1/24）");
    const add = screen.getByRole("button", { name: "添加镜头" });
    for (let index = 1; index < 24; index += 1) fireEvent.click(add);
    expect(screen.getByText("镜头（24/24）")).toBeVisible();
    expect(screen.getByLabelText("镜头 24")).toBeVisible();
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(screen.queryByLabelText("镜头 25")).not.toBeInTheDocument();
  });

  it("支持添加、排序、删除及 visual/narration 条件字段", async () => {
    mount(); await screen.findByText("镜头（1/24）"); await fillFirstShot();
    fireEvent.click(screen.getByRole("button", { name: "添加镜头" }));
    fireEvent.change(screen.getByLabelText("镜头 2 标题"), { target: { value: "结尾" } });
    fireEvent.change(screen.getByLabelText("镜头 2 画面要求"), { target: { value: "拉远" } });
    fireEvent.click(screen.getByLabelText("上移镜头 2"));
    expect(screen.getByLabelText("镜头 1 标题")).toHaveValue("结尾");
    const first = screen.getByLabelText("镜头 1");
    fireEvent.click(within(first).getByLabelText("使用现有素材"));
    expect(screen.getByLabelText("镜头 1 现有素材")).toHaveValue("asset_1");
    fireEvent.click(within(first).getByLabelText("TTS 人工正文"));
    fireEvent.change(screen.getByLabelText("镜头 1 旁白正文"), { target: { value: "人工正文" } });
    fireEvent.click(screen.getByLabelText("删除镜头 2"));
    expect(screen.getByText("镜头（1/24）")).toBeVisible();
  });

  it("保存 exact DTO、显示 reused，并始终基于最新 current", async () => {
    const create = vi.fn().mockResolvedValue({ revision: detail, state: drafted, reused: true });
    const desktop = api({ getShotList: vi.fn().mockResolvedValue(drafted), listShotListRevisions: vi.fn().mockResolvedValue({ items: [summary], next_cursor: null }), createShotListRevision: create });
    mount(desktop); await screen.findByDisplayValue("第一版");
    fireEvent.change(screen.getByLabelText("清单标题"), { target: { value: "第二版" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新 Revision" }));
    expect(await screen.findByText("内容未变化，已复用当前 Revision。")).toBeVisible();
    expect(create).toHaveBeenCalledWith({ project_id: project.project_id, revision: expect.objectContaining({ schema_version: 1, base_revision_id: "revision_1", title: "第二版", requirements: expect.any(Array) }) });
    expect(JSON.stringify(create.mock.calls[0])).not.toContain("path");
  });

  it("历史列表按需加载 Detail、复制内容，并两步确认当前 Revision", async () => {
    const confirm = vi.fn().mockResolvedValue({ state: { ...drafted, lifecycle: "confirmed", confirmed_revision: summary }, reused: false });
    const desktop = api({ getShotList: vi.fn().mockResolvedValue(drafted), listShotListRevisions: vi.fn().mockResolvedValue({ items: [summary], next_cursor: null }), confirmShotListRevision: confirm });
    mount(desktop); await screen.findByDisplayValue("第一版");
    fireEvent.click(screen.getByRole("tab", { name: "Revision 历史" }));
    fireEvent.click(await screen.findByRole("button", { name: /第一版/ }));
    expect(await screen.findByText("历史画面")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "复制到编辑表单" }));
    expect(screen.getByDisplayValue("历史镜头")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认当前 Revision" }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "再次点击确认当前 Revision" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith({ project_id: project.project_id, confirmation: { revision_id: "revision_1", expected_current_revision_id: "revision_1" } }));
  });

  it("项目切换会清空未保存正文并隔离迟到响应", async () => {
    let resolveOld!: (value: ShotListState) => void;
    const old = new Promise<ShotListState>(resolve => { resolveOld = resolve; });
    const project2 = { ...project, project_id: "project_2" as never, name: "项目二" };
    const desktop = api({
      getShotList: vi.fn().mockImplementation((projectId: string) => projectId === project.project_id ? old : Promise.resolve({ ...empty, project_id: project2.project_id })),
      listShotListRevisions: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    });
    window.desktop = desktop;
    const view = render(<ShotRequirementWorkbench project={project} assets={[asset]} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("清单标题"), { target: { value: "未保存敏感正文" } });
    view.rerender(<ShotRequirementWorkbench project={project2} assets={[]} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("清单标题")).toHaveValue(""));
    await act(async () => resolveOld(drafted));
    expect(screen.getByLabelText("清单标题")).toHaveValue("");
    expect(screen.queryByDisplayValue("未保存敏感正文")).not.toBeInTheDocument();
  });
});
