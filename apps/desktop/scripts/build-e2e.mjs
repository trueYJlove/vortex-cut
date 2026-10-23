#!/usr/bin/env node
/**
 * E2E 构建配方：electron-vite build + 编译期诊断指标开关。
 *
 * 为什么需要独立配方：`window.__aivsPreviewMetrics` / `__editorPerf` 的生产者
 * 在编译期就被 `import.meta.env.VITE_AIVS_PERF === "1"` 整段裁剪（SyntheticPreview.tsx
 * / perf-metrics.ts），解码 worker 的决策 trace 同样由 VITE_AIVS_DECODE_TIMING 门控
 * （decode-worker.ts）。默认 `pnpm build` 是产品构建，**不得**带诊断指标（探针隔离
 * 校验 verify-probe-isolation.mjs 以产品 out/ 为基准）。因此 e2e 用本脚本单独建，
 * 产品构建保持原样。
 *
 * 两个开关都要开：
 * - VITE_AIVS_PERF=1          → __aivsPreviewMetrics / __editorPerf 存在（指标断言非空转）
 * - VITE_AIVS_DECODE_TIMING=1 → worker 决策 trace 存在（eof_reorder_stuck 等计数断言非空转）
 * 只开 PERF 时 seek-play 的「单帧停摆兜底 ≤4」会因为 trace 恒空而变成恒真断言。
 *
 * 跨平台：直接改子进程 env 再 spawn，不依赖 shell 语法或 cross-env。
 */
const { spawn } = await import("node:child_process");
const { createRequire } = await import("node:module");
const path = await import("node:path");

// dev.mjs 同款：剥掉 ELECTRON_RUN_AS_NODE（构建虽是 node 侧，但保持行为一致）。
delete process.env.ELECTRON_RUN_AS_NODE;

const buildEnv = { ...process.env, VITE_AIVS_PERF: "1", VITE_AIVS_DECODE_TIMING: "1" };

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(path.dirname(require.resolve("electron-vite")));
const cli = path.join(pkgDir, "bin", "electron-vite.js");

process.stdout.write("[build-e2e] VITE_AIVS_PERF=1 VITE_AIVS_DECODE_TIMING=1 (diagnostics build for e2e)\n");

const proc = spawn(process.execPath, [cli, "build", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: buildEnv,
  cwd: process.cwd(),
});
proc.on("close", code => process.exit(code ?? 0));
