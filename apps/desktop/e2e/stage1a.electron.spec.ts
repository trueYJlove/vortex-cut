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

test("真实 Electron 覆盖 Stage 1A 项目、四类素材和 availability 流程", async () => {
  test.setTimeout(120_000);
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
      await expect(assetRow.locator(".asset-name strong")).toHaveText(expectedNames[kind]);
    }
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
    await expect(page.locator(".job-row").filter({ hasText: "代理素材" })).toBeVisible({ timeout: 30_000 });

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
    // 左栏重构后 list 行不再渲染 availability 角标（f452d63）；刷新结果经
    // 全局 notice（role=alert）呈现，据此断言 availability 流转。
    await expect(page.locator(".notice").filter({ hasText: "已刷新素材库" })).toBeVisible({ timeout: 30_000 });
    await unlink(fixtures.paths.video);
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
  } finally {
    await app.close();
  }
});
