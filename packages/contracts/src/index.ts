export const PROTOCOL_VERSION = 1 as const;
export const API_PREFIX = "/api/v1" as const;
export const CONTRACT_VERSION = "stage6r-v1" as const;

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
export type BriefId = string & { readonly __brand: "brief_id" };
export type RecipeId = string & { readonly __brand: "recipe_id" };
export type ProviderConfigId = string & { readonly __brand: "provider_config_id" };
export type EgressPreviewId = string & { readonly __brand: "egress_preview_id" };
export type CandidateGenerationId = string & { readonly __brand: "candidate_generation_id" };
export type ProviderInvocationId = string & { readonly __brand: "provider_invocation_id" };
export type CandidatePlanId = string & { readonly __brand: "candidate_plan_id" };
export type TimelinePatchEgressPreviewId = string & { readonly __brand: "timeline_patch_egress_preview_id" };
export type TimelinePatchGenerationId = string & { readonly __brand: "timeline_patch_generation_id" };
export type TimelinePatchProposalId = string & { readonly __brand: "timeline_patch_proposal_id" };
export type PlatformPresetId = string & { readonly __brand: "platform_preset_id" };
export type RenditionPresetId = string & { readonly __brand: "rendition_preset_id" };
export type RenditionSnapshotId = string & { readonly __brand: "rendition_snapshot_id" };
export type DirectoryGrantId = string & { readonly __brand: "directory_grant_id" };
export type ExportBatchId = string & { readonly __brand: "export_batch_id" };
export type ExportBatchItemId = string & { readonly __brand: "export_batch_item_id" };
export type RenditionReframeSnapshotId = string & { readonly __brand: "rendition_reframe_snapshot_id" };
export type ReframeExportBatchId = string & { readonly __brand: "reframe_export_batch_id" };
export type ReframeExportBatchItemId = string & { readonly __brand: "reframe_export_batch_item_id" };
export type MediaGenerationRequestId = string & { readonly __brand: "media_generation_request_id" };
export type MediaGenerationTaskId = string & { readonly __brand: "media_generation_task_id" };
export type ShotListId = string & { readonly __brand: "shot_list_id" };
export type ShotListRevisionId = string & { readonly __brand: "shot_list_revision_id" };
export type ShotRequirementId = string & { readonly __brand: "shot_requirement_id" };
export type ProviderImagePreviewId = string & { readonly __brand: "provider_image_preview_id" };
export type ProviderImageProvenanceId = string & { readonly __brand: "provider_image_provenance_id" };

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
  | "candidate_generation"
  | "timeline_patch_generation"
  | "authoritative_preview"
  | "final_export"
  | "media_generation";
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
  | "preparing"
  | "awaiting_confirmation"
  | "invoking_provider"
  | "validating_candidate"
  | "loading_snapshot"
  | "calling_provider"
  | "validating_response"
  | "applying_patch_in_memory"
  | "computing_diff"
  | "persisting_proposal"
  | (string & {});
export type ModelInstallStatus = "unavailable" | "queued" | "downloading" | "paused" | "verifying" | "ready" | "cancelled" | "failed" | "corrupt";
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
  "TIMELINE_LOCKED", "TIMELINE_DIFF_INVALID", "TIMELINE_PATCH_EGRESS_EXPIRED",
  "TIMELINE_TRANSITION_EXISTS", "TIMELINE_TRANSITION_INVALID",
  "TIMELINE_PATCH_EGRESS_MISMATCH", "TIMELINE_PATCH_GENERATION_NOT_FOUND",
  "TIMELINE_PATCH_GENERATION_INVALID", "TIMELINE_PATCH_PROPOSAL_NOT_FOUND",
  "TIMELINE_PATCH_PROPOSAL_INVALID", "TIMELINE_PATCH_PROPOSAL_CONFLICT",
  "TIMELINE_PATCH_PROPOSAL_APPLIED", "TIMELINE_PATCH_PROVIDER_UNTESTED", "TIMELINE_PATCH_PROVIDER_UNSUPPORTED",
  "TIMELINE_OPERATION_UNSUPPORTED", "RENDER_PLAN_INVALID", "RENDER_INPUT_CHANGED",
  "RENDER_FONT_MISSING", "RENDER_FAILED", "RENDER_VALIDATION_FAILED", "RENDER_VALIDATION_TIMEOUT", "PREVIEW_NOT_FOUND",
  "EXPORT_NOT_FOUND", "EXPORT_DESTINATION_INVALID", "EXPORT_DESTINATION_EXISTS",
  "EXPORT_DESTINATION_EXPIRED", "EXPORT_DISK_SPACE_INSUFFICIENT", "ARTIFACT_NOT_FOUND",
  "PLAYBACK_TICKET_INVALID"
  , "PLATFORM_PRESET_INVALID", "RENDITION_PRESET_INVALID", "RENDITION_NOT_ALLOWED_FOR_PLATFORM",
  "RENDITION_SNAPSHOT_INVALID", "RENDITION_PREVIEW_REQUIRED", "RENDITION_PREVIEW_STALE",
  "EXPORT_BATCH_INVALID", "EXPORT_BATCH_ITEM_DUPLICATE", "EXPORT_DIRECTORY_GRANT_INVALID",
  "EXPORT_DIRECTORY_GRANT_EXPIRED", "EXPORT_DIRECTORY_GRANT_CLAIMED", "EXPORT_RETRY_NOT_ALLOWED"
  , "REFRAME_SNAPSHOT_INVALID", "REFRAME_ADJUSTMENT_DUPLICATE", "REFRAME_CLIP_NOT_FOUND",
  "REFRAME_NOT_APPLICABLE", "REFRAME_ANCHOR_INVALID", "REFRAME_PREVIEW_REQUIRED",
  "REFRAME_PREVIEW_STALE", "REFRAME_BATCH_INVALID", "REFRAME_BATCH_ITEM_DUPLICATE",
  "REFRAME_RETRY_NOT_ALLOWED"
  , "CANDIDATE_PROVIDER_UNTESTED", "CANDIDATE_PROVIDER_UNSUPPORTED",
  "CANDIDATE_RESPONSE_ADAPTER_INVALID", "CANDIDATE_CAPABILITY_STALE",
  "CANDIDATE_CANDIDATESCRIPT_INVALID", "CANDIDATE_EGRESS_PAYLOAD_UNAVAILABLE"
  , "GENERATION_REQUEST_INVALID", "GENERATION_KIND_UNSUPPORTED", "GENERATION_INPUT_CHANGED",
  "GENERATION_HASH_MISMATCH", "GENERATION_OUTPUT_INVALID", "GENERATION_INTERRUPTED",
  "GENERATION_RETRY_NOT_ALLOWED", "GENERATION_TASK_NOT_FOUND"
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
  /** C22 渲染校验细分阶段：preparing/encoding/validating_probe/validating_decode/hashing/publishing；旧 UI 忽略即可。 */
  phase?: string | null;
  /** 细分阶段进度 0..1；null = 该阶段无可靠进度（不定进度，UI 显示活动态）。 */
  phase_progress?: number | null;
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

export type ProviderKind = "openai_compatible_text";
export type CredentialStatus = "missing" | "configured" | "unavailable";
export type TimelinePatchCapabilityStatus = "untested" | "supported" | "unsupported";
export type CandidateCapabilityStatus = "untested" | "supported" | "unsupported";
/**
 * 仅供 Core 持久化及进程内路由使用的固定认证适配器白名单。
 * Renderer 不得据此显示或选择 Provider 协议细节。
 */
export type TimelinePatchResponseAdapterId =
  | "openai_responses_json_schema_v1"
  | "openai_responses_patchscript_v1"
  | "openai_chat_completions_json_schema_v1"
  | "openai_chat_completions_patchscript_v1";
export type CandidateResponseAdapterId =
  | "openai_responses_json_schema_v1"
  | "openai_responses_candidatescript_v1"
  | "openai_chat_completions_json_schema_v1"
  | "openai_chat_completions_candidatescript_v1";
export type OriginalAudioPolicy = "preserve" | "mute";
export type CaptionPolicy = "auto_from_transcript" | "none";
export type CandidateVariant = "balanced" | "compact" | "bold";
export type CandidateGenerationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type ProviderInvocationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface Brief {
  schema_version: 1; brief_id: BriefId; project_id: ProjectId; topic: string; audience: string;
  target_platform: "generic_vertical"; target_duration_us: number; narrative_goal: string; style_notes: string;
  must_keep: string[]; forbidden: string[]; original_audio_policy: OriginalAudioPolicy; caption_policy: CaptionPolicy;
  caption_preset_id: CaptionPresetId; default_layout: TimelineLayout; document_sha256: string;
}
export interface BriefInput extends Omit<Brief, "brief_id" | "project_id" | "document_sha256"> {}
export interface Recipe {
  schema_version: 1; recipe_id: RecipeId; name: string; summary: string; rules: { selection: string; pace: string; max_gap_us: number }; document_sha256: string;
}
export interface ProviderConfig {
  provider_config_id: ProviderConfigId; kind: ProviderKind; display_name: string; base_url: string; model: string;
  enabled: boolean; credential_status: CredentialStatus; input_price_per_million: number | null;
  output_price_per_million: number | null; timeline_patch_capability_status: TimelinePatchCapabilityStatus;
  timeline_patch_response_adapter_id: TimelinePatchResponseAdapterId | null; timeline_patch_probe_protocol_version: string | null;
  timeline_patch_capability_tested_at: string | null; timeline_patch_capability_failure_code: ErrorCode | null;
  timeline_patch_capability_probe_sha256: string | null;
  candidate_capability_status: CandidateCapabilityStatus;
  candidate_response_adapter_id: CandidateResponseAdapterId | null; candidate_probe_protocol_version: string | null;
  candidate_capability_tested_at: string | null; candidate_capability_failure_code: ErrorCode | null;
  candidate_capability_probe_sha256: string | null; created_at: string; updated_at: string;
}
export interface TimelinePatchCapabilityTestResponse {
  timeline_patch_capability_status: TimelinePatchCapabilityStatus;
  timeline_patch_response_adapter_id: TimelinePatchResponseAdapterId | null; timeline_patch_probe_protocol_version: string | null;
  timeline_patch_capability_tested_at: string | null; timeline_patch_capability_failure_code: ErrorCode | null;
  timeline_patch_capability_probe_sha256: string | null;
}
export interface ProviderCapabilityTestResult {
  candidate_capability_status: CandidateCapabilityStatus;
  candidate_response_adapter_id: CandidateResponseAdapterId | null; candidate_probe_protocol_version: string | null;
  candidate_capability_tested_at: string | null; candidate_capability_failure_code: ErrorCode | null;
  candidate_capability_probe_sha256: string | null;
}
export interface EgressPreview {
  egress_preview_id: EgressPreviewId; provider: { display_name: string; origin: string; model: string };
  prompt_template_version: string; sent_fields: string[]; payload_sha256: string; expires_at: string;
  payload: Record<string, unknown>; stats: { transcript_count: number; segment_count: number; character_count: number; estimated_tokens: number };
}
export interface CandidateClip {
  clip_id: string; order_index: number; asset_id: AssetId; transcript_id: TranscriptId; segment_ids: TranscriptSegmentId[];
  source_start_us: number; source_end_us: number; reason: string; model_score: number | null; caption_text: string;
}
export interface CandidatePlan {
  candidate_plan_id: CandidatePlanId; project_id: ProjectId; candidate_generation_id: CandidateGenerationId; variant: CandidateVariant;
  schema_version: 1; ordinal: number; title_suggestion: string; summary: string; duration_us: number; clips: CandidateClip[]; warnings: string[]; document_sha256: string;
}
export interface CandidateGeneration {
  candidate_generation_id: CandidateGenerationId; project_id: ProjectId; status: CandidateGenerationStatus; payload_sha256: string;
  created_at: string; updated_at: string; finished_at: string | null; candidate_plans?: CandidatePlan[];
}
export interface ProviderInvocation {
  provider_config_id: ProviderConfigId; provider_invocation_id: ProviderInvocationId; status: ProviderInvocationStatus;
}
export interface CandidateAdoption { schema_version: 1; candidate_document_sha256: string; base_revision_id: TimelineRevisionId | null; }

