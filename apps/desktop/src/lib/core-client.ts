import { parseWorklist, type Worklist } from "@aivideo/contracts";
import {
  API_PREFIX,
  isApiErrorResponse,
  isJobEvent,
  parseAsset,
  parseFileGrant,
  parseModelDetail,
  parseModelSummary,
  parseJob,
  parseProject,
  parseTranscript,
  parseTranscriptSummary,
  parseTimelineRevision,
  parseTimelineState,
  parseTimelineDraft,
  isPage,
  isAuthoritativePreview,
  isExportRecord,
  parseRenderArtifact,
  parsePreviewCreateResponse,
  parseExportCreateResponse,
  type ApiError,
  type Asset,
  type AssetAvailability,
  type AssetKind,
  type Artifact,
  type ArtifactId,
  type FileGrant,
  type GrantId,
  type Job,
  type JobId,
  type JobKind,
  type JobPage,
  type ModelDetail,
  type ModelDownloadPage,
  type ModelDownloadResponse,
  type ModelDownloadStatusResponse,
  type ModelId,
  type ModelSummary,
  type MediaInfo,
  type Project,
  type ProjectId,
  type ProjectPage,
  type ProjectStatus,
  type AssetPage,
  type Transcript,
  type TranscriptionCreateInput,
  type TranscriptPage,
  type TranscriptionCreateResponse
  , type TimelineCreateInput
  , type TimelineDraft
  , type TimelineDraftInput
  , type TimelinePatch
  , type TimelineRevision
  , type TimelineRevisionId
  , type TimelineRevisionPage
  , type TimelineState
  , type AuthoritativePreviewPage
  , type ExportRecordPage
  , type PreviewCreateInput
  , type PreviewCreateResponse
  , type ExportCreateInput
  , type ExportCreateResponse
  , type RenderArtifact
  , type RenderArtifactId
  , parseTimelineDiff
  , parseAgentSessionEgressPreview
  , parseAgentSessionCreateResponse
  , parseAgentSession
  , parseCvAnalysisSummary
  , parseCvSamplesPage
  , parseEditingGrammarTool
  , parseEditingGrammarPrepareResult
  , parseEditingGrammarProposal
  , parseEditingGrammarProposalListItem
  , parseTimelinePatchEgressPreview
  , parseTimelinePatchGeneration
  , parseTimelinePatchGenerationCreateResponse
  , parseTimelinePatchProposal
  , type TimelineDiff
  , type TimelinePatchEgressPreview
  , type TimelinePatchGeneration
  , type TimelinePatchGenerationCreateResponse
  , type TimelinePatchProposal
  , type EditingGrammarTool
  , type EditingGrammarPrepareResult
  , type EditingGrammarProposal
  , type EditingGrammarProposalListItem
  , parseTimelinePatchCapabilityTestResponse
  , type TimelinePatchCapabilityTestResponse
  , isPlatformPreset, isRenditionPreset, isRenditionPreview, isExportBatch
  , isRenditionReframePreview, isReframeExportBatch
  , parseRenditionPreviewCreateResponse, parseExportBatchCreateResponse, parseExportBatchRetryResponse
  , parseRenditionReframePreviewCreateResponse, parseReframeExportBatch, parseReframeExportBatchCreateResponse, parseReframeExportBatchRetryResponse
  , type PlatformPreset, type RenditionPreset, type RenditionPreviewPage, type RenditionPreviewCreateInput, type RenditionPreviewCreateResponse
  , type ExportBatch, type ExportBatchPage, type ExportBatchCreateInput, type ExportBatchCreateResponse, type ExportBatchRetryInput, type ExportBatchRetryResponse
  , type RenditionReframePreviewPage, type RenditionReframePreviewCreateInput, type RenditionReframePreviewCreateResponse
  , type ReframeExportBatch, type ReframeExportBatchPage, type ReframeExportBatchCreateInput, type ReframeExportBatchCreateResponse, type ReframeExportBatchRetryInput, type ReframeExportBatchRetryResponse
  , parseMediaGenerationPreparedRequest, parseMediaGenerationCreateResponse, parseMediaGenerationRequest
  , parseMediaGenerationRequestPage, parseMediaGenerationTaskPage, parseMediaGenerationTask
  , type MediaGenerationPrepareInput, type MediaGenerationCreateInput, type MediaGenerationPreparedRequest
  , type MediaGenerationCreateResponse, type MediaGenerationRequest, type MediaGenerationRequestPage
  , type MediaGenerationRequestId, type MediaGenerationTask, type MediaGenerationTaskId, type MediaGenerationTaskPage
  , parseShotListState, parseShotListRevisionPage, parseShotListRevisionDetail
  , parseShotListRevisionCreateInput, parseShotListRevisionCreateResponse, parseShotListConfirmInput, parseShotListConfirmResponse
  , type ShotListState, type ShotListRevisionPage, type ShotListRevisionDetail
  , type ShotListRevisionCreateInput, type ShotListRevisionCreateResponse, type ShotListConfirmInput, type ShotListConfirmResponse
  , type ShotListRevisionId
  , parseImageProviderConfigPage, parseImageProviderConfigSummary
  , parseProviderImageGenerationPreparedPreview, parseProviderImageGenerationCreateResponse
  , parseProviderImageGenerationRequest, parseProviderImageGenerationRequestPage, parseProviderImageGenerationTaskPage, parseProviderImageGenerationTask
  , parseProviderImageGenerationRetryPrepareInput
  , type ImageProviderConfigCreateInput, type ImageProviderConfigPage, type ImageProviderConfigSummary
  , type ProviderImageGenerationPrepareInput, type ProviderImageGenerationPreparedPreview
  , type ProviderImageGenerationCreateInput, type ProviderImageGenerationCreateResponse
  , type ProviderImageGenerationRequest, type ProviderImageGenerationRequestPage, type ProviderImageGenerationTaskPage, type ProviderImageGenerationTask
  , type ProviderImageGenerationRetryPrepareInput
  , parseShotRequirementImageFulfillmentPrepareInput
  , parseShotRequirementImageFulfillmentPreparedPreview
  , parseShotRequirementImageFulfillmentCreateInput
  , parseShotRequirementImageFulfillmentCreateResponse
  , parseShotRequirementImageFulfillmentState
  , parseShotRequirementImageGenerationLinkPage
  , parseShotRequirementImageAdoptionPage
  , parseShotRequirementImageAdoptInput
  , parseShotRequirementImageAdoptResponse
  , type ShotRequirementId
  , type ShotRequirementImageFulfillmentPrepareInput
  , type ShotRequirementImageFulfillmentPreparedPreview
  , type ShotRequirementImageFulfillmentCreateInput
  , type ShotRequirementImageFulfillmentCreateResponse
  , type ShotRequirementImageFulfillmentState
  , type ShotRequirementImageGenerationLinkPage
  , type ShotRequirementImageAdoptionPage
  , type ShotRequirementImageAdoptInput
  , type ShotRequirementImageAdoptResponse
  , parseShotRequirementTimelineAssemblyPrepareInput, parseShotRequirementTimelineAssemblyApplyInput
  , parseShotRequirementTimelineAssemblyPreview, parseShotRequirementTimelineAssembly
  , parseShotRequirementTimelineAssemblyApplyResponse, parseShotRequirementTimelineAssemblyPage
  , type ShotRequirementTimelineAssemblyPrepareInput, type ShotRequirementTimelineAssemblyApplyInput
  , type ShotRequirementTimelineAssemblyPreview, type ShotRequirementTimelineAssembly
  , type ShotRequirementTimelineAssemblyApplyResponse, type ShotRequirementTimelineAssemblyPage
  , type AgentSessionEgressPreview, type AgentSessionCreateResponse, type AgentSession
  , type CvAnalysisSummary, type CvSamplesPage
} from "@aivideo/contracts";

