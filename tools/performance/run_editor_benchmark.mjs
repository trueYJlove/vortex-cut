import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({ options: {
  scenarios: { type: "string", default: "F01" }, fixtures: { type: "string" }, output: { type: "string" },
  runs: { type: "string", default: "5" }, seeks: { type: "string", default: "100" },
  "playback-seconds": { type: "string", default: "300" }, "smoke": { type: "boolean", default: false },
  seed: { type: "string", default: "20260908" },
} });
function fail(message) { console.error(message); process.exit(2); }
if (!values.fixtures || !values.output) fail("--fixtures and --output are required");
// Scene recipes are declared by the spec (per-scenario test); the runner refuses
// labels it does not know instead of measuring something else under an Fxx name.
const KNOWN_SCENES = ["F01", "F02", "F04", "F07"];
const scenes = values.scenarios.split(",").map(scene => scene.trim()).filter(Boolean);
if (!scenes.length || scenes.some(scene => !KNOWN_SCENES.includes(scene))) {
  fail(`Implemented complete-App scenes: ${KNOWN_SCENES.join(", ")}. F03/F05/F06 scene assembly is pending; do not substitute another scene.`);
}
for (const key of ["runs", "seeks", "playback-seconds"]) {
  const value = Number(values[key]); if (!Number.isSafeInteger(value) || value < 1 || value > 3600) fail(`invalid --${key}`);
}
{
  const value = Number(values.seed);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) fail("invalid --seed");
}
const output = resolve(values.output);
if (existsSync(output)) fail("Output must not exist; historical evidence will not be overwritten");
const fixtures = resolve(values.fixtures);
const manifest = JSON.parse(readFileSync(resolve(fixtures, "manifest.json"), "utf8"));
const manifestVersion = manifest.schema_version ?? 1;
if (manifestVersion < 2 && scenes.some(scene => scene !== "F01")) {
  fail("Multi-scene runs require a schema_version 2 fixture manifest (regenerate with make_fixtures.py)");
}
for (const scene of scenes) {
  if (!manifest.fixtures[scene]) fail(`Fixture manifest missing ${scene} media`);
}
if (!existsSync(resolve(root, "apps/desktop/out/main/index.cjs"))) fail("Build missing. Build explicitly with VITE_AIVS_PERF=1 first.");
mkdirSync(output, { recursive: true });
const git = args => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("Cannot fingerprint checkout");
  return result.stdout.trim();
};
// Include untracked implementation as well as tracked files, not only a dirty flag.
const hash = createHash("sha256");
for (const file of git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "apps", "services", "tools", "packages", "pnpm-lock.yaml"]).split("\0").filter(Boolean).sort()) {
  hash.update(file).update("\0");
  hash.update(existsSync(resolve(root, file)) ? readFileSync(resolve(root, file)) : "<deleted>");
}
const codeFingerprint = hash.digest("hex");
writeFileSync(resolve(output, "run-config.json"), JSON.stringify({ ...values, scenarios: scenes, fixtures: undefined, output: undefined,
  baseline_status: values.smoke ? "smoke-only-not-G0" : "partial-B00-not-G0", commit: git(["rev-parse", "HEAD"]),
  code_fingerprint: codeFingerprint, dirty_files: git(["status", "--short"]), node: process.version, fixtures_used: scenes.map(scene => manifest.fixtures[scene]) }, null, 2));
const cli = resolve(root, "apps/desktop/node_modules/@playwright/test/cli.js");
const result = spawnSync(process.execPath, [cli, "test", "--config=tests/playwright.config.ts", "performance-editor.spec.ts", "--workers=1", `-g`, scenes.map(scene => `B00 complete editor ${scene}`).join("|")], {
  cwd: resolve(root, "apps/desktop"), stdio: "inherit", env: { ...process.env,
    AIVS_PERF_RUN: "1", AIVS_PERF_FIXTURES: fixtures, AIVS_PERF_RESULT: output,
    AIVS_PERF_RUNS: values.runs, AIVS_PERF_SEEKS: values.seeks,
    AIVS_PERF_PLAY_SECONDS: values["playback-seconds"], AIVS_PERF_SMOKE: String(values.smoke),
    AIVS_PERF_SEED: String(values.seed), AIVS_PERF_SCENES: scenes.join(","),
  }, timeout: (scenes.length * (2 * Number(values.runs) + 1) * (Number(values["playback-seconds"]) + Number(values.seeks) * 10 + 150) + 300) * 1000,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
