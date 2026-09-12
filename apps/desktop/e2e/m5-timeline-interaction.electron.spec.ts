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

test("M5 时间线：音量线拖拽改 gain、V1 自由定位贴齐钳制、双击标尺适应", async () => {
  test.setTimeout(300_000);
  const run = join(root, "test-results", `m5-timeline-${process.pid}-${Date.now()}`);
  const userData = join(run, "user-data"); const video = join(run, "素材.mp4");
  await mkdir(run, { recursive: true });
  await copyFile(join(root, "test-assets", "generated", "cfr-landscape-av.mp4"), video);
  const app = await launch(userData, video);
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    // 3 段各 2s（默认 60pps：x [120,240] [240,360] [360,480]；2s 片段 0dB 音量线在行内 y≈70）。
    const setup = await page.evaluate(async () => {
      const project = await window.desktop.createProject({ name: "M5 Timeline E2E" });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
      if (!imported) throw new Error("fixture import cancelled");
      const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
      const firstClipId = created.current_revision.document.clips[0].clip_id;
      const state = await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: created.current_revision.timeline_revision_id, operations: [
        { op: "trim_clip", clip_id: firstClipId as never, source_start_us: 0, source_end_us: 2_000_000 },
        { op: "insert_asset_clip", asset_id: imported.asset.asset_id, at_index: 1, source_start_us: 0, source_end_us: 2_000_000 },
        { op: "insert_asset_clip", asset_id: imported.asset.asset_id, at_index: 2, source_start_us: 0, source_end_us: 2_000_000 },
      ], summary: "三段" } });
      const [a, b, c] = state.current_revision.document.clips.map(clip => clip.clip_id as string);
      return { project_id: project.project_id, order: [a, b, c] };
    });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /Clip .* video/ })).toHaveCount(3, { timeout: 30_000 });

    const canvas = page.locator(".timeline-canvas-container canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no box");

    // 多轨道布局：固定行高（标尺 24 + 行 56），行序自上而下 C1/V1/A1；
    // V1 行 0dB 音量线位置按行几何推导。
    const rowHeight = 56;
    const v1RowY = 16 + rowHeight;
    const volumeLineY = Math.round(v1RowY + rowHeight - 6 - (30 / 42) * 0.35 * rowHeight);
    const volumeLineTop = Math.round(v1RowY + rowHeight - 6 - 0.35 * rowHeight);
    // 片段拖拽点取 V1 行顶部（避开音量线——它位于行内下部，最高到行底-6-0.35h）。
    const clipRowY = v1RowY + 8;

    // 1. 音量线：拖第二段（x≈300）0dB 音量线向上 → +12dB 附近（限幅）。
    await page.mouse.move(box.x + 300, box.y + volumeLineY);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + volumeLineTop, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const gains = await page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips.map(clip => clip.audio.gain_db);
    }, setup.project_id);
    expect(gains[1]).toBeGreaterThan(5); // 拖到顶部限幅 ≈ +12dB

    // 2. V1 自由定位：选中第二段并向右拖过第三段 → 钳制到第三段右缘贴齐
    //    （[6s, 8s)），第一/三段不动，列表顺序不变（position_clip 不重排）。
    await page.mouse.click(box.x + 300, box.y + clipRowY);
    await page.waitForTimeout(200);
    await page.mouse.move(box.x + 300, box.y + clipRowY);
    await page.mouse.down();
    await page.mouse.move(box.x + 470, box.y + clipRowY, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const positions = await page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips.map(clip => ({
        clip_id: clip.clip_id as string,
        start: clip.timeline_start_us as number,
        end: clip.timeline_end_us as number,
      }));
    }, setup.project_id);
    const positionById = new Map(positions.map(item => [item.clip_id, item]));
    expect(positionById.get(setup.order[1])?.start).toBe(6_000_000);
    expect(positionById.get(setup.order[1])?.end).toBe(8_000_000);
    expect(positionById.get(setup.order[0])?.start).toBe(0);
    expect(positionById.get(setup.order[2])?.start).toBe(4_000_000);

    // 3. 双击标尺 → 适应内容（滑杆回落到 fit 值 ≈86，而不是保持之前的缩放）。
    await page.locator(".timeline-zoom-slider").fill("100");
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => Number((document.querySelector(".timeline-zoom-slider") as HTMLInputElement).value));
    await page.mouse.dblclick(box.x + 400, box.y + 14);
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => Number((document.querySelector(".timeline-zoom-slider") as HTMLInputElement).value));
    expect(before).toBe(100);
    expect(after).toBeLessThan(100);
  } finally {
    await app.close();
  }
});
