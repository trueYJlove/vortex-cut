import type { EditorLoadMode } from "../editor-load-lease.js";
import type { IpcHandle } from "./shared.js";

export interface SystemIpcDependencies {
  handle: IpcHandle;
  waitForRendererRuntime: () => Promise<unknown>;
  updateEditorLoad: (mode: EditorLoadMode) => void;
  setWindowTheme: (theme: unknown) => { status: string };
  getDiagnostics: () => Promise<unknown>;
}

/** Register runtime readiness, editor load lease, window theme, and diagnostics IPC handlers. */
export function registerSystemIpc(deps: SystemIpcDependencies): void {
  deps.handle("runtime:get", () => deps.waitForRendererRuntime());
  // B16b：Renderer 推送编辑器负载（playing/scrubbing/idle；转换即时 +
  // 1s 保活——Main 侧 lease 心跳消费）。Renderer 崩溃 = 无推送 = 心跳
  // 维持最后值（Core TTL 兜底过期回 idle）。
  deps.handle("editor-load:update", (_event, mode: unknown) => {
    if (mode !== "playing" && mode !== "scrubbing" && mode !== "idle") {
      throw new Error("Invalid editor load mode");
    }
    deps.updateEditorLoad(mode);
    return { status: "ok" };
  });
  // 原生窗口按钮（右上角最小化/最大化/关闭）的颜色跟随主题（2026-11-11）。
  // 这组按钮由系统绘制（titleBarOverlay），CSS 完全管不到：浅色主题下
  // symbolColor 仍是写死的 #e6eaec 浅灰，落在浅色标题栏上等于看不见
  // （用户截图：「最小化/关闭按钮等看不见」）。
  // 渲染侧切换主题后调这里重设 overlay；SetTitleBarOverlay 是 Electron 的
  // 运行时接口，用可选调用避免旧版本/其他平台报错。
  deps.handle("window:set-theme", (_event, theme: unknown) => deps.setWindowTheme(theme));
  deps.handle("diagnostics:get", () => deps.getDiagnostics());
}