export type TimelineCreatedBy = "user" | "system" | "import";
export type TimelineLayout = "blurred_background" | "crop_fill" | "fit";
export type TimelineClipKind = "video" | "image" | "audio";
export type CaptionOrigin = "transcript" | "user";
export type CaptionPresetId = "default-bottom" | "game-safe-bottom" | "high-contrast";
export type RenderMode = "authoritative_preview" | "final_export";
export type RenderArtifactStatus = "ready" | "stale";
export type ExportStatus = "succeeded" | "missing";
export type EncoderMode = "auto" | "software";
/** 工具栏"比例"下拉可选值；"fit" 表示跟随时间线默认画幅。 */
export type OutputRatio = "fit" | "169" | "916" | "11" | "43" | "34";
export const OUTPUT_RATIOS: OutputRatio[] = ["fit", "169", "916", "11", "43", "34"];
export function isOutputRatio(value: unknown): value is OutputRatio { return oneOf(OUTPUT_RATIOS, value); }
export type LegacyRenderProfileId = "preview-portrait-v1" | "export-portrait-v1";
export type TargetRenderProfileId = "preview-portrait-9x16-v1" | "export-portrait-9x16-v1" | "preview-landscape-16x9-v1" | "export-landscape-16x9-v1";
// 前端"比例"下拉 → 权威预览/导出渲染档位（与 aivs_core.rendering.plan 保持一致）。
export type RatioRenderProfileId = "preview-169-v1" | "preview-916-v1" | "preview-11-v1" | "preview-43-v1" | "preview-34-v1" | "export-169-v1" | "export-916-v1" | "export-11-v1" | "export-43-v1" | "export-34-v1";
export type PreviewRenderProfileId = "preview-portrait-v1" | "preview-portrait-9x16-v1" | "preview-landscape-16x9-v1" | "preview-169-v1" | "preview-916-v1" | "preview-11-v1" | "preview-43-v1" | "preview-34-v1";
export type RenderProfileId = LegacyRenderProfileId | TargetRenderProfileId | RatioRenderProfileId;
export type ExportRenderProfileId = "export-portrait-v1" | "export-portrait-9x16-v1" | "export-landscape-16x9-v1" | "export-169-v1" | "export-916-v1" | "export-11-v1" | "export-43-v1" | "export-34-v1";

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
  profile_id: PreviewRenderProfileId;
}
export interface ExportRecord {
  export_record_id: ExportRecordId;
  project_id: ProjectId;
  timeline_revision_id: TimelineRevisionId;
  render_artifact_id: RenderArtifactId;
  status: ExportStatus;
  profile_id: ExportRenderProfileId;
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
export interface PreviewCreateInput { timeline_revision_id?: TimelineRevisionId; encoder_mode?: EncoderMode; output_ratio?: OutputRatio; }
export interface PreviewCreateResponse { job: Job | null; preview: AuthoritativePreview | null; reused: boolean; }
export interface ExportCreateInput { timeline_revision_id?: TimelineRevisionId; destination_grant_id: DestinationGrantId; encoder_mode?: EncoderMode; output_ratio?: OutputRatio; }
export interface ExportCreateResponse { job: Job; export_record: ExportRecord | null; }
export type AuthoritativePreviewPage = Page<AuthoritativePreview>;
export type ExportRecordPage = Page<ExportRecord>;

/** Stage 3A targeted rendition contracts.  These DTOs intentionally contain no
 * filesystem location, caption content, provider data, or unrestricted URL. */
export type LayoutPolicy = "preserve_timeline" | "fit_all" | "crop_fill_all" | "blurred_background_all";
export type RenditionWarningCode = "CENTER_CROP_MAY_HIDE_CONTENT" | "LETTERBOX_EXPECTED" | "PILLARBOX_EXPECTED";
export type ExportBatchItemStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type ExportBatchStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled" | "interrupted";
export interface PlatformPreset {
  schema_version: 1; platform_preset_id: PlatformPresetId; display_name: string; preset_version: 1;
  allowed_rendition_ids: RenditionPresetId[]; default_rendition_id: RenditionPresetId; filename_tag: string; document_sha256: string;
}
export interface RenditionPreset {
  schema_version: 1; rendition_preset_id: RenditionPresetId; display_name: string; preset_version: 1; document_sha256: string;
  preview_profile_id: TargetRenderProfileId; export_profile_id: TargetRenderProfileId;
  preview: { width: number; height: number }; export: { width: number; height: number };
}
export interface RenditionSnapshotSummary {
  rendition_snapshot_id: RenditionSnapshotId; project_id: ProjectId; timeline_revision_id: TimelineRevisionId;
  platform_preset_id: PlatformPresetId; rendition_preset_id: RenditionPresetId; layout_policy: LayoutPolicy;
  snapshot_sha256: string; warnings: RenditionWarningCode[]; created_at: string;
}
export interface RenditionPreview extends RenditionSnapshotSummary {
  render_artifact_id: RenderArtifactId; status: RenderArtifactStatus; profile_id: TargetRenderProfileId;
  display_name: string; size_bytes: number; sha256: string; media_info: RenderedMediaInfo; encoder: string; fallback_reason: string | null;
}
export interface RenditionPreviewCreateInput {
  timeline_revision_id: TimelineRevisionId; platform_preset_id: PlatformPresetId; rendition_preset_id: RenditionPresetId;
  layout_policy: LayoutPolicy; encoder_mode?: EncoderMode;
}
export interface RenditionPreviewCreateResponse { job: Job | null; preview: RenditionPreview | null; reused: boolean; }
export type RenditionPreviewPage = Page<RenditionPreview>;
export interface DirectoryGrant { directory_grant_id: DirectoryGrantId; display_name: string; expires_at: string; }
export interface ExportBatchCreateItem { rendition_snapshot_id: RenditionSnapshotId; preview_artifact_id: RenderArtifactId; encoder_mode?: EncoderMode; }
export interface ExportBatchCreateInput { timeline_revision_id: TimelineRevisionId; directory_grant_id: DirectoryGrantId; items: ExportBatchCreateItem[]; }
export interface ExportBatchItem {
  export_batch_item_id: ExportBatchItemId; ordinal: number; rendition_snapshot: RenditionSnapshotSummary;
  preview_artifact_id: RenderArtifactId; status: ExportBatchItemStatus; progress: number | null; job_id: JobId | null;
  destination_display_name: string | null; error_code: ErrorCode | null; export_record_id: ExportRecordId | null;
  retry_of_item_id: ExportBatchItemId | null;
}
export interface ExportBatch {
  export_batch_id: ExportBatchId; project_id: ProjectId; timeline_revision_id: TimelineRevisionId; status: ExportBatchStatus;
  directory_display_name: string; items: ExportBatchItem[]; retry_of_batch_id: ExportBatchId | null; created_at: string; updated_at: string;
}
export interface ExportBatchCreateResponse { batch: ExportBatch; jobs: Job[]; }
export interface ExportBatchRetryInput { directory_grant_id: DirectoryGrantId; export_batch_item_ids: ExportBatchItemId[]; }
export interface ExportBatchRetryResponse { batch: ExportBatch; jobs: Job[]; }
export type ExportBatchPage = Page<ExportBatch>;

export type HorizontalAnchor = "left" | "center" | "right";
export type VerticalAnchor = "top" | "center" | "bottom";
export type ReframeWarningCode = "STATIC_REFRAME_APPLIED" | "REFRAME_AXIS_NORMALIZED" | "REFRAME_MAY_HIDE_OPPOSITE_EDGE";
export type ReframeExportBatchItemStatus = ExportBatchItemStatus;
export type ReframeExportBatchStatus = ExportBatchStatus;
export interface RenditionReframeAdjustment {
  clip_id: TimelineClipId; horizontal_anchor: HorizontalAnchor; vertical_anchor: VerticalAnchor;
}
export interface RenditionReframePreviewCreateInput {
  base_rendition_snapshot_id: RenditionSnapshotId; adjustments: RenditionReframeAdjustment[]; encoder_mode?: EncoderMode;
}
export interface RenditionReframeSnapshotSummary {
  rendition_reframe_snapshot_id: RenditionReframeSnapshotId; project_id: ProjectId; timeline_revision_id: TimelineRevisionId;
  base_rendition_snapshot_id: RenditionSnapshotId; base_snapshot_sha256: string; platform_preset_id: PlatformPresetId;
  rendition_preset_id: RenditionPresetId; adjustment_count: number; reframe_snapshot_sha256: string;
  warnings: ReframeWarningCode[]; created_at: string;
}
export interface RenditionReframePreview extends RenditionReframeSnapshotSummary {
  render_artifact_id: RenderArtifactId; status: RenderArtifactStatus; profile_id: TargetRenderProfileId;
  display_name: string; size_bytes: number; sha256: string; media_info: RenderedMediaInfo; encoder: string; fallback_reason: string | null;
}
export interface RenditionReframePreviewCreateResponse { job: Job | null; preview: RenditionReframePreview | null; reused: boolean; }
export type RenditionReframePreviewPage = Page<RenditionReframePreview>;
export interface ReframeExportBatchCreateItem {
  rendition_reframe_snapshot_id: RenditionReframeSnapshotId; preview_artifact_id: RenderArtifactId; encoder_mode?: EncoderMode;
}
export interface ReframeExportBatchCreateInput { directory_grant_id: DirectoryGrantId; items: ReframeExportBatchCreateItem[]; }
export interface ReframeExportBatchItem {
  reframe_export_batch_item_id: ReframeExportBatchItemId; ordinal: number; rendition_reframe_snapshot: RenditionReframeSnapshotSummary;
  preview_artifact_id: RenderArtifactId; status: ReframeExportBatchItemStatus; progress: number | null; job_id: JobId | null;
  destination_display_name: string | null; error_code: ErrorCode | null; export_record_id: ExportRecordId | null;
  retry_of_item_id: ReframeExportBatchItemId | null;
}
export interface ReframeExportBatch {
  reframe_export_batch_id: ReframeExportBatchId; project_id: ProjectId; timeline_revision_id: TimelineRevisionId;
  status: ReframeExportBatchStatus; directory_display_name: string; items: ReframeExportBatchItem[];
  retry_of_batch_id: ReframeExportBatchId | null; created_at: string; updated_at: string;
}
export interface ReframeExportBatchCreateResponse { batch: ReframeExportBatch; jobs: Job[]; }
export interface ReframeExportBatchRetryInput { directory_grant_id: DirectoryGrantId; reframe_export_batch_item_ids: ReframeExportBatchItemId[]; }
export interface ReframeExportBatchRetryResponse { batch: ReframeExportBatch; jobs: Job[]; }
export type ReframeExportBatchPage = Page<ReframeExportBatch>;

export interface TimelineCanvas extends ProjectCanvas { background_color: string; }
/** 轨道类型：视频（主轨/覆盖轨）、文本（字幕/文字）、音频。 */
export type TimelineTrackKind = "video" | "text" | "audio";
export interface TimelineTrack { id: string; kind: TimelineTrackKind; locked: boolean; hidden: boolean; muted: boolean; solo: boolean; }
export interface TimelineClipAudio { enabled: boolean; gain_db: number; }
/** 帧率分子*1000；1000 = 1x。 */
export type TimelineClipSpeedMilli = number & { readonly __brand: "timeline_clip_speed_milli" };
export interface TimelineClip {
  clip_id: TimelineClipId;
  track_id: string;
  order_index: number;
  asset_id: AssetId;
  asset_kind: TimelineClipKind;
  source_start_us: number | null;
  source_end_us: number | null;
  timeline_start_us: number;
  timeline_end_us: number;
  layout: TimelineLayout;
  audio: TimelineClipAudio;
  /** 可选字段：缺省按 1000（原速）处理。 */
  speed_milli?: TimelineClipSpeedMilli;
  /** 可选字段：缺省为 false（正放）。仅视频片段支持。 */
  reverse_playback?: boolean;
  /** 可选字段：关键帧动画（B3），缺省视为无动画。 */
  keyframes?: TimelineClipKeyframes;
  /** P1 可选字段：静态默认变换（含画布位置/缩放/旋转/透明度）。关键帧存在时动画覆盖。 */
  transform?: TimelineClipStaticTransform;
  /** P2 可选字段：蒙版（线性/矩形/椭圆，羽化+反选）。缺省无蒙版即全可见。 */
  mask?: TimelineClipMask;
  /** P3 可选字段：抠像（纯色/绿幕 keying）。缺省无抠像即不透明。 */
  keying?: TimelineClipKeying;
}
/** B4：字幕样式覆盖（部分字段，渲染时与预设合并；见 docs/M2_B4_CAPTIONS_DESIGN.md §1.1）。 */
export interface CaptionStyleOverride {
  /** 字体名称（仅内置字体有效，缺省跟随预设）。 */
  font_name?: string;
  /** PlayRes 1080x1920 基准字号。 */
  font_size?: number;
  /** ASS &Haabbggrr 格式。 */
  primary_color?: string;
  outline_color?: string;
  /** 描边宽度 0–10。 */
  outline?: number;
  /** ASS numpad 对齐：1–3=底部 4–6=居中 7–9=顶部（左/中/右）。 */
  alignment?: number;
  margin_v?: number;
  /** 字间距（ASS Spacing，PlayRes 基准像素）。 */
  letter_spacing?: number;
  /** 粗体 / 斜体 / 下划线（ASS Bold/Italic/Underline）。 */
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** 0–1 画布比率；非 null 时以 \pos 覆盖对齐。 */
  pos_x?: number | null;
  pos_y?: number | null;
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
  /** 可选字段：与预设不同的样式字段（部分覆盖）。 */
  style_override?: CaptionStyleOverride;
}
/** B2 转场种类：值即 FFmpeg xfade 的 transition 参数。 */
export const TRANSITION_IDS = ["fade", "fadeblack", "dissolve", "wipeleft", "wiperight", "slideleft", "slideup", "zoomin"] as const;
export type TransitionKind = (typeof TRANSITION_IDS)[number];
export type TimelineTransitionId = string & { readonly __brand: "timeline_transition_id" };
export interface TimelineTransition {
  transition_id: TimelineTransitionId;
  /** 转场发生在该片段与其 V1 后继之间。 */
  after_clip_id: TimelineClipId;
  kind: TransitionKind;
  duration_us: number;
}

/** B3 关键帧属性种类与数值范围（见 docs/M2_B3_KEYFRAMES_DESIGN.md §1）。 */
export const KEYFRAME_PROPERTIES = ["position", "scale", "rotate", "opacity"] as const;
export type KeyframeProperty = (typeof KEYFRAME_PROPERTIES)[number];
/** 关键帧：t_us 为片段内时间线时间；position 含 x/y 比率，其余含标量 v。 */
export interface TimelineKeyframe {
  t_us: number;
  x?: number;
  y?: number;
  v?: number;
}
/** 单属性关键帧轨道（每属性独立时间轴，帧按 t_us 升序唯一，≤32 帧）。 */
export interface TimelineKeyframeTrack {
  frames: TimelineKeyframe[];
}
/** 片段的关键帧集合：可选取四个属性，缺省视为无动画。 */
export interface TimelineClipKeyframes {
  position?: TimelineKeyframeTrack;
  scale?: TimelineKeyframeTrack;
  rotate?: TimelineKeyframeTrack;
  opacity?: TimelineKeyframeTrack;
}
/** P1 静态位置：片段的默认画面变换（归一化坐标/比值）。关键帧存在时动画覆盖。 */
export interface TimelineClipStaticTransform {
  /** 中心点归一化位置 x（0..1），缺省 0.5（水平居中）。 */
  x?: number;
  /** 中心点归一化位置 y（0..1），缺省 0.5（垂直居中）。 */
  y?: number;
  /** 缩放（0.05..5.0），缺省 1.0（原始布局尺寸）。 */
  scale?: number;
  /** 旋转（度，-180..180），缺省 0。 */
  rotate?: number;
  /** 不透明度（0..1），缺省 1.0。 */
  opacity?: number;
}
/**
 * P2 蒙版：线性/矩形/椭圆选型 + 羽化 + 反选。几何参数均归一化 0..1（相对画面），
 * 旋转以度计（-180..180）、羽化 0..1。缺省字段由渲染按 type 取合理默认。
 * - linear：以 (x,y) 处的方向线（rotation）为分界，width=软边过渡带宽；invert 反转保留侧。
 * - rect：中心 (x,y)，宽 height，rotation 旋转，feather 羽化。
 * - ellipse：中心 (x,y)，半轴 (width/2, height/2)，rotation 旋转，feather 羽化。
 */
export interface TimelineClipMask {
  kind: "linear" | "rect" | "ellipse";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  feather?: number;
  invert?: boolean;
}
export interface TimelineClipKeying {
  /** 抠除的纯色（0-255 各通道）：绿幕基准色。缺省 "00FF00"。 */
  color?: string;
  /** 色距相似度阈值 0-1（colorkey similarity），越大抠得越狠。缺省 0.3。 */
  similarity?: number;
  /** 边缘混合/blend(平滑过渡)或 color blend。缺省 0.1。 */
  blend?: number;
  /** 是否反选 (invert keying → 保留基准色、透明其余)。缺省 false。 */
  invert?: boolean;
}
export interface TimelineDocument {
  schema_version: 1;
  project_id: ProjectId;
  canvas: TimelineCanvas;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  captions: TimelineCaption[];
  locked_elements?: TimelineClipId[];
  transitions?: TimelineTransition[];
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
  | { op: "insert_asset_clip"; asset_id: AssetId; at_index: number; source_start_us?: number; source_end_us?: number; duration_us?: number; layout?: TimelineLayout; speed_milli?: number; reverse_playback?: boolean; track_id?: string }
  | { op: "insert_transcript_segments"; transcript_id: TranscriptId; segment_ids: TranscriptSegmentId[]; at_index: number; padding_before_us: number; padding_after_us: number; create_captions: boolean; layout?: TimelineLayout }
  | { op: "remove_clip"; clip_id: TimelineClipId }
  | { op: "move_clip"; clip_id: TimelineClipId; to_index: number }
  | { op: "position_clip"; clip_id: TimelineClipId; timeline_start_us: number; track_id?: string }
  | { op: "add_track"; kind: "video" | "text" }
  | { op: "remove_track"; track_id: string }
  | { op: "move_track"; track_id: string; to_index: number }
  | { op: "set_track_flags"; track_id: string; locked?: boolean; hidden?: boolean; muted?: boolean; solo?: boolean }
  | { op: "trim_clip"; clip_id: TimelineClipId; source_start_us: number; source_end_us: number }
  | { op: "split_clip"; clip_id: TimelineClipId; source_time_us: number }
  | { op: "set_layout"; clip_id: TimelineClipId; layout: TimelineLayout }
  | { op: "set_audio"; clip_id: TimelineClipId; enabled: boolean; gain_db: number }
  | { op: "add_transition"; after_clip_id: TimelineClipId; kind: TransitionKind; duration_us: number }
  | { op: "update_transition"; transition_id: TimelineTransitionId; kind?: TransitionKind; duration_us?: number }
  | { op: "remove_transition"; transition_id: TimelineTransitionId }
  | { op: "set_clip_keyframes"; clip_id: TimelineClipId; property: KeyframeProperty; frames: TimelineKeyframe[] }
  | { op: "clear_clip_keyframes"; clip_id: TimelineClipId; property: KeyframeProperty }
  | { op: "set_clip_transform"; clip_id: TimelineClipId; transform: TimelineClipStaticTransform }
  | { op: "set_clip_mask"; clip_id: TimelineClipId; mask: TimelineClipMask | Record<string, never> }
  | { op: "set_clip_keying"; clip_id: TimelineClipId; keying: TimelineClipKeying | Record<string, never> }
  | { op: "set_speed"; clip_id: TimelineClipId; speed_milli: number }
  | { op: "set_reverse_playback"; clip_id: TimelineClipId; reverse_playback: boolean }
  | { op: "set_image_duration"; clip_id: TimelineClipId; duration_us: number }
  | { op: "set_clip_locked"; clip_id: TimelineClipId; locked: boolean }
  | { op: "add_caption"; start_us: number; end_us: number; text: string; preset_id: CaptionPresetId; source_clip_id: null }
  | { op: "import_captions"; entries: Array<{ start_us: number; end_us: number; text: string }>; preset_id: CaptionPresetId; replace_existing: boolean }
  | { op: "remove_caption"; caption_id: TimelineCaptionId }
  | { op: "update_caption"; caption_id: TimelineCaptionId; text: string }
  | { op: "set_caption_timing"; caption_id: TimelineCaptionId; start_us: number; end_us: number }
  | { op: "set_caption_preset"; caption_id: TimelineCaptionId; preset_id: CaptionPresetId }
  | { op: "set_caption_style"; caption_id: TimelineCaptionId; style: CaptionStyleOverride }
  | { op: "clear_caption_style"; caption_id: TimelineCaptionId };
export interface TimelinePatch { schema_version: 1; base_revision_id: TimelineRevisionId; operations: TimelinePatchOperation[]; summary: string; }
export interface TimelineRevisionPointerInput { base_revision_id: TimelineRevisionId; }

export type TimelinePatchGenerationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type TimelineClipChangeType = "added" | "removed" | "moved" | "trimmed" | "split" | "layout_changed" | "audio_changed" | "duration_changed" | "speed_changed" | "reverse_toggled" | "keyframes_changed" | "transform_changed" | "mask_changed" | "keying_changed";
export type TimelineCaptionChangeType = "added" | "removed" | "text_changed" | "timing_changed" | "preset_changed" | "style_changed";
export interface TimelineClipChange { type: TimelineClipChangeType; clip_id: TimelineClipId; created_clip_ids?: TimelineClipId[]; }
export type TimelineTransitionChangeType = "added" | "removed" | "updated";
export interface TimelineTransitionChange { type: TimelineTransitionChangeType; transition_id: TimelineTransitionId; after_clip_id: TimelineClipId; }
export interface TimelineCaptionChange { type: TimelineCaptionChangeType; caption_id: TimelineCaptionId; }
export interface TimelineLockChange { type: "locked" | "unlocked"; clip_id: TimelineClipId; }
export interface TimelineIndirectLockedTimingShift { clip_id: TimelineClipId; from_start_us: number; from_end_us: number; to_start_us: number; to_end_us: number; }
export interface TimelineDiff {
  schema_version: 1; project_id: ProjectId; base_revision_id: TimelineRevisionId; target_revision_id: TimelineRevisionId | null;
  base_document_sha256: string; target_document_sha256: string;
  summary: { clip_changes: number; caption_changes: number; lock_changes: number; transition_changes: number };
  duration_delta_us: number; clip_changes: TimelineClipChange[]; caption_changes: TimelineCaptionChange[];
  lock_changes: TimelineLockChange[]; indirect_locked_timing_shifts: TimelineIndirectLockedTimingShift[]; transition_changes: TimelineTransitionChange[];
}
export interface TimelinePatchEgressPreview {
  timeline_patch_egress_preview_id: TimelinePatchEgressPreviewId;
  provider: { display_name: string; origin: string; model: string };
  prompt_template_version: string; output_schema_version: string; sent_fields: string[]; payload_sha256: string;
  character_count: number; estimated_tokens: number; clip_count: number; caption_count: number; locked_count: number; expires_at: string;
}
export interface TimelinePatchGeneration {
  timeline_patch_generation_id: TimelinePatchGenerationId; project_id: ProjectId; base_revision_id: TimelineRevisionId;
  base_document_sha256: string; status: TimelinePatchGenerationStatus; payload_sha256: string;
  created_at: string; updated_at: string; finished_at: string | null;
}
export interface TimelinePatchProposal {
  schema_version: 1; timeline_patch_proposal_id: TimelinePatchProposalId; timeline_patch_generation_id: TimelinePatchGenerationId;
  project_id: ProjectId; base_revision_id: TimelineRevisionId; base_document_sha256: string; provider_config_id: ProviderConfigId;
  provider_display_name: string; model: string; prompt_template_version: string; output_schema_version: string;
  patch: TimelinePatch; patch_sha256: string; proposed_document_sha256: string; diff: TimelineDiff; created_at: string;
  applied_revision_id: TimelineRevisionId | null; generation_status: TimelinePatchGenerationStatus;
}
export interface TimelinePatchPrepareRequest { base_revision_id: TimelineRevisionId; provider_config_id: ProviderConfigId; instruction: string; }
export interface TimelinePatchGenerationCreateRequest { timeline_patch_egress_preview_id: TimelinePatchEgressPreviewId; payload_sha256: string; }
export interface TimelinePatchGenerationCreateResponse { timeline_patch_generation_id: TimelinePatchGenerationId; job: Job; }
export interface TimelinePatchProposalApplyRequest { base_revision_id: TimelineRevisionId; proposed_document_sha256: string; }
export interface TimelineRevisionDiffRequest { base_revision_id: TimelineRevisionId; target_revision_id: TimelineRevisionId; }

export type GenerationKind = "image" | "tts";
export type GenerationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type GenerationExecutionMode = "simulation_only";

export interface ImageGenerationParameters {
  width: number;
  height: number;
  style_preset_id?: string;
  seed?: number;
}
export interface TtsGenerationParameters {
  voice_preset_id: string;
  language: "zh-CN" | "en-US";
  speed_milli: number;
}
export type MediaGenerationParameters = ImageGenerationParameters | TtsGenerationParameters;
export type MediaGenerationPrepareInput =
  | { generation_kind: "image"; prompt: string; input_refs: string[]; parameters: ImageGenerationParameters }
  | { generation_kind: "tts"; prompt: string; input_refs: string[]; parameters: TtsGenerationParameters };
export type MediaGenerationCreateInput = MediaGenerationPrepareInput & { request_sha256: string };
export interface MediaGenerationPreparedRequest {
  schema_version: 1;
  project_id: ProjectId;
  generation_kind: GenerationKind;
  execution_mode: GenerationExecutionMode;
  prompt_sha256: string;
  input_refs: string[];
  parameters: MediaGenerationParameters;
  request_sha256: string;
}
export interface MediaGenerationRequest {
  request_id: MediaGenerationRequestId;
  project_id: ProjectId;
  generation_kind: GenerationKind;
  execution_mode: GenerationExecutionMode;
  prompt_sha256: string;
  input_refs: string[];
  parameters: MediaGenerationParameters;
  request_sha256: string;
  created_at: string;
}
export type MediaGenerationRequestSummary = MediaGenerationRequest;
export interface MediaGenerationResultSummary {
  execution_mode: GenerationExecutionMode;
  outcome: "validated_without_media";
  provider_call_count: 0;
}
export interface MediaGenerationTaskError { code: ErrorCode; message: string }
export interface MediaGenerationTask {
  task_id: MediaGenerationTaskId;
  request_id: MediaGenerationRequestId;
  job_id: JobId;
  attempt: number;
  status: GenerationStatus;
  stage: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  retry_of_task_id: MediaGenerationTaskId | null;
  output_asset_id: AssetId | null;
  output_sha256: string | null;
  result_summary: MediaGenerationResultSummary | null;
  error: MediaGenerationTaskError | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
export interface MediaGenerationCreateResponse { request: MediaGenerationRequest; task: MediaGenerationTask; reused: boolean }
export type MediaGenerationRequestPage = Page<MediaGenerationRequest>;
export type MediaGenerationTaskPage = Page<MediaGenerationTask>;
export type MediaGenerationRetryInput = Record<string, never>;


export type ProviderImageExecutionMode = "provider_image_v1";
export type ProviderImageSize = "1024x1024";
export interface ImageProviderConfigCreateInput { display_name: string; enabled: boolean }
export interface ImageProviderConfigSummary {
  provider_config_id: ProviderConfigId; project_id: ProjectId; provider_kind: "apikey_fun_images";
  adapter_id: "apikey_fun_images_sse_v1"; capability: "image_text_to_image"; protocol_version: "1";
  display_name: string; model: "gpt-image-2"; enabled: boolean; price_per_image: 0.1; price_2k_per_image: 0.15; price_currency: "CNY";
  credential_status: "missing" | "configured"; created_at: string; updated_at: string;
}
export interface ImageProviderConfigPage { items: ImageProviderConfigSummary[] }
export interface ProviderImageGenerationPrepareInput { provider_config_id: ProviderConfigId; prompt: string; size: ProviderImageSize }
export interface ProviderImageGenerationPreparedPreview {
  preview_id: ProviderImagePreviewId; project_id: ProjectId; execution_mode: ProviderImageExecutionMode;
  prompt_sha256: string; payload_sha256: string; size: ProviderImageSize; output_format: "png"; image_count: 1;
  provider: { provider_config_id: ProviderConfigId; provider_kind: "apikey_fun_images"; adapter_id: "apikey_fun_images_sse_v1"; model: "gpt-image-2" };
  estimated_cost: number | null; estimated_cost_currency: "CNY"; price_tier: "1K"; expires_at: string;
}
export interface ProviderImageGenerationCreateInput { preview_id: ProviderImagePreviewId; payload_sha256: string; confirmed: true }
export interface ProviderImageGenerationRequest {
  request_id: MediaGenerationRequestId; project_id: ProjectId; generation_kind: "image"; execution_mode: ProviderImageExecutionMode;
  prompt_sha256: string; parameters: { size: ProviderImageSize }; request_sha256: string; created_at: string;
}
export interface ProviderImageAssetSummary {
  asset_id: AssetId; display_name: string; kind: "image"; storage_mode: "managed"; availability: "available";
}
export interface ProviderImageGenerationResultSummary {
  execution_mode: ProviderImageExecutionMode; provider_call_count: 1;
  asset: ProviderImageAssetSummary; output: { format: "png"; width: number; height: number; size_bytes: number; sha256: string };
  provider: { kind: "apikey_fun_images"; adapter_id: "apikey_fun_images_sse_v1"; model: "gpt-image-2" };
  estimated_cost: number | null; estimated_cost_currency: "CNY"; price_tier: "1K"; provenance_id: ProviderImageProvenanceId;
}
export interface ProviderImageGenerationTask {
  task_id: MediaGenerationTaskId; request_id: MediaGenerationRequestId; job_id: JobId; attempt: number;
  status: GenerationStatus; stage: string; retry_of_task_id: MediaGenerationTaskId | null;
  provider_call_count: 0 | 1; provider_may_have_processed: boolean; estimated_cost: number | null;
  estimated_cost_currency: "CNY"; price_tier: "1K";
  output_asset_id: AssetId | null; output_sha256: string | null; result_summary: ProviderImageGenerationResultSummary | null;
  error: MediaGenerationTaskError | null; created_at: string; updated_at: string; finished_at: string | null;
}
export interface ProviderImageGenerationCreateResponse { request: ProviderImageGenerationRequest; task: ProviderImageGenerationTask; reused: boolean }
export type ProviderImageGenerationRequestPage = Page<ProviderImageGenerationRequest>;
export type ProviderImageGenerationTaskPage = Page<ProviderImageGenerationTask>;
export interface ProviderImageGenerationRetryPrepareInput { prompt: string }
export type ProviderImageGenerationRetryPreparedPreview = ProviderImageGenerationPreparedPreview;
export type ProviderImageGenerationRetryInput = ProviderImageGenerationCreateInput;
export interface ShotVisualRequirementInput {
  requirement_kind: "existing_media" | "image";
  source_asset_id: AssetId | null;
}
export interface ShotNarrationRequirementInput {
  requirement_kind: "tts";
  text: string;
}
export interface ShotRequirementInput {
  title: string;
  visual_direction: string;
  target_duration_us: number | null;
  visual: ShotVisualRequirementInput;
  narration: ShotNarrationRequirementInput | null;
}
export interface ShotListRevisionCreateInput {
  schema_version: 1;
  base_revision_id: ShotListRevisionId | null;
  title: string;
  summary: string;
  requirements: ShotRequirementInput[];
}
export interface ShotListConfirmInput {
  revision_id: ShotListRevisionId;
  expected_current_revision_id: ShotListRevisionId;
}
export interface ShotRequirement extends ShotRequirementInput {
  shot_requirement_id: ShotRequirementId;
  shot_list_revision_id: ShotListRevisionId;
  ordinal: number;
}
export interface ShotListRevisionSummary {
  schema_version: 1;
  shot_list_revision_id: ShotListRevisionId;
  shot_list_id: ShotListId;
  project_id: ProjectId;
  parent_revision_id: ShotListRevisionId | null;
  title: string;
  requirement_count: number;
  document_sha256: string;
  created_at: string;
}
export interface ShotListRevisionDetail extends ShotListRevisionSummary {
  summary: string;
  requirements: ShotRequirement[];
}
export interface ShotListState {
  shot_list_id: ShotListId | null;
  project_id: ProjectId;
  lifecycle: "empty" | "drafted" | "confirmed";
  current_revision: ShotListRevisionDetail | null;
  confirmed_revision: ShotListRevisionSummary | null;
}
export interface ShotListRevisionCreateResponse {
  revision: ShotListRevisionDetail;
  state: ShotListState;
  reused: boolean;
}
export interface ShotListConfirmResponse {
  state: ShotListState;
  reused: boolean;
}
export type ShotListRevisionPage = Page<ShotListRevisionSummary>;

export class ContractValidationError extends Error {
  constructor(public readonly contract: string, message = "Invalid contract payload") {
    super(`${contract}: ${message}`);
    this.name = "ContractValidationError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const JOB_STATUSES: JobStatus[] = ["queued", "running", "succeeded", "failed", "cancelling", "cancelled", "interrupted"];
const JOB_KINDS: JobKind[] = ["asset_probe", "asset_fingerprint", "proxy", "portrait_sample", "vertical_sample", "model_download", "transcription", "candidate_generation", "timeline_patch_generation", "authoritative_preview", "final_export", "media_generation"];
const PROJECT_STATUSES: ProjectStatus[] = ["active", "archived", "missing"];
const ASSET_KINDS: AssetKind[] = ["video", "audio", "image", "text"];
const ASSET_AVAILABILITIES: AssetAvailability[] = ["available", "missing", "changed", "unsupported"];
const MODEL_INSTALL_STATUSES: ModelInstallStatus[] = ["unavailable", "queued", "downloading", "paused", "verifying", "ready", "cancelled", "failed", "corrupt"];
const PROVIDER_STATUSES: AsrProviderStatus[] = ["unavailable", "installed", "corrupt", "runtime_unavailable"];
const TRANSCRIPT_STATUSES: TranscriptStatus[] = ["pending", "ready", "stale", "failed"];
const TIMELINE_LAYOUTS: TimelineLayout[] = ["blurred_background", "crop_fill", "fit"];
const CAPTION_PRESETS: CaptionPresetId[] = ["default-bottom", "game-safe-bottom", "high-contrast"];
const TIMELINE_CREATED_BY: TimelineCreatedBy[] = ["user", "system", "import"];
const RENDER_MODES: RenderMode[] = ["authoritative_preview", "final_export"];
const RENDER_ARTIFACT_STATUSES: RenderArtifactStatus[] = ["ready", "stale"];
const EXPORT_STATUSES: ExportStatus[] = ["succeeded", "missing"];
const ENCODER_MODES: EncoderMode[] = ["auto", "software"];
const RENDER_PROFILE_IDS: RenderProfileId[] = ["preview-portrait-v1", "export-portrait-v1", "preview-portrait-9x16-v1", "export-portrait-9x16-v1", "preview-landscape-16x9-v1", "export-landscape-16x9-v1", "preview-169-v1", "preview-916-v1", "preview-11-v1", "preview-43-v1", "preview-34-v1", "export-169-v1", "export-916-v1", "export-11-v1", "export-43-v1", "export-34-v1"];
const PREVIEW_RENDER_PROFILE_IDS: PreviewRenderProfileId[] = ["preview-portrait-v1", "preview-portrait-9x16-v1", "preview-landscape-16x9-v1", "preview-169-v1", "preview-916-v1", "preview-11-v1", "preview-43-v1", "preview-34-v1"];
const EXPORT_RENDER_PROFILE_IDS: ExportRenderProfileId[] = ["export-portrait-v1", "export-portrait-9x16-v1", "export-landscape-16x9-v1", "export-169-v1", "export-916-v1", "export-11-v1", "export-43-v1", "export-34-v1"];

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
  return Object.entries(value).some(([key, item]) => ["installed_path", "install_dir", "path", "absolute_path", "uri", "token", "admin_token", "ui_token", "api_key", "secret", "authorization", "prompt", "raw_response", "http_body", "request_body", "response_body", "body", "request", "response", "system_message", "transcript", "caption", "payload", "stderr", "command", "traceback"].includes(key.toLowerCase()) || hasSensitiveKey(item));
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
  // C22 可选细分阶段：出现时 phase 为非空字符串、phase_progress 为空或 0..1。
  if (value.phase !== undefined && value.phase !== null && !(typeof value.phase === "string" && value.phase.length > 0)) return false;
  if (value.phase_progress !== undefined && value.phase_progress !== null && !isRatio(value.phase_progress)) return false;
  return !hasSensitiveKey(value) && (value.error === null || (isString(value.error.code) && isString(value.error.message)));
}

const BRIEF_INPUT_KEYS = ["schema_version", "topic", "audience", "target_platform", "target_duration_us", "narrative_goal", "style_notes", "must_keep", "forbidden", "original_audio_policy", "caption_policy", "caption_preset_id", "default_layout"] as const;
const BRIEF_KEYS = ["brief_id", "project_id", "document_sha256", ...BRIEF_INPUT_KEYS] as const;
const PROVIDER_CAPABILITY_KEYS = ["timeline_patch_capability_status", "timeline_patch_response_adapter_id", "timeline_patch_probe_protocol_version", "timeline_patch_capability_tested_at", "timeline_patch_capability_failure_code", "timeline_patch_capability_probe_sha256"] as const;
const CANDIDATE_CAPABILITY_KEYS = ["candidate_capability_status", "candidate_response_adapter_id", "candidate_probe_protocol_version", "candidate_capability_tested_at", "candidate_capability_failure_code", "candidate_capability_probe_sha256"] as const;
const PROVIDER_KEYS = ["provider_config_id", "kind", "display_name", "base_url", "model", "enabled", "credential_status", "input_price_per_million", "output_price_per_million", ...PROVIDER_CAPABILITY_KEYS, ...CANDIDATE_CAPABILITY_KEYS, "created_at", "updated_at"] as const;
const TIMELINE_PATCH_RESPONSE_ADAPTER_IDS: TimelinePatchResponseAdapterId[] = [
  "openai_responses_json_schema_v1",
  "openai_responses_patchscript_v1",
  "openai_chat_completions_json_schema_v1",
  "openai_chat_completions_patchscript_v1"
];
export const CANDIDATE_RESPONSE_ADAPTER_IDS: readonly CandidateResponseAdapterId[] = [
  "openai_responses_json_schema_v1",
  "openai_responses_candidatescript_v1",
  "openai_chat_completions_json_schema_v1",
  "openai_chat_completions_candidatescript_v1"
] as const;
function isBriefText(value: unknown, maximum: number): value is string { return isString(value) && value.length <= maximum && value.trim().length > 0 && !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value); }
export function isBriefInput(value: unknown): value is BriefInput {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, BRIEF_INPUT_KEYS) && value.schema_version === 1 && isBriefText(value.topic, 200) && isBriefText(value.audience, 200) && value.target_platform === "generic_vertical" && isInteger(value.target_duration_us, 15_000_000) && Number(value.target_duration_us) <= 180_000_000 && isBriefText(value.narrative_goal, 500) && isString(value.style_notes) && value.style_notes.length <= 1000 && Array.isArray(value.must_keep) && value.must_keep.length <= 20 && value.must_keep.every(item => isBriefText(item, 100)) && Array.isArray(value.forbidden) && value.forbidden.length <= 20 && value.forbidden.every(item => isBriefText(item, 100)) && oneOf(["preserve", "mute"] as const, value.original_audio_policy) && oneOf(["auto_from_transcript", "none"] as const, value.caption_policy) && isCaptionPresetId(value.caption_preset_id) && isTimelineLayout(value.default_layout);
}
export function isBrief(value: unknown): value is Brief { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, BRIEF_KEYS) && isId(value.brief_id) && isId(value.project_id) && isSha256(value.document_sha256) && isBriefInput(Object.fromEntries(BRIEF_INPUT_KEYS.map(key => [key, value[key]]))); }
export function isRecipe(value: unknown): value is Recipe { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["schema_version", "recipe_id", "name", "summary", "rules", "document_sha256"]) && isId(value.recipe_id) && value.schema_version === 1 && isBriefText(value.name, 200) && isBriefText(value.summary, 1000) && isRecord(value.rules) && onlyKeys(value.rules, ["selection", "pace", "max_gap_us"]) && isBriefText(value.rules.selection, 100) && isBriefText(value.rules.pace, 100) && isInteger(value.rules.max_gap_us, 0) && isSha256(value.document_sha256); }
function isTimelinePatchCapabilityMetadata(value: Record<string, unknown>): boolean {
  if (!oneOf(["untested", "supported", "unsupported"] as const, value.timeline_patch_capability_status) || !(value.timeline_patch_response_adapter_id === null || oneOf(TIMELINE_PATCH_RESPONSE_ADAPTER_IDS, value.timeline_patch_response_adapter_id)) || !(value.timeline_patch_probe_protocol_version === null || isBriefText(value.timeline_patch_probe_protocol_version, 100)) || !(value.timeline_patch_capability_tested_at === null || isTime(value.timeline_patch_capability_tested_at)) || !(value.timeline_patch_capability_failure_code === null || isBriefText(value.timeline_patch_capability_failure_code, 200)) || !(value.timeline_patch_capability_probe_sha256 === null || isSha256(value.timeline_patch_capability_probe_sha256))) return false;
  return value.timeline_patch_capability_status === "supported"
    ? oneOf(TIMELINE_PATCH_RESPONSE_ADAPTER_IDS, value.timeline_patch_response_adapter_id) && value.timeline_patch_probe_protocol_version === "1" && value.timeline_patch_capability_tested_at !== null && value.timeline_patch_capability_failure_code === null && value.timeline_patch_capability_probe_sha256 !== null
    : value.timeline_patch_response_adapter_id === null && value.timeline_patch_probe_protocol_version === null && (value.timeline_patch_capability_status === "untested" ? value.timeline_patch_capability_tested_at === null && value.timeline_patch_capability_failure_code === null && value.timeline_patch_capability_probe_sha256 === null : value.timeline_patch_capability_tested_at !== null && value.timeline_patch_capability_failure_code !== null && value.timeline_patch_capability_probe_sha256 !== null);
}
function isCandidateCapabilityMetadata(value: Record<string, unknown>): boolean {
  if (!oneOf(["untested", "supported", "unsupported"] as const, value.candidate_capability_status) || !(value.candidate_response_adapter_id === null || oneOf(CANDIDATE_RESPONSE_ADAPTER_IDS, value.candidate_response_adapter_id)) || !(value.candidate_probe_protocol_version === null || isBriefText(value.candidate_probe_protocol_version, 100)) || !(value.candidate_capability_tested_at === null || isTime(value.candidate_capability_tested_at)) || !(value.candidate_capability_failure_code === null || isBriefText(value.candidate_capability_failure_code, 200)) || !(value.candidate_capability_probe_sha256 === null || isSha256(value.candidate_capability_probe_sha256))) return false;
  return value.candidate_capability_status === "supported"
    ? oneOf(CANDIDATE_RESPONSE_ADAPTER_IDS, value.candidate_response_adapter_id) && value.candidate_probe_protocol_version === "1" && value.candidate_capability_tested_at !== null && value.candidate_capability_failure_code === null && value.candidate_capability_probe_sha256 !== null
    : value.candidate_response_adapter_id === null && value.candidate_probe_protocol_version === null && (value.candidate_capability_status === "untested" ? value.candidate_capability_tested_at === null && value.candidate_capability_failure_code === null && value.candidate_capability_probe_sha256 === null : value.candidate_capability_tested_at !== null && value.candidate_capability_failure_code !== null && value.candidate_capability_probe_sha256 !== null);
}
export function isCandidateResponseAdapterId(value: unknown): value is CandidateResponseAdapterId { return oneOf(CANDIDATE_RESPONSE_ADAPTER_IDS, value); }
export function isProviderConfig(value: unknown): value is ProviderConfig { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, PROVIDER_KEYS) && isId(value.provider_config_id) && value.kind === "openai_compatible_text" && isBriefText(value.display_name, 100) && isString(value.base_url) && /^https?:\/\//.test(value.base_url) && isBriefText(value.model, 200) && typeof value.enabled === "boolean" && oneOf(["missing", "configured", "unavailable"] as const, value.credential_status) && (value.input_price_per_million === null || isFiniteNumber(value.input_price_per_million)) && (value.output_price_per_million === null || isFiniteNumber(value.output_price_per_million)) && isTimelinePatchCapabilityMetadata(value) && isCandidateCapabilityMetadata(value) && isTime(value.created_at) && isTime(value.updated_at); }
export function isTimelinePatchCapabilityTestResponse(value: unknown): value is TimelinePatchCapabilityTestResponse { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, PROVIDER_CAPABILITY_KEYS) && isTimelinePatchCapabilityMetadata(value); }
export function isProviderCapabilityTestResult(value: unknown): value is ProviderCapabilityTestResult { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, CANDIDATE_CAPABILITY_KEYS) && isCandidateCapabilityMetadata(value); }
export function isEgressPreview(value: unknown): value is EgressPreview { return isRecord(value) && !hasSensitiveKey({ ...value, payload: undefined }) && onlyKeys(value, ["egress_preview_id", "provider", "prompt_template_version", "sent_fields", "payload_sha256", "expires_at", "payload", "stats"]) && isId(value.egress_preview_id) && isRecord(value.provider) && onlyKeys(value.provider, ["display_name", "origin", "model"]) && isBriefText(value.provider.display_name, 100) && isString(value.provider.origin) && /^https?:\/\//.test(value.provider.origin) && isBriefText(value.provider.model, 200) && isBriefText(value.prompt_template_version, 200) && Array.isArray(value.sent_fields) && value.sent_fields.every(item => isString(item) && item.length > 0) && isSha256(value.payload_sha256) && isTime(value.expires_at) && isRecord(value.payload) && isRecord(value.stats) && onlyKeys(value.stats, ["transcript_count", "segment_count", "character_count", "estimated_tokens"]) && [value.stats.transcript_count, value.stats.segment_count, value.stats.character_count, value.stats.estimated_tokens].every(item => isInteger(item, 0)); }
export function isCandidateClip(value: unknown): value is CandidateClip { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["clip_id", "order_index", "asset_id", "transcript_id", "segment_ids", "source_start_us", "source_end_us", "reason", "model_score", "caption_text"]) && isId(value.clip_id) && isInteger(value.order_index, 0) && isId(value.asset_id) && isId(value.transcript_id) && Array.isArray(value.segment_ids) && value.segment_ids.length > 0 && value.segment_ids.every(isId) && isInteger(value.source_start_us) && isInteger(value.source_end_us, 1) && value.source_end_us > value.source_start_us && isBriefText(value.reason, 300) && (value.model_score === null || (isFiniteNumber(value.model_score) && value.model_score >= 0 && value.model_score <= 1)) && isBriefText(value.caption_text, 10_000); }
export function isCandidatePlan(value: unknown): value is CandidatePlan { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["schema_version", "candidate_plan_id", "candidate_generation_id", "project_id", "ordinal", "variant", "title_suggestion", "summary", "duration_us", "clips", "warnings", "document_sha256"]) && value.schema_version === 1 && isId(value.candidate_plan_id) && isId(value.project_id) && isId(value.candidate_generation_id) && isInteger(value.ordinal, 0) && oneOf(["balanced", "compact", "bold"] as const, value.variant) && isBriefText(value.title_suggestion, 200) && isBriefText(value.summary, 500) && isInteger(value.duration_us, 15_000_000) && value.duration_us <= 180_000_000 && Array.isArray(value.clips) && value.clips.length > 0 && value.clips.every(isCandidateClip) && Array.isArray(value.warnings) && value.warnings.every(item => isString(item)) && isSha256(value.document_sha256); }
export function isCandidateGeneration(value: unknown): value is CandidateGeneration { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["candidate_generation_id", "project_id", "status", "payload_sha256", "created_at", "updated_at", "finished_at", "candidate_plans"]) && isId(value.candidate_generation_id) && isId(value.project_id) && oneOf(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"] as const, value.status) && isSha256(value.payload_sha256) && isTime(value.created_at) && isTime(value.updated_at) && (value.finished_at === null || isTime(value.finished_at)) && (value.candidate_plans === undefined || (Array.isArray(value.candidate_plans) && value.candidate_plans.every(isCandidatePlan))); }
export function isProviderInvocation(value: unknown): value is ProviderInvocation { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["provider_config_id", "provider_invocation_id", "status"]) && isId(value.provider_config_id) && isId(value.provider_invocation_id) && oneOf(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"] as const, value.status); }
export function isCandidateAdoption(value: unknown): value is CandidateAdoption { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["schema_version", "candidate_document_sha256", "base_revision_id"]) && value.schema_version === 1 && isSha256(value.candidate_document_sha256) && (value.base_revision_id === null || isId(value.base_revision_id)); }

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
export function parseBrief(value: unknown): Brief { if (!isBrief(value)) throw new ContractValidationError("Brief"); return value; }
export function parseBriefInput(value: unknown): BriefInput { if (!isBriefInput(value)) throw new ContractValidationError("BriefInput"); return value; }
export function parseRecipe(value: unknown): Recipe { if (!isRecipe(value)) throw new ContractValidationError("Recipe"); return value; }
export function parseProviderConfig(value: unknown): ProviderConfig { if (!isProviderConfig(value)) throw new ContractValidationError("ProviderConfig"); return value; }
export function parseTimelinePatchCapabilityTestResponse(value: unknown): TimelinePatchCapabilityTestResponse { if (!isTimelinePatchCapabilityTestResponse(value)) throw new ContractValidationError("TimelinePatchCapabilityTestResponse"); return value; }
export function parseProviderCapabilityTestResult(value: unknown): ProviderCapabilityTestResult { if (!isProviderCapabilityTestResult(value)) throw new ContractValidationError("ProviderCapabilityTestResult"); return value; }
export function parseEgressPreview(value: unknown): EgressPreview { if (!isEgressPreview(value)) throw new ContractValidationError("EgressPreview"); return value; }
export function parseCandidateGeneration(value: unknown): CandidateGeneration { if (!isCandidateGeneration(value)) throw new ContractValidationError("CandidateGeneration"); return value; }
export function parseCandidatePlan(value: unknown): CandidatePlan { if (!isCandidatePlan(value)) throw new ContractValidationError("CandidatePlan"); return value; }
export function parseCandidateAdoption(value: unknown): CandidateAdoption { if (!isCandidateAdoption(value)) throw new ContractValidationError("CandidateAdoption"); return value; }

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
    ((value.kind === "authoritative_preview" && PREVIEW_RENDER_PROFILE_IDS.includes(value.profile_id as PreviewRenderProfileId)) || (value.kind === "final_export" && EXPORT_RENDER_PROFILE_IDS.includes(value.profile_id as ExportRenderProfileId))) && isString(value.display_name) && value.display_name.length > 0 && isInteger(value.size_bytes, 1) && isSha256(value.sha256) && isRenderedMediaInfo(value.media_info) && isString(value.encoder) && value.encoder.length > 0 && isNullableString(value.fallback_reason) && isTime(value.created_at);
}
export function isAuthoritativePreview(value: unknown): value is AuthoritativePreview { return isRenderArtifact(value) && value.kind === "authoritative_preview"; }
export function isExportRecord(value: unknown): value is ExportRecord {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["export_record_id", "project_id", "timeline_revision_id", "render_artifact_id", "status", "profile_id", "destination_display_name", "size_bytes", "sha256", "media_info", "encoder", "fallback_reason", "created_at"]) &&
    isId(value.export_record_id) && isId(value.project_id) && isId(value.timeline_revision_id) && isId(value.render_artifact_id) && oneOf(EXPORT_STATUSES, value.status) && EXPORT_RENDER_PROFILE_IDS.includes(value.profile_id as ExportRenderProfileId) && isString(value.destination_display_name) && value.destination_display_name.length > 0 && isInteger(value.size_bytes, 1) && isSha256(value.sha256) && isRenderedMediaInfo(value.media_info) && isString(value.encoder) && value.encoder.length > 0 && isNullableString(value.fallback_reason) && isTime(value.created_at);
}
export function isDestinationGrant(value: unknown): value is DestinationGrant {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["destination_grant_id", "display_name", "extension", "overwrite_authorized", "expires_at"]) && isId(value.destination_grant_id) && isString(value.display_name) && value.display_name.length > 0 && value.extension === ".mp4" && typeof value.overwrite_authorized === "boolean" && isTime(value.expires_at);
}
export function isPreviewCreateInput(value: unknown): value is PreviewCreateInput {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["timeline_revision_id", "encoder_mode", "output_ratio"]) && (value.timeline_revision_id === undefined || isId(value.timeline_revision_id)) && (value.encoder_mode === undefined || isEncoderMode(value.encoder_mode)) && (value.output_ratio === undefined || isOutputRatio(value.output_ratio));
}
export function isPreviewCreateResponse(value: unknown): value is PreviewCreateResponse {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["job", "preview", "reused"]) || !(value.job === null || isJob(value.job)) || !(value.preview === null || isAuthoritativePreview(value.preview)) || typeof value.reused !== "boolean") return false;
  return value.reused ? value.job === null && value.preview !== null && value.preview.status === "ready" : value.job !== null && value.preview === null && value.job.kind === "authoritative_preview";
}
export function isExportCreateInput(value: unknown): value is ExportCreateInput {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["timeline_revision_id", "destination_grant_id", "encoder_mode", "output_ratio"]) && (value.timeline_revision_id === undefined || isId(value.timeline_revision_id)) && isId(value.destination_grant_id) && (value.encoder_mode === undefined || isEncoderMode(value.encoder_mode)) && (value.output_ratio === undefined || isOutputRatio(value.output_ratio));
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
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["clip_id", "track_id", "order_index", "asset_id", "asset_kind", "source_start_us", "source_end_us", "timeline_start_us", "timeline_end_us", "layout", "audio", "speed_milli", "reverse_playback", "keyframes", "transform", "mask", "keying"])) return false;
  if (!isId(value.clip_id) || !oneOf(["V1", "A1"] as const, value.track_id) || !isInteger(value.order_index) || !isId(value.asset_id) || !oneOf(["video", "image", "audio"] as const, value.asset_kind) ||
    !isInteger(value.timeline_start_us) || !isInteger(value.timeline_end_us, 1) || value.timeline_end_us <= value.timeline_start_us || !isTimelineLayout(value.layout) || !isRecord(value.audio) ||
    !onlyKeys(value.audio, ["enabled", "gain_db"]) || typeof value.audio.enabled !== "boolean" || !isFiniteNumber(value.audio.gain_db) || value.audio.gain_db < -60 || value.audio.gain_db > 12) return false;
  // 可选变速/倒放字段：出现时必须合法；speed 250–4000（0.25x–4x），倒放仅视频。
  if (value.speed_milli !== undefined && (!isInteger(value.speed_milli, 250) || value.speed_milli > 4000)) return false;
  if (value.reverse_playback !== undefined && (typeof value.reverse_playback !== "boolean" || (value.reverse_playback && value.asset_kind !== "video"))) return false;
  // 可选关键帧：结构按属性校验；t_us 上界（片段时长）由 core 归一化时校验。
  if (value.keyframes !== undefined && !isTimelineClipKeyframes(value.keyframes)) return false;
  // P1 可选静态变换：只接受合法子集字段（画布位置/缩放/旋转/透明度）。
  if (value.transform !== undefined) {
    if (!isRecord(value.transform) || hasSensitiveKey(value.transform) || !onlyKeys(value.transform, ["x", "y", "scale", "rotate", "opacity"])) return false;
    const inRange = (v: unknown, lo: number, hi: number) => isFiniteNumber(v) && v >= lo && v <= hi;
    if (value.transform.x !== undefined && !inRange(value.transform.x, 0, 1)) return false;
    if (value.transform.y !== undefined && !inRange(value.transform.y, 0, 1)) return false;
    if (value.transform.scale !== undefined && !inRange(value.transform.scale, 0.05, 5)) return false;
    if (value.transform.rotate !== undefined && !inRange(value.transform.rotate, -180, 180)) return false;
    if (value.transform.opacity !== undefined && !inRange(value.transform.opacity, 0, 1)) return false;
  }
  // P2 可选蒙版：只接受合法子集字段；几何范围校验见 isTimelineClipMask。
  if (value.mask !== undefined && !isTimelineClipMask(value.mask)) return false;
  // P3 可选抠像：只接受合法子集字段；颜色与阈值范围见 isTimelineClipKeying。
  if (value.keying !== undefined && !isTimelineClipKeying(value.keying)) return false;
  if (value.asset_kind === "image") return value.track_id === "V1" && value.source_start_us === null && value.source_end_us === null && value.timeline_end_us - value.timeline_start_us >= 500_000 && value.timeline_end_us - value.timeline_start_us <= 30_000_000;
  // 视频/音频：timeline 时长 = 源范围时长 / 速度（四舍五入到微秒；原速时严格相等）。
  const speed = typeof value.speed_milli === "number" ? value.speed_milli : 1000;
  const sourceSpan = (value.source_end_us as number) - (value.source_start_us as number);
  const expected = speed === 1000 ? sourceSpan : Math.round(sourceSpan / speed * 1000);
  return value.source_end_us !== null && value.source_start_us !== null && sourceSpan >= 100_000 && value.timeline_end_us - value.timeline_start_us === expected;
}
/** B4：ASS &Haabbggrr 颜色格式（十六进制，总长 10）。 */
function isAssColor(value: unknown): value is string {
  return isString(value) && /^&H[0-9A-Fa-f]{8}$/.test(value);
}
export function isCaptionStyleOverride(value: unknown): value is CaptionStyleOverride {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["font_name", "font_size", "primary_color", "outline_color", "outline", "alignment", "margin_v", "letter_spacing", "bold", "italic", "underline", "pos_x", "pos_y"]) || !Object.keys(value).length) return false;
  if (value.font_name !== undefined && (!isString(value.font_name) || value.font_name.length === 0 || value.font_name.length > 60)) return false;
  if (value.font_size !== undefined && (!isInteger(value.font_size, 24) || value.font_size > 144)) return false;
  if (value.primary_color !== undefined && !isAssColor(value.primary_color)) return false;
  if (value.outline_color !== undefined && !isAssColor(value.outline_color)) return false;
  if (value.outline !== undefined && (!isInteger(value.outline, 0) || value.outline > 10)) return false;
  if (value.alignment !== undefined && (!isInteger(value.alignment, 0) || ![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(value.alignment))) return false;
  if (value.margin_v !== undefined && (!isInteger(value.margin_v, 0) || value.margin_v > 600)) return false;
  if (value.letter_spacing !== undefined && (!isFiniteNumber(value.letter_spacing) || value.letter_spacing < 0 || value.letter_spacing > 50)) return false;
  for (const flag of ["bold", "italic", "underline"] as const) {
    if (value[flag] !== undefined && typeof value[flag] !== "boolean") return false;
  }
  const posOk = (v: unknown) => v === null || (isFiniteNumber(v) && v >= 0 && v <= 1);
  if (value.pos_x !== undefined && !posOk(value.pos_x)) return false;
  if (value.pos_y !== undefined && !posOk(value.pos_y)) return false;
  return true;
}
export function isTimelineCaption(value: unknown): value is TimelineCaption {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["caption_id", "track_id", "source_clip_id", "start_us", "end_us", "text", "preset_id", "origin", "edited", "source_segment_ids", "style_override"])) return false;
  if (!isId(value.caption_id) || value.track_id !== "C1" || !(value.source_clip_id === null || isId(value.source_clip_id)) || !isInteger(value.start_us) || !isInteger(value.end_us, 1) || value.end_us - value.start_us < 200_000 ||
    !isString(value.text) || value.text.trim().length < 1 || [...value.text].length > 200 || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.text) || !isCaptionPresetId(value.preset_id) || !oneOf(["transcript", "user"] as const, value.origin) || typeof value.edited !== "boolean" || !Array.isArray(value.source_segment_ids) || !value.source_segment_ids.every(isId)) return false;
  if (value.style_override !== undefined && !isCaptionStyleOverride(value.style_override)) return false;
  return value.origin === "transcript" ? value.source_clip_id !== null && value.source_segment_ids.length > 0 : value.source_segment_ids.length === 0;
}
export function isTimelineTransition(value: unknown): value is TimelineTransition {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["transition_id", "after_clip_id", "kind", "duration_us"]) && isId(value.transition_id) && isId(value.after_clip_id) && oneOf(TRANSITION_IDS, value.kind) && isInteger(value.duration_us, 100_000) && value.duration_us <= 2_000_000;
}
/** B3：单属性关键帧轨道校验（范围按属性，帧升序唯一，1-32 帧）。 */
export function isTimelineKeyframeTrack(value: unknown, property: KeyframeProperty): value is TimelineKeyframeTrack {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["frames"]) || !Array.isArray(value.frames) || value.frames.length < 1 || value.frames.length > 32) return false;
  let previous = -1;
  for (const frame of value.frames) {
    if (!isRecord(frame) || !onlyKeys(frame, ["t_us", "x", "y", "v"]) || !isInteger(frame.t_us, 0) || frame.t_us <= previous) return false;
    previous = frame.t_us;
    if (property === "position") {
      if (frame.x === undefined || frame.y === undefined || frame.v !== undefined) return false;
      if (!isFiniteNumber(frame.x) || frame.x < -0.5 || frame.x > 0.5 || !isFiniteNumber(frame.y) || frame.y < -0.5 || frame.y > 0.5) return false;
    } else {
      if (frame.v === undefined || frame.x !== undefined || frame.y !== undefined) return false;
      if (!isFiniteNumber(frame.v)) return false;
      if (property === "scale" && (frame.v < 0.1 || frame.v > 5)) return false;
      if (property === "rotate" && (frame.v < -180 || frame.v > 180)) return false;
      if (property === "opacity" && (frame.v < 0 || frame.v > 1)) return false;
    }
  }
  return true;
}
export function isTimelineClipKeyframes(value: unknown): value is TimelineClipKeyframes {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["position", "scale", "rotate", "opacity"]) || !Object.keys(value).length) return false;
  return KEYFRAME_PROPERTIES.every(property => value[property] === undefined || isTimelineKeyframeTrack(value[property], property));
}
/** P1：片段静态变换守卫（字段子集 + 数值范围）。 */
export function isTimelineClipStaticTransform(value: unknown): value is TimelineClipStaticTransform {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["x", "y", "scale", "rotate", "opacity"])) return false;
  const inRange = (v: unknown, lo: number, hi: number) => isFiniteNumber(v) && v >= lo && v <= hi;
  if (value.x !== undefined && !inRange(value.x, 0, 1)) return false;
  if (value.y !== undefined && !inRange(value.y, 0, 1)) return false;
  if (value.scale !== undefined && !inRange(value.scale, 0.05, 5)) return false;
  if (value.rotate !== undefined && !inRange(value.rotate, -180, 180)) return false;
  if (value.opacity !== undefined && !inRange(value.opacity, 0, 1)) return false;
  return true;
}
/** P2：片段蒙版守卫（字段子集 + 数值范围 + kind 合法）。 */
export function isTimelineClipMask(value: unknown): value is TimelineClipMask {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["kind", "x", "y", "width", "height", "rotation", "feather", "invert"])) return false;
  // 空对象表示「清除蒙版」。
  if (Object.keys(value).length === 0) return true;
  if (!oneOf(["linear", "rect", "ellipse"] as const, value.kind)) return false;
  const in01 = (v: unknown) => v === undefined || (isFiniteNumber(v) && v >= 0 && v <= 1);
  if (!in01(value.x) || !in01(value.y)) return false;
  if (value.width !== undefined && !(isFiniteNumber(value.width) && value.width > 0 && value.width <= 1)) return false;
  if (value.height !== undefined && !(isFiniteNumber(value.height) && value.height > 0 && value.height <= 1)) return false;
  if (value.rotation !== undefined && !(isFiniteNumber(value.rotation) && value.rotation >= -180 && value.rotation <= 180)) return false;
  if (value.feather !== undefined && !(isFiniteNumber(value.feather) && value.feather >= 0 && value.feather <= 1)) return false;
  if (value.invert !== undefined && typeof value.invert !== "boolean") return false;
  return true;
}
/** P3：片段抠像守卫（字段子集 + 数值范围 + 颜色格式）。空对象表示「清除抠像」。 */
export function isTimelineClipKeying(value: unknown): value is TimelineClipKeying {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["color", "similarity", "blend", "invert"])) return false;
  if (Object.keys(value).length === 0) return true;
  if (value.color !== undefined && !(isString(value.color) && /^[0-9A-Fa-f]{6}$/.test(value.color))) return false;
  if (value.similarity !== undefined && !(isFiniteNumber(value.similarity) && value.similarity >= 0 && value.similarity <= 1)) return false;
  if (value.blend !== undefined && !(isFiniteNumber(value.blend) && value.blend >= 0 && value.blend <= 1)) return false;
  if (value.invert !== undefined && typeof value.invert !== "boolean") return false;
  return true;
}
const TRANSITION_DOC_MAX = 50;
export function isTimelineTrack(value: unknown): value is TimelineTrack {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["id", "kind", "locked", "hidden", "muted", "solo"]) || !isString(value.id) || !value.id.length || !oneOf(["video", "text", "audio"], value.kind)) return false;
  return value.locked === false && value.hidden === false && value.muted === false && value.solo === false;
}
export function isTimelineDocument(value: unknown): value is TimelineDocument {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["schema_version", "project_id", "canvas", "tracks", "clips", "captions", "locked_elements", "transitions", "provenance"]) || value.schema_version !== 1 || !isId(value.project_id) || !isTimelineCanvas(value.canvas) || !Array.isArray(value.tracks) || value.tracks.length < 2 || !value.tracks.every(isTimelineTrack) || !Array.isArray(value.clips) || !value.clips.every(isTimelineClip) || !Array.isArray(value.captions) || !value.captions.every(isTimelineCaption) || !isRecord(value.provenance)) return false;
  if (value.transitions !== undefined) {
    if (!Array.isArray(value.transitions) || value.transitions.length > TRANSITION_DOC_MAX || !value.transitions.every(isTimelineTransition)) return false;
    const seen = new Set<string>();
    for (const item of value.transitions as TimelineTransition[]) { if (seen.has(item.after_clip_id)) return false; seen.add(item.after_clip_id); }
  }
  // 轨道结构（数组顺序 = 自上而下）：[动态视频/文本轨道...] → [C1(字幕，可删，
  // 存在时必须紧邻 V1 之前)] → V1(主视频) → A1(音频)。
  const tracks = value.tracks as TimelineTrack[];
  const audioTrack = tracks[tracks.length - 1];
  const visual = tracks[tracks.length - 2];
  if (audioTrack?.id !== "A1" || audioTrack.kind !== "audio") return false;
  if (visual?.id !== "V1" || visual.kind !== "video") return false;
  const dynamic = tracks.slice(0, -2);
  const captionIndex = dynamic.findIndex(track => track.id === "C1");
  if (captionIndex !== -1 && captionIndex !== dynamic.length - 1) return false;
  if (dynamic.some(track => track.id === "V1" || track.id === "A1")) return false;
  const trackIds = new Set(tracks.map(track => track.id));
  if (trackIds.size !== tracks.length) return false;
  const kindOf = (id: string) => id.startsWith("V") ? "video" : id.startsWith("T") ? "text" : "audio";
  if (dynamic.some(track => track.id !== "C1" && kindOf(track.id) !== track.kind)) return false;
  if (!onlyKeys(value.provenance, ["created_by", "source_transcript_ids"]) || !isTimelineCreatedBy(value.provenance.created_by) || !Array.isArray(value.provenance.source_transcript_ids) || !value.provenance.source_transcript_ids.every(isId)) return false;

  // 片段必须引用存在的轨道，且类型与轨道匹配；同轨时间区间不得重叠。
  for (const clip of value.clips as TimelineClip[]) {
    const track = tracks.find(item => item.id === clip.track_id);
    if (!track) return false;
    const clipKind = clip.asset_kind === "audio" ? "audio" : "video";
    if (track.kind !== clipKind) return false;
  }
  for (const track of tracks) {
    if (track.kind !== "video") continue;
    const sorted = (value.clips as TimelineClip[]).filter(item => item.track_id === track.id).sort((a, b) => a.timeline_start_us - b.timeline_start_us);
    for (let index = 1; index < sorted.length; index += 1) { if (sorted[index].timeline_start_us < sorted[index - 1].timeline_end_us) return false; }
  }

  const captions = [...value.captions].sort((a, b) => a.start_us - b.start_us);
  const totalEnd = (value.clips as TimelineClip[]).reduce((max, item) => Math.max(max, item.timeline_end_us), 0);
  if (!captions.every((item, index) => (item.origin === "transcript" && item.end_us > totalEnd) || (index > 0 && captions[index - 1].end_us > item.start_us))) return false;
  if (value.locked_elements === undefined) return true;
  if (!Array.isArray(value.locked_elements) || !value.locked_elements.every(isId) || new Set(value.locked_elements).size !== value.locked_elements.length) return false;
  const clipIds = new Set<string>(value.clips.map(item => item.clip_id));
  return value.locked_elements.every(item => clipIds.has(item));
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
    case "insert_asset_clip": return onlyKeys(value, ["op", "asset_id", "at_index", "source_start_us", "source_end_us", "duration_us", "layout", "speed_milli", "reverse_playback", "track_id"]) && id("asset_id") && index("at_index") && (value.source_start_us === undefined || us("source_start_us")) && (value.source_end_us === undefined || us("source_end_us", 1)) && (value.duration_us === undefined || us("duration_us", 500_000)) && (value.layout === undefined || isTimelineLayout(value.layout)) && (value.speed_milli === undefined || (isInteger(value.speed_milli, 250) && value.speed_milli <= 4000)) && (value.reverse_playback === undefined || typeof value.reverse_playback === "boolean") && (value.track_id === undefined || (isString(value.track_id) && Boolean(value.track_id.length)));
    case "insert_transcript_segments": return onlyKeys(value, ["op", "transcript_id", "segment_ids", "at_index", "padding_before_us", "padding_after_us", "create_captions", "layout"]) && id("transcript_id") && Array.isArray(value.segment_ids) && value.segment_ids.length > 0 && value.segment_ids.every(isId) && index("at_index") && us("padding_before_us") && Number(value.padding_before_us) <= 300_000 && us("padding_after_us") && Number(value.padding_after_us) <= 300_000 && typeof value.create_captions === "boolean" && (value.layout === undefined || isTimelineLayout(value.layout));
    case "remove_clip": return onlyKeys(value, ["op", "clip_id"]) && id("clip_id");
    case "move_clip": return onlyKeys(value, ["op", "clip_id", "to_index"]) && id("clip_id") && index("to_index");
    case "position_clip": return onlyKeys(value, ["op", "clip_id", "timeline_start_us", "track_id"]) && id("clip_id") && us("timeline_start_us") && (value.track_id === undefined || (isString(value.track_id) && Boolean(value.track_id.length)));
    case "add_track": return onlyKeys(value, ["op", "kind"]) && oneOf(["video", "text"], value.kind);
    case "remove_track": return onlyKeys(value, ["op", "track_id"]) && isString(value.track_id) && Boolean(value.track_id.length);
    case "move_track": return onlyKeys(value, ["op", "track_id", "to_index"]) && isString(value.track_id) && Boolean(value.track_id.length) && index("to_index");
    case "set_track_flags": return onlyKeys(value, ["op", "track_id", "locked", "hidden", "muted", "solo"]) && isString(value.track_id) && Boolean(value.track_id.length) && (value.locked === undefined || typeof value.locked === "boolean") && (value.hidden === undefined || typeof value.hidden === "boolean") && (value.muted === undefined || typeof value.muted === "boolean") && (value.solo === undefined || typeof value.solo === "boolean") && (value.locked !== undefined || value.hidden !== undefined || value.muted !== undefined || value.solo !== undefined);
    case "trim_clip": return onlyKeys(value, ["op", "clip_id", "source_start_us", "source_end_us"]) && id("clip_id") && us("source_start_us") && us("source_end_us", 1) && Number(value.source_end_us) - Number(value.source_start_us) >= 100_000;
    case "split_clip": return onlyKeys(value, ["op", "clip_id", "source_time_us"]) && id("clip_id") && us("source_time_us", 1);
    case "set_layout": return onlyKeys(value, ["op", "clip_id", "layout"]) && id("clip_id") && isTimelineLayout(value.layout);
    case "set_audio": return onlyKeys(value, ["op", "clip_id", "enabled", "gain_db"]) && id("clip_id") && typeof value.enabled === "boolean" && isFiniteNumber(value.gain_db) && value.gain_db >= -60 && value.gain_db <= 12;
    case "add_transition": return onlyKeys(value, ["op", "after_clip_id", "kind", "duration_us"]) && id("after_clip_id") && oneOf(TRANSITION_IDS, value.kind) && us("duration_us", 100_000) && Number(value.duration_us) <= 2_000_000;
    case "update_transition": return onlyKeys(value, ["op", "transition_id", "kind", "duration_us"]) && id("transition_id") && (value.kind === undefined || oneOf(TRANSITION_IDS, value.kind)) && (value.duration_us === undefined || (us("duration_us", 100_000) && Number(value.duration_us) <= 2_000_000)) && (value.kind !== undefined || value.duration_us !== undefined);
    case "remove_transition": return onlyKeys(value, ["op", "transition_id"]) && id("transition_id");
    case "set_clip_keyframes": return onlyKeys(value, ["op", "clip_id", "property", "frames"]) && id("clip_id") && oneOf(KEYFRAME_PROPERTIES, value.property) && isTimelineKeyframeTrack({ frames: value.frames }, value.property);
    case "clear_clip_keyframes": return onlyKeys(value, ["op", "clip_id", "property"]) && id("clip_id") && oneOf(KEYFRAME_PROPERTIES, value.property);
    case "set_clip_transform": return onlyKeys(value, ["op", "clip_id", "transform"]) && id("clip_id") && isTimelineClipStaticTransform(value.transform);
    case "set_clip_mask": return onlyKeys(value, ["op", "clip_id", "mask"]) && id("clip_id") && isTimelineClipMask(value.mask);
    case "set_clip_keying": return onlyKeys(value, ["op", "clip_id", "keying"]) && id("clip_id") && isTimelineClipKeying(value.keying);
    case "set_speed": return onlyKeys(value, ["op", "clip_id", "speed_milli"]) && id("clip_id") && isInteger(value.speed_milli, 250) && value.speed_milli <= 4000;
    case "set_reverse_playback": return onlyKeys(value, ["op", "clip_id", "reverse_playback"]) && id("clip_id") && typeof value.reverse_playback === "boolean";
    case "set_image_duration": return onlyKeys(value, ["op", "clip_id", "duration_us"]) && id("clip_id") && us("duration_us", 500_000) && Number(value.duration_us) <= 30_000_000;
    case "set_clip_locked": return onlyKeys(value, ["op", "clip_id", "locked"]) && id("clip_id") && typeof value.locked === "boolean";
    case "add_caption": return onlyKeys(value, ["op", "start_us", "end_us", "text", "preset_id", "source_clip_id"]) && us("start_us") && us("end_us", 1) && Number(value.end_us) - Number(value.start_us) >= 200_000 && isString(value.text) && value.text.trim().length > 0 && [...value.text].length <= 200 && isCaptionPresetId(value.preset_id) && value.source_clip_id === null;
    case "import_captions": return onlyKeys(value, ["op", "entries", "preset_id", "replace_existing"]) && Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= 2000 && (value.entries as unknown[]).every(item => isRecord(item) && onlyKeys(item, ["start_us", "end_us", "text"]) && isInteger(item.start_us, 0) && isInteger(item.end_us, 1) && Number(item.end_us) - Number(item.start_us) >= 200_000 && isString(item.text) && item.text.trim().length > 0 && [...item.text].length <= 200) && isCaptionPresetId(value.preset_id) && typeof value.replace_existing === "boolean";
    case "remove_caption": return onlyKeys(value, ["op", "caption_id"]) && id("caption_id");
    case "update_caption": return onlyKeys(value, ["op", "caption_id", "text"]) && id("caption_id") && isString(value.text) && value.text.trim().length > 0 && [...value.text].length <= 200;
    case "set_caption_timing": return onlyKeys(value, ["op", "caption_id", "start_us", "end_us"]) && id("caption_id") && us("start_us") && us("end_us", 1) && Number(value.end_us) - Number(value.start_us) >= 200_000;
    case "set_caption_preset": return onlyKeys(value, ["op", "caption_id", "preset_id"]) && id("caption_id") && isCaptionPresetId(value.preset_id);
    case "set_caption_style": return onlyKeys(value, ["op", "caption_id", "style"]) && id("caption_id") && isCaptionStyleOverride(value.style);
    case "clear_caption_style": return onlyKeys(value, ["op", "caption_id"]) && id("caption_id");
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
const TIMELINE_PATCH_GENERATION_STATUSES: TimelinePatchGenerationStatus[] = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted"];
const TIMELINE_CLIP_CHANGE_TYPES: TimelineClipChangeType[] = ["added", "removed", "moved", "trimmed", "split", "layout_changed", "audio_changed", "duration_changed", "speed_changed", "reverse_toggled", "keyframes_changed", "transform_changed"];
const TIMELINE_CAPTION_CHANGE_TYPES: TimelineCaptionChangeType[] = ["added", "removed", "text_changed", "timing_changed", "preset_changed", "style_changed"];
export function isTimelinePatchEgressPreview(value: unknown): value is TimelinePatchEgressPreview {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["timeline_patch_egress_preview_id", "provider", "prompt_template_version", "output_schema_version", "sent_fields", "payload_sha256", "character_count", "estimated_tokens", "clip_count", "caption_count", "locked_count", "expires_at"]) && isId(value.timeline_patch_egress_preview_id) && isRecord(value.provider) && onlyKeys(value.provider, ["display_name", "origin", "model"]) && isBriefText(value.provider.display_name, 100) && isString(value.provider.origin) && /^https?:\/\//.test(value.provider.origin) && isBriefText(value.provider.model, 200) && isBriefText(value.prompt_template_version, 200) && isBriefText(value.output_schema_version, 200) && Array.isArray(value.sent_fields) && value.sent_fields.length > 0 && value.sent_fields.every(item => isBriefText(item, 100)) && isSha256(value.payload_sha256) && [value.character_count, value.estimated_tokens, value.clip_count, value.caption_count, value.locked_count].every(item => isInteger(item, 0)) && isTime(value.expires_at);
}
export function isTimelinePatchGeneration(value: unknown): value is TimelinePatchGeneration {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["timeline_patch_generation_id", "project_id", "base_revision_id", "base_document_sha256", "status", "payload_sha256", "created_at", "updated_at", "finished_at"]) && isId(value.timeline_patch_generation_id) && isId(value.project_id) && isId(value.base_revision_id) && isSha256(value.base_document_sha256) && oneOf(TIMELINE_PATCH_GENERATION_STATUSES, value.status) && isSha256(value.payload_sha256) && isTime(value.created_at) && isTime(value.updated_at) && (value.finished_at === null || isTime(value.finished_at));
}
export function isTimelineClipChange(value: unknown): value is TimelineClipChange {
  if (!isRecord(value) || hasSensitiveKey(value) || !oneOf(TIMELINE_CLIP_CHANGE_TYPES, value.type) || !isId(value.clip_id)) return false;
  if (value.type === "split") return onlyKeys(value, ["type", "clip_id", "created_clip_ids"]) && Array.isArray(value.created_clip_ids) && value.created_clip_ids.length > 0 && value.created_clip_ids.every(isId);
  return onlyKeys(value, ["type", "clip_id"]);
}
export function isTimelineCaptionChange(value: unknown): value is TimelineCaptionChange { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["type", "caption_id"]) && oneOf(TIMELINE_CAPTION_CHANGE_TYPES, value.type) && isId(value.caption_id); }
export function isTimelineLockChange(value: unknown): value is TimelineLockChange { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["type", "clip_id"]) && oneOf(["locked", "unlocked"] as const, value.type) && isId(value.clip_id); }
export function isTimelineIndirectLockedTimingShift(value: unknown): value is TimelineIndirectLockedTimingShift { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["clip_id", "from_start_us", "from_end_us", "to_start_us", "to_end_us"]) && isId(value.clip_id) && [value.from_start_us, value.from_end_us, value.to_start_us, value.to_end_us].every(item => isInteger(item, 0)) && Number(value.from_end_us) > Number(value.from_start_us) && Number(value.to_end_us) > Number(value.to_start_us); }
export function isTimelineDiff(value: unknown): value is TimelineDiff {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["schema_version", "project_id", "base_revision_id", "target_revision_id", "base_document_sha256", "target_document_sha256", "summary", "duration_delta_us", "clip_changes", "caption_changes", "lock_changes", "indirect_locked_timing_shifts", "transition_changes"]) && value.schema_version === 1 && isId(value.project_id) && isId(value.base_revision_id) && (value.target_revision_id === null || isId(value.target_revision_id)) && isSha256(value.base_document_sha256) && isSha256(value.target_document_sha256) && isRecord(value.summary) && onlyKeys(value.summary, ["clip_changes", "caption_changes", "lock_changes", "transition_changes"]) && [value.summary.clip_changes, value.summary.caption_changes, value.summary.lock_changes, value.summary.transition_changes].every(item => isInteger(item, 0)) && typeof value.duration_delta_us === "number" && Number.isInteger(value.duration_delta_us) && Array.isArray(value.clip_changes) && value.clip_changes.every(isTimelineClipChange) && Array.isArray(value.caption_changes) && value.caption_changes.every(isTimelineCaptionChange) && Array.isArray(value.lock_changes) && value.lock_changes.every(isTimelineLockChange) && Array.isArray(value.indirect_locked_timing_shifts) && value.indirect_locked_timing_shifts.every(isTimelineIndirectLockedTimingShift) && Array.isArray(value.transition_changes) && value.transition_changes.every((item): item is TimelineTransitionChange => isRecord(item) && onlyKeys(item, ["type", "transition_id", "after_clip_id"]) && oneOf(["added", "removed", "updated"] as const, item.type) && isId(item.transition_id) && isId(item.after_clip_id)) && value.summary.clip_changes === value.clip_changes.length && value.summary.caption_changes === value.caption_changes.length && value.summary.lock_changes === value.lock_changes.length && value.summary.transition_changes === value.transition_changes.length;
}
export function isTimelinePatchProposal(value: unknown): value is TimelinePatchProposal { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["schema_version", "timeline_patch_proposal_id", "timeline_patch_generation_id", "project_id", "base_revision_id", "base_document_sha256", "provider_config_id", "provider_display_name", "model", "prompt_template_version", "output_schema_version", "patch", "patch_sha256", "proposed_document_sha256", "diff", "created_at", "applied_revision_id", "generation_status"]) && value.schema_version === 1 && isId(value.timeline_patch_proposal_id) && isId(value.timeline_patch_generation_id) && isId(value.project_id) && isId(value.base_revision_id) && isSha256(value.base_document_sha256) && isId(value.provider_config_id) && isBriefText(value.provider_display_name, 100) && isBriefText(value.model, 200) && isBriefText(value.prompt_template_version, 200) && isBriefText(value.output_schema_version, 200) && isTimelinePatch(value.patch) && value.patch.base_revision_id === value.base_revision_id && isSha256(value.patch_sha256) && isSha256(value.proposed_document_sha256) && isTimelineDiff(value.diff) && value.diff.project_id === value.project_id && value.diff.base_revision_id === value.base_revision_id && value.diff.target_revision_id === null && isTime(value.created_at) && (value.applied_revision_id === null || isId(value.applied_revision_id)) && oneOf(TIMELINE_PATCH_GENERATION_STATUSES, value.generation_status); }
export function isTimelinePatchPrepareRequest(value: unknown): value is TimelinePatchPrepareRequest { return isRecord(value) && onlyKeys(value, ["base_revision_id", "provider_config_id", "instruction"]) && isId(value.base_revision_id) && isId(value.provider_config_id) && isString(value.instruction) && value.instruction.trim().length >= 1 && [...value.instruction].length <= 4000 && !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.instruction); }
export function isTimelinePatchGenerationCreateRequest(value: unknown): value is TimelinePatchGenerationCreateRequest { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["timeline_patch_egress_preview_id", "payload_sha256"]) && isId(value.timeline_patch_egress_preview_id) && isSha256(value.payload_sha256); }
export function isTimelinePatchGenerationCreateResponse(value: unknown): value is TimelinePatchGenerationCreateResponse { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["timeline_patch_generation_id", "job"]) && isId(value.timeline_patch_generation_id) && isJob(value.job) && value.job.kind === "timeline_patch_generation"; }
export function isTimelinePatchProposalApplyRequest(value: unknown): value is TimelinePatchProposalApplyRequest { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["base_revision_id", "proposed_document_sha256"]) && isId(value.base_revision_id) && isSha256(value.proposed_document_sha256); }
export function isTimelineRevisionDiffRequest(value: unknown): value is TimelineRevisionDiffRequest { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["base_revision_id", "target_revision_id"]) && isId(value.base_revision_id) && isId(value.target_revision_id); }
export function parseTimelinePatchEgressPreview(value: unknown): TimelinePatchEgressPreview { if (!isTimelinePatchEgressPreview(value)) throw new ContractValidationError("TimelinePatchEgressPreview"); return value; }
export function parseTimelinePatchGeneration(value: unknown): TimelinePatchGeneration { if (!isTimelinePatchGeneration(value)) throw new ContractValidationError("TimelinePatchGeneration"); return value; }
export function parseTimelineDiff(value: unknown): TimelineDiff { if (!isTimelineDiff(value)) throw new ContractValidationError("TimelineDiff"); return value; }
export function parseTimelinePatchProposal(value: unknown): TimelinePatchProposal { if (!isTimelinePatchProposal(value)) throw new ContractValidationError("TimelinePatchProposal"); return value; }
export function parseTimelinePatchGenerationCreateResponse(value: unknown): TimelinePatchGenerationCreateResponse { if (!isTimelinePatchGenerationCreateResponse(value)) throw new ContractValidationError("TimelinePatchGenerationCreateResponse"); return value; }
export function parseRenderedMediaInfo(value: unknown): RenderedMediaInfo { if (!isRenderedMediaInfo(value)) throw new ContractValidationError("RenderedMediaInfo"); return value; }
export function parseRenderArtifact(value: unknown): RenderArtifact { if (!isRenderArtifact(value)) throw new ContractValidationError("RenderArtifact"); return value; }
export function parseAuthoritativePreview(value: unknown): AuthoritativePreview { if (!isAuthoritativePreview(value)) throw new ContractValidationError("AuthoritativePreview"); return value; }
export function parseExportRecord(value: unknown): ExportRecord { if (!isExportRecord(value)) throw new ContractValidationError("ExportRecord"); return value; }
export function parseDestinationGrant(value: unknown): DestinationGrant { if (!isDestinationGrant(value)) throw new ContractValidationError("DestinationGrant"); return value; }
export function parsePreviewCreateInput(value: unknown): PreviewCreateInput { if (!isPreviewCreateInput(value)) throw new ContractValidationError("PreviewCreateInput"); return value; }
export function parsePreviewCreateResponse(value: unknown): PreviewCreateResponse { if (!isPreviewCreateResponse(value)) throw new ContractValidationError("PreviewCreateResponse"); return value; }
export function parseExportCreateInput(value: unknown): ExportCreateInput { if (!isExportCreateInput(value)) throw new ContractValidationError("ExportCreateInput"); return value; }
export function parseExportCreateResponse(value: unknown): ExportCreateResponse { if (!isExportCreateResponse(value)) throw new ContractValidationError("ExportCreateResponse"); return value; }

