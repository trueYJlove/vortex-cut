import { app, type BrowserWindow } from "electron";
import { randomBytes } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { totalmem } from "node:os";
import { join, resolve } from "node:path";
import { isApiErrorResponse } from "@aivideo/contracts";
import { CoreAdminClient, CoreHttpError } from "../core-admin-client.js";
import type { DesktopSettings, DesktopSettingsStore } from "../desktop-settings.js";
import { EditorLoadLeaseHeartbeat, makeWindowOwnerId, type EditorLoadMode } from "../editor-load-lease.js";
import { ImageProviderSecretStore, reinjectImageProviderSecrets } from "../image-provider-secrets.js";
import { appendLog, defaultLogPath, redact } from "../logging.js";
import { ProviderSecretStore, reinjectProviderSecrets } from "../provider-secrets.js";
import { SidecarSupervisor } from "../sidecar-supervisor.js";

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

function rendererHealth(value: Awaited<ReturnType<CoreAdminClient["health"]>>): Awaited<ReturnType<CoreAdminClient["health"]>> {
  return {
    status: value.status,
    protocol_version: value.protocol_version,
    build_version: value.build_version,
    ...(typeof value.scheduler === "string" && !/[\\/]|(?:file|https?):\/\//i.test(value.scheduler) ? { scheduler: value.scheduler } : {}),
  };
}

function statusCode(status: number): string {
  if (status === 400) return "VALIDATION_ERROR";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  return "INTERNAL_ERROR";
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

async function assertRuntimeResources(resourcesPath: string): Promise<void> {
  const required = [
    SidecarSupervisor.packagedExecutable(resourcesPath),
    join(resourcesPath, "ffmpeg", "win-x64", "ffmpeg.exe"),
    join(resourcesPath, "ffmpeg", "win-x64", "ffprobe.exe"),
    join(resourcesPath, "licenses", "THIRD_PARTY_NOTICES.txt"),
    join(resourcesPath, "model-manifests"),
    join(resourcesPath, "recipes"),
    join(resourcesPath, "platform-presets"),
    join(resourcesPath, "renditions"),
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
  if (!platformPresets.some(entry => entry.isFile() && entry.name === "manifest.json") || !renditions.some(entry => entry.isFile() && entry.name === "manifest.json")) {
    throw new Error("Stage 3A preset manifest is missing from packaged resources");
  }
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

export interface RuntimeManager {
  requireCore: () => CoreAdminClient;
  getProviderSecrets: () => ProviderSecretStore;
  getImageProviderSecrets: () => ImageProviderSecretStore;
  getStartRuntimeSettings: () => DesktopSettings | null;
  waitForRendererRuntime: () => Promise<ReturnType<typeof rendererRuntime>>;
  updateEditorLoad: (mode: EditorLoadMode) => void;
  getHealth: () => Promise<Awaited<ReturnType<CoreAdminClient["health"]>>>;
  fetchWithUi: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  fetchBinaryWithUi: (path: string, init?: RequestInit) => Promise<ArrayBuffer>;
  startRuntime: () => Promise<void>;
  shutdownRuntime: () => Promise<void>;
  restartCore: () => Promise<void>;
}

/** Manage Python Core sidecar startup, UI session tokens, secret stores, lease heartbeat, and shutdown. */
export function createRuntimeManager({
  settingsStore,
  setLogPath,
  getLogPath,
  getWindow,
}: {
  settingsStore: () => DesktopSettingsStore;
  setLogPath: (path: string) => void;
  getLogPath: () => string;
  getWindow: () => BrowserWindow | undefined;
}): RuntimeManager {
  let supervisor: SidecarSupervisor | undefined;
  let core: CoreAdminClient | undefined;
  let runtime: { base_url: string; ui_token: string; protocol_version: 1 } | undefined;
  // B16b：编辑器负载 lease 心跳（Core 就绪后 1s 自重调度；停止即 TTL 过期）
  let editorLease: EditorLoadLeaseHeartbeat | undefined;
  let providerSecrets: ProviderSecretStore | undefined;
  let imageProviderSecrets: ImageProviderSecretStore | undefined;
  // DESK-2：当前 sidecar 进程启动时的设置快照（设置页"当前生效"态的依据；
  // null = 运行时尚未启动）。
  let startRuntimeSettings: DesktopSettings | null = null;
  let restartingCore = false;
  let resolveRuntime: ((value: NonNullable<typeof runtime>) => void) | undefined;
  const runtimeReady = new Promise<NonNullable<typeof runtime>>(resolve => {
    resolveRuntime = resolve;
  });

  function requireCore(): CoreAdminClient {
    if (!core) throw new Error("Core is not ready");
    return core;
  }

  function getProviderSecrets(): ProviderSecretStore {
    providerSecrets ??= new ProviderSecretStore(app.getPath("userData"));
    return providerSecrets;
  }

  function getImageProviderSecrets(): ImageProviderSecretStore {
    imageProviderSecrets ??= new ImageProviderSecretStore(app.getPath("userData"));
    return imageProviderSecrets;
  }

  async function requestUiResponse(path: string, init: RequestInit = {}): Promise<Response> {
    if (!runtime) throw new Error("Runtime is not ready");
    const response = await fetch(`${runtime.base_url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${runtime.ui_token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
    if (!response.ok) {
      let data: unknown = null;
      try { data = await response.json(); } catch { /* preserve HTTP status for empty/binary error responses */ }
      const error = isApiErrorResponse(data) ? data.error : undefined;
      const code = error?.code ?? statusCode(response.status);
      // Electron IPC 只把 message 传给渲染端（自定义 .code 属性会被剥离）；
      // 这里把业务码前缀进 message，渲染端 errorCode() 提取后才能识别
      // TIMELINE_NOT_FOUND / PREVIEW_IR_UNSUPPORTED 等业务错误。
      throw new CoreHttpError(response.status, `[${code}] ${redact(error?.message ?? "Core request failed")}`, code, error?.trace_id);
    }
    return response;
  }

  async function fetchWithUi<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await requestUiResponse(path, init);
    let data: unknown = null;
    try { data = await response.json(); } catch { /* preserve empty 204/no-body responses */ }
    return data as T;
  }

  async function fetchBinaryWithUi(path: string, init: RequestInit = {}): Promise<ArrayBuffer> {
    const response = await requestUiResponse(path, init);
    return response.arrayBuffer();
  }

  async function startRuntime(): Promise<void> {
    const logPath = defaultLogPath(app.getPath("userData"));
    setLogPath(logPath);
    const adminToken = randomBytes(32).toString("hex");
    const launchSettings = settingsStore().get();
    startRuntimeSettings = launchSettings;
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
      resourcesPath,
      dataDir,
      runtimeDir,
      logPath,
      ffmpegPath: join(resourcesPath, "ffmpeg", "win-x64", "ffmpeg.exe"),
      ffprobePath: join(resourcesPath, "ffmpeg", "win-x64", "ffprobe.exe"),
      manifestDir: join(resourcesPath, "model-manifests"),
      buildVersion: app.getVersion(),
      adminToken,
      launchEvidencePath: process.env.AIVS_E2E_SIDECAR_ARGV_EVIDENCE,
      enableImageProviderNetwork: process.env.AIVS_ENABLE_IMAGE_PROVIDER_NETWORK === "true",
      // DESK-2：设置持久化的代理模式/地址随 sidecar 启动传入（Core 启动时解析
      // 一次，运行中不热生效——生效语义 = 重启内核，规划门 §5 裁决①）。
      proxyMode: launchSettings.proxy_mode,
      providerProxy: launchSettings.provider_proxy ?? undefined,
    });
    await appendLog(logPath, `starting sidecar resources=${resourcesPath}`);
    const ready = await supervisor.start();
    await appendLog(logPath, `sidecar ready pid=${ready.pid} port=${ready.port}`);
    core = new CoreAdminClient(`http://127.0.0.1:${ready.port}`, adminToken);
    await appendLog(logPath, `Core process ready pid=${ready.pid} port=${ready.port} build=${ready.build_version}`);
    await waitForCoreHealth(core);
    await appendLog(logPath, "Core public health ready");
    const session = await core.createSession();
    await reinjectProviderSecrets(getProviderSecrets(), core);
    await reinjectImageProviderSecrets(getImageProviderSecrets(), core);
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
    await appendLog(getLogPath(), "Core UI session ready");
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

  /**
   * DESK-2：代理等设置变更后的"重启内核"动作——stop→start 全量就绪序列复用
   * （CoreAdminClient 重建 + 密钥重注入 + UI session 重开，与冷启动同路径）。
   * 运行时未就绪（首次启动尚未完成）时拒绝重启，避免与 startRuntime 竞争。
   */
  async function restartCore(): Promise<void> {
    if (restartingCore) throw new Error("内核正在重启，请稍候");
    if (!runtime || !supervisor) throw new Error("内核尚未就绪，无法重启");
    restartingCore = true;
    try {
      const windowRef = getWindow();
      if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send("runtime:error", "内核正在重启，界面恢复后可继续操作。");
      await shutdownRuntime();
      await startRuntime();
    } finally {
      restartingCore = false;
    }
  }

  return {
    requireCore,
    getProviderSecrets,
    getImageProviderSecrets,
    getStartRuntimeSettings: () => startRuntimeSettings,
    async waitForRendererRuntime() {
      // 重启窗口期（restartingCore 且 runtime 已清空）：等 startRuntime 完成，
      // 避免竞态窗口拿到已停用旧 sidecar 的 base_url。
      const deadline = Date.now() + 30_000;
      while (!runtime && restartingCore && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
      if (runtime) return rendererRuntime();
      await Promise.race([
        runtimeReady,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Core UI session startup timed out")), 30_000)),
      ]);
      return rendererRuntime();
    },
    updateEditorLoad(mode) {
      editorLease?.updateMode(mode);
    },
    async getHealth() {
      return rendererHealth(await requireCore().health());
    },
    fetchWithUi,
    fetchBinaryWithUi,
    startRuntime,
    shutdownRuntime,
    restartCore,
  };
}
