import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, ModelDetail, TimelineDocument, TimelineState } from "@aivideo/contracts";
import type { DesktopApi } from "../electron/preload/index.js";
import { App } from "../src/app/App.js";

const now = "2026-08-11T00:00:00.000Z";
const project = { project_id: "project_1" as never, name: "演示项目", status: "active" as const, canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 }, root_dir_name: "Demo", current_timeline_revision_id: "revision_1", created_at: now, updated_at: now, last_opened_at: now };
const video = { asset_id: "asset_video" as never, project_id: project.project_id, kind: "video" as const, storage_mode: "external" as const, display_name: "很长的中文素材文件名-第一幕.mp4", fingerprint: "a".repeat(64), size_bytes: 10, modified_at: now, availability: "available" as const, media_info: { duration_us: 5_000_000 }, created_at: now, updated_at: now };
const image = { ...video, asset_id: "asset_image" as never, kind: "image" as const, display_name: "海报.png", media_info: { duration_us: 0 } };
const timelineDocument: TimelineDocument = { schema_version: 1, project_id: project.project_id, canvas: { ...project.canvas, background_color: "#000000" }, tracks: [{ id: "V1", kind: "visual", locked: false }, { id: "C1", kind: "caption", locked: false }], clips: [{ clip_id: "clip_1" as never, track_id: "V1", order_index: 0, asset_id: video.asset_id, asset_kind: "video", source_start_us: 0, source_end_us: 5_000_000, timeline_start_us: 0, timeline_end_us: 5_000_000, layout: "fit", audio: { enabled: true, gain_db: 0 } }], captions: [{ caption_id: "caption_1" as never, track_id: "C1", source_clip_id: "clip_1" as never, start_us: 0, end_us: 1_000_000, text: "这是一条很长的中文字幕，用于验证编辑与布局。", preset_id: "default-bottom", origin: "transcript", edited: false, source_segment_ids: ["segment_1" as never] }], provenance: { created_by: "user", source_transcript_ids: ["transcript_1" as never] } };
const state: TimelineState = { project_id: project.project_id, current_revision: { timeline_revision_id: "revision_1" as never, project_id: project.project_id, parent_revision_id: null, document_sha256: "a".repeat(64), summary: "创建", created_by: "user", created_at: now, schema_version: 1, document: timelineDocument }, draft: null, can_undo: true, can_redo: true, current_preview: null };
const transcript = { transcript_id: "transcript_1" as never, asset_id: video.asset_id, status: "ready" as const, language: "zh", segments: [{ segment_id: "segment_1" as never, ordinal: 0, start_us: 0, end_us: 1_000_000, text: "第一句", confidence: 1, words: null }], words: null, provider: "fixture", model_id: "model_1" as never, model_revision: "v1", source_media_fingerprint: video.fingerprint, duration_us: 5_000_000, created_at: now, updated_at: now };
const model: ModelDetail = { model_id: "model_1" as never, display_name: "本地测试模型", purpose: "本地语音转录", provider: "fixture", revision: "v1", supported_languages: ["zh", "en"], supports_word_timestamps: true, runtime_version: "1", model_size_bytes: 1024, installed_size_bytes: 2048, model_sha256: "b".repeat(64), license: { id: "license_1", name: "测试许可证", url: null, attribution: null, acceptance_required: true }, source: { kind: "trusted_manifest", display_name: "内置清单", host: null, url: null }, requires_network: true, local_only: true, status: "unavailable", provider_status: "installed", progress: null, required_disk_bytes: 4096, runtime_requirements: {}, files: [], available_disk_bytes: 8192 };
const readyModel = { ...model, status: "ready" as const };
const job: Job = { job_id: "job_1" as never, project_id: project.project_id, asset_id: video.asset_id, kind: "transcription", status: "interrupted", stage: "failed", progress: 0, attempt: 1, model_id: model.model_id, model_revision: model.revision, input_fingerprint: video.fingerprint, input: { asset_id: video.asset_id }, error: { code: "JOB_INTERRUPTED", message: "interrupted" }, created_at: now, updated_at: now, started_at: null, finished_at: now };
const runningJob = { ...job, job_id: "job_running" as never, status: "running" as const, stage: "transcribing", error: null };
const createdJob = { ...runningJob, job_id: "job_created" as never };
const downloadJob = { ...runningJob, job_id: "job_download" as never, asset_id: null, kind: "model_download" as const };

