import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { CoreAdminClient, CoreHttpError } from "./core-admin-client.js";
import { EditorLoadLeaseHeartbeat, makeWindowOwnerId, type EditorLoadMode } from "./editor-load-lease.js";
import { ProviderSecretStore, reinjectProviderSecrets, removeProviderSecret, saveProviderSecret } from "./provider-secrets.js";
import { ImageProviderSecretStore, reinjectImageProviderSecrets } from "./image-provider-secrets.js";
import { issueCandidateClipMedia } from "./candidate-media.js";
import { registerStage2aIpc } from "./stage2a-ipc.js";
import { registerStage2bIpc } from "./stage2b-ipc.js";
import { registerStage3bIpc } from "./stage3b-ipc.js";
import { registerStage4Ipc } from "./stage4-ipc.js";
import { registerStage4cIpc } from "./stage4c-ipc.js";
import { registerStage4dIpc } from "./stage4d-ipc.js";
import { registerStage4eIpc } from "./stage4e-ipc.js";
import { registerStage5Ipc } from "./stage5-ipc.js";
import { registerStage6rIpc } from "./stage6r-ipc.js";
import { registerPerformanceIpc } from "./performance-ipc.js";
import { registerFileGrant } from "./file-grants.js";
import { exportFileName, normalizeExportPath } from "./export-destination.js";
import { defaultLogPath, appendLog, redact } from "./logging.js";
import { SidecarSupervisor } from "./sidecar-supervisor.js";
import { RESTRICTED_MEDIA_SCHEME, RestrictedMediaRegistry, serveRestrictedMedia } from "./restricted-media.js";
import { probeActive, probeLoadQuery, registerProbeIpc, type ProbeIpcHandle } from "./probe-ipc.js";
import { normalizeJob } from "../../src/lib/core-client.js";
import {
  isApiErrorResponse,
  isAssetKind,
  parseModelDetail,
  parseModelSummary,
  parseTranscript,
  parseTranscriptSummary,
  isPage,
  isAuthoritativePreview,
  isExportRecord,
  parsePreviewCreateInput,
  parsePreviewCreateResponse,
  parseExportCreateInput,
  parseExportCreateResponse,
  parseRenditionPreviewCreateInput,
  parseRenditionPreviewCreateResponse,
  parseExportBatchCreateInput,
  parseExportBatchCreateResponse,
  parseExportBatch,
  parseExportBatchRetryInput,
  parseExportBatchRetryResponse,
  isPlatformPreset,
  isRenditionPreset,
  isRenditionPreview,
  isExportBatch,
  parseRenderArtifact,
  type Asset,
  type AssetKind,
  type ArtifactId,
  type GrantId,
  type Job,
  type JobId,
  type MediaInfo,
  type ModelId,
  type ModelSummary,
  type ProjectId,
  type TranscriptId
  , type TimelineCreateInput
  , type TimelineDraftInput
  , type TimelinePatch
  , type TimelineRevisionId
  , type AuthoritativePreview
  , type ExportRecord
  , type PreviewCreateInput
  , type ExportCreateInput
  , type RenderArtifactId
  , type RenditionPreview
  , type RenditionPreviewCreateInput
  , type ExportBatchCreateInput
  , type ExportBatchRetryInput
  , type ExportBatchId
  , type RenditionReframePreview
} from "@aivideo/contracts";

protocol.registerSchemesAsPrivileged([{
  scheme: RESTRICTED_MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}]);

let windowRef: BrowserWindow | undefined;
let supervisor: SidecarSupervisor | undefined;
let core: CoreAdminClient | undefined;
let runtime: { base_url: string; ui_token: string; protocol_version: 1 } | undefined;
// B16b：编辑器负载 lease 心跳（Core 就绪后 1s 自重调度；停止即 TTL 过期）
let editorLease: EditorLoadLeaseHeartbeat | undefined;
let editorLeaseIpc: { handle(channel: string, listener: (_event: unknown, mode?: unknown) => unknown): void } | null = null;
const restrictedMedia = new RestrictedMediaRegistry();
let probeIpc: ProbeIpcHandle | null = null;
let logPath = "";
let providerSecrets: ProviderSecretStore | undefined;
let imageProviderSecrets: ImageProviderSecretStore | undefined;
// Acquire the lock before startup work so duplicate launches cannot race with
// window creation or sidecar startup.
const hasSingleInstanceLock = !app.isPackaged || app.requestSingleInstanceLock();
let resolveRuntime: ((value: NonNullable<typeof runtime>) => void) | undefined;
const runtimeReady = new Promise<NonNullable<typeof runtime>>(resolve => {
  resolveRuntime = resolve;
});

if (app.isPackaged && !hasSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (windowRef && !windowRef.isDestroyed()) {
    if (windowRef.isMinimized()) windowRef.restore();
    windowRef.focus();
  }
});

process.on("uncaughtException", error => {
  void appendLog(logPath || join(app.getPath("userData"), "logs", "desktop.log"), `uncaughtException: ${error.stack ?? error.message}`);
});
process.on("unhandledRejection", reason => {
  void appendLog(logPath || join(app.getPath("userData"), "logs", "desktop.log"), `unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`).catch(() => undefined);
});
function requireCore(): CoreAdminClient {
  if (!core) throw new Error("Core is not ready");
  return core;
}

/** B13：Renderer 资源档位（离散——不暴露 totalmem 等主机信息；
 *  8GiB/未知 → conservative，>16GiB → high，其余 balanced）。 */
function resourceTier(): "conservative" | "balanced" | "high" {
  const totalMiB = totalmem() / (1024 * 1024);
  if (!Number.isFinite(totalMiB) || totalMiB <= 0) return "conservative";
  if (totalMiB <= 8 * 1024) return "conservative";
  if (totalMiB > 16 * 1024) return "high";
  return "balanced";
}

function rendererRuntime(): { protocol_version: 1; status: "ready"; resource_tier: "conservative" | "balanced" | "high"; force_copy_to?: boolean } {
  // B13-R 判别诊断开关：仅诊断构建（VITE_AIVS_PERF=1 编译期已对 Renderer
  // 生效）+ 显式环境变量时下发；正常构建无此字段，行为不变。
  const forceCopyTo = process.env.AIVS_FORCE_COPYTO === "1";
  return {
    protocol_version: 1,
    status: "ready",
    resource_tier: resourceTier(),
    ...(forceCopyTo ? { force_copy_to: true } : {}),
  };
}

/** Core admin resolve 的瞬时抖动重试（F04 100 素材复测暴露：reload 后批量
 *  restrictedMediaUrl 扇出期间 Core 偶发拒连，失败被 assetPresentation 折叠成
 *  media_url=null 且无重试通道——缺票永久化，合成预览回退无法自动恢复）。
 *  连接级失败 3 次退避（0/300/900ms）；CoreHttpError 的域错误
 *  （ASSET_MISSING/ASSET_CHANGED 等）语义明确，立即上抛不重试。 */
