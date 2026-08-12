import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = resolve(desktop, "../..");
const require = createRequire(join(desktop, "package.json"));
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] }));
const electron = playwright._electron;
const modelRoot = process.env.AIVS_E2E_MODEL_DIR;
const sourceVideo = process.env.AIVS_E2E_MIXED_VIDEO;
if (!modelRoot || !existsSync(modelRoot)) throw new Error("package:verify:real requires an existing AIVS_E2E_MODEL_DIR");
if (!sourceVideo || !existsSync(sourceVideo)) throw new Error("package:verify:real requires an existing AIVS_E2E_MIXED_VIDEO");

const reportPath = process.env.AIVS_PACKAGE_REPORT ?? join(root, "build", "reports", "windows-package-latest.json");
const report = JSON.parse(await readFile(reportPath, "utf8"));
if (report.schema_version !== 1 || report.status !== "built") throw new Error("Windows package report is not a completed build");
const packagedExe = join(report.unpacked_root, "AIVideo Studio.exe");
const packageResources = report.package_root;
const componentManifest = JSON.parse(await readFile(join(packageResources, "manifests", "components.json"), "utf8"));
const sidecarComponent = componentManifest.components.find(item => item.path === "core/aivs-core/aivs-core.exe");
if (!sidecarComponent) throw new Error("components manifest does not contain the packaged sidecar");
const sidecarBytes = await readFile(join(packageResources, sidecarComponent.path));
const sidecarHash = createHash("sha256").update(sidecarBytes).digest("hex");
if (sidecarHash.toLowerCase() !== String(sidecarComponent.sha256).toLowerCase()) throw new Error("packaged sidecar hash does not match components manifest");

const evidenceRoot = join(root, "test-results", "stage1c-render-rework-package-20260811");
const run = join(evidenceRoot, `full-chain-${process.pid}-${Date.now()}`);
const userData = join(run, "用户 数据");
const video = join(run, "中文 路径", "中英混合 原素材.mp4");
const destination = join(run, "最终 导出.mp4");
const launchEvidencePath = join(run, "sidecar-launch.json");
await mkdir(dirname(video), { recursive: true });
await copyFile(sourceVideo, video);

const launch = () => electron.launch({
  executablePath: packagedExe,
  args: [`--user-data-dir=${userData}`],
  cwd: report.unpacked_root,
  env: {
    ...process.env,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video }),
    AIVS_E2E_EXPORT_PATH: destination,
    AIVS_E2E_MODEL_DIR: modelRoot,
    AIVS_E2E_SIDECAR_ARGV_EVIDENCE: launchEvidencePath,
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_OPTIONS: undefined
  }
});

async function waitForJob(page, jobId, timeout = 300_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const job = await page.evaluate(id => window.desktop.getJob(id), jobId);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return job;
    await page.waitForTimeout(500);
  }
  throw new Error(`job timeout: ${jobId}`);
}

async function newestJob(page, projectId, kind) {
  for (let index = 0; index < 120; index += 1) {
    const jobs = await page.evaluate(id => window.desktop.listJobs({ project_id: id, limit: 100 }), projectId);
    const job = jobs.items.find(item => item.kind === kind);
    if (job) return job;
    await page.waitForTimeout(250);
  }
  throw new Error(`${kind} job was not created`);
}

