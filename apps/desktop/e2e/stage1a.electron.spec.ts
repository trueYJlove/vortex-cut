import { copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectCurrentProject, openProjectManagement } from "./project-switcher";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;

const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../..", "..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");
const videoFixture = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
const ffmpeg = join(resources, "ffmpeg", "win-x64", "ffmpeg.exe");

async function createFixtures(): Promise<{ paths: Record<string, string>; relocated: string; userData: string }> {
  const dir = join(root, "test-results", `stage1a-electron-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const video = join(dir, "clip.mp4");
  const audio = join(dir, "sound.wav");
  const image = join(dir, "still.png");
  const text = join(dir, "notes.txt");
  const relocated = join(dir, "relocated-clip.mp4");
  await copyFile(videoFixture, video);
  const generated = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000", "-t", "1", audio], { windowsHide: true });
  if (generated.status !== 0) throw new Error(`FFmpeg audio fixture failed: ${generated.stderr.toString()}`);
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await writeFile(text, "Stage 1A text fixture\n", "utf8");
  await copyFile(video, relocated);
  return { paths: { video, audio, image, text }, relocated, userData: join(dir, "user-data") };
}

async function atomicallyReplace(source: string, target: string): Promise<void> {
  const temporary = join(dirname(target), `.replacement-${process.pid}-${Date.now()}.mp4`);
  await copyFile(source, temporary);
  await rename(temporary, target);
}

test("真实 Electron 覆盖 Stage 1A 项目、四类素材和 availability 流程", async ({}, testInfo) => {
  test.setTimeout(180_000);
  if (!existsSync(videoFixture) || !existsSync(ffmpeg)) throw new Error("真实 E2E 夹具或 bundled FFmpeg 不存在");
  const fixtures = await createFixtures();
  const env = {
    ...process.env,
    AIVS_RESOURCES_PATH: resources,
    AIVS_E2E_ASSET_PATHS: JSON.stringify(fixtures.paths),
    AIVS_E2E_MEDIA_PATH: fixtures.paths.video,
    AIVS_E2E_RELOCATE_PATH: fixtures.relocated,
    AIVS_SIDECAR_EXECUTABLE: join(root, ".venv", "Scripts", "python.exe"),
    AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
    AIVS_E2E_SIDECAR_ARGV_EVIDENCE: join(fixtures.userData, "sidecar-argv.json"),
    PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_OPTIONS: undefined
  };
  const app = await electron.launch({
    args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${fixtures.userData}`],
    cwd: desktop,
    env
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByRole("tab", { name: "素材", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });

    await openProjectManagement(page);
    await page.getByLabel("新项目名称").fill("Stage 1A E2E");
    await page.getByRole("button", { name: "创建项目" }).click();
    await expectCurrentProject(page, "Stage 1A E2E");
    await openProjectManagement(page);
    await page.getByLabel("重命名项目").fill("Stage 1A Renamed");
    await page.getByRole("button", { name: "保存名称" }).click();
    await expect(page.locator(".project-current-name")).toContainText("Stage 1A Renamed");
    await page.getByRole("button", { name: "归档项目" }).click();
    await expect(page.locator(".project-current-name")).toContainText("已归档");
    await page.getByRole("button", { name: "重新打开项目" }).click();
    await expect(page.locator(".project-current-name")).toContainText("活动");
    await page.getByRole("button", { name: "关闭项目管理" }).click();

    // 左栏信息架构重构（f452d63）后：媒体导入按钮仅 视频/音频/图片；文本改为
    // 默认文本插入与字幕导入（notes.txt 夹具不再经导入文件对话框消费）。
    const expectedNames: Record<string, string> = { video: "clip.mp4", audio: "sound.wav", image: "still.png" };
    for (const kind of ["video", "audio", "image"]) {
      await page.getByRole("button", { name: kind === "video" ? "导入视频" : kind === "audio" ? "导入音频" : "导入图片" }).click();
      const assetRow = page.locator(".asset-row").filter({ hasText: expectedNames[kind] });
      await expect(assetRow).toBeVisible({ timeout: 30_000 });
      await expect(assetRow.locator(".asset-filename")).toHaveText(expectedNames[kind]);
    }
    const library = page.getByRole("region", { name: "媒体库" });
    const initialViewport = page.viewportSize();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 1024) {
        const handle = page.getByRole("separator", { name: "调整左侧面板宽度" });
        const bounds = await handle.boundingBox();
        if (!bounds) throw new Error("Left pane resize handle is missing");
        const x = bounds.x + bounds.width / 2;
        const y = bounds.y + 45;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x - 120, y);
        await page.mouse.up();
        await expect.poll(() => library.evaluate(element => element.clientWidth)).toBeLessThan(230);
      }
      await expect(library.locator(".asset-view-grid")).toBeVisible();
      expect(await library.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
      if (width === 1440) await page.screenshot({ path: testInfo.outputPath("asset-grid.png") });
      await library.getByRole("button", { name: "切换到列表视图" }).click();
      await expect(library.locator(".asset-view-list")).toBeVisible();
      if (width === 1024) await expect(library.locator(".asset-row-meta").first()).toBeHidden();
      const hasOverflow = await library.evaluate(element => element.scrollWidth > element.clientWidth);
      expect(hasOverflow).toBe(false);
      const first = library.locator(".asset-select").first();
      const last = library.locator(".asset-select").last();
      await first.focus();
      await first.press("End");
      await expect(last).toBeFocused();
      await expect(last).toHaveAttribute("aria-pressed", "true");
      await last.press("Shift+F10");
      const assetMenu = page.getByRole("menu");
      await expect(assetMenu.getByRole("menuitem", { name: /^删除 / })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(last).toBeFocused();
      if (width === 1440) await page.screenshot({ path: testInfo.outputPath("asset-list.png") });
      await library.getByRole("button", { name: "切换到网格视图" }).click();
    }
    if (initialViewport) await page.setViewportSize(initialViewport);
    let videoMediaUrl: string | null = null;
    await expect.poll(async () => {
      const assets = await page.evaluate(async () => {
        const projects = await window.desktop.listProjects({ limit: 100 });
        const project = projects.items.find(item => item.name === "Stage 1A Renamed");
        if (!project) throw new Error("E2E project was not found");
        const list = await window.desktop.listAssets({ project_id: project.project_id, limit: 100 });
        return list.items.map(item => ({ name: item.asset.display_name, media_url: item.media_url }));
      });
      const url = assets.find(item => item.name === "clip.mp4")?.media_url ?? null;
      videoMediaUrl = url;
      return url;
    }, { timeout: 15_000 }).toMatch(/^aivideo:\/\/media\/[A-Za-z0-9_-]{32,}$/);
    const mediaBytes = await page.evaluate(async url => (await fetch(url)).arrayBuffer().then(buffer => buffer.byteLength), videoMediaUrl!);
    expect(mediaBytes).toBeGreaterThan(0);
    await expect(page.getByRole("tab", { name: "任务" })).toBeVisible();

    const projectId = await page.evaluate(async () => {
      const page = await window.desktop.listProjects({ limit: 100 });
      const project = page.items.find(item => item.name === "Stage 1A Renamed");
      if (!project) throw new Error("E2E project was not found");
      return project.project_id;
    });
    const mediaSelection = await page.evaluate(() => window.desktop.chooseMedia());
    if (!mediaSelection) throw new Error("E2E media selection was cancelled");
    const createdJob = await page.evaluate(async input => window.desktop.createJob(input), {
      project_id: projectId,
      media_id: mediaSelection.media.media_id,
      kind: "proxy"
    });
    expect(createdJob.project_id).toBe(projectId);
    const projectJobs = await page.evaluate(input => window.desktop.listJobs({ project_id: input, limit: 100 }), projectId);
    expect(projectJobs.items.some(job => job.job_id === createdJob.job_id && job.project_id === projectId)).toBe(true);
    // 左栏四子标签重构后：任务列表在"任务"页签内。
    await page.getByRole("tab", { name: "任务" }).click();
    await expect(page.locator(".job-row").filter({ hasText: "代理素材" }).first()).toBeVisible({ timeout: 30_000 });

    const database = join(fixtures.userData, "data-v2", "app.db");
    const databaseCheck = spawnSync(join(root, ".venv", "Scripts", "python.exe"), ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); row=c.execute('select project_id from jobs where id=?',(sys.argv[2],)).fetchone(); print(row[0] if row else '')", database, createdJob.job_id], { encoding: "utf8", windowsHide: true });
    if (databaseCheck.status !== 0) throw new Error(`SQLite project_id check failed: ${databaseCheck.stderr}`);
    expect(databaseCheck.stdout.trim()).toBe(projectId);

    const videoRow = page.locator(".asset-row").filter({ hasText: "clip.mp4" });
    const refreshButton = page.getByRole("button", { name: "刷新素材库" });
    // 刷新控件在"素材"页签；上一步切换到了"任务"页签，先切回。
    await page.getByRole("tab", { name: "素材", exact: true }).click();
    // Use the same atomic-replacement operation as the Core availability
    // contract: a copy-over can retain an opened file's observed metadata.
    await atomicallyReplace(join(root, "test-assets", "generated", "short-odd-size.mp4"), fixtures.paths.video);
    await refreshButton.click();
    // 局部状态和全局公告同时反馈素材变化。
    await expect(page.locator(".notice").filter({ hasText: "已刷新素材库" })).toBeVisible({ timeout: 30_000 });
    await expect(videoRow.getByText("已变更", { exact: true })).toBeVisible();
    // Windows can keep the file open briefly while the thumbnail worker releases its handle.
    await expect.poll(async () => {
      try {
        await unlink(fixtures.paths.video);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EBUSY") return false;
        throw error;
      }
    }, { timeout: 10_000 }).toBe(true);
    // 素材未被时间线引用时，刷新会把本地文件已删除的素材清理出列表。
    await refreshButton.click();
    await expect(videoRow).toHaveCount(0, { timeout: 30_000 });

    const runtime = await page.evaluate(() => window.desktop.getRuntime());
    const rendererText = await page.locator("body").innerText();
    expect(runtime).not.toHaveProperty("ui_token");
    expect(runtime).not.toHaveProperty("base_url");
    expect(rendererText).not.toContain(fixtures.userData);
    expect(rendererText).not.toContain("AIVS_ADMIN_TOKEN");
    expect(rendererText).not.toContain("database_path");

    // Open a second project tab and populate the editor for whole-window review.
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    await page.getByLabel("新项目名称").fill("素材工作台");
    await page.getByLabel("新建项目画布比例").selectOption("169");
    await page.getByRole("button", { name: "创建项目" }).click();
    await expectCurrentProject(page, "素材工作台");
    await expect(page.getByRole("dialog", { name: "项目管理" })).toHaveCount(0);
    const projectTabs = page.getByRole("tablist", { name: "已打开的项目" });
    await expect(projectTabs.getByRole("tab")).toHaveCount(2);
    await projectTabs.getByRole("tab", { name: "素材工作台" }).press("ArrowLeft");
    await expectCurrentProject(page, "Stage 1A Renamed");
    await projectTabs.getByRole("tab", { name: "素材工作台" }).click();
    await expectCurrentProject(page, "素材工作台");
    await copyFile(process.env.AIVS_WORKSPACE_REVIEW_VIDEO || videoFixture, fixtures.paths.video);
    if (process.env.AIVS_WORKSPACE_REVIEW_IMAGE) {
      const png = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", process.env.AIVS_WORKSPACE_REVIEW_IMAGE,
        "-frames:v", "1", fixtures.paths.image], { windowsHide: true });
      if (png.status !== 0) throw new Error(`Review image conversion failed: ${png.stderr.toString()}`);
    }
    if (process.env.AIVS_WORKSPACE_REVIEW_AUDIO) {
      const wav = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", process.env.AIVS_WORKSPACE_REVIEW_AUDIO,
        "-c:a", "pcm_s16le", fixtures.paths.audio], { windowsHide: true });
      if (wav.status !== 0) throw new Error(`Review audio conversion failed: ${wav.stderr.toString()}`);
    }
    for (const kind of ["视频", "音频", "图片"]) {
      await page.getByRole("button", { name: `导入${kind}` }).click();
    }
    const video = library.getByRole("button", { name: "clip.mp4，视频" });
    const audio = library.getByRole("button", { name: "sound.wav，音频" });
    const image = library.getByRole("button", { name: "still.png，图片" });
    await video.locator(".asset-filename").click();
    await audio.locator(".asset-filename").click({ modifiers: ["Control"] });
    await expect(video).toHaveAttribute("aria-pressed", "true");
    await expect(audio).toHaveAttribute("aria-pressed", "true");
    await expect(image).toBeVisible();
    const orderedAssets = library.locator(".asset-select .asset-filename");
    await orderedAssets.first().click();
    await orderedAssets.last().click({ modifiers: ["Shift"] });
    await expect(library.locator('.asset-select[aria-pressed="true"]')).toHaveCount(3);
    await expect(page.getByRole("region", { name: "素材属性" }).getByText("已选 3 项素材")).toBeVisible();
    await video.locator(".asset-filename").click({ button: "right" });
    await page.getByRole("menuitem", { name: "收藏素材" }).click();
    const categories = library.getByRole("navigation", { name: "素材分类" });
    await categories.getByRole("button", { name: "收藏" }).click();
    await expect(library.locator(".asset-select")).toHaveCount(1);
    await expect(video).toBeVisible();
    await categories.getByRole("button", { name: "导入" }).click();
    await expect(library.locator(".asset-select")).toHaveCount(3);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "界面", exact: true }).click();
    await page.getByRole("menuitem", { name: "恢复默认布局" }).click();
    const divider = await page.getByRole("separator", { name: "调整时间线高度" }).boundingBox();
    if (!divider) throw new Error("Timeline divider is unavailable");
    const dividerX = divider.x + divider.width / 2;
    const dividerY = divider.y + divider.height / 2;
    await page.mouse.move(dividerX, dividerY);
    await page.mouse.down();
    await page.mouse.move(dividerX, dividerY - 110);
    await page.mouse.up();
    const dropAsset = (name: string, track: string, x: number) => page.evaluate(({ name, track, x }) => {
      const asset = [...document.querySelectorAll<HTMLButtonElement>(".asset-select")].find(button => button.title === name);
      const canvas = document.querySelector('canvas[aria-label="时间线画布"]');
      const row = [...document.querySelectorAll<HTMLElement>(".timeline-track-head")].find(head => head.dataset.trackId === track);
      if (!asset || !canvas) throw new Error(`Missing asset ${name} or timeline canvas`);
      const rect = canvas.getBoundingClientRect();
      const lane = row?.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      asset.closest(".asset-row")?.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
      const args = { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + x,
        clientY: lane ? lane.top + lane.height / 2 : rect.top + Math.min(112, rect.height - 8) };
      canvas.dispatchEvent(new DragEvent("dragover", args));
      canvas.dispatchEvent(new DragEvent("drop", args));
    }, { name, track, x });
    await video.locator(".asset-filename").click();
    await audio.locator(".asset-filename").click({ modifiers: ["Control"] });
    await dropAsset("clip.mp4", "V1", 50);
    const timelineClips = page.locator(".timeline-a11y-clips button");
    await expect(timelineClips).toHaveCount(2);
    const timelineBar = page.locator(".timeline-toolbar");
    await timelineBar.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(timelineClips).toHaveCount(0);
    await timelineBar.getByRole("button", { name: "重做", exact: true }).click();
    await expect(timelineClips).toHaveCount(2);
    await dropAsset("still.png", "C1", 50);
    await expect(timelineClips).toHaveCount(3);
    await expect(page.locator('.timeline-track-head[data-track-id="V2"]')).toBeVisible();
    const clip = page.getByRole("button", { name: /^Clip \d+ image/ });
    await clip.press("Enter");
    await expect(page.getByRole("group", { name: "片段属性" })).toBeVisible();
    await expect(page.getByText("位置与大小", { exact: true })).toBeVisible();
    const reviewProjectId = await page.evaluate(async () => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const p = projects.items.find(item => item.name === "素材工作台");
      if (!p) throw new Error("Review project was not found");
      return p.project_id;
    });
    const readOverlay = () => page.evaluate(async id => {
      const state = await window.desktop.getTimeline(id);
      const layers = state.current_revision.document.clips;
      const overlay = layers.find(item => item.track_id === "V2");
      return { tracks: layers.map(item => item.track_id).sort(), transform: overlay?.transform };
    }, reviewProjectId);
    const saveTimeout = { timeout: 25_000 };
    const widthField = page.getByRole("textbox", { name: "宽度（相对舞台）" });
    await widthField.fill("40");
    await widthField.press("Enter");
    await expect.poll(readOverlay, saveTimeout).toMatchObject({ transform: { scale: 0.4 } });
    const alignment = page.getByRole("group", { name: "画面对齐" });
    await alignment.getByRole("button", { name: "右对齐" }).click();
    await expect.poll(async () => (await readOverlay())?.transform?.x ?? 0, saveTimeout).toBeGreaterThan(0.5);
    await alignment.getByRole("button", { name: "顶对齐" }).click();
    await expect.poll(readOverlay, saveTimeout).toMatchObject({ tracks: ["A1", "V1", "V2"], transform: { scale: 0.4 } });
    await expect.poll(async () => (await readOverlay())?.transform?.y ?? 1, saveTimeout).toBeCloseTo(0.2, 2);
    await expect(page.getByRole("textbox", { name: "位置 X" })).not.toHaveValue("0");
    await expect(page.getByRole("textbox", { name: "位置 Y" })).not.toHaveValue("0");
    await expect(page.locator(".synthetic-preview canvas").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".synthetic-buffering")).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => {
      const canvas = document.querySelector(".synthetic-preview canvas")?.getBoundingClientRect();
      const outline = document.querySelector(".synthetic-preview .sp-box.selected")?.getBoundingClientRect();
      return Boolean(canvas && outline && Math.abs(outline.right - canvas.right) < 5 && Math.abs(outline.top - canvas.top) < 5);
    }), saveTimeout).toBe(true);
    await page.mouse.move(750, 50);
    await page.screenshot({ path: testInfo.outputPath("openfilm-alignment-grid.png") });
    await library.getByRole("button", { name: "切换到列表视图" }).click();
    const timelineCanvas = page.locator('canvas[aria-label="时间线画布"]');
    const canvasBounds = await timelineCanvas.boundingBox();
    const laneBounds = await page.locator('.timeline-track-head[data-track-id="V1"]').boundingBox();
    if (!canvasBounds || !laneBounds) throw new Error("Main track geometry is missing");
    await timelineCanvas.click({
      modifiers: ["Shift"],
      position: { x: laneBounds.width + 18, y: laneBounds.y + laneBounds.height / 2 - canvasBounds.y },
    });
    const group = page.getByRole("region", { name: "多片段属性" });
    await expect(group.getByText("已选 2 个片段")).toBeVisible();
    await group.getByRole("button", { name: "左对齐" }).click();
    await expect.poll(async () => (await readOverlay())?.transform?.x ?? 1, saveTimeout).toBeLessThan(0.5);
    // Seek off the paused old frame so this capture shows the newly composed result.
    await page.getByRole("slider", { name: "时间线播放头" }).press("ArrowRight");
    await expect(page.locator(".synthetic-preview canvas").first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => {
      const canvas = document.querySelector(".synthetic-preview canvas")?.getBoundingClientRect();
      const boxes = [...document.querySelectorAll(".synthetic-preview .sp-box.selected")].map(box => box.getBoundingClientRect());
      const overlay = boxes.sort((a, b) => a.width - b.width)[0];
      return Boolean(canvas && boxes.length === 2 && overlay && Math.abs(overlay.left - canvas.left) < 5);
    }), saveTimeout).toBe(true);
    await page.mouse.move(750, 50);
    await page.screenshot({ path: testInfo.outputPath("openfilm-alignment-list.png") });
    // Distribution acceptance: endpoints use the same still image, so their display bounds match.
    await image.locator(".asset-filename").click();
    await dropAsset("still.png", "C1", 50);
    await expect(timelineClips).toHaveCount(4);
    await expect(page.locator('.timeline-track-head[data-track-id="V3"]')).toBeVisible();
    const distributionIds = await page.evaluate(async id => {
      const state = await window.desktop.getTimeline(id);
      const clips = state.current_revision.document.clips;
      return {
        first: clips.find(item => item.track_id === "V2")!.clip_id,
        middle: clips.find(item => item.track_id === "V1")!.clip_id,
        last: clips.find(item => item.track_id === "V3")!.clip_id,
      };
    }, reviewProjectId);
    const distributionTargets = [distributionIds.first, distributionIds.middle, distributionIds.last];
    await page.evaluate(async ({ id, ids }) => {
      const state = await window.desktop.getTimeline(id);
      const positions = [{ x: 0.18, y: 0.23 }, { x: 0.38, y: 0.4 }, { x: 0.82, y: 0.77 }];
      const operations = ids.map((clip_id, index) => ({
        op: "set_clip_transform" as const,
        clip_id,
        transform: { scale: 0.24, ...positions[index] },
      }));
      await window.desktop.patchTimeline({ project_id: id, patch: { schema_version: 1, base_revision_id: state.current_revision.timeline_revision_id, operations, summary: "等距分布 E2E 初始布局" } });
    }, { id: reviewProjectId, ids: distributionTargets });
    const distributionState = () => page.evaluate(async ({ id, ids }) => {
      const state = await window.desktop.getTimeline(id);
      return ids.map(clip_id => state.current_revision.document.clips.find(item => item.clip_id === clip_id)?.transform);
    }, { id: reviewProjectId, ids: distributionTargets });
    const selectThree = async (count = 3) => {
      const canvas = page.locator('canvas[aria-label="时间线画布"]');
      const bounds = await canvas.boundingBox();
      if (!bounds) throw new Error("Distribution selection canvas is missing");
      for (const [index, track] of ["V2", "V1", "V3"].slice(0, count).entries()) {
        const lane = await page.locator(`.timeline-track-head[data-track-id="${track}"]`).boundingBox();
        if (!lane) throw new Error(`Distribution track ${track} is not visible`);
        await canvas.click({ ...(index ? { modifiers: ["Shift"] as const } : {}), position: { x: lane.width + 18, y: lane.y + lane.height / 2 - bounds.y } });
        if (index === 0) await expect(page.getByRole("textbox", { name: "宽度（相对舞台）" })).toHaveValue("24");
      }
    };
    await selectThree();
    const distributionGroup = page.getByRole("region", { name: "多片段属性" });
    await expect(distributionGroup.getByText("已选 3 个片段")).toBeVisible();
    await selectThree(2);
    const twoClipGroup = page.getByRole("region", { name: "多片段属性" });
    await expect(twoClipGroup.getByText("已选 2 个片段")).toBeVisible();
    await expect(twoClipGroup.getByRole("button", { name: "水平等距分布" })).toHaveCount(0);
    await expect(twoClipGroup.getByRole("button", { name: "垂直等距分布" })).toHaveCount(0);
    await selectThree();
    await expect(distributionGroup.getByRole("button", { name: "水平等距分布" })).toBeVisible();
    await expect(distributionGroup.getByRole("button", { name: "垂直等距分布" })).toBeVisible();
    await distributionGroup.getByRole("button", { name: "水平等距分布" }).click();
    await expect.poll(async () => {
      const [first, middle, last] = await distributionState();
      return Boolean(first && middle && last && Math.abs(middle.x - 0.5) < 0.005 && first.x === 0.18 && last.x === 0.82 && [first, middle, last].every(item => item.y === 0.23 || item.y === 0.4 || item.y === 0.77));
    }, saveTimeout).toBe(true);
    await selectThree();
    await distributionGroup.getByRole("button", { name: "垂直等距分布" }).click();
    await expect.poll(async () => {
      const [first, middle, last] = await distributionState();
      return Boolean(first && middle && last && Math.abs(middle.y - 0.5) < 0.005 && first.y === 0.23 && last.y === 0.77 && first.x === 0.18 && Math.abs(middle.x - 0.5) < 0.005 && last.x === 0.82);
    }, saveTimeout).toBe(true);
    await page.getByRole("slider", { name: "时间线播放头" }).press("ArrowRight");
    await expect(page.locator(".synthetic-preview canvas").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".synthetic-loading")).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => page.locator(".synthetic-preview .sp-box.selected").count(), saveTimeout).toBe(3);
    await page.mouse.move(750, 50);
    await page.screenshot({ path: testInfo.outputPath("openfilm-distribution.png") });
    // Keep a stable, easy-to-review full-window artifact beside this run's real media fixtures.
    await page.screenshot({ path: join(dirname(fixtures.paths.video), "openfilm-main-ui.png") });
    const groupX = distributionGroup.getByRole("textbox", { name: "选区 X" });
    const groupY = distributionGroup.getByRole("textbox", { name: "选区 Y" });
    const groupWidth = distributionGroup.getByRole("textbox", { name: "选区宽度" });
    const groupHeight = distributionGroup.getByRole("textbox", { name: "选区高度" });
    const initialGroupX = Number(await groupX.inputValue());
    const initialGroupY = Number(await groupY.inputValue());
    const initialGroupWidth = Number(await groupWidth.inputValue());
    const initialGroupHeight = Number(await groupHeight.inputValue());
    await groupX.fill(String(initialGroupX + 48));
    await groupX.press("Enter");
    await expect.poll(async () => (await distributionState())[0]?.x, saveTimeout).toBeCloseTo(0.23, 3);
    await groupY.fill(String(initialGroupY + 27));
    await groupY.press("Enter");
    await expect.poll(async () => (await distributionState())[0]?.y, saveTimeout).toBeCloseTo(0.28, 3);
    await groupWidth.fill(String(initialGroupWidth * 0.8));
    await groupWidth.press("Enter");
    await expect.poll(async () =>
      (await distributionState()).every(clip => Math.abs((clip?.scale ?? 0) - 0.192) < 0.001), saveTimeout).toBe(true);
    await expect.poll(async () => Number(await groupHeight.inputValue()), saveTimeout).toBeCloseTo(initialGroupHeight * 0.8, 0);
    await expect.poll(async () => Number(await groupX.inputValue()), saveTimeout).toBeCloseTo(initialGroupX + 48, 0);
    await timelineBar.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await distributionState()).every(clip => clip?.scale === 0.24), saveTimeout).toBe(true);
    await timelineBar.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await distributionState()).every(clip => Math.abs((clip?.scale ?? 0) - 0.192) < 0.001), saveTimeout).toBe(true);
    await page.getByRole("slider", { name: "时间线播放头" }).press("ArrowRight");
    await expect.poll(() => page.locator(".synthetic-preview .sp-box.selected").count(), saveTimeout).toBe(3);
    await page.mouse.move(750, 50);
    await page.screenshot({ path: testInfo.outputPath("openfilm-group-bounds.png") });
    const timelineToolbar = page.locator(".timeline-toolbar");
    await timelineToolbar.getByRole("button", { name: "添加标记" }).click();
    await expect(page.getByRole("group", { name: "时间线标记" })).toBeVisible();
    await page.getByRole("textbox", { name: "标记备注" }).fill("复核");
    await page.getByRole("textbox", { name: "标记备注" }).press("Enter");
    await expect(page.getByRole("button", { name: /标记 复核/ })).toBeVisible();
    const rangeButton = timelineToolbar.getByRole("button", { name: "时间区间" });
    await rangeButton.click();
    await page.getByRole("menuitem", { name: "设为区间入点" }).click();
    const rangeStart = page.getByRole("slider", { name: "时间区间入点" });
    await expect(rangeStart).toBeVisible();
    const before = Number(await rangeStart.getAttribute("aria-valuenow"));
    await rangeStart.press("ArrowRight");
    await expect.poll(async () => Number(await rangeStart.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
    await rangeButton.click();
    await page.getByRole("menuitem", { name: "清除时间区间" }).click();
    await expect(rangeStart).toHaveCount(0);
    const rangePlayhead = page.getByRole("slider", { name: "时间线播放头" });
    await rangePlayhead.press("End");
    for (let n = 0; n < 50; n += 1) await rangePlayhead.press("ArrowLeft");
    await rangePlayhead.press("i");
    for (let n = 0; n < 20; n += 1) await rangePlayhead.press("ArrowRight");
    await rangePlayhead.press("o");
    await page.getByRole("button", { name: "播放设置" }).click();
    await page.getByRole("switch", { name: "循环播放" }).click();
    await page.getByRole("button", { name: "播放设置" }).click();
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await page.waitForFunction(() => {
      const slider = document.querySelector('[role="slider"][aria-label="时间线播放头"]');
      const value = Number(slider?.getAttribute("aria-valuenow"));
      const state = window as typeof window & { __testLoopLast?: number; __testLoopSawForward?: boolean };
      if (state.__testLoopLast !== undefined && value > state.__testLoopLast + 30_000) state.__testLoopSawForward = true;
      const looped = Boolean(state.__testLoopSawForward && state.__testLoopLast !== undefined && value < state.__testLoopLast - 100_000);
      state.__testLoopLast = value;
      return looped;
    }, undefined, { timeout: 15_000 });
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await page.getByRole("button", { name: "播放设置" }).click();
    await page.getByRole("switch", { name: "循环播放" }).click();
    await page.getByRole("button", { name: "播放设置" }).click();
    await rangeButton.click();
    await page.getByRole("menuitem", { name: "清除时间区间" }).click();
    const mainClip = page.getByRole("button", { name: /^Clip \d+ video/ });
    await mainClip.press("Enter");
    const playhead = page.getByRole("slider", { name: "时间线播放头" });
    await playhead.press("End");
    for (let n = 0; n < 35; n += 1) await playhead.press("ArrowLeft");
    const split = timelineToolbar.getByRole("button", { name: "拆分片段" });
    await expect(split).toBeEnabled();
    await split.click();
    await expect(timelineClips).toHaveCount(5);
    const linkedVideo = page.getByRole("button", { name: /^Clip \d+ video/ }).first();
    const linkedAudio = page.getByRole("button", { name: /^Clip \d+ audio/ }).first();
    await linkedVideo.press("Enter");
    await linkedAudio.press("Shift+Enter");
    const link = timelineToolbar.getByRole("button", { name: "链接片段" });
    await expect(link).toBeEnabled();
    await link.click();
    const unlinkButton = timelineToolbar.getByRole("button", { name: "取消片段链接" });
    await expect(unlinkButton).toBeEnabled();
    await unlinkButton.click();
    await expect(unlinkButton).toBeDisabled();
    await linkedVideo.press("Enter");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.screenshot({ path: testInfo.outputPath("openfilm-timeline.png") });
    await page.locator('.timeline-track-head[data-track-id="V2"]').click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "删除轨道" })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("openfilm-track-menu.png") });
    await page.keyboard.press("Escape");
    const rippleCanvas = page.locator('canvas[aria-label="时间线画布"]');
    const canvasBox = await rippleCanvas.boundingBox();
    const mainLane = await page.locator('.timeline-track-head[data-track-id="V1"]').boundingBox();
    if (!canvasBox || !mainLane) throw new Error("Main timeline lane is not visible");
    await rippleCanvas.click({ button: "right", position: { x: mainLane.width + 18, y: mainLane.y + mainLane.height / 2 - canvasBox.y } });
    await page.getByRole("menuitem", { name: "主轨波纹删除" }).click();
    await expect(timelineClips).toHaveCount(2);
    await timelineToolbar.getByRole("button", { name: "撤销" }).click();
    await expect(timelineClips).toHaveCount(5);
    const atomicSwap = await page.evaluate(async id => {
      const before = await window.desktop.getTimeline(id);
      const [left, right] = before.current_revision.document.clips.filter(item => item.track_id === "V1")
        .sort((a, b) => a.timeline_start_us - b.timeline_start_us);
      if (!left || !right) throw new Error("Atomic swap requires two main-track clips");
      const after = await window.desktop.patchTimeline({ project_id: id, patch: {
        schema_version: 1, base_revision_id: before.current_revision.timeline_revision_id,
        operations: [{ op: "position_clips", placements: [
          { clip_id: left.clip_id, timeline_start_us: right.timeline_end_us - right.timeline_start_us },
          { clip_id: right.clip_id, timeline_start_us: 0 },
        ] }], summary: "原子交换实机验收",
      } });
      return after.current_revision.document.clips.find(item => item.clip_id === right.clip_id)?.timeline_start_us;
    }, reviewProjectId);
    expect(atomicSwap).toBe(0);
    await projectTabs.getByRole("button", { name: "关闭项目标签 素材工作台" }).click();
    await expect(projectTabs.getByRole("tab")).toHaveCount(1);
    await expectCurrentProject(page, "Stage 1A Renamed");
  } finally {
    await app.close();
  }
});
