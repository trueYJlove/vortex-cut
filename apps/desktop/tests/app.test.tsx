import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, ModelDetail, TimelineDocument, TimelineState } from "@aivideo/contracts";
import type { DesktopApi } from "../electron/preload/index.js";
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
const readyModel = { ...model, status: "ready" as const };
const job: Job = { job_id: "job_1" as never, project_id: project.project_id, asset_id: video.asset_id, kind: "transcription", status: "interrupted", stage: "failed", progress: 0, attempt: 1, model_id: model.model_id, model_revision: model.revision, input_fingerprint: video.fingerprint, input: { asset_id: video.asset_id }, error: { code: "JOB_INTERRUPTED", message: "interrupted" }, created_at: now, updated_at: now, started_at: null, finished_at: now };
const runningJob = { ...job, job_id: "job_running" as never, status: "running" as const, stage: "transcribing", error: null };
const createdJob = { ...runningJob, job_id: "job_created" as never };
const downloadJob = { ...runningJob, job_id: "job_download" as never, asset_id: null, kind: "model_download" as const };

const stage3bHash = "b".repeat(64);
const stage3bMediaInfo = { duration_us: 5_000_000, format_name: "mp4", video: { codec: "h264", width: 1080, height: 1920, pixel_format: "yuv420p", fps_num: 30, fps_den: 1 }, audio: { codec: "aac", sample_rate: 48_000, channels: 2 } };
const stage3bPlatform = { schema_version: 1 as const, platform_preset_id: "douyin" as never, display_name: "抖音", preset_version: 1 as const, allowed_rendition_ids: ["portrait-9x16-v1" as never], default_rendition_id: "portrait-9x16-v1" as never, filename_tag: "douyin", document_sha256: stage3bHash };
const stage3bRendition = { schema_version: 1 as const, rendition_preset_id: "portrait-9x16-v1" as never, display_name: "竖屏 9:16", preset_version: 1 as const, document_sha256: stage3bHash, preview_profile_id: "preview-portrait-9x16-v1" as never, export_profile_id: "export-portrait-9x16-v1" as never, preview: { width: 540, height: 960 }, export: { width: 1080, height: 1920 } };
function stage3aPreview(layout_policy: "preserve_timeline" | "fit_all" | "crop_fill_all" | "blurred_background_all") {
  return { preview: { rendition_snapshot_id: `rendition_snapshot_${layout_policy}` as never, project_id: project.project_id, timeline_revision_id: state.current_revision.timeline_revision_id, platform_preset_id: stage3bPlatform.platform_preset_id, rendition_preset_id: stage3bRendition.rendition_preset_id, layout_policy, snapshot_sha256: stage3bHash, warnings: [], created_at: now, render_artifact_id: `artifact_${layout_policy}` as never, status: "ready" as const, profile_id: stage3bRendition.preview_profile_id, display_name: "preview.mp4", size_bytes: 10, sha256: stage3bHash, media_info: stage3bMediaInfo, encoder: "libx264", fallback_reason: null }, media_url: `aivideo://media/${layout_policy}abcdefghijklmnopqrstuvwxyz` };
}
const stage3bReframePreview = { preview: { rendition_reframe_snapshot_id: "rendition_reframe_snapshot_1" as never, project_id: project.project_id, timeline_revision_id: state.current_revision.timeline_revision_id, base_rendition_snapshot_id: "rendition_snapshot_crop_fill_all" as never, base_snapshot_sha256: stage3bHash, platform_preset_id: stage3bPlatform.platform_preset_id, rendition_preset_id: stage3bRendition.rendition_preset_id, adjustment_count: 1, reframe_snapshot_sha256: stage3bHash, warnings: ["STATIC_REFRAME_APPLIED" as const], created_at: now, render_artifact_id: "reframe_artifact_1" as never, status: "ready" as const, profile_id: stage3bRendition.preview_profile_id, display_name: "reframe-preview.mp4", size_bytes: 10, sha256: stage3bHash, media_info: stage3bMediaInfo, encoder: "libx264", fallback_reason: null }, media_url: "aivideo://media/reframeabcdefghijklmnopqrstuvwxyz" };

const switcherButton = () => screen.getByRole("button", { name: "切换项目" });
const switcherName = () => switcherButton().querySelector(".titlebar-project-name")?.textContent ?? "";
async function expectSwitcherName(name: string) {
  await waitFor(() => expect(switcherName()).toBe(name));
}
function openSwitcher() {
  fireEvent.click(switcherButton());
}
function selectProject(name: RegExp) {
  openSwitcher();
  fireEvent.click(within(screen.getByRole("listbox", { name: "选择项目" })).getByRole("option", { name }));
}
function openProjectManagement() {
  openSwitcher();
  fireEvent.click(within(screen.getByRole("listbox", { name: "选择项目" })).getByRole("menuitem", { name: /项目管理/ }));
}

