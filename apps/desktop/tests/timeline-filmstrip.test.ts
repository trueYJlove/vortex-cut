import { describe, expect, it } from "vitest";
import type { TimelineClip } from "@aivideo/contracts";
import { cachedFilmstripFallback, cellSourceTimeSec, computeFrameRequests, quantizeFrameCount, thumbnailStepMs } from "../src/app/timeline/TimelineCanvas.js";

function clip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    clip_id: "clip_1" as never,
    track_id: "V1",
    order_index: 0,
    asset_id: "a1" as never,
    asset_kind: "video",
    source_start_us: 0,
    source_end_us: 10_000_000,
    timeline_start_us: 0,
    timeline_end_us: 10_000_000,
    layout: "fit",
    audio: { enabled: true, gain_db: 0 },
    ...overrides,
  };
}

describe("OpenFilm filmstrip grid", () => {
  it("uses the source thumbnail seek ladder for an 80px cell", () => {
    expect(thumbnailStepMs((80 / 28) * 1000)).toBe(5000);
    expect(thumbnailStepMs((80 / 60) * 1000)).toBe(2000);
  });

  it("samples a long clip on source times 0, 5, 10, 15, and 20 seconds", () => {
    const long = clip({ source_end_us: 20_000_000, timeline_end_us: 20_000_000 });
    const frames = computeFrameRequests("aivideo://media/x", long, 28);
    expect(frames.map((frame) => frame.sourceTimeUs)).toEqual([0, 5, 10, 15, 20].map((seconds) => seconds * 1_000_000));
    expect(frames.map((frame) => frame.fromUs)).toEqual(frames.map((frame) => frame.sourceTimeUs));
    expect(frames.every((frame) => frame.keySuffix.startsWith(":source:"))).toBe(true);
  });

  it("maps trimmed source shots back to their timeline positions", () => {
    const trimmed = clip({
      source_start_us: 5_000_000,
      source_end_us: 15_000_000,
      timeline_start_us: 2_000_000,
      timeline_end_us: 12_000_000,
    });
    const frames = computeFrameRequests("aivideo://media/x", trimmed, 28);
    expect(frames.map((frame) => frame.sourceTimeUs)).toEqual([5_000_000, 10_000_000, 15_000_000]);
    expect(frames.map((frame) => frame.fromUs)).toEqual([2_000_000, 7_000_000, 12_000_000]);
  });

  it("scales the source grid with playback speed", () => {
    const fast = clip({
      source_start_us: 0,
      source_end_us: 10_000_000,
      timeline_start_us: 0,
      timeline_end_us: 5_000_000,
      speed_milli: 2000 as never,
    });
    const frames = computeFrameRequests("aivideo://media/x", fast, 28);
    expect(frames.map((frame) => frame.sourceTimeUs)).toEqual([0, 10_000_000]);
    expect(frames.map((frame) => frame.fromUs)).toEqual([0, 5_000_000]);
  });

  it("uses one clip-local anchor when a short clip contains no ladder sample", () => {
    const short = clip({
      source_start_us: 1_000_000,
      source_end_us: 3_000_000,
      timeline_start_us: 2_000_000,
      timeline_end_us: 4_000_000,
    });
    const frames = computeFrameRequests("aivideo://media/x", short, 28);
    expect(frames).toHaveLength(1);
    expect(frames[0].sourceTimeUs).toBe(1_560_000);
    expect(frames[0].fromUs).toBe(2_560_000);
  });

  it("requests only visible source samples plus the nearest sample on either side", () => {
    const long = clip({ source_end_us: 20_000_000, timeline_end_us: 20_000_000 });
    const frames = computeFrameRequests("aivideo://media/x", long, 28, { fromUs: 7_000_000, toUs: 13_000_000 });
    expect(frames.map((frame) => frame.sourceTimeUs)).toEqual([5_000_000, 10_000_000, 15_000_000]);
    expect(computeFrameRequests("aivideo://media/x", long, 28, { fromUs: 30_000_000, toUs: 40_000_000 })).toEqual([]);
  });

  it("keeps the Vortex reverse-playback sampling extension", () => {
    const reversed = clip({ reverse_playback: true });
    const frames = computeFrameRequests("aivideo://media/x", reversed, 60);
    const count = quantizeFrameCount(Math.round(10_000_000 / 1_000_000 * 60 / 80));
    expect(frames).toHaveLength(count);
    expect(frames[0].sourceTimeUs).toBeCloseTo(10_000_000 - 0.5 * (10_000_000 / count), 0);
    expect(frames[count - 1].sourceTimeUs).toBeCloseTo(0.5 * (10_000_000 / count), 0);
    expect(cellSourceTimeSec(reversed, 0, count)).toBeCloseTo(frames[0].timeSec, 9);
  });

  it("requests one image for a still instead of decoding duplicate copies", () => {
    const still = clip({ asset_kind: "image", source_end_us: 60_000_000, timeline_end_us: 60_000_000 });
    expect(computeFrameRequests("file:///still.jpg", still, 28)).toHaveLength(1);
  });

  it("returns no frames for absent media or a zero-length clip", () => {
    expect(computeFrameRequests(null, clip(), 28)).toEqual([]);
    expect(computeFrameRequests("aivideo://media/x", clip({ timeline_end_us: 0 }), 28)).toEqual([]);
  });
});

describe("legacy tier helpers used by reverse playback", () => {
  it("reuses the nearest cached cell when zoom tiers differ", () => {
    const cache = new Map([
      ["clip:2:0", "left"],
      ["clip:2:1", "right"],
      ["clip:4:3", "far-right"],
      ["other:4:0", "other-source"],
      ["sparse:8:0", "first-loaded"],
      ["sparse:preview", "first-loaded"],
    ]);
    expect(cachedFilmstripFallback(cache, "clip", 8, 0)).toBe("left");
    expect(cachedFilmstripFallback(cache, "clip", 8, 4)).toBe("right");
    expect(cachedFilmstripFallback(cache, "clip", 8, 7)).toBe("far-right");
    expect(cachedFilmstripFallback(cache, "sparse", 4, 3)).toBe("first-loaded");
    expect(cachedFilmstripFallback(cache, "new-source-window", 8, 7)).toBeUndefined();
  });
});
