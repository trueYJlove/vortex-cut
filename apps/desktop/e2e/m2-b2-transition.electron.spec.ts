import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../../.."); const desktop = resolve(currentDir, ".."); const resources = join(root, "resources");
const pythonSidecar = join(root, ".venv", "Scripts", "python.exe"); const packagedSidecar = join(resources, "core", "aivs-core", "aivs-core.exe");
const sidecarExecutable = process.env.AIVS_SIDECAR_EXECUTABLE ?? (existsSync(pythonSidecar) ? pythonSidecar : packagedSidecar);
const sidecarArgs = process.env.AIVS_SIDECAR_EXECUTABLE_ARGS ?? (existsSync(pythonSidecar) ? JSON.stringify(["-m", "aivs_core.bootstrap"]) : JSON.stringify([]));
const evidenceRoot = join(root, "test-results", "m2-b2-transition-evidence");

import { existsSync } from "node:fs";

function env(video: string) { return { ...process.env, AIVS_RESOURCES_PATH: resources, AIVS_E2E_ASSET_PATHS: JSON.stringify({ video, image: video }), AIVS_SIDECAR_EXECUTABLE: sidecarExecutable, AIVS_SIDECAR_EXECUTABLE_ARGS: sidecarArgs, PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"), ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }; }
async function launch(userData: string, video: string) { return electron.launch({ args: [join(desktop, "out", "main", "index.js"), `--user-data-dir=${userData}`], cwd: desktop, env: env(video) }); }
async function waitForJob(page: any, jobId: string, timeoutMs = 300_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const job = await page.evaluate((id: string) => window.desktop.getJob(id as never), jobId); if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return job; await page.waitForTimeout(1_000); } throw new Error(`job ${jobId} did not reach a terminal state`); }

test("B2 转场：add_transition 后权威预览时长 = 总时长 − 转场区间", async () => {
  test.setTimeout(420_000); await mkdir(evidenceRoot, { recursive: true });
  const run = join(evidenceRoot, `run-${process.pid}-${Date.now()}`); const userData = join(run, "user-data"); const video = join(run, "转场素材.mp4"); await mkdir(run, { recursive: true });
  await copyFile(join(root, "test-assets", "generated", "cfr-landscape-av.mp4"), video);
  const app = await launch(userData, video);
  try {
    const page = await app.firstWindow(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });

    // 1. 建项目：同一视频插两次 → V1 两段；各 trim 到 2s（源总长 3s，留转场借用余量）。
    const setup = await page.evaluate(async () => {
      const project = await window.desktop.createProject({ name: "B2 Transition E2E" });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
      if (!imported) throw new Error("fixture import cancelled");
      const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
      const firstClipId = created.current_revision.document.clips[0].clip_id;
      const state = await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: created.current_revision.timeline_revision_id, operations: [
        { op: "trim_clip", clip_id: firstClipId as never, source_start_us: 0, source_end_us: 2_000_000 },
        { op: "insert_asset_clip", asset_id: imported.asset.asset_id, at_index: 1, source_start_us: 0, source_end_us: 2_000_000 },
      ], summary: "第二段" } });
      const clips = state.current_revision.document.clips;
      const totalUs = clips.reduce((sum, clip) => sum + (clip.timeline_end_us - clip.timeline_start_us), 0);
      return { project_id: project.project_id, first_clip_id: firstClipId, clip_count: clips.length, total_us: totalUs };
    });
    expect(setup.clip_count).toBe(2);
    expect(setup.total_us).toBe(4_000_000);

    // 2. 添加 0.5s fade 转场 + 生成权威预览，产物时长 = 总长 − 0.5s（±83ms）。
    const result = await page.evaluate(async ({ projectId, firstClipId }) => {
      const state = await window.desktop.getTimeline(projectId as never);
      return window.desktop.patchTimeline({ project_id: projectId as never, patch: { schema_version: 1, base_revision_id: state.current_revision.timeline_revision_id, operations: [{ op: "add_transition", after_clip_id: firstClipId as never, kind: "fade", duration_us: 500_000 }], summary: "B2 转场验收" } });
    }, { projectId: setup.project_id, firstClipId: setup.first_clip_id });
    expect(result.current_revision.document.transitions?.length).toBe(1);
    const previewResult = await page.evaluate(async projectId => { const state = await window.desktop.getTimeline(projectId as never); return window.desktop.createPreview({ project_id: projectId as never, preview: { timeline_revision_id: state.current_revision.timeline_revision_id, encoder_mode: "auto" } }); }, setup.project_id);
    if (previewResult.job) {
      const job = await waitForJob(page, previewResult.job.job_id);
      if (job.status !== "succeeded") { await writeFile(join(run, "failed-job.json"), JSON.stringify(job, null, 2)); }
      expect(job.status).toBe("succeeded");
    }
    const readyPreview = await page.evaluate(async projectId => { const page = await window.desktop.listPreviews({ project_id: projectId as never, limit: 10 }); return page.items.find(item => item.preview.status === "ready") ?? null; }, setup.project_id);
    expect(readyPreview).toBeTruthy();
    const expectedUs = setup.total_us - 500_000;
    const actualUs = readyPreview!.preview.media_info.duration_us;
    expect(Math.abs(actualUs - expectedUs)).toBeLessThanOrEqual(83_334);

    // 3. UI：转场标记渲染可见，点击选中后属性面板出现（kind/时长/删除）。
    await page.reload(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime()); await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /Clip .* video/ }).first()).toBeVisible({ timeout: 30_000 });
    const marker = page.locator(".timeline-transition-marker");
    await expect(marker).toHaveCount(1, { timeout: 15_000 });
    await marker.click();
    await expect(page.locator(".property-form h2", { hasText: "转场属性" })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".property-form select").first()).toHaveValue("fade");

    // 4. 删除转场 → 预览过期；重新生成后时长恢复总长。
    await page.evaluate(async ({ projectId, transitionId }) => { const state = await window.desktop.getTimeline(projectId as never); await window.desktop.patchTimeline({ project_id: projectId as never, patch: { schema_version: 1, base_revision_id: state.current_revision.timeline_revision_id, operations: [{ op: "remove_transition", transition_id: transitionId as never }], summary: "删除转场" } }); }, { projectId: setup.project_id, transitionId: result.current_revision.document.transitions![0].transition_id });
    const preview2 = await page.evaluate(async projectId => { const state = await window.desktop.getTimeline(projectId as never); return window.desktop.createPreview({ project_id: projectId as never, preview: { timeline_revision_id: state.current_revision.timeline_revision_id, encoder_mode: "auto" } }); }, setup.project_id);
    if (preview2.job) { const job = await waitForJob(page, preview2.job.job_id); expect(job.status).toBe("succeeded"); }
    const ready2 = await page.evaluate(async projectId => { const page = await window.desktop.listPreviews({ project_id: projectId as never, limit: 10 }); return page.items.filter(item => item.preview.status === "ready").at(0) ?? null; }, setup.project_id);
    expect(ready2).toBeTruthy();
    expect(Math.abs(ready2!.preview.media_info.duration_us - setup.total_us)).toBeLessThanOrEqual(83_334);

    await page.screenshot({ path: join(run, "b2-transition.png"), fullPage: true });
    await writeFile(join(run, "result.json"), JSON.stringify({ status: "passed", total_us: setup.total_us, with_transition_us: actualUs, expected_with_transition_us: expectedUs, without_transition_us: ready2!.preview.media_info.duration_us }, null, 2));
  } finally { await app.close(); }
});
