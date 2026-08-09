import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(desktopDir, "../..");
const localAppData = process.env.LOCALAPPDATA;
const nsisDir = localAppData ? join(localAppData, "electron-builder", "Cache", "nsis", "nsis-3.0.4.1") : "";
const nsisResourcesDir = localAppData ? join(localAppData, "electron-builder", "Cache", "nsis", "nsis-resources-3.4.1") : "";
const sevenZip = join(workspaceRoot, ".deps-download", "7zip-bin-extracted", "package", "win", "x64", "7za.exe");
const env = { ...process.env };
if (existsSync(join(nsisDir, "Bin", "makensis.exe"))) env.ELECTRON_BUILDER_NSIS_DIR = nsisDir;
if (existsSync(join(nsisResourcesDir, "plugins"))) env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = nsisResourcesDir;
if (existsSync(sevenZip)) env.ELECTRON_BUILDER_7ZIP_PATH = sevenZip;

const run = (command, args) => new Promise((resolvePromise, reject) => {
  const usesCmd = process.platform === "win32" && command !== process.execPath;
  const executable = usesCmd ? process.env.ComSpec : command;
  const commandArgs = usesCmd ? ["/d", "/s", "/c", command + ".cmd " + args.join(" ")] : args;
  const child = execFile(executable, commandArgs, { cwd: desktopDir, env, windowsHide: true }, (error, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (error) reject(error); else resolvePromise();
  });
});

await run(process.execPath, ["scripts/prepare-electron-builder.mjs"]);
await run("pnpm", ["build"]);
await run("electron-builder", ["--win", "nsis", "--config", "electron-builder.yml"]);
