import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { CoreAdminClient, CoreHttpError } from "./core-admin-client.js";
import { registerFileGrant } from "./file-grants.js";
import { defaultLogPath, appendLog } from "./logging.js";
import { SidecarSupervisor } from "./sidecar-supervisor.js";
import { assetIdFromRestrictedUrl, RESTRICTED_MEDIA_SCHEME, RestrictedMediaRegistry } from "./restricted-media.js";
import { normalizeJob } from "../../src/lib/core-client.js";
import { isApiErrorResponse, isAssetKind, type Asset, type AssetKind, type ArtifactId, type GrantId, type Job, type JobId, type MediaInfo, type ProjectId } from "@aivideo/contracts";

protocol.registerSchemesAsPrivileged([{
  scheme: RESTRICTED_MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}]);

let windowRef: BrowserWindow | undefined;
let supervisor: SidecarSupervisor | undefined;
let core: CoreAdminClient | undefined;
let runtime: { base_url: string; ui_token: string; protocol_version: 1 } | undefined;
const restrictedMedia = new RestrictedMediaRegistry();
let logPath = "";
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

function rendererRuntime(): { protocol_version: 1; status: "ready" } {
  return { protocol_version: 1, status: "ready" };
}

function restrictedMediaUrl(assetId: string): string {
  return restrictedMedia.url(assetId);
}

