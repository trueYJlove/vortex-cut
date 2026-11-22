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
async function launch(userData: string, video: string) { return electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`], cwd: desktop, env: env(video) }); }

const trackIds = (page: any, projectId: string) => page.evaluate(async (id: string) => {
  const state = await window.desktop.getTimeline(id as never);
  return state.current_revision.document.tracks.map(track => track.id as string);
}, projectId);
const trackFlags = (page: any, projectId: string, trackId: string) => page.evaluate(async ({ id, track }: { id: string; track: string }) => {
  const state = await window.desktop.getTimeline(id as never);
  return state.current_revision.document.tracks.find(item => item.id === track);
}, { id: projectId, track: trackId } as never);

test("多轨道：新增视频/文本轨、跨轨拖动与轨道属性", async () => {
  test.setTimeout(300_000);
  const run = join(root, "test-results", `m6-multi-track-${process.pid}-${Date.now()}`);
  const userData = join(run, "user-data"); const video = join(run, "素材.mp4");
  await mkdir(run, { recursive: true });
  await copyFile(join(root, "test-assets", "generated", "cfr-landscape-av.mp4"), video);
  const app = await launch(userData, video);
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    const setup = await page.evaluate(async () => {
      const project = await window.desktop.createProject({ name: "M6 Multi Track E2E" });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
      if (!imported) throw new Error("fixture import cancelled");
      const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
      const firstClipId = created.current_revision.document.clips[0].clip_id;
      await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: created.current_revision.timeline_revision_id, operations: [
        { op: "trim_clip", clip_id: firstClipId as never, source_start_us: 0, source_end_us: 2_000_000 },
      ], summary: "两秒" } });
      return { project_id: project.project_id, asset_id: imported.asset.asset_id };
    });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /Clip .* video/ })).toHaveCount(1, { timeout: 30_000 });

    const canvas = page.locator(".timeline-canvas-container canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no box");
    // 轨道组可能在可用空间中垂直居中，按实际轨道头坐标定位。
    const rowDragY = async (trackId: string) => {
      const head = await page.locator(`.timeline-track-head[data-track-id="${trackId}"]`).boundingBox();
      const currentCanvas = await canvas.boundingBox();
      if (!head || !currentCanvas) throw new Error(`轨道 ${trackId} 不可见`);
      return Math.round(head.y - currentCanvas.y + 8);
    };
    // HTML5 拖放模拟：向画布指定行位置派发 dragover/drop。
    const dispatchDrop = (assetId: string, x: number, y: number) => page.evaluate(({ x: px, y: py, assetId: aid }: { x: number; y: number; assetId: string }) => {
      const canvas = document.querySelector(".timeline-canvas-container canvas") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData("application/x-vortex-cut-asset", aid);
      const opts = { bubbles: true, cancelable: true, clientX: rect.left + px, clientY: rect.top + py, dataTransfer: dt };
      canvas.dispatchEvent(new DragEvent("dragover", opts));
      canvas.dispatchEvent(new DragEvent("drop", opts));
    }, { x, y, assetId } as never);

    // 1. 新增视频轨（"+"按钮 → 菜单）。
    await page.getByRole("button", { name: "添加轨道" }).click();
    await page.getByRole("menuitem", { name: "视频轨道" }).click();
    await expect.poll(() => trackIds(page, setup.project_id)).toEqual(["V2", "C1", "V1", "A1"]);
    await expect(page.locator(".timeline-track-head")).toHaveCount(4);

    // 2. 片段跨轨拖动：V1（行 2）→ V2（行 0），仅垂直拖动，时间位置不变。
    //    拖拽点取行顶部偏移 +8，避开行内下部的音量线。
    // 轨道顺序：V2=0, C1=1, V1=2, A1=3。
    await page.mouse.move(box.x + 150, box.y + await rowDragY("V1"));
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + await rowDragY("V2"), { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const movedTrackId = await page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips[0].track_id as string;
    }, setup.project_id);
    expect(movedTrackId).toBe("V2");

    // 2b. 拖入新视频素材到 V2 行（HTML5 drop 模拟）→ 素材加入 V2。
    await dispatchDrop(setup.asset_id, 320, await rowDragY("V2"));
    await expect.poll(async () => await page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips.length;
    }, setup.project_id)).toBe(2);
    const secondClipTrack = await page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips[1].track_id as string;
    }, setup.project_id);
    expect(secondClipTrack).toBe("V2");

    // 3. 轨道属性开关：隐藏与静音（视频轨全量）。
    await page.getByRole("button", { name: "隐藏轨道 V2" }).click();
    await expect.poll(async () => (await trackFlags(page, setup.project_id, "V2"))?.hidden).toBe(true);
    await page.getByRole("button", { name: "静音轨道 V2" }).click();
    await expect.poll(async () => (await trackFlags(page, setup.project_id, "V2"))?.muted).toBe(true);
    await page.getByRole("button", { name: "独奏轨道 V2" }).click();
    await expect.poll(async () => (await trackFlags(page, setup.project_id, "V2"))?.solo).toBe(true);
    await page.getByRole("button", { name: "锁定轨道 V2" }).click();
    await expect.poll(async () => (await trackFlags(page, setup.project_id, "V2"))?.locked).toBe(true);

    // 4. 新增文本轨（验证头部按钮按类型增减）。
    await page.getByRole("button", { name: "添加轨道" }).click();
    await page.getByRole("menuitem", { name: "文本轨道" }).click();
    await expect.poll(() => trackIds(page, setup.project_id)).toEqual(["V2", "T1", "C1", "V1", "A1"]);
    await expect(page.getByRole("button", { name: "静音轨道 T1" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "独奏轨道 T1" })).toHaveCount(0);
    // 无素材的轨道不显示属性开关（A1 为空）；有片段的 V2 开关齐全。
    await expect(page.getByRole("button", { name: "隐藏轨道 A1" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "静音轨道 A1" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "静音轨道 V2" })).toHaveCount(1);

    // 4b. 视频素材拖到文本轨上 → 自动新建视频轨（V3）并放入。
    await dispatchDrop(setup.asset_id, 320, await rowDragY("T1"));
    await expect.poll(() => trackIds(page, setup.project_id)).toEqual(["V2", "T1", "V3", "C1", "V1", "A1"]);
    const thirdClipTrack = await page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips[2].track_id as string;
    }, setup.project_id);
    expect(thirdClipTrack).toBe("V3");

    // 5. 轨道头只保留轨道属性，不暴露移动和删除入口。
    const v2Head = page.locator('.timeline-track-head[data-track-id="V2"]');
    await v2Head.hover();
    await expect(page.getByRole("button", { name: /(?:上移|下移|删除)轨道/ })).toHaveCount(0);
    const badge = v2Head.locator(".timeline-track-badge");
    const dragTrackTo = async (targetId: string) => {
      const from = await badge.boundingBox();
      const to = await page.locator(`.timeline-track-head[data-track-id="${targetId}"]`).boundingBox();
      if (!from || !to) throw new Error("轨道头不可见");
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 8 });
      await page.mouse.up();
    };
    await dragTrackTo("T1");
    await expect.poll(() => trackIds(page, setup.project_id)).toEqual(["T1", "V2", "V3", "C1", "V1", "A1"]);
    await dragTrackTo("T1");
    await expect.poll(() => trackIds(page, setup.project_id)).toEqual(["V2", "T1", "V3", "C1", "V1", "A1"]);
    await v2Head.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "删除轨道" })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "锁定轨道 V2" }).click();
    await expect.poll(async () => (await trackFlags(page, setup.project_id, "V2"))?.locked).toBe(false);
    await v2Head.click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除轨道" }).click();
    await expect.poll(() => trackIds(page, setup.project_id)).toEqual(["T1", "V3", "C1", "V1", "A1"]);
    const remaining = await page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips.map(clip => clip.track_id as string);
    }, setup.project_id);
    expect(remaining).toEqual(["V3"]);
  } finally {
    await app.close();
  }
});
