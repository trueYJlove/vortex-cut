import { describe, expect, it } from "vitest";
import type { TimelineClip, TimelineDocument } from "@aivideo/contracts";
import { planTimelineSpeedEdge, speedMilliForLength } from "../src/app/timeline/speed-edge-plan.js";

const clip = (id: string, trackId: string, startUs: number, endUs: number, overrides: Partial<TimelineClip> = {}): TimelineClip => ({
  clip_id: id as TimelineClip["clip_id"],
  track_id: trackId,
  order_index: 0,
  asset_id: `${id}-asset` as TimelineClip["asset_id"],
  asset_kind: trackId === "A1" ? "audio" : "video",
  source_start_us: 0,
  source_end_us: endUs - startUs,
  timeline_start_us: startUs,
  timeline_end_us: endUs,
  layout: "fit",
  audio: { enabled: true, gain_db: 0 },
  ...overrides,
});

const documentOf = (clips: TimelineClip[]): TimelineDocument => ({
  schema_version: 1,
  project_id: "p1" as never,
  canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, background_color: "#000000" },
  tracks: [
    { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
    { id: "V2", kind: "video", locked: false, hidden: false, muted: false, solo: false },
    { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
  ],
  clips,
  captions: [],
  provenance: { created_by: "user", source_transcript_ids: [] },
});

describe("OpenFilm speed-edge plan", () => {
  it("converts timeline length to the source speed's three significant figures", () => {
    expect(speedMilliForLength(2_000_000, 1_739_130)).toBe(1_150);
    expect(speedMilliForLength(2_000_000, 0)).toBe(100_000);
  });

  it("keeps a marker-snapped edge landed at the milli-speed resolution", () => {
    expect(speedMilliForLength(100_000_000, 99_900_100, true)).toBe(1_001);
    expect(speedMilliForLength(100_000_000, 99_900_100)).toBe(1_000);
  });

  it("keeps a non-magnetic video end fixed when its start speed handle moves", () => {
    const video = clip("video", "V2", 5_000_000, 7_000_000);
    const plan = planTimelineSpeedEdge(documentOf([video]), video, 2_000, "left", false, true);
    expect(plan.targets).toMatchObject([{ clipId: video.clip_id, startUs: 6_000_000, endUs: 7_000_000, speedMilli: 2_000 }]);
    expect(plan.operations).toContainEqual({ op: "position_clips", placements: [{ clip_id: video.clip_id, timeline_start_us: 6_000_000 }] });
  });

  it("keeps the start and ripples main-track followers and linked riders", () => {
    const lead = clip("lead", "V1", 0, 2_000_000);
    const follower = clip("follower", "V1", 2_000_000, 4_000_000);
    const rider = clip("rider", "V2", 2_250_000, 3_000_000, { source_end_us: 750_000 });
    const plan = planTimelineSpeedEdge(documentOf([lead, follower, rider]), lead, 2_000, "right", true, true);
    expect(plan.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ clipId: lead.clip_id, startUs: 0, endUs: 1_000_000 }),
      expect.objectContaining({ clipId: follower.clip_id, startUs: 1_000_000, endUs: 3_000_000 }),
      expect.objectContaining({ clipId: rider.clip_id, startUs: 1_250_000, endUs: 2_000_000 }),
    ]));
    expect(plan.operations).toContainEqual({ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: follower.clip_id, timeline_start_us: 1_000_000 },
      { clip_id: rider.clip_id, timeline_start_us: 1_250_000 },
    ]) });
  });

  it("ripples following clips on a linked partner track even without a main-track rider", () => {
    const group = "linked-av";
    const lead = clip("lead", "V1", 0, 2_000_000, { link_group_id: group });
    const linkedAudio = clip("linked-audio", "A1", 0, 2_000_000, { link_group_id: group });
    const audioFollower = clip("audio-follower", "A1", 2_000_000, 4_000_000);
    const document = documentOf([lead, linkedAudio, audioFollower]);
    const plan = planTimelineSpeedEdge(document, lead, 2_000, "right", true, true);
    expect(plan.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ clipId: lead.clip_id, startUs: 0, endUs: 1_000_000 }),
      expect.objectContaining({ clipId: linkedAudio.clip_id, startUs: 0, endUs: 1_000_000 }),
      expect.objectContaining({ clipId: audioFollower.clip_id, startUs: 1_000_000, endUs: 3_000_000 }),
    ]));
    expect(plan.operations).toContainEqual({ op: "position_clips", placements: expect.arrayContaining([
      { clip_id: audioFollower.clip_id, timeline_start_us: 1_000_000 },
    ]) });
  });

  it("limits a non-ripple slow-down at the next same-track clip", () => {
    const lead = clip("lead", "V2", 0, 2_000_000);
    const next = clip("next", "V2", 2_500_000, 4_500_000);
    const plan = planTimelineSpeedEdge(documentOf([lead, next]), lead, 500, "right", false, false);
    expect(plan.speedMilli).toBe(800);
    expect(plan.targets).toMatchObject([{ clipId: lead.clip_id, startUs: 0, endUs: 2_500_000, speedMilli: 800 }]);
    expect(plan.reason).toBeUndefined();
  });

  it("keeps linked audio on the same speed while preserving the selected edge", () => {
    const group = "link-1";
    const video = clip("video", "V2", 5_000_000, 7_000_000, { link_group_id: group });
    const audio = clip("audio", "A1", 5_000_000, 7_000_000, { link_group_id: group });
    const plan = planTimelineSpeedEdge(documentOf([video, audio]), video, 2_000, "left", false, true);
    expect(plan.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ clipId: video.clip_id, startUs: 6_000_000, endUs: 7_000_000 }),
      expect.objectContaining({ clipId: audio.clip_id, startUs: 6_000_000, endUs: 7_000_000 }),
    ]));
    expect(plan.operations.filter(operation => operation.op === "set_speed")).toHaveLength(2);
  });
});
