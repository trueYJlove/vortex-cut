import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const defaultRelease = join(root, "release");
const defaultPackageDir = existsSync(join(defaultRelease, "win-unpacked", "resources"))
  ? join(defaultRelease, "win-unpacked", "resources")
  : defaultRelease;
const packageDir = resolve(process.env.AIVS_PACKAGE_DIR ?? defaultPackageDir);
const required = [
  "core/aivs-core/aivs-core.exe",
  "ffmpeg/win-x64/ffmpeg.exe",
  "ffmpeg/win-x64/ffprobe.exe",
  "licenses/THIRD_PARTY_NOTICES.txt",
  "manifests/components.json"
];
const missing = required.filter(relative => !existsSync(join(packageDir, relative)));
if (missing.length) { console.error("缺少打包组件:\n" + missing.join("\n")); process.exit(1); }
const manifestPath = join(packageDir, "manifests/components.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!Array.isArray(manifest.components)) throw new Error("components.json 缺少 components 数组");
const releaseBlocked = manifest.release_blocked_until_pinned === true;
const isPinnedSha256 = value => /^[0-9a-f]{64}$/i.test(String(value));
for (const component of manifest.components) {
  if (!component.path || !component.sha256) throw new Error("组件清单必须包含 path 和 sha256");
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
