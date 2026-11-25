import { describe, expect, it } from "vitest";
import type { TimelineCaption, TimelineClip, TimelineTransition } from "@aivideo/contracts";
import { clipAudioBand, volumeToY, type TrackRowLayout } from "../src/app/timeline/geometry.js";
import {
  DEFAULT_VIEW_STATE,
  type ActiveTransitionRenderRect,
  type CaptionRenderRect,
  type ClipRenderRect,
  type TransitionRenderRect,
} from "../src/app/timeline/types.js";
import {
  CAPTION_EDGE_PX,
  detectCanvasHover,
  hitTestCanvasContextMenuTarget,
  hitTestCanvasPointerDown,
  hitTestCaptionEdge,
  hitTestCaptions,
  hitTestSpeedHandle,
} from "../src/app/timeline/canvas/hit-test.js";

function makeClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    clip_id: "clip_1" as TimelineClip["clip_id"],
    track_id: "V1",
    order_index: 0,
    asset_id: "asset_1" as TimelineClip["asset_id"],
    asset_kind: "video",
    source_start_us: 0,
    source_end_us: 5_000_000,
    timeline_start_us: 0,
    timeline_end_us: 5_000_000,
    layout: "fit",
    audio: { enabled: true, gain_db: 0 },
    ...overrides,
  };
}

function makeClipRect(clip: TimelineClip, x = 51, y = 40, width = 300, height = 68): ClipRenderRect {
  return { x, y, width, height, clip, index: 0 };
}

function makeCaptionRect(): CaptionRenderRect {
  const caption: TimelineCaption = {
    caption_id: "cap_1" as TimelineCaption["caption_id"],
    track_id: "C1",
    source_clip_id: null,
    start_us: 0,
    end_us: 2_000_000,
    text: "测试字幕",
    preset_id: "default-bottom",
    origin: "user",
    edited: false,
    source_segment_ids: [],
  };
  return { x: 51, y: 20, width: 120, height: 24, caption };
}

