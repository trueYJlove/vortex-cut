import { describe, expect, it } from "vitest";
import type { TimelineClip, TimelineDocument } from "@aivideo/contracts";
import { planAdvancedEdit } from "../src/app/timeline/advanced-edit.js";

function makeClip(id: string, start: number, end: number, sourceStart: number, sourceEnd: number): TimelineClip {
  return {
    clip_id: id as TimelineClip["clip_id"], track_id: "V1", order_index: 0,
    asset_id: "asset_1" as TimelineClip["asset_id"], asset_kind: "video",
    source_start_us: sourceStart, source_end_us: sourceEnd,
    timeline_start_us: start, timeline_end_us: end, layout: "fit",
    audio: { enabled: false, gain_db: 0 }, speed_milli: 1000, reverse_playback: false,
  } as TimelineClip;
}

function makeDocument(clips: TimelineClip[]): TimelineDocument {
  return {
    schema_version: 1, project_id: "project_1" as TimelineDocument["project_id"],
    canvas: { width: 1920, height: 1080, fps_num: 10, fps_den: 1 },
    tracks: [{ id: "V1", kind: "video", order_index: 0 }], clips, captions: [], transitions: [], locked_elements: [],
  } as unknown as TimelineDocument;
}

describe("advanced timeline edge edits", () => {
  it("rolls a shared cut while keeping the pair's outer bounds fixed", () => {
    const clips = [makeClip("left", 0, 2_000_000, 0, 2_000_000), makeClip("right", 2_000_000, 5_000_000, 2_000_000, 5_000_000)];
    const plan = planAdvancedEdit(makeDocument(clips), "roll", ["left", "right"], 1_000_000, 100_000, new Map([["asset_1", 5_000_000]]));
    expect(plan.deltaUs).toBe(1_000_000);
    expect(plan.targets.map(target => [target.timelineStartUs, target.timelineEndUs])).toEqual([[0, 3_000_000], [3_000_000, 5_000_000]]);
    expect(plan.operations).toMatchObject([
      { op: "set_clip_source_window", clip_id: "left", source_start_us: 0, source_end_us: 3_000_000, anchor: "start" },
      { op: "set_clip_source_window", clip_id: "right", source_start_us: 3_000_000, source_end_us: 5_000_000, anchor: "end" },
    ]);
  });

  it("slips source frames while preserving timeline placement and duration", () => {
    const clip = makeClip("clip", 4_000_000, 6_000_000, 1_000_000, 3_000_000);
    const plan = planAdvancedEdit(makeDocument([clip]), "slip", ["clip"], 1_000_000, 100_000, new Map([["asset_1", 5_000_000]]));
    expect(plan.targets[0]).toMatchObject({ sourceStartUs: 2_000_000, sourceEndUs: 4_000_000, timelineStartUs: 4_000_000, timelineEndUs: 6_000_000 });
    expect(plan.operations[0]).toMatchObject({ op: "set_clip_source_window", anchor: "timeline" });
  });

  it("slides a middle clip while trimming the two neighboring source edges", () => {
    const clips = [
      makeClip("before", 0, 2_000_000, 0, 2_000_000),
      makeClip("middle", 2_000_000, 4_000_000, 2_000_000, 4_000_000),
      makeClip("after", 4_000_000, 5_000_000, 4_000_000, 5_000_000),
    ];
    const plan = planAdvancedEdit(makeDocument(clips), "slide", ["before", "middle", "after"], 500_000, 100_000, new Map([["asset_1", 5_000_000]]));
    expect(plan.deltaUs).toBe(500_000);
    expect(plan.targets.map(target => [target.timelineStartUs, target.timelineEndUs])).toEqual([[0, 2_500_000], [2_500_000, 4_500_000], [4_500_000, 5_000_000]]);
    expect(plan.operations.map(operation => operation.op)).toEqual(["set_clip_source_window", "position_clip", "set_clip_source_window"]);
  });
});
