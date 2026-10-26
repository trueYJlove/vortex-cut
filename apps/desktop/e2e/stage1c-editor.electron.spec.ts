import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { expectCurrentProject, selectProject } from "./project-switcher";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../../.."); const desktop = resolve(currentDir, ".."); const resources = join(root, "resources");
const pythonSidecar = join(root, ".venv", "Scripts", "python.exe"); const packagedSidecar = join(resources, "core", "aivs-core", "aivs-core.exe");
const sidecarExecutable = process.env.AIVS_SIDECAR_EXECUTABLE ?? (existsSync(pythonSidecar) ? pythonSidecar : packagedSidecar);
const sidecarArgs = process.env.AIVS_SIDECAR_EXECUTABLE_ARGS ?? (existsSync(pythonSidecar) ? JSON.stringify(["-m", "aivs_core.bootstrap"]) : JSON.stringify([]));
const evidenceRoot = join(root, "test-results", "stage1c-editor-evidence");

function env(video: string, image: string) { return { ...process.env, AIVS_RESOURCES_PATH: resources, AIVS_E2E_ASSET_PATHS: JSON.stringify({ video, image }), AIVS_SIDECAR_EXECUTABLE: sidecarExecutable, AIVS_SIDECAR_EXECUTABLE_ARGS: sidecarArgs, PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"), ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }; }
async function launch(userData: string, video: string, image: string) { return electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`], cwd: desktop, env: env(video, image) }); }
async function waitForJob(page: any, jobId: string, timeoutMs = 240_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const job = await page.evaluate((id: string) => window.desktop.getJob(id as never), jobId); if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return job; await page.waitForTimeout(1_000); } throw new Error(`job ${jobId} did not reach a terminal state`); }

test("1C-Editor 真实 Electron 创建、编辑、Ticket 与重启草稿恢复", async () => {
  test.setTimeout(180_000); await mkdir(evidenceRoot, { recursive: true });
  const run = join(evidenceRoot, `run-${process.pid}-${Date.now()}`); const userData = join(run, "user-data"); const video = join(run, "中文素材.mp4"); const image = join(run, "图片.png"); await mkdir(run, { recursive: true });
  await copyFile(join(root, "test-assets", "generated", "cfr-landscape-av.mp4"), video);
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==", "base64"));
  let projectId = "";
  const first = await launch(userData, video, image);
  try {
    const page = await first.firstWindow(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime()); await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    const result = await page.evaluate(async () => {
      const project = await window.desktop.createProject({ name: "1C Editor E2E" });
      const video = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" }); const image = await window.desktop.importAsset({ project_id: project.project_id, kind: "image" }); if (!video || !image) throw new Error("fixture import cancelled");
      const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: video.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
      let state = await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: created.current_revision.timeline_revision_id, operations: [{ op: "insert_asset_clip", asset_id: image.asset.asset_id, at_index: 1, duration_us: 3_000_000, layout: "fit" }, { op: "set_layout", clip_id: created.current_revision.document.clips[0].clip_id, layout: "crop_fill" }, { op: "add_caption", start_us: 0, end_us: 1_000_000, text: "真实 Electron 字幕", preset_id: "high-contrast", source_clip_id: null }], summary: "E2E 编辑" } });
      const draftDocument = structuredClone(state.current_revision.document); draftDocument.captions[0].text = "重启后恢复的草稿字幕";
      await window.desktop.saveTimelineDraft({ project_id: project.project_id, draft: { schema_version: 1, base_revision_id: state.current_revision.timeline_revision_id, document: draftDocument } });
      const assets = await window.desktop.listAssets({ project_id: project.project_id });
      return { project_id: project.project_id, revision_id: state.current_revision.timeline_revision_id, clips: state.current_revision.document.clips.length, captions: state.current_revision.document.captions.length, media_urls: assets.items.map(item => item.media_url) };
    });
    projectId = result.project_id; expect(result.clips).toBe(2); expect(result.captions).toBe(1); expect(result.media_urls.every((url: string | null) => url === null || /^aivideo:\/\/media\/[A-Za-z0-9_-]{32,}$/.test(url))).toBe(true);
    await page.screenshot({ path: join(run, "editor-before-restart.png"), fullPage: true }); await writeFile(join(run, "result.json"), JSON.stringify(result, null, 2));
  } finally { await first.close(); }
  const second = await launch(userData, video, image);
  try {
    const page = await second.firstWindow(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime()); await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    const restored = await page.evaluate(async projectId => { const state = await window.desktop.getTimeline(projectId as never); const assets = await window.desktop.listAssets({ project_id: projectId as never }); return { draft_text: state.draft?.document.captions[0]?.text, conflict: state.draft?.conflict, urls: assets.items.map(item => item.media_url) }; }, projectId);
    expect(restored.draft_text).toBe("重启后恢复的草稿字幕"); expect(restored.conflict).toBe(false); expect(restored.urls.some((url: string | null) => /^aivideo:\/\/media\//.test(url ?? ""))).toBe(true); await page.screenshot({ path: join(run, "editor-after-restart.png"), fullPage: true });
  } finally { await second.close(); }
});

test("1C-Editor 在 1024x720 下约束长文件名、长字幕和时间线布局", async () => {
  test.setTimeout(180_000); await mkdir(evidenceRoot, { recursive: true });
  const run = join(evidenceRoot, `layout-${process.pid}-${Date.now()}`); const userData = join(run, "user-data"); const longName = `${"超长中文素材文件名".repeat(9)}.mp4`; const video = join(run, longName); const image = join(run, "unused.png"); await mkdir(run, { recursive: true }); await copyFile(join(root, "test-assets", "generated", "cfr-landscape-av.mp4"), video); await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==", "base64"));
  const app = await launch(userData, video, image);
  try {
    const page = await app.firstWindow(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 720)); await page.waitForFunction(() => innerWidth === 1024 && innerHeight === 720); await page.evaluate(() => window.desktop.getRuntime());
    const longCaption = "这是用于验证一千零二十四乘七百二十窗口布局的超长中文字幕。".repeat(6);
    await page.evaluate(async ({ longCaption }) => { const project = await window.desktop.createProject({ name: "1C Layout E2E" }); const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" }); if (!imported) throw new Error("fixture import cancelled"); const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } }); await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: created.current_revision.timeline_revision_id, operations: [{ op: "add_caption", start_us: 0, end_us: 3_000_000, text: longCaption, preset_id: "high-contrast", source_clip_id: null }], summary: "布局压力测试" } }); }, { longCaption });
    // 预览模式在 e2e 侧补齐，产品源码不动：
    // (a) 装配竞态（App 只在 project_id 变化时装配时间线与资产列表）曾靠一次
    //     reload 重跑装配；P195（时间线）与 P199（资产集合对账）已从产品侧修掉，
    //     故不再 reload——留着它只会把要防的缺陷一起盖住。
    // (b) .caption-overlay 只在交互预览渲染（App.tsx:2636），而 previewMode 默认
    //     "synthetic"（App.tsx:253，0357c98「合成预览设为默认」的有意变更）。UI 上
    //     唯一的切换入口是素材箱的「预览播放」（App.tsx:1621 previewFromLibrary →
    //     setPreviewMode("interactive")）：点击后立刻暂停，播放头停住，字幕不随
    //     播放走出 0-3s 区间。不使用 page.evaluate 改 React state。
    await page.evaluate(() => window.desktop.getRuntime());
    await expectCurrentProject(page, "1C Layout E2E"); await expect(page.locator(".timeline-a11y-clips button[aria-label^='Clip ']").first()).toBeAttached({ timeout: 30_000 });
    const previewButton = page.getByRole("button", { name: `预览播放 ${longName}` });
    await page.locator(".asset-row").first().hover();
    await previewButton.click();
    await page.getByRole("button", { name: "暂停" }).click();
    await expect(page.locator(".caption-overlay")).toContainText(longCaption.slice(0, 20), { timeout: 30_000 });
    const geometry = await page.evaluate(() => { const rect = (selector: string) => { const item = document.querySelector(selector); if (!item) throw new Error(`${selector} not found`); const value = item.getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height, scrollWidth: item.scrollWidth, clientWidth: item.clientWidth }; }; const caption = rect(".caption-overlay"); const label = rect(".interactive-label"); return { viewport: { width: innerWidth, height: innerHeight }, documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, library: rect(".library-pane"), track: rect(".timeline-canvas-container"), timeline: rect(".timeline-pane"), caption, label, overlaps: !(caption.right <= label.left || label.right <= caption.left || caption.bottom <= label.top || label.bottom <= caption.top) }; });
    expect(geometry.viewport).toEqual({ width: 1024, height: 720 }); expect(geometry.documentOverflow).toBe(0); expect(geometry.library.scrollWidth).toBeLessThanOrEqual(geometry.library.clientWidth); expect(geometry.track.scrollWidth).toBeLessThanOrEqual(geometry.track.clientWidth); expect(geometry.timeline.height).toBeGreaterThanOrEqual(205); expect(geometry.overlaps).toBe(false);
    await page.screenshot({ path: join(run, "editor-1024x720.png") }); await writeFile(join(run, "layout-result.json"), JSON.stringify({ long_name: longName, caption_length: longCaption.length, geometry }, null, 2));
  } finally { await app.close(); }
});

test("1C-Editor 通过 UI 追加真实 ready Transcript 并在重启后保持", async () => {
  test.setTimeout(420_000); await mkdir(evidenceRoot, { recursive: true });
  const modelDir = process.env.AIVS_E2E_MODEL_DIR; const sourceVideo = process.env.AIVS_E2E_MIXED_VIDEO;
  if (!modelDir || !sourceVideo || !existsSync(modelDir) || !existsSync(sourceVideo)) { await writeFile(join(evidenceRoot, "real-transcript-ui-unverified.json"), JSON.stringify({ status: "unverified", missing: [!modelDir || !existsSync(modelDir ?? "") ? "AIVS_E2E_MODEL_DIR" : null, !sourceVideo || !existsSync(sourceVideo ?? "") ? "AIVS_E2E_MIXED_VIDEO" : null].filter(Boolean) }, null, 2)); test.skip(true, "真实 Transcript UI E2E 前置未提供"); return; }
  const run = join(evidenceRoot, `real-transcript-ui-${process.pid}-${Date.now()}`); const userData = join(run, "user-data"); const video = join(run, "mixed-video.mp4"); const image = join(run, "unused.png"); await mkdir(run, { recursive: true }); await copyFile(sourceVideo, video); await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==", "base64"));
  let expected: { project_id: string; revision_id: string; clips: number; captions: number; transcript_id: string } | undefined;
  const first = await launch(userData, video, image);
  try {
    const page = await first.firstWindow(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime());
    const setup = await page.evaluate(async () => { const project = await window.desktop.createProject({ name: "1C Real Transcript UI" }); const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" }); if (!imported) throw new Error("fixture import cancelled"); const models = await window.desktop.listModels({ limit: 100 }); const model = models.items.find(item => item.status === "ready" && item.provider_status === "installed"); if (!model) throw new Error("real model was not ready"); const transcription = await window.desktop.createTranscription({ asset_id: imported.asset.asset_id, model_id: model.model_id, language: "auto", word_timestamps: true, license_acceptance: null }); return { project_id: project.project_id, asset_id: imported.asset.asset_id, job_id: transcription.job.job_id }; });
    const job = await waitForJob(page, setup.job_id); expect(job.status).toBe("succeeded"); const ready = await page.evaluate(async assetId => { const items = await window.desktop.listTranscripts(assetId as never); const transcript = await window.desktop.getTranscript(items.items[0].transcript_id); return { transcript_id: transcript.transcript_id, segment_count: transcript.segments.length }; }, setup.asset_id); expect(ready.segment_count).toBeGreaterThan(0);
    await page.evaluate(async projectId => window.desktop.createTimeline({ project_id: projectId as never, timeline: { schema_version: 1, source: { kind: "empty" }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } }), setup.project_id);
    await expectCurrentProject(page, "1C Real Transcript UI"); await selectProject(page, setup.project_id); await page.getByRole("tab", { name: "转录", exact: true }).click(); await expect(page.locator(".transcript-item")).toBeVisible({ timeout: 30_000 }); const before = await page.evaluate(projectId => window.desktop.getTimeline(projectId as never), setup.project_id); await page.locator(".segment-row input[type=checkbox]").first().check(); await page.getByRole("button", { name: "追加所选片段" }).click();
    await expect.poll(async () => { const state = await page.evaluate(projectId => window.desktop.getTimeline(projectId as never), setup.project_id); return { clips: state.current_revision.document.clips.length, captions: state.current_revision.document.captions.length }; }, { timeout: 30_000 }).toEqual({ clips: before.current_revision.document.clips.length + 1, captions: before.current_revision.document.captions.length + 1 });
    const persisted = await page.evaluate(projectId => window.desktop.getTimeline(projectId as never), setup.project_id); expect(persisted.current_revision.document.clips.length).toBeGreaterThan(before.current_revision.document.clips.length); expect(persisted.current_revision.document.captions.length).toBeGreaterThan(before.current_revision.document.captions.length); expect(await page.locator("body").innerText()).not.toContain("TIMELINE_INVALID"); expected = { project_id: setup.project_id, revision_id: persisted.current_revision.timeline_revision_id, clips: persisted.current_revision.document.clips.length, captions: persisted.current_revision.document.captions.length, transcript_id: ready.transcript_id };
    await page.screenshot({ path: join(run, "after-ui-append.png") });
  } finally { await first.close(); }
  if (!expected) throw new Error("real Transcript UI state was not recorded");
  const second = await launch(userData, video, image);
  try { const page = await second.firstWindow(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime()); const restored = await page.evaluate(projectId => window.desktop.getTimeline(projectId as never), expected.project_id); expect(restored.current_revision.timeline_revision_id).toBe(expected.revision_id); expect(restored.current_revision.document.clips.length).toBe(expected.clips); expect(restored.current_revision.document.captions.length).toBe(expected.captions); await page.screenshot({ path: join(run, "after-restart.png") }); } finally { await second.close(); }
  const database = join(userData, "data-v2", "app.db"); const databaseCheck = spawnSync(pythonSidecar, ["-c", "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); p=sys.argv[2]; print(json.dumps({'revisions':c.execute('select count(*) from timeline_revisions where project_id=?',(p,)).fetchone()[0],'navigation':c.execute('select count(*) from timeline_navigation where project_id=?',(p,)).fetchone()[0]}))", database, expected.project_id], { encoding: "utf8", windowsHide: true }); if (databaseCheck.status !== 0) throw new Error(databaseCheck.stderr); const databaseEvidence = JSON.parse(databaseCheck.stdout.trim()); expect(databaseEvidence.revisions).toBeGreaterThanOrEqual(2); await writeFile(join(run, "result.json"), JSON.stringify({ status: "passed", ...expected, database: databaseEvidence }, null, 2));
});
