import { parseProviderCapabilityTestResult } from "@aivideo/contracts";
import { issueCandidateClipMedia } from "./candidate-media.js";

type RequestInitLike = { method?: string; body?: string };
type IpcHandle = (channel: string, listener: (_event: unknown, input?: any) => Promise<unknown> | unknown) => void;

export interface Stage2aIpcDependencies {
  handle: IpcHandle;
  fetchWithUi: <T = unknown>(path: string, init?: RequestInitLike) => Promise<T>;
  saveSecret: (providerConfigId: string, secret: string) => Promise<void>;
  deleteSecret: (providerConfigId: string) => Promise<void>;
  issueCandidateClipMedia: typeof issueCandidateClipMedia;
  candidateMediaDependencies: Parameters<typeof issueCandidateClipMedia>[1];
}

const API_PREFIX = "/api/v1";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const rendererSensitiveKeys = new Set([
  "path", "uri", "root_dir", "database", "database_path", "admin_token", "ui_token", "token", "authorization",
  "installed_path", "install_dir", "source_file", "model_path", "model_dir", "runtime_dir", "ready_file",
  "api_key", "secret", "prompt", "raw_response", "request", "response", "body", "request_body", "response_body"
]);

export function rendererSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rendererSafe);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (!rendererSensitiveKeys.has(key.toLowerCase())) result[key] = rendererSafe(item);
  return result;
}

function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function record(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))) throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

const PROVIDER_TEST_ERRORS = new Set([
  "PROVIDER_AUTH_FAILED", "PROVIDER_RATE_LIMITED", "PROVIDER_TIMEOUT",
  "PROVIDER_NETWORK_ERROR", "PROVIDER_TLS_ERROR", "PROVIDER_UNAVAILABLE",
  "PROVIDER_CONTENT_REJECTED", "PROVIDER_INVALID_REQUEST", "PROVIDER_ENDPOINT_NOT_FOUND",
  "PROVIDER_INVALID_RESPONSE", "PROVIDER_INVALID_CONFIG", "PROVIDER_SECRET_MISSING",
  "PROVIDER_CREDENTIAL_MISSING", "PROVIDER_NOT_FOUND", "PROVIDER_RESPONSE_TOO_LARGE",
]);
function safeError(): Error { return new Error("Core request failed"); }
// P67：Provider 删除的失败码白名单——只有这两个确定性业务码允许透传到
// 渲染端（决定 UI 文案走向），其余上游文本一律吞掉（可能含凭据）。
const PROVIDER_DELETE_ERRORS = new Set(["PROVIDER_NOT_FOUND", "PROVIDER_IN_USE"]);
async function safeInvoke<T>(operation: () => Promise<T>, providerTest = false, allowCodes?: ReadonlySet<string>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // Electron strips custom error properties. Pass only an allowlisted code
    // in the message, never upstream text (which can contain credentials).
    const candidate = error as { code?: unknown; message?: unknown } | null;
    const message = typeof candidate?.message === "string" ? candidate.message : "";
    const code = typeof candidate?.code === "string" ? candidate.code : /^\[([A-Z_]+)\]/.exec(message)?.[1];
    if (providerTest && code && PROVIDER_TEST_ERRORS.has(code)) {
      console.error(`[core] provider test failed: ${code}`);
      throw new Error(`[${code}] Provider connection test failed`);
    }
    if (code && allowCodes?.has(code)) {
      console.error(`[core] provider delete failed: ${code}`);
      throw new Error(`[${code}] Provider 删除被拒绝`);
    }
    console.error("[core] request failed (details withheld)");
    throw safeError();
  }
}

