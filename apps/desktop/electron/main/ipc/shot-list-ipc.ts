import {
  parseShotListConfirmInput,
  parseShotListConfirmResponse,
  parseShotListRevisionCreateInput,
  parseShotListRevisionCreateResponse,
  parseShotListRevisionDetail,
  parseShotListRevisionPage,
  parseShotListState,
} from "@aivideo/contracts";
import { asId, asRecord } from "./shared.js";

type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
type Registrar = { handle(channel: string, listener: Handler): void };
type FetchWithUi = (path: string, init?: RequestInit) => Promise<unknown>;

const sensitiveKeys = new Set([
  "path", "uri", "absolute_path", "prompt", "transcript", "caption", "authorization",
  "api_key", "secret", "payload", "raw_exception", "raw_response", "stderr", "command", "traceback",
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

const rendererErrorCodes = new Set([
  "SHOT_LIST_NOT_FOUND", "SHOT_LIST_REVISION_NOT_FOUND", "SHOT_LIST_INVALID",
  "SHOT_LIST_CONFLICT", "SHOT_LIST_CONFIRMATION_CONFLICT",
]);

async function safeInvoke<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (typeof code === "string" && rendererErrorCodes.has(code)) throw new Error(code);
    throw new Error("Core request failed");
  }
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

export function registerShotListIpc({ ipc, fetchWithUi }: { ipc: Registrar; fetchWithUi: FetchWithUi }): void {
  const fetchSafe = (path: string, init?: RequestInit) => safeInvoke(() => fetchWithUi(path, init));
  ipc.handle("shot-list:get", async (_event, projectId) =>
    parseShotListState(rendererSafe(await fetchSafe(`/api/v1/projects/${asId(projectId, "project_id")}/shot-list`))));

  ipc.handle("shot-list:revisions", async (_event, value) => {
    const input = asRecord(value, ["project_id", "limit", "cursor"], "shot list revision page");
    const projectId = asId(input.project_id, "project_id");
    return parseShotListRevisionPage(rendererSafe(await fetchSafe(`/api/v1/projects/${projectId}/shot-list/revisions${pageQuery(input)}`)));
  });

  ipc.handle("shot-list:revision:get", async (_event, revisionId) =>
    parseShotListRevisionDetail(rendererSafe(await fetchSafe(`/api/v1/shot-list-revisions/${asId(revisionId, "shot_list_revision_id")}`))));

  ipc.handle("shot-list:revision:create", async (_event, value) => {
    const input = asRecord(value, ["project_id", "revision"], "shot list revision create");
    const projectId = asId(input.project_id, "project_id");
    const revision = parseShotListRevisionCreateInput(input.revision);
    return parseShotListRevisionCreateResponse(rendererSafe(await fetchSafe(`/api/v1/projects/${projectId}/shot-list/revisions`, {
      method: "POST", body: JSON.stringify(revision),
    })));
  });

  ipc.handle("shot-list:confirm", async (_event, value) => {
    const input = asRecord(value, ["project_id", "confirmation"], "shot list confirmation");
    const projectId = asId(input.project_id, "project_id");
    const confirmation = parseShotListConfirmInput(input.confirmation);
    return parseShotListConfirmResponse(rendererSafe(await fetchSafe(`/api/v1/projects/${projectId}/shot-list/confirm`, {
      method: "POST", body: JSON.stringify(confirmation),
    })));
  });
}
