import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@aivideo/contracts";
import { App } from "../src/app/App.js";
import {
  createdJob,
  desktopApi,
  expectSwitcherName,
  now,
  openToolsMenu,
  project,
  selectProject,
  state,
  timelineDocument,
} from "./helpers/app-test-harness.js";

describe("Stage 2A AI 粗剪", () => {
  afterEach(() => cleanup());
  it("未测试 Provider 不可准备，只有用户点击兼容性测试后才允许 AI 粗剪", async () => {
    const api = desktopApi();
    vi.mocked(api.listProviders!).mockResolvedValue({ items: [{ provider_config_id: "provider_1" as never, kind: "openai_compatible_text", display_name: "未测试 Provider", base_url: "https://provider.test", model: "model", enabled: true, credential_status: "configured", input_price_per_million: null, output_price_per_million: null, timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "openai_chat_completions_json_schema_v1", timeline_patch_probe_protocol_version: "1", timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: null, timeline_patch_capability_probe_sha256: `sha256:${"d".repeat(64)}`, candidate_capability_status: "untested", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: null, candidate_capability_failure_code: null, candidate_capability_probe_sha256: null, captions_provider_capability_status: "supported", captions_provider_response_adapter_id: "openai_chat_completions_captionscript_v1", captions_provider_probe_protocol_version: "1", captions_provider_capability_tested_at: now, captions_provider_capability_failure_code: null, captions_provider_capability_probe_sha256: `sha256:${"f".repeat(64)}`, created_at: now, updated_at: now }] });
    vi.mocked(api.testCandidateProviderCapability).mockResolvedValue({ candidate_capability_status: "supported", candidate_response_adapter_id: "openai_chat_completions_json_schema_v1", candidate_probe_protocol_version: "1", candidate_capability_tested_at: now, candidate_capability_failure_code: null, candidate_capability_probe_sha256: `sha256:${"e".repeat(64)}` });
    window.desktop = api; render(<App />); await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("button", { name: "AI 粗剪" }));
    expect(await screen.findByRole("option", { name: /未测试 Provider.*未测试/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "准备外传确认" })).toBeDisabled(); expect(api.testCandidateProviderCapability).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "测试 AI 粗剪兼容性" })); await waitFor(() => expect(api.testCandidateProviderCapability).toHaveBeenCalledWith("provider_1"));
    expect(await screen.findByText("AI 粗剪可用。")).toBeVisible(); expect(document.body.textContent).not.toMatch(/responses|chat|schema|candidatescript|adapter/i);
  });
  it("必须先 prepare 再经明确确认创建，且不渲染密钥", async () => {
    const api = desktopApi(); api.listCandidatePlans = vi.fn().mockResolvedValue({ items: [{} as never] }); window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    await screen.findByRole("note", { name: "合成预览回退提示" }, { timeout: 10_000 });
    fireEvent.click(screen.getByRole("button", { name: "AI 粗剪" }));
    fireEvent.change(await screen.findByLabelText("主题"), { target: { value: "游戏高光" } });
    fireEvent.change(screen.getByLabelText("受众"), { target: { value: "玩家" } });
    fireEvent.change(screen.getByLabelText("叙事目标"), { target: { value: "展示关键操作" } });
    fireEvent.change(screen.getByLabelText("制作配方"), { target: { value: "balanced-narrative-v1" } });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "provider_1" } });
    fireEvent.change(screen.getByLabelText("就绪转录"), { target: { value: "transcript_1" } });
    fireEvent.click(screen.getByRole("button", { name: "测试 AI 粗剪兼容性" }));
    await waitFor(() => expect(api.testCandidateProviderCapability).toHaveBeenCalledWith("provider_1"));
    expect(api.createPlanning).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "准备外传确认" }));
    await screen.findByText("确认发送的精确内容"); expect(api.preparePlanning).toHaveBeenCalled(); expect(api.createPlanning).not.toHaveBeenCalled();
    const sendBtn = screen.getByRole("button", { name: "我确认发送以上内容" }) as HTMLButtonElement;
    expect(sendBtn.disabled, "未勾选时不应可发送").toBe(true);
    fireEvent.click(screen.getByLabelText("我已核对以上外发内容"));
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    fireEvent.click(sendBtn);
    await waitFor(() => expect(api.createPlanning).toHaveBeenCalledWith({ project_id: "project_1", egress_preview_id: "preview_1", payload_sha256: `sha256:${"b".repeat(64)}` }));
  });
  it("Provider 设置是独立入口：可创建 Provider 并保存密钥且不回显", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />); await expectSwitcherName("演示项目");
    await screen.findByRole("note", { name: "合成预览回退提示" }, { timeout: 10_000 });
    openToolsMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Provider 设置" }));
    const dialog = await screen.findByRole("dialog", { name: "Provider 设置" });
    expect(within(dialog).getByText(/密钥只提交、不回显/)).toBeVisible();
    fireEvent.change(await within(dialog).findByLabelText("已有 Provider"), { target: { value: "provider_1" } });
    fireEvent.change(within(dialog).getByLabelText("Provider 密钥"), { target: { value: "SENTINEL-SECRET" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "安全保存密钥" }));
    await waitFor(() => expect(api.setProviderSecret).toHaveBeenCalledWith({ provider_config_id: "provider_1", secret: "SENTINEL-SECRET" }));
    expect(document.body.textContent).not.toContain("SENTINEL-SECRET");
  });
  it("Provider 设置也可从「设置」进入，并关闭设置避免两窗叠加", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />); await expectSwitcherName("演示项目");
    await screen.findByRole("note", { name: "合成预览回退提示" }, { timeout: 10_000 });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settings = await screen.findByRole("dialog", { name: "设置" });
    expect(within(settings).getByText(/AI 粗剪、AI 修改、AI 助手与 AI 字幕优化共用/)).toBeVisible();
    fireEvent.click(within(settings).getByRole("button", { name: "打开 Provider 设置" }));
    expect(await screen.findByRole("dialog", { name: "Provider 设置" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "设置" })).not.toBeInTheDocument();
  });

  it("Provider 设置可新建 Provider，并提示接着填密钥", async () => {
    const api = desktopApi();
    api.listProviders = vi.fn().mockResolvedValue({ items: [] });
    vi.mocked(api.createProvider!).mockResolvedValue({ provider_config_id: "provider_new" as never, kind: "openai_compatible_text", display_name: "我的网关", base_url: "https://gw.test", model: "m", enabled: true, credential_status: "missing", input_price_per_million: null, output_price_per_million: null, timeline_patch_capability_status: "untested", timeline_patch_response_adapter_id: null, timeline_patch_probe_protocol_version: null, timeline_patch_capability_tested_at: null, timeline_patch_capability_failure_code: null, timeline_patch_capability_probe_sha256: null, candidate_capability_status: "untested", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: null, candidate_capability_failure_code: null, candidate_capability_probe_sha256: null, captions_provider_capability_status: "untested", captions_provider_response_adapter_id: null, captions_provider_probe_protocol_version: null, captions_provider_capability_tested_at: null, captions_provider_capability_failure_code: null, captions_provider_capability_probe_sha256: null, created_at: now, updated_at: now });
    window.desktop = api; render(<App />); await expectSwitcherName("演示项目");
    openToolsMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Provider 设置" }));
    const dialog = await screen.findByRole("dialog", { name: "Provider 设置" });
    expect(await within(dialog).findByText(/尚无 Provider/)).toBeVisible();
    fireEvent.change(within(dialog).getByLabelText("Provider 名称"), { target: { value: "我的网关" } });
    fireEvent.change(within(dialog).getByLabelText("Provider 地址"), { target: { value: "https://gw.test" } });
    fireEvent.change(within(dialog).getByLabelText("Provider 模型"), { target: { value: "m" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建 Provider" }));
    await waitFor(() => expect(api.createProvider).toHaveBeenCalledWith(expect.objectContaining({ kind: "openai_compatible_text", display_name: "我的网关", base_url: "https://gw.test", model: "m", enabled: true })));
    expect(await within(dialog).findByText(/下一步：填入密钥并保存/)).toBeVisible();
  });
  it("删除密钥使用白名单桥接且不回显", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />); await expectSwitcherName("演示项目");
    await screen.findByRole("note", { name: "合成预览回退提示" }, { timeout: 10_000 });
    openToolsMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Provider 设置" }));
    const dialog = await screen.findByRole("dialog", { name: "Provider 设置" });
    fireEvent.change(await within(dialog).findByLabelText("已有 Provider"), { target: { value: "provider_1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除密钥" })); await waitFor(() => expect(api.deleteProviderSecret).toHaveBeenCalledWith("provider_1"));
    expect(document.body.textContent).not.toContain("SENTINEL-KEY-NEVER-LOG");
  });
  it.each(["failed", "cancelled", "interrupted"] as const)("任务 %s 会清除旧外传预览，取消按钮调用任务取消并强制重新准备", async status => {
    const api = desktopApi(); api.listCandidatePlans = vi.fn().mockImplementation(() => new Promise(() => undefined)); let listener: ((value: Job) => void) | undefined;
    api.subscribeJob = vi.fn((_id, next) => { listener = next; return () => undefined; });
    window.desktop = api; render(<App />); await expectSwitcherName("演示项目");
    await screen.findByRole("note", { name: "合成预览回退提示" }, { timeout: 10_000 });
    fireEvent.click(screen.getByRole("button", { name: "AI 粗剪" }));
    fireEvent.change(await screen.findByLabelText("主题"), { target: { value: "游戏高光" } }); fireEvent.change(screen.getByLabelText("受众"), { target: { value: "玩家" } }); fireEvent.change(screen.getByLabelText("叙事目标"), { target: { value: "展示操作" } }); fireEvent.change(screen.getByLabelText("制作配方"), { target: { value: "balanced-narrative-v1" } }); fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "provider_1" } }); fireEvent.change(screen.getByLabelText("就绪转录"), { target: { value: "transcript_1" } });
    fireEvent.click(screen.getByRole("button", { name: "准备外传确认" })); await screen.findByText("确认发送的精确内容"); fireEvent.click(screen.getByLabelText("我已核对以上外发内容")); fireEvent.click(screen.getByRole("button", { name: "我确认发送以上内容" }));
    expect(await screen.findByRole("button", { name: "取消生成" })).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "取消生成" })); expect(api.cancelJob).toHaveBeenCalledWith("job_created");
    expect(listener).toBeTypeOf("function"); listener?.({ ...createdJob, status, stage: status, progress: 0, error: { code: `JOB_${status.toUpperCase()}`, message: status } });
    expect(await screen.findByRole("button", { name: "准备外传确认" })).toBeVisible(); expect(screen.queryByText("确认发送的精确内容")).not.toBeInTheDocument(); expect(api.createPlanning).toHaveBeenCalledTimes(1);
  });
});

