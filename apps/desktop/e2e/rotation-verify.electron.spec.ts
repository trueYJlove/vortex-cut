import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as any;
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "..", "..", "..");
const desktop = resolve(currentDir, "..");
const fixture = process.env.AIVS_PROBE_MEDIA ?? "";

test("rotation-verify", async () => {
  // 跳过而非失败：本探针需要真实素材，由 AIVS_PROBE_MEDIA 指定；未设或文件不在时跳过。
  test.skip(!existsSync(fixture), "requires AIVS_PROBE_MEDIA to point at a real media fixture");
  test.setTimeout(240_000);
  const dir = join(root, "test-results", `rot-${process.pid}`);
  await mkdir(join(dir, "user-data"), { recursive: true });
  const env: Record<string, string | undefined> = { ...process.env,
    AIVS_RESOURCES_PATH: join(root, "resources"), AIVS_E2E_MEDIA_PATH: fixture,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: fixture }),
    AIVS_SIDECAR_EXECUTABLE: join(root, ".venv", "Scripts", "python.exe"),
    AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
    PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
    ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined };
  const app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${join(dir, "user-data")}`], cwd: desktop, env });
  try {
    const page = await app.firstWindow();
    page.on("crash", () => console.log("[rot] CRASH"));
    await page.waitForFunction(() => Boolean((window as any).desktop?.getRuntime), { timeout: 60_000 });
    await page.evaluate(() => (window as any).desktop.getRuntime());
    await page.getByRole("tab", { name: "素材", exact: true }).waitFor({ timeout: 30_000 });
    const projectName = `ROT ${process.pid}`;
    await page.getByRole("button", { name: "切换项目" }).click();
    await page.getByRole("listbox", { name: "选择项目" }).getByRole("menuitem", { name: "项目管理" }).click();
    await page.getByLabel("新项目名称").fill(projectName);
    await page.getByLabel("新建项目画布比例").selectOption("916");
    // 显式确认 select 真被设成 916（否则会静默用默认值创建 16:9 项目）
    const ratio = await page.getByLabel("新建项目画布比例").inputValue();
    console.log("[rot] new project ratio =", ratio);
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
    await page.getByLabel("预览比例").selectOption("916");
    await page.waitForTimeout(15000);
    console.log("[rot] clicking play");
    await page.getByRole("button", { name: "播放", exact: true }).click({ timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(10000);
    // 截图取证
    await page.screenshot({ path: join(dir, "preview.png") });
    const st = await page.evaluate(() => {
      const w = window as any;
      const m = w.__aivsPreviewMetrics ?? null;
      const tcEl = document.querySelector(".playback-bar .tc b") as HTMLElement | null;
      return { tc: tcEl?.innerText ?? "?", backend: m?.decode_backend ?? null, hdrMedia: m?.hdr_media ?? null, err: (m?.last_error ?? "").slice(0,120) };
    });
    console.log(`[rot] ${JSON.stringify(st)}`);
    console.log(`[rot] screenshot=${join(dir, "preview.png")}`);
  } finally { await app.close().catch(() => undefined); }
});