async function resolveAssetWithRetry(assetId: string): Promise<{ path: string }> {
  const delays = [0, 300, 900];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try { return await requireCore().resolveAsset(assetId); } catch (error) {
      lastError = error;
      if (error instanceof CoreHttpError) throw error;
    }
  }
  throw lastError;
}

async function restrictedMediaUrl(assetId: string): Promise<string> {
  if (!restrictedMedia.registeredPath(assetId)) {
    const resolved = await resolveAssetWithRetry(assetId);
    restrictedMedia.register(assetId, resolved.path, "asset");
  }
  return restrictedMedia.issue(assetId, "asset");
}

async function artifactMediaUrl(artifactId: string): Promise<string> {
  if (!restrictedMedia.registeredPath(artifactId, "artifact")) {
    const resolved = await requireCore().resolveArtifact(artifactId);
    restrictedMedia.register(artifactId, resolved.path, "artifact");
  }
  return restrictedMedia.issue(artifactId, "artifact");
}

async function previewPresentation(preview: AuthoritativePreview) {
  return { preview, media_url: await artifactMediaUrl(preview.render_artifact_id) };
}

async function exportPresentation(exportRecord: ExportRecord) {
  // 单个导出的产物文件若已缺失/损坏，不应让整个导出列表失败：降级为 media_url=null。
  try { return { export_record: exportRecord, media_url: await artifactMediaUrl(exportRecord.render_artifact_id) }; }
  catch { return { export_record: exportRecord, media_url: null }; }
}
async function renditionPreviewPresentation(preview: RenditionPreview) {
  return { preview, media_url: await artifactMediaUrl(preview.render_artifact_id) };
}
async function renditionReframePreviewPresentation(preview: RenditionReframePreview) {
  return { preview, media_url: await artifactMediaUrl(preview.render_artifact_id) };
}

async function assetPresentation(asset: Asset): Promise<{ asset: Asset; media_url: string | null }> {
  if (asset.availability !== "available" || (asset.kind !== "video" && asset.kind !== "image" && asset.kind !== "audio")) return { asset, media_url: null };
  try { return { asset, media_url: await restrictedMediaUrl(asset.asset_id) }; }
  catch (error) {
    // 静默折叠前落日志：缺票在现场无从定位（F04 100 素材复测），域错误与
    // 连接失败分开留痕。media_url=null 的折叠语义不变（列表 resilience）。
    void appendLog(logPath, `asset presentation resolve failed asset=[redacted] error=${error instanceof Error ? error.message : String(error)}`);
    return { asset, media_url: null };
  }
}

/** 有界并发映射：asset 呈现等扇出此前用 Promise.all 一次性打出整页请求
 *  （F04 reload 后 100 个素材的 restrictedMedia 注册全部失效，瞬时 100 个
 *  admin resolve 请求 → 本地 Core 连接被瞬时打满，后续 manifest 请求
 *  ECONNREFUSED，间歇但真实）。限并发后单批 ≤8，语义与顺序无关。 */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

const rendererSensitiveKeys = new Set([
  "path", "uri", "root_dir", "database", "database_path", "admin_token", "ui_token", "token", "authorization",
  "installed_path", "install_dir", "source_file", "model_path", "model_dir", "runtime_dir", "ready_file"
]);
function rendererSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rendererSafe);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (!rendererSensitiveKeys.has(key)) result[key] = rendererSafe(item);
  return result;
}

function modelSummary(value: unknown): ModelSummary { return parseModelSummary(rendererSafe(value)); }
function modelDetail(value: unknown) { return parseModelDetail(rendererSafe(value)); }
function transcript(value: unknown) { return parseTranscript(rendererSafe(value)); }
function transcriptSummary(value: unknown) { return parseTranscriptSummary(rendererSafe(value)); }
function rendererHealth(value: Awaited<ReturnType<CoreAdminClient["health"]>>): Awaited<ReturnType<CoreAdminClient["health"]>> {
  return {
    status: value.status,
    protocol_version: value.protocol_version,
    build_version: value.build_version,
    ...(typeof value.scheduler === "string" && !/[\\/]|(?:file|https?):\/\//i.test(value.scheduler) ? { scheduler: value.scheduler } : {})
  };
}

function envAssetPath(kind: AssetKind | undefined): string | undefined {
  const raw = process.env.AIVS_E2E_ASSET_PATHS;
  if (!raw || !kind) return undefined;
  try {
    const paths = JSON.parse(raw) as Record<string, unknown>;
    return typeof paths[kind] === "string" ? paths[kind] : undefined;
  } catch {
    return undefined;
  }
}

async function chooseAssetPath(kind?: AssetKind, title = "选择素材", relocate = false): Promise<string | null> {
  const configured = relocate
    ? process.env.AIVS_E2E_RELOCATE_PATH
    : envAssetPath(kind) ?? (kind === undefined ? process.env.AIVS_E2E_MEDIA_PATH : undefined);
  if (configured) return configured;
  const extensions = kind === "video" ? ["mp4", "mov", "mkv", "webm", "avi"]
    : kind === "audio" ? ["wav", "mp3", "m4a", "aac", "flac"]
      : kind === "image" ? ["png", "jpg", "jpeg", "webp"]
        : kind === "text" ? ["txt", "srt", "vtt"]
          : ["mp4", "mov", "mkv", "webm", "avi", "wav", "mp3", "m4a", "aac", "flac", "png", "jpg", "jpeg", "webp", "txt", "srt", "vtt"];
  const result = await dialog.showOpenDialog(windowRef!, { title, properties: ["openFile"], filters: [{ name: "素材", extensions }] });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

function asId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
async function createWindow(): Promise<void> {
  await appendLog(logPath, `createWindow renderer=${process.env.ELECTRON_RENDERER_URL ?? "file"}`);
  try {
    windowRef = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    title: "Vortex Cut",
    autoHideMenuBar: true,
    // 参考 dsh-desktop 的原生外框处理（Window Controls Overlay）：
    // 系统绘制右上角原生最小化/最大化/关闭按钮，网页内容仍填充标题栏区域。
    // overlay 高度与 .editor-titlebar 的 36px 对齐。
    titleBarStyle: process.platform === "darwin"
      ? "hiddenInset"
      : process.platform === "win32" ? "hidden" : "default",
    titleBarOverlay: process.platform === "win32"
      ? { color: "#00000000", symbolColor: "#e6eaec", height: 36 }
      : undefined,
    show: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // 编辑器预览不被遮挡节流：截图工具遮罩/半覆盖窗口时 Occlusion 追踪会把
      // rAF 节流到 ~0——合成画面冻结而音频照播，恢复后时钟狂奔（丢帧风暴 +
      // 音频硬校正）。预览应用必须持续渲染。
      backgroundThrottling: false
    }
    });
    await appendLog(logPath, "BrowserWindow created");
  } catch (error) {
    await appendLog(logPath, `BrowserWindow creation failed: ${String(error)}`);
    throw error;
  }
  windowRef.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  windowRef.webContents.on("will-navigate", event => event.preventDefault());
  windowRef.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("[preload-error RAW]", preloadPath, error);
    void appendLog(logPath, `preload error path=${preloadPath} error=${error.stack ?? error.message}`);
  });
  windowRef.webContents.on("render-process-gone", (_event, details) => {
    probeIpc?.noteRenderGone();
    void appendLog(logPath, `render process gone reason=${details.reason} exit=${details.exitCode}`);
  });
  windowRef.webContents.on("did-finish-load", () => { void appendLog(logPath, "renderer did-finish-load"); });
  windowRef.once("ready-to-show", () => { void appendLog(logPath, "window ready-to-show"); });
  // 最小化/最大化/关闭改由系统 caption 按钮处理（titleBarOverlay），
  // 不再向渲染进程转发 maximize 状态；菜单栏整体隐藏（参考 dsh-desktop）。
  if (process.platform === "win32") windowRef.setMenuBarVisibility(false);
  windowRef.webContents.on("did-fail-load", (_event, code, description, url) => {
    void appendLog(logPath, `renderer load failed code=${code} description=${description} url=${url}`);
  });
  // M3-0 探针：dev-only 采集渲染进程 console（探针无 stdout，错误经此落日志）。
  if (probeActive()) {
    windowRef.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      void appendLog(logPath, `renderer console[level=${level}] ${message} @${sourceId}:${line}`);
    });
  }
  windowRef.on("closed", () => { void appendLog(logPath, "window closed"); windowRef = undefined; });
  // M3-0 探针：仅 dev + AIVS_M3_PROBE 时向加载 URL 追加 ?probe=<名>（§7.1 第 1 层）。
  const probeQuery = probeLoadQuery();
  const load = process.env.ELECTRON_RENDERER_URL
    ? windowRef.loadURL(process.env.ELECTRON_RENDERER_URL + probeQuery)
    : windowRef.loadFile(join(__dirname, "../renderer/index.html"));
  void load.then(() => appendLog(logPath, "window loaded")).catch(error => appendLog(logPath, `window load error: ${String(error)}`));
}

