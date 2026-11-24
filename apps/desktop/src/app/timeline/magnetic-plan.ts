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

/** Close the deleted time on each selected track, keeping explicit clip links together. */
export function planRippleDelete(document: TimelineDocument, selected: readonly TimelineClip[], linkage: boolean): { operations: TimelinePatchOperation[]; reason?: string } {
  if (!selected.length) return { operations: [], reason: "请选择要波纹删除的片段" };
  if (selected.every(clip => clip.track_id === "V1")) return planMagneticDelete(document, selected, linkage);

  const operations = removeLinkedClips(selected, document);
  if (!operations.length) return { operations: [], reason: "所选片段或链接轨道已锁定" };
  const clipsById = new Map(document.clips.map(clip => [clip.clip_id, clip]));
  const removedIds = new Set(operations.flatMap(op => op.op === "remove_clip" ? [op.clip_id] : []));
  const removedGroups = new Set([...removedIds].map(id => clipsById.get(id)?.link_group_id).filter(Boolean));
  const lockedTracks = new Set(document.tracks.filter(track => track.locked).map(track => track.id));
  const lockedClips = new Set(document.locked_elements);
  const cutsByTrack = new Map<string, Array<{ start: number; end: number }>>();
  const remaining = [];
  for (const clip of document.clips) {
    if (!removedIds.has(clip.clip_id) && !(clip.link_group_id && removedGroups.has(clip.link_group_id))) {
      remaining.push(clip);
      continue;
    }
    removedIds.add(clip.clip_id);
    const cuts = cutsByTrack.get(clip.track_id) ?? [];
    cuts.push({ start: clip.timeline_start_us, end: clip.timeline_end_us });
    cutsByTrack.set(clip.track_id, cuts);
  }
  for (const [trackId, cuts] of cutsByTrack) {
    const merged: typeof cuts = [];
    for (const cut of cuts.sort((a, b) => a.start - b.start)) {
      const previous = merged.at(-1);
      if (previous && cut.start <= previous.end) previous.end = Math.max(previous.end, cut.end);
      else merged.push(cut);
    }
    cutsByTrack.set(trackId, merged);
  }
  const shifts = new Map<string, number>();
  for (const clip of remaining) {
    const distance = (cutsByTrack.get(clip.track_id) ?? []).reduce((sum, cut) =>
      cut.end <= clip.timeline_start_us ? sum + cut.end - cut.start : sum, 0);
    if (!distance) continue;
    const group = clip.link_group_id || clip.clip_id;
    const previous = shifts.get(group);
    if (previous !== undefined && previous !== distance) return { operations: [], reason: "链接片段无法同步闭合所选区间" };
    shifts.set(group, distance);
  }

  const placements = [];
  const visualByTrack = new Map<string, Array<{ start: number; end: number }>>();
  const shiftById = new Map<string, number>();
  for (const clip of remaining) {
    const distance = shifts.get(clip.link_group_id || clip.clip_id) ?? 0;
    const start = clip.timeline_start_us - distance;
    if (distance && (start < 0 || lockedTracks.has(clip.track_id) || lockedClips.has(clip.clip_id))) {
      return { operations: [], reason: "波纹删除会移动锁定片段或使片段早于时间线起点" };
    }
    if (distance) {
      placements.push({ clip_id: clip.clip_id, timeline_start_us: start });
      shiftById.set(clip.clip_id, distance);
    }
    if (clip.asset_kind !== "audio") {
      const ranges = visualByTrack.get(clip.track_id) ?? [];
      ranges.push({ start, end: clip.timeline_end_us - distance });
      visualByTrack.set(clip.track_id, ranges);
    }
  }
  const captionRanges = document.captions.flatMap(caption => {
    const sourceId = caption.source_clip_id;
    if (sourceId && removedIds.has(sourceId)) return [];
    const distance = sourceId ? shiftById.get(sourceId) ?? 0 : 0;
    return [{ start: caption.start_us - distance, end: caption.end_us - distance }];
  });
  for (const ranges of [...visualByTrack.values(), captionRanges]) {
    ranges.sort((a, b) => a.start - b.start);
    if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1]!.end)) {
      return { operations: [], reason: "波纹删除会造成视频片段或字幕重叠" };
    }
  }
  if (operations.length + Number(placements.length > 0) > 100) {
    return { operations: [], reason: "一次编辑的操作超过上限" };
  }
  if (placements.length) operations.push({ op: "position_clips", placements });
  return { operations };
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
  const hasLinks = document.clips.some(clip => Boolean(clip.link_group_id));
  const onlyMainClips = document.clips.every(clip => clip.track_id === main.id);
  if (!hasLinks && document.captions.length === 0 && (!linkage || onlyMainClips)) {
    const primary = document.clips.filter(clip => clip.track_id === main.id).sort((a, b) => a.timeline_start_us - b.timeline_start_us);
    const primaryById = mainOrder ? new Map(primary.map(clip => [clip.clip_id, clip])) : null;
    const ordered = mainOrder ? mainOrder.map(id => primaryById!.get(id as TimelineClip["clip_id"])).filter((clip): clip is TimelineClip => Boolean(clip)) : primary;
    if (ordered.length !== primary.length || new Set(ordered.map(clip => clip.clip_id)).size !== primary.length) return { operations: [], reason: "主轨顺序不合法" };
    const lockedIds = new Set(document.locked_elements ?? []);
    const spans = closedSpans ? [...closedSpans].sort((a, b) => a.end - b.end) : [];
    const spanEnds = spans.map(span => span.end);
    const spanPrefix = [0];
    for (const span of spans) spanPrefix.push(spanPrefix.at(-1)! + span.end - span.start);
    const placements: Array<{ clip_id: TimelineClip["clip_id"]; timeline_start_us: number }> = [];
    let cursor = 0;
    for (const clip of ordered) {
      let delta: number;
      if (closedSpans) {
        let low = 0; let high = spanEnds.length;
        while (low < high) { const middle = (low + high) >>> 1; if (spanEnds[middle]! <= clip.timeline_start_us) low = middle + 1; else high = middle; }
        delta = -spanPrefix[low]!;
      } else delta = cursor - clip.timeline_start_us;
      if (delta && (lockedIds.has(clip.clip_id) || clip.timeline_start_us + delta < 0)) return { operations: [], reason: "链接或锁定的片段无法一起移动" };
      if (delta) placements.push({ clip_id: clip.clip_id, timeline_start_us: clip.timeline_start_us + delta });
      cursor += clip.timeline_end_us - clip.timeline_start_us;
    }
    return { operations: placements.length ? [{ op: "position_clips", placements }] : [] };
  }
  const tracksById = new Map(document.tracks.map(track => [track.id, track]));
  const clipsById = new Map(document.clips.map(clip => [clip.clip_id, clip]));
  const clipsByTrack = new Map<string, TimelineClip[]>();
  const linkMembers = new Map<string, TimelineClip[]>();
  for (const clip of document.clips) {
    const lane = clipsByTrack.get(clip.track_id) ?? [];
    lane.push(clip);
    clipsByTrack.set(clip.track_id, lane);
    if (clip.link_group_id) {
      const group = linkMembers.get(clip.link_group_id) ?? [];
      group.push(clip);
      linkMembers.set(clip.link_group_id, group);
    }
  }
  for (const lane of clipsByTrack.values()) lane.sort((a, b) => a.timeline_start_us - b.timeline_start_us);
  const primary = clipsByTrack.get(main.id) ?? [];
  const primaryById = new Map(primary.map(clip => [clip.clip_id, clip]));
  const deltaById = new Map<string, number>();
  let cursor = 0;
  const ordered = mainOrder ? mainOrder.map(id => primaryById.get(id as TimelineClip["clip_id"])).filter((clip): clip is TimelineClip => Boolean(clip)) : primary;
  if (ordered.length !== primary.length || new Set(ordered.map(clip => clip.clip_id)).size !== primary.length) return { operations: [], reason: "主轨顺序不合法" };
  for (const clip of ordered) {
    const delta = closedSpans ? -closedSpans.filter(span => span.end <= clip.timeline_start_us).reduce((sum, span) => sum + span.end - span.start, 0) : cursor - clip.timeline_start_us;
    deltaById.set(clip.clip_id, delta);
    cursor += clip.timeline_end_us - clip.timeline_start_us;
  }
  const mainStarts = primary.map(clip => clip.timeline_start_us);
  const cuts = [...new Set(primary.flatMap(clip => [clip.timeline_start_us, clip.timeline_end_us]))].sort((a, b) => a - b);
  const upperBound = (items: readonly number[], value: number): number => {
    let low = 0; let high = items.length;
    while (low < high) { const middle = (low + high) >>> 1; if (items[middle]! <= value) low = middle + 1; else high = middle; }
    return low;
  };
  const lowerBound = (items: readonly number[], value: number): number => {
    let low = 0; let high = items.length;
    while (low < high) { const middle = (low + high) >>> 1; if (items[middle]! < value) low = middle + 1; else high = middle; }
    return low;
  };
  const host = (start: number, end: number): TimelineClip | undefined => {
    const found = primary[upperBound(mainStarts, start) - 1];
    const crossed = lowerBound(cuts, end) - upperBound(cuts, start);
    if (found && start >= found.timeline_end_us) return undefined;
    return found && crossed <= 1 ? found : undefined;
  };
  const lockedIds = new Set(document.locked_elements ?? []);
  const locked = (clip: TimelineClip) => Boolean(lockedIds.has(clip.clip_id) || tracksById.get(clip.track_id)?.locked);
  const addGroup = (clip: TimelineClip, delta: number): boolean => {
    const members = clip.link_group_id ? linkMembers.get(clip.link_group_id) ?? [clip] : [clip];
    for (const member of members) {
      const existing = deltaById.get(member.clip_id);
      // OpenFilm moves writable linked members together and leaves locked partners in place.
      if (delta !== 0 && locked(member)) {
        if (existing !== undefined && existing !== 0) return false;
        continue;
      }
      if ((existing !== undefined && existing !== delta) || (delta !== 0 && (locked(member) || member.timeline_start_us + delta < 0))) return false;
    }
    for (const member of members) {
      if (delta !== 0 && locked(member)) continue;
      deltaById.set(member.clip_id, delta);
    }
    return true;
  };
  for (const clip of primary) if (!addGroup(clip, deltaById.get(clip.clip_id) ?? 0)) return { operations: [], reason: "链接或锁定的片段无法一起移动" };
  if (linkMembers.size === 0 && document.captions.length === 0 && (!linkage || document.clips.length === primary.length)) {
    const placements = primary.flatMap(clip => {
      const delta = deltaById.get(clip.clip_id) ?? 0;
      return delta ? [{ clip_id: clip.clip_id, timeline_start_us: clip.timeline_start_us + delta }] : [];
    });
    return { operations: placements.length ? [{ op: "position_clips", placements }] : [] };
  }
  if (linkage) for (const clip of document.clips) {
    if (clip.track_id === main.id || deltaById.has(clip.clip_id) || locked(clip)) continue;
    const owner = host(clip.timeline_start_us, clip.timeline_end_us);
    const delta = owner ? deltaById.get(owner.clip_id) ?? 0 : 0;
    if (delta && !addGroup(clip, delta)) return { operations: [], reason: "联动片段无法安全移动" };
  }
  type PlannedClip = { clip: TimelineClip; trackId: string; start: number; end: number };
  const statesById = new Map<string, PlannedClip>(document.clips.map(clip => {
    const delta = deltaById.get(clip.clip_id) ?? 0;
    return [clip.clip_id, { clip, trackId: clip.track_id, start: clip.timeline_start_us + delta, end: clip.timeline_end_us + delta }];
  }));
  const clipsByPlannedTrack = new Map<string, PlannedClip[]>();
  for (const state of statesById.values()) {
    const lane = clipsByPlannedTrack.get(state.trackId) ?? [];
    lane.push(state);
    clipsByPlannedTrack.set(state.trackId, lane);
  }
  for (const lane of clipsByPlannedTrack.values()) lane.sort((a, b) => a.start - b.start);
  const laneKinds = new Map(document.tracks.map(track => [track.id, track.kind]));
  const laneLocked = new Map(document.tracks.map(track => [track.id, Boolean(track.locked)]));
  const laneOrder = document.tracks.map(track => track.id);
  const nextNumber = new Map<string, number>();
  for (const track of document.tracks) {
    const prefix = track.kind === "audio" ? "A" : track.kind === "video" ? "V" : "T";
    const number = Number(track.id.slice(prefix.length));
    if (Number.isInteger(number)) nextNumber.set(prefix, Math.max(nextNumber.get(prefix) ?? (prefix === "T" ? 0 : 1), number));
  }
  const addTrackOps: TimelinePatchOperation[] = [];
  const movedRiders = new Set<TimelineClip["clip_id"]>();
  for (const [id, delta] of deltaById) {
    const clip = clipsById.get(id as TimelineClip["clip_id"]);
    if (delta && clip && clip.track_id !== main.id) movedRiders.add(clip.clip_id);
  }
  const overlaps = (a: PlannedClip, b: PlannedClip) => a.start < b.end && a.end > b.start;
  const hasRoom = (trackId: string, candidate: PlannedClip): boolean => {
    const lane = clipsByPlannedTrack.get(trackId) ?? [];
    let low = 0; let high = lane.length;
    while (low < high) { const middle = (low + high) >>> 1; if (lane[middle]!.start < candidate.start) low = middle + 1; else high = middle; }
    return !(low > 0 && lane[low - 1]!.end > candidate.start) && !(low < lane.length && lane[low]!.start < candidate.end);
  };
  const insertSorted = (lane: PlannedClip[], state: PlannedClip) => {
    let low = 0; let high = lane.length;
    while (low < high) { const middle = (low + high) >>> 1; if (lane[middle]!.start <= state.start) low = middle + 1; else high = middle; }
    lane.splice(low, 0, state);
  };
  const moveTo = (state: PlannedClip, destination: string) => {
    const from = clipsByPlannedTrack.get(state.trackId);
    if (from) { const index = from.indexOf(state); if (index >= 0) from.splice(index, 1); }
    state.trackId = destination;
    const to = clipsByPlannedTrack.get(destination) ?? [];
    insertSorted(to, state);
    clipsByPlannedTrack.set(destination, to);
  };
  const createAdjacentTrack = (fromTrackId: string): string | null => {
    const kind = laneKinds.get(fromTrackId);
    if (kind !== "video" && kind !== "audio") return null;
    const prefix = kind === "audio" ? "A" : "V";
    let number = (nextNumber.get(prefix) ?? (prefix === "A" ? 1 : 1)) + 1;
    let id = `${prefix}${number}`;
    while (laneKinds.has(id)) id = `${prefix}${++number}`;
    nextNumber.set(prefix, number);
    const fromIndex = laneOrder.indexOf(fromTrackId);
    if (fromIndex < 0) return null;
    if (kind === "audio") {
      addTrackOps.push({ op: "add_track", kind: "audio", track_id: id, after_track_id: fromTrackId });
      laneOrder.splice(fromIndex + 1, 0, id);
    } else {
      addTrackOps.push({ op: "add_track", kind: "video", track_id: id, before_track_id: fromTrackId });
      laneOrder.splice(fromIndex, 0, id);
    }
    laneKinds.set(id, kind);
    laneLocked.set(id, false);
    return id;
  };
  const settleLaneFor = (state: PlannedClip, fromTrackId: string, preserveBundleShape = false): string | null => {
    const kind = laneKinds.get(fromTrackId);
    const fromIndex = laneOrder.indexOf(fromTrackId);
    if (!kind || fromIndex < 0) return null;
    if (preserveBundleShape) {
      const sameKind = laneOrder.filter(id => laneKinds.get(id) === kind);
      const laneIndex = sameKind.indexOf(fromTrackId);
      const preferredIndex = laneIndex + (kind === "audio" ? 1 : -1);
      const adjacent = sameKind[preferredIndex];
      // A linked bundle shifts one compatible lane for every member. If that neighbor is occupied or locked,
      // open the missing adjacent lane rather than moving only this member farther away from its partners.
      if (adjacent && adjacent !== main.id && !laneLocked.get(adjacent) && hasRoom(adjacent, state)) return adjacent;
      return createAdjacentTrack(fromTrackId);
    }
    const candidates = [...laneKinds].filter(([id, laneKind]) => id !== fromTrackId && id !== main.id && laneKind === kind && !laneLocked.get(id) && hasRoom(id, state));
    candidates.sort(([a], [b]) => {
      const aIndex = laneOrder.indexOf(a); const bIndex = laneOrder.indexOf(b);
      const distance = Math.abs(aIndex - fromIndex) - Math.abs(bIndex - fromIndex);
      if (distance) return distance;
      return kind === "audio" ? bIndex - aIndex : aIndex - bIndex;
    });
    return candidates[0]?.[0] ?? createAdjacentTrack(fromTrackId);
  };
  const settleRider = (state: PlannedClip, fromTrackId: string): boolean => {
    const groupId = state.clip.link_group_id;
    const linkedMembers = groupId ? linkMembers.get(groupId) ?? [] : [];
    const bundle = linkedMembers.length > 1
      ? linkedMembers.map(member => statesById.get(member.clip_id)!).filter(member => movedRiders.has(member.clip.clip_id))
      : [state];
    // A linked audio/video rider must settle as a bundle. Each member keeps its carried time delta and goes to a
    // compatible lane of its own kind; a missing lane is created beside that member's source lane.
    const orderedBundle = [...bundle].sort((a, b) => laneOrder.indexOf(a.trackId) - laneOrder.indexOf(b.trackId));
    const destinations: Array<[PlannedClip, string]> = [];
    for (const member of orderedBundle) {
      const destination = settleLaneFor(member, member.trackId, linkedMembers.length > 1);
      if (!destination) return false;
      destinations.push([member, destination]);
    }
    for (const [member, destination] of destinations) moveTo(member, destination);
    return true;
  };
  // Main-track magnet carries riders to the footage. Settle any moved rider that lands on occupied content onto
  // the nearest unlocked lane of the same kind (picture ties upward, sound ties downward), opening a lane if needed.
  for (const track of document.tracks) {
    if (track.id === main.id || track.locked || track.kind === "text") continue;
    const kept: PlannedClip[] = [];
    for (const state of [...(clipsByPlannedTrack.get(track.id) ?? [])].sort((a, b) => a.start - b.start)) {
      const hits: PlannedClip[] = [];
      for (let index = kept.length - 1; index >= 0 && kept[index]!.end > state.start; index -= 1) {
        const other = kept[index]!;
        if (overlaps(other, state)) hits.push(other);
      }
      const going = movedRiders.has(state.clip.clip_id) ? (hits.length ? [state] : []) : hits.filter(other => movedRiders.has(other.clip.clip_id));
      for (const moved of going) {
        if (kept.includes(moved)) kept.splice(kept.indexOf(moved), 1);
        if (!settleRider(moved, track.id)) return { operations: [], reason: "主轨联动片段无法安全移轨" };
      }
      if (!going.includes(state)) kept.push(state);
    }
  }
  for (const lane of clipsByPlannedTrack.values()) lane.sort((a, b) => a.start - b.start);
  for (const [trackId, kind] of laneKinds) if (kind === "video") {
    const lane = clipsByPlannedTrack.get(trackId) ?? [];
    if (lane.some((item, index) => index > 0 && item.start < lane[index - 1]!.end)) return { operations: [], reason: "联动后片段会重叠" };
  }
  const placements = [...statesById.values()].flatMap(state => {
    if (state.start === state.clip.timeline_start_us && state.trackId === state.clip.track_id) return [];
    return [{ clip_id: state.clip.clip_id, timeline_start_us: state.start, ...(state.trackId !== state.clip.track_id ? { track_id: state.trackId } : {}) }];
  });
  const operations: TimelinePatchOperation[] = [...addTrackOps];
  if (placements.length) operations.push({ op: "position_clips", placements });
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
export function planMagneticTrim(document: TimelineDocument, clip: TimelineClip, sourceStartUs: number, sourceEndUs: number, linkage: boolean, ignoreLink = false): { operations: TimelinePatchOperation[]; reason?: string } {
  if (clip.track_id !== "V1" || clip.asset_kind !== "video") return { operations: [{ op: "trim_clip", clip_id: clip.clip_id, source_start_us: sourceStartUs, source_end_us: sourceEndUs, ...(ignoreLink ? { ignore_link: true } : {}) }] };
  const speed = clip.speed_milli ?? 1000;
  const newDuration = Math.round((sourceEndUs - sourceStartUs) * 1000 / speed);
  const delta = newDuration - (clip.timeline_end_us - clip.timeline_start_us);
  const main = document.clips.filter(item => item.track_id === "V1");
  const shifted = new Set(main.filter(item => item.clip_id !== clip.clip_id && item.timeline_start_us >= clip.timeline_end_us).map(item => item.clip_id));
  const deltas = new Map<string, number>([[clip.clip_id, delta]]);
  const isLocked = (item: TimelineClip) => Boolean(document.locked_elements?.includes(item.clip_id) || document.tracks.find(track => track.id === item.track_id)?.locked);
  // Data-linked picture/sound is an inseparable edit group in OpenFilm; the
  // linkage switch controls unlinked riders, not explicit clip links.
  if (clip.link_group_id && !ignoreLink) for (const item of document.clips) {
    if (item.clip_id === clip.clip_id || !item.link_group_id || item.link_group_id !== clip.link_group_id || isLocked(item)) continue;
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
    const restoreTrimmedHead = id === clip.clip_id || Boolean(!ignoreLink && clip.link_group_id && deltas.has(id) && item?.link_group_id === clip.link_group_id);
    return restoreTrimmedHead ? leftTrim !== 0 : amount !== 0;
  }).map(([id, amount]) => {
    const item = document.clips.find(entry => entry.clip_id === id)!;
    const restoreTrimmedHead = id === clip.clip_id || Boolean(!ignoreLink && deltas.has(id) && clip.link_group_id && item.link_group_id === clip.link_group_id);
    return { clip_id: item.clip_id, timeline_start_us: restoreTrimmedHead ? item.timeline_start_us : item.timeline_start_us + amount };
  });
  if (placements.some(item => {
    const clipItem = document.clips.find(entry => entry.clip_id === item.clip_id)!;
    return isLocked(clipItem) && item.timeline_start_us !== clipItem.timeline_start_us || item.timeline_start_us < 0;
  })) return { operations: [], reason: "磁吸修剪会移动锁定或负时间片段" };
  const intervalsByTrack = new Map<string, Array<{ start: number; end: number }>>();
  for (const item of document.clips.filter(entry => entry.asset_kind !== "audio")) {
    const deltaForItem = deltas.get(item.clip_id) ?? 0;
    const trimmedGroup = item.clip_id === clip.clip_id || Boolean(!ignoreLink && deltas.has(item.clip_id) && clip.link_group_id && item.link_group_id === clip.link_group_id);
    const adjustedStart = trimmedGroup ? item.timeline_start_us : item.timeline_start_us + deltaForItem;
    const adjustedEnd = adjustedStart + (trimmedGroup ? newDuration : item.timeline_end_us - item.timeline_start_us);
    const bucket = intervalsByTrack.get(item.track_id) ?? [];
    bucket.push({ start: adjustedStart, end: adjustedEnd }); intervalsByTrack.set(item.track_id, bucket);
  }
  if ([...intervalsByTrack.values()].some(intervals => intervals.sort((a, b) => a.start - b.start).some((item, index) => index > 0 && item.start < intervals[index - 1]!.end))) return { operations: [], reason: "磁吸修剪会造成视频片段重叠" };
  const operations: TimelinePatchOperation[] = [{ op: "trim_clip", clip_id: clip.clip_id, source_start_us: sourceStartUs, source_end_us: sourceEndUs, ...(ignoreLink ? { ignore_link: true } : {}) }];
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

