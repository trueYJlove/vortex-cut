import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectCurrentProject } from "./project-switcher";

/**
 * P33 W2.6 末条「overlay-only 时间线 play() 静默」根修的端到端验收。
 *
 * 场景：片段全部落在 V2 覆盖轨、V1 主轨为空。修复前 IR 投影 total_frames=0
 * （visual 只取 V1），play() 首个 tick 即结束判定、静默无任何提示；修复后
 * 时长对齐权威端「全程黑场 + 覆盖轨照常叠加」（ir.py 主轨空时长下限），
 * 播放必须推进到覆盖轨终点。
 *
 * 时间线用 patchTimeline 程序化构建（empty source + add_track +
 * insert_asset_clip(track_id)），与真实拖放落 V2 等价且无落点坐标脆弱性。
 */
const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;

const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "..", "..", "..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");
const realUserAsset = "C:/Users/trueY/Videos/fdf0f0e269126269ed686f208b3063e3.mp4";
// 长度前提（不是性能问题）：覆盖轨片段窗口 OVERLAY_WINDOW_S=5s 必须真实落在素材内。
// 3s 的通用夹具 cfr-landscape-av.mp4 上，下方 patch(insert_asset_clip,
// source_end_us=5s) 会被 Core 判为 [TIMELINE_SOURCE_INVALID] 视频源范围无效——
// 那是夹具太短，不是 overlay-only 缺陷。故 3s 通用夹具之前先取 60s 长夹具；
// 用户真机素材仍最优先（真机复测口径不变），长夹具只是回落到「够长且可用」的那一档。
const longFixture = join(root, "test-assets", "generated", "h264-1080p-60s-g30-nobf.mp4");
const fallbackFixture = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
const fixture = existsSync(realUserAsset) ? realUserAsset
  : existsSync(longFixture) ? longFixture
    : fallbackFixture;
/** 覆盖轨片段源窗口（秒）：足够长以判定推进，又不拖慢回归。 */
const OVERLAY_WINDOW_S = 5;

