import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const safe = { available: true, encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)), decryptString: vi.fn((value: Buffer) => value.toString().replace(/^enc:/, "")) };
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => safe.available, encryptString: safe.encryptString, decryptString: safe.decryptString } }));

const { ProviderSecretStore, reinjectProviderSecrets, removeProviderSecret, saveProviderSecret } = await import("../electron/main/provider-secrets.js");
const roots: string[] = [];
afterEach(async () => { safe.available = true; safe.encryptString.mockClear(); safe.decryptString.mockClear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("ProviderSecretStore", () => {
  it("密文持久化、重启加载和删除均不回显哨兵", async () => {
    const root = await mkdtemp(join(tmpdir(), "aivideo-secret-")); roots.push(root); const sentinel = "SENTINEL-KEY-NEVER-LOG";
    const store = new ProviderSecretStore(root); await store.set("provider_1", sentinel);
    const raw = await readFile(store.filePathForTest(), "utf8"); expect(raw).not.toContain(sentinel); expect(raw).toContain("provider_1");
    const restarted = new ProviderSecretStore(root); expect(await restarted.load()).toEqual([{ provider_config_id: "provider_1", secret: sentinel }]);
    await restarted.delete("provider_1"); expect(await readFile(restarted.filePathForTest(), "utf8")).not.toContain("provider_1");
  });
  it("safeStorage 不可用时只保留进程内存，绝不落盘", async () => {
    const root = await mkdtemp(join(tmpdir(), "aivideo-secret-")); roots.push(root); safe.available = false;
    const store = new ProviderSecretStore(root); await store.set("provider_1", "SENTINEL-KEY-NEVER-LOG");
    await expect(readFile(store.filePathForTest(), "utf8")).rejects.toThrow(); expect(await new ProviderSecretStore(root).load()).toEqual([]);
  });
  it("与 Main 管理客户端协同：保存、重启重注入、连接测试与删除均不回显凭据", async () => {
    const root = await mkdtemp(join(tmpdir(), "aivideo-secret-")); roots.push(root); const sentinel = "SENTINEL-KEY-NEVER-LOG";
    const calls: Array<{ action: string; provider: string }> = []; let status: "missing" | "configured" = "missing";
    const admin = {
      setProviderSecret: vi.fn(async (provider: string, _secret: string) => { calls.push({ action: "set", provider }); status = "configured"; }),
      deleteProviderSecret: vi.fn(async (provider: string) => { calls.push({ action: "delete", provider }); status = "missing"; })
    };
    const store = new ProviderSecretStore(root);
    await saveProviderSecret(store, admin, "provider_1", sentinel);
    expect(status).toBe("configured");
    expect(await readFile(store.filePathForTest(), "utf8")).not.toContain(sentinel);
    const restarted = new ProviderSecretStore(root);
    expect(await reinjectProviderSecrets(restarted, admin)).toBe(1);
    expect(admin.setProviderSecret).toHaveBeenCalledTimes(2);
    // A Provider test sees only Core's credential state, never the key value.
    const connectionTest = vi.fn(async () => ({ credential_status: status, ok: status === "configured" }));
    expect(await connectionTest()).toEqual({ credential_status: "configured", ok: true });
    await removeProviderSecret(restarted, admin, "provider_1");
    expect(status).toBe("missing"); expect(calls).toEqual([{ action: "set", provider: "provider_1" }, { action: "set", provider: "provider_1" }, { action: "delete", provider: "provider_1" }]);
    const persisted = await readFile(restarted.filePathForTest(), "utf8"); expect(persisted).not.toContain("provider_1"); expect(persisted).not.toContain(sentinel);
  });
});
