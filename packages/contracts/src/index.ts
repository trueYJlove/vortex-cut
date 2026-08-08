export const PROTOCOL_VERSION = 1 as const;
export const API_PREFIX = "/api/v1" as const;

export type GrantId = string & { readonly __brand: "grant_id" };
export type MediaId = string & { readonly __brand: "media_id" };
export type JobId = string & { readonly __brand: "job_id" };
export type ArtifactId = string & { readonly __brand: "artifact_id" };

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "interrupted";

export type JobKind = "proxy" | "portrait_sample" | "vertical_sample";

export interface SidecarReady {
  protocol_version: 1;
  port: number;
  pid: number;
  build_version: string;
}

export interface CoreHealth {
  status: "ok";
  protocol_version: 1;
  build_version: string;
  database?: string;
  scheduler?: string;
}

export interface RendererSession {
  token: string;
  expires_with_process: true;
  scopes: string[];
}

export interface FileGrant {
  grant_id: GrantId;
  display_name: string;
  size_bytes: number;
  modified_at: string;
}

export interface MediaStream {
  index: number;
  codec: string;
  width?: number;
  height?: number;
  avg_frame_rate_num?: number;
  avg_frame_rate_den?: number;
  rotation?: number;
  pixel_format?: string;
}

export interface MediaInfo {
  media_id: MediaId;
  display_name: string;
  format_name: string;
  duration_us: number;
  size_bytes: number;
  video_streams: MediaStream[];
  audio_streams: MediaStream[];
}

export interface Job {
  job_id: JobId;
  type?: JobKind;
  kind?: JobKind;
  status: JobStatus;
  stage: string;
  progress: number | null;
  encoder?: string;
  fallback_reason?: string | null;
  artifact_id?: ArtifactId | null;
  error?: { code: string; message: string; trace_id?: string } | null;
  artifacts?: Artifact[];
}

export interface Artifact {
  artifact_id: ArtifactId;
  id?: ArtifactId;
  kind?: string;
  job_id: JobId;
  display_name: string;
  size_bytes: number;
  sha256: string;
  media_info: MediaInfo;
}

export interface JobEvent {
  type: "job.updated";
  job: Job;
}

export interface WsAuthenticate {
  type: "authenticate";
  token: string;
}

export function isSidecarReady(value: unknown): value is SidecarReady {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.protocol_version === PROTOCOL_VERSION &&
    typeof candidate.port === "number" && candidate.port > 0 && candidate.port < 65536 &&
    typeof candidate.pid === "number" && candidate.pid > 0 &&
    typeof candidate.build_version === "string" && candidate.build_version.length > 0
  );
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" &&
    ["queued", "running", "succeeded", "failed", "cancelling", "cancelled", "interrupted"].includes(value);
}

export function asEntityId<T extends GrantId | MediaId | JobId | ArtifactId>(value: string): T {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("Invalid entity id");
  }
  return value as T;
}

export function parseSidecarReadyLine(line: string): SidecarReady {
  const prefix = "AIVS_READY ";
  if (!line.startsWith(prefix)) throw new Error("Missing AIVS_READY prefix");
  const value: unknown = JSON.parse(line.slice(prefix.length));
  if (!isSidecarReady(value)) throw new Error("Invalid AIVS_READY payload");
  return value;
}
