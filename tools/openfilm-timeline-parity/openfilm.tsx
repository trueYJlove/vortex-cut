import React from 'react';
import { createRoot } from 'react-dom/client';
import { Timeline, type TimelineProps } from 'C:/DataFolder/codes/openfilm/packages/openfilm/studio/ui/src/components/Timeline.tsx';
import { LaneMarkers, type MarkerActions } from 'C:/DataFolder/codes/openfilm/packages/openfilm/studio/ui/src/components/TimelineMarkers.tsx';
import { addMarker, changeMarker, placeMarkers, removeMarker, type Marker } from 'C:/DataFolder/codes/openfilm/packages/openfilm/studio/ui/src/lib/markers.ts';
import type { TimelineBlock, TimelineTrack } from 'C:/DataFolder/codes/openfilm/packages/openfilm/studio/ui/src/lib/timeline-layout.ts';
import { setLanguageChoice } from 'C:/DataFolder/codes/openfilm/packages/openfilm/studio/ui/src/i18n/index.ts';
import { setTimecodeFps } from 'C:/DataFolder/codes/openfilm/packages/openfilm/studio/ui/src/lib/timecode.ts';
import fixture from './fixture.json';
import waveformFixture from './media/p235-timeline-audio-waveform.json';
import 'C:/DataFolder/codes/openfilm/packages/openfilm/studio/ui/src/globals.css';

setLanguageChoice('zh-CN');
setTimecodeFps(fixture.fps.num / fixture.fps.den);
Object.assign(window, { __openfilmDragOps: [] as unknown[], __openfilmView: null as unknown, __timelineFixtureUiState: fixture.uiState });

const videoSrc = new URL('./media/p235-timeline-video.mp4', import.meta.url).href;
const audioSrc = new URL('./media/p235-timeline-audio.wav', import.meta.url).href;
const waveformUrl = `data:application/json,${encodeURIComponent(JSON.stringify(waveformFixture))}`;
const filmstripFrames = fixture.media.filmstripSeconds.map((seconds, index) => ({
  seconds,
  url: new URL(`./media/p235-frame-${String(fixture.media.filmstripFrameSeconds[index]).padStart(2, '0')}s.jpg`, import.meta.url).href,
}));
const thumbs = new Map<string, string>();
for (const clip of fixture.clips.filter(item => item.kind === 'video')) {
  for (const frame of filmstripFrames) {
    if (frame.seconds * 1000 > (clip.endUs - clip.startUs) / 1000) continue;
    thumbs.set(`fixture:${clip.id}@${frame.seconds * 1000}#v`, frame.url);
  }
}

const tracks: TimelineTrack[] = fixture.tracks.map((track, index) => ({
  lane: track.id,
  role: track.kind === 'audio' ? 'audio' : 'video',
  index: 1,
  name: track.id,
  badge: track.id,
  kind: track.kind === 'audio' ? 'audio' : 'video',
  docIndex: index,
  height: track.height,
  main: track.id === 'V1',
  blocks: fixture.clips.filter((clip) => clip.trackId === track.id).map((clip, clipIndex): TimelineBlock => ({
    id: clip.id,
    clipId: clip.id,
    loc: `film.html#${index}.${clipIndex}`,
    anchor: { move: 'at', resize: 'end', trimFrom: 0, parentStartMs: 0 },
    title: clip.title,
    startMs: clip.startUs / 1000,
    endMs: clip.endUs / 1000,
    kind: clip.kind === 'audio' ? 'voice' : 'video',
    src: clip.kind === 'audio' ? audioSrc : videoSrc,
    sourceDurMs: clip.kind === 'audio' ? fixture.media.audio.durationUs / 1000 : fixture.media.video.durationUs / 1000,
    inMs: 0,
    ownAudio: clip.kind === 'video',
  })),
}));

const noop = async (): Promise<null> => null;

