import { describe, expect, it, vi } from "vitest";
import { PreviewSourceResolver } from "../src/app/preview/source-resolver.js";
import type { PreviewSourceDescription } from "@aivideo/contracts";

const now = "2026-09-09T00:00:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;

function description(overrides: Partial<PreviewSourceDescription>): PreviewSourceDescription {
  return {
    source_id: "src_asset_1_preview-720-v1_original",
    mode: "original", status: "ready", job_id: null, cache_key: null,
    asset_fingerprint: hashA, profile_id: "preview-720-v1", duration_us: 12_000_000,
    source_origin_us: 0, fps_num: 30, fps_den: 1,
    coded_width: 1280, coded_height: 720, display_width: 1280, display_height: 720,
    rotation: 0, codec: "avc", size_bytes: 4096,
    ...overrides,
  };
}

describe("B11 PreviewSourceResolver", () => {
  it("代理 ready 时换代理票据（原源 URL 被替换）", async () => {
    const getPreviewSource = vi.fn().mockResolvedValue(description({
      source_id: "src_asset_1_preview-720-v1_proxy", mode: "proxy",
      cache_key: hashA, codec: "avc",
    }));
    const previewSourceMediaUrl = vi.fn().mockResolvedValue({
      media_url: "aivideo://media/proxy-ticket", cache_key: hashA, status: "ready", size_bytes: 4096,
    });
    const resolver = new PreviewSourceResolver({ getPreviewSource, previewSourceMediaUrl }, "project_1");
    const result = await resolver.resolve("asset_1", "aivideo://media/asset-ticket");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("aivideo://media/proxy-ticket");
    expect(result!.isProxy).toBe(true);
    expect(getPreviewSource).toHaveBeenCalledWith({ project_id: "project_1", asset_id: "asset_1", mode: "auto" });
    expect(previewSourceMediaUrl).toHaveBeenCalledWith({
      project_id: "project_1", asset_id: "asset_1", profile_id: "preview-720-v1",
    });
  });

  it("pending/unavailable/original 回退原源（返回 null，预览不阻塞）", async () => {
    for (const overrides of [
      { status: "pending" as const, mode: "proxy" as const, cache_key: hashA },
      { status: "unavailable" as const },
      { mode: "original" as const, status: "ready" as const },
    ]) {
      const getPreviewSource = vi.fn().mockResolvedValue(description(overrides));
      const previewSourceMediaUrl = vi.fn();
      const resolver = new PreviewSourceResolver({ getPreviewSource, previewSourceMediaUrl }, "project_1");
      const result = await resolver.resolve("asset_1", "aivideo://media/asset-ticket");
      expect(result).toBeNull();
      expect(previewSourceMediaUrl).not.toHaveBeenCalled();
    }
  });

  it("IPC 失败静默回退（B11 失败路径不阻塞预览）", async () => {
    const getPreviewSource = vi.fn().mockRejectedValue(new Error("DERIVED_NOT_FOUND"));
    const previewSourceMediaUrl = vi.fn();
    const resolver = new PreviewSourceResolver({ getPreviewSource, previewSourceMediaUrl }, "project_1");
    const result = await resolver.resolve("asset_1", "aivideo://media/asset-ticket");
    expect(result).toBeNull();
  });

  it("同素材并发共享一次解析（缓存）", async () => {
    const getPreviewSource = vi.fn().mockResolvedValue(description({ mode: "original" }));
    const resolver = new PreviewSourceResolver({ getPreviewSource, previewSourceMediaUrl: vi.fn() }, "project_1");
    const [a, b] = await Promise.all([
      resolver.resolve("asset_1", "orig"),
      resolver.resolve("asset_1", "orig"),
    ]);
    expect(getPreviewSource).toHaveBeenCalledTimes(1);
    expect(a).toBeNull();
    expect(b).toBeNull();
  });

  it("invalidate 清缓存后重新解析", async () => {
    const getPreviewSource = vi.fn()
      .mockResolvedValueOnce(description({ mode: "original" }))
      .mockResolvedValueOnce(description({
        source_id: "src_asset_1_preview-720-v1_proxy", mode: "proxy", cache_key: hashA,
      }));
    const previewSourceMediaUrl = vi.fn().mockResolvedValue({
      media_url: "aivideo://media/proxy-ticket", cache_key: hashA, status: "ready", size_bytes: 4096,
    });
    const resolver = new PreviewSourceResolver({ getPreviewSource, previewSourceMediaUrl }, "project_1");
    expect(await resolver.resolve("asset_1", "orig")).toBeNull();
    resolver.invalidate("asset_1");
    const result = await resolver.resolve("asset_1", "orig");
    expect(result?.isProxy).toBe(true);
    expect(getPreviewSource).toHaveBeenCalledTimes(2);
  });
});