let projectId; let finalState; let preview; let exportRecord; let transcript; let range; let models; let argv;
const first = await launch();
try {
  const page = await first.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
  await page.evaluate(() => window.desktop.getRuntime());
  const launchEvidence = JSON.parse(await readFile(launchEvidencePath, "utf8"));
  argv = launchEvidence.args;
  const expectedManifestDir = join(packageResources, "model-manifests");
  const manifestIndex = argv.indexOf("--manifest-dir");
  if (manifestIndex < 0 || argv[manifestIndex + 1] !== expectedManifestDir) throw new Error(`packaged sidecar argv is missing manifest-dir: ${JSON.stringify(argv)}`);
  const setup = await page.evaluate(async () => {
    const project = await window.desktop.createProject({ name: "Package Real Full Chain" });
    const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
    if (!imported) throw new Error("fixture import cancelled");
    const modelPage = await window.desktop.listModels({ limit: 100 });
    const model = modelPage.items.find(item => item.status === "ready" && item.provider_status === "installed");
    if (!modelPage.items.length) throw new Error("packaged application exposed no model manifest");
    if (!model) throw new Error(`packaged provider runtime is unavailable: ${JSON.stringify(modelPage.items)}`);
    const created = await window.desktop.createTranscription({ asset_id: imported.asset.asset_id, model_id: model.model_id, language: "auto", word_timestamps: true, license_acceptance: null });
    return { project_id: project.project_id, asset_id: imported.asset.asset_id, modelPage, job_id: created.job.job_id };
  });
  projectId = setup.project_id; models = setup.modelPage;
  const transcriptionJob = await waitForJob(page, setup.job_id);
  if (transcriptionJob.status !== "succeeded") throw new Error(`real packaged transcription failed: ${JSON.stringify(transcriptionJob)}`);
  transcript = await page.evaluate(async assetId => { const values = await window.desktop.listTranscripts(assetId); return window.desktop.getTranscript(values.items[0].transcript_id); }, setup.asset_id);
  const wordCount = (transcript.words?.length ?? 0) + transcript.segments.reduce((total, segment) => total + (segment.words?.length ?? 0), 0);
  if (!transcript.segments.length || wordCount < 1) throw new Error("real packaged transcription did not produce Segment and Word output");
  const selectedSegment = transcript.segments.find(segment => segment.text.trim()) ?? transcript.segments[0];
  finalState = await page.evaluate(async ({ id, transcriptId, segmentId }) => window.desktop.createTimeline({ project_id: id, timeline: { schema_version: 1, source: { kind: "transcript_selection", transcript_id: transcriptId, segment_ids: [segmentId], padding_before_us: 0, padding_after_us: 0, create_captions: true }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } }), { id: projectId, transcriptId: transcript.transcript_id, segmentId: selectedSegment.segment_id });
  if (finalState.current_revision.document.clips.length !== 1 || finalState.current_revision.document.captions.length !== 1) throw new Error("Transcript did not create Timeline Clip and Caption");
  await page.getByRole("option", { name: "Package Real Full Chain" }).waitFor({ state: "attached", timeout: 30_000 });
  await page.getByLabel("当前项目").selectOption("");
  await page.getByLabel("当前项目").selectOption(projectId);
  await page.getByRole("button", { name: "生成预览" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find(item => item.textContent?.includes("生成预览"));
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await page.getByLabel("编码模式").selectOption("software");
  await page.getByRole("button", { name: "生成预览" }).click();
  const previewDone = await waitForJob(page, (await newestJob(page, projectId, "authoritative_preview")).job_id);
  if (previewDone.status !== "succeeded") throw new Error(`packaged preview failed: ${JSON.stringify(previewDone)}`);
  preview = (await page.evaluate(id => window.desktop.listPreviews({ project_id: id, limit: 100 }), projectId)).items[0];
  range = await page.evaluate(async url => { const response = await fetch(url, { headers: { Range: "bytes=0-63" } }); return { status: response.status, length: (await response.arrayBuffer()).byteLength }; }, preview.media_url);
  if (range.status !== 206 || range.length !== 64) throw new Error(`preview Range failed: ${JSON.stringify(range)}`);
  await page.getByRole("button", { name: "权威预览" }).click();
  await page.getByLabel("权威预览视频").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "导出" }).click();
  const exportDone = await waitForJob(page, (await newestJob(page, projectId, "final_export")).job_id);
  if (exportDone.status !== "succeeded") throw new Error(`packaged export failed: ${JSON.stringify(exportDone)}`);
  exportRecord = (await page.evaluate(id => window.desktop.listExports({ project_id: id, limit: 100 }), projectId)).items[0];
  const clipId = finalState.current_revision.document.clips[0].clip_id;
  finalState = await page.evaluate(({ id, revision, clip }) => window.desktop.patchTimeline({ project_id: id, patch: { schema_version: 1, base_revision_id: revision, operations: [{ op: "set_layout", clip_id: clip, layout: "crop_fill" }], summary: "package stale verification" } }), { id: projectId, revision: finalState.current_revision.timeline_revision_id, clip: clipId });
  const stale = (await page.evaluate(id => window.desktop.listPreviews({ project_id: id, limit: 100 }), projectId)).items[0];
  if (stale.preview.status !== "stale") throw new Error("packaged preview did not become stale");
  await page.screenshot({ path: join(run, "full-chain-before-restart.png"), fullPage: true });
} finally { await first.close(); }

