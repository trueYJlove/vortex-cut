import type { TimelineClip, TimelineDocument, TimelinePatchOperation, TimelineTrack } from "@aivideo/contracts";
import type { TimelineDropHit } from "./geometry.js";
import { planCompactMainTrack, planMagneticDrop } from "./magnetic-plan.js";

export type TimelineMoveMode = "place" | "insert";

export interface ClipDragPlanInput {
  document: TimelineDocument;
  /** Frozen source group captured at pointerdown. The lead is the grabbed clip. */
  clipIds: readonly string[];
  leadClipId: string;
  /** Desired lead start and the project time under the pointer. */
  leadStartUs: number;
  pointerTimeUs: number;
  /** Actual row/clip hit beneath the pointer. */
  dropHit: TimelineDropHit | null;
  targetTrackId: string | null;
  mode: TimelineMoveMode;
  /** Alt was held at pointerdown. This never changes during the gesture. */
  copyOnStart: boolean;
  /** Preallocated copy ids, in the same order as clipIds. */
  copyIds?: readonly string[];
  mainTrackMagnet: boolean;
  linkageEnabled: boolean;
  /** OpenFilm's near-edge correction is only active while snapping is enabled. */
  snappingEnabled?: boolean;
  flushToleranceUs?: number;
}

export interface ClipDragPlan {
  operations: TimelinePatchOperation[];
  /** Final position of the lead clip or copy. */
  lead: { clipId: string; trackId: string; startUs: number } | null;
  /** Every resulting position, including clips pushed by Insert/Replace. */
  placements: Array<{ clipId: string; trackId: string; startUs: number }>;
  reason?: string;
}

interface ClipDragIndexes {
  clipsById: Map<string, TimelineClip>;
  clipsByTrack: Map<string, TimelineClip[]>;
  prefixMaxEndByTrack: Map<string, number[]>;
  tracksById: Map<string, TimelineTrack>;
  trackIndexById: Map<string, number>;
  nonMainClips: TimelineClip[];
  ridersByMainClipTrack: Map<string, Map<string, TimelineClip[]>>;
  riderOwnerByClipId: Map<string, string>;
  mainCuts: number[];
  clipsByLinkGroup: Map<string, TimelineClip[]>;
  lockedIds: Set<string>;
}

const noPlan = (reason: string): ClipDragPlan => ({ operations: [], placements: [], lead: null, reason });
const operationLimitExceeded = (operations: readonly TimelinePatchOperation[]) => operations.length > 100;

function kindForClip(clip: TimelineClip): "video" | "audio" {
  return clip.asset_kind === "audio" ? "audio" : "video";
}

function compatible(track: TimelineTrack | undefined, clip: TimelineClip): boolean {
  return track?.kind === kindForClip(clip);
}

function isLocked(lockedIds: ReadonlySet<string>, tracksById: ReadonlyMap<string, TimelineTrack>, clip: TimelineClip): boolean {
  return Boolean(lockedIds.has(clip.clip_id) || tracksById.get(clip.track_id)?.locked);
}

function intervalsOverlap(sorted: readonly { start: number; end: number }[], start: number, end: number): boolean {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle]!.start < start) low = middle + 1;
    else high = middle;
  }
  return (low > 0 && sorted[low - 1]!.end > start) || (low < sorted.length && sorted[low]!.start < end);
}

