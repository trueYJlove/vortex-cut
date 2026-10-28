/**
 * P200 验证：reanchor 与 missingStuck 的时间相关性。
 *
 * 待验假说（结构上已成立，见 docs/STATUS.md §4 P200 第三轮）：
 *   `emittedRankMax` 只增不减（decode-worker.worker.ts:497/:538），而 `reanchor`
 *   （preview-session.ts:2147）把播放头向后归位时**不动这份台账** ⇒ 重锚后一串
 *   请求必然 `targetRank <= emittedRankMax` ⇒ 判 `missingStuck` ⇒ 冷启整 GOP。
 *
 * 判据：观察窗内 `cold_start` 事件中 `backDistance > 0` 者，有多少落在某个
 * `reanchor` 之后的 REANCHOR_WINDOW_MS 内。本 spec **只回答是/否**，不主张定量结论。
 *
 * 两条通道的时间轴对齐：`reanchor` 走 editorPerf（带 at: performance.now()），
 * `cold_start` 走 worker trace（原本不带时间戳）。已在 decode-worker.ts 的 trace
 * 落点补 at（同一时钟），故两者可直接比较。
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
const REANCHOR_WINDOW_MS = Number(process.env.AIVS_P200_WINDOW_MS ?? 2000);

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

    // 只断言"遥测生效"：没有一条带 backDistance 就说明链路没通，测了也没意义。
    // 「是否由 reanchor 驱动」由 correlated_within_window 回答，不在本 spec 内断言为真。
    expect(summary.cold_start_with_back_distance, "没有任何 cold_start 带 backDistance ⇒ 遥测未生效").toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});