const LAYOUT_POLICIES: LayoutPolicy[] = ["preserve_timeline", "fit_all", "crop_fill_all", "blurred_background_all"];
const RENDITION_WARNINGS: RenditionWarningCode[] = ["CENTER_CROP_MAY_HIDE_CONTENT", "LETTERBOX_EXPECTED", "PILLARBOX_EXPECTED"];
const EXPORT_BATCH_ITEM_STATUSES: ExportBatchItemStatus[] = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted"];
const EXPORT_BATCH_STATUSES: ExportBatchStatus[] = ["queued", "running", "succeeded", "partial", "failed", "cancelled", "interrupted"];
const HORIZONTAL_ANCHORS: HorizontalAnchor[] = ["left", "center", "right"];
const VERTICAL_ANCHORS: VerticalAnchor[] = ["top", "center", "bottom"];
const REFRAME_WARNINGS: ReframeWarningCode[] = ["STATIC_REFRAME_APPLIED", "REFRAME_AXIS_NORMALIZED", "REFRAME_MAY_HIDE_OPPOSITE_EDGE"];
const TARGET_RENDER_PROFILE_IDS: TargetRenderProfileId[] = ["preview-portrait-9x16-v1", "export-portrait-9x16-v1", "preview-landscape-16x9-v1", "export-landscape-16x9-v1"];
const isPlatformPresetId = (value: unknown): value is PlatformPresetId => isId(value) && /^(generic|douyin|wechat-channels|xiaohongshu)$/.test(value);
const isRenditionPresetId = (value: unknown): value is RenditionPresetId => isId(value) && /^(portrait-9x16-v1|landscape-16x9-v1)$/.test(value);
const isDirectoryGrantId = (value: unknown): value is DirectoryGrantId => isId(value) && value.startsWith("directory_");
const isRenditionSnapshotId = (value: unknown): value is RenditionSnapshotId => isId(value) && value.startsWith("rendition_snapshot_");
const isExportBatchId = (value: unknown): value is ExportBatchId => isId(value) && value.startsWith("export_batch_");
const isExportBatchItemId = (value: unknown): value is ExportBatchItemId => isId(value) && value.startsWith("export_batch_item_");
const isRenditionReframeSnapshotId = (value: unknown): value is RenditionReframeSnapshotId => isId(value) && value.startsWith("rendition_reframe_snapshot_");
const isReframeExportBatchId = (value: unknown): value is ReframeExportBatchId => isId(value) && value.startsWith("reframe_export_batch_");
const isReframeExportBatchItemId = (value: unknown): value is ReframeExportBatchItemId => isId(value) && value.startsWith("reframe_export_batch_item_");
const isTargetProfileId = (value: unknown): value is TargetRenderProfileId => oneOf(TARGET_RENDER_PROFILE_IDS, value);
const isDimensions = (value: unknown): value is { width: number; height: number } => isRecord(value) && onlyKeys(value, ["width", "height"]) && isInteger(value.width, 1) && isInteger(value.height, 1);
export function isLayoutPolicy(value: unknown): value is LayoutPolicy { return oneOf(LAYOUT_POLICIES, value); }
export function isPlatformPreset(value: unknown): value is PlatformPreset {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["schema_version", "platform_preset_id", "display_name", "preset_version", "allowed_rendition_ids", "default_rendition_id", "filename_tag", "document_sha256"])
    && value.schema_version === 1 && isPlatformPresetId(value.platform_preset_id) && isBriefText(value.display_name, 40) && value.preset_version === 1
    && Array.isArray(value.allowed_rendition_ids) && value.allowed_rendition_ids.length > 0 && value.allowed_rendition_ids.every(isRenditionPresetId) && new Set(value.allowed_rendition_ids).size === value.allowed_rendition_ids.length
    && isRenditionPresetId(value.default_rendition_id) && value.allowed_rendition_ids.includes(value.default_rendition_id) && isString(value.filename_tag) && /^[a-z0-9-]{1,32}$/.test(value.filename_tag) && isSha256(value.document_sha256);
}
export function isRenditionPreset(value: unknown): value is RenditionPreset {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["schema_version", "rendition_preset_id", "display_name", "preset_version", "document_sha256", "preview_profile_id", "export_profile_id", "preview", "export"])
    && value.schema_version === 1 && isRenditionPresetId(value.rendition_preset_id) && isBriefText(value.display_name, 40) && value.preset_version === 1 && isSha256(value.document_sha256)
    && isTargetProfileId(value.preview_profile_id) && isTargetProfileId(value.export_profile_id) && isDimensions(value.preview) && isDimensions(value.export);
}
export function isRenditionSnapshotSummary(value: unknown): value is RenditionSnapshotSummary {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["rendition_snapshot_id", "project_id", "timeline_revision_id", "platform_preset_id", "rendition_preset_id", "layout_policy", "snapshot_sha256", "warnings", "created_at"])
    && isRenditionSnapshotId(value.rendition_snapshot_id) && isId(value.project_id) && isId(value.timeline_revision_id) && isPlatformPresetId(value.platform_preset_id) && isRenditionPresetId(value.rendition_preset_id) && isLayoutPolicy(value.layout_policy) && isSha256(value.snapshot_sha256)
    && Array.isArray(value.warnings) && value.warnings.every(item => oneOf(RENDITION_WARNINGS, item)) && new Set(value.warnings).size === value.warnings.length && isTime(value.created_at);
}
export function isRenditionPreview(value: unknown): value is RenditionPreview {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["rendition_snapshot_id", "project_id", "timeline_revision_id", "platform_preset_id", "rendition_preset_id", "layout_policy", "snapshot_sha256", "warnings", "created_at", "render_artifact_id", "status", "profile_id", "display_name", "size_bytes", "sha256", "media_info", "encoder", "fallback_reason"])
    && isRenditionSnapshotSummary(Object.fromEntries(["rendition_snapshot_id", "project_id", "timeline_revision_id", "platform_preset_id", "rendition_preset_id", "layout_policy", "snapshot_sha256", "warnings", "created_at"].map(key => [key, value[key]])))
    && isId(value.render_artifact_id) && oneOf(RENDER_ARTIFACT_STATUSES, value.status) && isTargetProfileId(value.profile_id) && isBriefText(value.display_name, 200) && isInteger(value.size_bytes, 0) && isSha256(value.sha256) && isRenderedMediaInfo(value.media_info) && isBriefText(value.encoder, 100) && isNullableString(value.fallback_reason);
}
export function isRenditionPreviewCreateInput(value: unknown): value is RenditionPreviewCreateInput { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["timeline_revision_id", "platform_preset_id", "rendition_preset_id", "layout_policy", "encoder_mode"]) && isId(value.timeline_revision_id) && isPlatformPresetId(value.platform_preset_id) && isRenditionPresetId(value.rendition_preset_id) && isLayoutPolicy(value.layout_policy) && (value.encoder_mode === undefined || oneOf(ENCODER_MODES, value.encoder_mode)); }
export function isRenditionPreviewCreateResponse(value: unknown): value is RenditionPreviewCreateResponse { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["job", "preview", "reused"]) && (value.job === null || isJob(value.job)) && (value.preview === null || isRenditionPreview(value.preview)) && typeof value.reused === "boolean"; }
export function isDirectoryGrant(value: unknown): value is DirectoryGrant { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["directory_grant_id", "display_name", "expires_at"]) && isDirectoryGrantId(value.directory_grant_id) && isBriefText(value.display_name, 200) && isTime(value.expires_at); }
export function isExportBatchCreateInput(value: unknown): value is ExportBatchCreateInput {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["timeline_revision_id", "directory_grant_id", "items"]) || !isId(value.timeline_revision_id) || !isDirectoryGrantId(value.directory_grant_id) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 8) return false;
  return value.items.every(item => isRecord(item) && !hasSensitiveKey(item) && onlyKeys(item, ["rendition_snapshot_id", "preview_artifact_id", "encoder_mode"]) && isRenditionSnapshotId(item.rendition_snapshot_id) && isId(item.preview_artifact_id) && (item.encoder_mode === undefined || oneOf(ENCODER_MODES, item.encoder_mode))) && new Set(value.items.map(item => `${String((item as Record<string, unknown>).rendition_snapshot_id)}:${String((item as Record<string, unknown>).preview_artifact_id)}`)).size === value.items.length;
}
export function isExportBatchItem(value: unknown): value is ExportBatchItem { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["export_batch_item_id", "ordinal", "rendition_snapshot", "preview_artifact_id", "status", "progress", "job_id", "destination_display_name", "error_code", "export_record_id", "retry_of_item_id"]) && isExportBatchItemId(value.export_batch_item_id) && isInteger(value.ordinal, 0) && isRenditionSnapshotSummary(value.rendition_snapshot) && isId(value.preview_artifact_id) && oneOf(EXPORT_BATCH_ITEM_STATUSES, value.status) && (value.progress === null || isRatio(value.progress)) && (value.job_id === null || isId(value.job_id)) && (value.destination_display_name === null || isBriefText(value.destination_display_name, 200)) && (value.error_code === null || isBriefText(value.error_code, 100)) && (value.export_record_id === null || isId(value.export_record_id)) && (value.retry_of_item_id === null || isExportBatchItemId(value.retry_of_item_id)); }
export function isExportBatch(value: unknown): value is ExportBatch { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["export_batch_id", "project_id", "timeline_revision_id", "status", "directory_display_name", "items", "retry_of_batch_id", "created_at", "updated_at"]) && isExportBatchId(value.export_batch_id) && isId(value.project_id) && isId(value.timeline_revision_id) && oneOf(EXPORT_BATCH_STATUSES, value.status) && isBriefText(value.directory_display_name, 200) && Array.isArray(value.items) && value.items.length >= 1 && value.items.length <= 8 && value.items.every(isExportBatchItem) && (value.retry_of_batch_id === null || isExportBatchId(value.retry_of_batch_id)) && isTime(value.created_at) && isTime(value.updated_at); }
export function isExportBatchCreateResponse(value: unknown): value is ExportBatchCreateResponse { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["batch", "jobs"]) && isExportBatch(value.batch) && Array.isArray(value.jobs) && value.jobs.every(isJob); }
export function isExportBatchRetryInput(value: unknown): value is ExportBatchRetryInput { return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["directory_grant_id", "export_batch_item_ids"]) && isDirectoryGrantId(value.directory_grant_id) && Array.isArray(value.export_batch_item_ids) && value.export_batch_item_ids.length >= 1 && value.export_batch_item_ids.length <= 8 && value.export_batch_item_ids.every(isExportBatchItemId) && new Set(value.export_batch_item_ids).size === value.export_batch_item_ids.length; }
export const isExportBatchRetryResponse = isExportBatchCreateResponse;
export function isRenditionReframeAdjustment(value: unknown): value is RenditionReframeAdjustment {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["clip_id", "horizontal_anchor", "vertical_anchor"])
    && isId(value.clip_id) && oneOf(HORIZONTAL_ANCHORS, value.horizontal_anchor) && oneOf(VERTICAL_ANCHORS, value.vertical_anchor)
    && !(value.horizontal_anchor === "center" && value.vertical_anchor === "center");
}
export function isRenditionReframePreviewCreateInput(value: unknown): value is RenditionReframePreviewCreateInput {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["base_rendition_snapshot_id", "adjustments", "encoder_mode"])
    || !isRenditionSnapshotId(value.base_rendition_snapshot_id) || !Array.isArray(value.adjustments)
    || value.adjustments.length < 1 || value.adjustments.length > 500
    || (value.encoder_mode !== undefined && !oneOf(ENCODER_MODES, value.encoder_mode))) return false;
  return value.adjustments.every(isRenditionReframeAdjustment)
    && new Set(value.adjustments.map(item => item.clip_id)).size === value.adjustments.length;
}
export function isRenditionReframeSnapshotSummary(value: unknown): value is RenditionReframeSnapshotSummary {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["rendition_reframe_snapshot_id", "project_id", "timeline_revision_id", "base_rendition_snapshot_id", "base_snapshot_sha256", "platform_preset_id", "rendition_preset_id", "adjustment_count", "reframe_snapshot_sha256", "warnings", "created_at"])
    && isRenditionReframeSnapshotId(value.rendition_reframe_snapshot_id) && isId(value.project_id) && isId(value.timeline_revision_id)
    && isRenditionSnapshotId(value.base_rendition_snapshot_id) && isSha256(value.base_snapshot_sha256)
    && isPlatformPresetId(value.platform_preset_id) && isRenditionPresetId(value.rendition_preset_id)
    && isInteger(value.adjustment_count, 1) && value.adjustment_count <= 500 && isSha256(value.reframe_snapshot_sha256)
    && Array.isArray(value.warnings) && value.warnings.every(item => oneOf(REFRAME_WARNINGS, item))
    && new Set(value.warnings).size === value.warnings.length && isTime(value.created_at);
}
export function isRenditionReframePreview(value: unknown): value is RenditionReframePreview {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["rendition_reframe_snapshot_id", "project_id", "timeline_revision_id", "base_rendition_snapshot_id", "base_snapshot_sha256", "platform_preset_id", "rendition_preset_id", "adjustment_count", "reframe_snapshot_sha256", "warnings", "created_at", "render_artifact_id", "status", "profile_id", "display_name", "size_bytes", "sha256", "media_info", "encoder", "fallback_reason"])) return false;
  const summaryKeys = ["rendition_reframe_snapshot_id", "project_id", "timeline_revision_id", "base_rendition_snapshot_id", "base_snapshot_sha256", "platform_preset_id", "rendition_preset_id", "adjustment_count", "reframe_snapshot_sha256", "warnings", "created_at"];
  return isRenditionReframeSnapshotSummary(Object.fromEntries(summaryKeys.map(key => [key, value[key]])))
    && isId(value.render_artifact_id) && oneOf(RENDER_ARTIFACT_STATUSES, value.status) && isTargetProfileId(value.profile_id)
    && isBriefText(value.display_name, 200) && isInteger(value.size_bytes, 0) && isSha256(value.sha256)
    && isRenderedMediaInfo(value.media_info) && isBriefText(value.encoder, 100) && isNullableString(value.fallback_reason);
}
export function isRenditionReframePreviewCreateResponse(value: unknown): value is RenditionReframePreviewCreateResponse {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["job", "preview", "reused"])
    && (value.job === null || (isJob(value.job) && value.job.kind === "authoritative_preview"))
    && (value.preview === null || isRenditionReframePreview(value.preview)) && typeof value.reused === "boolean"
    && ((value.reused && value.job === null && value.preview !== null) || (!value.reused && value.job !== null && value.preview === null));
}
export function isReframeExportBatchCreateInput(value: unknown): value is ReframeExportBatchCreateInput {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, ["directory_grant_id", "items"])
    || !isDirectoryGrantId(value.directory_grant_id) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 8) return false;
  if (!value.items.every(item => isRecord(item) && !hasSensitiveKey(item) && onlyKeys(item, ["rendition_reframe_snapshot_id", "preview_artifact_id", "encoder_mode"])
    && isRenditionReframeSnapshotId(item.rendition_reframe_snapshot_id) && isId(item.preview_artifact_id)
    && (item.encoder_mode === undefined || oneOf(ENCODER_MODES, item.encoder_mode)))) return false;
  return new Set(value.items.map(item => (item as ReframeExportBatchCreateItem).rendition_reframe_snapshot_id)).size === value.items.length
    && new Set(value.items.map(item => (item as ReframeExportBatchCreateItem).preview_artifact_id)).size === value.items.length;
}
export function isReframeExportBatchItem(value: unknown): value is ReframeExportBatchItem {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["reframe_export_batch_item_id", "ordinal", "rendition_reframe_snapshot", "preview_artifact_id", "status", "progress", "job_id", "destination_display_name", "error_code", "export_record_id", "retry_of_item_id"])
    && isReframeExportBatchItemId(value.reframe_export_batch_item_id) && isInteger(value.ordinal, 0)
    && isRenditionReframeSnapshotSummary(value.rendition_reframe_snapshot) && isId(value.preview_artifact_id)
    && oneOf(EXPORT_BATCH_ITEM_STATUSES, value.status) && (value.progress === null || isRatio(value.progress))
    && (value.job_id === null || isId(value.job_id)) && (value.destination_display_name === null || isBriefText(value.destination_display_name, 200))
    && (value.error_code === null || isBriefText(value.error_code, 100)) && (value.export_record_id === null || isId(value.export_record_id))
    && (value.retry_of_item_id === null || isReframeExportBatchItemId(value.retry_of_item_id));
}
export function isReframeExportBatch(value: unknown): value is ReframeExportBatch {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["reframe_export_batch_id", "project_id", "timeline_revision_id", "status", "directory_display_name", "items", "retry_of_batch_id", "created_at", "updated_at"])
    && isReframeExportBatchId(value.reframe_export_batch_id) && isId(value.project_id) && isId(value.timeline_revision_id)
    && oneOf(EXPORT_BATCH_STATUSES, value.status) && isBriefText(value.directory_display_name, 200)
    && Array.isArray(value.items) && value.items.length >= 1 && value.items.length <= 8 && value.items.every(isReframeExportBatchItem)
    && (value.retry_of_batch_id === null || isReframeExportBatchId(value.retry_of_batch_id)) && isTime(value.created_at) && isTime(value.updated_at);
}
export function isReframeExportBatchCreateResponse(value: unknown): value is ReframeExportBatchCreateResponse {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["batch", "jobs"])
    && isReframeExportBatch(value.batch) && Array.isArray(value.jobs) && value.jobs.every(job => isJob(job) && job.kind === "final_export");
}
export function isReframeExportBatchRetryInput(value: unknown): value is ReframeExportBatchRetryInput {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["directory_grant_id", "reframe_export_batch_item_ids"])
    && isDirectoryGrantId(value.directory_grant_id) && Array.isArray(value.reframe_export_batch_item_ids)
    && value.reframe_export_batch_item_ids.length >= 1 && value.reframe_export_batch_item_ids.length <= 8
    && value.reframe_export_batch_item_ids.every(isReframeExportBatchItemId)
    && new Set(value.reframe_export_batch_item_ids).size === value.reframe_export_batch_item_ids.length;
}
export const isReframeExportBatchRetryResponse = isReframeExportBatchCreateResponse;
const GENERATION_STATUSES: GenerationStatus[] = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted"];
const GENERATION_STAGES = ["queued", "running", "completed", "failed", "cancelled", "interrupted"] as const;
const GENERATION_RESPONSE_SENSITIVE_KEYS = new Set(["prompt", "absolute_path", "path", "uri", "transcript", "caption", "payload", "raw_response", "stderr", "command", "traceback", "api_key", "secret", "authorization", "token"]);
function hasGenerationResponseSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasGenerationResponseSensitiveKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => GENERATION_RESPONSE_SENSITIVE_KEYS.has(key.toLowerCase()) || hasGenerationResponseSensitiveKey(item));
}
function isGenerationPrompt(value: unknown): value is string {
  return isString(value) && value.length >= 1 && value.length <= 4000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}