function firstPossibleOverlap(lane: readonly TimelineClip[], prefixMaxEnd: readonly number[], startUs: number): number {
  let low = 0;
  let high = prefixMaxEnd.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (prefixMaxEnd[middle]! <= startUs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function laneHasOverlap(
  lane: readonly TimelineClip[],
  prefixMaxEnd: readonly number[],
  skip: ReadonlySet<string>,
  startUs: number,
  endUs: number,
): boolean {
  for (let index = firstPossibleOverlap(lane, prefixMaxEnd, startUs); index < lane.length; index += 1) {
    const clip = lane[index]!;
    if (clip.timeline_start_us >= endUs) break;
    if (!skip.has(clip.clip_id) && clip.timeline_end_us > startUs) return true;
  }
  return false;
}

/** Align a small accidental overlap to a neighboring edge without scanning an entire large track. */
function flushNearEdge(
  lane: readonly TimelineClip[],
  prefixMaxEnd: readonly number[],
  skip: ReadonlySet<string>,
  startUs: number,
  durationUs: number,
  toleranceUs: number,
): number | null {
  if (!(toleranceUs > 0) || durationUs <= 0) return null;
  const endUs = startUs + durationUs;
  const busy: Array<{ start: number; end: number }> = [];
  for (let index = firstPossibleOverlap(lane, prefixMaxEnd, startUs); index < lane.length; index += 1) {
    const clip = lane[index]!;
    if (clip.timeline_start_us >= endUs) break;
    if (skip.has(clip.clip_id) || clip.timeline_end_us <= startUs) continue;
    const previous = busy.at(-1);
    if (previous && clip.timeline_start_us <= previous.end) previous.end = Math.max(previous.end, clip.timeline_end_us);
    else busy.push({ start: clip.timeline_start_us, end: clip.timeline_end_us });
  }
  const candidates = busy.flatMap(range => [
    { startUs: range.end - durationUs, edgeUs: range.end, deltaUs: range.end - startUs },
    { startUs: range.start - durationUs, edgeUs: range.start, deltaUs: range.start - durationUs - startUs },
  ]).sort((a, b) => Math.abs(a.deltaUs) - Math.abs(b.deltaUs));
  for (const candidate of candidates) {
    if (!candidate.deltaUs || Math.abs(candidate.deltaUs) > toleranceUs || candidate.startUs < 0) continue;
    if (!laneHasOverlap(lane, prefixMaxEnd, skip, candidate.startUs, candidate.startUs + durationUs)) return candidate.startUs;
  }
  return null;
}

function mainTrackOwner(
  main: readonly TimelineClip[], cuts: readonly number[], startUs: number, endUs: number,
): TimelineClip | undefined {
  if (main.length === 1) {
    const owner = main[0]!;
    return startUs >= owner.timeline_start_us && startUs < owner.timeline_end_us && endUs > startUs
      ? owner
      : undefined;
  }
  let low = 0;
  let high = main.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (main[middle]!.timeline_start_us <= startUs) low = middle + 1;
    else high = middle;
  }
  const owner = main[low - 1];
  if (!owner || startUs >= owner.timeline_end_us) return undefined;
  let firstGreater = 0;
  let lastLess = cuts.length;
  while (firstGreater < lastLess) {
    const middle = (firstGreater + lastLess) >>> 1;
    if (cuts[middle]! <= startUs) firstGreater = middle + 1;
    else lastLess = middle;
  }
  let firstAtEnd = firstGreater;
  let endHigh = cuts.length;
  while (firstAtEnd < endHigh) {
    const middle = (firstAtEnd + endHigh) >>> 1;
    if (cuts[middle]! < endUs) firstAtEnd = middle + 1;
    else endHigh = middle;
  }
  return firstAtEnd - firstGreater <= 1 ? owner : undefined;
}

/**
 * OpenFilm excludes the writable clips riding on a moved main-track clip from that gesture's snap targets.
 * Keep this based on the pointerdown snapshot; ripple/insert placements are not snap exclusions.
 */
export function linkedRiderClipIdsForDrag(
  document: TimelineDocument,
  movingClipIds: readonly string[],
  copyOnStart: boolean,
): TimelineClip["clip_id"][] {
  if (copyOnStart || !movingClipIds.length) return [];
  const mainTrack = document.tracks.find(track => track.id === "V1");
  if (!mainTrack || mainTrack.locked) return [];
  const moving = new Set(movingClipIds);
  const main = document.clips.filter(clip => clip.track_id === mainTrack.id)
    .sort((a, b) => a.timeline_start_us - b.timeline_start_us);
  const movingMain = new Set(main.filter(clip => moving.has(clip.clip_id)).map(clip => clip.clip_id));
  if (!movingMain.size) return [];
  const cuts = [...new Set(main.flatMap(clip => [clip.timeline_start_us, clip.timeline_end_us]))].sort((a, b) => a - b);
  const lockedIds = new Set(document.locked_elements ?? []);
  const lockedTracks = new Set(document.tracks.filter(track => track.locked).map(track => track.id));
  return document.clips.flatMap(clip => {
    if (clip.track_id === mainTrack.id || moving.has(clip.clip_id) || lockedIds.has(clip.clip_id) || lockedTracks.has(clip.track_id)) return [];
    const owner = mainTrackOwner(main, cuts, clip.timeline_start_us, clip.timeline_end_us);
    return owner && movingMain.has(owner.clip_id) ? [clip.clip_id] : [];
  });
}

function addLinkedRiderCarry(
  document: TimelineDocument,
  operations: TimelinePatchOperation[],
  linkageEnabled: boolean,
  indexes: ClipDragIndexes,
  excludedRiderIds?: ReadonlySet<string>,
): { operations: TimelinePatchOperation[]; placements: Array<{ clipId: string; trackId: string; startUs: number }> } {
  const planned = new Map<string, { trackId: string; startUs: number }>();
  for (const operation of operations) {
    if (operation.op === "position_clip") {
      const clip = indexes.clipsById.get(operation.clip_id);
      planned.set(operation.clip_id, {
        trackId: operation.track_id ?? clip?.track_id ?? "V1",
        startUs: operation.timeline_start_us,
      });
    } else if (operation.op === "position_clips") {
      for (const placement of operation.placements) {
        const clip = indexes.clipsById.get(placement.clip_id);
        planned.set(placement.clip_id, {
          trackId: placement.track_id ?? clip?.track_id ?? "V1",
          startUs: placement.timeline_start_us,
        });
      }
    }
  }
  const planPlacements = [...planned].map(([clipId, position]) => ({ clipId, ...position }));
  if (!linkageEnabled || !planned.size) return { operations, placements: planPlacements };

  const mainMoves = new Map<string, number>();
  for (const [clipId, position] of planned) {
    const clip = indexes.clipsById.get(clipId);
    if (clip?.track_id === "V1" && position.startUs !== clip.timeline_start_us) {
      mainMoves.set(clipId, position.startUs - clip.timeline_start_us);
    }
  }
  const main = indexes.clipsByTrack.get("V1") ?? [];
  const cuts = indexes.mainCuts;
  const appendCaptionMoves = (baseOperations: TimelinePatchOperation[]) => {
    if (indexes.tracksById.get("C1")?.locked) return baseOperations;
    const captionOpsAlreadyPlanned = new Set(baseOperations.flatMap(operation => operation.op === "set_caption_timing" ? [operation.caption_id] : []));
    const captionOps = document.captions.flatMap(caption => {
      if (caption.source_clip_id || captionOpsAlreadyPlanned.has(caption.caption_id)) return [];
      const owner = mainTrackOwner(main, cuts, caption.start_us, caption.end_us);
      const delta = owner ? mainMoves.get(owner.clip_id) ?? 0 : 0;
      if (!delta) return [];
      return [{ op: "set_caption_timing" as const, caption_id: caption.caption_id, start_us: Math.max(0, caption.start_us + delta), end_us: Math.max(0, caption.end_us + delta) }];
    });
    return captionOps.length ? [...baseOperations, ...captionOps] : baseOperations;
  };

  // A common large-timeline case is one main clip carrying many same-lane clips as it is
  // placed onto that lane. The owner/lane index was built with the document snapshot, so
  // this path only reads the affected lane and returns before allocating per-rider maps.
  if (main.length === 1 && planned.size === 1) {
    const owner = main[0]!;
    const delta = mainMoves.get(owner.clip_id);
    const mainPosition = planned.get(owner.clip_id);
    if (delta && mainPosition && mainPosition.trackId !== "V1") {
      const ownerLanes = indexes.ridersByMainClipTrack.get(owner.clip_id);
      const sourceTrackId = mainPosition.trackId;
      const ownerLane = ownerLanes?.get(sourceTrackId);
      const hasOtherRiderTracks = [...(ownerLanes?.keys() ?? [])].some(trackId => trackId !== sourceTrackId);
      // With one planned item and this main clip as its only V1 member, the planned map
      // cannot contain a non-main rider. Index entries already exclude locked clips/tracks.
      if (ownerLane?.length && !hasOtherRiderTracks) {
        const sourceTrack = indexes.tracksById.get(sourceTrackId);
        if (sourceTrack && sourceTrack.kind !== "text") {
          const movingGroup = ownerLane;
          let nonOverlapping = true;
          let previousEnd = Number.NEGATIVE_INFINITY;
          const incomingClip = indexes.clipsById.get(owner.clip_id)!;
          const incomingStartUs = mainPosition.startUs;
          const incomingEndUs = incomingStartUs + incomingClip.timeline_end_us - incomingClip.timeline_start_us;
          let everyMovedClipCollides = movingGroup.length > 0;
          for (const clip of movingGroup) {
            const startUs = Math.max(0, clip.timeline_start_us + delta);
            const endUs = startUs + clip.timeline_end_us - clip.timeline_start_us;
            if (startUs < previousEnd) nonOverlapping = false;
            previousEnd = Math.max(previousEnd, endUs);
            // This fast path only claims the case where the incoming main clip itself
            // overlaps every rider. Other partial collisions use the general settle path.
            if (!(startUs < incomingEndUs && endUs > incomingStartUs)) {
              everyMovedClipCollides = false;
              break;
            }
          }
          if (nonOverlapping && everyMovedClipCollides) {
            const kind = sourceTrack.kind === "audio" ? "audio" : "video";
            const sourceIndex = indexes.trackIndexById.get(sourceTrackId) ?? 0;
            const candidates = [...indexes.tracksById.values()]
              .filter(track => track.id !== sourceTrackId && track.id !== "V1" && track.kind === kind && !track.locked)
              .sort((left, right) => {
                const leftIndex = indexes.trackIndexById.get(left.id) ?? 0;
                const rightIndex = indexes.trackIndexById.get(right.id) ?? 0;
                const distance = Math.abs(leftIndex - sourceIndex) - Math.abs(rightIndex - sourceIndex);
                return distance || (kind === "audio" ? rightIndex - leftIndex : leftIndex - rightIndex);
              });
            const fits = (lane: readonly TimelineClip[]) => {
              let movingIndex = 0;
              for (const occupied of lane) {
                while (movingIndex < movingGroup.length) {
                  const moving = movingGroup[movingIndex]!;
                  const startUs = Math.max(0, moving.timeline_start_us + delta);
                  const endUs = startUs + moving.timeline_end_us - moving.timeline_start_us;
                  if (endUs <= occupied.timeline_start_us) movingIndex += 1;
                  else {
                    if (occupied.timeline_end_us <= startUs) break;
                    return false;
                  }
                }
              }
              return true;
            };
            const destination = candidates.find(track => fits(indexes.clipsByTrack.get(track.id) ?? []));
            const destinationTrackId = destination?.id ?? newTrackId(document, kind, new Set());
            const riderPlacements: Array<{ clip_id: TimelineClip["clip_id"]; timeline_start_us: number; track_id: string }> = [];
            for (const clip of movingGroup) {
              const startUs = Math.max(0, clip.timeline_start_us + delta);
              if (startUs === clip.timeline_start_us && destinationTrackId === clip.track_id) continue;
              riderPlacements.push({ clip_id: clip.clip_id, timeline_start_us: startUs, track_id: destinationTrackId });
              planPlacements.push({ clipId: clip.clip_id, trackId: destinationTrackId, startUs });
            }
            const addTrack = destination ? [] : [addTrackOperation(document, kind, sourceTrackId, destinationTrackId)];
            const carriedOperations = [...addTrack, ...operations,
              ...(riderPlacements.length ? [{ op: "position_clips" as const, placements: riderPlacements, ignore_link: true }] : [])];
            return { operations: appendCaptionMoves(carriedOperations), placements: planPlacements };
          }
        }
      }
    }
  }

  const riderDeltas = new Map<string, number>();
  for (const [ownerId, delta] of mainMoves) {
    if (!delta) continue;
    for (const riders of indexes.ridersByMainClipTrack.get(ownerId)?.values() ?? []) {
      for (const clip of riders) {
        if (!planned.has(clip.clip_id) && !excludedRiderIds?.has(clip.clip_id)) {
          riderDeltas.set(clip.clip_id, delta);
        }
      }
    }
  }
  // Insert/Replace can ripple a rider on its own lane even though its main-track
  // host did not move. OpenFilm snapshots the rider-to-host relationship before
  // the edit, then carries the rider back to the same footage moment afterward.
  // Restore any planned rider to that host-relative position; if the host moved,
  // follow its new position. The carry settlement below moves a restored rider to
  // the nearest free compatible lane when the edit left it overlapping another clip.
  const removedHostIds = new Set<string>(operations.flatMap(operation => operation.op === "remove_clip" ? [operation.clip_id] : []));
  for (const [clipId, position] of planned) {
    if (excludedRiderIds?.has(clipId)) continue;
    const ownerId = indexes.riderOwnerByClipId.get(clipId);
    const rider = indexes.clipsById.get(clipId);
    const owner = ownerId ? indexes.clipsById.get(ownerId) : undefined;
    if (!ownerId || !rider || !owner || removedHostIds.has(ownerId)) continue;
    const ownerPosition = planned.get(ownerId);
    const expectedStartUs = Math.max(0, rider.timeline_start_us + (ownerPosition?.startUs ?? owner.timeline_start_us) - owner.timeline_start_us);
    if (position.startUs !== expectedStartUs) riderDeltas.set(clipId, expectedStartUs - rider.timeline_start_us);
  }
  if (!mainMoves.size && !riderDeltas.size) {
    return { operations: appendCaptionMoves(operations), placements: planPlacements };
  }
  if (!riderDeltas.size) {
    return { operations: appendCaptionMoves(operations), placements: planPlacements };
  }

  // Most linked moves are collision-free translations: every rider on a lane
  // shifts by the same delta, preserving order and spacing. Validate those
  // lanes directly against the indexed clips and skip the much heavier
  // mutable collision planner (which builds a CarryState for every clip).
  // Any changed non-main placement, removal, new lane, mixed lane delta, or
  // resulting overlap falls back to the full relocation planner below.
  const onlyMainTrackPositions = [...planned].every(([clipId, position]) =>
    indexes.clipsById.get(clipId)?.track_id === "V1" && position.trackId === "V1");
  const hasStructuralClipEdit = operations.some(operation => operation.op === "add_track" || operation.op === "remove_clip");
  if (!hasStructuralClipEdit && planned.size === 1 && riderDeltas.size) {
    const [[mainClipId, mainPosition]] = planned;
    const mainClip = indexes.clipsById.get(mainClipId);
    const riderTracks = new Set([...riderDeltas.keys()].map(clipId => indexes.clipsById.get(clipId)!.track_id));
    if (mainClip?.track_id === "V1" && mainPosition.trackId !== "V1" && riderTracks.size === 1) {
      const sourceTrackId = [...riderTracks][0]!;
      const sourceTrack = indexes.tracksById.get(sourceTrackId);
      const sourceLane = indexes.clipsByTrack.get(sourceTrackId) ?? [];
      const movingGroup = sourceLane.filter(clip => riderDeltas.has(clip.clip_id));
      const delta = movingGroup.length ? riderDeltas.get(movingGroup[0]!.clip_id) : undefined;
      const oneUniformGroup = delta !== undefined && movingGroup.length === riderDeltas.size &&
        movingGroup.every(clip => riderDeltas.get(clip.clip_id) === delta);
      if (sourceTrack && sourceTrack.kind !== "text" && oneUniformGroup && mainPosition.trackId === sourceTrackId) {
        let nonOverlapping = true;
        let previousEnd = Number.NEGATIVE_INFINITY;
        for (const clip of movingGroup) {
          const startUs = Math.max(0, clip.timeline_start_us + delta);
          const endUs = startUs + clip.timeline_end_us - clip.timeline_start_us;
          if (startUs < previousEnd) nonOverlapping = false;
          previousEnd = Math.max(previousEnd, endUs);
        }
        const stationary = sourceLane.filter(clip => !riderDeltas.has(clip.clip_id) && !planned.has(clip.clip_id));
        const incoming = [...planned].flatMap(([clipId, position]) => {
          if (position.trackId !== sourceTrackId) return [];
          const clip = indexes.clipsById.get(clipId);
          return clip ? [{ clip, startUs: position.startUs }] : [];
        });
        let stationaryIndex = 0;
        let everyMovedClipCollides = stationary.length + incoming.length > 0;
        for (const clip of movingGroup) {
          const startUs = Math.max(0, clip.timeline_start_us + delta);
          const endUs = startUs + clip.timeline_end_us - clip.timeline_start_us;
          while (stationaryIndex < stationary.length && stationary[stationaryIndex]!.timeline_end_us <= startUs) stationaryIndex += 1;
          const occupied = stationary[stationaryIndex];
          const collidesWithLane = Boolean(occupied && occupied.timeline_start_us < endUs);
          const collidesWithIncoming = incoming.some(item => item.startUs < endUs && item.startUs + item.clip.timeline_end_us - item.clip.timeline_start_us > startUs);
          if (!collidesWithLane && !collidesWithIncoming) {
            everyMovedClipCollides = false;
            break;
          }
        }
        if (nonOverlapping && everyMovedClipCollides) {
          const kind = sourceTrack.kind === "audio" ? "audio" : "video";
          const sourceIndex = document.tracks.findIndex(track => track.id === sourceTrackId);
          const candidates = document.tracks
            .filter(track => track.id !== sourceTrackId && track.id !== "V1" && track.kind === kind && !track.locked)
            .sort((left, right) => {
              const leftIndex = document.tracks.findIndex(track => track.id === left.id);
              const rightIndex = document.tracks.findIndex(track => track.id === right.id);
              const distance = Math.abs(leftIndex - sourceIndex) - Math.abs(rightIndex - sourceIndex);
              return distance || (kind === "audio" ? rightIndex - leftIndex : leftIndex - rightIndex);
            });
          const fits = (lane: readonly TimelineClip[]) => {
            let movingIndex = 0;
            for (const occupied of lane) {
              while (movingIndex < movingGroup.length) {
                const moving = movingGroup[movingIndex]!;
                const startUs = Math.max(0, moving.timeline_start_us + delta);
                const endUs = startUs + moving.timeline_end_us - moving.timeline_start_us;
                if (endUs <= occupied.timeline_start_us) movingIndex += 1;
                else {
                  if (occupied.timeline_end_us <= startUs) break;
                  return false;
                }
              }
            }
            return true;
          };
          const destination = candidates.find(track => fits(indexes.clipsByTrack.get(track.id) ?? []));
          const destinationTrackId = destination?.id ?? newTrackId(document, kind, new Set());
          const riderPlacements: Array<{ clip_id: TimelineClip["clip_id"]; timeline_start_us: number; track_id: string }> = [];
          for (const clip of movingGroup) {
            const startUs = Math.max(0, clip.timeline_start_us + delta);
            if (startUs === clip.timeline_start_us && destinationTrackId === clip.track_id) continue;
            riderPlacements.push({ clip_id: clip.clip_id, timeline_start_us: startUs, track_id: destinationTrackId });
            planPlacements.push({ clipId: clip.clip_id, trackId: destinationTrackId, startUs });
          }
          const addTrack = destination ? [] : [addTrackOperation(document, kind, sourceTrackId, destinationTrackId)];
          const carriedOperations = [...addTrack, ...operations,
            ...(riderPlacements.length ? [{ op: "position_clips" as const, placements: riderPlacements, ignore_link: true }] : [])];
          return { operations: appendCaptionMoves(carriedOperations), placements: planPlacements };
        }
      }
    }
  }
  if (onlyMainTrackPositions && !hasStructuralClipEdit) {
    let canStayOnCurrentTracks = true;
    const deltasByTrack = new Map<string, number>();
    for (const [clipId, delta] of riderDeltas) {
      const clip = indexes.clipsById.get(clipId)!;
      const previous = deltasByTrack.get(clip.track_id);
      if (previous !== undefined && previous !== delta) {
        canStayOnCurrentTracks = false;
        break;
      }
      deltasByTrack.set(clip.track_id, delta);
    }
    if (canStayOnCurrentTracks) for (const [trackId, delta] of deltasByTrack) {
      let previousEnd = Number.NEGATIVE_INFINITY;
      for (const clip of indexes.clipsByTrack.get(trackId) ?? []) {
        const startUs = riderDeltas.has(clip.clip_id)
          ? Math.max(0, clip.timeline_start_us + delta)
          : clip.timeline_start_us;
        const endUs = startUs + clip.timeline_end_us - clip.timeline_start_us;
        if (startUs < previousEnd) {
          canStayOnCurrentTracks = false;
          break;
        }
        previousEnd = Math.max(previousEnd, endUs);
      }
      if (!canStayOnCurrentTracks) break;
    }
    if (canStayOnCurrentTracks) {
      const riderPlacements: Array<{ clip_id: TimelineClip["clip_id"]; timeline_start_us: number }> = [];
      for (const [clipId, delta] of riderDeltas) {
        const clip = indexes.clipsById.get(clipId)!;
        const startUs = Math.max(0, clip.timeline_start_us + delta);
        if (startUs === clip.timeline_start_us) continue;
        riderPlacements.push({ clip_id: clip.clip_id, timeline_start_us: startUs });
        planPlacements.push({ clipId, trackId: clip.track_id, startUs });
      }
      const carriedOperations = riderPlacements.length
        ? [...operations, { op: "position_clips" as const, placements: riderPlacements, ignore_link: true }]
        : operations;
      return { operations: appendCaptionMoves(carriedOperations), placements: planPlacements };
    }
  }
  type CarryState = { clip: TimelineClip; trackId: string; startUs: number; endUs: number };
  const removedIds = new Set(operations.flatMap(operation => operation.op === "remove_clip" ? [operation.clip_id] : []));
  const trackOrder = document.tracks.map(track => track.id);
  const trackKinds = new Map(document.tracks.map(track => [track.id, track.kind]));
  const trackLocked = new Map(document.tracks.map(track => [track.id, Boolean(track.locked)]));
  const reservedTrackIds = new Set<string>();
  const candidateTrackCache = new Map<string, string[]>();
  for (const operation of operations) if (operation.op === "add_track" && operation.track_id) {
    const id = operation.track_id;
    reservedTrackIds.add(id);
    trackKinds.set(id, operation.kind);
    trackLocked.set(id, false);
    const before = operation.before_track_id ? trackOrder.indexOf(operation.before_track_id) : -1;
    const after = operation.after_track_id ? trackOrder.indexOf(operation.after_track_id) : -1;
    if (before >= 0) trackOrder.splice(before, 0, id);
    else if (after >= 0) trackOrder.splice(after + 1, 0, id);
    else trackOrder.push(id);
  }
  const addedTrackOperations: TimelinePatchOperation[] = [];
  const statesByTrack = new Map<string, CarryState[]>(trackOrder.map(trackId => [trackId, []]));
  const sortedLane = new Map<string, boolean>(trackOrder.map(trackId => [trackId, true]));
  const movedRiderStates: CarryState[] = [];
  for (const clip of document.clips) {
    if (removedIds.has(clip.clip_id)) continue;
    const position = planned.get(clip.clip_id);
    const riderDelta = riderDeltas.get(clip.clip_id);
    const startUs = riderDelta === undefined
      ? position?.startUs ?? clip.timeline_start_us
      : Math.max(0, clip.timeline_start_us + riderDelta);
    const state: CarryState = {
      clip,
      trackId: position?.trackId ?? clip.track_id,
      startUs,
      endUs: startUs + clip.timeline_end_us - clip.timeline_start_us,
    };
    let lane = statesByTrack.get(state.trackId);
    if (!lane) {
      lane = [];
      statesByTrack.set(state.trackId, lane);
      sortedLane.set(state.trackId, true);
    }
    if (lane.length && lane[lane.length - 1]!.startUs > state.startUs) sortedLane.set(state.trackId, false);
    lane.push(state);
    if (riderDelta !== undefined) movedRiderStates.push(state);
  }
  const lanesWithExistingOverlap = new Set<string>();
  for (const [trackId, lane] of statesByTrack) {
    if (!sortedLane.get(trackId)) lane.sort((a, b) => a.startUs - b.startUs);
    let greatestEnd = Number.NEGATIVE_INFINITY;
    for (const state of lane) {
      if (state.startUs < greatestEnd) lanesWithExistingOverlap.add(trackId);
      greatestEnd = Math.max(greatestEnd, state.endUs);
    }
  }
  const staleByTrack = new Map<string, number>();
  const overlaps = (left: CarryState, right: CarryState) => left.startUs < right.endUs && left.endUs > right.startUs;
  const activeLane = (trackId: string) => (statesByTrack.get(trackId) ?? []).filter(state => state.trackId === trackId);
  const candidateTracksFor = (fromTrackId: string, kind: "video" | "audio"): string[] => {
    const cacheKey = `${fromTrackId}\0${kind}`;
    let candidates = candidateTrackCache.get(cacheKey);
    if (!candidates) {
      const fromIndex = trackOrder.indexOf(fromTrackId);
      candidates = trackOrder.filter(id => id !== fromTrackId && id !== "V1" && trackKinds.get(id) === kind && !trackLocked.get(id));
      candidates.sort((left, right) => {
        const leftIndex = trackOrder.indexOf(left);
        const rightIndex = trackOrder.indexOf(right);
        const distance = Math.abs(leftIndex - fromIndex) - Math.abs(rightIndex - fromIndex);
        return distance || (kind === "audio" ? rightIndex - leftIndex : leftIndex - rightIndex);
      });
      candidateTrackCache.set(cacheKey, candidates);
    }
    return candidates;
  };
  const addLane = (fromTrackId: string, kind: "video" | "audio"): string => {
    const id = newTrackId(document, kind, reservedTrackIds);
    reservedTrackIds.add(id);
    addedTrackOperations.push(addTrackOperation(document, kind, fromTrackId, id));
    trackKinds.set(id, kind);
    trackLocked.set(id, false);
    const anchorIndex = trackOrder.indexOf(fromTrackId);
    trackOrder.splice(anchorIndex + (kind === "audio" ? 1 : 0), 0, id);
    statesByTrack.set(id, []);
    sortedLane.set(id, true);
    candidateTrackCache.clear();
    return id;
  };
  const laneFitsGroup = (trackId: string, group: readonly CarryState[]): boolean => {
    const lane = activeLane(trackId);
    let movingIndex = 0;
    let laneIndex = 0;
    while (movingIndex < group.length && laneIndex < lane.length) {
      const moving = group[movingIndex]!;
      const occupied = lane[laneIndex]!;
      if (overlaps(moving, occupied)) return false;
      if (moving.endUs <= occupied.startUs) movingIndex += 1;
      else laneIndex += 1;
    }
    return true;
  };
  const moveGroupToLane = (fromTrackId: string, toTrackId: string, group: CarryState[]) => {
    for (const state of group) state.trackId = "";
    statesByTrack.set(fromTrackId, activeLane(fromTrackId));
    staleByTrack.set(fromTrackId, 0);
    const destination = activeLane(toTrackId);
    for (const state of group) state.trackId = toTrackId;
    if (!destination.length) {
      statesByTrack.set(toTrackId, group);
      sortedLane.set(toTrackId, true);
      return;
    }
    let oldIndex = 0;
    let groupIndex = 0;
    const merged: CarryState[] = [];
    while (oldIndex < destination.length && groupIndex < group.length) {
      if (destination[oldIndex]!.startUs <= group[groupIndex]!.startUs) merged.push(destination[oldIndex++]!);
      else merged.push(group[groupIndex++]!);
    }
    while (oldIndex < destination.length) merged.push(destination[oldIndex++]!);
    while (groupIndex < group.length) merged.push(group[groupIndex++]!);
    statesByTrack.set(toTrackId, merged);
  };
  const removeFromLane = (trackId: string, state: CarryState) => {
    const lane = statesByTrack.get(trackId);
    if (!lane) return;
    // Marking a state out of its lane is O(1). Repeated splice(1, 1) while
    // carrying thousands of clips would otherwise copy the tail 10,000 times.
    state.trackId = "";
    const stale = (staleByTrack.get(trackId) ?? 0) + 1;
    staleByTrack.set(trackId, stale);
    if (stale >= Math.max(64, lane.length / 4)) {
      statesByTrack.set(trackId, lane.filter(item => item.trackId === trackId));
      staleByTrack.set(trackId, 0);
    }
  };
  const insertIntoLane = (trackId: string, state: CarryState) => {
    const lane = statesByTrack.get(trackId) ?? [];
    state.trackId = trackId;
    let low = 0;
    let high = lane.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (lane[middle]!.startUs <= state.startUs) low = middle + 1;
      else high = middle;
    }
    lane.splice(low, 0, state);
    statesByTrack.set(trackId, lane);
  };
  const laneHasOverlap = (trackId: string, state: CarryState): boolean => {
    const lane = statesByTrack.get(trackId) ?? [];
    if (!lane.length) return false;
    if (lanesWithExistingOverlap.has(trackId)) return lane.some(other => other.trackId === trackId && other !== state && overlaps(other, state));
    let low = 0;
    let high = lane.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (lane[middle]!.startUs < state.startUs) low = middle + 1;
      else high = middle;
    }
    let previousIndex = low - 1;
    while (previousIndex >= 0 && lane[previousIndex]!.trackId !== trackId) previousIndex -= 1;
    let nextIndex = low;
    while (nextIndex < lane.length && lane[nextIndex]!.trackId !== trackId) nextIndex += 1;
    const previous = lane[previousIndex];
    const next = lane[nextIndex];
    return Boolean((previous && previous.endUs > state.startUs) || (next && next.startUs < state.endUs));
  };
  const relocate = (state: CarryState, fromTrackId: string): void => {
    const kind = state.clip.asset_kind === "audio" ? "audio" : "video";
    const candidates = candidateTracksFor(fromTrackId, kind);
    const free = candidates.find(id => !laneHasOverlap(id, state));
    removeFromLane(fromTrackId, state);
    if (free) {
      insertIntoLane(free, state);
      return;
    }
    const id = addLane(fromTrackId, kind);
    insertIntoLane(id, state);
  };
  for (let laneIndex = 0; laneIndex < trackOrder.length; laneIndex += 1) {
    const trackId = trackOrder[laneIndex]!;
    if (trackId === "V1" || trackLocked.get(trackId) || trackKinds.get(trackId) === "text") continue;
    const lane = (statesByTrack.get(trackId) ?? []).filter(state => state.trackId === trackId);
    const movingGroup = lane.filter(state => riderDeltas.has(state.clip.clip_id));
    if (movingGroup.length > 1) {
      const groupDelta = riderDeltas.get(movingGroup[0]!.clip.clip_id);
      let sameDelta = groupDelta !== undefined;
      let nonOverlapping = true;
      for (let index = 0; index < movingGroup.length; index += 1) {
        if (riderDeltas.get(movingGroup[index]!.clip.clip_id) !== groupDelta) sameDelta = false;
        if (index > 0 && movingGroup[index]!.startUs < movingGroup[index - 1]!.endUs) nonOverlapping = false;
      }
      if (sameDelta && nonOverlapping) {
        const stationary = lane.filter(state => !riderDeltas.has(state.clip.clip_id));
        let stationaryIndex = 0;
        let everyMovedClipCollides = stationary.length > 0;
        for (const moving of movingGroup) {
          while (stationaryIndex < stationary.length && stationary[stationaryIndex]!.endUs <= moving.startUs) stationaryIndex += 1;
          const occupied = stationary[stationaryIndex];
          if (!occupied || occupied.startUs >= moving.endUs) {
            everyMovedClipCollides = false;
            break;
          }
        }
        if (everyMovedClipCollides) {
          const kind = lane[0]!.clip.asset_kind === "audio" ? "audio" : "video";
          const free = candidateTracksFor(trackId, kind).find(candidate => laneFitsGroup(candidate, movingGroup));
          const destination = free ?? addLane(trackId, kind);
          moveGroupToLane(trackId, destination, movingGroup);
          continue;
        }
      }
    }
    const byEnd = [...lane].sort((a, b) => a.endUs - b.endUs);
    const active = new Set<CarryState>();
    const activeMoved = new Set<CarryState>();
    let expireIndex = 0;
    for (const state of lane) {
      while (expireIndex < byEnd.length && byEnd[expireIndex]!.endUs <= state.startUs) {
        const expired = byEnd[expireIndex++]!;
        active.delete(expired);
        activeMoved.delete(expired);
      }
      if (riderDeltas.has(state.clip.clip_id)) {
        if (active.size) relocate(state, trackId);
        else {
          active.add(state);
          activeMoved.add(state);
        }
        continue;
      }
      if (activeMoved.size) for (const moved of [...activeMoved]) {
        active.delete(moved);
        activeMoved.delete(moved);
        relocate(moved, trackId);
      }
      active.add(state);
    }
  }

  const riderPlacements: Array<{ clip_id: TimelineClip["clip_id"]; timeline_start_us: number; track_id?: string }> = [];
  for (const state of movedRiderStates) {
    const original = state.clip;
    const before = planned.get(original.clip_id);
    const beforeStartUs = before?.startUs ?? original.timeline_start_us;
    const beforeTrackId = before?.trackId ?? original.track_id;
    if (state.startUs === beforeStartUs && state.trackId === beforeTrackId) continue;
    const existingPlacementIndex = planPlacements.findIndex(item => item.clipId === original.clip_id);
    if (state.startUs === original.timeline_start_us && state.trackId === original.track_id && existingPlacementIndex < 0) continue;
    const placement = { clipId: original.clip_id, trackId: state.trackId, startUs: state.startUs };
    if (existingPlacementIndex >= 0) planPlacements[existingPlacementIndex] = placement;
    else planPlacements.push(placement);
    riderPlacements.push({ clip_id: original.clip_id, timeline_start_us: state.startUs, ...(state.trackId !== original.track_id ? { track_id: state.trackId } : {}) });
  }
  if (riderPlacements.length) operations.push({ op: "position_clips", placements: riderPlacements, ignore_link: true });

  operations = appendCaptionMoves(operations);

  // Track additions must precede the position operations that reference their IDs.
  if (addedTrackOperations.length) {
    operations = [...operations.filter(operation => operation.op === "add_track"), ...addedTrackOperations,
      ...operations.filter(operation => operation.op !== "add_track")];
  }
  return { operations, placements: planPlacements };
}

