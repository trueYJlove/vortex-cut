import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { RestrictedMediaRegistry, serveRestrictedMedia, ticketFromRestrictedUrl } from "../electron/main/restricted-media.js";

describe("restricted media protocol", () => {
  it("uses unpredictable short-lived opaque tickets and isolates purposes", () => {
    let now = 100;
    const registry = new RestrictedMediaRegistry(50, () => now);
    registry.register("asset_1", "C:\\media\\clip.mp4", "asset");
    registry.register("asset_1", "C:\\media\\preview.mp4", "proxy");
    const url = registry.issue("asset_1", "asset");
    expect(url).toMatch(/^aivideo:\/\/media\/[A-Za-z0-9_-]{32,}$/);
    expect(url).not.toContain("asset_1");
    expect(ticketFromRestrictedUrl(url)).not.toBeNull();
    expect(registry.resolveUrl(url, "asset")?.path).toContain("clip.mp4");
    expect(registry.resolveUrl(url, "proxy")).toBeUndefined();
    now = 151;
    expect(registry.resolveUrl(url)).toBeUndefined();
    expect(registry.resolveUrl("aivideo://media/../../private")).toBeUndefined();
  });

  it("accepts derived-media cache keys (sha256:<hex>) as entity ids and still rejects malformed ones", () => {
    const registry = new RestrictedMediaRegistry();
    // B10/B14/B15 派生媒体键带 "sha256:" 前缀（core derived_cache_key 格式）。
    const cacheKey = `sha256:${"a".repeat(64)}`;
    registry.register(cacheKey, "C:\\media\\derived.bin", "proxy");
    expect(registry.registeredPath(cacheKey, "proxy")).toContain("derived.bin");
    expect(registry.issue(cacheKey, "proxy")).toMatch(/^aivideo:\/\/media\//);
    // 冒号后非法（路径分隔符/点/空串/超长）仍然严拒。
    expect(() => registry.register("sha256:", "C:\\media\\x.bin", "proxy")).toThrow();
    expect(() => registry.register("sha256:../evil", "C:\\media\\x.bin", "proxy")).toThrow();
    expect(() => registry.register("sha256:zzzz!", "C:\\media\\x.bin", "proxy")).toThrow();
    expect(() => registry.register("../evil", "C:\\media\\x.bin", "proxy")).toThrow();
  });

  it("serves GET, HEAD and byte ranges while rejecting unsupported methods", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aivideo-ticket-"));
    const path = join(dir, "clip.bin");
    await writeFile(path, Buffer.from("0123456789"));
    const registry = new RestrictedMediaRegistry();
    registry.register("asset_1", path);
    const url = registry.issue("asset_1");
    const head = await serveRestrictedMedia(new Request(url, { method: "HEAD" }), registry);
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe("10");
    const range = await serveRestrictedMedia(new Request(url, { headers: { Range: "bytes=2-5" } }), registry);
    expect(range.status).toBe(206); expect(await range.text()).toBe("2345"); expect(range.headers.get("content-range")).toBe("bytes 2-5/10");
    const suffix = await serveRestrictedMedia(new Request(url, { headers: { Range: "bytes=-4" } }), registry);
    expect(suffix.status).toBe(206); expect(await suffix.text()).toBe("6789"); expect(suffix.headers.get("content-range")).toBe("bytes 6-9/10");
    expect((await serveRestrictedMedia(new Request(url, { method: "POST" }), registry)).status).toBe(403);
  });

  it("rejects unknown, expired, directory and invalid range requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aivideo-ticket-reject-"));
    const path = join(dir, "clip.bin");
    await writeFile(path, Buffer.from("0123456789"));
    let now = 100;
    const registry = new RestrictedMediaRegistry(50, () => now);
    registry.register("file", path);
    registry.register("directory", dir);
    const fileUrl = registry.issue("file");
    const directoryUrl = registry.issue("directory");
    expect((await serveRestrictedMedia(new Request("aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH"), registry)).status).toBe(404);
    expect((await serveRestrictedMedia(new Request(directoryUrl), registry)).status).toBe(403);
    for (const range of ["items=0-1", "bytes=20-30", "bytes=8-2", "bytes=-0", "bytes=1-2,4-5"]) {
      const response = await serveRestrictedMedia(new Request(fileUrl, { headers: { Range: range } }), registry);
      expect(response.status, range).toBe(416);
      expect(response.headers.get("content-range"), range).toBe("bytes */10");
    }
    now = 151;
    expect((await serveRestrictedMedia(new Request(fileUrl), registry)).status).toBe(404);
  });
});
