import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { DesktopSettingsStore } = await import("../electron/main/desktop-settings.js");
const { registerSettingsIpc } = await import("../electron/main/settings-ipc.js");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function root() { const value = await mkdtemp(join(tmpdir(), "aivideo-settings-ipc-")); roots.push(value); return value; }

type PlaybackDefaults = { preview_proxy_auto: boolean; preview_proxy_quality: "auto" | "540" | "720" | "1080" };

function setup(effective: ({ proxy_mode: "system" | "custom" | "direct"; provider_proxy: string | null } & Partial<PlaybackDefaults>) | null = null) {
  const dir = roots[roots.length - 1];
  const store = new DesktopSettingsStore(dir!);
  const handlers = new Map<string, (_event: unknown, input?: unknown) => unknown>();
  const restartCore = vi.fn().mockResolvedValue(undefined);
  registerSettingsIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
    store: () => store,
    effective: () => (effective ? { preview_proxy_auto: true, preview_proxy_quality: "auto", ...effective } : null),
    restartCore
  });
  return { handlers, store, restartCore };
}

describe("settings IPC (DESK-1/DESK-2)", () => {
  it("只注册冻结白名单 settings:get/set 与 core:restart", async () => {
    await root();
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual(["settings:get", "settings:set", "core:restart"]);
  });

  it("get 返回保存值与生效值两态；pending_restart 按差异判定", async () => {
    await root();
    const { handlers } = setup({ proxy_mode: "system", provider_proxy: null });
    type State = { saved: { proxy_mode: string; provider_proxy: string | null }; effective: { proxy_mode: string; provider_proxy: string | null } | null; pending_restart: boolean };
    let state = await handlers.get("settings:get")?.({}, undefined) as State;
    // 播放字段（preview_proxy_*）与代理三态同存于设置；这里断言代理两态与 pending_restart，
    // 播放字段由 desktop-settings.test.ts 单独覆盖。
    expect(state).toMatchObject({ saved: { proxy_mode: "system", provider_proxy: null }, effective: { proxy_mode: "system", provider_proxy: null }, pending_restart: false });
    await handlers.get("settings:set")?.({}, { proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" });
    state = await handlers.get("settings:get")?.({}, undefined) as State;
    expect(state.saved).toMatchObject({ proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" });
    expect(state.pending_restart).toBe(true);
  });

  it("生效值 null（内核未启动）时 pending_restart 恒 false", async () => {
    await root();
    const { handlers } = setup(null);
    await handlers.get("settings:set")?.({}, { proxy_mode: "direct", provider_proxy: null });
    const state = await handlers.get("settings:get")?.({}, undefined) as { pending_restart: boolean };
    expect(state.pending_restart).toBe(false);
  });

  it("set 往返持久化且拒绝非法输入（不落盘）", async () => {
    await root();
    const { handlers, store } = setup();
    await handlers.get("settings:set")?.({}, { proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" });
    expect(store.get()).toMatchObject({ proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" });
    await expect(handlers.get("settings:set")?.({}, { proxy_mode: "turbo", provider_proxy: null })).rejects.toThrow("Invalid proxy mode");
    await expect(handlers.get("settings:set")?.({}, { proxy_mode: "custom", provider_proxy: null })).rejects.toThrow("自定义代理需要有效地址");
    await expect(handlers.get("settings:set")?.({}, "not an object")).rejects.toThrow("Invalid settings input");
    expect(store.get()).toMatchObject({ proxy_mode: "custom", provider_proxy: "http://127.0.0.1:10809" });
  });

  it("core:restart 转发 restartCore 依赖", async () => {
    await root();
    const { handlers, restartCore } = setup();
    await handlers.get("core:restart")?.({}, undefined);
    expect(restartCore).toHaveBeenCalledTimes(1);
  });
});