function isInputRefs(value: unknown, canonical = false): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || !value.every(isId) || new Set(value).size !== value.length) return false;
  return !canonical || value.every((item, index) => index === 0 || value[index - 1] <= item);
}
export function isImageGenerationParameters(value: unknown): value is ImageGenerationParameters {
  return isRecord(value) && !hasGenerationResponseSensitiveKey(value) && onlyKeys(value, ["width", "height", "style_preset_id", "seed"])
    && isInteger(value.width, 64) && value.width <= 4096 && isInteger(value.height, 64) && value.height <= 4096
    && (value.style_preset_id === undefined || isId(value.style_preset_id))
    && (value.seed === undefined || (isInteger(value.seed) && value.seed <= 2147483647));
}
export function isTtsGenerationParameters(value: unknown): value is TtsGenerationParameters {
  return isRecord(value) && !hasGenerationResponseSensitiveKey(value) && onlyKeys(value, ["voice_preset_id", "language", "speed_milli"])
    && isId(value.voice_preset_id) && oneOf(["zh-CN", "en-US"] as const, value.language)
    && isInteger(value.speed_milli, 500) && value.speed_milli <= 2000;
}
function isGenerationParameters(kind: unknown, value: unknown): value is MediaGenerationParameters {
  return kind === "image" ? isImageGenerationParameters(value) : kind === "tts" ? isTtsGenerationParameters(value) : false;
}
export function isMediaGenerationPrepareInput(value: unknown): value is MediaGenerationPrepareInput {
  return isRecord(value) && onlyKeys(value, ["generation_kind", "prompt", "input_refs", "parameters"])
    && oneOf(["image", "tts"] as const, value.generation_kind) && isGenerationPrompt(value.prompt)
    && isInputRefs(value.input_refs) && isGenerationParameters(value.generation_kind, value.parameters);
}
export function isMediaGenerationCreateInput(value: unknown): value is MediaGenerationCreateInput {
  if (!isRecord(value) || !onlyKeys(value, ["generation_kind", "prompt", "input_refs", "parameters", "request_sha256"]) || !isSha256(value.request_sha256)) return false;
  const { request_sha256: _requestSha256, ...prepare } = value;
  return isMediaGenerationPrepareInput(prepare);
}
export function isMediaGenerationPreparedRequest(value: unknown): value is MediaGenerationPreparedRequest {
  return isRecord(value) && !hasGenerationResponseSensitiveKey(value) && onlyKeys(value, ["schema_version", "project_id", "generation_kind", "execution_mode", "prompt_sha256", "input_refs", "parameters", "request_sha256"])
    && value.schema_version === 1 && isId(value.project_id) && oneOf(["image", "tts"] as const, value.generation_kind)
    && value.execution_mode === "simulation_only" && isSha256(value.prompt_sha256) && isInputRefs(value.input_refs, true)
    && isGenerationParameters(value.generation_kind, value.parameters) && isSha256(value.request_sha256);
}
export function isMediaGenerationRequest(value: unknown): value is MediaGenerationRequest {
  return isRecord(value) && !hasGenerationResponseSensitiveKey(value) && onlyKeys(value, ["request_id", "project_id", "generation_kind", "execution_mode", "prompt_sha256", "input_refs", "parameters", "request_sha256", "created_at"])
    && isId(value.request_id) && isId(value.project_id) && oneOf(["image", "tts"] as const, value.generation_kind)
    && value.execution_mode === "simulation_only" && isSha256(value.prompt_sha256) && isInputRefs(value.input_refs, true)
    && isGenerationParameters(value.generation_kind, value.parameters) && isSha256(value.request_sha256) && isTime(value.created_at);
}
export function isMediaGenerationResultSummary(value: unknown): value is MediaGenerationResultSummary {
  return isRecord(value) && !hasGenerationResponseSensitiveKey(value) && onlyKeys(value, ["execution_mode", "outcome", "provider_call_count"])
    && value.execution_mode === "simulation_only" && value.outcome === "validated_without_media" && value.provider_call_count === 0;
}
export function isMediaGenerationTask(value: unknown): value is MediaGenerationTask {
  if (!isRecord(value) || hasGenerationResponseSensitiveKey(value) || !onlyKeys(value, ["task_id", "request_id", "job_id", "attempt", "status", "stage", "retry_of_task_id", "output_asset_id", "output_sha256", "result_summary", "error", "created_at", "updated_at", "finished_at"])) return false;
  if (!isId(value.task_id) || !isId(value.request_id) || !isId(value.job_id) || !isInteger(value.attempt, 1) || !oneOf(GENERATION_STATUSES, value.status) || !oneOf(GENERATION_STAGES, value.stage)) return false;
  if (!(value.retry_of_task_id === null || isId(value.retry_of_task_id)) || !(value.output_asset_id === null || isId(value.output_asset_id)) || !(value.output_sha256 === null || isSha256(value.output_sha256))) return false;
  if (!(value.result_summary === null || isMediaGenerationResultSummary(value.result_summary)) || !(value.error === null || (isRecord(value.error) && onlyKeys(value.error, ["code", "message"]) && isString(value.error.code) && isString(value.error.message)))) return false;
  if (!isTime(value.created_at) || !isTime(value.updated_at) || !(value.finished_at === null || isTime(value.finished_at))) return false;
  if (value.status === "succeeded" && (value.stage !== "completed" || !isMediaGenerationResultSummary(value.result_summary) || value.error !== null)) return false;
  if (value.status !== "succeeded" && value.result_summary !== null) return false;
  if (["queued", "running"].includes(value.status) && value.finished_at !== null) return false;
  return true;
}
export function isMediaGenerationCreateResponse(value: unknown): value is MediaGenerationCreateResponse {
  return isRecord(value) && !hasGenerationResponseSensitiveKey(value) && onlyKeys(value, ["request", "task", "reused"])
    && isMediaGenerationRequest(value.request) && isMediaGenerationTask(value.task) && typeof value.reused === "boolean"
    && value.task.request_id === value.request.request_id;
}
export function isMediaGenerationRequestPage(value: unknown): value is MediaGenerationRequestPage { return isPage(value, isMediaGenerationRequest); }
export function isMediaGenerationTaskPage(value: unknown): value is MediaGenerationTaskPage { return isPage(value, isMediaGenerationTask); }
export function isMediaGenerationRetryInput(value: unknown): value is MediaGenerationRetryInput { return isRecord(value) && Object.keys(value).length === 0; }

