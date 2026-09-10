import { contextBridge, ipcRenderer } from "electron";
import type {
  Asset,
  AssetAvailability,
  AssetKind,
  AssetPage,
  AssetPresentationPage,
  AssetPresentation,
  CoreHealth,
  FileGrant,
  GrantId,
  ImportedAsset,
  Job,
  JobId,
  JobPage,
  MediaInfo,
  ModelDetail,
  ModelDownloadPage,
  ModelDownloadResponse,
  ModelDownloadStatusResponse,
  ModelId,
  Project,
  ProjectId,
  ProjectPage,
  ProjectStatus,
  Transcript,
  TranscriptId,
  TranscriptPage,
  TranscriptionCreateResponse
  , TimelineCreateInput
  , TimelineDraft
  , TimelineDraftInput
  , TimelinePatch
  , TimelineRevision
  , TimelineRevisionId
  , TimelineRevisionPage
  , TimelineState
  , AuthoritativePreview
  , DestinationGrant
  , EncoderMode
  , OutputRatio
  , ExportRecord
  , RenderArtifact
  , RenderArtifactId
  , Brief, BriefInput, Recipe, ProviderConfig, EgressPreview, CandidatePlan, ProviderCapabilityTestResult
  , TimelineDiff, TimelinePatchEgressPreview, TimelinePatchGeneration, TimelinePatchGenerationCreateResponse, TimelinePatchProposal, TimelinePatchCapabilityTestResponse
  , PlatformPreset, RenditionPreset, RenditionPreview, RenditionPreviewCreateInput, DirectoryGrant, ExportBatch, ExportBatchCreateInput, ExportBatchRetryInput
  , RenditionReframePreview, RenditionReframePreviewCreateInput, ReframeExportBatch, ReframeExportBatchCreateInput, ReframeExportBatchRetryInput
  , MediaGenerationPrepareInput, MediaGenerationCreateInput, MediaGenerationPreparedRequest
  , MediaGenerationCreateResponse, MediaGenerationRequest, MediaGenerationRequestId, MediaGenerationRequestPage
  , MediaGenerationTask, MediaGenerationTaskId, MediaGenerationTaskPage
  , ShotListState, ShotListRevisionPage, ShotListRevisionDetail, ShotListRevisionId
  , ShotListRevisionCreateInput, ShotListRevisionCreateResponse, ShotListConfirmInput, ShotListConfirmResponse
  , ImageProviderConfigCreateInput, ImageProviderConfigPage, ImageProviderConfigSummary
  , ProviderImageGenerationPrepareInput, ProviderImageGenerationPreparedPreview
  , ProviderImageGenerationCreateInput, ProviderImageGenerationCreateResponse
  , ProviderImageGenerationRequest, ProviderImageGenerationRequestPage
  , ProviderImageGenerationTask, ProviderImageGenerationTaskPage, ProviderImageGenerationRetryPrepareInput
  , ShotRequirementId, ShotRequirementImageFulfillmentPrepareInput
  , ShotRequirementImageFulfillmentPreparedPreview, ShotRequirementImageFulfillmentCreateInput
  , ShotRequirementImageFulfillmentCreateResponse, ShotRequirementImageFulfillmentState
  , ShotRequirementImageGenerationLinkPage, ShotRequirementImageAdoptionPage
  , ShotRequirementImageAdoptInput, ShotRequirementImageAdoptResponse
  , ShotRequirementTimelineAssemblyPrepareInput, ShotRequirementTimelineAssemblyApplyInput
  , ShotRequirementTimelineAssemblyPreview, ShotRequirementTimelineAssembly
  , ShotRequirementTimelineAssemblyApplyResponse, ShotRequirementTimelineAssemblyPage
  , ShotRequirementTimelineAssemblyPreviewId, ShotRequirementTimelineAssemblyId
  , ShotRequirementTimelineBatchAssemblyPrepareInput, ShotRequirementTimelineBatchAssemblyApplyInput
  , ShotRequirementTimelineBatchAssemblyPreview, ShotRequirementTimelineBatchAssembly
  , ShotRequirementTimelineBatchAssemblyApplyResponse, ShotRequirementTimelineBatchAssemblyPage
  , ShotRequirementTimelineBatchAssemblyPreviewId, ShotRequirementTimelineBatchAssemblyId
  , ShotRequirementTimelineBatchAssemblyItemPage
  , DerivedMediaEntry, DerivedMediaStats
  , PreviewSourceDescription, PreviewSourceJobResponse, PreviewSourceMediaResponse, PreviewSourceProfileId, PreviewSourceMode
  , WaveformDescription, WaveformMediaResponse
  , PcmChunkDescription, PcmChunkMediaResponse
  , PreviewIrV2Manifest, PreviewIrV2Window
} from "@aivideo/contracts";

// M3-0 探针 dev-only 桥：生产构建 NODE_ENV 静态替换 → 死代码消除（见 probe-bridge.ts 注释）。
if (process.env.NODE_ENV !== "production" && process.env.AIVS_M3_PROBE) {
  void import("./probe-bridge.js").then(module => module.registerProbeBridge()).catch(() => undefined);
}

