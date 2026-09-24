import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * 品牌图标解析（资产清单见 docs/BRANDING_ASSETS.md）：
 * - 打包后：src/renderer/public/icons 随 files:["out"] 构建进 out/renderer/icons，
 *   再进入 asar，主进程用 __dirname 相对路径读取；
 * - 开发态：electron-vite 只把 main/preload 写入 out，图标从源码 public 目录取。
 */
function iconRoots(): string[] {
  return [
    join(__dirname, "..", "renderer", "icons"),
    join(app.getAppPath(), "src", "renderer", "public", "icons")
  ];
}

/** 按文件名解析图标绝对路径；找不到返回 undefined（绝不抛错，图标缺失不应阻断启动）。 */
export function iconPath(name: string): string | undefined {
  for (const root of iconRoots()) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 窗口图标（任务栏 / Alt-Tab / 窗口左上角）：Windows 用多尺寸 .ico，其余平台用大尺寸 PNG。 */
export function windowIconPath(): string | undefined {
  return process.platform === "win32"
    ? iconPath("icon.ico") ?? iconPath("256.png")
    : iconPath("256.png") ?? iconPath("512.png");
}

/** 托盘图标：Windows 托盘按 ~16px 渲染，交给系统从 .ico 挑尺寸；其余平台用小尺寸 PNG。 */
export function trayIconPath(): string | undefined {
  return process.platform === "win32"
    ? iconPath("icon.ico") ?? iconPath("16.png")
    : iconPath("16.png");
}
