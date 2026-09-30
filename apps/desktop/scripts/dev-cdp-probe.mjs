/**
 * dev 模式真机探针（P33 L9 自测闭环）：CDP 接管 `electron-vite dev` 启动的真实编辑器。
 *
 * 为什么要它：此前自动化只跑**生产构建**，探针页虽跑 dev 模式但不是完整编辑器；
 * 用户 dev 复测里的「残差 63ms」因此无法在本地复现。本脚本连到 dev 实例的
 * remote-debugging 端口，走与 e2e 相同的用户操作（建项目 → 导入 → 落 V1 → 播放），
 * 采集指标行 + 主线程 longtask + 会话指标快照，落 JSON 证据。
 *
 * 用法（先起 dev 实例）：
 *   $env:ELECTRON_CLI_ARGS='["--user-data-dir=<temp>"]'; $env:REMOTE_DEBUGGING_PORT='9333'
 *   $env:VITE_AIVS_PERF='1'; $env:AIVS_E2E_MEDIA_PATH='<media>'; npx electron-vite dev
 *   node dev-cdp-probe.mjs --port 9333 --label dev-hevc --media <media> --out <json>
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
// pnpm 严格布局：playwright 是 @playwright/test 的传递依赖，需经它解析。
const { chromium } = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] }));

const argv = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, list) => {
  if (token.startsWith("--")) pairs.push([token.slice(2), list[index + 1]]);
  return pairs;
}, []));
const port = argv.port ?? "9333";
const label = argv.label ?? "dev";
const media = argv.media ?? "C:/Users/trueY/Videos/fdf0f0e269126269ed686f208b3063e3.mp4";
const out = resolve(argv.out ?? `evidence/performance/preview-smoothness-baseline/dev-probe-${label}.json`);
const projectName = `Dev Probe ${label}`;

const main = async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find(p => !p.isClosed()) ?? await context.waitForEvent("page");
  page.on("pageerror", error => console.log(`[dev-probe:pageerror] ${String(error).slice(0, 200)}`));

  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), undefined, { timeout: 60_000 });
  await page.getByRole("tab", { name: "素材", exact: true }).waitFor({ timeout: 60_000 });
  await page.getByText(/Core 已连接/).waitFor({ timeout: 60_000 });

  // 建项目（若同名已存在则直接复用）
  const existing = await page.evaluate(async name => {
    const projects = await window.desktop.listProjects({ limit: 100 });
    return projects.items.find(item => item.name === name)?.project_id ?? null;
  }, projectName);
  if (!existing) {
    await page.getByRole("button", { name: "切换项目" }).click();
    await page.getByRole("listbox", { name: "选择项目" }).getByRole("menuitem", { name: "项目管理" }).click();
    await page.getByLabel("新项目名称").fill(projectName);
    await page.getByLabel("新建项目画布比例").selectOption("169");
    await page.getByRole("button", { name: "创建项目" }).click();
    await page.keyboard.press("Escape");
  }
  await page.waitForTimeout(1_000);

  const assetName = media.split(/[\\/]/).pop();
  const already = await page.evaluate(async ({ name, project }) => {
    const projects = await window.desktop.listProjects({ limit: 100 });
    const hit = projects.items.find(item => item.name === project);
    const list = await window.desktop.listAssets({ project_id: hit.project_id, limit: 100 });
    return list.items.some(item => item.asset.display_name === name);
  }, { name: assetName, project: projectName });
  if (!already) {
    await page.getByRole("button", { name: "导入视频" }).click();
    await page.locator(".asset-row").filter({ hasText: assetName }).waitFor({ timeout: 180_000 });
  }
  await page.waitForTimeout(1_000);

  const clipPlaced = await page.evaluate(async project => {
    const projects = await window.desktop.listProjects({ limit: 100 });
    const hit = projects.items.find(item => item.name === project);
    const state = await window.desktop.getTimeline(hit.project_id);
    const doc = state.draft?.document ?? state.current_revision.document;
    return doc.clips.some(clip => clip.track_id === "V1" && clip.asset_kind === "video");
  }, projectName);
  if (!clipPlaced) {
    await page.evaluate(async ({ name, project }) => {
      const canvas = document.querySelector('canvas[aria-label="时间线画布"]');
      if (!canvas) throw new Error("timeline canvas missing");
      const rect = canvas.getBoundingClientRect();
      const targetY = Math.min(112, rect.height - 8);
      const projects = await window.desktop.listProjects({ limit: 100 });
      const hit = projects.items.find(item => item.name === project);
      const list = await window.desktop.listAssets({ project_id: hit.project_id, limit: 100 });
      const asset = list.items.find(item => item.asset.display_name === name);
      const transfer = new DataTransfer();
      transfer.setData("application/x-vortex-cut-asset", asset.asset.asset_id);
      canvas.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 200, clientY: rect.top + targetY }));
      canvas.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 200, clientY: rect.top + targetY }));
    }, { name: assetName, project: projectName });
    await page.waitForTimeout(3_000);
  }

  await page.getByLabel("预览比例").selectOption("169").catch(() => undefined);
  // 新建/切换项目后会命中 preview-ir-v2:manifest 的 revision 竞态（App 回退交互预览）；
  // 重载渲染层让会话以当前 revision 干净重建（探针只关心播放期指标）。
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), undefined, { timeout: 60_000 });
  await page.getByRole("tab", { name: "素材", exact: true }).waitFor({ timeout: 60_000 });
  await page.getByLabel("预览比例").selectOption("169").catch(() => undefined);
  const metricsRow = page.locator(".synthetic-metrics");
  await metricsRow.waitFor({ timeout: 180_000 });
  await page.waitForTimeout(2_000);

  // 主线程尖峰观测：longtask（PerformanceObserver）+ 每秒指标采样 + 编辑器自身
  // perf 计数（VITE_AIVS_PERF=1 时才有 __editorPerf：react_commit / timeline_draw /
  // compose / long_task 的计数与耗时——用来归因「主线程 19 秒都花在哪」）。
  await page.evaluate(() => {
    const host = window;
    host.__devProbe = { longTasks: [], raf: [], perf: [] };
    host.__editorPerf?.configure(true);
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) host.__devProbe.longTasks.push({ start: Math.round(entry.startTime), dur: Math.round(entry.duration) });
      }).observe({ entryTypes: ["longtask"] });
    } catch { /* 环境不支持 */ }
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      host.__devProbe.raf.push(Math.round((now - last) * 10) / 10);
      last = now;
      if (host.__devProbe.raf.length < 6000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const playBtn = page.getByRole("button", { name: "播放", exact: true });
  const box = await playBtn.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  const samples = [];
  const totalUs = await page.evaluate(async project => {
    const projects = await window.desktop.listProjects({ limit: 100 });
    const hit = projects.items.find(item => item.name === project);
    const state = await window.desktop.getTimeline(hit.project_id);
    const doc = state.draft?.document ?? state.current_revision.document;
    return doc.clips.reduce((sum, clip) => sum + (clip.timeline_end_us - clip.timeline_start_us), 0);
  }, projectName);
  const parseTcUs = text => {
    const parts = text.split(":").map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) return null;
    return ((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1_000_000) + Math.round(parts[3] * 1_000_000 / 30);
  };
  const deadline = Date.now() + (totalUs / 1000) + 90_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    const text = await metricsRow.innerText().catch(() => "");
    const tc = await page.locator(".playback-bar .tc b").innerText().catch(() => "");
    const metrics = await page.evaluate(() => window.__aivsPreviewMetrics ?? null);
    samples.push({ tc, text: text.replace(/\s+/g, " "), metrics: metrics && { dropped: metrics.dropped_frames, p50: metrics.decode_ms_p50, p95: metrics.decode_ms_p95, seg: metrics.decode_seg, backend: metrics.decode_backend, hardware: metrics.decode_hardware } });
    // 逐秒排空 perf 事件环（容量 4096），累积主线程归因计数
    const perf = await page.evaluate(() => {
      const host = window;
      if (!host.__editorPerf) return null;
      const snapshot = host.__editorPerf.snapshot();
      host.__editorPerf.reset();
      return { counts: snapshot.counts, durations: snapshot.durations, events: snapshot.events };
    });
    if (perf) {
      const acc = page.__perfAcc ?? (page.__perfAcc = { counts: {}, durations: {} });
      for (const [kind, count] of Object.entries(perf.counts)) acc.counts[kind] = (acc.counts[kind] ?? 0) + count;
      for (const [kind, value] of Object.entries(perf.durations)) {
        const slot = acc.durations[kind] ?? (acc.durations[kind] = { total_ms: 0, max_ms: 0 });
        slot.total_ms += value.total_ms;
        slot.max_ms = Math.max(slot.max_ms, value.max_ms);
      }
    }
    const us = parseTcUs(tc);
    if (us !== null && us >= totalUs - 1_000_000) break;
  }
  await page.waitForTimeout(1_500);
  const finalText = await metricsRow.innerText().catch(() => "");
  const probe = await page.evaluate(() => window.__devProbe ?? null);
  const longTasks = (probe?.longTasks ?? []).sort((a, b) => b.dur - a.dur);
  const raf = (probe?.raf ?? []).slice().sort((a, b) => a - b);
  const pick = (list, q) => (list.length ? list[Math.min(list.length - 1, Math.floor(q * list.length))] : -1);
  const report = {
    label, media, total_us: totalUs, final_text: finalText.replace(/\s+/g, " "),
    long_tasks: { count: longTasks.length, top: longTasks.slice(0, 15), p95: pick(longTasks.map(t => t.dur).sort((a, b) => a - b), 0.95) },
    raf_interval_ms: { samples: raf.length, p50: pick(raf, 0.5), p95: pick(raf, 0.95), max: raf.length ? raf[raf.length - 1] : -1 },
    main_thread_attribution: page.__perfAcc ?? null,
    samples,
  };
  writeFileSync(out, JSON.stringify(report, null, 1), "utf8");
  console.log(`[dev-probe] ${finalText.replace(/\s+/g, " ")}`);
  console.log(`[dev-probe] longtask n=${report.long_tasks.count} p95=${report.long_tasks.p95}ms | raf p50=${report.raf_interval_ms.p50} p95=${report.raf_interval_ms.p95} max=${report.raf_interval_ms.max}ms`);
  console.log(`[dev-probe] evidence → ${out}`);
  await browser.close();
};

main().catch(error => { console.error("[dev-probe] failed:", error); process.exit(1); });