describe("timeline canvas hit-test", () => {
  it("resolves pointer-down target priority (header rail, scrollbar, ruler, transitions, handles, clip, caption, empty)", () => {
    const clip = makeClip();
    const clipRect = makeClipRect(clip, 51, 50, 300, 68);
    const clip2 = makeClip({ clip_id: "clip_2" as TimelineClip["clip_id"], timeline_start_us: 5_000_000, timeline_end_us: 10_000_000, order_index: 1 });
    const clipRect2 = makeClipRect(clip2, 351, 50, 300, 68);
    const captionRect = makeCaptionRect();
    const transition: TimelineTransition = {
      transition_id: "tr_1" as TimelineTransition["transition_id"],
      after_clip_id: clip.clip_id,
      kind: "fade",
      duration_us: 500_000,
    };
    const transitionRect: TransitionRenderRect = { x: 340, y: 50, width: 22, height: 68, transition };
    const activeTransitionRect: ActiveTransitionRenderRect = {
      x: 340,
      y: 50,
      width: 22,
      height: 68,
      editable: true,
      transition: {
        transition_id: "atr_1",
        kind: "fade",
        start_us: 4_750_000,
        end_us: 5_250_000,
        track_id: "V1",
        after_clip_id: clip.clip_id,
        rest_clip_id: clip2.clip_id,
        source: "legacy",
      } as never,
    };

    const baseOpts = {
      view: DEFAULT_VIEW_STATE,
      totalUs: 20_000_000,
      canvasWidth: 600,
      canvasHeight: 200,
      scrollTop: 0,
      clips: [clip, clip2],
      clipRects: [clipRect, clipRect2],
      captionRects: [captionRect],
      transitionRects: [transitionRect],
      activeTransitionRects: [activeTransitionRect],
      speedModeActive: false,
      selectedSpeedClipIds: [],
      isClipLocked: () => false,
      waveformRatio: 0.3,
    };

    expect(hitTestCanvasPointerDown({ ...baseOpts, x: 20, y: 80 }).hit).toEqual({ kind: "header-rail" });
    expect(hitTestCanvasPointerDown({ ...baseOpts, x: 120, y: 195 }).hit).toEqual({ kind: "scrollbar" });
    expect(hitTestCanvasPointerDown({ ...baseOpts, x: 120, y: 10 }).hit).toEqual({ kind: "ruler" });
    // Active transition wins over legacy transition / trim handle at boundary x=350
    expect(hitTestCanvasPointerDown({ ...baseOpts, x: 350, y: 80 }).hit).toEqual({
      kind: "active-transition",
      transitionId: "atr_1",
    });
    // Left trim handle of clip_1 at x=52 (outside transition marker)
    expect(hitTestCanvasPointerDown({ ...baseOpts, x: 52, y: 80 }).hit).toEqual({
      kind: "trim-handle",
      clipId: clip.clip_id,
      edge: "left",
    });
    // Volume line hit inside audio band
    const band = clipAudioBand(clip, clipRect, 0.3)!;
    const volY = volumeToY(0, band);
    expect(hitTestCanvasPointerDown({ ...baseOpts, x: 160, y: volY }).hit).toEqual({
      kind: "volume-line",
      clipId: clip.clip_id,
    });
    // Clip body hit outside volume band & handles
    expect(hitTestCanvasPointerDown({ ...baseOpts, x: 160, y: 60 }).hit).toEqual({
      kind: "clip",
      clipId: clip.clip_id,
    });
    // Caption left edge vs caption body
    expect(hitTestCanvasPointerDown({ ...baseOpts, x: 51 + CAPTION_EDGE_PX - 1, y: 30 }).hit).toEqual({
      kind: "caption-edge",
      captionId: "cap_1",
      edge: "left",
    });
    expect(hitTestCanvasPointerDown({ ...baseOpts, x: 110, y: 30 }).hit).toEqual({
      kind: "caption",
      captionId: "cap_1",
    });
    // Empty hit outside everything
    expect(hitTestCanvasPointerDown({ ...baseOpts, x: 500, y: 150 }).hit).toEqual({ kind: "empty" });
  });

  it("prioritizes speed handles when speedModeActive is enabled for speedable selected clips", () => {
    const clip = makeClip();
    const clipRect = makeClipRect(clip, 51, 50, 300, 68);
    expect(
      hitTestSpeedHandle({
        x: 52,
        y: 80,
        speedModeActive: true,
        selectedSpeedClipIds: [clip.clip_id],
        clips: [clip],
        clipRects: [clipRect],
        isClipLocked: () => false,
      }),
    ).toEqual({ clipId: clip.clip_id, edge: "left" });

    // Locked or image clips are excluded from speed handle
    const imageClip = makeClip({ asset_kind: "image", source_start_us: null, source_end_us: null });
    expect(
      hitTestSpeedHandle({
        x: 52,
        y: 80,
        speedModeActive: true,
        selectedSpeedClipIds: [imageClip.clip_id],
        clips: [imageClip],
        clipRects: [makeClipRect(imageClip, 51, 50, 300, 68)],
        isClipLocked: () => false,
      }),
    ).toBeNull();
  });

  it("detects hover cursors and context menu targets consistently", () => {
    const clip = makeClip();
    const clipRect = makeClipRect(clip, 51, 50, 300, 68);
    const captionRect = makeCaptionRect();
    const trackRows: TrackRowLayout[] = [
      { track: { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false }, y: 20, height: 24 },
      { track: { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false }, y: 50, height: 68 },
    ];

    expect(detectCanvasHover({ x: 52, y: 80, clipRects: [clipRect], isClipLocked: () => false, waveformRatio: 0.3 })).toEqual({
      hover: { clipId: clip.clip_id, edge: "left" },
      cursor: "ew-resize",
    });
    expect(detectCanvasHover({ x: 150, y: 70, clipRects: [clipRect], isClipLocked: () => false, waveformRatio: 0.3 })).toEqual({
      hover: { clipId: clip.clip_id, edge: null },
      cursor: "grab",
    });
    expect(detectCanvasHover({ x: 150, y: 70, clipRects: [clipRect], isClipLocked: () => true, waveformRatio: 0.3 })).toEqual({
      hover: { clipId: clip.clip_id, edge: null },
      cursor: "default",
    });

    expect(hitTestCaptions(100, 30, [captionRect])).toBe("cap_1");
    expect(hitTestCaptionEdge(170, 30, [captionRect])).toEqual({ captionId: "cap_1", edge: "right" });

    expect(
      hitTestCanvasContextMenuTarget({ x: 150, y: 70, transitionRects: [], clipRects: [clipRect], captionRects: [captionRect], trackRows }),
    ).toEqual({ kind: "clip", clipId: clip.clip_id });
    expect(
      hitTestCanvasContextMenuTarget({ x: 100, y: 30, transitionRects: [], clipRects: [clipRect], captionRects: [captionRect], trackRows }),
    ).toEqual({ kind: "caption", captionId: "cap_1" });
    expect(
      hitTestCanvasContextMenuTarget({ x: 400, y: 70, transitionRects: [], clipRects: [clipRect], captionRects: [captionRect], trackRows }),
    ).toEqual({ kind: "empty", trackId: "V1" });
  });
});
