import { dialog, shell, type BrowserWindow } from "electron";
import { access } from "node:fs/promises";
import {
  isAuthoritativePreview,
  isExportBatch,
  isExportRecord,
  isPage,
  isPlatformPreset,
  isRenditionPreset,
  isRenditionPreview,
  parseExportBatch,
  parseExportBatchCreateInput,
  parseExportBatchCreateResponse,
  parseExportBatchRetryInput,
  parseExportBatchRetryResponse,
  parseExportCreateInput,
  parseExportCreateResponse,
  parsePreviewCreateInput,
  parsePreviewCreateResponse,
  parseRenderArtifact,
  parseRenditionPreviewCreateInput,
  parseRenditionPreviewCreateResponse,
  type ArtifactId,
  type ExportBatchCreateInput,
  type ExportBatchId,
  type ExportBatchRetryInput,
  type ExportCreateInput,
  type PreviewCreateInput,
  type ProjectId,
  type RenderArtifactId,
  type RenditionPreview,
  type RenditionPreviewCreateInput,
} from "@aivideo/contracts";
import type { MediaPresentationService } from "../bootstrap/protocol.js";
import type { CoreAdminClient } from "../core-admin-client.js";
import { exportFileName, normalizeExportPath } from "../export-destination.js";
import { API_PREFIX, asId, buildQuery, rendererSafe, type FetchWithUi, type IpcHandle } from "./shared.js";

export interface PreviewExportIpcDependencies {
  handle: IpcHandle;
  fetchWithUi: FetchWithUi;
  requireCore: () => CoreAdminClient;
  mediaPresentation: MediaPresentationService;
  getWindow: () => BrowserWindow | undefined;
}