function assetPresentation(asset: Asset): { asset: Asset; media_url: string } {
  return { asset, media_url: restrictedMediaUrl(asset.asset_id) };
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
    show: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
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
    void appendLog(logPath, `preload error path=${preloadPath} error=${error.stack ?? error.message}`);
  });
  windowRef.webContents.on("render-process-gone", (_event, details) => {
    void appendLog(logPath, `render process gone reason=${details.reason} exit=${details.exitCode}`);
  });
  windowRef.webContents.on("did-finish-load", () => { void appendLog(logPath, "renderer did-finish-load"); });
  windowRef.once("ready-to-show", () => { void appendLog(logPath, "window ready-to-show"); });
  windowRef.webContents.on("did-fail-load", (_event, code, description, url) => {
    void appendLog(logPath, `renderer load failed code=${code} description=${description} url=${url}`);
  });
  windowRef.on("closed", () => { void appendLog(logPath, "window closed"); windowRef = undefined; });
  const load = process.env.ELECTRON_RENDERER_URL
    ? windowRef.loadURL(process.env.ELECTRON_RENDERER_URL)
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
  ipcMain.handle("diagnostics:get", () => requireCore().health());
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
    return { next_cursor: page.next_cursor, items: page.items.map(assetPresentation) };
  });
  ipcMain.handle("asset:import", async (_event, input: { project_id: ProjectId; kind?: AssetKind }) => {
    const projectId = asId(input.project_id, "project_id") as ProjectId;
    if (input.kind !== undefined && !isAssetKind(input.kind)) throw new Error("Invalid asset kind");
    const selectedPath = await chooseAssetPath(input.kind, "导入素材");
    if (!selectedPath) return null;
    const grant = await registerFileGrant(requireCore(), selectedPath);
    const asset = await fetchWithUi<Asset>(`${API_PREFIX}/projects/${projectId}/assets`, { method: "POST", body: JSON.stringify({ grant_id: grant.grant_id, ...(input.kind ? { kind: input.kind } : {}) }) });
    restrictedMedia.register(asset.asset_id, selectedPath);
    return { grant, asset, media_url: restrictedMediaUrl(asset.asset_id) };
  });
  ipcMain.handle("asset:refresh", async (_event, assetId: string) => {
    const asset = await fetchWithUi<Asset>(`${API_PREFIX}/assets/${asId(assetId, "asset_id")}/refresh`, { method: "POST" });
    return assetPresentation(asset);
  });
  ipcMain.handle("asset:relocate", async (_event, input: { asset_id: string }) => {
    const assetId = asId(input.asset_id, "asset_id");
    const selectedPath = await chooseAssetPath(undefined, "重新定位素材", true);
    if (!selectedPath) return null;
    const grant = await registerFileGrant(requireCore(), selectedPath);
    const asset = await fetchWithUi<Asset>(`${API_PREFIX}/assets/${assetId}/relocate`, { method: "POST", body: JSON.stringify({ grant_id: grant.grant_id }) });
    restrictedMedia.register(asset.asset_id, selectedPath);
    return { grant, asset, media_url: restrictedMediaUrl(asset.asset_id) };
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
  ipcMain.handle("artifact:resolve", (_event, artifactId: ArtifactId) => requireCore().resolveArtifact(asId(artifactId, "artifact_id")));
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
    throw new CoreHttpError(response.status, error?.message ?? `Core request failed: ${response.status}`, error?.code ?? statusCode(response.status), error?.trace_id);
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
  await appendLog(logPath, `runtime resources=${resourcesPath} data=${dataDir}`);
  const runtimeDir = join(dataDir, "runtime", `${process.pid}-${randomBytes(8).toString("hex")}`);
  supervisor = new SidecarSupervisor({
    executable: process.env.AIVS_SIDECAR_EXECUTABLE ?? SidecarSupervisor.packagedExecutable(resourcesPath),
    executableArgs: parseExecutableArgs(process.env.AIVS_SIDECAR_EXECUTABLE_ARGS),
    resourcesPath, dataDir, runtimeDir, logPath,
    ffmpegPath: join(resourcesPath, "ffmpeg", "win-x64", "ffmpeg.exe"),
    ffprobePath: join(resourcesPath, "ffmpeg", "win-x64", "ffprobe.exe"),
    buildVersion: app.getVersion(), adminToken
  });
  await appendLog(logPath, `starting sidecar resources=${resourcesPath}`);
  const ready = await supervisor.start();
  await appendLog(logPath, `sidecar ready pid=${ready.pid} port=${ready.port}`);
  core = new CoreAdminClient(`http://127.0.0.1:${ready.port}`, adminToken);
  runtime = { base_url: `http://127.0.0.1:${ready.port}`, ui_token: adminToken, protocol_version: 1 };
  await appendLog(logPath, `Core process ready pid=${ready.pid} port=${ready.port} build=${ready.build_version}`);
  await waitForCoreHealth(core);
  await appendLog(logPath, "Core public health ready");
  const session = await core.createSession();
  await appendLog(logPath, "Core session response received");
  runtime = { base_url: `http://127.0.0.1:${ready.port}`, ui_token: session.token, protocol_version: 1 };
  resolveRuntime?.(runtime);
  await appendLog(logPath, "Core UI session ready");
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
  protocol.handle(RESTRICTED_MEDIA_SCHEME, async request => {
    const assetId = assetIdFromRestrictedUrl(request.url);
    const inputPath = assetId ? restrictedMedia.resolve(assetId) : undefined;
    if (!inputPath || request.method !== "GET") return new Response(null, { status: 404 });
    try {
      return await net.fetch(pathToFileURL(inputPath).toString());
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  registerIpc();
  try {
    await createWindow();
    void startRuntime().catch(async error => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      await appendLog(logPath, `runtime startup failed after window: ${message}`).catch(() => undefined);
      if (windowRef && !windowRef.isDestroyed()) {
        windowRef.webContents.send("runtime:error", message);
      }
    });
  }
  catch (error) {
    await appendLog(logPath || join(app.getPath("userData"), "logs", "desktop.log"), String(error)).catch(() => undefined);
    await shutdownRuntime().catch(() => undefined);
    await dialog.showErrorBox("AIVideo Studio 启动失败", "本地核心服务未能启动，请查看日志目录。");
    app.exit(1);
  }
}).catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  void appendLog(logPath || join(app.getPath("userData"), "logs", "desktop.log"), `startup failure: ${message}`).catch(() => undefined);
  if (windowRef && !windowRef.isDestroyed()) {
    dialog.showErrorBox("AIVideo Studio 启动失败", message);
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
