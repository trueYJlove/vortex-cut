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
} from "@aivideo/contracts";

export interface MediaSelection { grant: FileGrant; media: MediaInfo }
export interface DesktopRuntime { protocol_version: 1; status: "ready" }
export interface AuthoritativePreviewPresentation { preview: AuthoritativePreview; media_url: string }
export interface ExportRecordPresentation { export_record: ExportRecord; media_url: string }
export interface RenderArtifactPresentation { artifact: RenderArtifact; media_url: string }
export interface RenditionPreviewPresentation { preview: RenditionPreview; media_url: string }
export interface RenditionReframePreviewPresentation { preview: RenditionReframePreview; media_url: string }

export interface DesktopApi {
  getRuntime: () => Promise<DesktopRuntime>;
  chooseMedia: () => Promise<MediaSelection | null>;
  probeMedia: (grantId: GrantId) => Promise<MediaInfo>;
  listProjects: (params?: { status?: ProjectStatus; limit?: number; cursor?: string }) => Promise<ProjectPage>;
  createProject: (input: { name: string; root_dir_name?: string }) => Promise<Project>;
  getProject: (projectId: ProjectId) => Promise<Project>;
  renameProject: (input: { project_id: ProjectId; name: string }) => Promise<Project>;
  archiveProject: (projectId: ProjectId) => Promise<Project>;
  reopenProject: (projectId: ProjectId) => Promise<Project>;
  listAssets: (input: { project_id: ProjectId; availability?: AssetAvailability; limit?: number; cursor?: string }) => Promise<AssetPresentationPage>;
  importAsset: (input: { project_id: ProjectId; kind?: AssetKind }) => Promise<ImportedAsset | null>;
  refreshAsset: (assetId: string) => Promise<AssetPresentation>;
  relocateAsset: (input: { asset_id: string }) => Promise<ImportedAsset | null>;
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
  createPreview: (input: { project_id: ProjectId; preview: { timeline_revision_id?: TimelineRevisionId; encoder_mode?: EncoderMode } }) => Promise<{ job: Job | null; preview: AuthoritativePreviewPresentation | null; reused: boolean }>;
  listPreviews: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<{ items: AuthoritativePreviewPresentation[]; next_cursor: string | null }>;
  chooseExportDestination: (projectId: ProjectId) => Promise<DestinationGrant | null>;
  createExport: (input: { project_id: ProjectId; export: { timeline_revision_id?: TimelineRevisionId; destination_grant_id: DestinationGrant["destination_grant_id"]; encoder_mode?: EncoderMode } }) => Promise<{ job: Job; export_record: ExportRecordPresentation | null }>;
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
  getRenderArtifact: (artifactId: RenderArtifactId) => Promise<RenderArtifactPresentation>;
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
  getRenderArtifact: artifactId => ipcRenderer.invoke("render-artifact:get", artifactId),
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