function newTrackId(document: TimelineDocument, kind: "video" | "audio", reserved: Set<string>): string {
  const prefix = kind === "audio" ? "A" : "V";
  const maxExisting = document.tracks.reduce((max, track) => {
    if (!track.id.startsWith(prefix)) return max;
    const suffix = Number(track.id.slice(prefix.length));
    return Number.isInteger(suffix) ? Math.max(max, suffix) : max;
  }, kind === "audio" ? 1 : 1);
  let number = maxExisting + 1;
  while (reserved.has(`${prefix}${number}`) || document.tracks.some(track => track.id === `${prefix}${number}`)) number += 1;
  return `${prefix}${number}`;
}

function addTrackOperation(document: TimelineDocument, kind: "video" | "audio", anchorId: string, id: string): TimelinePatchOperation {
  if (kind === "audio") {
    return { op: "add_track", kind, track_id: id, after_track_id: anchorId };
  }
  return { op: "add_track", kind, track_id: id, before_track_id: anchorId };
}

function mergeSpans(spans: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end + 1_000) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function removedWidthBefore(cuts: readonly { start: number; end: number }[]): (atUs: number) => number {
  // `cuts` is sorted and disjoint. Binary search avoids allocating a filtered array for every clip in large Insert edits.
  const prefixWidths = [0];
  for (const cut of cuts) prefixWidths.push(prefixWidths.at(-1)! + cut.end - cut.start);
  return atUs => {
    let low = 0;
    let high = cuts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cuts[middle]!.end <= atUs) low = middle + 1;
      else high = middle;
    }
    return prefixWidths[low]!;
  };
}

