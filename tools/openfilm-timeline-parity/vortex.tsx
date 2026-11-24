import React from 'react';
import { createRoot } from 'react-dom/client';
import type { TimelineDocument } from '@aivideo/contracts';
import { TimelinePanel } from '../../apps/desktop/src/app/timeline/TimelineCanvas.js';
import { createPlayheadStore } from '../../apps/desktop/src/app/timeline/playhead-store.js';
import { WaveformCache, type WaveformPyramid } from '../../apps/desktop/src/app/timeline/waveform-cache.js';
import { TIMELINE_PREFS_STORAGE_KEY, type TimelineSelection } from '../../apps/desktop/src/app/timeline/types.js';
import fixture from './fixture.json';
import waveformFixture from './media/p235-timeline-audio-waveform.json';
import '../../apps/desktop/src/tailwind.css';
import '../../apps/desktop/src/styles.css';
import './harness.css';

const projectId = 'p235-visual-fixture';
const videoUrl = new URL('./media/p235-timeline-video.mp4', import.meta.url).href;
const audioUrl = new URL('./media/p235-timeline-audio.wav', import.meta.url).href;
const filmstripFrameUrls = fixture.media.filmstripFrameSeconds.map(seconds => new URL(`./media/p235-frame-${String(seconds).padStart(2, '0')}s.jpg`, import.meta.url).href);
// These are sparse stand-in decodes for OpenFilm's requested filmstrip sample
// positions. Each URL contains the nearest available source frame for that
// requested position (for example, request 5s maps to the 4s JPEG).
Object.assign(window, { __timelineFrameUrls: filmstripFrameUrls, __timelineFrameTimes: fixture.media.filmstripSeconds });
Object.assign(window, { __vortexDragOps: [] as unknown[], __timelineFixtureUiState: fixture.uiState });
const desktopBridge = (window as unknown as { desktop?: { assetMediaTicket: (assetId: string) => Promise<{ media_url: string }> } }).desktop ?? {};
desktopBridge.assetMediaTicket = async (assetId) => ({ media_url: assetId === 'asset-one-line.wav' ? audioUrl : videoUrl });
(window as unknown as { desktop: typeof desktopBridge }).desktop = desktopBridge;

function makeWaveformPyramid(peaks: readonly number[]): WaveformPyramid {
  const levelData: Float32Array[] = [];
  let values = new Float32Array(peaks.length * 2);
  for (let index = 0; index < peaks.length; index += 1) {
    values[index * 2] = -peaks[index]!;
    values[index * 2 + 1] = peaks[index]!;
  }
  levelData.push(values);
  while (values.length > 2) {
    const next = new Float32Array(Math.ceil(values.length / 4) * 2);
    for (let bucket = 0; bucket < next.length / 2; bucket += 1) {
      const first = bucket * 4;
      next[bucket * 2] = Math.min(values[first] ?? 0, values[first + 2] ?? 0);
      next[bucket * 2 + 1] = Math.max(values[first + 1] ?? 0, values[first + 3] ?? 0);
    }
    levelData.push(next);
    values = next;
  }
  return {
    baseBuckets: peaks.length,
    levels: levelData.length,
    levelData,
    totalBytes: levelData.reduce((sum, level) => sum + level.byteLength, 0),
  };
}

const waveformCache = new WaveformCache({
  getWaveform: async () => { throw new Error('visual harness uses a seeded waveform cache'); },
  waveformMediaUrl: async () => { throw new Error('visual harness uses a seeded waveform cache'); },
}, projectId);
const readyWaveform = {
  state: 'ready' as const,
  pyramid: makeWaveformPyramid(waveformFixture.peaks),
  bucketSpanUs: 25_000,
  promise: Promise.resolve(null),
  seq: 1,
};
(waveformCache as unknown as { entries: Map<string, typeof readyWaveform> }).entries.set('asset-one-line.wav', readyWaveform);
(waveformCache as unknown as { entries: Map<string, typeof readyWaveform> }).entries.set('asset-blue-court.mp4', readyWaveform);
(waveformCache as unknown as { entries: Map<string, typeof readyWaveform> }).entries.set('asset-match-cut.mp4', readyWaveform);
(waveformCache as unknown as { entries: Map<string, typeof readyWaveform> }).entries.set('asset-main-shot.mp4', readyWaveform);
localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify({
  snappingEnabled: fixture.uiState.snappingEnabled,
  mainTrackMagnet: fixture.uiState.mainTrackMagnet,
  linkageEnabled: fixture.uiState.linkageEnabled,
  trackHeight: 56,
  waveformRatio: 0.3,
}));
localStorage.setItem(`${TIMELINE_PREFS_STORAGE_KEY}.project.${encodeURIComponent(projectId)}.track-heights`, JSON.stringify({ V3: 52, V2: 52, V1: 68, A1: 42 }));
localStorage.setItem('vortex-cut.timeline.markers.v1', JSON.stringify({
  [projectId]: fixture.uiState.markers.map((marker) => ({
    id: marker.id,
    timeUs: marker.timeUs,
    color: marker.color === 'yellow' ? '#e8c547' : '#4c8dff',
    label: marker.label,
  })),
}));