const PROVIDER_IMAGE_SIZES: ProviderImageSize[] = ["1024x1024"];
function isProviderImageSafe(value: unknown): boolean { return !hasGenerationResponseSensitiveKey(value); }
export function isImageProviderConfigCreateInput(value: unknown): value is ImageProviderConfigCreateInput {
  return isRecord(value) && onlyKeys(value, ["display_name", "enabled"]) && isString(value.display_name) && value.display_name.trim().length >= 1 && value.display_name.trim().length <= 120 && typeof value.enabled === "boolean";
}
export function isImageProviderConfigSummary(value: unknown): value is ImageProviderConfigSummary {
  return isRecord(value) && isProviderImageSafe(value) && onlyKeys(value, ["provider_config_id", "project_id", "provider_kind", "adapter_id", "capability", "protocol_version", "display_name", "model", "enabled", "price_per_image", "price_2k_per_image", "price_currency", "credential_status", "created_at", "updated_at"]) && isId(value.provider_config_id) && isId(value.project_id) && value.provider_kind === "apikey_fun_images" && value.adapter_id === "apikey_fun_images_sse_v1" && value.capability === "image_text_to_image" && value.protocol_version === "1" && isString(value.display_name) && value.model === "gpt-image-2" && typeof value.enabled === "boolean" && value.price_per_image === 0.1 && value.price_2k_per_image === 0.15 && value.price_currency === "CNY" && oneOf(["missing", "configured"] as const, value.credential_status) && isTime(value.created_at) && isTime(value.updated_at);
}
export function isImageProviderConfigPage(value: unknown): value is ImageProviderConfigPage { return isRecord(value) && onlyKeys(value, ["items"]) && Array.isArray(value.items) && value.items.every(isImageProviderConfigSummary); }
export function isProviderImageGenerationPrepareInput(value: unknown): value is ProviderImageGenerationPrepareInput { return isRecord(value) && onlyKeys(value, ["provider_config_id", "prompt", "size"]) && isId(value.provider_config_id) && isGenerationPrompt(value.prompt) && oneOf(PROVIDER_IMAGE_SIZES, value.size); }
export function isProviderImageGenerationPreparedPreview(value: unknown): value is ProviderImageGenerationPreparedPreview {
  return isRecord(value) && isProviderImageSafe(value) && onlyKeys(value, ["preview_id", "project_id", "execution_mode", "prompt_sha256", "payload_sha256", "size", "output_format", "image_count", "provider", "estimated_cost", "estimated_cost_currency", "price_tier", "expires_at"]) && isId(value.preview_id) && isId(value.project_id) && value.execution_mode === "provider_image_v1" && isSha256(value.prompt_sha256) && isSha256(value.payload_sha256) && oneOf(PROVIDER_IMAGE_SIZES, value.size) && value.output_format === "png" && value.image_count === 1 && isRecord(value.provider) && onlyKeys(value.provider, ["provider_config_id", "provider_kind", "adapter_id", "model"]) && isId(value.provider.provider_config_id) && value.provider.provider_kind === "apikey_fun_images" && value.provider.adapter_id === "apikey_fun_images_sse_v1" && value.provider.model === "gpt-image-2" && (value.estimated_cost === null || (isFiniteNumber(value.estimated_cost) && value.estimated_cost >= 0)) && value.estimated_cost_currency === "CNY" && value.price_tier === "1K" && isTime(value.expires_at);
}
export function isProviderImageGenerationCreateInput(value: unknown): value is ProviderImageGenerationCreateInput { return isRecord(value) && onlyKeys(value, ["preview_id", "payload_sha256", "confirmed"]) && isId(value.preview_id) && isSha256(value.payload_sha256) && value.confirmed === true; }
export function isProviderImageGenerationRequest(value: unknown): value is ProviderImageGenerationRequest { return isRecord(value) && isProviderImageSafe(value) && onlyKeys(value, ["request_id", "project_id", "generation_kind", "execution_mode", "prompt_sha256", "parameters", "request_sha256", "created_at"]) && isId(value.request_id) && isId(value.project_id) && value.generation_kind === "image" && value.execution_mode === "provider_image_v1" && isSha256(value.prompt_sha256) && isRecord(value.parameters) && onlyKeys(value.parameters, ["size"]) && oneOf(PROVIDER_IMAGE_SIZES, value.parameters.size) && isSha256(value.request_sha256) && isTime(value.created_at); }
export function isProviderImageAssetSummary(value: unknown): value is ProviderImageAssetSummary { return isRecord(value) && isProviderImageSafe(value) && onlyKeys(value, ["asset_id", "display_name", "kind", "storage_mode", "availability"]) && isId(value.asset_id) && isString(value.display_name) && value.kind === "image" && value.storage_mode === "managed" && value.availability === "available"; }
export function isProviderImageGenerationResultSummary(value: unknown): value is ProviderImageGenerationResultSummary { return isRecord(value) && isProviderImageSafe(value) && onlyKeys(value, ["execution_mode", "provider_call_count", "asset", "output", "provider", "estimated_cost", "estimated_cost_currency", "price_tier", "provenance_id"]) && value.execution_mode === "provider_image_v1" && value.provider_call_count === 1 && isProviderImageAssetSummary(value.asset) && isRecord(value.output) && onlyKeys(value.output, ["format", "width", "height", "size_bytes", "sha256"]) && value.output.format === "png" && isInteger(value.output.width, 1) && isInteger(value.output.height, 1) && isInteger(value.output.size_bytes, 1) && isSha256(value.output.sha256) && isRecord(value.provider) && onlyKeys(value.provider, ["kind", "adapter_id", "model"]) && value.provider.kind === "apikey_fun_images" && value.provider.adapter_id === "apikey_fun_images_sse_v1" && value.provider.model === "gpt-image-2" && (value.estimated_cost === null || (isFiniteNumber(value.estimated_cost) && value.estimated_cost >= 0)) && value.estimated_cost_currency === "CNY" && value.price_tier === "1K" && isId(value.provenance_id); }
export function isProviderImageGenerationTask(value: unknown): value is ProviderImageGenerationTask { if (!isRecord(value) || !isProviderImageSafe(value) || !onlyKeys(value, ["task_id", "request_id", "job_id", "attempt", "status", "stage", "retry_of_task_id", "provider_call_count", "provider_may_have_processed", "estimated_cost", "estimated_cost_currency", "price_tier", "output_asset_id", "output_sha256", "result_summary", "error", "created_at", "updated_at", "finished_at"])) return false; return isId(value.task_id) && isId(value.request_id) && isId(value.job_id) && isInteger(value.attempt, 1) && oneOf(GENERATION_STATUSES, value.status) && isString(value.stage) && value.stage.length > 0 && (value.retry_of_task_id === null || isId(value.retry_of_task_id)) && (value.provider_call_count === 0 || value.provider_call_count === 1) && typeof value.provider_may_have_processed === "boolean" && (!value.provider_may_have_processed || value.provider_call_count === 1) && (value.estimated_cost === null || (isFiniteNumber(value.estimated_cost) && value.estimated_cost >= 0)) && value.estimated_cost_currency === "CNY" && value.price_tier === "1K" && (value.output_asset_id === null || isId(value.output_asset_id)) && (value.output_sha256 === null || isSha256(value.output_sha256)) && (value.result_summary === null || isProviderImageGenerationResultSummary(value.result_summary)) && (value.error === null || (isRecord(value.error) && onlyKeys(value.error, ["code", "message"]) && isString(value.error.code) && isString(value.error.message))) && isTime(value.created_at) && isTime(value.updated_at) && (value.finished_at === null || isTime(value.finished_at)) && (value.status !== "succeeded" || (value.result_summary !== null && value.error === null)); }
export function isProviderImageGenerationCreateResponse(value: unknown): value is ProviderImageGenerationCreateResponse { return isRecord(value) && isProviderImageSafe(value) && onlyKeys(value, ["request", "task", "reused"]) && isProviderImageGenerationRequest(value.request) && isProviderImageGenerationTask(value.task) && typeof value.reused === "boolean" && value.task.request_id === value.request.request_id; }
export function isProviderImageGenerationRequestPage(value: unknown): value is ProviderImageGenerationRequestPage { return isPage(value, isProviderImageGenerationRequest); }
export function isProviderImageGenerationTaskPage(value: unknown): value is ProviderImageGenerationTaskPage { return isPage(value, isProviderImageGenerationTask); }
export function isProviderImageGenerationRetryPrepareInput(value: unknown): value is ProviderImageGenerationRetryPrepareInput { return isRecord(value) && onlyKeys(value, ["prompt"]) && isGenerationPrompt(value.prompt); }
export const isProviderImageGenerationRetryPreparedPreview = isProviderImageGenerationPreparedPreview;
export const isProviderImageGenerationRetryInput = isProviderImageGenerationCreateInput;
const SHOT_SENSITIVE_KEYS = new Set([
  "path", "uri", "absolute_path", "prompt", "transcript", "caption", "authorization",
  "api_key", "secret", "payload", "raw_exception", "raw_response", "stderr", "command", "traceback"
]);
function hasShotSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasShotSensitiveKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => SHOT_SENSITIVE_KEYS.has(key.toLowerCase()) || hasShotSensitiveKey(item));
}
function isShotText(value: unknown, minimum: number, maximum: number): value is string {
  return isString(value) && value.length >= minimum && value.length <= maximum && !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}
