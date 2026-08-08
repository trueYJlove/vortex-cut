import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CoreAdminClient } from "./core-admin-client.js";
import { registerFileGrant } from "./file-grants.js";
import { defaultLogPath, appendLog } from "./logging.js";
import { SidecarSupervisor } from "./sidecar-supervisor.js";
import type { ArtifactId, GrantId, JobId, MediaInfo } from "@aivideo/contracts";

let windowRef: BrowserWindow | undefined;
let supervisor: SidecarSupervisor | undefined;
let core: CoreAdminClient | undefined;
let runtime: { base_url: string; ui_token: string; protocol_version: 1 } | undefined;
let logPath = "";

function requireCore(): CoreAdminClient {
  if (!core) throw new Error("Core is not ready");
  return core;
}

function asId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

async function createWindow(): Promise<void> {
  windowRef = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  windowRef.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  windowRef.webContents.on("will-navigate", event => event.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) await windowRef.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await windowRef.loadFile(join(__dirname, "../renderer/index.html"));
  windowRef.on("closed", () => { windowRef = undefined; });
}

function registerIpc(): void {
  ipcMain.handle("runtime:get", () => {
    if (!runtime) throw new Error("Runtime is not ready");
    return runtime;
  });
  ipcMain.handle("diagnostics:get", () => requireCore().health());
  ipcMain.handle("media:choose", async () => {
    const result = await dialog.showOpenDialog(windowRef!, { properties: ["openFile"], filters: [{ name: "Video", extensions: ["mp4", "mkv", "mov", "webm"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const grant = await registerFileGrant(requireCore(), result.filePaths[0]);
    const media = await fetchWithUi<MediaInfo>("/api/v1/media/probe", { method: "POST", body: JSON.stringify({ grant_id: grant.grant_id }) });
    return { grant, media };
  });
  ipcMain.handle("media:probe", (_event, grantId: GrantId) => fetchWithUi<MediaInfo>("/api/v1/media/probe", { method: "POST", body: JSON.stringify({ grant_id: asId(grantId, "grant_id") }) }));
  ipcMain.handle("job:create", (_event, input: { media_id: string; kind: string; encoder_mode?: string; start_us?: number; duration_us?: number; layout?: string }) => {
    if (input.kind !== "proxy" && input.kind !== "portrait_sample") throw new Error("Invalid job kind");
    const mediaId = asId(input.media_id, "media_id");
    const path = input.kind === "proxy" ? "/api/v1/jobs/proxy" : "/api/v1/jobs/vertical-sample";
    const body = input.kind === "proxy"
      ? { media_id: mediaId, encoder_mode: input.encoder_mode ?? "auto" }
      : { media_id: mediaId, encoder_mode: input.encoder_mode ?? "auto", start_us: input.start_us ?? 0, duration_us: input.duration_us ?? 10_000_000, layout: input.layout ?? "blurred_background" };
    return fetchWithUi(path, { method: "POST", body: JSON.stringify(body) });
  });
  ipcMain.handle("job:get", (_event, jobId: JobId) => fetchWithUi(`/api/v1/jobs/${asId(jobId, "job_id")}`));
  ipcMain.handle("job:cancel", (_event, jobId: JobId) => fetchWithUi(`/api/v1/jobs/${asId(jobId, "job_id")}/cancel`, { method: "POST" }));
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
  if (!response.ok) throw new Error(`Core request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

async function startRuntime(): Promise<void> {
  logPath = defaultLogPath(app.getPath("userData"));
  const adminToken = randomBytes(32).toString("hex");
  const resourcesPath = process.resourcesPath;
  const dataDir = app.getPath("userData");
  const runtimeDir = join(dataDir, "runtime", `${process.pid}-${randomBytes(8).toString("hex")}`);
  supervisor = new SidecarSupervisor({
    executable: process.env.AIVS_SIDECAR_EXECUTABLE ?? SidecarSupervisor.packagedExecutable(resourcesPath),
    resourcesPath, dataDir, runtimeDir,
    ffmpegPath: join(resourcesPath, "ffmpeg", "win-x64", "ffmpeg.exe"),
    ffprobePath: join(resourcesPath, "ffmpeg", "win-x64", "ffprobe.exe"),
    buildVersion: app.getVersion(), adminToken
  });
  const ready = await supervisor.start();
  core = new CoreAdminClient(`http://127.0.0.1:${ready.port}`, adminToken);
  const health = await core.health();
  if (health.protocol_version !== 1) throw new Error("Unsupported Core protocol version");
  const session = await core.createSession();
  runtime = { base_url: core ? `http://127.0.0.1:${ready.port}` : "", ui_token: session.token, protocol_version: 1 };
  await appendLog(logPath, `Core ready pid=${ready.pid} port=${ready.port} build=${ready.build_version}`);
}

async function shutdownRuntime(): Promise<void> {
  try { await core?.shutdown(); } catch { /* Core may already be down. */ }
  await supervisor?.stop();
  runtime = undefined;
  core = undefined;
}

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  registerIpc();
  try { await startRuntime(); await createWindow(); }
  catch (error) { await appendLog(logPath || join(app.getPath("userData"), "logs", "desktop.log"), String(error)); await dialog.showErrorBox("AIVideo Studio 启动失败", "本地核心服务未能启动，请查看日志目录。"); app.quit(); }
});
app.on("before-quit", event => { event.preventDefault(); void shutdownRuntime().finally(() => app.exit(0)); });
