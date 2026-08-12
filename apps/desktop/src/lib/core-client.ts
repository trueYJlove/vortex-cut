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
    if (["path", "uri", "root_dir", "database_path", "admin_token", "ui_token", "token", "installed_path", "install_dir", "source_file"].includes(key)) continue;
    result[key] = removeSensitiveFields(item);
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
  createProject(name: string, root_dir_name?: string): Promise<Project> {
    return this.request<unknown>(`${API_PREFIX}/projects`, { method: "POST", body: JSON.stringify({ name, ...(root_dir_name ? { root_dir_name } : {}) }) }).then(normalizeProject);
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