function desktopApi(options: { timeline?: TimelineState | null; models?: ModelDetail[]; jobs?: Job[] } = {}): DesktopApi {
  const timeline = options.timeline === undefined ? state : options.timeline;
  let transcriptionSequence = 0;
  return {
    getRuntime: vi.fn().mockResolvedValue({ protocol_version: 1, status: "ready" }), chooseMedia: vi.fn(), probeMedia: vi.fn(),
    listProjects: vi.fn().mockResolvedValue({ items: [project], next_cursor: null }), createProject: vi.fn().mockResolvedValue({ ...project, project_id: "project_2", name: "新项目" }), getProject: vi.fn().mockResolvedValue(project), renameProject: vi.fn().mockResolvedValue({ ...project, name: "已重命名" }), archiveProject: vi.fn().mockResolvedValue({ ...project, status: "archived" }), reopenProject: vi.fn().mockResolvedValue(project),
    listAssets: vi.fn().mockResolvedValue({ items: [{ asset: video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }, { asset: image, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGHI" }], next_cursor: null }), importAsset: vi.fn(), importAssetByFixture: vi.fn().mockResolvedValue(null).mockImplementation(async ({ kind }: { kind?: string }) => ({ grant: {}, asset: { ...image, asset_id: `import_${kind}` as never, kind: kind ?? "video", display_name: `import-${kind}` }, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGHI" })), refreshAsset: vi.fn().mockImplementation(async (assetId: string) => ({ asset: assetId === image.asset_id ? image : video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" })), relocateAsset: vi.fn().mockResolvedValue({ grant: {}, asset: video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }), importSubtitle: vi.fn().mockResolvedValue(null), deleteAsset: vi.fn().mockResolvedValue({ removed_clips: 1, removed_captions: 0 }), revealAsset: vi.fn().mockResolvedValue({ status: "opened" }),
    listJobs: vi.fn().mockResolvedValue({ items: options.jobs ?? [], next_cursor: null }), createJob: vi.fn(), getJob: vi.fn(), cancelJob: vi.fn().mockImplementation(async (jobId: string) => ({ ...createdJob, job_id: jobId, status: "cancelled" })), listModels: vi.fn().mockResolvedValue({ items: options.models ?? [], next_cursor: null }), getModel: vi.fn().mockResolvedValue(model), downloadModel: vi.fn().mockResolvedValue({ model: { ...model, status: "queued" }, job: downloadJob }), getModelDownload: vi.fn(), cancelModelDownload: vi.fn().mockResolvedValue({ model: { ...model, status: "cancelled" }, job: { ...downloadJob, status: "cancelled" } }), createTranscription: vi.fn().mockImplementation(async () => ({ job: { ...createdJob, job_id: `job_created_${++transcriptionSequence}` as never }, transcript: null })),
    listTranscripts: vi.fn().mockResolvedValue({ items: [{ ...transcript, segments: undefined, words: undefined }], next_cursor: null }), getTranscript: vi.fn().mockResolvedValue(transcript),
    getBrief: vi.fn().mockRejectedValue(new Error("BRIEF_NOT_FOUND")), putBrief: vi.fn().mockResolvedValue({}), listRecipes: vi.fn().mockResolvedValue({ items: [{ schema_version: 1, recipe_id: "balanced-narrative-v1", name: "Balanced", summary: "测试", rules: { selection: "keyword", pace: "balanced", max_gap_us: 1 }, document_sha256: `sha256:${"a".repeat(64)}` }] }), listProviders: vi.fn().mockResolvedValue({ items: [{ provider_config_id: "provider_1", kind: "openai_compatible_text", display_name: "测试 Provider", base_url: "https://provider.test", model: "model", enabled: true, credential_status: "configured", input_price_per_million: null, output_price_per_million: null, timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "openai_chat_completions_json_schema_v1", timeline_patch_probe_protocol_version: "1", timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: null, timeline_patch_capability_probe_sha256: `sha256:${"d".repeat(64)}`, candidate_capability_status: "supported", candidate_response_adapter_id: "openai_chat_completions_json_schema_v1", candidate_probe_protocol_version: "1", candidate_capability_tested_at: now, candidate_capability_failure_code: null, candidate_capability_probe_sha256: `sha256:${"e".repeat(64)}`, created_at: now, updated_at: now }] }), createProvider: vi.fn(), setProviderSecret: vi.fn(), deleteProviderSecret: vi.fn().mockResolvedValue({ provider_config_id: "provider_1", credential_status: "missing" }), testProvider: vi.fn().mockResolvedValue({ status: "succeeded" }), testCandidateProviderCapability: vi.fn().mockResolvedValue({ candidate_capability_status: "supported", candidate_response_adapter_id: "openai_chat_completions_json_schema_v1", candidate_probe_protocol_version: "1", candidate_capability_tested_at: now, candidate_capability_failure_code: null, candidate_capability_probe_sha256: `sha256:${"e".repeat(64)}` }), preparePlanning: vi.fn().mockResolvedValue({ egress_preview_id: "preview_1", provider: { display_name: "测试", origin: "https://provider.test", model: "model" }, prompt_template_version: "candidate-plan-v1", sent_fields: ["segments.text"], payload_sha256: `sha256:${"b".repeat(64)}`, expires_at: now, payload: { segments: [{ segment_ref: "s1", text: "第一句" }] }, stats: { transcript_count: 1, segment_count: 1, character_count: 3, estimated_tokens: 1 } }), createPlanning: vi.fn().mockResolvedValue({ job: { ...createdJob, kind: "candidate_generation" } }), listCandidatePlans: vi.fn().mockResolvedValue({ items: [] }), getCandidateClipMedia: vi.fn(), adoptCandidatePlan: vi.fn().mockResolvedValue(state),
    prepareTimelinePatch: vi.fn().mockResolvedValue({ timeline_patch_egress_preview_id: "patch_preview_1", provider: { display_name: "测试 Provider", origin: "https://provider.test", model: "model" }, prompt_template_version: "timeline-patch-v1", output_schema_version: "timeline-patch-output-v1", sent_fields: ["instruction", "timeline"], payload_sha256: `sha256:${"c".repeat(64)}`, character_count: 100, estimated_tokens: 30, clip_count: 1, caption_count: 1, locked_count: 0, expires_at: now }), testTimelinePatchProviderCapability: vi.fn().mockResolvedValue({ timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "openai_chat_completions_json_schema_v1", timeline_patch_probe_protocol_version: "1", timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: null, timeline_patch_probe_sha256: `sha256:${"d".repeat(64)}` }), createTimelinePatchGeneration: vi.fn().mockResolvedValue({ timeline_patch_generation_id: "patch_generation_1", job: { ...createdJob, kind: "timeline_patch_generation" } }), getTimelinePatchGeneration: vi.fn(), listTimelinePatchProposals: vi.fn().mockResolvedValue({ items: [] }), getTimelinePatchProposal: vi.fn(), applyTimelinePatchProposal: vi.fn().mockResolvedValue(state), compareTimelineRevisions: vi.fn(),
    createTimeline: vi.fn().mockResolvedValue(state), getTimeline: timeline ? vi.fn().mockResolvedValue(timeline) : vi.fn().mockRejectedValue(new Error("TIMELINE_NOT_FOUND 404")), patchTimeline: vi.fn().mockResolvedValue(state), undoTimeline: vi.fn().mockResolvedValue(state), redoTimeline: vi.fn().mockResolvedValue(state), saveTimelineDraft: vi.fn().mockResolvedValue({ project_id: project.project_id, base_revision_id: state.current_revision.timeline_revision_id, document: timelineDocument, updated_at: now, conflict: false }), deleteTimelineDraft: vi.fn().mockResolvedValue(undefined), listTimelineRevisions: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), getTimelineRevision: vi.fn(),
    createPreview: vi.fn().mockResolvedValue({ job: null, preview: null, reused: false }), listPreviews: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), chooseExportDestination: vi.fn().mockResolvedValue(null), createExport: vi.fn(), listExports: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), getRenderArtifact: vi.fn(), getPreviewIr: vi.fn().mockResolvedValue(fixturePreviewIrPresentation()), lookupDerivedMedia: vi.fn(), derivedMediaStats: vi.fn(), derivedMediaUrl: vi.fn(), captionFontUrl: vi.fn().mockResolvedValue(""),
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

describe("Stage 1A/1B 工作流", () => {
  beforeEach(() => { window.desktop = desktopApi(); });
  afterEach(() => { vi.useRealTimers(); cleanup(); vi.restoreAllMocks(); });

  it("支持项目创建、重命名、归档、重开和四类素材导入", async () => {
    const api = desktopApi();
    const createdProject = { ...project, project_id: "project_2" as never, name: "新项目" };
    api.createProject = vi.fn().mockResolvedValue(createdProject);
    // 新建项目在真实 Core 中尚无素材；让夹具反映该边界，避免 p2 的
    // 无关素材/转录加载与本工作流的项目切换同时竞争渲染。后台轮询的
    // 刷新语义由紧随其后的专门用例在受控回调下覆盖。
    api.listAssets = vi.fn().mockImplementation(async ({ project_id }: { project_id: string }) => ({
      items: project_id === project.project_id
        ? [{ asset: video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }, { asset: image, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGHI" }]
        : [],
      next_cursor: null
    }));
    api.listProjects = vi.fn()
      .mockResolvedValueOnce({ items: [project], next_cursor: null })
      .mockResolvedValue({ items: [project, createdProject], next_cursor: null });
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    openProjectManagement();
    fireEvent.change(await screen.findByLabelText("新项目名称"), { target: { value: "新项目" } }); fireEvent.click(screen.getByRole("button", { name: "创建项目" })); await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({ name: "新项目", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 } }));
    // Wait for the finished create mutation, then use the real project switcher
    // to continue the remaining workflow on project_1.  API invocation alone
    // is not completion: createProject still refreshes and selects its result.
    await expectSwitcherName("新项目");
    selectProject(/^演示项目 活跃$/);
    await expectSwitcherName("演示项目");
    openProjectManagement();
    fireEvent.change(await screen.findByLabelText("重命名项目"), { target: { value: "已重命名" } }); fireEvent.click(screen.getByRole("button", { name: "保存名称" })); await waitFor(() => expect(api.renameProject).toHaveBeenCalledWith({ project_id: "project_1", name: "已重命名" }));
    await expectSwitcherName("已重命名");
    fireEvent.click(screen.getByRole("button", { name: "归档项目" })); await waitFor(() => expect(api.archiveProject).toHaveBeenCalledWith("project_1"));
    await screen.findByRole("button", { name: "重新打开项目" });
    fireEvent.click(screen.getByRole("button", { name: "重新打开项目" })); await waitFor(() => expect(api.reopenProject).toHaveBeenCalledWith("project_1"));
    await screen.findByRole("button", { name: "归档项目" });
    // txt 不再提供导入入口（文本创作走默认文本/导入字幕）。
    for (const label of ["视频", "音频", "图片"]) fireEvent.click(screen.getByRole("button", { name: `导入${label}` }));
    await waitFor(() => expect(api.importAsset).toHaveBeenCalledTimes(3));
    expect(api.importAsset).toHaveBeenNthCalledWith(1, { project_id: "project_1", kind: "video" }); expect(api.importAsset).toHaveBeenNthCalledWith(3, { project_id: "project_1", kind: "image" });
  });

  it("新建项目可选画布比例，创建请求携带对应画布", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    openProjectManagement();
    fireEvent.change(await screen.findByLabelText("新项目名称"), { target: { value: "横屏项目" } });
    fireEvent.change(screen.getByLabelText("新建项目画布比例"), { target: { value: "169" } });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
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
    // A08：轮询改 RequestScheduler（结束后再 setTimeout + 同端点 single-flight）。
    // 受控注入点从 setInterval 回调改为 scheduler 的延迟 setTimeout：首轮
    // 调度立即执行（runCycle），后续由这里手动触发。
    const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
    let refreshProjects!: () => void;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number) => {
      // 调度器内部排程（数字 delay ≥1s）挂起为可手动触发的刷新钩子（只
      // 记最新一次——手动触发即模拟"间隔到达"，不重放历史周期）；其他
      // setTimeout（React/库内部）照常真实触发。
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
    const renameInput = await screen.findByLabelText("重命名项目");
    fireEvent.change(renameInput, { target: { value: "用户未提交草稿" } });
    expect(renameInput).toHaveValue("用户未提交草稿");

    await act(async () => { resolveStaleRefresh({ items: [staleProject, projectQ], next_cursor: null }); });
    await waitFor(() => expect(renameInput).toHaveValue("用户未提交草稿"));
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(api.renameProject).toHaveBeenCalledWith({ project_id: project.project_id, name: "用户未提交草稿" }));
    await waitFor(() => expect(renameInput).toHaveValue("服务端确认名"));

    const refreshForProjectP = refreshProjects;
    selectProject(/^服务端项目 Q 活跃$/);
    await waitFor(() => expect(renameInput).toHaveValue("服务端项目 Q"));
    await waitFor(() => expect(refreshProjects).not.toBe(refreshForProjectP));
    await act(async () => { refreshProjects(); });
    await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(renameInput).toHaveValue("服务端项目 Q（刷新）"));
    timeoutSpy.mockRestore();
  });

  it("支持素材库刷新、删除确认弹窗和只读 Transcript 查看", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />); await screen.findByText(video.display_name);
    // 重新定位按钮已移除（与导入重叠）；工具栏提供素材库级刷新。
    expect(screen.queryByRole("button", { name: "重新定位" })).toBeNull();
    expect(screen.getByRole("button", { name: "刷新素材库" })).toBeInTheDocument();
    await waitFor(() => expect(api.refreshAsset).not.toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "刷新素材库" }));
    await waitFor(() => expect(api.refreshAsset).toHaveBeenCalledWith(video.asset_id));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("所有素材文件均正常"));
    fireEvent.click(screen.getByTitle("转录")); expect(await screen.findByText("当前没有可用的本地 ASR 模型")).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: /^转录$/ })[0]);
    // 转录结果在"转录"子标签下：切换后查看。
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ }));
    fireEvent.click(await screen.findByRole("button", { name: /查看转录/ })); expect(await screen.findByText("原始 ASR 结果只读。字幕修订不会覆盖这份记录。")).toBeVisible(); expect(screen.getAllByText("第一句")).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: /^素材/ }));
    // 删除：应用内确认弹窗（含级联警告），确认后携带级联标记调用 Core。
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

  it("支持模型确认下载、取消下载、发起转录及任务取消重试", async () => {
    const api = desktopApi({ models: [model] }); window.desktop = api; render(<App />); fireEvent.click(screen.getByRole("tab", { name: /^模型/ })); await screen.findByText("本地测试模型");
    fireEvent.click(screen.getByRole("button", { name: "下载模型" })); expect(await screen.findByRole("heading", { name: "确认下载本地模型" })).toBeVisible(); const confirm = screen.getByRole("button", { name: "确认并下载" }); expect(confirm).toBeDisabled(); fireEvent.click(screen.getByRole("checkbox", { name: /接受/ })); fireEvent.click(confirm); await waitFor(() => expect(api.downloadModel).toHaveBeenCalledWith({ model_id: model.model_id, license_acceptance: "license_1" }));
    fireEvent.click(await screen.findByTitle("取消模型下载")); await waitFor(() => expect(api.cancelModelDownload).toHaveBeenCalledWith(model.model_id));
    const readyApi = desktopApi({ models: [readyModel], jobs: [job] }); window.desktop = readyApi; cleanup(); render(<App />); fireEvent.click(screen.getByRole("tab", { name: /^模型/ })); await screen.findByText("本地测试模型");
    // 发起转录的按钮在素材行操作区：切回"素材"标签再点。
    fireEvent.click(screen.getByRole("tab", { name: /^素材/ })); fireEvent.click(await screen.findByTitle("转录")); expect(await screen.findByRole("heading", { name: "创建本地转录" })).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "开始转录" })); await waitFor(() => expect(readyApi.createTranscription).toHaveBeenCalledWith(expect.objectContaining({ asset_id: video.asset_id, model_id: model.model_id })));
    // 任务在"任务"子标签下：切换后重试/取消。
    fireEvent.click(screen.getByRole("tab", { name: /^任务/ }));
    fireEvent.click(screen.getByRole("button", { name: "重试转录" })); await waitFor(() => expect(readyApi.createTranscription).toHaveBeenCalledTimes(2)); fireEvent.click(screen.getAllByRole("button", { name: "取消" })[0]); await waitFor(() => expect(readyApi.cancelJob).toHaveBeenCalledWith("job_created_2"));
  });
});

