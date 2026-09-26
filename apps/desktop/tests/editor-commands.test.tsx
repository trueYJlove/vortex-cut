import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, ModelDetail, TimelineDocument, TimelineState } from "@aivideo/contracts";
import type { AuthoritativePreviewPresentation, DesktopApi } from "../electron/preload/index.js";
import { App } from "../src/app/App.js";
import { fixturePreviewIrPresentation } from "./fixtures/preview-ir.js";
import { editorCommands } from "../src/app/editorCommands.js";

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
    listAssets: vi.fn().mockResolvedValue({ items: [{ asset: video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }, { asset: image, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGHI" }], next_cursor: null }), importAsset: vi.fn(), importAssetByFixture: vi.fn().mockResolvedValue(null).mockImplementation(async ({ kind }: { kind?: string }) => ({ grant: {}, asset: { ...image, asset_id: `import_${kind}` as never, kind: kind ?? "video", display_name: `import-${kind}` }, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGHI" })), refreshAsset: vi.fn().mockResolvedValue({ asset: video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }), assetMediaTicket: vi.fn().mockResolvedValue({ media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }), relocateAsset: vi.fn().mockResolvedValue({ grant: {}, asset: video, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" }), importSubtitle: vi.fn().mockResolvedValue(null), deleteAsset: vi.fn().mockResolvedValue(undefined), revealAsset: vi.fn().mockResolvedValue({ status: "opened" }),
    listJobs: vi.fn().mockResolvedValue({ items: options.jobs ?? [], next_cursor: null }), createJob: vi.fn(), getJob: vi.fn(), cancelJob: vi.fn().mockImplementation(async (jobId: string) => ({ ...createdJob, job_id: jobId, status: "cancelled" })), listModels: vi.fn().mockResolvedValue({ items: options.models ?? [], next_cursor: null }), getModel: vi.fn().mockResolvedValue(model), downloadModel: vi.fn().mockResolvedValue({ model: { ...model, status: "queued" }, job: downloadJob }), getModelDownload: vi.fn(), cancelModelDownload: vi.fn().mockResolvedValue({ model: { ...model, status: "cancelled" }, job: { ...downloadJob, status: "cancelled" } }), createTranscription: vi.fn().mockImplementation(async () => ({ job: { ...createdJob, job_id: `job_created_${++transcriptionSequence}` as never }, transcript: null })),
    listTranscripts: vi.fn().mockResolvedValue({ items: [{ ...transcript, segments: undefined, words: undefined }], next_cursor: null }), getTranscript: vi.fn().mockResolvedValue(transcript),
    getBrief: vi.fn().mockRejectedValue(new Error("BRIEF_NOT_FOUND")), putBrief: vi.fn().mockResolvedValue({}), listRecipes: vi.fn().mockResolvedValue({ items: [{ schema_version: 1, recipe_id: "balanced-narrative-v1", name: "Balanced", summary: "测试", rules: { selection: "keyword", pace: "balanced", max_gap_us: 1 }, document_sha256: `sha256:${"a".repeat(64)}` }] }), listProviders: vi.fn().mockResolvedValue({ items: [{ provider_config_id: "provider_1", kind: "openai_compatible_text", display_name: "测试 Provider", base_url: "https://provider.test", model: "model", enabled: true, credential_status: "configured", input_price_per_million: null, output_price_per_million: null, timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "openai_chat_completions_json_schema_v1", timeline_patch_probe_protocol_version: "1", timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: null, timeline_patch_capability_probe_sha256: `sha256:${"d".repeat(64)}`, candidate_capability_status: "supported", candidate_response_adapter_id: "openai_chat_completions_json_schema_v1", candidate_probe_protocol_version: "1", candidate_capability_tested_at: now, candidate_capability_failure_code: null, candidate_capability_probe_sha256: `sha256:${"e".repeat(64)}`, created_at: now, updated_at: now }] }), createProvider: vi.fn(), setProviderSecret: vi.fn(), deleteProviderSecret: vi.fn().mockResolvedValue({ provider_config_id: "provider_1", credential_status: "missing" }), testProvider: vi.fn().mockResolvedValue({ status: "succeeded" }), testCandidateProviderCapability: vi.fn().mockResolvedValue({ candidate_capability_status: "supported", candidate_response_adapter_id: "openai_chat_completions_json_schema_v1", candidate_probe_protocol_version: "1", candidate_capability_tested_at: now, candidate_capability_failure_code: null, candidate_capability_probe_sha256: `sha256:${"e".repeat(64)}` }), preparePlanning: vi.fn().mockResolvedValue({ egress_preview_id: "preview_1", provider: { display_name: "测试", origin: "https://provider.test", model: "model" }, prompt_template_version: "candidate-plan-v1", sent_fields: ["segments.text"], payload_sha256: `sha256:${"b".repeat(64)}`, expires_at: now, payload: { segments: [{ segment_ref: "s1", text: "第一句" }] }, stats: { transcript_count: 1, segment_count: 1, character_count: 3, estimated_tokens: 1 } }), createPlanning: vi.fn().mockResolvedValue({ job: { ...createdJob, kind: "candidate_generation" } }), listCandidatePlans: vi.fn().mockResolvedValue({ items: [] }), getCandidateClipMedia: vi.fn(), adoptCandidatePlan: vi.fn().mockResolvedValue(state),
    prepareTimelinePatch: vi.fn().mockResolvedValue({ timeline_patch_egress_preview_id: "patch_preview_1", provider: { display_name: "测试 Provider", origin: "https://provider.test", model: "model" }, prompt_template_version: "timeline-patch-v1", output_schema_version: "timeline-patch-output-v1", sent_fields: ["instruction", "timeline"], payload_sha256: `sha256:${"c".repeat(64)}`, character_count: 100, estimated_tokens: 30, clip_count: 1, caption_count: 1, locked_count: 0, expires_at: now }), testTimelinePatchProviderCapability: vi.fn().mockResolvedValue({ timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "openai_chat_completions_json_schema_v1", timeline_patch_probe_protocol_version: "1", timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: null, timeline_patch_probe_sha256: `sha256:${"d".repeat(64)}` }), createTimelinePatchGeneration: vi.fn().mockResolvedValue({ timeline_patch_generation_id: "patch_generation_1", job: { ...createdJob, kind: "timeline_patch_generation" } }), getTimelinePatchGeneration: vi.fn(), listTimelinePatchProposals: vi.fn().mockResolvedValue({ items: [] }), getTimelinePatchProposal: vi.fn(), applyTimelinePatchProposal: vi.fn().mockResolvedValue(state), compareTimelineRevisions: vi.fn(), prepareAgentSession: vi.fn(), createAgentSession: vi.fn(), listAgentSessions: vi.fn().mockResolvedValue({ items: [] }), getAgentSession: vi.fn(), getCvAnalysis: vi.fn(), listCvSamples: vi.fn().mockResolvedValue({ asset_id: "asset_1", samples: [] }), listEditingGrammarPlanners: vi.fn().mockResolvedValue({ items: [] }), prepareEditingGrammar: vi.fn(), proposeEditingGrammar: vi.fn(), listEditingGrammarProposals: vi.fn().mockResolvedValue({ items: [] }), getEditingGrammarProposal: vi.fn(), applyEditingGrammarProposal: vi.fn().mockResolvedValue(state),
    createTimeline: vi.fn().mockResolvedValue(state), getTimeline: timeline ? vi.fn().mockResolvedValue(timeline) : vi.fn().mockRejectedValue(new Error("TIMELINE_NOT_FOUND 404")), patchTimeline: vi.fn().mockResolvedValue(state), undoTimeline: vi.fn().mockResolvedValue(state), redoTimeline: vi.fn().mockResolvedValue(state), saveTimelineDraft: vi.fn().mockResolvedValue({ project_id: project.project_id, base_revision_id: state.current_revision.timeline_revision_id, document: timelineDocument, updated_at: now, conflict: false }), deleteTimelineDraft: vi.fn().mockResolvedValue(undefined), listTimelineRevisions: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), getTimelineRevision: vi.fn(),
    createPreview: vi.fn().mockResolvedValue({ job: null, preview: null, reused: false }), listPreviews: vi.fn().mockResolvedValue({ items: options.previews ?? [], next_cursor: null }), chooseExportDestination: vi.fn().mockResolvedValue(null), renameExportDestination: vi.fn(), createExport: vi.fn(), listExports: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), deleteExportRecord: vi.fn().mockResolvedValue(undefined), getRenderArtifact: vi.fn(), getPreviewIr: vi.fn().mockResolvedValue(fixturePreviewIrPresentation()), lookupDerivedMedia: vi.fn(), derivedMediaStats: vi.fn(), derivedMediaUrl: vi.fn(), captionFontUrl: vi.fn().mockResolvedValue(""), captionFontUrls: vi.fn().mockResolvedValue([{ family: "Noto Sans CJK SC", media_url: "" }]),
    listPlatformPresets: vi.fn().mockResolvedValue({ items: [] }), listRenditionPresets: vi.fn().mockResolvedValue({ items: [] }), createRenditionPreview: vi.fn(), listRenditionPreviews: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), chooseExportDirectory: vi.fn().mockResolvedValue(null), createExportBatch: vi.fn(), getExportBatch: vi.fn(), listExportBatches: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), cancelExportBatch: vi.fn(), retryExportBatch: vi.fn(),
    createRenditionReframePreview: vi.fn(), listRenditionReframePreviews: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), createReframeExportBatch: vi.fn(), getReframeExportBatch: vi.fn(), listReframeExportBatches: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), cancelReframeExportBatch: vi.fn(), retryReframeExportBatch: vi.fn(),
    prepareMediaGeneration: vi.fn(), createMediaGeneration: vi.fn(), listMediaGenerationRequests: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), getMediaGenerationRequest: vi.fn(), listMediaGenerationTasks: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), retryMediaGenerationTask: vi.fn(), cancelMediaGenerationTask: vi.fn(),
    listImageProviderConfigs: vi.fn().mockResolvedValue({ items: [] }), createImageProviderConfig: vi.fn(), setImageProviderSecret: vi.fn(), deleteImageProviderSecret: vi.fn(), prepareProviderImageGeneration: vi.fn(), createProviderImageGeneration: vi.fn(), listProviderImageGenerationRequests: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), getProviderImageGenerationRequest: vi.fn(), listProviderImageGenerationTasks: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), prepareProviderImageGenerationRetry: vi.fn(), retryProviderImageGenerationTask: vi.fn(), cancelProviderImageGenerationTask: vi.fn(),
    getShotList: vi.fn().mockResolvedValue({ shot_list_id: null, project_id: project.project_id, lifecycle: "empty", current_revision: null, confirmed_revision: null }), listShotListRevisions: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), getShotListRevision: vi.fn(), createShotListRevision: vi.fn(), confirmShotListRevision: vi.fn(),
    getShotRequirementImageFulfillment: vi.fn(), listShotRequirementImageFulfillmentLinks: vi.fn(), listShotRequirementImageFulfillmentAdoptions: vi.fn(), prepareShotRequirementImageFulfillment: vi.fn(), createShotRequirementImageFulfillment: vi.fn(), adoptShotRequirementImageFulfillment: vi.fn(),
    prepareShotRequirementTimelineAssembly: vi.fn(), applyShotRequirementTimelineAssembly: vi.fn(), getShotRequirementTimelineAssemblyPreview: vi.fn(), getShotRequirementTimelineAssembly: vi.fn(), listShotRequirementTimelineAssemblies: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    prepareShotRequirementTimelineBatchAssembly: vi.fn(), applyShotRequirementTimelineBatchAssembly: vi.fn(), getShotRequirementTimelineBatchAssemblyPreview: vi.fn(), getShotRequirementTimelineBatchAssembly: vi.fn(), listShotRequirementTimelineBatches: vi.fn().mockResolvedValue({ items: [], next_cursor: null }), listShotRequirementTimelineBatchAssemblyItems: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    openArtifact: vi.fn(), openArtifactFolder: vi.fn(), subscribeJob: vi.fn().mockReturnValue(() => undefined), getPreviewSource: vi.fn(), createPreviewSourceJob: vi.fn(), previewSourceMediaUrl: vi.fn(), getWaveform: vi.fn(), waveformMediaUrl: vi.fn(), ensurePcmChunk: vi.fn(), pcmChunkMediaUrl: vi.fn(), decodeFrames: vi.fn(), getPreviewIrV2Manifest: vi.fn(), getPreviewIrV2Window: vi.fn(), updateEditorLoad: vi.fn().mockResolvedValue({ status: "ok" }), getSettings: vi.fn().mockResolvedValue({ saved: { proxy_mode: "system", provider_proxy: null }, effective: { proxy_mode: "system", provider_proxy: null }, pending_restart: false }), setSettings: vi.fn().mockResolvedValue({ proxy_mode: "system", provider_proxy: null }), restartCore: vi.fn().mockResolvedValue(undefined), diagnostics: vi.fn()
  } as DesktopApi;
}