const second = await launch(); let restored;
try {
  const page = await second.firstWindow(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime());
  restored = await page.evaluate(async id => ({ timeline: await window.desktop.getTimeline(id), previews: await window.desktop.listPreviews({ project_id: id, limit: 100 }), exports: await window.desktop.listExports({ project_id: id, limit: 100 }), models: await window.desktop.listModels({ limit: 100 }) }), projectId);
  if (restored.timeline.current_revision.timeline_revision_id !== finalState.current_revision.timeline_revision_id || !restored.previews.items.length || !restored.exports.items.length) throw new Error("packaged restart did not restore Stage1 state");
  await page.screenshot({ path: join(run, "full-chain-after-restart.png"), fullPage: true });
} finally { await second.close(); }

const destinationBytes = await readFile(destination);
const destinationHash = createHash("sha256").update(destinationBytes).digest("hex");
if (`sha256:${destinationHash}` !== exportRecord.export_record.sha256) throw new Error("export file hash does not match ExportRecord");
const ffprobePath = join(packageResources, "ffmpeg", "win-x64", "ffprobe.exe");
const probe = JSON.parse(execFileSync(ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", destination], { encoding: "utf8", windowsHide: true }));
if (!probe.streams.some(stream => stream.codec_type === "video" && stream.codec_name === "h264") || !probe.streams.some(stream => stream.codec_type === "audio" && stream.codec_name === "aac")) throw new Error("packaged export FFprobe validation failed");
const installerBytes = await readFile(report.installer_path);
const result = {
  status: "passed", packaged_executable: packagedExe, sidecar_argv: argv,
  manifest_count: models.items.length, provider_status: models.items[0].provider_status,
  transcript: { transcript_id: transcript.transcript_id, segments: transcript.segments.length, words: (transcript.words?.length ?? 0) + transcript.segments.reduce((total, segment) => total + (segment.words?.length ?? 0), 0) },
  timeline: { revision_id: finalState.current_revision.timeline_revision_id, clips: finalState.current_revision.document.clips.length, captions: finalState.current_revision.document.captions.length },
  preview: preview.preview, range, export_record: exportRecord.export_record,
  export_probe: probe, export_size: (await stat(destination)).size, export_sha256: `sha256:${destinationHash}`,
  stale_after_restart: restored.previews.items[0].preview.status, restored_model_count: restored.models.items.length,
  package: { installer_path: report.installer_path, installer_sha256: createHash("sha256").update(installerBytes).digest("hex"), sidecar_sha256: sidecarHash, component_sidecar_sha256: sidecarComponent.sha256 },
  renderer_payload_has_sensitive_keys: /(?:path|uri|token|render_plan|toolchain|admin)/i.test(JSON.stringify({ preview, exportRecord }))
};
if (result.renderer_payload_has_sensitive_keys) throw new Error("Renderer payload leaked sensitive fields");
await mkdir(evidenceRoot, { recursive: true });
await writeFile(join(run, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
await Promise.all([
  writeFile(join(run, "argv.json"), `${JSON.stringify({ sidecar_argv: argv, manifest_dir: join(packageResources, "model-manifests") }, null, 2)}\n`, "utf8"),
  writeFile(join(run, "model-provider.json"), `${JSON.stringify({ manifest_count: models.items.length, models: models.items.map(item => ({ model_id: item.model_id, status: item.status, provider_status: item.provider_status, runtime_version: item.runtime_version })) }, null, 2)}\n`, "utf8"),
  writeFile(join(run, "transcript.json"), `${JSON.stringify({ transcript_id: transcript.transcript_id, status: transcript.status, language: transcript.language, segments: transcript.segments, words: transcript.words }, null, 2)}\n`, "utf8"),
  writeFile(join(run, "render.json"), `${JSON.stringify({ preview: preview.preview, range, export_record: exportRecord.export_record, export_probe: probe, export_size: result.export_size, export_sha256: result.export_sha256 }, null, 2)}\n`, "utf8"),
  writeFile(join(run, "restart.json"), `${JSON.stringify({ timeline_revision_id: restored.timeline.current_revision.timeline_revision_id, preview_status: restored.previews.items[0].preview.status, preview_count: restored.previews.items.length, export_count: restored.exports.items.length, model_count: restored.models.items.length }, null, 2)}\n`, "utf8"),
  writeFile(join(run, "package-hash.json"), `${JSON.stringify(result.package, null, 2)}\n`, "utf8")
]);
await writeFile(join(evidenceRoot, "latest.json"), `${JSON.stringify({ ...result, evidence_dir: run }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...result, evidence_dir: run }, null, 2));