function desktopApi(options: { timeline?: TimelineState | null; models?: ModelDetail[]; jobs?: Job[] } = {}): DesktopApi {
  const timeline = options.timeline === undefined ? state : options.timeline;
  let transcriptionSequence = 0;
  return {
    getRuntime: vi.fn().mockResolvedValue({ protocol_version: 1, status: "ready" }), chooseMedia: vi.fn(), probeMedia: vi.fn(),
    listProjects: vi.fn().mockResolvedValue({ items: [project], next_cursor: null }), createProject: vi.fn().mockResolvedValue({ ...project, project_id: "project_2", name: "新项目" }), getProject: vi.fn().mockResolvedValue(project), renameProject: vi.fn().mockResolvedValue({ ...project, name: "已重命名" }), archiveProject: vi.fn().mockResolvedValue({ ...project, status: "archived" }), reopenProject: vi.fn().mockResolvedValue(project),
    listAssets: vi.fn().mockResolvedValue({ items: [{ asset: video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }, { asset: image, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGHI" }], next_cursor: null }), importAsset: vi.fn().mockImplementation(async ({ kind }: { kind?: string }) => ({ grant: {}, asset: { ...image, asset_id: `import_${kind}` as never, kind: kind ?? "video", display_name: `import-${kind}` }, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGHI" })), refreshAsset: vi.fn().mockResolvedValue({ asset: video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }), relocateAsset: vi.fn().mockResolvedValue({ grant: {}, asset: video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }),
    listJobs: vi.fn().mockResolvedValue({ items: options.jobs ?? [], next_cursor: null }), createJob: vi.fn(), getJob: vi.fn(), cancelJob: vi.fn().mockImplementation(async (jobId: string) => ({ ...createdJob, job_id: jobId, status: "cancelled" })), listModels: vi.fn().mockResolvedValue({ items: options.models ?? [], next_cursor: null }), getModel: vi.fn().mockResolvedValue(model), downloadModel: vi.fn().mockResolvedValue({ model: { ...model, status: "queued" }, job: downloadJob }), getModelDownload: vi.fn(), cancelModelDownload: vi.fn().mockResolvedValue({ model: { ...model, status: "cancelled" }, job: { ...downloadJob, status: "cancelled" } }), createTranscription: vi.fn().mockImplementation(async () => ({ job: { ...createdJob, job_id: `job_created_${++transcriptionSequence}` as never }, transcript: null })),
    listTranscripts: vi.fn().mockResolvedValue({ items: [{ ...transcript, segments: undefined, words: undefined }], next_cursor: null }), getTranscript: vi.fn().mockResolvedValue(transcript),
    getBrief: vi.fn().mockRejectedValue(new Error("BRIEF_NOT_FOUND")), putBrief: vi.fn().mockResolvedValue({}), listRecipes: vi.fn().mockResolvedValue({ items: [{ schema_version: 1, recipe_id: "balanced-narrative-v1", name: "Balanced", summary: "测试", rules: { selection: "keyword", pace: "balanced", max_gap_us: 1 }, document_sha256: `sha256:${"a".repeat(64)}` }] }), listProviders: vi.fn().mockResolvedValue({ items: [{ provider_config_id: "provider_1", display_name: "测试 Provider", credential_status: "configured" }] }), createProvider: vi.fn(), setProviderSecret: vi.fn(), deleteProviderSecret: vi.fn().mockResolvedValue({ provider_config_id: "provider_1", credential_status: "missing" }), testProvider: vi.fn().mockResolvedValue({ status: "succeeded" }), preparePlanning: vi.fn().mockResolvedValue({ egress_preview_id: "preview_1", provider: { display_name: "测试", origin: "https://provider.test", model: "model" }, prompt_template_version: "candidate-plan-v1", sent_fields: ["segments.text"], payload_sha256: `sha256:${"b".repeat(64)}`, expires_at: now, payload: { segments: [{ segment_ref: "s1", text: "第一句" }] }, stats: { transcript_count: 1, segment_count: 1, character_count: 3, estimated_tokens: 1 } }), createPlanning: vi.fn().mockResolvedValue({ job: { ...createdJob, kind: "candidate_generation" } }), listCandidatePlans: vi.fn().mockResolvedValue({ items: [] }), getCandidateClipMedia: vi.fn(), adoptCandidatePlan: vi.fn().mockResolvedValue(state),
    createTimeline: vi.fn().mockResolvedValue(state), getTimeline: timeline ? vi.fn().mockResolvedValue(timeline) : vi.fn().mockRejectedValue(new Error("TIMELINE_NOT_FOUND 404")), patchTimeline: vi.fn().mockResolvedValue(state), undoTimeline: vi.fn().mockResolvedValue(state), redoTimeline: vi.fn().mockResolvedValue(state), saveTimelineDraft: vi.fn().mockResolvedValue({ project_id: project.project_id, base_revision_id: state.current_revision.timeline_revision_id, document: timelineDocument, updated_at: now, conflict: false }), deleteTimelineDraft: vi.fn().mockResolvedValue(undefined), listTimelineRevisions: vi.fn(), getTimelineRevision: vi.fn(),
    createPreview: vi.fn().mockResolvedValue({ job: null, preview: null, reused: false }), listPreviews: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), chooseExportDestination: vi.fn().mockResolvedValue(null), createExport: vi.fn(), listExports: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), getRenderArtifact: vi.fn(),
    openArtifact: vi.fn(), openArtifactFolder: vi.fn(), subscribeJob: vi.fn().mockReturnValue(() => undefined), diagnostics: vi.fn()
  } as DesktopApi;
}