describe("命令注册表", () => {
  beforeEach(() => { window.desktop = desktopApi(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("keeps command identifiers unique and exposes required core commands", () => {
    const ids = editorCommands.map(command => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["timeline.undo", "timeline.redo", "timeline.split", "timeline.delete", "preview.generate", "export.open"]));
  });

  it("defines a Chinese label and at least one scope for every command", () => {
    for (const command of editorCommands) {
      expect(command.label.length).toBeGreaterThan(0);
      expect(command.scopes.length).toBeGreaterThan(0);
    }
  });

  it("opens the command palette with Ctrl+K and filters by query", async () => {
    const api = desktopApi();
    window.desktop = api;
    render(<App />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("searchbox", { name: "命令搜索" });
    expect(screen.getByRole("dialog", { name: "命令搜索" })).toBeInTheDocument();
    expect(screen.getByText("撤销")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "导出" } });
    expect(screen.queryByText("撤销")).not.toBeInTheDocument();
    expect(screen.getByText("导出")).toBeInTheDocument();
  });

  it("executes undo with Ctrl+Z", async () => {
    const api = desktopApi();
    window.desktop = api;
    render(<App />);
    await screen.findByRole("button", { name: /Clip 1/ });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(api.undoTimeline).toHaveBeenCalled());
  });

  it("does not fire timeline shortcuts while the command search input is focused", async () => {
    const api = desktopApi();
    window.desktop = api;
    render(<App />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("searchbox", { name: "命令搜索" });
    fireEvent.keyDown(input, { key: "z", ctrlKey: true });
    expect(api.undoTimeline).not.toHaveBeenCalled();
  });

  it("deletes the selected clip via Delete only with timeline focus", async () => {
    const api = desktopApi();
    window.desktop = api;
    render(<App />);
    const clip = await screen.findByRole("button", { name: /Clip 1/ });
    fireEvent.click(clip);
    fireEvent.keyDown(clip, { key: "Delete" });
    await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [expect.objectContaining({ op: "remove_clip" })] }) })));
  });

  it("shows disabled reasons for commands that cannot run", async () => {
    window.desktop = desktopApi();
    render(<App />);
    await screen.findByRole("button", { name: /Clip 1/ });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const list = await screen.findByRole("listbox", { name: "命令列表" });
    expect(within(list).getByText("请先选择时间线片段")).toBeInTheDocument();
  });
});
