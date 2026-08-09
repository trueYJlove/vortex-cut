export const PROTOCOL_VERSION = 1 as const;
export const API_PREFIX = "/api/v1" as const;
export const CONTRACT_VERSION = "stage1a-v1" as const;

export type GrantId = string & { readonly __brand: "grant_id" };
export type ProjectId = string & { readonly __brand: "project_id" };
export type AssetId = string & { readonly __brand: "asset_id" };
export type MediaId = string & { readonly __brand: "media_id" };
export type JobId = string & { readonly __brand: "job_id" };
export type ArtifactId = string & { readonly __brand: "artifact_id" };

export type ProjectStatus = "active" | "archived" | "missing";
export type AssetKind = "video" | "audio" | "image" | "text";
export type StorageMode = "external" | "managed";
export type AssetAvailability = "available" | "missing" | "changed" | "unsupported";
export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "interrupted";
export type JobKind =
  | "asset_probe"
  | "asset_fingerprint"
  | "proxy"
  | "portrait_sample"
  | "vertical_sample";

export const ERROR_CODES = [
  "UNAUTHORIZED", "FORBIDDEN", "VALIDATION_ERROR", "NOT_FOUND", "PROJECT_NOT_FOUND",
  "PROJECT_ARCHIVED", "PROJECT_NAME_INVALID", "ASSET_NOT_FOUND", "ASSET_DUPLICATE",
  "ASSET_MISSING", "ASSET_CHANGED", "ASSET_UNSUPPORTED", "GRANT_NOT_FOUND",
  "GRANT_EXPIRED", "MEDIA_NOT_FOUND", "MEDIA_UNSUPPORTED", "JOB_NOT_FOUND",
  "JOB_INVALID_STATE", "JOB_CANCELLED", "JOB_INTERRUPTED", "MIGRATION_FAILED",
  "CONFLICT", "INTERNAL_ERROR"
] as const;
export type ErrorCode = typeof ERROR_CODES[number] | (string & {});

export interface ApiError {
  code: ErrorCode;
  message: string;
  trace_id: string;
}

