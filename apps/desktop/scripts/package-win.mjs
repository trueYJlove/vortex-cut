import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

process.on("uncaughtException", error => {
  const message = String(error?.message ?? "");
  const code = /^[A-Z][A-Z0-9_]+$/.test(message) ? message : "BUILDER_UNKNOWN_FAILED";
  process.stderr.write(`${code}\n`);
  process.exit(1);
});

const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(desktopDir, "../..");
const localAppData = process.env.LOCALAPPDATA;
const cacheRoot = process.env.AIVS_ELECTRON_BUILDER_CACHE ?? (localAppData ? join(localAppData, "electron-builder", "Cache") : "");
const nsisDir = cacheRoot ? join(cacheRoot, "nsis", "nsis-3.0.4.1") : "";
const nsisResourcesDir = cacheRoot ? join(cacheRoot, "nsis", "nsis-resources-3.4.1") : "";
const sevenZip = process.env.AIVS_ELECTRON_BUILDER_7ZIP_PATH ?? join(workspaceRoot, ".deps-download", "7zip-bin-extracted", "package", "win", "x64", "7za.exe");
const releaseRoot = join(desktopDir, "release");
const packageRunId = `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}-${randomBytes(6).toString("hex")}`;
// AIVS_PACKAGE_OUTPUT_ROOT is the exact, unique output directory for this run,
// not a shared parent directory.  It must not exist before packaging starts.
const packageOutputOverride = process.env.AIVS_PACKAGE_OUTPUT_ROOT;
if (packageOutputOverride && !isAbsolute(packageOutputOverride)) throw new Error("AIVS_PACKAGE_OUTPUT_ROOT must be an absolute, new output directory");
const packageOutputDir = packageOutputOverride ? resolve(packageOutputOverride) : join(releaseRoot, `win-${packageRunId}`);
const packageRoot = join(packageOutputDir, "win-unpacked", "resources");
const packageResourcesRoot = join(tmpdir(), `aivideo-package-resources-${packageRunId}`);
const packageReportOverride = process.env.AIVS_PACKAGE_REPORT;
if (packageReportOverride && !isAbsolute(packageReportOverride)) throw new Error("AIVS_PACKAGE_REPORT must be an absolute, new report file");
// The legacy report location remains the default for existing callers.  To
// prevent an unrelated run from being overwritten, callers must supply a new
// AIVS_PACKAGE_REPORT when that legacy report already exists.
const packageReport = packageReportOverride ? resolve(packageReportOverride) : join(workspaceRoot, "build", "reports", "windows-package-latest.json");
const resourceEntries = [
  { from: join(packageResourcesRoot, "core", "aivs-core"), to: "core/aivs-core", filter: ["**/*"] },
  { from: join(packageResourcesRoot, "ffmpeg", "win-x64"), to: "ffmpeg/win-x64", filter: ["ffmpeg.exe", "ffprobe.exe"] },
  { from: join(packageResourcesRoot, "licenses"), to: "licenses", filter: ["**/*"] },
  { from: join(packageResourcesRoot, "manifests"), to: "manifests", filter: ["components.json"] },
  { from: join(workspaceRoot, "resources", "model-manifests"), to: "model-manifests", filter: ["*.json"] },
  { from: join(workspaceRoot, "resources", "recipes"), to: "recipes", filter: ["*.json"] },
  { from: join(workspaceRoot, "resources", "platform-presets"), to: "platform-presets", filter: ["**/*.json"] },
  { from: join(workspaceRoot, "resources", "renditions"), to: "renditions", filter: ["**/*.json"] },
  { from: join(workspaceRoot, "resources", "fonts"), to: "fonts", filter: ["**/*"] }
];
const packageVerifyCodes = new Set([
  "PACKAGE_REPORT_UNREADABLE", "PACKAGE_REPORT_INVALID", "PACKAGE_REQUIRED_SIDECAR_MISSING", "PACKAGE_REQUIRED_FFMPEG_MISSING",
  "PACKAGE_REQUIRED_LICENSE_MISSING", "PACKAGE_REQUIRED_COMPONENT_MANIFEST_MISSING", "PACKAGE_REQUIRED_MODEL_MANIFEST_MISSING",
  "PACKAGE_REQUIRED_RECIPE_MISSING", "PACKAGE_REQUIRED_PLATFORM_PRESET_MISSING", "PACKAGE_REQUIRED_RENDITION_PRESET_MISSING",
  "PACKAGE_REQUIRED_FONT_MISSING", "PACKAGE_COMPONENT_MANIFEST_INVALID",
  "PACKAGE_COMPONENT_LICENSE_INVALID", "PACKAGE_COMPONENT_PIN_INVALID", "PACKAGE_COMPONENT_HASH_MISMATCH", "PACKAGE_FONT_BUNDLE_INVALID",
  "PACKAGE_FONT_BUNDLE_FILE_MISSING", "PACKAGE_FONT_BUNDLE_HASH_MISMATCH", "PACKAGE_CAPTION_PRESETS_INVALID", "PACKAGE_CAPTION_STYLES_INVALID",
  "PACKAGE_FFMPEG_FILTER_INVALID", "PACKAGE_MODEL_MANIFEST_INVALID", "PACKAGE_MODEL_WEIGHTS_EMBEDDED",
  "PACKAGE_RECIPE_MANIFEST_INVALID", "PACKAGE_VERIFY_UNEXPECTED", "PACKAGE_COMPONENT_VERIFY_FAILED"
]);
// Use a self-contained JSON config rather than YAML `extends`: electron-builder
// resolves `extends` relative to the generated file, which is outside projectDir.
const builderConfigPath = join(tmpdir(), `aivideo-electron-builder-${packageRunId}.json`);
const builderConfig = {
  appId: "io.github.trueyjlove.vortexcut",
  productName: "Vortex Cut",
  directories: {
    output: packageOutputDir,
    buildResources: join(desktopDir, "build")
  },
  electronDist: join(desktopDir, "node_modules", "electron", "dist"),
  files: ["out", "package.json"],
  extraResources: resourceEntries,
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    artifactName: "VortexCut-Setup-${version}-x64.exe"
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    deleteAppDataOnUninstall: false
  }
};
const stageFailureCodes = Object.freeze({
  sidecar_build: "SIDECAR_BUILD_FAILED",
  bootstrap: "BOOTSTRAP_PREFLIGHT_FAILED",
  builder_prepare: "BUILDER_PREPARE_FAILED",
  desktop_build: "DESKTOP_BUILD_FAILED"
});
const packageRunStages = ["sidecar_build", "bootstrap", "builder_prepare", "desktop_build", "electron_builder", "package_verify"];
const builderFailureCodes = new Set([
  "BUILDER_CONFIG_INVALID", "BUILDER_RESOURCE_CONFIG_INVALID", "BUILDER_SIGNING_FAILED", "BUILDER_NSIS_FAILED",
  "BUILDER_FILE_ACCESS_FAILED", "BUILDER_DEPENDENCY_FAILED", "BUILDER_UNKNOWN_FAILED"
]);
const classifyBuilderFailure = (error, stdout = "", stderr = "") => {
  const detail = `${error?.message ?? ""}\n${stdout}\n${stderr}`;
  if (/(?:extraResources|extra resources|resource).*?(?:invalid|error|fail)|(?:invalid|error|fail).*?(?:extraResources|extra resources|resource)/is.test(detail)) return "BUILDER_RESOURCE_CONFIG_INVALID";
  if (/(?:extends|\.ya?ml|\.json|config(?:uration)?).*?(?:invalid|error|fail)|(?:invalid|error|fail).*?(?:extends|\.ya?ml|\.json|config(?:uration)?)/is.test(detail)) return "BUILDER_CONFIG_INVALID";
  if (/(?:sign(?:ing)?|certificate|winCodeSign)/i.test(detail)) return "BUILDER_SIGNING_FAILED";
  if (/(?:nsis|makensis)/i.test(detail)) return "BUILDER_NSIS_FAILED";
  if (/(?:EACCES|EPERM|access is denied|permission denied|file is being used)/i.test(detail)) return "BUILDER_FILE_ACCESS_FAILED";
  if (/(?:node_modules|module|dependency|electron-builder|7zip).*?(?:missing|not found|cannot find|failed)|(?:missing|not found|cannot find).*?(?:node_modules|module|dependency|electron-builder|7zip)/is.test(detail)) return "BUILDER_DEPENDENCY_FAILED";
  return "BUILDER_UNKNOWN_FAILED";
};
const env = { ...process.env };
// The desktop process can inherit a host-specific PSModulePath.  Passing that
// through Node to Windows PowerShell may hide built-in modules (for example
// Get-FileHash), so let PowerShell reconstruct its native default module path.
if (process.platform === "win32") delete env.PSModulePath;
if (existsSync(join(nsisDir, "Bin", "makensis.exe"))) env.ELECTRON_BUILDER_NSIS_DIR = nsisDir;
if (existsSync(join(nsisResourcesDir, "plugins"))) env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = nsisResourcesDir;
if (existsSync(sevenZip)) env.ELECTRON_BUILDER_7ZIP_PATH = sevenZip;

