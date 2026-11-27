import type { DesktopSettings, DesktopSettingsStore, SettingsState } from "../desktop-settings.js";

type IpcHandle = (channel: string, listener: (_event: unknown, input?: unknown) => unknown) => void;

export interface SettingsIpcDependencies {
  handle: IpcHandle;
  store: () => DesktopSettingsStore;
  /** 当前 sidecar 启动时的设置快照（null = 运行时尚未启动）。 */
  effective: () => DesktopSettings | null;
  restartCore: () => Promise<void>;
}

/**
 * DESK-1/DESK-2：桌面设置 IPC（Main-only 持久化，不经 Core HTTP）。
 * get 返回保存值与当前生效值两态——Core 启动时解析一次代理，重启内核前
 * 两者可不同；set 在写入前拒绝非法输入（store.normalize 兜底）。
 */
export function registerSettingsIpc(deps: SettingsIpcDependencies): void {
  deps.handle("settings:get", (): SettingsState => {
    const saved = deps.store().get();
    const effective = deps.effective();
    // 播放类设置即时生效（UI 每次登记代理时读取），不参与"需重启内核"判定；
    // 只有代理模式/地址是启动期解析的。
    return { saved, effective, pending_restart: effective !== null && (effective.proxy_mode !== saved.proxy_mode || effective.provider_proxy !== saved.provider_proxy) };
  });
  deps.handle("settings:set", async (_event, input: unknown): Promise<DesktopSettings> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid settings input");
    const value = input as Partial<DesktopSettings>;
    if (value.proxy_mode !== undefined && !["system", "custom", "direct"].includes(value.proxy_mode)) throw new Error("Invalid proxy mode");
    if (value.preview_proxy_quality !== undefined && !["auto", "540", "720", "1080"].includes(value.preview_proxy_quality)) throw new Error("Invalid preview proxy quality");
    if (value.preview_proxy_auto !== undefined && typeof value.preview_proxy_auto !== "boolean") throw new Error("Invalid preview proxy auto flag");
    const current = deps.store().get();
    await deps.store().set({
      proxy_mode: value.proxy_mode ?? current.proxy_mode,
      // provider_proxy 只在本次显式给出时更新：改播放设置不应清掉已保存的代理地址。
      provider_proxy: value.provider_proxy !== undefined ? value.provider_proxy : current.provider_proxy,
      preview_proxy_auto: value.preview_proxy_auto ?? current.preview_proxy_auto,
      preview_proxy_quality: value.preview_proxy_quality ?? current.preview_proxy_quality,
    });
    return deps.store().get();
  });
  deps.handle("core:restart", () => deps.restartCore());
}
