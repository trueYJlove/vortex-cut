import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir } from "node:fs/promises";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] }));
const electron = playwright._electron;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const desktop = resolve(here, "..");
const resources = join(root, "resources");
const pythonSidecar = join(root, ".venv", "Scripts", "python.exe");
const sidecarArgs = JSON.stringify(["-m", "aivs_core.bootstrap"]);
const runDir = join(root, ".tmp", "shots", process.env.SHOT_TAG || "before");
const video = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");

function env() {
  return { ...process.env,
    AIVS_RESOURCES_PATH: resources,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video }),
    AIVS_SIDECAR_EXECUTABLE: pythonSidecar,
    AIVS_SIDECAR_EXECUTABLE_ARGS: sidecarArgs,
    PYTHONPATH: [join(root, "services", "core", "src")].join(";"),
    ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined };
}

async function captureForTheme(mode, label) {
  const userData = join(runDir, "user-data-" + mode);
  await mkdir(userData, { recursive: true });
  const app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), "--user-data-dir=" + userData], cwd: desktop, env: env() });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 30000 });
  await page.evaluate(() => window.desktop.getRuntime());
  // pin theme before any snapshot
  await page.evaluate(m => localStorage.setItem("vortexcut.theme", m), mode);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 30000 });
  await page.evaluate(() => window.desktop.getRuntime());
  await page.waitForSelector("text=Core 已连接", { timeout: 30000 });

  // build a small project: video asset + timeline with two 2s clips
  await page.evaluate(async () => {
    const project = await window.desktop.createProject({ name: "UI Capture" });
    const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
    if (!imported) throw new Error("import cancelled");
    const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
    const firstClipId = created.current_revision.document.clips[0].clip_id;
    await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: created.current_revision.timeline_revision_id, operations: [
      { op: "trim_clip", clip_id: firstClipId, source_start_us: 0, source_end_us: 2000000 },
      { op: "insert_asset_clip", asset_id: imported.asset.asset_id, at_index: 1, source_start_us: 0, source_end_us: 2000000 },
    ], summary: "capture" } });
    return project.project_id;
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 30000 });
  await page.evaluate(() => window.desktop.getRuntime());
  await page.waitForSelector("text=Core 已连接", { timeout: 30000 });
  await page.waitForTimeout(2500); // thumbnails + canvas settle

  const dir = join(runDir, mode);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, "workspace.png") });
  const tl = page.locator(".timeline-canvas-container canvas").first();
  try { await tl.screenshot({ path: join(dir, "timeline.png"), timeout: 8000 }); } catch { console.log(label, ": timeline element shot failed"); }
  try {
    await page.getByRole("button", { name: /设置/ }).first().click({ timeout: 5000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(dir, "settings.png") });
    await page.keyboard.press("Escape");
  } catch { console.log(label, ": settings shot skipped"); }
  await app.close();
  console.log(label, ": captured");
}

await captureForTheme("light", "light");
await captureForTheme("dark", "dark");
console.log("DONE");