/** Stage2A's complete Renderer-facing IPC allowlist. It deliberately accepts no free-form secrets, paths, tokens, or media ranges. */
export function registerStage2aIpc(deps: Stage2aIpcDependencies): void {
  const safeFetch = <T = unknown>(path: string, init?: RequestInitLike) => safeInvoke(() => deps.fetchWithUi<T>(path, init));
  deps.handle("brief:get", (_event, projectId) => safeFetch(`${API_PREFIX}/projects/${id(projectId, "project_id")}/brief`).then(rendererSafe));
  deps.handle("brief:put", (_event, input) => {
    const value = record(input, ["project_id", "brief"], "brief request");
    return safeFetch(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/brief`, { method: "PUT", body: JSON.stringify(value.brief) }).then(rendererSafe);
  });
  deps.handle("recipe:list", async () => {
    const page = await safeFetch<{ items: unknown[] }>(`${API_PREFIX}/recipes`);
    if (!Array.isArray(page.items)) throw safeError();
    return { items: page.items.map(rendererSafe) };
  });
  deps.handle("recipe:get", (_event, recipeId) => safeFetch(`${API_PREFIX}/recipes/${encodeURIComponent(id(recipeId, "recipe_id"))}`).then(rendererSafe));
  deps.handle("provider:list", () => safeFetch(`${API_PREFIX}/providers`).then(rendererSafe));
  deps.handle("provider:create", (_event, input) => safeFetch(`${API_PREFIX}/providers`, { method: "POST", body: JSON.stringify(input) }).then(rendererSafe));
  deps.handle("provider:update", (_event, input) => {
    const value = record(input, ["provider_config_id", "patch"], "provider update");
    return safeFetch(`${API_PREFIX}/providers/${encodeURIComponent(id(value.provider_config_id, "provider_config_id"))}`, { method: "PATCH", body: JSON.stringify(value.patch) }).then(rendererSafe);
  });
  deps.handle("provider:set-secret", async (_event, input) => {
    const value = record(input, ["provider_config_id", "secret"], "provider secret");
    const providerConfigId = id(value.provider_config_id, "provider_config_id");
    if (typeof value.secret !== "string" || value.secret.length < 1 || value.secret.length > 16_384) throw new Error("Invalid credential input");
    await safeInvoke(() => deps.saveSecret(providerConfigId, value.secret as string));
    return { provider_config_id: providerConfigId, credential_status: "configured" };
  });
  deps.handle("provider:delete-secret", async (_event, providerId) => {
    const providerConfigId = id(providerId, "provider_config_id");
    await safeInvoke(() => deps.deleteSecret(providerConfigId));
    return { provider_config_id: providerConfigId, credential_status: "missing" };
  });
  deps.handle("provider:delete", async (_event, providerId) => {
    // P67：删除 Provider 配置。Core 侧 fail-closed（被外发/生成历史引用 →
    // PROVIDER_IN_USE）；行删除成功后必须再清加密存储条目，否则重启时
    // reinjectProviderSecrets 会永远携带孤儿密钥（隐私债）。
    const providerConfigId = id(providerId, "provider_config_id");
    await safeInvoke(
      () => deps.fetchWithUi(`${API_PREFIX}/providers/${encodeURIComponent(providerConfigId)}`, { method: "DELETE" }),
      false,
      PROVIDER_DELETE_ERRORS,
    );
    await safeInvoke(() => deps.deleteSecret(providerConfigId));
    return { provider_config_id: providerConfigId, deleted: true };
  });
  deps.handle("provider:test", (_event, providerId) => safeInvoke(
    () => deps.fetchWithUi(`${API_PREFIX}/providers/${encodeURIComponent(id(providerId, "provider_config_id"))}/test`, { method: "POST" }),
    true,
  ).then(rendererSafe));
  deps.handle("planning:test-provider-capability", (_event, providerId) => safeFetch(`${API_PREFIX}/providers/${encodeURIComponent(id(providerId, "provider_config_id"))}/candidate-planning-capability-test`, { method: "POST" }).then(value => parseProviderCapabilityTestResult(rendererSafe(value))));
  deps.handle("planning:prepare", async (_event, input) => {
    // AI-2 阶段三：candidate_source 为**可选**字段。record() 要求字段数与白名单
    // **完全相等**，故不能直接把它并入白名单（会让不带该字段的旧调用失败），
    // 也不能只留白名单不动（带该字段的调用会被拒，且下方永远读不到它）。
    // 正确做法：先将“未提供”归一为 undefined（不计入字段数），再按两种合法形态分别校验。
    const raw = (input !== null && typeof input === "object" && !Array.isArray(input))
      ? { ...(input as Record<string, unknown>) }
      : input;
    const hasSource = Boolean(raw && typeof raw === "object" && "candidate_source" in (raw as Record<string, unknown>)
      && (raw as Record<string, unknown>).candidate_source !== undefined);
    const value = record(raw, hasSource
      ? ["project_id", "provider_config_id", "recipe_id", "transcript_ids", "candidate_source"]
      : ["project_id", "provider_config_id", "recipe_id", "transcript_ids"], "planning prepare");
    if (!Array.isArray(value.transcript_ids) || value.transcript_ids.length < 1 || value.transcript_ids.length > 20) throw new Error("Invalid transcript_ids");
    const transcriptIds = value.transcript_ids.map(item => id(item, "transcript_id"));
    if (new Set(transcriptIds).size !== transcriptIds.length) throw new Error("Invalid transcript_ids");
    const source = typeof value.candidate_source === "string" ? value.candidate_source : undefined;
    if (hasSource && source === undefined) throw new Error("Invalid candidate_source");
    return safeFetch(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/candidate-generations/prepare`, { method: "POST", body: JSON.stringify({ provider_config_id: id(value.provider_config_id, "provider_config_id"), recipe_id: id(value.recipe_id, "recipe_id"), transcript_ids: transcriptIds, ...(source ? { candidate_source: source } : {}) }) }).then(rendererSafe);
  });
  deps.handle("planning:create", async (_event, input) => {
    const value = record(input, ["project_id", "egress_preview_id", "payload_sha256"], "planning create");
    return safeFetch(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/candidate-generations`, { method: "POST", body: JSON.stringify({ egress_preview_id: id(value.egress_preview_id, "egress_preview_id"), payload_sha256: sha256(value.payload_sha256, "payload_sha256") }) }).then(rendererSafe);
  });
  deps.handle("planning:list", (_event, projectId) => safeFetch(`${API_PREFIX}/projects/${id(projectId, "project_id")}/candidate-plans`).then(rendererSafe));
  deps.handle("planning:get", (_event, candidateId) => safeFetch(`${API_PREFIX}/candidate-plans/${encodeURIComponent(id(candidateId, "candidate_plan_id"))}`).then(rendererSafe));
  deps.handle("planning:clip-media", (_event, input) => safeInvoke(() => deps.issueCandidateClipMedia(input, deps.candidateMediaDependencies)));
  deps.handle("planning:adopt", async (_event, input) => {
    const value = record(input, ["project_id", "candidate_plan_id", "adoption"], "candidate adoption");
    const adoption = record(value.adoption, ["schema_version", "candidate_document_sha256", "base_revision_id"], "candidate adoption");
    if (adoption.schema_version !== 1 || !(adoption.base_revision_id === null || ID.test(String(adoption.base_revision_id)))) throw new Error("Invalid candidate adoption");
    const projectId = id(value.project_id, "project_id");
    await safeFetch(`${API_PREFIX}/projects/${projectId}/candidate-plans/${id(value.candidate_plan_id, "candidate_plan_id")}/adopt`, { method: "POST", body: JSON.stringify({ schema_version: 1, candidate_document_sha256: sha256(adoption.candidate_document_sha256, "candidate_document_sha256"), base_revision_id: adoption.base_revision_id }) });
    return rendererSafe(await safeFetch(`${API_PREFIX}/projects/${projectId}/timeline`));
  });
}
