import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] }));
const electron = playwright._electron;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const desktop = resolve(here, "..");
const resources = join(root, "resources");
const pythonSidecar = join(root, ".venv", "Scripts", "python.exe");
const runDir = join(root, ".tmp", "shots", "audit");
const video = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");

function env() {
  return { ...process.env,
    AIVS_RESOURCES_PATH: resources,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video }),
    AIVS_SIDECAR_EXECUTABLE: pythonSidecar,
    AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
    PYTHONPATH: join(root, "services", "core", "src"),
    ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined };
}

async function shot(page, dir, name) {
  await page.screenshot({ path: join(dir, name + ".png") });
  console.log("captured:", name);
}

async function closeAnyDialog(page) {
  for (let i = 0; i < 3; i++) {
    const backdrop = await page.locator(".modal-backdrop").count();
    if (!backdrop) break;
    // try explicit dismiss buttons first
    for (const label of ["暂不下载", "取消", "关闭"]) {
      const btn = page.getByRole("button", { name: label }).first();
      if (await btn.count() && await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(350);
        break;
      }
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
  }
}

const userData = join(runDir, "user-data");
await mkdir(userData, { recursive: true });
const app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), "--user-data-dir=" + userData], cwd: desktop, env: env() });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 30000 });
  await page.evaluate(() => window.desktop.getRuntime());
  await page.evaluate(() => localStorage.setItem("vortexcut.theme", "light"));
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 30000 });
  await page.evaluate(() => window.desktop.getRuntime());
  await page.waitForSelector("text=Core 已连接", { timeout: 30000 });
  const dir = join(runDir, "light2");
  await mkdir(dir, { recursive: true });

  await page.evaluate(async () => {
    const project = await window.desktop.createProject({ name: "Light Audit 2" });
    const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
    if (!imported) throw new Error("import cancelled");
    const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
    const firstClipId = created.current_revision.document.clips[0].clip_id;
    await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: created.current_revision.timeline_revision_id, operations: [
      { op: "trim_clip", clip_id: firstClipId, source_start_us: 0, source_end_us: 2000000 },
      { op: "insert_asset_clip", asset_id: imported.asset.asset_id, at_index: 1, source_start_us: 0, source_end_us: 2000000 },
    ], summary: "audit2" } });
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 30000 });
  await page.evaluate(() => window.desktop.getRuntime());
  await page.waitForSelector("text=Core 已连接", { timeout: 30000 });
  await page.waitForTimeout(2500);

  // dialogs from properties pane
  for (const [label, file] of [["导出正式视频", "09-export-dialog"], ["打开项目管理", "10-project-dialog"]]) {
    try {
      await page.getByRole("button", { name: label }).first().click({ timeout: 5000 });
      await page.waitForTimeout(900);
      await shot(page, dir, file);
      await closeAnyDialog(page);
    } catch (e) { console.log("skip", file, String(e).slice(0, 90)); await closeAnyDialog(page); }
  }

  // footer dialogs
  for (const [label, file] of [["Provider 设置", "11-provider"], ["版本比较", "12-revision"], ["AI 修改", "13-ai"], ["设置", "14-settings"]]) {
    try {
      await page.getByRole("button", { name: label }).first().click({ timeout: 5000 });
      await page.waitForTimeout(900);
      await shot(page, dir, file);
      await closeAnyDialog(page);
    } catch (e) { console.log("skip", file, String(e).slice(0, 90)); await closeAnyDialog(page); }
  }

  // clip selected → properties
  const canvas = page.locator(".timeline-canvas-container canvas").first();
  const box = await canvas.boundingBox();
  if (box) {
    await canvas.click({ position: { x: 150, y: 150 } });
    await page.waitForTimeout(700);
    await shot(page, dir, "15-clip-selected");
    await canvas.click({ button: "right", position: { x: 150, y: 150 } });
    await page.waitForTimeout(500);
    await shot(page, dir, "16-context-menu");
    await page.keyboard.press("Escape");
  }
  try {
    await page.getByRole("button", { name: "时间线显示设置" }).click({ timeout: 4000 });
    await page.waitForTimeout(400);
    await shot(page, dir, "17-display-flyout");
    await page.keyboard.press("Escape");
  } catch (e) { console.log("skip 17", String(e).slice(0, 90)); }
  try {
    await page.getByRole("button", { name: "播放设置" }).click({ timeout: 4000 });
    await page.waitForTimeout(400);
    await shot(page, dir, "18-rate-pop");
    await page.keyboard.press("Escape");
  } catch (e) { console.log("skip 18", String(e).slice(0, 90)); }
  // volume pop + zoom pop (player bar)
  try {
    await page.getByRole("button", { name: "音量" }).click({ timeout: 4000 });
    await page.waitForTimeout(400);
    await shot(page, dir, "19-volume-pop");
    await page.keyboard.press("Escape");
  } catch (e) { console.log("skip 19", String(e).slice(0, 90)); }
  try {
    await page.getByRole("button", { name: /预览缩放/ }).click({ timeout: 4000 });
    await page.waitForTimeout(400);
    await shot(page, dir, "20-zoom-pop");
    await page.keyboard.press("Escape");
  } catch (e) { console.log("skip 20", String(e).slice(0, 90)); }

  console.log("AUDIT2 DONE");
} finally {
  await app.close();
}
