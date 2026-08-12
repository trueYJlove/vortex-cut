export const PROTOCOL_VERSION = 1 as const;
export const API_PREFIX = "/api/v1" as const;
export const CONTRACT_VERSION = "stage1c-v1" as const;

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
export type TimelineRevisionId = string & { readonly __brand: "timeline_revision_id" };
export type TimelineClipId = string & { readonly __brand: "timeline_clip_id" };
export type TimelineCaptionId = string & { readonly __brand: "timeline_caption_id" };
export type RenderArtifactId = string & { readonly __brand: "render_artifact_id" };
export type ExportRecordId = string & { readonly __brand: "export_record_id" };
export type DestinationGrantId = string & { readonly __brand: "destination_grant_id" };
export type PlaybackTicketId = string & { readonly __brand: "playback_ticket_id" };

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
  | "transcription"
  | "authoritative_preview"
  | "final_export";
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
  , "TIMELINE_NOT_FOUND", "TIMELINE_ALREADY_EXISTS", "TIMELINE_INVALID",
  "TIMELINE_CONFLICT", "TIMELINE_EMPTY", "TIMELINE_DRAFT_CONFLICT",
  "TIMELINE_CLIP_NOT_FOUND", "TIMELINE_CAPTION_NOT_FOUND", "TIMELINE_SOURCE_INVALID",
  "TIMELINE_OPERATION_UNSUPPORTED", "RENDER_PLAN_INVALID", "RENDER_INPUT_CHANGED",
  "RENDER_FONT_MISSING", "RENDER_FAILED", "RENDER_VALIDATION_FAILED", "PREVIEW_NOT_FOUND",
  "EXPORT_NOT_FOUND", "EXPORT_DESTINATION_INVALID", "EXPORT_DESTINATION_EXISTS",
  "EXPORT_DESTINATION_EXPIRED", "EXPORT_DISK_SPACE_INSUFFICIENT", "ARTIFACT_NOT_FOUND",
  "PLAYBACK_TICKET_INVALID"
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

export type TimelineCreatedBy = "user" | "system" | "import";
export type TimelineLayout = "blurred_background" | "crop_fill" | "fit";
export type TimelineClipKind = "video" | "image";
export type CaptionOrigin = "transcript" | "user";
export type CaptionPresetId = "default-bottom" | "game-safe-bottom" | "high-contrast";
export type RenderMode = "authoritative_preview" | "final_export";
export type RenderArtifactStatus = "ready" | "stale";
export type ExportStatus = "succeeded" | "missing";
export type EncoderMode = "auto" | "software";
export type RenderProfileId = "preview-portrait-v1" | "export-portrait-v1";

export interface RenderedMediaInfo {
  duration_us: number;
  format_name: string;
  video: { codec: string; width: number; height: number; pixel_format: string; fps_num: number; fps_den: number };
  audio: { codec: string; sample_rate: number; channels: number } | null;
}
export interface RenderArtifact {
  render_artifact_id: RenderArtifactId;
  project_id: ProjectId;
  timeline_revision_id: TimelineRevisionId;
  kind: RenderMode;
  status: RenderArtifactStatus;
  content_fingerprint: string;
  profile_id: RenderProfileId;
  display_name: string;
  size_bytes: number;
  sha256: string;
  media_info: RenderedMediaInfo;
  encoder: string;
  fallback_reason: string | null;
  created_at: string;
}
export interface AuthoritativePreview extends RenderArtifact {
  kind: "authoritative_preview";
  profile_id: "preview-portrait-v1";
}
export interface ExportRecord {
  export_record_id: ExportRecordId;
  project_id: ProjectId;
  timeline_revision_id: TimelineRevisionId;
  render_artifact_id: RenderArtifactId;
  status: ExportStatus;
  profile_id: "export-portrait-v1";
  destination_display_name: string;
  size_bytes: number;
  sha256: string;
  media_info: RenderedMediaInfo;
  encoder: string;
  fallback_reason: string | null;
  created_at: string;
}
export interface DestinationGrant {
  destination_grant_id: DestinationGrantId;
  display_name: string;
  extension: ".mp4";
  overwrite_authorized: boolean;
  expires_at: string;
}
export interface PreviewCreateInput { timeline_revision_id?: TimelineRevisionId; encoder_mode?: EncoderMode; }
export interface PreviewCreateResponse { job: Job | null; preview: AuthoritativePreview | null; reused: boolean; }
export interface ExportCreateInput { timeline_revision_id?: TimelineRevisionId; destination_grant_id: DestinationGrantId; encoder_mode?: EncoderMode; }
export interface ExportCreateResponse { job: Job; export_record: ExportRecord | null; }
export type AuthoritativePreviewPage = Page<AuthoritativePreview>;
export type ExportRecordPage = Page<ExportRecord>;

