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
    expect(normalize({ version: 1, proxy_mode: "custom", provider_proxy: "https://p.test:8080" })).toMatchObject({ proxy_mode: "custom", provider_proxy: "https://p.test:8080" });
    expect(normalize({ version: 1, proxy_mode: "custom", provider_proxy: "not a url" })).toMatchObject({ proxy_mode: "system", provider_proxy: null });
    expect(normalize({ version: 1, proxy_mode: "direct", provider_proxy: "http://127.0.0.1:1" })).toMatchObject({ proxy_mode: "direct", provider_proxy: null });
  });

  it("set 持久化 system/custom/direct 并可往返读取", async () => {
    const dir = await root();
    const store = new DesktopSettingsStore(dir);
    await store.set({ proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" });
    expect(store.get()).toMatchObject({ proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" });
    await store.set({ proxy_mode: "direct", provider_proxy: null });
    expect(store.get()).toMatchObject({ proxy_mode: "direct", provider_proxy: null });
    await store.set({ proxy_mode: "system", provider_proxy: null });
    // 播放字段在旧调用点未给出时保留默认值，故用 matchObject 精确断言代理三态
    expect(store.get()).toMatchObject({ proxy_mode: DEFAULT_SETTINGS.proxy_mode, provider_proxy: null });
  });

  it("custom 模式缺地址被拒绝（防御：UI 已校验，IPC 层兜底）", async () => {
    const store = new DesktopSettingsStore(await root());
    await expect(store.set({ proxy_mode: "custom", provider_proxy: null })).rejects.toThrow("自定义代理需要有效地址");
  });

  it("播放设置默认开启、默认自动档，且旧文件缺字段时回落默认值", async () => {
    const dir = await root();
    const store = new DesktopSettingsStore(dir);
    // 全新安装：默认开代理 + 自动档位
    expect(store.get().preview_proxy_auto).toBe(true);
    expect(store.get().preview_proxy_quality).toBe("auto");
    // 旧版本配置文件（不含播放字段）能被读成默认值，而不是崩溃或丢设置
    await writeFile(join(dir, "settings.v1.json"), JSON.stringify({ version: 1, proxy_mode: "system", provider_proxy: null }), "utf8");
    expect(store.get()).toMatchObject({ preview_proxy_auto: true, preview_proxy_quality: "auto" });
  });

  it("播放设置可往返，且只改 proxy_mode 时不会重置播放偏好", async () => {
    const dir = await root();
    const store = new DesktopSettingsStore(dir);
    await store.set({ proxy_mode: "system", preview_proxy_auto: false, preview_proxy_quality: "540" });
    expect(store.get()).toMatchObject({ preview_proxy_auto: false, preview_proxy_quality: "540" });
    // 旧调用点只传代理模式：播放偏好必须保留
    await store.set({ proxy_mode: "direct" });
    expect(store.get()).toMatchObject({ proxy_mode: "direct", preview_proxy_auto: false, preview_proxy_quality: "540" });
  });

  it("非法播放档位回落默认，不因坏值让设置读失败", async () => {
    const dir = await root();
    await writeFile(join(dir, "settings.v1.json"), JSON.stringify({ version: 1, proxy_mode: "system", provider_proxy: null, preview_proxy_auto: "yes", preview_proxy_quality: "4k" }), "utf8");
    expect(new DesktopSettingsStore(dir).get()).toMatchObject({ preview_proxy_auto: true, preview_proxy_quality: "auto" });
  });

  it("持久化文件不含密钥字段（密钥只走 ProviderSecretStore）", async () => {
    const dir = await root();
    const store = new DesktopSettingsStore(dir);
    await store.set({ proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" });
    const raw = await readFile(join(dir, "settings.v1.json"), "utf8");
    expect(raw).not.toMatch(/secret|token|password|credential/i);
  });
});
