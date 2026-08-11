export const PROTOCOL_VERSION = 1 as const;
export const API_PREFIX = "/api/v1" as const;
export const CONTRACT_VERSION = "stage1b-v1" as const;

export type GrantId = string & { readonly __brand: "grant_id" };
export type ProjectId = string & { readonly __brand: "project_id" };
export type AssetId = string & { readonly __brand: "asset_id" };
export type MediaId = string & { readonly __brand: "media_id" };
export type JobId = string & { readonly __brand: "job_id" };
export type ArtifactId = string & { readonly __brand: "artifact_id" };
export type ModelId = string & { readonly __brand: "model_id" };
export type TranscriptId = string & { readonly __brand: "transcript_id" };
export type TranscriptSegmentId = string & { readonly __brand: "transcript_segment_id" };
export type TranscriptWordId = string & { readonly __brand: "transcript_word_id" };

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
  | "vertical_sample"
  | "model_download"
  | "transcription";
export type JobStage =
  | "queued"
  | "downloading"
  | "paused"
  | "verifying"
  | "transcribing"
  | "persisting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | (string & {});
export type ModelInstallStatus = "unavailable" | "queued" | "downloading" | "paused" | "verifying" | "ready" | "cancelled" | "failed";
export type AsrProviderStatus = "unavailable" | "installed" | "corrupt" | "runtime_unavailable";
export type TranscriptStatus = "pending" | "ready" | "stale" | "failed";

