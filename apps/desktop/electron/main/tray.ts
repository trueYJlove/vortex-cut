import { Menu, Tray } from "electron";
import { trayIconPath } from "./app-icons.js";

/**
 * Windows 右下角系统托盘：品牌图标 + 托盘菜单。
 * 只提供"显示主窗口 / 退出"入口，不改变窗口关闭语义（关闭窗口仍走正常退出流程）。
 */
export interface TrayCallbacks {
  showWindow(): void;
  quit(): void;
}

let tray: Tray | null = null;

export function initTray(callbacks: TrayCallbacks, log: (message: string) => void = () => undefined): void {
  if (process.env.AIVS_DISABLE_TRAY === "1") return;
  if (tray) return;
  const icon = trayIconPath();
  if (!icon) {
    log("tray icon missing; tray skipped");
    return;
  }
  try {
    tray = new Tray(icon);
  } catch (error) {
    log(`tray creation failed: ${String(error)}`);
    return;
  }
  tray.setToolTip("Vortex Cut");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => callbacks.showWindow() },
    { type: "separator" },
    { label: "退出 Vortex Cut", click: () => callbacks.quit() }
  ]));
  // Windows/Linux：单击托盘图标直接唤起主窗口；macOS 默认弹出菜单。
  if (process.platform !== "darwin") tray.on("click", () => callbacks.showWindow());
  log("tray initialized");
}

export function destroyTray(log: (message: string) => void = () => undefined): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
  log("tray destroyed");
}
