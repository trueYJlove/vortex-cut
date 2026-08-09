import { isAbsolute, normalize, resolve } from "node:path";

export const RESTRICTED_MEDIA_SCHEME = "aivideo";

export class RestrictedMediaRegistry {
  private readonly paths = new Map<string, string>();

  register(assetId: string, inputPath: string): void {
    if (!isAbsolute(inputPath)) throw new Error("Restricted media paths must be absolute");
    this.paths.set(assetId, normalize(resolve(inputPath)));
  }

  remove(assetId: string): void { this.paths.delete(assetId); }
  resolve(assetId: string): string | undefined { return this.paths.get(assetId); }
  url(assetId: string): string { return `${RESTRICTED_MEDIA_SCHEME}://asset/${encodeURIComponent(assetId)}`; }
}

export function assetIdFromRestrictedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== `${RESTRICTED_MEDIA_SCHEME}:` || url.hostname !== "asset") return null;
    const id = decodeURIComponent(url.pathname.replace(/^\//, ""));
    return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
