import type { TimelineClip, TimelineDocument, TimelinePatchOperation } from "@aivideo/contracts";
import { removeLinkedClips } from "./linked-clips.js";

export function readTimelineBehaviorPrefs(): { mainTrackMagnet: boolean; linkageEnabled: boolean } {
  try {
    const raw = window.localStorage.getItem("vortex-cut.timeline.prefs.v1");
    if (raw) {
      const value = JSON.parse(raw) as { mainTrackMagnet?: unknown; linkageEnabled?: unknown };
      return { mainTrackMagnet: value.mainTrackMagnet !== false, linkageEnabled: value.linkageEnabled !== false };
    }
  } catch { /* Use OpenFilm's enabled defaults. */ }
  return { mainTrackMagnet: true, linkageEnabled: true };
}

/** Plan a magnetic delete and the resulting main-track compaction as one revision. */
export function planMagneticDelete(document: TimelineDocument, selected: readonly TimelineClip[], linkage: boolean): { operations: TimelinePatchOperation[]; reason?: string } {
  const removes = removeLinkedClips(selected, document);
  if (!removes.length) return { operations: [], reason: "所选片段或链接轨道已锁定" };
  const removedIds = new Set<string>();
  const addGroup = (clip: TimelineClip) => {
    for (const member of document.clips) if (member.clip_id === clip.clip_id || (clip.link_group_id && member.link_group_id === clip.link_group_id)) removedIds.add(member.clip_id);
  };
  for (const op of removes) if (op.op === "remove_clip") {
    const clip = document.clips.find(item => item.clip_id === op.clip_id);
    if (clip) addGroup(clip);
  }
  const main = document.clips.filter(clip => clip.track_id === "V1");
  const removedMain = main.filter(clip => removedIds.has(clip.clip_id));
  if (!removedMain.length) return { operations: removes };
  const cuts = new Set(main.flatMap(clip => [clip.timeline_start_us, clip.timeline_end_us]));
  const deletedHost = (start: number, end: number) => removedMain.some(clip => start >= clip.timeline_start_us && start < clip.timeline_end_us) &&
    [...cuts].filter(cut => cut > start && cut < end).length <= 1;
  const isLocked = (clip: TimelineClip) => Boolean(document.locked_elements?.includes(clip.clip_id) || document.tracks.find(track => track.id === clip.track_id)?.locked);
  if (linkage) for (const clip of document.clips) {
    if (clip.track_id === "V1" || clip.asset_kind === "audio" || removedIds.has(clip.clip_id) || !deletedHost(clip.timeline_start_us, clip.timeline_end_us)) continue;
    const members = clip.link_group_id ? document.clips.filter(item => item.link_group_id === clip.link_group_id) : [clip];
    if (members.some(isLocked)) continue;
    removes.push({ op: "remove_clip", clip_id: clip.clip_id });
    addGroup(clip);
  }
  const removedCaptions = new Set<string>();
  for (const caption of document.captions) {
    if (caption.source_clip_id && removedIds.has(caption.source_clip_id)) removedCaptions.add(caption.caption_id);
    else if (linkage && !caption.source_clip_id && !document.tracks.find(track => track.id === "C1")?.locked && deletedHost(caption.start_us, caption.end_us)) {
      removes.push({ op: "remove_caption", caption_id: caption.caption_id });
      removedCaptions.add(caption.caption_id);
    }
  }
  const remaining: TimelineDocument = {
    ...document,
    clips: document.clips.filter(clip => !removedIds.has(clip.clip_id)),
    captions: document.captions.filter(caption => !removedCaptions.has(caption.caption_id)),
  };
  const compact = planCompactMainTrack(remaining, linkage, removedMain.map(clip => ({ start: clip.timeline_start_us, end: clip.timeline_end_us })));
  if (compact.reason) return compact;
  const operations = [...removes, ...compact.operations];
  return operations.length <= 100 ? { operations } : { operations: [], reason: "一次编辑的操作超过上限" };
}

