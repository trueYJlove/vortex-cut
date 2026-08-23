import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const desktop = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = resolve(desktop, "../..");
const defaultEvidenceRoot = join(root, "test-results", "stage1c-render-rework-package-20260811");
const evidenceOverride = process.env.AIVS_PACKAGE_REAL_EVIDENCE_ROOT;
const evidenceRoot = evidenceOverride && isAbsolute(evidenceOverride) ? resolve(evidenceOverride) : resolve(defaultEvidenceRoot);
const runId = `full-chain-${process.pid}-${Date.now()}`;
const evidenceRun = join(evidenceRoot, runId);
let stage = "preflight";
let handlingFailure = false;
const progress = Object.create(null);
const expectedWindowTitle = "Vortex Cut";

const allowedCodes = new Set([
  "PACKAGE_REAL_EVIDENCE_ROOT_INVALID", "REAL_FIXTURE_UNAVAILABLE", "PACKAGE_COMPONENT_VERIFY_FAILED", "PACKAGE_REPORT_UNREADABLE", "PACKAGE_REPORT_INVALID",
  "PACKAGE_REQUIRED_SIDECAR_MISSING", "PACKAGE_REQUIRED_FFMPEG_MISSING", "PACKAGE_REQUIRED_LICENSE_MISSING", "PACKAGE_REQUIRED_COMPONENT_MANIFEST_MISSING",
  "PACKAGE_REQUIRED_MODEL_MANIFEST_MISSING", "PACKAGE_REQUIRED_RECIPE_MISSING", "PACKAGE_REQUIRED_PLATFORM_PRESET_MISSING", "PACKAGE_REQUIRED_RENDITION_PRESET_MISSING", "PACKAGE_REQUIRED_FONT_MISSING", "PACKAGE_COMPONENT_MANIFEST_INVALID",
  "PACKAGE_COMPONENT_LICENSE_INVALID", "PACKAGE_COMPONENT_PIN_INVALID", "PACKAGE_COMPONENT_HASH_MISMATCH", "PACKAGE_FONT_BUNDLE_INVALID",
  "PACKAGE_FONT_BUNDLE_FILE_MISSING", "PACKAGE_FONT_BUNDLE_HASH_MISMATCH", "PACKAGE_CAPTION_PRESETS_INVALID",
  "PACKAGE_FFMPEG_FILTER_INVALID", "PACKAGE_MODEL_MANIFEST_INVALID", "PACKAGE_MODEL_WEIGHTS_EMBEDDED",
  "PACKAGE_RECIPE_MANIFEST_INVALID", "PACKAGE_VERIFY_UNEXPECTED",
  "COMPONENT_MANIFEST_UNREADABLE", "SIDECAR_COMPONENT_MISSING", "SIDECAR_HASH_MISMATCH", "WORKSPACE_SETUP_FAILED",
  "ELECTRON_LAUNCH_FAILED", "ELECTRON_RUNTIME_FAILED", "ELECTRON_WINDOW_TITLE_MISMATCH", "IMPORT_CANCELLED", "MODEL_MANIFEST_MISSING", "MODEL_RUNTIME_UNAVAILABLE",
  "TRANSCRIPTION_FAILED", "TRANSCRIPT_SEGMENT_OR_WORD_MISSING", "TIMELINE_OR_CAPTION_MISSING", "JOB_TIMEOUT", "JOB_NOT_CREATED",
  "PREVIEW_FAILED", "PREVIEW_PROJECT_SYNC_FAILED", "PREVIEW_UI_NOT_READY", "PREVIEW_JOB_NOT_CREATED", "PREVIEW_JOB_FAILED", "PREVIEW_RECORD_MISSING", "PREVIEW_RANGE_FAILED",
  "EXPORT_FAILED", "RENDITION_PREVIEW_FAILED", "RENDITION_PREVIEW_MISSING", "EXPORT_BATCH_GRANT_FAILED", "EXPORT_BATCH_CREATE_FAILED", "EXPORT_BATCH_INVALID", "EXPORT_BATCH_FAILURE_INJECTION_FAILED", "EXPORT_BATCH_STATE_UNAVAILABLE", "EXPORT_BATCH_EXPORT_IDS_INVALID", "EXPORT_BATCH_RECORDS_UNAVAILABLE", "EXPORT_BATCH_ARTIFACTS_UNAVAILABLE", "EXPORT_BATCH_RECORDS_MISSING", "EXPORT_BATCH_ARTIFACT_MISSING", "EXPORT_BATCH_OUTPUT_INVALID", "EXPORT_BATCH_MEDIA_INVALID", "EXPORT_BATCH_TARGETS_INCOMPLETE", "EXPORT_BATCH_PARTIAL_FAILED", "EXPORT_BATCH_RETRY_FAILED", "PREVIEW_NOT_STALE", "RESTART_TIMELINE_UNAVAILABLE", "RESTART_PREVIEWS_UNAVAILABLE",
  "RESTART_EXPORTS_UNAVAILABLE", "RESTART_MODELS_UNAVAILABLE", "RESTART_REVISION_MISMATCH", "RESTART_PREVIEW_MISSING",
  "RESTART_EXPORT_MISSING", "RESTART_RESTORE_FAILED",
  "EXPORT_HASH_MISMATCH", "EXPORT_CODEC_INVALID", "RENDERER_DTO_SENSITIVE_FIELD", "EVIDENCE_WRITE_FAILED",
  "PACKAGE_REAL_VERIFICATION_FAILED"
]);

