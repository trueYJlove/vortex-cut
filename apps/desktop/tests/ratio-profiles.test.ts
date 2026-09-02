// 验证新比例档位 profile_id 能通过契约校验（预览 + 导出）。
import { isAuthoritativePreview, isExportRecord } from "@aivideo/contracts";
import { describe, expect, it } from "vitest";

const now = "2026-09-02T00:00:00.000Z";
const hash = "a".repeat(64);
const mediaInfo = {
  duration_us: 5_000_000, format_name: "mov,mp4",
  video: { codec: "h264", width: 960, height: 540, pixel_format: "yuv420p", fps_num: 30, fps_den: 1 },
  audio: { codec: "aac", sample_rate: 48000, channels: 2 },
};

const ratios = ["169", "916", "11", "43", "34"] as const;

describe("ratio render profiles pass contract validation", () => {
  for (const ratio of ratios) {
    it(`preview-${ratio}-v1 is a valid authoritative preview`, () => {
      const preview = {
        render_artifact_id: "render_1", project_id: "project_1", timeline_revision_id: "revision_1",
        kind: "authoritative_preview", status: "ready", content_fingerprint: hash,
        profile_id: `preview-${ratio}-v1`, display_name: "preview.mp4", size_bytes: 10,
        sha256: hash, media_info: mediaInfo, encoder: "libx264", fallback_reason: null, created_at: now,
      };
      expect(isAuthoritativePreview(preview)).toBe(true);
    });

    it(`export-${ratio}-v1 is a valid export record`, () => {
      const record = {
        export_record_id: "export_1", project_id: "project_1", timeline_revision_id: "revision_1",
        render_artifact_id: "render_2", status: "succeeded", profile_id: `export-${ratio}-v1`,
        destination_display_name: "video.mp4", size_bytes: 10, sha256: hash,
        media_info: mediaInfo, encoder: "libx264", fallback_reason: null, created_at: now,
      };
      expect(isExportRecord(record)).toBe(true);
    });
  }
});
