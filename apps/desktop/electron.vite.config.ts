import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve(__dirname, "electron/main/index.ts") },
      // CJS 产物（.cjs）：Electron 36.2.1 内嵌 Node 22.15.0 的 ESM 翻译器有
      // cjsPreparseModuleExports 崩溃 bug（22.15.1 修复），CJS 加载路径绕开它。
      // contracts 只有 ESM exports，CJS require 不到 → 一并打包进产物。
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } }
    },
    plugins: [externalizeDepsPlugin({ exclude: ["@aivideo/contracts"] })]
  },
  preload: {
    build: {
      lib: { entry: resolve(__dirname, "electron/preload/index.ts") },
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
    resolve: { alias: { "@": resolve(__dirname, "src") } },
    plugins: [react(), tailwindcss()]
  }
});
