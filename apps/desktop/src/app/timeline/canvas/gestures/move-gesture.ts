import type {
  TimelineClip,
  TimelineClipId,
  TimelineDocument,
  TimelinePatchOperation,
} from "@aivideo/contracts";
import { createClipDragPlanner, linkedRiderClipIdsForDrag } from "../../clip-drag-plan.js";
import {
  SNAP_PX,
  clampGroupDelta,
  orderedMoveSnapTargets,
  resolveGroupMove,
  snapCandidates,
  snapResultSorted,
  snapTimeToFrame,
  snapValue,
  timelineDragDropExcludedClipIds,
  timelineDropHit,
  xToTime,
  type TimelineDropHit,
  type TrackRowLayout,
} from "../../geometry.js";
import type { TimelineMarker } from "../../markers.js";
import type { ClipRenderRect, MoveInteraction, TimelineSelection, TimelineViewState } from "../../types.js";
import type { PendingKeepPreview } from "../render/clips-layer.js";

export interface MoveSnapTargetCache {
  clipRects: ClipRenderRect[];
  markers: TimelineMarker[];
  withoutRiders: number[];
  withRiders: number[];
  withoutRidersOrder: ReadonlyMap<number, number>;
  withRidersOrder: ReadonlyMap<number, number>;
}

export interface ReplaceClipRequestState {
  operations: TimelinePatchOperation[];
  targetClipId: TimelineClipId;
  expected: Array<{ clipId: TimelineClipId; trackId: string; startUs: number; endUs: number }>;
}

export type ClipDragPlannerFn = ReturnType<typeof createClipDragPlanner> | null;

export function buildMoveSnapTargetCache(opts: {
  clipRects: ClipRenderRect[];
  markers: TimelineMarker[];
  moveClipIds: readonly TimelineClipId[];
  linkedRiderClipIds: readonly TimelineClipId[];
}): MoveSnapTargetCache {
  const { clipRects, markers, moveClipIds, linkedRiderClipIds } = opts;
  const makeSnapTargets = (excluded: Set<TimelineClipId>) =>
    orderedMoveSnapTargets(clipRects, markers.map((marker) => marker.timeUs), excluded);
  const withoutRiders = makeSnapTargets(new Set(moveClipIds));
  const withRiderExclusions = new Set(moveClipIds);
  for (const riderId of linkedRiderClipIds) withRiderExclusions.add(riderId);
  const withRiders = makeSnapTargets(withRiderExclusions);
  return {
    clipRects,
    markers,
    withoutRiders: withoutRiders.times,
    withRiders: withRiders.times,
    withoutRidersOrder: withoutRiders.orderByTime,
    withRidersOrder: withRiders.orderByTime,
  };
}

export function resolveMoveDragTargeting(opts: {
  active: MoveInteraction;
  clips: readonly TimelineClip[];
  trackRows: readonly TrackRowLayout[];
  clipRects: readonly ClipRenderRect[];
  linkageEnabled: boolean;
}): { targetTrackId: string | null; pointerRatio: number; dropHit: TimelineDropHit } {
  const { active, clips, trackRows, clipRects, linkageEnabled } = opts;
  const draggedClip = clips.find((c) => c.clip_id === active.clipId);
  const excluded = timelineDragDropExcludedClipIds(active.clipIds, active.linkedRiderClipIds, linkageEnabled);
  const hit = timelineDropHit(active.currentX, active.currentY, trackRows, clipRects, excluded);
  const dropHit = active.copyOnStart && hit.band === "body" ? { ...hit, clipId: null, zone: null } : hit;
  if (!draggedClip) return { targetTrackId: null, pointerRatio: 0, dropHit };
  let pointerRatio = 0;
  const row = dropHit.rowIndex >= 0 ? trackRows[dropHit.rowIndex] : null;
  const targetTrackId = dropHit.band === "body" && row ? row.track.id : null;
  if (dropHit.clipId) {
    const targetRect = clipRects.find((rect) => rect.clip.clip_id === dropHit.clipId);
    if (targetRect?.width) {
      pointerRatio = Math.max(0, Math.min(1, (active.currentX - targetRect.x) / targetRect.width));
    }
  }
  return { targetTrackId, pointerRatio, dropHit };
}