export interface TimelineCanvas extends ProjectCanvas { background_color: string; }
export interface TimelineTrack { id: "V1" | "C1"; kind: "visual" | "caption"; locked: boolean; }
export interface TimelineClipAudio { enabled: boolean; gain_db: number; }
export interface TimelineClip {
  clip_id: TimelineClipId;
  track_id: "V1";
  order_index: number;
  asset_id: AssetId;
  asset_kind: TimelineClipKind;
  source_start_us: number | null;
  source_end_us: number | null;
  timeline_start_us: number;
  timeline_end_us: number;
  layout: TimelineLayout;
  audio: TimelineClipAudio;
}
export interface TimelineCaption {
  caption_id: TimelineCaptionId;
  track_id: "C1";
  source_clip_id: TimelineClipId | null;
  start_us: number;
  end_us: number;
  text: string;
  preset_id: CaptionPresetId;
  origin: CaptionOrigin;
  edited: boolean;
  source_segment_ids: TranscriptSegmentId[];
}
export interface TimelineDocument {
  schema_version: 1;
  project_id: ProjectId;
  canvas: TimelineCanvas;
  tracks: [TimelineTrack, TimelineTrack];
  clips: TimelineClip[];
  captions: TimelineCaption[];
  provenance: { created_by: TimelineCreatedBy; source_transcript_ids: TranscriptId[] };
}
export interface TimelineRevisionSummary {
  timeline_revision_id: TimelineRevisionId;
  project_id: ProjectId;
  parent_revision_id: TimelineRevisionId | null;
  document_sha256: string;
  summary: string;
  created_by: TimelineCreatedBy;
  created_at: string;
}
export interface TimelineRevision extends TimelineRevisionSummary { schema_version: 1; document: TimelineDocument; }
export interface TimelineDraftInput { schema_version: 1; base_revision_id: TimelineRevisionId; document: TimelineDocument; }
export interface TimelineDraft { project_id: ProjectId; base_revision_id: TimelineRevisionId; document: TimelineDocument; updated_at: string; conflict: boolean; }
export interface TimelineState {
  project_id: ProjectId;
  current_revision: TimelineRevision;
  draft: TimelineDraft | null;
  can_undo: boolean;
  can_redo: boolean;
  current_preview: AuthoritativePreview | null;
}
export type TimelineRevisionPage = Page<TimelineRevisionSummary>;

export type TimelineCreateSource =
  | { kind: "empty" }
  | { kind: "full_asset"; asset_id: AssetId }
  | { kind: "transcript_selection"; transcript_id: TranscriptId; segment_ids: TranscriptSegmentId[]; padding_before_us: number; padding_after_us: number; create_captions: boolean };
export interface TimelineCreateInput { schema_version: 1; source: TimelineCreateSource; default_layout: TimelineLayout; caption_preset_id: CaptionPresetId; }

