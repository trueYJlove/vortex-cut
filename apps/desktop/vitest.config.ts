import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: [resolve(__dirname, "tests/setup.ts")],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // 全量并行时 jsdom worker 争抢 CPU，重交互用例偶发越过 5s 默认值
    // （编辑器工作流/安装包脚本类用例单跑均在 2s 内）——放宽默认超时消除负载抖动。
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reportsDirectory: resolve(__dirname, "coverage", "source-only"),
      reporter: ["text", "json-summary", "html"],
      include: [
        "src/app/**/*.tsx",
        "src/lib/**/*.ts",
        "electron/main/candidate-media.ts",
        "electron/main/provider-secrets.ts",
        "electron/main/stage2a-ipc.ts",
        "electron/main/stage2b-ipc.ts",
        "electron/main/restricted-media.ts",
        "electron/main/export-destination.ts",
        "electron/main/logging.ts",
        "electron/preload/index.ts"
      ],
      exclude: ["out/**", "coverage/**", "tests/**", "e2e/**", "scripts/**", "**/*.config.*"],
      thresholds: { statements: 82, lines: 82, functions: 68, branches: 72 }
    }
  }
});
