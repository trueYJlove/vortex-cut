import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectCurrentProject } from "./project-switcher";

/**
 * P33 用户原素材 App 内丢帧复测（真机合成预览路径）。
 *
 * 为什么需要本 spec：探针（m3p5）与 App 走同一套 PreviewSession 编排，但
 * 「探针 0 丢帧 / App 丢帧 452」的历史空白正是**只有探针、没有 App 内量化**造成的。
 * 本 spec 在真实 App（真实 UI + 音频 + 时间线 + 合成预览）里播放用户原素材，
 * 读与指标条同源的 `window.__aivsPreviewMetrics`（VITE_AIVS_PERF=1 诊断构建），
 * 把「丢帧数 / decode p95 / 合成间隔」落成可对账证据。
 *
 * 素材经 `AIVS_P33_MEDIA` 指定（默认用户 3440x1440 H.264 无 B 帧原素材）；
 * `AIVS_P33_LABEL` 只用于证据命名。
 */
const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;

const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "..", "..", "..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");

const DEFAULT_MEDIA = "C:/Users/trueY/Videos/5月11日(3)/5月11日(3)-1.mp4";
const fixture = process.env.AIVS_P33_MEDIA && existsSync(process.env.AIVS_P33_MEDIA)
  ? process.env.AIVS_P33_MEDIA
  : DEFAULT_MEDIA;
const label = process.env.AIVS_P33_LABEL ?? "user-h264-3440";
/** 项目名（浏览器上下文内不可见 Node 变量，一律经参数传入 evaluate）。 */
const projectName = `P33 Drop ${label}`;
/** 验收门（规划门 §2）：残余丢帧 ≤0.5% 全片帧数。 */
const DROP_RATE_LIMIT = 0.005;

