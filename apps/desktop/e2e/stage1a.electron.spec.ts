import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

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

test("真实 Electron 覆盖 Stage 1A 项目、四类素材和 availability 流程", async () => {
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
    PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_OPTIONS: undefined
  };
  const app = await electron.launch({
    args: [join(desktop, "out", "main", "index.js"), `--user-data-dir=${fixtures.userData}`],
    cwd: desktop,
    env
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "素材工作区" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Core 已连接")).toBeVisible({ timeout: 30_000 });

    await page.getByLabel("项目名称").fill("Stage 1A E2E");
    await page.getByRole("button", { name: "创建" }).click();
    await expect(page.getByRole("heading", { name: "Stage 1A E2E" })).toBeVisible();
    await page.getByLabel("重命名项目").fill("Stage 1A Renamed");
    await page.getByRole("button", { name: "重命名" }).click();
    await expect(page.getByRole("heading", { name: "Stage 1A Renamed" })).toBeVisible();
    await page.getByRole("button", { name: "归档" }).click();
    await expect(page.locator(".project-state.archived")).toBeVisible();
    await page.getByRole("button", { name: "重新打开" }).click();
    await expect(page.locator(".project-state.active")).toBeVisible();

    const expectedNames: Record<string, string> = { video: "clip.mp4", audio: "sound.wav", image: "still.png", text: "notes.txt" };
    for (const kind of ["video", "audio", "image", "text"]) {
      await page.getByRole("button", { name: `导入${kind}` }).click();
      await expect(page.getByText(expectedNames[kind])).toBeVisible({ timeout: 30_000 });
    }
    await expect(page.getByText("aivideo://asset/").first()).toBeVisible();
    const textMediaUrl = await page.locator(".asset-row").filter({ hasText: "notes.txt" }).locator(".asset-name small").innerText();
    await expect.poll(async () => page.evaluate(async url => (await fetch(url)).text(), textMediaUrl)).toContain("Stage 1A text fixture");
    await expect(page.getByRole("heading", { name: "任务" })).toBeVisible();

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
    await expect(page.locator(".job-row").filter({ hasText: "代理素材" })).toBeVisible({ timeout: 30_000 });

    const database = join(fixtures.userData, "data-v2", "app.db");
    const databaseCheck = spawnSync(join(root, ".venv", "Scripts", "python.exe"), ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); row=c.execute('select project_id from jobs where id=?',(sys.argv[2],)).fetchone(); print(row[0] if row else '')", database, createdJob.job_id], { encoding: "utf8", windowsHide: true });
    if (databaseCheck.status !== 0) throw new Error(`SQLite project_id check failed: ${databaseCheck.stderr}`);
    expect(databaseCheck.stdout.trim()).toBe(projectId);

    const videoRow = page.locator(".asset-row").filter({ hasText: "clip.mp4" });
    await copyFile(join(root, "test-assets", "generated", "short-odd-size.mp4"), fixtures.paths.video);
    await videoRow.getByRole("button", { name: "刷新" }).click();
    await expect(videoRow.getByText("已变更")).toBeVisible();
    await unlink(fixtures.paths.video);
    await videoRow.getByRole("button", { name: "刷新" }).click();
    await expect(videoRow.getByText("缺失")).toBeVisible();
    await videoRow.getByRole("button", { name: "重新定位" }).click();
    await expect(videoRow.getByText("可用")).toBeVisible();

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