/** Map a V1 insertion point through the selected V1 spans that close before the insert. */
function mapTimeAfterClosedSpans(atUs: number, cuts: readonly { start: number; end: number }[]): number {
  let removed = 0;
  for (const cut of cuts) {
    if (atUs < cut.start) break;
    if (atUs < cut.end) return Math.max(0, cut.start - removed);
    removed += cut.end - cut.start;
  }
  return Math.max(0, atUs - removed);
}

function trackInsertPoint(
  laneClips: readonly TimelineClip[], pointerUs: number, fallbackUs: number, skip = new Set<string>(),
): number {
  const lane = skip.size ? laneClips.filter(clip => !skip.has(clip.clip_id)) : laneClips;
  let low = 0;
  let high = lane.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lane[middle]!.timeline_start_us <= pointerUs) low = middle + 1;
    else high = middle;
  }
  const previous = lane[low - 1];
  const next = lane[low];
  const over = previous && pointerUs < previous.timeline_end_us ? previous : undefined;
  if (over) return pointerUs < (over.timeline_start_us + over.timeline_end_us) / 2 ? over.timeline_start_us : over.timeline_end_us;
  const lastEnd = lane.at(-1)?.timeline_end_us ?? 0;
  if (pointerUs >= lastEnd) return lastEnd;
  const gapStart = Math.max(0, previous?.timeline_end_us ?? 0);
  const gapEnd = next?.timeline_start_us ?? lastEnd;
  return Math.min(Math.max(fallbackUs, gapStart), gapEnd);
}

/** Same insertion point as filtering `skip` first, but without allocating a filtered lane. */
function trackInsertPointExcluding(
  lane: readonly TimelineClip[], pointerUs: number, fallbackUs: number, skip: ReadonlySet<string>,
): number {
  let low = 0;
  let high = lane.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lane[middle]!.timeline_start_us <= pointerUs) low = middle + 1;
    else high = middle;
  }
  let previousIndex = low - 1;
  while (previousIndex >= 0 && skip.has(lane[previousIndex]!.clip_id)) previousIndex -= 1;
  let nextIndex = low;
  while (nextIndex < lane.length && skip.has(lane[nextIndex]!.clip_id)) nextIndex += 1;
  let lastIndex = lane.length - 1;
  while (lastIndex >= 0 && skip.has(lane[lastIndex]!.clip_id)) lastIndex -= 1;
  const previous = previousIndex >= 0 ? lane[previousIndex] : undefined;
  const next = lane[nextIndex];
  const lastEnd = lastIndex >= 0 ? lane[lastIndex]!.timeline_end_us : 0;
  const over = previous && pointerUs < previous.timeline_end_us ? previous : undefined;
  if (over) return pointerUs < (over.timeline_start_us + over.timeline_end_us) / 2 ? over.timeline_start_us : over.timeline_end_us;
  if (pointerUs >= lastEnd) return lastEnd;
  const gapStart = Math.max(0, previous?.timeline_end_us ?? 0);
  const gapEnd = next?.timeline_start_us ?? lastEnd;
  return Math.min(Math.max(fallbackUs, gapStart), gapEnd);
}

/**
 * Build one immutable edit plan from the pointer snapshot. The same plan feeds the ghost and the patch; IDs and
 * modifier semantics are captured at pointerdown, so pointerup cannot commit a different edit than the preview.
 */
export function planClipDrag(input: ClipDragPlanInput): ClipDragPlan {
  return planClipDragWithIndexes(input, buildClipDragIndexes(input.document));
}

/** Reuse document indexes across pointer frames; call again only when the timeline document changes. */
export function createClipDragPlanner(document: TimelineDocument): (input: Omit<ClipDragPlanInput, "document">) => ClipDragPlan {
  const indexes = buildClipDragIndexes(document);
  return input => planClipDragWithIndexes({ ...input, document }, indexes);
}

