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
const evidenceRoot = join(root, "test-results", "m2-b1-speed-evidence");

import { existsSync } from "node:fs";

function env(video: string) { return { ...process.env, AIVS_RESOURCES_PATH: resources, AIVS_E2E_ASSET_PATHS: JSON.stringify({ video, image: video }), AIVS_SIDECAR_EXECUTABLE: sidecarExecutable, AIVS_SIDECAR_EXECUTABLE_ARGS: sidecarArgs, PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"), ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }; }
async function launch(userData: string, video: string) { return electron.launch({ args: [join(desktop, "out", "main", "index.js"), `--user-data-dir=${userData}`], cwd: desktop, env: env(video) }); }
async function waitForJob(page: any, jobId: string, timeoutMs = 300_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const job = await page.evaluate((id: string) => window.desktop.getJob(id as never), jobId); if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return job; await page.waitForTimeout(1_000); } throw new Error(`job ${jobId} did not reach a terminal state`); }

test("B1 变速/倒放：属性面板、交互预览 playbackRate、权威预览时长符合源时长÷速度", async () => {
  test.setTimeout(420_000); await mkdir(evidenceRoot, { recursive: true });
  const run = join(evidenceRoot, `run-${process.pid}-${Date.now()}`); const userData = join(run, "user-data"); const video = join(run, "变速素材.mp4"); await mkdir(run, { recursive: true });
  await copyFile(join(root, "test-assets", "generated", "cfr-landscape-av.mp4"), video);
  const app = await launch(userData, video);
  try {
    const page = await app.firstWindow(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });

    // 1. 建项目、导入视频、建时间线，读取源时长。
    const setup = await page.evaluate(async () => {
      const project = await window.desktop.createProject({ name: "B1 Speed E2E" });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
      if (!imported) throw new Error("fixture import cancelled");
      const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
      const clip = created.current_revision.document.clips[0];
      return { project_id: project.project_id, clip_id: clip.clip_id, source_duration_us: clip.timeline_end_us - clip.timeline_start_us };
    });
    expect(setup.source_duration_us).toBeGreaterThan(1_000_000);

    // 2. 通过 API 设 2x + 倒放，验证文档字段与 timeline 时长减半。
    const afterSpeed = await page.evaluate(async ({ projectId, clipId }) => {
      const state = await window.desktop.patchTimeline({ project_id: projectId as never, patch: { schema_version: 1, base_revision_id: (await window.desktop.getTimeline(projectId as never)).current_revision.timeline_revision_id, operations: [{ op: "set_speed", clip_id: clipId as never, speed_milli: 2000 }, { op: "set_reverse_playback", clip_id: clipId as never, reverse_playback: true }], summary: "B1 变速验收" } });
      const clip = state.current_revision.document.clips[0];
      return { speed_milli: clip.speed_milli, reverse_playback: clip.reverse_playback, timeline_us: clip.timeline_end_us - clip.timeline_start_us, can_undo: state.can_undo };
    }, { projectId: setup.project_id, clipId: setup.clip_id });
    expect(afterSpeed.speed_milli).toBe(2000);
    expect(afterSpeed.reverse_playback).toBe(true);
    expect(afterSpeed.timeline_us).toBe(Math.round(setup.source_duration_us / 2));
    expect(afterSpeed.can_undo).toBe(true);

    // 3. UI：等时间线数据加载完成（a11y 片段按钮出现），点击预览帧选中播放头处片段。
    await expect(page.getByRole("button", { name: /Clip 1 video/ })).toBeVisible({ timeout: 30_000 });
    await page.locator(".preview-frame").click();
    await expect(page.locator(".speed-editor")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".speed-editor-title")).toContainText("2x");
    await expect(page.locator(".speed-presets button.active")).toHaveText("2x");
    const reverseChecked = await page.evaluate(() => Array.from(document.querySelectorAll(".property-form label.check")).some(label => label.textContent?.includes("倒放") && (label.querySelector("input") as HTMLInputElement)?.checked));
    expect(reverseChecked).toBe(true);

    // 4. 交互预览：倒放开启时无法反向播放，playbackRate 回退 1（实现约定）。
    const reverseRate = await page.evaluate(() => { const media = document.querySelector("video.preview-foreground") as HTMLVideoElement | null; return media ? media.playbackRate : null; });
    expect(reverseRate).toBe(1);

    // 5. 关闭倒放后 playbackRate 跟随 2x；随后生成权威预览校验产物时长 = 源时长 ÷ 2。
    //    直接调用 preload API 更新的是后端，UI 状态需 reload 重新同步。
    await page.evaluate(async ({ projectId, clipId }) => { const state = await window.desktop.getTimeline(projectId as never); await window.desktop.patchTimeline({ project_id: projectId as never, patch: { schema_version: 1, base_revision_id: state.current_revision.timeline_revision_id, operations: [{ op: "set_reverse_playback", clip_id: clipId as never, reverse_playback: false }], summary: "关闭倒放以校验变速播放与音频时长" } }); }, { projectId: setup.project_id, clipId: setup.clip_id });
    await page.reload(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime()); await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /Clip 1 video/ })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => page.evaluate(() => { const media = document.querySelector("video.preview-foreground") as HTMLVideoElement | null; return media ? media.playbackRate : null; }), { timeout: 15_000 }).toBeCloseTo(2, 5);
    const previewResult = await page.evaluate(async projectId => { const state = await window.desktop.getTimeline(projectId as never); return window.desktop.createPreview({ project_id: projectId as never, preview: { timeline_revision_id: state.current_revision.timeline_revision_id, encoder_mode: "auto" } }); }, setup.project_id);
    if (previewResult.job) { const job = await waitForJob(page, previewResult.job.job_id); expect(job.status).toBe("succeeded"); }
    // 首次生成时响应仅含 job；任务成功后从预览列表取已就绪产物。
    const readyPreview = await page.evaluate(async projectId => { const page = await window.desktop.listPreviews({ project_id: projectId as never, limit: 10 }); return page.items.find(item => item.preview.status === "ready") ?? null; }, setup.project_id);
    expect(readyPreview).toBeTruthy();
    // 产物时长允许 ±83334us（渲染校验同款容差）。
    const expectedUs = Math.round(setup.source_duration_us / 2);
    const actualUs = readyPreview!.preview.media_info.duration_us;
    expect(actualUs).toBeTruthy();
    expect(Math.abs(actualUs - expectedUs)).toBeLessThanOrEqual(83_334);

    await page.screenshot({ path: join(run, "b1-speed-2x.png"), fullPage: true });
    await writeFile(join(run, "result.json"), JSON.stringify({ status: "passed", source_duration_us: setup.source_duration_us, speed_timeline_us: afterSpeed.timeline_us, preview_duration_us: actualUs, expected_us: expectedUs }, null, 2));
  } finally { await app.close(); }
});
