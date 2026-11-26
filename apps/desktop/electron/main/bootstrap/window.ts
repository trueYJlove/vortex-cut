import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import type { AssetKind } from "@aivideo/contracts";
import { windowIconPath } from "../app-icons.js";
import { appendLog } from "../logging.js";
import { probeActive, probeLoadQuery, type ProbeIpcHandle } from "../probe-ipc.js";

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

export interface MainWindowManager {
  getWindow: () => BrowserWindow | undefined;
  showMainWindow: () => void;
  setTheme: (theme: unknown) => { status: string };
  createWindow: () => Promise<void>;
  chooseAssetPath: (kind?: AssetKind, title?: string, relocate?: boolean) => Promise<string | null>;
}

/** Manage the single main BrowserWindow lifecycle, titlebar overlay theme, and asset file dialogs. */
export function createMainWindowManager({
  getLogPath,
  getProbeIpc,
}: {
  getLogPath: () => string;
  getProbeIpc: () => ProbeIpcHandle | null;
}): MainWindowManager {
  let windowRef: BrowserWindow | undefined;

  function showMainWindow(): void {
    if (!windowRef || windowRef.isDestroyed()) return;
    if (windowRef.isMinimized()) windowRef.restore();
    windowRef.show();
    windowRef.focus();
  }

  function setTheme(theme: unknown): { status: string } {
    if (theme !== "light" && theme !== "dark") throw new Error("Invalid theme");
    const win = windowRef;
    if (!win || win.isDestroyed()) return { status: "ok" };
    const setOverlay = (win as unknown as { setTitleBarOverlay?: (o: { color: string; symbolColor: string; height: number }) => void }).setTitleBarOverlay;
    if (process.platform === "win32" && typeof setOverlay === "function") {
      setOverlay.call(win, {
        color: "#00000000",
        // 深色标题栏用浅色符号，浅色标题栏用深色符号——这是这组按钮唯一的可读性来源。
        symbolColor: theme === "light" ? "#1a1a1f" : "#e6eaec",
        height: 36,
      });
    }
    return { status: "ok" };
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

  async function createWindow(): Promise<void> {
    const logPath = getLogPath();
    await appendLog(logPath, `createWindow renderer=${process.env.ELECTRON_RENDERER_URL ?? "file"}`);
    // 窗口图标：任务栏 / Alt-Tab / 系统窗口处的品牌 logo（Windows 取多尺寸 .ico）。
    const icon = windowIconPath();
    try {
      windowRef = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1024,
        minHeight: 720,
        title: "Vortex Cut",
        ...(icon ? { icon } : {}),
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
          backgroundThrottling: false,
        },
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
      void appendLog(getLogPath(), `preload error path=${preloadPath} error=${error.stack ?? error.message}`);
    });
    windowRef.webContents.on("render-process-gone", (_event, details) => {
      getProbeIpc()?.noteRenderGone();
      void appendLog(getLogPath(), `render process gone reason=${details.reason} exit=${details.exitCode}`);
    });
    windowRef.webContents.on("did-finish-load", () => { void appendLog(getLogPath(), "renderer did-finish-load"); });
    windowRef.once("ready-to-show", () => { void appendLog(getLogPath(), "window ready-to-show"); });
    // 最小化/最大化/关闭改由系统 caption 按钮处理（titleBarOverlay），
    // 不再向渲染进程转发 maximize 状态；菜单栏整体隐藏（参考 dsh-desktop）。
    if (process.platform === "win32") windowRef.setMenuBarVisibility(false);
    windowRef.webContents.on("did-fail-load", (_event, code, description, url) => {
      void appendLog(getLogPath(), `renderer load failed code=${code} description=${description} url=${url}`);
    });
    // M3-0 探针：dev-only 采集渲染进程 console（探针无 stdout，错误经此落日志）。
    if (probeActive()) {
      windowRef.webContents.on("console-message", (_event, level, message, line, sourceId) => {
        void appendLog(getLogPath(), `renderer console[level=${level}] ${message} @${sourceId}:${line}`);
      });
    }
    // AIVS_RENDERER_CONSOLE=1（dev 诊断开关）：渲染进程 console 落桌面日志
    //（抽帧链路在 worker 内报错，无此通道时现场无从定位）。
    if (!app.isPackaged && process.env.AIVS_RENDERER_CONSOLE === "1") {
      windowRef.webContents.on("console-message", (_event, level, message, line, sourceId) => {
        void appendLog(getLogPath(), `renderer-console[level=${level}] ${message} @${sourceId}:${line}`);
      });
    }
    windowRef.on("closed", () => { void appendLog(getLogPath(), "window closed"); windowRef = undefined; });
    // M3-0 探针：仅 dev + AIVS_M3_PROBE 时向加载 URL 追加 ?probe=<名>（§7.1 第 1 层）。
    const probeQuery = probeLoadQuery();
    const load = process.env.ELECTRON_RENDERER_URL
      ? windowRef.loadURL(process.env.ELECTRON_RENDERER_URL + probeQuery)
      : windowRef.loadFile(join(__dirname, "../renderer/index.html"));
    void load.then(() => appendLog(getLogPath(), "window loaded")).catch(error => appendLog(getLogPath(), `window load error: ${String(error)}`));
  }

  return {
    getWindow: () => windowRef,
    showMainWindow,
    setTheme,
    createWindow,
    chooseAssetPath,
  };
}
