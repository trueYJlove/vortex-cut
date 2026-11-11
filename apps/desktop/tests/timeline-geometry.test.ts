import { describe, expect, it } from "vitest";
import type { TimelineClip, TimelineTrack } from "@aivideo/contracts";
import {
  MIN_CLIP_US,
  clampGroupDelta,
  clampMoveStart,
  clipAudioBand,
  clipDuration,
  clipsInRect,
  clampScrollX,
  computeClipRects,
  computeTrackRows,
  computeTransitionRects,
  contentWidthPx,
  dragEdgeAutoScrollStep,
  fitZoomPps,
  ghostPosition,
  gridSnapCandidates,
  hitTestClips,
  hitTestTransitionGap,
  hitTestTransitions,
  hitTestTrimHandle,
  hitTestVolumeLine,
  volumeToY,
  yToVolume,
  marqueeRect,
  resolveGroupMove,
  resolveMoveTarget,
  scrollBounds,
  snapCandidates,
  snapValue,
  timeToX,
  xToTime,
  zoomAtAnchor,
} from "../src/app/timeline/geometry.js";
import { DEFAULT_VIEW_STATE, ZOOM_MAX_PPS, ZOOM_MIN_PPS, type TimelineViewState } from "../src/app/timeline/types.js";

const view: TimelineViewState = {
  ...DEFAULT_VIEW_STATE,
  pixelsPerSecond: 100, // 1s = 100px
  trackHeight: 64,
  rulerHeight: 28,
  headerWidth: 120,
};

