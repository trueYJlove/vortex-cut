import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const desktop = resolve(__dirname, "..");
const packageWin = readFileSync(resolve(desktop, "scripts/package-win.mjs"), "utf8");
const realVerify = readFileSync(resolve(desktop, "scripts/verify-package-real.mjs"), "utf8");
const verifyScript = resolve(desktop, "scripts/verify-package-real.mjs");
const packageVerifyScript = resolve(desktop, "scripts/verify-package.mjs");
const packageWinScript = resolve(desktop, "scripts/package-win.mjs");

function temporaryRoot() { return mkdtempSync(join(tmpdir(), "aivideo-package-script-test-")); }

function runVerifier(root: string, environment: Record<string, string>) {
  const evidenceRoot = join(root, "evidence");
  const child = spawnSync(process.execPath, [verifyScript], {
    cwd: desktop,
    env: { ...process.env, AIVS_PACKAGE_REAL_EVIDENCE_ROOT: evidenceRoot, ...environment },
    encoding: "utf8",
    windowsHide: true
  });
  const latest = JSON.parse(readFileSync(join(evidenceRoot, "latest.json"), "utf8"));
  return { child, latest };
}

function realFixtures(root: string) {
  const model = join(root, "model"); const media = join(root, "fixture.mp4");
  mkdirSync(model, { recursive: true }); writeFileSync(media, "fixture");
  return { AIVS_E2E_MODEL_DIR: model, AIVS_E2E_MIXED_VIDEO: media };
}

function builtReport(root: string) {
  const resources = join(root, "package", "resources");
  const sidecar = join(resources, "core", "aivs-core", "aivs-core.exe");
  mkdirSync(join(resources, "manifests"), { recursive: true }); mkdirSync(join(resources, "core", "aivs-core"), { recursive: true });
  writeFileSync(sidecar, "controlled-sidecar");
  const sha256 = createHash("sha256").update(readFileSync(sidecar)).digest("hex");
  writeFileSync(join(resources, "manifests", "components.json"), JSON.stringify({ components: [{ path: "core/aivs-core/aivs-core.exe", sha256 }] }));
  const report = join(root, "report.json");
  writeFileSync(report, JSON.stringify({ schema_version: 1, status: "built", package_root: resources, unpacked_root: join(root, "package"), installer_path: sidecar }));
  return report;
}

function runPackageVerify(root: string, report: string) {
  return spawnSync(process.execPath, [packageVerifyScript], {
    cwd: desktop, env: { ...process.env, AIVS_PACKAGE_REPORT: report }, encoding: "utf8", windowsHide: true
  });
}

function runPackageWin(root: string, environment: Record<string, string>) {
  const output = join(root, "external-output");
  const report = join(root, "external-report.json");
  const child = spawnSync(process.execPath, [packageWinScript], {
    cwd: desktop,
    env: {
      ...process.env,
      AIVS_PACKAGE_OUTPUT_ROOT: output,
      AIVS_PACKAGE_REPORT: report,
      ...environment
    },
    encoding: "utf8",
    windowsHide: true
  });
  return { child, output, report };
}

