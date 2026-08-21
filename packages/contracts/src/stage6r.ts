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
import type { ShotRequirementTimelineAssemblyAssetSummary } from "./stage5.js";

export type ShotRequirementTimelineBatchAssemblyPreviewId = string & {
  readonly __brand: "shot_requirement_timeline_batch_assembly_preview_id";
};
export type ShotRequirementTimelineBatchAssemblyId = string & {
  readonly __brand: "shot_requirement_timeline_batch_assembly_id";
};

export interface ShotRequirementTimelineBatchAssemblyItemInput {
  requirement_id: ShotRequirementId;
  expected_adoption_id: ShotRequirementImageAdoptionId;
  duration_us: number;
  layout: TimelineLayout;
}

export interface ShotRequirementTimelineBatchAssemblyPrepareInput {
  base_timeline_revision_id: TimelineRevisionId;
  at_index: number;
  items: ShotRequirementTimelineBatchAssemblyItemInput[];
}

export interface ShotRequirementTimelineBatchAssemblyApplyInput {
  batch_preview_id: ShotRequirementTimelineBatchAssemblyPreviewId;
  proposed_document_sha256: string;
  confirmed: true;
}

export interface ShotRequirementTimelineBatchAssemblyPreviewItem {
  item_index: number;
  shot_requirement_id: ShotRequirementId;
  adoption_id: ShotRequirementImageAdoptionId;
  asset: ShotRequirementTimelineAssemblyAssetSummary;
  proposed_clip_id: TimelineClipId;
  duration_us: number;
  layout: TimelineLayout;
  item_sha256: string;
  created_at: string;
}

export interface ShotRequirementTimelineBatchAssemblyPreview {
  preview_id: ShotRequirementTimelineBatchAssemblyPreviewId;
  project_id: ProjectId;
  shot_list_revision_id: ShotListRevisionId;
  base_timeline_revision_id: TimelineRevisionId;
  base_document_sha256: string;
  at_index: number;
  item_count: number;
  items: ShotRequirementTimelineBatchAssemblyPreviewItem[];
  proposed_document_sha256: string;
  preview_sha256: string;
  clip_count_before: number;
  clip_count_after: number;
  shifted_clip_count: number;
  shifted_caption_count: number;
  duration_before_us: number;
  duration_after_us: number;
  expires_at: string;
  created_at: string;
}

export interface ShotRequirementTimelineBatchAssembly {
  batch_assembly_id: ShotRequirementTimelineBatchAssemblyId;
  project_id: ProjectId;
  shot_list_revision_id: ShotListRevisionId;
  batch_preview_id: ShotRequirementTimelineBatchAssemblyPreviewId;
  base_timeline_revision_id: TimelineRevisionId;
  output_timeline_revision_id: TimelineRevisionId;
  proposed_document_sha256: string;
  item_count: number;
  created_at: string;
}

export interface ShotRequirementTimelineBatchAssemblyItem {
  item_index: number;
  shot_requirement_id: ShotRequirementId;
  adoption_id: ShotRequirementImageAdoptionId;
  asset_id: AssetId;
  proposed_clip_id: TimelineClipId;
  duration_us: number;
  layout: TimelineLayout;
  created_at: string;
}

export interface ShotRequirementTimelineBatchAssemblyApplyResponse {
  assembly: ShotRequirementTimelineBatchAssembly;
  reused: boolean;
}

export type ShotRequirementTimelineBatchAssemblyPage =
  Page<ShotRequirementTimelineBatchAssembly>;
export type ShotRequirementTimelineBatchAssemblyItemPage =
  Page<ShotRequirementTimelineBatchAssemblyItem>;

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
  return Object.keys(value).length === keys.length
    && Object.keys(value).every(
      key => keys.includes(key) && !SENSITIVE_KEYS.has(key.toLowerCase()),
    );
}
function id(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
function sha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}
function iso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
function nonnegative(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
function duration(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= 500_000
    && (value as number) <= 30_000_000;
}
function dimension(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && (value as number) > 0);
}
function layout(value: unknown): value is TimelineLayout {
  return LAYOUTS.includes(value as TimelineLayout);
}
function itemCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 2 && (value as number) <= 24;
}
function uniqueIds(value: readonly unknown[]): boolean {
  return new Set(value).size === value.length;
}