export function isShotVisualRequirementInput(value: unknown): value is ShotVisualRequirementInput {
  if (!isRecord(value) || hasShotSensitiveKey(value) || !onlyKeys(value, ["requirement_kind", "source_asset_id"])) return false;
  return (value.requirement_kind === "existing_media" && isId(value.source_asset_id))
    || (value.requirement_kind === "image" && value.source_asset_id === null);
}
export function isShotNarrationRequirementInput(value: unknown): value is ShotNarrationRequirementInput {
  return isRecord(value) && !hasShotSensitiveKey(value) && onlyKeys(value, ["requirement_kind", "text"])
    && value.requirement_kind === "tts" && isShotText(value.text, 1, 2000);
}
export function isShotRequirementInput(value: unknown): value is ShotRequirementInput {
  return isRecord(value) && !hasShotSensitiveKey(value)
    && onlyKeys(value, ["title", "visual_direction", "target_duration_us", "visual", "narration"])
    && isShotText(value.title, 1, 120) && isShotText(value.visual_direction, 1, 2000)
    && (value.target_duration_us === null || (isInteger(value.target_duration_us, 100_000) && value.target_duration_us <= 600_000_000))
    && isShotVisualRequirementInput(value.visual)
    && (value.narration === null || isShotNarrationRequirementInput(value.narration));
}
export function isShotListRevisionCreateInput(value: unknown): value is ShotListRevisionCreateInput {
  return isRecord(value) && !hasShotSensitiveKey(value)
    && onlyKeys(value, ["schema_version", "base_revision_id", "title", "summary", "requirements"])
    && value.schema_version === 1 && (value.base_revision_id === null || isId(value.base_revision_id))
    && isShotText(value.title, 1, 120) && isShotText(value.summary, 0, 4000)
    && Array.isArray(value.requirements) && value.requirements.length >= 1 && value.requirements.length <= 24
    && value.requirements.every(isShotRequirementInput);
}
export function isShotListConfirmInput(value: unknown): value is ShotListConfirmInput {
  return isRecord(value) && !hasShotSensitiveKey(value)
    && onlyKeys(value, ["revision_id", "expected_current_revision_id"])
    && isId(value.revision_id) && isId(value.expected_current_revision_id);
}
export function isShotRequirement(value: unknown): value is ShotRequirement {
  return isRecord(value) && !hasShotSensitiveKey(value)
    && onlyKeys(value, ["shot_requirement_id", "shot_list_revision_id", "ordinal", "title", "visual_direction", "target_duration_us", "visual", "narration"])
    && isId(value.shot_requirement_id) && isId(value.shot_list_revision_id) && isInteger(value.ordinal, 0) && value.ordinal <= 23
    && isShotRequirementInput({ title: value.title, visual_direction: value.visual_direction, target_duration_us: value.target_duration_us, visual: value.visual, narration: value.narration });
}
export function isShotListRevisionSummary(value: unknown): value is ShotListRevisionSummary {
  return isRecord(value) && !hasShotSensitiveKey(value)
    && onlyKeys(value, ["schema_version", "shot_list_revision_id", "shot_list_id", "project_id", "parent_revision_id", "title", "requirement_count", "document_sha256", "created_at"])
    && value.schema_version === 1 && isId(value.shot_list_revision_id) && isId(value.shot_list_id) && isId(value.project_id)
    && (value.parent_revision_id === null || isId(value.parent_revision_id)) && isShotText(value.title, 1, 120)
    && isInteger(value.requirement_count, 1) && value.requirement_count <= 24 && isSha256(value.document_sha256) && isTime(value.created_at);
}
export function isShotListRevisionDetail(value: unknown): value is ShotListRevisionDetail {
  if (!isRecord(value) || hasShotSensitiveKey(value)
    || !onlyKeys(value, ["schema_version", "shot_list_revision_id", "shot_list_id", "project_id", "parent_revision_id", "title", "requirement_count", "document_sha256", "created_at", "summary", "requirements"])) return false;
  const summary = { schema_version: value.schema_version, shot_list_revision_id: value.shot_list_revision_id, shot_list_id: value.shot_list_id, project_id: value.project_id, parent_revision_id: value.parent_revision_id, title: value.title, requirement_count: value.requirement_count, document_sha256: value.document_sha256, created_at: value.created_at };
  return isShotListRevisionSummary(summary) && isShotText(value.summary, 0, 4000) && Array.isArray(value.requirements)
    && value.requirements.length === value.requirement_count && value.requirements.every((item, ordinal) => isShotRequirement(item) && item.ordinal === ordinal && item.shot_list_revision_id === value.shot_list_revision_id);
}
export function isShotListState(value: unknown): value is ShotListState {
  if (!isRecord(value) || hasShotSensitiveKey(value) || !onlyKeys(value, ["shot_list_id", "project_id", "lifecycle", "current_revision", "confirmed_revision"]) || !isId(value.project_id)) return false;
  if (value.lifecycle === "empty") return value.shot_list_id === null && value.current_revision === null && value.confirmed_revision === null;
  if (!isId(value.shot_list_id) || !isShotListRevisionDetail(value.current_revision) || value.current_revision.project_id !== value.project_id || value.current_revision.shot_list_id !== value.shot_list_id) return false;
  const confirmed = value.confirmed_revision;
  const confirmedValid = isShotListRevisionSummary(confirmed)
    && confirmed.project_id === value.project_id && confirmed.shot_list_id === value.shot_list_id;
  if (value.lifecycle === "drafted") return confirmed === null
    || (confirmedValid && confirmed.shot_list_revision_id !== value.current_revision.shot_list_revision_id);
  return value.lifecycle === "confirmed" && confirmedValid
    && confirmed.shot_list_revision_id === value.current_revision.shot_list_revision_id;
}
export function isShotListRevisionCreateResponse(value: unknown): value is ShotListRevisionCreateResponse {
  return isRecord(value) && !hasShotSensitiveKey(value) && onlyKeys(value, ["revision", "state", "reused"])
    && isShotListRevisionDetail(value.revision) && isShotListState(value.state) && typeof value.reused === "boolean"
    && value.state.current_revision?.shot_list_revision_id === value.revision.shot_list_revision_id;
}
export function isShotListConfirmResponse(value: unknown): value is ShotListConfirmResponse {
  return isRecord(value) && !hasShotSensitiveKey(value) && onlyKeys(value, ["state", "reused"])
    && isShotListState(value.state) && typeof value.reused === "boolean" && value.state.lifecycle === "confirmed";
}
export function isShotListRevisionPage(value: unknown): value is ShotListRevisionPage { return isPage(value, isShotListRevisionSummary); }
export function parseShotListRevisionCreateInput(value: unknown): ShotListRevisionCreateInput { if (!isShotListRevisionCreateInput(value)) throw new ContractValidationError("ShotListRevisionCreateInput"); return value; }
export function parseShotListConfirmInput(value: unknown): ShotListConfirmInput { if (!isShotListConfirmInput(value)) throw new ContractValidationError("ShotListConfirmInput"); return value; }
export function parseShotListRevisionDetail(value: unknown): ShotListRevisionDetail { if (!isShotListRevisionDetail(value)) throw new ContractValidationError("ShotListRevisionDetail"); return value; }
export function parseShotListState(value: unknown): ShotListState { if (!isShotListState(value)) throw new ContractValidationError("ShotListState"); return value; }
export function parseShotListRevisionCreateResponse(value: unknown): ShotListRevisionCreateResponse { if (!isShotListRevisionCreateResponse(value)) throw new ContractValidationError("ShotListRevisionCreateResponse"); return value; }
export function parseShotListConfirmResponse(value: unknown): ShotListConfirmResponse { if (!isShotListConfirmResponse(value)) throw new ContractValidationError("ShotListConfirmResponse"); return value; }
export function parseShotListRevisionPage(value: unknown): ShotListRevisionPage { if (!isShotListRevisionPage(value)) throw new ContractValidationError("ShotListRevisionPage"); return value; }

