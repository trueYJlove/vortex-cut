/**
 * E8 响度统一 —— 真机 e2e（真实 Electron + 真实 Core sidecar + 真实 ffmpeg EBU R128）。
 *
 * 覆盖的接线（单元测试天生测不到的那一层）：
 *   真实 ffmpeg 测量 → prepareEditingGrammar 提案 → 显式采纳 → 正式 Timeline 的 gain_db 真的变了。
 *
 * 为什么必须读回文档而不是读 UI 文案：
 *   面板文案由 prepare 的 rationale 渲染，它与「提案写进 Revision」是两条互不依赖的路径。
 *   只断言文案，「提案没落库 / 采纳写错字段」都会绿。所以这里的终态断言是
 *   getTimeline(...).current_revision.document.clips[].audio.gain_db。
 *
 * 素材：test-assets/generated/cfr-landscape-av.mp4（实测 I = -21.8 LUFS，有 aac 音轨），
 *       目标 -16 LUFS ⇒ 期望增益约 +5.8dB，落在契约 -60..12dB 内，必然产 op（非 noop）。
 *
 * 负向对照（实跑记录见交付说明）：
 *   把 PropertyPanels.tsx 里 runLoudnessPrepare 的 window.desktop.prepareEditingGrammar(...)
 *   调用去掉 ⇒ 本 spec 在「看到实测 LUFS」一步超时变红；恢复 ⇒ 绿。
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
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

const TARGET_LUFS = -16;

/**
 * 用随包 ffmpeg 独立测一遍素材的 integrated loudness，作为「UI 上的数字是不是真测出来的」独立基准。
 * 解析口径与 Core（media/loudness.py）一致：取最后一帧的 lavfi.r128.I（整段积分值）。
 * 只取 stdout——摘要块的 "I: -xx LUFS" 在 stderr，那是另一条路径，拿它作基准等于自己证明自己。
 */