describe("素材箱交互", () => {
  afterEach(() => cleanup());

  it("素材列表固定为列表视图（视图切换已移除）", async () => {
    window.desktop = desktopApi(); render(<App />);
    await screen.findByText(video.display_name);
    expect(document.querySelector(".asset-list.asset-table")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "切换为缩略图视图" })).toBeNull();
    expect(screen.queryByRole("button", { name: "切换为列表视图" })).toBeNull();
    // 重新定位操作已移除（与导入重叠）；删除走应用内确认弹窗。
    expect(screen.queryByRole("button", { name: "重新定位" })).toBeNull();
    expect(screen.getAllByTitle(/删除 /).length).toBeGreaterThan(0);
  });

  it("提示条按级别配色（成功为绿色而非红色）", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />); await screen.findByText(video.display_name);
    // 刷新成功 → 绿色提示（而非红色）。
    fireEvent.click(screen.getByRole("button", { name: "刷新素材库" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("所有素材文件均正常"), { timeout: 15_000 });
    expect(document.querySelector(".notice.notice-success")).not.toBeNull();
    expect(document.querySelector(".notice.notice-error")).toBeNull();
    // 删除成功 → 同样是绿色成功提示。
    fireEvent.click(screen.getAllByTitle(`删除 ${video.display_name}`)[0]);
    fireEvent.click(await screen.findByRole("button", { name: "删除素材" }, { timeout: 15_000 }));
    await waitFor(() => expect(document.querySelector(".notice.notice-success")?.textContent).toContain("已删除素材"), { timeout: 15_000 });
  });

  it("双击素材在预览播放且不修改时间线，回到时间线后退出素材预览", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />);
    await screen.findByText(image.display_name);
    // 等合成预览回退（jsdom 无 WebGL2）落定，交互预览就绪后再操作；套件并发
    // 负载下回退可能超过默认 1s 超时，放宽。
    await screen.findByLabelText("交互预览视频", {}, { timeout: 10_000 });
    const imageItem = screen.getByText(image.display_name).closest(".asset-item")!;
    fireEvent.doubleClick(imageItem);
    expect(await screen.findByAltText(image.display_name)).toBeInTheDocument();
    expect(screen.queryByLabelText("交互预览视频")).not.toBeInTheDocument();
    expect(api.patchTimeline).not.toHaveBeenCalled();
    // 播放头 slider 是 role=slider 的 div（无 input value setter），走键盘可访问路径。
    // 任意 seek 即退出素材预览（seekFromProgressRatio → exitLibraryPreview）；
    // ArrowRight 一次 = 5s/300 ≈ 16.7ms，仍在 clip_1 区间内（交互预览视频存在）。
    fireEvent.keyDown(screen.getByLabelText("时间线播放头"), { key: "ArrowRight" });
    expect(screen.queryByAltText(image.display_name)).not.toBeInTheDocument();
    expect(screen.getByLabelText("交互预览视频")).toBeInTheDocument();
  }, 15_000);

  it("点击预览画面选中播放头处的片段并显示选中边框", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />);
    await screen.findByLabelText("交互预览视频", {}, { timeout: 10_000 });
    const frame = screen.getByRole("button", { name: "选中播放头处的片段" });
    expect(frame.className).not.toContain("selected");
    fireEvent.click(frame);
    await waitFor(() => expect(frame.className).toContain("selected"));
    expect(api.patchTimeline).not.toHaveBeenCalled();
    // 切到无片段的播放头位置（End 键跳到片尾）再点击，选中态清除
    fireEvent.keyDown(screen.getByLabelText("时间线播放头"), { key: "End" });
    fireEvent.click(frame);
    await waitFor(() => expect(frame.className).not.toContain("selected"));
  });
});