function buildClipDragIndexes(document: TimelineDocument): ClipDragIndexes {
  const clipsById = new Map<string, TimelineClip>(document.clips.map(clip => [clip.clip_id, clip]));
  const tracksById = new Map(document.tracks.map(track => [track.id, track]));
  const clipsByTrack = new Map<string, TimelineClip[]>();
  for (const clip of document.clips) {
    const lane = clipsByTrack.get(clip.track_id) ?? [];
    lane.push(clip);
    clipsByTrack.set(clip.track_id, lane);
  }
  for (const lane of clipsByTrack.values()) lane.sort((a, b) => a.timeline_start_us - b.timeline_start_us);
  const prefixMaxEndByTrack = new Map<string, number[]>();
  for (const [trackId, lane] of clipsByTrack) {
    let maximum = Number.NEGATIVE_INFINITY;
    prefixMaxEndByTrack.set(trackId, lane.map(clip => {
      maximum = Math.max(maximum, clip.timeline_end_us);
      return maximum;
    }));
  }
  const mainCuts = [...new Set((clipsByTrack.get("V1") ?? []).flatMap(clip => [clip.timeline_start_us, clip.timeline_end_us]))]
    .sort((a, b) => a - b);
  const nonMainClips = document.clips.filter(clip => clip.track_id !== "V1");
  const lockedIds = new Set<string>(document.locked_elements ?? []);
  const ridersByMainClipTrack = new Map<string, Map<string, TimelineClip[]>>();
  const mainClips = clipsByTrack.get("V1") ?? [];
  const riderOwnerByClipId = new Map<string, string>();
  for (const clip of tracksById.get("V1")?.locked ? [] : nonMainClips) {
    if (lockedIds.has(clip.clip_id) || tracksById.get(clip.track_id)?.locked) continue;
    const owner = mainTrackOwner(mainClips, mainCuts, clip.timeline_start_us, clip.timeline_end_us);
    if (!owner) continue;
    riderOwnerByClipId.set(clip.clip_id, owner.clip_id);
    let byTrack = ridersByMainClipTrack.get(owner.clip_id);
    if (!byTrack) {
      byTrack = new Map();
      ridersByMainClipTrack.set(owner.clip_id, byTrack);
    }
    const riders = byTrack.get(clip.track_id) ?? [];
    riders.push(clip);
    byTrack.set(clip.track_id, riders);
  }
  for (const byTrack of ridersByMainClipTrack.values()) {
    for (const riders of byTrack.values()) riders.sort((left, right) => left.timeline_start_us - right.timeline_start_us);
  }
  const clipsByLinkGroup = new Map<string, TimelineClip[]>();
  for (const clip of document.clips) if (clip.link_group_id) {
    const group = clipsByLinkGroup.get(clip.link_group_id) ?? [];
    group.push(clip);
    clipsByLinkGroup.set(clip.link_group_id, group);
  }
  return {
    clipsById,
    clipsByTrack,
    prefixMaxEndByTrack,
    tracksById,
    trackIndexById: new Map(document.tracks.map((track, index) => [track.id, index])),
    nonMainClips,
    ridersByMainClipTrack,
    riderOwnerByClipId,
    mainCuts,
    clipsByLinkGroup,
    lockedIds,
  };
}

