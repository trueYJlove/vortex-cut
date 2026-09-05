import { contextBridge, ipcRenderer } from "electron";

/**
 * M3-0 探针 dev-only 预加载桥（§7.1 四层隔离 · 第 1.5 层）。
 *
 * 由 preload/index.ts 在 `NODE_ENV !== "production" && AIVS_M3_PROBE` 双条件下
 * 动态导入：生产构建中 NODE_ENV 静态替换为 "production" → 分支死代码消除，
 * 本模块不进产物；即便运行时被人为置入 env，主进程侧 handler 未注册
 * （app.isPackaged 门控），invoke 一律拒绝。双重保险，见冻结方案 §7.1。
 */
export function registerProbeBridge(): void {
  const api = {
    session: () => ipcRenderer.invoke("probe:session"),
    mediaTicket: (entityId: string) => ipcRenderer.invoke("probe:media-ticket", entityId),
    writeArtifact: (relPath: string, content: string | { base64: string }) =>
      ipcRenderer.invoke("probe:write-artifact", relPath, content),
    gpu: () => ipcRenderer.invoke("probe:gpu"),
    env: () => ipcRenderer.invoke("probe:env"),
    done: (summary: unknown) => ipcRenderer.invoke("probe:done", summary),
  };
  contextBridge.exposeInMainWorld("probeDesktop", api);
}
