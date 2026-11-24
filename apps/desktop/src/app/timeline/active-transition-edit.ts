import type { ActiveTimelineTransition, TimelineClip, TimelinePatchOperation } from "@aivideo/contracts";

export type ActiveTransitionEdge = "start" | "end";

/**
 * Build an OpenFilm-style edge-resize patch from Core's active source-fact
 * projection. Every supported resize writes the corresponding clip facts;
 * overlap edits also move/extend the clips that define the projected window.
 * White dips and move/rest transitions intentionally stay read-only until the
 * frame-role and paired-head/rest editing services are available in Core.
 */
export function planActiveTransitionResize(
  transition: ActiveTimelineTransition,
  clips: readonly TimelineClip[],
  edge: ActiveTransitionEdge,
  deltaUs: number,
  fpsNum: number,
  fpsDen: number,
  assetDurationById: ReadonlyMap<string, number>,
): TimelinePatchOperation[] | null {
  const outgoing = clips.find(clip => clip.clip_id === transition.outgoing_clip_id);
  const incoming = clips.find(clip => clip.clip_id === transition.incoming_clip_id);
  if (!outgoing || !incoming || !Number.isFinite(deltaUs)) return null;

  const frameNum = Number.isSafeInteger(fpsNum) && fpsNum > 0 ? fpsNum : 30;
  const frameDen = Number.isSafeInteger(fpsDen) && fpsDen > 0 ? fpsDen : 1;
  const toFrame = (us: number) => Math.max(0, Math.round(Math.round(us * frameNum / (1_000_000 * frameDen)) * 1_000_000 * frameDen / frameNum));
  const minDurationUs = Math.max(100_000, toFrame(100_000));
  const pairedFades = (durationUs: number): TimelinePatchOperation[] => [
    { op: "set_clip_transition_facts", clip_id: outgoing.clip_id, picture_fade_out_us: durationUs },
    { op: "set_clip_transition_facts", clip_id: incoming.clip_id, picture_fade_in_us: durationUs },
  ];

  if (transition.kind === "dip-black") {
    const maxHalfUs = Math.min(
      outgoing.timeline_end_us - outgoing.timeline_start_us,
      incoming.timeline_end_us - incoming.timeline_start_us,
    );
    const requestedDuration = transition.end_us - transition.start_us + (edge === "start" ? -deltaUs : deltaUs);
    const maxDurationUs = Math.max(minDurationUs * 2, toFrame(maxHalfUs * 2));
    const durationUs = Math.min(maxDurationUs, Math.max(minDurationUs * 2, toFrame(requestedDuration)));
    const halfUs = Math.round(durationUs / 2);
    if (Math.abs(durationUs - (transition.end_us - transition.start_us)) < 1) return null;
    return [
      { op: "set_clip_transition_facts", clip_id: outgoing.clip_id, picture_fade_out_us: halfUs },
      { op: "set_clip_transition_facts", clip_id: incoming.clip_id, picture_fade_in_us: halfUs },
    ];
  }

  if (transition.kind !== "dissolve") return null;
  const currentDuration = transition.end_us - transition.start_us;
  const requestedDuration = currentDuration + (edge === "start" ? -deltaUs : deltaUs);
  const durationUs = Math.max(minDurationUs, toFrame(requestedDuration));
  if (Math.abs(durationUs - currentDuration) < 1) return null;

  if (edge === "start") {
    const nextStartUs = transition.end_us - durationUs;
    const shiftUs = nextStartUs - incoming.timeline_start_us;
    const movingIds = new Set(clips.filter(clip =>
      clip.clip_id === incoming.clip_id || (incoming.link_group_id && clip.link_group_id === incoming.link_group_id),
    ).map(clip => clip.clip_id));
    const newStart = incoming.timeline_start_us + shiftUs;
    const newEnd = incoming.timeline_end_us + shiftUs;
    const collision = clips.some(clip =>
      !movingIds.has(clip.clip_id) && clip.track_id === incoming.track_id &&
      clip.asset_kind !== "audio" && newStart < clip.timeline_end_us && clip.timeline_start_us < newEnd,
    );
    if (newStart < 0 || collision) return null;
    return [
      { op: "position_clip", clip_id: incoming.clip_id, timeline_start_us: nextStartUs },
      ...pairedFades(durationUs),
    ];
  }

  const nextEndUs = transition.start_us + durationUs;
  const deltaEndUs = nextEndUs - outgoing.timeline_end_us;
  const nextClipStart = clips
    .filter(clip => clip.clip_id !== outgoing.clip_id && clip.track_id === outgoing.track_id && clip.asset_kind !== "audio" && clip.timeline_start_us >= outgoing.timeline_end_us)
    .reduce((start, clip) => Math.min(start, clip.timeline_start_us), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextClipStart) && nextEndUs > nextClipStart) return null;

  let layoutOperation: TimelinePatchOperation;
  if (outgoing.asset_kind === "image") {
    layoutOperation = {
      op: "set_image_duration",
      clip_id: outgoing.clip_id,
      duration_us: nextEndUs - outgoing.timeline_start_us,
    };
  } else {
    if (outgoing.source_start_us === null || outgoing.source_end_us === null) return null;
    const speedMilli = outgoing.speed_milli ?? 1000;
    const sourceEndUs = outgoing.source_end_us + Math.round(deltaEndUs * speedMilli / 1000);
    if (sourceEndUs - outgoing.source_start_us < minDurationUs) return null;
    const sourceDurationUs = assetDurationById.get(outgoing.asset_id);
    if (sourceDurationUs !== undefined && sourceEndUs > sourceDurationUs) return null;
    if (sourceDurationUs === undefined && sourceEndUs > outgoing.source_end_us) return null;
    layoutOperation = {
      op: "set_clip_source_window",
      clip_id: outgoing.clip_id,
      source_start_us: outgoing.source_start_us,
      source_end_us: sourceEndUs,
      anchor: "start",
    };
  }
  return [layoutOperation, ...pairedFades(durationUs)];
}

export function clearActiveTransitionOperations(
  transition: ActiveTimelineTransition,
): TimelinePatchOperation[] {
  if (transition.kind === "dip-white" || transition.kind === "crossfade") return [];
  if (transition.kind === "move") {
    return [{ op: "set_clip_transition_facts", clip_id: transition.incoming_clip_id, move_in: null }];
  }
  return [
    { op: "set_clip_transition_facts", clip_id: transition.outgoing_clip_id, picture_fade_out_us: null },
    { op: "set_clip_transition_facts", clip_id: transition.incoming_clip_id, picture_fade_in_us: null },
  ];
}
