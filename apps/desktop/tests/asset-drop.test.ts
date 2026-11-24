import { describe, expect, it } from "vitest";
import type { Asset, TimelineTrack } from "@aivideo/contracts";
import { planAssetDrop, resolveTimelineAssetDropIntent } from "../src/app/timeline/asset-drop.js";

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
      { op: "insert_asset_clip", asset_id: "two", track_id: "V1", timeline_start_us: 3_500_000, duration_us: 4_000_000, edit_mode: "overwrite" },
    ]);
  });

  it("refuses overwrite when a media duration is unavailable", () => {
    expect(() => planAssetDrop([asset("unknown", "video", null)], tracks, 0, "V1", { atUs: 0 }))
      .toThrow(/准确时长/);
  });

  it("places a clip at the pointer time and opens a compatible track when Place would stack", () => {
    const clip = {
      clip_id: "existing" as never, track_id: "V1", order_index: 0,
      asset_id: "source" as never, asset_kind: "video" as const,
      source_start_us: 0, source_end_us: 3_000_000,
      timeline_start_us: 0, timeline_end_us: 3_000_000,
      layout: "fit" as const, audio: { enabled: true, gain_db: 0 },
    };
    const resolve = (pointerUs: number, assetKind: Asset["kind"] = "video", assetDurationUs = 2_000_000, clips = [clip]) =>
      resolveTimelineAssetDropIntent({
        hit: { trackId: "V1", band: "body", clipId: null, zone: null }, clips, tracks,
        assetKinds: [assetKind], assetDurationsUs: [assetDurationUs], itemCount: 1, canReplace: true,
        pointerUs, fpsNum: 30, fpsDen: 1, hasCoordinates: true,
      });
    const options = (intent: ReturnType<typeof resolve>) => ({
      intent, clips: [clip], linkageEnabled: true, fpsNum: 30, fpsDen: 1,
    });

    const place = resolve(5_000_000, "video", 2_000_000, []);
    expect(planAssetDrop([asset("placed", "video", 2_000_000)], tracks, place.slot, place.trackId ?? undefined, undefined, options(place)))
      .toMatchObject([{ op: "insert_asset_clip", asset_id: "placed", track_id: "V1", timeline_start_us: 5_000_000, edit_mode: "place", linkage_enabled: true }]);

    const conflict = resolve(1_000_000);
    expect(conflict).toMatchObject({ trackId: "new", newTrackKind: "video", newTrackAnchorId: "V1", newTrackSide: "before" });
    expect(planAssetDrop([asset("stacked", "video", 2_000_000)], tracks, conflict.slot, conflict.trackId ?? undefined, undefined, options(conflict)))
      .toMatchObject([
        { op: "add_track", kind: "video", track_id: "V2", before_track_id: "V1" },
        { op: "insert_asset_clip", asset_id: "stacked", track_id: "V2", timeline_start_us: 1_000_000, edit_mode: "place" },
      ]);
  });

  it("routes audio drops away from video rows and keeps image drops at four seconds", () => {
    const intent = resolveTimelineAssetDropIntent({
      hit: { trackId: "V1", band: "body", clipId: null, zone: null }, clips: [], tracks,
      assetKinds: ["audio"], assetDurationsUs: [1_000_000], itemCount: 1, canReplace: true,
      pointerUs: 4_000_000, fpsNum: 30, fpsDen: 1, hasCoordinates: true,
    });
    expect(planAssetDrop([asset("sound", "audio", 1_000_000)], tracks, intent.slot, intent.trackId ?? undefined, undefined, {
      intent, clips: [], linkageEnabled: true, fpsNum: 30, fpsDen: 1,
    })).toMatchObject([
      { op: "add_track", kind: "audio", track_id: "A2", after_track_id: "A1" },
      { op: "insert_asset_clip", asset_id: "sound", track_id: "A2", timeline_start_us: 4_000_000, edit_mode: "place" },
    ]);

    const imageIntent = resolveTimelineAssetDropIntent({
      hit: { trackId: "V1", band: "body", clipId: null, zone: null }, clips: [], tracks,
      assetKinds: ["image"], assetDurationsUs: [4_000_000], itemCount: 1, canReplace: true,
      pointerUs: 7_000_000, fpsNum: 30, fpsDen: 1, hasCoordinates: true,
    });
    expect(planAssetDrop([asset("still", "image", null)], tracks, imageIntent.slot, imageIntent.trackId ?? undefined, undefined, {
      intent: imageIntent, clips: [], linkageEnabled: true, fpsNum: 30, fpsDen: 1,
    })).toMatchObject([{ duration_us: 4_000_000, timeline_start_us: 7_000_000, edit_mode: "place" }]);
  });
});
