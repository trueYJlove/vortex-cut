/**
 * 播放期指标采样器（dev 真机诊断工具，P33 W11）。
 *
 * 与 dev-cdp-probe.mjs 的分工：探针走**完整用户操作**（建项目 → 导入 → 落轨 → 播放，
 * 用于验收）；本工具**只接管当前会话并播放**（用于「同一实例、同一素材、只改一个
 * 变量」的对照实验，例如 `VITE_AIVS_FORCE_DEGRADED_BUDGET` 强制降级起点的自愈验证）。
 * 每次运行前重载渲染层 ⇒ 会话/worker 干净重建（改 worker 源码后也能生效）。
 *
 * 用法（先起 dev 实例，见 dev-cdp-probe.mjs 顶部注释）：
 *   node scripts/dev-playback-sample.mjs --port 9333 --label degraded-6 --seconds 18 --viewport 1920x1080
 *   node scripts/dev-playback-sample.mjs --port 9333 --label healthy --seconds 18
 *
 * 落盘：evidence/performance/preview-smoothness-baseline/dev-sample-<label>.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] }));

const argv = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, list) => {
  if (token.startsWith("--")) pairs.push([token.slice(2), list[index + 1]]);
  return pairs;
}, []));
const port = argv.port ?? "9333";
const label = argv.label ?? "sample";
const seconds = Number(argv.seconds ?? 20);
const projectPrefix = argv.project ?? "Dev Probe";
const viewport = (() => {
  if (!argv.viewport) return null;
  const [w, h] = String(argv.viewport).split("x").map(Number);
  return Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : null;
})();
/** 默认落盘位置按**脚本所在位置**解析（不受 cwd 影响；此前 --out 相对路径踩过坑）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const out = resolve(argv.out ?? resolve(repoRoot, "evidence/performance/preview-smoothness-baseline", `dev-sample-${label}.json`));

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
const page = context.pages().find(p => !p.isClosed()) ?? await context.waitForEvent("page");
page.on("pageerror", error => console.log(`[pageerror] ${String(error).slice(0, 200)}`));
if (viewport) { await page.setViewportSize(viewport); await page.waitForTimeout(1_500); }

// 会话/worker 干净重建
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), undefined, { timeout: 60_000 });
await page.locator(".synthetic-metrics").waitFor({ timeout: 180_000 });
await page.waitForTimeout(2_000);

/** 环境快照：GPU、真实硬解能力（mediaCapabilities.powerEfficient 才是「会用硬解」，
 *  isConfigSupported 只回显请求的模式）、素材与所属项目。 */
const env = await page.evaluate(async prefix => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
  const power = await navigator.mediaCapabilities.decodingInfo({
    type: "file",
    video: { contentType: 'video/mp4; codecs="avc1.640032"', width: 3440, height: 1440, bitrate: 22470058, framerate: 30 },
  }).catch(error => ({ error: String(error) }));
  const projects = await window.desktop.listProjects({ limit: 50 });
  const hit = projects.items.find(item => item.name.startsWith(prefix));
  const state = hit ? await window.desktop.getTimeline(hit.project_id) : null;
  const doc = state?.draft?.document ?? state?.current_revision?.document ?? null;
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "?",
    h264_3440_power_efficient: power.powerEfficient ?? null,
    window: { w: window.innerWidth, h: window.innerHeight, dpr: devicePixelRatio },
    project: hit?.name ?? null,
    clips: doc?.clips?.map(clip => ({ track: clip.track_id, layout: clip.layout, end_us: clip.timeline_end_us })) ?? null,
  };
}, projectPrefix);
console.log(`[env] ${JSON.stringify(env)}`);

await page.evaluate(() => {
  window.__TRACE = [];
  window.__editorPerf?.configure(true);
  window.__editorPerf?.reset();
});

const playBtn = page.getByRole("button", { name: "播放", exact: true });
const box = await playBtn.boundingBox();
if (!box) throw new Error("play button not visible");
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.up();

console.log("[t] tc          drop p50   p95   up95  out50 out95 feed95 queue95 res95 inFlight hw");
const samples = [];
for (let i = 0; i < seconds; i++) {
  await page.waitForTimeout(1_000);
  const snap = await page.evaluate(() => {
    const m = window.__aivsPreviewMetrics ?? null;
    if (!m) return null;
    return {
      tc: document.querySelector(".playback-bar .tc b")?.textContent ?? "",
      dropped: m.dropped_frames, p50: m.decode_ms_p50, p95: m.decode_ms_p95, up95: m.upload_ms_p95,
      seg: m.decode_seg, inFlight: m.decode_in_flight, hw: m.decode_hardware, backend: m.decode_backend,
      backing: `${m.backing_w}x${m.backing_h}`, canvas: `${m.canvas_w}x${m.canvas_h}`, error: m.last_error ?? null,
    };
  });
  if (!snap) continue;
  samples.push(snap);
  const s = snap.seg ?? {};
  console.log(`${String(i).padStart(2)}  ${snap.tc.padEnd(11)} ${String(snap.dropped).padEnd(4)} ${String(snap.p50).padEnd(5)} ${String(snap.p95).padEnd(5)} ${String(snap.up95).padEnd(5)} ${String(s.out50 ?? "-").padEnd(5)} ${String(s.output_p95 ?? "-").padEnd(5)} ${String(s.feed_p95 ?? "-").padEnd(6)} ${String(s.queue_p95 ?? "-").padEnd(7)} ${String(s.residual_p95 ?? "-").padEnd(5)} ${String(snap.inFlight).padEnd(8)} ${snap.hw} ${snap.backing}`);
}
const decisions = await page.evaluate(() => {
  const counts = {};
  for (const event of window.__TRACE ?? []) counts[String(event.event ?? "?")] = (counts[String(event.event ?? "?")] ?? 0) + 1;
  return counts;
});
console.log(`[${label}] decisions: ${JSON.stringify(decisions)}`);
await page.getByRole("button", { name: "暂停", exact: true }).click().catch(() => undefined);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ label, env, samples, decisions }, null, 1), "utf8");
console.log(`[${label}] evidence → ${out}`);
await browser.close();
