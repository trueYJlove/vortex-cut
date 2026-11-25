import { app, dialog } from "electron";
import { join } from "node:path";
import { createMediaPresentationService, registerRestrictedMediaProtocol, registerRestrictedMediaScheme } from "./bootstrap/protocol.js";
import { createRuntimeManager } from "./bootstrap/runtime.js";
import { createMainWindowManager } from "./bootstrap/window.js";
import { DesktopSettingsStore } from "./desktop-settings.js";
import { registerAllIpc } from "./ipc/register-all.js";
import { appendLog, defaultLogPath, redact } from "./logging.js";
import { registerProbeIpc, type ProbeIpcHandle } from "./probe-ipc.js";
import { RestrictedMediaRegistry } from "./restricted-media.js";
import { destroyTray, initTray } from "./tray.js";

registerRestrictedMediaScheme();

const restrictedMedia = new RestrictedMediaRegistry();
let probeIpc: ProbeIpcHandle | null = null;
let logPath = "";
let desktopSettings: DesktopSettingsStore | undefined;
function settingsStore(): DesktopSettingsStore {
  desktopSettings ??= new DesktopSettingsStore(app.getPath("userData"));
  return desktopSettings;
}

const windowManager = createMainWindowManager({
  getLogPath: () => logPath,
  getProbeIpc: () => probeIpc,
});
const runtimeManager = createRuntimeManager({
  settingsStore,
  setLogPath: value => { logPath = value; },
  getLogPath: () => logPath,
  getWindow: windowManager.getWindow,
});
const mediaPresentation = createMediaPresentationService({
  restrictedMedia,
  requireCore: runtimeManager.requireCore,
  getLogPath: () => logPath,
});

// Acquire the lock before startup work so duplicate launches cannot race with
// window creation or sidecar startup.
const hasSingleInstanceLock = !app.isPackaged || app.requestSingleInstanceLock();
if (app.isPackaged && !hasSingleInstanceLock) {
  app.quit();
}

// Windows 任务栏/通知身份与安装包快捷方式（AppUserModelID = appId）保持一致，
// 否则固定到任务栏后会以通用 Electron 身份分组、丢失品牌图标。
if (process.platform === "win32") app.setAppUserModelId("io.github.trueyjlove.vortexcut");

app.on("second-instance", () => windowManager.showMainWindow());

process.on("uncaughtException", error => {
  void appendLog(logPath || join(app.getPath("userData"), "logs", "desktop.log"), `uncaughtException: ${error.stack ?? error.message}`);
});
process.on("unhandledRejection", reason => {
  void appendLog(logPath || join(app.getPath("userData"), "logs", "desktop.log"), `unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`).catch(() => undefined);
});

app.whenReady().then(async () => {
  logPath = defaultLogPath(app.getPath("userData"));
  await appendLog(logPath, "app ready").catch(() => undefined);
  if (app.isPackaged && !hasSingleInstanceLock) {
    await appendLog(logPath || join(app.getPath("userData"), "logs", "desktop.log"), "single instance lock unavailable").catch(() => undefined);
    app.quit();
    return;
  }
  registerRestrictedMediaProtocol(restrictedMedia);
  probeIpc = registerProbeIpc({ registry: restrictedMedia });
  registerAllIpc({
    runtimeManager,
    windowManager,
    mediaPresentation,
    restrictedMedia,
    settingsStore,
    getLogPath: () => logPath,
  });
  try {
    await windowManager.createWindow();
    // Windows 右下角系统托盘：品牌图标 + 显示主窗口/退出菜单。
    initTray({ showWindow: windowManager.showMainWindow, quit: () => app.quit() }, message => void appendLog(logPath, message));
    void runtimeManager.startRuntime().catch(async error => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      await appendLog(logPath, `runtime startup failed after window: ${message}`).catch(() => undefined);
      const windowRef = windowManager.getWindow();
      if (windowRef && !windowRef.isDestroyed()) {
        windowRef.webContents.send("runtime:error", redact(message));
      }
    });
  } catch (error) {
    await appendLog(logPath || join(app.getPath("userData"), "logs", "desktop.log"), String(error)).catch(() => undefined);
    await runtimeManager.shutdownRuntime().catch(() => undefined);
    await dialog.showErrorBox("Vortex Cut 启动失败", "本地核心服务未能启动，请查看日志目录。");
    app.exit(1);
  }
}).catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  void appendLog(logPath || join(app.getPath("userData"), "logs", "desktop.log"), `startup failure: ${message}`).catch(() => undefined);
  const windowRef = windowManager.getWindow();
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
  destroyTray(message => void appendLog(logPath, message));
  void appendLog(logPath, "shutdown started").catch(() => undefined);
  void runtimeManager.shutdownRuntime().finally(() => app.exit(0));
});
