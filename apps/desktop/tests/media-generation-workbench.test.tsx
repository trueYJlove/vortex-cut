import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AssetPresentation,
  MediaGenerationPreparedRequest,
  MediaGenerationRequest,
  MediaGenerationTask,
  Project,
} from "@aivideo/contracts";
import type { DesktopApi } from "../electron/preload/index.js";
import { MediaGenerationWorkbench } from "../src/app/media-generation/MediaGenerationWorkbench.js";

const now = "2026-08-18T00:00:00.000Z";
const project: Project = {
  project_id: "project_stage4b" as never,
  name: "Stage 4B",
  status: "active",
  canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 },
  root_dir_name: "Stage4B",
  current_timeline_revision_id: null,
  created_at: now,
  updated_at: now,
  last_opened_at: now,
};
const secondProject = { ...project, project_id: "project_other" as never, name: "另一个项目" };
const assets: AssetPresentation[] = [{
  asset: {
    asset_id: "asset_safe" as never,
    project_id: project.project_id,
    kind: "image",
    storage_mode: "external",
    display_name: "安全素材.png",
    fingerprint: "a".repeat(64),
    size_bytes: 10,
    modified_at: now,
    availability: "available",
    media_info: { duration_us: 0 },
    created_at: now,
    updated_at: now,
  },
  media_url: "aivideo://media/SECRET_MEDIA_URL",
}];
const promptHash = `sha256:${"b".repeat(64)}`;
const requestHash = `sha256:${"c".repeat(64)}`;
const prepared: MediaGenerationPreparedRequest = {
  schema_version: 1,
  project_id: project.project_id,
  generation_kind: "image",
  execution_mode: "simulation_only",
  prompt_sha256: promptHash,
  input_refs: ["asset_safe"],
  parameters: { width: 1024, height: 1024 },
  request_sha256: requestHash,
};
const request: MediaGenerationRequest = {
  request_id: "request_1" as never,
  project_id: project.project_id,
  generation_kind: "image",
  execution_mode: "simulation_only",
  prompt_sha256: promptHash,
  input_refs: ["asset_safe"],
  parameters: { width: 1024, height: 1024 },
  request_sha256: requestHash,
  created_at: now,
};
function task(status: MediaGenerationTask["status"], attempt = 1, id = `task_${attempt}`): MediaGenerationTask {
  const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(status);
  return {
    task_id: id as never,
    request_id: request.request_id,
    job_id: `job_${attempt}` as never,
    attempt,
    status,
    stage: status === "succeeded" ? "completed" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : status === "interrupted" ? "interrupted" : status,
    retry_of_task_id: attempt > 1 ? "task_1" as never : null,
    output_asset_id: null,
    output_sha256: null,
    result_summary: status === "succeeded" ? { execution_mode: "simulation_only", outcome: "validated_without_media", provider_call_count: 0 } : null,
    error: status === "failed" ? { code: "PROVIDER_FAILED", message: "安全失败" } : null,
    created_at: now,
    updated_at: now,
    finished_at: terminal ? now : null,
  };
}

function generationApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    prepareMediaGeneration: vi.fn().mockResolvedValue(prepared),
    createMediaGeneration: vi.fn().mockResolvedValue({ request, task: task("succeeded"), reused: false }),
    listMediaGenerationRequests: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    getMediaGenerationRequest: vi.fn().mockResolvedValue(request),
    listMediaGenerationTasks: vi.fn().mockResolvedValue({ items: [task("succeeded")], next_cursor: null }),
    retryMediaGenerationTask: vi.fn().mockResolvedValue(task("queued", 2)),
    cancelMediaGenerationTask: vi.fn().mockResolvedValue(task("cancelled")),
    subscribeJob: vi.fn().mockReturnValue(vi.fn()),
    ...overrides,
  } as unknown as DesktopApi;
}

async function fillImageForm() {
  fireEvent.change(screen.getByLabelText("生成验证 Prompt"), { target: { value: "仅用于本地验证的秘密 Prompt" } });
  fireEvent.click(screen.getByLabelText("引用素材 安全素材.png"));
  await waitFor(() => expect(screen.getByRole("button", { name: "准备验证" })).toBeEnabled());
}