/** Trim a still image edge, with the same linked-edge and main-track ripple rules as a source-backed clip. */
export function planMagneticImageTrim(
  document: TimelineDocument,
  clip: TimelineClip,
  edge: "left" | "right",
  edgeDeltaUs: number,
  linkage: boolean,
  magnetic: boolean,
  ignoreLink = false,
): { operations: TimelinePatchOperation[]; reason?: string } {
  const lockedIds = new Set(document.locked_elements ?? []);
  const trackById = new Map(document.tracks.map(track => [track.id, track]));
  const isLocked = (item: TimelineClip) => lockedIds.has(item.clip_id) || Boolean(trackById.get(item.track_id)?.locked);
  const group = clip.link_group_id && !ignoreLink
    ? document.clips.filter(item => item.link_group_id === clip.link_group_id)
    : [clip];
  const writableGroup = group.filter(item => !isLocked(item));
  if (!writableGroup.some(item => item.clip_id === clip.clip_id)) return { operations: [], reason: "片段或轨道已锁定" };
  const durationDeltaUs = edge === "left" ? -edgeDeltaUs : edgeDeltaUs;
  const durations = new Map(writableGroup.map(item => [item.clip_id, item.timeline_end_us - item.timeline_start_us + durationDeltaUs]));
  if ([...durations.values()].some(duration => duration < 100_000)) return { operations: [], reason: "图片片段不能短于 100ms" };
  const operations: TimelinePatchOperation[] = writableGroup.map(item => ({
    op: "set_image_duration",
    clip_id: item.clip_id,
    duration_us: durations.get(item.clip_id)!,
  }));

  const placements = new Map<string, number>();
  if (!magnetic) {
    if (edge === "left" && edgeDeltaUs) for (const item of writableGroup) {
      placements.set(item.clip_id, item.timeline_start_us + edgeDeltaUs);
    }
  } else if (durationDeltaUs) {
    const editedTracks = new Set(writableGroup.map(item => item.track_id));
    const groupIds = new Set(writableGroup.map(item => item.clip_id));
    const pointUs = clip.timeline_end_us;
    const shiftedHosts = document.clips.filter(item =>
      editedTracks.has(item.track_id) && !groupIds.has(item.clip_id) && item.timeline_start_us >= pointUs,
    );
    for (const host of shiftedHosts) {
      const members = host.link_group_id
        ? document.clips.filter(item => item.link_group_id === host.link_group_id)
        : [host];
      for (const member of members) {
        if (isLocked(member)) return { operations: [], reason: "磁吸修剪会移动锁定的链接片段" };
        placements.set(member.clip_id, member.timeline_start_us + durationDeltaUs);
      }
    }
    if (linkage) {
      const main = document.clips.filter(item => item.track_id === "V1").sort((a, b) => a.timeline_start_us - b.timeline_start_us);
      const cuts = [...new Set(main.flatMap(item => [item.timeline_start_us, item.timeline_end_us]))].sort((a, b) => a - b);
      for (const item of document.clips) {
        if (editedTracks.has(item.track_id) || placements.has(item.clip_id) || isLocked(item)) continue;
        const owner = main.find(host => item.timeline_start_us >= host.timeline_start_us && item.timeline_start_us < host.timeline_end_us);
        if (!owner || !shiftedHosts.some(host => host.clip_id === owner.clip_id) || cuts.filter(cut => cut > item.timeline_start_us && cut < item.timeline_end_us).length > 1) continue;
        const members = item.link_group_id
          ? document.clips.filter(member => member.link_group_id === item.link_group_id)
          : [item];
        for (const member of members) {
          if (isLocked(member)) return { operations: [], reason: "磁吸修剪会移动锁定的联动片段" };
          placements.set(member.clip_id, member.timeline_start_us + durationDeltaUs);
        }
      }
    }
  }

  if (placements.size) {
    const intervalsByTrack = new Map<string, Array<{ start: number; end: number }>>();
    for (const item of document.clips) {
      const start = placements.get(item.clip_id) ?? item.timeline_start_us;
      const duration = durations.get(item.clip_id) ?? item.timeline_end_us - item.timeline_start_us;
      const bucket = intervalsByTrack.get(item.track_id) ?? [];
      bucket.push({ start, end: start + duration });
      intervalsByTrack.set(item.track_id, bucket);
    }
    if ([...intervalsByTrack.values()].some(items => items.sort((a, b) => a.start - b.start).some((item, index) => index > 0 && item.start < items[index - 1]!.end))) {
      return { operations: [], reason: "修剪后图片会与同轨片段重叠" };
    }
    operations.push({ op: "position_clips", placements: [...placements].map(([clipId, timelineStartUs]) => ({ clip_id: clipId as TimelineClip["clip_id"], timeline_start_us: timelineStartUs })) });
  }
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
  const editedTrackIds = new Set(group.map(member => member.track_id));
  const groupIds = new Set(group.map(member => member.clip_id));
  const following = document.clips.filter(item => editedTrackIds.has(item.track_id) && !groupIds.has(item.clip_id) && item.timeline_start_us >= clip.timeline_end_us);
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
    if (item.track_id === "V1" || groupIds.has(item.clip_id) || deltas.has(item.clip_id) || locked(item)) continue;
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