export function parseMediaGenerationPrepareInput(value: unknown): MediaGenerationPrepareInput { if (!isMediaGenerationPrepareInput(value)) throw new ContractValidationError("MediaGenerationPrepareInput"); return value; }
export function parseMediaGenerationCreateInput(value: unknown): MediaGenerationCreateInput { if (!isMediaGenerationCreateInput(value)) throw new ContractValidationError("MediaGenerationCreateInput"); return value; }
export function parseMediaGenerationPreparedRequest(value: unknown): MediaGenerationPreparedRequest { if (!isMediaGenerationPreparedRequest(value)) throw new ContractValidationError("MediaGenerationPreparedRequest"); return value; }
export function parseMediaGenerationRequest(value: unknown): MediaGenerationRequest { if (!isMediaGenerationRequest(value)) throw new ContractValidationError("MediaGenerationRequest"); return value; }
export function parseMediaGenerationTask(value: unknown): MediaGenerationTask { if (!isMediaGenerationTask(value)) throw new ContractValidationError("MediaGenerationTask"); return value; }
export function parseMediaGenerationCreateResponse(value: unknown): MediaGenerationCreateResponse { if (!isMediaGenerationCreateResponse(value)) throw new ContractValidationError("MediaGenerationCreateResponse"); return value; }
export function parseMediaGenerationRequestPage(value: unknown): MediaGenerationRequestPage { if (!isMediaGenerationRequestPage(value)) throw new ContractValidationError("MediaGenerationRequestPage"); return value; }
export function parseMediaGenerationTaskPage(value: unknown): MediaGenerationTaskPage { if (!isMediaGenerationTaskPage(value)) throw new ContractValidationError("MediaGenerationTaskPage"); return value; }
export function parseMediaGenerationRetryInput(value: unknown): MediaGenerationRetryInput { if (!isMediaGenerationRetryInput(value)) throw new ContractValidationError("MediaGenerationRetryInput"); return value; }

