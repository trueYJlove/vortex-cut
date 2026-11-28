import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Asset, TimelineDocument } from "@aivideo/contracts";
import { TimelinePanel } from "../src/app/timeline/TimelineCanvas.js";
import { ASSET_DRAG, clearSystemFileDrop, getActiveDraggedAssetIds, resolveTimelineAssetDropIntent, setActiveDraggedAssetIds, takeSystemFileDrop } from "../src/app/timeline/asset-drop.js";
import { timelineZoomToPps } from "../src/app/timeline/geometry.js";
import { DEFAULT_VIEW_STATE, TIMELINE_ZOOM_DEFAULT } from "../src/app/timeline/types.js";

const videoClip = {
  clip_id: "clip_1" as never,
  track_id: "V1",
  order_index: 0,
  asset_id: "asset_source" as never,
  asset_kind: "video" as const,
  source_start_us: 0,
  source_end_us: 2_000_000,
  timeline_start_us: 0,
  timeline_end_us: 2_000_000,
  layout: "fit" as const,
  audio: { enabled: true, gain_db: 0 },
};
const baseDocument = (overrides: Partial<TimelineDocument> = {}): TimelineDocument => ({
  schema_version: 1,
  project_id: "p1" as never,
  canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, background_color: "#000000" },
  tracks: [
    { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false },
    { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
    { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
  ],
  clips: [videoClip],
  captions: [],
  provenance: { created_by: "user", source_transcript_ids: [] },
  ...overrides,
});
const assetMedia = (asset_id: string, kind: Asset["kind"]) => ({
  asset_id, kind, media_url: null, display_name: `${asset_id}.mp4`, duration_us: 2_000_000,
});
const documentFixture = baseDocument();
const canvasXAt = (seconds: number) => DEFAULT_VIEW_STATE.headerWidth + timelineZoomToPps(
  2_000_000,
  800 - DEFAULT_VIEW_STATE.headerWidth,
  TIMELINE_ZOOM_DEFAULT,
) * seconds;
const canvasY = 102; // center of V1 for the 800×200 jsdom canvas.

function props(overrides: Record<string, unknown> = {}) {
  return {
    document: documentFixture,
    selection: null,
    setSelection: vi.fn(),
    onPatch: vi.fn().mockResolvedValue(undefined),
    onDropAsset: vi.fn(),
    onReplaceAssetDrop: vi.fn().mockResolvedValue(undefined),
    canUndo: false,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    assetMedia: [assetMedia("asset_source", "video"), assetMedia("asset_new", "video"), assetMedia("asset_audio", "audio")],
    ...overrides,
  };
}

function transfer(type = ASSET_DRAG, getData: (type: string) => string = vi.fn(() => "asset_new")) {
  return { types: [type], items: [], files: [], dropEffect: "none", getData } as unknown as DataTransfer;
}

function fireDrag(target: Element, type: "dragover" | "drop" | "dragleave" | "dragend", dataTransfer?: DataTransfer, clientX = 0, clientY = 0, relatedTarget?: EventTarget | null) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  if (dataTransfer) Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  if (type === "dragleave") Object.defineProperty(event, "relatedTarget", { value: relatedTarget ?? null });
  fireEvent(target, event);
}

beforeEach(() => {
  window.localStorage.clear();
  clearSystemFileDrop();
  setActiveDraggedAssetIds([]);
});
afterEach(() => {
  cleanup();
  clearSystemFileDrop();
  setActiveDraggedAssetIds([]);
});

