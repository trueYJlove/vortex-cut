import type {
  TimelineCaption,
  TimelineClip,
  TimelineDocument,
  TimelinePatchOperation,
} from "@aivideo/contracts";
import type { AdvancedEditMode, AdvancedEditPlan } from "../../advanced-edit.js";
import {
  MIN_CLIP_US,
  SNAP_PX,
  snapCandidates,
  snapTimeToFrame,
  snapValue,
  timelineGestureDeltaUs,
} from "../../geometry.js";
import { planMagneticImageTrim, planMagneticTrim } from "../../magnetic-plan.js";
import type { TimelineMarker } from "../../markers.js";
import { planTimelineSpeedEdge, speedMilliForLength } from "../../speed-edge-plan.js";
import type { ClipRenderRect, TimelineInteraction, TrimEdge } from "../../types.js";

/** Minimum caption duration (µs), mirroring core MIN_CAPTION_US. */
export const MIN_CAPTION_US = 200_000;

export type EdgeEditInteraction = Extract<TimelineInteraction, { kind: "edge-edit" }>;
export type SpeedInteraction = Extract<TimelineInteraction, { kind: "speed" }>;
export type TrimInteraction = Extract<TimelineInteraction, { kind: "trim" }>;
export type CaptionTrimInteraction = Extract<TimelineInteraction, { kind: "caption-trim" }>;
export type CaptionMoveInteraction = Extract<TimelineInteraction, { kind: "caption-move" }>;

const canChangeClipSpeed = (clip: TimelineClip): boolean =>
  (clip.asset_kind === "video" || clip.asset_kind === "audio")
  && clip.source_start_us != null
  && clip.source_end_us != null
  && clip.source_end_us > clip.source_start_us;

export function stepAdvancedEdgeEdit(opts: {
  active: EdgeEditInteraction;
  x: number;
  scrollX: number;
  pixelsPerSecond: number;
  frameUs: number;
  snappingEnabled: boolean;
  clips: readonly TimelineClip[];
  clipRects: ClipRenderRect[];
  playheadUs: number;
  markers: readonly TimelineMarker[];
  getAdvancedEditPlan: (mode: AdvancedEditMode, clipIds: readonly string[], deltaUs: number) => AdvancedEditPlan | null;
}): { interaction: EdgeEditInteraction; feedback: string } | { blockedReason: string } {
  const {
    active,
    x,
    scrollX,
    pixelsPerSecond,
    frameUs,
    snappingEnabled,
    clips,
    clipRects,
    playheadUs,
    markers,
    getAdvancedEditPlan,
  } = opts;
  const rawDeltaUs = timelineGestureDeltaUs(x, active.startX, scrollX, active.startScrollX, pixelsPerSecond);
  let requestedDeltaUs = rawDeltaUs;
  let snapUs: number | null = null;
  if (active.mode !== "slip" && snappingEnabled) {
    const originClipId = active.mode === "roll" ? active.clipIds[0] : active.clipIds[1];
    const originClip = clips.find((clip) => clip.clip_id === originClipId);
    if (originClip) {
      const originUs = active.mode === "roll" ? originClip.timeline_end_us : originClip.timeline_start_us;
      const candidates = [
        ...snapCandidates(clipRects, playheadUs, new Set(active.clipIds)),
        ...markers.map((marker) => marker.timeUs),
      ];
      const snapped = snapValue(originUs + rawDeltaUs, candidates, (SNAP_PX / pixelsPerSecond) * 1_000_000);
      requestedDeltaUs = snapped - originUs;
      if (Math.abs(snapped - (originUs + rawDeltaUs)) > 1) snapUs = snapped;
    }
  }
  const plan = getAdvancedEditPlan(active.mode, active.clipIds, requestedDeltaUs);
  if (!plan || plan.reason) {
    return { blockedReason: plan?.reason ?? "编辑无法完成" };
  }
  const next: EdgeEditInteraction = {
    ...active,
    deltaUs: plan.deltaUs,
    targets: plan.targets,
    operations: plan.operations,
    snapUs: snapUs !== null && Math.abs(plan.deltaUs - requestedDeltaUs) < frameUs ? snapUs : null,
  };
  const label = active.mode === "roll" ? "滚动修剪" : active.mode === "slip" ? "滑移素材" : "滑动片段";
  const feedback = `${label} ${plan.deltaUs >= 0 ? "+" : "−"}${Math.abs(plan.deltaUs / 1_000_000).toFixed(2)} 秒`;
  return { interaction: next, feedback };
}