export const ERROR_CODES = [
  "UNAUTHORIZED", "FORBIDDEN", "VALIDATION_ERROR", "NOT_FOUND", "PROJECT_NOT_FOUND",
  "PROJECT_ARCHIVED", "PROJECT_NAME_INVALID", "ASSET_NOT_FOUND", "ASSET_DUPLICATE",
  "ASSET_MISSING", "ASSET_CHANGED", "ASSET_UNSUPPORTED", "GRANT_NOT_FOUND",
  "GRANT_EXPIRED", "MEDIA_NOT_FOUND", "MEDIA_UNSUPPORTED", "JOB_NOT_FOUND",
  "JOB_INVALID_STATE", "JOB_CANCELLED", "JOB_INTERRUPTED", "MIGRATION_FAILED",
  "CONFLICT", "INTERNAL_ERROR", "MODEL_NOT_FOUND", "MODEL_NOT_INSTALLED",
  "MODEL_DOWNLOAD_FAILED", "MODEL_DOWNLOAD_CANCELLED", "MODEL_HASH_MISMATCH",
  "MODEL_LICENSE_REQUIRED", "MODEL_DISK_SPACE_INSUFFICIENT", "MODEL_RUNTIME_UNAVAILABLE",
  "TRANSCRIPTION_NOT_READY", "TRANSCRIPTION_FAILED", "TRANSCRIPTION_CANCELLED",
  "TRANSCRIPTION_INPUT_CHANGED", "TRANSCRIPTION_UNSUPPORTED_LANGUAGE"
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
  asset_id: AssetId | null;
  kind: JobKind;
  status: JobStatus;
  stage: JobStage;
  progress: number | null;
  attempt: number;
  model_id: ModelId | null;
  model_revision: string | null;
  input_fingerprint: string | null;
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

export interface LicenseInfo {
  id: string;
  name: string;
  url: string | null;
  attribution: string | null;
  acceptance_required: boolean;
}

export type ModelSourceKind = "trusted_manifest" | "https";
export interface ModelSource {
  kind: ModelSourceKind;
  display_name: string;
  host: string | null;
  url: string | null;
}

export interface RendererModelFile {
  relative_path: string;
  size_bytes: number;
  sha256: string;
}

export interface InternalModelFile {
  path: string;
  size_bytes: number;
  sha256: string;
  url?: string | null;
}

export interface InternalModelManifest {
  model_id: ModelId;
  provider: string;
  revision: string;
  display_name: string;
  purpose: string;
  download_url: string | null;
  trusted_source_id: string | null;
  size_bytes: number;
  installed_size_bytes: number;
  sha256: string;
  license: LicenseInfo;
  supported_languages: string[];
  supports_word_timestamps: boolean;
  runtime_version: string;
  runtime_requirements: Record<string, unknown>;
  files: InternalModelFile[];
  installed_path: string | null;
  source_file?: string | null;
  manifest_sha256?: string | null;
  created_at: string;
}

export type ModelFile = RendererModelFile;
export type ModelManifest = InternalModelManifest;

export interface ModelSummary {
  model_id: ModelId;
  display_name: string;
  purpose: string;
  provider: string;
  revision: string;
  supported_languages: string[];
  supports_word_timestamps: boolean;
  runtime_version: string;
  model_size_bytes: number;
  installed_size_bytes: number;
  model_sha256: string;
  license: LicenseInfo;
  source: ModelSource;
  requires_network: boolean;
  local_only: true;
  status: ModelInstallStatus;
  provider_status: AsrProviderStatus;
  progress: number | null;
  required_disk_bytes: number;
}

export interface ModelDetail extends ModelSummary {
  runtime_requirements: Record<string, unknown>;
  files: RendererModelFile[];
  available_disk_bytes: number | null;
}

export interface ModelDownloadPage extends Page<ModelSummary> {}
export interface ModelDownloadResponse { model: ModelDetail; job: Job; }
export interface ModelDownloadStatusResponse { model: ModelDetail; job: Job | null; }

export interface TranscriptionCreateInput {
  model_id: ModelId;
  language: string;
  word_timestamps: boolean;
  license_acceptance: string | null;
}
export interface TranscriptionCreateResponse { job: Job; transcript: Transcript | null; }
export interface TranscriptSummary {
  transcript_id: TranscriptId;
  asset_id: AssetId;
  status: TranscriptStatus;
  language: string;
  provider: string;
  model_id: ModelId;
  model_revision: string;
  source_media_fingerprint: string;
  duration_us: number;
  created_at: string;
  updated_at: string;
}
export interface TranscriptPage extends Page<TranscriptSummary> {}

export interface TranscriptWord {
  word_id: TranscriptWordId;
  segment_id: TranscriptSegmentId;
  ordinal: number;
  start_us: number;
  end_us: number;
  text: string;
  confidence: number | null;
}
export interface TranscriptSegment {
  segment_id: TranscriptSegmentId;
  ordinal: number;
  start_us: number;
  end_us: number;
  text: string;
  confidence: number | null;
  words: TranscriptWord[] | null;
}
export interface Transcript {
  transcript_id: TranscriptId;
  asset_id: AssetId;
  status: TranscriptStatus;
  language: string;
  segments: TranscriptSegment[];
  words: TranscriptWord[] | null;
  provider: string;
  model_id: ModelId;
  model_revision: string;
  source_media_fingerprint: string;
  duration_us: number;
  created_at: string;
  updated_at: string;
}

export class ContractValidationError extends Error {
  constructor(public readonly contract: string, message = "Invalid contract payload") {
    super(`${contract}: ${message}`);
    this.name = "ContractValidationError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const JOB_STATUSES: JobStatus[] = ["queued", "running", "succeeded", "failed", "cancelling", "cancelled", "interrupted"];
const JOB_KINDS: JobKind[] = ["asset_probe", "asset_fingerprint", "proxy", "portrait_sample", "vertical_sample", "model_download", "transcription"];
const PROJECT_STATUSES: ProjectStatus[] = ["active", "archived", "missing"];
const ASSET_KINDS: AssetKind[] = ["video", "audio", "image", "text"];
const ASSET_AVAILABILITIES: AssetAvailability[] = ["available", "missing", "changed", "unsupported"];
const MODEL_INSTALL_STATUSES: ModelInstallStatus[] = ["unavailable", "queued", "downloading", "paused", "verifying", "ready", "cancelled", "failed"];
const PROVIDER_STATUSES: AsrProviderStatus[] = ["unavailable", "installed", "corrupt", "runtime_unavailable"];
const TRANSCRIPT_STATUSES: TranscriptStatus[] = ["pending", "ready", "stale", "failed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isString(value: unknown): value is string { return typeof value === "string"; }
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isId(value: unknown): value is string { return isString(value) && ID_PATTERN.test(value); }
function isTime(value: unknown): value is string { return isString(value) && value.length > 0; }
function oneOf<T extends string>(values: readonly T[], value: unknown): value is T { return typeof value === "string" && values.includes(value as T); }
function isInteger(value: unknown, minimum = 0): value is number { return isFiniteNumber(value) && Number.isInteger(value) && value >= minimum; }
function isRatio(value: unknown): value is number { return isFiniteNumber(value) && value >= 0 && value <= 1; }
function isSha256(value: unknown): value is string { return isString(value) && /^(?:sha256:)?[a-f0-9]{64}$/.test(value); }
function isNullableString(value: unknown): value is string | null { return value === null || isString(value); }
function isLanguage(value: unknown): value is string { return isString(value) && /^(auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(value); }
function hasSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => ["installed_path", "install_dir", "path", "uri", "token", "admin_token", "ui_token"].includes(key) || hasSensitiveKey(item));
}

export function isLicenseInfo(value: unknown): value is LicenseInfo {
  if (!isRecord(value)) return false;
  return isString(value.id) && value.id.length > 0 && isString(value.name) && value.name.length > 0 &&
    isNullableString(value.url) && isNullableString(value.attribution) && typeof value.acceptance_required === "boolean";
}
export function isModelSource(value: unknown): value is ModelSource {
  if (!isRecord(value)) return false;
  return oneOf(["trusted_manifest", "https"] as const, value.kind) && isString(value.display_name) &&
    isNullableString(value.host) && isNullableString(value.url);
}
export function isModelFile(value: unknown): value is ModelFile {
  if (!isRecord(value)) return false;
  return isString(value.relative_path) && value.relative_path.length > 0 && !value.relative_path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value.relative_path) && isInteger(value.size_bytes, 1) && isSha256(value.sha256);
}
export function isInternalModelFile(value: unknown): value is InternalModelFile {
  if (!isRecord(value)) return false;
  return isString(value.path) && value.path.length > 0 && !value.path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value.path) && isInteger(value.size_bytes, 1) && isSha256(value.sha256) && (value.url === undefined || isNullableString(value.url));
}
function isModelIdentity(value: Record<string, unknown>): boolean {
  return isId(value.model_id) && isString(value.display_name) && value.display_name.length > 0 && isString(value.purpose) &&
    value.purpose.length > 0 && isString(value.provider) && value.provider.length > 0 && isString(value.revision) &&
    value.revision.length > 0 && Array.isArray(value.supported_languages) && value.supported_languages.every(item => isString(item) && item.length > 0) &&
    typeof value.supports_word_timestamps === "boolean" && isString(value.runtime_version) && value.runtime_version.length > 0 &&
    isInteger(value.model_size_bytes, 1) && isInteger(value.installed_size_bytes, 1) && isSha256(value.model_sha256) &&
    isLicenseInfo(value.license) && isModelSource(value.source) && typeof value.requires_network === "boolean" && value.local_only === true &&
    oneOf(MODEL_INSTALL_STATUSES, value.status) && oneOf(PROVIDER_STATUSES, value.provider_status) &&
    (value.progress === null || isRatio(value.progress)) && isInteger(value.required_disk_bytes, 1);
}
export function isModelSummary(value: unknown): value is ModelSummary {
  return isRecord(value) && isModelIdentity(value);
}
export function isModelDetail(value: unknown): value is ModelDetail {
  if (!isModelSummary(value)) return false;
  const detail = value as ModelDetail;
  return isRecord(detail.runtime_requirements) && Array.isArray(detail.files) && detail.files.every(isModelFile) &&
    (detail.available_disk_bytes === null || isInteger(detail.available_disk_bytes, 0)) && !hasSensitiveKey(detail) && !Object.prototype.hasOwnProperty.call(detail, "installed_path");
}
export function isInternalModelManifest(value: unknown): value is InternalModelManifest {
  if (!isRecord(value)) return false;
  return isId(value.model_id) && isString(value.provider) && isString(value.revision) && isString(value.display_name) && isString(value.purpose) && isNullableString(value.download_url) &&
    isNullableString(value.trusted_source_id) && isInteger(value.size_bytes, 1) && isInteger(value.installed_size_bytes, 1) &&
    isSha256(value.sha256) && isLicenseInfo(value.license) && Array.isArray(value.supported_languages) &&
    value.supported_languages.every(isLanguage) && typeof value.supports_word_timestamps === "boolean" && isString(value.runtime_version) &&
    isRecord(value.runtime_requirements) && Array.isArray(value.files) && value.files.every(isInternalModelFile) &&
    isNullableString(value.installed_path) && (value.source_file === undefined || isNullableString(value.source_file)) &&
    (value.manifest_sha256 === undefined || isNullableString(value.manifest_sha256)) && isTime(value.created_at);
}
export const isModelManifest = isInternalModelManifest;

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
  if (!isRecord(value) || !isId(value.job_id) || !(value.project_id === null || isId(value.project_id)) || !(value.asset_id === null || isId(value.asset_id)) || !isJobKind(value.kind) || !isJobStatus(value.status) || !isString(value.stage) ||
    !(value.progress === null || isFiniteNumber(value.progress)) || !Number.isInteger(value.attempt) || !isRecord(value.input) || !(value.error === null || isRecord(value.error)) || !isTime(value.created_at) || !isTime(value.updated_at) ||
    !(value.started_at === null || isTime(value.started_at)) || !(value.finished_at === null || isTime(value.finished_at)) ||
    !(value.model_id === null || isId(value.model_id)) || !(value.model_revision === null || isString(value.model_revision)) ||
    !(value.input_fingerprint === null || isString(value.input_fingerprint))) return false;
  if (value.progress !== null && !isRatio(value.progress)) return false;
  if (!isInteger(value.attempt, 1)) return false;
  return value.error === null || (isString(value.error.code) && isString(value.error.message));
}

