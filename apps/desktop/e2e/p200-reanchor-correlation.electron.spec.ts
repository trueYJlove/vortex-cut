/**
 * P200 验证：reanchor 与 cold_start 的时间相关性。
 *
 * **⚠️ 原假说已被否证（2026-10-28 第五轮）**：`backDistance` 量到的**不是**重锚回退
 * 距离，而是解码器管线深度 / 回扫窗宽度——`emittedRankMax` 在实测中恒等于
 * `lastFedSample`（18/20），且 71.9% 的重锚根本没移动播放头。
 * 真机主因是暂存帧被自身容量驱逐。见 `ATTRIBUTION_ROUND5.md`。
 * **因此本 spec 不再宣称能验证因果关系**，它现在的用途是：
 * 把两个量测出来，并**与零基线对照**，使数字可被解读。
 *
 * **为什么必须带零基线**（本 spec 第一版的缺陷）：重锚间隔实测 p50=1000ms，
 * 若窗口取 2000ms，任取一时刻落在某次重锚之后的概率就有 **77.9%**
 * ⇒ 「相关性」会在随机时序下自动报 ~78%，数字读不出任何结论。
 * 故此处同时输出 `null_baseline_ratio`（对同一时间轴做均匀采样、不看 cold_start），
 * 并与 `correlated_ratio` 并列——**只有显著高于零基线才有信息量**。
 * 默认窗口因此收紧到 250ms（零基线约 22.5%）。
 *
 * 两条通道的时间轴对齐：`reanchor` 走 editorPerf（带 at: performance.now()），
 * `cold_start` 走 worker trace（`decode-worker.ts` 落点补 at，同一时钟）。
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectCurrentProject } from "./project-switcher";

// 与既有 spec 同一取法：playwright 不是本仓直接依赖，需从 @playwright/test 旁解析
const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;

const currentDir = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(currentDir, "..");
const root = resolve(currentDir, "..", "..", "..");
const resources = join(root, "resources");
const fixture = process.env.AIVS_P33_MEDIA ?? "";
const label = process.env.AIVS_P33_LABEL ?? "p200-trace";
const observeMs = Number(process.env.AIVS_P200_OBSERVE_MS ?? 120_000);
// 零基线随窗口变化（P196 实测 n=17,976）：2000ms→77.9% / 500ms→39.7% / 250ms→22.5% / 100ms→10.0%
const REANCHOR_WINDOW_MS = Number(process.env.AIVS_P200_WINDOW_MS ?? 250);

test(`P200 trace：reanchor → missingStuck 相关性（${label}）`, async () => {
  test.setTimeout(observeMs + 480_000);
  if (!fixture || !existsSync(fixture)) throw new Error(`素材不存在：${fixture}`);
  const dir = join(root, "test-results", `p200-${label}-${process.pid}-${Date.now()}`);
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
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByRole("tab", { name: "素材", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });

    const projectName = `P200 ${label} ${Date.now()}`;
    await page.getByRole("button", { name: "切换项目" }).click();
    await page.getByRole("listbox", { name: "选择项目" }).getByRole("menuitem", { name: "项目管理" }).click();
    await page.getByLabel("新项目名称").fill(projectName);
    await page.getByLabel("新建项目画布比例").selectOption("169");
    await page.getByRole("button", { name: "创建项目" }).click();
    await expectCurrentProject(page, projectName);
    await page.keyboard.press("Escape");
    await expect(page.locator(".project-management-modal")).toHaveCount(0, { timeout: 10_000 });

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

    // 落 V1 主轨：复用 p33-user-drop 的拖放手势（真实 UI 路径）
    await page.evaluate(async ({ name, project }) => {
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
    }, { name: assetName, project: projectName });
    await expect.poll(async () => page.evaluate(async project => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const hit = projects.items.find(item => item.name === project)!;
      const state = await window.desktop.getTimeline(hit.project_id);
      const doc = state.draft?.document ?? state.current_revision.document;
      return doc.clips.some(clip => clip.track_id === "V1" && clip.asset_kind === "video");
    }, projectName), { timeout: 60_000, intervals: [500] }).toBeTruthy();

    await page.getByLabel("预览比例").selectOption("169");
    await expect(page.locator(".synthetic-metrics")).toBeVisible({ timeout: 180_000 });

    // __TRACE 必须先初始化为数组（worker trace 落点用 ?.push，未初始化即丢弃）
    await page.evaluate(() => {
      const host = window as unknown as { __TRACE?: unknown[]; __editorPerf?: { configure(enabled: boolean): void } };
      host.__editorPerf?.configure(true);
      host.__TRACE = [];
    });

    await page.getByRole("button", { name: "播放", exact: true }).click();
    const started = Date.now();
    while (Date.now() - started < observeMs) await page.waitForTimeout(5_000);
    await page.getByRole("button", { name: "暂停", exact: true }).click().catch(() => undefined);

    const snapshot = await page.evaluate(() => {
      const host = window as unknown as {
        __TRACE?: Array<{ event: string; detail?: Record<string, unknown>; at?: number }>;
        __editorPerf?: { snapshot(): { events?: Array<{ kind: string; at: number }>; counts?: Record<string, number> } };
      };
      return { traces: host.__TRACE ?? [], perf: host.__editorPerf?.snapshot() ?? null };
    });

    const coldStarts = snapshot.traces.filter(t => t.event === "cold_start");
    const reanchors = (snapshot.perf?.events ?? []).filter(e => e.kind === "reanchor");
    const depths = coldStarts.map(t => Number(t.detail?.backDistance ?? NaN)).filter(Number.isFinite);
    const positives = coldStarts.filter(t => Number(t.detail?.backDistance ?? 0) > 0);
    const windowed = positives.filter(t => typeof t.at === "number"
      && reanchors.some(r => t.at! >= r.at && t.at! - r.at <= REANCHOR_WINDOW_MS));

    // **零基线**（本 spec 第一版缺这一步，导致数字不可解读）：沿同一时间轴均匀采样，
    // 统计"落在某次 reanchor 之后 W 内"的比例——它**与 cold_start 无关**，只反映重锚
    // 自身的密度。correlated_ratio 只有显著高于它才有信息量。
    const reanchorAts = reanchors.map(r => r.at).sort((a, b) => a - b);
    const nullBaselineRatio = (() => {
      if (reanchorAts.length < 2) return null;
      const lo = reanchorAts[0], hi = reanchorAts[reanchorAts.length - 1];
      const step = Math.max(10, (hi - lo) / 20_000);
      let covered = 0, total = 0;
      for (let t = lo; t < hi; t += step) {
        total += 1;
        if (reanchorAts.some(a => t >= a && t - a <= REANCHOR_WINDOW_MS)) covered += 1;
      }
      return total > 0 ? covered / total : null;
    })();

    const summary = {
      label,
      observe_ms: observeMs,
      reanchor_window_ms: REANCHOR_WINDOW_MS,
      trace_total: snapshot.traces.length,
      cold_start_total: coldStarts.length,
      cold_start_with_back_distance: depths.length,
      cold_start_with_positive_depth: positives.length,
      reanchor_total: reanchors.length,
      correlated_within_window: windowed.length,
      // 两个比率并列才有意义；null_baseline_ratio = 重锚自密度（与 cold_start 无关）
      correlated_ratio: positives.length ? windowed.length / positives.length : null,
      null_baseline_ratio: nullBaselineRatio,
      max_back_distance: depths.length ? Math.max(...depths) : null,
      // 诊断：__TRACE 里真实的事件类型分布（判断"没触发"还是"链路不通"）
      trace_event_kinds: Object.fromEntries(
        Object.entries(snapshot.traces.reduce<Record<string, number>>((acc, t) => {
          acc[t.event] = (acc[t.event] ?? 0) + 1; return acc;
        }, {})).sort((a, b) => b[1] - a[1]).slice(0, 12)),
      perf_event_kinds: Object.fromEntries(
        Object.entries((snapshot.perf?.events ?? []).reduce<Record<string, number>>((acc, e) => {
          acc[e.kind] = (acc[e.kind] ?? 0) + 1; return acc;
        }, {})).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    };
    await writeFile(join(dir, "p200-trace-summary.json"), JSON.stringify(summary, null, 1), "utf8");
    await writeFile(join(dir, "p200-trace-raw.json"), JSON.stringify({ coldStarts, reanchors }, null, 1), "utf8");
    console.log(`[p200] ${JSON.stringify(summary)}`);

    // 断言只覆盖"链路与判据可用"，**不断言因果**（原假说已被否证，见文件头）。
    // ① 遥测生效：一条带 backDistance 的 cold_start 都没有，后面全是空转。
    expect(summary.cold_start_with_back_distance, "没有任何 cold_start 带 backDistance ⇒ 遥测未生效").toBeGreaterThan(0);
    // ② 判据可用：重锚太少时零基线无意义，此时 correlated_ratio 不可解读，
    //    必须显式失败而不是给出一个看似成功的数字。
    expect(reanchors.length, "reanchor 事件过少（<20）⇒ 零基线无统计意义，本次测量不可解读").toBeGreaterThanOrEqual(20);
    expect(nullBaselineRatio, "无法计算零基线 ⇒ 相关性数字不可解读").not.toBeNull();
    // ③ 把结论写成一行，避免下一个人只看到 correlated_within_window 就下结论。
    const ratio = summary.correlated_ratio;
    const verdict = ratio === null || nullBaselineRatio === null
      ? "不可判定"
      : ratio > nullBaselineRatio + 0.25
        ? "相关性显著高于零基线（可作为线索，仍需独立证据支持因果）"
        : "相关性未显著高于零基线 ⇒ 本数据不支持「重锚驱动冷启」";
    console.log(`[p200] correlated_ratio=${ratio} null_baseline=${nullBaselineRatio?.toFixed(3)} ⇒ ${verdict}`);
  } finally {
    await app.close();
  }
});
