import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export type ProxyMode = "system" | "custom" | "direct";

export interface DesktopSettings {
  proxy_mode: ProxyMode;
  provider_proxy: string | null;
}

/** Settings IPC payload: saved vs. currently-effective values (restart-to-apply). */
export interface SettingsState {
  saved: DesktopSettings;
  effective: DesktopSettings | null;
  pending_restart: boolean;
}

interface SettingsFile { version: 1; proxy_mode?: unknown; provider_proxy?: unknown; }

export const DEFAULT_SETTINGS: DesktopSettings = { proxy_mode: "system", provider_proxy: null };

const PROXY_MODES: readonly string[] = ["system", "custom", "direct"];
// Core 侧 provider_proxy 是自由 URL 字符串（str | None），http/https 均合法；
// 这里只做形态防御（scheme://host:port），深校验交给连接测试。
const PROXY_PATTERN = /^https?:\/\/[A-Za-z0-9._\-]+(:\d{1,5})?(\/.*)?$/;

function isProxyMode(value: unknown): value is ProxyMode {
  return typeof value === "string" && PROXY_MODES.includes(value);
}

/**
 * Plain-JSON desktop settings (never credentials — those live in
 * ProviderSecretStore). Corrupt file or unknown fields degrade to defaults so
 * a broken settings file can never block app start ("代理是优化不是依赖").
 */
export class DesktopSettingsStore {
  private readonly file: string;
  constructor(userData: string) { this.file = join(userData, "settings.v1.json"); }

  filePathForTest(): string { return this.file; }

  get(): DesktopSettings {
    let raw: unknown;
    try { raw = JSON.parse(readFileSyncUtf8(this.file)); } catch { return { ...DEFAULT_SETTINGS }; }
    return normalize(raw);
  }

  async set(settings: DesktopSettings): Promise<void> {
    // IPC 层防御：custom 必须带合法 URL（UI 已校验；normalize 会把不合法
    // 输入静默降级为 system，这里在降级之前拒绝）。
    if (settings.proxy_mode === "custom" && !(typeof settings.provider_proxy === "string" && PROXY_PATTERN.test(settings.provider_proxy))) {
      throw new Error("自定义代理需要有效地址");
    }
    const normalized = normalize(settings);
    const temporary = `${this.file}.${process.pid}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try { handle = await open(temporary, "w", 0o600); await handle.writeFile(JSON.stringify({ version: 1, ...normalized })); await handle.sync(); await handle.close(); handle = undefined; await rename(temporary, this.file); }
    finally { await handle?.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
  }
}

/** Unknown modes/URL shapes fall back to defaults instead of failing the read. */
export function normalize(raw: unknown): DesktopSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const value = raw as SettingsFile;
  // custom + 无合法 URL 一并回退默认——绝不让 Core 以 custom 模式空地址启动
  //（Core 侧 custom+空 会静默直连，UI 显示与实际生效将不一致）。
  if (value.proxy_mode === "custom") {
    const url = typeof value.provider_proxy === "string" && PROXY_PATTERN.test(value.provider_proxy) ? value.provider_proxy : null;
    return url ? { proxy_mode: "custom", provider_proxy: url } : { ...DEFAULT_SETTINGS };
  }
  const proxy_mode = isProxyMode(value.proxy_mode) ? value.proxy_mode : DEFAULT_SETTINGS.proxy_mode;
  return { proxy_mode, provider_proxy: null };
}

function readFileSyncUtf8(file: string): string {
  // get() is called inside the synchronous app-ready sequence before the
  // supervisor is constructed; an async read would race the first launch.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  try { return readFileSync(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