describe("Stage 1A/1B 工作流", () => {
  beforeEach(() => { window.desktop = desktopApi(); });
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it("支持项目创建、重命名、归档、重开和四类素材导入", async () => {
    const api = desktopApi();
    const createdProject = { ...project, project_id: "project_2" as never, name: "新项目" };
    api.createProject = vi.fn().mockResolvedValue(createdProject);
    api.listProjects = vi.fn()
      .mockResolvedValueOnce({ items: [project], next_cursor: null })
      .mockResolvedValue({ items: [project, createdProject], next_cursor: null });
    window.desktop = api; render(<App />);
    await screen.findByRole("option", { name: "演示项目" });
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "新项目" } }); fireEvent.click(screen.getByRole("button", { name: /^创建$/ })); await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({ name: "新项目" }));
    // Wait for the finished create mutation, then use the real project picker
    // to continue the remaining workflow on project_1.  API invocation alone
    // is not completion: createProject still refreshes and selects its result.
    await screen.findByRole("heading", { name: "新项目" });
    fireEvent.change(screen.getByLabelText("当前项目"), { target: { value: "project_1" } });
    await screen.findByRole("heading", { name: "演示项目" });
    fireEvent.change(screen.getByLabelText("重命名项目"), { target: { value: "已重命名" } }); fireEvent.click(screen.getByRole("button", { name: "重命名" })); await waitFor(() => expect(api.renameProject).toHaveBeenCalledWith({ project_id: "project_1", name: "已重命名" }));
    await screen.findByRole("heading", { name: "已重命名" });
    fireEvent.click(screen.getByRole("button", { name: "归档" })); await waitFor(() => expect(api.archiveProject).toHaveBeenCalledWith("project_1"));
    await screen.findByRole("button", { name: "重新打开" });
    fireEvent.click(screen.getByRole("button", { name: "重新打开" })); await waitFor(() => expect(api.reopenProject).toHaveBeenCalledWith("project_1"));
    await screen.findByRole("button", { name: "归档" });
    for (const kind of ["video", "audio", "image", "text"] as const) fireEvent.click(screen.getByRole("button", { name: `导入${kind}` }));
    await waitFor(() => expect(api.importAsset).toHaveBeenCalledTimes(4));
    expect(api.importAsset).toHaveBeenNthCalledWith(1, { project_id: "project_1", kind: "video" }); expect(api.importAsset).toHaveBeenNthCalledWith(4, { project_id: "project_1", kind: "text" });
  });

  it("卸载后的启动请求不会穿透到后来挂载的 Desktop bridge", async () => {
    let resolveRuntime!: () => void;
    const lateRuntime = new Promise<{ protocol_version: 1; status: "ready" }>(resolve => { resolveRuntime = () => resolve({ protocol_version: 1, status: "ready" }); });
    const staleApi = desktopApi(); staleApi.getRuntime = vi.fn().mockReturnValue(lateRuntime);
    window.desktop = staleApi; const stale = render(<App />); stale.unmount();
    const freshApi = desktopApi(); window.desktop = freshApi; render(<App />);
    await screen.findByRole("option", { name: "演示项目" });
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
    let refreshProjects!: () => void;
    let resolveStaleRefresh!: (value: { items: (typeof project)[]; next_cursor: null }) => void;
    const staleRefresh = new Promise<{ items: (typeof project)[]; next_cursor: null }>(resolve => { resolveStaleRefresh = resolve; });
    const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 1500) refreshProjects = callback as () => void;
      return 1 as never;
    });
    const api = desktopApi();
    api.listProjects = vi.fn()
      .mockResolvedValueOnce({ items: [project], next_cursor: null })
      .mockReturnValueOnce(staleRefresh)
      .mockResolvedValueOnce({ items: [confirmedProject, refreshedProjectQ], next_cursor: null });
    api.renameProject = vi.fn().mockResolvedValue(confirmedProject);
    window.desktop = api;
    render(<App />);
    await screen.findByRole("option", { name: "演示项目" });

    expect(refreshProjects).toBeTypeOf("function");
    await act(async () => { refreshProjects(); });
    await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(2));
    const renameInput = screen.getByLabelText("重命名项目");
    fireEvent.change(renameInput, { target: { value: "用户未提交草稿" } });
    expect(renameInput).toHaveValue("用户未提交草稿");

    await act(async () => { resolveStaleRefresh({ items: [staleProject, projectQ], next_cursor: null }); });
    await waitFor(() => expect(renameInput).toHaveValue("用户未提交草稿"));
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    await waitFor(() => expect(api.renameProject).toHaveBeenCalledWith({ project_id: project.project_id, name: "用户未提交草稿" }));
    await waitFor(() => expect(renameInput).toHaveValue("服务端确认名"));

    const refreshForProjectP = refreshProjects;
    fireEvent.change(screen.getByLabelText("当前项目"), { target: { value: projectQ.project_id } });
    await waitFor(() => expect(renameInput).toHaveValue("服务端项目 Q"));
    await waitFor(() => expect(refreshProjects).not.toBe(refreshForProjectP));
    await act(async () => { refreshProjects(); });
    await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(renameInput).toHaveValue("服务端项目 Q（刷新）"));
    intervalSpy.mockRestore();
  });

  it("支持素材刷新、重新定位和只读 Transcript 查看", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />); await screen.findByText(video.display_name);
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]); fireEvent.click(screen.getAllByRole("button", { name: "重新定位" })[0]);
    await waitFor(() => expect(api.refreshAsset).toHaveBeenCalledWith(video.asset_id)); await waitFor(() => expect(api.relocateAsset).toHaveBeenCalledWith({ asset_id: video.asset_id }));
    fireEvent.click(screen.getByTitle("转录")); expect(await screen.findByText("当前没有可用的本地 ASR 模型")).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: /^转录$/ })[0]);
    fireEvent.click(await screen.findByRole("button", { name: /查看转录/ })); expect(await screen.findByText("原始 ASR 结果只读。字幕修订不会覆盖这份记录。")).toBeVisible(); expect(screen.getAllByText("第一句")).toHaveLength(2);
  });

  it("支持模型确认下载、取消下载、发起转录及任务取消重试", async () => {
    const api = desktopApi({ models: [model] }); window.desktop = api; render(<App />); await screen.findByText("本地测试模型");
    fireEvent.click(screen.getByRole("button", { name: "下载模型" })); expect(await screen.findByRole("heading", { name: "确认下载本地模型" })).toBeVisible(); const confirm = screen.getByRole("button", { name: "确认并下载" }); expect(confirm).toBeDisabled(); fireEvent.click(screen.getByRole("checkbox", { name: /接受/ })); fireEvent.click(confirm); await waitFor(() => expect(api.downloadModel).toHaveBeenCalledWith({ model_id: model.model_id, license_acceptance: "license_1" }));
    fireEvent.click(await screen.findByTitle("取消模型下载")); await waitFor(() => expect(api.cancelModelDownload).toHaveBeenCalledWith(model.model_id));
    const readyApi = desktopApi({ models: [readyModel], jobs: [job] }); window.desktop = readyApi; cleanup(); render(<App />); await screen.findByText("本地测试模型"); fireEvent.click(await screen.findByTitle("转录")); expect(await screen.findByRole("heading", { name: "创建本地转录" })).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "开始转录" })); await waitFor(() => expect(readyApi.createTranscription).toHaveBeenCalledWith(expect.objectContaining({ asset_id: video.asset_id, model_id: model.model_id })));
    fireEvent.click(screen.getByRole("button", { name: "重试转录" })); await waitFor(() => expect(readyApi.createTranscription).toHaveBeenCalledTimes(2)); fireEvent.click(screen.getAllByRole("button", { name: "取消任务" })[0]); await waitFor(() => expect(readyApi.cancelJob).toHaveBeenCalledWith("job_created_2"));
  });
});