describe("Windows 安装包验收脚本安全边界", () => {
  it("支持隔离的输出与报告路径，并拒绝覆盖现有目标", () => {
    expect(packageWin).toContain("AIVS_PACKAGE_OUTPUT_ROOT"); expect(packageWin).toContain("AIVS_PACKAGE_REPORT");
    expect(packageWin).toContain("must be an absolute, new output directory"); expect(packageWin).toContain("must be an absolute, new report file");
    expect(packageWin).toContain("Package output directory already exists"); expect(packageWin).toContain("Package report already exists");
  });

  it("为仓库外输出生成七组绝对资源来源，并保持固定安装包相对目标", () => {
    const root = temporaryRoot(); const capture = join(root, "builder-config.json");
    const { child, output } = runPackageWin(root, { AIVS_PACKAGE_TEST_CAPTURE_CONFIG: capture });
    expect(child.status).toBe(0);
    const captured = JSON.parse(readFileSync(capture, "utf8"));
    expect(captured.builder_config).toMatchObject({
      appId: "com.aivideo.studio",
      productName: "AIVideo Studio",
      files: ["out", "package.json"]
    });
    expect(captured.builder_config.extends).toBeUndefined();
    expect(captured.extra_resources).toHaveLength(7);
    expect(captured.extra_resources.map((entry: { to: string }) => entry.to)).toEqual([
      "core/aivs-core", "ffmpeg/win-x64", "licenses", "manifests", "model-manifests", "recipes", "fonts"
    ]);
    for (const entry of captured.extra_resources as Array<{ from: string; to: string }>) {
      expect(entry.from).toMatch(/^[A-Za-z]:[\\/]/);
      expect(entry.from).toContain(`${resolve(desktop, "../..", "resources")}`);
      expect(entry.from.startsWith(output)).toBe(false);
    }
  });

  it("受控验证失败时报告保持 failed，只有验证通过才写 built", () => {
    const failingRoot = temporaryRoot();
    const failed = runPackageWin(failingRoot, {
      AIVS_PACKAGE_TEST_SIMULATE_BUILD: "true",
      AIVS_PACKAGE_TEST_PACKAGE_VERIFY: "fail"
    });
    expect(failed.child.status).toBe(1);
    expect(JSON.parse(readFileSync(failed.report, "utf8"))).toMatchObject({ status: "failed", failure_code: "PACKAGE_COMPONENT_VERIFY_FAILED", failure_stage: "package_verify" });

    const passingRoot = temporaryRoot();
    const passed = runPackageWin(passingRoot, {
      AIVS_PACKAGE_TEST_SIMULATE_BUILD: "true",
      AIVS_PACKAGE_TEST_PACKAGE_VERIFY: "pass"
    });
    expect(passed.child.status).toBe(0);
    expect(JSON.parse(readFileSync(passed.report, "utf8"))).toMatchObject({ status: "built", installer_path: expect.any(String) });
  });

  it("每个前置构建阶段失败都会写入独立安全码和阶段", () => {
    const cases = [
      ["sidecar_build", "SIDECAR_BUILD_FAILED"],
      ["bootstrap", "BOOTSTRAP_PREFLIGHT_FAILED"],
      ["builder_prepare", "BUILDER_PREPARE_FAILED"],
      ["desktop_build", "DESKTOP_BUILD_FAILED"]
    ];
    for (const [stage, code] of cases) {
      const root = temporaryRoot();
      const result = runPackageWin(root, { AIVS_PACKAGE_TEST_STAGE_FAILURE: stage });
      expect(result.child.status).toBe(1);
      expect(JSON.parse(readFileSync(result.report, "utf8"))).toMatchObject({ status: "failed", failure_stage: stage, failure_code: code });
    }
  });

  it("Builder 失败会写入离散安全类别、Electron Builder 阶段且不会写 built", () => {
    const cases = [
      "BUILDER_CONFIG_INVALID",
      "BUILDER_RESOURCE_CONFIG_INVALID",
      "BUILDER_SIGNING_FAILED",
      "BUILDER_NSIS_FAILED",
      "BUILDER_FILE_ACCESS_FAILED"
    ];
    for (const failure of cases) {
      const root = temporaryRoot();
      const result = runPackageWin(root, { AIVS_PACKAGE_TEST_BUILDER_FAILURE: failure });
      expect(result.child.status).toBe(1);
      expect(JSON.parse(readFileSync(result.report, "utf8"))).toMatchObject({ status: "failed", failure_stage: "electron_builder", failure_code: failure });
    }
  });

  it("package_verify 仅写 PACKAGE 具体码或安全回退，绝不写 BUILDER 码", () => {
    const concreteRoot = temporaryRoot();
    const concrete = runPackageWin(concreteRoot, {
      AIVS_PACKAGE_TEST_SIMULATE_BUILD: "true",
      AIVS_PACKAGE_TEST_PACKAGE_VERIFY: "PACKAGE_REQUIRED_FONT_MISSING"
    });
    expect(concrete.child.status).toBe(1);
    expect(JSON.parse(readFileSync(concrete.report, "utf8"))).toMatchObject({
      status: "failed", failure_stage: "package_verify", failure_code: "PACKAGE_REQUIRED_FONT_MISSING"
    });

    const unknownRoot = temporaryRoot();
    const unknown = runPackageWin(unknownRoot, {
      AIVS_PACKAGE_TEST_SIMULATE_BUILD: "true",
      AIVS_PACKAGE_TEST_PACKAGE_VERIFY: "unclassified"
    });
    expect(unknown.child.status).toBe(1);
    const report = JSON.parse(readFileSync(unknown.report, "utf8"));
    expect(report).toMatchObject({ status: "failed", failure_stage: "package_verify", failure_code: "PACKAGE_COMPONENT_VERIFY_FAILED" });
    expect(report.failure_code).not.toMatch(/^BUILDER_/);
  });

  it("报告读取前失败会写入 schema v2 安全码", () => {
    const root = temporaryRoot(); const { child, latest } = runVerifier(root, { ...realFixtures(root), AIVS_PACKAGE_REAL_TEST_DIRECT_VERIFY: "pass", AIVS_PACKAGE_REPORT: join(root, "missing.json") });
    expect(child.status).toBe(1); expect(child.stdout + child.stderr).toContain("PACKAGE_REPORT_UNREADABLE");
    expect(latest).toMatchObject({ schema_version: 2, status: "failed", code: "PACKAGE_REPORT_UNREADABLE", stage: "report_read" });
  });

  it("非法报告会写入 schema v2 安全码", () => {
    const root = temporaryRoot(); const report = join(root, "invalid.json"); writeFileSync(report, JSON.stringify({ schema_version: 99 }));
    const { child, latest } = runVerifier(root, { ...realFixtures(root), AIVS_PACKAGE_REAL_TEST_DIRECT_VERIFY: "pass", AIVS_PACKAGE_REPORT: report });
    expect(child.status).toBe(1); expect(child.stdout + child.stderr).toContain("PACKAGE_REPORT_INVALID");
    expect(latest).toMatchObject({ schema_version: 2, status: "failed", code: "PACKAGE_REPORT_INVALID", stage: "report_read" });
  });

  it("Electron 启动前注入失败会写入 schema v2 安全码", () => {
    const root = temporaryRoot(); const report = builtReport(root);
    const { child, latest } = runVerifier(root, { ...realFixtures(root), AIVS_PACKAGE_REAL_TEST_DIRECT_VERIFY: "pass", AIVS_PACKAGE_REPORT: report, AIVS_PACKAGE_REAL_TEST_FAIL_STAGE: "electron_launch" });
    expect(child.status).toBe(1); expect(child.stdout + child.stderr).toContain("ELECTRON_LAUNCH_FAILED");
    expect(latest).toMatchObject({ schema_version: 2, status: "failed", code: "ELECTRON_LAUNCH_FAILED", stage: "electron_launch" });
  });

  it("Electron 启动后 runtime 注入失败会写入 schema v2 安全码", () => {
    const root = temporaryRoot(); const report = builtReport(root);
    const { child, latest } = runVerifier(root, { ...realFixtures(root), AIVS_PACKAGE_REAL_TEST_DIRECT_VERIFY: "pass", AIVS_PACKAGE_REPORT: report, AIVS_PACKAGE_REAL_TEST_FAIL_STAGE: "electron_runtime" });
    expect(child.status).toBe(1); expect(child.stdout + child.stderr).toContain("ELECTRON_RUNTIME_FAILED");
    expect(latest).toMatchObject({ schema_version: 2, status: "failed", code: "ELECTRON_RUNTIME_FAILED", stage: "electron_runtime" });
  });

  it("同一 package root 的直接静态校验通过后继续进入 Electron 阶段", () => {
    const root = temporaryRoot(); const report = builtReport(root);
    const { child, latest } = runVerifier(root, { ...realFixtures(root), AIVS_PACKAGE_REPORT: report, AIVS_PACKAGE_REAL_TEST_DIRECT_VERIFY: "pass", AIVS_PACKAGE_REAL_TEST_FAIL_STAGE: "electron_launch" });
    expect(child.status).toBe(1); expect(child.stdout + child.stderr).toContain("ELECTRON_LAUNCH_FAILED");
    expect(latest).toMatchObject({ schema_version: 2, status: "failed", code: "ELECTRON_LAUNCH_FAILED", stage: "electron_launch" });
  });

  it("直接静态校验的具体 PACKAGE 码会写入安全证据且不进入真实验证", () => {
    const root = temporaryRoot(); const report = builtReport(root);
    const { child, latest } = runVerifier(root, { ...realFixtures(root), AIVS_PACKAGE_REPORT: report, AIVS_PACKAGE_REAL_TEST_DIRECT_VERIFY: "PACKAGE_REQUIRED_FONT_MISSING", AIVS_PACKAGE_REAL_TEST_FAIL_STAGE: "electron_launch" });
    expect(child.status).toBe(1); expect(child.stdout + child.stderr).toContain("PACKAGE_REQUIRED_FONT_MISSING");
    expect(latest).toMatchObject({ schema_version: 2, status: "failed", code: "PACKAGE_REQUIRED_FONT_MISSING", stage: "package_verify" });
  });

  it("直接静态校验未知输出回退固定码，且不泄漏报告环境", () => {
    const root = temporaryRoot(); const report = builtReport(root);
    const { child, latest } = runVerifier(root, { ...realFixtures(root), AIVS_PACKAGE_REPORT: report, AIVS_PACKAGE_REAL_TEST_DIRECT_VERIFY: "unknown", AIVS_PACKAGE_REAL_TEST_FAIL_STAGE: "electron_launch" });
    expect(child.status).toBe(1); expect(child.stdout + child.stderr).toContain("PACKAGE_COMPONENT_VERIFY_FAILED");
    expect(latest).toMatchObject({ schema_version: 2, status: "failed", code: "PACKAGE_COMPONENT_VERIFY_FAILED", stage: "package_verify" });
    expect(JSON.stringify(latest)).not.toContain(root);
  });

  it("preview 子阶段写入有限安全码和最小进度投影", () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["project_sync", "PREVIEW_PROJECT_SYNC_FAILED", { component_hash_verified: true }],
      ["ui", "PREVIEW_UI_NOT_READY", { component_hash_verified: true, preview_project_reset: true, preview_project_selected: true, preview_project_synced: true }],
      ["job_missing", "PREVIEW_JOB_NOT_CREATED", { component_hash_verified: true, preview_project_reset: true, preview_project_selected: true, preview_project_synced: true, preview_ui_ready: true }],
      ["job_failed", "PREVIEW_JOB_FAILED", { component_hash_verified: true, preview_project_reset: true, preview_project_selected: true, preview_project_synced: true, preview_ui_ready: true, preview_job_created: true, preview_job_status: "failed" }],
      ["record_missing", "PREVIEW_RECORD_MISSING", { component_hash_verified: true, preview_project_reset: true, preview_project_selected: true, preview_project_synced: true, preview_ui_ready: true, preview_job_created: true, preview_job_status: "succeeded", preview_record_count: 0 }],
      ["range", "PREVIEW_RANGE_FAILED", { component_hash_verified: true, preview_project_reset: true, preview_project_selected: true, preview_project_synced: true, preview_ui_ready: true, preview_job_created: true, preview_job_status: "succeeded", preview_record_count: 1 }]
    ];
    for (const [failure, code, checks] of cases) {
      const root = temporaryRoot(); const report = builtReport(root);
      const { child, latest } = runVerifier(root, {
        ...realFixtures(root), AIVS_PACKAGE_REPORT: report, AIVS_PACKAGE_REAL_TEST_DIRECT_VERIFY: "pass", AIVS_PACKAGE_REAL_TEST_PREVIEW_FAILURE: failure
      });
      expect(child.status).toBe(1);
      expect(latest).toMatchObject({ schema_version: 2, status: "failed", code, stage: "preview", checks: { ...checks, evidence_written: true } });
      const serialized = JSON.stringify(latest);
      expect(serialized).not.toContain("untrusted_runtime_value");
      expect(serialized).not.toContain(root);
      expect(serialized).not.toContain("must never be persisted");
    }
  });

  it("restart 子阶段写入离散安全码、有限轮询进度且不泄漏运行时值", () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["timeline_unavailable", "RESTART_TIMELINE_UNAVAILABLE", { component_hash_verified: true, preview_stale_before_restart: true }],
      ["revision_mismatch", "RESTART_REVISION_MISMATCH", { component_hash_verified: true, preview_stale_before_restart: true, restart_timeline_restored: true, restart_revision_matches: false }],
      ["previews_unavailable", "RESTART_PREVIEWS_UNAVAILABLE", { component_hash_verified: true, preview_stale_before_restart: true, restart_timeline_restored: true, restart_revision_matches: true }],
      ["preview_missing", "RESTART_PREVIEW_MISSING", { component_hash_verified: true, preview_stale_before_restart: true, restart_timeline_restored: true, restart_revision_matches: true, restart_preview_count: 0 }],
      ["exports_unavailable", "RESTART_EXPORTS_UNAVAILABLE", { component_hash_verified: true, preview_stale_before_restart: true, restart_timeline_restored: true, restart_revision_matches: true, restart_preview_count: 1 }],
      ["export_missing", "RESTART_EXPORT_MISSING", { component_hash_verified: true, preview_stale_before_restart: true, restart_timeline_restored: true, restart_revision_matches: true, restart_preview_count: 1, restart_export_count: 0 }],
      ["models_unavailable", "RESTART_MODELS_UNAVAILABLE", { component_hash_verified: true, preview_stale_before_restart: true, restart_timeline_restored: true, restart_revision_matches: true, restart_preview_count: 1, restart_export_count: 1 }]
    ];
    for (const [failure, code, checks] of cases) {
      const root = temporaryRoot(); const report = builtReport(root);
      const { child, latest } = runVerifier(root, {
        ...realFixtures(root), AIVS_PACKAGE_REPORT: report, AIVS_PACKAGE_REAL_TEST_DIRECT_VERIFY: "pass", AIVS_PACKAGE_REAL_TEST_RESTART_FAILURE: failure
      });
      expect(child.status).toBe(1);
      expect(latest).toMatchObject({ schema_version: 2, status: "failed", code, stage: "restart", checks: { ...checks, evidence_written: true } });
      const serialized = JSON.stringify(latest);
      expect(serialized).not.toContain("untrusted_restart_value");
      expect(serialized).not.toContain(root);
      expect(serialized).not.toContain("must never be persisted");
    }
  });

  it("package:verify 对基础资源缺失输出离散安全码", () => {
    const root = temporaryRoot(); const report = builtReport(root);
    const child = runPackageVerify(root, report);
    expect(child.status).toBe(1);
    expect(child.stdout + child.stderr).toContain("PACKAGE_REQUIRED_FFMPEG_MISSING");
    expect(child.stdout + child.stderr).not.toContain(root);
  });

  it("验证脚本不落盘原始 DTO、正文、绝对路径或完整错误", () => {
    expect(realVerify).toContain("AIVS_PACKAGE_REAL_EVIDENCE_ROOT"); expect(realVerify).toContain("schema_version: 2");
    expect(realVerify).toContain("writeFailureEvidence"); expect(realVerify).toContain("await main().catch(terminate)");
    expect(realVerify).toContain("PACKAGE_COMPONENT_VERIFY_FAILED"); expect(realVerify).toContain("AIVS_PACKAGE_DIR: packageRoot"); expect(realVerify).toContain("scripts/verify-package.mjs");
    expect(realVerify).toContain("delete verifierEnv.AIVS_PACKAGE_REPORT"); expect(realVerify).not.toContain("[\"package:verify\"]");
    expect(realVerify).toContain("PREVIEW_UI_NOT_READY"); expect(realVerify).toContain("PREVIEW_JOB_NOT_CREATED");
    expect(realVerify).toContain("PREVIEW_PROJECT_SYNC_FAILED"); expect(realVerify).toContain("preview_project_synced");
    expect(realVerify).toContain("preview_project_reset"); expect(realVerify).toContain("preview_project_selected");
    const resetIndex = realVerify.indexOf('selectOption(""'); const selectIndex = realVerify.indexOf("selectOption(projectId");
    expect(resetIndex).toBeGreaterThan(-1); expect(selectIndex).toBeGreaterThan(resetIndex);
    expect(realVerify).toContain("PREVIEW_JOB_FAILED"); expect(realVerify).toContain("PREVIEW_RECORD_MISSING");
    expect(realVerify).toContain("pollRestartRead"); expect(realVerify).toContain("pollRestartList");
    expect(realVerify).toContain("RESTART_TIMELINE_UNAVAILABLE"); expect(realVerify).toContain("RESTART_MODELS_UNAVAILABLE");
    expect(realVerify).toContain("RESTART_REVISION_MISMATCH"); expect(realVerify).toContain("RESTART_PREVIEW_MISSING"); expect(realVerify).toContain("RESTART_EXPORT_MISSING");
    expect(realVerify).toContain("preview_stale_before_restart"); expect(realVerify).toContain("restart_revision_matches");
    expect(realVerify).toContain("failureChecks"); expect(realVerify).toContain("untrusted_runtime_value");
    expect(realVerify).not.toContain("transcript.json"); expect(realVerify).not.toContain("render.json"); expect(realVerify).not.toContain("page.screenshot");
    expect(realVerify).not.toContain("JSON.stringify(transcriptionJob)"); expect(realVerify).not.toContain("console.error(error)");
  });
});
