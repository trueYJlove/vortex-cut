import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { DesktopSettingsStore, DEFAULT_SETTINGS, normalize } = await import("../electron/main/desktop-settings.js");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function root() { const value = await mkdtemp(join(tmpdir(), "aivideo-desktop-settings-")); roots.push(value); return value; }

describe("DesktopSettingsStore", () => {
  it("缺文件回退默认值（system + 无地址）", async () => {
    const store = new DesktopSettingsStore(await root());
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("损坏 JSON 回退默认值而不是抛错——坏设置文件不能阻塞启动", async () => {
    const dir = await root();
    await writeFile(join(dir, "settings.v1.json"), "{not json", "utf8");
    expect(new DesktopSettingsStore(dir).get()).toEqual(DEFAULT_SETTINGS);
  });

  it("未知字段/非法模式/非法 URL 全部归一化为默认", () => {
    expect(normalize({ version: 1, proxy_mode: "turbo", provider_proxy: "ftp://x" })).toEqual(DEFAULT_SETTINGS);
    expect(normalize(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalize({ version: 1, proxy_mode: "custom", provider_proxy: "https://p.test:8080" })).toEqual({ proxy_mode: "custom", provider_proxy: "https://p.test:8080" });
    expect(normalize({ version: 1, proxy_mode: "custom", provider_proxy: "not a url" })).toEqual({ proxy_mode: "system", provider_proxy: null });
    expect(normalize({ version: 1, proxy_mode: "direct", provider_proxy: "http://127.0.0.1:1" })).toEqual({ proxy_mode: "direct", provider_proxy: null });
  });

  it("set 持久化 system/custom/direct 并可往返读取", async () => {
    const dir = await root();
    const store = new DesktopSettingsStore(dir);
    await store.set({ proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" });
    expect(store.get()).toEqual({ proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" });
    await store.set({ proxy_mode: "direct", provider_proxy: null });
    expect(store.get()).toEqual({ proxy_mode: "direct", provider_proxy: null });
    await store.set({ proxy_mode: "system", provider_proxy: null });
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("custom 模式缺地址被拒绝（防御：UI 已校验，IPC 层兜底）", async () => {
    const store = new DesktopSettingsStore(await root());
    await expect(store.set({ proxy_mode: "custom", provider_proxy: null })).rejects.toThrow("自定义代理需要有效地址");
  });

  it("持久化文件不含密钥字段（密钥只走 ProviderSecretStore）", async () => {
    const dir = await root();
    const store = new DesktopSettingsStore(dir);
    await store.set({ proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" });
    const raw = await readFile(join(dir, "settings.v1.json"), "utf8");
    expect(raw).not.toMatch(/secret|token|password|credential/i);
  });
});
