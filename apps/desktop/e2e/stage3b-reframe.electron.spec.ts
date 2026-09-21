import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../../..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");
const python = join(root, ".venv", "Scripts", "python.exe");

async function waitForJob(page: any, jobId: string): Promise<any> {
  return expect.poll(async () => page.evaluate((id: string) => window.desktop.getJob(id as never), jobId), { timeout: 240_000 }).toMatchObject({ status: "succeeded" });
}

function hasSensitive(value: unknown, absoluteNeedles: string[]): boolean {
  const text = JSON.stringify(value).toLowerCase();
  const forbidden = ["absolute_path", "destination_path", "source_path", "stderr", "ffmpeg_command", "authorization", "api_key", "provider_payload", "transcript", "caption_text"];
  return forbidden.some(key => text.includes(key)) || absoluteNeedles.some(path => text.includes(path.toLowerCase().replaceAll("\\", "\\\\")) || text.includes(path.toLowerCase()));
}

test("3B 真实 Electron 独立 Reframe Preview、Ticket、Batch 与 Provider 0", async () => {
  test.setTimeout(420_000);
  const run = join(root, "test-results", `stage3b-electron-${process.pid}-${Date.now()}`);
  const userData = join(run, "user-data");
  const video = join(run, "stage3b-real.mp4");
  const exports = join(run, "exports");
  await mkdir(exports, { recursive: true });
  await copyFile(join(root, "test-assets", "generated", "cfr-landscape-av.mp4"), video);
  const app = await electron.launch({
    args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`],
    cwd: desktop,
    env: {
      ...process.env,
      AIVS_RESOURCES_PATH: resources,
      AIVS_E2E_ASSET_PATHS: JSON.stringify({ video }),
      AIVS_E2E_EXPORT_DIRECTORY: exports,
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
      const project = await window.desktop.createProject({ name: "Stage 3B Electron" });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
      if (!imported) throw new Error("fixture cancelled");
      const timeline = await window.desktop.createTimeline({
        project_id: project.project_id,
        timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "crop_fill", caption_preset_id: "default-bottom" }
      });
      return { project_id: project.project_id, revision_id: timeline.current_revision.timeline_revision_id, clip_id: timeline.current_revision.document.clips[0].clip_id };
    });
    const baseCreate = await page.evaluate(async input => window.desktop.createRenditionPreview({
      project_id: input.project_id as never,
      preview: { timeline_revision_id: input.revision_id as never, platform_preset_id: "generic", rendition_preset_id: "portrait-9x16-v1", layout_policy: "crop_fill_all", encoder_mode: "software" }
    }), setup);
    expect(baseCreate.job).not.toBeNull();
    await waitForJob(page, baseCreate.job.job_id);
    const base = await page.evaluate(async projectId => (await window.desktop.listRenditionPreviews({ project_id: projectId as never, limit: 100 })).items[0], setup.project_id);
    const reframeCreate = await page.evaluate(async input => window.desktop.createRenditionReframePreview({
      project_id: input.project_id as never,
      preview: { base_rendition_snapshot_id: input.base_id as never, adjustments: [{ clip_id: input.clip_id as never, horizontal_anchor: "left", vertical_anchor: "center" }], encoder_mode: "software" }
    }), { project_id: setup.project_id, base_id: base.preview.rendition_snapshot_id, clip_id: setup.clip_id });
    expect(reframeCreate.job).not.toBeNull();
    await waitForJob(page, reframeCreate.job.job_id);
    const reframe = await page.evaluate(async projectId => (await window.desktop.listRenditionReframePreviews({ project_id: projectId as never, limit: 100 })).items[0], setup.project_id);
    expect(reframe.media_url).toMatch(/^aivideo:\/\/media\/[A-Za-z0-9_-]{32,}$/);
    const range = await page.evaluate(async url => {
      const response = await fetch(url, { headers: { Range: "bytes=0-31" } });
      return { status: response.status, length: (await response.arrayBuffer()).byteLength };
    }, reframe.media_url);
    expect(range).toEqual({ status: 206, length: 32 });
    const grant = await page.evaluate(projectId => window.desktop.chooseExportDirectory(projectId as never), setup.project_id);
    expect(grant).not.toBeNull();
    const created = await page.evaluate(async input => window.desktop.createReframeExportBatch({
      project_id: input.project_id as never,
      batch: { directory_grant_id: input.grant_id as never, items: [{ rendition_reframe_snapshot_id: input.snapshot_id as never, preview_artifact_id: input.preview_id as never, encoder_mode: "software" }] }
    }), { project_id: setup.project_id, grant_id: grant.directory_grant_id, snapshot_id: reframe.preview.rendition_reframe_snapshot_id, preview_id: reframe.preview.render_artifact_id });
    expect(created.jobs).toHaveLength(1);
    await waitForJob(page, created.jobs[0].job_id);
    const batch = await page.evaluate(id => window.desktop.getReframeExportBatch(id), created.batch.reframe_export_batch_id);
    expect(batch.status).toBe("succeeded");
    const publicState = { setup, base, reframe, range, batch };
    expect(hasSensitive(publicState, [video, exports, userData])).toBe(false);
    const providerCount = await page.evaluate(async projectId => {
      const jobs = await window.desktop.listJobs({ project_id: projectId as never, limit: 100 });
      return jobs.items.filter(item => item.kind.includes("provider")).length;
    }, setup.project_id);
    expect(providerCount).toBe(0);
  } finally {
    await app.close().catch(() => undefined);
  }
});