export class CoreApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly traceId?: string
  ) {
    super(message);
    this.name = "CoreApiError";
  }
}

function normalizeArtifact(value: Record<string, unknown>, jobId: JobId): Artifact {
  return {
    artifact_id: String(value.artifact_id ?? value.id) as ArtifactId,
    job_id: jobId,
    display_name: typeof value.display_name === "string" ? value.display_name : `${String(value.kind ?? "artifact")}.mp4`,
    size_bytes: Number(value.size_bytes ?? 0),
    sha256: String(value.sha256 ?? ""),
    media_info: value.media_info as MediaInfo
  };
}

function removeSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeSensitiveFields);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (["path", "uri", "root_dir", "database_path", "admin_token", "ui_token", "token", "installed_path", "install_dir", "source_file", "authorization", "api_key", "secret", "prompt", "raw_exception", "raw_response", "sse", "base64", "instruction", "payload", "http_body", "request_body", "system_message", "absolute_path", "transcript", "caption", "stderr", "command", "traceback"].includes(key.toLowerCase())) continue;
    result[key] = removeSensitiveFields(item);
  }
  return result;
}

const STAGE5_EXTRA_SENSITIVE_KEYS = new Set([
  "document", "requirement", "visual_direction", "narration_text",
]);
function removeStage5SensitiveFields(value: unknown): unknown {
  const cleaned = removeSensitiveFields(value);
  if (Array.isArray(cleaned)) return cleaned.map(removeStage5SensitiveFields);
  if (!cleaned || typeof cleaned !== "object") return cleaned;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(cleaned)) {
    if (STAGE5_EXTRA_SENSITIVE_KEYS.has(key.toLowerCase())) continue;
    result[key] = removeStage5SensitiveFields(item);
  }
  return result;
}
function normalizeProject(value: unknown): Project {
  return parseProject(value);
}

function normalizeAsset(value: unknown): Asset {
  return parseAsset(removeSensitiveFields(value));
}

export function normalizeJob(value: unknown): Job {
  const raw = removeSensitiveFields(value) as Record<string, unknown>;
  const jobId = String(raw.job_id ?? raw.id) as JobId;
  const kind = (raw.kind ?? raw.type ?? "proxy") as JobKind;
  const input = (raw.input && typeof raw.input === "object" ? raw.input : {}) as Record<string, unknown>;
  const normalized: Job = {
    ...raw,
    job_id: jobId,
    project_id: raw.project_id == null ? null : String(raw.project_id) as ProjectId,
    asset_id: raw.asset_id == null ? (input.asset_id == null ? null : String(input.asset_id) as Asset["asset_id"]) : String(raw.asset_id) as Asset["asset_id"],
    kind,
    type: kind,
    status: raw.status as Job["status"],
    stage: String(raw.stage ?? "queued"),
    progress: raw.progress == null ? null : Number(raw.progress),
    phase: raw.phase == null ? null : String(raw.phase),
    phase_progress: raw.phase_progress == null ? null : Number(raw.phase_progress),
    attempt: Number(raw.attempt ?? 1),
    model_id: raw.model_id == null ? null : String(raw.model_id) as ModelId,
    model_revision: raw.model_revision == null ? null : String(raw.model_revision),
    input_fingerprint: raw.input_fingerprint == null ? null : String(raw.input_fingerprint),
    input: input as Job["input"],
    error: raw.error == null ? null : raw.error as Job["error"],
    created_at: String(raw.created_at ?? new Date(0).toISOString()),
    updated_at: String(raw.updated_at ?? raw.created_at ?? new Date(0).toISOString()),
    started_at: raw.started_at == null ? null : String(raw.started_at),
    finished_at: raw.finished_at == null ? null : String(raw.finished_at),
    encoder: (raw.encoder ?? raw.encoder_used) as string | null | undefined,
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.map(item => normalizeArtifact(item as Record<string, unknown>, jobId)) : []
  };
  return parseJob(normalized);
}

export interface ListParams {
  limit?: number;
  cursor?: string;
}
export interface ProjectListParams extends ListParams { status?: ProjectStatus; }
export interface AssetListParams extends ListParams { availability?: AssetAvailability; }
export interface JobListParams extends ListParams { status?: Job["status"]; }
export interface ModelListParams extends ListParams { status?: ModelSummary["status"]; }

export interface CoreClientOptions {
  baseUrl: string;
  uiToken: string;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
  pollIntervalMs?: number;
}
export type JobListener = (job: Job) => void;

function query(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const result = search.toString();
  return result ? `?${result}` : "";
}

export class CoreClient {
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: (url: string) => WebSocket;
  private readonly listeners = new Map<JobId, Set<JobListener>>();
  private readonly pollers = new Map<JobId, ReturnType<typeof setInterval>>();