/** Plan closing all main-track gaps in one atomic edit, optionally carrying short overlays. */
export function planCompactMainTrack(document: TimelineDocument, linkage: boolean, closedSpans?: readonly { start: number; end: number }[], mainOrder?: readonly string[]): { operations: TimelinePatchOperation[]; reason?: string } {
  const main = document.tracks.find(track => track.id === "V1" && track.kind === "video");
  if (!main || main.locked) return { operations: [], reason: "主轨已锁定或不存在" };
  const primary = document.clips.filter(clip => clip.track_id === main.id).sort((a, b) => a.timeline_start_us - b.timeline_start_us);
  const deltaById = new Map<string, number>();
  let cursor = 0;
  const ordered = mainOrder ? mainOrder.map(id => primary.find(clip => clip.clip_id === id)).filter((clip): clip is TimelineClip => Boolean(clip)) : primary;
  if (ordered.length !== primary.length || new Set(ordered.map(clip => clip.clip_id)).size !== primary.length) return { operations: [], reason: "主轨顺序不合法" };
  for (const clip of ordered) {
    const delta = closedSpans ? -closedSpans.filter(span => span.end <= clip.timeline_start_us).reduce((sum, span) => sum + span.end - span.start, 0) : cursor - clip.timeline_start_us;
    deltaById.set(clip.clip_id, delta);
    cursor += clip.timeline_end_us - clip.timeline_start_us;
  }
  const cuts = new Set(primary.flatMap(clip => [clip.timeline_start_us, clip.timeline_end_us]));
  const host = (start: number, end: number): TimelineClip | undefined => {
    const found = primary.find(clip => start >= clip.timeline_start_us && start < clip.timeline_end_us);
    const crossed = [...cuts].filter(cut => cut > start && cut < end).length;
    return found && crossed <= 1 ? found : undefined;
  };
  const locked = (clip: TimelineClip) => Boolean(document.locked_elements?.includes(clip.clip_id) || document.tracks.find(track => track.id === clip.track_id)?.locked);
  const addGroup = (clip: TimelineClip, delta: number): boolean => {
    const members = clip.link_group_id ? document.clips.filter(item => item.link_group_id === clip.link_group_id) : [clip];
    for (const member of members) {
      const existing = deltaById.get(member.clip_id);
      if ((existing !== undefined && existing !== delta) || (delta !== 0 && (locked(member) || member.timeline_start_us + delta < 0))) return false;
    }
    for (const member of members) deltaById.set(member.clip_id, delta);
    return true;
  };
  for (const clip of primary) if (!addGroup(clip, deltaById.get(clip.clip_id) ?? 0)) return { operations: [], reason: "链接或锁定的片段无法一起移动" };
  if (linkage) for (const clip of document.clips) {
    if (clip.track_id === main.id || deltaById.has(clip.clip_id) || locked(clip)) continue;
    const owner = host(clip.timeline_start_us, clip.timeline_end_us);
    const delta = owner ? deltaById.get(owner.clip_id) ?? 0 : 0;
    if (delta && !addGroup(clip, delta)) return { operations: [], reason: "联动片段无法安全移动" };
  }
  for (const track of document.tracks.filter(item => item.kind === "video")) {
    const intervals = document.clips.filter(clip => clip.track_id === track.id).map(clip => ({
      start: clip.timeline_start_us + (deltaById.get(clip.clip_id) ?? 0),
      end: clip.timeline_end_us + (deltaById.get(clip.clip_id) ?? 0),
    })).sort((a, b) => a.start - b.start);
    if (intervals.some((item, index) => index > 0 && item.start < intervals[index - 1].end)) return { operations: [], reason: "联动后片段会重叠" };
  }
  const placements = document.clips.flatMap(clip => {
    const delta = deltaById.get(clip.clip_id) ?? 0;
    return delta ? [{ clip_id: clip.clip_id, timeline_start_us: clip.timeline_start_us + delta }] : [];
  });
  if (placements.length > 100) return { operations: [], reason: "一次移动的片段超过上限" };
  const operations: TimelinePatchOperation[] = placements.length ? [{ op: "position_clips", placements }] : [];
  const captionDeltas = new Map<string, number>();
  if (linkage && !document.tracks.find(track => track.id === "C1")?.locked) {
    for (const caption of document.captions) {
      if (caption.source_clip_id) continue; // Core moves captions bound to their source clip.
      const owner = host(caption.start_us, caption.end_us);
      const delta = owner ? deltaById.get(owner.clip_id) ?? 0 : 0;
      if (delta) {
        captionDeltas.set(caption.caption_id, delta);
        operations.push({ op: "set_caption_timing", caption_id: caption.caption_id, start_us: caption.start_us + delta, end_us: caption.end_us + delta });
      }
    }
  }
  const captionIntervals = document.captions.map(caption => {
    const delta = caption.source_clip_id ? deltaById.get(caption.source_clip_id) ?? 0 : captionDeltas.get(caption.caption_id) ?? 0;
    return { start: caption.start_us + delta, end: caption.end_us + delta };
  }).sort((a, b) => a.start - b.start);
  if (captionIntervals.some((item, index) => index > 0 && item.start < captionIntervals[index - 1].end)) return { operations: [], reason: "联动后字幕会重叠" };
  return operations.length <= 100 ? { operations } : { operations: [], reason: "一次编辑的操作超过上限" };
}