export interface MediaSelection { grant: FileGrant; media: MediaInfo }
export interface DesktopRuntime {
  protocol_version: 1;
  status: "ready";
  /** B13 资源预算档位（离散值；不暴露额外主机信息——Main 侧由总内存判定）。 */
  resource_tier?: "conservative" | "balanced" | "high";
}
export interface AuthoritativePreviewPresentation { preview: AuthoritativePreview; media_url: string }
export interface ExportRecordPresentation { export_record: ExportRecord; media_url: string | null }
export interface RenderArtifactPresentation { artifact: RenderArtifact; media_url: string }
export interface PreviewIrPresentation {
  schema_version: number;
  content_fingerprint: string;
  timeline_revision_id: string;
  output_ratio: string;
  ir: Record<string, unknown>;
}
export interface RenditionPreviewPresentation { preview: RenditionPreview; media_url: string }
export interface RenditionReframePreviewPresentation { preview: RenditionReframePreview; media_url: string }

export interface DesktopApi {
  getRuntime: () => Promise<DesktopRuntime>;
  chooseMedia: () => Promise<MediaSelection | null>;
  probeMedia: (grantId: GrantId) => Promise<MediaInfo>;
  listProjects: (params?: { status?: ProjectStatus; limit?: number; cursor?: string }) => Promise<ProjectPage>;
  createProject: (input: { name: string; root_dir_name?: string; canvas?: { width: number; height: number; fps_num?: number; fps_den?: number } }) => Promise<Project>;
  getProject: (projectId: ProjectId) => Promise<Project>;
  renameProject: (input: { project_id: ProjectId; name: string }) => Promise<Project>;
  archiveProject: (projectId: ProjectId) => Promise<Project>;
  reopenProject: (projectId: ProjectId) => Promise<Project>;
  listAssets: (input: { project_id: ProjectId; availability?: AssetAvailability; limit?: number; cursor?: string }) => Promise<AssetPresentationPage>;
  importAsset: (input: { project_id: ProjectId; kind?: AssetKind }) => Promise<ImportedAsset | null>;
  refreshAsset: (assetId: string) => Promise<AssetPresentation>;
  relocateAsset: (input: { asset_id: string }) => Promise<ImportedAsset | null>;
  /** 删除素材；remove_timeline_clips=true 时级联删除时间线相关片段，返回清理计数。 */
  deleteAsset: (input: { asset_id: string; remove_timeline_clips?: boolean }) => Promise<{ removed_clips: number; removed_captions: number }>;
  /** 打开素材所在文件夹；文件缺失时弹框提供 重新定位 / 移除 恢复路径。 */
  revealAsset: (assetId: string) => Promise<{ status: "opened" | "relocated" | "deleted" | "cancelled" }>;
  /** 弹出字幕文件选择框（SRT/ASS/SSA/LRC），返回文本内容；取消返回 null。 */
  importSubtitle: () => Promise<{ file_name: string; content: string } | null>;
  listJobs: (input: { project_id: ProjectId; status?: Job["status"]; limit?: number; cursor?: string }) => Promise<JobPage>;
  createJob: (input: { project_id: ProjectId; media_id: MediaInfo["media_id"]; kind: "proxy" | "portrait_sample"; encoder_mode?: "auto" | "software"; start_us?: number; duration_us?: number; layout?: "blurred_background" }) => Promise<Job>;
  getJob: (jobId: JobId) => Promise<Job>;
  cancelJob: (jobId: JobId) => Promise<Job>;
  listModels: (params?: { status?: string; limit?: number; cursor?: string }) => Promise<ModelDownloadPage>;
  getModel: (modelId: ModelId) => Promise<ModelDetail>;
  downloadModel: (input: { model_id: ModelId; license_acceptance: string | null }) => Promise<ModelDownloadResponse>;
  getModelDownload: (modelId: ModelId) => Promise<ModelDownloadStatusResponse>;
  cancelModelDownload: (modelId: ModelId) => Promise<ModelDownloadResponse>;
  createTranscription: (input: { asset_id: string; model_id: ModelId; language: string; word_timestamps: boolean; license_acceptance: string | null }) => Promise<TranscriptionCreateResponse>;
  listTranscripts: (assetId: string) => Promise<TranscriptPage>;
  getTranscript: (transcriptId: TranscriptId) => Promise<Transcript>;
  getBrief?: (projectId: ProjectId) => Promise<Brief>;
  putBrief?: (input: { project_id: ProjectId; brief: BriefInput }) => Promise<Brief>;
  listRecipes?: () => Promise<{ items: Recipe[] }>;
  listProviders?: () => Promise<{ items: ProviderConfig[] }>;
  createProvider?: (input: Record<string, unknown>) => Promise<ProviderConfig>;
  setProviderSecret?: (input: { provider_config_id: string; secret: string }) => Promise<{ provider_config_id: string; credential_status: "configured" }>;
  deleteProviderSecret?: (providerId: string) => Promise<{ provider_config_id: string; credential_status: "missing" }>;
  testProvider?: (providerId: string) => Promise<{ ok?: boolean; message?: string }>;
  testCandidateProviderCapability: (providerId: string) => Promise<ProviderCapabilityTestResult>;
  preparePlanning?: (input: { project_id: ProjectId; provider_config_id: string; recipe_id: string; transcript_ids: string[] }) => Promise<EgressPreview>;
  createPlanning?: (input: { project_id: ProjectId; egress_preview_id: string; payload_sha256: string }) => Promise<{ job: Job }>;
  listCandidatePlans?: (projectId: ProjectId) => Promise<{ items: CandidatePlan[] }>;
  getCandidateClipMedia?: (input: { project_id: ProjectId; candidate_plan_id: string; candidate_clip_id: string }) => Promise<{ media_url: string; source_start_us: number; source_end_us: number }>;
  adoptCandidatePlan?: (input: { project_id: ProjectId; candidate_plan_id: string; adoption: { schema_version: 1; candidate_document_sha256: string; base_revision_id: TimelineRevisionId | null } }) => Promise<TimelineState>;
  prepareTimelinePatch: (input: { project_id: ProjectId; base_revision_id: TimelineRevisionId; provider_config_id: string; instruction: string }) => Promise<TimelinePatchEgressPreview>;
  testTimelinePatchProviderCapability: (providerId: string) => Promise<TimelinePatchCapabilityTestResponse>;
  createTimelinePatchGeneration: (input: { project_id: ProjectId; timeline_patch_egress_preview_id: string; payload_sha256: string }) => Promise<TimelinePatchGenerationCreateResponse>;
  getTimelinePatchGeneration: (generationId: string) => Promise<TimelinePatchGeneration>;
  listTimelinePatchProposals: (projectId: ProjectId) => Promise<{ items: TimelinePatchProposal[] }>;
  getTimelinePatchProposal: (proposalId: string) => Promise<TimelinePatchProposal>;
  applyTimelinePatchProposal: (input: { project_id: ProjectId; proposal_id: string; base_revision_id: TimelineRevisionId; proposed_document_sha256: string }) => Promise<TimelineState>;
  compareTimelineRevisions: (input: { project_id: ProjectId; base_revision_id: TimelineRevisionId; target_revision_id: TimelineRevisionId }) => Promise<TimelineDiff>;
  createTimeline: (input: { project_id: ProjectId; timeline: TimelineCreateInput }) => Promise<TimelineState>;
  getTimeline: (projectId: ProjectId) => Promise<TimelineState>;
  patchTimeline: (input: { project_id: ProjectId; patch: TimelinePatch }) => Promise<TimelineState>;
  undoTimeline: (input: { project_id: ProjectId; base_revision_id: TimelineRevisionId }) => Promise<TimelineState>;
  redoTimeline: (input: { project_id: ProjectId; base_revision_id: TimelineRevisionId }) => Promise<TimelineState>;
  saveTimelineDraft: (input: { project_id: ProjectId; draft: TimelineDraftInput }) => Promise<TimelineDraft>;
  deleteTimelineDraft: (projectId: ProjectId) => Promise<void>;
  listTimelineRevisions: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<TimelineRevisionPage>;
  getTimelineRevision: (revisionId: TimelineRevisionId) => Promise<TimelineRevision>;
  createPreview: (input: { project_id: ProjectId; preview: { timeline_revision_id?: TimelineRevisionId; encoder_mode?: EncoderMode; output_ratio?: OutputRatio } }) => Promise<{ job: Job | null; preview: AuthoritativePreviewPresentation | null; reused: boolean }>;
  listPreviews: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<{ items: AuthoritativePreviewPresentation[]; next_cursor: string | null }>;
  chooseExportDestination: (projectId: ProjectId) => Promise<DestinationGrant | null>;
  createExport: (input: { project_id: ProjectId; export: { timeline_revision_id?: TimelineRevisionId; destination_grant_id: DestinationGrant["destination_grant_id"]; encoder_mode?: EncoderMode; output_ratio?: OutputRatio } }) => Promise<{ job: Job; export_record: ExportRecordPresentation | null }>;
  listExports: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<{ items: ExportRecordPresentation[]; next_cursor: string | null }>;
  listPlatformPresets: () => Promise<{ items: PlatformPreset[] }>;
  listRenditionPresets: () => Promise<{ items: RenditionPreset[] }>;
  createRenditionPreview: (input: { project_id: ProjectId; preview: RenditionPreviewCreateInput }) => Promise<{ job: Job | null; preview: RenditionPreviewPresentation | null; reused: boolean }>;
  listRenditionPreviews: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<{ items: RenditionPreviewPresentation[]; next_cursor: string | null }>;
  chooseExportDirectory: (projectId: ProjectId) => Promise<DirectoryGrant | null>;
  createExportBatch: (input: { project_id: ProjectId; batch: ExportBatchCreateInput }) => Promise<{ batch: ExportBatch; jobs: Job[] }>;
  getExportBatch: (batchId: string) => Promise<ExportBatch>;
  listExportBatches: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<{ items: ExportBatch[]; next_cursor: string | null }>;
  cancelExportBatch: (batchId: string) => Promise<ExportBatch>;
  retryExportBatch: (input: { batch_id: string; retry: ExportBatchRetryInput }) => Promise<{ batch: ExportBatch; jobs: Job[] }>;
  createRenditionReframePreview: (input: { project_id: ProjectId; preview: RenditionReframePreviewCreateInput }) => Promise<{ job: Job | null; preview: RenditionReframePreviewPresentation | null; reused: boolean }>;
  listRenditionReframePreviews: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<{ items: RenditionReframePreviewPresentation[]; next_cursor: string | null }>;
  createReframeExportBatch: (input: { project_id: ProjectId; batch: ReframeExportBatchCreateInput }) => Promise<{ batch: ReframeExportBatch; jobs: Job[] }>;
  getReframeExportBatch: (batchId: string) => Promise<ReframeExportBatch>;
  listReframeExportBatches: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<{ items: ReframeExportBatch[]; next_cursor: string | null }>;
  cancelReframeExportBatch: (batchId: string) => Promise<ReframeExportBatch>;
  retryReframeExportBatch: (input: { batch_id: string; retry: ReframeExportBatchRetryInput }) => Promise<{ batch: ReframeExportBatch; jobs: Job[] }>;
  prepareMediaGeneration: (input: { project_id: ProjectId; request: MediaGenerationPrepareInput }) => Promise<MediaGenerationPreparedRequest>;
  createMediaGeneration: (input: { project_id: ProjectId; request: MediaGenerationCreateInput }) => Promise<MediaGenerationCreateResponse>;
  listMediaGenerationRequests: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<MediaGenerationRequestPage>;
  getMediaGenerationRequest: (requestId: MediaGenerationRequestId) => Promise<MediaGenerationRequest>;
  listMediaGenerationTasks: (input: { request_id: MediaGenerationRequestId; limit?: number; cursor?: string }) => Promise<MediaGenerationTaskPage>;
  retryMediaGenerationTask: (taskId: MediaGenerationTaskId) => Promise<MediaGenerationTask>;
  cancelMediaGenerationTask: (taskId: MediaGenerationTaskId) => Promise<MediaGenerationTask>;
  listImageProviderConfigs: (projectId: ProjectId) => Promise<ImageProviderConfigPage>;
  createImageProviderConfig: (input: { project_id: ProjectId; config: ImageProviderConfigCreateInput }) => Promise<ImageProviderConfigSummary>;
  setImageProviderSecret: (input: { provider_config_id: string; secret: string }) => Promise<{ provider_config_id: string; credential_status: "configured" }>;
  deleteImageProviderSecret: (providerConfigId: string) => Promise<{ provider_config_id: string; credential_status: "missing" }>;
  prepareProviderImageGeneration: (input: { project_id: ProjectId; request: ProviderImageGenerationPrepareInput }) => Promise<ProviderImageGenerationPreparedPreview>;
  createProviderImageGeneration: (input: { project_id: ProjectId; request: ProviderImageGenerationCreateInput }) => Promise<ProviderImageGenerationCreateResponse>;
  listProviderImageGenerationRequests: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<ProviderImageGenerationRequestPage>;
  getProviderImageGenerationRequest: (requestId: MediaGenerationRequestId) => Promise<ProviderImageGenerationRequest>;
  listProviderImageGenerationTasks: (input: { request_id: MediaGenerationRequestId; limit?: number; cursor?: string }) => Promise<ProviderImageGenerationTaskPage>;
  prepareProviderImageGenerationRetry: (input: { task_id: MediaGenerationTaskId; request: ProviderImageGenerationRetryPrepareInput }) => Promise<ProviderImageGenerationPreparedPreview>;
  retryProviderImageGenerationTask: (input: { task_id: MediaGenerationTaskId; request: ProviderImageGenerationCreateInput }) => Promise<ProviderImageGenerationTask>;
  cancelProviderImageGenerationTask: (taskId: MediaGenerationTaskId) => Promise<ProviderImageGenerationTask>;
  getShotList: (projectId: ProjectId) => Promise<ShotListState>;
  listShotListRevisions: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<ShotListRevisionPage>;
  getShotListRevision: (revisionId: ShotListRevisionId) => Promise<ShotListRevisionDetail>;
  createShotListRevision: (input: { project_id: ProjectId; revision: ShotListRevisionCreateInput }) => Promise<ShotListRevisionCreateResponse>;
  confirmShotListRevision: (input: { project_id: ProjectId; confirmation: ShotListConfirmInput }) => Promise<ShotListConfirmResponse>;
  getShotRequirementImageFulfillment: (input: { project_id: ProjectId; requirement_id: ShotRequirementId }) => Promise<ShotRequirementImageFulfillmentState>;
  listShotRequirementImageFulfillmentLinks: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; limit?: number; cursor?: string }) => Promise<ShotRequirementImageGenerationLinkPage>;
  listShotRequirementImageFulfillmentAdoptions: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; limit?: number; cursor?: string }) => Promise<ShotRequirementImageAdoptionPage>;
  prepareShotRequirementImageFulfillment: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; request: ShotRequirementImageFulfillmentPrepareInput }) => Promise<ShotRequirementImageFulfillmentPreparedPreview>;
  createShotRequirementImageFulfillment: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; request: ShotRequirementImageFulfillmentCreateInput }) => Promise<ShotRequirementImageFulfillmentCreateResponse>;
  adoptShotRequirementImageFulfillment: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; request: ShotRequirementImageAdoptInput }) => Promise<ShotRequirementImageAdoptResponse>;
  prepareShotRequirementTimelineAssembly: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; request: ShotRequirementTimelineAssemblyPrepareInput }) => Promise<ShotRequirementTimelineAssemblyPreview>;
  applyShotRequirementTimelineAssembly: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; request: ShotRequirementTimelineAssemblyApplyInput }) => Promise<ShotRequirementTimelineAssemblyApplyResponse>;
  getShotRequirementTimelineAssemblyPreview: (input: { preview_id: ShotRequirementTimelineAssemblyPreviewId }) => Promise<ShotRequirementTimelineAssemblyPreview>;
  getShotRequirementTimelineAssembly: (input: { assembly_id: ShotRequirementTimelineAssemblyId }) => Promise<ShotRequirementTimelineAssembly>;
  listShotRequirementTimelineAssemblies: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; limit?: number; cursor?: string }) => Promise<ShotRequirementTimelineAssemblyPage>;
  prepareShotRequirementTimelineBatchAssembly: (input: { project_id: ProjectId; request: ShotRequirementTimelineBatchAssemblyPrepareInput }) => Promise<ShotRequirementTimelineBatchAssemblyPreview>;
  applyShotRequirementTimelineBatchAssembly: (input: { project_id: ProjectId; request: ShotRequirementTimelineBatchAssemblyApplyInput }) => Promise<ShotRequirementTimelineBatchAssemblyApplyResponse>;
  getShotRequirementTimelineBatchAssemblyPreview: (input: { preview_id: ShotRequirementTimelineBatchAssemblyPreviewId }) => Promise<ShotRequirementTimelineBatchAssemblyPreview>;
  getShotRequirementTimelineBatchAssembly: (input: { batch_id: ShotRequirementTimelineBatchAssemblyId }) => Promise<ShotRequirementTimelineBatchAssembly>;
  listShotRequirementTimelineBatches: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<ShotRequirementTimelineBatchAssemblyPage>;
  listShotRequirementTimelineBatchAssemblyItems: (input: { batch_id: ShotRequirementTimelineBatchAssemblyId; limit?: number; cursor?: string }) => Promise<ShotRequirementTimelineBatchAssemblyItemPage>;
  getRenderArtifact: (artifactId: RenderArtifactId) => Promise<RenderArtifactPresentation>;
  getPreviewIr: (input: { project_id: ProjectId; timeline_revision_id?: string | null; output_ratio?: string }) => Promise<PreviewIrPresentation>;
  // C20 窗口化 IR v2：manifest（非帧 DTO）+ 窗口帧表切片（Renderer 分页取帧）
  getPreviewIrV2Manifest: (input: { project_id: ProjectId; timeline_revision_id?: string | null; output_ratio?: string }) => Promise<PreviewIrV2Manifest>;
  getPreviewIrV2Window: (input: { project_id: ProjectId; start_frame: number; frame_count: number; timeline_revision_id?: string | null; output_ratio?: string }) => Promise<PreviewIrV2Window>;
  // B10 派生媒体缓存（performance-v1）：查询/用量 + 票据化媒体 URL
  lookupDerivedMedia: (input: { project_id: ProjectId; asset_id: string; kind: string; params: Record<string, string> }) => Promise<DerivedMediaEntry>;
  derivedMediaStats: (projectId: ProjectId) => Promise<DerivedMediaStats>;
  derivedMediaUrl: (input: { project_id: ProjectId; asset_id: string; kind: string; params: Record<string, string> }) => Promise<{ media_url: string; cache_key: string; status: "ready"; size_bytes: number }>;
  // B11 preview-source（全源代理与预览源选择）：描述/作业/代理票据
  getPreviewSource: (input: { project_id: ProjectId; asset_id: string; profile_id?: PreviewSourceProfileId; mode?: PreviewSourceMode; generate?: boolean }) => Promise<PreviewSourceDescription>;
  createPreviewSourceJob: (input: { project_id: ProjectId; asset_id: string; profile_id?: PreviewSourceProfileId }) => Promise<PreviewSourceJobResponse>;
  previewSourceMediaUrl: (input: { project_id: ProjectId; asset_id: string; profile_id: PreviewSourceProfileId }) => Promise<PreviewSourceMediaResponse>;
  // B14 素材级持久化波形：描述（generate 登记作业）+ 票据化文件 URL
  getWaveform: (input: { project_id: ProjectId; asset_id: string; generate?: boolean }) => Promise<WaveformDescription>;
  waveformMediaUrl: (input: { project_id: ProjectId; asset_id: string }) => Promise<WaveformMediaResponse>;
  // B15 分块 PCM：块确保（网格对齐）+ 票据化块文件 URL
  ensurePcmChunk: (input: { project_id: ProjectId; asset_id: string; start_sample: number }) => Promise<PcmChunkDescription>;
  pcmChunkMediaUrl: (input: { project_id: ProjectId; asset_id: string; start_sample: number }) => Promise<PcmChunkMediaResponse>;
  // B16b 编辑器负载：playing/scrubbing/idle 推送（Main 侧 lease 心跳消费）
  updateEditorLoad: (mode: "playing" | "scrubbing" | "idle") => Promise<{ status: string }>;
  captionFontUrl: () => Promise<string>;
  openArtifact: (artifactId: string) => Promise<void>;
  openArtifactFolder: (artifactId: string) => Promise<void>;
  subscribeJob: (jobId: JobId, listener: (job: Job) => void) => () => void;
  diagnostics: () => Promise<CoreHealth>;
}