  constructor(private readonly options: CoreClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.webSocketFactory = options.webSocketFactory ?? (url => new WebSocket(url));
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(this.options.baseUrl + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.uiToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers
      }
    });
    let data: unknown = null;
    try { data = await response.json(); } catch { /* empty error responses are handled below */ }
    if (!response.ok) {
      const apiError = isApiErrorResponse(data) ? data.error : undefined;
      throw new CoreApiError(response.status, apiError?.code ?? statusCode(response.status), apiError?.message ?? `Core request failed: ${response.status}`, apiError?.trace_id);
    }
    return data as T;
  }

  listProjects(params: ProjectListParams = {}): Promise<ProjectPage> {
    return this.request<unknown>(`${API_PREFIX}/projects${query(params)}`).then(value => {
      const page = value as ProjectPage;
      return { items: page.items.map(normalizeProject), next_cursor: page.next_cursor ?? null };
    });
  }
  createProject(name: string, root_dir_name?: string, canvas?: { width: number; height: number; fps_num?: number; fps_den?: number }): Promise<Project> {
    return this.request<unknown>(`${API_PREFIX}/projects`, { method: "POST", body: JSON.stringify({ name, ...(root_dir_name ? { root_dir_name } : {}), ...(canvas ? { canvas } : {}) }) }).then(normalizeProject);
  }
  getProject(projectId: ProjectId): Promise<Project> { return this.request<unknown>(`${API_PREFIX}/projects/${projectId}`).then(normalizeProject); }
  renameProject(projectId: ProjectId, name: string): Promise<Project> { return this.request<unknown>(`${API_PREFIX}/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ name }) }).then(normalizeProject); }
  archiveProject(projectId: ProjectId): Promise<Project> { return this.request<unknown>(`${API_PREFIX}/projects/${projectId}/archive`, { method: "POST" }).then(normalizeProject); }
  reopenProject(projectId: ProjectId): Promise<Project> { return this.request<unknown>(`${API_PREFIX}/projects/${projectId}/reopen`, { method: "POST" }).then(normalizeProject); }

  listAssets(projectId: ProjectId, params: AssetListParams = {}): Promise<AssetPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${projectId}/assets${query(params)}`).then(value => {
      const page = value as AssetPage;
      return { items: page.items.map(normalizeAsset), next_cursor: page.next_cursor ?? null };
    });
  }
  importAsset(projectId: ProjectId, grantId: GrantId, kind?: AssetKind): Promise<Asset> {
    return this.request<unknown>(`${API_PREFIX}/projects/${projectId}/assets`, { method: "POST", body: JSON.stringify({ grant_id: grantId, ...(kind ? { kind } : {}) }) }).then(normalizeAsset);
  }
  getAsset(assetId: string): Promise<Asset> { return this.request<unknown>(`${API_PREFIX}/assets/${assetId}`).then(normalizeAsset); }
  refreshAsset(assetId: string): Promise<Asset> { return this.request<unknown>(`${API_PREFIX}/assets/${assetId}/refresh`, { method: "POST" }).then(normalizeAsset); }
  relocateAsset(assetId: string, grantId: GrantId): Promise<Asset> { return this.request<unknown>(`${API_PREFIX}/assets/${assetId}/relocate`, { method: "POST", body: JSON.stringify({ grant_id: grantId }) }).then(normalizeAsset); }

  listJobs(projectId: ProjectId, params: JobListParams = {}): Promise<JobPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${projectId}/jobs${query(params)}`).then(value => {
      const page = value as JobPage;
      return { items: page.items.map(normalizeJob), next_cursor: page.next_cursor ?? null };
    });
  }
  probe(grantId: GrantId): Promise<MediaInfo> { return this.request(`${API_PREFIX}/media/probe`, { method: "POST", body: JSON.stringify({ grant_id: grantId }) }); }
  createJob(mediaId: string, kind: JobKind, options: { encoder_mode?: "auto" | "software"; start_us?: number; duration_us?: number; layout?: "blurred_background" } = {}): Promise<Job> {
    const path = kind === "proxy" ? `${API_PREFIX}/jobs/proxy` : `${API_PREFIX}/jobs/vertical-sample`;
    const body = kind === "proxy"
      ? { media_id: mediaId, encoder_mode: options.encoder_mode ?? "auto" }
      : { media_id: mediaId, encoder_mode: options.encoder_mode ?? "auto", start_us: options.start_us ?? 0, duration_us: options.duration_us ?? 10_000_000, layout: options.layout ?? "blurred_background" };
    return this.request<unknown>(path, { method: "POST", body: JSON.stringify(body) }).then(normalizeJob);
  }
  getJob(jobId: JobId): Promise<Job> { return this.request<unknown>(`${API_PREFIX}/jobs/${jobId}`).then(normalizeJob); }
  cancelJob(jobId: JobId): Promise<Job> { return this.request<unknown>(`${API_PREFIX}/jobs/${jobId}/cancel`, { method: "POST" }).then(normalizeJob); }

  listModels(params: ModelListParams = {}): Promise<ModelDownloadPage> {
    return this.request<unknown>(`${API_PREFIX}/models${query(params)}`).then(value => {
      const page = value as { items: unknown[]; next_cursor?: string | null };
      return { items: page.items.map(item => parseModelSummary(removeSensitiveFields(item))), next_cursor: page.next_cursor ?? null };
    });
  }
  getModel(modelId: ModelId): Promise<ModelDetail> {
    return this.request<unknown>(`${API_PREFIX}/models/${encodeURIComponent(modelId)}`).then(value => parseModelDetail(removeSensitiveFields(value)));
  }
  downloadModel(modelId: ModelId, licenseAcceptance: string | null): Promise<ModelDownloadResponse> {
    return this.request<unknown>(`${API_PREFIX}/models/${encodeURIComponent(modelId)}/download`, {
      method: "POST", body: JSON.stringify({ license_acceptance: licenseAcceptance })
    }).then(value => {
      const result = value as { model: unknown; job: unknown };
      return { model: parseModelDetail(removeSensitiveFields(result.model)), job: normalizeJob(result.job) };
    });
  }
  getModelDownload(modelId: ModelId): Promise<ModelDownloadStatusResponse> {
    return this.request<unknown>(`${API_PREFIX}/models/${encodeURIComponent(modelId)}/download`).then(value => {
      const result = value as { model: unknown; job: unknown | null };
      return { model: parseModelDetail(removeSensitiveFields(result.model)), job: result.job === null ? null : normalizeJob(result.job) };
    });
  }
  cancelModelDownload(modelId: ModelId): Promise<ModelDownloadResponse> {
    return this.request<unknown>(`${API_PREFIX}/models/${encodeURIComponent(modelId)}/cancel`, { method: "POST" }).then(value => {
      const result = value as { model: unknown; job: unknown };
      return { model: parseModelDetail(removeSensitiveFields(result.model)), job: normalizeJob(result.job) };
    });
  }
  createTranscription(assetId: Asset["asset_id"], input: TranscriptionCreateInput): Promise<TranscriptionCreateResponse> {
    return this.request<unknown>(`${API_PREFIX}/assets/${encodeURIComponent(assetId)}/transcription`, {
      method: "POST", body: JSON.stringify(input)
    }).then(value => {
      const result = value as { job: unknown; transcript: unknown | null };
      return { job: normalizeJob(result.job), transcript: result.transcript === null ? null : parseTranscript(removeSensitiveFields(result.transcript)) };
    });
  }
  listTranscripts(assetId: Asset["asset_id"]): Promise<TranscriptPage> {
    return this.request<unknown>(`${API_PREFIX}/assets/${encodeURIComponent(assetId)}/transcription`).then(value => {
      const page = value as { items: unknown[]; next_cursor?: string | null };
      return { items: page.items.map(item => parseTranscriptSummary(removeSensitiveFields(item))), next_cursor: page.next_cursor ?? null };
    });
  }
  getTranscript(transcriptId: string): Promise<Transcript> {
    return this.request<unknown>(`${API_PREFIX}/transcriptions/${encodeURIComponent(transcriptId)}`).then(value => parseTranscript(removeSensitiveFields(value)));
  }

  createTimeline(projectId: ProjectId, input: TimelineCreateInput): Promise<TimelineState> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/timelines`, { method: "POST", body: JSON.stringify(input) }).then(value => parseTimelineState(removeSensitiveFields(value)));
  }
  getTimeline(projectId: ProjectId): Promise<TimelineState> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/timeline`).then(value => parseTimelineState(removeSensitiveFields(value)));
  }
  patchTimeline(projectId: ProjectId, input: TimelinePatch): Promise<TimelineState> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/timeline/patches`, { method: "POST", body: JSON.stringify(input) }).then(value => parseTimelineState(removeSensitiveFields(value)));
  }
  undoTimeline(projectId: ProjectId, baseRevisionId: TimelineRevisionId): Promise<TimelineState> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/timeline/undo`, { method: "POST", body: JSON.stringify({ base_revision_id: baseRevisionId }) }).then(value => parseTimelineState(removeSensitiveFields(value)));
  }
  redoTimeline(projectId: ProjectId, baseRevisionId: TimelineRevisionId): Promise<TimelineState> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/timeline/redo`, { method: "POST", body: JSON.stringify({ base_revision_id: baseRevisionId }) }).then(value => parseTimelineState(removeSensitiveFields(value)));
  }
  saveTimelineDraft(projectId: ProjectId, input: TimelineDraftInput): Promise<TimelineDraft> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/timeline/draft`, { method: "PUT", body: JSON.stringify(input) }).then(value => parseTimelineDraft(removeSensitiveFields(value)));
  }
  async deleteTimelineDraft(projectId: ProjectId): Promise<void> {
    await this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/timeline/draft`, { method: "DELETE" });
  }
  listTimelineRevisions(projectId: ProjectId, params: ListParams = {}): Promise<TimelineRevisionPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/timeline/revisions${query(params)}`).then(value => {
      const page = removeSensitiveFields(value) as TimelineRevisionPage;
      return page;
    });
  }
  getTimelineRevision(revisionId: TimelineRevisionId): Promise<TimelineRevision> {
    return this.request<unknown>(`${API_PREFIX}/timeline-revisions/${encodeURIComponent(revisionId)}`).then(value => parseTimelineRevision(removeSensitiveFields(value)));
  }
  prepareTimelinePatch(projectId: ProjectId, input: { base_revision_id: TimelineRevisionId; provider_config_id: string; instruction: string }): Promise<TimelinePatchEgressPreview> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/timeline-patch-generations/prepare`, { method: "POST", body: JSON.stringify(input) }).then(value => parseTimelinePatchEgressPreview(removeSensitiveFields(value)));
  }
  testTimelinePatchProviderCapability(providerId: string): Promise<TimelinePatchCapabilityTestResponse> {
    return this.request<unknown>(`${API_PREFIX}/providers/${encodeURIComponent(providerId)}/timeline-patch-capability-test`, { method: "POST" }).then(value => parseTimelinePatchCapabilityTestResponse(removeSensitiveFields(value)));
  }
  createTimelinePatchGeneration(projectId: ProjectId, input: { timeline_patch_egress_preview_id: string; payload_sha256: string }): Promise<TimelinePatchGenerationCreateResponse> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/timeline-patch-generations`, { method: "POST", body: JSON.stringify(input) }).then(value => parseTimelinePatchGenerationCreateResponse(removeSensitiveFields(value)));
  }
  getTimelinePatchGeneration(generationId: string): Promise<TimelinePatchGeneration> {
    return this.request<unknown>(`${API_PREFIX}/timeline-patch-generations/${encodeURIComponent(generationId)}`).then(value => parseTimelinePatchGeneration(removeSensitiveFields(value)));
  }
  listTimelinePatchProposals(projectId: ProjectId): Promise<{ items: TimelinePatchProposal[] }> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/timeline-patch-proposals`).then(value => {
      const page = removeSensitiveFields(value) as { items?: unknown[] };
      if (!Array.isArray(page.items)) throw new Error("Invalid TimelinePatchProposalPage");
      return { items: page.items.map(parseTimelinePatchProposal) };
    });
  }
  getTimelinePatchProposal(proposalId: string): Promise<TimelinePatchProposal> {
    return this.request<unknown>(`${API_PREFIX}/timeline-patch-proposals/${encodeURIComponent(proposalId)}`).then(value => parseTimelinePatchProposal(removeSensitiveFields(value)));
  }
  applyTimelinePatchProposal(projectId: ProjectId, proposalId: string, input: { base_revision_id: TimelineRevisionId; proposed_document_sha256: string }): Promise<TimelineState> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/timeline-patch-proposals/${encodeURIComponent(proposalId)}/apply`, { method: "POST", body: JSON.stringify(input) }).then(value => parseTimelineState(removeSensitiveFields(value)));
  }
  // AI-1：内置多步 agent 会话（三段式对齐 timeline-patch-generations 先例）。
  prepareAgentSession(projectId: ProjectId, input: { base_revision_id: TimelineRevisionId; provider_config_id: string; instruction: string }): Promise<AgentSessionEgressPreview> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/agent-sessions/prepare`, { method: "POST", body: JSON.stringify(input) }).then(value => parseAgentSessionEgressPreview(removeSensitiveFields(value)));
  }
  createAgentSession(projectId: ProjectId, input: { agent_session_egress_preview_id: string; payload_sha256: string }): Promise<AgentSessionCreateResponse> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/agent-sessions`, { method: "POST", body: JSON.stringify(input) }).then(value => parseAgentSessionCreateResponse(removeSensitiveFields(value)));
  }
  listAgentSessions(projectId: ProjectId): Promise<{ items: AgentSession[] }> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/agent-sessions`).then(value => {
      const page = removeSensitiveFields(value) as { items?: unknown[] };
      if (!Array.isArray(page.items)) throw new Error("Invalid AgentSessionPage");
      return { items: page.items.map(parseAgentSession) };
    });
  }
  listWorklists(projectId: ProjectId): Promise<{ items: Worklist[] }> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/worklists`).then(value => {
      const page = removeSensitiveFields(value) as { items?: unknown[] };
      if (!Array.isArray(page.items)) throw new Error("Invalid WorklistPage");
      return { items: page.items.map(parseWorklist) };
    });
  }
  getWorklist(projectId: ProjectId, worklistId: string): Promise<Worklist> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/worklists/${encodeURIComponent(worklistId)}`).then(value => parseWorklist(removeSensitiveFields(value)));
  }
  prepareWorklist(projectId: ProjectId, input: { base_revision_id: TimelineRevisionId; steps: Array<{ kind: string; planner: string; params: Record<string, unknown> }>; max_steps: number; token_budget: number }): Promise<Worklist> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/worklists/prepare`, { method: "POST", body: JSON.stringify(input) }).then(value => parseWorklist(removeSensitiveFields(value)));
  }
  createWorklist(projectId: ProjectId, input: { worklist_id: string; base_revision_id: TimelineRevisionId }): Promise<Worklist> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/worklists`, { method: "POST", body: JSON.stringify(input) }).then(value => parseWorklist(removeSensitiveFields(value)));
  }
  cancelWorklist(projectId: ProjectId, worklistId: string): Promise<Worklist> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/worklists/${encodeURIComponent(worklistId)}/cancel`, { method: "POST" }).then(value => parseWorklist(removeSensitiveFields(value)));
  }
  applyWorklistStep(projectId: ProjectId, worklistId: string, stepId: string, input: { base_revision_id: TimelineRevisionId; proposed_document_sha256: string }): Promise<Worklist> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/worklists/${encodeURIComponent(worklistId)}/steps/${encodeURIComponent(stepId)}/apply`, { method: "POST", body: JSON.stringify(input) }).then(value => parseWorklist(removeSensitiveFields(value)));
  }
  getAgentSession(sessionId: string): Promise<AgentSession> {
    return this.request<unknown>(`${API_PREFIX}/agent-sessions/${encodeURIComponent(sessionId)}`).then(value => parseAgentSession(removeSensitiveFields(value)));
  }
  // AI-2：素材 CV 信号分析（generate=True 登记作业；仅 video 素材）。
  getCvAnalysis(projectId: ProjectId, assetId: string, input: { generate: boolean; target_gap_us?: number | null; budget_per_minute_s?: number | null }): Promise<CvAnalysisSummary> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/cv-analysis`, { method: "POST", body: JSON.stringify(input) }).then(value => parseCvAnalysisSummary(removeSensitiveFields(value)));
  }
  // 阶段 C 稳定性包：CV 信号样本（sparkline 可视化数据）。
  listCvSamples(projectId: ProjectId, assetId: string): Promise<CvSamplesPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/cv-samples`).then(value => parseCvSamplesPage(removeSensitiveFields(value)));
  }
  // W1.1 剪辑语法层（零 egress）。
  listEditingGrammarPlanners(projectId: ProjectId): Promise<{ items: EditingGrammarTool[] }> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/editing-grammar/planners`).then(value => {
      const page = removeSensitiveFields(value) as { items?: unknown[] };
      if (!Array.isArray(page.items)) throw new Error("Invalid EditingGrammarToolPage");
      return { items: page.items.map(parseEditingGrammarTool) };
    });
  }
  prepareEditingGrammar(projectId: ProjectId, input: { base_revision_id: TimelineRevisionId; planner: string; params: Record<string, unknown> }): Promise<EditingGrammarPrepareResult> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/editing-grammar/prepare`, { method: "POST", body: JSON.stringify(input) }).then(value => parseEditingGrammarPrepareResult(removeSensitiveFields(value)));
  }
  proposeEditingGrammar(projectId: ProjectId, input: { base_revision_id: TimelineRevisionId; planner: string; params: Record<string, unknown> }): Promise<EditingGrammarProposal> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/editing-grammar/proposals`, { method: "POST", body: JSON.stringify(input) }).then(value => parseEditingGrammarProposal(removeSensitiveFields(value)));
  }
  listEditingGrammarProposals(projectId: ProjectId): Promise<{ items: EditingGrammarProposalListItem[] }> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/editing-grammar/proposals`).then(value => {
      const page = removeSensitiveFields(value) as { items?: unknown[] };
      if (!Array.isArray(page.items)) throw new Error("Invalid EditingGrammarProposalPage");
      return { items: page.items.map(parseEditingGrammarProposalListItem) };
    });
  }
  getEditingGrammarProposal(projectId: ProjectId, proposalId: string): Promise<EditingGrammarProposal> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/editing-grammar/proposals/${encodeURIComponent(proposalId)}`).then(value => parseEditingGrammarProposal(removeSensitiveFields(value)));
  }
  applyEditingGrammarProposal(projectId: ProjectId, proposalId: string, input: { base_revision_id: TimelineRevisionId; proposed_document_sha256: string }): Promise<TimelineState> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/editing-grammar/proposals/${encodeURIComponent(proposalId)}/apply`, { method: "POST", body: JSON.stringify(input) }).then(value => parseTimelineState(removeSensitiveFields(value)));
  }
  compareTimelineRevisions(projectId: ProjectId, input: { base_revision_id: TimelineRevisionId; target_revision_id: TimelineRevisionId }): Promise<TimelineDiff> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/timeline/revision-diffs`, { method: "POST", body: JSON.stringify(input) }).then(value => parseTimelineDiff(removeSensitiveFields(value)));
  }
  createPreview(projectId: ProjectId, input: PreviewCreateInput): Promise<PreviewCreateResponse> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/previews`, { method: "POST", body: JSON.stringify(input) }).then(value => parsePreviewCreateResponse(removeSensitiveFields(value)));
  }
  listPreviews(projectId: ProjectId, params: ListParams = {}): Promise<AuthoritativePreviewPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/previews${query(params)}`).then(value => {
      const cleaned = removeSensitiveFields(value);
      if (!isPage(cleaned, isAuthoritativePreview)) throw new Error("Invalid AuthoritativePreviewPage");
      return cleaned;
    });
  }
  createExport(projectId: ProjectId, input: ExportCreateInput): Promise<ExportCreateResponse> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/exports`, { method: "POST", body: JSON.stringify(input) }).then(value => parseExportCreateResponse(removeSensitiveFields(value)));
  }
  listExports(projectId: ProjectId, params: ListParams = {}): Promise<ExportRecordPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/exports${query(params)}`).then(value => {
      const cleaned = removeSensitiveFields(value);
      if (!isPage(cleaned, isExportRecord)) throw new Error("Invalid ExportRecordPage");
      return cleaned;
    });
  }
  getRenderArtifact(artifactId: RenderArtifactId): Promise<RenderArtifact> {
    return this.request<unknown>(`${API_PREFIX}/render-artifacts/${encodeURIComponent(artifactId)}`).then(value => parseRenderArtifact(removeSensitiveFields(value)));
  }
  listPlatformPresets(): Promise<{ items: PlatformPreset[] }> {
    return this.request<unknown>(`${API_PREFIX}/platform-presets`).then(value => {
      const cleaned = removeSensitiveFields(value) as { items?: unknown[] };
      if (!Array.isArray(cleaned.items) || !cleaned.items.every(isPlatformPreset)) throw new Error("Invalid PlatformPresetPage");
      return { items: cleaned.items };
    });
  }
  listRenditionPresets(): Promise<{ items: RenditionPreset[] }> {
    return this.request<unknown>(`${API_PREFIX}/rendition-presets`).then(value => {
      const cleaned = removeSensitiveFields(value) as { items?: unknown[] };
      if (!Array.isArray(cleaned.items) || !cleaned.items.every(isRenditionPreset)) throw new Error("Invalid RenditionPresetPage");
      return { items: cleaned.items };
    });
  }
  createRenditionPreview(projectId: ProjectId, input: RenditionPreviewCreateInput): Promise<RenditionPreviewCreateResponse> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/rendition-previews`, { method: "POST", body: JSON.stringify(input) }).then(value => parseRenditionPreviewCreateResponse(removeSensitiveFields(value)));
  }
  listRenditionPreviews(projectId: ProjectId, params: ListParams = {}): Promise<RenditionPreviewPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/rendition-previews${query(params)}`).then(value => {
      const cleaned = removeSensitiveFields(value);
      if (!isPage(cleaned, isRenditionPreview)) throw new Error("Invalid RenditionPreviewPage");
      return cleaned;
    });
  }
  createExportBatch(projectId: ProjectId, input: ExportBatchCreateInput): Promise<ExportBatchCreateResponse> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/export-batches`, { method: "POST", body: JSON.stringify(input) }).then(value => parseExportBatchCreateResponse(removeSensitiveFields(value)));
  }
  getExportBatch(batchId: string): Promise<ExportBatch> { return this.request<unknown>(`${API_PREFIX}/export-batches/${encodeURIComponent(batchId)}`).then(value => isExportBatch(removeSensitiveFields(value)) ? removeSensitiveFields(value) as ExportBatch : Promise.reject(new Error("Invalid ExportBatch"))); }
  listExportBatches(projectId: ProjectId, params: ListParams = {}): Promise<ExportBatchPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/export-batches${query(params)}`).then(value => { const cleaned = removeSensitiveFields(value); if (!isPage(cleaned, isExportBatch)) throw new Error("Invalid ExportBatchPage"); return cleaned; });
  }
  cancelExportBatch(batchId: string): Promise<ExportBatch> { return this.request<unknown>(`${API_PREFIX}/export-batches/${encodeURIComponent(batchId)}/cancel`, { method: "POST" }).then(value => isExportBatch(removeSensitiveFields(value)) ? removeSensitiveFields(value) as ExportBatch : Promise.reject(new Error("Invalid ExportBatch"))); }
  retryExportBatch(batchId: string, input: ExportBatchRetryInput): Promise<ExportBatchRetryResponse> { return this.request<unknown>(`${API_PREFIX}/export-batches/${encodeURIComponent(batchId)}/retry`, { method: "POST", body: JSON.stringify(input) }).then(value => parseExportBatchRetryResponse(removeSensitiveFields(value))); }

  createRenditionReframePreview(projectId: ProjectId, input: RenditionReframePreviewCreateInput): Promise<RenditionReframePreviewCreateResponse> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/rendition-reframe-previews`, { method: "POST", body: JSON.stringify(input) }).then(value => parseRenditionReframePreviewCreateResponse(removeSensitiveFields(value)));
  }
  listRenditionReframePreviews(projectId: ProjectId, params: ListParams = {}): Promise<RenditionReframePreviewPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/rendition-reframe-previews${query(params)}`).then(value => {
      const cleaned = removeSensitiveFields(value);
      if (!isPage(cleaned, isRenditionReframePreview)) throw new Error("Invalid RenditionReframePreviewPage");
      return cleaned;
    });
  }
  createReframeExportBatch(projectId: ProjectId, input: ReframeExportBatchCreateInput): Promise<ReframeExportBatchCreateResponse> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/reframe-export-batches`, { method: "POST", body: JSON.stringify(input) }).then(value => parseReframeExportBatchCreateResponse(removeSensitiveFields(value)));
  }
  getReframeExportBatch(batchId: string): Promise<ReframeExportBatch> {
    return this.request<unknown>(`${API_PREFIX}/reframe-export-batches/${encodeURIComponent(batchId)}`).then(value => parseReframeExportBatch(removeSensitiveFields(value)));
  }
  listReframeExportBatches(projectId: ProjectId, params: ListParams = {}): Promise<ReframeExportBatchPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/reframe-export-batches${query(params)}`).then(value => {
      const cleaned = removeSensitiveFields(value);
      if (!isPage(cleaned, isReframeExportBatch)) throw new Error("Invalid ReframeExportBatchPage");
      return cleaned;
    });
  }
  cancelReframeExportBatch(batchId: string): Promise<ReframeExportBatch> {
    return this.request<unknown>(`${API_PREFIX}/reframe-export-batches/${encodeURIComponent(batchId)}/cancel`, { method: "POST" }).then(value => parseReframeExportBatch(removeSensitiveFields(value)));
  }
  retryReframeExportBatch(batchId: string, input: ReframeExportBatchRetryInput): Promise<ReframeExportBatchRetryResponse> {
    return this.request<unknown>(`${API_PREFIX}/reframe-export-batches/${encodeURIComponent(batchId)}/retry`, { method: "POST", body: JSON.stringify(input) }).then(value => parseReframeExportBatchRetryResponse(removeSensitiveFields(value)));
  }

  prepareMediaGeneration(projectId: ProjectId, input: MediaGenerationPrepareInput): Promise<MediaGenerationPreparedRequest> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/media-generation-requests/prepare`, { method: "POST", body: JSON.stringify(input) })
      .then(value => parseMediaGenerationPreparedRequest(removeSensitiveFields(value)));
  }
  createMediaGeneration(projectId: ProjectId, input: MediaGenerationCreateInput): Promise<MediaGenerationCreateResponse> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/media-generation-requests`, { method: "POST", body: JSON.stringify(input) })
      .then(value => parseMediaGenerationCreateResponse(removeSensitiveFields(value)));
  }
  listMediaGenerationRequests(projectId: ProjectId, params: ListParams = {}): Promise<MediaGenerationRequestPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/media-generation-requests${query(params)}`)
      .then(value => parseMediaGenerationRequestPage(removeSensitiveFields(value)));
  }
  getMediaGenerationRequest(requestId: MediaGenerationRequestId): Promise<MediaGenerationRequest> {
    return this.request<unknown>(`${API_PREFIX}/media-generation-requests/${encodeURIComponent(requestId)}`)
      .then(value => parseMediaGenerationRequest(removeSensitiveFields(value)));
  }
  listMediaGenerationTasks(requestId: MediaGenerationRequestId, params: ListParams = {}): Promise<MediaGenerationTaskPage> {
    return this.request<unknown>(`${API_PREFIX}/media-generation-requests/${encodeURIComponent(requestId)}/tasks${query(params)}`)
      .then(value => parseMediaGenerationTaskPage(removeSensitiveFields(value)));
  }
  retryMediaGenerationTask(taskId: MediaGenerationTaskId): Promise<MediaGenerationTask> {
    return this.request<unknown>(`${API_PREFIX}/media-generation-tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST", body: JSON.stringify({}) })
      .then(value => parseMediaGenerationTask(removeSensitiveFields(value)));
  }
  cancelMediaGenerationTask(taskId: MediaGenerationTaskId): Promise<MediaGenerationTask> {
    return this.request<unknown>(`${API_PREFIX}/media-generation-tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: JSON.stringify({}) })
      .then(value => parseMediaGenerationTask(removeSensitiveFields(value)));
  }

  listImageProviderConfigs(projectId: ProjectId): Promise<ImageProviderConfigPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/image-provider-configs`)
      .then(value => parseImageProviderConfigPage(removeSensitiveFields(value)));
  }
  createImageProviderConfig(projectId: ProjectId, input: ImageProviderConfigCreateInput): Promise<ImageProviderConfigSummary> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/image-provider-configs`, { method: "POST", body: JSON.stringify(input) })
      .then(value => parseImageProviderConfigSummary(removeSensitiveFields(value)));
  }
  prepareProviderImageGeneration(projectId: ProjectId, input: ProviderImageGenerationPrepareInput): Promise<ProviderImageGenerationPreparedPreview> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/provider-image-generations/prepare`, { method: "POST", body: JSON.stringify(input) })
      .then(value => parseProviderImageGenerationPreparedPreview(removeSensitiveFields(value)));
  }
  createProviderImageGeneration(projectId: ProjectId, input: ProviderImageGenerationCreateInput): Promise<ProviderImageGenerationCreateResponse> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/provider-image-generations`, { method: "POST", body: JSON.stringify(input) })
      .then(value => parseProviderImageGenerationCreateResponse(removeSensitiveFields(value)));
  }
  listProviderImageGenerationRequests(projectId: ProjectId, params: ListParams = {}): Promise<ProviderImageGenerationRequestPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/provider-image-generations${query(params)}`)
      .then(value => parseProviderImageGenerationRequestPage(removeSensitiveFields(value)));
  }
  getProviderImageGenerationRequest(requestId: string): Promise<ProviderImageGenerationRequest> {
    return this.request<unknown>(`${API_PREFIX}/provider-image-generations/${encodeURIComponent(requestId)}`)
      .then(value => parseProviderImageGenerationRequest(removeSensitiveFields(value)));
  }
  listProviderImageGenerationTasks(requestId: string, params: ListParams = {}): Promise<ProviderImageGenerationTaskPage> {
    return this.request<unknown>(`${API_PREFIX}/provider-image-generations/${encodeURIComponent(requestId)}/tasks${query(params)}`)
      .then(value => parseProviderImageGenerationTaskPage(removeSensitiveFields(value)));
  }
  prepareProviderImageGenerationRetry(taskId: string, input: ProviderImageGenerationRetryPrepareInput): Promise<ProviderImageGenerationPreparedPreview> {
    const request = parseProviderImageGenerationRetryPrepareInput(input);
    return this.request<unknown>(`${API_PREFIX}/provider-image-generation-tasks/${encodeURIComponent(taskId)}/retry/prepare`, { method: "POST", body: JSON.stringify(request) })
      .then(value => parseProviderImageGenerationPreparedPreview(removeSensitiveFields(value)));
  }
  retryProviderImageGenerationTask(taskId: string, input: ProviderImageGenerationCreateInput): Promise<ProviderImageGenerationTask> {
    return this.request<unknown>(`${API_PREFIX}/provider-image-generation-tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST", body: JSON.stringify(input) })
      .then(value => parseProviderImageGenerationTask(removeSensitiveFields(value)));
  }
  cancelProviderImageGenerationTask(taskId: string): Promise<ProviderImageGenerationTask> {
    return this.request<unknown>(`${API_PREFIX}/provider-image-generation-tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: JSON.stringify({}) })
      .then(value => parseProviderImageGenerationTask(removeSensitiveFields(value)));
  }
  getShotList(projectId: ProjectId): Promise<ShotListState> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/shot-list`)
      .then(value => parseShotListState(removeSensitiveFields(value)));
  }
  listShotListRevisions(projectId: ProjectId, params: ListParams = {}): Promise<ShotListRevisionPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/shot-list/revisions${query(params)}`)
      .then(value => parseShotListRevisionPage(removeSensitiveFields(value)));
  }
  getShotListRevision(revisionId: ShotListRevisionId): Promise<ShotListRevisionDetail> {
    return this.request<unknown>(`${API_PREFIX}/shot-list-revisions/${encodeURIComponent(revisionId)}`)
      .then(value => parseShotListRevisionDetail(removeSensitiveFields(value)));
  }
  createShotListRevision(projectId: ProjectId, input: ShotListRevisionCreateInput): Promise<ShotListRevisionCreateResponse> {
    const request = parseShotListRevisionCreateInput(input);
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/shot-list/revisions`, { method: "POST", body: JSON.stringify(request) })
      .then(value => parseShotListRevisionCreateResponse(removeSensitiveFields(value)));
  }
  confirmShotListRevision(projectId: ProjectId, input: ShotListConfirmInput): Promise<ShotListConfirmResponse> {
    const request = parseShotListConfirmInput(input);
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/shot-list/confirm`, { method: "POST", body: JSON.stringify(request) })
      .then(value => parseShotListConfirmResponse(removeSensitiveFields(value)));
  }

  getShotRequirementImageFulfillment(projectId: ProjectId, requirementId: ShotRequirementId): Promise<ShotRequirementImageFulfillmentState> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/shot-requirements/${encodeURIComponent(requirementId)}/image-fulfillment`)
      .then(value => parseShotRequirementImageFulfillmentState(removeSensitiveFields(value)));
  }
  listShotRequirementImageFulfillmentLinks(projectId: ProjectId, requirementId: ShotRequirementId, params: ListParams = {}): Promise<ShotRequirementImageGenerationLinkPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/shot-requirements/${encodeURIComponent(requirementId)}/image-fulfillment/links${query(params)}`)
      .then(value => parseShotRequirementImageGenerationLinkPage(removeSensitiveFields(value)));
  }
  listShotRequirementImageFulfillmentAdoptions(projectId: ProjectId, requirementId: ShotRequirementId, params: ListParams = {}): Promise<ShotRequirementImageAdoptionPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/shot-requirements/${encodeURIComponent(requirementId)}/image-fulfillment/adoptions${query(params)}`)
      .then(value => parseShotRequirementImageAdoptionPage(removeSensitiveFields(value)));
  }
  prepareShotRequirementImageFulfillment(projectId: ProjectId, requirementId: ShotRequirementId, input: ShotRequirementImageFulfillmentPrepareInput): Promise<ShotRequirementImageFulfillmentPreparedPreview> {
    const request = parseShotRequirementImageFulfillmentPrepareInput(input);
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/shot-requirements/${encodeURIComponent(requirementId)}/image-fulfillment/prepare`, { method: "POST", body: JSON.stringify(request) })
      .then(value => parseShotRequirementImageFulfillmentPreparedPreview(removeSensitiveFields(value)));
  }
  createShotRequirementImageFulfillment(projectId: ProjectId, requirementId: ShotRequirementId, input: ShotRequirementImageFulfillmentCreateInput): Promise<ShotRequirementImageFulfillmentCreateResponse> {
    const request = parseShotRequirementImageFulfillmentCreateInput(input);
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/shot-requirements/${encodeURIComponent(requirementId)}/image-fulfillment/create`, { method: "POST", body: JSON.stringify(request) })
      .then(value => parseShotRequirementImageFulfillmentCreateResponse(removeSensitiveFields(value)));
  }
  adoptShotRequirementImageFulfillment(projectId: ProjectId, requirementId: ShotRequirementId, input: ShotRequirementImageAdoptInput): Promise<ShotRequirementImageAdoptResponse> {
    const request = parseShotRequirementImageAdoptInput(input);
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/shot-requirements/${encodeURIComponent(requirementId)}/image-fulfillment/adopt`, { method: "POST", body: JSON.stringify(request) })
      .then(value => parseShotRequirementImageAdoptResponse(removeSensitiveFields(value)));
  }

  prepareShotRequirementTimelineAssembly(projectId: ProjectId, requirementId: ShotRequirementId, input: ShotRequirementTimelineAssemblyPrepareInput): Promise<ShotRequirementTimelineAssemblyPreview> {
    const request = parseShotRequirementTimelineAssemblyPrepareInput(input);
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/shot-requirements/${encodeURIComponent(requirementId)}/timeline-assemblies/prepare`, { method: "POST", body: JSON.stringify(request) })
      .then(value => parseShotRequirementTimelineAssemblyPreview(removeStage5SensitiveFields(value)));
  }
  applyShotRequirementTimelineAssembly(projectId: ProjectId, requirementId: ShotRequirementId, input: ShotRequirementTimelineAssemblyApplyInput): Promise<ShotRequirementTimelineAssemblyApplyResponse> {
    const request = parseShotRequirementTimelineAssemblyApplyInput(input);
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/shot-requirements/${encodeURIComponent(requirementId)}/timeline-assemblies`, { method: "POST", body: JSON.stringify(request) })
      .then(value => parseShotRequirementTimelineAssemblyApplyResponse(removeStage5SensitiveFields(value)));
  }
  getShotRequirementTimelineAssemblyPreview(previewId: string): Promise<ShotRequirementTimelineAssemblyPreview> {
    return this.request<unknown>(`${API_PREFIX}/shot-requirement-timeline-assembly-previews/${encodeURIComponent(previewId)}`)
      .then(value => parseShotRequirementTimelineAssemblyPreview(removeStage5SensitiveFields(value)));
  }
  getShotRequirementTimelineAssembly(assemblyId: string): Promise<ShotRequirementTimelineAssembly> {
    return this.request<unknown>(`${API_PREFIX}/shot-requirement-timeline-assemblies/${encodeURIComponent(assemblyId)}`)
      .then(value => parseShotRequirementTimelineAssembly(removeStage5SensitiveFields(value)));
  }
  listShotRequirementTimelineAssemblies(projectId: ProjectId, requirementId: ShotRequirementId, params: ListParams = {}): Promise<ShotRequirementTimelineAssemblyPage> {
    return this.request<unknown>(`${API_PREFIX}/projects/${encodeURIComponent(projectId)}/shot-requirements/${encodeURIComponent(requirementId)}/timeline-assemblies${query(params)}`)
      .then(value => parseShotRequirementTimelineAssemblyPage(removeStage5SensitiveFields(value)));
  }
  subscribe(jobId: JobId, listener: JobListener): () => void {
    let set = this.listeners.get(jobId);
    if (!set) { set = new Set(); this.listeners.set(jobId, set); }
    set.add(listener);
    const ws = this.webSocketFactory(this.options.baseUrl.replace(/^http/, "ws") + `${API_PREFIX}/events`);
    let authenticated = false;
    const poll = () => {
      if (this.pollers.has(jobId)) return;
      const interval = setInterval(() => { void this.getJob(jobId).then(job => this.emit(jobId, job)).catch(() => undefined); }, this.options.pollIntervalMs ?? 1000);
      this.pollers.set(jobId, interval);
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "authenticate", token: this.options.uiToken }));
    ws.onmessage = event => {
      try {
        const message: unknown = JSON.parse(String(event.data));
        if (isRecordEvent(message) && message.type === "authenticated") { authenticated = true; return; }
        if (isJobEvent(message) && (message.job?.job_id === jobId || message.payload?.job_id === jobId)) void this.getJob(jobId).then(job => this.emit(jobId, job)).catch(() => undefined);
      } catch { /* polling remains the source of truth after malformed frames */ }
    };
    ws.onerror = poll;
    ws.onclose = () => { if (!authenticated) poll(); };
    return () => {
      set?.delete(listener);
      if (set?.size === 0) {
        this.listeners.delete(jobId);
        const interval = this.pollers.get(jobId);
        if (interval) clearInterval(interval);
        this.pollers.delete(jobId);
      }
      ws.close();
    };
  }
  private emit(jobId: JobId, job: Job): void { for (const listener of this.listeners.get(jobId) ?? []) listener(job); }
}

function isRecordEvent(value: unknown): value is { type: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}
function statusCode(status: number): string {
  if (status === 400) return "VALIDATION_ERROR";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  return "INTERNAL_ERROR";
}

export function normalizeFileGrant(value: unknown): FileGrant { return parseFileGrant(value); }
export function createDesktopCoreClient(runtime: { base_url: string; ui_token: string }): CoreClient { return new CoreClient({ baseUrl: runtime.base_url, uiToken: runtime.ui_token }); }
