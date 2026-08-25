import { describe, expect, it } from "vitest";
import type { TimelineClip } from "@aivideo/contracts";
import {
  MIN_CLIP_US,
  clipDuration,
  clipsInRect,
  computeClipRects,
  computeV1TargetIndex,
  ghostPosition,
  hitTestClips,
  hitTestTrimHandle,
  marqueeRect,
  packV1Clips,
  snapCandidates,
  snapValue,
  timeToX,
  v1ReorderToMixedIndex,
  xToTime,
} from "../src/app/timeline/geometry.js";
import { DEFAULT_VIEW_STATE, type TimelineViewState } from "../src/app/timeline/types.js";

const view: TimelineViewState = {
  ...DEFAULT_VIEW_STATE,
  pixelsPerSecond: 100, // 1s = 100px
  trackHeight: 64,
  rulerHeight: 28,
  headerWidth: 120,
};

/**
 * Consistent clip factory: source duration always matches the timeline range,
 * so clipDuration() (source-based for video/audio) equals timeline_end-start.
 */
const videoClip = (
  overrides: Partial<TimelineClip> = {},
  durationUs = 1_000_000,
): TimelineClip => ({
  clip_id: `clip_${Math.random().toString(36).slice(2)}` as never,
  track_id: "V1",
  order_index: 0,
  asset_id: "asset_1" as never,
  asset_kind: "video",
  source_start_us: 0,
  source_end_us: durationUs,
  timeline_start_us: 0,
  timeline_end_us: durationUs,
  layout: "fit",
  audio: { enabled: true, gain_db: 0 },
  ...overrides,
});

const audioClip = (overrides: Partial<TimelineClip> = {}, durationUs = 1_000_000): TimelineClip =>
  videoClip({ track_id: "A1", asset_kind: "audio", ...overrides }, durationUs);

const imageClip = (overrides: Partial<TimelineClip> = {}): TimelineClip =>
  videoClip({
    asset_kind: "image",
    source_start_us: null,
    source_end_us: null,
    ...overrides,
  });

describe("geometry time/space conversion", () => {
  it("converts time to x (including header gutter) and back", () => {
    expect(timeToX(0, view)).toBe(120);
    expect(timeToX(1_000_000, view)).toBe(220);
    expect(xToTime(120, view)).toBe(0);
    expect(xToTime(320, view)).toBe(2_000_000);
    expect(xToTime(0, view)).toBe(0); // clamped to >= 0
  });
});

