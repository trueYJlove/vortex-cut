import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../electron/preload/index.js";
import { App } from "../src/app/App.js";
import {
  desktopApi,
  expectSwitcherName,
  openToolsMenu,
  project,
  video,
} from "./helpers/app-test-harness.js";

describe("AI 字幕优化（转录页发起）", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const openOptimize = async (api: DesktopApi) => {
    window.desktop = api;
    render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: "转录" }));
    fireEvent.click(await screen.findByRole("button", { name: /查看转录 transcript_1/ }));
    const checkbox = await screen.findByRole("checkbox", { name: /第一句/ });
    fireEvent.click(checkbox);
    const entry = await screen.findByRole("button", { name: "AI 优化字幕文本" });
    await waitFor(() => expect(entry).toBeEnabled());
    fireEvent.click(entry);
    return screen.findByRole("dialog", { name: "AI 字幕优化" });
  };

  it("未通过字幕能力测试时不可准备，测试通过后才放行", async () => {
    const api = desktopApi();
    const base = (await api.listProviders!()).items[0];
    vi.mocked(api.listProviders!).mockResolvedValue({ items: [{ ...base, captions_provider_capability_status: "untested", captions_provider_response_adapter_id: null, captions_provider_probe_protocol_version: null, captions_provider_capability_tested_at: null, captions_provider_capability_failure_code: null, captions_provider_capability_probe_sha256: null }] });
    await openOptimize(api);
    fireEvent.change(await screen.findByLabelText("字幕优化 Provider"), { target: { value: "provider_1" } });
    expect(screen.getByRole("button", { name: "准备外传确认" })).toBeDisabled();
    expect(api.testCaptionsProviderCapability).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "测试字幕兼容性" }));
    await waitFor(() => expect(api.testCaptionsProviderCapability).toHaveBeenCalledWith("provider_1"));
    expect(await screen.findByText("字幕能力可用。")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "准备外传确认" })).toBeEnabled());
  });

  it("必须先准备并确认外传，再生成提案，最后显式应用", async () => {
    const api = desktopApi();
    await openOptimize(api);
    fireEvent.change(await screen.findByLabelText("字幕优化 Provider"), { target: { value: "provider_1" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "准备外传确认" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "准备外传确认" }));
    expect(await screen.findByText(/segments\.text/)).toBeVisible();
    expect(api.createCaptionsProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认并生成" }));
    await waitFor(() => expect(api.createCaptionsProvider).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("字幕改写提案")).toBeVisible();
    expect(api.applyCaptionsProviderProposal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "应用为新的 Revision" }));
    await waitFor(() => expect(api.applyCaptionsProviderProposal).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("已应用")).toBeVisible();
  });

  it("未勾选片段时入口不可用", async () => {
    const api = desktopApi();
    window.desktop = api;
    render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: "转录" }));
    fireEvent.click(await screen.findByRole("button", { name: /查看转录 transcript_1/ }));
    const entry = await screen.findByRole("button", { name: "AI 优化字幕文本" });
    expect(entry).toBeDisabled();
    expect(screen.queryByRole("dialog", { name: "AI 字幕优化" })).not.toBeInTheDocument();
  });

  it("界面不回显协议、适配器或失败码细节", async () => {
    const api = desktopApi();
    await openOptimize(api);
    fireEvent.change(await screen.findByLabelText("字幕优化 Provider"), { target: { value: "provider_1" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "准备外传确认" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "准备外传确认" }));
    await screen.findByText(/segments\.text/);
    expect(document.body.textContent).not.toMatch(/captionscript|json_schema|adapter|probe_sha256/i);
  });

  it("生成期间有关闭出口，状态用人话（P68 排版/文案）", async () => {
    const api = desktopApi();
    vi.mocked(api.getCaptionsProviderGeneration!).mockResolvedValue({ status: "running" } as never);
    await openOptimize(api);
    fireEvent.change(await screen.findByLabelText("字幕优化 Provider"), { target: { value: "provider_1" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "准备外传确认" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "准备外传确认" }));
    await screen.findByText(/segments\.text/);
    fireEvent.click(screen.getByRole("button", { name: "确认并生成" }));
    await screen.findByText("正在生成字幕文本");
    expect(screen.getByText("执行中")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/执行中（|（running）|（queued）/);
    const close = screen.getByRole("button", { name: "关闭面板" });
    expect(close).toBeVisible();
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "AI 字幕优化" })).not.toBeInTheDocument());
  });

  it("段↔字幕映射失败给可操作出路，不给「请稍后重试」（P68）", async () => {
    const api = desktopApi();
    vi.mocked(api.createCaptionsProviderProposal!).mockRejectedValue(
      new Error("[CAPTIONS_PROVIDER_SEGMENTS_UNMAPPED] 所选片段与时间线字幕不对应"),
    );
    await openOptimize(api);
    fireEvent.change(await screen.findByLabelText("字幕优化 Provider"), { target: { value: "provider_1" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "准备外传确认" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "准备外传确认" }));
    await screen.findByText(/segments\.text/);
    fireEvent.click(screen.getByRole("button", { name: "确认并生成" }));
    await waitFor(() => expect(api.createCaptionsProviderProposal).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/先在转录查看器里把这些片段「追加所选片段」到时间线/),
    ).toBeVisible();
    expect(screen.queryByText(/请稍后重试/)).not.toBeInTheDocument();
  });
});

describe("W3.1 素材语义检索入口", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  async function semanticEntry(): Promise<HTMLElement> {
    openToolsMenu();
    return await screen.findByRole("menuitem", { name: /素材语义检索/ });
  }

  it("从「工具」菜单能打开语义检索面板，并能关闭", async () => {
    window.desktop = desktopApi();
    render(<App />);
    const entry = await semanticEntry();
    await waitFor(() => expect(entry).toBeEnabled());
    fireEvent.click(entry);
    expect(await screen.findByRole("dialog", { name: "素材语义检索" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "素材语义检索" })).not.toBeInTheDocument());
  });

  it("未选择项目时入口禁用", async () => {
    const api = desktopApi();
    api.listProjects = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
    window.desktop = api;
    render(<App />);
    const entry = await semanticEntry();
    expect(entry).toBeDisabled();
    expect(screen.queryByRole("dialog", { name: "素材语义检索" })).not.toBeInTheDocument();
  });

  it("面板按素材显示名列出建索引入口，并用 generate: true 调用", async () => {
    const api = desktopApi();
    api.indexSemanticAsset = vi.fn().mockResolvedValue({
      index_id: null, status: "queued", job_id: "job_semantic_1", frame_count: null,
      algorithm_version: null, model_id: null, reason: null,
    });
    window.desktop = api;
    render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(await semanticEntry());
    const panel = await screen.findByRole("dialog", { name: "素材语义检索" });
    await waitFor(() => expect(within(panel).getByText(video.display_name)).toBeVisible());
    fireEvent.click(within(panel).getByRole("button", { name: "为此项目建索引" }));
    await waitFor(() => expect(api.indexSemanticAsset).toHaveBeenCalledWith({
      project_id: project.project_id, asset_id: video.asset_id, generate: true,
    }));
  });
});
