import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectCurrentProject } from "./project-switcher";

/**
 * P33 W2.6 真机复测：截断尾 GOP 素材（真机用户素材同结构）播到片尾后
 * 再点播放必须从头回卷复播。
 *
 * 验收点（对应此前真机报错「EOF reorder watchdog … 再点播放无效」）：
 * 1. 片尾播放结束 onEnded 后播放头吸附到 totalUs（片尾吸附修复）；
 * 2. 结束后再点播放，播放头从 0 重新开始（play() 回卷条件成立）；
 * 3. 合成预览指标条不出现「最近错误：EOF reorder watchdog」级别的
 *    不可恢复错误（EOF 定格替代兜底）。
 */
const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;

const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "..", "..", "..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");
// 素材优先级：真机用户素材（HEVC 720x1280 B 帧交错 + 截断尾 GOP，L4 复测对象，
// 环境变量指向本机路径）→ 仓内复刻夹具（不存在则跳过生成）→ 通用 H.264 夹具。
// H.264 无 B 帧重排，EOF 回卷语义对所有素材一致但针对性弱——仅兜底。
const userEofFixture = join(root, "test-assets", "generated", "user-eof-bframe.mp4");
const realUserAsset = "C:/Users/trueY/Videos/fdf0f0e269126269ed686f208b3063e3.mp4";
const fallbackFixture = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
const fixture = existsSync(userEofFixture) ? userEofFixture
  : existsSync(realUserAsset) ? realUserAsset
    : fallbackFixture;

