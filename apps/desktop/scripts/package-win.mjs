import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(desktopDir, "../..");
const localAppData = process.env.LOCALAPPDATA;
const cacheRoot = process.env.AIVS_ELECTRON_BUILDER_CACHE ?? (localAppData ? join(localAppData, "electron-builder", "Cache") : "");
const nsisDir = cacheRoot ? join(cacheRoot, "nsis", "nsis-3.0.4.1") : "";
const nsisResourcesDir = cacheRoot ? join(cacheRoot, "nsis", "nsis-resources-3.4.1") : "";
const sevenZip = process.env.AIVS_ELECTRON_BUILDER_7ZIP_PATH ?? join(workspaceRoot, ".deps-download", "7zip-bin-extracted", "package", "win", "x64", "7za.exe");
const env = { ...process.env };
if (existsSync(join(nsisDir, "Bin", "makensis.exe"))) env.ELECTRON_BUILDER_NSIS_DIR = nsisDir;
if (existsSync(join(nsisResourcesDir, "plugins"))) env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = nsisResourcesDir;
if (existsSync(sevenZip)) env.ELECTRON_BUILDER_7ZIP_PATH = sevenZip;

const run = (command, args) => new Promise((resolvePromise, reject) => {
  const usesCmd = process.platform === "win32" && command !== process.execPath && !command.toLowerCase().endsWith(".exe");
  const executable = usesCmd ? process.env.ComSpec : command;
  const commandArgs = usesCmd ? ["/d", "/s", "/c", command + ".cmd " + args.join(" ")] : args;
  const child = execFile(executable, commandArgs, { cwd: desktopDir, env, windowsHide: true }, (error, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (error) reject(error); else resolvePromise();
  });
});

await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(workspaceRoot, "tools", "packaging", "bootstrap-windows.ps1"), "-PreflightOnly"]);
await run(process.execPath, ["scripts/prepare-electron-builder.mjs"]);
await run("pnpm", ["build"]);
await run("electron-builder", ["--win", "nsis", "--config", "electron-builder.yml"]);
await run("pnpm", ["package:verify"]);
