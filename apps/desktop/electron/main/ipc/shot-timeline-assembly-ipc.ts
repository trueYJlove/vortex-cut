import {
  parseShotRequirementTimelineAssembly,
  parseShotRequirementTimelineAssemblyApplyInput,
  parseShotRequirementTimelineAssemblyApplyResponse,
  parseShotRequirementTimelineAssemblyPage,
  parseShotRequirementTimelineAssemblyPrepareInput,
  parseShotRequirementTimelineAssemblyPreview,
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
  "STAGE5_REQUIREMENT_NOT_ELIGIBLE", "STAGE5_ADOPTION_CONFLICT", "STAGE5_ASSET_UNAVAILABLE",
  "STAGE5_TIMELINE_REQUIRED", "STAGE5_TIMELINE_CONFLICT", "STAGE5_TIMELINE_DRAFT_EXISTS",
  "STAGE5_DURATION_CONFIRMATION_REQUIRED", "STAGE5_DURATION_INVALID", "STAGE5_POSITION_INVALID",
  "STAGE5_LOCKED_SHIFT", "STAGE5_PREVIEW_EXPIRED", "STAGE5_PREVIEW_MISMATCH",
  "STAGE5_CONFIRMATION_REQUIRED", "STAGE5_ALREADY_ASSEMBLED", "STAGE5_ASSEMBLY_NOT_FOUND",
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
function identity(input: Record<string, unknown>): { projectId: string; requirementId: string } {
  return {
    projectId: asId(input.project_id, "project_id"),
    requirementId: asId(input.requirement_id, "requirement_id"),
  };
}
function basePath(input: Record<string, unknown>): string {
  const { projectId, requirementId } = identity(input);
  return `/api/v1/projects/${projectId}/shot-requirements/${requirementId}/timeline-assemblies`;
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

export function registerShotTimelineAssemblyIpc({ ipc, fetchWithUi }: {
  ipc: Registrar;
  fetchWithUi: FetchWithUi;
}): void {
  const fetchSafe = (path: string, init?: RequestInit) =>
    safeInvoke(() => fetchWithUi(path, init));

  ipc.handle("stage5:assembly-prepare", async (_event, value) => {
    const input = asRecord(value, ["project_id", "requirement_id", "request"], "assembly prepare");
    const request = parseShotRequirementTimelineAssemblyPrepareInput(input.request);
    return parseShotRequirementTimelineAssemblyPreview(rendererSafe(await fetchSafe(
      `${basePath(input)}/prepare`, { method: "POST", body: JSON.stringify(request) },
    )));
  });
  ipc.handle("stage5:assembly-apply", async (_event, value) => {
    const input = asRecord(value, ["project_id", "requirement_id", "request"], "assembly apply");
    const request = parseShotRequirementTimelineAssemblyApplyInput(input.request);
    return parseShotRequirementTimelineAssemblyApplyResponse(rendererSafe(await fetchSafe(
      basePath(input), { method: "POST", body: JSON.stringify(request) },
    )));
  });
  ipc.handle("stage5:assembly-preview-get", async (_event, value) => {
    const input = asRecord(value, ["preview_id"], "assembly preview get");
    const previewId = asId(input.preview_id, "preview_id");
    return parseShotRequirementTimelineAssemblyPreview(rendererSafe(await fetchSafe(
      `/api/v1/shot-requirement-timeline-assembly-previews/${previewId}`,
    )));
  });
  ipc.handle("stage5:assembly-get", async (_event, value) => {
    const input = asRecord(value, ["assembly_id"], "assembly get");
    const assemblyId = asId(input.assembly_id, "assembly_id");
    return parseShotRequirementTimelineAssembly(rendererSafe(await fetchSafe(
      `/api/v1/shot-requirement-timeline-assemblies/${assemblyId}`,
    )));
  });
  ipc.handle("stage5:assembly-list", async (_event, value) => {
    const input = asRecord(
      value, ["project_id", "requirement_id", "limit", "cursor"], "assembly list",
    );
    return parseShotRequirementTimelineAssemblyPage(rendererSafe(await fetchSafe(
      `${basePath(input)}${pageQuery(input)}`,
    )));
  });
}