const tracks = fixture.tracks.map((track) => ({
  id: track.id,
  kind: track.kind === 'audio' ? 'audio' as const : 'video' as const,
  locked: false,
  hidden: false,
  muted: false,
  solo: false,
}));
const clips = fixture.clips.map((clip, index) => ({
  clip_id: clip.id as never,
  track_id: clip.trackId,
  order_index: index,
  asset_id: `asset-${clip.title}` as never,
  asset_kind: clip.kind,
  source_start_us: 0,
  source_end_us: clip.endUs - clip.startUs,
  timeline_start_us: clip.startUs,
  timeline_end_us: clip.endUs,
  layout: 'fit' as const,
  audio: { enabled: clip.kind === 'video', gain_db: 0 },
}));
const documentModel: TimelineDocument = {
  schema_version: 1,
  project_id: projectId as never,
  canvas: { width: 1920, height: 1080, fps_num: fixture.fps.num, fps_den: fixture.fps.den, background_color: '#000000' },
  tracks,
  clips,
  captions: [],
  transitions: [],
  provenance: { created_by: 'user', source_transcript_ids: [] },
};

function applyVortexOperations(current: TimelineDocument, operations: unknown[]): TimelineDocument {
  const placements = new Map<string, { track_id?: string; timeline_start_us: number }>();
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || !('op' in operation) || operation.op !== 'position_clips' || !('placements' in operation) || !Array.isArray(operation.placements)) continue;
    for (const item of operation.placements) {
      if (!item || typeof item !== 'object' || !('clip_id' in item) || typeof item.clip_id !== 'string' || !('timeline_start_us' in item) || typeof item.timeline_start_us !== 'number') continue;
      if ('track_id' in item && typeof item.track_id !== 'string') continue;
      placements.set(item.clip_id, {
        ...('track_id' in item && typeof item.track_id === 'string' ? { track_id: item.track_id } : {}),
        timeline_start_us: item.timeline_start_us,
      });
    }
  }
  if (!placements.size) return current;
  return {
    ...current,
    clips: current.clips.map((clip) => {
      const placement = placements.get(clip.clip_id);
      if (!placement) return clip;
      const durationUs = clip.timeline_end_us - clip.timeline_start_us;
      return {
        ...clip,
        track_id: placement.track_id ?? clip.track_id,
        timeline_start_us: placement.timeline_start_us,
        timeline_end_us: placement.timeline_start_us + durationUs,
      };
    }),
  };
}

const playheadStore = createPlayheadStore();
playheadStore.set(fixture.playheadUs);

function VortexHarness() {
  const [currentDocument, setCurrentDocument] = React.useState(documentModel);
  const [selection, setSelection] = React.useState<TimelineSelection>(null);
  (window as unknown as { __vortexSetDocument?: typeof setCurrentDocument }).__vortexSetDocument = setCurrentDocument;
  (window as unknown as { __vortexDocument?: TimelineDocument }).__vortexDocument = currentDocument;
  return <div className="editor-shell" style={{ position: 'relative', width: '100vw', height: `${fixture.viewport.height}px`, minHeight: 0, display: 'block' }}>
    <div className="timeline-fixture-frame" style={{ position: 'absolute', left: `${fixture.timelineRegion.x}px`, top: `${fixture.timelineRegion.y}px`, width: `${fixture.timelineRegion.width}px`, height: `${fixture.timelineRegion.height}px` }}>
      <TimelinePanel
      projectId={projectId}
      document={currentDocument}
      selection={selection}
      setSelection={setSelection}
      onPatch={async (ops, summary) => {
        (window as unknown as { __vortexDragOps: unknown[] }).__vortexDragOps.push({ ops, summary });
        setCurrentDocument((current) => applyVortexOperations(current, ops as unknown[]));
      }}
      onDropAsset={() => undefined}
      canUndo={fixture.uiState.canUndo}
      canRedo={fixture.uiState.canRedo}
      onUndo={() => undefined}
      onRedo={() => undefined}
      assetMedia={fixture.clips.map((clip) => ({
        asset_id: `asset-${clip.title}`,
        media_url: clip.kind === 'audio' ? audioUrl : videoUrl,
        kind: clip.kind === 'audio' ? 'audio' : 'video',
        display_name: clip.title,
        duration_us: clip.kind === 'audio' ? fixture.media.audio.durationUs : fixture.media.video.durationUs,
        has_audio: clip.kind === 'video',
      }))}
      waveformCache={waveformCache}
      playheadStore={playheadStore}
      onSeek={() => undefined}
      onSeekCommit={() => undefined}
      coverUrl={null}
      playing={false}
      />
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<VortexHarness />);