describe("Stage 1C Editor", () => {
  beforeEach(() => { window.desktop = desktopApi(); });
  afterEach(() => cleanup());

  it("渲染固定编辑工作台且不暴露敏感字段", async () => {
    render(<App />); await expectSwitcherName("演示项目"); await screen.findByText(video.display_name); expect(screen.getByText("V1")).toBeVisible(); expect(screen.getByText("C1")).toBeVisible(); expect(screen.getByText(/非权威/)).toBeVisible(); expect(document.body.textContent).not.toContain("C:\\");
  });

  it("支持片段与字幕编辑", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />); fireEvent.click(await screen.findByRole("button", { name: /video 5.00s/ })); fireEvent.click(screen.getByRole("button", { name: "拆分片段" })); await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [expect.objectContaining({ op: "split_clip" })] }) }))); fireEvent.click(screen.getByRole("button", { name: "裁切填满" })); await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [expect.objectContaining({ op: "set_layout", layout: "crop_fill" })] }) }))); fireEvent.click(screen.getByRole("button", { name: /这是一条很长/ })); fireEvent.change(screen.getByLabelText("文本"), { target: { value: "修正字幕" } }); fireEvent.blur(screen.getByLabelText("文本")); await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [expect.objectContaining({ op: "update_caption", text: "修正字幕" })] }) })));
  });

  it("创建空时间线后忽略迟到的 404，并以冻结契约追加素材与转录", async () => {
    let rejectTimeline!: (reason: unknown) => void; const pendingTimeline = new Promise<TimelineState>((_, reject) => { rejectTimeline = reject; }); const api = desktopApi({ timeline: null }); api.getTimeline = vi.fn().mockReturnValue(pendingTimeline); window.desktop = api; render(<App />); fireEvent.click(await screen.findByRole("button", { name: "创建空时间线" })); await screen.findByRole("button", { name: /video 5.00s/ }); rejectTimeline(new Error("TIMELINE_NOT_FOUND 404"));
    fireEvent.dragOver(screen.getByLabelText("时间线画布"), { dataTransfer: { getData: () => video.asset_id, dropEffect: "copy" } }); fireEvent.drop(screen.getByLabelText("时间线画布"), { dataTransfer: { getData: () => video.asset_id, dropEffect: "copy" } }); await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [expect.objectContaining({ op: "insert_asset_clip" })] }) })));
    fireEvent.click(screen.getAllByRole("button", { name: /^转录$/ })[0]);
    // 勾选转录片段的界面在"转录"子标签下：切换后操作。A08：转录正文不再
    // 全量预取——先点"查看转录"按需加载（并发队列 + 代次作废），再勾选。
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ })); fireEvent.click(await screen.findByRole("button", { name: /查看转录/ })); fireEvent.click(await screen.findByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "追加所选片段" }));
    await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledTimes(2)); const operation = vi.mocked(api.patchTimeline).mock.calls[1][0].patch.operations[0]; expect(operation).toEqual({ op: "insert_transcript_segments", transcript_id: transcript.transcript_id, segment_ids: [transcript.segments[0].segment_id], at_index: timelineDocument.clips.length, padding_before_us: 150_000, padding_after_us: 150_000, create_captions: true, layout: "blurred_background" }); expect(operation).not.toHaveProperty("kind");
  });

  it("使用服务端 Revision 执行撤销重做并显示草稿恢复入口", async () => {
    const api = desktopApi({ timeline: { ...state, draft: { project_id: project.project_id, base_revision_id: state.current_revision.timeline_revision_id, document: timelineDocument, updated_at: now, conflict: false } } }); window.desktop = api; render(<App />); expect(await screen.findByText("检测到上次未恢复草稿")).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "丢弃" })); expect(api.deleteTimelineDraft).toHaveBeenCalledWith("project_1"); fireEvent.click(screen.getByRole("button", { name: "撤销" })); await waitFor(() => expect(api.undoTimeline).toHaveBeenCalled()); fireEvent.click(screen.getByRole("button", { name: "重做" })); await waitFor(() => expect(api.redoTimeline).toHaveBeenCalled());
  });
});

