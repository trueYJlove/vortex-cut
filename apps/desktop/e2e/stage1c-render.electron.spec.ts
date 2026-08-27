import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { expectCurrentProject, selectProject } from "./project-switcher";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../../..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");
const python = join(root, ".venv", "Scripts", "python.exe");
const evidenceRoot = join(root, "test-results", "stage1c-render-evidence");

test("1C-Render 真实 Electron 权威预览、Artifact Ticket 与最终导出", async () => {
  test.setTimeout(420_000);
  const run = join(evidenceRoot, `run-${process.pid}-${Date.now()}`);
  const userData = join(run, "user-data");
  const video = join(run, "中文素材.mp4");
  const destination = join(run, "最终导出.mp4");
  await mkdir(run, { recursive: true });
  await copyFile(join(root, "test-assets", "generated", "cfr-landscape-av.mp4"), video);
  const app = await electron.launch({
    args: [join(desktop, "out", "main", "index.js"), `--user-data-dir=${userData}`],
    cwd: desktop,
    env: {
      ...process.env,
      AIVS_RESOURCES_PATH: resources,
      AIVS_E2E_ASSET_PATHS: JSON.stringify({ video }),
      AIVS_E2E_EXPORT_PATH: destination,
      AIVS_SIDECAR_EXECUTABLE: python,
      AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
      PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
      ELECTRON_RUN_AS_NODE: undefined,
      NODE_OPTIONS: undefined
    }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    const setup = await page.evaluate(async () => {
      const project = await window.desktop.createProject({ name: "1C Render E2E" });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
      if (!imported) throw new Error("fixture import cancelled");
      const timeline = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
      return { project_id: project.project_id, revision_id: timeline.current_revision.timeline_revision_id };
    });
    await expectCurrentProject(page, "1C Render E2E");
    await selectProject(page, setup.project_id);
    await expect(page.getByRole("button", { name: "生成权威预览" })).toBeEnabled({ timeout: 30_000 });
    await page.getByLabel("编码模式").selectOption("software");
    await page.getByRole("button", { name: "生成权威预览" }).click();
    const preview = await expect.poll(async () => page.evaluate(async projectId => {
      const jobs = await window.desktop.listJobs({ project_id: projectId as never, limit: 100 });
      const job = jobs.items.find(item => item.kind === "authoritative_preview");
      const previews = await window.desktop.listPreviews({ project_id: projectId as never, limit: 100 });
      return { job_status: job?.status ?? null, item: previews.items[0] ?? null };
    }, setup.project_id), { timeout: 240_000 }).toMatchObject({ job_status: "succeeded", item: { preview: { status: "ready", timeline_revision_id: setup.revision_id, encoder: "libopenh264" } } });
    const previewResult = await page.evaluate(async projectId => (await window.desktop.listPreviews({ project_id: projectId as never, limit: 100 })).items[0], setup.project_id);
    expect(previewResult.media_url).toMatch(/^aivideo:\/\/media\/[A-Za-z0-9_-]{32,}$/);
    const playback = await page.evaluate(async url => { const response = await fetch(url, { headers: { Range: "bytes=0-31" } }); return { status: response.status, length: (await response.arrayBuffer()).byteLength }; }, previewResult.media_url);
    expect(playback).toEqual({ status: 206, length: 32 });
    const renderPanelClose = page.getByRole("button", { name: "关闭渲染与导出" });
    if (await renderPanelClose.isVisible().catch(() => false)) { await renderPanelClose.click(); await expect(page.getByRole("button", { name: "关闭渲染与导出" })).toHaveCount(0, { timeout: 10_000 }); }
    await page.getByRole("button", { name: "权威预览", exact: true }).click();
    await expect(page.getByLabel("权威预览视频")).toBeVisible();

    await page.getByRole("button", { name: "导出正式视频" }).click();
    await expect.poll(async () => page.evaluate(async projectId => {
      const jobs = await window.desktop.listJobs({ project_id: projectId as never, limit: 100 });
      const job = jobs.items.find(item => item.kind === "final_export");
      const exports = await window.desktop.listExports({ project_id: projectId as never, limit: 100 });
      return { job_status: job?.status ?? null, item: exports.items[0] ?? null };
    }, setup.project_id), { timeout: 240_000 }).toMatchObject({ job_status: "succeeded", item: { export_record: { status: "succeeded", destination_display_name: "最终导出.mp4", timeline_revision_id: setup.revision_id, encoder: "libopenh264" } } });
    await expect(page.getByText("最终导出.mp4")).toBeVisible({ timeout: 30_000 });
    const destinationInfo = await stat(destination);
    expect(destinationInfo.size).toBeGreaterThan(0);
    const rendererPayload = await page.evaluate(async projectId => ({ previews: await window.desktop.listPreviews({ project_id: projectId as never }), exports: await window.desktop.listExports({ project_id: projectId as never }) }), setup.project_id);
    expect(JSON.stringify(rendererPayload)).not.toMatch(/(?:path|uri|token|render_plan_json|toolchain_json)/i);
    await page.screenshot({ path: join(run, "render-ready.png"), fullPage: true });
    await writeFile(join(run, "result.json"), JSON.stringify({ status: "passed", setup, playback, destination_size: destinationInfo.size, renderer_payload: rendererPayload }, null, 2));
  } finally {
    await app.close();
  }
});
