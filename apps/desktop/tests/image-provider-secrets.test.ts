import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const safe = {
  available: true,
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
  decryptString: vi.fn((value: Buffer) => value.toString().replace(/^encrypted:/, "")),
};
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => safe.available,
    encryptString: safe.encryptString,
    decryptString: safe.decryptString,
  },
}));

const {
  ImageProviderSecretStore, reinjectImageProviderSecrets, removeImageProviderSecret, saveImageProviderSecret,
} = await import("../electron/main/image-provider-secrets.js");
const roots: string[] = [];
afterEach(async () => {
  safe.available = true;
  safe.encryptString.mockClear();
  safe.decryptString.mockClear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function root() { const value = await mkdtemp(join(tmpdir(), "aivideo-image-secret-")); roots.push(value); return value; }

describe("ImageProviderSecretStore", () => {
  it("使用独立文件名、只持久化 OS 密文，并支持重启重注入", async () => {
    const directory = await root();
    const sentinel = "SENTINEL-IMAGE-KEY-NEVER-PERSIST";
    const store = new ImageProviderSecretStore(directory);
    expect(store.filePathForTest()).toBe(join(directory, "image-provider-secrets.v1.json"));
    expect(basename(store.filePathForTest())).not.toBe("provider-secrets.v1.json");
    await store.set("image_provider_1", sentinel);
    const raw = await readFile(store.filePathForTest(), "utf8");
    expect(raw).not.toContain(sentinel);
    expect(raw).toContain("image_provider_1");
    const restarted = new ImageProviderSecretStore(directory);
    const admin = { setImageProviderSecret: vi.fn().mockResolvedValue(undefined) };
    expect(await reinjectImageProviderSecrets(restarted, admin)).toBe(1);
    expect(admin.setImageProviderSecret).toHaveBeenCalledWith("image_provider_1", sentinel);
  });

  it("safeStorage 不可用时 fail closed，不落盘也不调用 Core admin", async () => {
    const directory = await root(); safe.available = false;
    const store = new ImageProviderSecretStore(directory);
    const admin = { setImageProviderSecret: vi.fn(), deleteImageProviderSecret: vi.fn() };
    await expect(saveImageProviderSecret(store, admin, "image_provider_1", "sentinel")).rejects.toThrow("系统安全存储不可用");
    await expect(removeImageProviderSecret(store, admin, "image_provider_1")).rejects.toThrow("系统安全存储不可用");
    expect(admin.setImageProviderSecret).not.toHaveBeenCalled();
    expect(admin.deleteImageProviderSecret).not.toHaveBeenCalled();
    await expect(readFile(store.filePathForTest(), "utf8")).rejects.toThrow();
  });

  it("Core 保存失败时恢复旧密文，新建失败时删除新密文", async () => {
    const directory = await root();
    const store = new ImageProviderSecretStore(directory);
    await store.set("image_provider_1", "old-secret");
    const failing = { setImageProviderSecret: vi.fn().mockRejectedValue(new Error("core unavailable")) };
    await expect(saveImageProviderSecret(store, failing, "image_provider_1", "new-secret")).rejects.toThrow("core unavailable");
    expect(await store.load()).toEqual([{ provider_config_id: "image_provider_1", secret: "old-secret" }]);
    await expect(saveImageProviderSecret(store, failing, "image_provider_2", "new-secret-2")).rejects.toThrow("core unavailable");
    expect(await store.load()).toEqual([{ provider_config_id: "image_provider_1", secret: "old-secret" }]);
    expect(await readFile(store.filePathForTest(), "utf8")).not.toContain("new-secret");
  });

  it("删除严格先成功清除 Core，再移除本地密文", async () => {
    const directory = await root();
    const store = new ImageProviderSecretStore(directory);
    await store.set("image_provider_1", "secret");
    const events: string[] = [];
    const admin = { deleteImageProviderSecret: vi.fn(async () => { events.push("core"); }) };
    const originalDelete = store.delete.bind(store);
    store.delete = vi.fn(async id => { events.push("local"); await originalDelete(id); });
    await removeImageProviderSecret(store, admin, "image_provider_1");
    expect(events).toEqual(["core", "local"]);
    expect(await store.load()).toEqual([]);
  });

  it("重注入隔离单项失败且返回值和错误不回显凭据", async () => {
    const directory = await root();
    const store = new ImageProviderSecretStore(directory);
    await store.set("image_provider_1", "secret-one");
    await store.set("image_provider_2", "secret-two");
    const admin = { setImageProviderSecret: vi.fn(async (id: string) => { if (id === "image_provider_1") throw new Error("reject"); }) };
    expect(await reinjectImageProviderSecrets(store, admin)).toBe(1);
    expect(JSON.stringify(admin.setImageProviderSecret.mock.results.map(item => item.type))).not.toContain("secret-");
  });
});
