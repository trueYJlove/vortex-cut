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
const sidecarArgs = JSON.stringify(["-m", "aivs_core.bootstrap"]);
const runDir = join(root, ".tmp", "p231-verify");
const video = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
const image = join(root, "test-assets", "generated", "poster.png");

function env() {
  return { ...process.env,
    AIVS_RESOURCES_PATH: resources,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video, image }),
    AIVS_SIDECAR_EXECUTABLE: pythonSidecar,
    AIVS_SIDECAR_EXECUTABLE_ARGS: sidecarArgs,
    PYTHONPATH: [join(root, "services", "core", "src")].join(";"),
    ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined };
}

async function main() {
  await mkdir(runDir, { recursive: true });
  const userData = join(runDir, "user-data");
  await mkdir(userData, { recursive: true });
  const app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), "--user-data-dir=" + userData], cwd: desktop, env: env() });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 30000 });
  await page.evaluate(() => window.desktop.getRuntime());
  await page.waitForSelector("text=Core 已连接", { timeout: 30000 });

  await page.evaluate(async () => {
    const project = await window.desktop.createProject({ name: "P231 Verify" });
    const vid = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
    const img = await window.desktop.importAsset({ project_id: project.project_id, kind: "image" });
    if (!vid || !img) throw new Error("import cancelled");
    const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: vid.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
    const base = created.current_revision.timeline_revision_id;
    const v1Clip = created.current_revision.document.clips[0].clip_id;
    await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: base, operations: [
      { op: "add_track", kind: "video" },
      { op: "insert_asset_clip", asset_id: img.asset.asset_id, at_index: 0, track_id: "V2", duration_us: 3000000 },
      { op: "set_clip_transform", clip_id: v1Clip, transform: { x: 0.5, y: 0.5, scale: 0.7, rotate: 0, opacity: 1 } },
    ], summary: "p231-verify" } });
    return project.project_id;
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 30000 });
  await page.evaluate(() => window.desktop.getRuntime());
  await page.waitForSelector("text=Core 已连接", { timeout: 30000 });
  await page.waitForTimeout(3500);

  await page.screenshot({ path: join(runDir, "workspace.png") });
  const canvas = page.locator("canvas[aria-label=\"预览画布\"], .preview-canvas canvas").first();
  try { await canvas.screenshot({ path: join(runDir, "preview.png"), timeout: 8000 }); } catch (e) { console.log("preview shot failed:", e.message); }
  const tl = page.locator(".timeline-canvas-container canvas").first();
  try { await tl.screenshot({ path: join(runDir, "timeline.png"), timeout: 8000 }); } catch (e) { console.log("timeline shot failed:", e.message); }

  console.log("P231 verify captures saved to", runDir);
  await app.close();
}
main().catch(e => { console.error(e); process.exit(1); });