export type TimelinePatchOperation =
  | { op: "insert_asset_clip"; asset_id: AssetId; at_index: number; source_start_us?: number; source_end_us?: number; duration_us?: number; layout?: TimelineLayout }
  | { op: "insert_transcript_segments"; transcript_id: TranscriptId; segment_ids: TranscriptSegmentId[]; at_index: number; padding_before_us: number; padding_after_us: number; create_captions: boolean; layout?: TimelineLayout }
  | { op: "remove_clip"; clip_id: TimelineClipId }
  | { op: "move_clip"; clip_id: TimelineClipId; to_index: number }
  | { op: "trim_clip"; clip_id: TimelineClipId; source_start_us: number; source_end_us: number }
  | { op: "split_clip"; clip_id: TimelineClipId; source_time_us: number }
  | { op: "set_layout"; clip_id: TimelineClipId; layout: TimelineLayout }
  | { op: "set_audio"; clip_id: TimelineClipId; enabled: boolean; gain_db: number }
  | { op: "set_image_duration"; clip_id: TimelineClipId; duration_us: number }
  | { op: "add_caption"; start_us: number; end_us: number; text: string; preset_id: CaptionPresetId; source_clip_id: null }
  | { op: "remove_caption"; caption_id: TimelineCaptionId }
  | { op: "update_caption"; caption_id: TimelineCaptionId; text: string }
  | { op: "set_caption_timing"; caption_id: TimelineCaptionId; start_us: number; end_us: number }
  | { op: "set_caption_preset"; caption_id: TimelineCaptionId; preset_id: CaptionPresetId };
export interface TimelinePatch { schema_version: 1; base_revision_id: TimelineRevisionId; operations: TimelinePatchOperation[]; summary: string; }
export interface TimelineRevisionPointerInput { base_revision_id: TimelineRevisionId; }

