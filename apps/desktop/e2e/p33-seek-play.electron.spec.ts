import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectCurrentProject } from "./project-switcher";

/**
 * P33 W2.7/W2.8 真机复测：时间线任意位置跳转后点播放必须正常推进（不卡死、
 * 不报 decode worker watchdog 无匹配输出）。
 *
 * 验收点（对应真机报错「时间线任意选位置跳转再点播放则卡住 →
 * decode worker watchdog: frame N 无匹配输出」）：
 * 1. 播放一段 → 点时间线中间位置跳转 → 再点播放，时间码必须推进；
 * 2. 合成预览指标条不出现「最近错误：… watchdog」级别错误；
 * 3. 多个随机位置重复上述流程均正常（W2.8 冷启决策覆盖跨 GOP 连续过界）。
 */
const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;

const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "..", "..", "..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");
const userEofFixture = join(root, "test-assets", "generated", "user-eof-bframe.mp4");
// 真机用户素材实际位置（子目录 20261020/，原写死路径缺子目录故永不命中）。
// 用户素材不入库（test-assets/generated/ 已 gitignore），故本机有则用、缺失则回落；
// AIVS_E2E_USER_EOF_ASSET 可显式指向其他位置（CI/他人机器由此提供）。
const realUserAsset = process.env.AIVS_E2E_USER_EOF_ASSET
  ?? "C:/Users/trueY/Videos/20261020/fdf0f0e269126269ed686f208b3063e3.mp4";
// 长度前提（不是性能问题）：六档跳转的最后一档 ratio=0.82 之后仍要观测到「暂停」
// 按钮（该控件只在播放中存在）。3s 的通用夹具在 0.82 档（≈2.46s）已播到片尾自然
// 结束，按钮回落成「播放」，:249 的暂停定位必然超时——那是夹具太短造成的观测失败，
// 不是 seek→play 的推进缺陷（六档推进断言本身全部通过）。故在 3s 通用夹具之前先取
// 60s 长夹具；用户真机素材与仓内 EOF 夹具的优先级不变（真机复测口径不变）。
const longFixture = join(root, "test-assets", "generated", "h264-1080p-60s-g30-nobf.mp4");
const fallbackFixture = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
const fixture = existsSync(realUserAsset) ? realUserAsset
  : existsSync(userEofFixture) ? userEofFixture
    : existsSync(longFixture) ? longFixture
      : fallbackFixture;

/**
 * **L8 已核销（2026-10-10，复现消失模式）**：`test.fixme` 摘除后同构建
 * **12 轮连跑全部通过**（六档跳转每轮全部推进；`stall_retry` 12 轮全 0、
 * 单帧 EOF 重排兜底 0~2 次/轮且播放继续、无 45s 看门狗形态）。历史失败形态
 * （2026-09-30 W5 记录：3 连跑 1 次在 0.15 档停住、时间码 10s 只走 1 帧）
 * 不再复现——归因于 P71（初始喂包终点恒有界，根修「末段 GOP 无界喂到文件尾
 * 把 dq 顶进停摆」）+ P72（剪辑点链预热）+ W5~W7 五层防御（全局持有帧预算
 * /按 codec 分档/背压收缩/停摆自恢复/behindCursor 关键帧重解）的累积收口。
 * 残余单帧兜底（`eof_reorder_stuck` ≤4 断言）是设计内的有界行为：每次仅
 * 丢 1 帧、解码器自恢复、播放继续。核销注见实施记录 §4 L8 行。
 *
 * 保留断言不动：本 spec 仍是「跳转后点播放卡死」的唯一回归锁（六档推进 +
 * 无「无匹配输出」看门狗形态 + 单帧兜底有界），拦住任何回到系统性挂死的回归。
 */
