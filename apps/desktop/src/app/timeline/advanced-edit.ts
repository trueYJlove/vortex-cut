import type { TimelineClip, TimelineClipId, TimelineDocument, TimelinePatchOperation } from "@aivideo/contracts";

export type AdvancedEditMode = "roll" | "slip" | "slide";
export type EdgeAnchor = "start" | "end" | "timeline";

export interface AdvancedEditTarget {
  clipId: TimelineClipId;
  sourceStartUs: number;
  sourceEndUs: number;
  timelineStartUs: number;
  timelineEndUs: number;
}

export interface AdvancedEditPlan {
  deltaUs: number;
  targets: AdvancedEditTarget[];
  operations: TimelinePatchOperation[];
  reason?: string;
}

interface EditAction {
  clip: TimelineClip;
  anchor: EdgeAnchor;
  shiftTimeline?: boolean;
}

const MIN_SOURCE_US = 100_000;

function speedOf(clip: TimelineClip): number {
  return clip.speed_milli ?? 1000;
}

function sourceBounds(action: EditAction, assetDurationUs: number): [number, number] {
  const start = action.clip.source_start_us;
  const end = action.clip.source_end_us;
  if (start == null || end == null) return [1, -1];
  if (action.anchor === "start") return [start + MIN_SOURCE_US - end, assetDurationUs - end];
  if (action.anchor === "end") return [-start, end - start - MIN_SOURCE_US];
  return [-start, assetDurationUs - end];
}

function sourceDeltaFor(deltaUs: number, speedMilli: number): number {
  return Math.round((deltaUs * speedMilli) / 1000);
}

function durationUs(startUs: number, endUs: number, speedMilli: number): number {
  return speedMilli === 1000 ? endUs - startUs : Math.max(1, Math.round(((endUs - startUs) * 1000) / speedMilli));
}

function anchoredTarget(action: EditAction, deltaUs: number): AdvancedEditTarget {
  const clip = action.clip;
  const sourceStartUs = clip.source_start_us ?? 0;
  const sourceEndUs = clip.source_end_us ?? 0;
  const sourceDelta = sourceDeltaFor(deltaUs, speedOf(clip));
  const nextSourceStart = action.anchor === "end" || action.anchor === "timeline"
    ? sourceStartUs + sourceDelta
    : sourceStartUs;
  const nextSourceEnd = action.anchor === "start" || action.anchor === "timeline"
    ? sourceEndUs + sourceDelta
    : sourceEndUs;
  const nextDuration = durationUs(nextSourceStart, nextSourceEnd, speedOf(clip));
  let timelineStartUs = clip.timeline_start_us;
  let timelineEndUs = clip.timeline_end_us;
  if (action.anchor === "start") timelineEndUs = timelineStartUs + nextDuration;
  else if (action.anchor === "end") timelineStartUs = timelineEndUs - nextDuration;
  else if (nextDuration !== clip.timeline_end_us - clip.timeline_start_us) {
    timelineEndUs = timelineStartUs + nextDuration;
  }
  if (action.shiftTimeline) {
    timelineStartUs += deltaUs;
    timelineEndUs += deltaUs;
  }
  return { clipId: clip.clip_id, sourceStartUs: nextSourceStart, sourceEndUs: nextSourceEnd, timelineStartUs, timelineEndUs };
}

function isLocked(document: TimelineDocument, clip: TimelineClip): boolean {
  return Boolean(document.locked_elements?.includes(clip.clip_id) || document.tracks.find(track => track.id === clip.track_id)?.locked);
}

function relatedClips(document: TimelineDocument, clip: TimelineClip): TimelineClip[] {
  return clip.link_group_id
    ? document.clips.filter(member => member.link_group_id === clip.link_group_id)
    : [clip];
}

function invalid(reason: string): AdvancedEditPlan {
  return { deltaUs: 0, targets: [], operations: [], reason };
}