const quoteCmdArg = value => {
  const stringValue = String(value);
  if (!/[\s"]/.test(stringValue)) return stringValue;
  return `"${stringValue.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
};

const run = (stage, command, args, commandEnv = env) => new Promise((resolvePromise, reject) => {
  const simulatedFailureStage = process.env.AIVS_PACKAGE_TEST_STAGE_FAILURE;
  const simulatedFailureIndex = packageRunStages.indexOf(simulatedFailureStage);
  const stageIndex = packageRunStages.indexOf(stage);
  if (process.env.AIVS_PACKAGE_TEST_SIMULATE_COMMANDS === "true") {
    if (simulatedFailureStage === stage) {
      const error = new Error(stageFailureCodes[stage] ?? "BUILDER_UNKNOWN_FAILED");
      error.failureStage = stage;
      reject(error);
    } else resolvePromise();
    return;
  }
  if (simulatedFailureIndex >= 0 && stageIndex >= 0 && stageIndex < simulatedFailureIndex) {
    resolvePromise();
    return;
  }
  if (simulatedFailureStage === stage) {
    const error = new Error(stageFailureCodes[stage] ?? "BUILDER_UNKNOWN_FAILED");
    error.failureStage = stage;
    reject(error);
    return;
  }
  const usesCmd = process.platform === "win32" && command !== process.execPath && !command.toLowerCase().endsWith(".exe");
  // 直接以 node 调脚本时 PATH 不含 node_modules/.bin（pnpm run 才注入）——
  // 裸命令名在 cmd /c 下报"不是内部或外部命令"。这里解析到 .bin 绝对路径。
  const resolveBin = name => {
    const localShim = join(desktopDir, "node_modules", ".bin", name);
    if (existsSync(localShim + ".cmd")) return localShim + ".cmd";
    if (existsSync(localShim)) return localShim;
    return name;
  };
  const executable = usesCmd ? process.env.ComSpec : command;
  const commandArgs = usesCmd
    ? ["/d", "/s", "/c", [resolveBin(command) === command ? command + ".cmd" : resolveBin(command), ...args].map(quoteCmdArg).join(" ")]
    : args;
  const child = execFile(executable, commandArgs, { cwd: desktopDir, env: commandEnv, windowsHide: true }, (error, stdout, stderr) => {
    if (error) {
      error.failureStage = stage;
      // 分类前落原始输出：错误码只报分类结果，现场（config 校验/资源缺失等）
      // 无原始输出无从定位。
      process.stderr.write(`[package-win] stage=${stage} failed; stdout:\n${stdout}\nstderr:\n${stderr}\n`);
      if (stage === "package_verify") {
        const code = [error.message, stdout, stderr]
          .flatMap(value => String(value ?? "").match(/[A-Z][A-Z0-9_]+/g) ?? [])
          .find(value => packageVerifyCodes.has(value));
        if (code) error.safeCode = code;
      }
      if (stage === "electron_builder") error.builderCode = classifyBuilderFailure(error, stdout, stderr);
      reject(error);
    } else resolvePromise();
  });
});

if (existsSync(packageOutputDir)) throw new Error("Package output directory already exists; choose a new AIVS_PACKAGE_OUTPUT_ROOT");
if (existsSync(packageReport)) throw new Error("Package report already exists; choose a new AIVS_PACKAGE_REPORT");
if (process.env.AIVS_PACKAGE_TEST_CAPTURE_CONFIG) {
  const capture = process.env.AIVS_PACKAGE_TEST_CAPTURE_CONFIG;
  if (!isAbsolute(capture) || existsSync(capture)) throw new Error("AIVS_PACKAGE_TEST_CAPTURE_CONFIG must be a new absolute file");
  mkdirSync(dirname(capture), { recursive: true });
  writeFileSync(capture, `${JSON.stringify({ schema_version: 1, builder_config: builderConfig, extra_resources: resourceEntries }, null, 2)}\n`, "utf8");
  process.exit(0);
}
mkdirSync(dirname(packageReport), { recursive: true });
let currentStage = "initializing";
const writePackageReport = (status, failureCode = null, installerPath = null, failureStage = null, stage = currentStage) => writeFileSync(packageReport, `${JSON.stringify({
  schema_version: 1,
  status,
  package_root: packageRoot,
  unpacked_root: join(packageOutputDir, "win-unpacked"),
  output_root: packageOutputDir,
  ...(installerPath ? { installer_path: installerPath } : {}),
  ...(failureCode ? { failure_code: failureCode } : {}),
  ...(failureStage ? { failure_stage: failureStage } : {}),
  ...(status === "building" ? { current_stage: stage } : {}),
  created_at: new Date().toISOString()
}, null, 2)}\n`, "utf8");
const enterStage = stage => {
  currentStage = stage;
  writePackageReport("building", null, null, null, stage);
};
writePackageReport("building", null, null, null, currentStage);

try {
  const testBuilderFailure = process.env.AIVS_PACKAGE_TEST_BUILDER_FAILURE;
  if (testBuilderFailure && builderFailureCodes.has(testBuilderFailure)) {
    enterStage("electron_builder");
    const error = new Error(testBuilderFailure);
    error.failureStage = "electron_builder";
    throw error;
  }
  if (process.env.AIVS_PACKAGE_TEST_SIMULATE_BUILD === "true") {
    enterStage("electron_builder");
    // Test-only seam: creates no source-derived files and never runs in a real package.
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageOutputDir, "VortexCut-Setup-0.0.1-x64.exe"), "test installer", "utf8");
  } else {
    writeFileSync(builderConfigPath, `${JSON.stringify(builderConfig, null, 2)}\n`, "utf8");
    enterStage("sidecar_build");
    await run("sidecar_build", "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(workspaceRoot, "tools", "packaging", "build-sidecar.ps1"), "-OutputRoot", packageResourcesRoot]);
    enterStage("bootstrap");
    await run("bootstrap", "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(workspaceRoot, "tools", "packaging", "bootstrap-windows.ps1"), "-PreflightOnly", "-ResourceRoot", packageResourcesRoot]);
    enterStage("builder_prepare");
    await run("builder_prepare", process.execPath, ["scripts/prepare-electron-builder.mjs"]);
    enterStage("desktop_build");
    await run("desktop_build", "pnpm", ["build"]);
    enterStage("electron_builder");
    await run("electron_builder", "electron-builder", [
      "--win", "nsis", "--config", builderConfigPath,
      `--config.directories.output=${packageOutputDir}`
    ]);
  }
  const installer = readdirSync(packageOutputDir, { withFileTypes: true }).find(entry => (
    entry.isFile() && /^VortexCut-Setup-.+-x64\.exe$/i.test(entry.name)
  ));
  if (!installer) throw new Error("PACKAGE_INSTALLER_MISSING");
  env.AIVS_PACKAGE_DIR = packageRoot;
  env.AIVS_PACKAGE_REPORT = packageReport;
  enterStage("package_verify");
  const testPackageVerify = process.env.AIVS_PACKAGE_TEST_PACKAGE_VERIFY;
  if (testPackageVerify && testPackageVerify !== "pass") {
    const error = new Error(packageVerifyCodes.has(testPackageVerify) ? testPackageVerify : "PACKAGE_COMPONENT_VERIFY_FAILED");
    error.failureStage = "package_verify";
    throw error;
  }
  if (testPackageVerify !== "pass") {
    const verificationEnv = { ...env };
    delete verificationEnv.AIVS_PACKAGE_REPORT;
    await run("package_verify", process.execPath, ["scripts/verify-package.mjs"], verificationEnv);
  }
  writePackageReport("built", null, join(packageOutputDir, installer.name));
  console.log("PACKAGE_BUILT");
} catch (error) {
  const stage = error?.failureStage ?? currentStage;
  const code = stage === "package_verify"
    ? (packageVerifyCodes.has(error?.message) ? error.message
      : packageVerifyCodes.has(error?.safeCode) ? error.safeCode
        : "PACKAGE_COMPONENT_VERIFY_FAILED")
    : stage === "electron_builder"
      ? (builderFailureCodes.has(error?.message) ? error.message
        : builderFailureCodes.has(error?.builderCode) ? error.builderCode
          : "BUILDER_UNKNOWN_FAILED")
      : stageFailureCodes[stage] ?? "BUILDER_UNKNOWN_FAILED";
  writePackageReport("failed", code, null, stage);
  throw new Error(code);
} finally {
  rmSync(packageResourcesRoot, { recursive: true, force: true });
}