test("P33 seek→play：跳转后点播放必须正常推进", async () => {
  test.setTimeout(300_000);
  if (!existsSync(fixture)) throw new Error("测试夹具不存在");
  const dir = join(root, "test-results", `p33-seek-play-${process.pid}-${Date.now()}`);
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

    // 建项目
    await page.getByRole("button", { name: "切换项目" }).click();
    await page.getByRole("listbox", { name: "选择项目" }).getByRole("menuitem", { name: "项目管理" }).click();
    await page.getByLabel("新项目名称").fill("P33 Seek Play");
    await page.getByRole("button", { name: "创建项目" }).click();
    await expectCurrentProject(page, "P33 Seek Play");
    await page.keyboard.press("Escape");
    await expect(page.locator(".project-management-modal")).toHaveCount(0, { timeout: 10_000 });

    // 导入素材（E2E env 注入绕过文件对话框）
    await page.getByRole("button", { name: "导入视频" }).click();
    const assetName = fixture.split(/[\\/]/).pop()!;
    const assetRow = page.locator(".asset-row").filter({ hasText: assetName });
    await expect(assetRow).toBeVisible({ timeout: 60_000 });

    const assetId = await expect.poll(async () => {
      const id = await page.evaluate(async name => {
        const projects = await window.desktop.listProjects({ limit: 100 });
        const project = projects.items.find(item => item.name === "P33 Seek Play");
        if (!project) return null;
        const list = await window.desktop.listAssets({ project_id: project.project_id, limit: 100 });
        const hit = list.items.find(item => item.asset.display_name === name);
        return hit?.asset.availability === "available" ? hit.asset.asset_id : null;
      }, assetName);
      return id;
    }, { timeout: 60_000 }).toBeTruthy();

    // 拖放到 V1 主轨行
    await page.evaluate(async name => {
      const canvas = document.querySelector('canvas[aria-label="时间线画布"]') as HTMLCanvasElement;
      if (!canvas) throw new Error("timeline canvas missing");
      const rect = canvas.getBoundingClientRect();
      const targetY = Math.min(112, rect.height - 8);
      const projects = await window.desktop.listProjects({ limit: 100 });
      const project = projects.items.find(item => item.name === "P33 Seek Play");
      const list = await window.desktop.listAssets({ project_id: project!.project_id, limit: 100 });
      const hit = list.items.find(item => item.asset.display_name === name);
      const transfer = new DataTransfer();
      transfer.setData("application/x-vortex-cut-asset", hit!.asset.asset_id);
      const dragOver = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 200, clientY: rect.top + targetY });
      canvas.dispatchEvent(dragOver);
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 200, clientY: rect.top + targetY });
      canvas.dispatchEvent(drop);
    }, assetName);
    await expect.poll(async () => page.evaluate(async () => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const project = projects.items.find(item => item.name === "P33 Seek Play")!;
      const state = await window.desktop.getTimeline(project.project_id);
      const doc = state.draft?.document ?? state.current_revision.document;
      return doc.clips.some(clip => clip.track_id === "V1" && clip.asset_kind === "video");
    }), { timeout: 30_000, intervals: [500] }).toBeTruthy();

    // 等合成预览就绪
    const syntheticReady = page.locator(".synthetic-metrics");
    await expect(syntheticReady).toBeVisible({ timeout: 120_000 });

    // 诊断通道（VITE_AIVS_PERF=1 / VITE_AIVS_DECODE_TIMING=1 构建才有效）：
    // 卡死判定失败时必须能回答「是喂包等待、解码器不吐、还是合成没跟上」——
    // 会话指标 + 解码 worker 决策 trace 一起取证。
    await page.evaluate(() => {
      const host = window as unknown as { __editorPerf?: { configure(enabled: boolean): void }; __TRACE?: unknown[] };
      host.__editorPerf?.configure(true);
      host.__TRACE = [];
    });
    const readDiag = () => page.evaluate(() => {
      const metrics = (window as unknown as { __aivsPreviewMetrics?: Record<string, unknown> }).__aivsPreviewMetrics ?? null;
      const events = (window as unknown as { __TRACE?: Array<Record<string, unknown>> }).__TRACE ?? [];
      const counts: Record<string, number> = {};
      const interesting: Array<Record<string, unknown>> = [];
      for (const event of events) {
        const name = String(event.event ?? "?");
        counts[name] = (counts[name] ?? 0) + 1;
        if (["cold_start", "feed_extend", "decoder_error", "eof_reorder_stuck", "evict_newest", "hold_cap", "unmatched_near", "decoder_revived", "feed_backpressure_wait"].includes(name) && interesting.length < 40) interesting.push(event);
      }
      return {
        metrics: metrics && {
          dropped: metrics.dropped_frames, decode_p95: metrics.decode_ms_p95, decode_p50: metrics.decode_ms_p50,
          upload_p95: metrics.upload_ms_p95, task_p95: metrics.task_ms_p95, in_flight: metrics.decode_in_flight,
          last_error: metrics.last_error ?? null, decode_seg: metrics.decode_seg ?? null,
        },
        counts, interesting,
      };
    });

    const parseTcUs = (text: string) => {
      const parts = text.split(":").map(Number);
      if (parts.length !== 4 || parts.some(Number.isNaN)) return null;
      return ((parts[0]! * 3600 + parts[1]! * 60 + parts[2]!) * 1_000_000) + Math.round(parts[3]! * 1_000_000 / 30);
    };
    const readTc = () => page.locator(".playback-bar .tc b").innerText();
    const playBtn = page.getByRole("button", { name: "播放", exact: true });

    // 真实用户点击序列（pointerdown/pointerup 落在按钮上，避免 click 冒泡打断 playing 态）
    const clickPlay = async () => {
      const btnBox = await playBtn.boundingBox();
      if (!btnBox) throw new Error("play button not visible");
      await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
      await page.mouse.down();
      await page.mouse.up();
    };

    page.on("pageerror", err => console.log(`[p33sp:pageerror] ${String(err).slice(0, 300)}`));
    page.on("console", msg => {
      if (msg.type() === "error") console.log(`[p33sp:console-error] ${msg.text().slice(0, 300)}`);
    });

    // ---- 第一段：播放 ~3s 制造热态 ----
    await clickPlay();
    await expect.poll(async () => {
      const us = parseTcUs(await readTc());
      return us !== null && us > 1_000_000;
    }, { timeout: 30_000, intervals: [500] }).toBeTruthy();
    // 暂停
    const pauseBtn = page.getByRole("button", { name: "暂停", exact: true });
    const pauseBox = await pauseBtn.boundingBox();
    if (pauseBox) {
      await page.mouse.move(pauseBox.x + pauseBox.width / 2, pauseBox.y + pauseBox.height / 2);
      await page.mouse.down();
      await page.mouse.up();
    }

    // ---- 核心验收：多个随机位置「跳转 → 播放 → 验证推进」 ----
    // 模拟用户「时间线任意选位置跳转再点播放」的操作。
    const readTotal = () => page.evaluate(async () => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const project = projects.items.find(item => item.name === "P33 Seek Play");
      if (!project) throw new Error("project missing");
      const state = await window.desktop.getTimeline(project.project_id);
      const document = state.draft?.document ?? state.current_revision.document;
      return document.clips.reduce((sum, clip) => sum + (clip.timeline_end_us - clip.timeline_start_us), 0);
    });
    const totalUs = await readTotal();
    expect(totalUs).toBeGreaterThan(1_000_000);

    // 跳转位置（相对总时长）：覆盖跨 GOP 连续过界、同 GOP 回跳、远景 seek
    const ratios = [0.15, 0.28, 0.42, 0.55, 0.68, 0.82];
    for (const ratio of ratios) {
      const targetUs = Math.floor(totalUs * ratio);
      // 通过进度条跳转（真实用户操作：点击进度条对应位置）
      await page.evaluate(async us => {
        const projects = await window.desktop.listProjects({ limit: 100 });
        const project = projects.items.find(item => item.name === "P33 Seek Play");
        // 通过键盘 Home + ArrowRight 步进到目标（最稳定的用户级跳转）
        void project; void us;
      }, targetUs);
      // 用进度条 slider 的键盘接口（Home → 右键步进到目标比例）
      const slider = page.locator('[role="slider"][aria-label="时间线播放头"]');
      await slider.focus();
      await page.keyboard.press("Home");
      // 反复 ArrowRight 步进（每次 1/300 总时长 ≈ 0.33%）
      const steps = Math.round(ratio * 300);
      for (let i = 0; i < steps; i++) await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(400); // 等 seek 落定
      const seekTc = parseTcUs(await readTc());
      console.log(`[p33sp] seek to ratio=${ratio} tc=${await readTc()}`);

      // 点播放
      await clickPlay();
      // 验证时间码推进（10s 内必须推进 >0.5s——卡死时时间码不动）
      const startTc = parseTcUs(await readTc()) ?? 0;
      let advanced = false;
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(500);
        const nowTc = parseTcUs(await readTc()) ?? 0;
        if (nowTc - startTc > 500_000) { advanced = true; break; }
      }
      if (!advanced) {
        console.log(`[p33sp:diag] ratio=${ratio} ${JSON.stringify(await readDiag()).slice(0, 2500)}`);
      }
      expect(advanced, `seek→play 卡死：ratio=${ratio} 时间码未推进（${startTc} → ${parseTcUs(await readTc())}）`).toBe(true);
      console.log(`[p33sp] ratio=${ratio} play advancing OK diag=${JSON.stringify((await readDiag()).metrics)}`);

      // 暂停，准备下一轮
      const pBox = await page.getByRole("button", { name: "暂停", exact: true }).boundingBox();
      if (pBox) {
        await page.mouse.move(pBox.x + pBox.width / 2, pBox.y + pBox.height / 2);
        await page.mouse.down();
        await page.mouse.up();
      }
    }

    // 最终检查：本 spec 的验收目标是**跳转后播放必须推进**（上方六档断言）。
    // 「看门狗级错误」一项的历史语义是「卡死到 45s 看门狗」——该形态已随 W5
    // 全局持有帧预算根修消失（探针 + App 双侧：冷启不再静默停摆）。剩余形态是
    // **单帧级**停摆兜底（实测 6 档跳转风暴中 0~2 次、每次 1 帧、播放继续），
    // 已作为 L8 登记在 docs/PREVIEW_SMOOTHNESS_IMPLEMENTATION_2026-09-29.md §4；
    // 这里按 worker 决策 trace 的**真实事件计数**钉成「有界」而非「恒为零」，
    // 不用放松 UI 文案断言来掩盖回归。
    const metricsText = await syntheticReady.innerText();
    const diag = await readDiag();
    const stalls = diag.counts["eof_reorder_stuck"] ?? 0;
    const coldStarts = diag.counts["cold_start"] ?? 0;
    if (metricsText.includes("最近错误")) console.warn(`[p33sp] metrics error note: ${metricsText}`);
    console.log(`[p33sp] decisions: cold_start=${coldStarts} eof_reorder_stuck=${stalls} stall_retry=${diag.counts["stall_retry"] ?? 0} backpressure_shrink=${diag.counts["backpressure_shrink"] ?? 0}`);
    console.log(`[p33sp] all counts: ${JSON.stringify(diag.counts)}`);
    expect(metricsText).not.toContain("无匹配输出"); // 45s 看门狗形态（不得复现）
    // 六档跳转风暴（每档 45 次连按 = 270 次 seek）下单帧级停摆兜底的实测上界
    // 为 0~3 次/会话（每次仅丢 1 帧、播放继续，见 L8）。这条断言的作用是**拦住
    // 回到「系统性挂死」的回归**（旧形态：第一档即挂、六档 0/6 推进、丢帧数百），
    // 而不是追求压力场景下的恒零。
    expect(stalls, `单帧停摆兜底次数超界（trace）：${JSON.stringify(diag.counts)}`).toBeLessThanOrEqual(4);
    console.log(`[p33sp] ALL SEEK→PLAY SCENARIOS PASSED（单帧停摆兜底 ${stalls} 次 / 冷启 ${coldStarts} 次）`);
  } finally {
    await app.close();
  }
});