test(`P33 App 内丢帧复测：${label}`, async () => {
  test.setTimeout(420_000);
  if (!existsSync(fixture)) throw new Error(`素材不存在：${fixture}`);
  const dir = join(root, "test-results", `p33-user-drop-${label}-${process.pid}-${Date.now()}`);
  await mkdir(join(dir, "user-data"), { recursive: true });
  const env = {
    ...process.env,
    AIVS_RESOURCES_PATH: resources,
    AIVS_E2E_MEDIA_PATH: fixture,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: fixture }),
    AIVS_SIDECAR_EXECUTABLE: join(root, ".venv", "Scripts", "python.exe"),
    AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
    PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_OPTIONS: undefined
  };
  const app = await electron.launch({
    args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${join(dir, "user-data")}`],
    cwd: desktop,
    env
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByRole("tab", { name: "素材", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    page.on("pageerror", err => console.log(`[p33drop:pageerror] ${String(err).slice(0, 300)}`));
    page.on("console", msg => { if (msg.type() === "error") console.log(`[p33drop:console-error] ${msg.text().slice(0, 300)}`); });

    // 建项目（16:9 画布，与用户真机预览 960x540 一致）
    await page.getByRole("button", { name: "切换项目" }).click();
    await page.getByRole("listbox", { name: "选择项目" }).getByRole("menuitem", { name: "项目管理" }).click();
    await page.getByLabel("新项目名称").fill(projectName);
    await page.getByLabel("新建项目画布比例").selectOption("169");
    await page.getByRole("button", { name: "创建项目" }).click();
    await expectCurrentProject(page, projectName);
    await page.keyboard.press("Escape");
    await expect(page.locator(".project-management-modal")).toHaveCount(0, { timeout: 10_000 });

    // 导入素材
    await page.getByRole("button", { name: "导入视频" }).click();
    const assetName = fixture.split(/[\\/]/).pop()!;
    await expect(page.locator(".asset-row").filter({ hasText: assetName })).toBeVisible({ timeout: 120_000 });
    await expect.poll(async () => page.evaluate(async ({ name, project }) => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const hit0 = projects.items.find(item => item.name === project);
      if (!hit0) return null;
      const list = await window.desktop.listAssets({ project_id: hit0.project_id, limit: 100 });
      const hit = list.items.find(item => item.asset.display_name === name);
      return hit?.asset.availability === "available" ? hit.asset.asset_id : null;
    }, { name: assetName, project: projectName }), { timeout: 120_000 }).toBeTruthy();

    // 落 V1 主轨
    await page.evaluate(async ({ name, projectName: project }) => {
      const canvas = document.querySelector('canvas[aria-label="时间线画布"]') as HTMLCanvasElement;
      if (!canvas) throw new Error("timeline canvas missing");
      const rect = canvas.getBoundingClientRect();
      const targetY = Math.min(112, rect.height - 8);
      const projects = await window.desktop.listProjects({ limit: 100 });
      const hit0 = projects.items.find(item => item.name === project);
      const list = await window.desktop.listAssets({ project_id: hit0!.project_id, limit: 100 });
      const hit = list.items.find(item => item.asset.display_name === name);
      const transfer = new DataTransfer();
      transfer.setData("application/x-vortex-cut-asset", hit!.asset.asset_id);
      canvas.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 200, clientY: rect.top + targetY }));
      canvas.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 200, clientY: rect.top + targetY }));
    }, { name: assetName, projectName });
    await expect.poll(async () => page.evaluate(async project => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const hit = projects.items.find(item => item.name === project)!;
      const state = await window.desktop.getTimeline(hit.project_id);
      const doc = state.draft?.document ?? state.current_revision.document;
      return doc.clips.some(clip => clip.track_id === "V1" && clip.asset_kind === "video");
    }, projectName), { timeout: 60_000, intervals: [500] }).toBeTruthy();

    // 比例钉到 16:9（用户真机指标条画布 = 960x540）
    await page.getByLabel("预览比例").selectOption("169");

    const syntheticReady = page.locator(".synthetic-metrics");
    await expect(syntheticReady).toBeVisible({ timeout: 180_000 });
    // 等指标条出数（会话 metrics 1Hz 上报）
    await expect.poll(async () => (await syntheticReady.innerText()).includes("画布"), { timeout: 60_000 }).toBeTruthy();

    const readTotal = () => page.evaluate(async project => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const hit = projects.items.find(item => item.name === project);
      if (!hit) throw new Error("project missing");
      const state = await window.desktop.getTimeline(hit.project_id);
      const document = state.draft?.document ?? state.current_revision.document;
      return document.clips.reduce((sum, clip) => sum + (clip.timeline_end_us - clip.timeline_start_us), 0);
    }, projectName);
    await expect.poll(async () => (await readTotal()) > 1_000_000, { timeout: 30_000 }).toBeTruthy();
    const totalUs = await readTotal();
    const expectedFrames = Math.round((totalUs / 1e6) * 30);
    console.log(`[p33drop] ${label} totalUs=${totalUs} expectedFrames≈${expectedFrames}`);

    const parseTcUs = (text: string) => {
      const parts = text.split(":").map(Number);
      if (parts.length !== 4 || parts.some(Number.isNaN)) return null;
      return ((parts[0]! * 3600 + parts[1]! * 60 + parts[2]!) * 1_000_000) + Math.round(parts[3]! * 1_000_000 / 30);
    };
    const readTc = () => page.locator(".playback-bar .tc b").innerText();
    const readMetrics = () => page.evaluate(() => (window as unknown as { __aivsPreviewMetrics?: Record<string, unknown> }).__aivsPreviewMetrics ?? null);
    // 逐秒排空 editorPerf 事件环（容量 4096，60s 播放会绕圈）：排空式累积
    // 保留全量时间线——丢帧跳变点附近能看到主线程 long_task / 解码 / 上传实况。
    const drainPerf = () => page.evaluate(() => {
      const host = window as unknown as { __editorPerf?: { snapshot(): { events: unknown[]; counts: Record<string, number>; residency: unknown }; reset(): void } };
      if (!host.__editorPerf) return null;
      const snapshot = host.__editorPerf.snapshot();
      host.__editorPerf.reset();
      return snapshot;
    });
    await page.evaluate(() => {
      const host = window as unknown as { __editorPerf?: { configure(enabled: boolean): void }; __TRACE?: unknown[] };
      host.__editorPerf?.configure(true);
      // decode worker 决策 trace 的落点（timing 构建才有事件；非 timing 构建为空数组）
      host.__TRACE = [];
    });

    const playBtn = page.getByRole("button", { name: "播放", exact: true });
    const btnBox = await playBtn.boundingBox();
    if (!btnBox) throw new Error("play button not visible");
    await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    // 播到片尾（自然结束）或超时；期间每秒采样一次会话指标，记录丢帧轨迹。
    const trace: Array<Record<string, unknown>> = [];
    const perfEvents: Array<Record<string, unknown>> = [];
    let perfResidency: unknown = null;
    const deadline = Date.now() + Math.max(120_000, (totalUs / 1000) + 60_000);
    let reachedEnd = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1_000);
      const metrics = await readMetrics();
      const tcText = await readTc();
      const tcUs = parseTcUs(tcText);
      if (metrics) trace.push({ tc: tcText, tc_us: tcUs, dropped: metrics.dropped_frames, decode_p95: metrics.decode_ms_p95, upload_p95: metrics.upload_ms_p95, task_p95: metrics.task_ms_p95, decode_in_flight: metrics.decode_in_flight, last_error: metrics.last_error ?? null, decode_seg: metrics.decode_seg ?? null });
      const perf = await drainPerf();
      if (perf) {
        for (const event of perf.events as Array<Record<string, unknown>>) perfEvents.push(event);
        perfResidency = perf.residency ?? perfResidency;
      }
      if (tcUs !== null && tcUs >= totalUs - 1_000_000) { reachedEnd = true; break; }
    }
    // 静止 1s 让最后一次 1Hz 指标落定
    await page.waitForTimeout(1_500);
    const finalMetrics = await readMetrics();
    const metricsText = await syntheticReady.innerText();
    // 解码 worker 决策 trace（仅 VITE_AIVS_DECODE_TIMING=1 诊断构建存在）：
    // cold_start/feed_extend/hold_cap/evict_newest 计数是「持有窗与延伸策略」
    // 是否健康的直接判据（正常顺播应为 0/0/-/0）。
    const decisions = await page.evaluate(() => {
      const events = (window as unknown as { __TRACE?: Array<Record<string, unknown>> }).__TRACE ?? [];
      const counts: Record<string, number> = {};
      const coldStarts: Array<Record<string, unknown>> = [];
      for (const event of events) {
        const name = String(event.event ?? "?");
        counts[name] = (counts[name] ?? 0) + 1;
        if (name === "cold_start" && coldStarts.length < 20) coldStarts.push(event);
      }
      return { counts, coldStarts };
    });
    const report = {
      label, fixture, total_us: totalUs, expected_frames: expectedFrames,
      reached_end: reachedEnd, metrics_text: metricsText, final: finalMetrics,
      residency: perfResidency, samples: trace, perf_events: perfEvents, decisions,
    };
    const outPath = join(root, "evidence", "performance", "preview-smoothness-baseline",
      `app-drop-${label}${process.env.AIVS_P33_ROUND ? `-r${process.env.AIVS_P33_ROUND}` : ""}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 1), "utf8");
    console.log(`[p33drop] metrics: ${metricsText}`);
    console.log(`[p33drop] evidence → ${outPath}`);

    expect(finalMetrics, "VITE_AIVS_PERF=1 诊断构建才有的 __aivsPreviewMetrics 缺失").toBeTruthy();
    const dropped = Number((finalMetrics as Record<string, unknown>).dropped_frames ?? -1);
    const rate = dropped / expectedFrames;
    console.log(`[p33drop] dropped=${dropped}/${expectedFrames} (rate=${(rate * 100).toFixed(2)}%)`);
    expect(String(metricsText)).not.toContain("最近错误");
    expect(rate, `丢帧率 ${(rate * 100).toFixed(2)}% 超门限 ${DROP_RATE_LIMIT * 100}%`).toBeLessThanOrEqual(DROP_RATE_LIMIT);
  } finally {
    await app.close();
  }
});
