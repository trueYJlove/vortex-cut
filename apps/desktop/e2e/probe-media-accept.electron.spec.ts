/**
 * 最小媒体可播性探针（P203 / P204 的复现载体，2026-11-01）。
 *
 * **为什么单列一个 spec**：`p33-user-drop` 是长流程（建项目→导入→落轨→播放→
 * 采样→断言丢帧率），任何一步挂死都只能看到「test timeout」，无法区分
 * 「素材播不了」与「harness 有问题」。本探针**逐步打点**并把每步耗时和
 * 时间码/错误原样打印，使失败点一眼可见。
 *
 * 已用它定位两个缺陷（见 `evidence/2026-11-01-iphone-hevc-blockers/README.md`）：
 * - P203：10-bit HDR HEVC 素材点「播放」即挂死（日志停在 `ratio set` 之后）
 * - P204：8-bit 转码版播放能启动但全帧 `no sample`（`tc` 恒 00:00:00:00）
 *
 * 用法：
 *   AIVS_PROBE_MEDIA=<绝对路径> AIVS_PROBE_LABEL=<标签> \
 *     npx playwright test --config=tests/playwright.config.ts \
 *     e2e/probe-media-accept.electron.spec.ts --reporter=line
 *
 * **它不做断言**：本探针只输出诊断事实，判定由人（或上层 spec）完成——
 * 因为「可播」的阈值随素材类型而变，写死会在无关素材上误红。
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (o: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "..", "..", "..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");
const fixture = process.env.AIVS_PROBE_MEDIA ?? "";
const label = process.env.AIVS_PROBE_LABEL ?? "probe";


test(`probe: ${label}`, async () => {
  test.setTimeout(300_000);
  // 跳过而非失败：本探针需要真实素材，由 AIVS_PROBE_MEDIA 指定；未设或文件不在时跳过。
  test.skip(!existsSync(fixture), "requires AIVS_PROBE_MEDIA to point at a real media fixture");
  const dir = join(root, "test-results", `probe-${label}-${process.pid}`);
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
  const t0 = Date.now();
  const mark = (m: string) => console.log(`[probe] +${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
  try {
    const page = await app.firstWindow();
    page.on("console", msg => { if (msg.type() === "error") console.log(`[probe:err] ${msg.text().slice(0, 200)}`); });
    page.on("pageerror", e => console.log(`[probe:pageerror] ${String(e).slice(0, 200)}`));
    await page.waitForFunction(() => Boolean((window as unknown as { desktop?: { getRuntime?: unknown } }).desktop?.getRuntime));
    await page.evaluate(() => (window as unknown as { desktop: { getRuntime(): unknown } }).desktop.getRuntime());
    await page.getByRole("tab", { name: "素材", exact: true }).waitFor({ timeout: 30_000 });
    // **必须早于此后的任何素材导入**：worker trace 落点用 `__TRACE?.push`，
    // 数组未初始化则事件被静默丢弃（P204 诊断第一次就是这么拿到 null 的）。
    await page.evaluate(() => {
      const w = window as unknown as { __TRACE?: unknown[]; __editorPerf?: { configure(b: boolean): void } };
      w.__TRACE = [];
      w.__editorPerf?.configure(true);
    });
    mark("app ready");

    const projectName = `Probe ${label}`;
    await page.getByRole("button", { name: "切换项目" }).click();
    await page.getByRole("listbox", { name: "选择项目" }).getByRole("menuitem", { name: "项目管理" }).click();
    await page.getByLabel("新项目名称").fill(projectName);
    await page.getByLabel("新建项目画布比例").selectOption("169");
    await page.getByRole("button", { name: "创建项目" }).click();
    await page.keyboard.press("Escape");
    mark("project created");

    await page.getByRole("button", { name: "导入视频" }).click();
    const assetName = fixture.split(/[\\/]/).pop()!;
    await page.locator(".asset-row").filter({ hasText: assetName }).waitFor({ timeout: 120_000 });
    mark("asset row visible");

    await page.evaluate(async ({ name, project }: { name: string; project: string }) => {
      const w = window as unknown as { desktop: { listProjects(a: unknown): Promise<{ items: Array<{ name: string; project_id: string }> }>; listAssets(a: unknown): Promise<{ items: Array<{ asset: { display_name: string; asset_id: string } }> }> } };
      const canvas = document.querySelector('canvas[aria-label="时间线画布"]') as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const projects = await w.desktop.listProjects({ limit: 100 });
      const hit0 = projects.items.find(item => item.name === project)!;
      const list = await w.desktop.listAssets({ project_id: hit0.project_id, limit: 100 });
      const hit = list.items.find(item => item.asset.display_name === name)!;
      const transfer = new DataTransfer();
      transfer.setData("application/x-vortex-cut-asset", hit.asset.asset_id);
      const y = rect.top + Math.min(112, rect.height - 8);
      canvas.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 200, clientY: y }));
      canvas.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 200, clientY: y }));
    }, { name: assetName, project: projectName });
    mark("drop dispatched");

    for (let i = 0; i < 40; i++) {
      const st = await page.evaluate(async (project: string) => {
        const w = window as unknown as {
          desktop: { listProjects(a: unknown): Promise<{ items: Array<{ name: string; project_id: string }> }>; getTimeline(id: string): Promise<{ draft?: { document?: { clips: unknown[] } }; current_revision?: { document?: { clips: unknown[] } } }> };
          __aivsPreviewMetrics?: unknown;
        };
        const projects = await w.desktop.listProjects({ limit: 100 });
        const hit = projects.items.find(item => item.name === project);
        if (!hit) return { clips: 0, metrics: false, metricsText: null };
        const s = await w.desktop.getTimeline(hit.project_id);
        const doc = s.draft?.document ?? s.current_revision?.document;
        const metrics = w.__aivsPreviewMetrics ?? null;
        const el = document.querySelector(".synthetic-metrics") as HTMLElement | null;
        return { clips: doc?.clips?.length ?? 0, metrics: Boolean(metrics), metricsText: el?.innerText?.slice(0, 120) ?? null };
      }, projectName);
      if (i % 5 === 0) mark(`poll#${i} clips=${st.clips} metrics=${st.metrics} text=${JSON.stringify(st.metricsText)}`);
      if (st.metrics) { mark("METRICS APPEARED"); break; }
      if (i === 39) mark(`GAVE UP: clips=${st.clips} metrics=${st.metrics}`);
      await page.waitForTimeout(3000);
    }

    await page.getByLabel("预览比例").selectOption("169");
    mark("ratio set");
    // P204 诊断：把 worker 的 sample_index_built 原样打印出来
    const idx = await page.evaluate(() => {
      const t = (window as unknown as { __TRACE?: Array<{ event?: string; detail?: Record<string, unknown> }> }).__TRACE ?? [];
      return t.filter(e => e.event === "sample_index_built").slice(-1)[0]?.detail ?? null;
    });
    console.log(`[probe:index] ${JSON.stringify(idx)}`);
    await page.getByRole("button", { name: "播放", exact: true }).click();
    mark("play clicked");

    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(2000);
      const s = await page.evaluate(() => {
        const w = window as unknown as { __aivsPreviewMetrics?: { dropped_frames?: number; decode_ms_p50?: number; last_error?: string | null } };
        const m = w.__aivsPreviewMetrics ?? null;
        const tcEl = document.querySelector(".playback-bar .tc b") as HTMLElement | null;
        return { tc: tcEl?.innerText ?? "?", dropped: m?.dropped_frames ?? null, p50: m?.decode_ms_p50 ?? null, err: m?.last_error ?? null };
      });
      mark(`play#${i} tc=${s.tc} dropped=${s.dropped} p50=${s.p50} err=${JSON.stringify(s.err)}`);
    }
  } finally {
    await app.close();
  }
});