export class ContractValidationError extends Error {
  constructor(public readonly contract: string, message = "Invalid contract payload") {
    super(`${contract}: ${message}`);
    this.name = "ContractValidationError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const JOB_STATUSES: JobStatus[] = ["queued", "running", "succeeded", "failed", "cancelling", "cancelled", "interrupted"];
const JOB_KINDS: JobKind[] = ["asset_probe", "asset_fingerprint", "proxy", "portrait_sample", "vertical_sample", "model_download", "transcription", "authoritative_preview", "final_export"];
const PROJECT_STATUSES: ProjectStatus[] = ["active", "archived", "missing"];
const ASSET_KINDS: AssetKind[] = ["video", "audio", "image", "text"];
const ASSET_AVAILABILITIES: AssetAvailability[] = ["available", "missing", "changed", "unsupported"];
const MODEL_INSTALL_STATUSES: ModelInstallStatus[] = ["unavailable", "queued", "downloading", "paused", "verifying", "ready", "cancelled", "failed"];
const PROVIDER_STATUSES: AsrProviderStatus[] = ["unavailable", "installed", "corrupt", "runtime_unavailable"];
const TRANSCRIPT_STATUSES: TranscriptStatus[] = ["pending", "ready", "stale", "failed"];
const TIMELINE_LAYOUTS: TimelineLayout[] = ["blurred_background", "crop_fill", "fit"];
const CAPTION_PRESETS: CaptionPresetId[] = ["default-bottom", "game-safe-bottom", "high-contrast"];
const TIMELINE_CREATED_BY: TimelineCreatedBy[] = ["user", "system", "import"];
const RENDER_MODES: RenderMode[] = ["authoritative_preview", "final_export"];
const RENDER_ARTIFACT_STATUSES: RenderArtifactStatus[] = ["ready", "stale"];
const EXPORT_STATUSES: ExportStatus[] = ["succeeded", "missing"];
const ENCODER_MODES: EncoderMode[] = ["auto", "software"];
const RENDER_PROFILE_IDS: RenderProfileId[] = ["preview-portrait-v1", "export-portrait-v1"];

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

export function asEntityId<T extends GrantId | ProjectId | AssetId | MediaId | JobId | ArtifactId | ModelId | TranscriptId | TranscriptSegmentId | TranscriptWordId | TimelineRevisionId | TimelineClipId | TimelineCaptionId | RenderArtifactId | ExportRecordId | DestinationGrantId | PlaybackTicketId>(value: string): T {
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

export function isTimelineLayout(value: unknown): value is TimelineLayout { return oneOf(TIMELINE_LAYOUTS, value); }
export function isCaptionPresetId(value: unknown): value is CaptionPresetId { return oneOf(CAPTION_PRESETS, value); }
export function isTimelineCreatedBy(value: unknown): value is TimelineCreatedBy { return oneOf(TIMELINE_CREATED_BY, value); }
export function isEncoderMode(value: unknown): value is EncoderMode { return oneOf(ENCODER_MODES, value); }
export function isRenderProfileId(value: unknown): value is RenderProfileId { return oneOf(RENDER_PROFILE_IDS, value); }

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
export function isRenderedMediaInfo(value: unknown): value is RenderedMediaInfo {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["duration_us", "format_name", "video", "audio"]) || !isInteger(value.duration_us, 1) || !isString(value.format_name) || value.format_name.length === 0 || !isRecord(value.video) || !onlyKeys(value.video, ["codec", "width", "height", "pixel_format", "fps_num", "fps_den"])) return false;
  if (!isString(value.video.codec) || value.video.codec.length === 0 || !isInteger(value.video.width, 1) || !isInteger(value.video.height, 1) || !isString(value.video.pixel_format) || value.video.pixel_format.length === 0 || !isInteger(value.video.fps_num, 1) || !isInteger(value.video.fps_den, 1)) return false;
  return value.audio === null || (isRecord(value.audio) && onlyKeys(value.audio, ["codec", "sample_rate", "channels"]) && isString(value.audio.codec) && value.audio.codec.length > 0 && isInteger(value.audio.sample_rate, 1) && isInteger(value.audio.channels, 1));
}
export function isRenderArtifact(value: unknown): value is RenderArtifact {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["render_artifact_id", "project_id", "timeline_revision_id", "kind", "status", "content_fingerprint", "profile_id", "display_name", "size_bytes", "sha256", "media_info", "encoder", "fallback_reason", "created_at"]) &&
    isId(value.render_artifact_id) && isId(value.project_id) && isId(value.timeline_revision_id) && oneOf(RENDER_MODES, value.kind) && oneOf(RENDER_ARTIFACT_STATUSES, value.status) && isString(value.content_fingerprint) && value.content_fingerprint.length > 0 && isRenderProfileId(value.profile_id) &&
    ((value.kind === "authoritative_preview" && value.profile_id === "preview-portrait-v1") || (value.kind === "final_export" && value.profile_id === "export-portrait-v1")) && isString(value.display_name) && value.display_name.length > 0 && isInteger(value.size_bytes, 1) && isSha256(value.sha256) && isRenderedMediaInfo(value.media_info) && isString(value.encoder) && value.encoder.length > 0 && isNullableString(value.fallback_reason) && isTime(value.created_at);
}
export function isAuthoritativePreview(value: unknown): value is AuthoritativePreview { return isRenderArtifact(value) && value.kind === "authoritative_preview" && value.profile_id === "preview-portrait-v1"; }
export function isExportRecord(value: unknown): value is ExportRecord {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["export_record_id", "project_id", "timeline_revision_id", "render_artifact_id", "status", "profile_id", "destination_display_name", "size_bytes", "sha256", "media_info", "encoder", "fallback_reason", "created_at"]) &&
    isId(value.export_record_id) && isId(value.project_id) && isId(value.timeline_revision_id) && isId(value.render_artifact_id) && oneOf(EXPORT_STATUSES, value.status) && value.profile_id === "export-portrait-v1" && isString(value.destination_display_name) && value.destination_display_name.length > 0 && isInteger(value.size_bytes, 1) && isSha256(value.sha256) && isRenderedMediaInfo(value.media_info) && isString(value.encoder) && value.encoder.length > 0 && isNullableString(value.fallback_reason) && isTime(value.created_at);
}
export function isDestinationGrant(value: unknown): value is DestinationGrant {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["destination_grant_id", "display_name", "extension", "overwrite_authorized", "expires_at"]) && isId(value.destination_grant_id) && isString(value.display_name) && value.display_name.length > 0 && value.extension === ".mp4" && typeof value.overwrite_authorized === "boolean" && isTime(value.expires_at);
}
export function isPreviewCreateInput(value: unknown): value is PreviewCreateInput {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["timeline_revision_id", "encoder_mode"]) && (value.timeline_revision_id === undefined || isId(value.timeline_revision_id)) && (value.encoder_mode === undefined || isEncoderMode(value.encoder_mode));
}
export function isPreviewCreateResponse(value: unknown): value is PreviewCreateResponse {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["job", "preview", "reused"]) || !(value.job === null || isJob(value.job)) || !(value.preview === null || isAuthoritativePreview(value.preview)) || typeof value.reused !== "boolean") return false;
  return value.reused ? value.job === null && value.preview !== null && value.preview.status === "ready" : value.job !== null && value.preview === null && value.job.kind === "authoritative_preview";
}
export function isExportCreateInput(value: unknown): value is ExportCreateInput {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["timeline_revision_id", "destination_grant_id", "encoder_mode"]) && (value.timeline_revision_id === undefined || isId(value.timeline_revision_id)) && isId(value.destination_grant_id) && (value.encoder_mode === undefined || isEncoderMode(value.encoder_mode));
}
export function isExportCreateResponse(value: unknown): value is ExportCreateResponse {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["job", "export_record"]) && isJob(value.job) && value.job.kind === "final_export" && (value.export_record === null || isExportRecord(value.export_record));
}
function isTimelineCanvas(value: unknown): value is TimelineCanvas {
  return isRecord(value) && onlyKeys(value, ["width", "height", "fps_num", "fps_den", "background_color"]) &&
    isInteger(value.width, 1) && isInteger(value.height, 1) && isInteger(value.fps_num, 1) && isInteger(value.fps_den, 1) &&
    isString(value.background_color) && /^#[0-9A-Fa-f]{6}$/.test(value.background_color);
}
export function isTimelineClip(value: unknown): value is TimelineClip {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["clip_id", "track_id", "order_index", "asset_id", "asset_kind", "source_start_us", "source_end_us", "timeline_start_us", "timeline_end_us", "layout", "audio"])) return false;
  if (!isId(value.clip_id) || value.track_id !== "V1" || !isInteger(value.order_index) || !isId(value.asset_id) || !oneOf(["video", "image"] as const, value.asset_kind) ||
    !isInteger(value.timeline_start_us) || !isInteger(value.timeline_end_us, 1) || value.timeline_end_us <= value.timeline_start_us || !isTimelineLayout(value.layout) || !isRecord(value.audio) ||
    !onlyKeys(value.audio, ["enabled", "gain_db"]) || typeof value.audio.enabled !== "boolean" || !isFiniteNumber(value.audio.gain_db) || value.audio.gain_db < -60 || value.audio.gain_db > 12) return false;
  if (value.asset_kind === "image") return value.source_start_us === null && value.source_end_us === null && value.timeline_end_us - value.timeline_start_us >= 500_000 && value.timeline_end_us - value.timeline_start_us <= 30_000_000;
  return isInteger(value.source_start_us) && isInteger(value.source_end_us, 1) && value.source_end_us - value.source_start_us >= 100_000 && value.timeline_end_us - value.timeline_start_us === value.source_end_us - value.source_start_us;
}
export function isTimelineCaption(value: unknown): value is TimelineCaption {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["caption_id", "track_id", "source_clip_id", "start_us", "end_us", "text", "preset_id", "origin", "edited", "source_segment_ids"])) return false;
  if (!isId(value.caption_id) || value.track_id !== "C1" || !(value.source_clip_id === null || isId(value.source_clip_id)) || !isInteger(value.start_us) || !isInteger(value.end_us, 1) || value.end_us - value.start_us < 200_000 ||
    !isString(value.text) || value.text.trim().length < 1 || [...value.text].length > 200 || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.text) || !isCaptionPresetId(value.preset_id) || !oneOf(["transcript", "user"] as const, value.origin) || typeof value.edited !== "boolean" || !Array.isArray(value.source_segment_ids) || !value.source_segment_ids.every(isId)) return false;
  return value.origin === "transcript" ? value.source_clip_id !== null && value.source_segment_ids.length > 0 : value.source_segment_ids.length === 0;
}
export function isTimelineDocument(value: unknown): value is TimelineDocument {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["schema_version", "project_id", "canvas", "tracks", "clips", "captions", "provenance"]) || value.schema_version !== 1 || !isId(value.project_id) || !isTimelineCanvas(value.canvas) || !Array.isArray(value.tracks) || value.tracks.length !== 2 || !Array.isArray(value.clips) || !value.clips.every(isTimelineClip) || !Array.isArray(value.captions) || !value.captions.every(isTimelineCaption) || !isRecord(value.provenance)) return false;
  const [visual, caption] = value.tracks;
  if (!isRecord(visual) || !isRecord(caption) || JSON.stringify(visual) !== JSON.stringify({ id: "V1", kind: "visual", locked: Boolean(visual.locked) }) || JSON.stringify(caption) !== JSON.stringify({ id: "C1", kind: "caption", locked: Boolean(caption.locked) })) return false;
  if (!onlyKeys(value.provenance, ["created_by", "source_transcript_ids"]) || !isTimelineCreatedBy(value.provenance.created_by) || !Array.isArray(value.provenance.source_transcript_ids) || !value.provenance.source_transcript_ids.every(isId)) return false;
  let end = 0;
  for (let index = 0; index < value.clips.length; index += 1) { const clip = value.clips[index]; if (clip.order_index !== index || clip.timeline_start_us !== end) return false; end = clip.timeline_end_us; }
  const captions = [...value.captions].sort((a, b) => a.start_us - b.start_us);
  return captions.every((item, index) => item.end_us <= end && (index === 0 || captions[index - 1].end_us <= item.start_us));
}
export function isTimelineRevisionSummary(value: unknown): value is TimelineRevisionSummary {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["timeline_revision_id", "project_id", "parent_revision_id", "document_sha256", "summary", "created_by", "created_at"]) && isId(value.timeline_revision_id) && isId(value.project_id) && (value.parent_revision_id === null || isId(value.parent_revision_id)) && isSha256(value.document_sha256) && isString(value.summary) && isTimelineCreatedBy(value.created_by) && isTime(value.created_at);
}
export function isTimelineRevision(value: unknown): value is TimelineRevision {
  if (!isRecord(value) || value.schema_version !== 1 || !isTimelineDocument(value.document)) return false;
  const summary = { ...value }; delete summary.schema_version; delete summary.document;
  return isTimelineRevisionSummary(summary) && value.project_id === value.document.project_id;
}
export function isTimelineDraft(value: unknown): value is TimelineDraft {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["project_id", "base_revision_id", "document", "updated_at", "conflict"]) && isId(value.project_id) && isId(value.base_revision_id) && isTimelineDocument(value.document) && value.document.project_id === value.project_id && isTime(value.updated_at) && typeof value.conflict === "boolean";
}
export function isTimelineState(value: unknown): value is TimelineState {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["project_id", "current_revision", "draft", "can_undo", "can_redo", "current_preview"]) && isId(value.project_id) && isTimelineRevision(value.current_revision) && value.current_revision.project_id === value.project_id && (value.draft === null || isTimelineDraft(value.draft)) && typeof value.can_undo === "boolean" && typeof value.can_redo === "boolean" && (value.current_preview === null || (isAuthoritativePreview(value.current_preview) && value.current_preview.project_id === value.project_id));
}
export function isTimelineCreateInput(value: unknown): value is TimelineCreateInput {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["schema_version", "source", "default_layout", "caption_preset_id"]) || value.schema_version !== 1 || !isRecord(value.source) || !isTimelineLayout(value.default_layout) || !isCaptionPresetId(value.caption_preset_id)) return false;
  if (value.source.kind === "empty") return onlyKeys(value.source, ["kind"]);
  if (value.source.kind === "full_asset") return onlyKeys(value.source, ["kind", "asset_id"]) && isId(value.source.asset_id);
  return value.source.kind === "transcript_selection" && onlyKeys(value.source, ["kind", "transcript_id", "segment_ids", "padding_before_us", "padding_after_us", "create_captions"]) && isId(value.source.transcript_id) && Array.isArray(value.source.segment_ids) && value.source.segment_ids.length > 0 && value.source.segment_ids.every(isId) && isInteger(value.source.padding_before_us) && value.source.padding_before_us <= 300_000 && isInteger(value.source.padding_after_us) && value.source.padding_after_us <= 300_000 && typeof value.source.create_captions === "boolean";
}
export function isTimelinePatchOperation(value: unknown): value is TimelinePatchOperation {
  if (!isRecord(value) || hasSensitiveKey(value) || !isString(value.op)) return false;
  const index = (key: string) => isInteger(value[key]); const id = (key: string) => isId(value[key]); const us = (key: string, minimum = 0) => isInteger(value[key], minimum);
  switch (value.op) {
    case "insert_asset_clip": return onlyKeys(value, ["op", "asset_id", "at_index", "source_start_us", "source_end_us", "duration_us", "layout"]) && id("asset_id") && index("at_index") && (value.source_start_us === undefined || us("source_start_us")) && (value.source_end_us === undefined || us("source_end_us", 1)) && (value.duration_us === undefined || us("duration_us", 500_000)) && (value.layout === undefined || isTimelineLayout(value.layout));
    case "insert_transcript_segments": return onlyKeys(value, ["op", "transcript_id", "segment_ids", "at_index", "padding_before_us", "padding_after_us", "create_captions", "layout"]) && id("transcript_id") && Array.isArray(value.segment_ids) && value.segment_ids.length > 0 && value.segment_ids.every(isId) && index("at_index") && us("padding_before_us") && Number(value.padding_before_us) <= 300_000 && us("padding_after_us") && Number(value.padding_after_us) <= 300_000 && typeof value.create_captions === "boolean" && (value.layout === undefined || isTimelineLayout(value.layout));
    case "remove_clip": return onlyKeys(value, ["op", "clip_id"]) && id("clip_id");
    case "move_clip": return onlyKeys(value, ["op", "clip_id", "to_index"]) && id("clip_id") && index("to_index");
    case "trim_clip": return onlyKeys(value, ["op", "clip_id", "source_start_us", "source_end_us"]) && id("clip_id") && us("source_start_us") && us("source_end_us", 1) && Number(value.source_end_us) - Number(value.source_start_us) >= 100_000;
    case "split_clip": return onlyKeys(value, ["op", "clip_id", "source_time_us"]) && id("clip_id") && us("source_time_us", 1);
    case "set_layout": return onlyKeys(value, ["op", "clip_id", "layout"]) && id("clip_id") && isTimelineLayout(value.layout);
    case "set_audio": return onlyKeys(value, ["op", "clip_id", "enabled", "gain_db"]) && id("clip_id") && typeof value.enabled === "boolean" && isFiniteNumber(value.gain_db) && value.gain_db >= -60 && value.gain_db <= 12;
    case "set_image_duration": return onlyKeys(value, ["op", "clip_id", "duration_us"]) && id("clip_id") && us("duration_us", 500_000) && Number(value.duration_us) <= 30_000_000;
    case "add_caption": return onlyKeys(value, ["op", "start_us", "end_us", "text", "preset_id", "source_clip_id"]) && us("start_us") && us("end_us", 1) && Number(value.end_us) - Number(value.start_us) >= 200_000 && isString(value.text) && value.text.trim().length > 0 && [...value.text].length <= 200 && isCaptionPresetId(value.preset_id) && value.source_clip_id === null;
    case "remove_caption": return onlyKeys(value, ["op", "caption_id"]) && id("caption_id");
    case "update_caption": return onlyKeys(value, ["op", "caption_id", "text"]) && id("caption_id") && isString(value.text) && value.text.trim().length > 0 && [...value.text].length <= 200;
    case "set_caption_timing": return onlyKeys(value, ["op", "caption_id", "start_us", "end_us"]) && id("caption_id") && us("start_us") && us("end_us", 1) && Number(value.end_us) - Number(value.start_us) >= 200_000;
    case "set_caption_preset": return onlyKeys(value, ["op", "caption_id", "preset_id"]) && id("caption_id") && isCaptionPresetId(value.preset_id);
    default: return false;
  }
}
export function isTimelinePatch(value: unknown): value is TimelinePatch {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["schema_version", "base_revision_id", "operations", "summary"]) && value.schema_version === 1 && isId(value.base_revision_id) && Array.isArray(value.operations) && value.operations.length > 0 && value.operations.length <= 100 && value.operations.every(isTimelinePatchOperation) && isString(value.summary) && value.summary.trim().length > 0;
}
export function isTimelineDraftInput(value: unknown): value is TimelineDraftInput {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["schema_version", "base_revision_id", "document"]) && value.schema_version === 1 && isId(value.base_revision_id) && isTimelineDocument(value.document);
}
export function parseTimelineState(value: unknown): TimelineState { if (!isTimelineState(value)) throw new ContractValidationError("TimelineState"); return value; }
export function parseTimelineRevision(value: unknown): TimelineRevision { if (!isTimelineRevision(value)) throw new ContractValidationError("TimelineRevision"); return value; }
export function parseTimelineDraft(value: unknown): TimelineDraft { if (!isTimelineDraft(value)) throw new ContractValidationError("TimelineDraft"); return value; }
export function parseTimelineCreateInput(value: unknown): TimelineCreateInput { if (!isTimelineCreateInput(value)) throw new ContractValidationError("TimelineCreateInput"); return value; }
export function parseTimelinePatch(value: unknown): TimelinePatch { if (!isTimelinePatch(value)) throw new ContractValidationError("TimelinePatch"); return value; }
export function parseRenderedMediaInfo(value: unknown): RenderedMediaInfo { if (!isRenderedMediaInfo(value)) throw new ContractValidationError("RenderedMediaInfo"); return value; }
export function parseRenderArtifact(value: unknown): RenderArtifact { if (!isRenderArtifact(value)) throw new ContractValidationError("RenderArtifact"); return value; }
export function parseAuthoritativePreview(value: unknown): AuthoritativePreview { if (!isAuthoritativePreview(value)) throw new ContractValidationError("AuthoritativePreview"); return value; }
export function parseExportRecord(value: unknown): ExportRecord { if (!isExportRecord(value)) throw new ContractValidationError("ExportRecord"); return value; }
export function parseDestinationGrant(value: unknown): DestinationGrant { if (!isDestinationGrant(value)) throw new ContractValidationError("DestinationGrant"); return value; }
export function parsePreviewCreateInput(value: unknown): PreviewCreateInput { if (!isPreviewCreateInput(value)) throw new ContractValidationError("PreviewCreateInput"); return value; }
export function parsePreviewCreateResponse(value: unknown): PreviewCreateResponse { if (!isPreviewCreateResponse(value)) throw new ContractValidationError("PreviewCreateResponse"); return value; }
export function parseExportCreateInput(value: unknown): ExportCreateInput { if (!isExportCreateInput(value)) throw new ContractValidationError("ExportCreateInput"); return value; }
export function parseExportCreateResponse(value: unknown): ExportCreateResponse { if (!isExportCreateResponse(value)) throw new ContractValidationError("ExportCreateResponse"); return value; }
