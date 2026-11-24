import { describe, expect, it } from "vitest";
import type { TimelineClip, TimelineDocument, TimelineTrack } from "@aivideo/contracts";
import { createClipDragPlanner, planClipDrag } from "../src/app/timeline/clip-drag-plan.js";
import { planMagneticMove } from "../src/app/timeline/magnetic-plan.js";

const tracks: TimelineTrack[] = [
  { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false },
  { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
  { id: "V2", kind: "video", locked: false, hidden: false, muted: false, solo: false },
  { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
];

function clip(id: string, track: string, start: number, end: number, overrides: Partial<TimelineClip> = {}): TimelineClip {
  const audio = track.startsWith("A");
  return {
    clip_id: id as TimelineClip["clip_id"],
    track_id: track,
    order_index: 0,
    asset_id: `asset_${id}` as TimelineClip["asset_id"],
    asset_kind: audio ? "audio" : "video",
    source_start_us: 0,
    source_end_us: end - start,
    timeline_start_us: start,
    timeline_end_us: end,
    layout: "fit",
    audio: { enabled: true, gain_db: 0 },
    ...overrides,
  };
}

function document(clips: TimelineClip[], extra: Partial<TimelineDocument> = {}): TimelineDocument {
  return {
    schema_version: 1,
    project_id: "p1" as never,
    canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, background_color: "#000000" },
    tracks,
    clips,
    captions: [],
    provenance: { created_by: "user", source_transcript_ids: [] },
    ...extra,
  };
}

function plan(doc: TimelineDocument, options: Partial<Parameters<typeof planClipDrag>[0]> = {}) {
  const source = doc.clips[0]!;
  return planClipDrag({
    document: doc,
    clipIds: [source.clip_id],
    leadClipId: source.clip_id,
    leadStartUs: 4_000_000,
    pointerTimeUs: 4_250_000,
    dropHit: { rowIndex: 2, trackId: "V2", band: "body", clipId: null, zone: null },
    targetTrackId: "V2",
    mode: "place",
    copyOnStart: false,
    mainTrackMagnet: false,
    linkageEnabled: true,
    ...options,
  });
}

describe("OpenFilm-style clip drag planning", () => {
  it("quantizes pointer-derived positions to OpenFilm's millisecond precision", () => {
    const source = clip("precision-source", "V1", 0, 2_000_000);
    const result = plan(document([source]), {
      leadStartUs: 18_618_600,
      pointerTimeUs: 18_618_600,
      targetTrackId: "V2",
    });

    expect(result.lead?.startUs).toBe(18_619_000);
    expect(result.operations.at(-1)).toEqual({
      op: "position_clips",
      placements: [{ clip_id: source.clip_id, track_id: "V2", timeline_start_us: 18_619_000 }],
    });
  });

  it("Place opens a compatible adjacent track when the target time is occupied", () => {
    const source = clip("source", "V1", 0, 2_000_000);
    const blocker = clip("blocker", "V2", 4_000_000, 6_000_000);
    const result = plan(document([source, blocker]));
    expect(result.lead).toEqual({ clipId: source.clip_id, trackId: "V3", startUs: 4_000_000 });
    expect(result.operations[0]).toEqual({ op: "add_track", kind: "video", track_id: "V3", before_track_id: "V2" });
    expect(result.operations.at(-1)).toEqual({ op: "position_clips", placements: [{ clip_id: source.clip_id, track_id: "V3", timeline_start_us: 4_000_000 }] });
  });

  it("flushes a visually touching Place drop by one snap tolerance instead of opening a track", () => {
    const source = clip("flush-source", "V1", 0, 2_000_000);
    const blocker = clip("flush-blocker", "V2", 5_000_000, 7_000_000);
    const result = plan(document([source, blocker]), {
      leadStartUs: 3_020_000,
      pointerTimeUs: 3_020_000,
      snappingEnabled: true,
      flushToleranceUs: 80_000,
    });
    expect(result.lead).toEqual({ clipId: source.clip_id, trackId: "V2", startUs: 3_000_000 });
    expect(result.operations.some(operation => operation.op === "add_track")).toBe(false);
  });

  it("keeps a genuine Place collision on a new track when snapping is off", () => {
    const source = clip("free-source", "V1", 0, 2_000_000);
    const blocker = clip("free-blocker", "V2", 5_000_000, 7_000_000);
    const result = plan(document([source, blocker]), {
      leadStartUs: 3_020_000,
      pointerTimeUs: 3_020_000,
      snappingEnabled: false,
      flushToleranceUs: 80_000,
    });
    expect(result.lead?.trackId).toBe("V3");
    expect(result.lead?.startUs).toBe(3_020_000);
  });

  it("keeps main-track magnet behavior when cross-track Place collides", () => {
    const source = clip("magnet-source", "V1", 0, 2_000_000);
    const mainFollower = clip("magnet-main-next", "V1", 2_000_000, 4_000_000);
    const blocker = clip("magnet-blocker", "V2", 4_000_000, 6_000_000);
    const result = plan(document([source, mainFollower, blocker]), {
      leadStartUs: 4_000_000,
      pointerTimeUs: 4_500_000,
      targetTrackId: "V2",
      dropHit: { rowIndex: 2, trackId: "V2", band: "body", clipId: null, zone: null },
      mainTrackMagnet: true,
    });
    expect(result.operations).toContainEqual({ op: "add_track", kind: "video", track_id: "V3", before_track_id: "V2" });
    expect(result.operations).toContainEqual({ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: source.clip_id, track_id: "V3", timeline_start_us: 4_000_000 },
      { clip_id: mainFollower.clip_id, timeline_start_us: 0 },
    ]) });
  });

  it("lets the main-track magnet resolve a colliding drop onto V1 instead of opening a track", () => {
    const source = clip("overlay-source", "V2", 0, 2_000_000);
    const main = clip("main-target", "V1", 4_000_000, 6_000_000);
    const result = plan(document([source, main]), {
      leadStartUs: 4_000_000,
      pointerTimeUs: 4_500_000,
      targetTrackId: "V1",
      dropHit: { rowIndex: 1, trackId: "V1", band: "body", clipId: null, zone: null },
      mainTrackMagnet: true,
    });
    expect(result.operations.some(operation => operation.op === "add_track")).toBe(false);
    expect(result.operations).toContainEqual({ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: source.clip_id, track_id: "V1", timeline_start_us: 0 },
      { clip_id: main.clip_id, timeline_start_us: 2_000_000 },
    ]) });
  });

  it("maps Alt Insert through target-track cuts only while closing every source track", () => {
    const source = clip("insert-source", "V1", 0, 4_000_000);
    const sourceNext = clip("insert-source-next", "V1", 4_000_000, 6_000_000);
    const targetNext = clip("insert-target-next", "V2", 12_000_000, 14_000_000);
    const result = plan(document([source, sourceNext, targetNext]), {
      leadStartUs: 10_000_000,
      pointerTimeUs: 10_000_000,
      targetTrackId: "V2",
      mode: "insert",
      dropHit: { rowIndex: 2, trackId: "V2", band: "body", clipId: null, zone: null },
    });
    expect(result.operations).toContainEqual({ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: source.clip_id, track_id: "V2", timeline_start_us: 10_000_000 },
      { clip_id: sourceNext.clip_id, track_id: "V1", timeline_start_us: 0 },
      { clip_id: targetNext.clip_id, track_id: "V2", timeline_start_us: 16_000_000 },
    ]) });
  });

  it("carries linked riders back to their host footage after a cross-track Alt Insert", () => {
    const source = clip("linked-insert-source", "V3", 2_000_000, 11_000_000);
    const hostA = clip("linked-insert-host-a", "V1", 14_000_000, 34_000_000);
    const hostB = clip("linked-insert-host-b", "V1", 34_000_000, 60_000_000);
    const sourceRider = clip("linked-insert-source-rider", "V3", 26_000_000, 39_000_000);
    const targetRider = clip("linked-insert-target-rider", "V2", 43_000_000, 50_000_000);
    const doc = document([source, hostA, hostB, sourceRider, targetRider], {
      tracks: [...tracks, { id: "V3", kind: "video", locked: false, hidden: false, muted: false, solo: false }],
    });
    const result = planClipDrag({
      document: doc,
      clipIds: [source.clip_id],
      leadClipId: source.clip_id,
      leadStartUs: 20_000_000,
      pointerTimeUs: 20_000_000,
      dropHit: { rowIndex: 2, trackId: "V2", band: "body", clipId: null, zone: null },
      targetTrackId: "V2",
      mode: "insert",
      copyOnStart: false,
      mainTrackMagnet: true,
      linkageEnabled: true,
    });
    const applied = new Map(doc.clips.map(item => [item.clip_id, { trackId: item.track_id, startUs: item.timeline_start_us }]));
    for (const operation of result.operations) {
      if (operation.op === "position_clip") applied.set(operation.clip_id, {
        trackId: operation.track_id ?? applied.get(operation.clip_id)?.trackId ?? "V1",
        startUs: operation.timeline_start_us,
      });
      if (operation.op === "position_clips") for (const item of operation.placements) applied.set(item.clip_id, {
        trackId: item.track_id ?? applied.get(item.clip_id)?.trackId ?? "V1",
        startUs: item.timeline_start_us,
      });
    }

    expect(applied.get(source.clip_id)).toEqual({ trackId: "V2", startUs: 20_000_000 });
    expect(applied.get(sourceRider.clip_id)).toEqual({ trackId: "V3", startUs: sourceRider.timeline_start_us });
    expect(applied.get(targetRider.clip_id)).toEqual({ trackId: "V2", startUs: targetRider.timeline_start_us });
    expect(result.placements.filter(item => item.clipId === sourceRider.clip_id)).toEqual([{
      clipId: sourceRider.clip_id, trackId: "V3", startUs: sourceRider.timeline_start_us,
    }]);
    expect(result.placements.filter(item => item.clipId === targetRider.clip_id)).toEqual([{
      clipId: targetRider.clip_id, trackId: "V2", startUs: targetRider.timeline_start_us,
    }]);
  });

  it("keeps Insert ripple placements when main-track linkage is disabled", () => {
    const source = clip("unlinked-insert-source", "V3", 2_000_000, 11_000_000);
    const hostA = clip("unlinked-insert-host-a", "V1", 14_000_000, 34_000_000);
    const hostB = clip("unlinked-insert-host-b", "V1", 34_000_000, 60_000_000);
    const sourceRider = clip("unlinked-insert-source-rider", "V3", 26_000_000, 39_000_000);
    const targetRider = clip("unlinked-insert-target-rider", "V2", 43_000_000, 50_000_000);
    const doc = document([source, hostA, hostB, sourceRider, targetRider], {
      tracks: [...tracks, { id: "V3", kind: "video", locked: false, hidden: false, muted: false, solo: false }],
    });
    const result = planClipDrag({
      document: doc,
      clipIds: [source.clip_id],
      leadClipId: source.clip_id,
      leadStartUs: 20_000_000,
      pointerTimeUs: 20_000_000,
      dropHit: { rowIndex: 2, trackId: "V2", band: "body", clipId: null, zone: null },
      targetTrackId: "V2",
      mode: "insert",
      copyOnStart: false,
      mainTrackMagnet: true,
      linkageEnabled: false,
    });

    expect(result.placements.find(item => item.clipId === sourceRider.clip_id)).toEqual({
      clipId: sourceRider.clip_id, trackId: "V3", startUs: 17_000_000,
    });
    expect(result.placements.find(item => item.clipId === targetRider.clip_id)).toEqual({
      clipId: targetRider.clip_id, trackId: "V2", startUs: 52_000_000,
    });
  });

  it("settles a carried Insert rider on a free compatible lane after source-track closure causes a collision", () => {
    const source = clip("settle-insert-source", "V3", 2_000_000, 11_000_000);
    const host = clip("settle-insert-host", "V1", 14_000_000, 24_000_000);
    const rider = clip("settle-insert-rider", "V3", 18_000_000, 24_000_000);
    const gapClip = clip("settle-insert-gap-clip", "V3", 24_000_000, 30_000_000);
    const target = clip("settle-insert-target", "V2", 30_000_000, 39_000_000);
    const doc = document([source, host, rider, gapClip, target], {
      tracks: [...tracks, { id: "V3", kind: "video", locked: false, hidden: false, muted: false, solo: false }],
    });
    const result = planClipDrag({
      document: doc,
      clipIds: [source.clip_id],
      leadClipId: source.clip_id,
      leadStartUs: 20_000_000,
      pointerTimeUs: 20_000_000,
      dropHit: { rowIndex: 2, trackId: "V2", band: "body", clipId: null, zone: null },
      targetTrackId: "V2",
      mode: "insert",
      copyOnStart: false,
      mainTrackMagnet: true,
      linkageEnabled: true,
    });
    const carried = result.placements.find(item => item.clipId === rider.clip_id);

    expect(carried).toEqual({ clipId: rider.clip_id, trackId: "V4", startUs: 18_000_000 });
    expect(result.operations).toContainEqual({ op: "add_track", kind: "video", track_id: "V4", before_track_id: "V3" });
  });

  it("single-lane Insert closes the source gap then opens the same width at the drop cut", () => {
    const source = clip("single-insert-source", "V2", 0, 500_000);
    const earlier = clip("single-insert-earlier", "V2", 2_000_000, 2_500_000);
    const target = clip("single-insert-target", "V2", 4_000_000, 4_500_000);
    const next = clip("single-insert-next", "V2", 6_000_000, 6_500_000);
    const result = plan(document([source, earlier, target, next]), {
      leadStartUs: 4_100_000,
      pointerTimeUs: 4_100_000,
      targetTrackId: "V2",
      mode: "insert",
      mainTrackMagnet: false,
      dropHit: { rowIndex: 2, trackId: "V2", band: "body", clipId: null, zone: null },
    });
    expect(result.lead).toEqual({ clipId: source.clip_id, trackId: "V2", startUs: 3_500_000 });
    expect(result.operations).toEqual([{ op: "position_clips", placements: [
      { clip_id: earlier.clip_id, track_id: "V2", timeline_start_us: 1_500_000 },
      { clip_id: source.clip_id, track_id: "V2", timeline_start_us: 3_500_000 },
    ] }]);
  });

  it("opens a new compatible track when a single Alt-copy is dropped above the track stack", () => {
    const source = clip("edge-copy-source", "V2", 1_000_000, 3_000_000);
    const result = plan(document([source]), {
      copyOnStart: true,
      copyIds: ["edge-copy" as TimelineClip["clip_id"]],
      targetTrackId: "V2",
      dropHit: { rowIndex: -1, trackId: null, band: "above", clipId: null, zone: null },
    });
    expect(result.operations).toContainEqual({ op: "add_track", kind: "video", track_id: "V3", before_track_id: "V1" });
    expect(result.operations).toContainEqual({ op: "duplicate_timeline_items", copies: [
      { item_kind: "clip", source_id: source.clip_id, copy_id: "edge-copy", timeline_start_us: 4_000_000, track_id: "V3" },
    ] });
  });

  it("allows opening a lane beside a locked row but still refuses its body", () => {
    const source = clip("locked-edge-source", "V1", 0, 2_000_000);
    const lockedTracks = tracks.map(track => track.id === "V2" ? { ...track, locked: true } : track);
    const doc = document([source], { tracks: lockedTracks });
    const edge = plan(doc, {
      targetTrackId: "V2",
      dropHit: { rowIndex: 2, trackId: "V2", band: "above", clipId: null, zone: null },
    });
    expect(edge.reason).toBeUndefined();
    expect(edge.operations).toContainEqual({ op: "add_track", kind: "video", track_id: "V3", before_track_id: "V2" });
    expect(edge.lead).toEqual({ clipId: source.clip_id, trackId: "V3", startUs: 4_000_000 });

    const body = plan(doc, {
      targetTrackId: "V2",
      dropHit: { rowIndex: 2, trackId: "V2", band: "body", clipId: null, zone: null },
    });
    expect(body.reason).toBe("目标轨道已锁定");
    expect(body.operations).toEqual([]);
  });

  it("drops an Alt-copy onto the row under the pointer when released on its upper edge", () => {
    const source = clip("edge-copy-row-source", "V1", 1_000_000, 3_000_000);
    const result = plan(document([source]), {
      copyOnStart: true,
      copyIds: ["edge-copy-row" as TimelineClip["clip_id"]],
      targetTrackId: "V1",
      dropHit: { rowIndex: 2, trackId: "V2", band: "above", clipId: null, zone: null },
    });
    expect(result.operations).toContainEqual({ op: "duplicate_timeline_items", copies: [
      { item_kind: "clip", source_id: source.clip_id, copy_id: "edge-copy-row", timeline_start_us: 4_000_000, track_id: "V2" },
    ] });
    expect(result.operations.some(operation => operation.op === "add_track")).toBe(false);
  });

  it("a clip-edge drop inserts before the target and pushes its following clips", () => {
    const source = clip("source", "V1", 0, 1_000_000);
    const target = clip("target", "V2", 4_000_000, 6_000_000);
    const next = clip("next", "V2", 6_000_000, 7_000_000);
    const result = plan(document([source, target, next]), {
      leadStartUs: 4_000_000,
      dropHit: { rowIndex: 2, trackId: "V2", band: "body", clipId: target.clip_id, zone: "before" },
    });
    expect(result.operations).toEqual([{ op: "position_clips", placements: [
      { clip_id: target.clip_id, track_id: "V2", timeline_start_us: 5_000_000 },
      { clip_id: next.clip_id, track_id: "V2", timeline_start_us: 7_000_000 },
      { clip_id: source.clip_id, track_id: "V2", timeline_start_us: 4_000_000 },
    ] }]);
  });

  it("center Replace removes only the target and moves the source into its slot", () => {
    const source = clip("source", "V1", 0, 2_000_000);
    const target = clip("target", "V2", 5_000_000, 6_000_000, { link_group_id: "target-link" });
    const targetPartner = clip("target-audio", "A1", 5_000_000, 6_000_000, { link_group_id: "target-link" });
    const next = clip("next", "V2", 6_000_000, 7_000_000);
    const result = plan(document([source, target, targetPartner, next]), {
      leadStartUs: 5_000_000,
      dropHit: { rowIndex: 2, trackId: "V2", band: "body", clipId: target.clip_id, zone: "replace" },
    });
    expect(result.operations).toEqual([
      { op: "remove_clip", clip_id: target.clip_id, ignore_link: true },
      { op: "position_clips", placements: [
        { clip_id: next.clip_id, track_id: "V2", timeline_start_us: 7_000_000 },
        { clip_id: source.clip_id, track_id: "V2", timeline_start_us: 5_000_000 },
      ] },
    ]);
    expect(result.operations.flatMap(op => op.op === "remove_clip" ? [op.clip_id] : [])).not.toContain(targetPartner.clip_id);
  });

  it("Alt copy applies one common lane delta to every linked member", () => {
    const video = clip("source-v", "V1", 0, 2_000_000, { link_group_id: "av-link" });
    const sound = clip("source-a", "A1", 0, 2_000_000, { link_group_id: "av-link" });
    const a2: TimelineTrack = { id: "A2", kind: "audio", locked: false, hidden: false, muted: false, solo: false };
    const result = plan(document([video, sound], { tracks: [...tracks, a2] }), {
      clipIds: [video.clip_id, sound.clip_id],
      copyIds: ["copy-v" as TimelineClip["clip_id"], "copy-a" as TimelineClip["clip_id"]],
      copyOnStart: true,
      targetTrackId: "V2",
      leadStartUs: 4_000_000,
    });
    expect(result.operations).toContainEqual({ op: "duplicate_timeline_items", copies: [
      { item_kind: "clip", source_id: video.clip_id, copy_id: "copy-v", timeline_start_us: 4_000_000, track_id: "V2" },
      { item_kind: "clip", source_id: sound.clip_id, copy_id: "copy-a", timeline_start_us: 4_000_000, track_id: "A2" },
    ] });
    expect(result.placements).toHaveLength(2);
    expect(result.operations.some(op => op.op === "position_clips" && op.placements.some(item => item.clip_id === video.clip_id))).toBe(false);
  });

  it("moves a linked A/V group onto V1 without main-magnet repacking", () => {
    const video = clip("move-linked-v", "V1", 0, 2_000_000, { link_group_id: "move-linked-av" });
    const sound = clip("move-linked-a", "A1", 0, 2_000_000, { link_group_id: "move-linked-av" });
    const mainNext = clip("move-linked-main-next", "V1", 2_000_000, 4_000_000);
    const result = plan(document([video, sound, mainNext]), {
      clipIds: [video.clip_id, sound.clip_id],
      leadClipId: video.clip_id,
      leadStartUs: 4_000_000,
      pointerTimeUs: 4_000_000,
      targetTrackId: "V1",
      dropHit: { rowIndex: 1, trackId: "V1", band: "body", clipId: null, zone: null },
      mainTrackMagnet: true,
    });
    expect(result.operations).toEqual([{ op: "position_clips", placements: [
      { clip_id: video.clip_id, track_id: "V1", timeline_start_us: 4_000_000 },
      { clip_id: sound.clip_id, track_id: "A1", timeline_start_us: 4_000_000 },
    ] }]);
    expect(result.placements).not.toContainEqual(expect.objectContaining({ clipId: mainNext.clip_id }));
  });

  it("moving a linked A/V group from V2+A2 to V1+A1 inserts on V1 and carries its successor", () => {
    const linked = "cross-track-linked-main";
    const first = clip("cross-main-first", "V1", 0, 2_000_000);
    const next = clip("cross-main-next", "V1", 2_000_000, 4_000_000);
    const video = clip("cross-video", "V2", 4_000_000, 6_000_000, { link_group_id: linked });
    const audio = clip("cross-audio", "A2", 4_000_000, 6_000_000, { link_group_id: linked });
    const timeline = document([first, next, video, audio], {
      tracks: [...tracks, { id: "A2", kind: "audio", locked: false, hidden: false, muted: false, solo: false }],
    });
    const result = planClipDrag({
      document: timeline,
      clipIds: [video.clip_id, audio.clip_id],
      leadClipId: video.clip_id,
      leadStartUs: 2_000_000,
      pointerTimeUs: 2_250_000,
      dropHit: { rowIndex: 1, trackId: "V1", band: "body", clipId: null, zone: null },
      targetTrackId: "V1",
      mode: "place",
      copyOnStart: false,
      mainTrackMagnet: true,
      linkageEnabled: true,
    });
    expect(result.operations).toContainEqual({ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: video.clip_id, track_id: "V1", timeline_start_us: 2_000_000 },
      { clip_id: audio.clip_id, track_id: "A1", timeline_start_us: 2_000_000 },
      { clip_id: next.clip_id, timeline_start_us: 4_000_000 },
    ]) });
  });

  it("multi-track Insert ripples from the earliest group member while preserving the lead offset", () => {
    const video = clip("insert-group-video", "V2", 10_000_000, 12_000_000);
    const audio = clip("insert-group-audio", "A2", 8_000_000, 12_000_000);
    const videoTarget = clip("insert-group-v3-target", "V3", 12_000_000, 14_000_000);
    const videoNext = clip("insert-group-v3-next", "V3", 16_000_000, 18_000_000);
    const audioTarget = clip("insert-group-a3-target", "A3", 12_000_000, 14_000_000);
    const audioNext = clip("insert-group-a3-next", "A3", 16_000_000, 18_000_000);
    const timeline = document([video, audio, videoTarget, videoNext, audioTarget, audioNext], {
      tracks: [tracks[0]!, tracks[1]!, tracks[2]!,
        { id: "V3", kind: "video", locked: false, hidden: false, muted: false, solo: false },
        tracks[3]!,
        { id: "A2", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
        { id: "A3", kind: "audio", locked: false, hidden: false, muted: false, solo: false }],
    });
    const result = planClipDrag({
      document: timeline,
      clipIds: [video.clip_id, audio.clip_id],
      leadClipId: video.clip_id,
      leadStartUs: 12_000_000,
      pointerTimeUs: 12_250_000,
      dropHit: { rowIndex: 3, trackId: "V3", band: "body", clipId: null, zone: null },
      targetTrackId: "V3",
      mode: "insert",
      copyOnStart: false,
      mainTrackMagnet: false,
      linkageEnabled: true,
    });
    expect(result.operations).toContainEqual({ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: video.clip_id, track_id: "V3", timeline_start_us: 14_000_000 },
      { clip_id: audio.clip_id, track_id: "A3", timeline_start_us: 12_000_000 },
      { clip_id: videoTarget.clip_id, track_id: "V3", timeline_start_us: 16_000_000 },
      { clip_id: videoNext.clip_id, track_id: "V3", timeline_start_us: 20_000_000 },
      { clip_id: audioTarget.clip_id, track_id: "A3", timeline_start_us: 16_000_000 },
      { clip_id: audioNext.clip_id, track_id: "A3", timeline_start_us: 20_000_000 },
    ]) });
  });

  it("Alt copy on V1 inserts at the hand's cut and moves footage plus linked riders", () => {
    const source = clip("source", "V1", 0, 2_000_000);
    const next = clip("next", "V1", 2_000_000, 4_000_000);
    const rider = clip("rider", "V2", 2_000_000, 3_000_000);
    const caption = {
      caption_id: "caption_1" as never,
      track_id: "C1" as const,
      source_clip_id: null,
      start_us: 2_000_000,
      end_us: 3_000_000,
      text: "rider caption",
      preset_id: "default-bottom" as const,
      origin: "user" as const,
      edited: false,
      source_segment_ids: [],
    } as TimelineDocument["captions"][number];
    const result = plan(document([source, next, rider], { captions: [caption] }), {
      clipIds: [source.clip_id],
      copyIds: ["copy" as TimelineClip["clip_id"]],
      copyOnStart: true,
      targetTrackId: "V1",
      leadStartUs: 1_500_000,
      pointerTimeUs: 1_500_000,
      dropHit: { rowIndex: 1, trackId: "V1", band: "body", clipId: null, zone: null },
      mainTrackMagnet: true,
      linkageEnabled: true,
    });
    expect(result.lead).toEqual({ clipId: "copy", trackId: "V1", startUs: 2_000_000 });
    expect(result.operations).toContainEqual({ op: "duplicate_timeline_items", copies: [
      { item_kind: "clip", source_id: source.clip_id, copy_id: "copy", timeline_start_us: 2_000_000, track_id: "V1" },
    ] });
    expect(result.operations).toContainEqual({ op: "position_clips", placements: [
      { clip_id: next.clip_id, timeline_start_us: 4_000_000 },
      { clip_id: rider.clip_id, timeline_start_us: 4_000_000 },
    ] });
    expect(result.operations).toContainEqual({ op: "set_caption_timing", caption_id: caption.caption_id, start_us: 4_000_000, end_us: 5_000_000 });
  });

  it("keeps an A/V linked copy aligned when main-track magnet moves its video copy to an insert cut", () => {
    const video = clip("linked-v", "V1", 0, 2_000_000, { link_group_id: "linked-av" });
    const sound = clip("linked-a", "A1", 0, 2_000_000, { link_group_id: "linked-av" });
    const next = clip("linked-next", "V1", 2_000_000, 4_000_000);
    const result = plan(document([video, sound, next]), {
      clipIds: [video.clip_id, sound.clip_id],
      copyIds: ["linked-copy-v" as TimelineClip["clip_id"], "linked-copy-a" as TimelineClip["clip_id"]],
      copyOnStart: true,
      leadStartUs: 1_500_000,
      pointerTimeUs: 1_500_000,
      targetTrackId: "V1",
      dropHit: { rowIndex: 1, trackId: "V1", band: "body", clipId: null, zone: null },
      mainTrackMagnet: true,
    });
    expect(result.operations).toContainEqual({ op: "duplicate_timeline_items", copies: [
      { item_kind: "clip", source_id: video.clip_id, copy_id: "linked-copy-v", timeline_start_us: 2_000_000, track_id: "V1" },
      { item_kind: "clip", source_id: sound.clip_id, copy_id: "linked-copy-a", timeline_start_us: 2_000_000, track_id: "A1" },
    ] });
    expect(result.operations).not.toContainEqual(expect.objectContaining({ op: "add_track" }));
    expect(result.placements).toContainEqual({ clipId: "linked-copy-v", trackId: "V1", startUs: 2_000_000 });
    expect(result.placements).toContainEqual({ clipId: "linked-copy-a", trackId: "A1", startUs: 2_000_000 });
  });

  it("magnetic group moves on V1 as a single compacted order", () => {
    const first = clip("first", "V1", 0, 1_000_000);
    const second = clip("second", "V1", 1_000_000, 2_000_000);
    const last = clip("last", "V1", 2_000_000, 3_000_000);
    const final = clip("final", "V1", 3_000_000, 4_000_000);
    const rider = clip("final-rider", "V2", 3_000_000, 4_000_000);
    const result = plan(document([first, second, last, final, rider]), {
      clipIds: [first.clip_id, second.clip_id],
      leadStartUs: 1_000_000,
      pointerTimeUs: 2_750_000,
      targetTrackId: "V1",
      dropHit: { rowIndex: 1, trackId: "V1", band: "body", clipId: null, zone: null },
      mainTrackMagnet: true,
    });
    expect(result.operations).toEqual([{ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: last.clip_id, timeline_start_us: 0 },
      { clip_id: first.clip_id, timeline_start_us: 1_000_000 },
      { clip_id: second.clip_id, timeline_start_us: 2_000_000 },
    ]) }]);
    const placements = result.operations.flatMap(operation => operation.op === "position_clips" ? operation.placements : []);
    expect(placements).not.toContainEqual(expect.objectContaining({ clip_id: final.clip_id }));
    expect(placements).not.toContainEqual(expect.objectContaining({ clip_id: rider.clip_id }));
  });

  it("linked A/V group inserted by the V1 magnet preserves pre-existing main-track gaps", () => {
    const first = clip("gap-first", "V1", 0, 1_000_000);
    const next = clip("gap-next", "V1", 2_000_000, 3_000_000);
    const video = clip("gap-source-video", "V2", 5_000_000, 6_000_000, { link_group_id: "gap-source-av" });
    const audio = clip("gap-source-audio", "A2", 5_000_000, 6_000_000, { link_group_id: "gap-source-av" });
    const timeline = document([first, next, video, audio], {
      tracks: [...tracks, { id: "A2", kind: "audio", locked: false, hidden: false, muted: false, solo: false }],
    });
    const result = planClipDrag({
      document: timeline,
      clipIds: [video.clip_id, audio.clip_id],
      leadClipId: video.clip_id,
      leadStartUs: 200_000,
      pointerTimeUs: 200_000,
      dropHit: { rowIndex: 1, trackId: "V1", band: "body", clipId: null, zone: null },
      targetTrackId: "V1",
      mode: "place",
      copyOnStart: false,
      mainTrackMagnet: true,
      linkageEnabled: true,
    });
    expect(result.operations).toContainEqual({ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: video.clip_id, track_id: "V1", timeline_start_us: 0 },
      { clip_id: audio.clip_id, track_id: "A1", timeline_start_us: 0 },
      { clip_id: first.clip_id, timeline_start_us: 1_000_000 },
      { clip_id: next.clip_id, timeline_start_us: 3_000_000 },
    ]) });
  });

  it("plans main-track riders from the final close-and-insert result", () => {
    const first = clip("rider-order-first", "V1", 0, 1_000_000);
    const second = clip("rider-order-second", "V1", 1_000_000, 2_000_000);
    const third = clip("rider-order-third", "V1", 2_000_000, 3_000_000);
    const fourth = clip("rider-order-fourth", "V1", 3_000_000, 4_000_000);
    const rider = clip("rider-order-overlay", "V2", 3_000_000, 4_000_000);
    const blocker = clip("rider-order-blocker", "V2", 1_000_000, 2_000_000);
    const caption = {
      caption_id: "rider-order-caption" as never,
      track_id: "C1" as const,
      source_clip_id: null,
      start_us: 3_000_000,
      end_us: 4_000_000,
      text: "caption on the unmoved successor",
      preset_id: "default-bottom" as const,
      origin: "user" as const,
      edited: false,
      source_segment_ids: [],
    } as TimelineDocument["captions"][number];
    const result = plan(document([first, second, third, fourth, rider, blocker], { captions: [caption] }), {
      clipIds: [first.clip_id, second.clip_id],
      leadClipId: first.clip_id,
      leadStartUs: 1_000_000,
      pointerTimeUs: 2_750_000,
      targetTrackId: "V1",
      dropHit: { rowIndex: 1, trackId: "V1", band: "body", clipId: null, zone: null },
      mainTrackMagnet: true,
      linkageEnabled: true,
    });
    const placements = result.operations.flatMap(operation => operation.op === "position_clips" ? operation.placements : []);

    expect(result.reason).toBeUndefined();
    expect(placements).toEqual(expect.arrayContaining([
      { clip_id: first.clip_id, timeline_start_us: 1_000_000 },
      { clip_id: second.clip_id, timeline_start_us: 2_000_000 },
      { clip_id: third.clip_id, timeline_start_us: 0 },
    ]));
    // The fourth clip's close (-2s) and insert (+2s) cancel. Its rider and caption must therefore
    // stay at 3s; a close-only carry would move the rider onto the blocker and open an unnecessary V3.
    expect(placements).not.toContainEqual(expect.objectContaining({ clip_id: rider.clip_id }));
    expect(placements).not.toContainEqual(expect.objectContaining({ clip_id: fourth.clip_id }));
    expect(result.operations.some(operation => operation.op === "add_track")).toBe(false);
    expect(result.operations.some(operation => operation.op === "set_caption_timing" && operation.caption_id === caption.caption_id)).toBe(false);
  });

  it("main-track reorder leaves a locked explicit-link partner in place", () => {
    const video = clip("locked-link-video", "V1", 0, 2_000_000, { link_group_id: "locked-link" });
    const audio = clip("locked-link-audio", "A1", 0, 2_000_000, { link_group_id: "locked-link" });
    const next = clip("locked-link-next", "V1", 2_000_000, 4_000_000);
    const result = plan(document([video, audio, next], { locked_elements: [audio.clip_id] }), {
      leadStartUs: 2_000_000,
      pointerTimeUs: 3_500_000,
      targetTrackId: "V1",
      dropHit: { rowIndex: 1, trackId: "V1", band: "body", clipId: null, zone: null },
      mainTrackMagnet: true,
    });
    expect(result.operations).toContainEqual({ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: video.clip_id, timeline_start_us: 2_000_000 },
      { clip_id: next.clip_id, timeline_start_us: 0 },
    ]) });
    expect(result.operations.flatMap(operation => operation.op === "position_clips" ? operation.placements : []))
      .not.toContainEqual(expect.objectContaining({ clip_id: audio.clip_id }));
  });

  it("linkage carries a writable rider with a moved V1 source even when the main-track magnet is off", () => {
    const source = clip("linkage-source", "V1", 0, 2_000_000);
    const rider = clip("linkage-rider", "V2", 1_260_000, 2_260_000);
    const v3: TimelineTrack = { id: "V3", kind: "video", locked: false, hidden: false, muted: false, solo: false };
    const doc = document([source, rider], { tracks: [...tracks.slice(0, 3), v3, tracks[3]!] });
    const moved = plan(doc, {
      leadStartUs: 2_300_000,
      pointerTimeUs: 2_800_000,
      targetTrackId: "V3",
      dropHit: { rowIndex: 3, trackId: "V3", band: "body", clipId: null, zone: null },
      mainTrackMagnet: false,
      linkageEnabled: true,
    });
    expect(moved.operations).toContainEqual({ op: "position_clips", placements: [
      { clip_id: source.clip_id, track_id: "V3", timeline_start_us: 2_300_000 },
    ] });
    expect(moved.operations).toContainEqual({ op: "position_clips", ignore_link: true, placements: [
      { clip_id: rider.clip_id, timeline_start_us: 3_560_000 },
    ] });

    const unlinked = plan(doc, {
      leadStartUs: 2_300_000,
      pointerTimeUs: 2_800_000,
      targetTrackId: "V3",
      dropHit: { rowIndex: 3, trackId: "V3", band: "body", clipId: null, zone: null },
      mainTrackMagnet: false,
      linkageEnabled: false,
    });
    expect(unlinked.operations.flatMap(operation => operation.op === "position_clips" ? operation.placements : []))
      .not.toContainEqual(expect.objectContaining({ clip_id: rider.clip_id }));
  });

  it("keeps a 10k non-rider main-source move linear and leaves the background clips untouched", () => {
    const source = clip("no-rider-source", "V1", 0, 1_000_000);
    const background = Array.from({ length: 10_000 }, (_, index) => clip(
      `no-rider-background-${index}`,
      "V2",
      10_000_000 + index * 1_000_000,
      10_500_000 + index * 1_000_000,
    ));
    const planner = createClipDragPlanner(document([source, ...background]));
    const input = {
      clipIds: [source.clip_id],
      leadClipId: source.clip_id,
      leadStartUs: 2_000_000,
      pointerTimeUs: 2_000_000,
      targetTrackId: "V2",
      dropHit: { rowIndex: 2, trackId: "V2", band: "body" as const, clipId: null, zone: null },
      mode: "place" as const,
      copyOnStart: false,
      mainTrackMagnet: false,
      linkageEnabled: true,
    };
    const result = planner(input);
    expect(result.reason).toBeUndefined();
    expect(result.operations).toEqual([{ op: "position_clips", placements: [
      { clip_id: source.clip_id, track_id: "V2", timeline_start_us: 2_000_000 },
    ] }]);
    expect(result.placements).toEqual([{ clipId: source.clip_id, trackId: "V2", startUs: 2_000_000 }]);

    for (let warm = 0; warm < 5; warm += 1) planner(input);
    const timings = Array.from({ length: 21 }, () => {
      const start = performance.now();
      planner(input);
      return performance.now() - start;
    }).sort((a, b) => a - b);
    const p50 = timings[Math.floor(timings.length * 0.5)]!;
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1]!;
    if (process.env.TIMELINE_DRAG_BENCH === "1") {
      console.info(`[timeline-drag-bench] clips=10000 V1-move-no-riders p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
    }
    expect(p95, "10k non-rider main-source move p95").toBeLessThan(16);
  });

  it("moves a carried rider off an occupied lane after a non-magnetic V1 drop", () => {
    const source = clip("settle-source", "V1", 0, 2_000_000);
    const rider = clip("settle-rider", "V2", 1_260_000, 2_260_000);
    const result = plan(document([source, rider]), {
      leadStartUs: 2_300_000,
      pointerTimeUs: 2_800_000,
      targetTrackId: "V2",
      dropHit: { rowIndex: 2, trackId: "V2", band: "body", clipId: null, zone: null },
      mainTrackMagnet: false,
      linkageEnabled: true,
    });
    expect(result.operations[0]).toEqual({ op: "add_track", kind: "video", track_id: "V3", before_track_id: "V2" });
    const placements = result.operations.flatMap(operation => operation.op === "position_clips" ? operation.placements : []);
    expect(placements).toContainEqual({ clip_id: source.clip_id, track_id: "V2", timeline_start_us: 2_300_000 });
    expect(placements).toContainEqual({ clip_id: rider.clip_id, track_id: "V3", timeline_start_us: 3_560_000 });
  });

  it("moves every member of a multi-track group by the same lane delta and ignores clip edge zones", () => {
    const first = clip("lane-first", "V1", 0, 1_000_000);
    const second = clip("lane-second", "V2", 0, 1_000_000);
    const target = clip("lane-target", "V2", 5_000_000, 6_000_000);
    const v3: TimelineTrack = { id: "V3", kind: "video", locked: false, hidden: false, muted: false, solo: false };
    const doc = document([first, second, target], { tracks: [tracks[0]!, tracks[1]!, tracks[2]!, v3, tracks[3]!] });
    const result = plan(doc, {
      clipIds: [first.clip_id, second.clip_id],
      leadClipId: first.clip_id,
      leadStartUs: 3_000_000,
      targetTrackId: "V2",
      dropHit: { rowIndex: 2, trackId: "V2", band: "body", clipId: target.clip_id, zone: "before" },
    });
    expect(result.reason).toBeUndefined();
    expect(result.operations).toContainEqual({ op: "position_clips", placements: [
      { clip_id: first.clip_id, track_id: "V2", timeline_start_us: 3_000_000 },
      { clip_id: second.clip_id, track_id: "V3", timeline_start_us: 3_000_000 },
    ] });
    expect(result.placements).not.toContainEqual(expect.objectContaining({ clipId: target.clip_id }));
  });

  it("opens a compatible track for each member of a grouped Alt-copy dropped beyond the outer row", () => {
    const first = clip("outer-first", "V1", 0, 1_000_000);
    const second = clip("outer-second", "V2", 0, 1_000_000);
    const v4: TimelineTrack = { id: "V4", kind: "video", locked: false, hidden: false, muted: false, solo: false };
    const result = plan(document([first, second], { tracks: [tracks[0]!, tracks[1]!, tracks[2]!, v4, tracks[3]!] }), {
      clipIds: [first.clip_id, second.clip_id],
      copyIds: ["outer-copy-1" as TimelineClip["clip_id"], "outer-copy-2" as TimelineClip["clip_id"]],
      copyOnStart: true,
      targetTrackId: "V1",
      dropHit: { rowIndex: -1, trackId: null, band: "above", clipId: null, zone: null },
      leadStartUs: 2_000_000,
    });
    expect(result.reason).toBeUndefined();
    expect(result.operations.slice(0, 2)).toEqual([
      { op: "add_track", kind: "video", track_id: "V6", before_track_id: "V1" },
      { op: "add_track", kind: "video", track_id: "V5", before_track_id: "V6" },
    ]);
    expect(result.operations).toContainEqual({ op: "duplicate_timeline_items", copies: [
      { item_kind: "clip", source_id: first.clip_id, copy_id: "outer-copy-1", timeline_start_us: 2_000_000, track_id: "V5" },
      { item_kind: "clip", source_id: second.clip_id, copy_id: "outer-copy-2", timeline_start_us: 2_000_000, track_id: "V6" },
    ] });
  });

  it("opens collision tracks in target order and allocates ids above the largest existing number", () => {
    const first = clip("conflict-first", "V1", 0, 1_000_000);
    const second = clip("conflict-second", "V2", 0, 1_000_000);
    const blocker1 = clip("conflict-blocker-1", "V1", 5_000_000, 6_000_000);
    const blocker2 = clip("conflict-blocker-2", "V2", 5_000_000, 6_000_000);
    const v4: TimelineTrack = { id: "V4", kind: "video", locked: false, hidden: false, muted: false, solo: false };
    const doc = document([first, second, blocker1, blocker2], { tracks: [tracks[0]!, tracks[1]!, tracks[2]!, v4, tracks[3]!] });
    const result = plan(doc, {
      clipIds: [first.clip_id, second.clip_id], leadClipId: first.clip_id,
      leadStartUs: 5_000_000, targetTrackId: "V1", pointerTimeUs: 5_000_000,
      dropHit: { rowIndex: 1, trackId: "V1", band: "body", clipId: null, zone: null },
    });
    expect(result.reason).toBeUndefined();
    expect(result.operations.slice(0, 2)).toEqual([
      { op: "add_track", kind: "video", track_id: "V5", before_track_id: "V1" },
      { op: "add_track", kind: "video", track_id: "V6", before_track_id: "V2" },
    ]);
    expect(result.placements).toEqual([
      { clipId: first.clip_id, trackId: "V5", startUs: 5_000_000 },
      { clipId: second.clip_id, trackId: "V6", startUs: 5_000_000 },
    ]);
  });

  it("short Replace ripples backward only on V1 with main magnet", () => {
    const source = clip("short-source", "V1", 0, 1_000_000);
    const target = clip("long-target", "V2", 5_000_000, 7_000_000);
    const next = clip("long-next", "V2", 7_000_000, 8_000_000);
    const result = plan(document([source, target, next]), {
      leadStartUs: 5_000_000,
      targetTrackId: "V2",
      mainTrackMagnet: true,
      dropHit: { rowIndex: 2, trackId: "V2", band: "body", clipId: target.clip_id, zone: "replace" },
    });
    expect(result.operations).toEqual([
      { op: "remove_clip", clip_id: target.clip_id, ignore_link: true },
      { op: "position_clips", placements: [{ clip_id: source.clip_id, track_id: "V2", timeline_start_us: 5_000_000 }] },
    ]);
    const mainTarget = clip("main-target", "V1", 5_000_000, 7_000_000);
    const mainNext = clip("main-next", "V1", 7_000_000, 8_000_000);
    const mainResult = plan(document([source, mainTarget, mainNext]), {
      leadStartUs: 5_000_000,
      targetTrackId: "V1",
      mainTrackMagnet: true,
      dropHit: { rowIndex: 1, trackId: "V1", band: "body", clipId: mainTarget.clip_id, zone: "replace" },
    });
    expect(mainResult.operations).toContainEqual({ op: "position_clips", placements: [
      { clip_id: mainNext.clip_id, track_id: "V1", timeline_start_us: 6_000_000 },
      { clip_id: source.clip_id, track_id: "V1", timeline_start_us: 5_000_000 },
    ] });
  });

  it("keeps unobstructed main-magnet riders on their lane and settles collisions to a free compatible lane", () => {
    const first = clip("settle-host-1", "V1", 0, 2_000_000);
    const second = clip("settle-host-2", "V1", 2_000_000, 4_000_000);
    const rider = clip("settle-rider", "V2", 0, 1_000_000);
    const v3: TimelineTrack = { id: "V3", kind: "video", locked: false, hidden: false, muted: false, solo: false };
    const freePlan = planMagneticMove(document([first, second, rider], { tracks: [tracks[0]!, tracks[1]!, tracks[2]!, v3, tracks[3]!] }), first.clip_id, 4_500_000, true);
    expect(freePlan.operations).toContainEqual({ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: rider.clip_id, timeline_start_us: 2_000_000 },
    ]) });
    expect(freePlan.operations.some(operation => operation.op === "add_track")).toBe(false);

    const blocker = clip("settle-blocker", "V2", 1_000_000, 5_000_000);
    const settled = planMagneticMove(document([first, second, rider, blocker], { tracks: [tracks[0]!, tracks[1]!, tracks[2]!, v3, tracks[3]!] }), first.clip_id, 4_500_000, true);
    expect(settled.operations).toContainEqual({ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: rider.clip_id, timeline_start_us: 2_000_000, track_id: "V3" },
    ]) });

    const lockedV3 = { ...v3, locked: true };
    const lockedFallback = planMagneticMove(document([first, second, rider, blocker], { tracks: [tracks[0]!, tracks[1]!, tracks[2]!, lockedV3, tracks[3]!] }), first.clip_id, 4_500_000, true);
    expect(lockedFallback.operations).toContainEqual({ op: "add_track", kind: "video", track_id: "V4", before_track_id: "V2" });
    expect(lockedFallback.operations).toContainEqual({ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: rider.clip_id, timeline_start_us: 2_000_000, track_id: "V4" },
    ]) });
  });

  it("settles linked A/V riders together and creates the missing compatible lane", () => {
    const first = clip("linked-host-1", "V1", 0, 2_000_000, { link_group_id: "settle-link" });
    const second = clip("linked-host-2", "V1", 2_000_000, 4_000_000);
    const videoRider = clip("linked-video-rider", "V2", 0, 2_000_000, { link_group_id: "settle-link" });
    const audioRider = clip("linked-audio-rider", "A1", 0, 2_000_000, { link_group_id: "settle-link" });
    const videoBlocker = clip("linked-video-blocker", "V2", 1_000_000, 5_000_000);
    const audioBlocker = clip("linked-audio-blocker", "A1", 1_000_000, 5_000_000);
    const result = planMagneticMove(document([first, second, videoRider, audioRider, videoBlocker, audioBlocker]), first.clip_id, 4_500_000, true);
    expect(result.reason).toBeUndefined();
    expect(result.operations).toContainEqual({ op: "add_track", kind: "audio", track_id: "A2", after_track_id: "A1" });
    expect(result.operations).toContainEqual({ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: videoRider.clip_id, timeline_start_us: 2_000_000, track_id: "V3" },
      { clip_id: audioRider.clip_id, timeline_start_us: 2_000_000, track_id: "A2" },
    ]) });
  });

  it("keeps hot Place, Insert, and V1 magnet-copy plans within 16ms at 100, 1k, and 10k clips", () => {
    const measure = (planner: ReturnType<typeof createClipDragPlanner>, input: Parameters<ReturnType<typeof createClipDragPlanner>>[0]) => {
      for (let warm = 0; warm < 5; warm += 1) planner(input);
      const timings = Array.from({ length: 21 }, () => {
        const start = performance.now();
        planner(input);
        return performance.now() - start;
      }).sort((a, b) => a - b);
      return { p50: timings[Math.floor(timings.length * 0.5)]!, p95: timings[Math.ceil(timings.length * 0.95) - 1]! };
    };
    for (const size of [100, 1_000, 10_000]) {
      const source = clip(`bench_source_${size}`, "V2", 0, 500_000);
      const background = Array.from({ length: size }, (_, index) => clip(
        `bench_${size}_${index}`,
        "V2",
        (index + 1) * 1_000_000,
        (index + 1) * 1_000_000 + 500_000,
      ));
      const doc = document([source, ...background]);
      const options = {
        leadStartUs: (size + 2) * 1_000_000,
        targetTrackId: "V2",
        dropHit: { rowIndex: 2, trackId: "V2", band: "body" as const, clipId: null, zone: null },
        mainTrackMagnet: false,
      };
      const preparedPlanner = createClipDragPlanner(doc);
      const preparedInput = {
        clipIds: [source.clip_id],
        leadClipId: source.clip_id,
        pointerTimeUs: (size + 2) * 1_000_000,
        mode: "place" as const,
        copyOnStart: false,
        linkageEnabled: true,
        ...options,
      };
      const place = measure(preparedPlanner, preparedInput);

      const insertInput = {
        ...preparedInput,
        mode: "insert" as const,
        pointerTimeUs: (Math.floor(size / 2) + 1.1) * 1_000_000,
        leadStartUs: (Math.floor(size / 2) + 1.1) * 1_000_000,
      };
      const insert = measure(preparedPlanner, insertInput);
      const insertPlan = preparedPlanner(insertInput);

      const mainClips = Array.from({ length: size }, (_, index) => clip(
        `main_bench_${size}_${index}`,
        "V1",
        index * 1_000_000,
        index * 1_000_000 + 500_000,
      ));
      const mainDoc = document(mainClips);
      const mainPlanner = createClipDragPlanner(mainDoc);
      const mainSource = mainClips[0]!;
      const mainCopy = measure(mainPlanner, {
        clipIds: [mainSource.clip_id],
        leadClipId: mainSource.clip_id,
        copyIds: [`main_copy_${size}` as TimelineClip["clip_id"]],
        copyOnStart: true,
        leadStartUs: Math.floor(size / 2) * 1_000_000 + 100_000,
        pointerTimeUs: Math.floor(size / 2) * 1_000_000 + 100_000,
        targetTrackId: "V1",
        dropHit: { rowIndex: 1, trackId: "V1", band: "body" as const, clipId: null, zone: null },
        mode: "place" as const,
        mainTrackMagnet: true,
        linkageEnabled: true,
      });
      const groupCount = Math.min(size >= 1_000 ? 128 : 32, size);
      const groupInput = {
        clipIds: mainClips.slice(0, groupCount).map(item => item.clip_id),
        leadClipId: mainSource.clip_id,
        leadStartUs: size * 1_000_000,
        pointerTimeUs: (size + 1) * 1_000_000,
        targetTrackId: "V1",
        dropHit: { rowIndex: 1, trackId: "V1", band: "body" as const, clipId: null, zone: null },
        mode: "place" as const,
        copyOnStart: false,
        mainTrackMagnet: true,
        linkageEnabled: true,
      };
      const groupPlan = mainPlanner(groupInput);
      const group = measure(mainPlanner, groupInput);
      const placementCount = (operations: ReturnType<typeof planClipDrag>["operations"]) => operations.reduce((sum, operation) =>
        sum + (operation.op === "position_clips" ? operation.placements.length : operation.op === "position_clip" ? 1 : 0), 0);
      if (size >= 1_000) {
        expect(placementCount(insertPlan.operations), `${size} clips Insert moved clips`).toBeGreaterThan(100);
        expect(placementCount(groupPlan.operations), `${size} clips V1 group moved clips`).toBeGreaterThan(100);
        expect(new TextEncoder().encode(JSON.stringify({ schema_version: 1, operations: groupPlan.operations })).byteLength,
          `${size} clips grouped request body bytes`).toBeLessThan(4 * 1024 * 1024);
      }

      if (process.env.TIMELINE_DRAG_BENCH === "1") {
        console.info(`[timeline-drag-bench] clips=${size} Place p50=${place.p50.toFixed(2)}ms p95=${place.p95.toFixed(2)}ms; Insert p50=${insert.p50.toFixed(2)}ms p95=${insert.p95.toFixed(2)}ms; V1-copy p50=${mainCopy.p50.toFixed(2)}ms p95=${mainCopy.p95.toFixed(2)}ms; V1-group(${groupCount}) p50=${group.p50.toFixed(2)}ms p95=${group.p95.toFixed(2)}ms`);
      }
      expect(place.p95, `${size} clips Place p95`).toBeLessThan(16);
      expect(insert.p95, `${size} clips Insert p95`).toBeLessThan(16);
      expect(mainCopy.p95, `${size} clips V1 magnet-copy p95`).toBeLessThan(16);
      expect(group.p95, `${size} clips V1 group(${groupCount}) p95`).toBeLessThan(16);
    }
  });

  it("keeps a 10k single-lane linked rider carry under 16ms p95", () => {
    const size = 10_000;
    const riderHost = clip(`rider_host_${size}`, "V1", 0, (size + 1) * 1_000_000);
    const riders = Array.from({ length: size }, (_, index) => clip(
      `rider_${size}_${index}`,
      "V2",
      index * 1_000_000,
      index * 1_000_000 + 500_000,
    ));
    const riderPlanner = createClipDragPlanner(document([riderHost, ...riders]));
    const riderInput = {
      clipIds: [riderHost.clip_id],
      leadClipId: riderHost.clip_id,
      leadStartUs: (size + 1) * 1_000_000,
      pointerTimeUs: (size + 1) * 1_000_000,
      targetTrackId: "V2",
      dropHit: { rowIndex: 2, trackId: "V2", band: "body" as const, clipId: null, zone: null },
      mode: "place" as const,
      copyOnStart: false,
      mainTrackMagnet: false,
      linkageEnabled: true,
    };
    const riderPlan = riderPlanner(riderInput);
    expect(riderPlan.reason).toBeUndefined();
    const riderPositions = riderPlan.operations.flatMap(operation => operation.op === "position_clips" ? operation.placements : []);
    expect(riderPositions).toHaveLength(size + 1);
    expect(riderPositions).toContainEqual({ clip_id: riders[0]!.clip_id, track_id: "V3", timeline_start_us: (size + 1) * 1_000_000 });
    expect(riderPositions).toContainEqual({ clip_id: riders.at(-1)!.clip_id, track_id: "V3", timeline_start_us: (2 * size) * 1_000_000 });
    expect(new TextEncoder().encode(JSON.stringify({ schema_version: 1, operations: riderPlan.operations })).byteLength)
      .toBeLessThan(4 * 1024 * 1024);

    for (let warm = 0; warm < 5; warm += 1) riderPlanner(riderInput);
    const timings = Array.from({ length: 21 }, () => {
      const start = performance.now();
      riderPlanner(riderInput);
      return performance.now() - start;
    }).sort((a, b) => a - b);
    const p50 = timings[Math.floor(timings.length * 0.5)]!;
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1]!;
    if (process.env.TIMELINE_DRAG_BENCH === "1") {
      console.info(`[timeline-drag-bench] clips=${size} V1-rider-carry(${size}) p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
    }
    expect(p95, "10k linked rider carry p95").toBeLessThan(16);
  });
});
