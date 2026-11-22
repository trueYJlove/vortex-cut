import { describe, expect, it } from "vitest";
import type { Asset, TimelineTrack } from "@aivideo/contracts";
import { planAssetDrop } from "../src/app/timeline/asset-drop.js";

const asset = (id: string, kind: Asset["kind"], durationUs: number | null): Asset => ({
  asset_id: id as Asset["asset_id"], project_id: "project_1" as Asset["project_id"], kind,
  storage_mode: "external", display_name: id, fingerprint: `fp-${id}`, size_bytes: 1,
  modified_at: "2026-01-01T00:00:00.000Z", availability: "available",
  media_info: durationUs === null ? null : { duration_us: durationUs },
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
} as Asset);

const tracks = [
  { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
  { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
] as TimelineTrack[];

describe("asset drop planning", () => {
  it("plans Alt overwrite at the exact snapped time and lays selected assets end to end", () => {
    const operations = planAssetDrop(
      [asset("one", "video", 2_000_000), asset("two", "image", null)],
      tracks,
      0,
      "V1",
      { atUs: 1_500_000 },
    );
    expect(operations).toMatchObject([
      { op: "insert_asset_clip", asset_id: "one", track_id: "V1", timeline_start_us: 1_500_000, edit_mode: "overwrite" },
      { op: "insert_asset_clip", asset_id: "two", track_id: "V1", timeline_start_us: 3_500_000, duration_us: 3_000_000, edit_mode: "overwrite" },
    ]);
  });

  it("refuses overwrite when a media duration is unavailable", () => {
    expect(() => planAssetDrop([asset("unknown", "video", null)], tracks, 0, "V1", { atUs: 0 }))
      .toThrow(/准确时长/);
  });
});
