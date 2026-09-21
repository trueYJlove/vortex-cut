import type { DesktopSettings, DesktopSettingsStore, SettingsState } from "./desktop-settings.js";

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
    return { saved, effective, pending_restart: effective !== null && (effective.proxy_mode !== saved.proxy_mode || effective.provider_proxy !== saved.provider_proxy) };
  });
  deps.handle("settings:set", async (_event, input: unknown): Promise<DesktopSettings> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid settings input");
    const value = input as Partial<DesktopSettings>;
    if (value.proxy_mode !== undefined && !["system", "custom", "direct"].includes(value.proxy_mode)) throw new Error("Invalid proxy mode");
    await deps.store().set({ proxy_mode: value.proxy_mode ?? deps.store().get().proxy_mode, provider_proxy: value.provider_proxy ?? null });
    return deps.store().get();
  });
  deps.handle("core:restart", () => deps.restartCore());
}
