import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(desktopDir, "../..");
const localAppData = process.env.LOCALAPPDATA;
const cacheRoot = process.env.AIVS_ELECTRON_BUILDER_CACHE ?? (localAppData ? join(localAppData, "electron-builder", "Cache") : "");
const nsisDir = cacheRoot ? join(cacheRoot, "nsis", "nsis-3.0.4.1") : "";
const nsisResourcesDir = cacheRoot ? join(cacheRoot, "nsis", "nsis-resources-3.4.1") : "";
const sevenZip = process.env.AIVS_ELECTRON_BUILDER_7ZIP_PATH ?? join(workspaceRoot, ".deps-download", "7zip-bin-extracted", "package", "win", "x64", "7za.exe");
const releaseRoot = join(desktopDir, "release");
const packageRunId = `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}-${randomBytes(6).toString("hex")}`;
const packageOutputDir = join(releaseRoot, `win-${packageRunId}`);
const packageRoot = join(packageOutputDir, "win-unpacked", "resources");
const packageReport = join(workspaceRoot, "build", "reports", "windows-package-latest.json");
const env = { ...process.env };
if (existsSync(join(nsisDir, "Bin", "makensis.exe"))) env.ELECTRON_BUILDER_NSIS_DIR = nsisDir;
if (existsSync(join(nsisResourcesDir, "plugins"))) env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = nsisResourcesDir;
if (existsSync(sevenZip)) env.ELECTRON_BUILDER_7ZIP_PATH = sevenZip;

const quoteCmdArg = value => {
  const stringValue = String(value);
  if (!/[\s"]/.test(stringValue)) return stringValue;
  return `"${stringValue.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
};

const run = (command, args) => new Promise((resolvePromise, reject) => {
  const usesCmd = process.platform === "win32" && command !== process.execPath && !command.toLowerCase().endsWith(".exe");
  const executable = usesCmd ? process.env.ComSpec : command;
  const commandArgs = usesCmd
    ? ["/d", "/s", "/c", [command + ".cmd", ...args].map(quoteCmdArg).join(" ")]
    : args;
  const child = execFile(executable, commandArgs, { cwd: desktopDir, env, windowsHide: true }, (error, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (error) reject(error); else resolvePromise();
  });
});

if (existsSync(packageOutputDir)) throw new Error(`Package output directory already exists: ${packageOutputDir}`);
mkdirSync(join(workspaceRoot, "build", "reports"), { recursive: true });
const writePackageReport = status => writeFileSync(packageReport, `${JSON.stringify({
  schema_version: 1,
  status,
  package_root: packageRoot,
  unpacked_root: join(packageOutputDir, "win-unpacked"),
  output_root: packageOutputDir,
  created_at: new Date().toISOString()
}, null, 2)}\n`, "utf8");
writePackageReport("building");

await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(workspaceRoot, "tools", "packaging", "build-sidecar.ps1")]);
await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(workspaceRoot, "tools", "packaging", "bootstrap-windows.ps1"), "-PreflightOnly"]);
await run(process.execPath, ["scripts/prepare-electron-builder.mjs"]);
await run("pnpm", ["build"]);
await run("electron-builder", [
  "--win", "nsis", "--config", "electron-builder.yml",
  `--config.directories.output=${packageOutputDir}`
]);

const installer = readdirSync(packageOutputDir, { withFileTypes: true })
  .find(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"));
writePackageReport("built");
const report = JSON.parse(readFileSync(packageReport, "utf8"));
report.installer_path = installer ? join(packageOutputDir, installer.name) : null;
writeFileSync(packageReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");
env.AIVS_PACKAGE_DIR = packageRoot;
env.AIVS_PACKAGE_REPORT = packageReport;
console.log(`Windows package output: ${packageOutputDir}`);
console.log(`Windows package report: ${packageReport}`);
await run("pnpm", ["package:verify"]);