/** Plan an OpenFilm-style roll, slip, or slide while leaving ordinary trim semantics untouched. */
export function planAdvancedEdit(
  document: TimelineDocument,
  mode: AdvancedEditMode,
  clipIds: readonly string[],
  requestedDeltaUs: number,
  frameUs: number,
  assetDurationById: ReadonlyMap<string, number>,
): AdvancedEditPlan {
  const expectedCount = mode === "roll" ? 2 : mode === "slide" ? 3 : 1;
  if (clipIds.length !== expectedCount || new Set(clipIds).size !== expectedCount) return invalid("请在同一轨道选择合适的片段")
  const clips = clipIds.map(id => document.clips.find(clip => clip.clip_id === id));
  if (clips.some((clip): clip is undefined => !clip)) return invalid("片段已不存在")
  const resolved = clips as TimelineClip[];
  if (resolved.some(clip => !["video", "audio"].includes(clip.asset_kind))) return invalid("图片片段不能进行素材源编辑")
  if (resolved.some(isLocked.bind(null, document))) return invalid("片段或轨道已锁定")
  if (resolved.some(clip => clip.track_id !== resolved[0]!.track_id)) return invalid("编辑片段必须位于同一轨道")

  if (mode === "roll" && resolved[0]!.timeline_end_us !== resolved[1]!.timeline_start_us) {
    return invalid("滚动修剪需要两个片段首尾相接")
  }
  if (mode === "slide" && (resolved[0]!.timeline_end_us !== resolved[1]!.timeline_start_us || resolved[1]!.timeline_end_us !== resolved[2]!.timeline_start_us)) {
    return invalid("滑动编辑需要三个片段首尾相接")
  }

  const transitionAnchors = mode === "roll" ? [resolved[0]!.clip_id] : mode === "slide" ? resolved.slice(0, 2).map(clip => clip.clip_id) : [];
  if (document.transitions?.some(transition => transitionAnchors.includes(transition.after_clip_id))) {
    return invalid("请先移除关联转场，再进行边界编辑")
  }

  const actions: EditAction[] = mode === "roll"
    ? [{ clip: resolved[0]!, anchor: "start" }, { clip: resolved[1]!, anchor: "end" }]
    : mode === "slide"
      ? [{ clip: resolved[0]!, anchor: "start" }, { clip: resolved[2]!, anchor: "end" }]
      : [{ clip: resolved[0]!, anchor: "timeline" }];
  const touchedGroups = new Set<string>();
  const allActionMembers = new Map<string, { action: EditAction; member: TimelineClip; durationUs: number }>();
  let minDeltaUs = -Infinity;
  let maxDeltaUs = Infinity;
  for (const action of actions) {
    const members = relatedClips(document, action.clip);
    if (action.clip.link_group_id && touchedGroups.has(action.clip.link_group_id)) return invalid("同一链接组不能同时作为两个编辑边界")
    if (action.clip.link_group_id) touchedGroups.add(action.clip.link_group_id);
    for (const member of members) {
      const duration = assetDurationById.get(member.asset_id);
      if (!Number.isFinite(duration) || duration == null) return invalid("素材时长尚未读取，无法安全编辑源范围")
      if (isLocked(document, member)) return invalid("链接片段或其轨道已锁定")
      if (member.asset_id !== action.clip.asset_id || member.asset_kind !== action.clip.asset_kind ||
          member.source_start_us !== action.clip.source_start_us || member.source_end_us !== action.clip.source_end_us ||
          speedOf(member) !== speedOf(action.clip)) return invalid("链接组的素材范围或速度不一致，无法同步编辑")
      const [minSourceDelta, maxSourceDelta] = sourceBounds(action, duration);
      const speed = speedOf(member);
      minDeltaUs = Math.max(minDeltaUs, (minSourceDelta * 1000) / speed);
      maxDeltaUs = Math.min(maxDeltaUs, (maxSourceDelta * 1000) / speed);
      if (action.anchor === "end") minDeltaUs = Math.max(minDeltaUs, -member.timeline_start_us);
      allActionMembers.set(member.clip_id, { action, member, durationUs: duration });
    }
  }
  if (mode === "slide") {
    const center = resolved[1]!;
    const centerMembers = relatedClips(document, center);
    if (center.link_group_id && touchedGroups.has(center.link_group_id)) return invalid("同一链接组不能同时作为两个编辑边界")
    if (center.link_group_id) touchedGroups.add(center.link_group_id);
    for (const member of centerMembers) {
      if (isLocked(document, member)) return invalid("链接片段或其轨道已锁定")
      if (member.asset_id !== center.asset_id || member.source_start_us !== center.source_start_us ||
          member.source_end_us !== center.source_end_us || speedOf(member) !== speedOf(center)) {
        return invalid("链接组的素材范围或速度不一致，无法同步滑动")
      }
      minDeltaUs = Math.max(minDeltaUs, -member.timeline_start_us);
      allActionMembers.set(member.clip_id, { action: { clip: center, anchor: "timeline", shiftTimeline: true }, member, durationUs: assetDurationById.get(member.asset_id) ?? 0 });
    }
  }

  const frame = Math.max(1, Math.round(frameUs));
  const minFrame = Number.isFinite(minDeltaUs) ? Math.ceil(minDeltaUs / frame) : Number.MIN_SAFE_INTEGER;
  const maxFrame = Number.isFinite(maxDeltaUs) ? Math.floor(maxDeltaUs / frame) : Number.MAX_SAFE_INTEGER;
  if (minFrame > maxFrame) return invalid("当前素材边界没有可编辑空间")
  const deltaUs = Math.max(minFrame, Math.min(maxFrame, Math.round(requestedDeltaUs / frame))) * frame;

  const targets = [...allActionMembers.values()].map(({ action, member }) => {
    const target = anchoredTarget({ ...action, clip: member }, deltaUs);
    return target;
  });
  const targetById = new Map(targets.map(target => [target.clipId, target]));
  if (mode === "slide") {
    const center = resolved[1]!;
    for (const member of relatedClips(document, center)) {
      targetById.set(member.clip_id, {
        clipId: member.clip_id,
        sourceStartUs: member.source_start_us ?? 0,
        sourceEndUs: member.source_end_us ?? 0,
        timelineStartUs: member.timeline_start_us + deltaUs,
        timelineEndUs: member.timeline_end_us + deltaUs,
      });
    }
  }
  const plannedTargets = [...targetById.values()].sort((a, b) => a.timelineStartUs - b.timelineStartUs);
  const targetStartById = new Map(plannedTargets.map(target => [target.clipId, target]));
  const allSameTrack = document.clips.filter(clip => clip.track_id === resolved[0]!.track_id);
  const finalRanges = allSameTrack.map(clip => {
    const target = targetStartById.get(clip.clip_id);
    return { id: clip.clip_id, start: target?.timelineStartUs ?? clip.timeline_start_us, end: target?.timelineEndUs ?? clip.timeline_end_us };
  }).sort((a, b) => a.start - b.start);
  if (finalRanges.some(item => item.start < 0) || finalRanges.some((item, index) => index > 0 && item.start < finalRanges[index - 1]!.end)) {
    return invalid("编辑会造成同轨片段重叠")
  }

  const operations: TimelinePatchOperation[] = [];
  const primaryActions = actions;
  for (const action of primaryActions) {
    const target = targetById.get(action.clip.clip_id);
    if (!target) continue;
    operations.push({
      op: "set_clip_source_window",
      clip_id: action.clip.clip_id,
      source_start_us: Math.round(target.sourceStartUs),
      source_end_us: Math.round(target.sourceEndUs),
      anchor: action.anchor,
    });
  }
  if (mode === "slide") {
    operations.splice(1, 0, {
      op: "position_clip",
      clip_id: resolved[1]!.clip_id,
      timeline_start_us: Math.max(0, resolved[1]!.timeline_start_us + deltaUs),
    });
  }
  if (deltaUs === 0) operations.length = 0;
  return { deltaUs, targets: plannedTargets, operations };
}
