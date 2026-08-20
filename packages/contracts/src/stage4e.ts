import {
  isProviderImageGenerationRequest,
  isProviderImageGenerationTask,
} from "./index.js";
import type {
  AssetAvailability,
  AssetId,
  MediaGenerationRequestId,
  MediaGenerationTaskId,
  Page,
  ProjectId,
  ProviderConfigId,
  ProviderImageExecutionMode,
  ProviderImageGenerationPreparedPreview,
  ProviderImageGenerationRequest,
  ProviderImageGenerationTask,
  ProviderImageSize,
  ShotListRevisionId,
  ShotRequirementId,
} from "./index.js";

export type ShotRequirementImageGenerationLinkId = string & {
  readonly __brand: "shot_requirement_image_generation_link_id";
};
export type ShotRequirementImageAdoptionId = string & {
  readonly __brand: "shot_requirement_image_adoption_id";
};
export type ShotRequirementImageFulfillmentPreviewId = string & {
  readonly __brand: "shot_requirement_image_fulfillment_preview_id";
};

export type ShotRequirementImageFulfillmentLifecycle =
  | "unstarted"
  | "in_progress"
  | "review_required"
  | "adopted"
  | "adopted_unavailable"
  | "no_usable_output";

export interface ShotRequirementImageFulfillmentPrepareInput {
  expected_confirmed_revision_id: ShotListRevisionId;
  provider_config_id: ProviderConfigId;
  prompt: string;
}

export interface ShotRequirementImageFulfillmentPreparedPreview {
  preview_id: ShotRequirementImageFulfillmentPreviewId;
  project_id: ProjectId;
  shot_list_revision_id: ShotListRevisionId;
  shot_requirement_id: ShotRequirementId;
  requirement_sha256: string;
  fulfillment_payload_sha256: string;
  execution_mode: ProviderImageExecutionMode;
  prompt_sha256: string;
  size: ProviderImageSize;
  output_format: "png";
  image_count: 1;
  provider: ProviderImageGenerationPreparedPreview["provider"];
  estimated_cost: number | null;
  estimated_cost_currency: "CNY";
  price_tier: "1K";
  expires_at: string;
}

export interface ShotRequirementImageFulfillmentCreateInput {
  preview_id: ShotRequirementImageFulfillmentPreviewId;
  fulfillment_payload_sha256: string;
  expected_confirmed_revision_id: ShotListRevisionId;
  confirmed: true;
}

export interface ShotRequirementImageGenerationLink {
  link_id: ShotRequirementImageGenerationLinkId;
  project_id: ProjectId;
  shot_list_revision_id: ShotListRevisionId;
  shot_requirement_id: ShotRequirementId;
  request_id: MediaGenerationRequestId;
  requirement_sha256: string;
  created_at: string;
}

export interface ShotRequirementImageAdoption {
  adoption_id: ShotRequirementImageAdoptionId;
  project_id: ProjectId;
  shot_list_revision_id: ShotListRevisionId;
  shot_requirement_id: ShotRequirementId;
  generation_link_id: ShotRequirementImageGenerationLinkId;
  task_id: MediaGenerationTaskId;
  asset_id: AssetId;
  adoption_ordinal: number;
  previous_adoption_id: ShotRequirementImageAdoptionId | null;
  created_at: string;
}

export interface ShotRequirementImageFulfillmentState {
  project_id: ProjectId;
  shot_list_revision_id: ShotListRevisionId;
  shot_requirement_id: ShotRequirementId;
  requirement_sha256: string;
  currently_confirmed: boolean;
  lifecycle: ShotRequirementImageFulfillmentLifecycle;
  link_count: number;
  current_adoption: ShotRequirementImageAdoption | null;
  current_asset_availability: AssetAvailability | null;
}

export interface ShotRequirementImageFulfillmentCreateResponse {
  link: ShotRequirementImageGenerationLink;
  request: ProviderImageGenerationRequest;
  task: ProviderImageGenerationTask;
  generation_reused: boolean;
  link_reused: boolean;
}