function renderWorkbench(api = generationApi(), props: { project?: Project; assets?: AssetPresentation[]; onClose?: () => void } = {}) {
  window.desktop = api;
  const result = render(<MediaGenerationWorkbench project={props.project ?? project} assets={props.assets ?? assets} onClose={props.onClose ?? vi.fn()} />);
  return { api, ...result };
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

describe("Stage 4B 生成任务验证工作台", () => {
  it("持续显示 simulation_only 边界，并且素材区域不暴露 media_url", async () => {
    renderWorkbench();
    expect((await screen.findAllByText(/Provider 调用 0 次/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("dialog", { name: "生成验证（模拟）" })).toBeVisible();
    expect(screen.getByLabelText("生成验证 Prompt")).toHaveValue("");
    expect(screen.getByText("安全素材.png")).toBeVisible();
    expect(document.body.textContent).not.toContain("SECRET_MEDIA_URL");
    expect(screen.getByText("图片参数验证")).toBeVisible();
    fireEvent.click(screen.getByLabelText("TTS 参数验证"));
    expect(screen.getByLabelText("声音验证预设")).toHaveValue("validation_voice");
    expect(screen.getByText(/不会合成或试听真实声音/)).toBeVisible();
  });

  it("Prepare 只提交 Asset ID，确认页不回显 Prompt，Create 后清除 Prompt 并显示零 Provider 成功结果", async () => {
    const api = generationApi();
    renderWorkbench(api);
    await fillImageForm();
    fireEvent.click(screen.getByRole("button", { name: "准备验证" }));

    await screen.findByRole("heading", { name: "确认模拟验证请求" });
    expect(api.prepareMediaGeneration).toHaveBeenCalledWith({
      project_id: project.project_id,
      request: { generation_kind: "image", prompt: "仅用于本地验证的秘密 Prompt", input_refs: ["asset_safe"], parameters: { width: 1024, height: 1024 } },
    });
    const preparePayload = JSON.stringify(vi.mocked(api.prepareMediaGeneration).mock.calls[0]);
    expect(preparePayload).not.toContain("SECRET_MEDIA_URL");
    expect(document.body.textContent).not.toContain("仅用于本地验证的秘密 Prompt");
    expect(screen.getByText(/17 字符；正文不回显/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "确认并创建验证任务" }));
    expect(await screen.findByText(/验证完成，未生成媒体 · Provider 调用 0 次/)).toBeVisible();
    expect(api.createMediaGeneration).toHaveBeenCalledWith({
      project_id: project.project_id,
      request: { generation_kind: "image", prompt: "仅用于本地验证的秘密 Prompt", input_refs: ["asset_safe"], parameters: { width: 1024, height: 1024 }, request_sha256: requestHash },
    });
    fireEvent.click(screen.getByRole("tab", { name: "新建验证" }));
    expect(screen.getByLabelText("生成验证 Prompt")).toHaveValue("");
  });

  it("Create reused=true 时明确标记复用既有请求与任务", async () => {
    const api = generationApi({ createMediaGeneration: vi.fn().mockResolvedValue({ request, task: task("succeeded"), reused: true }) });
    renderWorkbench(api);
    await fillImageForm();
    fireEvent.click(screen.getByRole("button", { name: "准备验证" }));
    await screen.findByRole("heading", { name: "确认模拟验证请求" });
    fireEvent.click(screen.getByRole("button", { name: "确认并创建验证任务" }));
    expect(await screen.findByText("复用既有请求与任务")).toBeVisible();
  });
  it("返回修改后字段变化必须重新 Prepare，支持 TTS 白名单参数", async () => {
    const ttsPrepared = { ...prepared, generation_kind: "tts" as const, parameters: { voice_preset_id: "validation_voice", language: "en-US" as const, speed_milli: 1200 } };
    const api = generationApi({ prepareMediaGeneration: vi.fn().mockResolvedValue(ttsPrepared) });
    renderWorkbench(api);
    await waitFor(() => expect(screen.getByLabelText("TTS 参数验证")).toBeEnabled());
    fireEvent.click(screen.getByLabelText("TTS 参数验证"));
    fireEvent.change(screen.getByLabelText("生成验证 Prompt"), { target: { value: "TTS 验证" } });
    fireEvent.click(screen.getByLabelText("引用素材 安全素材.png"));
    fireEvent.change(screen.getByLabelText("TTS 语言"), { target: { value: "en-US" } });
    fireEvent.change(screen.getByLabelText("TTS 速度"), { target: { value: "1200" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "准备验证" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "准备验证" }));
    await screen.findByRole("heading", { name: "确认模拟验证请求" });
    fireEvent.click(screen.getByRole("button", { name: "返回修改" }));
    fireEvent.change(screen.getByLabelText("TTS 速度"), { target: { value: "1300" } });
    expect(screen.queryByRole("heading", { name: "确认模拟验证请求" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "准备验证" })).toBeEnabled();
    expect(api.prepareMediaGeneration).toHaveBeenCalledTimes(1);
  });

  it("Create 按立即回读、订阅、二次回读捕获快速终态，Job 事件只触发 Task 权威回读", async () => {
    let listener: (() => void) | undefined;
    const snapshots = [[task("running")], [task("succeeded")], [task("succeeded")]];
    const listTasks = vi.fn().mockImplementation(async () => ({ items: snapshots.shift() ?? [task("succeeded")], next_cursor: null }));
    const api = generationApi({
      createMediaGeneration: vi.fn().mockResolvedValue({ request, task: task("queued"), reused: false }),
      listMediaGenerationTasks: listTasks,
      subscribeJob: vi.fn((_job, callback) => { listener = () => callback({} as never); return vi.fn(); }),
    });
    renderWorkbench(api);
    await fillImageForm();
    fireEvent.click(screen.getByRole("button", { name: "准备验证" }));
    await screen.findByRole("heading", { name: "确认模拟验证请求" });
    fireEvent.click(screen.getByRole("button", { name: "确认并创建验证任务" }));
    expect(await screen.findByText(/验证完成，未生成媒体/)).toBeVisible();
    expect(api.subscribeJob).toHaveBeenCalledWith("job_1", expect.any(Function));
    expect(listTasks.mock.calls.length).toBeGreaterThanOrEqual(2);

    const beforeEvent = listTasks.mock.calls.length;
    await act(async () => { listener?.(); await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(listTasks.mock.calls.length).toBeGreaterThan(beforeEvent);
  });

  it("展示六种冻结状态，并仅按状态开放 cancel/retry，保留 retry lineage", async () => {
    const allTasks = [task("queued", 1, "queued"), task("running", 2, "running"), task("succeeded", 3, "succeeded"), task("failed", 4, "failed"), task("cancelled", 5, "cancelled"), task("interrupted", 6, "interrupted")];
    allTasks[3]!.retry_of_task_id = "task_parent" as never;
    const api = generationApi({
      listMediaGenerationRequests: vi.fn().mockResolvedValue({ items: [request], next_cursor: null }),
      listMediaGenerationTasks: vi.fn().mockResolvedValue({ items: allTasks, next_cursor: null }),
    });
    renderWorkbench(api);
    fireEvent.click(await screen.findByRole("tab", { name: "历史与任务" }));
    for (const label of ["排队中", "运行中", "验证完成", "验证失败", "已取消", "已中断"]) expect(await screen.findByText(label)).toBeVisible();
    expect(screen.getByText("Retry parent：task_parent")).toBeVisible();
    const articles = screen.getAllByRole("article");
    expect(within(articles[0]!).getByRole("button", { name: "取消" })).toBeEnabled();
    expect(within(articles[0]!).getByRole("button", { name: "重试" })).toBeDisabled();
    expect(within(articles[2]!).getByRole("button", { name: "取消" })).toBeDisabled();
    expect(within(articles[2]!).getByRole("button", { name: "重试" })).toBeDisabled();
    expect(within(articles[3]!).getByRole("button", { name: "重试" })).toBeEnabled();
    expect(within(articles[4]!).getByRole("button", { name: "重试" })).toBeEnabled();
    expect(within(articles[5]!).getByRole("button", { name: "重试" })).toBeEnabled();
  });

  it("执行 cancel 与 retry 后回读 Task 权威状态", async () => {
    let current = [task("running")];
    const api = generationApi({
      listMediaGenerationRequests: vi.fn().mockResolvedValue({ items: [request], next_cursor: null }),
      listMediaGenerationTasks: vi.fn().mockImplementation(async () => ({ items: current, next_cursor: null })),
      cancelMediaGenerationTask: vi.fn().mockImplementation(async () => { current = [task("cancelled")]; return current[0]!; }),
      retryMediaGenerationTask: vi.fn().mockImplementation(async () => { current = [task("cancelled"), task("queued", 2)]; return current[1]!; }),
    });
    renderWorkbench(api);
    fireEvent.click(await screen.findByRole("tab", { name: "历史与任务" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    expect(await screen.findByText("已取消")).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: "重试" }).find(button => !button.hasAttribute("disabled"))!);
    expect(await screen.findByText("Attempt 2")).toBeVisible();
    expect(screen.getByText("Retry parent：task_1")).toBeVisible();
  });

  it("项目切换/卸载丢弃迟到响应并清理订阅和轮询", async () => {
    let resolveOldTasks!: (value: { items: MediaGenerationTask[]; next_cursor: null }) => void;
    const oldTasks = new Promise<{ items: MediaGenerationTask[]; next_cursor: null }>(resolve => { resolveOldTasks = resolve; });
    const stop = vi.fn();
    const api = generationApi({
      listMediaGenerationRequests: vi.fn().mockImplementation(async ({ project_id }) => project_id === project.project_id ? { items: [request], next_cursor: null } : { items: [], next_cursor: null }),
      listMediaGenerationTasks: vi.fn().mockReturnValue(oldTasks),
      subscribeJob: vi.fn().mockReturnValue(stop),
    });
    window.desktop = api;
    const result = render(<MediaGenerationWorkbench key={project.project_id} project={project} assets={assets} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史与任务" }));
    await screen.findByText("图片参数验证");
    result.rerender(<MediaGenerationWorkbench key={secondProject.project_id} project={secondProject} assets={[]} onClose={vi.fn()} />);
    resolveOldTasks({ items: [task("running")], next_cursor: null });
    await act(async () => { await oldTasks; await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "历史与任务" }));
    expect(await screen.findByText("尚无模拟验证记录。")).toBeVisible();
    result.unmount();
    expect(api.subscribeJob).not.toHaveBeenCalled();
  });

  it("卸载时清理已建立的 Job 订阅", async () => {
    const stop = vi.fn();
    const api = generationApi({
      listMediaGenerationRequests: vi.fn().mockResolvedValue({ items: [request], next_cursor: null }),
      listMediaGenerationTasks: vi.fn().mockResolvedValue({ items: [task("running")], next_cursor: null }),
      subscribeJob: vi.fn().mockReturnValue(stop),
    });
    const result = renderWorkbench(api);
    fireEvent.click(await screen.findByRole("tab", { name: "历史与任务" }));
    await waitFor(() => expect(api.subscribeJob).toHaveBeenCalled());
    result.unmount();
    expect(stop).toHaveBeenCalled();
  });
  it("原始异常、绝对路径和 Prompt sentinel 不进入 DOM 或 console", async () => {
    const secret = "PROMPT_SENTINEL_4B";
    const raw = `RAW_EXCEPTION C:\\Users\\secret\\media.mp4 ${secret}`;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api = generationApi({ prepareMediaGeneration: vi.fn().mockRejectedValue(new Error(raw)) });
    renderWorkbench(api);
    await waitFor(() => expect(screen.getByLabelText("引用素材 安全素材.png")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("生成验证 Prompt"), { target: { value: secret } });
    fireEvent.click(screen.getByLabelText("引用素材 安全素材.png"));
    fireEvent.click(screen.getByRole("button", { name: "准备验证" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成，请刷新后重试。");
    expect(document.body.textContent).not.toContain("RAW_EXCEPTION");
    expect(document.body.textContent).not.toContain("C:\\Users\\secret");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