export function beginMoveGesture(opts: {
  clipId: TimelineClipId;
  clip: TimelineClip;
  x: number;
  y: number;
  altKey: boolean;
  clips: readonly TimelineClip[];
  clipRects: ClipRenderRect[];
  markers: TimelineMarker[];
  document?: TimelineDocument;
  snappingEnabled: boolean;
  selectionForDrag: TimelineSelection;
  selection: TimelineSelection;
  isClipLocked: (clipId: TimelineClipId, alone?: boolean) => boolean;
  createClipId: () => TimelineClipId;
}): {
  interaction: MoveInteraction;
  snapTargets: MoveSnapTargetCache | null;
  nextSelection: TimelineSelection | null;
  shouldSetSelection: boolean;
} {
  const {
    clipId,
    clip,
    x,
    y,
    altKey,
    clips,
    clipRects,
    markers,
    document,
    snappingEnabled,
    selectionForDrag,
    selection,
    isClipLocked,
    createClipId,
  } = opts;
  const selectedGroup = selectionForDrag?.kind === "clips" && selectionForDrag.ids.includes(clipId)
    ? selectionForDrag.ids
    : selectionForDrag?.kind === "clip" && selectionForDrag.id === clipId
      ? [selectionForDrag.id]
      : [clipId];
  const capturedClipIds = [
    ...new Set(
      selectedGroup.flatMap((id) => {
        const member = clips.find((item) => item.clip_id === id);
        return member?.link_group_id
          ? clips.filter((item) => item.link_group_id === member.link_group_id).map((item) => item.clip_id)
          : [id];
      }),
    ),
  ].filter((id) => clips.some((item) => item.clip_id === id) && !isClipLocked(id as TimelineClipId, true));
  const capturedMembers = capturedClipIds.map((id) => clips.find((item) => item.clip_id === id)!).filter(Boolean);
  const copyIds = altKey ? capturedClipIds.map(() => createClipId()) : [];
  const moveClipIds = capturedMembers.map((member) => member.clip_id);
  const linkedRiderClipIds = document ? linkedRiderClipIdsForDrag(document, moveClipIds, altKey) : [];

  const snapTargets = snappingEnabled
    ? buildMoveSnapTargetCache({ clipRects, markers, moveClipIds, linkedRiderClipIds })
    : null;

  let shouldSetSelection = false;
  let nextSelection: TimelineSelection | null = null;
  if (!altKey) {
    shouldSetSelection = true;
    nextSelection = capturedClipIds.length > 1 ? { kind: "clips", ids: capturedClipIds } : { kind: "clip", id: capturedClipIds[0] ?? clipId };
  } else if (!(selection?.kind === "clips" && selection.ids.includes(clipId))) {
    shouldSetSelection = true;
    nextSelection = capturedClipIds.length > 1 ? { kind: "clips", ids: capturedClipIds } : { kind: "clip", id: clipId };
  }

  return {
    interaction: {
      kind: "move",
      clipId,
      ignoreLink: false,
      startX: x,
      startY: y,
      currentX: x,
      currentY: y,
      startUs: clip.timeline_start_us,
      previewStartUs: clip.timeline_start_us,
      targetStartUs: clip.timeline_start_us,
      targetTrackId: null,
      resolution: null,
      snapUs: null,
      copyOnStart: altKey,
      moveMode: "place",
      clipIds: moveClipIds,
      linkedRiderClipIds,
      copyIds,
      dragPlan: null,
      dropHit: null,
    },
    snapTargets,
    nextSelection,
    shouldSetSelection,
  };
}

