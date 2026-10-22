/**
 * W3.3 关键帧外传审阅 —— 真机 e2e（真实 Electron + 真实 Core + 真实抽帧编码）。
 *
 * 验的是 ADR-0003 D4「用户可逐张审阅」在**真实界面**上成立，而不是只在面板单测里成立：
 *   工具菜单 → 关键帧外传审阅 → 准备预览 → 逐帧列表出现（每张有序号/时间码/尺寸/实测字节）
 *   → 移除某一帧 → 该帧标记为已移除 且 **服务端状态真的变了**（读 app.db 的
 *     keyframe_egress_previews.excluded_frames_json，不是读 UI 的本地状态）
 *   → 确认按钮在未勾选时禁用。
 *
 * 不发真实外传：全程不点「确认外传」，Provider 指向不可达的本地端口，进程不会走出 preview。
 *
 * 素材：test-assets/generated/cfr-landscape-av.mp4（3s ⇒ 默认 2s 间隔抽样得到多帧）。
 *
 * ✅ 2026-10-22：本 spec 首次运行时是**红**的，并因此抓出两处生产缺陷（已修）：
 *      services/core/src/aivs_core/app.py:2745 调了不存在的方法
 *        provider = state.providers.require(project_id, ...)  ← ProviderRepository 无 require
 *      同一路由的 ffprobe 调用三处都错（漏 await / 传 str 而非 Path / 按属性读 dict）
 *    ⇒ HTTP 500，面板只显示「生成预览失败，请稍后重试」。
 *    修复见 app.py 该路由 + 回归锁 services/core/tests/integration/test_keyframe_routes.py（12 项，
 *    走真实路由）。**这条 spec 的价值就在这里**：26 项关键帧单测全绿，
 *    而 grep 'keyframe-preview' services/core/tests/ 当时零命中 —— 装配层问题单测看不见。
 *
 * ⚠️ 注意第 242 行附近的「累加断言」：3s 素材默认抽样只有 2 帧，
 *    `if (frameCount > 2)` 使它**静默跳过**。不要把这里的绿读成「累加已验证」。
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
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
const python = join(root, ".venv", "Scripts", "python.exe");

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

/** 在 user-data 下找到 Core 的 app.db（与 wave1 spec 的 findAppDb 同一做法）。 */
async function findAppDb(base: string): Promise<string> {
  const stack = [base];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
    try { entries = (await readdir(current, { withFileTypes: true })) as never; } catch { continue; }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "app.db") return full;
    }
  }
  return "";
}

/**
 * 读 Core 落库的排除集合（**服务端状态**，不是 UI 状态）。
 * 取该项目最新的一条预览行——exclude 只增不改，重算的是 payload_sha256。
 */
function readServerExclusion(dbPath: string, projectId: string): { excluded: number[]; previewId: string; sha: string } {
  const script = [
    "import sqlite3,json,sys",
    "con=sqlite3.connect(sys.argv[1])",
    "row=con.execute('SELECT id,excluded_frames_json,payload_sha256 FROM keyframe_egress_previews WHERE project_id=? ORDER BY created_at DESC, id DESC LIMIT 1',(sys.argv[2],)).fetchone()",
    "print(json.dumps({'preview_id':row[0],'excluded':json.loads(row[1]),'payload_sha256':row[2]}) if row else 'null')"
  ].join("\n");
  const output = execFileSync(python, ["-c", script, dbPath, projectId], { encoding: "utf8" });
  const parsed = JSON.parse(output.trim() || "null");
  if (!parsed) throw new Error("app.db 中找不到该项目的 keyframe_egress_previews 行");
  return { excluded: parsed.excluded, previewId: parsed.preview_id, sha: parsed.payload_sha256 };
}

