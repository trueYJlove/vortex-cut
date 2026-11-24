import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActiveTimelineTransition, TimelineClip } from "@aivideo/contracts";
import { clearActiveTransitionOperations, planActiveTransitionResize } from "../src/app/timeline/active-transition-edit.js";

type EditFixture = { document: { clips: unknown[] }; expected_active_transitions: unknown[] };
const fixture = JSON.parse(readFileSync(
  resolve(process.cwd(), "../../tests/fixtures/openfilm_transition_projection.json"),
  "utf8",
)) as { cases: Record<string, EditFixture> };
const clipsFor = (name: string) => fixture.cases[name]!.document.clips as TimelineClip[];
const transitionFor = (name: string) => fixture.cases[name]!.expected_active_transitions[0] as ActiveTimelineTransition;

describe("active transition source-fact editing", () => {
  it("resizes a same-track dip symmetrically by changing both source fade facts", () => {
    const plan = planActiveTransitionResize(transitionFor("touch_dip_black"), clipsFor("touch_dip_black"), "start", -100_000, 30, 1, new Map());
    expect(plan).toEqual([
      { op: "set_clip_transition_facts", clip_id: "dip-out", picture_fade_out_us: 550_000 },
      { op: "set_clip_transition_facts", clip_id: "dip-in", picture_fade_in_us: 550_000 },
    ]);
  });

  it("resizes a cross-track overlap start with a position patch and paired visual facts", () => {
    const plan = planActiveTransitionResize(transitionFor("cross_track_dissolve"), clipsFor("cross_track_dissolve"), "start", -250_000, 30, 1, new Map());
    expect(plan).toEqual([
      { op: "position_clip", clip_id: "dissolve-in", timeline_start_us: 733_333 },
      { op: "set_clip_transition_facts", clip_id: "dissolve-out", picture_fade_out_us: 1_266_667 },
      { op: "set_clip_transition_facts", clip_id: "dissolve-in", picture_fade_in_us: 1_266_667 },
    ]);
  });

  it("resizes a cross-track overlap end while preserving the outgoing start", () => {
    const plan = planActiveTransitionResize(
      transitionFor("cross_track_dissolve"), clipsFor("cross_track_dissolve"), "end", 250_000, 30, 1,
      new Map([["asset-out", 3_000_000]]),
    );
    expect(plan).toEqual([
      { op: "set_clip_source_window", clip_id: "dissolve-out", source_start_us: 0, source_end_us: 2_266_667, anchor: "start" },
      { op: "set_clip_transition_facts", clip_id: "dissolve-out", picture_fade_out_us: 1_266_667 },
      { op: "set_clip_transition_facts", clip_id: "dissolve-in", picture_fade_in_us: 1_266_667 },
    ]);
  });

  it("keeps move/rest and dip-white edits read-only until their paired services exist", () => {
    const move = transitionFor("cross_track_move_rest");
    const white = transitionFor("dip_white");
    expect(planActiveTransitionResize(move, clipsFor("cross_track_move_rest"), "start", -100_000, 30, 1, new Map())).toBeNull();
    expect(planActiveTransitionResize(white, clipsFor("dip_white"), "start", -100_000, 30, 1, new Map())).toBeNull();
    expect(clearActiveTransitionOperations(move)).toEqual([
      { op: "set_clip_transition_facts", clip_id: "move-head", move_in: null },
    ]);
    expect(clearActiveTransitionOperations(white)).toEqual([]);
  });

  it("clears active source facts without ever emitting a legacy transition operation", () => {
    const operations = clearActiveTransitionOperations(transitionFor("cross_track_dissolve"));
    expect(operations).toEqual([
      { op: "set_clip_transition_facts", clip_id: "dissolve-out", picture_fade_out_us: null },
      { op: "set_clip_transition_facts", clip_id: "dissolve-in", picture_fade_in_us: null },
    ]);
    expect(operations.some(operation => operation.op === "update_transition" || operation.op === "remove_transition")).toBe(false);
  });
});
