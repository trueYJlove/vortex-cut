import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const VERIFY_CODES = new Set([
  "PACKAGE_REPORT_UNREADABLE", "PACKAGE_REPORT_INVALID", "PACKAGE_REQUIRED_SIDECAR_MISSING", "PACKAGE_REQUIRED_FFMPEG_MISSING",
  "PACKAGE_REQUIRED_LICENSE_MISSING", "PACKAGE_REQUIRED_COMPONENT_MANIFEST_MISSING", "PACKAGE_REQUIRED_MODEL_MANIFEST_MISSING",
  "PACKAGE_REQUIRED_RECIPE_MISSING", "PACKAGE_REQUIRED_PLATFORM_PRESET_MISSING", "PACKAGE_REQUIRED_RENDITION_PRESET_MISSING",
  "PACKAGE_REQUIRED_FONT_MISSING", "PACKAGE_COMPONENT_MANIFEST_INVALID",
  "PACKAGE_COMPONENT_LICENSE_INVALID", "PACKAGE_COMPONENT_PIN_INVALID", "PACKAGE_COMPONENT_HASH_MISMATCH", "PACKAGE_FONT_BUNDLE_INVALID",
  "PACKAGE_FONT_BUNDLE_FILE_MISSING", "PACKAGE_FONT_BUNDLE_HASH_MISMATCH", "PACKAGE_CAPTION_PRESETS_INVALID", "PACKAGE_CAPTION_STYLES_INVALID",
  "PACKAGE_FFMPEG_FILTER_INVALID", "PACKAGE_MODEL_MANIFEST_INVALID", "PACKAGE_MODEL_WEIGHTS_EMBEDDED",
  "PACKAGE_RECIPE_MANIFEST_INVALID", "PACKAGE_VERIFY_UNEXPECTED"
]);
const fail = code => { throw new Error(code); };
const safeCode = error => VERIFY_CODES.has(String(error?.message ?? "")) ? error.message : "PACKAGE_VERIFY_UNEXPECTED";
process.on("uncaughtException", error => { console.error(safeCode(error)); process.exit(1); });

const root = resolve(process.cwd());
const defaultReport = join(root, "../../build/reports/windows-package-latest.json");
const explicitPackageDir = process.env.AIVS_PACKAGE_DIR;
// A caller that passes a concrete package directory must not be redirected to
// an unrelated legacy report left by a previous packaging run.
const reportPath = process.env.AIVS_PACKAGE_REPORT ?? (explicitPackageDir ? undefined : defaultReport);
let reportedPackageDir;
if (reportPath && existsSync(reportPath)) {
  let report;
  try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { fail("PACKAGE_REPORT_UNREADABLE"); }
  if (report.schema_version !== 1 || report.status !== "built" || typeof report.package_root !== "string") {
    fail("PACKAGE_REPORT_INVALID");
  }
  reportedPackageDir = resolve(report.package_root);
}
const packageDir = resolve(reportedPackageDir ?? process.env.AIVS_PACKAGE_DIR ?? "");
if (!packageDir || packageDir === root) {
  fail("PACKAGE_REPORT_INVALID");
}
const required = [
  "core/aivs-core/aivs-core.exe",
  "ffmpeg/win-x64/ffmpeg.exe",
  "ffmpeg/win-x64/ffprobe.exe",
  "licenses/THIRD_PARTY_NOTICES.txt",
  "manifests/components.json",
  "model-manifests",
  "recipes/manifest.json",
  "platform-presets/manifest.json",
  "platform-presets/generic.json",
  "renditions/manifest.json",
  "renditions/portrait-9x16-v1.json",
  "renditions/landscape-16x9-v1.json",
  "fonts/bundle.json",
  "fonts/caption-presets.json",
  "fonts/caption-styles-v2.json",
  "fonts/noto-sans-sc/NotoSansCJKsc-VF.ttf",
  "fonts/noto-sans-sc/OFL.txt"
];
const missing = required.filter(relative => !existsSync(join(packageDir, relative)));
if (missing.length) {
  const code = missing.some(item => item.startsWith("core/")) ? "PACKAGE_REQUIRED_SIDECAR_MISSING"
    : missing.some(item => item.startsWith("ffmpeg/")) ? "PACKAGE_REQUIRED_FFMPEG_MISSING"
      : missing.some(item => item.startsWith("licenses/")) ? "PACKAGE_REQUIRED_LICENSE_MISSING"
        : missing.some(item => item.startsWith("manifests/")) ? "PACKAGE_REQUIRED_COMPONENT_MANIFEST_MISSING"
          : missing.some(item => item.startsWith("model-manifests")) ? "PACKAGE_REQUIRED_MODEL_MANIFEST_MISSING"
            : missing.some(item => item.startsWith("recipes/")) ? "PACKAGE_REQUIRED_RECIPE_MISSING"
              : missing.some(item => item.startsWith("platform-presets/")) ? "PACKAGE_REQUIRED_PLATFORM_PRESET_MISSING"
                : missing.some(item => item.startsWith("renditions/")) ? "PACKAGE_REQUIRED_RENDITION_PRESET_MISSING"
              : "PACKAGE_REQUIRED_FONT_MISSING";
  fail(code);
}

