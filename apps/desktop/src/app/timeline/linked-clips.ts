import type { TimelineClip, TimelineDocument, TimelinePatchOperation } from "@aivideo/contracts";

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
