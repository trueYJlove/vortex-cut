import { ipcRenderer } from "electron";
import type { CoreHealth } from "@aivideo/contracts";
import type { DesktopSettings, SettingsState } from "../../main/desktop-settings.js";
import type { DesktopRuntime } from "./types.js";

export interface SystemPreloadApi {
  getRuntime: () => Promise<DesktopRuntime>;
  // B16b 编辑器负载：playing/scrubbing/idle 推送（Main 侧 lease 心跳消费）
  updateEditorLoad: (mode: "playing" | "scrubbing" | "idle") => Promise<{ status: string }>;
  /** 原生窗口按钮（最小化/最大化/关闭）颜色跟随主题。CSS 管不到这组系统绘制的按钮。 */
  setWindowTheme: (theme: "light" | "dark") => Promise<{ status: string }>;
  // DESK-1/DESK-2/DESK-3：桌面设置 + 内核重启（代理生效语义 = 重启）
  getSettings: () => Promise<SettingsState>;
  setSettings: (input: {
    proxy_mode?: "system" | "custom" | "direct";
    provider_proxy?: string | null;
    preview_proxy_auto?: boolean;
    preview_proxy_quality?: "auto" | "540" | "720" | "1080";
  }) => Promise<DesktopSettings>;
  restartCore: () => Promise<void>;
  diagnostics: () => Promise<CoreHealth>;
}

export function createSystemPreloadApi(): SystemPreloadApi {
  return {
    getRuntime: () => ipcRenderer.invoke("runtime:get"),
    updateEditorLoad: mode => ipcRenderer.invoke("editor-load:update", mode),
    setWindowTheme: theme => ipcRenderer.invoke("window:set-theme", theme),
    diagnostics: () => ipcRenderer.invoke("diagnostics:get"),
    getSettings: () => ipcRenderer.invoke("settings:get"),
    setSettings: input => ipcRenderer.invoke("settings:set", input),
    restartCore: () => ipcRenderer.invoke("core:restart"),
  };
}
