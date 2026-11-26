import {
  isReframeExportBatch,
  isRenditionReframePreview,
  parseReframeExportBatch,
  parseReframeExportBatchCreateInput,
  parseReframeExportBatchCreateResponse,
  parseReframeExportBatchRetryInput,
  parseReframeExportBatchRetryResponse,
  parseRenditionReframePreviewCreateInput,
  parseRenditionReframePreviewCreateResponse,
  type ReframeExportBatchId,
  type RenditionReframePreview
} from "@aivideo/contracts";

type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
type Registrar = { handle(channel: string, listener: Handler): void };
type FetchWithUi = (path: string, init?: RequestInit) => Promise<unknown>;
type PreviewPresentation = (preview: RenditionReframePreview) => Promise<{ preview: RenditionReframePreview; media_url: string }>;

const sensitiveKeys = new Set(["path", "uri", "root_dir", "database", "database_path", "admin_token", "ui_token", "token", "authorization", "request", "payload", "raw_response", "stderr", "command"]);

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

function asId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
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

export function registerReframeExportIpc({ ipc, fetchWithUi, previewPresentation }: { ipc: Registrar; fetchWithUi: FetchWithUi; previewPresentation: PreviewPresentation }): void {
  ipc.handle("reframe-preview:create", async (_event, value) => {
    const input = asRecord(value, ["project_id", "preview"], "reframe preview request");
    const projectId = asId(input.project_id, "project_id");
    const request = parseRenditionReframePreviewCreateInput(input.preview);
    const response = parseRenditionReframePreviewCreateResponse(rendererSafe(await fetchWithUi(`/api/v1/projects/${projectId}/rendition-reframe-previews`, { method: "POST", body: JSON.stringify(request) })));
    return { ...response, preview: response.preview ? await previewPresentation(response.preview) : null };
  });
  ipc.handle("reframe-preview:list", async (_event, value) => {
    const input = asRecord(value, ["project_id", "limit", "cursor"], "reframe preview list request");
    const projectId = asId(input.project_id, "project_id");
    const page = rendererSafe(await fetchWithUi(`/api/v1/projects/${projectId}/rendition-reframe-previews${pageQuery(input)}`));
    if (!page || typeof page !== "object" || !Array.isArray((page as { items?: unknown[] }).items) || !(page as { items: unknown[] }).items.every(isRenditionReframePreview)) throw new Error("Invalid RenditionReframePreviewPage");
    const typed = page as { items: RenditionReframePreview[]; next_cursor?: unknown };
    if (typed.next_cursor !== null && typed.next_cursor !== undefined && (typeof typed.next_cursor !== "string" || !/^\d{1,10}$/.test(typed.next_cursor))) throw new Error("Invalid RenditionReframePreviewPage");
    return { next_cursor: typed.next_cursor ?? null, items: await Promise.all(typed.items.map(previewPresentation)) };
  });
  ipc.handle("reframe-export-batch:create", async (_event, value) => {
    const input = asRecord(value, ["project_id", "batch"], "reframe export batch request");
    const projectId = asId(input.project_id, "project_id");
    return parseReframeExportBatchCreateResponse(rendererSafe(await fetchWithUi(`/api/v1/projects/${projectId}/reframe-export-batches`, { method: "POST", body: JSON.stringify(parseReframeExportBatchCreateInput(input.batch)) })));
  });
  ipc.handle("reframe-export-batch:get", async (_event, batchId) => parseReframeExportBatch(rendererSafe(await fetchWithUi(`/api/v1/reframe-export-batches/${asId(batchId as ReframeExportBatchId, "reframe_export_batch_id")}`))));
  ipc.handle("reframe-export-batch:list", async (_event, value) => {
    const input = asRecord(value, ["project_id", "limit", "cursor"], "reframe export batch list request");
    const projectId = asId(input.project_id, "project_id");
    const page = rendererSafe(await fetchWithUi(`/api/v1/projects/${projectId}/reframe-export-batches${pageQuery(input)}`));
    if (!page || typeof page !== "object" || !Array.isArray((page as { items?: unknown[] }).items) || !(page as { items: unknown[] }).items.every(isReframeExportBatch)) throw new Error("Invalid ReframeExportBatchPage");
    const typed = page as { items: unknown[]; next_cursor?: unknown };
    if (typed.next_cursor !== null && typed.next_cursor !== undefined && (typeof typed.next_cursor !== "string" || !/^\d{1,10}$/.test(typed.next_cursor))) throw new Error("Invalid ReframeExportBatchPage");
    return { items: typed.items, next_cursor: typed.next_cursor ?? null };
  });
  ipc.handle("reframe-export-batch:cancel", async (_event, batchId) => parseReframeExportBatch(rendererSafe(await fetchWithUi(`/api/v1/reframe-export-batches/${asId(batchId as ReframeExportBatchId, "reframe_export_batch_id")}/cancel`, { method: "POST" }))));
  ipc.handle("reframe-export-batch:retry", async (_event, value) => {
    const input = asRecord(value, ["batch_id", "retry"], "reframe export batch retry request");
    const batchId = asId(input.batch_id, "reframe_export_batch_id");
    return parseReframeExportBatchRetryResponse(rendererSafe(await fetchWithUi(`/api/v1/reframe-export-batches/${batchId}/retry`, { method: "POST", body: JSON.stringify(parseReframeExportBatchRetryInput(input.retry)) })));
  });
}