export function stepSpeedEdgeGesture(opts: {
  active: SpeedInteraction;
  x: number;
  scrollX: number;
  pixelsPerSecond: number;
  fpsNum: number;
  fpsDen: number;
  frameUs: number;
  snappingEnabled: boolean;
  mainTrackMagnet: boolean;
  linkageEnabled: boolean;
  document?: TimelineDocument;
  clips: readonly TimelineClip[];
  clipRects: ClipRenderRect[];
  playheadUs: number;
  markers: readonly TimelineMarker[];
}): { interaction: SpeedInteraction; feedback: string; invalid?: boolean } | null {
  const {
    active,
    x,
    scrollX,
    pixelsPerSecond,
    fpsNum,
    fpsDen,
    frameUs,
    snappingEnabled,
    mainTrackMagnet,
    linkageEnabled,
    document,
    clips,
    clipRects,
    playheadUs,
    markers,
  } = opts;
  const clip = clips.find((item) => item.clip_id === active.clipId);
  if (!clip || !canChangeClipSpeed(clip) || !document) return null;
  const mainRipple = mainTrackMagnet && clip.track_id === "V1" && clip.asset_kind === "video";
  const effectiveEdge: TrimEdge = mainRipple ? "right" : active.edge;
  const pointerDeltaUs = timelineGestureDeltaUs(x, active.startX, scrollX, active.startScrollX, pixelsPerSecond);
  const effectiveDeltaUs = mainRipple && active.edge === "left" ? -pointerDeltaUs : pointerDeltaUs;
  const originalEdgeUs = effectiveEdge === "left" ? active.originalTimelineStartUs : active.originalTimelineEndUs;
  const rawEdgeUs = originalEdgeUs + effectiveDeltaUs;
  const movingIds = new Set(active.linkedClipIds);
  const candidates = snappingEnabled
    ? [...snapCandidates(clipRects, playheadUs, movingIds), ...markers.map((marker) => marker.timeUs)].filter(
        (candidate) => Math.abs(candidate - originalEdgeUs) >= 1_000,
      )
    : [];
  const snappedEdgeUs = snapValue(rawEdgeUs, candidates, (SNAP_PX / pixelsPerSecond) * 1_000_000);
  const didSnap = Math.abs(snappedEdgeUs - rawEdgeUs) > 1;
  let targetEdgeUs = didSnap ? snappedEdgeUs : snapTimeToFrame(rawEdgeUs, fpsNum, fpsDen);
  if (!mainRipple) {
    const groupIds = new Set(active.linkedClipIds);
    const neighbors = clips.filter((item) => item.track_id === clip.track_id && !groupIds.has(item.clip_id));
    if (effectiveEdge === "left") {
      const previousEnd = Math.max(0, ...neighbors.filter((item) => item.timeline_end_us <= active.originalTimelineStartUs).map((item) => item.timeline_end_us));
      targetEdgeUs = Math.max(previousEnd, Math.min(active.originalTimelineEndUs - 1, targetEdgeUs));
    } else {
      const nextStart = Math.min(Number.MAX_SAFE_INTEGER, ...neighbors.filter((item) => item.timeline_start_us >= active.originalTimelineEndUs).map((item) => item.timeline_start_us));
      targetEdgeUs = Math.max(active.originalTimelineStartUs + 1, Math.min(nextStart, targetEdgeUs));
    }
  }
  const targetLengthUs = effectiveEdge === "left"
    ? active.originalTimelineEndUs - targetEdgeUs
    : targetEdgeUs - active.originalTimelineStartUs;
  const sourceDurationUs = clip.source_end_us! - clip.source_start_us!;
  const edgeHeld = Math.abs(targetEdgeUs - snapTimeToFrame(rawEdgeUs, fpsNum, fpsDen)) >= 0.5;
  const requestedSpeedMilli = speedMilliForLength(sourceDurationUs, targetLengthUs, didSnap || edgeHeld);
  const plan = planTimelineSpeedEdge(document, clip, requestedSpeedMilli, active.edge, mainTrackMagnet, linkageEnabled, active.ignoreLink);
  if (plan.reason) {
    return {
      invalid: true,
      feedback: plan.reason,
      interaction: {
        ...active,
        targetSpeedMilli: active.originalSpeedMilli,
        targetTimelineStartUs: active.originalTimelineStartUs,
        targetTimelineEndUs: active.originalTimelineEndUs,
        targets: [],
        operations: [],
        snapUs: null,
      },
    };
  }
  const lead = plan.targets.find((item) => item.clipId === active.clipId);
  if (!lead && plan.operations.length) return null;
  const landedEdgeUs = lead ? (effectiveEdge === "left" ? lead.startUs : lead.endUs) : originalEdgeUs;
  const snapUs = didSnap && Math.abs(landedEdgeUs - snappedEdgeUs) <= frameUs / 2 ? snappedEdgeUs : null;
  return {
    feedback: `${(plan.speedMilli / 1_000).toFixed(2)}x`,
    interaction: {
      ...active,
      targetSpeedMilli: plan.speedMilli,
      targetTimelineStartUs: lead?.startUs ?? active.originalTimelineStartUs,
      targetTimelineEndUs: lead?.endUs ?? active.originalTimelineEndUs,
      targets: plan.targets,
      operations: plan.operations,
      snapUs,
    },
  };
}

