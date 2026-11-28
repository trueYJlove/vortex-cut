import {
  parseMediaGenerationCreateInput,
  parseMediaGenerationCreateResponse,
  parseMediaGenerationPreparedRequest,
  parseMediaGenerationRequest,
  parseMediaGenerationRequestPage,
  parseMediaGenerationTask,
  parseMediaGenerationTaskPage,
  parseMediaGenerationPrepareInput
} from "@aivideo/contracts";
import { asId, asRecord } from "./shared.js";

type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
type Registrar = { handle(channel: string, listener: Handler): void };
type FetchWithUi = (path: string, init?: RequestInit) => Promise<unknown>;

const sensitiveKeys = new Set([
  "path", "absolute_path", "uri", "root_dir", "database", "database_path",
  "admin_token", "ui_token", "token", "authorization", "api_key", "secret",
  "prompt", "transcript", "caption", "payload", "raw_response",
  "stderr", "command", "traceback", "http_body", "request_body", "response_body",
  "system_message"
]);

function rendererSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rendererSafe);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!sensitiveKeys.has(key.toLowerCase())) result[key] = rendererSafe(item);
  }
  return result;
}

function pageQuery(input: Record<string, unknown>): string {
  const search = new URLSearchParams();
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100) throw new Error("Invalid limit");
    search.set("limit", String(input.limit));
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || !/^\d{1,10}$/.test(input.cursor)) throw new Error("Invalid cursor");
    search.set("cursor", input.cursor);
  }
  const result = search.toString();
  return result ? `?${result}` : "";
}

export function registerMediaGenerationIpc({ ipc, fetchWithUi }: { ipc: Registrar; fetchWithUi: FetchWithUi }): void {
  ipc.handle("media-generation:prepare", async (_event, value) => {
    const input = asRecord(value, ["project_id", "request"], "media generation prepare request");
    const projectId = asId(input.project_id, "project_id");
    const request = parseMediaGenerationPrepareInput(input.request);
    return parseMediaGenerationPreparedRequest(rendererSafe(await fetchWithUi(`/api/v1/projects/${projectId}/media-generation-requests/prepare`, {
      method: "POST", body: JSON.stringify(request)
    })));
  });
  ipc.handle("media-generation:create", async (_event, value) => {
    const input = asRecord(value, ["project_id", "request"], "media generation create request");
    const projectId = asId(input.project_id, "project_id");
    const request = parseMediaGenerationCreateInput(input.request);
    return parseMediaGenerationCreateResponse(rendererSafe(await fetchWithUi(`/api/v1/projects/${projectId}/media-generation-requests`, {
      method: "POST", body: JSON.stringify(request)
    })));
  });
  ipc.handle("media-generation:list", async (_event, value) => {
    const input = asRecord(value, ["project_id", "limit", "cursor"], "media generation request list");
    const projectId = asId(input.project_id, "project_id");
    return parseMediaGenerationRequestPage(rendererSafe(await fetchWithUi(`/api/v1/projects/${projectId}/media-generation-requests${pageQuery(input)}`)));
  });
  ipc.handle("media-generation:get", async (_event, requestId) =>
    parseMediaGenerationRequest(rendererSafe(await fetchWithUi(`/api/v1/media-generation-requests/${asId(requestId, "media_generation_request_id")}`))));
  ipc.handle("media-generation:tasks", async (_event, value) => {
    const input = asRecord(value, ["request_id", "limit", "cursor"], "media generation task list");
    const requestId = asId(input.request_id, "media_generation_request_id");
    return parseMediaGenerationTaskPage(rendererSafe(await fetchWithUi(`/api/v1/media-generation-requests/${requestId}/tasks${pageQuery(input)}`)));
  });
  ipc.handle("media-generation:retry", async (_event, taskId) =>
    parseMediaGenerationTask(rendererSafe(await fetchWithUi(`/api/v1/media-generation-tasks/${asId(taskId, "media_generation_task_id")}/retry`, {
      method: "POST", body: JSON.stringify({})
    }))));
  ipc.handle("media-generation:cancel", async (_event, taskId) =>
    parseMediaGenerationTask(rendererSafe(await fetchWithUi(`/api/v1/media-generation-tasks/${asId(taskId, "media_generation_task_id")}/cancel`, {
      method: "POST", body: JSON.stringify({})
    }))));
}
