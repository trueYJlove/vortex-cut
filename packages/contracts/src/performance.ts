import type { AssetId, ProjectId } from "./index.js";

/**
 * B10 派生媒体缓存契约（performance-v1）。
 *
 * 约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6.1 节）：
 * - Renderer 不接受也不返回任何系统路径——`path` 只存在于 Core↔Main 的
 *   受控内部响应（main 通过 admin 通道换取后转票据 URL），此契约文件
 *   的 Renderer 可见类型不含路径字段。
 * - 请求校验 project/asset 归属、枚举与参数上限在四层各自重复强制
 *   （contracts/preload/main/Core），不只改 TS interface。
 */

export type DerivedMediaKind = "video_proxy" | "waveform" | "audio_pcm_chunk" | "reverse_chunk";

export const DERIVED_MEDIA_KINDS: readonly DerivedMediaKind[] = [
  "video_proxy", "waveform", "audio_pcm_chunk", "reverse_chunk",
] as const;

export const DERIVED_MEDIA_ALGORITHM_VERSION = 1 as const;

export interface DerivedMediaLookupInput {
  project_id: ProjectId;
  asset_id: AssetId;
  kind: DerivedMediaKind;
  params: Record<string, string>;
}

export interface DerivedMediaEntry {
  cache_key: string;
  kind: DerivedMediaKind;
  status: "ready" | "building" | "failed";
  size_bytes: number;
  created_at: string;
  last_accessed_at: string;
}

export interface DerivedMediaResolveInput {
  project_id: ProjectId;
  asset_id: AssetId;
  kind: DerivedMediaKind;
  params: Record<string, string>;
}

export interface DerivedMediaInternalResolve {
  /** 仅 Main↔Core admin 通道使用；Renderer 永远拿不到此字段。 */
  cache_key: string;
  kind: DerivedMediaKind;
  status: "ready" | "building" | "failed";
  path: string;
  size_bytes: number;
}

export interface DerivedMediaStats {
  total_ready_bytes: number;
  ready_count: number;
  disk_budget_bytes: number;
}

const SENSITIVE_KEYS = new Set(["path", "uri", "absolute_path", "authorization", "api_key", "secret"]);

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^sha256:[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const PARAM_KEY = /^[a-z0-9_]{1,64}$/;
const PARAM_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_PARAMS = 8;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key) && !SENSITIVE_KEYS.has(key.toLowerCase()))
    && Object.keys(value).length === keys.length;
}