/** Register presets, preview/export records, destination grants, batch exports, and artifact open IPC handlers. */
export function registerPreviewExportIpc({
  handle,
  fetchWithUi,
  requireCore,
  mediaPresentation,
  getWindow,
}: PreviewExportIpcDependencies): void {
  handle("preset:list-platforms", async () => {
    const page = rendererSafe(await fetchWithUi<{ items: unknown[] }>(`${API_PREFIX}/platform-presets`));
    if (!page || typeof page !== "object" || !Array.isArray((page as { items?: unknown[] }).items) || !(page as { items: unknown[] }).items.every(isPlatformPreset)) throw new Error("Invalid PlatformPresetPage");
    return page;
  });
  handle("preset:list-renditions", async () => {
    const page = rendererSafe(await fetchWithUi<{ items: unknown[] }>(`${API_PREFIX}/rendition-presets`));
    if (!page || typeof page !== "object" || !Array.isArray((page as { items?: unknown[] }).items) || !(page as { items: unknown[] }).items.every(isRenditionPreset)) throw new Error("Invalid RenditionPresetPage");
    return page;
  });
  handle("rendition-preview:create", async (_event, input: { project_id: ProjectId; preview: RenditionPreviewCreateInput }) => {
    const projectId = asId(input.project_id, "project_id");
    const request = parseRenditionPreviewCreateInput(input.preview);
    const response = parseRenditionPreviewCreateResponse(rendererSafe(await fetchWithUi(`${API_PREFIX}/projects/${projectId}/rendition-previews`, { method: "POST", body: JSON.stringify(request) })));
    return { ...response, preview: response.preview ? await mediaPresentation.renditionPreviewPresentation(response.preview) : null };
  });
  handle("rendition-preview:list", async (_event, input: { project_id: ProjectId; limit?: number; cursor?: string }) => {
    const page = rendererSafe(await fetchWithUi<{ items: unknown[]; next_cursor: string | null }>(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/rendition-previews${buildQuery(input, ["project_id"])}`));
    if (!page || typeof page !== "object" || !Array.isArray((page as { items?: unknown[] }).items) || !(page as { items: unknown[] }).items.every(isRenditionPreview)) throw new Error("Invalid RenditionPreviewPage");
    const typed = page as { items: RenditionPreview[]; next_cursor: string | null };
    return { next_cursor: typed.next_cursor ?? null, items: await Promise.all(typed.items.map(mediaPresentation.renditionPreviewPresentation)) };
  });
  handle("export:choose-directory", async (_event, projectIdValue: ProjectId) => {
    asId(projectIdValue, "project_id");
    const configured = process.env.AIVS_E2E_EXPORT_DIRECTORY;
    const selected = configured ? { canceled: false, filePaths: [configured] } : await dialog.showOpenDialog(getWindow()!, { title: "选择导出目录", properties: ["openDirectory", "createDirectory"] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    return requireCore().createDirectoryGrant(selected.filePaths[0]);
  });
  handle("export-batch:create", async (_event, input: { project_id: ProjectId; batch: ExportBatchCreateInput }) => {
    const projectId = asId(input.project_id, "project_id");
    return parseExportBatchCreateResponse(rendererSafe(await fetchWithUi(`${API_PREFIX}/projects/${projectId}/export-batches`, { method: "POST", body: JSON.stringify(parseExportBatchCreateInput(input.batch)) })));
  });
  handle("export-batch:get", async (_event, batchId: ExportBatchId) => parseExportBatch(rendererSafe(await fetchWithUi(`${API_PREFIX}/export-batches/${asId(batchId, "export_batch_id")}`))));
  handle("export-batch:list", async (_event, input: { project_id: ProjectId; limit?: number; cursor?: string }) => {
    const page = rendererSafe(await fetchWithUi<{ items: unknown[]; next_cursor: string | null }>(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/export-batches${buildQuery(input, ["project_id"])}`));
    if (!page || typeof page !== "object" || !Array.isArray((page as { items?: unknown[] }).items) || !(page as { items: unknown[] }).items.every(isExportBatch)) throw new Error("Invalid ExportBatchPage");
    return page;
  });
  handle("export-batch:cancel", async (_event, batchId: ExportBatchId) => parseExportBatch(rendererSafe(await fetchWithUi(`${API_PREFIX}/export-batches/${asId(batchId, "export_batch_id")}/cancel`, { method: "POST" }))));
  handle("export-batch:retry", async (_event, input: { batch_id: ExportBatchId; retry: ExportBatchRetryInput }) => parseExportBatchRetryResponse(rendererSafe(await fetchWithUi(`${API_PREFIX}/export-batches/${asId(input.batch_id, "export_batch_id")}/retry`, { method: "POST", body: JSON.stringify(parseExportBatchRetryInput(input.retry)) }))));

  handle("preview:create", async (_event, input: { project_id: ProjectId; preview: PreviewCreateInput }) => {
    const projectId = asId(input.project_id, "project_id");
    const request = parsePreviewCreateInput(input.preview);
    const response = parsePreviewCreateResponse(rendererSafe(await fetchWithUi(`${API_PREFIX}/projects/${projectId}/previews`, { method: "POST", body: JSON.stringify(request) })));
    return { ...response, preview: response.preview ? await mediaPresentation.previewPresentation(response.preview) : null };
  });
  handle("preview-ir:get", async (_event, input: { project_id: string; timeline_revision_id?: string | null; output_ratio?: string }) => {
    const params = new URLSearchParams();
    if (input?.timeline_revision_id) params.set("timeline_revision_id", input.timeline_revision_id);
    if (input?.output_ratio) params.set("output_ratio", input.output_ratio);
    const query = params.toString();
    // fetchWithUi 已把业务码以 "[CODE] message" 传入 message；渲染端
    // SyntheticPreview 据此匹配 PREVIEW_IR_UNSUPPORTED 走友好回退提示。
    return fetchWithUi(`${API_PREFIX}/projects/${asId(input?.project_id ?? "", "project_id")}/preview-ir${query ? `?${query}` : ""}`);
  });
  handle("preview:list", async (_event, input: { project_id: ProjectId; limit?: number; cursor?: string }) => {
    const page = rendererSafe(await fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/previews${buildQuery(input, ["project_id"])}`));
    if (!isPage(page, isAuthoritativePreview)) throw new Error("Invalid AuthoritativePreviewPage");
    return { next_cursor: page.next_cursor, items: await Promise.all(page.items.map(mediaPresentation.previewPresentation)) };
  });
  handle("export:choose-destination", async (_event, projectIdValue: ProjectId, fileNameOverride?: string) => {
    const projectId = asId(projectIdValue, "project_id");
    const project = await fetchWithUi<{ name: string }>(`${API_PREFIX}/projects/${projectId}`);
    const configured = process.env.AIVS_E2E_EXPORT_PATH;
    const defaultName = fileNameOverride ? exportFileName(fileNameOverride) : exportFileName(project.name);
    const selected = configured ? { canceled: false, filePath: configured } : await dialog.showSaveDialog(getWindow()!, {
      title: "导出视频",
      defaultPath: defaultName,
      filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
      properties: ["showOverwriteConfirmation"],
    });
    if (selected.canceled || !selected.filePath) return null;
    const destinationPath = normalizeExportPath(selected.filePath);
    let overwriteAuthorized = false;
    try { await access(destinationPath); overwriteAuthorized = true; } catch { /* new destination */ }
    return requireCore().createDestinationGrant(destinationPath, overwriteAuthorized);
  });
  handle("export:rename-destination", async (_event, input: { grant_id: string; file_name: string }) => {
    return requireCore().renameDestinationGrant(asId(input.grant_id, "destination_grant_id"), input.file_name);
  });
  handle("export:create", async (_event, input: { project_id: ProjectId; export: ExportCreateInput }) => {
    const projectId = asId(input.project_id, "project_id");
    const request = parseExportCreateInput(input.export);
    const response = parseExportCreateResponse(rendererSafe(await fetchWithUi(`${API_PREFIX}/projects/${projectId}/exports`, { method: "POST", body: JSON.stringify(request) })));
    return { ...response, export_record: response.export_record ? await mediaPresentation.exportPresentation(response.export_record) : null };
  });
  handle("export:list", async (_event, input: { project_id: ProjectId; limit?: number; cursor?: string }) => {
    const page = rendererSafe(await fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/exports${buildQuery(input, ["project_id"])}`));
    if (!isPage(page, isExportRecord)) throw new Error("Invalid ExportRecordPage");
    return { next_cursor: page.next_cursor, items: await Promise.all(page.items.map(mediaPresentation.exportPresentation)) };
  });
  handle("export:delete-record", async (_event, input: { project_id: ProjectId; export_record_id: string }) => {
    // 移除文件已缺失的导出记录（Core 校验文件仍存在时拒绝）。
    await fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/exports/${asId(input.export_record_id, "export_record_id")}`, { method: "DELETE" });
  });
  handle("render-artifact:get", async (_event, artifactIdValue: RenderArtifactId) => {
    const artifactId = asId(artifactIdValue, "render_artifact_id");
    const artifact = parseRenderArtifact(rendererSafe(await fetchWithUi(`${API_PREFIX}/render-artifacts/${artifactId}`)));
    return { artifact, media_url: await mediaPresentation.artifactMediaUrl(artifact.render_artifact_id) };
  });
  handle("artifact:open", async (_event, artifactId: ArtifactId) => {
    const result = await requireCore().resolveArtifact(asId(artifactId, "artifact_id"));
    await shell.openPath(result.path);
  });
  handle("artifact:folder", async (_event, artifactId: ArtifactId) => {
    const result = await requireCore().resolveArtifact(asId(artifactId, "artifact_id"));
    shell.showItemInFolder(result.path);
  });
}