function measureLufs(path: string): number {
  const stdout = execFileSync(ffmpeg, [
    "-hide_banner", "-nostdin", "-nostats", "-v", "error",
    "-i", path, "-vn", "-map", "0:a:0",
    "-af", "ebur128=metadata=1:framelog=quiet,ametadata=mode=print:key=lavfi.r128.I:file=-",
    "-f", "null", "-"
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
  const values = [...stdout.matchAll(/^lavfi\.r128\.I=(-?\d+(?:\.\d+)?)$/gm)].map(m => Number(m[1]));
  if (!values.length) throw new Error("未能从 ffmpeg stdout 解析 integrated loudness：" + stdout.slice(-400));
  return values[values.length - 1];
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

const loudnessRow = (page: Page) =>
  page.locator('fieldset.pp-panel[aria-label="片段属性"]').locator(".pp-row").filter({ hasText: "响度统一" });

test("E8 响度统一：真实 ffmpeg 测量 → 提案 → 采纳 → Timeline gain_db 真的变了", async () => {
  test.setTimeout(600_000);
  const run = join(root, "test-results", "e8-loudness-evidence", "run-" + process.pid + "-" + Date.now());
  await mkdir(run, { recursive: true });
  const userData = join(run, "user-data");
  const sourceAsset = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
  if (!existsSync(sourceAsset)) throw new Error("缺少夹具：" + sourceAsset);

  // 独立基准先跑（不依赖 App 的任何状态）
  const baselineLufs = measureLufs(sourceAsset);
  // -16 - (-21.8) = +5.8dB，在 -60..12 内 ⇒ 必然产 op
  expect(TARGET_LUFS - baselineLufs).toBeGreaterThan(0.5);
  expect(TARGET_LUFS - baselineLufs).toBeLessThanOrEqual(12);

  const projectName = "E8 响度统一 E2E " + Date.now();
  const app = await electron.launch({
    args: [join(desktop, "out", "main", "index.cjs"), "--user-data-dir=" + userData],
    cwd: desktop,
    env: {
      ...process.env,
      AIVS_RESOURCES_PATH: resources,
      AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: sourceAsset }),
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
      const clip = created.current_revision.document.clips[0];
      return {
        project_id: project.project_id,
        asset_id: imported.asset.asset_id,
        clip_id: clip.clip_id as string,
        base_revision_id: created.current_revision.timeline_revision_id,
        gain_before: clip.audio.gain_db as number,
        has_audio_stream: true
      };
    }, projectName);
    // 采纳前：默认 0dB（否则下面的「变了」失去基准）
    expect(setup.gain_before).toBe(0);

    await page.reload();
    await page.waitForFunction(() => Boolean((window as any).desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 60_000 });
    await ensureProject(page, projectName);
    await expect(page.getByRole("button", { name: /Clip 1 video/ })).toBeVisible({ timeout: 60_000 });

    // 选中片段（点预览画面 = 选中播放头处片段），再切到「音频」页签
    await page.locator(".preview-frame").click();
    const panel = page.locator('fieldset.pp-panel[aria-label="片段属性"]');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel.getByRole("tab", { name: /^音频/ }).click();
    await expect(loudnessRow(page)).toBeVisible({ timeout: 15_000 });

    // ── 1. 点「响度统一」开关 → 真实 ffmpeg 测量 ─────────────────────────────
    const toggle = loudnessRow(page).getByRole("switch");
    await expect(toggle).toBeEnabled({ timeout: 15_000 });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();

    const preview = panel.getByTestId("pp-loudness-preview");
    await expect(preview).toBeVisible({ timeout: 180_000 });
    const measuredText = (await preview.locator(".pp-loudness-line").nth(1).innerText()).replace(/\s+/g, " ").trim();
    await page.screenshot({ path: join(run, "10-loudness-measured.png"), fullPage: true });

    // ── 2. 实测 LUFS 必须是真的（不是占位）─────────────────────────────────
    const measuredMatch = /实测\s+(-?\d+(?:\.\d+)?)\s*→\s*目标\s+(-?\d+)\s+LUFS/.exec(measuredText);
    if (!measuredMatch) throw new Error("未在面板上看到实测 LUFS，实际文案：" + JSON.stringify(measuredText));
    const uiMeasured = Number(measuredMatch[1]);
    const uiTarget = Number(measuredMatch[2]);
    expect(uiMeasured).not.toBe(0);
    // 与独立 ffmpeg 测量对拍（±1.5 LU 容纳编码/滤镜路径差异）
    expect(Math.abs(uiMeasured - baselineLufs)).toBeLessThanOrEqual(1.5);
    expect(uiTarget).toBe(TARGET_LUFS);

    // 三段式的第一步不得写时间线
    const midDoc = await page.evaluate(async (pid: string) => (await window.desktop.getTimeline(pid as never)).current_revision.document, setup.project_id);
    expect(midDoc.clips.find((c: any) => c.clip_id === setup.clip_id).audio.gain_db).toBe(0);

    // ── 3. 生成提案 ────────────────────────────────────────────────────────
    await preview.getByRole("button", { name: "生成提案" }).click();
    const proposal = panel.getByTestId("pp-loudness-proposal");
    await expect(proposal).toBeVisible({ timeout: 120_000 });
    const proposalText = (await proposal.innerText()).replace(/\s+/g, " ").trim();
    await page.screenshot({ path: join(run, "20-loudness-proposal.png"), fullPage: true });
    const opsMatch = /待采纳\s+(\d+)\s+项改动/.exec(proposalText);
    if (!opsMatch) throw new Error("提案视图未给出操作数，实际文案：" + JSON.stringify(proposalText));
    expect(Number(opsMatch[1])).toBeGreaterThan(0);

    // 提案未采纳前，正式 Timeline 仍不动
    const beforeApply = await page.evaluate(async (pid: string) => (await window.desktop.getTimeline(pid as never)).current_revision.document, setup.project_id);
    expect(beforeApply.clips.find((c: any) => c.clip_id === setup.clip_id).audio.gain_db).toBe(0);

    // ── 4. 显式采纳 → 读回文档断言 gain_db ─────────────────────────────────
    await proposal.getByRole("button", { name: "应用提案" }).click();
    await expect(panel.getByText(/已应用为新的正式 Revision/)).toBeVisible({ timeout: 120_000 });

    const after = await page.evaluate(async (pid: string) => {
      const state = await window.desktop.getTimeline(pid as never);
      return { revision_id: state.current_revision.timeline_revision_id, document: state.current_revision.document };
    }, setup.project_id);
    await page.screenshot({ path: join(run, "30-loudness-applied.png"), fullPage: true });

    expect(after.revision_id).not.toBe(setup.base_revision_id);
    const appliedClip = after.document.clips.find((c: any) => c.clip_id === setup.clip_id);
    const gainAfter = appliedClip.audio.gain_db as number;

    // 关键断言：gain_db 真的变了，且等于「目标 - 实测」（Core 语义：new_gain = target - measured）
    const expectedGain = Math.round((TARGET_LUFS - baselineLufs) * 100) / 100;
    expect(gainAfter).not.toBe(setup.gain_before);
    expect(Math.abs(gainAfter - expectedGain)).toBeLessThanOrEqual(1.5);
    // 上下界：Core 契约 -60..12
    expect(gainAfter).toBeGreaterThan(-60);
    expect(gainAfter).toBeLessThanOrEqual(12);

    // 幂等性：采纳后 effective = measured + gain 应落在目标容差内
    expect(Math.abs(baselineLufs + gainAfter - TARGET_LUFS)).toBeLessThanOrEqual(1.5);

    console.log("[E8] 独立测量=" + baselineLufs + " LUFS；UI 实测=" + uiMeasured
      + "；目标=" + uiTarget + "；提案=" + opsMatch[1] + " 项；gain_db " + setup.gain_before + " → " + gainAfter
      + "；新 revision=" + after.revision_id);
  } finally {
    await app.close().catch(() => undefined);
  }
});