describe("clip rects", () => {
  it("places V1 on row 0 and A1 on row 1 with pixel width from pps", () => {
    const clips = [
      videoClip({ timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000),
      audioClip({ timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 }, 2_000_000),
    ];
    const rects = computeClipRects(clips, view);
    expect(rects[0]).toMatchObject({ x: 120, y: 28, width: 200, height: 64 });
    expect(rects[1]).toMatchObject({ x: 420, y: 92, width: 200, height: 64 });
  });

  it("computes image duration from timeline range", () => {
    const img = imageClip({ timeline_start_us: 0, timeline_end_us: 3_000_000 });
    expect(clipDuration(img)).toBe(3_000_000);
    expect(clipDuration(videoClip())).toBe(1_000_000);
  });
});

describe("hit testing", () => {
  const clips = [
    videoClip({ timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000),
    audioClip({ timeline_start_us: 3_000_000, timeline_end_us: 4_000_000 }),
  ];
  const rects = computeClipRects(clips, view);

  it("finds the clip under the pointer", () => {
    expect(hitTestClips(130, 40, rects)).toBe(clips[0].clip_id);
    expect(hitTestClips(420, 120, rects)).toBe(clips[1].clip_id);
    expect(hitTestClips(50, 40, rects)).toBeNull(); // header gutter
    expect(hitTestClips(130, 10, rects)).toBeNull(); // ruler
  });

  it("detects trim handles only on trimmable clip edges", () => {
    expect(hitTestTrimHandle(120, 40, rects)).toEqual({ clipId: clips[0].clip_id, edge: "left" });
    expect(hitTestTrimHandle(320, 40, rects)).toEqual({ clipId: clips[0].clip_id, edge: "right" });
    expect(hitTestTrimHandle(327, 40, rects)).toBeNull(); // outside handle zone (320+6=326)
    expect(hitTestTrimHandle(420, 120, rects)).toEqual({ clipId: clips[1].clip_id, edge: "left" });
    const imageRects = computeClipRects([imageClip()], view);
    expect(hitTestTrimHandle(120, 40, imageRects)).toBeNull(); // images not trimmable
  });
});

describe("snapping", () => {
  const clips = [
    videoClip({ timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000),
    audioClip({ timeline_start_us: 3_000_000, timeline_end_us: 4_000_000 }),
  ];
  const rects = computeClipRects(clips, view);

  it("collects clip edges, playhead and origin as snap candidates", () => {
    const candidates = snapCandidates(rects, 1_500_000);
    expect(candidates).toContain(0);
    expect(candidates).toContain(2_000_000);
    expect(candidates).toContain(3_000_000);
    expect(candidates).toContain(4_000_000);
    expect(candidates).toContain(1_500_000);
  });

  it("excludes the dragged clip's own edges but keeps the timeline origin", () => {
    const candidates = snapCandidates(rects, 0, clips[0].clip_id);
    expect(candidates).toContain(0); // timeline origin stays a snap target
    expect(candidates).not.toContain(2_000_000); // dragged clip's right edge
    expect(candidates).toContain(3_000_000);
  });

  it("snaps within the threshold and keeps the raw value outside", () => {
    // 8px threshold at 100pps = 80_000µs
    expect(snapValue(3_050_000, [3_000_000], 80_000)).toBe(3_000_000);
    expect(snapValue(3_200_000, [3_000_000], 80_000)).toBe(3_200_000);
  });
});

describe("V1 ordering", () => {
  const a = videoClip({ clip_id: "a" as never, order_index: 0, timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000);
  const b = videoClip({ clip_id: "b" as never, order_index: 1, timeline_start_us: 2_000_000, timeline_end_us: 3_000_000 }, 1_000_000);
  const img = imageClip({ clip_id: "i" as never, order_index: 2, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 });

  it("packs V1 clips sequentially from 0 using source durations", () => {
    const packed = packV1Clips([a, img, b]);
    expect(packed.map(p => [p.startUs, p.endUs])).toEqual([[0, 2_000_000], [2_000_000, 4_000_000], [4_000_000, 5_000_000]]);
  });

  it("computes the V1 insertion index from the target start time", () => {
    // Target inside clip a's span (< midpoint 1s) → insert at 0
    expect(computeV1TargetIndex([a, b, img], "c" as never, 500_000)).toBe(0);
    // Target past a's midpoint → insert after a (index 1)
    expect(computeV1TargetIndex([a, b, img], "c" as never, 1_500_000)).toBe(1);
    // Target past everything → append
    expect(computeV1TargetIndex([a, b, img], "c" as never, 10_000_000)).toBe(3);
  });

  it("maps a V1-order index to a mixed-list to_index for move_clip", () => {
    const mixed = [a, videoClip({ clip_id: "x" as never, track_id: "A1", order_index: 0, timeline_start_us: 0 }), b];
    // Move a (V1 index 0) to V1 index 1: insert before the 1st remaining V1 (b at mixed index 2)
    expect(v1ReorderToMixedIndex(mixed, "a" as never, 1)).toBe(2);
    // Move b to V1 index 0: insert before the 0th remaining V1 (a at mixed index 0)
    expect(v1ReorderToMixedIndex(mixed, "b" as never, 0)).toBe(0);
    // Move b to V1 index 1: append after the last remaining V1 (a at mixed index 0) → 1
    expect(v1ReorderToMixedIndex(mixed, "b" as never, 1)).toBe(1);
  });
});

describe("ghost position", () => {
  it("renders an A1 clip at the free target position", () => {
    const clip = audioClip({ clip_id: "a1" as never, timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000);
    const ghost = ghostPosition([clip], clip, 12_000_000);
    expect(ghost).toEqual({ startUs: 12_000_000, endUs: 14_000_000 });
  });

  it("renders a V1 clip at its packed landing position", () => {
    const a = videoClip({ clip_id: "a" as never, order_index: 0, timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000);
    const b = videoClip({ clip_id: "b" as never, order_index: 1, timeline_start_us: 2_000_000, timeline_end_us: 3_000_000 }, 1_000_000);
    // Drag b to start at 0.5s → lands before a (index 0) → packed at [0, 1s]
    const ghost = ghostPosition([a, b], b, 500_000);
    expect(ghost).toEqual({ startUs: 0, endUs: 1_000_000 });
  });
});

describe("marquee", () => {
  const clips = [
    videoClip({ clip_id: "a" as never, timeline_start_us: 0, timeline_end_us: 1_000_000 }),
    audioClip({ clip_id: "b" as never, timeline_start_us: 3_000_000, timeline_end_us: 4_000_000 }),
  ];
  const rects = computeClipRects(clips, view);

  it("normalizes a dragged rect", () => {
    expect(marqueeRect(200, 100, 100, 50)).toEqual({ x: 100, y: 50, width: 100, height: 50 });
  });

  it("collects every clip intersecting the box", () => {
    // Box spans x [100, 600] → crosses both V1 (x 120-220) and A1 (x 420-520)
    const ids = clipsInRect(marqueeRect(100, 20, 600, 200), rects);
    expect(ids).toEqual([clips[0].clip_id, clips[1].clip_id]);
    const none = clipsInRect(marqueeRect(100, 20, 110, 25), rects);
    expect(none).toEqual([]);
  });
});

describe("constants", () => {
  it("keeps the minimum clip duration aligned with the contract", () => {
    expect(MIN_CLIP_US).toBe(100_000);
  });
});
