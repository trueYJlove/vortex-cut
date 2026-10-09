import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectCurrentProject } from "./project-switcher";

/**
 * P71 多片段（同一素材、源窗口散布）真实 App 丢帧测量。
 *
 * 为什么需要本 spec：用户真机项目「Dev Probe dev-hevc」= 同一 1080p50 素材切成 13
 * 段（源窗口 20s..167.22s 散布）。它的**最后一段 src 166.380→167.220s 落在素材
 * 最后一个 GOP（167.000s 起）内**，与 lwd 单片段片尾是同一个喂包边界陷阱；同时
 * 12 个内部剪辑点各是一次源跳变。本 spec 用 patchTimeline 逐条复刻同样的源窗口，
 * 在真实 App（真 UI + 音频 + 合成预览）里整片播放并落指标证据。
 *
 * 环境变量与 p33-user-drop 一致：AIVS_P33_MEDIA / AIVS_P33_LABEL / AIVS_P33_VIEWPORT。
 */
const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;

const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "..", "..", "..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");

const DEFAULT_MEDIA = "C:/Users/trueY/Desktop/刘可艾 小花猫舞蹈视频.mp4";
const fixture = process.env.AIVS_P33_MEDIA && existsSync(process.env.AIVS_P33_MEDIA)
  ? process.env.AIVS_P33_MEDIA
  : DEFAULT_MEDIA;
const label = process.env.AIVS_P33_LABEL ?? "dev-hevc-clone";
const projectName = `P33 Multi ${label}`;
const DROP_RATE_LIMIT = 0.005;

/** 真机 dev-hevc 项目的 13 段源窗口（秒），照抄自项目文档。 */
const SOURCE_WINDOWS: Array<[number, number]> = [
  [20.0, 21.64], [68.98, 70.5], [139.56, 143.12], [144.02, 145.9],
  [145.9, 148.1], [151.92, 153.62], [153.62, 155.36], [155.9, 158.28],
  [158.28, 161.34], [161.34, 162.7], [162.7, 164.32], [164.32, 166.38],
  [166.38, 167.22],
];

