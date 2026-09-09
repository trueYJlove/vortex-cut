import {
  isDerivedMediaStats,
  parseDerivedMediaEntry,
  parseDerivedMediaLookupInput,
  parsePcmChunkDescription,
  parsePcmChunkMediaResponse,
  parsePcmChunkRequestInput,
  parsePreviewSourceDescription,
  parsePreviewSourceJobRequestInput,
  parsePreviewSourceJobResponse,
  parsePreviewSourceMediaResponse,
  parsePreviewSourceRequestInput,
  parseWaveformDescription,
  parseWaveformMediaResponse,
  parseWaveformRequestInput,
  type DerivedMediaEntry,
  type DerivedMediaStats,
} from "@aivideo/contracts";

type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
type Registrar = { handle(channel: string, listener: Handler): void };
type FetchWithUi = (path: string, init?: RequestInit) => Promise<unknown>;

/**
 * B10 派生媒体 + B11 preview-source IPC（计划第 6.1 节四层贯穿的 Main 层）。
 *
 * - lookup/stats/preview-source/preview-source-jobs：Renderer 可见（UI 通道）；
 *   响应经 rendererSafe 剥离任何路径形态字段（契约校验再兜底）。
 * - media/preview-source-media：Main 经 admin 通道 resolve 派生/代理文件
 *   绝对路径，再以 restricted-media 注册 + 换票据——Renderer 只拿
 *   aivideo:// 票据 URL，永远接触不到 path。
 */

const RENDERER_SAFE_KEYS = new Set(["path", "uri", "absolute_path", "root_dir"]);

function rendererSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rendererSafe);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!RENDERER_SAFE_KEYS.has(key.toLowerCase())) result[key] = rendererSafe(item);
  }
  return result;
}

