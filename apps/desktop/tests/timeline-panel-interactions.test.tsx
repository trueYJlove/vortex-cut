import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { isTimelinePatchOperation, type TimelineDocument, type TimelinePatchOperation } from "@aivideo/contracts";
import { TimelinePanel } from "../src/app/timeline/TimelineCanvas.js";
import { timelineZoomToPps } from "../src/app/timeline/geometry.js";
import { DEFAULT_VIEW_STATE, TIMELINE_HEAD_WIDTH, TIMELINE_PREFS_STORAGE_KEY, TIMELINE_ZOOM_DEFAULT } from "../src/app/timeline/types.js";
import { saveMarkers } from "../src/app/timeline/markers.js";
import { closeGapAt } from "../src/app/timeline/close-gap.js";
import { expandLinkedClipIds, mergeLinkedMarqueeSelection } from "../src/app/timeline/linked-clips.js";
import { createPlayheadStore } from "../src/app/timeline/playhead-store.js";
import { planCompactMainTrack, planMagneticDelete, planMagneticDrop, planMagneticMove, planMagneticSpeed, planMagneticTrim, planMagneticImageTrim, planRippleDelete } from "../src/app/timeline/magnetic-plan.js";

const doc = (overrides: Partial<TimelineDocument> = {}): TimelineDocument => ({
  schema_version: 1,
  project_id: "p1" as never,
  canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, background_color: "#000000" },
  tracks: [
    { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false },
    { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
    { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
  ],
  clips: [
    {
      clip_id: "clip_1" as never,
      track_id: "V1",
      order_index: 0,
      asset_id: "a1" as never,
      asset_kind: "video",
      source_start_us: 0,
      source_end_us: 2_000_000,
      timeline_start_us: 0,
      timeline_end_us: 2_000_000,
      layout: "fit",
      audio: { enabled: true, gain_db: 0 },
    },
  ],
  captions: [],
  provenance: { created_by: "user", source_transcript_ids: [] },
  ...overrides,
});

// TimelineCanvas starts at 800px in jsdom (ResizeObserver is intentionally a no-op).
// Keep interaction fixtures tied to the new project-relative default zoom instead
// of baking in the retired 60px/s scale.
const TEST_CANVAS_WIDTH = 800;
const testPps = (totalUs = 2_000_000) => timelineZoomToPps(
  totalUs,
  TEST_CANVAS_WIDTH - DEFAULT_VIEW_STATE.headerWidth,
  TIMELINE_ZOOM_DEFAULT,
);
const canvasXAt = (timeSeconds: number, totalUs = 2_000_000) =>
  DEFAULT_VIEW_STATE.headerWidth + testPps(totalUs) * timeSeconds;
const rulerXAt = (timeSeconds: number, totalUs = 2_000_000) =>
  TIMELINE_HEAD_WIDTH + canvasXAt(timeSeconds, totalUs);

function baseProps() {
  return {
    selection: null,
    setSelection: vi.fn(),
    onPatch: vi.fn().mockResolvedValue(undefined),
    onDropAsset: vi.fn(),
    canUndo: false,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    assetMedia: [],
    onSeek: vi.fn(),
    onCommand: vi.fn(),
  };
}

function firePointer(target: Element, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", init: MouseEventInit = {}) {
  fireEvent(target, Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }), {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  }));
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("Timeline Round 4 — 磁吸开关", () => {
  it("片段时长变化时保持 OpenFilm 的 px/s 时间尺度", () => {
    const props = baseProps();
    const initial = doc();
    const { container, rerender } = render(<TimelinePanel document={initial} {...props} />);
    const canvas = container.querySelector('canvas[aria-label="时间线画布"]')!;
    const before = Number(canvas.getAttribute("data-timeline-pps"));
    const extendedClip = {
      ...initial.clips[0]!,
      source_end_us: 4_000_000,
      timeline_end_us: 4_000_000,
    };

    rerender(<TimelinePanel document={doc({ clips: [extendedClip] })} {...props} />);
    expect(Number(canvas.getAttribute("data-timeline-pps"))).toBeCloseTo(before, 6);
  });

  it("空时间线的首个短片段保持 18 秒 opening view", () => {
    const props = baseProps();
    const empty = doc({ clips: [] });
    const { container, rerender } = render(<TimelinePanel document={empty} {...props} />);
    const canvas = container.querySelector('canvas[aria-label="时间线画布"]')!;
    const before = Number(canvas.getAttribute("data-timeline-pps"));
    const firstClip = { ...doc().clips[0]!, source_end_us: 4_000_000, timeline_end_us: 4_000_000 };

    rerender(<TimelinePanel document={doc({ clips: [firstClip] })} {...props} />);
    expect(Number(canvas.getAttribute("data-timeline-pps"))).toBeCloseTo(before, 6);
  });

  it("首次载入长项目使用项目相对默认缩放", () => {
    const props = baseProps();
    const { container, rerender } = render(<TimelinePanel document={doc({ clips: [] })} {...props} />);
    const canvas = container.querySelector('canvas[aria-label="时间线画布"]')!;
    const emptyPps = Number(canvas.getAttribute("data-timeline-pps"));
    const longClip = {
      ...doc().clips[0]!,
      source_end_us: 60_000_000,
      timeline_end_us: 60_000_000,
    };

    rerender(<TimelinePanel document={doc({ clips: [longClip] })} {...props} />);
    const expected = timelineZoomToPps(60_000_000, TEST_CANVAS_WIDTH - DEFAULT_VIEW_STATE.headerWidth, TIMELINE_ZOOM_DEFAULT);
    expect(Number(canvas.getAttribute("data-timeline-pps"))).toBeCloseTo(expected, 6);
    expect(Number(canvas.getAttribute("data-timeline-pps"))).toBeLessThan(emptyPps);
  });

  it("缩短现有项目保持时间尺度，清空后恢复 18 秒视图", () => {
    const props = baseProps();
    const longClip = {
      ...doc().clips[0]!,
      source_end_us: 12_000_000,
      timeline_end_us: 12_000_000,
    };
    const { container, rerender } = render(<TimelinePanel document={doc({ clips: [longClip] })} {...props} />);
    const canvas = container.querySelector('canvas[aria-label="时间线画布"]')!;
    const existingPps = Number(canvas.getAttribute("data-timeline-pps"));
    const shortClip = { ...longClip, source_end_us: 4_000_000, timeline_end_us: 4_000_000 };

    rerender(<TimelinePanel document={doc({ clips: [shortClip] })} {...props} />);
    expect(Number(canvas.getAttribute("data-timeline-pps"))).toBeCloseTo(existingPps, 6);

    rerender(<TimelinePanel document={doc({ clips: [] })} {...props} />);
    const timeWidthPx = TEST_CANVAS_WIDTH - DEFAULT_VIEW_STATE.headerWidth;
    expect(Number(canvas.getAttribute("data-timeline-pps"))).toBeCloseTo(timeWidthPx / 18, 6);
  });

  it("ripple deletes on video and audio tracks and protects locked successors", () => {
    const main = doc().clips[0];
    const overlay = { ...main, clip_id: "overlay" as never, track_id: "V2" };
    const next = { ...overlay, clip_id: "overlay-next" as never, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    const audio = { ...main, clip_id: "audio" as never, track_id: "A1", asset_kind: "audio" as const };
    const overlappingAudio = { ...audio, clip_id: "audio-overlap" as never, timeline_start_us: 500_000, timeline_end_us: 2_500_000 };
    const nextAudio = { ...audio, clip_id: "audio-next" as never, timeline_start_us: 4_000_000, timeline_end_us: 6_000_000 };
    const tracks = [...doc().tracks, { ...doc().tracks[1], id: "V2" }];
    const timeline = doc({ tracks, clips: [main, overlay, next, audio, overlappingAudio, nextAudio] });
    const targets = [overlay, audio, overlappingAudio];
    expect(planRippleDelete(timeline, targets, true).operations).toEqual([
      ...targets.map(clip => ({ op: "remove_clip", clip_id: clip.clip_id })),
      { op: "position_clips", placements: [
        { clip_id: next.clip_id, timeline_start_us: 1_000_000 },
        { clip_id: nextAudio.clip_id, timeline_start_us: 1_500_000 },
      ] },
    ]);
    expect(planRippleDelete({ ...timeline, locked_elements: [next.clip_id] }, targets, true).operations).toEqual([]);
  });
  it("关闭主轨空隙时联动短覆盖片段，并为重叠素材创建兼容轨", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    const overlay = { ...first, clip_id: "overlay" as never, track_id: "V2", timeline_start_us: 3_200_000, timeline_end_us: 4_000_000 };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    const result = planCompactMainTrack(doc({ clips: [first, second, overlay], tracks }), true);
    expect(result.operations).toEqual([{ op: "position_clips", placements: [
      { clip_id: second.clip_id, timeline_start_us: 2_000_000 },
      { clip_id: overlay.clip_id, timeline_start_us: 2_200_000 },
    ] }]);
    const obstacle = { ...overlay, clip_id: "obstacle" as never, timeline_start_us: 2_000_000, timeline_end_us: 2_400_000 };
    const settled = planCompactMainTrack(doc({ clips: [first, second, overlay, obstacle], tracks }), true);
    expect(settled.operations).toEqual([
      { op: "add_track", kind: "video", track_id: "V3", before_track_id: "V2" },
      { op: "position_clips", placements: [
        { clip_id: second.clip_id, timeline_start_us: 2_000_000 },
        { clip_id: overlay.clip_id, timeline_start_us: 2_200_000, track_id: "V3" },
      ] },
    ]);
  });
  it("磁吸删除主轨时删除附着画面、保留声音并联动后续片段", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const overlay = { ...first, clip_id: "overlay" as never, track_id: "V2", timeline_start_us: 200_000, timeline_end_us: 1_000_000 };
    const later = { ...overlay, clip_id: "later" as never, timeline_start_us: 2_200_000, timeline_end_us: 3_000_000 };
    const sound = { ...overlay, clip_id: "sound" as never, track_id: "A1", asset_kind: "audio" as const };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    const plan = planMagneticDelete(doc({ clips: [first, second, overlay, later, sound], tracks }), [first], true);
    expect(plan.operations).toEqual([
      { op: "remove_clip", clip_id: first.clip_id },
      { op: "remove_clip", clip_id: overlay.clip_id },
      { op: "position_clips", placements: [
        { clip_id: second.clip_id, timeline_start_us: 0 },
        { clip_id: later.clip_id, timeline_start_us: 200_000 },
      ] },
    ]);
    const gapped = { ...second, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    expect(planMagneticDelete(doc({ clips: [first, gapped] }), [first], false).operations).toEqual([
      { op: "remove_clip", clip_id: first.clip_id },
      { op: "position_clips", placements: [{ clip_id: gapped.clip_id, timeline_start_us: 1_000_000 }] },
    ]);
  });
  it("主轨磁吸换序时将覆盖片段随宿主移动", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const overlay = { ...first, clip_id: "overlay" as never, track_id: "V2", timeline_start_us: 200_000, timeline_end_us: 1_000_000 };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    expect(planMagneticMove(doc({ clips: [first, second, overlay], tracks }), first.clip_id, 4_000_000, true).operations).toEqual([
      { op: "position_clips", placements: [
        { clip_id: first.clip_id, timeline_start_us: 2_000_000 },
        { clip_id: second.clip_id, timeline_start_us: 0 },
        { clip_id: overlay.clip_id, timeline_start_us: 2_200_000 },
      ] },
    ]);
  });
  it("主轨磁吸换序可原子规划超过 100 个片段的位置", () => {
    const template = { ...doc().clips[0], source_end_us: 1_000_000, timeline_end_us: 1_000_000 };
    const clips = Array.from({ length: 102 }, (_, index) => ({
      ...template,
      clip_id: `magnetic_${index}` as never,
      order_index: index,
      timeline_start_us: index * 2_000_000,
      timeline_end_us: index * 2_000_000 + 1_000_000,
    }));
    const result = planMagneticMove(doc({ clips }), clips.at(-1)!.clip_id, 0, true);
    expect(result.reason).toBeUndefined();
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]?.op).toBe("position_clips");
    if (result.operations[0]?.op !== "position_clips") throw new Error("expected one bulk position patch");
    expect(result.operations[0].placements).toHaveLength(101);
    expect(result.operations[0].placements.find(item => item.clip_id === clips.at(-1)!.clip_id)?.timeline_start_us).toBe(0);
  });
  it("主轨拖放换序自动闭合并联动后续覆盖片段", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const overlay = { ...first, clip_id: "overlay" as never, track_id: "V2", timeline_start_us: 2_200_000, timeline_end_us: 3_000_000 };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    expect(planMagneticMove(doc({ clips: [first, second, overlay], tracks }), second.clip_id, 0, true).operations).toEqual([
      { op: "position_clips", placements: [
        { clip_id: first.clip_id, timeline_start_us: 2_000_000 },
        { clip_id: second.clip_id, timeline_start_us: 0 },
        { clip_id: overlay.clip_id, timeline_start_us: 200_000 },
      ] },
    ]);
  });
  it("从其他视频轨拖入主轨时按指针插入并自动闭合", () => {
    const first = doc().clips[0];
    const incoming = { ...first, clip_id: "incoming" as never, track_id: "V2", timeline_start_us: 5_000_000, timeline_end_us: 7_000_000 };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    expect(planMagneticDrop(doc({ clips: [first, incoming], tracks }), incoming.clip_id, "V1", 1_000_000, 1_000_000, true).operations).toEqual([
      { op: "position_clips", placements: [{ clip_id: incoming.clip_id, timeline_start_us: 2_000_000, track_id: "V1" }] },
    ]);
  });
  it("将主轨片段移出时闭合主轨空隙", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    expect(planMagneticDrop(doc({ clips: [first, second], tracks }), first.clip_id, "V2", 5_000_000, 5_000_000, true).operations).toEqual([
      { op: "position_clips", placements: [{ clip_id: second.clip_id, timeline_start_us: 0 }] },
      { op: "position_clip", clip_id: first.clip_id, timeline_start_us: 5_000_000, track_id: "V2" },
    ]);
  });
  it("主轨修剪后自动推移后续内容并保持链接轨道的开头", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const result = planMagneticTrim(doc({ clips: [first, second] }), first, 0, 1_500_000, true);
    expect(result.operations).toEqual([
      { op: "trim_clip", clip_id: first.clip_id, source_start_us: 0, source_end_us: 1_500_000 },
      { op: "position_clips", placements: [{ clip_id: second.clip_id, timeline_start_us: 1_500_000 }] },
    ]);
  });
  it("图片左边缘修剪保持右端锚定，并在主轨磁吸时推移后续片段", () => {
    const still = { ...doc().clips[0], asset_kind: "image" as const, source_start_us: null, source_end_us: null };
    const next = { ...still, clip_id: "still_next" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const timeline = doc({ clips: [still, next] });
    expect(planMagneticImageTrim(timeline, still, "left", 500_000, true, false).operations).toEqual([
      { op: "set_image_duration", clip_id: still.clip_id, duration_us: 1_500_000 },
      { op: "position_clips", placements: [{ clip_id: still.clip_id, timeline_start_us: 500_000 }] },
    ]);
    expect(planMagneticImageTrim(timeline, still, "left", 500_000, true, true).operations).toEqual([
      { op: "set_image_duration", clip_id: still.clip_id, duration_us: 1_500_000 },
      { op: "position_clips", placements: [{ clip_id: next.clip_id, timeline_start_us: 1_500_000 }] },
    ]);
  });
  it("Alt 图片修剪忽略显式链接伙伴但保留主轨磁吸", () => {
    const still = { ...doc().clips[0]!, asset_kind: "image" as const, source_start_us: null, source_end_us: null, link_group_id: "still-pair" };
    const partner = { ...still, clip_id: "still_partner" as never, track_id: "V2", link_group_id: "still-pair" };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    const timeline = doc({ clips: [still, partner], tracks });
    expect(planMagneticImageTrim(timeline, still, "right", 500_000, true, false, true).operations).toEqual([
      { op: "set_image_duration", clip_id: still.clip_id, duration_us: 2_500_000 },
    ]);
  });
  it("主轨变速时磁吸开关控制后续推移，联动开关带动覆盖素材", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const overlay = { ...first, clip_id: "overlay" as never, track_id: "V2", timeline_start_us: 2_200_000, timeline_end_us: 3_000_000 };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    expect(planMagneticSpeed(doc({ clips: [first, second, overlay], tracks }), first, 2000, true, true).operations).toEqual([
      { op: "set_speed", clip_id: first.clip_id, speed_milli: 2000, ripple: false },
      { op: "position_clips", placements: [
        { clip_id: second.clip_id, timeline_start_us: 1_000_000 },
        { clip_id: overlay.clip_id, timeline_start_us: 1_200_000 },
      ] },
    ]);
    expect(planMagneticSpeed(doc({ clips: [first, second, overlay], tracks }), first, 500, false, true).operations).toEqual([
      { op: "set_speed", clip_id: first.clip_id, speed_milli: 500, ripple: false },
    ]);
  });
  it("I/O 设置时间区间并在切换项目时清空", () => {
    const store = createPlayheadStore();
    store.dispatch({ source: "user", timeUs: 500_000 });
    const { rerender } = render(<TimelinePanel document={doc()} {...baseProps()} playheadStore={store} />);
    fireEvent.keyDown(window, { key: "i" });
    expect(screen.getByRole("slider", { name: "时间区间入点" })).toHaveAttribute("aria-valuenow", "0.5");
    store.dispatch({ source: "user", timeUs: 1_500_000 });
    fireEvent.keyDown(window, { key: "o" });
    expect(screen.getByRole("slider", { name: "时间区间出点" })).toHaveAttribute("aria-valuenow", "1.5");
    rerender(<TimelinePanel document={doc({ project_id: "p2" as never })} {...baseProps()} playheadStore={store} />);
    expect(screen.queryByRole("slider", { name: "时间区间入点" })).toBeNull();
  });
  it("关闭指定空隙时保留后续片段间距，且不移动锁定或链接片段", () => {
    const first = doc().clips[0];
    const next = { ...first, clip_id: "clip_2" as never, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    const last = { ...first, clip_id: "clip_3" as never, timeline_start_us: 6_000_000, timeline_end_us: 8_000_000 };
    expect(closeGapAt(doc({ clips: [first, next, last] }), "V1", 2_500_000)).toEqual([{ op: "position_clips", placements: [
      { clip_id: next.clip_id, timeline_start_us: 2_000_000 },
      { clip_id: last.clip_id, timeline_start_us: 5_000_000 },
    ] }]);
    const sound = { ...next, clip_id: "sound" as never, track_id: "A1", asset_kind: "audio" as const, link_group_id: "g" };
    expect(closeGapAt(doc({ clips: [first, { ...next, link_group_id: "g" }, last, sound] }), "V1", 2_500_000)).toEqual([{ op: "position_clips", placements: [
      { clip_id: next.clip_id, timeline_start_us: 2_000_000 },
      { clip_id: last.clip_id, timeline_start_us: 5_000_000 },
      { clip_id: sound.clip_id, timeline_start_us: 2_000_000 },
    ] }]);
    expect(closeGapAt(doc({ clips: [first, { ...next, link_group_id: "g" }, last, sound], locked_elements: [sound.clip_id] }), "V1", 2_500_000)).toEqual([]);
    expect(closeGapAt(doc({ clips: [first, next, last], locked_elements: [last.clip_id] }), "V1", 2_500_000)).toEqual([]);
    expect(isTimelinePatchOperation({ op: "position_clips", placements: [
      { clip_id: next.clip_id, timeline_start_us: 0 }, { clip_id: next.clip_id, timeline_start_us: 1 },
    ] })).toBe(false);
  });
  it("关闭空隙可一次移动超过 100 个片段", () => {
    const first = { ...doc().clips[0], source_end_us: 1_000_000, timeline_end_us: 1_000_000 };
    const following = Array.from({ length: 101 }, (_, index) => ({
      ...first,
      clip_id: `bulk_${index}` as never,
      order_index: index + 1,
      timeline_start_us: (2_000_000 + index * 2_000_000),
      timeline_end_us: (3_000_000 + index * 2_000_000),
    }));
    const operations = closeGapAt(doc({ clips: [first, ...following] }), "V1", 1_500_000);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe("position_clips");
    if (operations[0]?.op !== "position_clips") throw new Error("expected a bulk position patch");
    expect(operations[0].placements).toHaveLength(101);
    expect(operations[0].placements[0]).toEqual({ clip_id: "bulk_0", timeline_start_us: 1_000_000 });
    expect(operations[0].placements.at(-1)).toEqual({ clip_id: "bulk_100", timeline_start_us: 201_000_000 });
  });
  it("从轨道空隙右键菜单提交关闭空隙", () => {
    const first = doc().clips[0];
    const next = { ...first, clip_id: "clip_2" as never, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    const props = baseProps();
    const { container } = render(<TimelinePanel document={doc({ clips: [first, next] })} {...props} />);
    fireEvent.contextMenu(container.querySelector("canvas")!, {
      clientX: canvasXAt(2.5, 5_000_000),
      clientY: 102,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭空隙" }));
    expect(props.onPatch).toHaveBeenCalledWith([{ op: "position_clips", placements: [{ clip_id: next.clip_id, timeline_start_us: 2_000_000 }] }], "关闭空隙");
  });
  it("把新增轨道入口放进时间线空白处的右键菜单", () => {
    const props = baseProps();
    const first = doc().clips[0];
    const later = { ...first, clip_id: "clip_later" as never, order_index: 1, timeline_start_us: 4_000_000, timeline_end_us: 6_000_000 };
    const { container } = render(<TimelinePanel document={doc({ clips: [first, later] })} {...props} />);
    fireEvent.contextMenu(container.querySelector("canvas")!, {
      clientX: canvasXAt(2.5, 6_000_000),
      clientY: 124,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "添加轨道" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "视频轨道" }));
    expect(props.onPatch).toHaveBeenCalledWith([{ op: "add_track", kind: "video" }], "添加视频轨道");
  });
  it("从右键显示设置更改并持久化波形比例与默认轨高", () => {
    const props = baseProps();
    const first = doc().clips[0];
    const later = { ...first, clip_id: "clip_later" as never, order_index: 1, timeline_start_us: 4_000_000, timeline_end_us: 6_000_000 };
    const { container } = render(<TimelinePanel document={doc({ clips: [first, later] })} {...props} />);
    const canvas = container.querySelector("canvas")!;
    const openMenu = () => fireEvent.contextMenu(canvas, { clientX: canvasXAt(2.5, 6_000_000), clientY: 124 });

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "显示设置" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "波形占比 60%" }));
    expect(JSON.parse(window.localStorage.getItem(TIMELINE_PREFS_STORAGE_KEY) ?? "{}").waveformRatio).toBe(0.6);

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "显示设置" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "增加 4px" }));
    expect(JSON.parse(window.localStorage.getItem(TIMELINE_PREFS_STORAGE_KEY) ?? "{}").trackHeight).toBe(60);
  });
  it("链接选中片段后可按组解除链接", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, track_id: "A1", asset_kind: "audio" as const };
    const props = baseProps();
    const selected = { kind: "clips" as const, ids: [first.clip_id, second.clip_id] };
    const { container, rerender } = render(<TimelinePanel document={doc({ clips: [first, second] })} {...props} selection={selected} />);
    const canvas = container.querySelector("canvas")!;
    fireEvent.contextMenu(canvas, { clientX: canvasXAt(1, 5_000_000), clientY: 102 });
    fireEvent.click(screen.getByRole("menuitem", { name: "链接片段" }));
    expect(props.onPatch).toHaveBeenCalledWith([{ op: "set_clip_link", clip_ids: [first.clip_id, second.clip_id] }], "链接片段");
    rerender(<TimelinePanel document={doc({ clips: [{ ...first, link_group_id: "g" }, { ...second, link_group_id: "g" }] })} {...props} selection={selected} />);
    fireEvent.contextMenu(canvas, { clientX: canvasXAt(1, 5_000_000), clientY: 102 });
    fireEvent.click(screen.getByRole("menuitem", { name: "取消片段链接" }));
    expect(props.onPatch).toHaveBeenLastCalledWith([{ op: "clear_clip_link", clip_id: first.clip_id }], "取消片段链接");
    fireEvent.contextMenu(canvas, { clientX: canvasXAt(1, 5_000_000), clientY: 102 });
    fireEvent.click(screen.getByRole("menuitem", { name: "删除并闭合主轨" }));
    expect(props.onPatch).toHaveBeenLastCalledWith([{ op: "remove_clip", clip_id: first.clip_id }], "主轨磁吸删除");
  });
  it("按下 Alt 时复制链接片段组并保留原片段", () => {
    const first = { ...doc().clips[0], link_group_id: "g" };
    const second = { ...first, clip_id: "clip_2" as never, track_id: "A1", asset_kind: "audio" as const };
    const props = baseProps();
    const { container } = render(<TimelinePanel document={doc({ clips: [first, second] })} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    firePointer(canvas, "pointerdown", { clientX: canvasXAt(1.65), clientY: 102, button: 0, altKey: true });
    firePointer(canvas, "pointermove", { clientX: canvasXAt(2.65), clientY: 102, buttons: 1, altKey: true });
    firePointer(canvas, "pointerup", { clientX: canvasXAt(2.65), clientY: 102, button: 0, altKey: true });
    expect(props.setSelection).toHaveBeenCalledWith({ kind: "clips", ids: [first.clip_id, second.clip_id] });
    const [operations, summary] = props.onPatch.mock.calls.at(-1)!;
    expect(summary).toBe("复制片段");
    const duplicate = (operations as TimelinePatchOperation[]).find(operation => operation.op === "duplicate_timeline_items");
    expect(duplicate).toMatchObject({ op: "duplicate_timeline_items" });
    if (duplicate?.op !== "duplicate_timeline_items") throw new Error("Expected duplicate_timeline_items operation");
    expect(duplicate.copies).toEqual(expect.arrayContaining([
      expect.objectContaining({ item_kind: "clip", source_id: first.clip_id, track_id: "V1", timeline_start_us: 2_000_000 }),
      expect.objectContaining({ item_kind: "clip", source_id: second.clip_id, track_id: "A1", timeline_start_us: 2_000_000 }),
    ]));
    expect(operations).not.toContainEqual(expect.objectContaining({ op: "add_track", kind: "audio" }));
    expect(operations).not.toContainEqual(expect.objectContaining({ op: "remove_clip", clip_id: first.clip_id }));
  });
  it("Shift+Alt 拖动未选中的片段时只复制被拖片段及其链接伙伴", () => {
    const first = { ...doc().clips[0]!, clip_id: "selected-a" as never, timeline_start_us: 0, timeline_end_us: 800_000 };
    const second = { ...first, clip_id: "selected-b" as never, timeline_start_us: 800_000, timeline_end_us: 1_600_000 };
    const dragged = { ...first, clip_id: "dragged-c" as never, timeline_start_us: 1_600_000, timeline_end_us: 2_400_000 };
    const selected = { kind: "clips" as const, ids: [first.clip_id, second.clip_id] };
    const props = baseProps();
    const { container } = render(<TimelinePanel document={doc({ clips: [first, second, dragged] })} {...props} selection={selected} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    firePointer(canvas, "pointerdown", { clientX: canvasXAt(1.9, 2_400_000), clientY: 102, button: 0, shiftKey: true, altKey: true });
    expect(props.setSelection).toHaveBeenLastCalledWith({ kind: "clip", id: dragged.clip_id });
    firePointer(canvas, "pointermove", { clientX: canvasXAt(2.8, 2_400_000), clientY: 102, buttons: 1, shiftKey: true, altKey: true });
    firePointer(canvas, "pointerup", { clientX: canvasXAt(2.8, 2_400_000), clientY: 102, button: 0, shiftKey: true, altKey: true });

    const [operations, summary] = props.onPatch.mock.calls.at(-1)!;
    expect(summary).toBe("复制片段");
    const duplicate = (operations as TimelinePatchOperation[]).find(operation => operation.op === "duplicate_timeline_items");
    expect(duplicate).toMatchObject({ op: "duplicate_timeline_items" });
    if (duplicate?.op !== "duplicate_timeline_items") throw new Error("Expected duplicate_timeline_items operation");
    expect(duplicate.copies).toHaveLength(1);
    expect(duplicate.copies[0]?.source_id).toBe(dragged.clip_id);
  });

  it("框选命中集中的链接成员会扩展为完整链接组", () => {
    const video = { ...doc().clips[0]!, clip_id: "marquee-video" as never, link_group_id: "marquee-av" };
    const audio = { ...video, clip_id: "marquee-audio" as never, track_id: "A1", asset_kind: "audio" as const };
    expect(expandLinkedClipIds([video.clip_id], [video, audio])).toEqual([video.clip_id, audio.clip_id]);
  });
  it("Shift 框选把之前的单片段选区和新命中的链接组一起保留", () => {
    const previous = { ...doc().clips[0]!, clip_id: "marquee-previous" as never, link_group_id: "marquee-previous-av" };
    const previousPartner = { ...previous, clip_id: "marquee-previous-audio" as never, track_id: "A1", asset_kind: "audio" as const };
    const hit = { ...previous, clip_id: "marquee-hit" as never, link_group_id: "marquee-hit-av" };
    const hitPartner = { ...hit, clip_id: "marquee-hit-audio" as never, track_id: "A1", asset_kind: "audio" as const };
    expect(mergeLinkedMarqueeSelection(
      { kind: "clip", id: previous.clip_id },
      [hit.clip_id],
      [previous, previousPartner, hit, hitPartner],
    )).toEqual([previous.clip_id, previousPartner.clip_id, hit.clip_id, hitPartner.clip_id]);
  });
  it("拖动时只提交可写的链接成员，锁定伙伴留给 Core 保持原位", () => {
    const source = { ...doc().clips[0]!, track_id: "V2", link_group_id: "locked-link" };
    const lockedPartner = {
      ...source,
      clip_id: "locked-audio" as never,
      track_id: "A1",
      asset_kind: "audio" as const,
    };
    const videoTrack = { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false };
    const timeline = doc({
      tracks: [...doc().tracks.slice(0, 2), videoTrack, doc().tracks[2]!],
      clips: [source, lockedPartner],
      locked_elements: [lockedPartner.clip_id],
    });
    window.localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify({ snappingEnabled: false, mainTrackMagnet: false }));
    const props = baseProps();
    const { container } = render(<TimelinePanel document={timeline} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const head = container.querySelector<HTMLElement>('.timeline-track-head[data-track-id="V2"]')!;
    const y = Number(head.style.top.replace("px", "")) + Number(head.style.height.replace("px", "")) / 2;
    firePointer(canvas, "pointerdown", { clientX: canvasXAt(0.5), clientY: y, button: 0 });
    firePointer(canvas, "pointermove", { clientX: canvasXAt(1.5), clientY: y, buttons: 1 });
    firePointer(canvas, "pointerup", { clientX: canvasXAt(1.5), clientY: y, button: 0 });

    expect(props.onPatch).toHaveBeenCalledWith([
      { op: "position_clips", placements: [{ clip_id: source.clip_id, track_id: "V2", timeline_start_us: 1_000_000 }] },
    ], "移动片段");
  });
  it("中心拖放替换先确认，取消不提交，确认后才原子提交", () => {
    const source = doc().clips[0]!;
    const target = { ...source, clip_id: "replace-target" as never, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    const props = baseProps();
    const { container } = render(<TimelinePanel document={doc({ clips: [source, target] })} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const dragToReplace = () => {
      firePointer(canvas, "pointerdown", { clientX: canvasXAt(1, 5_000_000), clientY: 102, button: 0 });
      firePointer(canvas, "pointermove", { clientX: canvasXAt(4, 5_000_000), clientY: 102, buttons: 1 });
      firePointer(canvas, "pointerup", { clientX: canvasXAt(4, 5_000_000), clientY: 102, button: 0 });
    };

    dragToReplace();
    expect(screen.getByRole("alertdialog", { name: "替换时间线片段？" })).toBeInTheDocument();
    expect(props.onPatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(props.onPatch).not.toHaveBeenCalled();

    dragToReplace();
    fireEvent.click(screen.getByRole("button", { name: "确认替换" }));
    expect(props.onPatch).toHaveBeenCalledTimes(1);
    expect(props.onPatch).toHaveBeenCalledWith(expect.arrayContaining([
      { op: "remove_clip", clip_id: target.clip_id, ignore_link: true },
      expect.objectContaining({ op: "position_clips" }),
    ]), "替换片段");
  });
  it("片段移动遵守 OpenFilm 的逐轴 5px 阈值", () => {
    const props = baseProps();
    window.localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify({ snappingEnabled: false, mainTrackMagnet: false }));
    const { container } = render(<TimelinePanel document={doc()} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    firePointer(canvas, "pointerdown", { clientX: 150, clientY: 102, button: 0 });
    firePointer(canvas, "pointermove", { clientX: 154, clientY: 106, buttons: 1 });
    firePointer(canvas, "pointerup", { clientX: 154, clientY: 106, button: 0 });
    expect(props.onPatch).not.toHaveBeenCalled();

    firePointer(canvas, "pointerdown", { clientX: 150, clientY: 102, button: 0 });
    firePointer(canvas, "pointermove", { clientX: 155, clientY: 102, buttons: 1 });
    firePointer(canvas, "pointerup", { clientX: 155, clientY: 102, button: 0 });
    expect(props.onPatch).toHaveBeenCalledWith(
      [expect.objectContaining({ op: "position_clips", placements: expect.arrayContaining([expect.objectContaining({ clip_id: doc().clips[0].clip_id })]) })],
      "移动片段",
    );
  });
  it("Shift 按下未选中的片段后立即拖动整个选择组", () => {
    const first = doc().clips[0]!;
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    const props = { ...baseProps(), selection: { kind: "clip" as const, id: first.clip_id } };
    window.localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify({ snappingEnabled: false, mainTrackMagnet: false }));
    const { container } = render(<TimelinePanel document={doc({ clips: [first, second] })} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    firePointer(canvas, "pointerdown", { clientX: canvasXAt(3.5, 5_000_000), clientY: 102, button: 0, shiftKey: true });
    firePointer(canvas, "pointermove", { clientX: canvasXAt(4.5, 5_000_000), clientY: 102, buttons: 1, shiftKey: true });
    firePointer(canvas, "pointerup", { clientX: canvasXAt(4.5, 5_000_000), clientY: 102, button: 0, shiftKey: true });
    expect(props.onPatch).toHaveBeenCalledWith([{
      op: "position_clips",
      placements: expect.arrayContaining([
        expect.objectContaining({ clip_id: first.clip_id, timeline_start_us: 1_000_000 }),
        expect.objectContaining({ clip_id: second.clip_id, timeline_start_us: 4_000_000 }),
      ]),
    }], "移动片段");
  });
  it("Shift 拖动已选组成员时保留并移动整组，单击才从组选区移除", () => {
    const first = doc().clips[0]!;
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    const selection = { kind: "clips" as const, ids: [first.clip_id, second.clip_id] };
    const props = { ...baseProps(), selection };
    window.localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify({ snappingEnabled: false, mainTrackMagnet: false }));
    const { container, unmount } = render(<TimelinePanel document={doc({ clips: [first, second] })} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    firePointer(canvas, "pointerdown", { clientX: canvasXAt(1.5, 5_000_000), clientY: 102, button: 0, shiftKey: true });
    firePointer(canvas, "pointermove", { clientX: canvasXAt(2.5, 5_000_000), clientY: 102, buttons: 1, shiftKey: true });
    firePointer(canvas, "pointerup", { clientX: canvasXAt(2.5, 5_000_000), clientY: 102, button: 0, shiftKey: true });
    expect(props.onPatch).toHaveBeenCalledWith([{
      op: "position_clips",
      placements: expect.arrayContaining([
        expect.objectContaining({ clip_id: first.clip_id, timeline_start_us: 1_000_000 }),
        expect.objectContaining({ clip_id: second.clip_id, timeline_start_us: 4_000_000 }),
      ]),
    }], "移动片段");

    unmount();
    const clickProps = { ...baseProps(), selection };
    const { container: clickContainer } = render(<TimelinePanel document={doc({ clips: [first, second] })} {...clickProps} />);
    const clickCanvas = clickContainer.querySelector("canvas") as HTMLCanvasElement;
    firePointer(clickCanvas, "pointerdown", { clientX: canvasXAt(1.5, 5_000_000), clientY: 102, button: 0, shiftKey: true });
    firePointer(clickCanvas, "pointerup", { clientX: canvasXAt(1.5, 5_000_000), clientY: 102, button: 0, shiftKey: true });
    expect(clickProps.setSelection).toHaveBeenCalledWith({ kind: "clip", id: first.clip_id });
    expect(clickProps.onPatch).not.toHaveBeenCalled();
  });
  it("collapses a selected group to the clicked clip on an ordinary no-drag click", () => {
    const first = doc().clips[0]!;
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    const selection = { kind: "clips" as const, ids: [first.clip_id, second.clip_id] };
    const props = { ...baseProps(), selection };
    const { container } = render(<TimelinePanel document={doc({ clips: [first, second] })} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    firePointer(canvas, "pointerdown", { clientX: canvasXAt(1.5, 5_000_000), clientY: 102, button: 0 });
    firePointer(canvas, "pointerup", { clientX: canvasXAt(1.5, 5_000_000), clientY: 102, button: 0 });
    expect(props.setSelection).toHaveBeenCalledWith({ kind: "clip", id: first.clip_id });
    expect(props.onPatch).not.toHaveBeenCalled();
  });
  it("Ctrl-click toggles a clip group without starting a move or seeking", () => {
    const first = doc().clips[0]!;
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    const selection = { kind: "clips" as const, ids: [first.clip_id, second.clip_id] };
    const props = { ...baseProps(), selection };
    const { container } = render(<TimelinePanel document={doc({ clips: [first, second] })} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    firePointer(canvas, "pointerdown", { clientX: canvasXAt(1.5, 5_000_000), clientY: 102, button: 0, ctrlKey: true });
    firePointer(canvas, "pointerup", { clientX: canvasXAt(1.5, 5_000_000), clientY: 102, button: 0, ctrlKey: true });
    expect(props.setSelection).toHaveBeenCalledWith({ kind: "clip", id: second.clip_id });
    expect(props.onPatch).not.toHaveBeenCalled();
    expect(props.onSeek).not.toHaveBeenCalled();
  });
  it("自由修剪按项目帧量化，不吸附到额外半秒网格", () => {
    const source = { ...doc().clips[0]!, timeline_start_us: 1_000_000, timeline_end_us: 3_000_000 };
    const props = baseProps();
    window.localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify({ snappingEnabled: true, mainTrackMagnet: false }));
    const { container } = render(<TimelinePanel document={doc({ clips: [source] })} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    firePointer(canvas, "pointerdown", { clientX: canvasXAt(1, 3_000_000), clientY: 102, button: 0 });
    firePointer(canvas, "pointermove", { clientX: canvasXAt(1.45, 3_000_000), clientY: 102, buttons: 1 });
    firePointer(canvas, "pointerup", { clientX: canvasXAt(1.45, 3_000_000), clientY: 102, button: 0 });
    expect(props.onPatch).toHaveBeenCalledWith([expect.objectContaining({
      op: "trim_clip",
      source_start_us: 433_333,
    })], "修剪片段");
  });
  it("8fps 项目仍允许吸附修剪到 OpenFilm 的 100ms 下限", () => {
    const source = { ...doc().clips[0]!, source_end_us: 500_000, timeline_start_us: 0, timeline_end_us: 500_000 };
    const props = baseProps();
    window.localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify({ snappingEnabled: true, mainTrackMagnet: false }));
    saveMarkers("p1", [{ id: "trim-minimum", timeUs: 100_000, color: "#ffd76e", label: "" }]);
    const { container } = render(<TimelinePanel document={doc({
      canvas: { width: 1920, height: 1080, fps_num: 8, fps_den: 1, background_color: "#000000" },
      clips: [source],
    })} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    firePointer(canvas, "pointerdown", { clientX: canvasXAt(0.5, 500_000) - 1, clientY: 102, button: 0 });
    firePointer(canvas, "pointermove", { clientX: canvasXAt(0.102, 500_000), clientY: 102, buttons: 1 });
    firePointer(canvas, "pointerup", { clientX: canvasXAt(0.102, 500_000), clientY: 102, button: 0 });
    expect(props.onPatch).toHaveBeenCalledWith([expect.objectContaining({
      op: "trim_clip",
      clip_id: source.clip_id,
      source_end_us: 100_000,
    })], "修剪片段");
  });
  it("修剪共享边缘时忽略原始边界吸附目标", () => {
    const template = doc().clips[0]!;
    const left = { ...template, clip_id: "left" as never, source_end_us: 1_000_000, timeline_start_us: 0, timeline_end_us: 1_000_000 };
    const right = { ...template, clip_id: "right" as never, source_end_us: 2_000_000, timeline_start_us: 1_000_000, timeline_end_us: 3_000_000 };
    const props = baseProps();
    window.localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify({ snappingEnabled: true, mainTrackMagnet: false }));
    const { container } = render(<TimelinePanel document={doc({ clips: [right, left] })} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const sharedEdgeX = canvasXAt(1, 3_000_000);
    firePointer(canvas, "pointerdown", { clientX: sharedEdgeX, clientY: 102, button: 0 });
    firePointer(canvas, "pointermove", { clientX: sharedEdgeX + 7, clientY: 102, buttons: 1 });
    firePointer(canvas, "pointerup", { clientX: sharedEdgeX + 7, clientY: 102, button: 0 });
    expect(props.onPatch).toHaveBeenCalledWith([expect.objectContaining({
      op: "trim_clip",
      clip_id: right.clip_id,
      source_start_us: expect.any(Number),
    })], "修剪片段");
    const [[operations]] = props.onPatch.mock.calls as unknown as [[TimelinePatchOperation[]]];
    expect(operations.find(operation => operation.op === "trim_clip")).toMatchObject({ source_start_us: 33_333 });
  });
  it("图片边缘拖动提交时长与位置，不调用视频源修剪", () => {
    const still = { ...doc().clips[0]!, asset_kind: "image" as const, source_start_us: null, source_end_us: null };
    const props = baseProps();
    window.localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify({ snappingEnabled: false, mainTrackMagnet: false }));
    const { container } = render(<TimelinePanel document={doc({ clips: [still] })} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    firePointer(canvas, "pointerdown", { clientX: canvasXAt(0) + 1, clientY: 102, button: 0 });
    firePointer(canvas, "pointermove", { clientX: canvasXAt(0.5), clientY: 102, buttons: 1 });
    firePointer(canvas, "pointerup", { clientX: canvasXAt(0.5), clientY: 102, button: 0 });
    expect(props.onPatch).toHaveBeenCalledWith([
      { op: "set_image_duration", clip_id: still.clip_id, duration_us: 1_500_000 },
      { op: "position_clips", placements: [{ clip_id: still.clip_id, timeline_start_us: 500_000 }] },
    ], "修剪图片");
  });
  it("主轨拖走时仅排除随当前宿主移动的覆盖片段，并让它跟随宿主", () => {
    const source = { ...doc().clips[0]!, timeline_start_us: 0, timeline_end_us: 2_000_000 };
    const following = { ...source, clip_id: "following" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const rider = { ...source, clip_id: "rider" as never, track_id: "V2", timeline_start_us: 1_260_000, timeline_end_us: 2_260_000 };
    const videoTrack = (id: string) => ({ id, kind: "video" as const, locked: false, hidden: false, muted: false, solo: false });
    const timeline = doc({
      tracks: [...doc().tracks.slice(0, 2), videoTrack("V2"), videoTrack("V3"), doc().tracks[2]!],
      clips: [source, following, rider],
    });
    window.localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify({
      snappingEnabled: true,
      mainTrackMagnet: true,
      linkageEnabled: true,
    }));
    const props = baseProps();
    const { container } = render(<TimelinePanel document={timeline} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const rowCenter = (trackId: string) => {
      const head = container.querySelector<HTMLElement>(`.timeline-track-head[data-track-id="${trackId}"]`);
      if (!head) throw new Error(`Missing ${trackId} row`);
      return Number(head.style.top.replace("px", "")) + Number(head.style.height.replace("px", "")) / 2;
    };
    firePointer(canvas, "pointerdown", {
      clientX: canvasXAt(0.5, 4_000_000), clientY: rowCenter("V1"), button: 0,
    });
    firePointer(canvas, "pointermove", {
      clientX: canvasXAt(2.8, 4_000_000), clientY: rowCenter("V3"), buttons: 1,
    });
    firePointer(canvas, "pointerup", {
      clientX: canvasXAt(2.8, 4_000_000), clientY: rowCenter("V3"), button: 0,
    });

    const [operations] = props.onPatch.mock.calls.at(-1)!;
    const placements = (operations as TimelinePatchOperation[]).flatMap(operation =>
      operation.op === "position_clips" ? operation.placements : [],
    );
    expect(placements).toEqual(expect.arrayContaining([
      { clip_id: source.clip_id, track_id: "V3", timeline_start_us: 2_300_000 },
      { clip_id: following.clip_id, timeline_start_us: 0 },
      { clip_id: rider.clip_id, timeline_start_us: 3_560_000 },
    ]));
  });
  it("拖动链接组时不会将较早的音频推到时间线零点之前", () => {
    const first = { ...doc().clips[0], link_group_id: "g", timeline_start_us: 1_000_000, timeline_end_us: 3_000_000 };
    const second = { ...first, clip_id: "clip_2" as never, track_id: "A1", asset_kind: "audio" as const, timeline_start_us: 0, timeline_end_us: 2_000_000 };
    const props = baseProps();
    const { container } = render(<TimelinePanel document={doc({ clips: [first, second] })} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    firePointer(canvas, "pointerdown", { clientX: 210, clientY: 102, button: 0 });
    firePointer(canvas, "pointermove", { clientX: 150, clientY: 102, buttons: 1 });
    firePointer(canvas, "pointerup", { clientX: 150, clientY: 102, button: 0 });
    expect(props.onPatch).not.toHaveBeenCalled();
  });
  it("标记可通过键盘打开并定位，编辑时可以修改颜色", () => {
    saveMarkers("p1", [{ id: "mark", timeUs: 1_000_000, color: "#ffd76e", label: "节拍" }]);
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const pin = screen.getByRole("button", { name: /标记 节拍/ });
    pin.focus();
    fireEvent.click(pin);
    expect(props.onSeek).toHaveBeenCalledWith(1_000_000);
    expect(screen.getByRole("dialog", { name: "编辑时间线标记" })).toBeInTheDocument();
    const color = screen.getByRole("button", { name: "标记颜色 #3fbf6f" });
    color.focus();
    fireEvent.click(color);
    expect(JSON.parse(window.localStorage.getItem("vortex-cut.timeline.markers.v1") ?? "{}").p1[0].color).toBe("#3fbf6f");
  });
  it("新增标记使用 OpenFilm 的蓝色默认值且不会自动打开编辑卡片", () => {
    const props = baseProps();
    const playheadStore = createPlayheadStore();
    playheadStore.set(8_000_000);
    const timeline = doc({
      canvas: { width: 1920, height: 1080, fps_num: 30_000, fps_den: 1_001, background_color: "#000000" },
      clips: [{ ...doc().clips[0]!, source_end_us: 10_000_000, timeline_end_us: 10_000_000 }],
    });
    render(<TimelinePanel document={timeline} playheadStore={playheadStore} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "添加标记" }));
    expect(screen.queryByRole("dialog", { name: "编辑时间线标记" })).not.toBeInTheDocument();
    const stored = JSON.parse(window.localStorage.getItem("vortex-cut.timeline.markers.v1") ?? "{}").p1;
    expect(stored).toHaveLength(1);
    expect(stored[0].color).toBe("#4c8dff");
    expect(stored[0].timeUs).toBe(8_008_000);
  });
  it("使用 M 创建标记并用 Shift+M 跳转到下一标记", () => {
    saveMarkers("p1", [{ id: "mark", timeUs: 1_000_000, color: "#ffd76e", label: "节拍" }]);
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    fireEvent.keyDown(window, { key: "M", shiftKey: true });
    expect(props.onSeek).toHaveBeenCalledWith(1_000_000);
    fireEvent.keyDown(window, { key: "m" });
    expect(screen.queryByRole("dialog", { name: "编辑时间线标记" })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("vortex-cut.timeline.markers.v1") ?? "{}").p1).toHaveLength(2);
  });
  it("标尺靠近项目标记时吸附，关闭吸附后保留原始位置", () => {
    saveMarkers("p1", [{ id: "mark", timeUs: 1_000_000, color: "#ffd76e", label: "节拍" }]);
    const props = baseProps();
    const { container } = render(<TimelinePanel document={doc()} {...props} />);
    const ruler = container.querySelector(".timeline-ruler-pin") as HTMLCanvasElement;
    const unsnappedTimeSeconds = 1 + 5 / testPps();
    const x = rulerXAt(unsnappedTimeSeconds);
    const pointer = (type: string) => fireEvent(ruler, Object.assign(
      new MouseEvent(type, { bubbles: true, clientX: x, button: 0 }),
      { pointerId: 1 },
    ));
    pointer("pointerdown");
    expect(props.onSeek).toHaveBeenLastCalledWith(1_000_000);
    pointer("pointerup");
    fireEvent.click(screen.getByRole("button", { name: "磁吸吸附" }));
    pointer("pointerdown");
    expect(props.onSeek).toHaveBeenLastCalledWith(expect.closeTo(unsnappedTimeSeconds * 1_000_000, 0));
  });
  it("提交标尺松手的位置，取消擦洗时恢复原播放位置", () => {
    const props = { ...baseProps(), onSeekCommit: vi.fn() };
    const store = createPlayheadStore();
    store.set(250_000);
    const { container } = render(<TimelinePanel document={doc()} playheadStore={store} {...props} />);
    const ruler = container.querySelector(".timeline-ruler-pin")!;
    const x = (time: number) => rulerXAt(time);
    const pointer = (type: string, time: number) => fireEvent(ruler, Object.assign(
      new MouseEvent(type, { bubbles: true, clientX: x(time), clientY: 80, button: 0 }),
      { pointerId: 1 },
    ));
    pointer("pointerdown", 0.8);
    pointer("pointerup", 1.2);
    expect(props.onSeekCommit).toHaveBeenLastCalledWith(expect.closeTo(1_200_000, 0));
    pointer("pointerdown", 0.8);
    pointer("pointercancel", 1.2);
    expect(props.onSeekCommit).toHaveBeenLastCalledWith(250_000);
  });
  it("切换开关并持久化到 localStorage", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const magnet = screen.getByRole("button", { name: "磁吸吸附" });
    expect(magnet).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(magnet);
    expect(magnet).toHaveAttribute("aria-pressed", "false");
    const mainMagnet = screen.getByRole("button", { name: "主轨磁吸" });
    const linkage = screen.getByRole("button", { name: "联动" });
    expect(mainMagnet).toHaveAttribute("aria-pressed", "true");
    expect(linkage).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(mainMagnet);
    fireEvent.click(linkage);
    expect(
      JSON.parse(window.localStorage.getItem("vortex-cut.timeline.prefs.v1") ?? "{}"),
      // trackHeight 默认值 2026-11-10 起为 56（对齐 OpenFilm 的 TRACK_H.visual）。
    ).toEqual({ snappingEnabled: false, mainTrackMagnet: false, linkageEnabled: false, trackHeight: 56, trackHeights: {}, waveformRatio: 0.3 });
  });

  it("从 localStorage 恢复上次的状态", () => {
    window.localStorage.setItem(
      "vortex-cut.timeline.prefs.v1",
      JSON.stringify({ snappingEnabled: false }),
    );
    render(<TimelinePanel document={doc()} {...baseProps()} />);
    expect(screen.getByRole("button", { name: "磁吸吸附" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("Core active transition UI path", () => {
  it("selects and clears a projected marker through clip source facts, never legacy transition ops", async () => {
    const props = baseProps();
    const outgoing = doc().clips[0]!;
    const incoming = {
      ...outgoing,
      clip_id: "dissolve-in" as never,
      track_id: "V2",
      order_index: 0,
      timeline_start_us: 1_000_000,
      timeline_end_us: 3_000_000,
      source_end_us: 2_000_000,
    };
    const timeline = doc({
      tracks: [...doc().tracks, { ...doc().tracks[1]!, id: "V2" }],
      clips: [{ ...outgoing, clip_id: "dissolve-out" as never, picture_fade_out_us: 1_000_000 }, { ...incoming, picture_fade_in_us: 1_000_000 }],
    });
    const active = {
      transition_id: "transition_2dd7f5040e62c8640250fd90" as never,
      outgoing_clip_id: "dissolve-out" as never,
      incoming_clip_id: "dissolve-in" as never,
      kind: "dissolve" as const,
      start_us: 1_000_000,
      end_us: 2_000_000,
      cut_us: 2_000_000,
      on_clip_id: "dissolve-in" as never,
    };
    const { container } = render(<TimelinePanel document={timeline} activeTransitions={[active]} {...props} />);
    const marker = container.querySelector('[data-active-transition-id="transition_2dd7f5040e62c8640250fd90"]');
    expect(marker).not.toBeNull();
    fireEvent.click(marker!);
    expect(props.setSelection).toHaveBeenLastCalledWith({ kind: "active-transition", id: active.transition_id });

    fireEvent.contextMenu(marker!, { clientX: 300, clientY: 100 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "清除片段转场事实" }));
    const operations = props.onPatch.mock.calls.at(-1)?.[0] as TimelinePatchOperation[];
    expect(operations).toEqual([
      { op: "set_clip_transition_facts", clip_id: "dissolve-out", picture_fade_out_us: null },
      { op: "set_clip_transition_facts", clip_id: "dissolve-in", picture_fade_in_us: null },
    ]);
    expect(operations.some(operation => operation.op === "update_transition" || operation.op === "remove_transition")).toBe(false);
  });

  it("exposes picture fade facts from a clip context menu", async () => {
    const props = baseProps();
    const { container } = render(<TimelinePanel document={doc()} {...props} />);
    const canvas = container.querySelector("canvas")!;
    fireEvent.contextMenu(canvas, { clientX: canvasXAt(1), clientY: 100 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "添加画面淡出（0.5 秒）" }));
    expect(props.onPatch).toHaveBeenCalledWith([
      { op: "set_clip_transition_facts", clip_id: "clip_1", picture_fade_out_us: 500_000 },
    ], "添加画面淡出");
  });
});

describe("Timeline Round 4 — 右键菜单", () => {
  it("从片段右键菜单进入速度模式，拖动边缘提交 set_speed 而不是修剪源区间", () => {
    const props = baseProps();
    const selected = { kind: "clip" as const, id: doc().clips[0]!.clip_id };
    window.localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify({ snappingEnabled: false, mainTrackMagnet: true }));
    const { container } = render(<TimelinePanel document={doc()} {...props} selection={selected} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    fireEvent.contextMenu(canvas, { clientX: 150, clientY: 124 });
    fireEvent.click(screen.getByRole("menuitem", { name: "速度" }));
    expect(canvas).toHaveAttribute("data-speed-mode", "true");

    const startX = canvasXAt(0) + 1;
    const endX = startX + testPps(2_000_000) * 0.26;
    firePointer(canvas, "pointerdown", { clientX: startX, clientY: 124, button: 0 });
    firePointer(canvas, "pointermove", { clientX: endX, clientY: 124, buttons: 1 });
    firePointer(canvas, "pointerup", { clientX: endX, clientY: 124, button: 0 });

    expect(props.onPatch).toHaveBeenCalledWith([
      { op: "set_speed", clip_id: selected.id, speed_milli: 1_150, ripple: false },
    ], "调整速度 1.15x");
    expect(props.onPatch.mock.calls.flatMap(([operations]) => operations).some(operation => operation.op === "trim_clip")).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(canvas).not.toHaveAttribute("data-speed-mode");
  });

  it("取消速度边缘拖动时不提交 patch", () => {
    const props = baseProps();
    const selected = { kind: "clip" as const, id: doc().clips[0]!.clip_id };
    const { container } = render(<TimelinePanel document={doc()} {...props} selection={selected} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    fireEvent.contextMenu(canvas, { clientX: 150, clientY: 124 });
    fireEvent.click(screen.getByRole("menuitem", { name: "速度" }));
    const startX = canvasXAt(0) + 1;
    firePointer(canvas, "pointerdown", { clientX: startX, clientY: 124, button: 0 });
    firePointer(canvas, "pointermove", { clientX: startX + 80, clientY: 124, buttons: 1 });
    firePointer(canvas, "pointercancel", { clientX: startX + 80, clientY: 124, button: 0 });
    expect(props.onPatch).not.toHaveBeenCalled();
  });

  it("右键片段弹出菜单，删除片段提交 remove_clip patch", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    // 片段 rect：x [120, 240]、V1 行 y [92, 156]（默认 60pps、2s 片段；
    // 多轨道布局 C1=0 行、V1=1 行、A1=2 行）。
    fireEvent.contextMenu(canvas, { clientX: 150, clientY: 124 });
    // T10：参照 ContextMenu 的 role=menu 无 aria-label（aria-orientation 承担），按角色定位。
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除并闭合主轨" }));
    expect(props.onPatch).toHaveBeenCalledWith(
      [{ op: "remove_clip", clip_id: "clip_1" }],
      "主轨磁吸删除",
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("右键空区弹出粘贴/定位菜单，复制走编辑器命令", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    fireEvent.contextMenu(canvas, { clientX: canvasXAt(2.25), clientY: 124 });
    fireEvent.click(screen.getByRole("menuitem", { name: "粘贴到播放头" }));
    expect(props.onCommand).toHaveBeenCalledWith("timeline.paste");
  });

  it("点击菜单外部关闭菜单", () => {
    render(<TimelinePanel document={doc()} {...baseProps()} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    fireEvent.contextMenu(canvas, { clientX: 150, clientY: 124 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // T10：参照菜单自带 pointerdown capture 关闭（mouseDown 事件不算——监听的是 pointerdown）。
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("右键菜单的定位播放头使用点击位置", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    /* canvas-local time = (x − coverRail) / the current project-relative pps. */
    const headerW = DEFAULT_VIEW_STATE.headerWidth;
    const pps = testPps();
    fireEvent.contextMenu(canvas, { clientX: 500, clientY: 124 });
    fireEvent.click(screen.getByRole("menuitem", { name: "定位播放头" }));
    expect(props.onSeek).toHaveBeenCalledWith(expect.closeTo(((500 - headerW) / pps) * 1_000_000, 0));
  });
});

describe("Timeline Round 4 — 空区单击定位播放头", () => {
  it("空区单击（无拖动）移动播放头并清除选择；超过素材终点时钳制到终点", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    // Click beyond the clip end; ruler seeking is clamped at the 2s project end.
    const x = canvasXAt(2.25);
    firePointer(canvas, "pointerdown", { clientX: x, clientY: 124, button: 0 });
    firePointer(canvas, "pointerup", { clientX: x, clientY: 124 });
    expect(props.onSeek).toHaveBeenCalledWith(expect.closeTo(2_000_000, 0));
    expect(props.setSelection).toHaveBeenCalledWith(null);
  });

  it("空白区拖动进入框选，不移动播放头", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    firePointer(canvas, "pointerdown", { clientX: 500, clientY: 124, button: 0 });
    firePointer(canvas, "pointermove", { clientX: 600, clientY: 124 });
    firePointer(canvas, "pointerup", { clientX: 600, clientY: 124 });
    expect(props.onSeek).not.toHaveBeenCalled();
  });

  it("Shift + 拖动仍是框选，不移动播放头", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    firePointer(canvas, "pointerdown", { clientX: 400, clientY: 124, button: 0, shiftKey: true });
    firePointer(canvas, "pointermove", { clientX: 600, clientY: 200, shiftKey: true });
    firePointer(canvas, "pointerup", { clientX: 600, clientY: 200, shiftKey: true });
    expect(props.onSeek).not.toHaveBeenCalled();
  });

  it("空白区不足 5px 横移是点击，达到 5px 可用零高度框选片段", () => {
    const props = baseProps();
    const { container } = render(<TimelinePanel document={doc()} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const emptyX = canvasXAt(2.25);
    firePointer(canvas, "pointerdown", { clientX: emptyX, clientY: 102, button: 0 });
    firePointer(canvas, "pointermove", { clientX: emptyX + 4, clientY: 102, buttons: 1 });
    firePointer(canvas, "pointerup", { clientX: emptyX + 4, clientY: 102, button: 0 });
    expect(props.onSeek).toHaveBeenCalled();

    props.onSeek.mockClear();
    props.setSelection.mockClear();
    firePointer(canvas, "pointerdown", { clientX: emptyX, clientY: 102, button: 0 });
    firePointer(canvas, "pointermove", { clientX: emptyX + 5, clientY: 102, buttons: 1 });
    firePointer(canvas, "pointerup", { clientX: emptyX + 5, clientY: 102, button: 0 });
    expect(props.onSeek).not.toHaveBeenCalled();
    expect(props.setSelection).toHaveBeenLastCalledWith(null);
  });
});