const manifestPath = join(packageDir, "manifests/components.json");
let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { fail("PACKAGE_COMPONENT_MANIFEST_INVALID"); }
if (!Array.isArray(manifest.components)) fail("PACKAGE_COMPONENT_MANIFEST_INVALID");
const releaseBlocked = manifest.release_blocked_until_pinned === true;
const isPinnedSha256 = value => /^[0-9a-f]{64}$/i.test(String(value));
for (const component of manifest.components) {
  if (!component.path || !component.sha256) fail("PACKAGE_COMPONENT_MANIFEST_INVALID");
  if (typeof component.license !== "string" || !component.license.trim()) fail("PACKAGE_COMPONENT_LICENSE_INVALID");
  const filePath = join(packageDir, component.path);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) continue;
  if (!isPinnedSha256(component.sha256)) {
    if (releaseBlocked) continue;
    fail("PACKAGE_COMPONENT_PIN_INVALID");
  }
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  if (hash.toLowerCase() !== String(component.sha256).toLowerCase()) fail("PACKAGE_COMPONENT_HASH_MISMATCH");
}
console.log("package verify passed: Sidecar, FFmpeg, FFprobe, licenses and component manifest are present");

let fontBundle;
try { fontBundle = JSON.parse(readFileSync(join(packageDir, "fonts/bundle.json"), "utf8")); } catch { fail("PACKAGE_FONT_BUNDLE_INVALID"); }
if (!Number.isInteger(fontBundle.font_bundle_version) || fontBundle.font_bundle_version < 1 || typeof fontBundle.file !== "string" || typeof fontBundle.license_file !== "string" || !isPinnedSha256(fontBundle.sha256)) {
  fail("PACKAGE_FONT_BUNDLE_INVALID");
}
const fontPath = join(packageDir, "fonts", fontBundle.file);
const fontLicensePath = join(packageDir, "fonts", fontBundle.license_file);
if (!existsSync(fontPath) || !statSync(fontPath).isFile()) fail("PACKAGE_FONT_BUNDLE_FILE_MISSING");
if (!existsSync(fontLicensePath) || !statSync(fontLicensePath).isFile()) fail("PACKAGE_FONT_BUNDLE_FILE_MISSING");
const fontHash = createHash("sha256").update(readFileSync(fontPath)).digest("hex");
if (fontHash.toLowerCase() !== fontBundle.sha256.toLowerCase()) fail("PACKAGE_FONT_BUNDLE_HASH_MISMATCH");
let captionPresets;
try { captionPresets = JSON.parse(readFileSync(join(packageDir, "fonts/caption-presets.json"), "utf8")); } catch { fail("PACKAGE_CAPTION_PRESETS_INVALID"); }
if (!Number.isInteger(captionPresets.preset_version) || captionPresets.preset_version < 1 || !captionPresets.presets || typeof captionPresets.presets !== "object") fail("PACKAGE_CAPTION_PRESETS_INVALID");
let captionStyles;
try { captionStyles = JSON.parse(readFileSync(join(packageDir, "fonts/caption-styles-v2.json"), "utf8")); } catch { fail("PACKAGE_CAPTION_STYLES_INVALID"); }
const expectedRenditions = ["portrait-9x16-v1", "landscape-16x9-v1"];
const expectedCaptionPresets = ["default-bottom", "game-safe-bottom", "high-contrast"];
if (captionStyles?.schema_version !== 1 || captionStyles?.caption_style_version !== 2
  || !captionStyles.renditions || typeof captionStyles.renditions !== "object"
  || Object.keys(captionStyles.renditions).length !== expectedRenditions.length
  || expectedRenditions.some(id => {
    const rendition = captionStyles.renditions[id];
    return !rendition || typeof rendition !== "object" || !rendition.play_res || typeof rendition.play_res !== "object"
      || !Number.isInteger(rendition.play_res.width) || !Number.isInteger(rendition.play_res.height)
      || !rendition.presets || typeof rendition.presets !== "object"
      || Object.keys(rendition.presets).length !== expectedCaptionPresets.length
      || expectedCaptionPresets.some(presetId => !rendition.presets[presetId] || typeof rendition.presets[presetId] !== "object");
  })) fail("PACKAGE_CAPTION_STYLES_INVALID");