/** Insert a main-track clip at the pointer's nearest cut and carry its riders. */
export function planMagneticMove(document: TimelineDocument, clipId: string, pointerUs: number, linkage: boolean): { operations: TimelinePatchOperation[]; reason?: string } {
  const clips = document.clips.filter(clip => clip.track_id === "V1").sort((a, b) => a.timeline_start_us - b.timeline_start_us);
  const moving = clips.find(clip => clip.clip_id === clipId);
  if (!moving) return { operations: [], reason: "片段不在主轨" };
  const rest = clips.filter(clip => clip.clip_id !== clipId);
  const index = rest.findIndex(clip => pointerUs < (clip.timeline_start_us + clip.timeline_end_us) / 2);
  rest.splice(index < 0 ? rest.length : index, 0, moving);
  return planCompactMainTrack(document, linkage, undefined, rest.map(clip => clip.clip_id));
}

/** Move a clip onto/off the main track while applying its insert/close-gap behavior atomically. */
export function planMagneticDrop(document: TimelineDocument, clipId: string, targetTrackId: string, pointerUs: number, targetStartUs: number, linkage: boolean): { operations: TimelinePatchOperation[]; reason?: string } {
  const clip = document.clips.find(item => item.clip_id === clipId);
  if (!clip) return { operations: [], reason: "片段已不存在" };
  if (clip.track_id === "V1" && targetTrackId === "V1") return planMagneticMove(document, clipId, pointerUs, linkage);
  if (clip.track_id !== "V1" && targetTrackId === "V1") {
    const staged: TimelineDocument = { ...document, clips: document.clips.map(item => item.clip_id === clipId ? { ...item, track_id: "V1" } : item) };
    const before = staged.clips.filter(item => item.track_id === "V1" && item.clip_id !== clipId).sort((a, b) => a.timeline_start_us - b.timeline_start_us);
    const insertAt = before.findIndex(item => pointerUs < (item.timeline_start_us + item.timeline_end_us) / 2);
    const preceding = insertAt < 0 ? before : before.slice(0, insertAt);
    const canonicalStart = preceding.reduce((sum, item) => sum + item.timeline_end_us - item.timeline_start_us, 0);
    const plan = planMagneticMove(staged, clipId, pointerUs, linkage);
    if (plan.reason) return plan;
    const positionOperation = plan.operations.find(operation => operation.op === "position_clips");
    const moving = positionOperation?.op === "position_clips" ? positionOperation.placements.find(item => item.clip_id === clipId) : undefined;
    if (moving) moving.track_id = "V1";
    else if (positionOperation?.op === "position_clips") positionOperation.placements.push({ clip_id: clipId as TimelineClip["clip_id"], timeline_start_us: canonicalStart, track_id: "V1" });
    else plan.operations.unshift({ op: "position_clips", placements: [{ clip_id: clipId as TimelineClip["clip_id"], timeline_start_us: canonicalStart, track_id: "V1" }] });
    return plan.operations.length <= 100 ? plan : { operations: [], reason: "一次编辑的操作超过上限" };
  }
  if (clip.track_id === "V1" && targetTrackId !== "V1") {
    if (clip.link_group_id) return { operations: [], reason: "请先解除链接，再将主轨片段移到其他轨道" };
    const remaining: TimelineDocument = { ...document, clips: document.clips.filter(item => item.clip_id !== clipId) };
    const plan = planCompactMainTrack(remaining, linkage);
    if (plan.reason) return plan;
    plan.operations.push({ op: "position_clip", clip_id: clip.clip_id, timeline_start_us: Math.max(0, targetStartUs), track_id: targetTrackId });
    return plan.operations.length <= 100 ? plan : { operations: [], reason: "一次编辑的操作超过上限" };
  }
  return { operations: [] };
}