export type ShotRequirementImageGenerationLinkPage = Page<ShotRequirementImageGenerationLink>;
export type ShotRequirementImageAdoptionPage = Page<ShotRequirementImageAdoption>;

export interface ShotRequirementImageAdoptInput {
  generation_link_id: ShotRequirementImageGenerationLinkId;
  task_id: MediaGenerationTaskId;
  asset_id: AssetId;
  expected_current_adoption_id: ShotRequirementImageAdoptionId | null;
  confirmed: true;
}

export interface ShotRequirementImageAdoptResponse {
  adoption: ShotRequirementImageAdoption;
  reused: boolean;
}

const SENSITIVE_KEYS = new Set([
  "path",
  "uri",
  "absolute_path",
  "prompt",
  "visual_direction",
  "narration_text",
  "transcript",
  "caption",
  "authorization",
  "api_key",
  "secret",
  "payload",
  "raw_exception",
  "raw_response",
  "sse",
  "base64",
  "stderr",
  "command",
  "traceback",
]);
const LIFECYCLES: ShotRequirementImageFulfillmentLifecycle[] = [
  "unstarted",
  "in_progress",
  "review_required",
  "adopted",
  "adopted_unavailable",
  "no_usable_output",
];
const AVAILABILITIES: AssetAvailability[] = [
  "available",
  "missing",
  "changed",
  "unsupported",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
function isTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
function isInteger(value: unknown, minimum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum;
}
function oneOf<T>(values: readonly T[], value: unknown): value is T {
  return values.includes(value as T);
}
function hasSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, item]) => SENSITIVE_KEYS.has(key.toLowerCase()) || hasSensitiveKey(item),
  );
}
function isProvider(value: unknown): boolean {
  return isRecord(value)
    && onlyKeys(value, ["provider_config_id", "provider_kind", "adapter_id", "model"])
    && isId(value.provider_config_id)
    && value.provider_kind === "apikey_fun_images"
    && value.adapter_id === "apikey_fun_images_sse_v1"
    && value.model === "gpt-image-2";
}

export function isShotRequirementImageFulfillmentPrepareInput(
  value: unknown,
): value is ShotRequirementImageFulfillmentPrepareInput {
  return isRecord(value)
    && onlyKeys(value, ["expected_confirmed_revision_id", "provider_config_id", "prompt"])
    && isId(value.expected_confirmed_revision_id)
    && isId(value.provider_config_id)
    && typeof value.prompt === "string"
    && value.prompt.trim().length >= 1
    && value.prompt.length <= 16_000;
}

export function isShotRequirementImageFulfillmentPreparedPreview(
  value: unknown,
): value is ShotRequirementImageFulfillmentPreparedPreview {
  return isRecord(value)
    && !hasSensitiveKey(value)
    && onlyKeys(value, [
      "preview_id", "project_id", "shot_list_revision_id", "shot_requirement_id",
      "requirement_sha256", "fulfillment_payload_sha256", "execution_mode",
      "prompt_sha256", "size", "output_format", "image_count", "provider",
      "estimated_cost", "estimated_cost_currency", "price_tier", "expires_at",
    ])
    && isId(value.preview_id)
    && isId(value.project_id)
    && isId(value.shot_list_revision_id)
    && isId(value.shot_requirement_id)
    && isSha256(value.requirement_sha256)
    && isSha256(value.fulfillment_payload_sha256)
    && value.execution_mode === "provider_image_v1"
    && isSha256(value.prompt_sha256)
    && value.size === "1024x1024"
    && value.output_format === "png"
    && value.image_count === 1
    && isProvider(value.provider)
    && (value.estimated_cost === null
      || (typeof value.estimated_cost === "number" && Number.isFinite(value.estimated_cost)
        && value.estimated_cost >= 0))
    && value.estimated_cost_currency === "CNY"
    && value.price_tier === "1K"
    && isTime(value.expires_at);
}