test("P33 overlay-only：主轨空 + V2 覆盖轨片段，播放必须推进", async () => {
  test.setTimeout(240_000);
  if (!existsSync(fixture)) throw new Error("测试夹具不存在");
  const dir = join(root, "test-results", `p33-overlay-only-${process.pid}-${Date.now()}`);
  await mkdir(join(dir, "user-data"), { recursive: true });
  const env = {
    ...process.env,
    AIVS_RESOURCES_PATH: resources,
    AIVS_E2E_MEDIA_PATH: fixture,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: fixture }),
    AIVS_SIDECAR_EXECUTABLE: join(root, ".venv", "Scripts", "python.exe"),
    AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
    PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_OPTIONS: undefined
  };
  const app = await electron.launch({
    args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${join(dir, "user-data")}`],
    cwd: desktop,
    env
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByRole("tab", { name: "素材", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    page.on("pageerror", err => console.log(`[p33ov:pageerror] ${String(err).slice(0, 300)}`));

    const projectName = "P33 Overlay Only";
    await page.getByRole("button", { name: "切换项目" }).click();
    await page.getByRole("listbox", { name: "选择项目" }).getByRole("menuitem", { name: "项目管理" }).click();
    await page.getByLabel("新项目名称").fill(projectName);
    await page.getByRole("button", { name: "创建项目" }).click();
    await expectCurrentProject(page, projectName);
    await page.keyboard.press("Escape");
    await expect(page.locator(".project-management-modal")).toHaveCount(0, { timeout: 10_000 });

    await page.getByRole("button", { name: "导入视频" }).click();
    const assetName = fixture.split(/[\\/]/).pop()!;
    await expect(page.locator(".asset-row").filter({ hasText: assetName })).toBeVisible({ timeout: 60_000 });
    const lookupAsset = () => page.evaluate(async ({ name, project }) => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const hit = projects.items.find(item => item.name === project);
      if (!hit) return null;
      const list = await window.desktop.listAssets({ project_id: hit.project_id, limit: 100 });
      const found = list.items.find(item => item.asset.display_name === name);
      return found?.asset.availability === "available" ? (found.asset.asset_id as string) : null;
    }, { name: assetName, project: projectName });
    await expect.poll(lookupAsset, { timeout: 60_000 }).toBeTruthy();
    const assetId = await lookupAsset();
    if (!assetId) throw new Error("asset id 未取到");

    // 程序化构建 overlay-only 时间线：empty source + add_track(V2) + 覆盖轨片段。
    await page.evaluate(async ({ project, asset, windowS }) => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const hit = projects.items.find(item => item.name === project)!;
      let state = await window.desktop.getTimeline(hit.project_id).catch(() => null as never);
      if (!state || !(state.draft?.document ?? state.current_revision?.document)) {
        state = await window.desktop.createTimeline({
          project_id: hit.project_id,
          timeline: {
            schema_version: 1,
            source: { kind: "empty" },
            default_layout: "fit",
            caption_preset_id: "default-bottom",
          },
        });
      }
      let revisionId = state.current_revision.timeline_revision_id;
      const patch = async (operation: Record<string, unknown>, summary: string) => {
        try {
          const next = await window.desktop.patchTimeline({
            project_id: hit.project_id,
            patch: { schema_version: 1, base_revision_id: revisionId, operations: [operation], summary },
          });
          revisionId = next.current_revision.timeline_revision_id;
        } catch (error) {
          throw new Error(`${summary} ${JSON.stringify(operation)} -> ${String(error)}`);
        }
      };
      await patch({ op: "add_track", kind: "video" }, "建 V2 覆盖轨");
      await patch({
        op: "insert_asset_clip",
        asset_id: asset,
        at_index: 0,
        track_id: "V2",
        source_start_us: 0,
        source_end_us: Math.round(windowS * 1e6),
      }, "覆盖轨片段");
    }, { project: projectName, asset: assetId, windowS: OVERLAY_WINDOW_S });

    // API 建的时间线要 reload 才被 UI 装载（m6-multi-track 同款做法）。
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    await expectCurrentProject(page, projectName);

    // 时间线形状断言：V2 恰 1 个视频片段、V1 为空（overlay-only 前提成立）。
    await expect.poll(async () => page.evaluate(async project => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const hit = projects.items.find(item => item.name === project);
      if (!hit) return "";
      const state = await window.desktop.getTimeline(hit.project_id);
      const doc = state.draft?.document ?? state.current_revision.document;
      const v2 = doc.clips.filter((clip: Record<string, unknown>) => clip.track_id === "V2" && clip.asset_kind === "video").length;
      const v1 = doc.clips.filter((clip: Record<string, unknown>) => clip.track_id === "V1").length;
      return `${v2}/${v1}`;
    }, projectName), { timeout: 60_000, intervals: [500] }).toBe("1/0");

    await page.getByLabel("预览比例").selectOption("169");
    const syntheticReady = page.locator(".synthetic-metrics");
    await expect(syntheticReady).toBeVisible({ timeout: 180_000 });

    const parseTcUs = (text: string) => {
      const parts = text.split(":").map(Number);
      if (parts.length !== 4 || parts.some(Number.isNaN)) return null;
      return ((parts[0]! * 3600 + parts[1]! * 60 + parts[2]!) * 1_000_000) + Math.round(parts[3]! * 1_000_000 / 30);
    };
    const readTc = () => page.locator(".playback-bar .tc b").innerText();
    const readMetrics = () => page.evaluate(() => (window as unknown as { __aivsPreviewMetrics?: Record<string, unknown> }).__aivsPreviewMetrics ?? null);

    // 核心验收：点播放后时间码必须推进（修复前 play() 首个 tick 即静默结束）。
    const playBtn = page.getByRole("button", { name: "播放", exact: true });
    const btnBox = await playBtn.boundingBox();
    if (!btnBox) throw new Error("play button not visible");
    await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    const startTc = parseTcUs(await readTc()) ?? 0;
    let advancedUs = 0;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      const nowTc = parseTcUs(await readTc()) ?? 0;
      advancedUs = Math.max(advancedUs, nowTc - startTc);
      if (advancedUs > 500_000) break;
    }
    expect(advancedUs, `overlay-only 播放静默：时间码未推进（${startTc} → ${parseTcUs(await readTc())}）`).toBeGreaterThan(500_000);
    const metrics = await readMetrics();
    console.log(`[p33ov] play advancing OK advancedUs=${advancedUs} metrics=${JSON.stringify(metrics && { dropped: metrics.dropped_frames, decode_p95: metrics.decode_ms_p95, last_error: metrics.last_error ?? null })}`);
    expect(metrics?.last_error ?? null, "overlay-only 播放不得产生错误横幅").toBeNull();

    // 播放到覆盖轨终点（修复后时长 = 覆盖轨窗口；修复前 0 帧立即结束）。
    const targetUs = OVERLAY_WINDOW_S * 1_000_000;
    let reachedEnd = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      const tcUs = parseTcUs(await readTc()) ?? 0;
      if (tcUs >= targetUs - 1_000_000) { reachedEnd = true; break; }
    }
    expect(reachedEnd, `播放未到覆盖轨终点（tc=${await readTc()}）`).toBe(true);
    console.log("[p33ov] OVERLAY-ONLY PLAY PASSED（黑场 + 覆盖轨叠加，推进到终点）");
  } finally {
    await app.close();
  }
});
