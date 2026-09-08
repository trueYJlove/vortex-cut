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
} });
function fail(message) { console.error(message); process.exit(2); }
if (!values.fixtures || !values.output) fail("--fixtures and --output are required");
// Refuse unsupported scene recipes rather than measuring a short clip under a misleading Fxx label.
if (values.scenarios !== "F01") fail("Only F01/basic-cfr scene is implemented. F02–F07 scene assembly is pending; do not substitute F01.");
for (const key of ["runs", "seeks", "playback-seconds"]) {
  const value = Number(values[key]); if (!Number.isSafeInteger(value) || value < 1 || value > 3600) fail(`invalid --${key}`);
}
const output = resolve(values.output);
if (existsSync(output)) fail("Output must not exist; historical evidence will not be overwritten");
const fixtures = resolve(values.fixtures);
const manifest = JSON.parse(readFileSync(resolve(fixtures, "manifest.json"), "utf8"));
if (!manifest.fixtures.F01) fail("F01 fixture missing");
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
writeFileSync(resolve(output, "run-config.json"), JSON.stringify({ ...values, fixtures: undefined, output: undefined,
  baseline_status: values.smoke ? "smoke-only-not-G0" : "partial-B00-not-G0", commit: git(["rev-parse", "HEAD"]),
  code_fingerprint: codeFingerprint, dirty_files: git(["status", "--short"]), node: process.version, fixture: manifest.fixtures.F01 }, null, 2));
const cli = resolve(root, "apps/desktop/node_modules/@playwright/test/cli.js");
const result = spawnSync(process.execPath, [cli, "test", "--config=tests/playwright.config.ts", "performance-editor.spec.ts", "--workers=1"], {
  cwd: resolve(root, "apps/desktop"), stdio: "inherit", env: { ...process.env,
    AIVS_PERF_RUN: "1", AIVS_PERF_FIXTURES: fixtures, AIVS_PERF_RESULT: output,
    AIVS_PERF_RUNS: values.runs, AIVS_PERF_SEEKS: values.seeks,
    AIVS_PERF_PLAY_SECONDS: values["playback-seconds"], AIVS_PERF_SMOKE: String(values.smoke),
  }, timeout: ((2 * Number(values.runs) + 1) * (Number(values["playback-seconds"]) + Number(values.seeks) * 10 + 150) + 300) * 1000,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
