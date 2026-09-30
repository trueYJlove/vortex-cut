#!/usr/bin/env node
/**
 * Dev 启动包装：
 * - 剥掉 ELECTRON_RUN_AS_NODE —— 上层终端/工具链可能注入该变量，导致
 *   Electron 以纯 Node 模式启动（require("electron") 返回路径字符串，
 *   主进程立刻崩溃）。正常 dev 不需要它。
 * - 其余环境原样传给 electron-vite（CWD = 包目录，由 pnpm 保证）。
 */
delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = await import("node:child_process");
const { createRequire } = await import("node:module");
const { fileURLToPath } = await import("node:url");
const path = await import("node:path");

// 开发模式：默认让核心直接用仓库源码运行（.venv 的 python + entrypoint），
// 这样 core 的改动即刻生效，无需每次 PyInstaller 打包。想用打包 sidecar 时，
// 显式设 AIVS_SIDECAR_EXECUTABLE/AIVS_SIDECAR_EXECUTABLE_ARGS 即可覆盖。
if (process.env.AIVS_SIDECAR_EXECUTABLE === undefined) {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  // scripts/ → desktop → apps → 仓库根
  const repoRoot = path.resolve(selfDir, "..", "..", "..");
  const python = path.join(repoRoot, ".venv", "Scripts", "python.exe");
  const entrypoint = path.join(repoRoot, "services", "core", "entrypoint.py");
  process.env.AIVS_SIDECAR_EXECUTABLE = python;
  process.env.AIVS_SIDECAR_EXECUTABLE_ARGS = JSON.stringify([entrypoint]);
}

const require = createRequire(import.meta.url);
const entry = require.resolve("electron-vite");
const pkgDir = path.dirname(path.dirname(entry));
const cli = path.join(pkgDir, "bin", "electron-vite.js");

// 转发额外参数给 electron-vite（`pnpm dev -- --user-data-dir=...`）。
// 用途：dev 模式自动化/隔离复现——electron-vite 会把 `--` 之后的参数原样交给
// Electron 进程（cli.js 里 `process.env.ELECTRON_CLI_ARGS = JSON.stringify(options['--'])`），
// 因此可指定独立的 user-data-dir 而不触碰本机真实项目库（P33 L9 自测闭环需要）。
const proc = spawn(process.execPath, [cli, "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd(),
});
proc.on("close", (code) => process.exit(code ?? 0));
