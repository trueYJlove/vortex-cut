import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../../.."); const desktop = resolve(currentDir, ".."); const resources = join(root, "resources");
const pythonSidecar = join(root, ".venv", "Scripts", "python.exe"); const packagedSidecar = join(resources, "core", "aivs-core", "aivs-core.exe");
const sidecarExecutable = process.env.AIVS_SIDECAR_EXECUTABLE ?? (existsSync(pythonSidecar) ? pythonSidecar : packagedSidecar);
const sidecarArgs = process.env.AIVS_SIDECAR_EXECUTABLE_ARGS ?? (existsSync(pythonSidecar) ? JSON.stringify(["-m", "aivs_core.bootstrap"]) : JSON.stringify([]));

function env(video: string) { return { ...process.env, AIVS_RESOURCES_PATH: resources, AIVS_E2E_ASSET_PATHS: JSON.stringify({ video, image: video }), AIVS_SIDECAR_EXECUTABLE: sidecarExecutable, AIVS_SIDECAR_EXECUTABLE_ARGS: sidecarArgs, PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"), ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }; }
async function launch(userData: string, video: string) { return electron.launch({ args: [join(desktop, "out", "main", "index.js"), `--user-data-dir=${userData}`], cwd: desktop, env: env(video) }); }

test("M4 时间线交互：磁吸持久化、右键删除片段、滚轮缩放/平移后右键可用", async () => {
  test.setTimeout(300_000);
  const run = join(root, "test-results", `m4-timeline-interaction-${process.pid}-${Date.now()}`);
  const userData = join(run, "user-data"); const video = join(run, "交互素材.mp4");
  await mkdir(run, { recursive: true });
  await copyFile(join(root, "test-assets", "generated", "cfr-landscape-av.mp4"), video);
  const app = await launch(userData, video);
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });

    // 1. 建项目：同一视频插两次 → V1 两段各 2s（默认 60pps 下片段 x [120,240] 与 [240,360]）。
    const setup = await page.evaluate(async () => {
      const project = await window.desktop.createProject({ name: "M4 Timeline Interaction E2E" });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
      if (!imported) throw new Error("fixture import cancelled");
      const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
      const firstClipId = created.current_revision.document.clips[0].clip_id;
      await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: created.current_revision.timeline_revision_id, operations: [
        { op: "trim_clip", clip_id: firstClipId as never, source_start_us: 0, source_end_us: 2_000_000 },
        { op: "insert_asset_clip", asset_id: imported.asset.asset_id, at_index: 1, source_start_us: 0, source_end_us: 2_000_000 },
      ], summary: "第二段" } });
      return { project_id: project.project_id };
    });
    expect(setup.project_id).toBeTruthy();
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /Clip .* video/ })).toHaveCount(2, { timeout: 30_000 });

    // 2. 磁吸开关：默认开 → 关闭持久化 → 重载后保持关闭 → 再打开。
    const magnet = page.getByRole("button", { name: "磁吸吸附" });
    await expect(magnet).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
    await magnet.click();
    await expect(magnet).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "磁吸吸附" })).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 });
    await page.getByRole("button", { name: "磁吸吸附" }).click();
    await expect(page.getByRole("button", { name: "磁吸吸附" })).toHaveAttribute("aria-pressed", "true");

    // 3. 右键第一个片段 → 菜单 → 删除片段 → a11y 列表只剩 1 个片段。
    //    多轨道布局（自上而下 C1/V1/A1），V1 行中心 y = 28 + rowHeight/2。
    const canvas = page.locator(".timeline-canvas-container canvas");
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("canvas boundingBox unavailable");
    const rowHeight4 = 56; // 固定行高（标尺 16 + 行 56）
    const v1RowCenterY = Math.round(16 + rowHeight4 + rowHeight4 / 2);
    await canvas.click({ button: "right", position: { x: 150, y: v1RowCenterY } });
    const menu = page.getByRole("menu", { name: "时间线右键菜单" });
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await page.getByRole("menuitem", { name: "删除片段" }).click();
    await expect(page.getByRole("button", { name: /Clip .* video/ })).toHaveCount(1, { timeout: 15_000 });

    // 4. 滚轮缩放（光标锚定）后，右键交互仍正常。
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas boundingBox unavailable");
    await page.mouse.move(box.x + 150, box.y + 60);
    for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -240);
    await canvas.click({ button: "right", position: { x: 150, y: 60 } });
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden({ timeout: 5_000 });

    // 5. Shift+滚轮水平平移后，右键仍弹出菜单（片段或空区均视为可用）。
    await page.keyboard.down("Shift");
    for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, 300);
    await page.keyboard.up("Shift");
    await canvas.click({ button: "right", position: { x: Math.min(400, box.width - 30), y: 60 } });
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden({ timeout: 5_000 });
  } finally {
    await app.close();
  }
});