export function stepClipTrimGesture(opts: {
  active: TrimInteraction;
  x: number;
  scrollX: number;
  pixelsPerSecond: number;
  fpsNum: number;
  fpsDen: number;
  snappingEnabled: boolean;
  mainTrackMagnet: boolean;
  clips: readonly TimelineClip[];
  clipRects: ClipRenderRect[];
  playheadUs: number;
  markers: readonly TimelineMarker[];
  assetDurationById: ReadonlyMap<string, number>;
}): TrimInteraction | null {
  const {
    active,
    x,
    scrollX,
    pixelsPerSecond,
    fpsNum,
    fpsDen,
    snappingEnabled,
    mainTrackMagnet,
    clips,
    clipRects,
    playheadUs,
    markers,
    assetDurationById,
  } = opts;
  const clip = clips.find((c) => c.clip_id === active.clipId);
  if (!clip) return null;
  const deltaUs = timelineGestureDeltaUs(x, active.startX, scrollX, active.startScrollX, pixelsPerSecond);
  const threshold = (SNAP_PX / pixelsPerSecond) * 1_000_000;
  const movingIds = new Set(active.linkedClipIds);
  const originalEdgeUs = active.edge === "left" ? clip.timeline_start_us : clip.timeline_end_us;
  const candidates = snappingEnabled
    ? [...snapCandidates(clipRects, playheadUs, movingIds), ...markers.map((marker) => marker.timeUs)].filter(
        (candidate) => Math.abs(candidate - originalEdgeUs) >= 1000,
      )
    : [];
  const rawEdgeUs = originalEdgeUs + deltaUs;
  const snappedEdgeUs = snapValue(rawEdgeUs, candidates, threshold);
  const snapped = Math.abs(snappedEdgeUs - rawEdgeUs) > 1;
  const desiredEdgeUs = snapped ? snappedEdgeUs : snapTimeToFrame(rawEdgeUs, fpsNum, fpsDen);

  let lowerDeltaUs = -Number.MAX_SAFE_INTEGER;
  let upperDeltaUs = Number.MAX_SAFE_INTEGER;
  const mainMagnetRipple = mainTrackMagnet && clip.track_id === "V1";

  if (clip.asset_kind === "image") {
    for (const memberId of active.linkedClipIds) {
      const member = clips.find((item) => item.clip_id === memberId);
      if (!member) continue;
      const durationUs = member.timeline_end_us - member.timeline_start_us;
      if (active.edge === "left") {
        lowerDeltaUs = Math.max(lowerDeltaUs, -member.timeline_start_us);
        upperDeltaUs = Math.min(upperDeltaUs, durationUs - MIN_CLIP_US);
        if (!mainMagnetRipple) {
          for (const other of clips) {
            if (other.track_id === member.track_id && !movingIds.has(other.clip_id) && other.timeline_start_us < member.timeline_start_us) {
              lowerDeltaUs = Math.max(lowerDeltaUs, Math.min(other.timeline_end_us, member.timeline_start_us) - member.timeline_start_us);
            }
          }
        }
      } else {
        lowerDeltaUs = Math.max(lowerDeltaUs, MIN_CLIP_US - durationUs);
        if (!mainMagnetRipple) {
          for (const other of clips) {
            if (other.track_id === member.track_id && !movingIds.has(other.clip_id) && other.timeline_start_us >= member.timeline_end_us) {
              upperDeltaUs = Math.min(upperDeltaUs, Math.max(other.timeline_start_us, member.timeline_end_us) - member.timeline_end_us);
            }
          }
        }
      }
    }
    const edgeDeltaUs = Math.max(lowerDeltaUs, Math.min(upperDeltaUs, desiredEdgeUs - originalEdgeUs));
    const targetTimelineEdgeUs = originalEdgeUs + edgeDeltaUs;
    return {
      ...active,
      targetTimelineStartUs: active.edge === "left" ? targetTimelineEdgeUs : active.originalTimelineStartUs,
      targetTimelineEndUs: active.edge === "right" ? targetTimelineEdgeUs : active.originalTimelineEndUs,
      snapUs: snapped && Math.abs(targetTimelineEdgeUs - snappedEdgeUs) <= 1 ? snappedEdgeUs : null,
    };
  }

  for (const memberId of active.linkedClipIds) {
    const member = clips.find((item) => item.clip_id === memberId);
    if (!member) continue;
    const durationUs = member.timeline_end_us - member.timeline_start_us;
    const speed = Math.max(1, member.speed_milli ?? 1000);
    const sourceToTimeline = (sourceUs: number) => (member.asset_kind !== "image" ? Math.round((sourceUs * 1000) / speed) : sourceUs);
    if (active.edge === "left") {
      lowerDeltaUs = Math.max(lowerDeltaUs, -member.timeline_start_us, -sourceToTimeline(member.source_start_us ?? 0));
      upperDeltaUs = Math.min(upperDeltaUs, durationUs - MIN_CLIP_US);
      if (!mainMagnetRipple) {
        for (const other of clips) {
          if (other.track_id !== member.track_id || movingIds.has(other.clip_id)) continue;
          if (other.timeline_start_us < member.timeline_start_us) {
            const fence = Math.min(other.timeline_end_us, member.timeline_start_us);
            lowerDeltaUs = Math.max(lowerDeltaUs, fence - member.timeline_start_us);
          }
        }
      }
    } else {
      lowerDeltaUs = Math.max(lowerDeltaUs, MIN_CLIP_US - durationUs);
      const sourceDurationUs = assetDurationById.get(member.asset_id) ?? Number.MAX_SAFE_INTEGER;
      upperDeltaUs = Math.min(upperDeltaUs, sourceToTimeline(Math.max(0, sourceDurationUs - (member.source_end_us ?? sourceDurationUs))));
      if (!mainMagnetRipple) {
        for (const other of clips) {
          if (other.track_id !== member.track_id || movingIds.has(other.clip_id)) continue;
          if (other.timeline_start_us >= member.timeline_end_us) {
            const fence = Math.max(other.timeline_start_us, member.timeline_end_us);
            upperDeltaUs = Math.min(upperDeltaUs, fence - member.timeline_end_us);
          }
        }
      }
    }
  }
  const edgeDeltaUs = Math.max(lowerDeltaUs, Math.min(upperDeltaUs, desiredEdgeUs - originalEdgeUs));
  const targetTimelineEdgeUs = originalEdgeUs + edgeDeltaUs;
  const sourceDeltaUs = Math.round((edgeDeltaUs * Math.max(1, clip.speed_milli ?? 1000)) / 1000);
  const targetStartUs = active.edge === "left" ? Math.max(0, active.originalStartUs + sourceDeltaUs) : active.originalStartUs;
  const targetEndUs = active.edge === "left" ? active.originalEndUs : Math.max(targetStartUs + MIN_CLIP_US, active.originalEndUs + sourceDeltaUs);
  const snapUs = snapped && Math.abs(targetTimelineEdgeUs - snappedEdgeUs) <= 1 ? snappedEdgeUs : null;
  return { ...active, targetStartUs, targetEndUs, snapUs };
}