/** Ripple a main-track trim and keep overlays riding with the footage after it changes length. */
export function planMagneticTrim(document: TimelineDocument, clip: TimelineClip, sourceStartUs: number, sourceEndUs: number, linkage: boolean): { operations: TimelinePatchOperation[]; reason?: string } {
  if (clip.track_id !== "V1" || clip.asset_kind !== "video") return { operations: [{ op: "trim_clip", clip_id: clip.clip_id, source_start_us: sourceStartUs, source_end_us: sourceEndUs }] };
  const speed = clip.speed_milli ?? 1000;
  const newDuration = Math.round((sourceEndUs - sourceStartUs) * 1000 / speed);
  const delta = newDuration - (clip.timeline_end_us - clip.timeline_start_us);
  const main = document.clips.filter(item => item.track_id === "V1");
  const shifted = new Set(main.filter(item => item.clip_id !== clip.clip_id && item.timeline_start_us >= clip.timeline_end_us).map(item => item.clip_id));
  const deltas = new Map<string, number>([[clip.clip_id, delta]]);
  const isLocked = (item: TimelineClip) => Boolean(document.locked_elements?.includes(item.clip_id) || document.tracks.find(track => track.id === item.track_id)?.locked);
  // Data-linked picture/sound is an inseparable edit group in OpenFilm; the
  // linkage switch controls unlinked riders, not explicit clip links.
  if (clip.link_group_id) for (const item of document.clips) {
    if (item.clip_id === clip.clip_id || !item.link_group_id || item.link_group_id !== clip.link_group_id) continue;
    deltas.set(item.clip_id, delta);
  }
  for (const id of shifted) {
    const host = main.find(item => item.clip_id === id)!;
    deltas.set(id, delta);
    if (host.link_group_id) for (const member of document.clips.filter(item => item.link_group_id === host.link_group_id)) deltas.set(member.clip_id, delta);
  }
  const cuts = [...new Set(main.flatMap(item => [item.timeline_start_us, item.timeline_end_us]))].sort((a, b) => a - b);
  const ownerOf = (start: number, end: number) => {
    const owner = main.find(item => start >= item.timeline_start_us && start < item.timeline_end_us);
    return owner && cuts.filter(cut => cut > start && cut < end).length <= 1 ? owner : undefined;
  };
  if (linkage && delta) for (const item of document.clips) {
    if (item.track_id === "V1" || deltas.has(item.clip_id) || isLocked(item)) continue;
    const owner = ownerOf(item.timeline_start_us, item.timeline_end_us);
    if (owner && (owner.clip_id === clip.clip_id || shifted.has(owner.clip_id))) deltas.set(item.clip_id, delta);
  }
  const leftTrim = Math.round((sourceStartUs - (clip.source_start_us ?? 0)) * 1000 / speed);
  const placements = [...deltas].filter(([id, amount]) => {
    const item = document.clips.find(entry => entry.clip_id === id);
    const restoreTrimmedHead = id === clip.clip_id || Boolean(clip.link_group_id && item?.link_group_id === clip.link_group_id);
    return restoreTrimmedHead ? leftTrim !== 0 : amount !== 0;
  }).map(([id, amount]) => {
    const item = document.clips.find(entry => entry.clip_id === id)!;
    const restoreTrimmedHead = id === clip.clip_id || (clip.link_group_id && item.link_group_id === clip.link_group_id);
    return { clip_id: item.clip_id, timeline_start_us: restoreTrimmedHead ? item.timeline_start_us : item.timeline_start_us + amount };
  });
  if (placements.some(item => {
    const clipItem = document.clips.find(entry => entry.clip_id === item.clip_id)!;
    return isLocked(clipItem) && item.timeline_start_us !== clipItem.timeline_start_us || item.timeline_start_us < 0;
  })) return { operations: [], reason: "磁吸修剪会移动锁定或负时间片段" };
  const intervalsByTrack = new Map<string, Array<{ start: number; end: number }>>();
  for (const item of document.clips.filter(entry => entry.asset_kind !== "audio")) {
    const deltaForItem = deltas.get(item.clip_id) ?? 0;
    const trimmedGroup = item.clip_id === clip.clip_id || Boolean(clip.link_group_id && item.link_group_id === clip.link_group_id);
    const adjustedStart = trimmedGroup ? item.timeline_start_us : item.timeline_start_us + deltaForItem;
    const adjustedEnd = adjustedStart + (trimmedGroup ? newDuration : item.timeline_end_us - item.timeline_start_us);
    const bucket = intervalsByTrack.get(item.track_id) ?? [];
    bucket.push({ start: adjustedStart, end: adjustedEnd }); intervalsByTrack.set(item.track_id, bucket);
  }
  if ([...intervalsByTrack.values()].some(intervals => intervals.sort((a, b) => a.start - b.start).some((item, index) => index > 0 && item.start < intervals[index - 1]!.end))) return { operations: [], reason: "磁吸修剪会造成视频片段重叠" };
  const operations: TimelinePatchOperation[] = [{ op: "trim_clip", clip_id: clip.clip_id, source_start_us: sourceStartUs, source_end_us: sourceEndUs }];
  if (placements.length) operations.push({ op: "position_clips", placements });
  if (linkage && !document.tracks.find(track => track.id === "C1")?.locked) {
    const captionOps = document.captions.filter(caption => !caption.source_clip_id).flatMap(caption => {
      const owner = ownerOf(caption.start_us, caption.end_us);
      const amount = owner && shifted.has(owner.clip_id) ? delta : 0;
      return amount ? [{ op: "set_caption_timing" as const, caption_id: caption.caption_id, start_us: caption.start_us + amount, end_us: caption.end_us + amount }] : [];
    });
    operations.push(...captionOps);
  }
  if (operations.length > 100) return { operations: [], reason: "一次编辑的操作超过上限" };
  return { operations };
}

