import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import type { Job, ModelDetail, TimelineDocument, TimelineState } from "@aivideo/contracts";
import type { AuthoritativePreviewPresentation, DesktopApi } from "../electron/preload/index.js";
import { App } from "../src/app/App.js";
import { fixturePreviewIrPresentation } from "./fixtures/preview-ir.js";

const now = "2026-08-11T00:00:00.000Z";
const project = { project_id: "project_1" as never, name: "演示项目", status: "active" as const, canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 }, root_dir_name: "Demo", current_timeline_revision_id: "revision_1", created_at: now, updated_at: now, last_opened_at: now };
const video = { asset_id: "asset_video" as never, project_id: project.project_id, kind: "video" as const, storage_mode: "external" as const, display_name: "很长的中文素材文件名-第一幕.mp4", fingerprint: "a".repeat(64), size_bytes: 10, modified_at: now, availability: "available" as const, media_info: { duration_us: 5_000_000 }, created_at: now, updated_at: now };
const image = { ...video, asset_id: "asset_image" as never, kind: "image" as const, display_name: "海报.png", media_info: { duration_us: 0 } };
const timelineDocument: TimelineDocument = { schema_version: 1, project_id: project.project_id, canvas: { ...project.canvas, background_color: "#000000" }, tracks: [{ id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false }, { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false }, { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false }], clips: [{ clip_id: "clip_1" as never, track_id: "V1", order_index: 0, asset_id: video.asset_id, asset_kind: "video", source_start_us: 0, source_end_us: 5_000_000, timeline_start_us: 0, timeline_end_us: 5_000_000, layout: "fit", audio: { enabled: true, gain_db: 0 } }], captions: [{ caption_id: "caption_1" as never, track_id: "C1", source_clip_id: "clip_1" as never, start_us: 0, end_us: 1_000_000, text: "这是一条很长的中文字幕，用于验证编辑与布局。", preset_id: "default-bottom", origin: "transcript", edited: false, source_segment_ids: ["segment_1" as never] }], provenance: { created_by: "user", source_transcript_ids: ["transcript_1" as never] } };
const state: TimelineState = { project_id: project.project_id, current_revision: { timeline_revision_id: "revision_1" as never, project_id: project.project_id, parent_revision_id: null, document_sha256: "a".repeat(64), summary: "创建", created_by: "user", created_at: now, schema_version: 1, document: timelineDocument }, draft: null, can_undo: true, can_redo: true, current_preview: null };
const transcript = { transcript_id: "transcript_1" as never, asset_id: video.asset_id, status: "ready" as const, language: "zh", segments: [{ segment_id: "segment_1" as never, ordinal: 0, start_us: 0, end_us: 1_000_000, text: "第一句", confidence: 1, words: null }], words: null, provider: "fixture", model_id: "model_1" as never, model_revision: "v1", source_media_fingerprint: video.fingerprint, duration_us: 5_000_000, created_at: now, updated_at: now };
const model: ModelDetail = { model_id: "model_1" as never, display_name: "本地测试模型", purpose: "本地语音转录", provider: "fixture", revision: "v1", supported_languages: ["zh", "en"], supports_word_timestamps: true, runtime_version: "1", model_size_bytes: 1024, installed_size_bytes: 2048, model_sha256: "b".repeat(64), license: { id: "license_1", name: "测试许可证", url: null, attribution: null, acceptance_required: true }, source: { kind: "trusted_manifest", display_name: "内置清单", host: null, url: null }, requires_network: true, local_only: true, status: "unavailable", provider_status: "installed", progress: null, required_disk_bytes: 4096, runtime_requirements: {}, files: [], available_disk_bytes: 8192 };
const job: Job = { job_id: "job_1" as never, project_id: project.project_id, asset_id: video.asset_id, kind: "transcription", status: "interrupted", stage: "failed", progress: 0, attempt: 1, model_id: model.model_id, model_revision: model.revision, input_fingerprint: video.fingerprint, input: { asset_id: video.asset_id }, error: { code: "JOB_INTERRUPTED", message: "interrupted" }, created_at: now, updated_at: now, started_at: null, finished_at: now };
const runningJob = { ...job, job_id: "job_running" as never, status: "running" as const, stage: "transcribing", error: null };
const createdJob = { ...runningJob, job_id: "job_created" as never };
const downloadJob = { ...runningJob, job_id: "job_download" as never, asset_id: null, kind: "model_download" as const };
const runningRenderJob: Job = { ...runningJob, job_id: "job_render" as never, asset_id: null, kind: "final_export" as const, stage: "exporting", progress: 0.5, started_at: now, finished_at: null };
const stalePreview: AuthoritativePreviewPresentation = {
  preview: {
    render_artifact_id: "artifact_preview" as never,
    project_id: project.project_id,
    timeline_revision_id: "revision_1" as never,
    kind: "authoritative_preview",
    status: "stale",
    content_fingerprint: "a".repeat(64),
    profile_id: "preview-portrait-v1",
    display_name: "权威预览",
    size_bytes: 10,
    sha256: "a".repeat(64),
    media_info: { duration_us: 5_000_000, format_name: "mp4", video: { codec: "h264", width: 1080, height: 1920, pixel_format: "yuv420p", fps_num: 30, fps_den: 1 }, audio: null },
    encoder: "h264",
    fallback_reason: null,
    created_at: now,
  },
  media_url: "aivideo://media/stale",
};

