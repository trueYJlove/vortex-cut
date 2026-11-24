import type { TimelineClip, TimelineDocument, TimelinePatchOperation } from "@aivideo/contracts";
import type { SpeedPreviewTarget, TrimEdge } from "./types.js";
import { planMagneticSpeed } from "./magnetic-plan.js";

const SPEED_MIN_MILLI = 100;
const SPEED_MAX_MILLI = 100_000;

export interface SpeedEdgePlan {
  operations: TimelinePatchOperation[];
  targets: SpeedPreviewTarget[];
  speedMilli: number;
  reason?: string;
}

export function speedMilliForLength(sourceDurationUs: number, timelineDurationUs: number, exact = false): number {
  if (!(sourceDurationUs > 0) || !(timelineDurationUs > 0)) return SPEED_MAX_MILLI;
  const raw = sourceDurationUs * 1_000 / timelineDurationUs;
  // Freehand motion uses OpenFilm's three significant figures. A snapped or
  // constrained edge uses the nearest representable 0.001x value so integer
  // microsecond duration rounding preserves the landing instead of rounding
  // back to the prior three-significant-figure speed.
  const rounded = exact ? Math.round(raw) : Math.round(Number((raw / 1_000).toPrecision(3)) * 1_000);
  return Math.max(SPEED_MIN_MILLI, Math.min(SPEED_MAX_MILLI, rounded));
}

const sourceDurationOf = (clip: TimelineClip): number | null => {
  if (clip.asset_kind !== "video" && clip.asset_kind !== "audio") return null;
  const start = clip.source_start_us;
  const end = clip.source_end_us;
  return start !== null && start !== undefined && end !== null && end !== undefined && end > start ? end - start : null;
};

const durationAtSpeed = (clip: TimelineClip, speedMilli: number): number => {
  const sourceDurationUs = sourceDurationOf(clip);
  return sourceDurationUs === null ? clip.timeline_end_us - clip.timeline_start_us : Math.round(sourceDurationUs * 1_000 / speedMilli);
};

function minimumNoRippleSpeed(document: TimelineDocument, targets: readonly TimelineClip[], edge: TrimEdge): number {
  const targetIds = new Set(targets.map(clip => clip.clip_id));
  let minimum = SPEED_MIN_MILLI;
  for (const clip of targets) {
    const sourceDurationUs = sourceDurationOf(clip);
    if (sourceDurationUs === null) continue;
    const neighbors = document.clips.filter(other => other.track_id === clip.track_id && !targetIds.has(other.clip_id));
    const availableUs = edge === "right"
      ? Math.max(0, Math.min(...neighbors.filter(other => other.timeline_start_us >= clip.timeline_end_us).map(other => other.timeline_start_us - clip.timeline_end_us), Number.MAX_SAFE_INTEGER))
      : Math.max(0, Math.min(...neighbors.filter(other => other.timeline_end_us <= clip.timeline_start_us).map(other => clip.timeline_start_us - other.timeline_end_us), Number.MAX_SAFE_INTEGER));
    if (availableUs === Number.MAX_SAFE_INTEGER) continue;
    const maximumDurationUs = clip.timeline_end_us - clip.timeline_start_us + availableUs;
    minimum = Math.max(minimum, Math.ceil(sourceDurationUs * 1_000 / maximumDurationUs));
  }
  return Math.min(SPEED_MAX_MILLI, minimum);
}

/**
 * Plan OpenFilm's Speed-edge edit as one atomic TimelinePatch. The selected source window is retained;
 * the requested edge determines which timeline edge stays still. Main-track magnet speed edits keep
 * the clip's start and reuse the existing ripple/rider planner for everything that follows.
 */