export function isShotRequirementImageFulfillmentCreateInput(
  value: unknown,
): value is ShotRequirementImageFulfillmentCreateInput {
  return isRecord(value)
    && !hasSensitiveKey(value)
    && onlyKeys(value, [
      "preview_id", "fulfillment_payload_sha256", "expected_confirmed_revision_id", "confirmed",
    ])
    && isId(value.preview_id)
    && isSha256(value.fulfillment_payload_sha256)
    && isId(value.expected_confirmed_revision_id)
    && value.confirmed === true;
}

export function isShotRequirementImageGenerationLink(
  value: unknown,
): value is ShotRequirementImageGenerationLink {
  return isRecord(value)
    && !hasSensitiveKey(value)
    && onlyKeys(value, [
      "link_id", "project_id", "shot_list_revision_id", "shot_requirement_id",
      "request_id", "requirement_sha256", "created_at",
    ])
    && isId(value.link_id)
    && isId(value.project_id)
    && isId(value.shot_list_revision_id)
    && isId(value.shot_requirement_id)
    && isId(value.request_id)
    && isSha256(value.requirement_sha256)
    && isTime(value.created_at);
}

export function isShotRequirementImageAdoption(
  value: unknown,
): value is ShotRequirementImageAdoption {
  return isRecord(value)
    && !hasSensitiveKey(value)
    && onlyKeys(value, [
      "adoption_id", "project_id", "shot_list_revision_id", "shot_requirement_id",
      "generation_link_id", "task_id", "asset_id", "adoption_ordinal",
      "previous_adoption_id", "created_at",
    ])
    && isId(value.adoption_id)
    && isId(value.project_id)
    && isId(value.shot_list_revision_id)
    && isId(value.shot_requirement_id)
    && isId(value.generation_link_id)
    && isId(value.task_id)
    && isId(value.asset_id)
    && isInteger(value.adoption_ordinal, 1)
    && (value.previous_adoption_id === null || isId(value.previous_adoption_id))
    && isTime(value.created_at);
}

export function isShotRequirementImageFulfillmentState(
  value: unknown,
): value is ShotRequirementImageFulfillmentState {
  if (!isRecord(value) || hasSensitiveKey(value) || !onlyKeys(value, [
    "project_id", "shot_list_revision_id", "shot_requirement_id", "requirement_sha256",
    "currently_confirmed", "lifecycle", "link_count", "current_adoption",
    "current_asset_availability",
  ])) return false;
  if (!isId(value.project_id) || !isId(value.shot_list_revision_id)
    || !isId(value.shot_requirement_id) || !isSha256(value.requirement_sha256)
    || typeof value.currently_confirmed !== "boolean" || !oneOf(LIFECYCLES, value.lifecycle)
    || !isInteger(value.link_count, 0)) return false;
  if (value.current_adoption === null) {
    return value.current_asset_availability === null
      && value.lifecycle !== "adopted" && value.lifecycle !== "adopted_unavailable";
  }
  return isShotRequirementImageAdoption(value.current_adoption)
    && value.current_adoption.project_id === value.project_id
    && value.current_adoption.shot_list_revision_id === value.shot_list_revision_id
    && value.current_adoption.shot_requirement_id === value.shot_requirement_id
    && oneOf(AVAILABILITIES, value.current_asset_availability)
    && (value.lifecycle === "adopted" || value.lifecycle === "adopted_unavailable");
}

export function isShotRequirementImageFulfillmentCreateResponse(
  value: unknown,
): value is ShotRequirementImageFulfillmentCreateResponse {
  return isRecord(value)
    && !hasSensitiveKey(value)
    && onlyKeys(value, ["link", "request", "task", "generation_reused", "link_reused"])
    && isShotRequirementImageGenerationLink(value.link)
    && isProviderImageGenerationRequest(value.request)
    && isProviderImageGenerationTask(value.task)
    && value.link.project_id === value.request.project_id
    && value.link.request_id === value.request.request_id
    && value.task.request_id === value.request.request_id
    && typeof value.generation_reused === "boolean"
    && typeof value.link_reused === "boolean";
}

