import {
  parseShotRequirementTimelineBatchAssembly,
  parseShotRequirementTimelineBatchAssemblyApplyInput,
  parseShotRequirementTimelineBatchAssemblyApplyResponse,
  parseShotRequirementTimelineBatchAssemblyItemPage,
  parseShotRequirementTimelineBatchAssemblyPage,
  parseShotRequirementTimelineBatchAssemblyPrepareInput,
  parseShotRequirementTimelineBatchAssemblyPreview,
} from "@aivideo/contracts";

type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
type Registrar = { handle(channel: string, listener: Handler): void };
type FetchWithUi = (path: string, init?: RequestInit) => Promise<unknown>;

const sensitiveKeys = new Set([
  "path", "uri", "absolute_path", "prompt", "requirement", "visual_direction",
  "narration_text", "transcript", "caption", "authorization", "api_key", "secret",
  "payload", "raw_exception", "raw_response", "sse", "base64", "stderr", "command",
  "traceback", "document",
]);
const rendererErrorCodes = new Set([
  "STAGE6_BATCH_REQUEST_INVALID", "STAGE6_BATCH_SIZE_INVALID",
  "STAGE6_BATCH_REQUIREMENT_DUPLICATED", "STAGE6_BATCH_REQUIREMENT_NOT_ELIGIBLE",
  "STAGE6_BATCH_ADOPTION_CONFLICT", "STAGE6_BATCH_TIMELINE_REQUIRED",
  "STAGE6_BATCH_TIMELINE_CONFLICT", "STAGE6_BATCH_TIMELINE_DRAFT_EXISTS",
  "STAGE6_BATCH_ASSET_UNAVAILABLE", "STAGE6_BATCH_ALREADY_ASSEMBLED",
  "STAGE6_BATCH_POSITION_INVALID", "STAGE6_BATCH_DURATION_INVALID",
  "STAGE6_BATCH_PREVIEW_EXPIRED", "STAGE6_BATCH_PREVIEW_MISMATCH",
  "STAGE6_BATCH_CONFIRMATION_REQUIRED", "STAGE6_BATCH_NOT_FOUND",
]);

export function rendererSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rendererSafe);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!sensitiveKeys.has(key.toLowerCase())) result[key] = rendererSafe(item);
  }
  return result;
}
async function safeInvoke<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = error && typeof error === "object"
      ? (error as { code?: unknown }).code : undefined;
    if (typeof code === "string" && rendererErrorCodes.has(code)) throw new Error(code);
    throw new Error("Core request failed");
  }
}
function asRecord(value: unknown, allowed: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}
function asId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
function projectPath(input: Record<string, unknown>): string {
  return `/api/v1/projects/${asId(input.project_id, "project_id")}/shot-requirement-timeline-batch-assemblies`;
}
function pageQuery(input: Record<string, unknown>): string {
  const search = new URLSearchParams();
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || (input.limit as number) < 1
      || (input.limit as number) > 100) throw new Error("Invalid limit");
    search.set("limit", String(input.limit));
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || !/^\d{1,10}$/.test(input.cursor)) {
      throw new Error("Invalid cursor");
    }
    search.set("cursor", input.cursor);
  }
  return search.size ? `?${search.toString()}` : "";
}

export function registerShotTimelineBatchAssemblyIpc({ ipc, fetchWithUi }: {
  ipc: Registrar;
  fetchWithUi: FetchWithUi;
}): void {
  const fetchSafe = (path: string, init?: RequestInit) =>
    safeInvoke(() => fetchWithUi(path, init));

  ipc.handle("stage6r:batch-assembly-prepare", async (_event, value) => {
    const input = asRecord(value, ["project_id", "request"], "batch assembly prepare");
    const request = parseShotRequirementTimelineBatchAssemblyPrepareInput(input.request);
    return parseShotRequirementTimelineBatchAssemblyPreview(rendererSafe(await fetchSafe(
      `${projectPath(input)}/prepare`, { method: "POST", body: JSON.stringify(request) },
    )));
  });
  ipc.handle("stage6r:batch-assembly-apply", async (_event, value) => {
    const input = asRecord(value, ["project_id", "request"], "batch assembly apply");
    const request = parseShotRequirementTimelineBatchAssemblyApplyInput(input.request);
    return parseShotRequirementTimelineBatchAssemblyApplyResponse(rendererSafe(await fetchSafe(
      projectPath(input), { method: "POST", body: JSON.stringify(request) },
    )));
  });
  ipc.handle("stage6r:batch-assembly-preview-get", async (_event, value) => {
    const input = asRecord(value, ["preview_id"], "batch assembly preview get");
    const previewId = asId(input.preview_id, "preview_id");
    return parseShotRequirementTimelineBatchAssemblyPreview(rendererSafe(await fetchSafe(
      `/api/v1/shot-requirement-timeline-batch-assembly-previews/${previewId}`,
    )));
  });
  ipc.handle("stage6r:batch-assembly-get", async (_event, value) => {
    const input = asRecord(value, ["batch_id"], "batch assembly get");
    const batchId = asId(input.batch_id, "batch_id");
    return parseShotRequirementTimelineBatchAssembly(rendererSafe(await fetchSafe(
      `/api/v1/shot-requirement-timeline-batch-assemblies/${batchId}`,
    )));
  });
  ipc.handle("stage6r:batch-assembly-list", async (_event, value) => {
    const input = asRecord(
      value, ["project_id", "limit", "cursor"], "batch assembly list",
    );
    return parseShotRequirementTimelineBatchAssemblyPage(rendererSafe(await fetchSafe(
      `${projectPath(input)}${pageQuery(input)}`,
    )));
  });
  ipc.handle("stage6r:batch-assembly-item-list", async (_event, value) => {
    const input = asRecord(
      value, ["batch_id", "limit", "cursor"], "batch assembly item list",
    );
    const batchId = asId(input.batch_id, "batch_id");
    return parseShotRequirementTimelineBatchAssemblyItemPage(rendererSafe(await fetchSafe(
      `/api/v1/shot-requirement-timeline-batch-assemblies/${batchId}/items${pageQuery(input)}`,
    )));
  });
}
