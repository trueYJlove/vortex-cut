import {
  parseJob,
  type Artifact,
  type ArtifactId,
  type Asset,
  type Job,
  type JobId,
  type JobKind,
  type MediaInfo,
  type ModelId,
  type ProjectId,
} from "@aivideo/contracts";

const JOB_SENSITIVE_KEYS = new Set([
  "path",
  "uri",
  "root_dir",
  "database_path",
  "admin_token",
  "ui_token",
  "token",
  "installed_path",
  "install_dir",
  "source_file",
  "authorization",
  "api_key",
  "secret",
  "prompt",
  "raw_exception",
  "raw_response",
  "sse",
  "base64",
  "instruction",
  "payload",
  "http_body",
  "request_body",
  "system_message",
  "absolute_path",
  "transcript",
  "caption",
  "stderr",
  "command",
  "traceback",
]);

function stripSensitiveJobFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitiveJobFields);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (JOB_SENSITIVE_KEYS.has(key.toLowerCase())) continue;
    result[key] = stripSensitiveJobFields(item);
  }
  return result;
}

function normalizeArtifact(value: Record<string, unknown>, jobId: JobId): Artifact {
  return {
    artifact_id: String(value.artifact_id ?? value.id) as ArtifactId,
    job_id: jobId,
    display_name: typeof value.display_name === "string" ? value.display_name : `${String(value.kind ?? "artifact")}.mp4`,
    size_bytes: Number(value.size_bytes ?? 0),
    sha256: String(value.sha256 ?? ""),
    media_info: value.media_info as MediaInfo,
  };
}

/** Sanitize and normalize a raw Core job payload before forwarding to the renderer. */
export function normalizeJob(value: unknown): Job {
  const raw = stripSensitiveJobFields(value) as Record<string, unknown>;
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
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.map(item => normalizeArtifact(item as Record<string, unknown>, jobId)) : [],
  };
  return parseJob(normalized);
}
