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

// ---- B15：分块 PCM（audio_pcm_chunk） ----

/** PCM 块算法常量（与 Core media/audio_chunks.py 一致；参数服务端固定）。 */
export const PCM_CHUNK_SAMPLE_RATE = 48000 as const;
export const PCM_CHUNK_CHANNELS = 2 as const;
export const PCM_CHUNK_SAMPLES = 96000 as const;

export interface PcmChunkRequestInput {
  project_id: ProjectId;
  asset_id: AssetId;
  /** 块起点（每声道采样偏移；必须对齐 96000 样本网格）。 */
  start_sample: number;
}

export interface PcmChunkDescription {
  cache_key: string;
  status: "ready";
  start_sample: number;
  /** 每声道有效样本数；< 96000 = 尾块/EOF；null = 缓存命中路径未解析头。 */
  valid_samples: number | null;
  sample_rate: number;
  channels: number;
  chunk_samples: number;
  size_bytes: number;
}

export interface PcmChunkMediaInput {
  project_id: ProjectId;
  asset_id: AssetId;
  start_sample: number;
}

export interface PcmChunkMediaResponse {
  /** aivideo:// 票据 URL（Main 换发；Renderer 永远接触不到 path）。 */
  media_url: string;
  cache_key: string;
  status: "ready";
  size_bytes: number;
}

const CHUNK_GRID = PCM_CHUNK_SAMPLES;

export function isPcmChunkRequestInput(value: unknown): value is PcmChunkRequestInput {
  if (!record(value) || !only(value, ["project_id", "asset_id", "start_sample"])) return false;
  return id(value.project_id) && id(value.asset_id)
    && integer(value.start_sample, 0, Number.MAX_SAFE_INTEGER)
    && value.start_sample % CHUNK_GRID === 0;
}

export function isPcmChunkDescription(value: unknown): value is PcmChunkDescription {
  if (!record(value) || !only(value, [
    "cache_key", "status", "start_sample", "valid_samples", "sample_rate",
    "channels", "chunk_samples", "size_bytes",
  ])) return false;
  return sha(value.cache_key)
    && value.status === "ready"
    && integer(value.start_sample, 0, Number.MAX_SAFE_INTEGER)
    && (value.valid_samples === null || integer(value.valid_samples, 0, CHUNK_GRID))
    && value.sample_rate === PCM_CHUNK_SAMPLE_RATE
    && value.channels === PCM_CHUNK_CHANNELS
    && value.chunk_samples === CHUNK_GRID
    && nonnegative(value.size_bytes);
}

export function isPcmChunkMediaInput(value: unknown): value is PcmChunkMediaInput {
  if (!record(value) || !only(value, ["project_id", "asset_id", "start_sample"])) return false;
  return id(value.project_id) && id(value.asset_id)
    && integer(value.start_sample, 0, Number.MAX_SAFE_INTEGER)
    && value.start_sample % CHUNK_GRID === 0;
}

export function isPcmChunkMediaResponse(value: unknown): value is PcmChunkMediaResponse {
  if (!record(value) || !only(value, ["media_url", "cache_key", "status", "size_bytes"])) return false;
  return typeof value.media_url === "string" && value.media_url.startsWith("aivideo://media/")
    && sha(value.cache_key) && value.status === "ready" && nonnegative(value.size_bytes);
}

export const parsePcmChunkRequestInput = (value: unknown): PcmChunkRequestInput =>
  parse(value, isPcmChunkRequestInput, "PcmChunkRequestInput");
export const parsePcmChunkDescription = (value: unknown): PcmChunkDescription =>
  parse(value, isPcmChunkDescription, "PcmChunkDescription");
export const parsePcmChunkMediaInput = (value: unknown): PcmChunkMediaInput =>
  parse(value, isPcmChunkMediaInput, "PcmChunkMediaInput");
export const parsePcmChunkMediaResponse = (value: unknown): PcmChunkMediaResponse =>
  parse(value, isPcmChunkMediaResponse, "PcmChunkMediaResponse");

// ---- C20：窗口化 IR v2（preview-ir-v2 manifest/window） ----

/** v2 schema 常量（与 Core rendering/ir_window.py 一致）。 */
export const PREVIEW_IR_V2_SCHEMA = "preview-ir-v2" as const;
/** 每窗帧数硬上限（计划 C20：1..300）。 */
export const PREVIEW_IR_V2_MAX_WINDOW_FRAMES = 300 as const;

/** v2 manifest 请求输入。 */
export interface PreviewIrV2ManifestInput {
  project_id: ProjectId;
  timeline_revision_id?: string | null;
  output_ratio?: string;
}