function isTranscriptWord(value: unknown, segment?: TranscriptSegment): value is TranscriptWord {
  if (!isRecord(value) || !isId(value.word_id) || !isId(value.segment_id) || !isInteger(value.ordinal) || !isInteger(value.start_us) ||
    !isInteger(value.end_us, 1) || value.end_us <= value.start_us || !isString(value.text) || !(value.confidence === null || isRatio(value.confidence))) return false;
  return !segment || (value.segment_id === segment.segment_id && value.start_us >= segment.start_us && value.end_us <= segment.end_us);
}
export function isTranscriptSegment(value: unknown, durationUs?: number): value is TranscriptSegment {
  if (!isRecord(value) || !isId(value.segment_id) || !isInteger(value.ordinal) || !isInteger(value.start_us) || !isInteger(value.end_us, 1) ||
    value.end_us <= value.start_us || !isString(value.text) || !(value.confidence === null || isRatio(value.confidence)) ||
    !(value.words === null || Array.isArray(value.words))) return false;
  if (durationUs !== undefined && value.end_us > durationUs) return false;
  return value.words === null || value.words.every(item => isTranscriptWord(item, value as unknown as TranscriptSegment));
}
export function isTranscript(value: unknown): value is Transcript {
  if (!isRecord(value) || !isId(value.transcript_id) || !isId(value.asset_id) || !oneOf(TRANSCRIPT_STATUSES, value.status) ||
    !isString(value.language) || !Array.isArray(value.segments) || !(value.words === null || Array.isArray(value.words)) ||
    !isString(value.provider) || !isId(value.model_id) || !isString(value.model_revision) || !isString(value.source_media_fingerprint) ||
    !isInteger(value.duration_us, 0) || !isTime(value.created_at) || !isTime(value.updated_at)) return false;
  const durationUs = value.duration_us;
  if (!isInteger(durationUs, 0) || !value.segments.every(item => isTranscriptSegment(item, durationUs))) return false;
  for (let index = 1; index < value.segments.length; index += 1) {
    const previous = value.segments[index - 1];
    const current = value.segments[index];
    if (current.start_us < previous.start_us || (current.start_us === previous.start_us && current.ordinal < previous.ordinal)) return false;
  }
  if (value.words !== null && !value.words.every(item => isTranscriptWord(item))) return false;
  return true;
}
export function isTranscriptSummary(value: unknown): value is TranscriptSummary {
  if (!isRecord(value)) return false;
  return isId(value.transcript_id) && isId(value.asset_id) && oneOf(TRANSCRIPT_STATUSES, value.status) && isString(value.language) &&
    isString(value.provider) && isId(value.model_id) && isString(value.model_revision) && isString(value.source_media_fingerprint) &&
    isInteger(value.duration_us, 0) && isTime(value.created_at) && isTime(value.updated_at);
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

export function asEntityId<T extends GrantId | ProjectId | AssetId | MediaId | JobId | ArtifactId | ModelId | TranscriptId | TranscriptSegmentId | TranscriptWordId>(value: string): T {
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
export function parseModelSummary(value: unknown): ModelSummary { if (!isModelSummary(value)) throw new ContractValidationError("ModelSummary"); return value; }
export function parseModelDetail(value: unknown): ModelDetail { if (!isModelDetail(value)) throw new ContractValidationError("ModelDetail"); return value; }
export function parseInternalModelManifest(value: unknown): InternalModelManifest { if (!isInternalModelManifest(value)) throw new ContractValidationError("InternalModelManifest"); return value; }
export function parseTranscript(value: unknown): Transcript { if (!isTranscript(value)) throw new ContractValidationError("Transcript"); return value; }
export function parseTranscriptSummary(value: unknown): TranscriptSummary { if (!isTranscriptSummary(value)) throw new ContractValidationError("TranscriptSummary"); return value; }
export function parseApiError(value: unknown): ApiErrorResponse {
  if (!isApiErrorResponse(value)) throw new ContractValidationError("ApiError");
  return value;
}
