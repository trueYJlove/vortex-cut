// 抽帧"所见即所得"契约：格位由时间线时长均匀切分，帧 seek 格中心的源时刻
//（含变速/倒放），并返回格位 fromUs/toUs 供绘制精确落位。
import { describe, expect, it } from "vitest";
import type { TimelineClip } from "@aivideo/contracts";
import { computeFrameRequests, quantizeFrameCount } from "../src/app/timeline/TimelineCanvas.js";

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

describe("filmstrip frame requests — 时间对位（所见即所得）", () => {
  it("格位由时间线时长均匀切分，帧时刻=格中心，含格位边界", () => {
    // 10s 片段 @ 60pps → 600px → 档位 11 帧。
    const frames = computeFrameRequests("aivideo://media/x", clip(), 60);
    expect(frames.length).toBe(quantizeFrameCount(Math.round(600 / 56)));
    const count = frames.length;
    const step = 10_000_000 / count;
    for (let i = 0; i < count; i++) {
      expect(frames[i].fromUs).toBeCloseTo((i * 10_000_000) / count, 0);
      expect(frames[i].toUs).toBeCloseTo(((i + 1) * 10_000_000) / count, 0);
      expect(frames[i].timeSec * 1_000_000).toBeCloseTo((i + 0.5) * step, 0);
    }
  });

  it("片段在时间线上移动/裁切后，帧时刻跟随时间线位置（源窗内偏移）", () => {
    // 源窗 5s–15s，时间线 2s–7s（1x）：格中心 = 2s + (i+0.5)·step → 源 5s + 同偏移。
    const moved = clip({
      source_start_us: 5_000_000,
      source_end_us: 15_000_000,
      timeline_start_us: 2_000_000,
      timeline_end_us: 7_000_000,
    });
    const frames = computeFrameRequests("aivideo://media/x", moved, 60);
    const step = 5_000_000 / frames.length;
    expect(frames[0].timeSec * 1_000_000).toBeCloseTo(5_000_000 + 0.5 * step, 0);
    expect(frames[frames.length - 1].timeSec * 1_000_000).toBeCloseTo(5_000_000 + (frames.length - 0.5) * step, 0);
  });

  it("2x 变速：源时刻按速度映射，帧数随时间线时长（而非源时长）计算", () => {
    // 源窗 0–10s 以 2x 铺在时间线 0–5s：格中心时间线偏移 · 2 = 源偏移。
    const fast = clip({
      speed_milli: 2000 as never,
      timeline_end_us: 5_000_000,
    });
    const frames = computeFrameRequests("aivideo://media/x", fast, 60);
    const step = 5_000_000 / frames.length;
    expect(frames[0].timeSec * 1_000_000).toBeCloseTo(0.5 * step * 2, 0);
    expect(frames[frames.length - 1].timeSec * 1_000_000).toBeCloseTo((frames.length - 0.5) * step * 2, 0);
  });

  it("倒放：从源尾部反向映射", () => {
    const reversed = clip({ reverse_playback: true });
    const frames = computeFrameRequests("aivideo://media/x", reversed, 60);
    const count = frames.length;
    const step = 10_000_000 / count;
    // 首格中心（0.5 格处）→ 源 10s − 0.5·step。
    expect(frames[0].timeSec * 1_000_000).toBeCloseTo(10_000_000 - 0.5 * step, 0);
    expect(frames[count - 1].timeSec * 1_000_000).toBeCloseTo(0.5 * step, 0);
  });

  it("空媒体/空时长返回空数组", () => {
    expect(computeFrameRequests(null, clip(), 60)).toEqual([]);
    expect(computeFrameRequests("aivideo://media/x", clip({ timeline_end_us: 0 }), 60)).toEqual([]);
  });
});
