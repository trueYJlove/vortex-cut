import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const defaultReport = join(root, "../../build/reports/windows-package-latest.json");
const reportPath = process.env.AIVS_PACKAGE_REPORT ?? defaultReport;
let reportedPackageDir;
if (existsSync(reportPath)) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.schema_version !== 1 || report.status !== "built" || typeof report.package_root !== "string") {
    throw new Error(`安装包报告不是可验证的已完成本次产物: ${reportPath}`);
  }
  reportedPackageDir = resolve(report.package_root);
}
const packageDir = resolve(reportedPackageDir ?? process.env.AIVS_PACKAGE_DIR ?? "");
if (!packageDir || packageDir === root) {
  throw new Error(`未找到本次 Windows 安装包产物报告或 AIVS_PACKAGE_DIR: ${reportPath}`);
}
const required = [
  "core/aivs-core/aivs-core.exe",
  "ffmpeg/win-x64/ffmpeg.exe",
  "ffmpeg/win-x64/ffprobe.exe",
  "licenses/THIRD_PARTY_NOTICES.txt",
  "manifests/components.json",
  "model-manifests"
];
const missing = required.filter(relative => !existsSync(join(packageDir, relative)));
if (missing.length) {
  console.error("缺少打包组件:\n" + missing.join("\n"));
  process.exit(1);
}

const manifestPath = join(packageDir, "manifests/components.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!Array.isArray(manifest.components)) throw new Error("components.json 缺少 components 数组");
const releaseBlocked = manifest.release_blocked_until_pinned === true;
const isPinnedSha256 = value => /^[0-9a-f]{64}$/i.test(String(value));
for (const component of manifest.components) {
  if (!component.path || !component.sha256) throw new Error("组件清单必须包含 path 和 sha256");
  if (typeof component.license !== "string" || !component.license.trim()) throw new Error("组件清单必须包含许可证信息: " + component.path);
  const filePath = join(packageDir, component.path);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) continue;
  if (!isPinnedSha256(component.sha256)) {
    if (releaseBlocked) continue;
    throw new Error("release_blocked_until_pinned=false 时组件必须使用 64 位 SHA-256: " + component.path);
  }
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  if (hash.toLowerCase() !== String(component.sha256).toLowerCase()) throw new Error("组件哈希不匹配: " + component.path);
}
console.log("package verify passed: Sidecar, FFmpeg, FFprobe, licenses and component manifest are present");

const modelManifestDir = join(packageDir, "model-manifests");
const modelManifestFiles = readdirSync(modelManifestDir).filter(name => name.endsWith(".json"));
if (!modelManifestFiles.length) throw new Error("model-manifests 目录必须包含版本化 JSON manifest");
if (existsSync(join(packageDir, "models"))) throw new Error("模型权重目录不得进入安装包");
const weightPattern = /\.(?:bin|onnx|pt|pth|safetensors|ckpt)$/i;
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
  const value = JSON.parse(readFileSync(join(modelManifestDir, name), "utf8"));
  if (value.manifest_version === undefined || value.model_id === undefined || value.provider === undefined || value.revision === undefined) {
    throw new Error("模型 manifest 缺少版本、模型 ID、provider 或 revision: " + name);
  }
  if (Object.prototype.hasOwnProperty.call(value, "installed_path") || Object.prototype.hasOwnProperty.call(value, "install_dir")) {
    throw new Error("安装包 manifest 不得包含模型安装路径: " + name);
  }
  if (!value.license || typeof value.license.id !== "string" || typeof value.license.name !== "string") {
    throw new Error("模型 manifest 缺少许可证信息: " + name);
  }
  if (!isPinnedSha256(value.sha256) || !Number.isInteger(value.size_bytes) || value.size_bytes <= 0 || !Number.isInteger(value.installed_size_bytes) || value.installed_size_bytes <= 0) {
    throw new Error("模型 manifest 的大小或 SHA-256 无效: " + name);
  }
  if (!Array.isArray(value.files) || value.files.some(file => {
    const relativePath = file?.path ?? file?.relative_path;
    return !isSafeRelativePath(relativePath)
      || !isPinnedSha256(file?.sha256)
      || !Number.isInteger(file?.size_bytes)
      || file.size_bytes <= 0;
  })) {
    throw new Error("模型 manifest 的文件路径、大小或 SHA-256 无效: " + name);
  }
}

const packagedWeightFiles = findPackagedWeightFiles(packageDir);
if (packagedWeightFiles.length) throw new Error("安装包资源目录不得包含模型权重文件: " + packagedWeightFiles.join(", "));
console.log("package verify passed: ASR model manifests present and model weights excluded");
