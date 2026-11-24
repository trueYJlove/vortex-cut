import type { TimelineClip, TimelineDocument, TimelinePatchOperation } from "@aivideo/contracts";
import type { TimelineSelection } from "./types.js";

/** Marquee hits include the explicit link partners, matching OpenFilm's withLinked(selection). */
export function expandLinkedClipIds(clipIds: readonly string[], clips: readonly TimelineClip[]): TimelineClip["clip_id"][] {
  const selected = new Set(clipIds);
  const groups = new Set(clips.filter(clip => selected.has(clip.clip_id) && clip.link_group_id).map(clip => clip.link_group_id!));
  return clips.flatMap(clip => selected.has(clip.clip_id) || (clip.link_group_id && groups.has(clip.link_group_id))
    ? [clip.clip_id]
    : []);
}

/** Merge a marquee with an existing clip selection, then include every linked partner. */
export function mergeLinkedMarqueeSelection(
  selection: TimelineSelection,
  hitIds: readonly string[],
  clips: readonly TimelineClip[],
): TimelineClip["clip_id"][] {
  const selectedIds = selection?.kind === "clip"
    ? [selection.id]
    : selection?.kind === "clips" ? selection.ids : [];
  return expandLinkedClipIds([...selectedIds, ...hitIds], clips);
}

/** One remove operation per link group: Core removes the entire group atomically. */
export function removeLinkedClips(clips: readonly TimelineClip[], document: TimelineDocument | undefined): TimelinePatchOperation[] {
  if (!document) return [];
  const groups = new Set<string>();
  const operations: TimelinePatchOperation[] = [];
  for (const clip of clips) {
    const group = clip.link_group_id;
    if (group && groups.has(group)) continue;
    if (group) groups.add(group);
    const affected = group ? document.clips.filter(item => item.link_group_id === group) : [clip];
    if (affected.some(item => document.locked_elements?.includes(item.clip_id) || document.tracks.find(track => track.id === item.track_id)?.locked)) continue;
    operations.push({ op: "remove_clip", clip_id: clip.clip_id });
  }
  return operations;
}