function asRecord(value: unknown, allowedKeys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !allowedKeys.includes(key))) {
    throw new Error(`Invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

function asId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function asParams(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid derived params");
  }
  const entries = Object.entries(value);
  if (entries.length > 8) throw new Error("Invalid derived params");
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!/^[a-z0-9_]{1,64}$/.test(key)
      || typeof item !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item)) {
      throw new Error("Invalid derived params");
    }
    result[key] = item;
  }
  return result;
}

export interface DerivedMediaIpcDeps {
  /** UI 会话 fetch（lookup/stats/preview-source 走 Renderer 可见端点）。 */
  fetchWithUi: FetchWithUi;
  /** admin 通道 resolve：返回 { cache_key, status, path, size_bytes }。 */
  resolveDerived: (input: { project_id: string; asset_id: string; kind: string; params: Record<string, string> }) => Promise<{ cache_key: string; status: string; path: string; size_bytes: number }>;
  /** B11：admin 通道解析代理文件（preview-source/media 端点）。 */
  resolvePreviewSourceMedia: (input: { project_id: string; asset_id: string; profile_id: string }) => Promise<{ cache_key: string; status: string; path: string; size_bytes: number }>;
  /** B14：admin 通道解析波形文件（waveform/media 端点；无请求体——
   * 波形参数由服务端算法常量唯一决定）。 */
  resolveWaveformMedia: (input: { project_id: string; asset_id: string }) => Promise<{ cache_key: string; status: string; path: string; size_bytes: number }>;
  /** B15：admin 通道解析 PCM 块文件（pcm-chunks/media 端点）。 */
  resolvePcmChunkMedia: (input: { project_id: string; asset_id: string; start_sample: number }) => Promise<{ cache_key: string; status: string; path: string; size_bytes: number }>;
  /** restricted-media 注册（purpose="proxy"）+ 票据签发。 */
  registerDerivedMedia: (cacheKey: string, path: string) => string;
}

async function safeInvoke<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    const derivedCodes = new Set(["DERIVED_NOT_FOUND", "DERIVED_KIND_INVALID", "DERIVED_PARAMS_INVALID", "ASSET_NOT_FOUND", "ASSET_CHANGED", "ASSET_MISSING", "DERIVED_CACHE_UNSAFE", "PREVIEW_PROFILE_INVALID", "PREVIEW_SOURCE_MODE_INVALID", "ASSET_NO_VIDEO_STREAM", "MEDIA_NO_AUDIO", "PCM_CHUNK_OFFSET_INVALID", "PCM_CHUNK_FFMPEG_FAILED", "PCM_CHUNK_TOO_LARGE", "MEDIA_MISSING"]);
    if (typeof code === "string" && derivedCodes.has(code)) throw new Error(code);
    throw new Error("Core request failed");
  }
}

export function registerPerformanceIpc({ ipc, fetchWithUi, resolveDerived, resolvePreviewSourceMedia, resolveWaveformMedia, resolvePcmChunkMedia, registerDerivedMedia }: DerivedMediaIpcDeps & { ipc: Registrar }): void {
  const fetchSafe = (path: string, init?: RequestInit) =>
    safeInvoke(() => fetchWithUi(path, init));

  ipc.handle("derived-media:lookup", async (_event, value) => {
    const input = asRecord(value, ["project_id", "asset_id", "kind", "params"], "derived lookup");
    const request = parseDerivedMediaLookupInput({
      project_id: asId(input.project_id, "project_id"),
      asset_id: asId(input.asset_id, "asset_id"),
      kind: input.kind,
      params: asParams(input.params ?? {}),
    });
    return parseDerivedMediaEntry(rendererSafe(await fetchSafe(
      `/api/v1/projects/${request.project_id}/derived-media/lookup`,
      { method: "POST", body: JSON.stringify(request) },
    )));
  });

  ipc.handle("derived-media:stats", async (_event, value) => {
    const input = asRecord(value, ["project_id"], "derived stats");
    const projectId = asId(input.project_id, "project_id");
    const stats = rendererSafe(await fetchSafe(
      `/api/v1/projects/${projectId}/derived-media/stats`,
    )) as Record<string, unknown>;
    if ("path" in stats || "uri" in stats) throw new Error("Invalid DerivedMediaStats");
    if (!isDerivedMediaStats(stats)) throw new Error("Invalid DerivedMediaStats");
    return stats;
  });

  ipc.handle("derived-media:media", async (_event, value) => {
    const input = asRecord(value, ["project_id", "asset_id", "kind", "params"], "derived media");
    const request = parseDerivedMediaLookupInput({
      project_id: asId(input.project_id, "project_id"),
      asset_id: asId(input.asset_id, "asset_id"),
      kind: input.kind,
      params: asParams(input.params ?? {}),
    });
    const resolved = await safeInvoke(() => resolveDerived(request));
    if (resolved.status !== "ready" || typeof resolved.path !== "string") {
      throw new Error("DERIVED_NOT_FOUND");
    }
    // path 只存在于 Main 进程内存；Renderer 只收票据 URL。
    return { media_url: registerDerivedMedia(resolved.cache_key, resolved.path), cache_key: resolved.cache_key, status: "ready" as const, size_bytes: resolved.size_bytes };
  });

  // ---- B11：preview-source ----

  ipc.handle("preview-source:get", async (_event, value) => {
    const input = asRecord(value, ["project_id", "asset_id", "profile_id", "mode", "generate"], "preview source");
    const body: Record<string, unknown> = {};
    if (input.profile_id !== undefined) body.profile_id = input.profile_id;
    if (input.mode !== undefined) body.mode = input.mode;
    if (input.generate !== undefined) body.generate = input.generate;
    const request = parsePreviewSourceRequestInput({
      project_id: asId(input.project_id, "project_id"),
      asset_id: asId(input.asset_id, "asset_id"),
      ...body,
    });
    const payload = { profile_id: request.profile_id, mode: request.mode, generate: request.generate };
    const clean = Object.fromEntries(Object.entries(payload).filter(([, item]) => item !== undefined));
    const description = rendererSafe(await fetchSafe(
      `/api/v1/projects/${request.project_id}/assets/${request.asset_id}/preview-source`,
      { method: "POST", body: JSON.stringify(clean) },
    ));
    if (JSON.stringify(description).includes("path")) throw new Error("Invalid PreviewSourceDescription");
    return parsePreviewSourceDescription(description);
  });

  ipc.handle("preview-source:jobs", async (_event, value) => {
    const input = asRecord(value, ["project_id", "asset_id", "profile_id"], "preview source jobs");
    const body: Record<string, unknown> = {};
    if (input.profile_id !== undefined) body.profile_id = input.profile_id;
    const request = parsePreviewSourceJobRequestInput({
      project_id: asId(input.project_id, "project_id"),
      asset_id: asId(input.asset_id, "asset_id"),
      ...body,
    });
    const clean = request.profile_id === undefined ? {} : { profile_id: request.profile_id };
    return parsePreviewSourceJobResponse(rendererSafe(await fetchSafe(
      `/api/v1/projects/${request.project_id}/assets/${request.asset_id}/preview-source/jobs`,
      { method: "POST", body: JSON.stringify(clean) },
    )));
  });

  ipc.handle("preview-source:media", async (_event, value) => {
    const input = asRecord(value, ["project_id", "asset_id", "profile_id"], "preview source media");
    const request = parsePreviewSourceRequestInput({
      project_id: asId(input.project_id, "project_id"),
      asset_id: asId(input.asset_id, "asset_id"),
      profile_id: input.profile_id as string | undefined,
      mode: "proxy",
    });
    const resolved = await safeInvoke(() => resolvePreviewSourceMedia({
      project_id: request.project_id,
      asset_id: request.asset_id,
      profile_id: request.profile_id as string,
    }));
    if (resolved.status !== "ready" || typeof resolved.path !== "string") {
      throw new Error("DERIVED_NOT_FOUND");
    }
    // path 只存在于 Main 进程内存；Renderer 只收票据 URL（契约校验兜底）。
    return parsePreviewSourceMediaResponse({
      media_url: registerDerivedMedia(resolved.cache_key, resolved.path),
      cache_key: resolved.cache_key,
      status: "ready",
      size_bytes: resolved.size_bytes,
    });
  });

  // ---- B14：素材级持久化波形 ----

  ipc.handle("waveform:get", async (_event, value) => {
    const input = asRecord(value, ["project_id", "asset_id", "generate"], "waveform");
    const request = parseWaveformRequestInput({
      project_id: asId(input.project_id, "project_id"),
      asset_id: asId(input.asset_id, "asset_id"),
      generate: input.generate,
    });
    const body = request.generate === undefined ? {} : { generate: request.generate };
    const description = rendererSafe(await fetchSafe(
      `/api/v1/projects/${request.project_id}/assets/${request.asset_id}/waveform`,
      { method: "POST", body: JSON.stringify(body) },
    ));
    if (JSON.stringify(description).includes("path")) throw new Error("Invalid WaveformDescription");
    return parseWaveformDescription(description);
  });

  ipc.handle("waveform:media", async (_event, value) => {
    const input = asRecord(value, ["project_id", "asset_id"], "waveform media");
    const request = parseWaveformRequestInput({
      project_id: asId(input.project_id, "project_id"),
      asset_id: asId(input.asset_id, "asset_id"),
    });
    const resolved = await safeInvoke(() => resolveWaveformMedia({
      project_id: request.project_id,
      asset_id: request.asset_id,
    }));
    if (resolved.status !== "ready" || typeof resolved.path !== "string") {
      throw new Error("DERIVED_NOT_FOUND");
    }
    // path 只存在于 Main 进程内存；Renderer 只收票据 URL（契约校验兜底）。
    return parseWaveformMediaResponse({
      media_url: registerDerivedMedia(resolved.cache_key, resolved.path),
      cache_key: resolved.cache_key,
      status: "ready",
      size_bytes: resolved.size_bytes,
    });
  });

  // ---- B15：分块 PCM ----

  ipc.handle("pcm-chunk:ensure", async (_event, value) => {
    const input = asRecord(value, ["project_id", "asset_id", "start_sample"], "pcm chunk ensure");
    const startSample = input.start_sample;
    if (typeof startSample !== "number" || !Number.isInteger(startSample) || startSample < 0 || startSample % 96000 !== 0) {
      throw new Error("Invalid start_sample");
    }
    const request = parsePcmChunkRequestInput({
      project_id: asId(input.project_id, "project_id"),
      asset_id: asId(input.asset_id, "asset_id"),
      start_sample: startSample,
    });
    const description = rendererSafe(await fetchSafe(
      `/api/v1/projects/${request.project_id}/assets/${request.asset_id}/pcm-chunks`,
      { method: "POST", body: JSON.stringify({ start_sample: request.start_sample }) },
    ));
    if (JSON.stringify(description).includes("path")) throw new Error("Invalid PcmChunkDescription");
    return parsePcmChunkDescription(description);
  });

  ipc.handle("pcm-chunk:media", async (_event, value) => {
    const input = asRecord(value, ["project_id", "asset_id", "start_sample"], "pcm chunk media");
    const startSample = input.start_sample;
    if (typeof startSample !== "number" || !Number.isInteger(startSample) || startSample < 0 || startSample % 96000 !== 0) {
      throw new Error("Invalid start_sample");
    }
    const request = parsePcmChunkRequestInput({
      project_id: asId(input.project_id, "project_id"),
      asset_id: asId(input.asset_id, "asset_id"),
      start_sample: startSample,
    });
    const resolved = await safeInvoke(() => resolvePcmChunkMedia({
      project_id: request.project_id,
      asset_id: request.asset_id,
      start_sample: request.start_sample,
    }));
    if (resolved.status !== "ready" || typeof resolved.path !== "string") {
      throw new Error("DERIVED_NOT_FOUND");
    }
    // path 只存在于 Main 进程内存；Renderer 只收票据 URL（契约校验兜底）。
    return parsePcmChunkMediaResponse({
      media_url: registerDerivedMedia(resolved.cache_key, resolved.path),
      cache_key: resolved.cache_key,
      status: "ready",
      size_bytes: resolved.size_bytes,
    });
  });
}

export type { DerivedMediaEntry };
