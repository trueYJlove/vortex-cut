import {
  parseImageProviderConfigCreateInput,
  parseImageProviderConfigPage,
  parseImageProviderConfigSummary,
  parseProviderImageGenerationCreateInput,
  parseProviderImageGenerationCreateResponse,
  parseProviderImageGenerationPreparedPreview,
  parseProviderImageGenerationPrepareInput,
  parseProviderImageGenerationRequest,
  parseProviderImageGenerationRequestPage,
  parseProviderImageGenerationRetryPrepareInput,
  parseProviderImageGenerationTask,
  parseProviderImageGenerationTaskPage
} from "@aivideo/contracts";
import type { ImageProviderSecretStore } from "./image-provider-secrets.js";
import { removeImageProviderSecret, saveImageProviderSecret } from "./image-provider-secrets.js";
import type { CoreAdminClient } from "./core-admin-client.js";

type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
type Registrar = { handle(channel: string, listener: Handler): void };
type FetchWithUi = (path: string, init?: RequestInit) => Promise<unknown>;

const sensitiveKeys = new Set(["path", "absolute_path", "uri", "root_dir", "database", "database_path", "admin_token", "ui_token", "token", "authorization", "api_key", "secret", "prompt", "transcript", "caption", "payload", "raw_response", "base64", "b64_json", "stderr", "command", "traceback", "http_body", "request_body", "response_body"]);
function rendererSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rendererSafe);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (!sensitiveKeys.has(key.toLowerCase())) result[key] = rendererSafe(item);
  return result;
}
function asRecord(value: unknown, allowedKeys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowedKeys.includes(key))) throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}
function asId(value: unknown, name: string): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid ${name}`); return value; }
function asSecret(value: unknown): string { if (typeof value !== "string" || value.length < 1 || value.length > 16_384) throw new Error("Invalid credential"); return value; }
function pageQuery(input: Record<string, unknown>): string {
  const search = new URLSearchParams();
  if (input.limit !== undefined) { if (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100) throw new Error("Invalid limit"); search.set("limit", String(input.limit)); }
  if (input.cursor !== undefined) { if (typeof input.cursor !== "string" || !/^\d{1,10}$/.test(input.cursor)) throw new Error("Invalid cursor"); search.set("cursor", input.cursor); }
  return search.size ? `?${search.toString()}` : "";
}

export function registerStage4dIpc({ ipc, fetchWithUi, getAdmin, secrets }: { ipc: Registrar; fetchWithUi: FetchWithUi; getAdmin: () => CoreAdminClient; secrets: ImageProviderSecretStore }): void {
  ipc.handle("provider-image-config:list", async (_event, value) => {
    const input = asRecord(value, ["project_id"], "image provider config list");
    return parseImageProviderConfigPage(rendererSafe(await fetchWithUi(`/api/v1/projects/${asId(input.project_id, "project_id")}/image-provider-configs`)));
  });
  ipc.handle("provider-image-config:create", async (_event, value) => {
    const input = asRecord(value, ["project_id", "config"], "image provider config create");
    const config = parseImageProviderConfigCreateInput(input.config);
    return parseImageProviderConfigSummary(rendererSafe(await fetchWithUi(`/api/v1/projects/${asId(input.project_id, "project_id")}/image-provider-configs`, { method: "POST", body: JSON.stringify(config) })));
  });
  ipc.handle("provider-image-config:set-secret", async (_event, value) => {
    const input = asRecord(value, ["provider_config_id", "secret"], "image provider credential");
    const providerConfigId = asId(input.provider_config_id, "provider_config_id");
    await saveImageProviderSecret(secrets, getAdmin(), providerConfigId, asSecret(input.secret));
    return { provider_config_id: providerConfigId, credential_status: "configured" };
  });
  ipc.handle("provider-image-config:delete-secret", async (_event, value) => {
    const providerConfigId = asId(value, "provider_config_id");
    await removeImageProviderSecret(secrets, getAdmin(), providerConfigId);
    return { provider_config_id: providerConfigId, credential_status: "missing" };
  });
  ipc.handle("provider-image-generation:prepare", async (_event, value) => {
    const input = asRecord(value, ["project_id", "request"], "provider image prepare");
    const request = parseProviderImageGenerationPrepareInput(input.request);
    return parseProviderImageGenerationPreparedPreview(rendererSafe(await fetchWithUi(`/api/v1/projects/${asId(input.project_id, "project_id")}/provider-image-generations/prepare`, { method: "POST", body: JSON.stringify(request) })));
  });
  ipc.handle("provider-image-generation:create", async (_event, value) => {
    const input = asRecord(value, ["project_id", "request"], "provider image create");
    const request = parseProviderImageGenerationCreateInput(input.request);
    return parseProviderImageGenerationCreateResponse(rendererSafe(await fetchWithUi(`/api/v1/projects/${asId(input.project_id, "project_id")}/provider-image-generations`, { method: "POST", body: JSON.stringify(request) })));
  });
  ipc.handle("provider-image-generation:list", async (_event, value) => {
    const input = asRecord(value, ["project_id", "limit", "cursor"], "provider image list");
    const projectId = asId(input.project_id, "project_id");
    return parseProviderImageGenerationRequestPage(rendererSafe(await fetchWithUi(`/api/v1/projects/${projectId}/provider-image-generations${pageQuery(input)}`)));
  });
  ipc.handle("provider-image-generation:get", async (_event, value) => parseProviderImageGenerationRequest(rendererSafe(await fetchWithUi(`/api/v1/provider-image-generations/${asId(value, "request_id")}`))));
  ipc.handle("provider-image-generation:tasks", async (_event, value) => {
    const input = asRecord(value, ["request_id", "limit", "cursor"], "provider image tasks");
    const requestId = asId(input.request_id, "request_id");
    return parseProviderImageGenerationTaskPage(rendererSafe(await fetchWithUi(`/api/v1/provider-image-generations/${requestId}/tasks${pageQuery(input)}`)));
  });
  ipc.handle("provider-image-generation:retry-prepare", async (_event, value) => {
    const input = asRecord(value, ["task_id", "request"], "provider image retry prepare");
    const request = parseProviderImageGenerationRetryPrepareInput(input.request);
    return parseProviderImageGenerationPreparedPreview(rendererSafe(await fetchWithUi(`/api/v1/provider-image-generation-tasks/${asId(input.task_id, "task_id")}/retry/prepare`, { method: "POST", body: JSON.stringify(request) })));
  });
  ipc.handle("provider-image-generation:retry", async (_event, value) => {
    const input = asRecord(value, ["task_id", "request"], "provider image retry");
    const request = parseProviderImageGenerationCreateInput(input.request);
    return parseProviderImageGenerationTask(rendererSafe(await fetchWithUi(`/api/v1/provider-image-generation-tasks/${asId(input.task_id, "task_id")}/retry`, { method: "POST", body: JSON.stringify(request) })));
  });
  ipc.handle("provider-image-generation:cancel", async (_event, value) => parseProviderImageGenerationTask(rendererSafe(await fetchWithUi(`/api/v1/provider-image-generation-tasks/${asId(value, "task_id")}/cancel`, { method: "POST", body: JSON.stringify({}) }))));
}