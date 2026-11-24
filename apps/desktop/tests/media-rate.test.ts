import { describe, expect, it } from "vitest";
import { clampMediaRate, MEDIA_RATE_MAX, MEDIA_RATE_MIN, mediaRateIsPlayable } from "../src/app/preview/media-rate.js";

describe("OpenFilm preview media-rate limits", () => {
  it("recognizes the inclusive browser playback interval [1/16, 16]", () => {
    expect(mediaRateIsPlayable(MEDIA_RATE_MIN)).toBe(true);
    expect(mediaRateIsPlayable(0.1)).toBe(true);
    expect(mediaRateIsPlayable(1)).toBe(true);
    expect(mediaRateIsPlayable(MEDIA_RATE_MAX)).toBe(true);
    expect(mediaRateIsPlayable(MEDIA_RATE_MIN - 0.001)).toBe(false);
    expect(mediaRateIsPlayable(MEDIA_RATE_MAX + 0.001)).toBe(false);
    expect(mediaRateIsPlayable(Number.NaN)).toBe(false);
  });

  it("clamps only browser element rates and keeps invalid values safe", () => {
    expect(clampMediaRate(0.01)).toBe(MEDIA_RATE_MIN);
    expect(clampMediaRate(100)).toBe(MEDIA_RATE_MAX);
    expect(clampMediaRate(Number.NaN)).toBe(1);
  });
});
