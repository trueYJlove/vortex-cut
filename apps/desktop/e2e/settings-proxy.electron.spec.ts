import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../../.."); const desktop = resolve(currentDir, "..");
const python = join(root, ".venv", "Scripts", "python.exe"); const resources = join(root, "resources");
const run = join(root, "test-results", "settings-proxy-e2e", `run-${process.pid}-${Date.now()}`);

interface ArgvEvidence { executable: string; args: string[]; cwd: string }

async function readArgvEvidence(userData: string): Promise<ArgvEvidence> {
  return JSON.parse(await readFile(join(userData, "sidecar-argv.json"), "utf8")) as ArgvEvidence;
}

test("设置流：持久化代理随 sidecar 启动透传，重启内核后生效两态翻转", async () => {
  test.setTimeout(300_000);
  const userData = join(run, "user-data");
  // 预置自定义代理设置——冷启动即应随 sidecar argv 透传给 Core（DESK-2 断点补全的端到端证明）。
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, "settings.v1.json"), JSON.stringify({ version: 1, proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" }), "utf8");
  const app = await electron.launch({
    args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`],
    cwd: desktop,
    env: { ...process.env, AIVS_RESOURCES_PATH: resources, AIVS_SIDECAR_EXECUTABLE: python, AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]), AIVS_E2E_SIDECAR_ARGV_EVIDENCE: join(userData, "sidecar-argv.json"), PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"), ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());

    // 1) 冷启动：argv 证据含 custom 双参数（Core 收到的即桌面设置）。
    const coldArgs = (await readArgvEvidence(userData)).args;
    expect(coldArgs[coldArgs.indexOf("--proxy-mode") + 1]).toBe("custom");
    expect(coldArgs[coldArgs.indexOf("--provider-proxy") + 1]).toBe("http://127.0.0.1:10809");

    // 2) settings:get 两态：生效=保存=custom，无待生效更改。
    const cold = await page.evaluate(() => window.desktop.getSettings());
    expect(cold.saved).toEqual({ proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" });
    expect(cold.effective).toEqual({ proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" });
    expect(cold.pending_restart).toBe(false);

    // 3) 保存 direct：pending_restart 翻转；设置 UI 状态行如实呈现（DESK-3）。
    const saved = await page.evaluate(() => window.desktop.setSettings({ proxy_mode: "direct", provider_proxy: null }));
    expect(saved).toEqual({ proxy_mode: "direct", provider_proxy: null });
    const pending = await page.evaluate(() => window.desktop.getSettings());
    expect(pending.saved.proxy_mode).toBe("direct");
    expect(pending.effective.proxy_mode).toBe("custom");
    expect(pending.pending_restart).toBe(true);
    // 打开「设置」：页脚 actions 同时存在「Provider 设置」与「设置」，按包含匹配
    // 扫描会先命中前者（打开的是 provider-settings-title，不是 settings-title）。
    // 这里按 role + 精确名称定位页脚那颗「应用设置」按钮（App.tsx:2697 → setSettingsOpen）。
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.locator("#settings-title")).toBeVisible({ timeout: 30_000 });
    // 重启前生效仍是 custom（保存的 direct 待重启生效）——两态行如实呈现差异。
    await expect(page.locator(".settings-effective")).toContainText("自定义代理 · http://127.0.0.1:10809");
    await expect(page.locator(".settings-effective")).toContainText("有已保存未生效的更改");

    // 4) 防御：custom+空 URL 被 IPC 拒绝且不落盘。
    await expect(page.evaluate(() => window.desktop.setSettings({ proxy_mode: "custom", provider_proxy: null }))).rejects.toThrow();
    expect((await page.evaluate(() => window.desktop.getSettings())).saved.proxy_mode).toBe("direct");

    // 5) 重启内核：新 sidecar argv 变为 direct；pending_restart 归零。
    await page.evaluate(() => window.desktop.restartCore());
    const deadline = Date.now() + 60_000;
    let restarted = false;
    while (Date.now() < deadline) {
      try {
        const fresh = await page.evaluate(() => window.desktop.getSettings());
        if (fresh.effective?.proxy_mode === "direct" && !fresh.pending_restart) { restarted = true; break; }
      } catch { /* 重启窗口期 IPC 可能短暂失败 */ }
      await page.waitForTimeout(500);
    }
    expect(restarted).toBe(true);
    const warmArgs = (await readArgvEvidence(userData)).args;
    expect(warmArgs[warmArgs.indexOf("--proxy-mode") + 1]).toBe("direct");
    expect(warmArgs).not.toContain("--provider-proxy");
  } finally { await app.close(); }
});