export function stepMoveGesture(opts: {
  active: MoveInteraction;
  x: number;
  y: number;
  altKey: boolean;
  view: TimelineViewState;
  clips: readonly TimelineClip[];
  trackRows: readonly TrackRowLayout[];
  clipRects: ClipRenderRect[];
  markers: TimelineMarker[];
  playheadUs: number;
  fpsNum: number;
  fpsDen: number;
  snappingEnabled: boolean;
  mainTrackMagnet: boolean;
  linkageEnabled: boolean;
  snapTargetsCache: MoveSnapTargetCache | null;
  clipDragPlanner: ClipDragPlannerFn;
}): { interaction: MoveInteraction; snapTargetsCache: MoveSnapTargetCache } {
  const {
    active,
    x,
    y,
    altKey,
    view,
    clips,
    trackRows,
    clipRects,
    markers,
    playheadUs,
    fpsNum,
    fpsDen,
    snappingEnabled,
    mainTrackMagnet,
    linkageEnabled,
    clipDragPlanner,
  } = opts;
  const pps = view.pixelsPerSecond;
  const deltaUs = ((x - active.startX) / pps) * 1_000_000;
  const movingClip = clips.find((c) => c.clip_id === active.clipId);
  const captured = active.clipIds.map((id) => clips.find((clip) => clip.clip_id === id)).filter((clip): clip is TimelineClip => Boolean(clip));
  const linkedStarts = captured.length ? captured.map((clip) => clip.timeline_start_us) : [active.startUs];
  const minStartUs = Math.max(0, active.startUs - Math.min(...linkedStarts));
  const rawStartUs = Math.max(minStartUs, active.startUs + deltaUs);
  const clipDurationUs = movingClip ? movingClip.timeline_end_us - movingClip.timeline_start_us : 0;
  const threshold = (SNAP_PX / pps) * 1_000_000;
  const moveMode = active.copyOnStart ? "place" : altKey ? "insert" : "place";
  const frameAlignedStartUs = Math.max(minStartUs, snapTimeToFrame(rawStartUs, fpsNum, fpsDen));
  const rawStep: MoveInteraction = { ...active, currentX: x, currentY: y, targetStartUs: frameAlignedStartUs, moveMode };
  const { targetTrackId, dropHit } = resolveMoveDragTargeting({ active: rawStep, clips, trackRows, clipRects, linkageEnabled });

  let snapTargets = opts.snapTargetsCache;
  if (!snapTargets || snapTargets.clipRects !== clipRects || snapTargets.markers !== markers) {
    snapTargets = buildMoveSnapTargetCache({ clipRects, markers, moveClipIds: active.clipIds, linkedRiderClipIds: active.linkedRiderClipIds });
  }
  const selectedSnapTargets = snappingEnabled
    ? linkageEnabled
      ? { values: snapTargets.withRiders, order: snapTargets.withRidersOrder }
      : { values: snapTargets.withoutRiders, order: snapTargets.withoutRidersOrder }
    : { values: [] as number[], order: undefined };
  const candidates = selectedSnapTargets.values;
  const startSnap = snappingEnabled
    ? snapResultSorted(rawStartUs, candidates, threshold, playheadUs, selectedSnapTargets.order)
    : { valueUs: rawStartUs, snappedTo: null };
  const endSnap = snappingEnabled
    ? snapResultSorted(rawStartUs + clipDurationUs, candidates, threshold, playheadUs, selectedSnapTargets.order)
    : { valueUs: rawStartUs + clipDurationUs, snappedTo: null };
  const startDelta = startSnap.valueUs - rawStartUs;
  const endDelta = endSnap.valueUs - (rawStartUs + clipDurationUs);
  const useEnd = endSnap.snappedTo !== null && (startSnap.snappedTo === null || Math.abs(endDelta) < Math.abs(startDelta));
  const snappedTo = useEnd ? endSnap.snappedTo : startSnap.snappedTo;
  const landedStartUs = snappedTo === null
    ? snapTimeToFrame(rawStartUs + (useEnd ? endDelta : startDelta), fpsNum, fpsDen)
    : Math.round(rawStartUs + (useEnd ? endDelta : startDelta));
  const targetStartUs = Math.max(minStartUs, landedStartUs);
  const dragPlan = clipDragPlanner?.({
    clipIds: active.clipIds,
    leadClipId: active.clipId,
    leadStartUs: targetStartUs,
    pointerTimeUs: xToTime(x, view),
    dropHit,
    targetTrackId,
    mode: moveMode,
    copyOnStart: active.copyOnStart,
    copyIds: active.copyIds,
    mainTrackMagnet,
    linkageEnabled,
    snappingEnabled,
    flushToleranceUs: threshold,
  }) ?? null;
  const landed = dragPlan?.lead;
  const resolution = landed
    ? {
        startUs: landed.startUs,
        trackId: landed.trackId,
        mode: dropHit?.zone === "before" ? ("before" as const) : dropHit?.zone === "after" ? ("after" as const) : ("free" as const),
      }
    : null;
  return {
    interaction: {
      ...rawStep,
      previewStartUs: rawStartUs,
      targetStartUs: landed?.startUs ?? targetStartUs,
      targetTrackId: landed?.trackId ?? targetTrackId,
      dropHit,
      resolution,
      dragPlan,
      snapUs: landed?.startUs === targetStartUs && targetStartUs === rawStartUs + (useEnd ? endDelta : startDelta)
        ? (useEnd ? endSnap.snappedTo : startSnap.snappedTo)
        : null,
    },
    snapTargetsCache: snapTargets,
  };
}