const fail = code => { throw new Error(code); };
const safeErrorCode = error => allowedCodes.has(String(error?.message ?? "")) ? error.message : "PACKAGE_REAL_VERIFICATION_FAILED";
const failureStatus = code => code === "REAL_FIXTURE_UNAVAILABLE" || code === "PACKAGE_REAL_EVIDENCE_ROOT_INVALID" ? "unverified" : "failed";
const safeStage = () => /^[a-z0-9_]+$/.test(stage) ? stage : "unknown";
const safeJobStatus = value => ["succeeded", "failed", "cancelled", "interrupted"].includes(value) ? value : "unknown";
const safeCount = value => Number.isInteger(value) && value >= 0 ? value : undefined;
const failureChecks = () => {
  const checks = {};
  if (typeof progress.component_hash_verified === "boolean") checks.component_hash_verified = progress.component_hash_verified;
  for (const key of ["model_ready_installed_count", "transcription_segment_count", "transcription_word_count", "timeline_clip_count", "timeline_caption_count", "preview_record_count", "preview_range_byte_count", "export_record_count", "restart_preview_count", "restart_export_count", "restart_model_count"]) {
    const value = safeCount(progress[key]);
    if (value !== undefined) checks[key] = value;
  }
  if (typeof progress.preview_ui_ready === "boolean") checks.preview_ui_ready = progress.preview_ui_ready;
  if (typeof progress.preview_project_synced === "boolean") checks.preview_project_synced = progress.preview_project_synced;
  if (typeof progress.preview_project_reset === "boolean") checks.preview_project_reset = progress.preview_project_reset;
  if (typeof progress.preview_project_selected === "boolean") checks.preview_project_selected = progress.preview_project_selected;
  if (typeof progress.preview_stale_before_restart === "boolean") checks.preview_stale_before_restart = progress.preview_stale_before_restart;
  if (typeof progress.restart_timeline_restored === "boolean") checks.restart_timeline_restored = progress.restart_timeline_restored;
  if (typeof progress.restart_revision_matches === "boolean") checks.restart_revision_matches = progress.restart_revision_matches;
  if (typeof progress.export_job_created === "boolean") checks.export_job_created = progress.export_job_created;
  if (progress.preview_range_status !== undefined) checks.preview_range_status = Number.isInteger(progress.preview_range_status) ? progress.preview_range_status : "unknown";
  if (progress.export_job_status !== undefined) checks.export_job_status = safeJobStatus(progress.export_job_status);
  if (typeof progress.preview_job_created === "boolean") checks.preview_job_created = progress.preview_job_created;
  if (progress.preview_job_status !== undefined) checks.preview_job_status = safeJobStatus(progress.preview_job_status);
  if (typeof progress.window_title_matches_expected === "boolean") {
    checks.window_title = { expected: expectedWindowTitle, matches_expected: progress.window_title_matches_expected };
  }
  return checks;
};

async function writeFailureEvidence(code) {
  const result = { schema_version: 2, status: failureStatus(code), code, stage: safeStage(), checks: { ...failureChecks(), evidence_written: true } };
  try {
    await mkdir(evidenceRun, { recursive: true });
    await writeFile(join(evidenceRun, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await writeFile(join(evidenceRoot, "latest.json"), `${JSON.stringify({ ...result, evidence_component: "current-run" }, null, 2)}\n`, "utf8");
  } catch {
    return false;
  }
  return true;
}

async function terminate(error) {
  if (handlingFailure) return;
  handlingFailure = true;
  const code = safeErrorCode(error);
  const written = await writeFailureEvidence(code);
  console.error(written ? code : "EVIDENCE_WRITE_FAILED");
  process.exitCode = 1;
}

process.on("uncaughtException", error => { void terminate(error); });
process.on("unhandledRejection", error => { void terminate(error); });

const rendererPayloadHasSensitiveFields = value => {
  if (Array.isArray(value)) return value.some(rendererPayloadHasSensitiveFields);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => /(?:path|uri|token|authorization|secret|prompt|raw_response|egress|request|response|error|body|transcript|segment|word|render_plan|toolchain|admin)/i.test(key) || rendererPayloadHasSensitiveFields(item));
};

async function waitForJob(page, jobId, timeout = 300_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const job = await page.evaluate(id => window.desktop.getJob(id), jobId);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return job;
    await page.waitForTimeout(500);
  }
  fail("JOB_TIMEOUT");
}

async function newestJob(page, projectId, kind, missingCode = "JOB_NOT_CREATED") {
  for (let index = 0; index < 120; index += 1) {
    const jobs = await page.evaluate(id => window.desktop.listJobs({ project_id: id, limit: 100 }), projectId);
    const job = jobs.items.find(item => item.kind === kind);
    if (job) return job;
    await page.waitForTimeout(250);
  }
  fail(missingCode);
}

async function pollRestartRead(page, reader, unavailableCode, isAvailable = value => value !== undefined && value !== null, onValue = () => undefined) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const value = await reader();
      if (!isAvailable(value)) throw new Error("restart value unavailable");
      onValue(value);
      return value;
    } catch {
      if (attempt < 59) await page.waitForTimeout(250);
    }
  }
  fail(unavailableCode);
}

async function pollRestartList(page, reader, unavailableCode, missingCode, countKey) {
  let readable = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const value = await reader();
      if (!Array.isArray(value?.items)) throw new Error("invalid list");
      readable = true;
      progress[countKey] = value.items.length;
      if (value.items.length) return value;
    } catch {
      // The safe evidence records only final fixed codes, never this failure detail.
    }
    if (attempt < 59) await page.waitForTimeout(250);
  }
  fail(readable ? missingCode : unavailableCode);
}

