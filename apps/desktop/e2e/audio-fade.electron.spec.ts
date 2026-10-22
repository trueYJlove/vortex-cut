/**
 * 音频淡变 —— 真机 e2e（真实 Electron + 真实 Core + 真实 ffmpeg 导出与测量）。
 *
 * 这条 spec 的价值在「同一个真实进程里把面板与导出链连起来」：
 *   1. 从**属性面板的「淡入时长」滑块**设淡入（不是 API 直调——那是单测已覆盖的层）；
 *   2. 走**真实导出链**产出 mp4；
 *   3. 解出导出文件的 PCM，比较「首 50ms」与「中段」的 RMS；
 *   4. 把淡入拖回 0 再导一次，断言首/中比值接近 1。
 *
 * 第 4 步是区分力所在：只做第 3 步，「导出恒带淡入」或「导出恒静音」都会绿。
 *
 * 素材：test-assets/generated/cfr-landscape-av.mp4（3s，h264 + aac 单声道；实测前 2.5s
 *       RMS 平稳在 -21.1dB）。平稳性是这条 spec 的前提：中段与首段除了淡变之外没有别的差异。
 *
 * 负向对照（实跑记录见交付说明）：
 *   让 rendering/ffmpeg.py 的 _fade_chain 恒返回 ""（导出侧不再生成 afade）
 *   ⇒ 两次导出的首/中比值都约为 1 ⇒ 本 spec 红；恢复 ⇒ 绿。
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const python = join(root, ".venv", "Scripts", "python.exe");

const RATE = 48_000;
const WINDOW = Math.round(RATE * 0.05); // 50ms

/** 解出单声道 s16le PCM，量首 50ms 与中段的 RMS（dB）。 */
function rmsProfile(path: string): { firstDb: number; midDb: number; ratio: number; samples: number } {
  const pcm = execFileSync(ffmpeg, [
    "-v", "error", "-nostdin", "-i", path,
    "-vn", "-f", "s16le", "-ac", "1", "-ar", String(RATE), "-"
  ], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
  const total = Math.floor(pcm.length / 2);
  if (total < WINDOW * 4) throw new Error("导出音频过短（" + total + " 采样），无法比较首段与中段");
  const rms = (from: number, to: number) => {
    let sum = 0; let count = 0;
    for (let i = from; i < Math.min(to, total); i += 1) {
      const value = pcm.readInt16LE(i * 2) / 32768;
      sum += value * value; count += 1;
    }
    return Math.sqrt(sum / Math.max(1, count));
  };
  const db = (value: number) => 20 * Math.log10(value || 1e-9);
  const first = rms(0, WINDOW);
  const mid = rms(Math.floor(total / 2), Math.floor(total / 2) + WINDOW);
  return { firstDb: db(first), midDb: db(mid), ratio: first / mid, samples: total };
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

async function waitForJob(page: Page, jobId: string, timeoutMs = 300_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await page.evaluate((id: string) => window.desktop.getJob(id as never), jobId);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return job;
    await page.waitForTimeout(1_000);
  }
  throw new Error("job " + jobId + " 未在超时内到达终态");
}

/**
 * 真实导出链：chooseExportDestination 在 AIVS_E2E_EXPORT_PATH 存在时返回该固定路径，
 * 再用 renameExportDestination 改成本次要的文件名（同目录、目标不存在 ⇒ 无需覆盖授权）。
 */
async function exportAs(page: Page, projectId: string, fileName: string, expectedPath: string): Promise<any> {
  const started = await page.evaluate(async (input: { pid: string; name: string }) => {
    const grant = await window.desktop.chooseExportDestination(input.pid as never);
    if (!grant) throw new Error("未取得导出目标授权");
    const renamed = await window.desktop.renameExportDestination({ grant_id: grant.destination_grant_id, file_name: input.name });
    const state = await window.desktop.getTimeline(input.pid as never);
    const created = await window.desktop.createExport({
      project_id: input.pid as never,
      export: {
        timeline_revision_id: state.current_revision.timeline_revision_id,
        destination_grant_id: renamed.destination_grant_id,
        encoder_mode: "software"
      }
    });
    return { job_id: created.job.job_id };
  }, { pid: projectId, name: fileName });
  const job = await waitForJob(page, started.job_id);
  if (job.status !== "succeeded") throw new Error("导出作业未成功：" + JSON.stringify(job).slice(0, 500));
  await expect.poll(async () => existsSync(expectedPath), { timeout: 60_000 }).toBe(true);
  const info = await stat(expectedPath);
  expect(info.size).toBeGreaterThan(0);
  return job;
}

/** 读取正式 Timeline 里主视频片段的 fade_in_us（读回文档，不读 UI 文案）。 */
async function readFadeInUs(page: Page, projectId: string): Promise<number> {
  return page.evaluate(async (pid: string) => {
    const state = await window.desktop.getTimeline(pid as never);
    const clip = state.current_revision.document.clips.find((c: any) => c.track_id === "V1" && c.asset_kind === "video");
    return Number(clip?.audio?.fade_in_us ?? 0);
  }, projectId);
}

test("音频淡变：面板设淡入 → 真实导出 → 首/中 RMS 比 → 淡入归零复测接近 1", async () => {
  test.setTimeout(900_000);
  const run = join(root, "test-results", "audio-fade-evidence", "run-" + process.pid + "-" + Date.now());
  await mkdir(run, { recursive: true });
  const userData = join(run, "user-data");
  const sourceAsset = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
  const configuredExport = join(run, "export.mp4"); // AIVS_E2E_EXPORT_PATH 指向它
  const fadeExport = join(run, "fade-export.mp4");
  const plainExport = join(run, "plain-export.mp4");
  if (!existsSync(sourceAsset)) throw new Error("缺少夹具：" + sourceAsset);

  // 前提校验：素材源本身首段与中段平稳（否则比值没有解释力）。
  const sourceProfile = rmsProfile(sourceAsset);
  expect(sourceProfile.samples).toBeGreaterThan(RATE);
  expect(sourceProfile.firstDb).toBeGreaterThan(-30);
  expect(Math.abs(sourceProfile.firstDb - sourceProfile.midDb)).toBeLessThan(1.0);

  const projectName = "音频淡变 E2E " + Date.now();
  const app = await electron.launch({
    args: [join(desktop, "out", "main", "index.cjs"), "--user-data-dir=" + userData],
    cwd: desktop,
    env: {
      ...process.env,
      AIVS_RESOURCES_PATH: resources,
      AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: sourceAsset }),
      AIVS_E2E_EXPORT_PATH: configuredExport,
      AIVS_SIDECAR_EXECUTABLE: python,
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

    const setup = await page.evaluate(async (name: string) => {
      const project = await window.desktop.createProject({ name });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
      if (!imported) throw new Error("fixture import cancelled");
      const created = await window.desktop.createTimeline({
        project_id: project.project_id,
        timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" }
      });
      return { project_id: project.project_id, clip_id: created.current_revision.document.clips[0].clip_id as string };
    }, projectName);
    const projectId = setup.project_id;

    await page.reload();
    await page.waitForFunction(() => Boolean((window as any).desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 60_000 });
    await ensureProject(page, projectName);
    await expect(page.getByRole("button", { name: /Clip 1 video/ })).toBeVisible({ timeout: 60_000 });

    // 选中片段 → 「音频」页签
    await page.locator(".preview-frame").click();
    const panel = page.locator('fieldset.pp-panel[aria-label="片段属性"]');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel.getByRole("tab", { name: /^音频/ }).click();
    const fadeInSlider = panel.getByRole("slider", { name: "淡入时长" });
    await expect(fadeInSlider).toBeVisible({ timeout: 15_000 });

    // ── 1. 面板设淡入 1.5s（fill = 拖动滑杆；pointerup = 松手提交，与真实手势同一路径）──
    expect(await readFadeInUs(page, projectId)).toBe(0);
    await expect(fadeInSlider).toHaveValue("0");
    await fadeInSlider.fill("1.5");
    await fadeInSlider.dispatchEvent("pointerup");
    await expect.poll(async () => readFadeInUs(page, projectId), { timeout: 30_000 }).toBe(1_500_000);
    await page.screenshot({ path: join(run, "10-fade-in-set.png"), fullPage: true });

    // ── 2. 真实导出（淡入 1.5s）─────────────────────────────────────────
    await exportAs(page, projectId, "fade-export.mp4", fadeExport);

    // ── 3. 面板把淡入拖回 0 ────────────────────────────────────────────
    await expect(fadeInSlider).toHaveValue("1.5");
    await fadeInSlider.fill("0");
    await fadeInSlider.dispatchEvent("pointerup");
    await expect.poll(async () => readFadeInUs(page, projectId), { timeout: 30_000 }).toBe(0);
    await page.screenshot({ path: join(run, "20-fade-cleared.png"), fullPage: true });

    // ── 4. 真实导出（无淡入）───────────────────────────────────────────
    await exportAs(page, projectId, "plain-export.mp4", plainExport);

    // ── 5. 测量两个真实导出文件的 PCM ──────────────────────────────────
    const withFade = rmsProfile(fadeExport);
    const withoutFade = rmsProfile(plainExport);
    console.log("[fade] 有淡入：首 50ms=" + withFade.firstDb.toFixed(2) + "dB 中段=" + withFade.midDb.toFixed(2)
      + "dB 比值=" + withFade.ratio.toFixed(3) + " 采样=" + withFade.samples);
    console.log("[fade] 无淡入：首 50ms=" + withoutFade.firstDb.toFixed(2) + "dB 中段=" + withoutFade.midDb.toFixed(2)
      + "dB 比值=" + withoutFade.ratio.toFixed(3) + " 采样=" + withoutFade.samples);

    // 先把测量仪本身钉住：同一素材同一增益，两次导出的中段应当几乎一致。
    expect(Math.abs(withFade.midDb - withoutFade.midDb)).toBeLessThan(1.5);

    // 区分力所在：有淡入 ⇒ 首段显著低于中段；无淡入 ⇒ 首/中比值接近 1。
    expect(withFade.firstDb).toBeLessThan(withFade.midDb - 12);
    expect(withFade.ratio).toBeLessThan(0.3);
    expect(withoutFade.ratio).toBeGreaterThan(0.7);
    expect(withoutFade.ratio).toBeLessThan(1.4);

    // 对照方向也要成立：有淡入的首段必须比无淡入的首段明显更轻。
    expect(withFade.firstDb).toBeLessThan(withoutFade.firstDb - 12);
  } finally {
    await app.close().catch(() => undefined);
  }
});