test(`P33 多片段真实 App 丢帧测量：${label}`, async () => {
  test.setTimeout(420_000);
  if (!existsSync(fixture)) throw new Error(`素材不存在：${fixture}`);
  const dir = join(root, "test-results", `p33-multiclip-${label}-${process.pid}-${Date.now()}`);
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
    NODE_OPTIONS: undefined,
  };
  const app = await electron.launch({
    args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${join(dir, "user-data")}`],
    cwd: desktop,
    env,
  });
  try {
    const page = await app.firstWindow();
    if (process.env.AIVS_P33_VIEWPORT) {
      const [width, height] = process.env.AIVS_P33_VIEWPORT.split("x").map(Number);
      if (Number.isFinite(width) && Number.isFinite(height)) await page.setViewportSize({ width: width!, height: height! });
    }
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByRole("tab", { name: "素材", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    page.on("pageerror", err => console.log(`[p33multi:pageerror] ${String(err).slice(0, 300)}`));

    // 建项目（16:9，与真机 dev-hevc 画布 1920x1080 一致）
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
    const lookupAsset = () => page.evaluate(async ({ name, project }) => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const hit0 = projects.items.find(item => item.name === project);
      if (!hit0) return null;
      const list = await window.desktop.listAssets({ project_id: hit0.project_id, limit: 100 });
      const hit = list.items.find(item => item.asset.display_name === name);
      return hit?.asset.availability === "available" ? (hit.asset.asset_id as string) : null;
    }, { name: assetName, project: projectName });
    await expect.poll(lookupAsset, { timeout: 120_000 }).toBeTruthy();
    // 注意：expect.poll 只返回 void——asset id 必须单独取一次（否则 op 里 asset_id 丢失，
    // Core 报「请求字段不符合 Timeline v1 契约」）。
    const assetId = await lookupAsset();
    if (!assetId) throw new Error("asset id 未取到");

    // 用 createTimeline + patchTimeline 复刻 13 段源窗口（等价真机 dev-hevc 时间线：
    // layout=fit、audio enabled、片段首尾相接）
    await page.evaluate(async ({ project, asset, windows }) => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const hit = projects.items.find(item => item.name === project)!;
      // 建项/导入流程可能已落成空时间线（TIMELINE_ALREADY_EXISTS）——有时间线就在其
      // 上补片段，没有才新建。片段形状照抄真机：track V1 / layout fit / 首尾相接。
      let state = await window.desktop.getTimeline(hit.project_id).catch(() => null as never);
      if (!state || !(state.draft?.document ?? state.current_revision?.document)) {
        state = await window.desktop.createTimeline({
          project_id: hit.project_id,
          timeline: {
            schema_version: 1,
            source: { kind: "full_asset", asset_id: asset },
            default_layout: "fit",
            caption_preset_id: "default-bottom",
          },
        });
      }
      const doc = state.draft?.document ?? state.current_revision.document;
      const existing = (doc.clips ?? []).filter((clip: Record<string, unknown>) => clip.track_id === "V1" && clip.asset_kind === "video",);
      const operations: Array<Record<string, unknown>> = [];
      let firstIndex = 0;
      if (existing.length > 0) {
        const [startS, endS] = windows[0]!;
        operations.push({
          op: "trim_clip",
          clip_id: existing[0].clip_id,
          source_start_us: Math.round(startS * 1e6),
          source_end_us: Math.round(endS * 1e6),
        });
        firstIndex = 1;
      }
      for (let index = firstIndex; index < windows.length; index++) {
        const [startS, endS] = windows[index]!;
        operations.push({
          op: "insert_asset_clip",
          asset_id: asset,
          at_index: index,
          source_start_us: Math.round(startS * 1e6),
          source_end_us: Math.round(endS * 1e6),
        });
      }
      // 逐条 patch：失败时回报具体 op（Core 的错误信息不带字段定位）。
      let revisionId = state.current_revision.timeline_revision_id;
      for (let i = 0; i < operations.length; i++) {
        try {
          const next = await window.desktop.patchTimeline({
            project_id: hit.project_id,
            patch: {
              schema_version: 1,
              base_revision_id: revisionId,
              operations: [operations[i]],
              summary: "P33 多片段复刻",
            },
          });
          revisionId = next.current_revision.timeline_revision_id;
        } catch (error) {
          throw new Error(`op[${i}] ${JSON.stringify(operations[i])} -> ${String(error)}`);
        }
      }
    }, { project: projectName, asset: assetId, windows: SOURCE_WINDOWS });

    // API 建的时间线要 reload 才被 UI 装载（m6-multi-track 同款做法）。
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    await expectCurrentProject(page, projectName);

    await expect.poll(async () => page.evaluate(async project => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const hit = projects.items.find(item => item.name === project)!;
      const state = await window.desktop.getTimeline(hit.project_id);
      const doc = state.draft?.document ?? state.current_revision.document;
      return doc.clips.filter(clip => clip.track_id === "V1" && clip.asset_kind === "video").length;
    }, projectName), { timeout: 60_000, intervals: [500] }).toBeGreaterThanOrEqual(SOURCE_WINDOWS.length);

    await page.getByLabel("预览比例").selectOption("169");
    const syntheticReady = page.locator(".synthetic-metrics");
    await expect(syntheticReady).toBeVisible({ timeout: 180_000 });
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
    console.log(`[p33multi] ${label} totalUs=${totalUs} expectedFrames≈${expectedFrames}`);

    const parseTcUs = (text: string) => {
      const parts = text.split(":").map(Number);
      if (parts.length !== 4 || parts.some(Number.isNaN)) return null;
      return ((parts[0]! * 3600 + parts[1]! * 60 + parts[2]!) * 1_000_000) + Math.round(parts[3]! * 1_000_000 / 30);
    };
    const readTc = () => page.locator(".playback-bar .tc b").innerText();
    const readMetrics = () => page.evaluate(() => (window as unknown as { __aivsPreviewMetrics?: Record<string, unknown> }).__aivsPreviewMetrics ?? null);
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
      host.__TRACE = [];
    });

    const playBtn = page.getByRole("button", { name: "播放", exact: true });
    const btnBox = await playBtn.boundingBox();
    if (!btnBox) throw new Error("play button not visible");
    await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    await page.mouse.down();
    await page.mouse.up();

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
    await page.waitForTimeout(1_500);
    const finalMetrics = await readMetrics();
    const metricsText = await syntheticReady.innerText();
    const decisions = await page.evaluate(() => {
      const events = (window as unknown as { __TRACE?: Array<Record<string, unknown>> }).__TRACE ?? [];
      const counts: Record<string, number> = {};
      for (const event of events) {
        const name = String(event.event ?? "?");
        counts[name] = (counts[name] ?? 0) + 1;
      }
      return { counts };
    });
    const report = {
      label, fixture, total_us: totalUs, expected_frames: expectedFrames,
      clips: SOURCE_WINDOWS.length, reached_end: reachedEnd, metrics_text: metricsText,
      final: finalMetrics, residency: perfResidency, samples: trace, perf_events: perfEvents, decisions,
      raw_trace: process.env.AIVS_P33_TRACE === "1"
        ? await page.evaluate(() => (window as unknown as { __TRACE?: unknown[] }).__TRACE?.slice(-20_000) ?? [])
        : undefined,
    };
    const outPath = join(root, "evidence", "performance", "preview-smoothness-baseline", `app-multiclip-${label}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 1), "utf8");
    console.log(`[p33multi] metrics: ${metricsText}`);
    console.log(`[p33multi] evidence → ${outPath}`);
    expect(finalMetrics, "VITE_AIVS_PERF=1 诊断构建才有的 __aivsPreviewMetrics 缺失").toBeTruthy();
    const dropped = Number((finalMetrics as Record<string, unknown>).dropped_frames ?? -1);
    const rate = dropped / expectedFrames;
    console.log(`[p33multi] dropped=${dropped}/${expectedFrames} (rate=${(rate * 100).toFixed(2)}%)`);
    expect(String(metricsText)).not.toContain("最近错误");
    // P71 不变量（本 spec 的回归锁）：**片尾区间（含末段 GOP）不得新增丢帧**。
    // 多片段时间线最后一段 src 166.38→167.22s 落在素材末段 GOP（167.0s 起）——
    // 修复前正是「末段 GOP 初始终点=文件尾 → 一次灌 29 个采样 → 表面池停摆 →
    // stall_retry」的触发点；修复后该区间应与进入前持平。
    const lastClipStartUs = 24_720_000;
    const dropsAtTail = trace
      .filter(sample => Number(sample.tc_us ?? -1) < lastClipStartUs)
      .reduce((max, sample) => Math.max(max, Number(sample.dropped ?? 0)), 0);
    console.log(`[p33multi] 片尾前累计丢帧=${dropsAtTail}，全片=${dropped}（片尾新增 ${dropped - dropsAtTail}）`);
    expect(dropped, "片尾（含末段 GOP）出现新增丢帧").toBe(dropsAtTail);
    // 多片段残余丢帧集中在**剪辑点冷启**（同一素材 12 次源跳变，实测每次 1~9 帧）；
    // 全片门限口径（单素材 ≤0.5% vs 多片段按剪辑点计）仍待裁决，故只记录不设门。
    console.log(`[p33multi] 全片丢帧率 ${(rate * 100).toFixed(2)}%（单素材门限 ${DROP_RATE_LIMIT * 100}% 仅作参照）`);
  } finally {
    await app.close();
  }
});