export function stepGroupMoveGesture<T extends {
  kind: "group-move";
  clipIds: TimelineClipId[];
  startX: number;
  startY: number;
  startUsByClip: Record<string, number>;
  targetStartUsByClip: Record<string, number>;
  snapUs: number | null;
}>(opts: {
  active: T;
  x: number;
  pixelsPerSecond: number;
  snappingEnabled: boolean;
  clips: readonly TimelineClip[];
  clipRects: ClipRenderRect[];
  playheadUs: number;
  markers: readonly TimelineMarker[];
}): T {
  const { active, x, pixelsPerSecond, snappingEnabled, clips, clipRects, playheadUs, markers } = opts;
  const deltaUs = ((x - active.startX) / pixelsPerSecond) * 1_000_000;
  const starts = active.clipIds.map((id) => active.startUsByClip[id] ?? 0);
  const anchorStart = Math.min(...starts);
  const rawAnchor = Math.max(0, anchorStart + deltaUs);
  const threshold = (SNAP_PX / pixelsPerSecond) * 1_000_000;
  const excluded = new Set(active.clipIds);
  const candidates = snappingEnabled
    ? [...snapCandidates(clipRects, playheadUs, excluded), ...markers.map((marker) => marker.timeUs)]
    : [];
  const snappedAnchor = snapValue(rawAnchor, candidates, threshold);
  const rawDelta = snappedAnchor - anchorStart;
  const members = active.clipIds
    .map((id) => clips.find((c) => c.clip_id === id))
    .filter((c): c is TimelineClip => Boolean(c));
  const groupTrackId = members[0]?.track_id ?? null;
  const finalDelta = members.length > 0 && members[0].asset_kind !== "audio"
    ? clampGroupDelta(
        members,
        clips.filter((c) => c.track_id === groupTrackId && !excluded.has(c.clip_id)),
        rawDelta,
      )
    : resolveGroupMove(starts, rawDelta).actualDeltaUs;
  const targetStartUsByClip: Record<string, number> = {};
  for (const id of active.clipIds) {
    targetStartUsByClip[id] = Math.max(0, (active.startUsByClip[id] ?? 0) + finalDelta);
  }
  return {
    ...active,
    targetStartUsByClip,
    snapUs: Math.abs(snappedAnchor - rawAnchor) > 1 ? snappedAnchor : null,
  };
}

export function stepAutoScrollMoveInteraction(opts: {
  active: MoveInteraction;
  deltaUs: number;
  pointerX: number | undefined;
  nextView: TimelineViewState;
  clips: readonly TimelineClip[];
  trackRows: readonly TrackRowLayout[];
  clipRects: readonly ClipRenderRect[];
  mainTrackMagnet: boolean;
  linkageEnabled: boolean;
  snappingEnabled: boolean;
  clipDragPlanner: ClipDragPlannerFn;
}): MoveInteraction {
  const { active, deltaUs, pointerX, nextView, clips, trackRows, clipRects, mainTrackMagnet, linkageEnabled, snappingEnabled, clipDragPlanner } = opts;
  const shifted: MoveInteraction = {
    ...active,
    previewStartUs: active.previewStartUs + deltaUs,
    targetStartUs: Math.max(0, active.targetStartUs + deltaUs),
    startUs: active.startUs + deltaUs,
  };
  const draggedClip = clips.find((c) => c.clip_id === active.clipId);
  if (!draggedClip) return shifted;
  const { targetTrackId, dropHit } = resolveMoveDragTargeting({ active: shifted, clips, trackRows, clipRects, linkageEnabled });
  const dragPlan = clipDragPlanner?.({
    clipIds: active.clipIds,
    leadClipId: active.clipId,
    leadStartUs: shifted.targetStartUs,
    pointerTimeUs: pointerX !== undefined ? xToTime(pointerX, nextView) : shifted.targetStartUs,
    dropHit,
    targetTrackId,
    mode: active.moveMode,
    copyOnStart: active.copyOnStart,
    copyIds: active.copyIds,
    mainTrackMagnet,
    linkageEnabled,
    snappingEnabled,
    flushToleranceUs: (SNAP_PX / nextView.pixelsPerSecond) * 1_000_000,
  }) ?? null;
  const landed = dragPlan?.lead;
  return {
    ...shifted,
    targetStartUs: landed?.startUs ?? shifted.targetStartUs,
    targetTrackId: landed?.trackId ?? targetTrackId,
    dropHit,
    dragPlan,
    resolution: landed ? { startUs: landed.startUs, trackId: landed.trackId, mode: "free" } : null,
  };
}