/** v2 窗口请求输入（start_frame 含、frame_count 1..300）。 */
export interface PreviewIrV2WindowInput {
  project_id: ProjectId;
  start_frame: number;
  frame_count: number;
  timeline_revision_id?: string | null;
  output_ratio?: string;
}

/** v2 manifest：非帧字段的显式 DTO（frames 不在 manifest 中）。 */
export interface PreviewIrV2Manifest {
  schema: typeof PREVIEW_IR_V2_SCHEMA;
  projector_version: number;
  /** 绑定 project/revision/output profile/toolchain（内容指纹 + 模式 + 规格）。 */
  manifest_id: string;
  timeline_revision_id: string;
  content_fingerprint: string;
  fps_num: number;
  fps_den: number;
  total_frames: number;
  duration_us: number;
  canvas: Record<string, unknown>;
  inputs: Array<Record<string, unknown>>;
  segments: Array<Record<string, unknown>>;
  captions: Array<Record<string, unknown>>;
  caption_styles: Record<string, unknown>;
  transition_windows: Array<Record<string, unknown>>;
  known_approximations: string[];
}

/** v2 窗口响应：帧表切片（帧结构与 v1 PreviewFrame 同语义）。 */
export interface PreviewIrV2Window {
  schema: typeof PREVIEW_IR_V2_SCHEMA;
  manifest_id: string;
  start_frame: number;
  frame_count: number;
  frames: Array<Record<string, unknown>>;
}

const V2_SCHEMA = PREVIEW_IR_V2_SCHEMA;
const MANIFEST_ID = /^sha256:[a-f0-9]{64}@.+@.+$/;
const RATIO = /^(169|916|11|43|34)$/;

function frameRows(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(item => record(item) && !("path" in item));
}

function recordRows(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(item => record(item));
}

export function isPreviewIrV2ManifestInput(value: unknown): value is PreviewIrV2ManifestInput {
  if (!record(value) || !only(value, ["project_id", "timeline_revision_id", "output_ratio"])) return false;
  return id(value.project_id)
    && (value.timeline_revision_id === undefined || value.timeline_revision_id === null || id(value.timeline_revision_id))
    && (value.output_ratio === undefined || (typeof value.output_ratio === "string" && RATIO.test(value.output_ratio)));
}

export function isPreviewIrV2WindowInput(value: unknown): value is PreviewIrV2WindowInput {
  if (!record(value) || !only(value, ["project_id", "start_frame", "frame_count", "timeline_revision_id", "output_ratio"])) return false;
  return id(value.project_id)
    && integer(value.start_frame, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.frame_count, 1, PREVIEW_IR_V2_MAX_WINDOW_FRAMES)
    && (value.timeline_revision_id === undefined || value.timeline_revision_id === null || id(value.timeline_revision_id))
    && (value.output_ratio === undefined || (typeof value.output_ratio === "string" && RATIO.test(value.output_ratio)));
}

export function isPreviewIrV2Manifest(value: unknown): value is PreviewIrV2Manifest {
  if (!record(value) || !only(value, [
    "schema", "projector_version", "manifest_id", "timeline_revision_id",
    "content_fingerprint", "fps_num", "fps_den", "total_frames", "duration_us",
    "canvas", "inputs", "segments", "captions", "caption_styles",
    "transition_windows", "known_approximations",
  ])) return false;
  return value.schema === V2_SCHEMA
    && nonnegative(value.projector_version)
    && typeof value.manifest_id === "string" && MANIFEST_ID.test(value.manifest_id)
    && id(value.timeline_revision_id)
    && sha(value.content_fingerprint)
    && integer(value.fps_num, 1, 1000)
    && integer(value.fps_den, 1, 1000)
    && integer(value.total_frames, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.duration_us, 0, Number.MAX_SAFE_INTEGER)
    && record(value.canvas)
    && recordRows(value.inputs) && recordRows(value.segments)
    && recordRows(value.captions) && record(value.caption_styles)
    && recordRows(value.transition_windows)
    && Array.isArray(value.known_approximations)
    && value.known_approximations.every((item: unknown) => typeof item === "string");
}

export function isPreviewIrV2Window(value: unknown): value is PreviewIrV2Window {
  if (!record(value) || !only(value, ["schema", "manifest_id", "start_frame", "frame_count", "frames"])) return false;
  return value.schema === V2_SCHEMA
    && typeof value.manifest_id === "string" && MANIFEST_ID.test(value.manifest_id)
    && integer(value.start_frame, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.frame_count, 1, PREVIEW_IR_V2_MAX_WINDOW_FRAMES)
    && frameRows(value.frames)
    && value.frames.length === value.frame_count;
}

export const parsePreviewIrV2ManifestInput = (value: unknown): PreviewIrV2ManifestInput =>
  parse(value, isPreviewIrV2ManifestInput, "PreviewIrV2ManifestInput");
