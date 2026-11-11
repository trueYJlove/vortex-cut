import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] }));
const electron = playwright._electron;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const desktop = resolve(here, "..");
const resources = join(root, "resources");
const pythonSidecar = join(root, ".venv", "Scripts", "python.exe");
const tag = process.env.PERF_TAG || "flow";
const outDir = join(root, ".tmp", "perf", tag);
await mkdir(outDir, { recursive: true });
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

const userData = join(outDir, "user-data");
await mkdir(userData, { recursive: true });
const app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), "--user-data-dir=" + userData], cwd: desktop, env: env() });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 30000 });
  await page.evaluate(() => window.desktop.getRuntime());
  await page.waitForSelector("text=Core 已连接", { timeout: 30000 });
  await page.evaluate(async () => {
    const project = await window.desktop.createProject({ name: "Flow " + Date.now() });
    const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
    if (!imported) throw new Error("import cancelled");
    const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
    const firstClipId = created.current_revision.document.clips[0].clip_id;
    await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: created.current_revision.timeline_revision_id, operations: [
      { op: "trim_clip", clip_id: firstClipId, source_start_us: 0, source_end_us: 2000000 },
      { op: "insert_asset_clip", asset_id: imported.asset.asset_id, at_index: 1, source_start_us: 0, source_end_us: 2000000 },
    ], summary: "flow" } });
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 30000 });
  await page.evaluate(() => window.desktop.getRuntime());
  await page.waitForSelector("text=Core 已连接", { timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.waitForFunction(() => Boolean(window.__editorPerf), null, { timeout: 15000 });
  await page.evaluate(() => window.__editorPerf.configure(true));

  const slider = page.getByRole("slider", { name: "时间线播放头" });
  const box = await slider.boundingBox();
  if (!box) throw new Error("no slider");

  // continuous smooth scrub: one long left→right drag over 4s (60fps pointer stream), 8 passes
  const passes = [];
  for (let pass = 0; pass < 8; pass++) {
    await page.evaluate(() => window.__editorPerf.reset());
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 5, y);
    await page.mouse.down();
    const t0 = Date.now();
    // sweep right over 1200ms in 24 steps then back over 1200ms
    for (let i = 0; i <= 24; i++) {
      const x = 5 + (i / 24) * (box.width - 10);
      await page.mouse.move(box.x + x, y);
      await page.waitForTimeout(16);
    }
    for (let i = 24; i >= 0; i--) {
      const x = 5 + (i / 24) * (box.width - 10);
      await page.mouse.move(box.x + x, y);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    const wall = Date.now() - t0;
    const snap = await page.evaluate(() => {
      const s = window.__editorPerf.snapshot();
      const rc = s.durations?.react_commit ?? null;
      return { compose: s.counts.compose ?? 0, seek: s.counts.seek ?? 0, decode: s.counts.decode ?? 0, submitted: s.counts.submitted ?? 0, react_commits: s.counts.react_commit ?? 0, react_commit_total: rc ? rc.total_ms : 0, react_commit_max: rc ? rc.max_ms : 0, window_fetch: s.counts.window_fetch ?? 0 };
    });
    passes.push({ wall_ms: wall, ...snap, fps_presented: +(snap.compose / (wall / 1000)).toFixed(1) });
  }
  const rates = passes.map(p => p.fps_presented);
  const summary = {
    passes, median_fps: statistics_median(rates), min: Math.min(...rates), max: Math.max(...rates),
  };
  function statistics_median(arr) { const s = [...arr].sort((a, b) => a - b); return +(s[Math.floor(s.length / 2)]).toFixed(1); }
  await writeFile(join(outDir, "flow.json"), JSON.stringify(summary, null, 2));
  console.log(tag.toUpperCase(), "presented-fps during continuous scrub: median", summary.median_fps, "min", summary.min, "max", summary.max);
  console.log("PASSES", JSON.stringify(passes.map(p => p.fps_presented)));
  console.log("DONE");
} finally { await app.close(); }
