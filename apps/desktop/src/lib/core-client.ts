import type { Artifact, ArtifactId, GrantId, Job, JobId, JobKind, MediaInfo } from "@aivideo/contracts";

function normalizeArtifact(value: Record<string, unknown>, jobId: JobId): Artifact {
  return {
    artifact_id: (value.artifact_id ?? value.id) as ArtifactId,
    job_id: jobId,
    display_name: typeof value.display_name === "string" ? value.display_name : typeof value.kind === "string" ? value.kind + ".mp4" : "artifact.mp4",
    size_bytes: Number(value.size_bytes ?? 0),
    sha256: String(value.sha256 ?? ""),
    media_info: value.media_info as MediaInfo
  };
}

function normalizeJob(value: unknown): Job {
  const raw = value as Record<string, unknown>;
  const jobId = String(raw.job_id ?? raw.id) as JobId;
  const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts.map(item => normalizeArtifact(item as Record<string, unknown>, jobId)) : undefined;
  return { ...raw, job_id: jobId, type: (raw.type ?? raw.kind) as JobKind, status: raw.status as Job["status"], stage: String(raw.stage ?? "queued"), progress: raw.progress == null ? null : Number(raw.progress), encoder: (raw.encoder ?? raw.encoder_used) as string | undefined, artifacts } as Job;
}

export interface CoreClientOptions {
  baseUrl: string;
  uiToken: string;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
  pollIntervalMs?: number;
}
export type JobListener = (job: Job) => void;

export class CoreClient {
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: (url: string) => WebSocket;
  private readonly listeners = new Map<JobId, Set<JobListener>>();
  private readonly pollers = new Map<JobId, ReturnType<typeof setInterval>>();
  constructor(private readonly options: CoreClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory ?? (url => new WebSocket(url));
  }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(this.options.baseUrl + path, { ...init, headers: { Authorization: "Bearer " + this.options.uiToken, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
    if (!response.ok) throw new Error("Core request failed: " + response.status);
    return response.json() as Promise<T>;
  }
  probe(grantId: GrantId): Promise<MediaInfo> { return this.request("/api/v1/media/probe", { method: "POST", body: JSON.stringify({ grant_id: grantId }) }); }
  createJob(mediaId: string, kind: JobKind, options: { encoder_mode?: "auto" | "software"; start_us?: number; duration_us?: number; layout?: "blurred_background" } = {}): Promise<Job> {
    const path = kind === "proxy" ? "/api/v1/jobs/proxy" : "/api/v1/jobs/vertical-sample";
    const body = kind === "proxy"
      ? { media_id: mediaId, encoder_mode: options.encoder_mode ?? "auto" }
      : { media_id: mediaId, encoder_mode: options.encoder_mode ?? "auto", start_us: options.start_us ?? 0, duration_us: options.duration_us ?? 10_000_000, layout: options.layout ?? "blurred_background" };
    return this.request<unknown>(path, { method: "POST", body: JSON.stringify(body) }).then(normalizeJob);
  }
  getJob(jobId: JobId): Promise<Job> { return this.request<unknown>("/api/v1/jobs/" + jobId).then(normalizeJob); }
  cancelJob(jobId: JobId): Promise<Job> { return this.request<unknown>("/api/v1/jobs/" + jobId + "/cancel", { method: "POST" }).then(normalizeJob); }
  subscribe(jobId: JobId, listener: JobListener): () => void {
    let set = this.listeners.get(jobId);
    if (!set) { set = new Set(); this.listeners.set(jobId, set); }
    set.add(listener);
    const ws = this.webSocketFactory(this.options.baseUrl.replace(/^http/, "ws") + "/api/v1/events");
    let authenticated = false;
    const poll = () => {
      if (this.pollers.has(jobId)) return;
      const interval = setInterval(() => { void this.getJob(jobId).then(job => this.emit(jobId, job)); }, this.options.pollIntervalMs ?? 1000);
      this.pollers.set(jobId, interval);
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "authenticate", token: this.options.uiToken }));
    ws.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; job?: Job; payload?: { job_id?: string } };
        if (message.type === "authenticated") { authenticated = true; return; }
        if (message.type === "job.updated" && (message.job?.job_id === jobId || message.payload?.job_id === jobId)) void this.getJob(jobId).then(job => this.emit(jobId, job));
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
export function createDesktopCoreClient(runtime: { base_url: string; ui_token: string }): CoreClient { return new CoreClient({ baseUrl: runtime.base_url, uiToken: runtime.ui_token }); }
