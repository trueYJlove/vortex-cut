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
const path = await import("node:path");

const require = createRequire(import.meta.url);
const entry = require.resolve("electron-vite");
const pkgDir = path.dirname(path.dirname(entry));
const cli = path.join(pkgDir, "bin", "electron-vite.js");

const proc = spawn(process.execPath, [cli, "dev"], {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd(),
});
proc.on("close", (code) => process.exit(code ?? 0));
