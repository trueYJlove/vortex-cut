/**
 * W2.1 机位同步 —— 真机 e2e（真实 Electron + 真实 Core + 真实 ffmpeg 互相关）。
 *
 * 覆盖：工具菜单入口 → 面板建组 → 触发同步（作业 + 轮询对账）→ 偏移表如实展示
 *       → 人工偏移（与自动并列）。素材为同一段 pink noise 音频的两个"机位"，
 *       成员侧用 adelay 人为平移 687ms ⇒ 断言面板显示 +687.0 ms。
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as {
  _electron: { launch: (options: Record<string, unknown>) => Promise<any> };
};
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../../..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");
const ffmpeg = join(resources, "ffmpeg", "win-x64", "ffmpeg.exe");
const pythonSidecar = join(root, ".venv", "Scripts", "python.exe");
const OFFSET_MS = 687;

function buildCameras(dir: string): { a: string; b: string } {
  const audio = join(dir, "audio.wav");
  const a = join(dir, "camA.mp4");
  const b = join(dir, "camB.mp4");
  execFileSync(ffmpeg, ["-hide_banner", "-nostdin", "-y", "-f", "lavfi",
    "-i", "anoisesrc=color=pink:seed=42:duration=20:sample_rate=48000",
    "-ac", "1", "-c:a", "pcm_s16le", audio], { stdio: "pipe" });
  execFileSync(ffmpeg, ["-hide_banner", "-nostdin", "-y", "-f", "lavfi",
    "-i", "color=c=black:s=320x180:r=30:d=20", "-i", audio,
    "-map", "0:v", "-map", "1:a", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", a], { stdio: "pipe" });
  execFileSync(ffmpeg, ["-hide_banner", "-nostdin", "-y", "-f", "lavfi",
    "-i", "color=c=black:s=320x180:r=30:d=20", "-i", audio,
    "-map", "0:v", "-map", "1:a", "-af", "adelay=" + OFFSET_MS,
    "-c:v", "mpeg4", "-c:a", "aac", "-b:a", "192k", b], { stdio: "pipe" });
  return { a, b };
}

async function ensureProject(page: Page, name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await page.locator(".titlebar-project-name").innerText().catch(() => "")) === name) return;
    await page.getByRole("button", { name: "切换项目" }).click().catch(() => undefined);
    const option = page.locator(".project-switcher-dropdown").getByRole("option").filter({ hasText: name }).first();
    if (await option.count().catch(() => 0)) { await option.click().catch(() => undefined); await page.waitForTimeout(500); }
    else { await page.keyboard.press("Escape").catch(() => undefined); await page.waitForTimeout(1_000); }
  }
  throw new Error("未能切换到项目：" + name);
}

test("W2.1 机位同步：真机面板全链路（建组 → 同步 → 偏移表 → 人工偏移）", async () => {
  test.setTimeout(900_000);
  const run = join(root, "test-results", "angle-sync-evidence", "run-" + process.pid + "-" + Date.now());
  await mkdir(run, { recursive: true });
  const cameras = buildCameras(run);
  const projectName = "机位同步 E2E " + Date.now();

  const app = await electron.launch({
    args: [join(desktop, "out", "main", "index.cjs"), "--user-data-dir=" + join(run, "user-data")],
    cwd: desktop,
    env: {
      ...process.env,
      AIVS_RESOURCES_PATH: resources,
      AIVS_E2E_ASSET_PATHS_LIST: JSON.stringify({ "camA.mp4": cameras.a, "camB.mp4": cameras.b }),
      AIVS_SIDECAR_EXECUTABLE: pythonSidecar,
      AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
      PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
      ELECTRON_RUN_AS_NODE: undefined,
      NODE_OPTIONS: undefined
    }
  });
  try {
    const page: Page = await app.firstWindow();
    await page.waitForFunction(() => Boolean((window as any).desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 60_000 });

    await page.evaluate(async (name: string) => {
      const project = await window.desktop.createProject({ name });
      for (const fixture of ["camA.mp4", "camB.mp4"]) {
        const imported = await window.desktop.importAssetByFixture({
          project_id: project.project_id, fixture_file: fixture
        });
        if (!imported) throw new Error(fixture + " 导入被取消");
      }
    }, projectName);
    await page.reload();
    await page.waitForFunction(() => Boolean((window as any).desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 60_000 });
    await ensureProject(page, projectName);

    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "机位同步" }).click();
    const dialog = page.getByRole("dialog", { name: "机位同步" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // 显式把参考机位钉在 camA（未延时的一路）——面板默认参考取素材列表顺序，
    // 顺那次序会落到 camB 上，则正确结果是 −687ms（符号随参考选择翻转）。
    await dialog.getByLabel("参考机位").selectOption({ label: "camA.mp4" });
    await dialog.getByRole("button", { name: "建组并同步" }).click();
    // 轮询对账把 queued/running 推到 ready
    await expect(dialog.getByText("已就绪").first()).toBeVisible({ timeout: 180_000 });
    await expect(dialog.getByText(/\+687\.0 ms/)).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: join(run, "angle-sync-ready.png"), fullPage: true });

    const manualInput = dialog.getByLabel(/手填偏移/).nth(1);
    await manualInput.fill("-253");
    await dialog.getByRole("button", { name: "保存" }).nth(1).click();
    await expect(dialog.getByText("-253.0 ms")).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("人工").first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(run, "angle-sync-manual.png"), fullPage: true });

    if (!existsSync(join(run, "angle-sync-manual.png"))) throw new Error("截图未生成");
  } finally {
    await app.close().catch(() => undefined);
  }
});
