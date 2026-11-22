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
const sourceVideo = process.env.AIVS_M6_SOURCE_VIDEO ?? join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
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
  await copyFile(sourceVideo, video);
  const app = await launch(userData, video);
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    const setup = await page.evaluate(async () => {
      const project = await window.desktop.createProject({ name: "M6 Multi Track E2E", canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1 } });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
      if (!imported) throw new Error("fixture import cancelled");
      const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "fit", caption_preset_id: "default-bottom" } });
      const firstClipId = created.current_revision.document.clips[0].clip_id;
      await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: created.current_revision.timeline_revision_id, operations: [
        { op: "trim_clip", clip_id: firstClipId as never, source_start_us: 0, source_end_us: 2_000_000 },
        { op: "set_layout", clip_id: firstClipId as never, layout: "fit" },
      ], summary: "两秒" } });
      return { project_id: project.project_id, asset_id: imported.asset.asset_id };
    });
    await page.evaluate(() => window.localStorage.setItem("vortexcut.theme", "dark"));
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    await expect(page.getByRole("button", { name: /Clip .* video/ })).toHaveCount(1, { timeout: 30_000 });

    // The app menu now lives on the brand mark, as OpenFilm's logo menu does.
    await page.setViewportSize({ width: 900, height: 720 });
    const brandMenuButton = page.getByRole("button", { name: "Vortex Cut 主菜单" });
    await brandMenuButton.click();
    await expect(page.getByRole("dialog", { name: "Vortex Cut 主菜单" })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    const manageProjects = page.getByRole("menuitem", { name: "项目管理" });
    await expect(manageProjects).toBeFocused();
    await manageProjects.click();
    await expect(page.getByRole("dialog", { name: "项目管理" })).toBeVisible();
    const projectManagerBox = await page.getByRole("dialog", { name: "项目管理" }).boundingBox();
    expect(projectManagerBox?.width).toBeLessThanOrEqual(900);
    expect(projectManagerBox?.height).toBeLessThanOrEqual(720);
    const projectSearch = page.getByRole("searchbox", { name: "搜索项目" });
    await projectSearch.fill("M6 Multi Track E2E");
    const projectCard = page.locator(`.project-library-card[data-project-id="${setup.project_id}"]`);
    await expect(projectCard).toBeVisible();
    await page.getByRole("combobox", { name: "筛选项目状态" }).selectOption("archived");
    await expect(page.getByText("没有匹配的项目")).toBeVisible();
    await page.getByRole("combobox", { name: "筛选项目状态" }).selectOption("all");
    await expect(projectCard).toBeVisible();
    const searchFitsField = await page.locator(".project-library-search input").evaluate((input: HTMLInputElement) => {
      const field = input.parentElement!.getBoundingClientRect(); const box = input.getBoundingClientRect();
      return box.top >= field.top - 1 && box.bottom <= field.bottom + 1;
    });
    expect(searchFitsField).toBe(true);
    await projectSearch.fill("");
    await projectSearch.evaluate((element: HTMLInputElement) => element.blur());
    await page.keyboard.press("Escape");
    await page.getByText("项目库", { exact: true }).click();
    await page.addStyleTag({ content: ".synthetic-metrics { display: none !important; }" });
    await page.screenshot({ path: join(run, "project-manager.png"), fullPage: true });
    await page.getByRole("button", { name: "列表视图", exact: true }).click();
    await expect(page.locator(".project-library-grid")).toHaveClass(/list-view/);
    await page.getByRole("button", { name: "卡片视图" }).click();
    await expect(page.locator(".project-library-grid")).not.toHaveClass(/list-view/);
    await page.getByRole("button", { name: "关闭项目管理" }).click();
    await page.getByRole("button", { name: /Vortex Cut 主菜单/ }).click();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("menuitem", { name: "项目管理" }).click();
    await expect(page.getByRole("dialog", { name: "项目管理" })).toBeVisible();
    const unfilteredCard = page.locator(`.project-library-card[data-project-id="${setup.project_id}"]`);
    const renameManagedProject = async (name: string) => {
      await unfilteredCard.getByRole("button", { name: /重命名项目/ }).click();
      const nameInput = unfilteredCard.getByRole("textbox", { name: /项目名称/ });
      await nameInput.fill(name);
      await unfilteredCard.getByRole("button", { name: "保存项目名称" }).click();
      await expect(unfilteredCard.locator("h4")).toHaveText(name);
    };
    await renameManagedProject("M6 Multi Track Renamed");
    await renameManagedProject("M6 Multi Track E2E");
    await unfilteredCard.getByRole("button", { name: "归档项目 M6 Multi Track E2E" }).click();
    await expect(unfilteredCard.locator(".project-library-status")).toHaveText("已归档");
    await unfilteredCard.getByRole("button", { name: "重新打开项目 M6 Multi Track E2E" }).click();
    await expect(unfilteredCard.locator(".project-library-status")).toHaveText("本地项目");
    await page.getByRole("textbox", { name: "新项目名称" }).fill("M6 Project Manager E2E");
    await page.getByRole("combobox", { name: "新建项目画布比例" }).selectOption("169");
    await page.getByRole("dialog", { name: "项目管理" }).getByRole("button", { name: "新建项目", exact: true }).click();
    await expect(page.locator(".titlebar-project-name")).toHaveText("M6 Project Manager E2E", { timeout: 30_000 });
    const isolatedV1 = page.locator('.timeline-track-head[data-track-id="V1"]');
    await expect(isolatedV1).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "添加轨道" }).click();
    await page.getByRole("menuitem", { name: "视频轨道" }).click();
    await expect(page.locator('.timeline-track-head[data-track-id="V2"]')).toHaveCSS("height", "52px");
    await page.getByRole("button", { name: /Vortex Cut 主菜单/ }).click();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("menuitem", { name: "项目管理" }).click();
    const originalProject = page.locator(`.project-library-card[data-project-id="${setup.project_id}"]`);
    await page.getByRole("searchbox", { name: "搜索项目" }).fill("M6 Multi Track E2E");
    await originalProject.getByRole("button", { name: "打开项目" }).click();
    await expect(page.locator(".titlebar-project-name")).toHaveText("M6 Multi Track E2E", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: /Clip .* video/ })).toHaveCount(1, { timeout: 30_000 });
    await brandMenuButton.click();
    await expect(page.getByRole("dialog", { name: "Vortex Cut 主菜单" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Vortex Cut 主菜单" })).toHaveCount(0);
    await expect(brandMenuButton).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 900 });

    // Pane switches must collapse their grid tracks, not leave empty columns behind.
    const libraryPane = page.locator(".library-pane");
    const libraryToggle = page.getByRole("button", { name: "媒体库面板开关" });
    const stackBeforeLibraryClose = await page.locator(".editor-stack").boundingBox();
    await libraryToggle.click();
    await expect(libraryToggle).toHaveAttribute("aria-pressed", "false");
    await expect(libraryPane).toBeHidden();
    await expect.poll(async () => (await page.locator(".editor-stack").boundingBox())?.x ?? Infinity).toBeLessThan((stackBeforeLibraryClose?.x ?? 0) + 2);
    await libraryToggle.click();
    await expect(libraryToggle).toHaveAttribute("aria-pressed", "true");
    await expect(libraryPane).toBeVisible();
    const inspectorToggle = page.getByRole("button", { name: "属性面板开关" });
    const propertiesPane = page.locator(".properties-pane");
    const stageWidthBeforeClose = (await page.locator(".stage-pane").boundingBox())?.width ?? 0;
    await inspectorToggle.click();
    await expect(inspectorToggle).toHaveAttribute("aria-pressed", "false");
    await expect(propertiesPane).toBeHidden();
    await expect.poll(async () => (await page.locator(".stage-pane").boundingBox())?.width ?? 0).toBeGreaterThan(stageWidthBeforeClose + 100);
    await inspectorToggle.click();
    await expect(inspectorToggle).toHaveAttribute("aria-pressed", "true");
    await expect(propertiesPane).toBeVisible();
    const previewSettings = page.getByRole("button", { name: "预览设置" });
    await previewSettings.click();
    await expect(page.getByRole("dialog", { name: "预览设置" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "预览设置" })).toHaveCount(0);
    await expect(previewSettings).toBeFocused();
    await previewSettings.click();
    await page.locator(".preview-frame").click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole("dialog", { name: "预览设置" })).toHaveCount(0);

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
    const dispatchDrop = (assetId: string, x: number, y: number, altKey = false) => page.evaluate(({ x: px, y: py, assetId: aid, alt }: { x: number; y: number; assetId: string; alt: boolean }) => {
      const canvas = document.querySelector(".timeline-canvas-container canvas") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData("application/x-vortex-cut-asset", aid);
      const opts = { bubbles: true, cancelable: true, clientX: rect.left + px, clientY: rect.top + py, dataTransfer: dt, altKey: alt };
      canvas.dispatchEvent(new DragEvent("dragover", opts));
      canvas.dispatchEvent(new DragEvent("drop", opts));
    }, { x, y, assetId, alt: altKey } as never);

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
    const beforeDropIds = await page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips.map(clip => clip.clip_id as string);
    }, setup.project_id);
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

    // 2c. OpenFilm Alt-drop overwrites the target range at the pointer instead of rippling.
    const insertedClipId = await page.evaluate(async ({ id, before }: { id: string; before: string[] }) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips.find(clip => !before.includes(clip.clip_id as string))?.clip_id as string | undefined;
    }, { id: setup.project_id, before: beforeDropIds });
    if (!insertedClipId) throw new Error("未找到普通插入创建的片段");
    const insertedRange = await page.evaluate(async ({ id, clipId }: { id: string; clipId: string }) => {
      const state = await window.desktop.getTimeline(id as never);
      const clip = state.current_revision.document.clips.find(item => item.clip_id === clipId);
      return clip ? { start: clip.timeline_start_us, end: clip.timeline_end_us } : null;
    }, { id: setup.project_id, clipId: insertedClipId });
    if (!insertedRange) throw new Error("普通插入片段已消失");
    const v2Y = await rowDragY("V2");
    await page.evaluate(({ x, y, assetId }: { x: number; y: number; assetId: string }) => {
      const canvas = document.querySelector(".timeline-canvas-container canvas") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData("application/x-vortex-cut-asset", assetId);
      canvas.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, dataTransfer: dt, altKey: true }));
    }, { x: 260, y: v2Y, assetId: setup.asset_id } as never);
    const overwriteHint = page.locator(".drop-hint").filter({ hasText: "Alt 覆盖" });
    await expect(overwriteHint).toBeVisible();
    const overwriteTime = Number((await overwriteHint.innerText()).match(/从\s+([\d.]+)s/)?.[1]) * 1_000_000;
    if (!Number.isFinite(overwriteTime)) throw new Error("覆盖提示中没有时间落点");
    await dispatchDrop(setup.asset_id, 260, v2Y, true);
    await expect.poll(async () => await page.evaluate(async ({ id, clipId, expectedEnd, originalEnd }: { id: string; clipId: string; expectedEnd: number; originalEnd: number }) => {
      const state = await window.desktop.getTimeline(id as never);
      const clip = state.current_revision.document.clips.find(item => item.clip_id === clipId);
      return Boolean(clip && clip.timeline_end_us < originalEnd && Math.abs(clip.timeline_end_us - expectedEnd) < 70_000);
    }, { id: setup.project_id, clipId: insertedClipId, expectedEnd: overwriteTime, originalEnd: insertedRange.end })).toBe(true);
    await expect.poll(async () => await page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips.length;
    }, setup.project_id)).toBe(3);
    const overwriteStart = await page.evaluate(async ({ id, fromUs }: { id: string; fromUs: number }) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips.find(clip => clip.track_id === "V2" && clip.timeline_start_us >= fromUs - 70_000)?.timeline_start_us;
    }, { id: setup.project_id, fromUs: overwriteTime });
    expect(overwriteStart).toBeDefined();
    expect(Math.abs(overwriteStart! - overwriteTime)).toBeLessThan(70_000);

    // 3. 轨道属性开关：隐藏与静音（视频轨全量）。
    await page.getByRole("button", { name: "隐藏轨道 V2" }).click();
    await expect.poll(async () => (await trackFlags(page, setup.project_id, "V2"))?.hidden).toBe(true);
    await page.getByRole("button", { name: "静音轨道 V2" }).click();
    await expect.poll(async () => (await trackFlags(page, setup.project_id, "V2"))?.muted).toBe(true);
    await page.getByRole("button", { name: "独奏轨道 V2" }).click();
    await expect.poll(async () => (await trackFlags(page, setup.project_id, "V2"))?.solo).toBe(true);
    await page.getByRole("button", { name: "锁定轨道 V2" }).click();
    await expect.poll(async () => (await trackFlags(page, setup.project_id, "V2"))?.locked).toBe(true);
    const hiddenPreview = await page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      const request = { project_id: id as never, timeline_revision_id: state.current_revision.timeline_revision_id, output_ratio: "169" };
      const [manifest, firstWindow] = await Promise.all([
        window.desktop.getPreviewIrV2Manifest(request),
        window.desktop.getPreviewIrV2Window({ ...request, start_frame: 0, frame_count: 1 }),
      ]);
      return { totalFrames: manifest.total_frames, firstFrame: firstWindow.frames[0] };
    }, setup.project_id);
    expect(hiddenPreview.totalFrames).toBeGreaterThan(0);
    expect(hiddenPreview.firstFrame?.main).toEqual({ kind: "black" });
    expect(hiddenPreview.firstFrame?.layers).toEqual([]);
    await expect(page.getByRole("note", { name: "合成预览回退提示" })).toHaveCount(0, { timeout: 10_000 });

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
      return state.current_revision.document.clips.find(clip => clip.track_id === "V3")?.track_id as string | undefined;
    }, setup.project_id);
    expect(thirdClipTrack).toBe("V3");

    // 5. 轨道头无独立上下移按钮；高度可逐轨调整，轨道顺序仍可拖动、删除走右键菜单。
    const v2Head = page.locator('.timeline-track-head[data-track-id="V2"]');
    await v2Head.hover();
    const v2Resize = page.getByRole("separator", { name: "调整轨道 V2 高度" });
    const v2HeightBefore = (await v2Head.boundingBox())?.height;
    const resizeBox = await v2Resize.boundingBox();
    if (v2HeightBefore === undefined || !resizeBox) throw new Error("V2 轨道高度控件不可见");
    await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2 + 20, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await v2Head.boundingBox())?.height ?? 0).toBeGreaterThan(v2HeightBefore + 12);
    await v2Resize.dblclick();
    await expect(v2Head).toHaveCSS("height", "52px");
    await v2Resize.focus();
    await page.keyboard.press("ArrowDown");
    await expect(v2Head).toHaveCSS("height", "56px");
    await expect.poll(() => page.evaluate((projectId: string) => {
      const prefs = JSON.parse(localStorage.getItem(`vortex-cut.timeline.prefs.v1.project.${encodeURIComponent(projectId)}.track-heights`) ?? "{}");
      return prefs.V2;
    }, setup.project_id)).toBe(56);
    await page.keyboard.press("Home");
    await expect(v2Head).toHaveCSS("height", "52px");
    await v2Resize.focus();
    await page.keyboard.press("ArrowDown");
    await expect(v2Head).toHaveCSS("height", "56px");
    const projectSwitcher = page.getByRole("button", { name: "切换项目" });
    await projectSwitcher.click();
    await page.getByRole("option", { name: /M6 Project Manager E2E/ }).click();
    await expect(page.locator(".titlebar-project-name")).toHaveText("M6 Project Manager E2E");
    await expect(page.locator('.timeline-track-head[data-track-id="V2"]')).toHaveCSS("height", "52px");
    await projectSwitcher.click();
    await page.getByRole("option", { name: /M6 Multi Track E2E/ }).click();
    await expect(page.locator(".titlebar-project-name")).toHaveText("M6 Multi Track E2E");
    const restoredV2Head = page.locator('.timeline-track-head[data-track-id="V2"]');
    await expect(restoredV2Head).toHaveCSS("height", "56px");
    await page.getByRole("separator", { name: "调整轨道 V2 高度" }).focus();
    await page.keyboard.press("Home");
    await expect(restoredV2Head).toHaveCSS("height", "52px");
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
    // Restore the display flags before capturing the final composition.
    await page.getByRole("button", { name: "隐藏轨道 V2" }).click();
    await expect.poll(async () => (await trackFlags(page, setup.project_id, "V2"))?.hidden).toBe(false);
    await page.getByRole("button", { name: "静音轨道 V2" }).click();
    await expect.poll(async () => (await trackFlags(page, setup.project_id, "V2"))?.muted).toBe(false);
    await page.getByRole("button", { name: "独奏轨道 V2" }).click();
    await expect.poll(async () => (await trackFlags(page, setup.project_id, "V2"))?.solo).toBe(false);
    // Park V3 after the V2 sequence so the preview shows a single active clip, not a PIP stack.
    const currentCanvas = await canvas.boundingBox();
    if (!currentCanvas) throw new Error("no current canvas box");
    const v3Y = await rowDragY("V3");
    await page.mouse.move(currentCanvas.x + 150, currentCanvas.y + v3Y);
    await page.mouse.down();
    await page.mouse.move(currentCanvas.x + 570, currentCanvas.y + v3Y, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => await page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips.find(clip => clip.track_id === "V3")?.timeline_start_us ?? -1;
    }, setup.project_id)).toBeGreaterThan(5_500_000);
    // Restore a base-track shot at playhead 0 after proving cross-track dragging.
    const v2YAfterOrder = await rowDragY("V2");
    const v1Y = await rowDragY("V1");
    await page.mouse.move(currentCanvas.x + 150, currentCanvas.y + v2YAfterOrder);
    await page.mouse.down();
    await page.mouse.move(currentCanvas.x + 150, currentCanvas.y + v1Y, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => await page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips.some(clip => clip.track_id === "V1");
    }, setup.project_id)).toBe(true);
    // Reload from the persisted clean state so the acceptance screenshot starts
    // with a fresh preview session and no active transform selection.
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "切换项目" }).click();
    await page.getByRole("option", { name: /M6 Multi Track E2E/ }).click();
    await expect(page.locator(".titlebar-project-name")).toHaveText("M6 Multi Track E2E");
    await expect(page.getByRole("button", { name: /Clip .* video/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => {
      const track = await trackFlags(page, setup.project_id, "V2");
      return { hidden: track?.hidden, muted: track?.muted, solo: track?.solo };
    }).toEqual({ hidden: false, muted: false, solo: false });
    const previewFallback = page.getByRole("note", { name: "合成预览回退提示" });
    await expect(page.locator(".synthetic-preview")).toBeVisible({ timeout: 30_000 });
    await expect(previewFallback).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(".synthetic-loading")).toHaveCount(0, { timeout: 30_000 });
    // Clear the transform handles so the acceptance frame shows the composition
    // cleanly, as a viewer would see it rather than an active geometry edit.
    const t1Y = await rowDragY("T1");
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("no current canvas box");
    await page.mouse.click(canvasBox.x + 500, canvasBox.y + t1Y, { button: "right" });
    await page.getByRole("menuitem", { name: "取消选择" }).click();
    // The preview must stay fitted at compact desktop sizes, and OpenFilm's
    // anchor zoom + wheel/middle-button pan must move the actual picture.
    await page.setViewportSize({ width: 1040, height: 760 });
    const previewFrame = page.locator(".preview-frame");
    await expect(previewFrame).toBeVisible();
    await expect(page.locator(".synthetic-buffering")).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => {
      const pane = document.querySelector(".stage-pane")!.getBoundingClientRect();
      const column = document.querySelector(".stage-column")!.getBoundingClientRect();
      const frame = document.querySelector(".preview-frame")!.getBoundingClientRect();
      const picture = document.querySelector(".preview-canvas")!.getBoundingClientRect();
      return column.width <= pane.width + 1 && frame.width > 0 && picture.width <= frame.width + 1;
    })).toBe(true);

    const anchor = await page.evaluate(() => {
      const frame = document.querySelector(".preview-frame")!;
      const picture = document.querySelector(".preview-canvas")!;
      const vr = frame.getBoundingClientRect(); const pr = picture.getBoundingClientRect();
      const x = vr.left + vr.width * 0.64; const y = vr.top + vr.height * 0.46;
      const before = { x: (x - pr.left) / pr.width, y: (y - pr.top) / pr.height, w: pr.width };
      const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: x, clientY: y });
      frame.dispatchEvent(wheel);
      return { ...before, prevented: wheel.defaultPrevented };
    });
    expect(anchor.prevented).toBe(true);
    await expect(previewFrame).toHaveClass(/zoomed/);
    await expect.poll(() => page.locator(".preview-canvas").evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(anchor.w * 1.1);
    await expect(page.locator(".synthetic-buffering")).toHaveCount(0, { timeout: 10_000 });
    const anchoredAfter = await page.evaluate(() => {
      const frame = document.querySelector(".preview-frame")!;
      const picture = document.querySelector(".preview-canvas")!;
      const vr = frame.getBoundingClientRect(); const pr = picture.getBoundingClientRect();
      return { x: (vr.left + vr.width * 0.64 - pr.left) / pr.width, y: (vr.top + vr.height * 0.46 - pr.top) / pr.height };
    });
    expect(anchoredAfter.x).toBeCloseTo(anchor.x, 2);
    expect(anchoredAfter.y).toBeCloseTo(anchor.y, 2);

    const beforeWheelPan = await page.locator(".preview-canvas").evaluate(el => {
      const rect = el.getBoundingClientRect(); return { left: rect.left, top: rect.top };
    });
    const wheelPanPrevented = await page.evaluate(() => {
      const frame = document.querySelector(".preview-frame")!;
      const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 });
      frame.dispatchEvent(wheel); return wheel.defaultPrevented;
    });
    expect(wheelPanPrevented).toBe(true);
    await expect.poll(() => page.locator(".preview-canvas").evaluate(el => el.getBoundingClientRect().top)).not.toBe(beforeWheelPan.top);

    const beforeMiddlePan = await page.locator(".preview-canvas").evaluate(el => el.getBoundingClientRect().left);
    const viewBox = await previewFrame.boundingBox();
    if (!viewBox) throw new Error("preview viewport is not measurable");
    await page.mouse.move(viewBox.x + viewBox.width / 2, viewBox.y + viewBox.height / 2);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(viewBox.x + viewBox.width / 2 + 24, viewBox.y + viewBox.height / 2 + 12, { steps: 4 });
    await page.mouse.up({ button: "middle" });
    await expect.poll(() => page.locator(".preview-canvas").evaluate(el => el.getBoundingClientRect().left)).not.toBe(beforeMiddlePan);

    await previewFrame.focus();
    const beforeArrowPan = await page.locator(".preview-canvas").evaluate(el => el.getBoundingClientRect().left);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => page.locator(".preview-canvas").evaluate(el => el.getBoundingClientRect().left)).not.toBe(beforeArrowPan);
    await page.locator(".zoom-btn").click();
    await expect(page.getByRole("dialog", { name: "预览缩放" })).toBeVisible();
    await page.getByRole("button", { name: /适应画布/ }).click();
    await expect(previewFrame).not.toHaveClass(/zoomed/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".zoom-btn")).toBeFocused();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => page.evaluate(() => {
      const pane = document.querySelector(".stage-pane")!.getBoundingClientRect();
      const column = document.querySelector(".stage-column")!.getBoundingClientRect();
      return column.width <= pane.width + 1;
    })).toBe(true);
    // Keep a reproducible full-window artifact for the real-media multi-track acceptance.
    await expect(page.locator(".synthetic-buffering")).toHaveCount(0, { timeout: 10_000 });
    // The E2E build enables diagnostic metrics that are absent from the release UI.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.addStyleTag({ content: ".synthetic-metrics { display: none !important; }" });
    await page.screenshot({ path: join(run, "multi-track-real-media.png"), fullPage: true });
    await v2Head.click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除轨道" }).click();
    await expect.poll(() => trackIds(page, setup.project_id)).toEqual(["T1", "V3", "C1", "V1", "A1"]);
    const remaining = await page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      return state.current_revision.document.clips.map(clip => clip.track_id as string);
    }, setup.project_id);
    expect(remaining).toContain("V1");
    expect(remaining).toContain("V3");
    expect(remaining).not.toContain("V2");
  } finally {
    await app.close();
  }
});
