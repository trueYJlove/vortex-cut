import type { TimelineDocument, TimelinePatchOperation } from "@aivideo/contracts";

/** Plan the OpenFilm close-gap action, preserving the spacing of everything after the gap. */
export function closeGapAt(document: TimelineDocument | undefined, trackId: string | null, timeUs: number): TimelinePatchOperation[] {
  if (!document || !trackId || document.tracks.find(track => track.id === trackId)?.locked) return [];
  const clips = document.clips.filter(clip => clip.track_id === trackId).sort((a, b) => a.timeline_start_us - b.timeline_start_us);
  const next = clips.find(clip => clip.timeline_start_us > timeUs);
  if (!next || clips.some(clip => clip.timeline_start_us <= timeUs && timeUs < clip.timeline_end_us)) return [];
  const previousEnd = clips.filter(clip => clip.timeline_end_us <= timeUs).reduce((end, clip) => Math.max(end, clip.timeline_end_us), 0);
  const gap = next.timeline_start_us - previousEnd;
  const moving = clips.filter(clip => clip.timeline_start_us >= next.timeline_start_us);
  // Core carries linked sound with its picture. A group with more than one picture
  // needs a cross-track collision plan, so refuse it rather than break the group.
  if (gap <= 0 || moving.some(clip => {
    const members = clip.link_group_id ? document.clips.filter(item => item.link_group_id === clip.link_group_id) : [clip];
    return members.filter(item => item.asset_kind !== "audio").length > 1 || members.some(item =>
      item.timeline_start_us < gap || document.locked_elements?.includes(item.clip_id) ||
      document.tracks.find(track => track.id === item.track_id)?.locked);
  })) return [];
  const ids = new Set(moving.map(clip => clip.clip_id));
  for (const clip of moving) {
    if (clip.link_group_id) for (const member of document.clips) {
      if (member.link_group_id === clip.link_group_id) ids.add(member.clip_id);
    }
  }
  const placements = document.clips.filter(clip => ids.has(clip.clip_id)).map(clip => ({
    clip_id: clip.clip_id, timeline_start_us: clip.timeline_start_us - gap,
  }));
  // All clip positions travel in one position_clips operation. The shared
  // patch contract limits operations, not the number of placements inside it.
  return placements.length ? [{ op: "position_clips", placements }] : [];
}