/** Change main-track speed and ripple following footage/riders only while the OpenFilm magnet is enabled. */
export function planMagneticSpeed(document: TimelineDocument, clip: TimelineClip, speedMilli: number, magnet: boolean, linkage: boolean): { operations: TimelinePatchOperation[]; reason?: string } {
  if (clip.track_id !== "V1" || clip.asset_kind !== "video" || !magnet) {
    return { operations: [{ op: "set_speed", clip_id: clip.clip_id, speed_milli: speedMilli, ripple: false }] };
  }
  const group = clip.link_group_id ? document.clips.filter(item => item.link_group_id === clip.link_group_id) : [clip];
  const oldDuration = clip.timeline_end_us - clip.timeline_start_us;
  const newDuration = Math.round(((clip.source_end_us ?? 0) - (clip.source_start_us ?? 0)) * 1000 / speedMilli);
  const delta = newDuration - oldDuration;
  const following = document.clips.filter(item => item.track_id === "V1" && !group.some(member => member.clip_id === item.clip_id) && item.timeline_start_us >= clip.timeline_end_us);
  const deltas = new Map<string, number>();
  for (const host of following) {
    deltas.set(host.clip_id, delta);
    if (host.link_group_id) for (const member of document.clips.filter(item => item.link_group_id === host.link_group_id)) deltas.set(member.clip_id, delta);
  }
  const cuts = [...new Set(document.clips.filter(item => item.track_id === "V1").flatMap(item => [item.timeline_start_us, item.timeline_end_us]))];
  const ownerOf = (start: number, end: number) => {
    const owner = document.clips.find(item => item.track_id === "V1" && start >= item.timeline_start_us && start < item.timeline_end_us);
    return owner && cuts.filter(cut => cut > start && cut < end).length <= 1 ? owner : undefined;
  };
  const locked = (item: TimelineClip) => Boolean(document.locked_elements?.includes(item.clip_id) || document.tracks.find(track => track.id === item.track_id)?.locked);
  if (linkage && delta) for (const item of document.clips) {
    if (item.track_id === "V1" || deltas.has(item.clip_id) || locked(item)) continue;
    const owner = ownerOf(item.timeline_start_us, item.timeline_end_us);
    if (owner && (owner.clip_id === clip.clip_id || following.some(host => host.clip_id === owner.clip_id))) deltas.set(item.clip_id, delta);
  }
  const placements = [...deltas].filter(([, amount]) => amount !== 0).map(([id, amount]) => {
    const item = document.clips.find(entry => entry.clip_id === id)!;
    return { clip_id: item.clip_id, timeline_start_us: item.timeline_start_us + amount };
  });
  if (placements.some(item => locked(document.clips.find(entry => entry.clip_id === item.clip_id)!) || item.timeline_start_us < 0)) return { operations: [], reason: "磁吸变速会移动锁定片段或越过时间线起点" };
  const videoIntervals = new Map<string, Array<{ start: number; end: number }>>();
  for (const item of document.clips.filter(entry => entry.asset_kind !== "audio")) {
    const start = item.timeline_start_us + (deltas.get(item.clip_id) ?? 0);
    const end = start + (item.clip_id === clip.clip_id ? newDuration : item.timeline_end_us - item.timeline_start_us);
    const bucket = videoIntervals.get(item.track_id) ?? [];
    bucket.push({ start, end }); videoIntervals.set(item.track_id, bucket);
  }
  if ([...videoIntervals.values()].some(items => items.sort((a, b) => a.start - b.start).some((item, index) => index > 0 && item.start < items[index - 1]!.end))) return { operations: [], reason: "变速后视频片段会重叠" };
  const operations: TimelinePatchOperation[] = group.map(member => ({ op: "set_speed", clip_id: member.clip_id, speed_milli: speedMilli, ripple: false }));
  if (placements.length) operations.push({ op: "position_clips", placements });
  if (linkage && !document.tracks.find(track => track.id === "C1")?.locked) for (const caption of document.captions.filter(item => !item.source_clip_id)) {
    const owner = ownerOf(caption.start_us, caption.end_us);
    if (owner && following.some(host => host.clip_id === owner.clip_id)) operations.push({ op: "set_caption_timing", caption_id: caption.caption_id, start_us: caption.start_us + delta, end_us: caption.end_us + delta });
  }
  return operations.length <= 100 ? { operations } : { operations: [], reason: "一次编辑的操作超过上限" };
}