test("P33 EOF 回卷：播到片尾后再点播放从头复播", async () => {
  test.setTimeout(240_000);
  if (!existsSync(fixture)) throw new Error("测试夹具不存在");
  const dir = join(root, "test-results", `p33-eof-replay-${process.pid}-${Date.now()}`);
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

    // 建项目（Escape 关闭项目管理对话框——Dialog.tsx 支持 Escape → onClose）
    await page.getByRole("button", { name: "切换项目" }).click();
    await page.getByRole("listbox", { name: "选择项目" }).getByRole("menuitem", { name: "项目管理" }).click();
    await page.getByLabel("新项目名称").fill("P33 EOF Replay");
    await page.getByRole("button", { name: "创建项目" }).click();
    await expectCurrentProject(page, "P33 EOF Replay");
    await page.keyboard.press("Escape");
    await expect(page.locator(".project-management-modal")).toHaveCount(0, { timeout: 10_000 });

    // 导入素材（E2E env 注入绕过文件对话框）
    await page.getByRole("button", { name: "导入视频" }).click();
    const assetName = fixture.split(/[\\/]/).pop()!;
    const assetRow = page.locator(".asset-row").filter({ hasText: assetName });
    await expect(assetRow).toBeVisible({ timeout: 60_000 });

    // 等素材 available，再取 asset_id
    const assetId = await expect.poll(async () => {
      const id = await page.evaluate(async name => {
        const projects = await window.desktop.listProjects({ limit: 100 });
        const project = projects.items.find(item => item.name === "P33 EOF Replay");
        if (!project) return null;
        const list = await window.desktop.listAssets({ project_id: project.project_id, limit: 100 });
        const hit = list.items.find(item => item.asset.display_name === name);
        return hit?.asset.availability === "available" ? hit.asset.asset_id : null;
      }, assetName);
      return id;
    }, { timeout: 60_000 }).toBeTruthy();

    // 把素材加入时间线：UI 拖放到 **V1 主轨行**。drop 落点决定轨道
    //（TimelineCanvas handleDrop → trackRowAt 几何命中）：默认新项目轨道行带
    // = ruler16 + C1 56 + V1 80 → V1 行带 [72,152)，取带内 y=112；A1 行带
    // [152,216)。落到 A1/C1 时 V1 为空 → IR 投影 visual 为空 → Core manifest
    // total_frames=0 → play() 首个 tick 即片尾结束判定（2026-09-29 六轮 e2e
    // 复测根因：V2/A1 落轨 → 播放 9ms 内 暂停→播放 翻转、零合成、无错误）。
    await page.evaluate(async name => {
      const canvas = document.querySelector('canvas[aria-label="时间线画布"]') as HTMLCanvasElement;
      if (!canvas) throw new Error("timeline canvas missing");
      const rect = canvas.getBoundingClientRect();
      const targetY = Math.min(112, rect.height - 8);
      const projects = await window.desktop.listProjects({ limit: 100 });
      const project = projects.items.find(item => item.name === "P33 EOF Replay");
      const list = await window.desktop.listAssets({ project_id: project!.project_id, limit: 100 });
      const hit = list.items.find(item => item.asset.display_name === name);
      const transfer = new DataTransfer();
      transfer.setData("application/x-vortex-cut-asset", hit!.asset.asset_id);
      const dragOver = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 200, clientY: rect.top + targetY });
      canvas.dispatchEvent(dragOver);
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 200, clientY: rect.top + targetY });
      canvas.dispatchEvent(drop);
    }, assetName);
    // 校验落轨：V1 必须有片段（防再次静默落错轨）
    await expect.poll(async () => page.evaluate(async () => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const project = projects.items.find(item => item.name === "P33 EOF Replay")!;
      const state = await window.desktop.getTimeline(project.project_id);
      const doc = state.draft?.document ?? state.current_revision.document;
      return doc.clips.some(clip => clip.track_id === "V1" && clip.asset_kind === "video");
    }), { timeout: 30_000, intervals: [500] }).toBeTruthy();

    // 等合成预览就绪（默认预览模式即合成预览 = WebCodecs 解码路径）
    const syntheticReady = page.locator(".synthetic-metrics");
    await expect(syntheticReady).toBeVisible({ timeout: 120_000 });
    const readTotal = () => page.evaluate(async () => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const project = projects.items.find(item => item.name === "P33 EOF Replay");
      if (!project) throw new Error("project missing");
      const state = await window.desktop.getTimeline(project.project_id);
      const document = state.draft?.document ?? state.current_revision.document;
      return document.clips.reduce((sum, clip) => sum + (clip.timeline_end_us - clip.timeline_start_us), 0);
    });
    // expect.poll 只做断言不返回被轮询值——先 poll 到位再显式取值
    await expect.poll(async () => (await readTotal()) > 0, { timeout: 30_000 }).toBeTruthy();
    const totalUs = await readTotal();
    expect(totalUs).toBeGreaterThan(1_000_000);
    console.log(`[p33] timeline totalUs=${totalUs}`);

    // 播放到片尾：点播放，轮询时间码直到结束（onEnded → 播放头吸附 last）。
    // 时间码为 SMPTE HH:MM:SS:FF（App.tsx formatSmpteTimecode）。
    const parseTcUs = (text: string) => {
      const parts = text.split(":").map(Number);
      if (parts.length !== 4 || parts.some(Number.isNaN)) return null;
      return ((parts[0]! * 3600 + parts[1]! * 60 + parts[2]!) * 1_000_000) + Math.round(parts[3]! * 1_000_000 / 30);
    };
    const playBtn = page.getByRole("button", { name: "播放", exact: true });
    page.on("pageerror", err => console.log(`[p33:pageerror] ${String(err).slice(0, 300)}`));
    page.on("console", msg => {
      if (msg.type() === "error") console.log(`[p33:console-error] ${msg.text().slice(0, 300)}`);
    });
    // 真 click 会先 pointerdown 命中按钮、pointerup 后浏览器派发的 click 冒泡
    // 到 preview-frame 的 onClick(selectClipAtPlayhead) → exitLibraryPreview +
    // setSelection 重渲（实测把刚置起的 playing 态打断）。改用真实用户同款
    // 序列：pointerdown/pointerup 落在按钮上，click 由浏览器合成——与手工
    // 点击一致，且不构造无坐标的合成 MouseEvent（React 17+ 事件委托需要）。
    const btnBox = await playBtn.boundingBox();
    if (!btnBox) throw new Error("play button not visible");
    await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    const readTc = () => page.locator(".playback-bar .tc b").innerText();
    await expect
      .poll(async () => {
        const us = parseTcUs(await readTc());
        return us !== null && us > 0;
      }, { timeout: 30_000, intervals: [1_000] })
      .toBeTruthy();
    // expect.poll 断言超时即抛错；成功时返回 void——不要再对返回值断言
    await expect
      .poll(async () => {
        const us = parseTcUs(await readTc());
        return us !== null && us >= totalUs - 3_000_000;
      }, { timeout: 180_000, intervals: [1_000] })
      .toBeTruthy();
    console.log(`[p33] reached end tc=${await readTc()}`);

    // 片尾吸附断言：结束态播放头 ≈ totalUs
    const endUs = await readTotal();
    await expect
      .poll(async () => {
        const us = parseTcUs(await readTc());
        return us !== null && us >= endUs - 2_000_000;
      }, { timeout: 10_000, intervals: [500] })
      .toBeTruthy();

    // 核心验收：结束态再点播放 → 播放头回卷从头（< 5s）
    // 同首播：mouse 序列点击（见上方说明），避免 click 冒泡打断 playing 态。
    const replayBtn = page.getByRole("button", { name: "播放", exact: true });
    const replayBox = await replayBtn.boundingBox();
    if (!replayBox) throw new Error("replay button not visible");
    await page.mouse.move(replayBox.x + replayBox.width / 2, replayBox.y + replayBox.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect
      .poll(async () => {
        const us = parseTcUs(await readTc());
        return us !== null && us <= 5_000_000;
      }, { timeout: 10_000, intervals: [300] })
      .toBeTruthy();
    console.log(`[p33] replay-from-start OK tc=${await readTc()}`);

    // 再等几秒确认复播持续推进（不是停在第 0 帧假象）
    const first = await readTc();
    await page.waitForTimeout(4_000);
    const second = await readTc();
    expect(second).not.toBe(first);
    console.log(`[p33] replay advancing: ${first} -> ${second}`);

    // 合成预览不应出现不可恢复的 EOF watchdog 级错误
    const metricsText = await syntheticReady.innerText();
    if (metricsText.includes("最近错误")) console.warn(`[p33] metrics error note: ${metricsText}`);
    expect(metricsText).not.toContain("EOF reorder watchdog");
  } finally {
    await app.close();
  }
});