export function parsePlatformPreset(value: unknown): PlatformPreset { if (!isPlatformPreset(value)) throw new ContractValidationError("PlatformPreset"); return value; }
export function parseRenditionPreset(value: unknown): RenditionPreset { if (!isRenditionPreset(value)) throw new ContractValidationError("RenditionPreset"); return value; }
export function parseRenditionPreviewCreateInput(value: unknown): RenditionPreviewCreateInput { if (!isRenditionPreviewCreateInput(value)) throw new ContractValidationError("RenditionPreviewCreateInput"); return value; }
export function parseRenditionPreviewCreateResponse(value: unknown): RenditionPreviewCreateResponse { if (!isRenditionPreviewCreateResponse(value)) throw new ContractValidationError("RenditionPreviewCreateResponse"); return value; }
export function parseDirectoryGrant(value: unknown): DirectoryGrant { if (!isDirectoryGrant(value)) throw new ContractValidationError("DirectoryGrant"); return value; }
export function parseExportBatchCreateInput(value: unknown): ExportBatchCreateInput { if (!isExportBatchCreateInput(value)) throw new ContractValidationError("ExportBatchCreateInput"); return value; }
export function parseExportBatch(value: unknown): ExportBatch { if (!isExportBatch(value)) throw new ContractValidationError("ExportBatch"); return value; }
export function parseExportBatchCreateResponse(value: unknown): ExportBatchCreateResponse { if (!isExportBatchCreateResponse(value)) throw new ContractValidationError("ExportBatchCreateResponse"); return value; }
export function parseExportBatchRetryInput(value: unknown): ExportBatchRetryInput { if (!isExportBatchRetryInput(value)) throw new ContractValidationError("ExportBatchRetryInput"); return value; }
export function parseExportBatchRetryResponse(value: unknown): ExportBatchRetryResponse { if (!isExportBatchRetryResponse(value)) throw new ContractValidationError("ExportBatchRetryResponse"); return value; }
export function parseRenditionReframePreviewCreateInput(value: unknown): RenditionReframePreviewCreateInput { if (!isRenditionReframePreviewCreateInput(value)) throw new ContractValidationError("RenditionReframePreviewCreateInput"); return value; }
export function parseRenditionReframePreviewCreateResponse(value: unknown): RenditionReframePreviewCreateResponse { if (!isRenditionReframePreviewCreateResponse(value)) throw new ContractValidationError("RenditionReframePreviewCreateResponse"); return value; }
export function parseRenditionReframePreview(value: unknown): RenditionReframePreview { if (!isRenditionReframePreview(value)) throw new ContractValidationError("RenditionReframePreview"); return value; }
export function parseReframeExportBatchCreateInput(value: unknown): ReframeExportBatchCreateInput { if (!isReframeExportBatchCreateInput(value)) throw new ContractValidationError("ReframeExportBatchCreateInput"); return value; }
export function parseReframeExportBatch(value: unknown): ReframeExportBatch { if (!isReframeExportBatch(value)) throw new ContractValidationError("ReframeExportBatch"); return value; }
export function parseReframeExportBatchCreateResponse(value: unknown): ReframeExportBatchCreateResponse { if (!isReframeExportBatchCreateResponse(value)) throw new ContractValidationError("ReframeExportBatchCreateResponse"); return value; }
export function parseReframeExportBatchRetryInput(value: unknown): ReframeExportBatchRetryInput { if (!isReframeExportBatchRetryInput(value)) throw new ContractValidationError("ReframeExportBatchRetryInput"); return value; }
export function parseReframeExportBatchRetryResponse(value: unknown): ReframeExportBatchRetryResponse { if (!isReframeExportBatchRetryResponse(value)) throw new ContractValidationError("ReframeExportBatchRetryResponse"); return value; }

export function parseImageProviderConfigCreateInput(value: unknown): ImageProviderConfigCreateInput { if (!isImageProviderConfigCreateInput(value)) throw new ContractValidationError("ImageProviderConfigCreateInput"); return value; }
export function parseImageProviderConfigSummary(value: unknown): ImageProviderConfigSummary { if (!isImageProviderConfigSummary(value)) throw new ContractValidationError("ImageProviderConfigSummary"); return value; }
export function parseImageProviderConfigPage(value: unknown): ImageProviderConfigPage { if (!isImageProviderConfigPage(value)) throw new ContractValidationError("ImageProviderConfigPage"); return value; }
export function parseProviderImageGenerationPrepareInput(value: unknown): ProviderImageGenerationPrepareInput { if (!isProviderImageGenerationPrepareInput(value)) throw new ContractValidationError("ProviderImageGenerationPrepareInput"); return value; }
export function parseProviderImageGenerationPreparedPreview(value: unknown): ProviderImageGenerationPreparedPreview { if (!isProviderImageGenerationPreparedPreview(value)) throw new ContractValidationError("ProviderImageGenerationPreparedPreview"); return value; }
export function parseProviderImageGenerationCreateInput(value: unknown): ProviderImageGenerationCreateInput { if (!isProviderImageGenerationCreateInput(value)) throw new ContractValidationError("ProviderImageGenerationCreateInput"); return value; }
export function parseProviderImageGenerationRequest(value: unknown): ProviderImageGenerationRequest { if (!isProviderImageGenerationRequest(value)) throw new ContractValidationError("ProviderImageGenerationRequest"); return value; }
export function parseProviderImageGenerationTask(value: unknown): ProviderImageGenerationTask { if (!isProviderImageGenerationTask(value)) throw new ContractValidationError("ProviderImageGenerationTask"); return value; }
export function parseProviderImageGenerationCreateResponse(value: unknown): ProviderImageGenerationCreateResponse { if (!isProviderImageGenerationCreateResponse(value)) throw new ContractValidationError("ProviderImageGenerationCreateResponse"); return value; }
export function parseProviderImageGenerationRequestPage(value: unknown): ProviderImageGenerationRequestPage { if (!isProviderImageGenerationRequestPage(value)) throw new ContractValidationError("ProviderImageGenerationRequestPage"); return value; }
export function parseProviderImageGenerationTaskPage(value: unknown): ProviderImageGenerationTaskPage { if (!isProviderImageGenerationTaskPage(value)) throw new ContractValidationError("ProviderImageGenerationTaskPage"); return value; }
export function parseProviderImageGenerationRetryPrepareInput(value: unknown): ProviderImageGenerationRetryPrepareInput { if (!isProviderImageGenerationRetryPrepareInput(value)) throw new ContractValidationError("ProviderImageGenerationRetryPrepareInput"); return value; }

export * from "./stage4e.js";
export * from "./stage5.js";
export * from "./stage6r.js";
export * from "./performance.js";
