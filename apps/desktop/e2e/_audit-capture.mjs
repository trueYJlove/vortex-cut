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
const resourcesFlag = process.env.AIVS_RESOURCES_PATH || join(root, "resources");
const pythonSidecar = join(root, ".venv", "Scripts", "python.exe");
const sidecarArgs = JSON.stringify(["-m", "aivs_core.bootstrap"]);
const runDir = process.env.SHOT_DIR || join(root, ".tmp", "uiaudit");
const video = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
const portrait = join(root, "test-assets", "generated", "vertical-real.mp4");

function env() {
  return { ...process.env,
    AIVS_RESOURCES_PATH: resourcesFlag,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video, portrait }),
    AIVS_SIDECAR_EXECUTABLE: pythonSidecar,
    AIVS_SIDECAR_EXECUTABLE_ARGS: sidecarArgs,
    PYTHONPATH: [join(root, "services", "core", "src")].join(";"),
    ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined };
}

async function capture(mode) {
  const userData = join(runDir, "user-data-" + mode);
  await mkdir(userData, { recursive: true });
  const app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), "--user-data-dir=" + userData], cwd: desktop, env: env() });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 40000 });
  await page.evaluate(() => window.desktop.getRuntime());
  await page.evaluate(m => localStorage.setItem("vortexcut.theme", m), mode);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 40000 });
  await page.evaluate(() => window.desktop.getRuntime());
  await page.waitForSelector("text=Core 已连接", { timeout: 40000 });

  const info = await page.evaluate(async () => {
    const project = await window.desktop.createProject({ name: "UI Audit" });
    const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
    if (!imported) throw new Error("import cancelled");
    const a = imported.asset.asset_id;
    const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: a }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
    const first = created.current_revision.document.clips[0].clip_id;
    await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: created.current_revision.timeline_revision_id, operations: [
      { op: "trim_clip", clip_id: first, source_start_us: 0, source_end_us: 2400000 },
      { op: "insert_asset_clip", asset_id: a, at_index: 1, source_start_us: 0, source_end_us: 1800000 },
      { op: "insert_asset_clip", asset_id: a, at_index: 2, source_start_us: 0, source_end_us: 1500000 },
    ], summary: "audit" } });
    return { project: project.project_id, clip: first, asset: a };
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 40000 });
  await page.evaluate(() => window.desktop.getRuntime());
  await page.waitForSelector("text=Core 已连接", { timeout: 40000 });
  await page.waitForTimeout(3000);

  const dir = join(runDir, mode);
  await mkdir(dir, { recursive: true });

  // 1. whole workspace, nothing selected (project properties on the right)
  await page.screenshot({ path: join(dir, "01-workspace-empty.png") });

  // 2. select a timeline clip so the clip properties show
  const clip = page.locator(".timeline-clip, [data-clip-id], .tl-clip").first();
  let selected = false;
  try {
    await clip.click({ timeout: 6000 });
    selected = true;
  } catch {
    try { await page.mouse.click(360, 800, { timeout: 4000 }); selected = "mouse"; } catch {}
  }
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(dir, "02-workspace-clip-selected.png") });

  // 3. timeline region only
  const tl = page.locator(".timeline-pane").first();
  try { await tl.screenshot({ path: join(dir, "03-timeline.png"), timeout: 8000 }); } catch { console.log("timeline shot failed"); }

  // 4. preview stage only
  const st = page.locator(".preview-stage, .stage-column").first();
  try { await st.screenshot({ path: join(dir, "04-preview.png"), timeout: 8000 }); } catch { console.log("preview shot failed"); }

  // 5. inspector only
  const prop = page.locator(".properties-pane").first();
  try { await prop.screenshot({ path: join(dir, "05-inspector.png"), timeout: 8000 }); } catch { console.log("inspector shot failed"); }

  // 6. collect computed metrics for the review
  const metrics = await page.evaluate(() => {
    const g = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { sel, w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor, color: cs.color, border: cs.borderTopWidth + " " + cs.borderTopColor, radius: cs.borderRadius, fs: cs.fontSize, fw: cs.fontWeight, ff: cs.fontFamily.split(",")[0], lh: cs.lineHeight }; };
    const sels = [".editor-titlebar", ".library-pane", ".properties-pane", ".timeline-pane", ".timeline-toolbar", ".timeline-ruler", ".timeline-left", ".timeline-scroll", ".preview-stage", ".stage-column", ".preview-frame", ".asset-item.asset-row", ".timeline-toolbar button", ".pp-tab", ".left-seg button"];
    const out = {}; for (const s of sels) out[s] = g(s);
    return out;
  });

  await app.close();
  console.log(JSON.stringify({ mode, selected, info, metrics }, null, 1));
}

const mode = process.argv[2] || "dark";
await capture(mode);
console.log("DONE " + mode);