test("W3.3 关键帧外传审阅：逐帧可见 → 单张移除 → 服务端状态持久 → 未勾选禁止确认", async () => {
  test.setTimeout(600_000);
  const run = join(root, "test-results", "w33-keyframe-review-evidence", "run-" + process.pid + "-" + Date.now());
  await mkdir(run, { recursive: true });
  const userData = join(run, "user-data");
  const sourceAsset = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
  if (!existsSync(sourceAsset)) throw new Error("缺少夹具：" + sourceAsset);

  const projectName = "W3.3 关键帧审阅 E2E " + Date.now();
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
      // Provider：面板只列「enabled 且 credential_status = configured」的条目。
      // 指向不可达的本地端口——本 spec 不点「确认外传」，它永远走不到网络。
      const provider = await window.desktop.createProvider?.({
        kind: "openai_compatible_text",
        display_name: "本地不可达（审阅用）",
        base_url: "http://127.0.0.1:9",
        model: "vision-model",
        enabled: true
      });
      if (!provider) throw new Error("Provider 创建不可用");
      await window.desktop.setProviderSecret?.({ provider_config_id: provider.provider_config_id, secret: "e2e-review-only" });
      return {
        project_id: project.project_id,
        asset_id: imported.asset.asset_id,
        asset_name: imported.asset.display_name,
        provider_id: provider.provider_config_id
      };
    }, projectName);

    await page.reload();
    await page.waitForFunction(() => Boolean((window as any).desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 60_000 });
    await ensureProject(page, projectName);

    // 选中素材库里的该素材（工具菜单项在有选中素材时才可用）。
    // 用 dispatchEvent 而不是 click：整行点击可能落到行内「转录」按钮上（会弹
    // 「确认下载本地模型」模态），且 .asset-side 在悬停时覆盖名字文字。
    // 行容器自身的 onClick 就是 setSelectedAssetId，直接派发 click 即真实交互路径。
    const assetRow = page.locator(".asset-row").filter({ hasText: setup.asset_name }).first();
    await expect(assetRow).toBeVisible({ timeout: 30_000 });
    await assetRow.dispatchEvent("click");
    await expect(assetRow).toHaveClass(/sel/, { timeout: 15_000 });

    // 兜底：关掉任何意外残留的模态，否则菜单点击会被 modal-backdrop 吃掉。
    for (let attempt = 0; attempt < 5 && await page.locator(".modal-backdrop").count(); attempt += 1) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
    await expect(page.locator(".modal-backdrop")).toHaveCount(0, { timeout: 10_000 });

    // ── 1. 工具菜单入口 ────────────────────────────────────────────────
    await page.getByRole("button", { name: "工具", exact: true }).click();
    const menuItem = page.getByRole("menuitem", { name: "关键帧外传审阅" });
    await expect(menuItem).toBeEnabled();
    await menuItem.click();
    const dialog = page.getByRole("dialog", { name: "关键帧外传审阅" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    // D4 的第三条约束：界面不得用「抽样关键帧」暗示低风险
    await expect(dialog.getByText(/这不是匿名化/)).toBeVisible();
    await expect(dialog.getByText(/素材：/)).toBeVisible();

    // ── 2. 准备预览 → 逐帧列表出现 ────────────────────────────────────
    const providerSelect = dialog.getByLabel("接收关键帧的 Provider");
    await expect(providerSelect).toBeEnabled({ timeout: 15_000 });
    await dialog.getByRole("button", { name: /生成关键帧预览/ }).click();

    const list = dialog.locator(".keyframe-frame-list");
    try {
      await expect(list).toBeVisible({ timeout: 90_000 });
    } catch {
      // 预览没出现时把 Core 的真实报错带出来（面板只显示稳定文案，会吞掉原因）。
      const direct = await page.evaluate(async (input: { pid: string; aid: string; provider: string }) => {
        try {
          return { ok: true, value: await window.desktop.prepareKeyframePreview({
            project_id: input.pid as never, asset_id: input.aid as never, provider_config_id: input.provider
          }) };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      }, { pid: setup.project_id, aid: setup.asset_id, provider: setup.provider_id });
      const alert = await dialog.locator('[role="alert"]').innerText().catch(() => "");
      throw new Error("关键帧预览未生成（D4 第一步就不成立）。面板文案=" + JSON.stringify(alert)
        + "；直调 prepareKeyframePreview=" + JSON.stringify(direct)
        + "；Core 侧根因见 user-data/logs/desktop.log");
    }
    const frameCount = await list.locator(".keyframe-frame").count();
    await page.screenshot({ path: join(run, "10-keyframe-preview.png"), fullPage: true });
    // 3s 素材按默认 2s 间隔抽样 ⇒ 至少 2 帧；「每张都可见」要求逐行渲染而不是汇总
    expect(frameCount).toBeGreaterThanOrEqual(2);
    await expect(list.locator(".keyframe-frame")).toHaveCount(frameCount);

    // 每行都有序号 + 时间码 + 尺寸·实测字节（不是「共 N 张」的汇总敷衍）
    for (let index = 0; index < frameCount; index += 1) {
      const rowText = (await list.locator(".keyframe-frame").nth(index).innerText()).replace(/\s+/g, " ").trim();
      expect(rowText).toMatch(/#\d+/);
      expect(rowText).toMatch(/\d+:\d{2}\.\d{2}/);
      expect(rowText).toMatch(/\d+×\d+ · [\d.]+ (B|KB|MB)/);
    }

    // ── 3. 未勾选 ⇒ 「确认外传」禁用 ──────────────────────────────────
    const confirm = dialog.getByRole("button", { name: "确认外传" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/我已逐张审阅/).check();
    await expect(confirm).toBeEnabled();
    await dialog.getByLabel(/我已逐张审阅/).uncheck();
    await expect(confirm).toBeDisabled();

    // ── 4. 移除某一帧 ⇒ 该帧标记已移除 ────────────────────────────────
    const targetFrame = 1;
    const dbPath = await findAppDb(userData);
    expect(dbPath).not.toBe("");
    const before = readServerExclusion(dbPath, setup.project_id);
    expect(before.excluded).toEqual([]);

    await dialog.getByRole("button", { name: "移除第 1 帧" }).click();
    await expect(dialog.getByRole("button", { name: "第 1 帧已移除" })).toBeVisible({ timeout: 60_000 });
    await expect(list.locator(".keyframe-frame").nth(targetFrame)).toHaveClass(/excluded/);
    // 载荷变了 ⇒ 之前的「我确认过」自动失效（同意不能跨载荷继承）
    await expect(dialog.getByLabel(/我已逐张审阅/)).not.toBeChecked();
    await expect(confirm).toBeDisabled();
    const remainingText = (await dialog.getByText(/将外传/).first().innerText()).replace(/\s+/g, " ").trim();
    expect(remainingText).toContain(String(frameCount - 1));
    await page.screenshot({ path: join(run, "20-keyframe-excluded.png"), fullPage: true });

    // ── 5. 服务端状态真的变了（读 app.db，不读 UI）────────────────────
    const after = readServerExclusion(dbPath, setup.project_id);
    expect(after.previewId).toBe(before.previewId);      // 仍是同一份预览，不是新造的
    expect(after.excluded).toEqual([targetFrame]);        // 排除集合落库了
    expect(after.sha).not.toBe(before.sha);               // 载荷哈希随移除重算
    expect(after.sha).toMatch(/^[0-9a-f]{64}$/);

    // 再换一帧也会累加（只增不改：已排除的不会被「取消排除」悄悄复活）
    await dialog.getByRole("button", { name: "移除第 2 帧" }).click().catch(() => undefined);
    if (frameCount > 2) {
      await expect(dialog.getByRole("button", { name: "第 2 帧已移除" })).toBeVisible({ timeout: 60_000 });
      const accumulated = readServerExclusion(dbPath, setup.project_id);
      expect(accumulated.excluded).toEqual([1, 2]);
    }

    // ── 6. 关掉面板重开：新预览必须从「未勾选」开始，且确认按钮禁用 ────
    await dialog.getByRole("button", { name: "关闭关键帧外传审阅" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "关键帧外传审阅" }).click();
    const reopened = page.getByRole("dialog", { name: "关键帧外传审阅" });
    await expect(reopened).toBeVisible({ timeout: 15_000 });
    await expect(reopened.getByRole("button", { name: "确认外传" })).toBeDisabled();
    await expect(reopened.locator(".keyframe-frame-list")).toHaveCount(0);
    await page.screenshot({ path: join(run, "30-keyframe-reopened.png"), fullPage: true });

    console.log("[W3.3] 帧数=" + frameCount + "；移除帧=" + targetFrame
      + "；DB excluded 前=" + JSON.stringify(before.excluded) + " 后=" + JSON.stringify(after.excluded)
      + "；payload_sha256 " + before.sha.slice(0, 12) + " → " + after.sha.slice(0, 12)
      + "；预览 id 未变=" + before.previewId);
  } finally {
    await app.close().catch(() => undefined);
  }
});