const tracks: TimelineTrack[] = [
  { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false },
  { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
  { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
];
const rows = computeTrackRows(tracks, view.rulerHeight, view.trackHeight);


/**
 * Consistent clip factory: source duration always matches the timeline range,
 * so clipDuration() (timeline-based) equals timeline_end - timeline_start.
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
  it("places clips on their track rows with the main track taller (剪映式)", () => {
    const clips = [
      videoClip({ timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000),
      audioClip({ timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 }, 2_000_000),
    ];
    const rects = computeClipRects(clips, rows, view);
    // 行布局（2026-11-10 起，对齐 OpenFilm 的轨高与行间隙）：
    //   C1 文本轨  y=28（标尺底）            h=56（次轨比例已改为 1）
    //   间隙 2px  → V1 y=28+56+2=86          h=64（view.trackHeight，主轨完整行高）
    //   间隙 2px  → A1 y=86+64+2=152         h=44（音频轨固定值）
    // 片段在行内再内缩 CLIP_ROW_INSET（6px），故 V1 片段 y=92、A1 片段 y=158。
    // 用 rows 的实算值断言，避免把内缩常量硬编码进测试：
    // 将来调 CLIP_ROW_INSET 时这里仍然成立。
    const v1Row = rows.find(r => r.track.id === "V1")!;
    const a1Row = rows.find(r => r.track.id === "A1")!;
    expect(rects[0]).toMatchObject({ x: 120, width: 200, height: v1Row.height });
    expect(rects[0].y).toBeGreaterThanOrEqual(v1Row.y);
    expect(rects[0].y).toBeLessThan(v1Row.y + v1Row.height);
    expect(rects[1]).toMatchObject({ x: 420, width: 200, height: a1Row.height });
    expect(rects[1].y).toBeGreaterThanOrEqual(a1Row.y);
    expect(rects[1].y).toBeLessThan(a1Row.y + a1Row.height);
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
  const rects = computeClipRects(clips, rows, view);

  it("finds the clip under the pointer", () => {
    expect(hitTestClips(130, 100, rects)).toBe(clips[0].clip_id);
    expect(hitTestClips(420, 180, rects)).toBe(clips[1].clip_id);
    expect(hitTestClips(50, 100, rects)).toBeNull(); // header gutter
    expect(hitTestClips(130, 10, rects)).toBeNull(); // ruler
    expect(hitTestClips(130, 40, rects)).toBeNull(); // C1 row (no caption clips)
  });

  it("detects trim handles only on trimmable clip edges", () => {
    expect(hitTestTrimHandle(120, 100, rects)).toEqual({ clipId: clips[0].clip_id, edge: "left" });
    expect(hitTestTrimHandle(320, 100, rects)).toEqual({ clipId: clips[0].clip_id, edge: "right" });
    expect(hitTestTrimHandle(327, 100, rects)).toBeNull(); // outside handle zone (320+6=326)
    expect(hitTestTrimHandle(420, 180, rects)).toEqual({ clipId: clips[1].clip_id, edge: "left" });
    const imageRects = computeClipRects([imageClip()], rows, view);
    expect(hitTestTrimHandle(120, 100, imageRects)).toBeNull(); // images not trimmable
  });
});

describe("snapping", () => {
  const clips = [
    videoClip({ timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000),
    audioClip({ timeline_start_us: 3_000_000, timeline_end_us: 4_000_000 }),
  ];
  const rects = computeClipRects(clips, rows, view);

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

describe("同轨自由定位钳制", () => {
  const a = videoClip({ clip_id: "a" as never, order_index: 0, timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000);
  const b = videoClip({ clip_id: "b" as never, order_index: 1, timeline_start_us: 2_000_000, timeline_end_us: 3_000_000 }, 1_000_000);
  const c = videoClip({ clip_id: "c" as never, order_index: 2, timeline_start_us: 3_000_000, timeline_end_us: 4_000_000 }, 1_000_000);

  it("keeps a legal raw start unchanged (gaps are allowed)", () => {
    // raw 落在 [2s, 3s) 的空隙内且与邻居有安全距离 → 原样返回。
    expect(clampMoveStart([a, c], 500_000, 2_250_000)).toBe(2_250_000);
    // 完全没有其他片段 → 任意位置合法。
    expect(clampMoveStart([], 1_000_000, 5_000_000)).toBe(5_000_000);
  });

  it("clamps an overlapping start flush against the nearest neighbor", () => {
    // raw 0.5s 与 a [0,2s) 重叠：最近合法位置 = 贴 a 右缘 2s。
    expect(clampMoveStart([a], 1_000_000, 500_000)).toBe(2_000_000);
    // raw 2.5s 与 c [3s,4s) 重叠：候选 2s（贴 c 左缘）与 4s（贴 c 右缘），取更近的 2s。
    expect(clampMoveStart([c], 1_000_000, 2_500_000)).toBe(2_000_000);
    // raw 3.6s 与 c 重叠：候选 2s（dist 1.6s）与 4s（dist 0.4s），取 4s。
    expect(clampMoveStart([c], 1_000_000, 3_600_000)).toBe(4_000_000);
  });

  it("clamps to the left neighbor edge when the right side is closer", () => {
    // raw 2.9s 与 c [3s,4s) 重叠：贴 c 左缘 2s 比 c 右缘 4s 更近。
    expect(clampMoveStart([c], 1_000_000, 2_900_000)).toBe(2_000_000);
  });

  it("never returns a negative start", () => {
    // a 占据 [0,2s)，1s 片段无处可放在其左侧 → 贴右缘。
    expect(clampMoveStart([a], 1_000_000, 0)).toBe(2_000_000);
  });

  it("finds the nearest legal slot among multiple gaps", () => {
    // 空隙 [2s,3s)（宽 1s）恰好容纳：raw 1.8s 与 a 重叠 → 贴 a 右缘 2s。
    expect(clampMoveStart([a, c], 1_000_000, 1_800_000)).toBe(2_000_000);
    // 空隙两端都是候选：raw 3.2s 与 c 重叠 → 2s（dist 1.2）vs 4s（dist 0.8）→ 4s。
    expect(clampMoveStart([a, c], 1_000_000, 3_200_000)).toBe(4_000_000);
  });
});

describe("ghost position", () => {
  it("renders an A1 clip at the free target position", () => {
    const clip = audioClip({ clip_id: "a1" as never, timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000);
    const ghost = ghostPosition([clip], clip, 12_000_000);
    expect(ghost).toEqual({ startUs: 12_000_000, endUs: 14_000_000 });
  });

  it("renders a V1 clip following the pointer with no mid-drag clamping", () => {
    const a = videoClip({ clip_id: "a" as never, order_index: 0, timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000);
    const b = videoClip({ clip_id: "b" as never, order_index: 1, timeline_start_us: 2_000_000, timeline_end_us: 3_000_000 }, 1_000_000);
    // 剪映式拖拽：拖动途中片段 1:1 跟随鼠标（允许视觉上压过邻居、无吸附无钳制）；
    // 无重叠钳制只在松手时由 clampMoveStart 一次完成。
    const ghost = ghostPosition([a, b], b, 500_000);
    expect(ghost).toEqual({ startUs: 500_000, endUs: 1_500_000 });
    // 拖 b 到空隙内的合法位置 → 原样跟随。
    const ghostFree = ghostPosition([a, b], b, 2_500_000);
    expect(ghostFree).toEqual({ startUs: 2_500_000, endUs: 3_500_000 });
  });
});

describe("marquee", () => {
  const clips = [
    videoClip({ clip_id: "a" as never, timeline_start_us: 0, timeline_end_us: 1_000_000 }),
    audioClip({ clip_id: "b" as never, timeline_start_us: 3_000_000, timeline_end_us: 4_000_000 }),
  ];
  const rects = computeClipRects(clips, rows, view);

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

describe("B2 转场几何", () => {
  const left = videoClip({ clip_id: "left" as never, order_index: 0, timeline_start_us: 0, timeline_end_us: 2_000_000, source_start_us: 0, source_end_us: 2_000_000 });
  const right = videoClip({ clip_id: "right" as never, order_index: 1, timeline_start_us: 2_000_000, timeline_end_us: 5_000_000, source_start_us: 0, source_end_us: 3_000_000 });
  const transition = { transition_id: "t1" as never, after_clip_id: "left" as never, kind: "fade" as const, duration_us: 500_000 };

  it("computeTransitionRects 以锚点终点为中心，宽度受 6-80px 限幅", () => {
    const rects = computeTransitionRects([left, right], [transition], rows, view);
    expect(rects).toHaveLength(1);
    // 中心 = headerWidth + 2s × 100pps = 320；宽 0.5s × 100 = 50px。
    expect(rects[0].x).toBe(320 - 25);
    expect(rects[0].width).toBe(50);
    const huge = computeTransitionRects([left, right], [{ ...transition, duration_us: 2_000_000 }], rows, view);
    expect(huge[0].width).toBe(80); // 200px 限到 80
    const tiny = computeTransitionRects([left, right], [{ ...transition, duration_us: 50_000 }], rows, view);
    expect(tiny[0].width).toBe(6); // 5px 限到 6
  });

  it("computeTransitionRects 跳过锚点缺失的转场", () => {
    const rects = computeTransitionRects([right], [transition], rows, view);
    expect(rects).toHaveLength(0);
  });

  it("computeTransitionRects 跳过有空隙的休眠转场", () => {
    // 右片段移开 1s：两片段间有空隙 → 转场休眠，不渲染标记。
    const movedRight = videoClip({ clip_id: "right" as never, order_index: 1, timeline_start_us: 3_000_000, timeline_end_us: 6_000_000, source_start_us: 0, source_end_us: 3_000_000 });
    const rects = computeTransitionRects([left, movedRight], [transition], rows, view);
    expect(rects).toHaveLength(0);
    // 贴回后（首尾相接）转场恢复。
    const flushRight = videoClip({ clip_id: "right" as never, order_index: 1, timeline_start_us: 2_000_000, timeline_end_us: 5_000_000, source_start_us: 0, source_end_us: 3_000_000 });
    expect(computeTransitionRects([left, flushRight], [transition], rows, view)).toHaveLength(1);
  });

  it("hitTestTransitions 命中标记区域并优先于片段", () => {
    const rects = computeTransitionRects([left, right], [transition], rows, view);
    expect(hitTestTransitions(320, view.rulerHeight + view.trackHeight + 10, rects)).toBe("t1");
    expect(hitTestTransitions(10, view.rulerHeight + view.trackHeight + 10, rects)).toBeNull();
  });

  it("hitTestTransitionGap 在相邻可转场片段边界容差内返回左锚点", () => {
    const rects = computeClipRects([left, right], rows, view);
    // 边界 x = 120 + 200 = 320。
    expect(hitTestTransitionGap(320, view.rulerHeight + view.trackHeight + 10, rects)).toBe("left");
    expect(hitTestTransitionGap(325, view.rulerHeight + view.trackHeight + 10, rects)).toBe("left");
    expect(hitTestTransitionGap(340, view.rulerHeight + view.trackHeight + 10, rects)).toBeNull();
  });

  it("hitTestTransitionGap 拒绝图片→音频等不可转场组合", () => {
    const imageRight: TimelineClip = { ...right, asset_kind: "image", source_start_us: null, source_end_us: null, audio: { enabled: false, gain_db: 0 } };
    const rects = computeClipRects([left, imageRight], rows, view);
    // 视频→图片仍可转场。
    expect(hitTestTransitionGap(320, view.rulerHeight + view.trackHeight + 10, rects)).toBe("left");
    const audioLeft: TimelineClip = { ...left, asset_kind: "audio", track_id: "A1" };
    const audioRects = computeClipRects([audioLeft, imageRight], rows, view);
    expect(hitTestTransitionGap(320, view.rulerHeight + view.trackHeight + 10, audioRects)).toBeNull();
  });

  it("hitTestTransitionGap 在有空隙的边界不提供转场热点", () => {
    // 右片段移开 1s（x: 120+200=320 → 420）：旧边界处不再有热点。
    const movedRight = videoClip({ clip_id: "right" as never, order_index: 1, timeline_start_us: 3_000_000, timeline_end_us: 6_000_000, source_start_us: 0, source_end_us: 3_000_000 });
    const rects = computeClipRects([left, movedRight], rows, view);
    expect(hitTestTransitionGap(320, view.rulerHeight + view.trackHeight + 10, rects)).toBeNull();
    expect(hitTestTransitionGap(420, view.rulerHeight + view.trackHeight + 10, rects)).toBeNull();
  });
});

describe("Round 4 — scroll-aware coordinates", () => {
  const scrolled: TimelineViewState = { ...view, scrollX: 200 };

  it("timeToX/xToTime account for scrollX", () => {
    // content x of 2s = 120 + 200 = 320; viewport x = 320 - 200 = 120.
    expect(timeToX(2_000_000, scrolled)).toBe(120);
    // viewport x 320 + scroll 200 - gutter 120 = 400px → 4s at 100pps.
    expect(xToTime(320, scrolled)).toBe(4_000_000);
  });

  it("keeps scrollX=0 behavior identical to the pre-scroll contract", () => {
    expect(timeToX(1_000_000, view)).toBe(220);
    expect(xToTime(220, view)).toBe(1_000_000);
  });
});

describe("Round 4 — scroll bounds", () => {
  it("computes content width as gutter + timeline（终点即最后片段结束，无额外余量）", () => {
    expect(contentWidthPx(view, 2_000_000)).toBe(120 + 200);
  });

  it("maxScrollX is content minus viewport, floored at 0（到素材终点不能再往后拖）", () => {
    expect(scrollBounds(view, 2_000_000, 800).maxScrollX).toBe(0); // 320 < 800
    expect(scrollBounds(view, 20_000_000, 800).maxScrollX).toBe(120 + 2000 - 800);
    expect(clampScrollX(-5, 100)).toBe(0);
    expect(clampScrollX(150, 100)).toBe(100);
    expect(clampScrollX(50, 100)).toBe(50);
  });
});

describe("Round 4 — anchored zoom", () => {
  it("keeps the time under the anchor fixed on screen", () => {
    const totalUs = 20_000_000;
    // 2s sits at viewport x 320 (scrollX 0, pps 100).
    const next = zoomAtAnchor(view, 320, 800, 2, totalUs);
    expect(next.pixelsPerSecond).toBe(200);
    expect(timeToX(2_000_000, next)).toBe(320);
  });

  it("keeps the time under the anchor when already scrolled", () => {
    const totalUs = 20_000_000;
    const scrolled: TimelineViewState = { ...view, scrollX: 400 };
    const anchorX = 300;
    const anchorUs = xToTime(anchorX, scrolled);
    const next = zoomAtAnchor(scrolled, anchorX, 800, 0.5, totalUs);
    expect(timeToX(anchorUs, next)).toBeCloseTo(anchorX, 6);
  });

  it("clamps pps to the zoom limits and scrollX to the content range", () => {
    const totalUs = 2_000_000;
    const next = zoomAtAnchor(view, 320, 800, 1000, totalUs);
    expect(next.pixelsPerSecond).toBe(ZOOM_MAX_PPS);
    // anchor keeps 2s at x 320 → scrollX 3200, clamped to maxScroll 120+2000·2-800 = 3320
    // （无右侧余量：滚动终点即素材终点）。
    expect(next.scrollX).toBe(3320);
    const out = zoomAtAnchor(view, 320, 800, 0.0001, totalUs);
    expect(out.pixelsPerSecond).toBe(ZOOM_MIN_PPS);
  });
});

describe("Round 4 — grid snap candidates", () => {
  it("uses 0.5s steps at 100pps", () => {
    expect(gridSnapCandidates(view, 2_000_000, 30)).toEqual([0, 500_000, 1_000_000, 1_500_000, 2_000_000]);
  });

  it("uses frame steps at high zoom", () => {
    const candidates = gridSnapCandidates({ ...view, pixelsPerSecond: 250 }, 1_000_000, 30);
    expect(candidates[0]).toBe(0);
    expect(candidates[1]).toBeCloseTo(33_333.33, 0);
    expect(candidates.length).toBeGreaterThanOrEqual(30);
    expect(candidates[candidates.length - 1]).toBeLessThanOrEqual(1_000_000);
  });

  it("falls back to coarse steps at low zoom and returns empty without content", () => {
    expect(gridSnapCandidates({ ...view, pixelsPerSecond: 3 }, 30_000_000, 30)[1]).toBe(10_000_000);
    expect(gridSnapCandidates(view, 0, 30)).toEqual([]);
  });
});

describe("Round 4 — group move", () => {
  it("keeps relative offsets on a positive delta", () => {
    const result = resolveGroupMove([1_000_000, 3_000_000], 500_000);
    expect(result.targetStartsUs).toEqual([1_500_000, 3_500_000]);
    expect(result.actualDeltaUs).toBe(500_000);
  });

  it("clamps the whole group at the timeline origin", () => {
    const result = resolveGroupMove([1_000_000, 3_000_000], -2_000_000);
    expect(result.targetStartsUs).toEqual([0, 2_000_000]);
    expect(result.actualDeltaUs).toBe(-1_000_000);
  });

  it("handles an empty group", () => {
    expect(resolveGroupMove([], 1_000_000)).toEqual({ targetStartsUs: [], actualDeltaUs: 0 });
  });
});

describe("Round 4 — edge auto-scroll", () => {
  it("returns zero in the middle", () => {
    expect(dragEdgeAutoScrollStep(400, 800)).toBe(0);
  });

  it("scrolls left near the left edge, faster the closer to the edge", () => {
    expect(dragEdgeAutoScrollStep(0, 800)).toBe(-14);
    expect(dragEdgeAutoScrollStep(20, 800)).toBe(-6);
    expect(Math.abs(dragEdgeAutoScrollStep(20, 800)))
      .toBeLessThan(Math.abs(dragEdgeAutoScrollStep(0, 800)));
  });

  it("scrolls right near the right edge", () => {
    expect(dragEdgeAutoScrollStep(800, 800)).toBe(14);
    expect(dragEdgeAutoScrollStep(790, 800)).toBeGreaterThan(0);
  });
});

describe("Round 5 — volume line", () => {
  const band = { top: 28, height: 64 };

  it("maps gain onto the clip's audio band monotonically", () => {
    const high = volumeToY(12, band);
    const zero = volumeToY(0, band);
    const low = volumeToY(-30, band);
    expect(high).toBeLessThan(zero);
    expect(zero).toBeLessThan(low);
    expect(low).toBeCloseTo(band.top + band.height - 4, 5); // near the band bottom
    expect(yToVolume(high, band)).toBeCloseTo(12, 5);
    expect(yToVolume(low, band)).toBeCloseTo(-30, 5);
    expect(yToVolume(zero, band)).toBeCloseTo(0, 5);
  });

  it("clamps out-of-range values", () => {
    expect(volumeToY(99, band)).toBe(volumeToY(12, band));
    expect(yToVolume(band.top - 100, band)).toBeCloseTo(12, 5);
    expect(yToVolume(band.top + band.height, band)).toBeCloseTo(-30, 5);
  });

  it("hit-tests the line only on audio-carrying, unlocked, wide-enough clips", () => {
    const clip = videoClip({ timeline_start_us: 0, timeline_end_us: 2_000_000, source_start_us: 0, source_end_us: 2_000_000 });
    const rects = computeClipRects([clip], rows, view);
    const clipBand = clipAudioBand(clip, rects[0])!;
    const lineY = volumeToY(0, clipBand);
    expect(hitTestVolumeLine(150, lineY, rects, () => false)).toBe(clip.clip_id);
    expect(hitTestVolumeLine(150, lineY + 10, rects, () => false)).toBeNull(); // outside tolerance
    expect(hitTestVolumeLine(110, lineY, rects, () => false)).toBeNull(); // in the header gutter
    expect(hitTestVolumeLine(150, lineY, rects, () => true)).toBeNull(); // locked
    const muted = videoClip({ audio: { enabled: false, gain_db: 0 } });
    const mutedRects = computeClipRects([muted], rows, view);
    // 关闭原声 → 无音频带（clipAudioBand = null），命中测试直接跳过。
    expect(clipAudioBand(muted, mutedRects[0])).toBeNull();
    expect(hitTestVolumeLine(150, 0, mutedRects, () => false)).toBeNull();
    const image = imageClip();
    const imageRects = computeClipRects([image], rows, view);
    expect(hitTestVolumeLine(150, 0, imageRects, () => false)).toBeNull();
  });
});

describe("剪映式音频带高度（波形占比）", () => {
  it("视频片段的原声带高度随占比缩放（40% 窄带 / 100% 撑满）", () => {
    const clip = videoClip({ timeline_start_us: 0, timeline_end_us: 2_000_000, source_start_us: 0, source_end_us: 2_000_000 });
    const rects = computeClipRects([clip], rows, view);
    const rect = rects[0];
    // 轨道行高 64，片段（含上下留白后）高度 60；名称条 16 → 音频区域 44。
    const area = rect.height - 16;
    const band40 = clipAudioBand(clip, rect, 0.4)!;
    const band60 = clipAudioBand(clip, rect, 0.6)!;
    const band100 = clipAudioBand(clip, rect, 1)!;
    expect(band40.height).toBe(Math.round(area * 0.4));
    expect(band60.height).toBe(Math.round(area * 0.6));
    expect(band100.height).toBe(area);
    // 带始终贴片段底边。
    expect(band40.top + band40.height).toBe(rect.y + rect.height);
    expect(band100.top + band100.height).toBe(rect.y + rect.height);
  });
});

describe("剪映式拖放落点解析 resolveMoveTarget", () => {
  it("resolves same-track drags to the nearest legal free position", () => {
    const a = videoClip({ clip_id: "a" as never, order_index: 0, timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000);
    const b = videoClip({ clip_id: "b" as never, order_index: 1, timeline_start_us: 2_000_000, timeline_end_us: 3_000_000 }, 1_000_000);
    // 拖 b 压向 a：同轨钳制到贴 a 右缘（free 模式 = 预览剪影可省略）。
    const target = resolveMoveTarget([a, b], b, 500_000);
    expect(target).toMatchObject({ startUs: 2_000_000, trackId: b.track_id, mode: "free" });
  });

  it("prefers the slot before/after the overlapped clip by pointer half", () => {
    const v1 = videoClip({ clip_id: "v1" as never, order_index: 0, timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000);
    const onV2 = videoClip({ clip_id: "v2b" as never, order_index: 0, track_id: "V2" as never, timeline_start_us: 1_000_000, timeline_end_us: 3_000_000 }, 2_000_000);
    const dragged = videoClip({ clip_id: "d" as never, order_index: 1, timeline_start_us: 4_000_000, timeline_end_us: 5_000_000 }, 1_000_000);
    // 从 V1 拖到 V2，压住 v2b 左半边 → 优先放它前方（[0,1s) 空档容得下 1s）。
    const before = resolveMoveTarget([v1, onV2, dragged], dragged, 1_500_000, "V2", 0.2);
    expect(before).toMatchObject({ startUs: 0, trackId: "V2", mode: "before" });
    // 右半边 → 优先放它后方（[3s,…) 空档容得下）。
    const after = resolveMoveTarget([v1, onV2, dragged], dragged, 2_500_000, "V2", 0.8);
    expect(after).toMatchObject({ startUs: 3_000_000, trackId: "V2", mode: "after" });
  });

  it("falls back to swapping positions, then appending at the track tail", () => {
    // 目标轨：v2a [1s,3s)、v2b [3s,5s) 首尾相接；前方槽位为负、后方被 v2b 挡住
    // → 交换（v2a 回到拖动片段在 V1 的原位 [6s,8s)）。
    const left = videoClip({ clip_id: "l" as never, order_index: 0, timeline_start_us: 0, timeline_end_us: 2_000_000 }, 2_000_000);
    const right = videoClip({ clip_id: "r" as never, order_index: 1, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 }, 2_000_000);
    const v2a = videoClip({ clip_id: "v2a" as never, order_index: 0, track_id: "V2" as never, timeline_start_us: 1_000_000, timeline_end_us: 3_000_000 }, 2_000_000);
    const v2b = videoClip({ clip_id: "v2b" as never, order_index: 1, track_id: "V2" as never, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 }, 2_000_000);
    const dragged = videoClip({ clip_id: "d" as never, order_index: 2, timeline_start_us: 6_000_000, timeline_end_us: 8_000_000 }, 2_000_000);
    const swap = resolveMoveTarget([left, right, v2a, v2b, dragged], dragged, 1_500_000, "V2", 0.2);
    expect(swap.mode).toBe("swap");
    expect(swap.startUs).toBe(1_000_000);
    expect(swap.displaced).toMatchObject({ clipId: "v2a", trackId: "V1", startUs: 6_000_000 });
    // 原拖动位被 filler 占用（无法无损交换）→ 接到目标轨尾部（5s）。
    const filler = videoClip({ clip_id: "f" as never, order_index: 3, timeline_start_us: 6_000_000, timeline_end_us: 8_000_000 }, 2_000_000);
    const append = resolveMoveTarget([left, right, v2a, v2b, filler, dragged], dragged, 1_500_000, "V2", 0.2);
    expect(append).toMatchObject({ startUs: 5_000_000, trackId: "V2", mode: "append" });
  });
});

describe("Round 5 — fit zoom", () => {
  it("fits the whole timeline into the viewport", () => {
    // 4s into (1320 - 120 - 40)px → 290pps
    expect(fitZoomPps(4_000_000, 1320, 120)).toBe(290);
  });

  it("clamps to the zoom limits", () => {
    expect(fitZoomPps(0.1_000_000, 1320, 120)).toBe(ZOOM_MAX_PPS); // min content → max zoom
    expect(fitZoomPps(3600_000_000, 1320, 120)).toBe(ZOOM_MIN_PPS); // hour-long → min zoom
  });
});

describe("Round 5 — 同轨组移动钳制", () => {
  const a = videoClip({ clip_id: "a" as never, order_index: 0, timeline_start_us: 0, timeline_end_us: 1_000_000 }, 1_000_000);
  const b = videoClip({ clip_id: "b" as never, order_index: 1, timeline_start_us: 1_000_000, timeline_end_us: 2_000_000 }, 1_000_000);
  // 障碍片段与组之间留 0.25s 空隙（c 从 2.25s 起），保证"贴左缘/贴右缘"距离不对称。
  const c = videoClip({ clip_id: "c" as never, order_index: 2, timeline_start_us: 2_250_000, timeline_end_us: 3_250_000 }, 1_000_000);
  const x = videoClip({ clip_id: "x" as never, track_id: "A1", order_index: 1, timeline_start_us: 0, timeline_end_us: 1_000_000 }, 1_000_000);

  it("keeps a feasible raw delta unchanged", () => {
    // 组 [a] 右移 0.4s → [0.4s, 1.4s)，距 c [2.25s,3.25s) 仍无重叠。
    expect(clampGroupDelta([a], [c], 400_000)).toBe(400_000);
  });

  it("clamps a colliding delta flush against the nearest obstacle edge", () => {
    // 单成员：组 [a] 右移 2s 撞 c → 可行边界为贴 c 左缘（Δ=1.25s）或越过 c（Δ=3.25s），取更近的 1.25s。
    expect(clampGroupDelta([a], [c], 2_000_000)).toBe(1_250_000);
    // 双成员刚体：组 [a,b]（跨 [0,2s)）右移 2s 撞 c → 最近可行边界是"组首贴 c 右缘"（Δ=3.25s），
    // 而不是回退到贴 c 左缘（Δ=0.25s）。
    expect(clampGroupDelta([a, b], [c], 2_000_000)).toBe(3_250_000);
  });

  it("never translates the group before the timeline origin", () => {
    // 组 [a,b] 左移 3s：受 -minStart 下界钳制为 0（原地不动）。
    expect(clampGroupDelta([a, b], [], -3_000_000)).toBe(0);
  });

  it("ignores A1 clips as obstacles", () => {
    // A1 片段不是 V1 障碍物：结果与单障碍场景一致。
    expect(clampGroupDelta([a], [x, c], 2_000_000)).toBe(1_250_000);
  });
});
