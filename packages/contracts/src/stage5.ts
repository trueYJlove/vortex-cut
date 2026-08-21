import type {
  AssetAvailability,
  AssetId,
  Page,
  ProjectId,
  ShotListRevisionId,
  ShotRequirementId,
  TimelineClipId,
  TimelineLayout,
  TimelineRevisionId,
} from "./index.js";
import type { ShotRequirementImageAdoptionId } from "./stage4e.js";

export type ShotRequirementTimelineAssemblyPreviewId = string & {
  readonly __brand: "shot_requirement_timeline_assembly_preview_id";
};
export type ShotRequirementTimelineAssemblyId = string & {
  readonly __brand: "shot_requirement_timeline_assembly_id";
};

export interface ShotRequirementTimelineAssemblyPrepareInput {
  expected_adoption_id: ShotRequirementImageAdoptionId;
  base_timeline_revision_id: TimelineRevisionId;
  at_index: number;
  duration_us: number | null;
  layout: TimelineLayout;
}

export interface ShotRequirementTimelineAssemblyApplyInput {
  assembly_preview_id: ShotRequirementTimelineAssemblyPreviewId;
  proposed_document_sha256: string;
  confirmed: true;
}

export interface ShotRequirementTimelineAssemblyAssetSummary {
  asset_id: AssetId;
  kind: "image";
  availability: AssetAvailability;
  fingerprint: string;
  width: number | null;
  height: number | null;
}

export interface ShotRequirementTimelineAssemblyPreview {
  preview_id: ShotRequirementTimelineAssemblyPreviewId;
  project_id: ProjectId;
  shot_list_revision_id: ShotListRevisionId;
  shot_requirement_id: ShotRequirementId;
  adoption_id: ShotRequirementImageAdoptionId;
  asset: ShotRequirementTimelineAssemblyAssetSummary;
  base_timeline_revision_id: TimelineRevisionId;
  base_document_sha256: string;
  proposed_clip_id: TimelineClipId;
  at_index: number;
  duration_us: number;
  layout: TimelineLayout;
  proposed_document_sha256: string;
  preview_sha256: string;
  clip_count_before: number;
  shifted_clip_count: number;
  shifted_caption_count: number;
  duration_before_us: number;
  duration_after_us: number;
  expires_at: string;
  created_at: string;
}

export interface ShotRequirementTimelineAssembly {
  assembly_id: ShotRequirementTimelineAssemblyId;
  project_id: ProjectId;
  shot_list_revision_id: ShotListRevisionId;
  shot_requirement_id: ShotRequirementId;
  adoption_id: ShotRequirementImageAdoptionId;
  asset_id: AssetId;
  assembly_preview_id: ShotRequirementTimelineAssemblyPreviewId;
  base_timeline_revision_id: TimelineRevisionId;
  output_timeline_revision_id: TimelineRevisionId;
  proposed_clip_id: TimelineClipId;
  proposed_document_sha256: string;
  created_at: string;
}

export interface ShotRequirementTimelineAssemblyApplyResponse {
  assembly: ShotRequirementTimelineAssembly;
  reused: boolean;
}

export type ShotRequirementTimelineAssemblyPage = Page<ShotRequirementTimelineAssembly>;

const SENSITIVE_KEYS = new Set([
  "path", "uri", "absolute_path", "prompt", "requirement", "visual_direction",
  "narration_text", "transcript", "caption", "authorization", "api_key", "secret",
  "payload", "raw_exception", "raw_response", "sse", "base64", "stderr", "command",
  "traceback", "document",
]);
const LAYOUTS: TimelineLayout[] = ["blurred_background", "crop_fill", "fit"];
const AVAILABILITIES: AssetAvailability[] = ["available", "missing", "changed", "unsupported"];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^sha256:[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key) && !SENSITIVE_KEYS.has(key.toLowerCase()))
    && Object.keys(value).length === keys.length;
}
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function sha(value: unknown): value is string { return typeof value === "string" && SHA.test(value); }
function iso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
function nonnegative(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
function dimension(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && (value as number) > 0);
}

export function isShotRequirementTimelineAssemblyPrepareInput(
  value: unknown,
): value is ShotRequirementTimelineAssemblyPrepareInput {
  if (!record(value) || !only(value, [
    "expected_adoption_id", "base_timeline_revision_id", "at_index", "duration_us", "layout",
  ])) return false;
  return id(value.expected_adoption_id) && id(value.base_timeline_revision_id)
    && nonnegative(value.at_index)
    && (value.duration_us === null || (Number.isInteger(value.duration_us)
      && (value.duration_us as number) >= 500_000 && (value.duration_us as number) <= 30_000_000))
    && LAYOUTS.includes(value.layout as TimelineLayout);
}

export function isShotRequirementTimelineAssemblyApplyInput(
  value: unknown,
): value is ShotRequirementTimelineAssemblyApplyInput {
  if (!record(value) || !only(value, [
    "assembly_preview_id", "proposed_document_sha256", "confirmed",
  ])) return false;
  return id(value.assembly_preview_id) && sha(value.proposed_document_sha256)
    && value.confirmed === true;
}