function planClipDragWithIndexes(input: ClipDragPlanInput, indexes: ClipDragIndexes): ClipDragPlan {
  // OpenFilm serializes edit-plan timeline values through sec(ms), which rounds
  // every pointer-derived position to whole milliseconds (timeline-edit.ts:548).
  // Keep Vortex's microsecond model, but quantize the gesture coordinates at
  // the planner boundary so previews, placements, and committed patches agree.
  const toOpenFilmMillisecond = (timeUs: number) => Math.round(timeUs / 1_000) * 1_000;
  input = {
    ...input,
    leadStartUs: toOpenFilmMillisecond(input.leadStartUs),
    pointerTimeUs: toOpenFilmMillisecond(input.pointerTimeUs),
  };
  const { document, leadClipId } = input;
  const { clipsById, clipsByTrack, prefixMaxEndByTrack, tracksById, trackIndexById, nonMainClips, clipsByLinkGroup, lockedIds } = indexes;
  const lead = clipsById.get(leadClipId);
  if (!lead) return noPlan("片段已不存在");
  const sources = [...new Map(input.clipIds.map(id => [id, clipsById.get(id)] as const))]
    .map(([, clip]) => clip).filter((clip): clip is TimelineClip => Boolean(clip));
  if (!sources.some(clip => clip.clip_id === leadClipId)) sources.unshift(lead);
  if (sources.some(clip => isLocked(lockedIds, tracksById, clip))) return noPlan("片段或所在轨道已锁定");
  const oneLinkedGroup = Boolean(lead.link_group_id && sources.every(source => source.link_group_id === lead.link_group_id));
  const grouped = sources.length > 1;
  const copyIds = input.copyIds ?? [];
  if (input.copyOnStart && copyIds.length !== sources.length) return noPlan("复制目标未预分配");

  const hit = input.dropHit;
  let targetTrackId = input.targetTrackId ?? lead.track_id;
  let insertAtUs: number | null = null;
  let replaceTarget: TimelineClip | null = null;
  let openLane = false;
  let laneAnchor = hit?.trackId ?? null;
  let explicitInsert = false;

  if (hit) {
    const outerRow = hit.rowIndex < 0 || hit.rowIndex >= document.tracks.length;
    if (hit.band !== "body" && (!input.copyOnStart || outerRow)) {
      openLane = true;
      if (!laneAnchor) {
        const sameKind = document.tracks.filter(track => track.kind === kindForClip(lead));
        laneAnchor = hit.band === "above" ? sameKind[0]?.id ?? null : sameKind.at(-1)?.id ?? null;
      }
    } else if (!input.copyOnStart && hit.band === "body" && hit.clipId && hit.zone) {
      const target = clipsById.get(hit.clipId);
      if (!target || (!grouped && sources.some(clip => clip.clip_id === target.clip_id))) return noPlan("无效的落点片段");
      targetTrackId = target.track_id;
      if (target.asset_kind === "audio" !== (lead.asset_kind === "audio")) return noPlan("片段类型与目标轨道不匹配");
      // OpenFilm grouped drags ignore single-clip before/after/Replace hit zones and use the common lane delta.
      if (!grouped) {
        if (hit.zone === "before") { insertAtUs = target.timeline_start_us; explicitInsert = true; }
        else if (hit.zone === "after") { insertAtUs = target.timeline_end_us; explicitInsert = true; }
        else if (hit.zone === "replace") replaceTarget = target;
      }
    } else if (hit.trackId) {
      // OpenFilm resolves a row-edge Alt-copy against the lane under the pointer;
      // group members then keep their relative lane offsets from that lead lane.
      targetTrackId = hit.trackId;
    }
  }

  const operations: TimelinePatchOperation[] = [];
  const reservedTrackIds = new Set<string>();
  const destBySourceTrack = new Map<string, string>();
  const distinctSourceTracks = [...new Set(sources.map(clip => clip.track_id))]
    .sort((a, b) => (trackIndexById.get(a) ?? Number.MAX_SAFE_INTEGER) - (trackIndexById.get(b) ?? Number.MAX_SAFE_INTEGER));
  if (!openLane) {
    const targetTrack = tracksById.get(targetTrackId);
    if (!targetTrack || !compatible(targetTrack, lead)) return noPlan("片段与目标轨道类型不匹配");
    if (targetTrack.locked) return noPlan("目标轨道已锁定");
    if (grouped) {
      const leadIndex = trackIndexById.get(lead.track_id);
      const targetIndex = trackIndexById.get(targetTrackId);
      if (leadIndex === undefined || targetIndex === undefined) return noPlan("组合落点轨道不存在");
      const laneDelta = targetIndex - leadIndex;
      for (const sourceTrackId of distinctSourceTracks) {
        const sourceIndex = trackIndexById.get(sourceTrackId);
        const destination = sourceIndex === undefined ? undefined : document.tracks[sourceIndex + laneDelta];
        const representative = sources.find(source => source.track_id === sourceTrackId)!;
        if (!destination || !compatible(destination, representative)) return noPlan("组合落点超出兼容轨道范围");
        if (destination.locked) return noPlan("组合落点包含锁定轨道");
        destBySourceTrack.set(sourceTrackId, destination.id);
      }
      targetTrackId = destBySourceTrack.get(lead.track_id) ?? targetTrackId;
    } else {
      for (const sourceTrackId of distinctSourceTracks) destBySourceTrack.set(sourceTrackId, sourceTrackId === lead.track_id ? targetTrackId : sourceTrackId);
    }
  } else {
    // The row is only an insertion anchor here: OpenFilm lets a track be opened
    // immediately above/below a locked row. The new lane is writable; only body
    // drops target the locked track itself and are rejected in the non-openLane path.
    const hitIndex = hit?.rowIndex ?? -1;
    const atTop = Boolean(hit && hit.rowIndex < 0);
    const atBottom = Boolean(hit && hit.rowIndex >= document.tracks.length);
    const insertionIndex = atTop ? 0 : atBottom ? document.tracks.length : Math.max(0, hitIndex + (hit?.band === "below" ? 1 : 0));
    const wantedSide: "before" | "after" = atTop || hit?.band === "above" ? "before" : "after";
    const lastAfterAnchor = new Map<string, string>();
    const beforeGroups = new Map<string, Array<{ kind: "video" | "audio"; id: string; anchorId: string }>>();
    for (const sourceTrackId of distinctSourceTracks) {
      const representative = sources.find(source => source.track_id === sourceTrackId)!;
      const kind = kindForClip(representative);
      const sameKind = document.tracks.filter(track => track.kind === kind);
      if (!sameKind.length) return noPlan("找不到可创建相邻轨道的位置");
      const before = sameKind.filter(track => (trackIndexById.get(track.id) ?? -1) >= insertionIndex);
      const after = sameKind.filter(track => (trackIndexById.get(track.id) ?? Number.MAX_SAFE_INTEGER) < insertionIndex);
      let anchor: TimelineTrack;
      let side = wantedSide;
      if (side === "before" && before.length) anchor = before[0]!;
      else if (side === "after" && after.length) anchor = after.at(-1)!;
      else if (before.length) { anchor = before[0]!; side = "before"; }
      else { anchor = after.at(-1) ?? sameKind.at(-1)!; side = "after"; }
      // A1 is fixed at the top of the audio stack; Core deliberately cannot insert an audio lane before it.
      if (kind === "audio" && side === "before" && anchor.id === "A1") side = "after";
      let anchorId = anchor.id;
      const afterKey = `${kind}:${anchor.id}`;
      if (side === "after" && lastAfterAnchor.has(afterKey)) anchorId = lastAfterAnchor.get(afterKey)!;
      const id = newTrackId(document, kind, reservedTrackIds);
      reservedTrackIds.add(id);
      if (side === "before") {
        const key = `${kind}:${anchor.id}`;
        const group = beforeGroups.get(key) ?? [];
        group.push({ kind, id, anchorId: anchor.id });
        beforeGroups.set(key, group);
      } else {
        operations.push({ op: "add_track", kind, track_id: id, after_track_id: anchorId });
        lastAfterAnchor.set(afterKey, id);
      }
      destBySourceTrack.set(sourceTrackId, id);
    }
    // Build each above-row run bottom-up, chaining each insertion before the lane already opened below it.
    for (const group of beforeGroups.values()) {
      let anchorId = group[0]!.anchorId;
      for (const request of [...group].reverse()) {
        operations.push({ op: "add_track", kind: request.kind, track_id: request.id, before_track_id: anchorId });
        anchorId = request.id;
      }
    }
    targetTrackId = destBySourceTrack.get(lead.track_id) ?? targetTrackId;
  }
  if (replaceTarget && (replaceTarget.track_id !== targetTrackId || isLocked(lockedIds, tracksById, replaceTarget))) {
    return noPlan("替换目标或所在轨道已锁定");
  }

  const effectiveMode = explicitInsert ? "insert" : (input.copyOnStart || openLane) ? "place" : input.mode;
  const movingIds = new Set(sources.map(clip => clip.clip_id));
  const duration = (clip: TimelineClip) => clip.timeline_end_us - clip.timeline_start_us;
  const offsets = new Map(sources.map(clip => [clip.clip_id, clip.timeline_start_us - lead.timeline_start_us]));
  let targetStart = replaceTarget ? replaceTarget.timeline_start_us : insertAtUs ?? Math.max(0, input.leadStartUs);
  if (!grouped && !openLane) destBySourceTrack.set(lead.track_id, targetTrackId);

  const canFlushNearEdge = input.snappingEnabled === true && effectiveMode === "place" && !openLane && !explicitInsert &&
    !replaceTarget && sources.length === 1 && !(input.mainTrackMagnet && targetTrackId === "V1");
  if (canFlushNearEdge && input.flushToleranceUs && input.flushToleranceUs > 0) {
    const lane = clipsByTrack.get(targetTrackId) ?? [];
    const prefix = prefixMaxEndByTrack.get(targetTrackId) ?? [];
    const skip = input.copyOnStart ? new Set<string>() : movingIds;
    targetStart = flushNearEdge(lane, prefix, skip, targetStart, duration(lead), input.flushToleranceUs) ?? targetStart;
  }

  const copyInsertsOnMain = input.copyOnStart && input.mainTrackMagnet && targetTrackId === "V1" && !replaceTarget;
  const translatingGroup = sources.length > 1 && new Set(sources.map(source => source.track_id)).size > 1 &&
    sources.every(source => (destBySourceTrack.get(source.track_id) ?? targetTrackId) === source.track_id);
  const magneticMainGroup = !input.copyOnStart && !replaceTarget && !explicitInsert && effectiveMode === "place" && !translatingGroup && input.mainTrackMagnet &&
    targetTrackId === "V1" && sources.length > 1 && sources.some(source => (destBySourceTrack.get(source.track_id) ?? targetTrackId) === "V1");
  const magneticLinkedToMain = !input.copyOnStart && !replaceTarget && !explicitInsert && input.mainTrackMagnet &&
    targetTrackId === "V1" && oneLinkedGroup && !grouped;
  const mainCopySources = copyInsertsOnMain
    ? sources.filter(clip => (destBySourceTrack.get(clip.track_id) ?? targetTrackId) === "V1").sort((a, b) => a.timeline_start_us - b.timeline_start_us)
    : [];
  const mainInsertAtUs = copyInsertsOnMain ? trackInsertPoint(clipsByTrack.get("V1") ?? [], input.pointerTimeUs, targetStart) : null;

  const proposed = new Map(sources.map(clip => [clip.clip_id, {
    track_id: destBySourceTrack.get(clip.track_id) ?? targetTrackId,
    timeline_start_us: Math.max(0, targetStart + (offsets.get(clip.clip_id) ?? 0)),
  }]));
  const proposedIntervalsByTrack = new Map<string, Array<{ start: number; end: number }>>();
  for (const source of sources) {
    const position = proposed.get(source.clip_id)!;
    const intervals = proposedIntervalsByTrack.get(position.track_id) ?? [];
    intervals.push({ start: position.timeline_start_us, end: position.timeline_start_us + duration(source) });
    proposedIntervalsByTrack.set(position.track_id, intervals);
  }
  for (const intervals of proposedIntervalsByTrack.values()) {
    intervals.sort((a, b) => a.start - b.start);
    if (intervals.some((item, index) => index > 0 && item.start < intervals[index - 1]!.end)) return noPlan("组合内部片段会重叠");
  }
  if (mainInsertAtUs != null) {
    let cursor = mainInsertAtUs;
    const deltaByLinkGroup = new Map<string, number>();
    for (const source of mainCopySources) {
      const place = proposed.get(source.clip_id)!;
      const delta = cursor - place.timeline_start_us;
      place.timeline_start_us = cursor;
      if (source.link_group_id && !deltaByLinkGroup.has(source.link_group_id)) deltaByLinkGroup.set(source.link_group_id, delta);
      cursor += duration(source);
    }
    for (const source of sources) {
      if (source.track_id === "V1" || !source.link_group_id) continue;
      const delta = deltaByLinkGroup.get(source.link_group_id);
      if (delta !== undefined) proposed.get(source.clip_id)!.timeline_start_us = Math.max(0, proposed.get(source.clip_id)!.timeline_start_us + delta);
    }
  }
  const conflictTracks = new Set<string>();
  const magnetOwnsMainTarget = !replaceTarget && !explicitInsert && input.mainTrackMagnet && targetTrackId === "V1" &&
    sources.length === 1 &&
    (lead.track_id === "V1" || targetTrackId === "V1");
  if (!openLane && !replaceTarget && effectiveMode === "place" && !magneticMainGroup && !magneticLinkedToMain && !magnetOwnsMainTarget) {
    const proposedByTrack = new Map<string, Array<{ start: number; end: number }>>();
    for (const clip of sources) {
      const place = proposed.get(clip.clip_id)!;
      if (input.copyOnStart && copyInsertsOnMain && place.track_id === "V1") continue;
      const bucket = proposedByTrack.get(place.track_id) ?? [];
      bucket.push({ start: place.timeline_start_us, end: place.timeline_start_us + duration(clip) });
      proposedByTrack.set(place.track_id, bucket);
    }
    const baseByTrack = new Map<string, Array<{ start: number; end: number }>>();
    if (proposedByTrack.size) for (const item of document.clips) {
      if ((!input.copyOnStart && movingIds.has(item.clip_id)) || !proposedByTrack.has(item.track_id)) continue;
      const intervals = baseByTrack.get(item.track_id) ?? [];
      intervals.push({ start: item.timeline_start_us, end: item.timeline_end_us });
      baseByTrack.set(item.track_id, intervals);
    }
    for (const [trackId, intervals] of proposedByTrack) {
      const baseIntervals = baseByTrack.get(trackId) ?? [];
      if (intervals.length === 1) {
        const proposedInterval = intervals[0]!;
        if (baseIntervals.some(other => proposedInterval.start < other.end && other.start < proposedInterval.end)) conflictTracks.add(trackId);
      } else {
        baseIntervals.sort((a, b) => a.start - b.start);
        intervals.sort((a, b) => a.start - b.start);
        if (intervals.some((item, index) => index > 0 && item.start < intervals[index - 1]!.end)) conflictTracks.add(trackId);
        if (intervals.some(item => intervalsOverlap(baseIntervals, item.start, item.end))) conflictTracks.add(trackId);
      }
    }
  }
  const hasConflict = conflictTracks.size > 0;

  if (hasConflict) {
    const orderedConflicts = [...conflictTracks].sort((a, b) =>
      (trackIndexById.get(a) ?? Number.MAX_SAFE_INTEGER) - (trackIndexById.get(b) ?? Number.MAX_SAFE_INTEGER));
    for (const sourceTrackId of orderedConflicts) {
      const representative = sources.find(clip => (destBySourceTrack.get(clip.track_id) ?? targetTrackId) === sourceTrackId)!;
      const kind = kindForClip(representative);
      const existingTarget = tracksById.get(sourceTrackId);
      const anchor = tracksById.has(sourceTrackId) ? sourceTrackId : document.tracks.find(track => track.kind === kind)?.id;
      if (!anchor) return noPlan("找不到可创建相邻轨道的位置");
      const id = newTrackId(document, kind, reservedTrackIds);
      reservedTrackIds.add(id);
      operations.push(addTrackOperation(document, kind, anchor, id));
      for (const source of sources) {
        const current = destBySourceTrack.get(source.track_id) ?? targetTrackId;
        if (current === sourceTrackId) destBySourceTrack.set(source.track_id, id);
      }
      if (existingTarget?.locked) return noPlan("目标轨道已锁定");
    }
    for (const source of sources) {
      const place = proposed.get(source.clip_id)!;
      place.track_id = destBySourceTrack.get(source.track_id) ?? targetTrackId;
    }
  }

  if (input.copyOnStart) {
    const copies = sources.map((source, index) => ({
      item_kind: "clip" as const,
      source_id: source.clip_id,
      copy_id: copyIds[index]! as TimelineClip["clip_id"],
      timeline_start_us: proposed.get(source.clip_id)!.timeline_start_us,
      track_id: destBySourceTrack.get(source.track_id) ?? targetTrackId,
    }));
    operations.push({ op: "duplicate_timeline_items", copies });
    const duplicatePlacements = copies.map(copy => ({ clipId: copy.copy_id, trackId: copy.track_id, startUs: copy.timeline_start_us }));
    if (mainInsertAtUs != null && mainCopySources.length > 0) {
      const insertWidth = mainCopySources.reduce((sum, source) => sum + duration(source), 0);
      // When the project is only V1 clips, no external riders, captions, or explicit links
      // can participate. Ripple the already-sorted V1 suffix directly instead of materializing
      // the main delta map and then mapping its placements a second time on every drag frame.
      if (!nonMainClips.length && !document.captions.length && !clipsByLinkGroup.size) {
        if (tracksById.get("V1")?.locked) return noPlan("主轨已锁定");
        const main = clipsByTrack.get("V1") ?? [];
        let low = 0;
        let high = main.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (main[middle]!.timeline_start_us < mainInsertAtUs) low = middle + 1;
          else high = middle;
        }
        const shiftedPlacements: Array<{ clip_id: TimelineClip["clip_id"]; timeline_start_us: number }> = [];
        const shiftedGhosts: Array<{ clipId: string; trackId: string; startUs: number }> = [];
        for (let index = low; index < main.length; index += 1) {
          const item = main[index]!;
          if (lockedIds.has(item.clip_id)) return noPlan("主轨插入会移动锁定或无法同步的链接片段");
          const startUs = item.timeline_start_us + insertWidth;
          shiftedPlacements.push({ clip_id: item.clip_id, timeline_start_us: startUs });
          shiftedGhosts.push({ clipId: item.clip_id, trackId: "V1", startUs });
        }
        if (shiftedPlacements.length) operations.push({ op: "position_clips", placements: shiftedPlacements });
        const allPlacements = [...duplicatePlacements, ...shiftedGhosts];
        const leadCopy = copies[sources.findIndex(clip => clip.clip_id === leadClipId)] ?? copies[0]!;
        if (operationLimitExceeded(operations)) return noPlan("一次编辑的操作超过上限");
        return { operations, placements: allPlacements, lead: { clipId: leadCopy.copy_id, trackId: leadCopy.track_id, startUs: leadCopy.timeline_start_us } };
      }
      const deltaById = new Map<string, number>();
      const assignLinkedGroup = (clip: TimelineClip, delta: number): boolean => {
        const members = clip.link_group_id ? clipsByLinkGroup.get(clip.link_group_id) ?? [clip] : [clip];
        for (const member of members) {
          const previous = deltaById.get(member.clip_id);
          if (previous !== undefined && previous !== delta) return false;
          if (delta && (isLocked(lockedIds, tracksById, member) || member.timeline_start_us + delta < 0)) return false;
        }
        for (const member of members) deltaById.set(member.clip_id, delta);
        return true;
      };
      const main = clipsByTrack.get("V1") ?? [];
      if (tracksById.get("V1")?.locked) return noPlan("主轨已锁定");
      for (const host of main) {
        const delta = host.timeline_start_us >= mainInsertAtUs ? insertWidth : 0;
        if (delta && !assignLinkedGroup(host, delta)) return noPlan("主轨插入会移动锁定或无法同步的链接片段");
      }
      const cuts: number[] = [];
      for (const clip of main) {
        if (cuts.at(-1) !== clip.timeline_start_us) cuts.push(clip.timeline_start_us);
        if (cuts.at(-1) !== clip.timeline_end_us) cuts.push(clip.timeline_end_us);
      }
      if (input.linkageEnabled) for (const rider of nonMainClips) {
        if (rider.track_id === "V1" || deltaById.has(rider.clip_id)) continue;
        const owner = mainTrackOwner(main, cuts, rider.timeline_start_us, rider.timeline_end_us);
        const delta = owner ? deltaById.get(owner.clip_id) ?? 0 : 0;
        if (delta && !assignLinkedGroup(rider, delta)) return noPlan("联动片段无法安全移动");
      }
      const shiftedPlacements = [...deltaById].flatMap(([id, delta]) => {
        if (!delta) return [];
        const item = clipsById.get(id);
        if (!item) return [];
        const startUs = item.timeline_start_us + delta;
        return [{ clip_id: item.clip_id, timeline_start_us: startUs }];
      });
      if (shiftedPlacements.length) operations.push({ op: "position_clips", placements: shiftedPlacements });
      if (input.linkageEnabled && !tracksById.get("C1")?.locked) for (const caption of document.captions) {
        if (caption.source_clip_id) continue;
        const owner = mainTrackOwner(main, cuts, caption.start_us, caption.end_us);
        const delta = owner ? deltaById.get(owner.clip_id) ?? 0 : 0;
        if (delta) operations.push({ op: "set_caption_timing", caption_id: caption.caption_id, start_us: caption.start_us + delta, end_us: caption.end_us + delta });
      }
      const allPlacements = [...duplicatePlacements, ...shiftedPlacements.map(item => ({
        clipId: item.clip_id,
        trackId: clipsById.get(item.clip_id)!.track_id,
        startUs: item.timeline_start_us,
      }))];
      const leadCopy = copies[sources.findIndex(clip => clip.clip_id === leadClipId)] ?? copies[0]!;
      if (operationLimitExceeded(operations)) return noPlan("一次编辑的操作超过上限");
      return { operations, placements: allPlacements, lead: { clipId: leadCopy.copy_id, trackId: leadCopy.track_id, startUs: leadCopy.timeline_start_us } };
    }
    const leadCopy = copies[sources.findIndex(clip => clip.clip_id === leadClipId)] ?? copies[0]!;
    if (operationLimitExceeded(operations)) return noPlan("一次编辑的操作超过上限");
    return { operations, placements: duplicatePlacements, lead: { clipId: leadCopy.copy_id, trackId: leadCopy.track_id, startUs: leadCopy.timeline_start_us } };
  }

  const magneticLinkedOffMain = !replaceTarget && !explicitInsert && effectiveMode === "place" && input.mainTrackMagnet &&
    lead.track_id === "V1" && targetTrackId !== "V1" && sources.some(source => source.track_id === "V1");
  if (magneticLinkedOffMain) {
    const mainSpans = sources.filter(source => source.track_id === "V1").map(source => ({ start: source.timeline_start_us, end: source.timeline_end_us }));
    const remaining: TimelineDocument = { ...document, clips: document.clips.filter(clip => !movingIds.has(clip.clip_id)) };
    const compact = planCompactMainTrack(remaining, input.linkageEnabled, mainSpans);
    if (compact.reason) return noPlan(compact.reason);
    const positionsById = new Map<string, { clip_id: TimelineClip["clip_id"]; timeline_start_us: number; track_id?: string }>();
    const otherOperations = compact.operations.filter(operation => {
      if (operation.op !== "position_clips") return true;
      for (const placement of operation.placements) positionsById.set(placement.clip_id, placement);
      return false;
    });
    for (const source of sources) positionsById.set(source.clip_id, {
      clip_id: source.clip_id,
      timeline_start_us: Math.max(0, targetStart + (offsets.get(source.clip_id) ?? 0)),
      track_id: destBySourceTrack.get(source.track_id) ?? targetTrackId,
    });
    const placedOps = [...positionsById.values()];
    const allOperations = [...operations, ...(placedOps.length ? [{ op: "position_clips" as const, placements: placedOps }] : []), ...otherOperations];
    const carried = addLinkedRiderCarry(document, allOperations, input.linkageEnabled, indexes, movingIds);
    const leadPosition = carried.placements.find(item => item.clipId === leadClipId) ?? { clipId: leadClipId, trackId: targetTrackId, startUs: targetStart };
    if (operationLimitExceeded(carried.operations)) return noPlan("一次编辑的操作超过上限");
    return { operations: carried.operations, placements: carried.placements, lead: leadPosition };
  }

  // A group dropped onto V1 inserts its V1 members as one packed main-track transaction, even when
  // the group started on other lanes. Linked riders are planned against the final main order.
  if (magneticMainGroup) {
    if (tracksById.get("V1")?.locked) return noPlan("主轨已锁定或不存在");
    const mainSources = sources.filter(source => (destBySourceTrack.get(source.track_id) ?? targetTrackId) === "V1");
    const mainSpans = mergeSpans(sources.filter(source => source.track_id === "V1")
      .map(source => ({ start: source.timeline_start_us, end: source.timeline_end_us })));
    const rest = clipsByTrack.get("V1")!.filter(clip => !movingIds.has(clip.clip_id));
    let minimumOffsetUs = 0;
    for (const offset of offsets.values()) minimumOffsetUs = Math.min(minimumOffsetUs, offset);
    const originalInsertAtUs = trackInsertPointExcluding(
      rest,
      input.pointerTimeUs,
      Math.max(0, targetStart + minimumOffsetUs),
      movingIds,
    );
    const insertAtUs = mapTimeAfterClosedSpans(originalInsertAtUs, mainSpans);
    const closeWidthBefore = removedWidthBefore(mainSpans);
    const orderedMainSources = [...mainSources].sort((a, b) => a.timeline_start_us - b.timeline_start_us);
    const mainSourceIds = new Set(mainSources.map(source => source.clip_id));
    const packedDurationUs = orderedMainSources.reduce((sum, source) => sum + duration(source), 0);
    // Every retained main clip at/after a removed V1 source span changes position;
    // build the patch list directly instead of allocating a 10k-entry Map and then
    // traversing it again to filter unchanged placements.
    const positionPlacements: Array<{ clip_id: TimelineClip["clip_id"]; timeline_start_us: number; track_id?: string }> = [];

    for (const clip of rest) {
      const afterCloseUs = clip.timeline_start_us - closeWidthBefore(clip.timeline_start_us);
      const startUs = afterCloseUs >= insertAtUs ? afterCloseUs + packedDurationUs : afterCloseUs;
      if (startUs === clip.timeline_start_us) continue;
      if (isLocked(lockedIds, tracksById, clip)) return noPlan("主轨磁吸插入会移动锁定片段");
      positionPlacements.push({ clip_id: clip.clip_id, timeline_start_us: startUs });
    }

    let cursor = insertAtUs;
    let leadStart: number | null = null;
    for (const source of orderedMainSources) {
      if (source.clip_id === leadClipId) leadStart = cursor;
      if (source.track_id !== "V1" || cursor !== source.timeline_start_us) {
        positionPlacements.push({
          clip_id: source.clip_id,
          ...(source.track_id === "V1" ? {} : { track_id: "V1" }),
          timeline_start_us: cursor,
        });
      }
      cursor += duration(source);
    }
    leadStart ??= Math.max(0, insertAtUs - minimumOffsetUs);
    for (const source of sources) {
      if (mainSourceIds.has(source.clip_id)) continue;
      const destination = destBySourceTrack.get(source.track_id) ?? targetTrackId;
      const startUs = Math.max(0, leadStart + (offsets.get(source.clip_id) ?? 0));
      if (destination !== source.track_id || startUs !== source.timeline_start_us) {
        positionPlacements.push({ clip_id: source.clip_id, track_id: destination, timeline_start_us: startUs });
      }
    }

    // Common large main-only groups need only one linear pass; avoid building the rider/caption indexes for them.
    if (!indexes.nonMainClips.length && !document.captions.length && !clipsByLinkGroup.size && mainSources.length === sources.length) {
      const plannedOperations: TimelinePatchOperation[] = [
        ...operations,
        ...(positionPlacements.length ? [{ op: "position_clips" as const, placements: positionPlacements }] : []),
      ];
      if (operationLimitExceeded(plannedOperations)) return noPlan("一次编辑的操作超过上限");
      const placements = positionPlacements.map(item => ({
        clipId: item.clip_id,
        trackId: item.track_id ?? clipsById.get(item.clip_id)?.track_id ?? "V1",
        startUs: item.timeline_start_us,
      }));
      return {
        operations: plannedOperations,
        placements,
        lead: placements.find(item => item.clipId === leadClipId) ?? { clipId: leadClipId, trackId: targetTrackId, startUs: leadStart },
      };
    }

    const plannedOperations: TimelinePatchOperation[] = [
      ...operations,
      ...(positionPlacements.length ? [{ op: "position_clips" as const, placements: positionPlacements }] : []),
    ];
    const carried = addLinkedRiderCarry(document, plannedOperations, input.linkageEnabled, indexes, movingIds);
    if (operationLimitExceeded(carried.operations)) return noPlan("一次编辑的操作超过上限");
    const leadPosition = carried.placements.find(item => item.clipId === leadClipId) ?? {
      clipId: leadClipId,
      trackId: targetTrackId,
      startUs: leadStart,
    };
    return { operations: carried.operations, placements: carried.placements, lead: leadPosition };
  }

  // Main-track magnet has its own canonical reorder/rider planner. Explicit clip edges and Replace are handled below.
  if (!replaceTarget && !explicitInsert && !hasConflict && input.mainTrackMagnet && sources.length === 1 &&
      (lead.track_id === "V1" || targetTrackId === "V1")) {
    const magnetic = planMagneticDrop(document, lead.clip_id, targetTrackId, input.pointerTimeUs, targetStart, input.linkageEnabled);
    if (magnetic.reason) return noPlan(magnetic.reason);
    const positions = magnetic.operations.flatMap(operation => operation.op === "position_clip"
      ? [{ clipId: operation.clip_id, trackId: operation.track_id ?? lead.track_id, startUs: operation.timeline_start_us }]
      : operation.op === "position_clips" ? operation.placements.map(item => ({
        clipId: item.clip_id,
        trackId: item.track_id ?? clipsById.get(item.clip_id)?.track_id ?? lead.track_id,
        startUs: item.timeline_start_us,
      })) : []);
    const moved = positions.find(item => item.clipId === lead.clip_id) ?? { clipId: lead.clip_id, trackId: targetTrackId, startUs: targetStart };
    return { operations: magnetic.operations, placements: positions, lead: moved };
  }

  if (!replaceTarget && effectiveMode === "place") {
    const placements = sources.flatMap(source => {
      const position = proposed.get(source.clip_id)!;
      if (position.track_id === source.track_id && position.timeline_start_us === source.timeline_start_us) return [];
      return [{ clip_id: source.clip_id, track_id: position.track_id, timeline_start_us: position.timeline_start_us }];
    });
    if (placements.length) operations.push({ op: "position_clips", placements });
    const leadPosition = proposed.get(leadClipId as TimelineClip["clip_id"])!;
    const carried = input.linkageEnabled && sources.some(source => source.track_id === "V1")
      ? addLinkedRiderCarry(document, operations, true, indexes, movingIds)
      : { operations, placements: placements.map(item => ({ clipId: item.clip_id, trackId: item.track_id, startUs: item.timeline_start_us })) };
    if (operationLimitExceeded(carried.operations)) return noPlan("一次编辑的操作超过上限");
    return {
      operations: carried.operations,
      placements: carried.placements,
      lead: carried.placements.find(item => item.clipId === leadClipId) ?? { clipId: leadClipId, trackId: leadPosition.track_id, startUs: leadPosition.timeline_start_us },
    };
  }

  // A single implicit Insert on its existing non-main lane only closes the source gap,
  // opens the same width at the insertion point, and places the source there. Avoid building
  // a full base-position Map and scanning it in separate close/insert/change passes; the lane
  // index is sorted, so each unaffected clip can be resolved and emitted in one linear pass.
  if (!replaceTarget && !input.copyOnStart && !openLane && effectiveMode === "insert" && insertAtUs === null &&
      sources.length === 1 && lead.track_id === targetTrackId && targetTrackId !== "V1" && !clipsByLinkGroup.size) {
    const lane = clipsByTrack.get(targetTrackId) ?? [];
    const leadDuration = duration(lead);
    const sourceEndUs = lead.timeline_end_us;
    let insertionStartUs = trackInsertPointExcluding(lane, input.pointerTimeUs, targetStart, movingIds);
    if (insertionStartUs >= sourceEndUs) insertionStartUs -= leadDuration;
    else if (insertionStartUs > lead.timeline_start_us) insertionStartUs = lead.timeline_start_us;

    const changed: Array<{ clip_id: TimelineClip["clip_id"]; track_id: string; timeline_start_us: number }> = [];
    const placements: Array<{ clipId: string; trackId: string; startUs: number }> = [];
    for (const item of lane) {
      if (item.clip_id === lead.clip_id) continue;
      let startUs = item.timeline_start_us;
      if (item.timeline_start_us >= sourceEndUs) {
        if (isLocked(lockedIds, tracksById, item)) return noPlan("Insert 会移动锁定片段");
        startUs = Math.max(0, startUs - leadDuration);
      }
      if (startUs >= insertionStartUs) {
        if (isLocked(lockedIds, tracksById, item)) return noPlan("Insert 会移动锁定片段");
        startUs += leadDuration;
      }
      if (startUs === item.timeline_start_us) continue;
      changed.push({ clip_id: item.clip_id, track_id: item.track_id, timeline_start_us: startUs });
      placements.push({ clipId: item.clip_id, trackId: item.track_id, startUs });
    }
    if (insertionStartUs !== lead.timeline_start_us) {
      changed.push({ clip_id: lead.clip_id, track_id: targetTrackId, timeline_start_us: insertionStartUs });
      placements.push({ clipId: lead.clip_id, trackId: targetTrackId, startUs: insertionStartUs });
    }
    const operations: TimelinePatchOperation[] = changed.length ? [{ op: "position_clips", placements: changed }] : [];
    const carried = input.linkageEnabled
      ? addLinkedRiderCarry(document, operations, true, indexes, movingIds)
      : { operations, placements: placements };
    if (operationLimitExceeded(carried.operations)) return noPlan("一次编辑的操作超过上限");
    return {
      operations: carried.operations,
      placements: carried.placements,
      lead: carried.placements.find(item => item.clipId === lead.clip_id) ?? { clipId: lead.clip_id, trackId: targetTrackId, startUs: insertionStartUs },
    };
  }

  const removedIds = new Set(movingIds);
  if (replaceTarget) removedIds.add(replaceTarget.clip_id);
  const movedStarts = new Map<string, { track_id: string; timeline_start_us: number }>(sources.map(source => [source.clip_id, {
    track_id: destBySourceTrack.get(source.track_id) ?? targetTrackId,
    timeline_start_us: Math.max(0, targetStart + (offsets.get(source.clip_id) ?? 0)),
  }]));
  const closeEverySourceTrack = effectiveMode === "insert" && insertAtUs == null;
  const closeMainTrack = input.mainTrackMagnet && sources.some(source => source.track_id === "V1");
  const closedTrackIds = new Set(sources.filter(source => closeEverySourceTrack || (closeMainTrack && source.track_id === "V1")).map(source => source.track_id));
  const affectedTrackIds = new Set([targetTrackId, ...closedTrackIds, ...[...movedStarts.values()].map(item => item.track_id)]);
  const base = new Map<string, { track_id: string; timeline_start_us: number }>();
  for (const trackId of affectedTrackIds) for (const clip of clipsByTrack.get(trackId) ?? []) {
    if (removedIds.has(clip.clip_id)) continue;
    base.set(clip.clip_id, { track_id: clip.track_id, timeline_start_us: clip.timeline_start_us });
  }
  const spanStart = Math.min(...[...movedStarts.values()].map(item => item.timeline_start_us));
  const spanEnd = Math.max(...sources.map(source => movedStarts.get(source.clip_id)!.timeline_start_us + duration(source)));
  let spanWidth = spanEnd - spanStart;

  if (replaceTarget) {
    const diff = duration(lead) - duration(replaceTarget);
    const ripple = diff > 0 || (replaceTarget.track_id === "V1" && input.mainTrackMagnet && diff !== 0);
    if (ripple) for (const [id, position] of base) {
      const item = clipsById.get(id)!;
      if (position.track_id !== targetTrackId || item.timeline_start_us < replaceTarget.timeline_end_us || diff === 0) continue;
      if (isLocked(lockedIds, tracksById, item)) return noPlan("替换会移动锁定片段");
      position.timeline_start_us = Math.max(0, position.timeline_start_us + diff);
    }
  } else if (effectiveMode === "insert") {
    const minimumOffsetUs = Math.min(0, ...offsets.values());
    const closeByTrack = new Map<string, Array<{ start: number; end: number }>>();
    for (const source of sources) if (closeEverySourceTrack || (closeMainTrack && source.track_id === "V1")) {
      const spans = closeByTrack.get(source.track_id) ?? [];
      spans.push({ start: source.timeline_start_us, end: source.timeline_end_us });
      closeByTrack.set(source.track_id, spans);
    }
    let insertionStart = insertAtUs ?? trackInsertPoint(
      clipsByTrack.get(targetTrackId) ?? [], input.pointerTimeUs, targetStart + minimumOffsetUs, movingIds,
    );
    for (const [trackId, raw] of closeByTrack) {
      const cuts = mergeSpans(raw);
      const shiftByAt = removedWidthBefore(cuts);
      if (trackId === targetTrackId) for (const cut of cuts) {
        if (insertionStart >= cut.end) insertionStart -= cut.end - cut.start;
        else if (insertionStart > cut.start) insertionStart = cut.start;
      }
      for (const [id, position] of base) {
        if (position.track_id !== trackId) continue;
        const item = clipsById.get(id)!;
        const shift = shiftByAt(item.timeline_start_us);
        if (!shift) continue;
        if (isLocked(lockedIds, tracksById, item)) return noPlan("Insert 会移动锁定片段");
        position.timeline_start_us = Math.max(0, position.timeline_start_us - shift);
      }
    }
    let insertionLeadStart = insertionStart - minimumOffsetUs;
    for (const source of sources) movedStarts.set(source.clip_id, {
      ...movedStarts.get(source.clip_id)!,
      timeline_start_us: Math.max(0, insertionLeadStart + (offsets.get(source.clip_id) ?? 0)),
    });
    const packedMain = input.mainTrackMagnet && targetTrackId === "V1"
      ? sources.filter(source => (destBySourceTrack.get(source.track_id) ?? targetTrackId) === "V1").sort((a, b) => a.timeline_start_us - b.timeline_start_us)
      : [];
    if (packedMain.length) {
      let cursor = insertionStart;
      for (const source of packedMain) {
        movedStarts.get(source.clip_id)!.timeline_start_us = cursor;
        if (source.clip_id === leadClipId) insertionLeadStart = cursor;
        cursor += duration(source);
      }
      spanWidth = cursor - insertionStart;
      for (const source of sources) if (!packedMain.includes(source)) {
        movedStarts.get(source.clip_id)!.timeline_start_us = Math.max(0, insertionLeadStart + (offsets.get(source.clip_id) ?? 0));
      }
    }
    const insertRoomStart = insertionStart;
    const destinationTracks = packedMain.length
      ? new Set(["V1"])
      : new Set([...movedStarts.values()].map(item => item.track_id));
    for (const [id, position] of base) {
      if (!destinationTracks.has(position.track_id)) continue;
      if (position.timeline_start_us < insertRoomStart) continue;
      const item = clipsById.get(id)!;
      if (isLocked(lockedIds, tracksById, item)) return noPlan("Insert 会移动锁定片段");
      position.timeline_start_us += spanWidth;
    }
  }

  for (const [id, position] of movedStarts) base.set(id, position);
  const changed: Array<{ clip_id: TimelineClip["clip_id"]; track_id: string; timeline_start_us: number }> = [];
  for (const [id, position] of base) {
    const original = clipsById.get(id);
    if (!original || (original.track_id === position.track_id && original.timeline_start_us === position.timeline_start_us)) continue;
    changed.push({ clip_id: original.clip_id, track_id: position.track_id, timeline_start_us: position.timeline_start_us });
  }

  if (replaceTarget) operations.push({ op: "remove_clip", clip_id: replaceTarget.clip_id, ignore_link: true });
  if (changed.length) operations.push({ op: "position_clips", placements: changed });
  const carried = input.linkageEnabled
    ? addLinkedRiderCarry(document, operations, true, indexes, movingIds)
    : { operations, placements: changed.map(item => ({ clipId: item.clip_id, trackId: item.track_id, startUs: item.timeline_start_us })) };
  const placements = carried.placements;
  const leadPlacement = placements.find(item => item.clipId === leadClipId) ?? {
    clipId: leadClipId,
    trackId: movedStarts.get(leadClipId)?.track_id ?? targetTrackId,
    startUs: movedStarts.get(leadClipId)?.timeline_start_us ?? targetStart,
  };
  if (operationLimitExceeded(carried.operations)) return noPlan("一次编辑的操作超过上限");
  return { operations: carried.operations, placements, lead: leadPlacement };
}
