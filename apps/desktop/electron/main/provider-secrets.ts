import { safeStorage } from "electron";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

interface StoredSecret { provider_config_id: string; ciphertext: string; }
interface SecretFile { version: 1; secrets: StoredSecret[]; }

export interface ProviderSecretAdmin {
  setProviderSecret(providerConfigId: string, secret: string): Promise<unknown>;
  deleteProviderSecret(providerConfigId: string): Promise<unknown>;
}

/** Persisted credential material is always OS-encrypted. Errors intentionally omit values. */
export class ProviderSecretStore {
  private readonly memory = new Map<string, string>();
  private readonly file: string;
  constructor(userData: string) { this.file = join(userData, "provider-secrets.v1.json"); }

  filePathForTest(): string { return this.file; }

  available(): boolean { return safeStorage.isEncryptionAvailable(); }
  async set(providerConfigId: string, secret: string): Promise<void> {
    if (!isId(providerConfigId) || !isSecret(secret)) throw new Error("凭据输入无效");
    this.memory.set(providerConfigId, secret);
    if (!this.available()) return;
    const data = await this.read();
    const ciphertext = safeStorage.encryptString(secret).toString("base64");
    const secrets = data.secrets.filter(item => item.provider_config_id !== providerConfigId);
    secrets.push({ provider_config_id: providerConfigId, ciphertext });
    await this.write({ version: 1, secrets });
  }
  async delete(providerConfigId: string): Promise<void> {
    if (!isId(providerConfigId)) throw new Error("Provider 标识无效");
    this.memory.delete(providerConfigId);
    if (!this.available()) return;
    const data = await this.read();
    await this.write({ version: 1, secrets: data.secrets.filter(item => item.provider_config_id !== providerConfigId) });
  }
  async load(): Promise<Array<{ provider_config_id: string; secret: string }>> {
    if (!this.available()) return [];
    const data = await this.read(); const result: Array<{ provider_config_id: string; secret: string }> = [];
    for (const item of data.secrets) {
      try { result.push({ provider_config_id: item.provider_config_id, secret: safeStorage.decryptString(Buffer.from(item.ciphertext, "base64")) }); }
      catch { /* corrupt/encryption-unavailable entries must never be surfaced */ }
    }
    return result;
  }
  private async read(): Promise<SecretFile> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!raw || typeof raw !== "object" || (raw as SecretFile).version !== 1 || !Array.isArray((raw as SecretFile).secrets)) return { version: 1, secrets: [] };
      const secrets = (raw as SecretFile).secrets.filter(item => item && isId(item.provider_config_id) && typeof item.ciphertext === "string" && /^[A-Za-z0-9+/]+=*$/.test(item.ciphertext));
      return { version: 1, secrets };
    } catch { return { version: 1, secrets: [] }; }
  }
  private async write(value: SecretFile): Promise<void> {
    const temporary = `${this.file}.${process.pid}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try { handle = await open(temporary, "w", 0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = undefined; await rename(temporary, this.file); }
    finally { await handle?.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
  }
}

/** Rehydrates Core's memory-only vault after its sidecar restarts. Values never leave Main. */
export async function reinjectProviderSecrets(store: ProviderSecretStore, admin: Pick<ProviderSecretAdmin, "setProviderSecret">): Promise<number> {
  const entries = await store.load();
  let injected = 0;
  for (const entry of entries) {
    try { await admin.setProviderSecret(entry.provider_config_id, entry.secret); injected += 1; }
    catch { /* one unavailable provider must not disclose or block other credentials */ }
  }
  return injected;
}

/** Main-only IPC operation: persist first, then mirror the value into Core's volatile vault. */
export async function saveProviderSecret(store: ProviderSecretStore, admin: Pick<ProviderSecretAdmin, "setProviderSecret">, providerConfigId: string, secret: string): Promise<void> {
  await store.set(providerConfigId, secret);
  await admin.setProviderSecret(providerConfigId, secret);
}

/** Main-only IPC operation: remove the encrypted entry and Core's volatile copy together. */
export async function removeProviderSecret(store: ProviderSecretStore, admin: Pick<ProviderSecretAdmin, "deleteProviderSecret">, providerConfigId: string): Promise<void> {
  await store.delete(providerConfigId);
  await admin.deleteProviderSecret(providerConfigId);
}
function isId(value: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function isSecret(value: string): boolean { return value.length > 0 && value.length <= 16_384; }