const api: DesktopApi = {
  getRuntime: () => ipcRenderer.invoke("runtime:get"),
  chooseMedia: () => ipcRenderer.invoke("media:choose"),
  probeMedia: grantId => ipcRenderer.invoke("media:probe", grantId),
  listProjects: params => ipcRenderer.invoke("project:list", params),
  createProject: input => ipcRenderer.invoke("project:create", input),
  getProject: projectId => ipcRenderer.invoke("project:get", projectId),
  renameProject: input => ipcRenderer.invoke("project:rename", input),
  archiveProject: projectId => ipcRenderer.invoke("project:archive", projectId),
  reopenProject: projectId => ipcRenderer.invoke("project:reopen", projectId),
  listAssets: input => ipcRenderer.invoke("asset:list", input),
  importAsset: input => ipcRenderer.invoke("asset:import", input),
  refreshAsset: assetId => ipcRenderer.invoke("asset:refresh", assetId),
  relocateAsset: input => ipcRenderer.invoke("asset:relocate", input),
  deleteAsset: input => ipcRenderer.invoke("asset:delete", input),
  revealAsset: assetId => ipcRenderer.invoke("asset:reveal", assetId),
  importSubtitle: () => ipcRenderer.invoke("subtitle:import"),
  listJobs: input => ipcRenderer.invoke("job:list", input),
  createJob: input => ipcRenderer.invoke("job:create", input),
  getJob: jobId => ipcRenderer.invoke("job:get", jobId),
  cancelJob: jobId => ipcRenderer.invoke("job:cancel", jobId),
  listModels: params => ipcRenderer.invoke("model:list", params),
  getModel: modelId => ipcRenderer.invoke("model:get", modelId),
  downloadModel: input => ipcRenderer.invoke("model:download", input),
  getModelDownload: modelId => ipcRenderer.invoke("model:download-status", modelId),
  cancelModelDownload: modelId => ipcRenderer.invoke("model:cancel", modelId),
  createTranscription: input => ipcRenderer.invoke("transcription:create", input),
  listTranscripts: assetId => ipcRenderer.invoke("transcription:list", assetId),
  getTranscript: transcriptId => ipcRenderer.invoke("transcript:get", transcriptId),
  getBrief: projectId => ipcRenderer.invoke("brief:get", projectId),
  putBrief: input => ipcRenderer.invoke("brief:put", input),
  listRecipes: () => ipcRenderer.invoke("recipe:list"),
  listProviders: () => ipcRenderer.invoke("provider:list"),
  createProvider: input => ipcRenderer.invoke("provider:create", input),
  setProviderSecret: input => ipcRenderer.invoke("provider:set-secret", input),
  deleteProviderSecret: providerId => ipcRenderer.invoke("provider:delete-secret", providerId),
  testProvider: providerId => ipcRenderer.invoke("provider:test", providerId),
  testCandidateProviderCapability: providerId => ipcRenderer.invoke("planning:test-provider-capability", providerId),
  preparePlanning: input => ipcRenderer.invoke("planning:prepare", input),
  createPlanning: input => ipcRenderer.invoke("planning:create", input),
  listCandidatePlans: projectId => ipcRenderer.invoke("planning:list", projectId),
  getCandidateClipMedia: input => ipcRenderer.invoke("planning:clip-media", input),
  adoptCandidatePlan: input => ipcRenderer.invoke("planning:adopt", input),
  prepareTimelinePatch: input => ipcRenderer.invoke("planning-patch:prepare", input),
  testTimelinePatchProviderCapability: providerId => ipcRenderer.invoke("planning-patch:test-provider-capability", providerId),
  createTimelinePatchGeneration: input => ipcRenderer.invoke("planning-patch:create", input),
  getTimelinePatchGeneration: generationId => ipcRenderer.invoke("planning-patch:generation-get", generationId),
  listTimelinePatchProposals: projectId => ipcRenderer.invoke("planning-patch:proposal-list", projectId),
  getTimelinePatchProposal: proposalId => ipcRenderer.invoke("planning-patch:proposal-get", proposalId),
  applyTimelinePatchProposal: input => ipcRenderer.invoke("planning-patch:proposal-apply", input),
  compareTimelineRevisions: input => ipcRenderer.invoke("timeline:revision-diff", input),
  createTimeline: input => ipcRenderer.invoke("timeline:create", input),
  getTimeline: projectId => ipcRenderer.invoke("timeline:get", projectId),
  patchTimeline: input => ipcRenderer.invoke("timeline:patch", input),
  undoTimeline: input => ipcRenderer.invoke("timeline:undo", input),
  redoTimeline: input => ipcRenderer.invoke("timeline:redo", input),
  saveTimelineDraft: input => ipcRenderer.invoke("timeline:draft-save", input),
  deleteTimelineDraft: projectId => ipcRenderer.invoke("timeline:draft-delete", projectId),
  listTimelineRevisions: input => ipcRenderer.invoke("timeline:revisions", input),
  getTimelineRevision: revisionId => ipcRenderer.invoke("timeline:revision", revisionId),
  createPreview: input => ipcRenderer.invoke("preview:create", input),
  listPreviews: input => ipcRenderer.invoke("preview:list", input),
  chooseExportDestination: projectId => ipcRenderer.invoke("export:choose-destination", projectId),
  createExport: input => ipcRenderer.invoke("export:create", input),
  listExports: input => ipcRenderer.invoke("export:list", input),
  listPlatformPresets: () => ipcRenderer.invoke("preset:list-platforms"),
  listRenditionPresets: () => ipcRenderer.invoke("preset:list-renditions"),
  createRenditionPreview: input => ipcRenderer.invoke("rendition-preview:create", input),
  listRenditionPreviews: input => ipcRenderer.invoke("rendition-preview:list", input),
  chooseExportDirectory: projectId => ipcRenderer.invoke("export:choose-directory", projectId),
  createExportBatch: input => ipcRenderer.invoke("export-batch:create", input),
  getExportBatch: batchId => ipcRenderer.invoke("export-batch:get", batchId),
  listExportBatches: input => ipcRenderer.invoke("export-batch:list", input),
  cancelExportBatch: batchId => ipcRenderer.invoke("export-batch:cancel", batchId),
  retryExportBatch: input => ipcRenderer.invoke("export-batch:retry", input),
  createRenditionReframePreview: input => ipcRenderer.invoke("reframe-preview:create", input),
  listRenditionReframePreviews: input => ipcRenderer.invoke("reframe-preview:list", input),
  createReframeExportBatch: input => ipcRenderer.invoke("reframe-export-batch:create", input),
  getReframeExportBatch: batchId => ipcRenderer.invoke("reframe-export-batch:get", batchId),
  listReframeExportBatches: input => ipcRenderer.invoke("reframe-export-batch:list", input),
  cancelReframeExportBatch: batchId => ipcRenderer.invoke("reframe-export-batch:cancel", batchId),
  retryReframeExportBatch: input => ipcRenderer.invoke("reframe-export-batch:retry", input),
  prepareMediaGeneration: input => ipcRenderer.invoke("media-generation:prepare", input),
  createMediaGeneration: input => ipcRenderer.invoke("media-generation:create", input),
  listMediaGenerationRequests: input => ipcRenderer.invoke("media-generation:list", input),
  getMediaGenerationRequest: requestId => ipcRenderer.invoke("media-generation:get", requestId),
  listMediaGenerationTasks: input => ipcRenderer.invoke("media-generation:tasks", input),
  retryMediaGenerationTask: taskId => ipcRenderer.invoke("media-generation:retry", taskId),
  cancelMediaGenerationTask: taskId => ipcRenderer.invoke("media-generation:cancel", taskId),
  listImageProviderConfigs: projectId => ipcRenderer.invoke("provider-image-config:list", { project_id: projectId }),
  createImageProviderConfig: input => ipcRenderer.invoke("provider-image-config:create", input),
  setImageProviderSecret: input => ipcRenderer.invoke("provider-image-config:set-secret", input),
  deleteImageProviderSecret: providerConfigId => ipcRenderer.invoke("provider-image-config:delete-secret", providerConfigId),
  prepareProviderImageGeneration: input => ipcRenderer.invoke("provider-image-generation:prepare", input),
  createProviderImageGeneration: input => ipcRenderer.invoke("provider-image-generation:create", input),
  listProviderImageGenerationRequests: input => ipcRenderer.invoke("provider-image-generation:list", input),
  getProviderImageGenerationRequest: requestId => ipcRenderer.invoke("provider-image-generation:get", requestId),
  listProviderImageGenerationTasks: input => ipcRenderer.invoke("provider-image-generation:tasks", input),
  prepareProviderImageGenerationRetry: input => ipcRenderer.invoke("provider-image-generation:retry-prepare", input),
  retryProviderImageGenerationTask: input => ipcRenderer.invoke("provider-image-generation:retry", input),
  cancelProviderImageGenerationTask: taskId => ipcRenderer.invoke("provider-image-generation:cancel", taskId),
  getShotList: projectId => ipcRenderer.invoke("shot-list:get", projectId),
  listShotListRevisions: input => ipcRenderer.invoke("shot-list:revisions", input),
  getShotListRevision: revisionId => ipcRenderer.invoke("shot-list:revision:get", revisionId),
  createShotListRevision: input => ipcRenderer.invoke("shot-list:revision:create", input),
  confirmShotListRevision: input => ipcRenderer.invoke("shot-list:confirm", input),
  getShotRequirementImageFulfillment: input => ipcRenderer.invoke("shot-requirement-image-fulfillment:get", input),
  listShotRequirementImageFulfillmentLinks: input => ipcRenderer.invoke("shot-requirement-image-fulfillment:list-links", input),
  listShotRequirementImageFulfillmentAdoptions: input => ipcRenderer.invoke("shot-requirement-image-fulfillment:list-adoptions", input),
  prepareShotRequirementImageFulfillment: input => ipcRenderer.invoke("shot-requirement-image-fulfillment:prepare", input),
  createShotRequirementImageFulfillment: input => ipcRenderer.invoke("shot-requirement-image-fulfillment:create", input),
  adoptShotRequirementImageFulfillment: input => ipcRenderer.invoke("shot-requirement-image-fulfillment:adopt", input),
  prepareShotRequirementTimelineAssembly: input => ipcRenderer.invoke("stage5:assembly-prepare", input),
  applyShotRequirementTimelineAssembly: input => ipcRenderer.invoke("stage5:assembly-apply", input),
  getShotRequirementTimelineAssemblyPreview: input => ipcRenderer.invoke("stage5:assembly-preview-get", input),
  getShotRequirementTimelineAssembly: input => ipcRenderer.invoke("stage5:assembly-get", input),
  listShotRequirementTimelineAssemblies: input => ipcRenderer.invoke("stage5:assembly-list", input),
  prepareShotRequirementTimelineBatchAssembly: input => ipcRenderer.invoke("stage6r:batch-assembly-prepare", input),
  applyShotRequirementTimelineBatchAssembly: input => ipcRenderer.invoke("stage6r:batch-assembly-apply", input),
  getShotRequirementTimelineBatchAssemblyPreview: input => ipcRenderer.invoke("stage6r:batch-assembly-preview-get", input),
  getShotRequirementTimelineBatchAssembly: input => ipcRenderer.invoke("stage6r:batch-assembly-get", input),
  listShotRequirementTimelineBatches: input => ipcRenderer.invoke("stage6r:batch-assembly-list", input),
  listShotRequirementTimelineBatchAssemblyItems: input => ipcRenderer.invoke("stage6r:batch-assembly-item-list", input),
  getRenderArtifact: artifactId => ipcRenderer.invoke("render-artifact:get", artifactId),
  getPreviewIr: input => ipcRenderer.invoke("preview-ir:get", input),
  getPreviewIrV2Manifest: input => ipcRenderer.invoke("preview-ir-v2:manifest", input),
  getPreviewIrV2Window: input => ipcRenderer.invoke("preview-ir-v2:window", input),
  lookupDerivedMedia: input => ipcRenderer.invoke("derived-media:lookup", input),
  derivedMediaStats: projectId => ipcRenderer.invoke("derived-media:stats", { project_id: projectId }),
  derivedMediaUrl: input => ipcRenderer.invoke("derived-media:media", input),
  getPreviewSource: input => ipcRenderer.invoke("preview-source:get", input),
  createPreviewSourceJob: input => ipcRenderer.invoke("preview-source:jobs", input),
  previewSourceMediaUrl: input => ipcRenderer.invoke("preview-source:media", input),
  getWaveform: input => ipcRenderer.invoke("waveform:get", input),
  waveformMediaUrl: input => ipcRenderer.invoke("waveform:media", input),
  ensurePcmChunk: input => ipcRenderer.invoke("pcm-chunk:ensure", input),
  pcmChunkMediaUrl: input => ipcRenderer.invoke("pcm-chunk:media", input),
  updateEditorLoad: (mode: "playing" | "scrubbing" | "idle") => ipcRenderer.invoke("editor-load:update", mode),
  captionFontUrl: () => ipcRenderer.invoke("media:caption-font-url"),
  openArtifact: artifactId => ipcRenderer.invoke("artifact:open", artifactId),
  openArtifactFolder: artifactId => ipcRenderer.invoke("artifact:folder", artifactId),
  subscribeJob: (jobId, listener) => {
    const channel = `job:event:${jobId}`;
    const handler = (_event: Electron.IpcRendererEvent, job: Job) => listener(job);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  diagnostics: () => ipcRenderer.invoke("diagnostics:get")
};

contextBridge.exposeInMainWorld("desktop", api);
