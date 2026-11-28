import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.js";
import {
  desktopApi,
  expectSwitcherName,
  image,
  openProjectManagement,
  project,
  selectProject,
  video,
} from "./helpers/app-test-harness.js";

describe("Stage 1A/1B 项目与素材生命周期", () => {
  beforeEach(() => { window.desktop = desktopApi(); });
  afterEach(() => { vi.useRealTimers(); cleanup(); vi.restoreAllMocks(); });

  it("支持项目创建、重命名、归档、重开和四类素材导入", async () => {
    const api = desktopApi();
    const createdProject = { ...project, project_id: "project_2" as never, name: "新项目" };
    api.createProject = vi.fn().mockResolvedValue(createdProject);
    api.listAssets = vi.fn().mockImplementation(async ({ project_id }: { project_id: string }) => ({
      items: project_id === project.project_id
        ? [{ asset: video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }, { asset: image, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGHI" }]
        : [],
      next_cursor: null,
    }));
    api.listProjects = vi.fn()
      .mockResolvedValueOnce({ items: [project], next_cursor: null })
      .mockResolvedValue({ items: [project, createdProject], next_cursor: null });
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    openProjectManagement();
    const createDialog = await screen.findByRole("dialog", { name: "项目管理" });
    fireEvent.change(within(createDialog).getByLabelText("新项目名称"), { target: { value: "新项目" } });
    fireEvent.click(within(createDialog).getByRole("button", { name: "新建项目" }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({ name: "新项目", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 } }));
    await expectSwitcherName("新项目");
    selectProject(/^演示项目 活跃$/);
    await expectSwitcherName("演示项目");
    openProjectManagement();
    const manageDialog = await screen.findByRole("dialog", { name: "项目管理" });
    const card = within(manageDialog).getByRole("button", { name: "重命名项目 演示项目" }).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: "重命名项目 演示项目" }));
    fireEvent.change(within(card).getByLabelText("项目名称 演示项目"), { target: { value: "已重命名" } });
    fireEvent.click(within(card).getByRole("button", { name: "保存项目名称" }));
    await waitFor(() => expect(api.renameProject).toHaveBeenCalledWith({ project_id: "project_1", name: "已重命名" }));
    await expectSwitcherName("已重命名");
    fireEvent.click(within(card).getByRole("button", { name: /^归档项目 / }));
    await waitFor(() => expect(api.archiveProject).toHaveBeenCalledWith("project_1"));
    const reopenButton = await within(card).findByRole("button", { name: /^重新打开项目 / });
    fireEvent.click(reopenButton);
    await waitFor(() => expect(api.reopenProject).toHaveBeenCalledWith("project_1"));
    await within(card).findByRole("button", { name: /^归档项目 / });
    fireEvent.click(within(manageDialog).getByRole("button", { name: "关闭项目管理" }));
    for (const label of ["视频", "音频", "图片"]) fireEvent.click(screen.getByRole("button", { name: `导入${label}` }));
    await waitFor(() => expect(api.importAsset).toHaveBeenCalledTimes(3));
    expect(api.importAsset).toHaveBeenNthCalledWith(1, { project_id: "project_1", kind: "video" });
    expect(api.importAsset).toHaveBeenNthCalledWith(3, { project_id: "project_1", kind: "image" });
  });

  it("新建项目可选画布比例，创建请求携带对应画布", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    openProjectManagement();
    const dialog = await screen.findByRole("dialog", { name: "项目管理" });
    fireEvent.change(within(dialog).getByLabelText("新项目名称"), { target: { value: "横屏项目" } });
    fireEvent.change(within(dialog).getByLabelText("新建项目画布比例"), { target: { value: "169" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "新建项目" }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({ name: "横屏项目", canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1 } }));
  });

  it("卸载后的启动请求不会穿透到后来挂载的 Desktop bridge", async () => {
    let resolveRuntime!: () => void;
    const lateRuntime = new Promise<{ protocol_version: 1; status: "ready" }>(resolve => { resolveRuntime = () => resolve({ protocol_version: 1, status: "ready" }); });
    const staleApi = desktopApi(); staleApi.getRuntime = vi.fn().mockReturnValue(lateRuntime);
    window.desktop = staleApi; const stale = render(<App />); stale.unmount();
    const freshApi = desktopApi(); window.desktop = freshApi; render(<App />);
    await expectSwitcherName("演示项目");
    const freshProjectCalls = vi.mocked(freshApi.listProjects).mock.calls.length;
    resolveRuntime(); await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(vi.mocked(freshApi.listProjects).mock.calls.length).toBe(freshProjectCalls));
    expect(staleApi.listProjects).toHaveBeenCalledTimes(1);
  });

  it("迟到的同项目刷新不会覆盖重命名草稿，且切换与确认后仍会同步服务端名称", async () => {
    const projectQ = { ...project, project_id: "project_2" as never, name: "服务端项目 Q" };
    const refreshedProjectQ = { ...projectQ, name: "服务端项目 Q（刷新）" };
    const staleProject = { ...project, name: "服务端迟到名称" };
    const confirmedProject = { ...project, name: "服务端确认名" };
    let resolveStaleRefresh!: (value: { items: (typeof project)[]; next_cursor: null }) => void;
    const staleRefresh = new Promise<{ items: (typeof project)[]; next_cursor: null }>(resolve => { resolveStaleRefresh = resolve; });
    const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
    let refreshProjects!: () => void;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof delay === "number" && delay >= 1000 && typeof callback === "function") {
        refreshProjects = () => { void (callback as () => void)(); };
        return 1 as never;
      }
      return originalSetTimeout(callback, delay ?? 0) as never;
    }) as unknown as typeof setTimeout);
    const api = desktopApi();
    api.listProjects = vi.fn()
      .mockResolvedValueOnce({ items: [project], next_cursor: null })
      .mockReturnValueOnce(staleRefresh)
      .mockResolvedValueOnce({ items: [confirmedProject, refreshedProjectQ], next_cursor: null });
    api.renameProject = vi.fn().mockResolvedValue(confirmedProject);
    window.desktop = api;
    render(<App />);
    await expectSwitcherName("演示项目");

    await waitFor(() => expect(refreshProjects).toBeTypeOf("function"));
    await act(async () => { refreshProjects(); });
    await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(2));
    openProjectManagement();
    const dialog = await screen.findByRole("dialog", { name: "项目管理" });
    fireEvent.click(within(dialog).getByRole("button", { name: "重命名项目 演示项目" }));
    const renameInput = within(dialog).getByLabelText("项目名称 演示项目");
    fireEvent.change(renameInput, { target: { value: "用户未提交草稿" } });
    expect(renameInput).toHaveValue("用户未提交草稿");

    await act(async () => { resolveStaleRefresh({ items: [staleProject, projectQ], next_cursor: null }); });
    await waitFor(() => expect(renameInput).toHaveValue("用户未提交草稿"));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存项目名称" }));
    await waitFor(() => expect(api.renameProject).toHaveBeenCalledWith({ project_id: project.project_id, name: "用户未提交草稿" }));
    await within(dialog).findByRole("heading", { name: "服务端确认名" });
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭项目管理" }));

    const refreshForProjectP = refreshProjects;
    selectProject(/^服务端项目 Q 活跃$/);
    await expectSwitcherName("服务端项目 Q");
    await waitFor(() => expect(refreshProjects).not.toBe(refreshForProjectP));
    await act(async () => { refreshProjects(); });
    await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(3));
    await expectSwitcherName("服务端项目 Q（刷新）");
    timeoutSpy.mockRestore();
  });

  it("支持素材库刷新、删除确认弹窗和只读 Transcript 查看", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />); await within(screen.getByRole("region", { name: "媒体库" })).findByText(video.display_name);
    expect(screen.queryByRole("button", { name: "重新定位" })).toBeNull();
    expect(screen.getByRole("button", { name: "刷新素材库" })).toBeInTheDocument();
    await waitFor(() => expect(api.refreshAsset).not.toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "刷新素材库" }));
    await waitFor(() => expect(api.refreshAsset).toHaveBeenCalledWith(video.asset_id));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("所有素材文件均正常"));
    fireEvent.click(screen.getByTitle("转录")); expect(await screen.findByText("当前没有可用的本地 ASR 模型")).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: /^转录$/ })[0]);
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ }));
    fireEvent.click(await screen.findByRole("button", { name: /查看转录/ })); expect(await screen.findByText("原始 ASR 结果只读。勾选片段后，可追加到时间线或交给 AI 优化字幕文本。")).toBeVisible();
    expect(screen.getAllByText("第一句")).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: /^素材/ }));
    fireEvent.click(screen.getAllByTitle(`删除 ${video.display_name}`)[0]);
    expect(await screen.findByRole("heading", { name: "删除素材" })).toBeVisible();
    expect(screen.getByText(/相关片段（含关联字幕与转场）将一并删除/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "删除素材" })).toBeNull());
    expect(api.deleteAsset).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByTitle(`删除 ${video.display_name}`)[0]);
    fireEvent.click(await screen.findByRole("button", { name: "删除素材" }));
    await waitFor(() => expect(api.deleteAsset).toHaveBeenCalledWith({ asset_id: video.asset_id, remove_timeline_clips: true }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("已删除素材"));
  });
});

