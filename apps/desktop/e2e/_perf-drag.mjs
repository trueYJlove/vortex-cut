import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] }));
const electron = playwright._electron;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const desktop = resolve(here, "..");
const resources = join(root, "resources");
const pythonSidecar = join(root, ".venv", "Scripts", "python.exe");
const tag = process.env.PERF_TAG || "before";
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
    const project = await window.desktop.createProject({ name: "Perf " + Date.now() });
    const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
    if (!imported) throw new Error("import cancelled");
    const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
    const firstClipId = created.current_revision.document.clips[0].clip_id;
    await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: created.current_revision.timeline_revision_id, operations: [
      { op: "trim_clip", clip_id: firstClipId, source_start_us: 0, source_end_us: 2000000 },
      { op: "insert_asset_clip", asset_id: imported.asset.asset_id, at_index: 1, source_start_us: 0, source_end_us: 2000000 },
    ], summary: "perf" } });
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

  // drag workload: 60 drags, 3 pointermoves each, 30ms apart (same shape as performance-editor spec)
  let seed = 0x1a2b3c4d;
  const results = [];
  for (let i = 0; i < 60; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const x0 = 1 + (seed / 2**32) * (box.width - 2);
    await page.mouse.move(box.x + x0, box.y + box.height / 2);
    await page.mouse.down();
    let x = x0;
    for (let step = 0; step < 3; step++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      x = Math.max(1, Math.min(box.width - 2, x + ((seed / 2**32) - 0.5) * 120));
      await page.mouse.move(box.x + x, box.y + box.height / 2, { steps: 2 });
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(250);
    results.push(await page.evaluate(() => {
      const snap = window.__editorPerf?.snapshot?.();
      if (!snap) return null;
      const agg = snap.durations?.drag_to_submit ?? null;
      return { max: agg ? agg.max_ms : null, counts: snap.counts ?? {} };
    }));
    await page.evaluate(() => window.__editorPerf?.reset?.());
  }

  const dragSamples = results.filter(r => r && r.max != null).map(r => r.max);
  const p = (arr, q) => arr.length ? [...arr].sort((a,b)=>a-b)[Math.min(arr.length-1, Math.floor(q*arr.length))] : null;
  const summary = {
    samples: dragSamples.length,
    p50: p(dragSamples, 0.5), p90: p(dragSamples, 0.9), p99: p(dragSamples, 0.99),
    max: dragSamples.length ? Math.max(...dragSamples) : null,
  };
  await writeFile(join(outDir, "drag-perf.json"), JSON.stringify({ tag, summary, raw: dragSamples, perDrag: results }, null, 2));
  console.log(tag.toUpperCase(), "drag_to_submit ms:", JSON.stringify(summary));
  console.log("DONE");
} finally { await app.close(); }
