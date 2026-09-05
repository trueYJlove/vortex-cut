import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";

/**
 * 渲染入口（§7.1 四层隔离 · 第 2 层）：
 * 仅当 `import.meta.env.DEV && probe ∈ {m3p1,m3p2,m3p3}`（由主进程在 dev 加载
 * URL 上注入）时动态导入探针并替代 App 挂载。生产构建 import.meta.env.DEV
 * 静态替换为 false → 动态导入分支被死代码消除，探针代码不进产物
 * （校验：scripts/verify-probe-isolation.mjs 于 out/renderer grep 探针标记零命中）。
 */
const probeName = import.meta.env.DEV
  ? new URLSearchParams(window.location.search).get("probe")
  : null;

if (import.meta.env.DEV && (probeName === "m3p1" || probeName === "m3p2" || probeName === "m3p3")) {
  // 探针早期异常不能静默：落 console（dev 主进程采集）并展示在页面上。
  try {
    if (probeName === "m3p1") await import("../probes/m3p1.js").then(module => module.runProbe());
    else if (probeName === "m3p2") await import("../probes/m3p2.js").then(module => module.runProbe());
    else await import("../probes/m3p3.js").then(module => module.runProbe());
  } catch (error) {
    console.error(`[m3-probe] ${probeName} crashed:`, error);
    document.title = `probe ${probeName} CRASHED`;
    document.body.textContent = `probe ${probeName} crashed: ${error instanceof Error ? error.stack : String(error)}`;
  }
} else {
  const { App } = await import("../app/App.js");
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
}