describe("Stage 2B AI 修改", () => {
  afterEach(() => cleanup());
  const diff = { schema_version: 1 as const, project_id: project.project_id, base_revision_id: state.current_revision.timeline_revision_id, target_revision_id: null, base_document_sha256: `sha256:${"a".repeat(64)}`, target_document_sha256: `sha256:${"b".repeat(64)}`, summary: { clip_changes: 1, caption_changes: 0, lock_changes: 0, transition_changes: 0 }, duration_delta_us: -100_000, clip_changes: [{ type: "trimmed" as const, clip_id: "clip_1" as never }], caption_changes: [], lock_changes: [], indirect_locked_timing_shifts: [], transition_changes: [] };
  const proposal = { schema_version: 1 as const, timeline_patch_proposal_id: "proposal_1" as never, timeline_patch_generation_id: "patch_generation_1" as never, project_id: project.project_id, base_revision_id: state.current_revision.timeline_revision_id, base_document_sha256: `sha256:${"a".repeat(64)}`, provider_config_id: "provider_1" as never, provider_display_name: "测试 Provider", model: "model", prompt_template_version: "timeline-patch-v1", output_schema_version: "timeline-patch-output-v1", patch: { schema_version: 1 as const, base_revision_id: state.current_revision.timeline_revision_id, operations: [{ op: "trim_clip" as const, clip_id: "clip_1" as never, source_start_us: 0, source_end_us: 4_900_000 }], summary: "缩短" }, patch_sha256: `sha256:${"c".repeat(64)}`, proposed_document_sha256: `sha256:${"b".repeat(64)}`, diff, created_at: now, applied_revision_id: null, generation_status: "succeeded" as const };

  it("锁定按钮禁用 Clip 与关联 Caption 编辑，解锁仍可用", async () => {
    const lockedState = { ...state, current_revision: { ...state.current_revision, document: { ...timelineDocument, locked_elements: ["clip_1" as never] } } };
    const api = desktopApi({ timeline: lockedState }); window.desktop = api; render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /video 5.00s/ }));
    expect(screen.getByText(/此轨道已锁定/)).toBeVisible(); expect(screen.getByRole("radio", { name: "裁切填满" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /这是一条很长/ })); expect(screen.getByText(/关联 Clip 已锁定/)).toBeVisible(); expect(screen.getByLabelText("文本")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /video 5.00s/ }));
    const canvasEl = document.querySelector("canvas") as HTMLCanvasElement;
    fireEvent.contextMenu(canvasEl, { clientX: 150, clientY: 124 });
    fireEvent.click(screen.getByRole("menuitem", { name: "解锁片段" }));
    await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [{ op: "set_clip_locked", clip_id: "clip_1", locked: false }] }) })));
  });

  it("prepare 确认只显示当前本地指令，Core 意外正文不进入 DOM，关闭会清理", async () => {
    const api = desktopApi(); vi.mocked(api.prepareTimelinePatch).mockResolvedValue({ ...(await api.prepareTimelinePatch({} as never)), raw_response: "SENTINEL-RAW", payload: { caption_text: "SENTINEL-CAPTION" } } as never); vi.mocked(api.prepareTimelinePatch).mockClear();
    window.desktop = api; render(<App />); const entry = await screen.findByRole("button", { name: "AI 修改" }); await waitFor(() => expect(entry).toBeEnabled()); fireEvent.click(entry);
    fireEvent.change(await screen.findByLabelText("修改指令"), { target: { value: "把开头缩短一点" } }); fireEvent.click(screen.getByRole("button", { name: "准备外传确认" }));
    expect(await screen.findByRole("heading", { name: "确认本次外传" })).toBeVisible(); expect(screen.getByText("把开头缩短一点", { selector: "p" })).toBeVisible(); expect(document.body.textContent).not.toContain("SENTINEL-RAW"); expect(document.body.textContent).not.toContain("SENTINEL-CAPTION");
    fireEvent.click(screen.getByRole("button", { name: "关闭 AI 修改" })); fireEvent.click(screen.getByRole("button", { name: "AI 修改" })); expect(await screen.findByLabelText("修改指令")).toHaveValue("");
  });

  it("成功生成展示分组 Diff，应用显式创建正式 Revision", async () => {
    const api = desktopApi(); let listener: ((job: Job) => void) | undefined; api.subscribeJob = vi.fn((_id, next) => { listener = next; return () => undefined; }); vi.mocked(api.listTimelinePatchProposals).mockResolvedValue({ items: [proposal] });
    window.desktop = api; render(<App />); const entry = await screen.findByRole("button", { name: "AI 修改" }); await waitFor(() => expect(entry).toBeEnabled()); fireEvent.click(entry); fireEvent.change(await screen.findByLabelText("修改指令"), { target: { value: "缩短片段" } }); fireEvent.click(screen.getByRole("button", { name: "准备外传确认" })); fireEvent.click(await screen.findByLabelText("我已核对以上外发内容")); fireEvent.click(await screen.findByRole("button", { name: "确认并发送一次" })); await waitFor(() => expect(listener).toBeTypeOf("function"));
    await act(async () => { listener?.({ ...createdJob, kind: "timeline_patch_generation", status: "succeeded", stage: "completed", progress: 1 }); await Promise.resolve(); }); await waitFor(() => expect(api.listTimelinePatchProposals).toHaveBeenCalled()); expect(await screen.findByText("提案差异")).toBeVisible(); expect(screen.getByText(/trimmed/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "应用修改" })); await waitFor(() => expect(api.applyTimelinePatchProposal).toHaveBeenCalledWith({ project_id: "project_1", proposal_id: "proposal_1", base_revision_id: "revision_1", proposed_document_sha256: `sha256:${"b".repeat(64)}` }));
  });

  it("Revision 比较只调用只读 diff 接口", async () => {
    const api = desktopApi(); vi.mocked(api.listTimelineRevisions).mockResolvedValue({ items: [state.current_revision, { ...state.current_revision, timeline_revision_id: "revision_0" as never, summary: "上一版" }].map(({ schema_version: _s, document: _d, ...item }) => item), next_cursor: null }); vi.mocked(api.compareTimelineRevisions).mockResolvedValue({ ...diff, target_revision_id: state.current_revision.timeline_revision_id });
    window.desktop = api; render(<App />); const entry = await screen.findByRole("button", { name: "版本比较" }); await waitFor(() => expect(entry).toBeEnabled()); fireEvent.click(entry); fireEvent.click(await screen.findByRole("button", { name: "比较" })); await waitFor(() => expect(api.compareTimelineRevisions).toHaveBeenCalled()); expect(api.patchTimeline).not.toHaveBeenCalled(); expect(api.undoTimeline).not.toHaveBeenCalled();
  });
  it("未测试 Provider 禁用 AI 修改选择，兼容性测试后仅显示安全状态", async () => {
    const api = desktopApi();
    vi.mocked(api.listProviders!).mockResolvedValue({ items: [{ provider_config_id: "provider_1" as never, kind: "openai_compatible_text", display_name: "未测试 Provider", base_url: "https://provider.test", model: "model", enabled: true, credential_status: "configured", input_price_per_million: null, output_price_per_million: null, timeline_patch_capability_status: "untested", timeline_patch_response_adapter_id: null, timeline_patch_probe_protocol_version: null, timeline_patch_capability_tested_at: null, timeline_patch_capability_failure_code: null, timeline_patch_capability_probe_sha256: null, candidate_capability_status: "untested", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: null, candidate_capability_failure_code: null, candidate_capability_probe_sha256: null, captions_provider_capability_status: "supported", captions_provider_response_adapter_id: "openai_chat_completions_captionscript_v1", captions_provider_probe_protocol_version: "1", captions_provider_capability_tested_at: now, captions_provider_capability_failure_code: null, captions_provider_capability_probe_sha256: `sha256:${"f".repeat(64)}`, created_at: now, updated_at: now }] });
    window.desktop = api; render(<App />); const entry = await screen.findByRole("button", { name: "AI 修改" }); await waitFor(() => expect(entry).toBeEnabled()); fireEvent.click(entry);
    expect(await screen.findByRole("option", { name: /未测试 Provider.*未测试/ })).toBeDisabled();
    fireEvent.click(await screen.findByRole("button", { name: "测试 AI 修改兼容性" }));
    await waitFor(() => expect(api.testTimelinePatchProviderCapability).toHaveBeenCalledWith("provider_1"));
    expect(document.body.textContent).not.toContain("raw_response"); expect(document.body.textContent).not.toContain("SENTINEL");
  });
  it("AI 修改界面不回显协议、适配器或失败码细节", async () => {
    const api = desktopApi();
    vi.mocked(api.listProviders!).mockResolvedValue({ items: [{ provider_config_id: "provider_1" as never, kind: "openai_compatible_text", display_name: "不支持 Provider", base_url: "https://provider.test", model: "model", enabled: true, credential_status: "configured", input_price_per_million: null, output_price_per_million: null, timeline_patch_capability_status: "unsupported", timeline_patch_response_adapter_id: null, timeline_patch_probe_protocol_version: null, timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: "PROVIDER_SCHEMA_MISMATCH", timeline_patch_capability_probe_sha256: `sha256:${"d".repeat(64)}`, candidate_capability_status: "unsupported", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: now, candidate_capability_failure_code: "PROVIDER_FAILED", candidate_capability_probe_sha256: `sha256:${"e".repeat(64)}`, captions_provider_capability_status: "untested", captions_provider_response_adapter_id: null, captions_provider_probe_protocol_version: null, captions_provider_capability_tested_at: null, captions_provider_capability_failure_code: null, captions_provider_capability_probe_sha256: null, created_at: now, updated_at: now }] });
    vi.mocked(api.testTimelinePatchProviderCapability).mockResolvedValue({ timeline_patch_capability_status: "unsupported", timeline_patch_response_adapter_id: null, timeline_patch_probe_protocol_version: null, timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: "PROVIDER_SCHEMA_MISMATCH", timeline_patch_capability_probe_sha256: `sha256:${"d".repeat(64)}` });
    window.desktop = api; render(<App />); const entry = await screen.findByRole("button", { name: "AI 修改" }); await waitFor(() => expect(entry).toBeEnabled()); fireEvent.click(entry);
    expect((await screen.findAllByText(/当前 Provider 不支持 AI 修改/)).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/responses|chat|schema|patchscript|adapter|provider_schema_mismatch/i);
    fireEvent.click(screen.getByRole("button", { name: "测试 AI 修改兼容性" }));
    await screen.findByText("当前 Provider 不支持 AI 修改。");
    expect(document.body.textContent).not.toMatch(/responses|chat|schema|patchscript|adapter|provider_schema_mismatch/i);
  });
});