function applyOpenFilmOperations(current: TimelineTrack[], operations: unknown[]): TimelineTrack[] {
  let next = current.map((track) => ({ ...track, blocks: [...track.blocks] }));
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || !('op' in operation) || operation.op !== 'props' || !('edits' in operation) || !Array.isArray(operation.edits)) continue;
    const editsByClip = new Map<string, Record<string, unknown>>();
    for (const edit of operation.edits) {
      if (!edit || typeof edit !== 'object' || !('clip' in edit) || typeof edit.clip !== 'string' || !('prop' in edit) || typeof edit.prop !== 'string' || !('value' in edit)) continue;
      editsByClip.set(edit.clip, { ...editsByClip.get(edit.clip), [edit.prop]: edit.value });
    }
    for (const [clipId, edits] of editsByClip) {
      const sourceIndex = next.findIndex((track) => track.blocks.some((block) => block.id === clipId));
      const block = next[sourceIndex]?.blocks.find((item) => item.id === clipId);
      if (!block || sourceIndex < 0) continue;
      const requestedTrackIndex = typeof edits.track === 'number'
        ? next.findIndex((track) => track.docIndex === edits.track)
        : sourceIndex;
      const targetTrackIndex = requestedTrackIndex >= 0 ? requestedTrackIndex : sourceIndex;
      const startMs = typeof edits.at === 'number' ? edits.at * 1000 : block.startMs;
      const moved = { ...block, startMs, endMs: startMs + (block.endMs - block.startMs) };
      next = next.map((track, index) => ({
        ...track,
        blocks: index === targetTrackIndex
          ? [...track.blocks.filter((item) => item.id !== clipId), moved].sort((a, b) => a.startMs - b.startMs)
          : index === sourceIndex
            ? track.blocks.filter((item) => item.id !== clipId)
            : track.blocks,
      }));
    }
  }
  return next;
}

function OpenFilmHarness() {
  const [currentTracks, setCurrentTracks] = React.useState(tracks);
  (window as unknown as { __openfilmSetTracks?: typeof setCurrentTracks }).__openfilmSetTracks = setCurrentTracks;
  (window as unknown as { __openfilmTracks?: TimelineTrack[] }).__openfilmTracks = currentTracks;
  const [markers, setMarkers] = React.useState<Marker[]>(fixture.uiState.markers.map((marker) => ({
    id: marker.id,
    t: marker.timeUs / 1_000_000,
    color: marker.color as Marker['color'],
  })));
  const [naming, setNaming] = React.useState<string | null>(null);
  const placedMarkers = React.useMemo(() => placeMarkers(markers, currentTracks), [markers, currentTracks]);
  const markerActions = React.useMemo<MarkerActions>(() => ({
    onChange: (id, change) => setMarkers((current) => changeMarker(current, id, change)),
    onRemove: (id) => setMarkers((current) => removeMarker(current, id)),
    naming,
    onNamed: () => setNaming(null),
  }), [naming]);
  const addPlayheadMarker = () => {
    const { list, added } = addMarker(markers, fixture.playheadUs / 1000);
    if (list.length === markers.length) setNaming(added.id);
    else setMarkers(list);
  };
  const markerLane = React.useMemo(() => ({
    shown: placedMarkers.some((marker) => !marker.clip),
    render: (lane: Parameters<NonNullable<TimelineProps['markerLane']>['render']>[0]) => (
      <LaneMarkers placed={placedMarkers} lane={lane} actions={markerActions} />
    ),
  }), [placedMarkers, markerActions]);
  const props: TimelineProps = {
    tracks: currentTracks,
    totalMs: fixture.durationUs / 1000,
    timeMs: fixture.playheadUs / 1000,
    playing: false,
    onScrubPreview: () => undefined,
    onScrubCommit: () => undefined,
    onSeek: () => undefined,
    onEditOps: async (ops, label) => {
      (window as unknown as { __openfilmDragOps: unknown[] }).__openfilmDragOps.push({ ops, label });
      setCurrentTracks((current) => applyOpenFilmOperations(current, ops as unknown[]));
      return null;
    },
    onRemove: noop,
    onRemoveMany: noop,
    history: { canUndo: fixture.uiState.canUndo, canRedo: fixture.uiState.canRedo, step: () => undefined },
    onSplit: async () => null,
    onAddMarker: addPlayheadMarker,
    markerLane,
    snapPointsMs: placedMarkers.map((marker) => marker.ms),
    onMarkRange: () => undefined,
    onSelectedChange: () => undefined,
    onViewChange: (view) => { (window as unknown as { __openfilmView: unknown }).__openfilmView = view; },
    selected: fixture.uiState.selectedClipIds,
    solo: { tracks: new Set<number>(), onToggle: () => undefined },
    cover: { thumb: null, open: () => undefined, menu: () => [] },
    thumbs,
    waveUrl: () => waveformUrl,
  };
  return <main className="@container flex min-h-0 min-w-0 flex-1 flex-col" style={{ position: 'absolute', left: `${fixture.timelineRegion.x}px`, top: `${fixture.timelineRegion.y}px`, width: `${fixture.timelineRegion.width}px`, height: `${fixture.timelineRegion.height}px`, overflow: 'hidden' }}>
    <Timeline {...props} />
  </main>;
}

createRoot(document.getElementById('root')!).render(<OpenFilmHarness />);
