import { mkdir, writeFile } from "node:fs/promises";
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
const label = process.env.AIVS_PROBE_LABEL ?? "diag";

test(`diag: ${label}`, async () => {
  test.setTimeout(180_000);
  // 跳过而非失败：本探针需要真实素材，由 AIVS_PROBE_MEDIA 指定；未设或文件不在时跳过。
  test.skip(!existsSync(fixture), "requires AIVS_PROBE_MEDIA to point at a real media fixture");
  const dir = join(root, "test-results", `diag-${label}-${process.pid}`);
  await mkdir(join(dir, "user-data"), { recursive: true });
  const env = { ...process.env,
    AIVS_RESOURCES_PATH: resources, AIVS_E2E_MEDIA_PATH: fixture,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: fixture }),
    AIVS_SIDECAR_EXECUTABLE: join(root, ".venv", "Scripts", "python.exe"),
    AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
    PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
    ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined };
  const app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${join(dir, "user-data")}`], cwd: desktop, env });
  try {
    const page = await app.firstWindow();
    const logs: string[] = [];
    page.on("console", m => logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`));
    page.on("pageerror", e => logs.push(`[pageerror] ${String(e).slice(0, 600)}`));
    await page.waitForFunction(() => Boolean((window as any).desktop?.getRuntime));
    await page.evaluate(() => (window as any).desktop.getRuntime());
    await page.getByRole("tab", { name: "素材", exact: true }).waitFor({ timeout: 30_000 });
    // 装探针：记录点击后主线程是否还能响应 + 解码器状态
    await page.evaluate(() => {
      const w = window as any;
      w.__DIAG = { before: performance.now(), after: 0, heartbeats: 0 };
      setInterval(() => { w.__DIAG.heartbeats += 1; }, 100);
    });
    const projectName = `Diag ${label}`;
    await page.getByRole("button", { name: "切换项目" }).click();
    await page.getByRole("listbox", { name: "选择项目" }).getByRole("menuitem", { name: "项目管理" }).click();
    await page.getByLabel("新项目名称").fill(projectName);
    await page.getByLabel("新建项目画布比例").selectOption("169");
    await page.getByRole("button", { name: "创建项目" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "导入视频" }).click();
    const assetName = fixture.split(/[\\/]/).pop()!;
    await page.locator(".asset-row").filter({ hasText: assetName }).waitFor({ timeout: 120_000 });
    await page.evaluate(async ({ name, project }: any) => {
      const w = window as any;
      const canvas = document.querySelector('canvas[aria-label="时间线画布"]') as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const projects = await w.desktop.listProjects({ limit: 100 });
      const hit0 = projects.items.find((i: any) => i.name === project);
      const list = await w.desktop.listAssets({ project_id: hit0.project_id, limit: 100 });
      const hit = list.items.find((i: any) => i.asset.display_name === name);
      const tr = new DataTransfer();
      tr.setData("application/x-vortex-cut-asset", hit.asset.asset_id);
      const y = rect.top + Math.min(112, rect.height - 8);
      canvas.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: tr, clientX: rect.left + 200, clientY: y }));
      canvas.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: tr, clientX: rect.left + 200, clientY: y }));
    }, { name: assetName, project: projectName });
    await page.getByLabel("预览比例").selectOption("169");
    const ready = await page.evaluate(() => Boolean((window as any).__aivsPreviewMetrics));
    console.log(`[diag] metrics ready before play = ${ready}`);
    const hb0 = await page.evaluate(() => (window as any).__DIAG.heartbeats);
    console.log(`[diag] heartbeats before click = ${hb0}`);
    // **不 await click**：用 race 让点击与心跳采样并行
    const clickPromise = page.getByRole("button", { name: "播放", exact: true }).click({ timeout: 60_000 }).then(() => "clicked").catch(e => `click-error: ${String(e).slice(0, 120)}`);
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1500);
      const st = await Promise.race([
        page.evaluate(() => { const w = window as any; return { hb: w.__DIAG.heartbeats, metrics: Boolean(w.__aivsPreviewMetrics) }; }),
        Promise.resolve("EVAL_BLOCKED"),
      ]);
      console.log(`[diag] +${(i + 1) * 1.5}s probe = ${JSON.stringify(st)}`);
    }
    console.log(`[diag] click result = ${await Promise.race([clickPromise, Promise.resolve("still-pending")])}`);
    await writeFile(join(dir, "console.log"), logs.join("\n"), "utf8");
    console.log(`[diag] console lines captured = ${logs.length}; saved to ${join(dir, "console.log")}`);
  } finally { await app.close(); }
});