export function stepCaptionTrimGesture(opts: {
  active: CaptionTrimInteraction;
  x: number;
  scrollX: number;
  pixelsPerSecond: number;
  captions: readonly TimelineCaption[];
}): CaptionTrimInteraction | null {
  const { active, x, scrollX, pixelsPerSecond, captions } = opts;
  const caption = captions.find((c) => c.caption_id === active.captionId);
  if (!caption) return null;
  const deltaUs = timelineGestureDeltaUs(x, active.startX, scrollX, active.startScrollX, pixelsPerSecond);
  const sorted = [...captions].sort((a, b) => a.start_us - b.start_us);
  const idx = sorted.findIndex((c) => c.caption_id === active.captionId);
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const nextCap = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
  let targetStartUs = active.targetStartUs;
  let targetEndUs = active.targetEndUs;
  if (active.edge === "left") {
    const upper = active.originalEndUs - MIN_CAPTION_US;
    const lower = Math.max(0, prev ? prev.end_us : 0);
    targetStartUs = Math.max(lower, Math.min(upper, active.originalStartUs + deltaUs));
  } else {
    const lower = active.originalStartUs + MIN_CAPTION_US;
    const upper = nextCap ? nextCap.start_us : Number.MAX_SAFE_INTEGER;
    targetEndUs = Math.max(lower, Math.min(upper, active.originalEndUs + deltaUs));
  }
  return { ...active, targetStartUs, targetEndUs };
}

