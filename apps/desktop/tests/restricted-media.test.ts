import { describe, expect, it } from "vitest";
import { assetIdFromRestrictedUrl, RestrictedMediaRegistry } from "../electron/main/restricted-media.js";

describe("restricted media protocol", () => {
  it("exposes only an asset id URL and keeps the path in the main-process registry", () => {
    const registry = new RestrictedMediaRegistry();
    registry.register("asset_1", "C:\\media\\clip.mp4");
    const url = registry.url("asset_1");
    expect(url).toBe("aivideo://asset/asset_1");
    expect(url).not.toContain("media");
    expect(assetIdFromRestrictedUrl(url)).toBe("asset_1");
    expect(registry.resolve("asset_1")).toContain("clip.mp4");
    expect(assetIdFromRestrictedUrl("file:///C:/media/clip.mp4")).toBeNull();
  });
});
