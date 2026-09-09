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
