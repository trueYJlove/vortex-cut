import {
  parseModelDetail,
  parseModelSummary,
  parseTranscript,
  parseTranscriptSummary,
  type ModelSummary,
} from "@aivideo/contracts";

export const API_PREFIX = "/api/v1";

export type IpcHandle = (channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<unknown> | unknown) => void;
export type FetchWithUi = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
export type FetchBinaryWithUi = (path: string, init?: RequestInit) => Promise<ArrayBuffer>;

const rendererSensitiveKeys = new Set([
  "path", "uri", "root_dir", "database", "database_path", "admin_token", "ui_token", "token", "authorization",
  "installed_path", "install_dir", "source_file", "model_path", "model_dir", "runtime_dir", "ready_file",
  "absolute_path", "api_key", "secret", "stderr", "traceback", "raw_exception",
]);

/** Strip sensitive local path, token, and internal directory keys before returning Core DTOs to Renderer. */
export function rendererSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rendererSafe);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!rendererSensitiveKeys.has(key.toLowerCase())) result[key] = rendererSafe(item);
  }
  return result;
}

export function asId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

export function asRecord(value: unknown, allowedKeys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowedKeys.includes(key))) {
    throw new Error(`Invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

export function buildQuery(input: Record<string, unknown>, omit: string[] = []): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (omit.includes(key) || value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const result = search.toString();
  return result ? `?${result}` : "";
}

export function modelSummary(value: unknown): ModelSummary { return parseModelSummary(rendererSafe(value)); }
export function modelDetail(value: unknown) { return parseModelDetail(rendererSafe(value)); }
export function transcript(value: unknown) { return parseTranscript(rendererSafe(value)); }
export function transcriptSummary(value: unknown) { return parseTranscriptSummary(rendererSafe(value)); }