describe("Stage 1C Editor", () => {
  beforeEach(() => { window.desktop = desktopApi(); });
  afterEach(() => cleanup());

  it("渲染固定编辑工作台且不暴露敏感字段", async () => {
    render(<App />); expect(await screen.findByRole("option", { name: "演示项目" })).toBeVisible(); expect(await screen.findByText(video.display_name)).toBeVisible(); expect(screen.getByText("V1")).toBeVisible(); expect(screen.getByText("C1")).toBeVisible(); expect(screen.getByText(/非权威/)).toBeVisible(); expect(document.body.textContent).not.toContain("C:\\");
  });

  it("支持片段与字幕编辑", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />); fireEvent.click(await screen.findByRole("button", { name: /video 5.00s/ })); fireEvent.click(screen.getByRole("button", { name: "拆分片段" })); await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [expect.objectContaining({ op: "split_clip" })] }) }))); fireEvent.change(screen.getByLabelText("布局"), { target: { value: "crop_fill" } }); await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [expect.objectContaining({ op: "set_layout", layout: "crop_fill" })] }) }))); fireEvent.click(screen.getByRole("button", { name: /这是一条很长/ })); fireEvent.change(screen.getByLabelText("文本"), { target: { value: "修正字幕" } }); fireEvent.blur(screen.getByLabelText("文本")); await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [expect.objectContaining({ op: "update_caption", text: "修正字幕" })] }) })));
  });

  it("创建空时间线后忽略迟到的 404，并以冻结契约追加素材与转录", async () => {
    let rejectTimeline!: (reason: unknown) => void; const pendingTimeline = new Promise<TimelineState>((_, reject) => { rejectTimeline = reject; }); const api = desktopApi({ timeline: null }); api.getTimeline = vi.fn().mockReturnValue(pendingTimeline); window.desktop = api; render(<App />); fireEvent.click(await screen.findByRole("button", { name: "创建空时间线" })); await screen.findByRole("button", { name: /video 5.00s/ }); rejectTimeline(new Error("TIMELINE_NOT_FOUND 404"));
    fireEvent.click(screen.getByRole("button", { name: /追加 很长的中文素材/ })); await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [expect.objectContaining({ op: "insert_asset_clip" })] }) })));
    fireEvent.click(screen.getAllByRole("button", { name: /^转录$/ })[0]); fireEvent.click(await screen.findByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "追加所选片段" }));
    await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledTimes(2)); const operation = vi.mocked(api.patchTimeline).mock.calls[1][0].patch.operations[0]; expect(operation).toEqual({ op: "insert_transcript_segments", transcript_id: transcript.transcript_id, segment_ids: [transcript.segments[0].segment_id], at_index: timelineDocument.clips.length, padding_before_us: 150_000, padding_after_us: 150_000, create_captions: true, layout: "blurred_background" }); expect(operation).not.toHaveProperty("kind");
  });

  it("使用服务端 Revision 执行撤销重做并显示草稿恢复入口", async () => {
    const api = desktopApi({ timeline: { ...state, draft: { project_id: project.project_id, base_revision_id: state.current_revision.timeline_revision_id, document: timelineDocument, updated_at: now, conflict: false } } }); window.desktop = api; render(<App />); expect(await screen.findByText("检测到上次未恢复草稿")).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "丢弃" })); expect(api.deleteTimelineDraft).toHaveBeenCalledWith("project_1"); fireEvent.click(screen.getByRole("button", { name: "撤销" })); await waitFor(() => expect(api.undoTimeline).toHaveBeenCalled()); fireEvent.click(screen.getByRole("button", { name: "重做" })); await waitFor(() => expect(api.redoTimeline).toHaveBeenCalled());
  });
});