describe("Stage 2A AI 粗剪", () => {
  afterEach(() => cleanup());
  it("未测试 Provider 不可准备，只有用户点击兼容性测试后才允许 AI 粗剪", async () => {
    const api = desktopApi();
    vi.mocked(api.listProviders!).mockResolvedValue({ items: [{ provider_config_id: "provider_1" as never, kind: "openai_compatible_text", display_name: "未测试 Provider", base_url: "https://provider.test", model: "model", enabled: true, credential_status: "configured", input_price_per_million: null, output_price_per_million: null, timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "openai_chat_completions_json_schema_v1", timeline_patch_probe_protocol_version: "1", timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: null, timeline_patch_capability_probe_sha256: `sha256:${"d".repeat(64)}`, candidate_capability_status: "untested", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: null, candidate_capability_failure_code: null, candidate_capability_probe_sha256: null, created_at: now, updated_at: now }] });
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
    // 等合成预览回退（jsdom 无 WebGL2）落定：回退触发的重渲若撞上 RTL 模拟的
    // change 事件会触发 React change 去重、丢掉第一次模拟输入——先 settle 再交互。
    await screen.findByRole("note", { name: "合成预览回退提示" }, { timeout: 10_000 });
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
    fireEvent.click(screen.getByRole("button", { name: "测试 AI 粗剪兼容性" }));
    await waitFor(() => expect(api.testCandidateProviderCapability).toHaveBeenCalledWith("provider_1"));
    expect(api.createPlanning).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "准备外传确认" }));
    await screen.findByText("确认发送的精确内容"); expect(api.preparePlanning).toHaveBeenCalled(); expect(api.createPlanning).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "我确认发送以上内容" }));
    await waitFor(() => expect(api.createPlanning).toHaveBeenCalledWith({ project_id: "project_1", egress_preview_id: "preview_1", payload_sha256: `sha256:${"b".repeat(64)}` }));
  });
  it("删除密钥使用白名单桥接且不回显", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />); await expectSwitcherName("演示项目");
    await screen.findByRole("note", { name: "合成预览回退提示" }, { timeout: 10_000 }); // 等回退落定再交互（见"必须先 prepare"用例注释）
    fireEvent.click(screen.getByRole("button", { name: "AI 粗剪" })); fireEvent.change(await screen.findByLabelText("Provider"), { target: { value: "provider_1" } });
    fireEvent.click(screen.getByRole("button", { name: "删除密钥" })); await waitFor(() => expect(api.deleteProviderSecret).toHaveBeenCalledWith("provider_1"));
    expect(document.body.textContent).not.toContain("SENTINEL-KEY-NEVER-LOG");
  });
  it.each(["failed", "cancelled", "interrupted"] as const)("任务 %s 会清除旧外传预览，取消按钮调用任务取消并强制重新准备", async status => {
    const api = desktopApi(); api.listCandidatePlans = vi.fn().mockImplementation(() => new Promise(() => undefined)); let listener: ((value: Job) => void) | undefined;
    api.subscribeJob = vi.fn((_id, next) => { listener = next; return () => undefined; });
    window.desktop = api; render(<App />); await expectSwitcherName("演示项目");
    await screen.findByRole("note", { name: "合成预览回退提示" }, { timeout: 10_000 }); // 等回退落定再交互（见"必须先 prepare"用例注释）
    fireEvent.click(screen.getByRole("button", { name: "AI 粗剪" }));
    fireEvent.change(await screen.findByLabelText("主题"), { target: { value: "游戏高光" } }); fireEvent.change(screen.getByLabelText("受众"), { target: { value: "玩家" } }); fireEvent.change(screen.getByLabelText("叙事目标"), { target: { value: "展示操作" } }); fireEvent.change(screen.getByLabelText("制作配方"), { target: { value: "balanced-narrative-v1" } }); fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "provider_1" } }); fireEvent.change(screen.getByLabelText("就绪转录"), { target: { value: "transcript_1" } });
    fireEvent.click(screen.getByRole("button", { name: "准备外传确认" })); await screen.findByText("确认发送的精确内容"); fireEvent.click(screen.getByRole("button", { name: "我确认发送以上内容" }));
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
    expect(screen.getByText(/此 Clip 已锁定/)).toBeVisible(); expect(screen.getByRole("button", { name: "裁切填满" })).toBeDisabled(); expect(screen.getByRole("button", { name: "拆分片段" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /这是一条很长/ })); expect(screen.getByText(/关联 Clip 已锁定/)).toBeVisible(); expect(screen.getByLabelText("文本")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /video 5.00s/ }));
    fireEvent.click(screen.getByRole("button", { name: "解锁片段" })); await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [{ op: "set_clip_locked", clip_id: "clip_1", locked: false }] }) })));
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
    window.desktop = api; render(<App />); const entry = await screen.findByRole("button", { name: "AI 修改" }); await waitFor(() => expect(entry).toBeEnabled()); fireEvent.click(entry); fireEvent.change(await screen.findByLabelText("修改指令"), { target: { value: "缩短片段" } }); fireEvent.click(screen.getByRole("button", { name: "准备外传确认" })); fireEvent.click(await screen.findByRole("button", { name: "确认并发送一次" })); await waitFor(() => expect(listener).toBeTypeOf("function"));
    await act(async () => { listener?.({ ...createdJob, kind: "timeline_patch_generation", status: "succeeded", stage: "completed", progress: 1 }); await Promise.resolve(); }); await waitFor(() => expect(api.listTimelinePatchProposals).toHaveBeenCalled()); expect(await screen.findByText("提案差异")).toBeVisible(); expect(screen.getByText(/trimmed/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "应用修改" })); await waitFor(() => expect(api.applyTimelinePatchProposal).toHaveBeenCalledWith({ project_id: "project_1", proposal_id: "proposal_1", base_revision_id: "revision_1", proposed_document_sha256: `sha256:${"b".repeat(64)}` }));
  });

  it("Revision 比较只调用只读 diff 接口", async () => {
    const api = desktopApi(); vi.mocked(api.listTimelineRevisions).mockResolvedValue({ items: [state.current_revision, { ...state.current_revision, timeline_revision_id: "revision_0" as never, summary: "上一版" }].map(({ schema_version: _s, document: _d, ...item }) => item), next_cursor: null }); vi.mocked(api.compareTimelineRevisions).mockResolvedValue({ ...diff, target_revision_id: state.current_revision.timeline_revision_id });
    window.desktop = api; render(<App />); const entry = await screen.findByRole("button", { name: "版本比较" }); await waitFor(() => expect(entry).toBeEnabled()); fireEvent.click(entry); fireEvent.click(await screen.findByRole("button", { name: "比较" })); await waitFor(() => expect(api.compareTimelineRevisions).toHaveBeenCalled()); expect(api.patchTimeline).not.toHaveBeenCalled(); expect(api.undoTimeline).not.toHaveBeenCalled();
  });
  it("未测试 Provider 禁用 AI 修改选择，兼容性测试后仅显示安全状态", async () => {
    const api = desktopApi();
    vi.mocked(api.listProviders!).mockResolvedValue({ items: [{ provider_config_id: "provider_1" as never, kind: "openai_compatible_text", display_name: "未测试 Provider", base_url: "https://provider.test", model: "model", enabled: true, credential_status: "configured", input_price_per_million: null, output_price_per_million: null, timeline_patch_capability_status: "untested", timeline_patch_response_adapter_id: null, timeline_patch_probe_protocol_version: null, timeline_patch_capability_tested_at: null, timeline_patch_capability_failure_code: null, timeline_patch_capability_probe_sha256: null, candidate_capability_status: "untested", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: null, candidate_capability_failure_code: null, candidate_capability_probe_sha256: null, created_at: now, updated_at: now }] });
    window.desktop = api; render(<App />); const entry = await screen.findByRole("button", { name: "AI 修改" }); await waitFor(() => expect(entry).toBeEnabled()); fireEvent.click(entry);
    expect(await screen.findByRole("option", { name: /未测试 Provider.*未测试/ })).toBeDisabled();
    fireEvent.click(await screen.findByRole("button", { name: "测试 AI 修改兼容性" }));
    await waitFor(() => expect(api.testTimelinePatchProviderCapability).toHaveBeenCalledWith("provider_1"));
    expect(document.body.textContent).not.toContain("raw_response"); expect(document.body.textContent).not.toContain("SENTINEL");
  });
  it("AI 修改界面不回显协议、适配器或失败码细节", async () => {
    const api = desktopApi();
    vi.mocked(api.listProviders!).mockResolvedValue({ items: [{ provider_config_id: "provider_1" as never, kind: "openai_compatible_text", display_name: "不支持 Provider", base_url: "https://provider.test", model: "model", enabled: true, credential_status: "configured", input_price_per_million: null, output_price_per_million: null, timeline_patch_capability_status: "unsupported", timeline_patch_response_adapter_id: null, timeline_patch_probe_protocol_version: null, timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: "PROVIDER_SCHEMA_MISMATCH", timeline_patch_capability_probe_sha256: `sha256:${"d".repeat(64)}`, candidate_capability_status: "unsupported", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: now, candidate_capability_failure_code: "PROVIDER_FAILED", candidate_capability_probe_sha256: `sha256:${"e".repeat(64)}`, created_at: now, updated_at: now }] });
    vi.mocked(api.testTimelinePatchProviderCapability).mockResolvedValue({ timeline_patch_capability_status: "unsupported", timeline_patch_response_adapter_id: null, timeline_patch_probe_protocol_version: null, timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: "PROVIDER_SCHEMA_MISMATCH", timeline_patch_capability_probe_sha256: `sha256:${"d".repeat(64)}` });
    window.desktop = api; render(<App />); const entry = await screen.findByRole("button", { name: "AI 修改" }); await waitFor(() => expect(entry).toBeEnabled()); fireEvent.click(entry);
    expect((await screen.findAllByText(/当前 Provider 不支持 AI 修改/)).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/responses|chat|schema|patchscript|adapter|provider_schema_mismatch/i);
    fireEvent.click(screen.getByRole("button", { name: "测试 AI 修改兼容性" }));
    await screen.findByText("当前 Provider 不支持 AI 修改。");
    expect(document.body.textContent).not.toMatch(/responses|chat|schema|patchscript|adapter|provider_schema_mismatch/i);
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
    await expectSwitcherName("演示项目");
    const previewButton = screen.getByRole("button", { name: "生成权威预览" });
    await waitFor(() => expect(previewButton).toBeEnabled());
    fireEvent.change(screen.getByLabelText("编码模式"), { target: { value: "software" } });
    fireEvent.click(previewButton);
    await waitFor(() => expect(api.createPreview).toHaveBeenCalledWith({ project_id: project.project_id, preview: { timeline_revision_id: state.current_revision.timeline_revision_id, encoder_mode: "software", output_ratio: "916" } }));
    fireEvent.click(screen.getByRole("button", { name: "导出正式视频" }));
    await waitFor(() => expect(api.chooseExportDestination).toHaveBeenCalledWith(project.project_id));
    expect(api.createExport).toHaveBeenCalledWith({ project_id: project.project_id, export: { timeline_revision_id: state.current_revision.timeline_revision_id, destination_grant_id: "destination_1", encoder_mode: "software", output_ratio: "916" } });
  });

  it("空时间线和草稿会阻止 Render 提交", async () => {
    const emptyDocument = { ...timelineDocument, clips: [], captions: [] };
    const emptyState = { ...state, current_revision: { ...state.current_revision, document: emptyDocument } };
    const emptyApi = desktopApi({ timeline: emptyState }); window.desktop = emptyApi; render(<App />);
    expect(await screen.findByRole("button", { name: "生成权威预览" })).toBeDisabled(); expect(screen.getByRole("button", { name: "导出正式视频" })).toBeDisabled();
    cleanup();
    const draftState = { ...state, draft: { project_id: project.project_id, base_revision_id: state.current_revision.timeline_revision_id, document: timelineDocument, updated_at: now, conflict: false } };
    const draftApi = desktopApi({ timeline: draftState }); window.desktop = draftApi; render(<App />);
    await waitFor(() => {
      expect(screen.getByText("检测到上次未恢复草稿")).toBeVisible();
      expect(screen.getByRole("button", { name: "生成权威预览" })).toHaveAttribute("title", "存在未提交草稿，请先形成正式 Revision");
    });
  });
});