describe("Stage 4B 生成验证正式入口", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  async function generationEntry(): Promise<HTMLElement> {
    openToolsMenu();
    return await screen.findByRole("menuitem", { name: /生成验证（模拟）/ });
  }

  it("未选择项目时禁用入口，选择项目后可打开模拟验证工作台", async () => {
    const api = desktopApi();
    api.listProjects = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
    window.desktop = api;
    const view = render(<App />);
    const entry = await generationEntry();
    expect(entry).toBeDisabled();
    view.unmount();

    const projectApi = desktopApi();
    window.desktop = projectApi;
    render(<App />);
    const enabledEntry = await generationEntry();
    await waitFor(() => expect(enabledEntry).toBeEnabled());
    fireEvent.click(enabledEntry);
    expect(await screen.findByRole("dialog", { name: "生成验证（模拟）" })).toBeVisible();
    expect(screen.getByText(/不会生成媒体，不会注册素材，也不会写入时间线/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭生成验证" }));
    expect(screen.queryByRole("dialog", { name: "生成验证（模拟）" })).not.toBeInTheDocument();
  });

  it("切换项目时卸载工作台并清除当前表单", async () => {
    const other = { ...project, project_id: "project_other" as never, name: "第二项目" };
    const api = desktopApi();
    api.listProjects = vi.fn().mockResolvedValue({ items: [project, other], next_cursor: null });
    window.desktop = api;
    render(<App />);
    const entry = await generationEntry();
    await waitFor(() => expect(entry).toBeEnabled());
    fireEvent.click(entry);
    fireEvent.change(await screen.findByLabelText("生成验证 Prompt"), { target: { value: "切换项目必须清除" } });
    selectProject(/^第二项目 活跃$/);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "生成验证（模拟）" })).not.toBeInTheDocument());
    fireEvent.click(await generationEntry());
    expect(await screen.findByLabelText("生成验证 Prompt")).toHaveValue("");
  });
});