export function isShotRequirementTimelineAssemblyAssetSummary(
  value: unknown,
): value is ShotRequirementTimelineAssemblyAssetSummary {
  if (!record(value) || !only(value, [
    "asset_id", "kind", "availability", "fingerprint", "width", "height",
  ])) return false;
  return id(value.asset_id) && value.kind === "image"
    && AVAILABILITIES.includes(value.availability as AssetAvailability)
    && sha(value.fingerprint) && dimension(value.width) && dimension(value.height);
}

export function isShotRequirementTimelineAssemblyPreview(
  value: unknown,
): value is ShotRequirementTimelineAssemblyPreview {
  if (!record(value) || !only(value, [
    "preview_id", "project_id", "shot_list_revision_id", "shot_requirement_id", "adoption_id",
    "asset", "base_timeline_revision_id", "base_document_sha256", "proposed_clip_id", "at_index",
    "duration_us", "layout", "proposed_document_sha256", "preview_sha256", "clip_count_before",
    "shifted_clip_count", "shifted_caption_count", "duration_before_us", "duration_after_us",
    "expires_at", "created_at",
  ])) return false;
  return id(value.preview_id) && id(value.project_id) && id(value.shot_list_revision_id)
    && id(value.shot_requirement_id) && id(value.adoption_id)
    && isShotRequirementTimelineAssemblyAssetSummary(value.asset)
    && id(value.base_timeline_revision_id) && sha(value.base_document_sha256)
    && id(value.proposed_clip_id) && nonnegative(value.at_index)
    && Number.isInteger(value.duration_us) && (value.duration_us as number) >= 500_000
    && (value.duration_us as number) <= 30_000_000
    && LAYOUTS.includes(value.layout as TimelineLayout)
    && sha(value.proposed_document_sha256) && sha(value.preview_sha256)
    && nonnegative(value.clip_count_before) && nonnegative(value.shifted_clip_count)
    && nonnegative(value.shifted_caption_count) && nonnegative(value.duration_before_us)
    && nonnegative(value.duration_after_us)
    && (value.duration_after_us as number) >= (value.duration_before_us as number)
    && iso(value.expires_at) && iso(value.created_at);
}

export function isShotRequirementTimelineAssembly(
  value: unknown,
): value is ShotRequirementTimelineAssembly {
  if (!record(value) || !only(value, [
    "assembly_id", "project_id", "shot_list_revision_id", "shot_requirement_id", "adoption_id",
    "asset_id", "assembly_preview_id", "base_timeline_revision_id", "output_timeline_revision_id",
    "proposed_clip_id", "proposed_document_sha256", "created_at",
  ])) return false;
  return id(value.assembly_id) && id(value.project_id) && id(value.shot_list_revision_id)
    && id(value.shot_requirement_id) && id(value.adoption_id) && id(value.asset_id)
    && id(value.assembly_preview_id) && id(value.base_timeline_revision_id)
    && id(value.output_timeline_revision_id) && id(value.proposed_clip_id)
    && sha(value.proposed_document_sha256) && iso(value.created_at);
}

export function isShotRequirementTimelineAssemblyApplyResponse(
  value: unknown,
): value is ShotRequirementTimelineAssemblyApplyResponse {
  return record(value) && only(value, ["assembly", "reused"])
    && isShotRequirementTimelineAssembly(value.assembly) && typeof value.reused === "boolean";
}

export function isShotRequirementTimelineAssemblyPage(
  value: unknown,
): value is ShotRequirementTimelineAssemblyPage {
  return record(value) && only(value, ["items", "next_cursor"])
    && Array.isArray(value.items) && value.items.every(isShotRequirementTimelineAssembly)
    && (value.next_cursor === null || (typeof value.next_cursor === "string"
      && /^\d{1,10}$/.test(value.next_cursor)));
}

function parse<T>(value: unknown, check: (candidate: unknown) => candidate is T, name: string): T {
  if (!check(value)) throw new Error(`Invalid ${name}`);
  return value;
}
export const parseShotRequirementTimelineAssemblyPrepareInput = (value: unknown) =>
  parse(value, isShotRequirementTimelineAssemblyPrepareInput, "ShotRequirementTimelineAssemblyPrepareInput");
export const parseShotRequirementTimelineAssemblyApplyInput = (value: unknown) =>
  parse(value, isShotRequirementTimelineAssemblyApplyInput, "ShotRequirementTimelineAssemblyApplyInput");
export const parseShotRequirementTimelineAssemblyPreview = (value: unknown) =>
  parse(value, isShotRequirementTimelineAssemblyPreview, "ShotRequirementTimelineAssemblyPreview");
export const parseShotRequirementTimelineAssembly = (value: unknown) =>
  parse(value, isShotRequirementTimelineAssembly, "ShotRequirementTimelineAssembly");
export const parseShotRequirementTimelineAssemblyApplyResponse = (value: unknown) =>
  parse(value, isShotRequirementTimelineAssemblyApplyResponse, "ShotRequirementTimelineAssemblyApplyResponse");
export const parseShotRequirementTimelineAssemblyPage = (value: unknown) =>
  parse(value, isShotRequirementTimelineAssemblyPage, "ShotRequirementTimelineAssemblyPage");