describe("素材箱交互", () => {
  afterEach(() => cleanup());

  it("默认显示网格，切换到列表后记住项目视图并保留选中素材", async () => {
    const viewKey = `vortex.asset-view.${project.project_id}`;
    localStorage.removeItem(viewKey);
    window.desktop = desktopApi();
    const app = render(<App />);
    await within(screen.getByRole("region", { name: "媒体库" })).findByText(video.display_name);
    expect(document.querySelector(".asset-view-grid")).not.toBeNull();
    const assetButton = screen.getByRole("button", { name: `${video.display_name}，视频` });
    fireEvent.click(assetButton);
    fireEvent.click(screen.getByRole("button", { name: "切换到列表视图" }));
    expect(document.querySelector(".asset-view-list")).not.toBeNull();
    expect(assetButton).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem(viewKey)).toBe("list");
    app.unmount();
    render(<App />);
    await within(screen.getByRole("region", { name: "媒体库" })).findByText(video.display_name);
    expect(document.querySelector(".asset-view-list")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "切换到网格视图" }));
    expect(document.querySelector(".asset-view-grid")).not.toBeNull();
    localStorage.removeItem(viewKey);
  });

  it("提示条按级别配色（成功为绿色而非红色）", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />); await within(screen.getByRole("region", { name: "媒体库" })).findByText(video.display_name);
    fireEvent.click(screen.getByRole("button", { name: "刷新素材库" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("所有素材文件均正常"), { timeout: 15_000 });
    expect(document.querySelector(".notice.notice-success")).not.toBeNull();
    expect(document.querySelector(".notice.notice-error")).toBeNull();
    fireEvent.click(screen.getAllByTitle(`删除 ${video.display_name}`)[0]);
    fireEvent.click(await screen.findByRole("button", { name: "删除素材" }, { timeout: 15_000 }));
    await waitFor(() => expect(document.querySelector(".notice.notice-success")?.textContent).toContain("已删除素材"), { timeout: 15_000 });
  });

  it("双击素材在预览播放且不修改时间线，回到时间线后退出素材预览", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />);
    await screen.findByText(image.display_name);
    await screen.findByLabelText("交互预览视频", {}, { timeout: 10_000 });
    const imageItem = screen.getByText(image.display_name).closest(".asset-item")!;
    fireEvent.doubleClick(imageItem);
    expect(await screen.findByAltText(image.display_name)).toBeInTheDocument();
    expect(screen.queryByLabelText("交互预览视频")).not.toBeInTheDocument();
    expect(api.patchTimeline).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("时间线播放头"), { key: "ArrowRight" });
    expect(screen.queryByAltText(image.display_name)).not.toBeInTheDocument();
    expect(screen.getByLabelText("交互预览视频")).toBeInTheDocument();
  }, 15_000);

  it("点击预览画面选中播放头处的片段并显示选中边框", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />);
    await screen.findByLabelText("交互预览视频", {}, { timeout: 10_000 });
    const frame = screen.getByRole("button", { name: /预览画布/ });
    expect(frame.className).not.toContain("selected");
    fireEvent.click(frame);
    await waitFor(() => expect(frame.className).toContain("selected"));
    expect(api.patchTimeline).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("时间线播放头"), { key: "End" });
    fireEvent.click(frame);
    await waitFor(() => expect(frame.className).not.toContain("selected"));
  });

  it("播放中用户 seek = 暂停 + 跳转（剪映式：点击时间轴不再被播放吞掉）", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />);
    await screen.findByLabelText("交互预览视频", {}, { timeout: 10_000 });
    const playButton = () => screen.getByRole("button", { name: "播放" });
    fireEvent.click(playButton());
    expect(await screen.findByRole("button", { name: "暂停" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("时间线播放头"), { key: "End" });
    await waitFor(() => expect(playButton()).toBeInTheDocument());
    expect(screen.getByLabelText("时间线播放头").getAttribute("aria-valuenow")).toBe("5000000");
    expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
  }, 15_000);
});
