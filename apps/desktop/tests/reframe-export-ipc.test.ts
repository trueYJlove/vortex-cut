import { describe, expect, it, vi } from "vitest";
import { registerReframeExportIpc } from "../electron/main/ipc/reframe-export-ipc.js";

const now = "2026-08-18T00:00:00.000Z";
const hash = "a".repeat(64);
const mediaInfo = { duration_us: 1_000_000, format_name: "mp4", video: { codec: "h264", width: 1080, height: 1920, pixel_format: "yuv420p", fps_num: 30, fps_den: 1 }, audio: { codec: "aac", sample_rate: 48_000, channels: 2 } };
const preview = { rendition_reframe_snapshot_id: "rendition_reframe_snapshot_1", project_id: "project_1", timeline_revision_id: "revision_1", base_rendition_snapshot_id: "rendition_snapshot_1", base_snapshot_sha256: hash, platform_preset_id: "douyin", rendition_preset_id: "portrait-9x16-v1", adjustment_count: 1, reframe_snapshot_sha256: hash, warnings: ["STATIC_REFRAME_APPLIED"], created_at: now, render_artifact_id: "artifact_1", status: "ready", profile_id: "preview-portrait-9x16-v1", display_name: "preview.mp4", size_bytes: 10, sha256: hash, media_info: mediaInfo, encoder: "libx264", fallback_reason: null };

type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
function setup() {
  const handlers = new Map<string, Handler>();
  const fetchWithUi = vi.fn();
  const previewPresentation = vi.fn(async (safePreview: typeof preview) => ({ preview: safePreview, media_url: "aivideo://media/restricted-ticket" }));
  registerReframeExportIpc({ ipc: { handle: (channel, listener) => handlers.set(channel, listener) }, fetchWithUi, previewPresentation: previewPresentation as never });
  return { handlers, fetchWithUi, previewPresentation };
}

describe("Stage 3B Reframe IPC", () => {
  it("只注册七个独立白名单 channel", () => {
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual(["reframe-preview:create", "reframe-preview:list", "reframe-export-batch:create", "reframe-export-batch:get", "reframe-export-batch:list", "reframe-export-batch:cancel", "reframe-export-batch:retry"]);
  });

  it("严格转发 Preview 请求，先裁剪路径并只返回受限媒体 ticket", async () => {
    const { handlers, fetchWithUi, previewPresentation } = setup();
    fetchWithUi.mockResolvedValue({ job: null, preview: { ...preview, path: "C:\\private\\preview.mp4", uri: "file:///private.mp4" }, reused: true });
    const result = await handlers.get("reframe-preview:create")?.({}, { project_id: "project_1", preview: { base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: [{ clip_id: "clip_1", horizontal_anchor: "left", vertical_anchor: "top" }] } });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/rendition-reframe-previews", { method: "POST", body: JSON.stringify({ base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: [{ clip_id: "clip_1", horizontal_anchor: "left", vertical_anchor: "top" }] }) });
    expect(previewPresentation).toHaveBeenCalledWith(expect.not.objectContaining({ path: expect.anything(), uri: expect.anything() }));
    expect(result).toEqual({ job: null, preview: { preview, media_url: "aivideo://media/restricted-ticket" }, reused: true });
    expect(JSON.stringify(result)).not.toContain("C:\\private");
    expect(JSON.stringify(result)).not.toContain("file://");
  });

  it("拒绝 unknown、路径型字段、中心点、重复 Clip 和 Batch Revision", async () => {
    const { handlers, fetchWithUi } = setup();
    const validAdjustment = { clip_id: "clip_1", horizontal_anchor: "left", vertical_anchor: "top" };
    await expect(handlers.get("reframe-preview:create")?.({}, { project_id: "project_1", preview: { base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: [validAdjustment] }, extra: true })).rejects.toThrow();
    await expect(handlers.get("reframe-preview:create")?.({}, { project_id: "project_1", preview: { base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: [{ ...validAdjustment, path: "C:\\private" }] } })).rejects.toThrow();
    await expect(handlers.get("reframe-preview:create")?.({}, { project_id: "project_1", preview: { base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: [{ ...validAdjustment, horizontal_anchor: "center", vertical_anchor: "center" }] } })).rejects.toThrow();
    await expect(handlers.get("reframe-preview:create")?.({}, { project_id: "project_1", preview: { base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: [validAdjustment, validAdjustment] } })).rejects.toThrow();
    await expect(handlers.get("reframe-export-batch:create")?.({}, { project_id: "project_1", batch: { timeline_revision_id: "revision_1", directory_grant_id: "directory_1", items: [{ rendition_reframe_snapshot_id: "rendition_reframe_snapshot_1", preview_artifact_id: "artifact_1" }] } })).rejects.toThrow();
    expect(fetchWithUi).not.toHaveBeenCalled();
  });

  it("分页只接受 1–100 limit 和数字 cursor，并对列表逐项签发 ticket", async () => {
    const { handlers, fetchWithUi, previewPresentation } = setup();
    fetchWithUi.mockResolvedValue({ items: [preview], next_cursor: "20", path: "C:\\private" });
    await expect(handlers.get("reframe-preview:list")?.({}, { project_id: "project_1", limit: 20, cursor: "0" })).resolves.toEqual({ items: [{ preview, media_url: "aivideo://media/restricted-ticket" }], next_cursor: "20" });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/rendition-reframe-previews?limit=20&cursor=0");
    expect(previewPresentation).toHaveBeenCalledTimes(1);
    await expect(handlers.get("reframe-preview:list")?.({}, { project_id: "project_1", limit: 101 })).rejects.toThrow("Invalid limit");
    await expect(handlers.get("reframe-preview:list")?.({}, { project_id: "project_1", cursor: "../private" })).rejects.toThrow("Invalid cursor");
  });
});