export function commitMoveGesture(opts: {
  active: MoveInteraction;
  clips: readonly TimelineClip[];
  document?: TimelineDocument;
  setToolbarFeedback: (feedback: string) => void;
  setSelection: (selection: TimelineSelection) => void;
  setReplaceClipRequest: (request: ReplaceClipRequestState) => void;
  setPendingKeep: (keep: PendingKeepPreview) => void;
  onPatch: (operations: TimelinePatchOperation[], summary: string) => Promise<void> | void;
}): void {
  const { active, clips, document, setToolbarFeedback, setSelection, setReplaceClipRequest, setPendingKeep, onPatch } = opts;
  const clip = clips.find((c) => c.clip_id === active.clipId);
  const plan = active.dragPlan;
  if (!clip || !plan) return;
  if (plan.reason) setToolbarFeedback(plan.reason);
  else setToolbarFeedback("");
  if (!plan.operations.length) return;
  if (active.copyOnStart) {
    const copies = plan.operations.find((operation) => operation.op === "duplicate_timeline_items");
    if (copies?.op === "duplicate_timeline_items") {
      const ids = copies.copies.map((copy) => copy.copy_id as TimelineClipId);
      setSelection(ids.length > 1 ? { kind: "clips", ids } : { kind: "clip", id: ids[0]! });
    }
  }
  const isReplace = plan.operations.some((operation) => operation.op === "remove_clip");
  const isInsert = active.moveMode === "insert" || active.dropHit?.zone === "before" || active.dropHit?.zone === "after";
  const summary = active.copyOnStart ? "复制片段" : isReplace ? "替换片段" : isInsert ? "插入移动片段" : "移动片段";
  if (isReplace) {
    const remove = plan.operations.find((operation) => operation.op === "remove_clip");
    if (remove?.op === "remove_clip") {
      const affectedIds = new Set<TimelineClipId>([...active.clipIds, remove.clip_id]);
      for (const operation of plan.operations) {
        if (operation.op === "position_clips") {
          for (const placement of operation.placements) affectedIds.add(placement.clip_id);
        }
      }
      const expected = (document?.clips ?? [])
        .filter((item) => affectedIds.has(item.clip_id))
        .map((item) => ({
          clipId: item.clip_id,
          trackId: item.track_id,
          startUs: item.timeline_start_us,
          endUs: item.timeline_end_us,
        }));
      setReplaceClipRequest({ operations: plan.operations, targetClipId: remove.clip_id, expected });
    }
    return;
  }
  if (plan.lead) {
    const placements = new Map<TimelineClipId, { clipId: TimelineClipId; trackId: string; startUs: number }>();
    for (const item of plan.placements) {
      placements.set(item.clipId as TimelineClipId, {
        clipId: item.clipId as TimelineClipId,
        trackId: item.trackId,
        startUs: Math.round(item.startUs),
      });
    }
    placements.set(plan.lead.clipId as TimelineClipId, {
      clipId: plan.lead.clipId as TimelineClipId,
      trackId: plan.lead.trackId,
      startUs: Math.round(plan.lead.startUs),
    });
    const copiesById = new Map<TimelineClipId, TimelineClipId>();
    for (const operation of plan.operations) {
      if (operation.op === "duplicate_timeline_items") {
        for (const copy of operation.copies) {
          if (copy.item_kind === "clip") copiesById.set(copy.copy_id as TimelineClipId, copy.source_id as TimelineClipId);
        }
      }
    }
    const copies = plan.placements.flatMap((item) => {
      const sourceClipId = copiesById.get(item.clipId as TimelineClipId);
      return sourceClipId
        ? [{ clipId: item.clipId as TimelineClipId, sourceClipId, trackId: item.trackId, startUs: Math.round(item.startUs) }]
        : [];
    });
    setPendingKeep({ placements: [...placements.values()], copies });
  }
  void onPatch(plan.operations, summary);
}