function desktopApi(options: { timeline?: TimelineState | null; models?: ModelDetail[]; jobs?: Job[]; previews?: AuthoritativePreviewPresentation[] } = {}): DesktopApi {
  const timeline = options.timeline === undefined ? state : options.timeline;
  let transcriptionSequence = 0;
  return {
    getRuntime: vi.fn().mockResolvedValue({ protocol_version: 1, status: "ready" }), chooseMedia: vi.fn(), probeMedia: vi.fn(),
    listProjects: vi.fn().mockResolvedValue({ items: [project], next_cursor: null }), createProject: vi.fn().mockResolvedValue({ ...project, project_id: "project_2", name: "新项目" }), getProject: vi.fn().mockResolvedValue(project), renameProject: vi.fn().mockResolvedValue({ ...project, name: "已重命名" }), archiveProject: vi.fn().mockResolvedValue({ ...project, status: "archived" }), reopenProject: vi.fn().mockResolvedValue(project),
    listAssets: vi.fn().mockResolvedValue({ items: [{ asset: video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }, { asset: image, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGHI" }], next_cursor: null }), importAsset: vi.fn(), importAssetByFixture: vi.fn().mockResolvedValue(null).mockImplementation(async ({ kind }: { kind?: string }) => ({ grant: {}, asset: { ...image, asset_id: `import_${kind}` as never, kind: kind ?? "video", display_name: `import-${kind}` }, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGHI" })), refreshAsset: vi.fn().mockResolvedValue({ asset: video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }), relocateAsset: vi.fn().mockResolvedValue({ grant: {}, asset: video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }), importSubtitle: vi.fn().mockResolvedValue(null), deleteAsset: vi.fn().mockResolvedValue(undefined), revealAsset: vi.fn().mockResolvedValue({ status: "opened" }),
    listJobs: vi.fn().mockResolvedValue({ items: options.jobs ?? [], next_cursor: null }), createJob: vi.fn(), getJob: vi.fn(), cancelJob: vi.fn().mockImplementation(async (jobId: string) => ({ ...createdJob, job_id: jobId, status: "cancelled" })), listModels: vi.fn().mockResolvedValue({ items: options.models ?? [], next_cursor: null }), getModel: vi.fn().mockResolvedValue(model), downloadModel: vi.fn().mockResolvedValue({ model: { ...model, status: "queued" }, job: downloadJob }), getModelDownload: vi.fn(), cancelModelDownload: vi.fn().mockResolvedValue({ model: { ...model, status: "cancelled" }, job: { ...downloadJob, status: "cancelled" } }), createTranscription: vi.fn().mockImplementation(async () => ({ job: { ...createdJob, job_id: `job_created_${++transcriptionSequence}` as never }, transcript: null })),
    listTranscripts: vi.fn().mockResolvedValue({ items: [{ ...transcript, segments: undefined, words: undefined }], next_cursor: null }), getTranscript: vi.fn().mockResolvedValue(transcript),
    getBrief: vi.fn().mockRejectedValue(new Error("BRIEF_NOT_FOUND")), putBrief: vi.fn().mockResolvedValue({}), listRecipes: vi.fn().mockResolvedValue({ items: [{ schema_version: 1, recipe_id: "balanced-narrative-v1", name: "Balanced", summary: "测试", rules: { selection: "keyword", pace: "balanced", max_gap_us: 1 }, document_sha256: `sha256:${"a".repeat(64)}` }] }), listProviders: vi.fn().mockResolvedValue({ items: [{ provider_config_id: "provider_1", kind: "openai_compatible_text", display_name: "测试 Provider", base_url: "https://provider.test", model: "model", enabled: true, credential_status: "configured", input_price_per_million: null, output_price_per_million: null, timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "openai_chat_completions_json_schema_v1", timeline_patch_probe_protocol_version: "1", timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: null, timeline_patch_capability_probe_sha256: `sha256:${"d".repeat(64)}`, candidate_capability_status: "supported", candidate_response_adapter_id: "openai_chat_completions_json_schema_v1", candidate_probe_protocol_version: "1", candidate_capability_tested_at: now, candidate_capability_failure_code: null, candidate_capability_probe_sha256: `sha256:${"e".repeat(64)}`, created_at: now, updated_at: now }] }), createProvider: vi.fn(), setProviderSecret: vi.fn(), deleteProviderSecret: vi.fn().mockResolvedValue({ provider_config_id: "provider_1", credential_status: "missing" }), testProvider: vi.fn().mockResolvedValue({ status: "succeeded" }), testCandidateProviderCapability: vi.fn().mockResolvedValue({ candidate_capability_status: "supported", candidate_response_adapter_id: "openai_chat_completions_json_schema_v1", candidate_probe_protocol_version: "1", candidate_capability_tested_at: now, candidate_capability_failure_code: null, candidate_capability_probe_sha256: `sha256:${"e".repeat(64)}` }), preparePlanning: vi.fn().mockResolvedValue({ egress_preview_id: "preview_1", provider: { display_name: "测试", origin: "https://provider.test", model: "model" }, prompt_template_version: "candidate-plan-v1", sent_fields: ["segments.text"], payload_sha256: `sha256:${"b".repeat(64)}`, expires_at: now, payload: { segments: [{ segment_ref: "s1", text: "第一句" }] }, stats: { transcript_count: 1, segment_count: 1, character_count: 3, estimated_tokens: 1 } }), createPlanning: vi.fn().mockResolvedValue({ job: { ...createdJob, kind: "candidate_generation" } }), listCandidatePlans: vi.fn().mockResolvedValue({ items: [] }), getCandidateClipMedia: vi.fn(), adoptCandidatePlan: vi.fn().mockResolvedValue(state),
    prepareTimelinePatch: vi.fn().mockResolvedValue({ timeline_patch_egress_preview_id: "patch_preview_1", provider: { display_name: "测试 Provider", origin: "https://provider.test", model: "model" }, prompt_template_version: "timeline-patch-v1", output_schema_version: "timeline-patch-output-v1", sent_fields: ["instruction", "timeline"], payload_sha256: `sha256:${"c".repeat(64)}`, character_count: 100, estimated_tokens: 30, clip_count: 1, caption_count: 1, locked_count: 0, expires_at: now }), testTimelinePatchProviderCapability: vi.fn().mockResolvedValue({ timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "openai_chat_completions_json_schema_v1", timeline_patch_probe_protocol_version: "1", timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: null, timeline_patch_probe_sha256: `sha256:${"d".repeat(64)}` }), createTimelinePatchGeneration: vi.fn().mockResolvedValue({ timeline_patch_generation_id: "patch_generation_1", job: { ...createdJob, kind: "timeline_patch_generation" } }), getTimelinePatchGeneration: vi.fn(), listTimelinePatchProposals: vi.fn().mockResolvedValue({ items: [] }), getTimelinePatchProposal: vi.fn(), applyTimelinePatchProposal: vi.fn().mockResolvedValue(state), compareTimelineRevisions: vi.fn(),
    createTimeline: vi.fn().mockResolvedValue(state), getTimeline: timeline ? vi.fn().mockResolvedValue(timeline) : vi.fn().mockRejectedValue(new Error("TIMELINE_NOT_FOUND 404")), patchTimeline: vi.fn().mockResolvedValue(state), undoTimeline: vi.fn().mockResolvedValue(state), redoTimeline: vi.fn().mockResolvedValue(state), saveTimelineDraft: vi.fn().mockResolvedValue({ project_id: project.project_id, base_revision_id: state.current_revision.timeline_revision_id, document: timelineDocument, updated_at: now, conflict: false }), deleteTimelineDraft: vi.fn().mockResolvedValue(undefined), listTimelineRevisions: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), getTimelineRevision: vi.fn(),
    createPreview: vi.fn().mockResolvedValue({ job: null, preview: null, reused: false }), listPreviews: vi.fn().mockResolvedValue({ items: options.previews ?? [], next_cursor: null }), chooseExportDestination: vi.fn().mockResolvedValue(null), createExport: vi.fn(), listExports: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), getRenderArtifact: vi.fn(), getPreviewIr: vi.fn().mockResolvedValue(fixturePreviewIrPresentation()), lookupDerivedMedia: vi.fn(), derivedMediaStats: vi.fn(), derivedMediaUrl: vi.fn(), captionFontUrl: vi.fn().mockResolvedValue(""),
    listPlatformPresets: vi.fn().mockResolvedValue({ items: [] }), listRenditionPresets: vi.fn().mockResolvedValue({ items: [] }), createRenditionPreview: vi.fn(), listRenditionPreviews: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), chooseExportDirectory: vi.fn().mockResolvedValue(null), createExportBatch: vi.fn(), getExportBatch: vi.fn(), listExportBatches: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), cancelExportBatch: vi.fn(), retryExportBatch: vi.fn(),
    createRenditionReframePreview: vi.fn(), listRenditionReframePreviews: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), createReframeExportBatch: vi.fn(), getReframeExportBatch: vi.fn(), listReframeExportBatches: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), cancelReframeExportBatch: vi.fn(), retryReframeExportBatch: vi.fn(),
    prepareMediaGeneration: vi.fn(), createMediaGeneration: vi.fn(), listMediaGenerationRequests: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), getMediaGenerationRequest: vi.fn(), listMediaGenerationTasks: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), retryMediaGenerationTask: vi.fn(), cancelMediaGenerationTask: vi.fn(),
    listImageProviderConfigs: vi.fn().mockResolvedValue({ items: [] }), createImageProviderConfig: vi.fn(), setImageProviderSecret: vi.fn(), deleteImageProviderSecret: vi.fn(), prepareProviderImageGeneration: vi.fn(), createProviderImageGeneration: vi.fn(), listProviderImageGenerationRequests: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), getProviderImageGenerationRequest: vi.fn(), listProviderImageGenerationTasks: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), prepareProviderImageGenerationRetry: vi.fn(), retryProviderImageGenerationTask: vi.fn(), cancelProviderImageGenerationTask: vi.fn(),
    getShotList: vi.fn().mockResolvedValue({ shot_list_id: null, project_id: project.project_id, lifecycle: "empty", current_revision: null, confirmed_revision: null }), listShotListRevisions: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), getShotListRevision: vi.fn(), createShotListRevision: vi.fn(), confirmShotListRevision: vi.fn(),
    getShotRequirementImageFulfillment: vi.fn(), listShotRequirementImageFulfillmentLinks: vi.fn(), listShotRequirementImageFulfillmentAdoptions: vi.fn(), prepareShotRequirementImageFulfillment: vi.fn(), createShotRequirementImageFulfillment: vi.fn(), adoptShotRequirementImageFulfillment: vi.fn(),
    prepareShotRequirementTimelineAssembly: vi.fn(), applyShotRequirementTimelineAssembly: vi.fn(), getShotRequirementTimelineAssemblyPreview: vi.fn(), getShotRequirementTimelineAssembly: vi.fn(), listShotRequirementTimelineAssemblies: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    prepareShotRequirementTimelineBatchAssembly: vi.fn(), applyShotRequirementTimelineBatchAssembly: vi.fn(), getShotRequirementTimelineBatchAssemblyPreview: vi.fn(), getShotRequirementTimelineBatchAssembly: vi.fn(), listShotRequirementTimelineBatches: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), listShotRequirementTimelineBatchAssemblyItems: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    openArtifact: vi.fn(), openArtifactFolder: vi.fn(), subscribeJob: vi.fn().mockReturnValue(() => undefined), getPreviewSource: vi.fn(), createPreviewSourceJob: vi.fn(), previewSourceMediaUrl: vi.fn(), getWaveform: vi.fn(), waveformMediaUrl: vi.fn(), ensurePcmChunk: vi.fn(), pcmChunkMediaUrl: vi.fn(), getPreviewIrV2Manifest: vi.fn(), getPreviewIrV2Window: vi.fn(), updateEditorLoad: vi.fn().mockResolvedValue({ status: "ok" }), diagnostics: vi.fn()
  } as DesktopApi;
}