describe("asset drop intent parity", () => {
  it("resolves center Replace only for compatible single media and locks", () => {
    const args = {
      hit: { trackId: "V1", band: "body" as const, clipId: videoClip.clip_id, zone: "replace" as const },
      clips: [videoClip], tracks: documentFixture.tracks, assetKinds: ["video"] as const,
      itemCount: 1, canReplace: true, pointerUs: 1_000_000, fpsNum: 30, fpsDen: 1,
    };
    expect(resolveTimelineAssetDropIntent(args)).toMatchObject({
      targetClipId: videoClip.clip_id, zone: "center", boundary: null, trackId: "V1", locked: false, accepts: true,
    });
    expect(resolveTimelineAssetDropIntent({ ...args, assetKinds: ["audio"] })).toMatchObject({ accepts: false, zone: "center" });
    expect(resolveTimelineAssetDropIntent({ ...args, canReplace: false })).toMatchObject({ accepts: false });
    expect(resolveTimelineAssetDropIntent({ ...args, tracks: documentFixture.tracks.map(track => track.id === "V1" ? { ...track, locked: true } : track) })).toMatchObject({ locked: true, accepts: false });
  });

  it("snaps clip edges to before/after boundaries and stable insertion slots", () => {
    const shared = {
      clips: [videoClip], tracks: documentFixture.tracks,
      assetKinds: ["video"] as const, itemCount: 1, canReplace: true,
      pointerUs: 1_333_333, fpsNum: 30, fpsDen: 1,
    };
    const before = resolveTimelineAssetDropIntent({ ...shared, hit: { trackId: "V1", band: "body", clipId: videoClip.clip_id, zone: "before" } });
    const after = resolveTimelineAssetDropIntent({ ...shared, hit: { trackId: "V1", band: "body", clipId: videoClip.clip_id, zone: "after" } });
    expect(before).toMatchObject({ zone: "before", boundary: "before", atUs: 0, slot: 0, accepts: true });
    expect(after).toMatchObject({ zone: "after", boundary: "after", atUs: 2_000_000, slot: 1, accepts: true });
  });

  it("matches OpenFilm Place, Insert, Overwrite, media-family routing, and DropBand decisions", () => {
    const shared = {
      clips: [videoClip], tracks: documentFixture.tracks, itemCount: 1, canReplace: true,
      fpsNum: 30, fpsDen: 1, hasCoordinates: true,
    };
    const placeConflict = resolveTimelineAssetDropIntent({
      ...shared, hit: { trackId: "V1", band: "body", clipId: null, zone: null },
      assetKinds: ["video"], assetDurationsUs: [2_000_000], pointerUs: 1_000_000,
    });
    expect(placeConflict).toMatchObject({ mode: "place", trackId: "new", newTrackKind: "video", newTrackAnchorId: "V1", newTrackSide: "before", atUs: 1_000_000 });

    const audioOnVideo = resolveTimelineAssetDropIntent({
      ...shared, hit: { trackId: "V1", band: "body", clipId: null, zone: null },
      assetKinds: ["audio"], assetDurationsUs: [2_000_000], pointerUs: 5_000_000,
    });
    expect(audioOnVideo).toMatchObject({ mode: "place", trackId: "new", newTrackKind: "audio", newTrackAnchorId: "A1", newTrackSide: "after" });

    const edge = resolveTimelineAssetDropIntent({
      ...shared, hit: { trackId: "V1", band: "above", clipId: null, zone: null },
      assetKinds: ["video"], assetDurationsUs: [1_000_000], pointerUs: 5_000_000,
    });
    expect(edge).toMatchObject({ mode: "place", trackId: "new", newTrackKind: "video", newTrackSide: "before" });

    const insert = resolveTimelineAssetDropIntent({
      ...shared, hit: { trackId: "V1", band: "body", clipId: null, zone: null },
      assetKinds: ["video"], assetDurationsUs: [1_000_000], pointerUs: 500_000, mainTrackMagnet: true,
    });
    expect(insert).toMatchObject({ mode: "insert", trackId: "V1", atUs: 0 });

    const overwrite = resolveTimelineAssetDropIntent({
      ...shared, hit: { trackId: "V1", band: "body", clipId: null, zone: null },
      assetKinds: ["video"], assetDurationsUs: [1_000_000], pointerUs: 1_000_000, altKey: true,
    });
    expect(overwrite).toMatchObject({ mode: "overwrite", trackId: "V1", atUs: 1_000_000 });
  });

  it("sets dragover effect to none for locked or incompatible center drops", () => {
    const { container, rerender } = render(<TimelinePanel {...props({ assetMedia: [assetMedia("asset_audio", "audio")] })} />);
    const canvas = container.querySelector("canvas[aria-label='时间线画布']")!;
    setActiveDraggedAssetIds(["asset_audio"]);
    const incompatible = transfer();
    fireDrag(canvas, "dragover", incompatible, canvasXAt(1), canvasY);
    expect(incompatible.dropEffect).toBe("none");
    expect(incompatible.getData).not.toHaveBeenCalled();

    const lockedDocument = baseDocument({ tracks: documentFixture.tracks.map(track => track.id === "V1" ? { ...track, locked: true } : track) });
    rerender(<TimelinePanel {...props({ document: lockedDocument, assetMedia: [assetMedia("asset_new", "video")] })} />);
    setActiveDraggedAssetIds(["asset_new"]);
    const locked = transfer();
    fireDrag(canvas, "dragover", locked, canvasXAt(1), canvasY);
    expect(locked.dropEffect).toBe("none");
  });

  it("confirms center Replace before calling the controlled callback", () => {
    const p = props();
    const { container } = render(<TimelinePanel {...p} />);
    const canvas = container.querySelector("canvas[aria-label='时间线画布']")!;
    setActiveDraggedAssetIds(["asset_new"]);
    const dataTransfer = transfer(ASSET_DRAG, vi.fn((type: string) => type === ASSET_DRAG ? "asset_new" : ""));
    fireDrag(canvas, "dragover", dataTransfer, canvasXAt(1), canvasY);
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(screen.getByText("释放以确认替换此片段")).toBeInTheDocument();
    fireDrag(canvas, "drop", dataTransfer, canvasXAt(1), canvasY);
    expect(screen.getByRole("alertdialog", { name: "替换时间线素材？" })).toBeInTheDocument();
    expect(p.onReplaceAssetDrop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认替换" }));
    expect(p.onReplaceAssetDrop).toHaveBeenCalledWith(["asset_new"], videoClip.clip_id, expect.objectContaining({ zone: "center", accepts: true }));
    expect(p.onDropAsset).not.toHaveBeenCalled();
  });

  it("sends edge drops as Insert with the snapped boundary and clears on Escape, leave, end, and drop", () => {
    const p = props();
    const { container } = render(<TimelinePanel {...p} />);
    const canvas = container.querySelector("canvas[aria-label='时间线画布']")!;
    setActiveDraggedAssetIds(["asset_new"]);
    const beforeTransfer = transfer(ASSET_DRAG, vi.fn((type: string) => type === ASSET_DRAG ? "asset_new" : ""));
    const beforeX = canvasXAt(0.005);
    fireDrag(canvas, "dragover", beforeTransfer, beforeX, canvasY);
    expect(beforeTransfer.dropEffect).toBe("copy");
    expect(screen.getByText(/释放以插入到时间线（后续片段顺延）/)).toBeInTheDocument();
    fireDrag(canvas, "drop", beforeTransfer, beforeX, canvasY);
    expect(p.onDropAsset).toHaveBeenCalledWith(["asset_new"], 0, "V1", undefined, expect.objectContaining({ zone: "before", boundary: "before", atUs: 0 }));
    expect(screen.queryByText(/释放以插入到时间线（后续片段顺延）/)).toBeNull();

    const nextTransfer = transfer();
    setActiveDraggedAssetIds(["asset_new"]);
    fireDrag(canvas, "dragover", nextTransfer, canvasXAt(1), canvasY);
    fireDrag(canvas, "dragleave", nextTransfer, canvasXAt(1), canvasY, document.body);
    expect(screen.queryByText("释放以确认替换此片段")).toBeNull();
    setActiveDraggedAssetIds(["asset_new"]);
    fireDrag(canvas, "dragover", nextTransfer, canvasXAt(1), canvasY);
    fireDrag(canvas, "dragend", nextTransfer, canvasXAt(1), canvasY);
    expect(screen.queryByText("释放以确认替换此片段")).toBeNull();
    setActiveDraggedAssetIds(["asset_new"]);
    fireDrag(canvas, "dragover", nextTransfer, canvasXAt(1), canvasY);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("释放以确认替换此片段")).toBeNull();
    expect(getActiveDraggedAssetIds()).toEqual([]);
  });

  it("restores the native File snapshot after dragend before the confirmed Replace callback", () => {
    const p = props();
    p.onReplaceAssetDrop = vi.fn(() => { expect(takeSystemFileDrop()).toEqual([file]); });
    const { container } = render(<TimelinePanel {...p} />);
    const canvas = container.querySelector("canvas[aria-label='时间线画布']")!;
    const file = new File(["scene"], "scene.mp4", { type: "video/mp4" });
    const dataTransfer = {
      types: ["Files"],
      files: [file],
      items: [{ kind: "file", type: "video/mp4", getAsFile: () => file }],
      dropEffect: "none",
    } as unknown as DataTransfer;
    fireDrag(canvas, "drop", dataTransfer, canvasXAt(1), canvasY);
    expect(screen.getByRole("alertdialog", { name: "替换时间线素材？" })).toBeInTheDocument();
    clearSystemFileDrop(); // App-level dragend cleanup may run while the confirmation is open.
    fireEvent.click(screen.getByRole("button", { name: "确认替换" }));
    expect(p.onReplaceAssetDrop).toHaveBeenCalledWith([expect.any(String)], videoClip.clip_id, expect.objectContaining({ zone: "center" }));
  });

  it("clears the captured native File cache when a center Replace confirmation is cancelled", () => {
    const p = props();
    const { container } = render(<TimelinePanel {...p} />);
    const canvas = container.querySelector("canvas[aria-label='时间线画布']")!;
    const file = new File(["scene"], "scene.mp4", { type: "video/mp4" });
    const dataTransfer = {
      types: ["Files"],
      files: [file],
      items: [{ kind: "file", type: "video/mp4", getAsFile: () => file }],
      dropEffect: "none",
    } as unknown as DataTransfer;
    fireDrag(canvas, "drop", dataTransfer, canvasXAt(1), canvasY);
    expect(screen.getByRole("alertdialog", { name: "替换时间线素材？" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(takeSystemFileDrop()).toEqual([]);
    expect(p.onReplaceAssetDrop).not.toHaveBeenCalled();
  });

  it("P235-R1：center Replace 支持无音轨视频落入音轨并按目标/已知时长锚定预览区间", () => {
    const audioClip = {
      clip_id: "clip_audio_1" as never,
      track_id: "A1",
      order_index: 0,
      asset_id: "asset_audio" as never,
      asset_kind: "audio" as const,
      source_start_us: 0,
      source_end_us: 4_000_000,
      timeline_start_us: 1_000_000,
      timeline_end_us: 5_000_000,
      layout: "fit" as const,
      audio: { enabled: true, gain_db: 0 },
    };
    const videoOnAudioIntent = resolveTimelineAssetDropIntent({
      hit: { trackId: "A1", band: "body", clipId: audioClip.clip_id, zone: "replace" },
      clips: [audioClip],
      tracks: documentFixture.tracks,
      assetKinds: ["video"],
      assetDurationsUs: [null],
      itemCount: 1,
      canReplace: true,
      pointerUs: 2_800_000,
      fpsNum: 30,
      fpsDen: 1,
    });
    expect(videoOnAudioIntent).toMatchObject({
      accepts: true,
      zone: "center",
      trackId: "A1",
      targetClipId: audioClip.clip_id,
      atUs: 1_000_000,
      previewDurationUs: 4_000_000,
    });

    const shortSourceIntent = resolveTimelineAssetDropIntent({
      hit: { trackId: "V1", band: "body", clipId: videoClip.clip_id, zone: "replace" },
      clips: [videoClip],
      tracks: documentFixture.tracks,
      assetKinds: ["video"],
      assetDurationsUs: [900_000],
      itemCount: 1,
      canReplace: true,
      pointerUs: 1_200_000,
      fpsNum: 30,
      fpsDen: 1,
    });
    expect(shortSourceIntent).toMatchObject({
      accepts: true,
      atUs: 0,
      previewDurationUs: 900_000,
    });

    const longStillClip = {
      clip_id: "clip_still_45s" as never,
      track_id: "V1",
      order_index: 0,
      asset_id: "asset_still_old" as never,
      asset_kind: "image" as const,
      source_start_us: null,
      source_end_us: null,
      timeline_start_us: 0,
      timeline_end_us: 45_000_000,
      layout: "fit" as const,
      audio: { enabled: false, gain_db: 0 },
    };
    const longStillIntent = resolveTimelineAssetDropIntent({
      hit: { trackId: "V1", band: "body", clipId: longStillClip.clip_id, zone: "replace" },
      clips: [longStillClip],
      tracks: documentFixture.tracks,
      assetKinds: ["image"],
      assetDurationsUs: [0],
      itemCount: 1,
      canReplace: true,
      pointerUs: 10_000_000,
      fpsNum: 30,
      fpsDen: 1,
    });
    expect(longStillIntent).toMatchObject({
      accepts: true,
      atUs: 0,
      previewDurationUs: 45_000_000,
    });
  });
});