export function isShotRequirementTimelineBatchAssemblyPrepareInput(
  value: unknown,
): value is ShotRequirementTimelineBatchAssemblyPrepareInput {
  if (!record(value) || !only(value, ["base_timeline_revision_id", "at_index", "items"])) {
    return false;
  }
  if (!id(value.base_timeline_revision_id) || !nonnegative(value.at_index)) return false;
  if (!Array.isArray(value.items) || !itemCount(value.items.length)) return false;
  if (!uniqueIds(value.items.map(item => (item as { requirement_id?: unknown }).requirement_id))) {
    return false;
  }
  return value.items.every(item => {
    if (!record(item)
      || !only(item, [
        "requirement_id", "expected_adoption_id", "duration_us", "layout",
      ])) return false;
    return id(item.requirement_id) && id(item.expected_adoption_id)
      && duration(item.duration_us) && layout(item.layout);
  });
}

export function isShotRequirementTimelineBatchAssemblyApplyInput(
  value: unknown,
): value is ShotRequirementTimelineBatchAssemblyApplyInput {
  return record(value)
    && only(value, ["batch_preview_id", "proposed_document_sha256", "confirmed"])
    && id(value.batch_preview_id) && sha(value.proposed_document_sha256)
    && value.confirmed === true;
}

export function isShotRequirementTimelineBatchAssemblyPreviewItem(
  value: unknown,
): value is ShotRequirementTimelineBatchAssemblyPreviewItem {
  if (!record(value) || !only(value, [
    "item_index", "shot_requirement_id", "adoption_id", "asset", "proposed_clip_id",
    "duration_us", "layout", "item_sha256", "created_at",
  ])) return false;
  return nonnegative(value.item_index) && id(value.shot_requirement_id)
    && id(value.adoption_id) && id(value.proposed_clip_id)
    && duration(value.duration_us) && layout(value.layout)
    && sha(value.item_sha256) && iso(value.created_at)
    && isShotRequirementTimelineBatchAssemblyAssetSummary(value.asset);
}

export function isShotRequirementTimelineBatchAssemblyAssetSummary(
  value: unknown,
): value is ShotRequirementTimelineAssemblyAssetSummary {
  if (!record(value) || !only(value, [
    "asset_id", "kind", "availability", "fingerprint", "width", "height",
  ])) return false;
  return id(value.asset_id) && value.kind === "image"
    && AVAILABILITIES.includes(value.availability as AssetAvailability)
    && sha(value.fingerprint) && dimension(value.width) && dimension(value.height);
}

export function isShotRequirementTimelineBatchAssemblyPreview(
  value: unknown,
): value is ShotRequirementTimelineBatchAssemblyPreview {
  if (!record(value) || !only(value, [
    "preview_id", "project_id", "shot_list_revision_id", "base_timeline_revision_id",
    "base_document_sha256", "at_index", "item_count", "items",
    "proposed_document_sha256", "preview_sha256", "clip_count_before",
    "clip_count_after", "shifted_clip_count", "shifted_caption_count",
    "duration_before_us", "duration_after_us", "expires_at", "created_at",
  ])) return false;
  return id(value.preview_id) && id(value.project_id) && id(value.shot_list_revision_id)
    && id(value.base_timeline_revision_id) && sha(value.base_document_sha256)
    && nonnegative(value.at_index) && itemCount(value.item_count)
    && Array.isArray(value.items) && value.items.length === value.item_count
    && value.items.every(isShotRequirementTimelineBatchAssemblyPreviewItem)
    && value.items.every((item, index) =>
      (item as { item_index?: unknown }).item_index === index)
    && uniqueIds(value.items.map(
      item => (item as { shot_requirement_id?: unknown }).shot_requirement_id as ShotRequirementId,
    ))
    && sha(value.proposed_document_sha256) && sha(value.preview_sha256)
    && nonnegative(value.clip_count_before) && nonnegative(value.clip_count_after)
    && (value.clip_count_after as number) >= (value.clip_count_before as number)
    && nonnegative(value.shifted_clip_count) && nonnegative(value.shifted_caption_count)
    && nonnegative(value.duration_before_us) && nonnegative(value.duration_after_us)
    && (value.duration_after_us as number) >= (value.duration_before_us as number)
    && iso(value.expires_at) && iso(value.created_at);
}

