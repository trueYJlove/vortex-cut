import type { TimelineClip, TimelineDocument, TimelinePatchOperation } from "@aivideo/contracts";

const MIN_SOURCE_PART_US = 100_000;

/** Translate a point on the timeline into the source clock used by Core's split operation. */
export function splitClipAt(clip: TimelineClip, timeUs: number, document?: TimelineDocument):
  Extract<TimelinePatchOperation, { op: "split_clip" }> | null {
  if (clip.asset_kind !== "video" || clip.reverse_playback || clip.source_start_us == null || clip.source_end_us == null ||
      timeUs <= clip.timeline_start_us || timeUs >= clip.timeline_end_us ||
      document?.locked_elements?.includes(clip.clip_id) || document?.tracks.find(track => track.id === clip.track_id)?.locked) return null;
  if (clip.link_group_id && document?.clips.some(member => member.link_group_id === clip.link_group_id &&
      (document.locked_elements?.includes(member.clip_id) || document.tracks.find(track => track.id === member.track_id)?.locked))) return null;
  const transition = document?.transitions?.find(item => item.after_clip_id === clip.clip_id);
  if (transition && timeUs > clip.timeline_end_us - transition.duration_us) return null;
  const source = clip.source_start_us + Math.round((timeUs - clip.timeline_start_us) * (clip.speed_milli ?? 1000) / 1000);
  return source - clip.source_start_us >= MIN_SOURCE_PART_US && clip.source_end_us - source >= MIN_SOURCE_PART_US
    ? { op: "split_clip", clip_id: clip.clip_id, source_time_us: source } : null;
}

export function splitSelectionAt(clips: readonly TimelineClip[], timeUs: number, document?: TimelineDocument) {
  const operations = clips.flatMap(clip => {
    const operation = splitClipAt(clip, timeUs, document);
    return operation ? [operation] : [];
  });
  return operations.length <= 100 ? operations : [];
}
