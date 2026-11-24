import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActiveTimelineTransition, TimelineClip, TimelineTrack, TimelineTransition } from "@aivideo/contracts";
import {
  computeActiveTransitionRects,
  computeTrackRows,
  computeTransitionRects,
} from "../src/app/timeline/geometry.js";
import type { TimelineViewState } from "../src/app/timeline/types.js";

type FixtureDocument = {
  tracks: unknown[];
  clips: unknown[];
  transitions: unknown[];
};
type ProjectionCase = {
  document?: FixtureDocument;
  expected_active_transitions?: unknown[];
  transition?: unknown;
  before_document?: FixtureDocument;
  after_document?: FixtureDocument;
  expected_before_pair?: { outgoing_clip_id: string; incoming_clip_id: string };
  expected_after_compatibility_transitions?: unknown[];
  expected_after_active_transitions?: unknown[];
};

const fixtures = JSON.parse(readFileSync(
  resolve(process.cwd(), "../../tests/fixtures/openfilm_transition_projection.json"),
  "utf8",
)) as { source_commit: string; cases: Record<string, ProjectionCase> };

const view: TimelineViewState = {
  pixelsPerSecond: 100,
  projectZoom: 1,
  scrollX: 0,
  trackHeight: 64,
  headerWidth: 51,
  rulerHeight: 20,
};

function fixtureRows(document: FixtureDocument) {
  return computeTrackRows(document.tracks as TimelineTrack[], view.rulerHeight, view.trackHeight);
}

function fixtureClips(document: FixtureDocument) {
  return document.clips as TimelineClip[];
}

describe("Core/OpenFilm active transition fixture geometry", () => {
  it("uses the shared pinned projection fixture", () => {
    expect(fixtures.source_commit).toBe("b125a3d9");
  });

  for (const name of ["touch_dip_black", "cross_track_dissolve", "cross_track_move_rest", "linked_audio_dedupe", "dip_white"] as const) {
    it(`places ${name} on the Core on_clip_id row and exact projected window`, () => {
      const fixture = fixtures.cases[name]!;
      const document = fixture.document!;
      const transitions = fixture.expected_active_transitions as ActiveTimelineTransition[];
      const rows = fixtureRows(document);
      const rects = computeActiveTransitionRects(transitions, fixtureClips(document), rows, view);

      expect(rects).toHaveLength(transitions.length);
      for (let index = 0; index < transitions.length; index += 1) {
        const transition = transitions[index]!;
        const rect = rects[index]!;
        const ownerTrackId = fixtureClips(document).find(clip => clip.clip_id === transition.on_clip_id)?.track_id;
        expect(rect).toMatchObject({
          x: view.headerWidth + transition.start_us / 1_000_000 * view.pixelsPerSecond,
          width: Math.max(10, (transition.end_us - transition.start_us) / 1_000_000 * view.pixelsPerSecond),
          y: rows.find(row => row.track.id === ownerTrackId)?.y,
          transition,
          editable: transition.kind === "dip-black" || transition.kind === "dissolve",
        });
      }
    });
  }

  it("keeps linked picture/audio projection deduplicated to the shared picture transition", () => {
    const fixture = fixtures.cases.linked_audio_dedupe!;
    expect(fixture.expected_active_transitions).toHaveLength(1);
    expect(fixture.expected_active_transitions?.[0]).toMatchObject({
      outgoing_clip_id: "linked-picture-out",
      incoming_clip_id: "linked-picture-in",
    });
  });

  it("keeps a fixed legacy pair before relocation and dormant after a new successor is inserted", () => {
    const fixture = fixtures.cases.stale_compatibility!;
    const transition = fixture.transition as TimelineTransition;
    const before = fixture.before_document!;
    const after = fixture.after_document!;
    expect(transition).toMatchObject({
      after_clip_id: fixture.expected_before_pair?.outgoing_clip_id,
      incoming_clip_id: fixture.expected_before_pair?.incoming_clip_id,
    });
    expect(computeTransitionRects(fixtureClips(before), [transition], fixtureRows(before), view)).toHaveLength(1);
    expect(fixture.expected_after_compatibility_transitions).toEqual([]);
    expect(fixture.expected_after_active_transitions).toEqual([]);
    expect(computeTransitionRects(fixtureClips(after), [transition], fixtureRows(after), view)).toHaveLength(0);
  });
});