function id(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function sha(value: unknown): value is string { return typeof value === "string" && SHA.test(value); }
function iso(value: unknown): value is string { return typeof value === "string" && ISO.test(value); }
function nonnegative(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function params(value: unknown): value is Record<string, string> {
  if (!record(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_PARAMS) return false;
  return entries.every(([key, item]) =>
    PARAM_KEY.test(key) && typeof item === "string" && PARAM_VALUE.test(item));
}

function kind(value: unknown): value is DerivedMediaKind {
  return typeof value === "string" && (DERIVED_MEDIA_KINDS as readonly string[]).includes(value);
}

export function isDerivedMediaLookupInput(value: unknown): value is DerivedMediaLookupInput {
  if (!record(value) || !only(value, ["project_id", "asset_id", "kind", "params"])) return false;
  return id(value.project_id) && id(value.asset_id) && kind(value.kind) && params(value.params);
}

export function isDerivedMediaEntry(value: unknown): value is DerivedMediaEntry {
  if (!record(value) || !only(value, [
    "cache_key", "kind", "status", "size_bytes", "created_at", "last_accessed_at",
  ])) return false;
  return sha(value.cache_key) && kind(value.kind)
    && (value.status === "ready" || value.status === "building" || value.status === "failed")
    && nonnegative(value.size_bytes) && iso(value.created_at) && iso(value.last_accessed_at);
}

export function isDerivedMediaStats(value: unknown): value is DerivedMediaStats {
  if (!record(value) || !only(value, ["total_ready_bytes", "ready_count", "disk_budget_bytes"])) return false;
  return nonnegative(value.total_ready_bytes) && nonnegative(value.ready_count)
    && nonnegative(value.disk_budget_bytes);
}

function parse<T>(value: unknown, check: (candidate: unknown) => candidate is T, name: string): T {
  if (!check(value)) throw new Error(`Invalid ${name}`);
  return value;
}

export const parseDerivedMediaLookupInput = (value: unknown) =>
  parse(value, isDerivedMediaLookupInput, "DerivedMediaLookupInput");
export const parseDerivedMediaEntry = (value: unknown) =>
  parse(value, isDerivedMediaEntry, "DerivedMediaEntry");
export const parseDerivedMediaStats = (value: unknown) =>
  parse(value, isDerivedMediaStats, "DerivedMediaStats");

// ---- B11：preview-source（全源代理与预览源选择） ----

export const PREVIEW_SOURCE_PROFILES = ["preview-540-v1", "preview-720-v1", "preview-1080-v1"] as const;
export type PreviewSourceProfileId = (typeof PREVIEW_SOURCE_PROFILES)[number];
export type PreviewSourceMode = "auto" | "original" | "proxy";

export interface PreviewSourceDescription {
  source_id: string;
  /** 生效模式（auto 请求在代理 ready 时生效为 proxy）。 */
  mode: PreviewSourceMode;
  status: "ready" | "pending" | "unavailable";
  job_id: string | null;
  cache_key: string | null;
  asset_fingerprint: string;
  profile_id: PreviewSourceProfileId;
  duration_us: number;
  /** 原源微秒为权威：proxyTimeUs = sourceTimeUs - source_origin_us。 */
  source_origin_us: number;
  fps_num: number;
  fps_den: number;
  coded_width: number;
  coded_height: number;
  display_width: number;
  display_height: number;
  rotation: number;
  codec: string | null;
  size_bytes: number | null;
}

export interface PreviewSourceRequestInput {
  project_id: ProjectId;
  asset_id: AssetId;
  profile_id?: PreviewSourceProfileId;
  mode?: PreviewSourceMode;
  generate?: boolean;
}

export interface PreviewSourceJobRequestInput {
  project_id: ProjectId;
  asset_id: AssetId;
  profile_id?: PreviewSourceProfileId;
}

export interface PreviewSourceJobResponse {
  job_id: string | null;
  cache_key: string | null;
  status: "queued" | "ready" | "building" | "failed" | null;
}

export interface PreviewSourceMediaInput {
  project_id: ProjectId;
  asset_id: AssetId;
  profile_id: PreviewSourceProfileId;
}

export interface PreviewSourceMediaResponse {
  /** aivideo:// 票据 URL（Main 换发；Renderer 永远接触不到 path）。 */
  media_url: string;
  cache_key: string;
  status: "ready";
  size_bytes: number;
}

const PROFILE = /^preview-(540|720|1080)-v1$/;
const MODES: readonly PreviewSourceMode[] = ["auto", "original", "proxy"];
const SOURCE_ID = /^src_[A-Za-z0-9_-]+_(preview-(540|720|1080)-v1)_(original|proxy)$/;

function profile(value: unknown): value is PreviewSourceProfileId {
  return typeof value === "string" && PROFILE.test(value);
}

function mode(value: unknown): value is PreviewSourceMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function isPreviewSourceDescription(value: unknown): value is PreviewSourceDescription {
  if (!record(value) || !only(value, [
    "source_id", "mode", "status", "job_id", "cache_key", "asset_fingerprint",
    "profile_id", "duration_us", "source_origin_us", "fps_num", "fps_den",
    "coded_width", "coded_height", "display_width", "display_height", "rotation",
    "codec", "size_bytes",
  ])) return false;
  return typeof value.source_id === "string" && SOURCE_ID.test(value.source_id)
    && mode(value.mode)
    && (value.status === "ready" || value.status === "pending" || value.status === "unavailable")
    && (value.job_id === null || typeof value.job_id === "string")
    && (value.cache_key === null || sha(value.cache_key))
    && sha(value.asset_fingerprint)
    && profile(value.profile_id)
    && integer(value.duration_us, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.source_origin_us, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.fps_num, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.fps_den, 1, Number.MAX_SAFE_INTEGER)
    && integer(value.coded_width, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.coded_height, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.display_width, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.display_height, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.rotation, -360, 360)
    && (value.codec === null || typeof value.codec === "string")
    && (value.size_bytes === null || nonnegative(value.size_bytes));
}

function optionalOnly(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every(key => required.includes(key) || optional.includes(key))
    && required.every(key => keys.includes(key));
}

export function isPreviewSourceRequestInput(value: unknown): value is PreviewSourceRequestInput {
  if (!record(value) || !optionalOnly(value, ["project_id", "asset_id"], ["profile_id", "mode", "generate"])) return false;
  if (!id(value.project_id) || !id(value.asset_id)) return false;
  if (value.profile_id !== undefined && !profile(value.profile_id)) return false;
  if (value.mode !== undefined && !mode(value.mode)) return false;
  if (value.generate !== undefined && typeof value.generate !== "boolean") return false;
  return true;
}

export function isPreviewSourceJobRequestInput(value: unknown): value is PreviewSourceJobRequestInput {
  if (!record(value) || !optionalOnly(value, ["project_id", "asset_id"], ["profile_id"])) return false;
  return id(value.project_id) && id(value.asset_id)
    && (value.profile_id === undefined || profile(value.profile_id));
}

export function isPreviewSourceJobResponse(value: unknown): value is PreviewSourceJobResponse {
  if (!record(value) || !only(value, ["job_id", "cache_key", "status"])) return false;
  return (value.job_id === null || id(value.job_id))
    && (value.cache_key === null || sha(value.cache_key))
    && (value.status === null || value.status === "queued" || value.status === "ready"
      || value.status === "building" || value.status === "failed");
}

export function isPreviewSourceMediaInput(value: unknown): value is PreviewSourceMediaInput {
  if (!record(value) || !only(value, ["project_id", "asset_id", "profile_id"])) return false;
  return id(value.project_id) && id(value.asset_id) && profile(value.profile_id);
}

export function isPreviewSourceMediaResponse(value: unknown): value is PreviewSourceMediaResponse {
  if (!record(value) || !only(value, ["media_url", "cache_key", "status", "size_bytes"])) return false;
  return typeof value.media_url === "string" && value.media_url.startsWith("aivideo://media/")
    && sha(value.cache_key) && value.status === "ready" && nonnegative(value.size_bytes);
}

export const parsePreviewSourceDescription = (value: unknown): PreviewSourceDescription =>
  parse(value, isPreviewSourceDescription, "PreviewSourceDescription");
export const parsePreviewSourceRequestInput = (value: unknown): PreviewSourceRequestInput =>
  parse(value, isPreviewSourceRequestInput, "PreviewSourceRequestInput");
export const parsePreviewSourceJobRequestInput = (value: unknown): PreviewSourceJobRequestInput =>
  parse(value, isPreviewSourceJobRequestInput, "PreviewSourceJobRequestInput");
export const parsePreviewSourceJobResponse = (value: unknown): PreviewSourceJobResponse =>
  parse(value, isPreviewSourceJobResponse, "PreviewSourceJobResponse");
export const parsePreviewSourceMediaInput = (value: unknown): PreviewSourceMediaInput =>
  parse(value, isPreviewSourceMediaInput, "PreviewSourceMediaInput");
export const parsePreviewSourceMediaResponse = (value: unknown): PreviewSourceMediaResponse =>
  parse(value, isPreviewSourceMediaResponse, "PreviewSourceMediaResponse");

// ---- B14：素材级持久化波形（waveform） ----

/** 波形算法常量（与 Core media/waveform.py 一致；参数由服务端固定）。 */
export const WAVEFORM_SAMPLE_RATE = 8000 as const;
export const WAVEFORM_CHANNELS = 1 as const;
export const WAVEFORM_BUCKET = 256 as const;

export type WaveformStatus =
  | "ready" | "building" | "queued" | "running" | "failed" | null;

export interface WaveformRequestInput {
  project_id: ProjectId;
  asset_id: AssetId;
  /** true 时无条目则登记生成作业（Renderer 侧显式触发）。 */
  generate?: boolean;
}

export interface WaveformDescription {
  cache_key: string;
  status: WaveformStatus;
  job_id: string | null;
  size_bytes: number | null;
  sample_rate: number;
  channels: number;
  bucket: number;
}

export interface WaveformMediaInput {
  project_id: ProjectId;
  asset_id: AssetId;
}

export interface WaveformMediaResponse {
  /** aivideo:// 票据 URL（Main 换发；Renderer 永远接触不到 path）。 */
  media_url: string;
  cache_key: string;
  status: "ready";
  size_bytes: number;
}

export function isWaveformRequestInput(value: unknown): value is WaveformRequestInput {
  if (!record(value) || !optionalOnly(value, ["project_id", "asset_id"], ["generate"])) return false;
  if (!id(value.project_id) || !id(value.asset_id)) return false;
  if (value.generate !== undefined && typeof value.generate !== "boolean") return false;
  return true;
}

export function isWaveformDescription(value: unknown): value is WaveformDescription {
  if (!record(value) || !only(value, [
    "cache_key", "status", "job_id", "size_bytes", "sample_rate", "channels", "bucket",
  ])) return false;
  return sha(value.cache_key)
    && (value.status === null || value.status === "ready" || value.status === "building"
      || value.status === "queued" || value.status === "running" || value.status === "failed")
    && (value.job_id === null || id(value.job_id))
    && (value.size_bytes === null || nonnegative(value.size_bytes))
    && value.sample_rate === WAVEFORM_SAMPLE_RATE
    && value.channels === WAVEFORM_CHANNELS
    && value.bucket === WAVEFORM_BUCKET;
}

export function isWaveformMediaInput(value: unknown): value is WaveformMediaInput {
  if (!record(value) || !only(value, ["project_id", "asset_id"])) return false;
  return id(value.project_id) && id(value.asset_id);
}

export function isWaveformMediaResponse(value: unknown): value is WaveformMediaResponse {
  if (!record(value) || !only(value, ["media_url", "cache_key", "status", "size_bytes"])) return false;
  return typeof value.media_url === "string" && value.media_url.startsWith("aivideo://media/")
    && sha(value.cache_key) && value.status === "ready" && nonnegative(value.size_bytes);
}

export const parseWaveformRequestInput = (value: unknown): WaveformRequestInput =>
  parse(value, isWaveformRequestInput, "WaveformRequestInput");
export const parseWaveformDescription = (value: unknown): WaveformDescription =>
  parse(value, isWaveformDescription, "WaveformDescription");
export const parseWaveformMediaInput = (value: unknown): WaveformMediaInput =>
  parse(value, isWaveformMediaInput, "WaveformMediaInput");
export const parseWaveformMediaResponse = (value: unknown): WaveformMediaResponse =>
  parse(value, isWaveformMediaResponse, "WaveformMediaResponse");