describe("Stage 2A AI 粗剪", () => {
  afterEach(() => cleanup());
  it("必须先 prepare 再经明确确认创建，且不渲染密钥", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />);
    await screen.findByRole("option", { name: "演示项目" });
    fireEvent.click(screen.getByRole("button", { name: "AI 粗剪" }));
    fireEvent.change(await screen.findByLabelText("主题"), { target: { value: "游戏高光" } });
    fireEvent.change(screen.getByLabelText("受众"), { target: { value: "玩家" } });
    fireEvent.change(screen.getByLabelText("叙事目标"), { target: { value: "展示关键操作" } });
    fireEvent.change(screen.getByLabelText("制作配方"), { target: { value: "balanced-narrative-v1" } });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "provider_1" } });
    fireEvent.change(screen.getByLabelText("就绪转录"), { target: { value: "transcript_1" } });
    fireEvent.change(screen.getByLabelText("Provider 密钥"), { target: { value: "SENTINEL-SECRET" } });
    fireEvent.click(screen.getByRole("button", { name: "安全保存密钥" }));
    await waitFor(() => expect(api.setProviderSecret).toHaveBeenCalledWith({ provider_config_id: "provider_1", secret: "SENTINEL-SECRET" }));
    expect(document.body.textContent).not.toContain("SENTINEL-SECRET");
    expect(api.createPlanning).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "准备外传确认" }));
    await screen.findByText("确认发送的精确内容"); expect(api.preparePlanning).toHaveBeenCalled(); expect(api.createPlanning).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "我确认发送以上内容" }));
    await waitFor(() => expect(api.createPlanning).toHaveBeenCalledWith({ project_id: "project_1", egress_preview_id: "preview_1", payload_sha256: `sha256:${"b".repeat(64)}` }));
  });
  it("删除密钥使用白名单桥接且不回显", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />); await screen.findByRole("option", { name: "演示项目" });
    fireEvent.click(screen.getByRole("button", { name: "AI 粗剪" })); fireEvent.change(await screen.findByLabelText("Provider"), { target: { value: "provider_1" } });
    fireEvent.click(screen.getByRole("button", { name: "删除当前 Provider 密钥" })); await waitFor(() => expect(api.deleteProviderSecret).toHaveBeenCalledWith("provider_1"));
    expect(document.body.textContent).not.toContain("SENTINEL-KEY-NEVER-LOG");
  });
  it.each(["failed", "cancelled", "interrupted"] as const)("任务 %s 会清除旧外传预览，取消按钮调用任务取消并强制重新准备", async status => {
    const api = desktopApi(); let listener: ((value: Job) => void) | undefined;
    api.subscribeJob = vi.fn((_id, next) => { listener = next; return () => undefined; });
    window.desktop = api; render(<App />); await screen.findByRole("option", { name: "演示项目" });
    fireEvent.click(screen.getByRole("button", { name: "AI 粗剪" }));
    fireEvent.change(await screen.findByLabelText("主题"), { target: { value: "游戏高光" } }); fireEvent.change(screen.getByLabelText("受众"), { target: { value: "玩家" } }); fireEvent.change(screen.getByLabelText("叙事目标"), { target: { value: "展示操作" } }); fireEvent.change(screen.getByLabelText("制作配方"), { target: { value: "balanced-narrative-v1" } }); fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "provider_1" } }); fireEvent.change(screen.getByLabelText("就绪转录"), { target: { value: "transcript_1" } });
    fireEvent.click(screen.getByRole("button", { name: "准备外传确认" })); await screen.findByText("确认发送的精确内容"); fireEvent.click(screen.getByRole("button", { name: "我确认发送以上内容" }));
    expect(await screen.findByRole("button", { name: "取消生成" })).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "取消生成" })); expect(api.cancelJob).toHaveBeenCalledWith("job_created");
    expect(listener).toBeTypeOf("function"); listener?.({ ...createdJob, status, stage: status, progress: 0, error: { code: `JOB_${status.toUpperCase()}`, message: status } });
    expect(await screen.findByRole("button", { name: "准备外传确认" })).toBeVisible(); expect(screen.queryByText("确认发送的精确内容")).not.toBeInTheDocument(); expect(api.createPlanning).toHaveBeenCalledTimes(1);
  });
});