export const parsePreviewIrV2WindowInput = (value: unknown): PreviewIrV2WindowInput =>
  parse(value, isPreviewIrV2WindowInput, "PreviewIrV2WindowInput");
export const parsePreviewIrV2Manifest = (value: unknown): PreviewIrV2Manifest =>
  parse(value, isPreviewIrV2Manifest, "PreviewIrV2Manifest");
export const parsePreviewIrV2Window = (value: unknown): PreviewIrV2Window =>
  parse(value, isPreviewIrV2Window, "PreviewIrV2Window");

// ---- H1：解码能力表（MediaDecoder 双后端；MEDIA_DECODER_HEVC_PLANNING_GATE §2.2） ----

export type DecodeBackendId = "webcodecs" | "ffmpeg";
export const DECODE_BACKEND_IDS = ["webcodecs", "ffmpeg"] as const;

/** 实测解码模式（诊断呈现用，不参与后端决策）。 */
export type WebCodecsDecodeMode = "prefer-hardware" | "no-preference";

/** 规范化 codec 标识（非 RFC codec string）。 */
export type DecodeCapabilityCodec = "avc" | "hevc" | "av1";
export const DECODE_CAPABILITY_CODECS = ["avc", "hevc", "av1"] as const;

export interface DecodeCapabilityRow {
  codec: DecodeCapabilityCodec;
  /** 平台实测（启动后探测写入，非写死）。 */
  webcodecs_supported: boolean;
  /** 仅呈现用；null = 未探测。 */
  webcodecs_mode: WebCodecsDecodeMode | null;
  ffmpeg_supported: boolean;
  /** 决策：首选后端；webcodecs 不可用时自动 ffmpeg。 */
  preferred: DecodeBackendId;
}

export interface DecodeCapabilityTable {
  rows: DecodeCapabilityRow[];
  probed_at: string;
}

export function isDecodeCapabilityRow(value: unknown): value is DecodeCapabilityRow {
  if (!record(value) || !only(value, ["codec", "webcodecs_supported", "webcodecs_mode", "ffmpeg_supported", "preferred"])) return false;
  return (DECODE_CAPABILITY_CODECS as readonly string[]).includes(value.codec as string)
    && typeof value.webcodecs_supported === "boolean"
    && (value.webcodecs_mode === null || value.webcodecs_mode === "prefer-hardware" || value.webcodecs_mode === "no-preference")
    && typeof value.ffmpeg_supported === "boolean"
    && (value.preferred === "webcodecs" || value.preferred === "ffmpeg");
}

export function isDecodeCapabilityTable(value: unknown): value is DecodeCapabilityTable {
  if (!record(value) || !only(value, ["rows", "probed_at"])) return false;
  return Array.isArray(value.rows) && value.rows.every(isDecodeCapabilityRow) && iso(value.probed_at);
}

export const parseDecodeCapabilityRow = (value: unknown): DecodeCapabilityRow =>
  parse(value, isDecodeCapabilityRow, "DecodeCapabilityRow");
export const parseDecodeCapabilityTable = (value: unknown): DecodeCapabilityTable =>
  parse(value, isDecodeCapabilityTable, "DecodeCapabilityTable");

// ---- H3：窗口帧解码（后端 B / MEDIA_DECODER_HEVC_PLANNING_GATE §2.5） ----

export const MAX_DECODE_FRAMES_PER_REQUEST = 32 as const;

export interface DecodeFramesRequest {
  /** 合成时间轴帧号（非媒体采样序号） */
  frame_numbers: number[];
  /** 合成 fps（number，承载 23.976/29.97） */
  fps: number;
  pixel_format: "nv12";
}

export interface DecodeFramesMeta {
  width: number;
  height: number;
  /** 与请求等长；失败帧号出现在 notes，不在 frames 中 */
  frame_count: number;
  color_space: "bt709";
}

export function isDecodeFramesRequest(value: unknown): value is DecodeFramesRequest {
  if (!record(value) || !only(value, ["frame_numbers", "fps", "pixel_format"])) return false;
  return Array.isArray(value.frame_numbers)
    && value.frame_numbers.length > 0
    && value.frame_numbers.length <= MAX_DECODE_FRAMES_PER_REQUEST
    && value.frame_numbers.every((n: unknown) => Number.isInteger(n) && (n as number) >= 0)
    && typeof value.fps === "number"
    && Number.isFinite(value.fps)
    && (value.fps as number) > 0
    && value.pixel_format === "nv12";
}

export const parseDecodeFramesRequest = (value: unknown): DecodeFramesRequest =>
  parse(value, isDecodeFramesRequest, "DecodeFramesRequest");
