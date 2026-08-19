import { safeStorage } from "electron";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

interface StoredSecret { provider_config_id: string; ciphertext: string; }
interface SecretFile { version: 1; secrets: StoredSecret[]; }

export interface ImageProviderSecretAdmin {
  setImageProviderSecret(providerConfigId: string, secret: string): Promise<unknown>;
  deleteImageProviderSecret(providerConfigId: string): Promise<unknown>;
}

/** Stage 4D credentials use an independent OS-encrypted namespace. */
export class ImageProviderSecretStore {
  private readonly file: string;
  constructor(userData: string) { this.file = join(userData, "image-provider-secrets.v1.json"); }
  filePathForTest(): string { return this.file; }
  available(): boolean { return safeStorage.isEncryptionAvailable(); }
  async set(providerConfigId: string, secret: string): Promise<void> {
    if (!isId(providerConfigId) || !isSecret(secret)) throw new Error("凭据输入无效");
    if (!this.available()) throw new Error("系统安全存储不可用");
    const data = await this.read();
    const ciphertext = safeStorage.encryptString(secret).toString("base64");
    const secrets = data.secrets.filter(item => item.provider_config_id !== providerConfigId);
    secrets.push({ provider_config_id: providerConfigId, ciphertext });
    await this.write({ version: 1, secrets });
  }
  async delete(providerConfigId: string): Promise<void> {
    if (!isId(providerConfigId)) throw new Error("Provider 标识无效");
    if (!this.available()) throw new Error("系统安全存储不可用");
    const data = await this.read();
    await this.write({ version: 1, secrets: data.secrets.filter(item => item.provider_config_id !== providerConfigId) });
  }
  async load(): Promise<Array<{ provider_config_id: string; secret: string }>> {
    if (!this.available()) return [];
    const data = await this.read();
    const result: Array<{ provider_config_id: string; secret: string }> = [];
    for (const item of data.secrets) {
      try { result.push({ provider_config_id: item.provider_config_id, secret: safeStorage.decryptString(Buffer.from(item.ciphertext, "base64")) }); }
      catch { /* corrupt entries stay Main-only and are ignored */ }
    }
    return result;
  }
  private async read(): Promise<SecretFile> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!raw || typeof raw !== "object" || (raw as SecretFile).version !== 1 || !Array.isArray((raw as SecretFile).secrets)) return { version: 1, secrets: [] };
      return { version: 1, secrets: (raw as SecretFile).secrets.filter(item => item && isId(item.provider_config_id) && typeof item.ciphertext === "string" && /^[A-Za-z0-9+/]+=*$/.test(item.ciphertext)) };
    } catch { return { version: 1, secrets: [] }; }
  }
  private async write(value: SecretFile): Promise<void> {
    const temporary = `${this.file}.${process.pid}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "w", 0o600);
      await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = undefined;
      await rename(temporary, this.file);
    } finally { await handle?.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
  }
}

export async function reinjectImageProviderSecrets(store: ImageProviderSecretStore, admin: Pick<ImageProviderSecretAdmin, "setImageProviderSecret">): Promise<number> {
  let injected = 0;
  for (const entry of await store.load()) {
    try { await admin.setImageProviderSecret(entry.provider_config_id, entry.secret); injected += 1; }
    catch { /* one invalid config must not expose or block other credentials */ }
  }
  return injected;
}
export async function saveImageProviderSecret(store: ImageProviderSecretStore, admin: Pick<ImageProviderSecretAdmin, "setImageProviderSecret">, providerConfigId: string, secret: string): Promise<void> {
  const previous = (await store.load()).find(entry => entry.provider_config_id === providerConfigId)?.secret;
  await store.set(providerConfigId, secret);
  try {
    await admin.setImageProviderSecret(providerConfigId, secret);
  } catch (error) {
    try {
      if (previous === undefined) await store.delete(providerConfigId);
      else await store.set(providerConfigId, previous);
    } catch {
      throw new Error("图片 Provider 凭据保存失败，且本地密文回滚失败");
    }
    throw error;
  }
}
export async function removeImageProviderSecret(store: ImageProviderSecretStore, admin: Pick<ImageProviderSecretAdmin, "deleteImageProviderSecret">, providerConfigId: string): Promise<void> {
  if (!store.available()) throw new Error("系统安全存储不可用");
  await admin.deleteImageProviderSecret(providerConfigId);
  await store.delete(providerConfigId);
}
function isId(value: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function isSecret(value: string): boolean { return value.length > 0 && value.length <= 16_384; }