describe("Editor shell 基线", () => {
  // C20 v2 默认 on 后本组显式钉住 v1 数据面(desktopApi 的 v2 端点 stub
  // 未装配 fixture,状态区分断言与数据面无关;v2 由 harness E2E 覆盖)。
  afterAll(() => { vi.unstubAllEnvs(); });
  beforeEach(() => {
    vi.stubEnv("VITE_AIVS_PREVIEW_IR_V2", "0");
    window.desktop = desktopApi();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the editor shell with editing mode and status regions", async () => {
    render(<App />);
    expect(await screen.findByRole("region", { name: "媒体库" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "项目预览" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "时间线" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "上下文属性" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换项目" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "当前项目" })).not.toBeInTheDocument();
  });

  it("keeps save, preview, and job status separate", async () => {
    render(<App />);
    expect(await screen.findByText("已保存")).toBeInTheDocument();
    // 默认进入合成预览；jsdom 无 WebGL2 → 自动回退交互预览并留下内联提示。
    await screen.findByRole("note", { name: "合成预览回退提示" }, { timeout: 10_000 });
    expect(screen.getByText(/交互预览|权威预览/, { selector: ".preview-context" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "保存状态" })).toHaveTextContent("已保存");
    expect(screen.getByRole("status", { name: "预览状态" })).toHaveTextContent("交互预览");
    expect(screen.getByRole("status", { name: "Core 连接状态" })).toBeInTheDocument();
    // 重试合成预览：提示清除 → 再次尝试 → 环境不变则再次回退并重新提示。
    fireEvent.click(screen.getByRole("button", { name: "重试合成预览" }));
    expect(screen.queryByRole("note", { name: "合成预览回退提示" })).not.toBeInTheDocument();
    await screen.findByRole("note", { name: "合成预览回退提示" }, { timeout: 10_000 });
  });

  it("shows 保存中 while a timeline mutation is in flight", async () => {
    const api = desktopApi();
    vi.mocked(api.undoTimeline).mockReturnValue(new Promise<TimelineState>(() => {}));
    window.desktop = api;
    render(<App />);
    expect(await screen.findByRole("region", { name: "媒体库" })).toBeInTheDocument();
    const undoButton = screen.getByRole("button", { name: "撤销" });
    await waitFor(() => expect(undoButton).toBeEnabled());
    fireEvent.click(undoButton);
    expect(await screen.findByText("保存中")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "保存状态" })).toHaveTextContent("保存中");
  });

  it("shows a failed job status label for a failed job", async () => {
    const failedJob: Job = { ...job, job_id: "job_failed" as never, kind: "authoritative_preview", status: "failed", stage: "failed", progress: 0, error: { code: "JOB_FAILED", message: "failed" } };
    window.desktop = desktopApi({ jobs: [failedJob] });
    render(<App />);
    // 方案 A：任务移入"任务"子标签，先切换再断言（面板类名 jobs-panel → jobs-page）。
    fireEvent.click(screen.getByRole("tab", { name: /^任务/ }));
    const jobsPanel = await screen.findByText((_, element) =>
      element?.classList.contains("jobs-page") === true &&
      element.querySelector(".job-row") !== null &&
      element.textContent?.includes("失败") === true,
    ) as HTMLElement;
    expect(within(jobsPanel).getAllByText(/失败/).length).toBeGreaterThan(0);
  });

  it("shows the active render job count in the status bar task summary", async () => {
    window.desktop = desktopApi({ jobs: [runningRenderJob] });
    render(<App />);
    const summary = await screen.findByText(/1 个任务进行中/, { selector: ".tasks-summary" });
    expect(summary).toBeInTheDocument();
  });

  it("surfaces a stale authoritative preview in the top bar and preview context", async () => {
    window.desktop = desktopApi({ previews: [stalePreview] });
    render(<App />);
    expect(await screen.findByText("权威预览已过期")).toBeInTheDocument();
    // 模式切换已移除：生成权威预览（复用既有产物）后自动进入核验观看，
    // 状态徽标随 stale 语义显示"权威预览已过期"。
    vi.mocked(window.desktop.createPreview!).mockResolvedValue({ job: null, preview: stalePreview, reused: true });
    fireEvent.click(screen.getByRole("button", { name: "生成权威预览" }));
    await waitFor(() => expect(screen.getByText("权威预览已过期", { selector: ".preview-context" })).toBeInTheDocument());
  });

  it("filters visible assets without changing project data", async () => {
    render(<App />);
    const search = await screen.findByRole("searchbox", { name: "搜索素材" });
    await screen.findByText("很长的中文素材文件名-第一幕.mp4");
    fireEvent.change(search, { target: { value: "海报" } });
    expect(screen.getByText("海报.png")).toBeInTheDocument();
    expect(screen.queryByText("很长的中文素材文件名-第一幕.mp4")).not.toBeInTheDocument();
    expect(screen.queryByText("共 1 项")).toBeNull(); // "共 N 项"已移除
  });

  it("shows contextual properties for the selected timeline object", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /video 5.00s/ }));
    expect(screen.getByRole("group", { name: "片段属性" })).toBeInTheDocument();
  });

  it("shows project-level properties when nothing is selected", async () => {
    render(<App />);
    expect(await screen.findByRole("region", { name: "上下文属性" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "项目概览" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开项目管理" })).toBeInTheDocument();
  });

  it("formats long durations as SMPTE HH:MM:SS:FF timecode", async () => {
    const longClip = { ...timelineDocument, clips: [{ ...timelineDocument.clips[0], clip_id: "clip_long" as never, timeline_start_us: 0, timeline_end_us: 3_700_000_000, source_start_us: 0, source_end_us: 5_000_000 }] };
    window.desktop = desktopApi({ timeline: { ...state, current_revision: { ...state.current_revision, document: longClip } } });
    render(<App />);
    expect(await screen.findByRole("button", { name: /video 1:01:40/ })).toBeInTheDocument();
    // 播放器重设计后总时长在 .pb-left .tot 中（"当前 / 总时长" 被拆成多个元素）。
    expect(document.querySelector(".pb-left .tot")?.textContent).toBe("01:01:40:00");
  });

  it("exposes a preview ratio selector defaulting to the project canvas", async () => {
    render(<App />);
    const ratio = await screen.findByRole("combobox", { name: "预览比例" });
    await waitFor(() => expect(ratio).toHaveValue("916")); // 项目画布 1080x1920 → 比例真源（异步加载后生效）
    fireEvent.change(ratio, { target: { value: "169" } });
    expect(ratio).toHaveValue("169");
    expect(document.querySelector(".preview-frame")).toHaveClass("ratio-169");
  });

  it("marks the selected clip and exposes the playhead", async () => {
    render(<App />);
    const clip = await screen.findByRole("button", { name: /Clip 1/ });
    fireEvent.click(clip);
    expect(clip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("slider", { name: "时间线播放头" })).toBeInTheDocument();
  });

  it("shows a drop hint while dragging an asset over the timeline and clears it on drop", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /Clip 1/ });
    const dataTransfer = { getData: (type: string) => (type === "application/x-vortex-cut-asset" ? video.asset_id : ""), setData: vi.fn(), dropEffect: "copy", effectAllowed: "copy" };
    const canvas = document.querySelector(".timeline-canvas-container canvas") as HTMLElement;
    fireEvent.dragOver(canvas, { dataTransfer });
    expect(screen.getByText("释放以追加到时间线")).toBeInTheDocument();
    fireEvent.drop(canvas, { dataTransfer });
    expect(screen.queryByText("释放以追加到时间线")).not.toBeInTheDocument();
  });

  it("clears the drop highlight when dragging away", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /Clip 1/ });
    const dataTransfer = { getData: (type: string) => (type === "application/x-vortex-cut-asset" ? video.asset_id : ""), setData: vi.fn(), dropEffect: "copy", effectAllowed: "copy" };
    const canvas = document.querySelector(".timeline-canvas-container canvas") as HTMLElement;
    fireEvent.dragOver(canvas, { dataTransfer });
    expect(screen.getByText("释放以追加到时间线")).toBeInTheDocument();
    fireEvent.dragLeave(canvas, { dataTransfer });
    expect(screen.queryByText("释放以追加到时间线")).not.toBeInTheDocument();
  });

  it("keeps the toolbar row compact with only status output", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "切换项目" });
    expect(screen.queryByRole("button", { name: "剪辑" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "当前项目" })).not.toBeInTheDocument();
    expect(document.querySelector(".mode-context")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换项目" })).toBeInTheDocument();
  });

  it("opens project management from the titlebar project switcher dropdown", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "切换项目" });
    fireEvent.click(screen.getByRole("button", { name: "切换项目" }));
    await screen.findByRole("listbox", { name: "选择项目" });
    fireEvent.click(within(screen.getByRole("listbox", { name: "选择项目" })).getByRole("menuitem", { name: /项目管理/ }));
    expect(await screen.findByRole("dialog", { name: "项目管理" })).toBeInTheDocument();
  });

  it("opens the render panel from the preview toolbar action", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "渲染与导出" });
    fireEvent.click(screen.getByRole("button", { name: "渲染与导出" }));
    expect(await screen.findByRole("dialog", { name: "渲染与导出" })).toBeInTheDocument();
  });

  it("opens a dropdown with shortcut hints and supports arrow-key navigation", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "切换项目" });
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const undoItem = await screen.findByRole("menuitem", { name: /撤销/ });
    expect(undoItem).toBeInTheDocument();
    expect(undoItem.querySelector(".menu-item-shortcut")).toHaveTextContent("Ctrl+Z");
    const menu = screen.getByRole("menu", { name: "编辑" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: /重做/ })).toHaveClass("focused");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "编辑" })).not.toBeInTheDocument();
  });

  it("blocks timeline shortcuts while an input is focused", async () => {
    const api = desktopApi();
    window.desktop = api;
    render(<App />);
    const search = await screen.findByRole("searchbox", { name: "搜索素材" });
    search.focus();
    fireEvent.keyDown(search, { key: "z", ctrlKey: true });
    expect(api.undoTimeline).not.toHaveBeenCalled();
  });
});