describe("Stage 1C Render", () => {
  beforeEach(() => { window.desktop = desktopApi(); });
  afterEach(() => cleanup());

  it("按冻结 Revision 和编码模式创建权威预览，并允许无预览直接导出", async () => {
    const api = desktopApi();
    const previewJob = { ...runningJob, job_id: "job_preview" as never, asset_id: null, kind: "authoritative_preview" as const, status: "queued" as const, stage: "queued" };
    const exportJob = { ...previewJob, job_id: "job_export" as never, kind: "final_export" as const };
    vi.mocked(api.createPreview).mockResolvedValue({ job: previewJob, preview: null, reused: false });
    vi.mocked(api.chooseExportDestination).mockResolvedValue({ destination_grant_id: "destination_1" as never, display_name: "演示项目.mp4", extension: ".mp4", overwrite_authorized: false, expires_at: now });
    vi.mocked(api.createExport).mockResolvedValue({ job: exportJob, export_record: null });
    window.desktop = api; render(<App />);
    await screen.findByRole("option", { name: "演示项目" });
    const previewButton = screen.getByRole("button", { name: "生成预览" });
    await waitFor(() => expect(previewButton).toBeEnabled());
    fireEvent.change(screen.getByLabelText("编码模式"), { target: { value: "software" } });
    fireEvent.click(previewButton);
    await waitFor(() => expect(api.createPreview).toHaveBeenCalledWith({ project_id: project.project_id, preview: { timeline_revision_id: state.current_revision.timeline_revision_id, encoder_mode: "software" } }));
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(api.chooseExportDestination).toHaveBeenCalledWith(project.project_id));
    expect(api.createExport).toHaveBeenCalledWith({ project_id: project.project_id, export: { timeline_revision_id: state.current_revision.timeline_revision_id, destination_grant_id: "destination_1", encoder_mode: "software" } });
  });

  it("空时间线和草稿会阻止 Render 提交", async () => {
    const emptyDocument = { ...timelineDocument, clips: [], captions: [] };
    const emptyState = { ...state, current_revision: { ...state.current_revision, document: emptyDocument } };
    const emptyApi = desktopApi({ timeline: emptyState }); window.desktop = emptyApi; render(<App />);
    expect(await screen.findByRole("button", { name: "生成预览" })).toBeDisabled(); expect(screen.getByRole("button", { name: "导出" })).toBeDisabled();
    cleanup();
    const draftState = { ...state, draft: { project_id: project.project_id, base_revision_id: state.current_revision.timeline_revision_id, document: timelineDocument, updated_at: now, conflict: false } };
    const draftApi = desktopApi({ timeline: draftState }); window.desktop = draftApi; render(<App />);
    await waitFor(() => {
      expect(screen.getByText("检测到上次未恢复草稿")).toBeVisible();
      expect(screen.getByRole("button", { name: "生成预览" })).toHaveAttribute("title", "存在未提交草稿，请先形成正式 Revision");
    });
  });
});