export function isShotRequirementImageGenerationLinkPage(
  value: unknown,
): value is ShotRequirementImageGenerationLinkPage {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["items", "next_cursor"])
    && Array.isArray(value.items) && value.items.every(isShotRequirementImageGenerationLink)
    && (value.next_cursor === null || typeof value.next_cursor === "string");
}

export function isShotRequirementImageAdoptionPage(
  value: unknown,
): value is ShotRequirementImageAdoptionPage {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["items", "next_cursor"])
    && Array.isArray(value.items) && value.items.every(isShotRequirementImageAdoption)
    && (value.next_cursor === null || typeof value.next_cursor === "string");
}

export function isShotRequirementImageAdoptInput(
  value: unknown,
): value is ShotRequirementImageAdoptInput {
  return isRecord(value)
    && !hasSensitiveKey(value)
    && onlyKeys(value, [
      "generation_link_id", "task_id", "asset_id", "expected_current_adoption_id", "confirmed",
    ])
    && isId(value.generation_link_id)
    && isId(value.task_id)
    && isId(value.asset_id)
    && (value.expected_current_adoption_id === null || isId(value.expected_current_adoption_id))
    && value.confirmed === true;
}

export function isShotRequirementImageAdoptResponse(
  value: unknown,
): value is ShotRequirementImageAdoptResponse {
  return isRecord(value) && !hasSensitiveKey(value) && onlyKeys(value, ["adoption", "reused"])
    && isShotRequirementImageAdoption(value.adoption) && typeof value.reused === "boolean";
}

export class Stage4eContractValidationError extends Error {
  constructor(name: string) {
    super(`Invalid ${name}`);
    this.name = "Stage4eContractValidationError";
  }
}

function parse<T>(value: unknown, guard: (candidate: unknown) => candidate is T, name: string): T {
  if (!guard(value)) throw new Stage4eContractValidationError(name);
  return value;
}

export const parseShotRequirementImageFulfillmentPrepareInput = (value: unknown) =>
  parse(value, isShotRequirementImageFulfillmentPrepareInput, "ShotRequirementImageFulfillmentPrepareInput");
export const parseShotRequirementImageFulfillmentPreparedPreview = (value: unknown) =>
  parse(value, isShotRequirementImageFulfillmentPreparedPreview, "ShotRequirementImageFulfillmentPreparedPreview");
export const parseShotRequirementImageFulfillmentCreateInput = (value: unknown) =>
  parse(value, isShotRequirementImageFulfillmentCreateInput, "ShotRequirementImageFulfillmentCreateInput");
export const parseShotRequirementImageGenerationLink = (value: unknown) =>
  parse(value, isShotRequirementImageGenerationLink, "ShotRequirementImageGenerationLink");
export const parseShotRequirementImageAdoption = (value: unknown) =>
  parse(value, isShotRequirementImageAdoption, "ShotRequirementImageAdoption");
export const parseShotRequirementImageFulfillmentState = (value: unknown) =>
  parse(value, isShotRequirementImageFulfillmentState, "ShotRequirementImageFulfillmentState");
export const parseShotRequirementImageFulfillmentCreateResponse = (value: unknown) =>
  parse(value, isShotRequirementImageFulfillmentCreateResponse, "ShotRequirementImageFulfillmentCreateResponse");
export const parseShotRequirementImageGenerationLinkPage = (value: unknown) =>
  parse(value, isShotRequirementImageGenerationLinkPage, "ShotRequirementImageGenerationLinkPage");
export const parseShotRequirementImageAdoptionPage = (value: unknown) =>
  parse(value, isShotRequirementImageAdoptionPage, "ShotRequirementImageAdoptionPage");
export const parseShotRequirementImageAdoptInput = (value: unknown) =>
  parse(value, isShotRequirementImageAdoptInput, "ShotRequirementImageAdoptInput");
export const parseShotRequirementImageAdoptResponse = (value: unknown) =>
  parse(value, isShotRequirementImageAdoptResponse, "ShotRequirementImageAdoptResponse");