function packageVerifyFailureCode(packageRoot) {
  const testResult = process.env.AIVS_PACKAGE_REAL_TEST_DIRECT_VERIFY;
  if (testResult) {
    if (testResult === "pass") return null;
    if (testResult === "unknown") return "PACKAGE_COMPONENT_VERIFY_FAILED";
    return allowedCodes.has(testResult) && testResult.startsWith("PACKAGE_") ? testResult : "PACKAGE_COMPONENT_VERIFY_FAILED";
  }
  const verifierEnv = { ...process.env, AIVS_PACKAGE_DIR: packageRoot };
  delete verifierEnv.AIVS_PACKAGE_REPORT;
  const result = spawnSync(process.execPath, ["scripts/verify-package.mjs"], {
    cwd: desktop,
    env: verifierEnv,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true
  });
  if (result.status === 0 && !result.error) return null;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return [...allowedCodes].find(code => code.startsWith("PACKAGE_") && output.includes(code)) ?? "PACKAGE_COMPONENT_VERIFY_FAILED";
}

async function main() {
  if (evidenceOverride && !isAbsolute(evidenceOverride)) fail("PACKAGE_REAL_EVIDENCE_ROOT_INVALID");
  const modelRoot = process.env.AIVS_E2E_MODEL_DIR;
  const sourceVideo = process.env.AIVS_E2E_MIXED_VIDEO;
  const realPreflight = [
    { name: "AIVS_E2E_MODEL_DIR", supplied: Boolean(modelRoot), exists: Boolean(modelRoot && existsSync(modelRoot)) },
    { name: "AIVS_E2E_MIXED_VIDEO", supplied: Boolean(sourceVideo), exists: Boolean(sourceVideo && existsSync(sourceVideo)) }
  ];
  if (realPreflight.some(item => !item.exists)) fail("REAL_FIXTURE_UNAVAILABLE");

  stage = "report_read";
  const reportPath = process.env.AIVS_PACKAGE_REPORT ?? join(root, "build", "reports", "windows-package-latest.json");
  let report;
  try { report = JSON.parse(await readFile(reportPath, "utf8")); } catch { fail("PACKAGE_REPORT_UNREADABLE"); }
  if (report.schema_version !== 1 || report.status !== "built" || typeof report.package_root !== "string" || typeof report.unpacked_root !== "string" || typeof report.installer_path !== "string") fail("PACKAGE_REPORT_INVALID");

  stage = "package_verify";
  const packageVerifyFailure = packageVerifyFailureCode(report.package_root);
  if (packageVerifyFailure) fail(packageVerifyFailure);

  stage = "component_hash";
  const packageResources = report.package_root;
  let componentManifest;
  try { componentManifest = JSON.parse(await readFile(join(packageResources, "manifests", "components.json"), "utf8")); } catch { fail("COMPONENT_MANIFEST_UNREADABLE"); }
  const sidecarComponent = Array.isArray(componentManifest.components) ? componentManifest.components.find(item => item.path === "core/aivs-core/aivs-core.exe") : undefined;
  if (!sidecarComponent || typeof sidecarComponent.sha256 !== "string") fail("SIDECAR_COMPONENT_MISSING");
  let sidecarHash;
  try { sidecarHash = createHash("sha256").update(await readFile(join(packageResources, sidecarComponent.path))).digest("hex"); } catch { fail("SIDECAR_COMPONENT_MISSING"); }
  if (sidecarHash.toLowerCase() !== sidecarComponent.sha256.toLowerCase()) fail("SIDECAR_HASH_MISMATCH");
  progress.component_hash_verified = true;

  stage = "workspace_setup";
  const workRun = join(tmpdir(), "aivideo-package-real-work", `run-${process.pid}-${Date.now()}`);
  const userData = join(workRun, "user-data");
  const video = join(workRun, "source.mp4");
  const destination = join(workRun, "final.mp4");
  try { await mkdir(dirname(video), { recursive: true }); await copyFile(sourceVideo, video); } catch { fail("WORKSPACE_SETUP_FAILED"); }

  // Test-only seam: exercises safe preview evidence without launching Electron.
  const previewTestFailure = process.env.AIVS_PACKAGE_REAL_TEST_PREVIEW_FAILURE;
  if (previewTestFailure) {
    stage = "preview";
    progress.untrusted_runtime_value = { path: workRun, error: "must never be persisted" };
    if (previewTestFailure === "project_sync") fail("PREVIEW_PROJECT_SYNC_FAILED");
    progress.preview_project_reset = true;
    progress.preview_project_selected = true;
    progress.preview_project_synced = true;
    if (previewTestFailure === "ui") fail("PREVIEW_UI_NOT_READY");
    progress.preview_ui_ready = true;
    if (previewTestFailure === "job_missing") fail("PREVIEW_JOB_NOT_CREATED");
    progress.preview_job_created = true;
    if (previewTestFailure === "job_failed") { progress.preview_job_status = "failed"; fail("PREVIEW_JOB_FAILED"); }
    progress.preview_job_status = "succeeded";
    if (previewTestFailure === "record_missing") { progress.preview_record_count = 0; fail("PREVIEW_RECORD_MISSING"); }
    progress.preview_record_count = 1;
    if (previewTestFailure === "range") fail("PREVIEW_RANGE_FAILED");
    fail("PACKAGE_REAL_VERIFICATION_FAILED");
  }

  // Test-only seam: exercises restart diagnostics without launching Electron.
  const restartTestFailure = process.env.AIVS_PACKAGE_REAL_TEST_RESTART_FAILURE;
  if (restartTestFailure) {
    stage = "restart";
    progress.untrusted_restart_value = { path: workRun, error: "must never be persisted" };
    progress.preview_stale_before_restart = true;
    if (restartTestFailure === "timeline_unavailable") fail("RESTART_TIMELINE_UNAVAILABLE");
    progress.restart_timeline_restored = true;
    if (restartTestFailure === "revision_mismatch") {
      progress.restart_revision_matches = false;
      fail("RESTART_REVISION_MISMATCH");
    }
    progress.restart_revision_matches = true;
    if (restartTestFailure === "previews_unavailable") fail("RESTART_PREVIEWS_UNAVAILABLE");
    progress.restart_preview_count = 0;
    if (restartTestFailure === "preview_missing") fail("RESTART_PREVIEW_MISSING");
    progress.restart_preview_count = 1;
    if (restartTestFailure === "exports_unavailable") fail("RESTART_EXPORTS_UNAVAILABLE");
    progress.restart_export_count = 0;
    if (restartTestFailure === "export_missing") fail("RESTART_EXPORT_MISSING");
    progress.restart_export_count = 1;
    if (restartTestFailure === "models_unavailable") fail("RESTART_MODELS_UNAVAILABLE");
    progress.restart_model_count = 1;
    fail("RESTART_RESTORE_FAILED");
  }

  stage = "electron_launch";
  if (process.env.AIVS_PACKAGE_REAL_TEST_FAIL_STAGE === "electron_launch") fail("ELECTRON_LAUNCH_FAILED");
  const require = createRequire(join(desktop, "package.json"));
  let electron;
  try {
    const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] }));
    electron = playwright._electron;
  } catch { fail("ELECTRON_LAUNCH_FAILED"); }
  const launch = () => electron.launch({
    executablePath: join(report.unpacked_root, "Vortex Cut.exe"), args: [`--user-data-dir=${userData}`], cwd: report.unpacked_root,
    env: { ...process.env, AIVS_E2E_ASSET_PATHS: JSON.stringify({ video }), AIVS_E2E_EXPORT_PATH: destination, AIVS_E2E_EXPORT_DIRECTORY: workRun, AIVS_E2E_MODEL_DIR: modelRoot, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }
  });
  let first;
  // Test-only deterministic seam: avoids requiring an actual Windows package
  // when exercising the post-launch runtime failure evidence path.
  if (process.env.AIVS_PACKAGE_REAL_TEST_FAIL_STAGE === "electron_runtime") {
    stage = "electron_runtime";
    fail("ELECTRON_RUNTIME_FAILED");
  }
  if (process.env.AIVS_PACKAGE_REAL_TEST_FAIL_STAGE === "electron_window_title") {
    stage = "electron_window_title";
    progress.window_title_matches_expected = false;
    fail("ELECTRON_WINDOW_TITLE_MISMATCH");
  }
  try { first = await launch(); } catch { fail("ELECTRON_LAUNCH_FAILED"); }
  let projectId; let finalState; let preview; let exportRecord; let transcript; let range; let models; let wordCount; let stage3a; let stage3aPresentations = [];
  try {
    stage = "electron_runtime";
    const page = await first.firstWindow();
    stage = "electron_window_title";
    try {
      progress.window_title_matches_expected = await first.evaluate(
        ({ BrowserWindow }, expectedTitle) => BrowserWindow.getAllWindows()[0]?.getTitle() === expectedTitle,
        expectedWindowTitle
      );
    } catch {
      progress.window_title_matches_expected = false;
    }
    if (!progress.window_title_matches_expected) fail("ELECTRON_WINDOW_TITLE_MISMATCH");
    stage = "electron_runtime";
    try { await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime()); } catch { fail("ELECTRON_RUNTIME_FAILED"); }

    stage = "import_model";
    const setup = await page.evaluate(async () => {
      const project = await window.desktop.createProject({ name: "Package Real Full Chain" });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
      if (!imported) throw new Error("IMPORT_CANCELLED");
      const modelPage = await window.desktop.listModels({ limit: 100 });
      const model = modelPage.items.find(item => item.status === "ready" && item.provider_status === "installed");
      if (!modelPage.items.length) throw new Error("MODEL_MANIFEST_MISSING");
      if (!model) throw new Error("MODEL_RUNTIME_UNAVAILABLE");
      const created = await window.desktop.createTranscription({ asset_id: imported.asset.asset_id, model_id: model.model_id, language: "auto", word_timestamps: true, license_acceptance: null });
      return { project_id: project.project_id, asset_id: imported.asset.asset_id, modelPage, job_id: created.job.job_id };
    }).catch(() => fail("IMPORT_CANCELLED"));
    projectId = setup.project_id; models = setup.modelPage;
    progress.model_ready_installed_count = models.items.filter(item => item.status === "ready" && item.provider_status === "installed").length;

    stage = "transcription";
    if ((await waitForJob(page, setup.job_id)).status !== "succeeded") fail("TRANSCRIPTION_FAILED");
    transcript = await page.evaluate(async assetId => { const values = await window.desktop.listTranscripts(assetId); return window.desktop.getTranscript(values.items[0].transcript_id); }, setup.asset_id).catch(() => fail("TRANSCRIPTION_FAILED"));
    wordCount = (transcript.words?.length ?? 0) + transcript.segments.reduce((total, segment) => total + (segment.words?.length ?? 0), 0);
    if (!transcript.segments.length || wordCount < 1) fail("TRANSCRIPT_SEGMENT_OR_WORD_MISSING");
    progress.transcription_segment_count = transcript.segments.length;
    progress.transcription_word_count = wordCount;

    stage = "timeline";
    const selectedSegment = transcript.segments.find(segment => segment.text.trim()) ?? transcript.segments[0];
    finalState = await page.evaluate(async ({ id, transcriptId, segmentId }) => window.desktop.createTimeline({ project_id: id, timeline: { schema_version: 1, source: { kind: "transcript_selection", transcript_id: transcriptId, segment_ids: [segmentId], padding_before_us: 0, padding_after_us: 0, create_captions: true }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } }), { id: projectId, transcriptId: transcript.transcript_id, segmentId: selectedSegment.segment_id }).catch(() => fail("TIMELINE_OR_CAPTION_MISSING"));
    if (finalState.current_revision.document.clips.length !== 1 || finalState.current_revision.document.captions.length !== 1) fail("TIMELINE_OR_CAPTION_MISSING");
    progress.timeline_clip_count = finalState.current_revision.document.clips.length;
    progress.timeline_caption_count = finalState.current_revision.document.captions.length;

    stage = "preview";
    const previewButton = page.getByRole("button", { name: "生成权威预览" });
    const projectSelect = page.getByLabel("当前项目");
    try {
      await page.waitForFunction(projectId => {
        const select = document.querySelector('select[aria-label="当前项目"]');
        return select instanceof HTMLSelectElement && Array.from(select.options).some(option => option.value === projectId);
      }, projectId, { timeout: 15_000 });
      await projectSelect.selectOption("", { timeout: 15_000 });
      await page.waitForFunction(() => {
        const select = document.querySelector('select[aria-label="当前项目"]');
        return select instanceof HTMLSelectElement && select.value === "";
      }, undefined, { timeout: 15_000 });
      progress.preview_project_reset = true;
      await projectSelect.selectOption(projectId, { timeout: 15_000 });
      await page.waitForFunction(projectId => {
        const select = document.querySelector('select[aria-label="当前项目"]');
        return select instanceof HTMLSelectElement && select.value === projectId;
      }, projectId, { timeout: 15_000 });
      progress.preview_project_selected = true;
      await previewButton.waitFor({ state: "visible", timeout: 15_000 });
      await page.waitForFunction(projectId => {
        const select = document.querySelector('select[aria-label="当前项目"]');
        const button = Array.from(document.querySelectorAll("button")).find(item => item.textContent?.includes("生成权威预览"));
        return select instanceof HTMLSelectElement && select.value === projectId && button instanceof HTMLButtonElement && !button.disabled;
      }, projectId, { timeout: 15_000 });
    } catch { fail("PREVIEW_PROJECT_SYNC_FAILED"); }
    progress.preview_project_synced = true;
    try {
      await page.getByLabel("编码模式").selectOption("software", { timeout: 15_000 });
      await previewButton.click({ timeout: 15_000 });
    } catch { fail("PREVIEW_UI_NOT_READY"); }
    progress.preview_ui_ready = true;
    const previewJob = await newestJob(page, projectId, "authoritative_preview", "PREVIEW_JOB_NOT_CREATED");
    progress.preview_job_created = true;
    const previewJobResult = await waitForJob(page, previewJob.job_id);
    progress.preview_job_status = safeJobStatus(previewJobResult.status);
    if (previewJobResult.status !== "succeeded") fail("PREVIEW_JOB_FAILED");
    const previewItems = await page.evaluate(id => window.desktop.listPreviews({ project_id: id, limit: 100 }), projectId).catch(() => fail("PREVIEW_RECORD_MISSING"));
    progress.preview_record_count = Array.isArray(previewItems?.items) ? previewItems.items.length : 0;
    if (progress.preview_record_count < 1) fail("PREVIEW_RECORD_MISSING");
    preview = previewItems.items[0];
    range = await page.evaluate(async url => { const response = await fetch(url, { headers: { Range: "bytes=0-63" } }); return { status: response.status, length: (await response.arrayBuffer()).byteLength }; }, preview.media_url).catch(() => fail("PREVIEW_RANGE_FAILED"));
    if (range.status !== 206 || range.length !== 64) fail("PREVIEW_RANGE_FAILED");
    progress.preview_range_status = range.status;
    progress.preview_range_byte_count = range.length;

    stage = "export";
    await page.getByRole("button", { name: "导出正式视频" }).click().catch(() => fail("EXPORT_FAILED"));
    const exportJob = await newestJob(page, projectId, "final_export");
    progress.export_job_created = true;
    const exportJobResult = await waitForJob(page, exportJob.job_id);
    progress.export_job_status = safeJobStatus(exportJobResult.status);
    if (exportJobResult.status !== "succeeded") fail("EXPORT_FAILED");
    const exportItems = await page.evaluate(id => window.desktop.listExports({ project_id: id, limit: 100 }), projectId).catch(() => fail("EXPORT_FAILED"));
    progress.export_record_count = Array.isArray(exportItems?.items) ? exportItems.items.length : 0;
    if (progress.export_record_count < 1) fail("EXPORT_FAILED");
    exportRecord = exportItems.items[0];

    stage = "stage3a_renditions";
    const targetDefinitions = await page.evaluate(async () => {
      const [platforms, renditions] = await Promise.all([window.desktop.listPlatformPresets(), window.desktop.listRenditionPresets()]);
      const renditionIds = ["portrait-9x16-v1", "landscape-16x9-v1"];
      const platform = platforms.items.find(item => renditionIds.every(id => item.allowed_rendition_ids.includes(id)));
      if (!platform || !renditionIds.every(id => renditions.items.some(item => item.rendition_preset_id === id))) return null;
      return { platform_preset_id: platform.platform_preset_id, rendition_ids: renditionIds };
    }).catch(() => fail("RENDITION_PREVIEW_FAILED"));
    if (!targetDefinitions) fail("RENDITION_PREVIEW_FAILED");
    const expectedPreviewTargetSizes = {
      "portrait-9x16-v1": { width: 540, height: 960 },
      "landscape-16x9-v1": { width: 960, height: 540 }
    };
    const expectedExportTargetSizes = {
      "portrait-9x16-v1": { width: 1080, height: 1920 },
      "landscape-16x9-v1": { width: 1920, height: 1080 }
    };
    const targetPreviews = [];
    for (const renditionPresetId of targetDefinitions.rendition_ids) {
      const created = await page.evaluate(({ id, revision, platform, rendition }) => window.desktop.createRenditionPreview({
        project_id: id,
        preview: { timeline_revision_id: revision, platform_preset_id: platform, rendition_preset_id: rendition, layout_policy: "preserve_timeline", encoder_mode: "software" }
      }), { id: projectId, revision: finalState.current_revision.timeline_revision_id, platform: targetDefinitions.platform_preset_id, rendition: renditionPresetId }).catch(() => fail("RENDITION_PREVIEW_FAILED"));
      if (created.job && (await waitForJob(page, created.job.job_id)).status !== "succeeded") fail("RENDITION_PREVIEW_FAILED");
      const available = await page.evaluate(async ({ id, platform, rendition, revision }) => {
        const values = await window.desktop.listRenditionPreviews({ project_id: id, limit: 100 });
        return values.items.find(item => item.preview.timeline_revision_id === revision && item.preview.platform_preset_id === platform && item.preview.rendition_preset_id === rendition && item.preview.layout_policy === "preserve_timeline");
      }, { id: projectId, platform: targetDefinitions.platform_preset_id, rendition: renditionPresetId, revision: finalState.current_revision.timeline_revision_id }).catch(() => fail("RENDITION_PREVIEW_FAILED"));
      if (!available || available.preview.status !== "ready") fail("RENDITION_PREVIEW_MISSING");
      const expected = expectedPreviewTargetSizes[renditionPresetId];
      const media = available.preview.media_info;
      if (!expected || media?.video?.width !== expected.width || media?.video?.height !== expected.height || media?.video?.codec !== "h264" || media?.audio?.codec !== "aac") fail("RENDITION_PREVIEW_FAILED");
      targetPreviews.push(available);
    }
    stage3aPresentations = targetPreviews;

    stage = "stage3a_batch";
    stage = "stage3a_batch_grant";
    const batchGrant = await page.evaluate(id => window.desktop.chooseExportDirectory(id), projectId).catch(() => fail("EXPORT_BATCH_GRANT_FAILED"));
    if (!batchGrant) fail("EXPORT_BATCH_GRANT_FAILED");
    stage = "stage3a_batch_create";
    const batchCreated = await page.evaluate(({ id, revision, grant, previews }) => window.desktop.createExportBatch({
      project_id: id,
      batch: { timeline_revision_id: revision, directory_grant_id: grant, items: previews.map(preview => ({ rendition_snapshot_id: preview.preview.rendition_snapshot_id, preview_artifact_id: preview.preview.render_artifact_id, encoder_mode: "software" })) }
    }), { id: projectId, revision: finalState.current_revision.timeline_revision_id, grant: batchGrant.directory_grant_id, previews: targetPreviews }).catch(() => fail("EXPORT_BATCH_CREATE_FAILED"));
    if (!Array.isArray(batchCreated.jobs) || batchCreated.jobs.length !== 2 || batchCreated.batch.items.length !== 2) fail("EXPORT_BATCH_INVALID");
    const blockedItem = batchCreated.batch.items[1];
    if (typeof blockedItem.destination_display_name !== "string" || !/^[^<>:"/\\|?*\x00-\x1f]+\.mp4$/i.test(blockedItem.destination_display_name)) fail("EXPORT_BATCH_INVALID");
    // A temporary directory occupying one post-preflight target is an actual filesystem
    // failure injection. It verifies that one failed item does not suppress its sibling
    // and that retry consumes a fresh directory grant and produces a new batch.
    stage = "stage3a_batch_injection";
    await mkdir(join(workRun, blockedItem.destination_display_name)).catch(() => fail("EXPORT_BATCH_FAILURE_INJECTION_FAILED"));
    stage = "stage3a_batch_initial_jobs";
    const initialJobs = await Promise.all(batchCreated.jobs.map(job => waitForJob(page, job.job_id)));
    stage = "stage3a_batch_initial_state";
    const initialBatch = await page.evaluate(id => window.desktop.getExportBatch(id), batchCreated.batch.export_batch_id).catch(() => fail("EXPORT_BATCH_STATE_UNAVAILABLE"));
    const initialSucceeded = initialBatch.items.filter(item => item.status === "succeeded");
    const initialFailed = initialBatch.items.filter(item => ["failed", "cancelled", "interrupted"].includes(item.status));
    if (initialBatch.status !== "partial" || initialSucceeded.length !== 1 || initialFailed.length !== 1 || !initialJobs.some(job => job.status === "succeeded") || !initialJobs.some(job => ["failed", "cancelled", "interrupted"].includes(job.status))) fail("EXPORT_BATCH_PARTIAL_FAILED");
    stage = "stage3a_batch_retry_grant";
    const retryGrant = await page.evaluate(id => window.desktop.chooseExportDirectory(id), projectId).catch(() => fail("EXPORT_BATCH_RETRY_FAILED"));
    if (!retryGrant) fail("EXPORT_BATCH_RETRY_FAILED");
    stage = "stage3a_batch_retry_create";
    const retried = await page.evaluate(({ id, grant, item }) => window.desktop.retryExportBatch({ batch_id: id, retry: { directory_grant_id: grant, export_batch_item_ids: [item] } }), { id: initialBatch.export_batch_id, grant: retryGrant.directory_grant_id, item: initialFailed[0].export_batch_item_id }).catch(() => fail("EXPORT_BATCH_RETRY_FAILED"));
    if (retried.batch.retry_of_batch_id !== initialBatch.export_batch_id || retried.batch.items.length !== 1 || retried.batch.items[0].retry_of_item_id !== initialFailed[0].export_batch_item_id || retried.jobs.length !== 1) fail("EXPORT_BATCH_RETRY_FAILED");
    stage = "stage3a_batch_retry_job";
    if ((await waitForJob(page, retried.jobs[0].job_id)).status !== "succeeded") fail("EXPORT_BATCH_RETRY_FAILED");
    stage = "stage3a_batch_retry_state";
    const retryBatch = await page.evaluate(id => window.desktop.getExportBatch(id), retried.batch.export_batch_id).catch(() => fail("EXPORT_BATCH_RETRY_FAILED"));
    if (retryBatch.status !== "succeeded" || retryBatch.items[0]?.status !== "succeeded") fail("EXPORT_BATCH_RETRY_FAILED");
    const batchExportIds = [...initialSucceeded, ...retryBatch.items].map(item => item.export_record_id);
    if (batchExportIds.some(id => typeof id !== "string")) fail("EXPORT_BATCH_EXPORT_IDS_INVALID");
    stage = "stage3a_batch_records";
    const batchExports = await page.evaluate(async ({ id, exportIds }) => {
      const values = await window.desktop.listExports({ project_id: id, limit: 100 });
      return exportIds.map(exportId => values.items.find(item => item.export_record.export_record_id === exportId)).filter(Boolean);
    }, { id: projectId, exportIds: batchExportIds }).catch(() => fail("EXPORT_BATCH_RECORDS_UNAVAILABLE"));
    if (batchExports.length !== 2) fail("EXPORT_BATCH_RECORDS_MISSING");
    stage3aPresentations = [...stage3aPresentations, ...batchExports];
    stage = "stage3a_batch_artifacts";
    const batchArtifacts = await page.evaluate(async values => Promise.all(values.map(async value => ({
      export_record_id: value.export_record.export_record_id,
      artifact: (await window.desktop.getRenderArtifact(value.export_record.render_artifact_id)).artifact
    }))), batchExports).catch(() => fail("EXPORT_BATCH_ARTIFACTS_UNAVAILABLE"));
    const batchOutputChecks = [];
    stage = "stage3a_batch_outputs";
    for (const value of batchExports) {
      const record = value.export_record;
      const relatedItem = [...initialSucceeded, ...retryBatch.items].find(item => item.export_record_id === record.export_record_id);
      const expected = expectedExportTargetSizes[relatedItem?.rendition_snapshot?.rendition_preset_id];
      const artifact = batchArtifacts.find(item => item.export_record_id === record.export_record_id)?.artifact;
      const name = record.destination_display_name;
      if (!expected || !artifact || typeof name !== "string" || !/^[^<>:"/\\|?*\x00-\x1f]+\.mp4$/i.test(name)) fail("EXPORT_BATCH_ARTIFACT_MISSING");
      const output = resolve(workRun, name);
      if (dirname(output) !== resolve(workRun)) fail("EXPORT_BATCH_OUTPUT_INVALID");
      const bytes = await readFile(output).catch(() => fail("EXPORT_BATCH_OUTPUT_INVALID"));
      const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const probeResult = JSON.parse(execFileSync(join(packageResources, "ffmpeg", "win-x64", "ffprobe.exe"), ["-v", "error", "-show_streams", "-of", "json", output], { encoding: "utf8", windowsHide: true }));
      const h264 = probeResult.streams.some(stream => stream.codec_type === "video" && stream.codec_name === "h264");
      const aac = probeResult.streams.some(stream => stream.codec_type === "audio" && stream.codec_name === "aac");
      const media = artifact.media_info;
      if (media?.video?.width !== expected.width || media?.video?.height !== expected.height || media?.video?.codec !== "h264" || media?.audio?.codec !== "aac" || !h264 || !aac || hash !== artifact.sha256 || artifact.sha256 !== record.sha256) fail("EXPORT_BATCH_MEDIA_INVALID");
      batchOutputChecks.push({ rendition_preset_id: relatedItem.rendition_snapshot.rendition_preset_id, width: expected.width, height: expected.height, h264, aac, hash_matches_export_record: true });
    }
    if (new Set(batchOutputChecks.map(item => item.rendition_preset_id)).size !== 2) fail("EXPORT_BATCH_TARGETS_INCOMPLETE");
    stage3a = { portrait_landscape_preview_count: targetPreviews.length, initial_batch_status: initialBatch.status, initial_succeeded_count: initialSucceeded.length, initial_failed_count: initialFailed.length, retry_batch_status: retryBatch.status, retry_of_batch_verified: true, exports: batchOutputChecks };

    stage = "stale";
    const clipId = finalState.current_revision.document.clips[0].clip_id;
    finalState = await page.evaluate(({ id, revision, clip }) => window.desktop.patchTimeline({ project_id: id, patch: { schema_version: 1, base_revision_id: revision, operations: [{ op: "set_layout", clip_id: clip, layout: "crop_fill" }], summary: "package stale verification" } }), { id: projectId, revision: finalState.current_revision.timeline_revision_id, clip: clipId }).catch(() => fail("PREVIEW_NOT_STALE"));
    if ((await page.evaluate(id => window.desktop.listPreviews({ project_id: id, limit: 100 }), projectId)).items[0]?.preview?.status !== "stale") fail("PREVIEW_NOT_STALE");
    progress.preview_stale_before_restart = true;
  } finally { await first.close().catch(() => undefined); }

  stage = "restart";
  let second;
  try { second = await launch(); } catch { fail("ELECTRON_LAUNCH_FAILED"); }
  let restored;
  try {
    const page = await second.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)).catch(() => fail("ELECTRON_RUNTIME_FAILED"));
    const timeline = await pollRestartRead(
      page,
      () => page.evaluate(id => window.desktop.getTimeline(id), projectId),
      "RESTART_TIMELINE_UNAVAILABLE",
      value => Boolean(value?.current_revision?.timeline_revision_id),
      () => { progress.restart_timeline_restored = true; }
    );
    if (timeline.current_revision.timeline_revision_id !== finalState.current_revision.timeline_revision_id) {
      progress.restart_revision_matches = false;
      fail("RESTART_REVISION_MISMATCH");
    }
    progress.restart_revision_matches = true;
    const previews = await pollRestartList(
      page,
      () => page.evaluate(id => window.desktop.listPreviews({ project_id: id, limit: 100 }), projectId),
      "RESTART_PREVIEWS_UNAVAILABLE",
      "RESTART_PREVIEW_MISSING",
      "restart_preview_count"
    );
    const exports = await pollRestartList(
      page,
      () => page.evaluate(id => window.desktop.listExports({ project_id: id, limit: 100 }), projectId),
      "RESTART_EXPORTS_UNAVAILABLE",
      "RESTART_EXPORT_MISSING",
      "restart_export_count"
    );
    const restoredModels = await pollRestartRead(
      page,
      () => page.evaluate(() => window.desktop.listModels({ limit: 100 })),
      "RESTART_MODELS_UNAVAILABLE",
      value => Array.isArray(value?.items),
      value => { progress.restart_model_count = value.items.length; }
    );
    restored = { timeline, previews, exports, models: restoredModels };
  } catch (error) {
    if (allowedCodes.has(String(error?.message ?? ""))) throw error;
    fail("RESTART_RESTORE_FAILED");
  } finally { await second.close().catch(() => undefined); }

  stage = "export_hash";
  const destinationHash = createHash("sha256").update(await readFile(destination)).digest("hex");
  if (`sha256:${destinationHash}` !== exportRecord.export_record.sha256) fail("EXPORT_HASH_MISMATCH");
  const probe = JSON.parse(execFileSync(join(packageResources, "ffmpeg", "win-x64", "ffprobe.exe"), ["-v", "error", "-show_streams", "-show_format", "-of", "json", destination], { encoding: "utf8", windowsHide: true }));
  const hasH264 = probe.streams.some(stream => stream.codec_type === "video" && stream.codec_name === "h264");
  const hasAac = probe.streams.some(stream => stream.codec_type === "audio" && stream.codec_name === "aac");
  if (!hasH264 || !hasAac) fail("EXPORT_CODEC_INVALID");
  if (rendererPayloadHasSensitiveFields({ preview, exportRecord, stage3aPresentations })) fail("RENDERER_DTO_SENSITIVE_FIELD");

  stage = "evidence_write";
  const result = {
    schema_version: 2, status: "passed", checks: {
      sidecar_manifest: { component_path: sidecarComponent.path, hash_matches_manifest: true, sha256: `sha256:${sidecarHash}` },
      window_title: { expected: expectedWindowTitle, matches_expected: true },
      model_runtime: { manifest_count: models.items.length, ready_installed_count: models.items.filter(item => item.status === "ready" && item.provider_status === "installed").length },
      transcription: { segment_count: transcript.segments.length, word_count: wordCount, duration_us: transcript.duration_us ?? null },
      timeline: { clip_count: finalState.current_revision.document.clips.length, caption_count: finalState.current_revision.document.captions.length },
      preview_range: { status: range.status, byte_count: range.length },
      export: { h264: hasH264, aac: hasAac, size_bytes: (await stat(destination)).size, sha256: `sha256:${destinationHash}`, hash_matches_export_record: true },
      stage3a_batch: stage3a,
      stale_restart: { stale_before_restart: true, restored_after_restart: true, preview_count: restored.previews.items.length, export_count: restored.exports.items.length, model_count: restored.models.items.length },
      renderer_dto: { sensitive_fields_detected: false }
    }, package: { installer_sha256: `sha256:${createHash("sha256").update(await readFile(report.installer_path)).digest("hex")}`, sidecar_sha256: `sha256:${sidecarHash}`, component_sidecar_sha256: `sha256:${sidecarComponent.sha256}` }
  };
  try {
    await mkdir(evidenceRun, { recursive: true });
    await writeFile(join(evidenceRun, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await writeFile(join(evidenceRoot, "latest.json"), `${JSON.stringify({ schema_version: 2, status: "passed", evidence_component: "current-run", checks: result.checks, package: result.package }, null, 2)}\n`, "utf8");
  } catch { fail("EVIDENCE_WRITE_FAILED"); }
  console.log(JSON.stringify({ schema_version: 2, status: "passed", evidence_component: "current-run" }));
}

await main().catch(terminate);