export interface ApiErrorResponse {
  error: ApiError;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
export type ProjectPage = Page<Project>;
export type AssetPage = Page<Asset>;
export type JobPage = Page<Job>;

export interface ProjectCanvas {
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
}

export interface Project {
  project_id: ProjectId;
  name: string;
  status: ProjectStatus;
  canvas: ProjectCanvas;
  root_dir_name: string;
  current_timeline_revision_id: string | null;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
}

export interface FileGrant {
  grant_id: GrantId;
  display_name: string;
  size_bytes: number;
  modified_at: string;
  expires_at: string;
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

export type AssetMediaInfo = MediaInfo | Record<string, unknown>;

export interface Asset {
  asset_id: AssetId;
  project_id: ProjectId;
  kind: AssetKind;
  storage_mode: StorageMode;
  display_name: string;
  fingerprint: string;
  size_bytes: number;
  modified_at: string;
  availability: AssetAvailability;
  media_info: AssetMediaInfo | null;
  created_at: string;
  updated_at: string;
}

export interface AssetPresentation {
  asset: Asset;
  media_url: string | null;
}

export interface AssetPresentationPage {
  items: AssetPresentation[];
  next_cursor: string | null;
}

export interface ImportedAsset extends AssetPresentation {
  grant: FileGrant;
}

export interface JobError {
  code: ErrorCode;
  message: string;
  trace_id?: string;
}

export interface JobInput {
  asset_id?: AssetId;
  media_id?: MediaId;
  [key: string]: unknown;
}

export interface Job {
  job_id: JobId;
  project_id: ProjectId | null;
  kind: JobKind;
  status: JobStatus;
  stage: string;
  progress: number | null;
  attempt: number;
  input: JobInput;
  error: JobError | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  type?: JobKind;
  encoder?: string | null;
  fallback_reason?: string | null;
  artifact_id?: ArtifactId | null;
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

export interface JobUpdatedEvent {
  type: "job.updated";
  event_id?: string;
  occurred_at?: string;
  payload?: {
    job_id: JobId;
    status: JobStatus;
    progress: number | null;
  };
  job?: Job;
}
export type JobEvent = JobUpdatedEvent;

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

export class ContractValidationError extends Error {
  constructor(public readonly contract: string, message = "Invalid contract payload") {
    super(`${contract}: ${message}`);
    this.name = "ContractValidationError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const JOB_STATUSES: JobStatus[] = ["queued", "running", "succeeded", "failed", "cancelling", "cancelled", "interrupted"];
const JOB_KINDS: JobKind[] = ["asset_probe", "asset_fingerprint", "proxy", "portrait_sample", "vertical_sample"];
const PROJECT_STATUSES: ProjectStatus[] = ["active", "archived", "missing"];
const ASSET_KINDS: AssetKind[] = ["video", "audio", "image", "text"];
const ASSET_AVAILABILITIES: AssetAvailability[] = ["available", "missing", "changed", "unsupported"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isString(value: unknown): value is string { return typeof value === "string"; }
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isId(value: unknown): value is string { return isString(value) && ID_PATTERN.test(value); }
function isTime(value: unknown): value is string { return isString(value) && value.length > 0; }
function oneOf<T extends string>(values: readonly T[], value: unknown): value is T { return typeof value === "string" && values.includes(value as T); }

export function isSidecarReady(value: unknown): value is SidecarReady {
  if (!isRecord(value)) return false;
  return value.protocol_version === PROTOCOL_VERSION && isFiniteNumber(value.port) && value.port > 0 && value.port < 65536 &&
    Number.isInteger(value.port) && isFiniteNumber(value.pid) && value.pid > 0 && Number.isInteger(value.pid) && isString(value.build_version) && value.build_version.length > 0;
}

export function isJobStatus(value: unknown): value is JobStatus { return oneOf(JOB_STATUSES, value); }
export function isProjectStatus(value: unknown): value is ProjectStatus { return oneOf(PROJECT_STATUSES, value); }
export function isAssetKind(value: unknown): value is AssetKind { return oneOf(ASSET_KINDS, value); }
export function isAssetAvailability(value: unknown): value is AssetAvailability { return oneOf(ASSET_AVAILABILITIES, value); }
export function isJobKind(value: unknown): value is JobKind { return oneOf(JOB_KINDS, value); }

export function isFileGrant(value: unknown): value is FileGrant {
  if (!isRecord(value)) return false;
  return isId(value.grant_id) && isString(value.display_name) && isFiniteNumber(value.size_bytes) && isTime(value.modified_at) && isTime(value.expires_at);
}

export function isProject(value: unknown): value is Project {
  if (!isRecord(value) || !isId(value.project_id) || !isString(value.name) || !isProjectStatus(value.status)) return false;
  const canvas = value.canvas;
  return isRecord(canvas) && isFiniteNumber(canvas.width) && isFiniteNumber(canvas.height) && isFiniteNumber(canvas.fps_num) && isFiniteNumber(canvas.fps_den) &&
    isString(value.root_dir_name) && (value.current_timeline_revision_id === null || isString(value.current_timeline_revision_id)) && isTime(value.created_at) && isTime(value.updated_at) && isTime(value.last_opened_at);
}

export function isAsset(value: unknown): value is Asset {
  if (!isRecord(value)) return false;
  return isId(value.asset_id) && isId(value.project_id) && isAssetKind(value.kind) && oneOf(["external", "managed"] as const, value.storage_mode) && isString(value.display_name) && isString(value.fingerprint) && isFiniteNumber(value.size_bytes) &&
    (value.modified_at === null || isTime(value.modified_at)) && isAssetAvailability(value.availability) && (value.media_info === null || isRecord(value.media_info)) && isTime(value.created_at) && isTime(value.updated_at);
}

export function isJob(value: unknown): value is Job {
  if (!isRecord(value) || !isId(value.job_id) || !(value.project_id === null || isId(value.project_id)) || !isJobKind(value.kind) || !isJobStatus(value.status) || !isString(value.stage) ||
    !(value.progress === null || isFiniteNumber(value.progress)) || !Number.isInteger(value.attempt) || !isRecord(value.input) || !(value.error === null || isRecord(value.error)) || !isTime(value.created_at) || !isTime(value.updated_at) ||
    !(value.started_at === null || isTime(value.started_at)) || !(value.finished_at === null || isTime(value.finished_at))) return false;
  return value.error === null || (isString(value.error.code) && isString(value.error.message));
}

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (!isRecord(value) || !isRecord(value.error)) return false;
  return isString(value.error.code) && isString(value.error.message) && isString(value.error.trace_id);
}

export function isPage<T>(value: unknown, itemGuard: (item: unknown) => item is T): value is Page<T> {
  if (!isRecord(value) || !Array.isArray(value.items) || !(value.next_cursor === null || isString(value.next_cursor))) return false;
  return value.items.every(itemGuard);
}

export function isJobEvent(value: unknown): value is JobUpdatedEvent {
  if (!isRecord(value) || value.type !== "job.updated") return false;
  if (value.job !== undefined && !isJob(value.job)) return false;
  if (value.payload === undefined) return true;
  return isRecord(value.payload) && isId(value.payload.job_id) && isJobStatus(value.payload.status) && (value.payload.progress === null || isFiniteNumber(value.payload.progress));
}

export function parseSidecarReadyLine(line: string): SidecarReady {
  const prefix = "AIVS_READY ";
  if (!line.startsWith(prefix)) throw new ContractValidationError("SidecarReady", "Missing AIVS_READY prefix");
  let value: unknown;
  try { value = JSON.parse(line.slice(prefix.length)); } catch { throw new ContractValidationError("SidecarReady", "Invalid JSON"); }
  if (!isSidecarReady(value)) throw new ContractValidationError("SidecarReady");
  return value;
}

export function asEntityId<T extends GrantId | ProjectId | AssetId | MediaId | JobId | ArtifactId>(value: string): T {
  if (!ID_PATTERN.test(value)) throw new ContractValidationError("EntityId", "Invalid entity id");
  return value as T;
}

export function parseProject(value: unknown): Project {
  if (!isProject(value)) throw new ContractValidationError("Project");
  return value;
}
export function parseAsset(value: unknown): Asset {
  if (!isAsset(value)) throw new ContractValidationError("Asset");
  return value;
}
export function parseFileGrant(value: unknown): FileGrant {
  if (!isFileGrant(value)) throw new ContractValidationError("FileGrant");
  return value;
}
export function parseJob(value: unknown): Job {
  if (!isJob(value)) throw new ContractValidationError("Job");
  return value;
}
export function parseApiError(value: unknown): ApiErrorResponse {
  if (!isApiErrorResponse(value)) throw new ContractValidationError("ApiError");
  return value;
}