const ffmpegPath = join(packageDir, "ffmpeg/win-x64/ffmpeg.exe");
let filterOutput;
try { filterOutput = execFileSync(ffmpegPath, ["-hide_banner", "-filters"], { encoding: "utf8", windowsHide: true }); } catch { fail("PACKAGE_FFMPEG_FILTER_INVALID"); }
if (!/^\s*\.\.\s+ass\s+/m.test(filterOutput)) fail("PACKAGE_FFMPEG_FILTER_INVALID");
if (!/^\s*\.\.\s+subtitles\s+/m.test(filterOutput)) fail("PACKAGE_FFMPEG_FILTER_INVALID");
console.log("package verify passed: font bundle, license, presets and FFmpeg subtitle filters are present");

const modelManifestDir = join(packageDir, "model-manifests");
const modelManifestFiles = readdirSync(modelManifestDir).filter(name => name.endsWith(".json"));
if (!modelManifestFiles.length) fail("PACKAGE_MODEL_MANIFEST_INVALID");
if (existsSync(join(packageDir, "models"))) fail("PACKAGE_MODEL_WEIGHTS_EMBEDDED");
const weightPattern = /\.(?:bin|onnx|pt|pth|safetensors|ckpt)$/i;
const declaredModelWeights = new Set();
const isSafeRelativePath = value => {
  if (typeof value !== "string" || !value || value.trim() !== value || value.includes("\0")) return false;
  if (/^(?:[A-Za-z]:|[\\/])/.test(value) || value.includes(":")) return false;
  return !value.split(/[\\/]+/).some(segment => segment === ".." || !segment);
};
const findPackagedWeightFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const entryPath = join(directory, entry.name);
  if (entry.isDirectory()) return findPackagedWeightFiles(entryPath);
  return entry.isFile() && weightPattern.test(entry.name) ? [entryPath] : [];
});
for (const name of modelManifestFiles) {
  let value;
  try { value = JSON.parse(readFileSync(join(modelManifestDir, name), "utf8")); } catch { fail("PACKAGE_MODEL_MANIFEST_INVALID"); }
  if (value.manifest_version === undefined || value.model_id === undefined || value.provider === undefined || value.revision === undefined) {
    fail("PACKAGE_MODEL_MANIFEST_INVALID");
  }
  if (Object.prototype.hasOwnProperty.call(value, "installed_path") || Object.prototype.hasOwnProperty.call(value, "install_dir")) {
    fail("PACKAGE_MODEL_MANIFEST_INVALID");
  }
  if (!value.license || typeof value.license.id !== "string" || typeof value.license.name !== "string") {
    fail("PACKAGE_MODEL_MANIFEST_INVALID");
  }
  if (!isPinnedSha256(value.sha256) || !Number.isInteger(value.size_bytes) || value.size_bytes <= 0 || !Number.isInteger(value.installed_size_bytes) || value.installed_size_bytes <= 0) {
    fail("PACKAGE_MODEL_MANIFEST_INVALID");
  }
  if (!Array.isArray(value.files) || value.files.some(file => {
    const relativePath = file?.path ?? file?.relative_path;
    return !isSafeRelativePath(relativePath)
      || !isPinnedSha256(file?.sha256)
      || !Number.isInteger(file?.size_bytes)
      || file.size_bytes <= 0;
  })) {
    fail("PACKAGE_MODEL_MANIFEST_INVALID");
  }
  for (const file of value.files) declaredModelWeights.add(`${String(file.sha256).toLowerCase()}:${file.size_bytes}`);
}

const packagedWeightFiles = findPackagedWeightFiles(packageDir);
const embeddedDeclaredWeights = packagedWeightFiles.filter(path => {
  const size = statSync(path).size;
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  return declaredModelWeights.has(`${hash}:${size}`);
});
if (embeddedDeclaredWeights.length) fail("PACKAGE_MODEL_WEIGHTS_EMBEDDED");
console.log("package verify passed: ASR model manifests present and model weights excluded");

let recipeManifest;
try { recipeManifest = JSON.parse(readFileSync(join(packageDir, "recipes/manifest.json"), "utf8")); } catch { fail("PACKAGE_RECIPE_MANIFEST_INVALID"); }
if (!Array.isArray(recipeManifest.recipes) || !recipeManifest.recipes.length || recipeManifest.recipes.some(id => typeof id !== "string" || !existsSync(join(packageDir, "recipes", `${id}.json`)))) fail("PACKAGE_RECIPE_MANIFEST_INVALID");
console.log("package verify passed: AI recipe manifest and recipe files are present");