export function planTimelineSpeedEdge(
  document: TimelineDocument,
  clip: TimelineClip,
  requestedSpeedMilli: number,
  edge: TrimEdge,
  magnet: boolean,
  linkage: boolean,
  ignoreLink = false,
): SpeedEdgePlan {
  const mainRipple = magnet && clip.track_id === "V1" && clip.asset_kind === "video";
  const effectiveEdge: TrimEdge = mainRipple ? "right" : edge;
  const group = !ignoreLink && clip.link_group_id
    ? document.clips.filter(item => item.link_group_id === clip.link_group_id)
    : [clip];
  const lockedTracks = new Set(document.tracks.filter(track => track.locked).map(track => track.id));
  const lockedClips = new Set(document.locked_elements ?? []);
  const writable = group.filter(item => !lockedTracks.has(item.track_id) && !lockedClips.has(item.clip_id) && sourceDurationOf(item) !== null);
  if (!writable.some(item => item.clip_id === clip.clip_id)) return { operations: [], targets: [], speedMilli: clip.speed_milli ?? 1_000, reason: "片段已锁定或素材源区间不可变速" };
  const requested = Math.max(SPEED_MIN_MILLI, Math.min(SPEED_MAX_MILLI, Math.round(requestedSpeedMilli)));
  const speedMilli = Math.max(requested, mainRipple ? SPEED_MIN_MILLI : minimumNoRippleSpeed(document, writable, effectiveEdge));
  const clippedSpeed = Math.min(SPEED_MAX_MILLI, speedMilli);
  const targetById = new Map<string, SpeedPreviewTarget>();
  const placements = new Map<string, number>();
  const extraOperations: TimelinePatchOperation[] = [];

  if (mainRipple) {
    // OpenFilm ripples every track represented by the edited linked group. Pass
    // the original lead so the planner includes linked partner tracks when it
    // chooses which following clips move.
    const ripplePlan = planMagneticSpeed(document, clip, clippedSpeed, true, linkage);
    if (!ripplePlan.operations.length && ripplePlan.reason) return { operations: [], targets: [], speedMilli: clippedSpeed, reason: ripplePlan.reason };
    for (const operation of ripplePlan.operations) {
      if (operation.op === "position_clips") for (const item of operation.placements) placements.set(item.clip_id, item.timeline_start_us);
      else if (operation.op !== "set_speed") extraOperations.push(operation);
    }
  }

  const speedOperations: TimelinePatchOperation[] = [];
  for (const member of writable) {
    const sourceDurationUs = sourceDurationOf(member);
    if (sourceDurationUs === null) continue;
    const durationUs = durationAtSpeed(member, clippedSpeed);
    const startUs = effectiveEdge === "left"
      ? member.timeline_end_us - durationUs
      : member.timeline_start_us;
    if (startUs < 0) return { operations: [], targets: [], speedMilli: clippedSpeed, reason: "变速会让片段起点早于时间线起点" };
    speedOperations.push({ op: "set_speed", clip_id: member.clip_id, speed_milli: clippedSpeed, ripple: false });
    const coreStartAfterSpeed = member.asset_kind === "audio"
      ? member.timeline_end_us - durationUs
      : member.timeline_start_us;
    if (startUs !== coreStartAfterSpeed) placements.set(member.clip_id, startUs);
    targetById.set(member.clip_id, {
      clipId: member.clip_id,
      trackId: member.track_id,
      startUs,
      endUs: startUs + durationUs,
      speedMilli: clippedSpeed,
      originalStartUs: member.timeline_start_us,
      originalEndUs: member.timeline_end_us,
    });
  }

  // Every displaced clip is part of the same live preview and patch. The planner's position
  // entries include main-track followers and linked audio/video riders when linkage is enabled.
  for (const [clipId, startUs] of placements) {
    const member = document.clips.find(item => item.clip_id === clipId);
    if (!member) continue;
    const existing = targetById.get(clipId);
    const durationUs = existing ? existing.endUs - existing.startUs : member.timeline_end_us - member.timeline_start_us;
    targetById.set(clipId, {
      clipId: member.clip_id,
      trackId: member.track_id,
      startUs,
      endUs: startUs + durationUs,
      speedMilli: existing?.speedMilli ?? member.speed_milli ?? 1_000,
      originalStartUs: member.timeline_start_us,
      originalEndUs: member.timeline_end_us,
    });
  }

  const finalStarts = new Map([...targetById].map(([id, target]) => [id, target.startUs]));
  const finalDurations = new Map([...targetById].map(([id, target]) => [id, target.endUs - target.startUs]));
  const visualByTrack = new Map<string, Array<{ start: number; end: number }>>();
  for (const item of document.clips) {
    if (item.asset_kind === "audio") continue;
    const start = finalStarts.get(item.clip_id) ?? item.timeline_start_us;
    const duration = finalDurations.get(item.clip_id) ?? item.timeline_end_us - item.timeline_start_us;
    const intervals = visualByTrack.get(item.track_id) ?? [];
    intervals.push({ start, end: start + duration });
    visualByTrack.set(item.track_id, intervals);
  }
  if ([...visualByTrack.values()].some(items => items.sort((a, b) => a.start - b.start).some((item, index) => index > 0 && item.start < items[index - 1]!.end))) {
    return { operations: [], targets: [], speedMilli: clippedSpeed, reason: "变速后同轨视频片段会重叠" };
  }
  if (placements.size) {
    for (const [clipId, startUs] of placements) {
      const member = document.clips.find(item => item.clip_id === clipId);
      if (member && (lockedClips.has(member.clip_id) || lockedTracks.has(member.track_id) || startUs < 0)) {
        return { operations: [], targets: [], speedMilli: clippedSpeed, reason: "磁吸变速会移动锁定片段或越过时间线起点" };
      }
    }
  }
  const positionOperation: TimelinePatchOperation | null = placements.size
    ? { op: "position_clips", placements: [...placements].map(([clipId, timeline_start_us]) => ({ clip_id: clipId as TimelineClip["clip_id"], timeline_start_us })) }
    : null;
  const changedTargets = [...targetById.values()].filter(target => target.startUs !== target.originalStartUs || target.endUs !== target.originalEndUs || target.speedMilli !== (document.clips.find(item => item.clip_id === target.clipId)?.speed_milli ?? 1_000));
  if (!changedTargets.length && !extraOperations.length) return { operations: [], targets: [], speedMilli: clippedSpeed };
  const operations = [...speedOperations, ...(positionOperation ? [positionOperation] : []), ...extraOperations];
  if (operations.length > 100) return { operations: [], targets: [], speedMilli: clippedSpeed, reason: "一次编辑的操作超过上限" };
  return {
    operations,
    targets: changedTargets,
    speedMilli: clippedSpeed,
  };
}