export function stepCaptionMoveGesture(opts: {
  active: CaptionMoveInteraction;
  x: number;
  scrollX: number;
  pixelsPerSecond: number;
  captions: readonly TimelineCaption[];
}): CaptionMoveInteraction | null {
  const { active, x, scrollX, pixelsPerSecond, captions } = opts;
  const caption = captions.find((c) => c.caption_id === active.captionId);
  if (!caption) return null;
  const deltaUs = timelineGestureDeltaUs(x, active.startX, scrollX, active.startScrollX, pixelsPerSecond);
  const durationUs = active.originalEndUs - active.originalStartUs;
  const sorted = [...captions].sort((a, b) => a.start_us - b.start_us);
  const idx = sorted.findIndex((c) => c.caption_id === active.captionId);
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const nextCap = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
  const targetStartUs = Math.max(
    0,
    Math.max(
      prev ? prev.end_us : 0,
      Math.min(active.originalStartUs + deltaUs, (nextCap ? nextCap.start_us : Number.MAX_SAFE_INTEGER) - durationUs),
    ),
  );
  return { ...active, targetStartUs, targetEndUs: targetStartUs + durationUs };
}

export function commitClipTrimGesture(opts: {
  active: TrimInteraction;
  clips: readonly TimelineClip[];
  document?: TimelineDocument;
  mainTrackMagnet: boolean;
  linkageEnabled: boolean;
  setToolbarFeedback: (feedback: string) => void;
  onPatch: (operations: TimelinePatchOperation[], summary: string) => Promise<void> | void;
}): "early-return" | void {
  const { active, clips, document, mainTrackMagnet, linkageEnabled, setToolbarFeedback, onPatch } = opts;
  const clip = clips.find((c) => c.clip_id === active.clipId);
  if (clip?.asset_kind === "image") {
    const edgeDeltaUs = active.edge === "left"
      ? active.targetTimelineStartUs - active.originalTimelineStartUs
      : active.targetTimelineEndUs - active.originalTimelineEndUs;
    if (Math.abs(edgeDeltaUs) >= 1000 && document) {
      const magnetic = mainTrackMagnet && clip.track_id === "V1";
      const plan = planMagneticImageTrim(document, clip, active.edge, Math.round(edgeDeltaUs), linkageEnabled, magnetic, active.ignoreLink);
      if (!plan.operations.length) setToolbarFeedback(plan.reason ?? "图片修剪无法完成");
      else void onPatch(plan.operations, magnetic ? "主轨磁吸修剪" : "修剪图片");
    }
    return "early-return";
  }
  const startChanged = Math.abs(active.targetStartUs - active.originalStartUs) >= 1000;
  const endChanged = Math.abs(active.targetEndUs - active.originalEndUs) >= 1000;
  if (clip && (startChanged || endChanged)) {
    const operations: TimelinePatchOperation[] = [
      {
        op: "trim_clip",
        clip_id: clip.clip_id,
        source_start_us: Math.round(active.targetStartUs),
        source_end_us: Math.round(active.targetEndUs),
        ...(active.ignoreLink ? { ignore_link: true } : {}),
      },
    ];
    if (mainTrackMagnet && clip.track_id === "V1" && document) {
      const plan = planMagneticTrim(document, clip, Math.round(active.targetStartUs), Math.round(active.targetEndUs), linkageEnabled, active.ignoreLink);
      if (!plan.operations.length) setToolbarFeedback(plan.reason ?? "磁吸修剪无法完成");
      else void onPatch(plan.operations, "主轨磁吸修剪");
    } else {
      void onPatch(operations, "修剪片段");
    }
  }
}