function registerIpc(): void {
  ipcMain.handle("runtime:get", async () => {
    if (runtime) return rendererRuntime();
    await Promise.race([
      runtimeReady,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Core UI session startup timed out")), 30_000))
    ]);
    return rendererRuntime();
  });
  // B16b：Renderer 推送编辑器负载（playing/scrubbing/idle；转换即时 +
  // 1s 保活——Main 侧 lease 心跳消费）。Renderer 崩溃 = 无推送 = 心跳
  // 维持最后值（Core TTL 兜底过期回 idle）。
  editorLeaseIpc = { handle: (channel, listener) => ipcMain.handle(channel, listener) };
  ipcMain.handle("editor-load:update", (_event, mode: unknown) => {
    if (mode !== "playing" && mode !== "scrubbing" && mode !== "idle") {
      throw new Error("Invalid editor load mode");
    }
    editorLease?.updateMode(mode as EditorLoadMode);
    return { status: "ok" };
  });
  ipcMain.handle("diagnostics:get", async () => rendererHealth(await requireCore().health()));
  ipcMain.handle("media:choose", async () => {
    const selectedPath = await chooseAssetPath(undefined, "选择媒体");
    if (!selectedPath) return null;
    const grant = await registerFileGrant(requireCore(), selectedPath);
    const media = await fetchWithUi<MediaInfo>("/api/v1/media/probe", { method: "POST", body: JSON.stringify({ grant_id: grant.grant_id }) });
    return { grant, media };
  });
  ipcMain.handle("media:probe", (_event, grantId: GrantId) => fetchWithUi<MediaInfo>("/api/v1/media/probe", { method: "POST", body: JSON.stringify({ grant_id: asId(grantId, "grant_id") }) }));

  ipcMain.handle("project:list", (_event, params: { status?: string; limit?: number; cursor?: string } = {}) => fetchWithUi(`${API_PREFIX}/projects${buildQuery(params)}`));
  ipcMain.handle("project:create", (_event, input: { name: string; root_dir_name?: string }) => {
    if (typeof input?.name !== "string") throw new Error("Project name is required");
    return fetchWithUi(`${API_PREFIX}/projects`, { method: "POST", body: JSON.stringify(input) });
  });
  ipcMain.handle("project:get", (_event, projectId: ProjectId) => fetchWithUi(`${API_PREFIX}/projects/${asId(projectId, "project_id")}`));
  ipcMain.handle("project:rename", (_event, input: { project_id: ProjectId; name: string }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}`, { method: "PATCH", body: JSON.stringify({ name: input.name }) }));
  ipcMain.handle("project:archive", (_event, projectId: ProjectId) => fetchWithUi(`${API_PREFIX}/projects/${asId(projectId, "project_id")}/archive`, { method: "POST" }));
  ipcMain.handle("project:reopen", (_event, projectId: ProjectId) => fetchWithUi(`${API_PREFIX}/projects/${asId(projectId, "project_id")}/reopen`, { method: "POST" }));

  ipcMain.handle("asset:list", async (_event, input: { project_id: ProjectId; availability?: string; limit?: number; cursor?: string }) => {
    const page = await fetchWithUi<{ items: Asset[]; next_cursor: string | null }>(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/assets${buildQuery(input, ["project_id"])}`);
    return { next_cursor: page.next_cursor, items: await mapLimited(page.items, 8, assetPresentation) };
  });
  ipcMain.handle("asset:import", async (_event, input: { project_id: ProjectId; kind?: AssetKind }) => {
    const projectId = asId(input.project_id, "project_id") as ProjectId;
    if (input.kind !== undefined && !isAssetKind(input.kind)) throw new Error("Invalid asset kind");
    const selectedPath = await chooseAssetPath(input.kind, "导入素材");
    if (!selectedPath) return null;
    const grant = await registerFileGrant(requireCore(), selectedPath);
    const asset = await fetchWithUi<Asset>(`${API_PREFIX}/projects/${projectId}/assets`, { method: "POST", body: JSON.stringify({ grant_id: grant.grant_id, ...(input.kind ? { kind: input.kind } : {}) }) });
    restrictedMedia.register(asset.asset_id, selectedPath);
    return { grant, asset, media_url: await restrictedMediaUrl(asset.asset_id) };
  });
  ipcMain.handle("asset:refresh", async (_event, assetId: string) => {
    const asset = await fetchWithUi<Asset>(`${API_PREFIX}/assets/${asId(assetId, "asset_id")}/refresh`, { method: "POST" });
    return await assetPresentation(asset);
  });
  // E2E-only multi-asset import: selects from an explicit benchmark fixture map
  // (AIVS_E2E_ASSET_PATHS_LIST = {"F07.mp4": "...", ...}) instead of a dialog.
  // Outside benchmark runs the env is unset and every call fails closed — the
  // requested name must be a plain fixture file name, no paths/wildcards.
  ipcMain.handle("asset:import-fixture", async (_event, input: { project_id: ProjectId; fixture_file: string }) => {
    const projectId = asId(input.project_id, "project_id") as ProjectId;
    const raw = process.env.AIVS_E2E_ASSET_PATHS_LIST;
    let selectedPath: string | undefined;
    if (raw) {
      try {
        const paths = JSON.parse(raw) as Record<string, unknown>;
        const candidate = paths[input.fixture_file];
        if (typeof candidate === "string") selectedPath = candidate;
      } catch { /* fall through: invalid env selects nothing */ }
    }
    if (!selectedPath || !/^[A-Za-z0-9._-]+\.mp4$/.test(input.fixture_file)) throw new Error("Unknown fixture file");
    const grant = await registerFileGrant(requireCore(), selectedPath);
    const asset = await fetchWithUi<Asset>(`${API_PREFIX}/projects/${projectId}/assets`, { method: "POST", body: JSON.stringify({ grant_id: grant.grant_id, kind: "video" }) });
    restrictedMedia.register(asset.asset_id, selectedPath);
    return { grant, asset, media_url: await restrictedMediaUrl(asset.asset_id) };
  });
  ipcMain.handle("asset:relocate", async (_event, input: { asset_id: string }) => {
    const assetId = asId(input.asset_id, "asset_id");
    const selectedPath = await chooseAssetPath(undefined, "重新定位素材", true);
    if (!selectedPath) return null;
    const grant = await registerFileGrant(requireCore(), selectedPath);
    const asset = await fetchWithUi<Asset>(`${API_PREFIX}/assets/${assetId}/relocate`, { method: "POST", body: JSON.stringify({ grant_id: grant.grant_id }) });
    restrictedMedia.register(asset.asset_id, selectedPath);
    return { grant, asset, media_url: await restrictedMediaUrl(asset.asset_id) };
  });

  // 打开素材所在文件夹；文件缺失时弹框提供 重新定位 / 移除 的恢复路径。
  ipcMain.handle("asset:reveal", async (_event, assetIdValue: string) => {
    const assetId = asId(assetIdValue, "asset_id");
    const resolved = await requireCore().resolveAsset(assetId);
    try {
      await access(resolved.path);
    } catch {
      const box = await dialog.showMessageBox(windowRef!, {
        type: "warning",
        title: "素材文件不存在",
        message: "素材文件不存在，可能已被移动或删除。",
        detail: resolved.path,
        buttons: ["重新定位", "移除素材", "取消"],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });
      if (box.response === 0) {
        const selectedPath = await chooseAssetPath(undefined, "重新定位素材", true);
        if (!selectedPath) return { status: "cancelled" as const };
        const grant = await registerFileGrant(requireCore(), selectedPath);
        const asset = await fetchWithUi<Asset>(`${API_PREFIX}/assets/${assetId}/relocate`, { method: "POST", body: JSON.stringify({ grant_id: grant.grant_id }) });
        restrictedMedia.register(asset.asset_id, selectedPath);
        return { status: "relocated" as const };
      }
      if (box.response === 1) {
        try {
          await fetchWithUi(`${API_PREFIX}/assets/${assetId}`, { method: "DELETE" });
          return { status: "deleted" as const };
        } catch {
          await dialog.showMessageBox(windowRef!, {
            type: "warning",
            title: "无法移除素材",
            message: "素材仍被时间线引用，无法直接移除。请先在时间线中删除相关片段。",
            buttons: ["确定"],
            noLink: true
          });
          return { status: "cancelled" as const };
        }
      }
      return { status: "cancelled" as const };
    }
    shell.showItemInFolder(resolved.path);
    return { status: "opened" as const };
  });

  // 素材删除：remove_timeline_clips=true 时 Core 级联删除时间线相关片段，
  // 返回清理计数；默认模式下仍引用时返回 409（ASSET_IN_USE）。
  ipcMain.handle("asset:delete", async (_event, input: { asset_id: string; remove_timeline_clips?: boolean }) => {
    const assetId = asId(input.asset_id, "asset_id");
    const query = input.remove_timeline_clips ? "?remove_timeline_clips=true" : "";
    return await fetchWithUi<{ removed_clips: number; removed_captions: number }>(`${API_PREFIX}/assets/${assetId}${query}`, { method: "DELETE" });
  });

  // 本地字幕导入：弹文件框（SRT/ASS/SSA/LRC）读取文本内容返回给渲染进程
  // 解析（不走 Core 资产库——字幕文件不作为媒体素材管理）。
  ipcMain.handle("subtitle:import", async () => {
    const result = await dialog.showOpenDialog(windowRef!, {
      title: "导入本地字幕",
      properties: ["openFile"],
      filters: [{ name: "Subtitle files", extensions: ["srt", "ass", "ssa", "lrc"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const fileName = filePath.split(/[\\/]/).pop() ?? "subtitle";
    const content = await readFile(filePath, "utf8");
    return { file_name: fileName, content };
  });

  ipcMain.handle("job:list", async (_event, input: { project_id: ProjectId; status?: string; limit?: number; cursor?: string }) => {
    const page = await fetchWithUi<{ items: unknown[]; next_cursor: string | null }>(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/jobs${buildQuery(input, ["project_id"])}`);
    return { next_cursor: page.next_cursor, items: page.items.map(normalizeJob) };
  });
  ipcMain.handle("job:create", async (_event, input: { project_id: ProjectId; media_id: string; kind: string; encoder_mode?: string; start_us?: number; duration_us?: number; layout?: string }) => {
    const projectId = asId(input.project_id, "project_id") as ProjectId;
    if (input.kind !== "proxy" && input.kind !== "portrait_sample") throw new Error("Invalid job kind");
    const mediaId = asId(input.media_id, "media_id");
    const path = input.kind === "proxy" ? "/api/v1/jobs/proxy" : "/api/v1/jobs/vertical-sample";
    const body = input.kind === "proxy"
      ? { media_id: mediaId, project_id: projectId, encoder_mode: input.encoder_mode ?? "auto" }
      : { media_id: mediaId, project_id: projectId, encoder_mode: input.encoder_mode ?? "auto", start_us: input.start_us ?? 0, duration_us: input.duration_us ?? 10_000_000, layout: input.layout ?? "blurred_background" };
    return fetchWithUi<unknown>(path, { method: "POST", body: JSON.stringify(body) }).then(normalizeJob);
  });
  ipcMain.handle("job:get", (_event, jobId: JobId) => fetchWithUi<unknown>(`/api/v1/jobs/${asId(jobId, "job_id")}`).then(normalizeJob));
  ipcMain.handle("job:cancel", (_event, jobId: JobId) => fetchWithUi<unknown>(`/api/v1/jobs/${asId(jobId, "job_id")}/cancel`, { method: "POST" }).then(normalizeJob));

  ipcMain.handle("model:list", async (_event, params: { status?: string; limit?: number; cursor?: string } = {}) => {
    const page = await fetchWithUi<{ items: unknown[]; next_cursor: string | null }>(`${API_PREFIX}/models${buildQuery(params)}`);
    return { next_cursor: page.next_cursor ?? null, items: page.items.map(modelSummary) };
  });
  ipcMain.handle("model:get", (_event, modelId: ModelId) => fetchWithUi<unknown>(`${API_PREFIX}/models/${encodeURIComponent(asId(modelId, "model_id"))}`).then(modelDetail));
  ipcMain.handle("model:download", async (_event, input: { model_id: ModelId; license_acceptance: string | null }) => {
    const modelId = asId(input.model_id, "model_id");
    if (!(input.license_acceptance === null || typeof input.license_acceptance === "string")) throw new Error("Invalid license acceptance");
    const result = await fetchWithUi<{ model: unknown; job: unknown }>(`${API_PREFIX}/models/${encodeURIComponent(modelId)}/download`, {
      method: "POST", body: JSON.stringify({ license_acceptance: input.license_acceptance })
    });
    return { model: modelDetail(result.model), job: normalizeJob(result.job) };
  });
  ipcMain.handle("model:download-status", async (_event, modelId: ModelId) => {
    const result = await fetchWithUi<{ model: unknown; job: unknown | null }>(`${API_PREFIX}/models/${encodeURIComponent(asId(modelId, "model_id"))}/download`);
    return { model: modelDetail(result.model), job: result.job === null ? null : normalizeJob(result.job) };
  });
  ipcMain.handle("model:cancel", async (_event, modelId: ModelId) => {
    const result = await fetchWithUi<{ model: unknown; job: unknown }>(`${API_PREFIX}/models/${encodeURIComponent(asId(modelId, "model_id"))}/cancel`, { method: "POST" });
    return { model: modelDetail(result.model), job: normalizeJob(result.job) };
  });
  ipcMain.handle("transcription:create", async (_event, input: { asset_id: string; model_id: string; language: string; word_timestamps: boolean; license_acceptance: string | null }) => {
    const assetId = asId(input.asset_id, "asset_id");
    const modelId = asId(input.model_id, "model_id");
    if (typeof input.language !== "string" || input.language.length === 0 || typeof input.word_timestamps !== "boolean" || !(input.license_acceptance === null || typeof input.license_acceptance === "string")) throw new Error("Invalid transcription input");
    const result = await fetchWithUi<{ job: unknown; transcript: unknown | null }>(`${API_PREFIX}/assets/${encodeURIComponent(assetId)}/transcription`, {
      method: "POST", body: JSON.stringify({ model_id: modelId, language: input.language, word_timestamps: input.word_timestamps, license_acceptance: input.license_acceptance })
    });
    return { job: normalizeJob(result.job), transcript: result.transcript === null ? null : transcript(result.transcript) };
  });
  ipcMain.handle("transcription:list", async (_event, assetId: string) => {
    const page = await fetchWithUi<{ items: unknown[]; next_cursor: string | null }>(`${API_PREFIX}/assets/${encodeURIComponent(asId(assetId, "asset_id"))}/transcription`);
    return { next_cursor: page.next_cursor ?? null, items: page.items.map(transcriptSummary) };
  });
  ipcMain.handle("transcript:get", (_event, transcriptId: TranscriptId) => fetchWithUi<unknown>(`${API_PREFIX}/transcriptions/${encodeURIComponent(asId(transcriptId, "transcript_id"))}`).then(transcript));
  registerStage2aIpc({
    handle: ipcMain.handle.bind(ipcMain),
    fetchWithUi,
    saveSecret: async (providerConfigId, secret) => {
      providerSecrets ??= new ProviderSecretStore(app.getPath("userData"));
      await saveProviderSecret(providerSecrets, requireCore(), providerConfigId, secret);
    },
    deleteSecret: async providerConfigId => {
      providerSecrets ??= new ProviderSecretStore(app.getPath("userData"));
      await removeProviderSecret(providerSecrets, requireCore(), providerConfigId);
    },
    issueCandidateClipMedia,
    candidateMediaDependencies: {
      fetchPlan: candidatePlanId => fetchWithUi(`${API_PREFIX}/candidate-plans/${encodeURIComponent(candidatePlanId)}`),
      listProjectAssets: projectId => fetchWithUi(`${API_PREFIX}/projects/${projectId}/assets?limit=100`),
      issueAssetTicket: restrictedMediaUrl
    }
  });
  registerStage2bIpc({ handle: (channel, listener) => ipcMain.handle(channel, listener), fetchWithUi });
  ipcMain.handle("timeline:create", (_event, input: { project_id: ProjectId; timeline: TimelineCreateInput }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/timelines`, { method: "POST", body: JSON.stringify(input.timeline) }).then(rendererSafe));
  ipcMain.handle("timeline:get", (_event, projectId: ProjectId) => fetchWithUi(`${API_PREFIX}/projects/${asId(projectId, "project_id")}/timeline`).then(rendererSafe));
  ipcMain.handle("timeline:patch", (_event, input: { project_id: ProjectId; patch: TimelinePatch }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/timeline/patches`, { method: "POST", body: JSON.stringify(input.patch) }).then(rendererSafe));
  ipcMain.handle("timeline:undo", (_event, input: { project_id: ProjectId; base_revision_id: TimelineRevisionId }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/timeline/undo`, { method: "POST", body: JSON.stringify({ base_revision_id: asId(input.base_revision_id, "timeline_revision_id") }) }).then(rendererSafe));
  ipcMain.handle("timeline:redo", (_event, input: { project_id: ProjectId; base_revision_id: TimelineRevisionId }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/timeline/redo`, { method: "POST", body: JSON.stringify({ base_revision_id: asId(input.base_revision_id, "timeline_revision_id") }) }).then(rendererSafe));
  ipcMain.handle("timeline:draft-save", (_event, input: { project_id: ProjectId; draft: TimelineDraftInput }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/timeline/draft`, { method: "PUT", body: JSON.stringify(input.draft) }).then(rendererSafe));
  ipcMain.handle("timeline:draft-delete", async (_event, projectId: ProjectId) => { await fetchWithUi(`${API_PREFIX}/projects/${asId(projectId, "project_id")}/timeline/draft`, { method: "DELETE" }); });
  ipcMain.handle("timeline:revisions", (_event, input: { project_id: ProjectId; limit?: number; cursor?: string }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/timeline/revisions${buildQuery(input, ["project_id"])}`).then(rendererSafe));
  ipcMain.handle("timeline:revision", (_event, revisionId: TimelineRevisionId) => fetchWithUi(`${API_PREFIX}/timeline-revisions/${asId(revisionId, "timeline_revision_id")}`).then(rendererSafe));
  ipcMain.handle("preset:list-platforms", async () => {
    const page = rendererSafe(await fetchWithUi<{ items: unknown[] }>(`${API_PREFIX}/platform-presets`));
    if (!page || typeof page !== "object" || !Array.isArray((page as { items?: unknown[] }).items) || !(page as { items: unknown[] }).items.every(isPlatformPreset)) throw new Error("Invalid PlatformPresetPage");
    return page;
  });
  ipcMain.handle("preset:list-renditions", async () => {
    const page = rendererSafe(await fetchWithUi<{ items: unknown[] }>(`${API_PREFIX}/rendition-presets`));
    if (!page || typeof page !== "object" || !Array.isArray((page as { items?: unknown[] }).items) || !(page as { items: unknown[] }).items.every(isRenditionPreset)) throw new Error("Invalid RenditionPresetPage");
    return page;
  });
  ipcMain.handle("rendition-preview:create", async (_event, input: { project_id: ProjectId; preview: RenditionPreviewCreateInput }) => {
    const projectId = asId(input.project_id, "project_id");
    const request = parseRenditionPreviewCreateInput(input.preview);
    const response = parseRenditionPreviewCreateResponse(rendererSafe(await fetchWithUi(`${API_PREFIX}/projects/${projectId}/rendition-previews`, { method: "POST", body: JSON.stringify(request) })));
    return { ...response, preview: response.preview ? await renditionPreviewPresentation(response.preview) : null };
  });
  ipcMain.handle("rendition-preview:list", async (_event, input: { project_id: ProjectId; limit?: number; cursor?: string }) => {
    const page = rendererSafe(await fetchWithUi<{ items: unknown[]; next_cursor: string | null }>(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/rendition-previews${buildQuery(input, ["project_id"])}`));
    if (!page || typeof page !== "object" || !Array.isArray((page as { items?: unknown[] }).items) || !(page as { items: unknown[] }).items.every(isRenditionPreview)) throw new Error("Invalid RenditionPreviewPage");
    const typed = page as { items: RenditionPreview[]; next_cursor: string | null };
    return { next_cursor: typed.next_cursor ?? null, items: await Promise.all(typed.items.map(renditionPreviewPresentation)) };
  });
  ipcMain.handle("export:choose-directory", async (_event, projectIdValue: ProjectId) => {
    asId(projectIdValue, "project_id");
    const configured = process.env.AIVS_E2E_EXPORT_DIRECTORY;
    const selected = configured ? { canceled: false, filePaths: [configured] } : await dialog.showOpenDialog(windowRef!, { title: "选择导出目录", properties: ["openDirectory", "createDirectory"] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    return requireCore().createDirectoryGrant(selected.filePaths[0]);
  });
  ipcMain.handle("export-batch:create", async (_event, input: { project_id: ProjectId; batch: ExportBatchCreateInput }) => {
    const projectId = asId(input.project_id, "project_id");
    const response = parseExportBatchCreateResponse(rendererSafe(await fetchWithUi(`${API_PREFIX}/projects/${projectId}/export-batches`, { method: "POST", body: JSON.stringify(parseExportBatchCreateInput(input.batch)) })));
    return response;
  });
  ipcMain.handle("export-batch:get", async (_event, batchId: ExportBatchId) => parseExportBatch(rendererSafe(await fetchWithUi(`${API_PREFIX}/export-batches/${asId(batchId, "export_batch_id")}`))));
  ipcMain.handle("export-batch:list", async (_event, input: { project_id: ProjectId; limit?: number; cursor?: string }) => {
    const page = rendererSafe(await fetchWithUi<{ items: unknown[]; next_cursor: string | null }>(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/export-batches${buildQuery(input, ["project_id"])}`));
    if (!page || typeof page !== "object" || !Array.isArray((page as { items?: unknown[] }).items) || !(page as { items: unknown[] }).items.every(isExportBatch)) throw new Error("Invalid ExportBatchPage");
    return page;
  });
  ipcMain.handle("export-batch:cancel", async (_event, batchId: ExportBatchId) => parseExportBatch(rendererSafe(await fetchWithUi(`${API_PREFIX}/export-batches/${asId(batchId, "export_batch_id")}/cancel`, { method: "POST" }))));
  ipcMain.handle("export-batch:retry", async (_event, input: { batch_id: ExportBatchId; retry: ExportBatchRetryInput }) => parseExportBatchRetryResponse(rendererSafe(await fetchWithUi(`${API_PREFIX}/export-batches/${asId(input.batch_id, "export_batch_id")}/retry`, { method: "POST", body: JSON.stringify(parseExportBatchRetryInput(input.retry)) }))));
  registerStage3bIpc({ ipc: { handle: (channel, listener) => ipcMain.handle(channel, listener) }, fetchWithUi, previewPresentation: renditionReframePreviewPresentation });
  registerStage4Ipc({ ipc: { handle: (channel, listener) => ipcMain.handle(channel, listener) }, fetchWithUi });
  registerStage4cIpc({ ipc: { handle: (channel, listener) => ipcMain.handle(channel, listener) }, fetchWithUi });
  imageProviderSecrets ??= new ImageProviderSecretStore(app.getPath("userData"));
  registerStage4dIpc({ ipc: { handle: (channel, listener) => ipcMain.handle(channel, listener) }, fetchWithUi, getAdmin: requireCore, secrets: imageProviderSecrets });
  registerStage4eIpc({ ipc: { handle: (channel, listener) => ipcMain.handle(channel, listener) }, fetchWithUi });
  registerStage5Ipc({ ipc: { handle: (channel, listener) => ipcMain.handle(channel, listener) }, fetchWithUi });
  registerStage6rIpc({ ipc: { handle: (channel, listener) => ipcMain.handle(channel, listener) }, fetchWithUi });
  // B10：派生媒体 IPC + B11 preview-source IPC + B14 波形 IPC + B15 PCM 块
  // IPC——lookup/stats/描述/作业 (Renderer 可见) + media(admin resolve→票据)
  registerPerformanceIpc({
    ipc: { handle: (channel, listener) => ipcMain.handle(channel, listener) },
    fetchWithUi,
    resolveDerived: input => requireCore().resolveDerivedMedia(input),
    resolvePreviewSourceMedia: input => requireCore().resolvePreviewSourceMedia(input),
    resolveWaveformMedia: input => requireCore().resolveWaveformMedia(input),
    resolvePcmChunkMedia: input => requireCore().resolvePcmChunkMedia(input),
    registerDerivedMedia: (cacheKey, path) => {
      if (!restrictedMedia.registeredPath(cacheKey, "proxy")) {
        restrictedMedia.register(cacheKey, path, "proxy");
      }
      return restrictedMedia.issue(cacheKey, "proxy");
    },
  });
  ipcMain.handle("preview:create", async (_event, input: { project_id: ProjectId; preview: PreviewCreateInput }) => {
    const projectId = asId(input.project_id, "project_id");
    const request = parsePreviewCreateInput(input.preview);
    const response = parsePreviewCreateResponse(rendererSafe(await fetchWithUi(`${API_PREFIX}/projects/${projectId}/previews`, { method: "POST", body: JSON.stringify(request) })));
    return { ...response, preview: response.preview ? await previewPresentation(response.preview) : null };
  });
  ipcMain.handle("media:caption-font-url", async () => {
    const fontPath = resolve(
      app.isPackaged ? process.resourcesPath : resolve(__dirname, "../../../../resources"),
      "fonts", "noto-sans-sc", "NotoSansCJKsc-VF.ttf",
    );
    if (!restrictedMedia.registeredPath("caption-font")) {
      restrictedMedia.register("caption-font", fontPath, "asset");
    }
    return restrictedMedia.issue("caption-font", "asset");
  });
  // 多字体（M2-B4 扩展）：bundle v2 注册表 → 全部字体下发 ticket + 族名列表。
  // bundle.json 是静态资源（随 resources 分发），直接读文件。
  ipcMain.handle("media:caption-font-urls", async () => {
    const fontsRoot = resolve(
      app.isPackaged ? process.resourcesPath : resolve(__dirname, "../../../../resources"),
      "fonts",
    );
    const bundle = JSON.parse(await readFile(resolve(fontsRoot, "bundle.json"), "utf8")) as {
      fonts?: Array<{ family: string; file: string }>;
    };
    const fonts = Array.isArray(bundle.fonts) ? bundle.fonts : [];
    return fonts.map(font => {
      const key = `caption-font:${font.family}`;
      if (!restrictedMedia.registeredPath(key)) {
        restrictedMedia.register(key, resolve(fontsRoot, font.file), "asset");
      }
      return { family: font.family, media_url: restrictedMedia.issue(key, "asset") };
    });
  });
  ipcMain.handle("preview-ir:get", async (_event, input: { project_id: string; timeline_revision_id?: string | null; output_ratio?: string }) => {
    const params = new URLSearchParams();
    if (input?.timeline_revision_id) params.set("timeline_revision_id", input.timeline_revision_id);
    if (input?.output_ratio) params.set("output_ratio", input.output_ratio);
    const query = params.toString();
    // fetchWithUi 已把业务码以 "[CODE] message" 传入 message；渲染端
    // SyntheticPreview 据此匹配 PREVIEW_IR_UNSUPPORTED 走友好回退提示。
    return fetchWithUi(`${API_PREFIX}/projects/${asId(input?.project_id ?? "", "project_id")}/preview-ir${query ? `?${query}` : ""}`);
  });
  ipcMain.handle("preview:list", async (_event, input: { project_id: ProjectId; limit?: number; cursor?: string }) => {
    const page = rendererSafe(await fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/previews${buildQuery(input, ["project_id"])}`));
    if (!isPage(page, isAuthoritativePreview)) throw new Error("Invalid AuthoritativePreviewPage");
    return { next_cursor: page.next_cursor, items: await Promise.all(page.items.map(previewPresentation)) };
  });
  ipcMain.handle("export:choose-destination", async (_event, projectIdValue: ProjectId) => {
    const projectId = asId(projectIdValue, "project_id");
    const project = await fetchWithUi<{ name: string }>(`${API_PREFIX}/projects/${projectId}`);
    const configured = process.env.AIVS_E2E_EXPORT_PATH;
    const selected = configured ? { canceled: false, filePath: configured } : await dialog.showSaveDialog(windowRef!, {
      title: "导出视频",
      defaultPath: exportFileName(project.name),
      filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
      properties: ["showOverwriteConfirmation"]
    });
    if (selected.canceled || !selected.filePath) return null;
    const destinationPath = normalizeExportPath(selected.filePath);
    let overwriteAuthorized = false;
    try { await access(destinationPath); overwriteAuthorized = true; } catch { /* new destination */ }
    return requireCore().createDestinationGrant(destinationPath, overwriteAuthorized);
  });
  ipcMain.handle("export:create", async (_event, input: { project_id: ProjectId; export: ExportCreateInput }) => {
    const projectId = asId(input.project_id, "project_id");
    const request = parseExportCreateInput(input.export);
    const response = parseExportCreateResponse(rendererSafe(await fetchWithUi(`${API_PREFIX}/projects/${projectId}/exports`, { method: "POST", body: JSON.stringify(request) })));
    return { ...response, export_record: response.export_record ? await exportPresentation(response.export_record) : null };
  });
  ipcMain.handle("export:list", async (_event, input: { project_id: ProjectId; limit?: number; cursor?: string }) => {
    const page = rendererSafe(await fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/exports${buildQuery(input, ["project_id"])}`));
    if (!isPage(page, isExportRecord)) throw new Error("Invalid ExportRecordPage");
    return { next_cursor: page.next_cursor, items: await Promise.all(page.items.map(exportPresentation)) };
  });
  ipcMain.handle("render-artifact:get", async (_event, artifactIdValue: RenderArtifactId) => {
    const artifactId = asId(artifactIdValue, "render_artifact_id");
    const artifact = parseRenderArtifact(rendererSafe(await fetchWithUi(`${API_PREFIX}/render-artifacts/${artifactId}`)));
    return { artifact, media_url: await artifactMediaUrl(artifact.render_artifact_id) };
  });
  ipcMain.handle("artifact:open", async (_event, artifactId: ArtifactId) => {
    const result = await requireCore().resolveArtifact(asId(artifactId, "artifact_id"));
    await shell.openPath(result.path);
  });
  ipcMain.handle("artifact:folder", async (_event, artifactId: ArtifactId) => {
    const result = await requireCore().resolveArtifact(asId(artifactId, "artifact_id"));
    shell.showItemInFolder(result.path);
  });
}

async function fetchWithUi<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  if (!runtime) throw new Error("Runtime is not ready");
  const response = await fetch(`${runtime.base_url}${path}`, { ...init, headers: { Authorization: `Bearer ${runtime.ui_token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) } });
  let data: unknown = null;
  try { data = await response.json(); } catch { /* preserve HTTP status for empty responses */ }
  if (!response.ok) {
    const error = isApiErrorResponse(data) ? data.error : undefined;
    const code = error?.code ?? statusCode(response.status);
    // Electron IPC 只把 message 传给渲染端（自定义 .code 属性会被剥离）；
    // 这里把业务码前缀进 message，渲染端 errorCode() 提取后才能识别
    // TIMELINE_NOT_FOUND / PREVIEW_IR_UNSUPPORTED 等业务错误。
    throw new CoreHttpError(response.status, `[${code}] ${redact(error?.message ?? "Core request failed")}`, code, error?.trace_id);
  }
  return data as T;
}

const API_PREFIX = "/api/v1";

function buildQuery(input: Record<string, unknown>, omit: string[] = []): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (omit.includes(key) || value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const result = search.toString();
  return result ? `?${result}` : "";
}

function statusCode(status: number): string {
  if (status === 400) return "VALIDATION_ERROR";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  return "INTERNAL_ERROR";
}

async function waitForCoreHealth(client: CoreAdminClient, timeoutMs = 20_000): Promise<Awaited<ReturnType<CoreAdminClient["health"]>>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.ready();
      return await client.health();
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Core health check timed out: ${String(lastError)}`);
}

async function startRuntime(): Promise<void> {
  logPath = defaultLogPath(app.getPath("userData"));
  const adminToken = randomBytes(32).toString("hex");
  const resourcesPath = process.env.AIVS_RESOURCES_PATH
    ? resolve(process.env.AIVS_RESOURCES_PATH)
    : app.isPackaged
      ? process.resourcesPath
      : resolve(__dirname, "../../../../resources");
  const dataDir = join(app.getPath("userData"), "data-v2");
  await assertRuntimeResources(resourcesPath);
  await appendLog(logPath, `runtime resources=${resourcesPath} data=${dataDir}`);
  const runtimeDir = join(dataDir, "runtime", `${process.pid}-${randomBytes(8).toString("hex")}`);
  supervisor = new SidecarSupervisor({
    executable: process.env.AIVS_SIDECAR_EXECUTABLE ?? SidecarSupervisor.packagedExecutable(resourcesPath),
    executableArgs: parseExecutableArgs(process.env.AIVS_SIDECAR_EXECUTABLE_ARGS),
    resourcesPath, dataDir, runtimeDir, logPath,
    ffmpegPath: join(resourcesPath, "ffmpeg", "win-x64", "ffmpeg.exe"),
    ffprobePath: join(resourcesPath, "ffmpeg", "win-x64", "ffprobe.exe"),
    manifestDir: join(resourcesPath, "model-manifests"),
    buildVersion: app.getVersion(), adminToken,
    launchEvidencePath: process.env.AIVS_E2E_SIDECAR_ARGV_EVIDENCE,
    enableImageProviderNetwork: process.env.AIVS_ENABLE_IMAGE_PROVIDER_NETWORK === "true"
  });
  await appendLog(logPath, `starting sidecar resources=${resourcesPath}`);
  const ready = await supervisor.start();
  await appendLog(logPath, `sidecar ready pid=${ready.pid} port=${ready.port}`);
  core = new CoreAdminClient(`http://127.0.0.1:${ready.port}`, adminToken);
  await appendLog(logPath, `Core process ready pid=${ready.pid} port=${ready.port} build=${ready.build_version}`);
  await waitForCoreHealth(core);
  await appendLog(logPath, "Core public health ready");
  const session = await core.createSession();
  providerSecrets ??= new ProviderSecretStore(app.getPath("userData"));
  await reinjectProviderSecrets(providerSecrets, core);
  imageProviderSecrets ??= new ImageProviderSecretStore(app.getPath("userData"));
  await reinjectImageProviderSecrets(imageProviderSecrets, core);
  await appendLog(logPath, "Core session response received");
  // Do not publish a runtime until the per-sidecar UI session exists.  The
  // admin client remains Main-only; returning readiness while it was briefly
  // stored here let an eager renderer issue public requests with a token that
  // Core correctly rejects after session isolation is enabled.
  runtime = { base_url: `http://127.0.0.1:${ready.port}`, ui_token: session.token, protocol_version: 1 };
  resolveRuntime?.(runtime);
  // B16b：编辑器负载 lease 心跳（1s 自重调度；停止/崩溃 = Core TTL 过期
  // 回 idle——Renderer 崩溃不永久饿死后台任务）
  editorLease?.stop();
  editorLease = new EditorLoadLeaseHeartbeat({
    windowId: makeWindowOwnerId(),
    report: input => core!.reportEditorLoadLease(input),
    schedule: (delayMs, callback) => {
      const timer = setTimeout(() => callback(), delayMs);
      return () => clearTimeout(timer);
    },
  });
  editorLease.start();
  await appendLog(logPath, "Core UI session ready");
}

async function assertRuntimeResources(resourcesPath: string): Promise<void> {
  const required = [
    SidecarSupervisor.packagedExecutable(resourcesPath),
    join(resourcesPath, "ffmpeg", "win-x64", "ffmpeg.exe"),
    join(resourcesPath, "ffmpeg", "win-x64", "ffprobe.exe"),
    join(resourcesPath, "licenses", "THIRD_PARTY_NOTICES.txt"),
    join(resourcesPath, "model-manifests"),
    join(resourcesPath, "recipes"),
    join(resourcesPath, "platform-presets"),
    join(resourcesPath, "renditions")
  ];
  await Promise.all(required.map(path => access(path)));
  const manifests = await readdir(join(resourcesPath, "model-manifests"), { withFileTypes: true });
  if (!manifests.some(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))) {
    throw new Error("ASR model manifest is missing from packaged resources");
  }
  const recipes = await readdir(join(resourcesPath, "recipes"), { withFileTypes: true });
  if (!recipes.some(entry => entry.isFile() && entry.name === "manifest.json")) throw new Error("AI recipe manifest is missing from packaged resources");
  const platformPresets = await readdir(join(resourcesPath, "platform-presets"), { withFileTypes: true });
  const renditions = await readdir(join(resourcesPath, "renditions"), { withFileTypes: true });
  if (!platformPresets.some(entry => entry.isFile() && entry.name === "manifest.json") || !renditions.some(entry => entry.isFile() && entry.name === "manifest.json")) throw new Error("Stage 3A preset manifest is missing from packaged resources");
}

function parseExecutableArgs(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function shutdownRuntime(): Promise<void> {
  // B16b：心跳停止 → Core TTL 3s 过期回 idle（不显式上报）
  editorLease?.stop();
  editorLease = undefined;
  try { await core?.shutdown(); } catch { /* Core may already be down. */ }
  await supervisor?.stop();
  runtime = undefined;
  core = undefined;
}

app.whenReady().then(async () => {
  logPath = defaultLogPath(app.getPath("userData"));
  await appendLog(logPath, "app ready").catch(() => undefined);
  if (app.isPackaged && !hasSingleInstanceLock) {
    await appendLog(logPath || join(app.getPath("userData"), "logs", "desktop.log"), "single instance lock unavailable").catch(() => undefined);
    app.quit();
    return;
  }
  protocol.handle(RESTRICTED_MEDIA_SCHEME, request => serveRestrictedMedia(request, restrictedMedia));
  probeIpc = registerProbeIpc({ registry: restrictedMedia });
  registerIpc();
  try {
    await createWindow();
    void startRuntime().catch(async error => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      await appendLog(logPath, `runtime startup failed after window: ${message}`).catch(() => undefined);
      if (windowRef && !windowRef.isDestroyed()) {
        windowRef.webContents.send("runtime:error", redact(message));
      }
    });
  }
  catch (error) {
    await appendLog(logPath || join(app.getPath("userData"), "logs", "desktop.log"), String(error)).catch(() => undefined);
    await shutdownRuntime().catch(() => undefined);
    await dialog.showErrorBox("Vortex Cut 启动失败", "本地核心服务未能启动，请查看日志目录。");
    app.exit(1);
  }
}).catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  void appendLog(logPath || join(app.getPath("userData"), "logs", "desktop.log"), `startup failure: ${message}`).catch(() => undefined);
  if (windowRef && !windowRef.isDestroyed()) {
    dialog.showErrorBox("Vortex Cut 启动失败", message);
  }
  app.exit(1);
});
app.on("window-all-closed", () => {
  void appendLog(logPath, "window-all-closed");
  if (process.platform === "darwin") return;
  // On Windows the window closing is the natural shutdown signal. route it
  // through the same guarded before-quit path so shutdownRuntime runs exactly
  // once and the sidecar is torn down before the process exits.
  if (!shuttingDown) app.quit();
});
app.on("quit", (_event, code) => { void appendLog(logPath, `app quit code=${code}`); });
app.on("before-quit", () => { void appendLog(logPath, "before-quit event"); });
app.on("will-quit", () => { void appendLog(logPath, "will-quit event"); });
let shuttingDown = false;
app.on("before-quit", event => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void appendLog(logPath, "shutdown started").catch(() => undefined);
  void shutdownRuntime().finally(() => app.exit(0));
});
