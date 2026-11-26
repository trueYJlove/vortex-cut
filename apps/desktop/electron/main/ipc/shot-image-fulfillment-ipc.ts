import {
  parseShotRequirementImageAdoptInput,
  parseShotRequirementImageAdoptResponse,
  parseShotRequirementImageAdoptionPage,
  parseShotRequirementImageFulfillmentCreateInput,
  parseShotRequirementImageFulfillmentCreateResponse,
  parseShotRequirementImageFulfillmentPreparedPreview,
  parseShotRequirementImageFulfillmentPrepareInput,
  parseShotRequirementImageFulfillmentState,
  parseShotRequirementImageGenerationLinkPage,
} from "@aivideo/contracts";

type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
type Registrar = { handle(channel: string, listener: Handler): void };
type FetchWithUi = (path: string, init?: RequestInit) => Promise<unknown>;

const sensitiveKeys = new Set([
  "path", "uri", "absolute_path", "prompt", "visual_direction", "narration_text",
  "transcript", "caption", "authorization", "api_key", "secret", "payload",
  "raw_exception", "raw_response", "sse", "base64", "stderr", "command", "traceback",
]);
const rendererErrorCodes = new Set([
  "SHOT_REQUIREMENT_NOT_FOUND",
  "SHOT_REQUIREMENT_REVISION_CONFLICT",
  "SHOT_REQUIREMENT_IMAGE_INELIGIBLE",
  "SHOT_REQUIREMENT_IMAGE_CONFIRMATION_INVALID",
  "SHOT_REQUIREMENT_IMAGE_ADOPTION_INVALID",
  "SHOT_REQUIREMENT_IMAGE_ADOPTION_CONFLICT",
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
      ? (error as { code?: unknown }).code
      : undefined;
    if (typeof code === "string" && rendererErrorCodes.has(code)) throw new Error(code);
    throw new Error("Core request failed");
  }
}

function asRecord(
  value: unknown,
  allowedKeys: readonly string[],
  name: string,
): Record<string, unknown> {
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
function basePath(input: Record<string, unknown>): string {
  const projectId = asId(input.project_id, "project_id");
  const requirementId = asId(input.requirement_id, "requirement_id");
  return `/api/v1/projects/${projectId}/shot-requirements/${requirementId}/image-fulfillment`;
}

export function registerShotImageFulfillmentIpc({
  ipc,
  fetchWithUi,
}: {
  ipc: Registrar;
  fetchWithUi: FetchWithUi;
}): void {
  const fetchSafe = (path: string, init?: RequestInit) =>
    safeInvoke(() => fetchWithUi(path, init));

  ipc.handle("shot-requirement-image-fulfillment:get", async (_event, value) => {
    const input = asRecord(value, ["project_id", "requirement_id"], "fulfillment get");
    return parseShotRequirementImageFulfillmentState(
      rendererSafe(await fetchSafe(basePath(input))),
    );
  });
  ipc.handle("shot-requirement-image-fulfillment:list-links", async (_event, value) => {
    const input = asRecord(
      value,
      ["project_id", "requirement_id", "limit", "cursor"],
      "fulfillment link page",
    );
    return parseShotRequirementImageGenerationLinkPage(
      rendererSafe(await fetchSafe(`${basePath(input)}/links${pageQuery(input)}`)),
    );
  });
  ipc.handle("shot-requirement-image-fulfillment:list-adoptions", async (_event, value) => {
    const input = asRecord(
      value,
      ["project_id", "requirement_id", "limit", "cursor"],
      "fulfillment adoption page",
    );
    return parseShotRequirementImageAdoptionPage(
      rendererSafe(await fetchSafe(`${basePath(input)}/adoptions${pageQuery(input)}`)),
    );
  });
  ipc.handle("shot-requirement-image-fulfillment:prepare", async (_event, value) => {
    const input = asRecord(
      value,
      ["project_id", "requirement_id", "request"],
      "fulfillment prepare",
    );
    const request = parseShotRequirementImageFulfillmentPrepareInput(input.request);
    return parseShotRequirementImageFulfillmentPreparedPreview(
      rendererSafe(await fetchSafe(`${basePath(input)}/prepare`, {
        method: "POST",
        body: JSON.stringify(request),
      })),
    );
  });
  ipc.handle("shot-requirement-image-fulfillment:create", async (_event, value) => {
    const input = asRecord(
      value,
      ["project_id", "requirement_id", "request"],
      "fulfillment create",
    );
    const request = parseShotRequirementImageFulfillmentCreateInput(input.request);
    return parseShotRequirementImageFulfillmentCreateResponse(
      rendererSafe(await fetchSafe(`${basePath(input)}/create`, {
        method: "POST",
        body: JSON.stringify(request),
      })),
    );
  });
  ipc.handle("shot-requirement-image-fulfillment:adopt", async (_event, value) => {
    const input = asRecord(
      value,
      ["project_id", "requirement_id", "request"],
      "fulfillment adopt",
    );
    const request = parseShotRequirementImageAdoptInput(input.request);
    return parseShotRequirementImageAdoptResponse(
      rendererSafe(await fetchSafe(`${basePath(input)}/adopt`, {
        method: "POST",
        body: JSON.stringify(request),
      })),
    );
  });
}