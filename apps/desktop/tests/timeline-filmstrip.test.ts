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
    // 10s 片段 @ 60pps → 600px → 档位随格宽（T8：80px，参照 BlockThumbs THUMB_CELL_PX）。
    const frames = computeFrameRequests("aivideo://media/x", clip(), 60);
    expect(frames.length).toBe(quantizeFrameCount(Math.round(600 / 80)));
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

describe("WP-P232/T8 缩略格档位单源（frameTierFor）", () => {
  // 真机缺陷：档位清理侧曾写死 /44，而请求/绘制侧是 /80。两侧不同常数时
  // 清理侧算出的档位永远不等于实际缓存键里的档位 → 3 轮后帧被当陈旧档清空。
  it("请求侧与清理侧用同一函数算档位（11.9s@60pps = 8 格）", async () => {
    const { frameTierFor, computeFrameRequests, THUMB_CELL_PX } = await import("../src/app/timeline/TimelineCanvas.js");
    const durUs = 11_900_000;
    const pps = 60;
    const tier = frameTierFor(durUs, pps);
    const frames = computeFrameRequests("aivideo://m/x", clip({ timeline_end_us: durUs }), pps);
    // 缓存键里的档位 = frames.length；必须与清理侧算的档位一致。
    expect(frames.length).toBe(tier);
    expect(THUMB_CELL_PX).toBe(80);
    // 反证：旧 /44 算法给出的档位不同——正是这一差异导致误清。
    const legacy = quantizeFrameCount(Math.round(((durUs / 1_000_000) * pps) / 44));
    expect(legacy).not.toBe(tier);
  });

  it("绘制侧用的格数 = 请求侧（两侧同源，不会画空格）", async () => {
    const { frameTierFor, computeFrameRequests } = await import("../src/app/timeline/TimelineCanvas.js");
    for (const durUs of [3_000_000, 11_900_000, 30_000_000, 95_000_000]) {
      for (const pps of [30, 60, 120, 240]) {
        const frames = computeFrameRequests("aivideo://m/x", clip({ timeline_end_us: durUs }), pps);
        expect(frames.length).toBe(frameTierFor(durUs, pps));
      }
    }
  });
});

describe("WP-P232 档位清理不得误删在用帧（currentFrameTiers 与缓存键同源）", () => {
  it("清理侧档位集合与请求侧缓存键的档位逐条一致", async () => {
    const { currentFrameTiers, computeFrameRequests } = await import("../src/app/timeline/TimelineCanvas.js");
    const cases = [
      { durUs: 3_000_000, pps: 30 },
      { durUs: 11_900_000, pps: 60 },
      { durUs: 11_900_000, pps: 240 },
      { durUs: 95_000_000, pps: 45 },
    ];
    for (const { durUs, pps } of cases) {
      const c = clip({ clip_id: "clip_x" as never, timeline_end_us: durUs });
      const frames = computeFrameRequests("aivideo://m/x", c, pps);
      const tiers = currentFrameTiers([{ clip: c }], pps);
      // 缓存键形 = clipId:frameCount:fi —— 档位就是 frames.length。
      expect(tiers.has(`clip_x:${frames.length}`)).toBe(true);
      expect(tiers.size).toBe(1);
    }
  });

  it("非可视素材（音频）不进档位集合（避免误留/误删）", async () => {
    const { currentFrameTiers } = await import("../src/app/timeline/TimelineCanvas.js");
    const audio = clip({ clip_id: "a1" as never, asset_kind: "audio" });
    expect(currentFrameTiers([{ clip: audio }], 60).size).toBe(0);
  });

  it("零时长片段不进集合（守卫除零档位）", async () => {
    const { currentFrameTiers } = await import("../src/app/timeline/TimelineCanvas.js");
    const zero = clip({ clip_id: "z1" as never, timeline_end_us: 0 });
    expect(currentFrameTiers([{ clip: zero }], 60).size).toBe(0);
  });
});

describe("WP-P232 绘制期 sprite 兜底（cellSourceTimeSec 与请求侧同源）", () => {
  // 绘制侧在缓存未命中时同步查 sprite 表——它算的源时刻必须与请求侧
  // computeFrameRequests 逐位一致，否则「查到的格子内容与位置对不上」。
  it("格源时刻与 computeFrameRequests 完全一致（含变速/倒放）", async () => {
    const { cellSourceTimeSec, computeFrameRequests, frameTierFor } = await import("../src/app/timeline/TimelineCanvas.js");
    const cases = [
      clip({ timeline_start_us: 0, timeline_end_us: 11_900_000 }),
      clip({ timeline_start_us: 2_000_000, timeline_end_us: 9_000_000, source_start_us: 5_000_000, source_end_us: 15_000_000 }),
      clip({ timeline_start_us: 0, timeline_end_us: 8_000_000, source_start_us: 0, source_end_us: 4_000_000, speed_milli: 2000 as never }),
      clip({ timeline_start_us: 0, timeline_end_us: 8_000_000, source_start_us: 2_000_000, source_end_us: 10_000_000, reverse_playback: true }),
    ];
    for (const c of cases) {
      const pps = 60;
      const frames = computeFrameRequests("aivideo://m/x", c, pps);
      const count = frameTierFor(c.timeline_end_us - c.timeline_start_us, pps);
      expect(frames.length).toBe(count);
      for (let i = 0; i < count; i += 1) {
        expect(cellSourceTimeSec(c, i, count)).toBeCloseTo(frames[i].timeSec, 9);
      }
    }
  });

  it("源时刻钳在 0 以上（倒放越过源起点不产生负时刻）", async () => {
    const { cellSourceTimeSec } = await import("../src/app/timeline/TimelineCanvas.js");
    const c = clip({ timeline_start_us: 0, timeline_end_us: 10_000_000, source_start_us: 0, source_end_us: 2_000_000, reverse_playback: true });
    for (let i = 0; i < 5; i += 1) {
      expect(cellSourceTimeSec(c, i, 5)).toBeGreaterThanOrEqual(0);
    }
  });
});
