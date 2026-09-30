/** One-off: dump dev-app state via CDP (screenshot + project/clip/preview facts). */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] }));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const context = browser.contexts()[0];
const page = context.pages().find(p => !p.isClosed());
console.log("pages:", context.pages().map(p => p.url()));
const state = await page.evaluate(async () => {
  const projects = await window.desktop.listProjects({ limit: 100 });
  const out = [];
  for (const project of projects.items) {
    const assets = await window.desktop.listAssets({ project_id: project.project_id, limit: 100 });
    let clips = [];
    try {
      const timeline = await window.desktop.getTimeline(project.project_id);
      const doc = timeline.draft?.document ?? timeline.current_revision.document;
      clips = doc.clips.map(c => `${c.track_id}:${c.asset_kind}`);
    } catch (error) { clips = [`err:${String(error).slice(0, 60)}`]; }
    out.push({ name: project.name, assets: assets.items.map(a => a.asset.display_name), clips });
  }
  return out;
});
console.log(JSON.stringify(state, null, 1));
const bodies = await page.evaluate(() => ({
  metricsText: document.querySelector(".synthetic-metrics")?.textContent ?? null,
  loadingText: document.querySelector(".synthetic-loading")?.textContent ?? null,
  previewMode: document.querySelector(".synthetic-preview") ? "synthetic" : "other",
}));
console.log(JSON.stringify(bodies));
const shot = resolve("../../.tmp/inspect", "dev-app-state.png");
await page.screenshot({ path: shot });
console.log("screenshot →", shot);
await browser.close();