export function isShotRequirementTimelineBatchAssembly(
  value: unknown,
): value is ShotRequirementTimelineBatchAssembly {
  return record(value)
    && only(value, [
      "batch_assembly_id", "project_id", "shot_list_revision_id", "batch_preview_id",
      "base_timeline_revision_id", "output_timeline_revision_id",
      "proposed_document_sha256", "item_count", "created_at",
    ])
    && id(value.batch_assembly_id) && id(value.project_id) && id(value.shot_list_revision_id)
    && id(value.batch_preview_id) && id(value.base_timeline_revision_id)
    && id(value.output_timeline_revision_id) && sha(value.proposed_document_sha256)
    && itemCount(value.item_count) && iso(value.created_at);
}

export function isShotRequirementTimelineBatchAssemblyItem(
  value: unknown,
): value is ShotRequirementTimelineBatchAssemblyItem {
  return record(value)
    && only(value, [
      "item_index", "shot_requirement_id", "adoption_id", "asset_id", "proposed_clip_id",
      "duration_us", "layout", "created_at",
    ])
    && nonnegative(value.item_index) && id(value.shot_requirement_id)
    && id(value.adoption_id) && id(value.asset_id) && id(value.proposed_clip_id)
    && duration(value.duration_us) && layout(value.layout) && iso(value.created_at);
}

export function isShotRequirementTimelineBatchAssemblyApplyResponse(
  value: unknown,
): value is ShotRequirementTimelineBatchAssemblyApplyResponse {
  return record(value) && only(value, ["assembly", "reused"])
    && isShotRequirementTimelineBatchAssembly(value.assembly)
    && typeof value.reused === "boolean";
}

export function isShotRequirementTimelineBatchAssemblyPage(
  value: unknown,
): value is ShotRequirementTimelineBatchAssemblyPage {
  return record(value) && only(value, ["items", "next_cursor"])
    && Array.isArray(value.items)
    && value.items.every(isShotRequirementTimelineBatchAssembly)
    && (value.next_cursor === null
      || (typeof value.next_cursor === "string" && /^\d{1,10}$/.test(value.next_cursor)));
}

export function isShotRequirementTimelineBatchAssemblyItemPage(
  value: unknown,
): value is ShotRequirementTimelineBatchAssemblyItemPage {
  return record(value) && only(value, ["items", "next_cursor"])
    && Array.isArray(value.items)
    && value.items.every(isShotRequirementTimelineBatchAssemblyItem)
    && (value.next_cursor === null
      || (typeof value.next_cursor === "string" && /^\d{1,10}$/.test(value.next_cursor)));
}

function parse<T>(value: unknown, check: (candidate: unknown) => candidate is T, name: string): T {
  if (!check(value)) throw new Error(`Invalid ${name}`);
  return value;
}
export const parseShotRequirementTimelineBatchAssemblyPrepareInput = (value: unknown) =>
  parse(
    value,
    isShotRequirementTimelineBatchAssemblyPrepareInput,
    "ShotRequirementTimelineBatchAssemblyPrepareInput",
  );
export const parseShotRequirementTimelineBatchAssemblyApplyInput = (value: unknown) =>
  parse(
    value,
    isShotRequirementTimelineBatchAssemblyApplyInput,
    "ShotRequirementTimelineBatchAssemblyApplyInput",
  );
export const parseShotRequirementTimelineBatchAssemblyPreview = (value: unknown) =>
  parse(
    value,
    isShotRequirementTimelineBatchAssemblyPreview,
    "ShotRequirementTimelineBatchAssemblyPreview",
  );
export const parseShotRequirementTimelineBatchAssembly = (value: unknown) =>
  parse(
    value,
    isShotRequirementTimelineBatchAssembly,
    "ShotRequirementTimelineBatchAssembly",
  );
export const parseShotRequirementTimelineBatchAssemblyApplyResponse = (value: unknown) =>
  parse(
    value,
    isShotRequirementTimelineBatchAssemblyApplyResponse,
    "ShotRequirementTimelineBatchAssemblyApplyResponse",
  );
export const parseShotRequirementTimelineBatchAssemblyPage = (value: unknown) =>
  parse(
    value,
    isShotRequirementTimelineBatchAssemblyPage,
    "ShotRequirementTimelineBatchAssemblyPage",
  );
export const parseShotRequirementTimelineBatchAssemblyItemPage = (value: unknown) =>
  parse(
    value,
    isShotRequirementTimelineBatchAssemblyItemPage,
    "ShotRequirementTimelineBatchAssemblyItemPage",
  );