describe("Stage 3B 静态焦点重构图", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  function setupStage3bApi(timeline: TimelineState = state) {
    const api = desktopApi({ timeline });
    vi.mocked(api.listPlatformPresets).mockResolvedValue({ items: [stage3bPlatform] });
    vi.mocked(api.listRenditionPresets).mockResolvedValue({ items: [stage3bRendition] });
    vi.mocked(api.listRenditionPreviews).mockResolvedValue({ items: [stage3aPreview("preserve_timeline"), stage3aPreview("fit_all"), stage3aPreview("crop_fill_all"), stage3aPreview("blurred_background_all")], next_cursor: null });
    vi.mocked(api.createRenditionReframePreview).mockResolvedValue({ job: null, preview: stage3bReframePreview, reused: true });
    return api;
  }

  async function openStage3b(api: DesktopApi) {
    window.desktop = api;
    render(<App />);
    const entry = await screen.findByRole("button", { name: "多平台导出" });
    await waitFor(() => expect(entry).toBeEnabled());
    fireEvent.click(entry);
    return await screen.findByRole("dialog", { name: "多平台导出" });
  }

  it("只为解析为 crop_fill 的 Clip 显示固定 3×3，并展示非 AI 与安全区边界", async () => {
    const cropDocument = { ...timelineDocument, clips: timelineDocument.clips.map(clip => ({ ...clip, layout: "crop_fill" as const })) };
    const cropState = { ...state, current_revision: { ...state.current_revision, document: cropDocument } };
    const dialog = await openStage3b(setupStage3bApi(cropState));
    const editor = within(dialog).getByRole("region", { name: "静态焦点重构图" });
    expect(within(editor).getByRole("group", { name: "Clip 1 静态焦点" })).toBeVisible();
    expect(within(editor).getAllByRole("button", { name: /^Clip 1 / })).toHaveLength(9);
    expect(editor).toHaveTextContent("非自动识别"); expect(editor).toHaveTextContent("非动态跟踪"); expect(editor).toHaveTextContent("不保证平台审核安全区");
    expect(within(editor).getByRole("button", { name: "生成重构图权威预览" })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("目标布局策略"), { target: { value: "fit_all" } });
    expect(within(dialog).getByText(/没有解析为 crop_fill/)).toBeVisible();
    expect(within(dialog).queryByRole("group", { name: "Clip 1 静态焦点" })).not.toBeInTheDocument();
  });

  it("中心点只执行删除语义，非中心 adjustment 才发送且选择变化使旧预览失效", async () => {
    const api = setupStage3bApi();
    const dialog = await openStage3b(api);
    fireEvent.change(within(dialog).getByLabelText("目标布局策略"), { target: { value: "crop_fill_all" } });
    const editor = within(dialog).getByRole("region", { name: "静态焦点重构图" });
    fireEvent.click(within(editor).getByRole("button", { name: "Clip 1 左上" }));
    fireEvent.click(within(editor).getByRole("button", { name: "生成重构图权威预览" }));
    await waitFor(() => expect(api.createRenditionReframePreview).toHaveBeenCalledWith({ project_id: project.project_id, preview: { base_rendition_snapshot_id: "rendition_snapshot_crop_fill_all", adjustments: [{ clip_id: "clip_1", horizontal_anchor: "left", vertical_anchor: "top" }], encoder_mode: "auto" } }));
    expect(await within(editor).findByRole("button", { name: "播放重构图预览" })).toBeVisible();

    fireEvent.click(within(editor).getByRole("button", { name: "Clip 1 中心" }));
    expect(within(editor).getByRole("button", { name: "生成重构图权威预览" })).toBeDisabled();
    expect(within(editor).queryByRole("button", { name: "播放重构图预览" })).not.toBeInTheDocument();
    expect(api.createRenditionReframePreview).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(api.createRenditionReframePreview).mock.calls)).not.toContain('"horizontal_anchor":"center","vertical_anchor":"center"');
  });

  it("任务成功后刷新独立 Reframe Preview，Batch payload 从 Snapshot 派生且不含 Revision", async () => {
    const api = setupStage3bApi();
    let listener: ((job: Job) => void) | undefined;
    api.subscribeJob = vi.fn((_jobId, next) => { listener = next; return () => undefined; });
    const reframeJob = { ...runningJob, job_id: "job_reframe" as never, asset_id: null, kind: "authoritative_preview" as const, input: { rendition_reframe_snapshot_id: "rendition_reframe_snapshot_1" } };
    vi.mocked(api.createRenditionReframePreview).mockResolvedValue({ job: reframeJob, preview: null, reused: false });
    vi.mocked(api.listRenditionReframePreviews).mockResolvedValue({ items: [stage3bReframePreview], next_cursor: null });
    vi.mocked(api.chooseExportDirectory).mockResolvedValue({ directory_grant_id: "directory_reframe_1" as never, display_name: "Exports", expires_at: now });
    vi.mocked(api.createReframeExportBatch).mockResolvedValue({ batch: { reframe_export_batch_id: "reframe_export_batch_1" as never, project_id: project.project_id, timeline_revision_id: state.current_revision.timeline_revision_id, status: "queued", directory_display_name: "Exports", items: [], retry_of_batch_id: null, created_at: now, updated_at: now }, jobs: [] });

    const dialog = await openStage3b(api);
    fireEvent.change(within(dialog).getByLabelText("目标布局策略"), { target: { value: "crop_fill_all" } });
    const editor = within(dialog).getByRole("region", { name: "静态焦点重构图" });
    fireEvent.click(within(editor).getByRole("button", { name: "Clip 1 右" }));
    fireEvent.click(within(editor).getByRole("button", { name: "生成重构图权威预览" }));
    await waitFor(() => expect(listener).toBeTypeOf("function"));
    await act(async () => { listener?.({ ...reframeJob, status: "succeeded", stage: "completed", progress: 1 }); await Promise.resolve(); });
    expect(await within(editor).findByRole("button", { name: "播放重构图预览" })).toBeVisible();

    const choose = within(dialog).getByRole("button", { name: "选择重构图输出目录" });
    expect(choose).toBeEnabled(); fireEvent.click(choose);
    const create = await within(dialog).findByRole("button", { name: "创建重构图批次" });
    await waitFor(() => expect(create).toBeEnabled()); fireEvent.click(create);
    await waitFor(() => expect(api.createReframeExportBatch).toHaveBeenCalled());
    const payload = vi.mocked(api.createReframeExportBatch).mock.calls[0][0];
    expect(payload).toEqual({ project_id: project.project_id, batch: { directory_grant_id: "directory_reframe_1", items: [{ rendition_reframe_snapshot_id: "rendition_reframe_snapshot_1", preview_artifact_id: "reframe_artifact_1", encoder_mode: "auto" }] } });
    expect(payload.batch).not.toHaveProperty("timeline_revision_id");
  });
});

describe("Stage 4B 生成验证正式入口", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  async function generationEntry(): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole("button", { name: "工具" }));
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
