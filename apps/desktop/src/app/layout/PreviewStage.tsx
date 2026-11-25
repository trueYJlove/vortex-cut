import type { Dispatch, KeyboardEvent, MutableRefObject, PointerEvent, RefObject, SetStateAction } from "react";
import {
  LayoutPanelLeft,
  Maximize,
  Minimize,
  Pause,
  Play,
  Repeat,
  Settings2,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  ZoomIn,
} from "lucide-react";
import type {
  AssetPresentation,
  EncoderMode,
  OutputRatio,
  Project,
  TimelineCaption,
  TimelineClip,
  TimelineDocument,
  TimelineState,
} from "@aivideo/contracts";
import type { ExportRecordPresentation, RenditionReframePreviewPresentation } from "../../../electron/preload/index.js";
import { PreviewPipOverlays, type PipOverlay, type PipTransform } from "../PreviewPipOverlays.js";
import { SyntheticPreview } from "../preview/SyntheticPreview.js";
import type { AssetDecodeBudget } from "../preview/preview-session.js";
import type { PreviewSourceResolver } from "../preview/source-resolver.js";
import { syntheticFallbackNotice } from "../preview/fallback-notice.js";
import type { PlayheadStore } from "../timeline/playhead-store.js";
import type { TimeRange } from "../timeline/time-range.js";
import { formatSmpteTimecode, previewRatios, type Selection } from "../appHelpers.js";

export interface PreviewStageProps {
  project: Project | undefined;
  timeline: TimelineState | undefined;
  working: TimelineDocument | undefined;
  selection: Selection;
  setSelection: (selection: Selection) => void;
  selectedClip: TimelineClip | undefined;
  clipAtPlayhead: TimelineClip | undefined;
  audioAsset: AssetPresentation | undefined;
  previewAsset: AssetPresentation | undefined;
  mainTransformStyle: { transform: string; opacity: number } | undefined;
  visibleCaption: TimelineCaption | undefined;
  tracksAtPlayhead: TimelineDocument["tracks"];
  trackIndexByClipId: Map<string, number>;
  isClipAudible: (clip: TimelineClip) => boolean;
  overlayPips: PipOverlay[];
  overlayClipSelected: boolean;
  pipSelectedId: TimelineClip["clip_id"] | null;
  pipLocked: boolean;
  draftPipTransform: (clipId: TimelineClip["clip_id"], transform: PipTransform) => void;
  commitPipTransform: (clipId: TimelineClip["clip_id"], transform: PipTransform) => Promise<boolean>;
  draftPipMask: (clipId: TimelineClip["clip_id"], mask: NonNullable<TimelineClip["mask"]>) => void;
  commitPipMask: (clipId: TimelineClip["clip_id"], mask: NonNullable<TimelineClip["mask"]>) => void;
  leftPaneOpen: boolean;
  setLeftPaneOpen: Dispatch<SetStateAction<boolean>>;
  rightPaneOpen: boolean;
  setRightPaneOpen: Dispatch<SetStateAction<boolean>>;
  paneSettingsOpen: boolean;
  setPaneSettingsOpen: Dispatch<SetStateAction<boolean>>;
  paneSettingsRef: RefObject<HTMLSpanElement | null>;
  effectiveRatio: OutputRatio;
  changePreviewRatio: (value: string) => void;
  encoderMode: EncoderMode;
  setEncoderMode: (mode: EncoderMode) => void;
  setRenderPanelOpen: (open: boolean) => void;
  renderActivity: number;
  renderRatio: OutputRatio;
  previewClass: string;
  previewSelected: boolean;
  isViewerFit: boolean;
  previewZoom: number | "fit";
  zoomT: (z: number) => number;
  resetZoom: () => void;
  applySliderZoom: (sliderValue: number) => void;
  stagePaneRef: RefObject<HTMLElement | null>;
  stageColumnRef: RefObject<HTMLDivElement | null>;
  previewFrameRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLDivElement | null>;
  selBoxRef: RefObject<HTMLDivElement | null>;
  stageMarquee: { x: number; y: number; w: number; h: number } | null;
  selDimsText: string;
  isFullscreen: boolean;
  toggleFullscreen: () => Promise<void>;
  onPreviewPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPreviewPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPreviewPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onPreviewPointerCancel: () => void;
  onPreviewKeyDown: (event: KeyboardEvent<HTMLDivElement>, onSelectAtPlayhead: () => void) => void;
  selectClipAtPlayhead: () => void;
  beginSelDrag: (dir: string) => (event: PointerEvent<HTMLElement>) => void;
  moveSelDrag: (event: PointerEvent<HTMLElement>) => void;
  endSelDrag: (event: PointerEvent<HTMLElement>) => void;
  previewMode: "interactive" | "authoritative" | "synthetic";
  setPreviewMode: (mode: "interactive" | "authoritative" | "synthetic") => void;
  authoritativeMediaUrl: string | null | undefined;
  reframePlayback: RenditionReframePreviewPresentation | undefined;
  setReframePlayback: (value: RenditionReframePreviewPresentation | undefined) => void;
  exportPlayback: ExportRecordPresentation | undefined;
  setExportPlayback: (value: ExportRecordPresentation | undefined) => void;
  previewIsStale: boolean;
  syntheticNotice: string | null;
  setSyntheticNotice: (notice: string | null) => void;
  projectStateReady: boolean;
  preparePreviewPlaybackRef: RefObject<(() => void) | null>;
  previewSessionRef: RefObject<{
    seekToFrame(target: number): Promise<number>;
    play(): void;
    pause(): void;
    beginScrubStorm(): void;
    endScrubStorm(): void;
    getMeterSamples?(): readonly [Float32Array, Float32Array] | null;
  } | null>;
  syntheticMediaUrls: Map<string, string>;
  syntheticAudioByClip: Map<TimelineClip["clip_id"], { readonly enabled: boolean; readonly gainDb: number; readonly fadeInUs: number | undefined; readonly fadeOutUs: number | undefined }>;
  syntheticPipClips: Array<{
    clipId: string;
    transform: { x: number | undefined; y: number | undefined; scale: number | undefined; rotate: number | undefined; opacity: number | undefined };
    mask: TimelineClip["mask"] | undefined;
  }>;
  previewSourceResolver: PreviewSourceResolver | null;
  resourceTier: "conservative" | "balanced" | "high" | undefined;
  forceCopyTo: boolean;
  syntheticSnapshotRef: MutableRefObject<(() => Promise<{ buffer: ArrayBuffer; contentX: number; contentY: number; contentW: number; contentH: number } | null>) | null>;
  proxyReadyEpoch: number;
  onDecodeBudget: (verdicts: AssetDecodeBudget[]) => void;
  seenAnyTicketRef: RefObject<boolean>;
  pausePreviewPlayback: () => boolean;
  resumePreviewPlayback: (wasPlaying: boolean) => void;
  gestureHoldRef: RefObject<boolean>;
  playing: boolean;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  playhead: number;
  playheadStore: PlayheadStore;
  uiRate: number;
  setUiRate: (rate: number) => void;
  previewReverse: boolean;
  interactiveMediaRatePlayable: boolean;
  libraryPreviewId: string | null;
  totalUs: number;
  previewFps: number;
  progressPct: number;
  progressDragging: boolean;
  setProgressDragging: (dragging: boolean) => void;
  progressRef: RefObject<HTMLDivElement | null>;
  pgBubbleRef: RefObject<HTMLDivElement | null>;
  pgFillRef: RefObject<HTMLDivElement | null>;
  tcTimeRef: RefObject<HTMLElement | null>;
  volRailRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  audioRef: RefObject<HTMLAudioElement | null>;
  togglePlayback: () => void;
  dispatchPlayhead: (source: "user" | "playback" | "external", timeUs: number, commitReact: boolean) => void;
  seekFromPlayback: (timeUs: number) => void;
  handlePreviewEnded: () => void;
  handleVideoEnded: () => void;
  seekFromProgress: (clientX: number) => void;
  scrubFromProgress: (clientX: number) => void;
  commitScrub: (timeUs: number) => void;
  seekFromProgressRatio: (ratio: number) => void;
  ratePopOpen: boolean;
  setRatePopOpen: Dispatch<SetStateAction<boolean>>;
  ratePopRef: RefObject<HTMLDivElement | null>;
  volPopOpen: boolean;
  setVolPopOpen: Dispatch<SetStateAction<boolean>>;
  volPopRef: RefObject<HTMLDivElement | null>;
  zoomPopOpen: boolean;
  setZoomPopOpen: Dispatch<SetStateAction<boolean>>;
  zoomPopRef: RefObject<HTMLDivElement | null>;
  loopPlayback: boolean;
  setLoopPlayback: Dispatch<SetStateAction<boolean>>;
  playbackRange: TimeRange | null;
  loopSeekPending: RefObject<boolean>;
  cancelLoopRestart: () => void;
  volume: number;
  setVolume: (vol: number) => void;
  seekVolumeFrom: (clientY: number) => void;
}

export function PreviewStage(props: PreviewStageProps) {
  const {
    project,
    timeline,
    working,
    selection,
    setSelection,
    selectedClip,
    clipAtPlayhead,
    audioAsset,
    previewAsset,
    mainTransformStyle,
    visibleCaption,
    tracksAtPlayhead,
    trackIndexByClipId,
    isClipAudible,
    overlayPips,
    overlayClipSelected,
    pipSelectedId,
    pipLocked,
    draftPipTransform,
    commitPipTransform,
    draftPipMask,
    commitPipMask,
    leftPaneOpen,
    setLeftPaneOpen,
    rightPaneOpen,
    setRightPaneOpen,
    paneSettingsOpen,
    setPaneSettingsOpen,
    paneSettingsRef,
    effectiveRatio,
    changePreviewRatio,
    encoderMode,
    setEncoderMode,
    setRenderPanelOpen,
    renderActivity,
    renderRatio,
    previewClass,
    previewSelected,
    isViewerFit,
    previewZoom,
    zoomT,
    resetZoom,
    applySliderZoom,
    stagePaneRef,
    stageColumnRef,
    previewFrameRef,
    canvasRef,
    selBoxRef,
    stageMarquee,
    selDimsText,
    isFullscreen,
    toggleFullscreen,
    onPreviewPointerDown,
    onPreviewPointerMove,
    onPreviewPointerUp,
    onPreviewPointerCancel,
    onPreviewKeyDown,
    selectClipAtPlayhead,
    beginSelDrag,
    moveSelDrag,
    endSelDrag,
    previewMode,
    setPreviewMode,
    authoritativeMediaUrl,
    reframePlayback,
    setReframePlayback,
    exportPlayback,
    setExportPlayback,
    previewIsStale,
    syntheticNotice,
    setSyntheticNotice,
    projectStateReady,
    preparePreviewPlaybackRef,
    previewSessionRef,
    syntheticMediaUrls,
    syntheticAudioByClip,
    syntheticPipClips,
    previewSourceResolver,
    resourceTier,
    forceCopyTo,
    syntheticSnapshotRef,
    proxyReadyEpoch,
    onDecodeBudget,
    seenAnyTicketRef,
    pausePreviewPlayback,
    resumePreviewPlayback,
    gestureHoldRef,
    playing,
    setPlaying,
    playhead,
    playheadStore,
    uiRate,
    setUiRate,
    previewReverse,
    interactiveMediaRatePlayable,
    libraryPreviewId,
    totalUs,
    previewFps,
    progressPct,
    progressDragging,
    setProgressDragging,
    progressRef,
    pgBubbleRef,
    pgFillRef,
    tcTimeRef,
    volRailRef,
    videoRef,
    audioRef,
    togglePlayback,
    dispatchPlayhead,
    seekFromPlayback,
    handlePreviewEnded,
    handleVideoEnded,
    seekFromProgress,
    scrubFromProgress,
    commitScrub,
    seekFromProgressRatio,
    ratePopOpen,
    setRatePopOpen,
    ratePopRef,
    volPopOpen,
    setVolPopOpen,
    volPopRef,
    zoomPopOpen,
    setZoomPopOpen,
    zoomPopRef,
    loopPlayback,
    setLoopPlayback,
    playbackRange,
    loopSeekPending,
    cancelLoopRestart,
    volume,
    setVolume,
    seekVolumeFrom,
  } = props;

  return (
    <section ref={stagePaneRef} className={`stage-pane${isFullscreen ? " fullscreen" : ""}`} aria-label="项目预览">
      <div className="stage-column" ref={stageColumnRef}>
        <div className="pane-bar">
          <button type="button" className={`pane-bar-btn${leftPaneOpen ? " on" : ""}`} aria-pressed={leftPaneOpen} aria-label="媒体库面板开关" title={leftPaneOpen ? "收起媒体库" : "展开媒体库"} onClick={() => setLeftPaneOpen(value => !value)}><LayoutPanelLeft size={16} aria-hidden="true" /></button>
          <span className="pane-bar-spacer" />
          <button type="button" className={`pane-bar-btn${rightPaneOpen ? " on" : ""}`} aria-pressed={rightPaneOpen} aria-label="属性面板开关" title={rightPaneOpen ? "收起属性面板" : "展开属性面板"} onClick={() => setRightPaneOpen(value => !value)}><SlidersHorizontal size={16} aria-hidden="true" /></button>
          <span className="pane-settings-anchor" ref={paneSettingsRef}>
            <button type="button" className={`pane-bar-btn${paneSettingsOpen ? " on" : ""}`} aria-haspopup="dialog" aria-expanded={paneSettingsOpen} aria-label="预览设置" title="预览设置（比例 / 编码）" onClick={event => { event.stopPropagation(); setPaneSettingsOpen(value => !value); }}><Settings2 size={16} aria-hidden="true" /></button>
            {paneSettingsOpen && (
              <div className="pane-settings-pop" role="dialog" aria-label="预览设置" onClick={event => event.stopPropagation()}>
                <div className="pane-settings-row">
                  <label>
                    <span className="sr-only">预览比例</span>
                    <select aria-label="预览比例" value={effectiveRatio} onChange={event => changePreviewRatio(event.target.value)}>{previewRatios.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
                  </label>
                  <label>
                    <span className="sr-only">编码模式</span>
                    <select aria-label="编码模式" value={encoderMode} onChange={event => setEncoderMode(event.target.value as EncoderMode)}><option value="auto">自动</option><option value="software">软件</option></select>
                  </label>
                </div>
                <button type="button" className="pane-settings-action" onClick={() => { setPaneSettingsOpen(false); setRenderPanelOpen(true); }} aria-label="渲染与导出">渲染与导出{renderActivity ? <span className="render-badge" aria-hidden="true">{renderActivity}</span> : null}</button>
              </div>
            )}
          </span>
        </div>
        <div className="stage-view">
          <div
            ref={previewFrameRef}
            className={`preview-frame ${previewClass}${previewSelected ? " selected" : ""}${isViewerFit ? "" : " zoomed"}`}
            role="button"
            tabIndex={0}
            aria-label="预览画布。Ctrl 或 Command 加滚轮缩放，中键拖动画面；放大后可用方向键平移"
            title="Ctrl / Command + 滚轮缩放；放大后中键拖动或用方向键平移"
            onPointerDown={onPreviewPointerDown}
            onPointerMove={onPreviewPointerMove}
            onPointerUp={onPreviewPointerUp}
            onPointerCancel={onPreviewPointerCancel}
            onClick={selectClipAtPlayhead}
            onKeyDown={event => onPreviewKeyDown(event, selectClipAtPlayhead)}
          >
            {stageMarquee && <div className="preview-marquee" aria-hidden="true" style={{ left: stageMarquee.x, top: stageMarquee.y, width: stageMarquee.w, height: stageMarquee.h }} />}
            <div className="preview-canvas" ref={canvasRef}>
              {previewMode === "authoritative" && authoritativeMediaUrl && (
                <video
                  ref={videoRef}
                  className="preview-foreground authoritative-video"
                  src={authoritativeMediaUrl}
                  aria-label={reframePlayback ? "重构图权威预览视频" : exportPlayback ? "导出视频" : "权威预览视频"}
                  controls
                  onEnded={() => { setPlaying(false); setExportPlayback(undefined); setReframePlayback(undefined); setPreviewMode("synthetic"); }}
                />
              )}
              {previewMode === "synthetic" && projectStateReady && project && working && timeline && working.clips.length > 0 && (
                <SyntheticPreview
                  preparePlaybackRef={preparePreviewPlaybackRef}
                  key={project.project_id}
                  outputRatio={renderRatio}
                  projectId={project.project_id}
                  revisionId={timeline.current_revision.timeline_revision_id}
                  mediaUrls={syntheticMediaUrls}
                  audioByClip={syntheticAudioByClip}
                  pipClips={syntheticPipClips}
                  lockedClipIds={working.locked_elements}
                  selectedClipId={pipSelectedId}
                  selectedClipIds={selection?.kind === "clips" ? selection.ids : undefined}
                  onSelectClip={clipId => setSelection(clipId ? { kind: "clip", id: clipId as never } : null)}
                  onSelectClips={ids => setSelection(ids.length ? { kind: "clips", ids } : null)}
                  trackIndexByClipId={trackIndexByClipId}
                  onCommitPipTransform={async (clipId, transform) => { const clip = (working?.clips ?? []).find(item => item.clip_id === clipId); return commitPipTransform(clipId as never, { ...(clip?.transform ?? {}), ...transform }); }}
                  onDraftPipMask={(clipId, mask) => draftPipMask(clipId as never, mask)}
                  onCommitPipMask={(clipId, mask) => commitPipMask(clipId as never, mask)}
                  onGesturePause={pausePreviewPlayback}
                  onGestureResume={resumePreviewPlayback}
                  playing={playing && !gestureHoldRef.current}
                  playheadUs={playhead}
                  playheadStore={playheadStore}
                  playbackRate={uiRate}
                  onTimeUs={us => seekFromPlayback(us)}
                  onEnded={handlePreviewEnded}
                  onFallback={(reason, code) => { if (!seenAnyTicketRef.current) return; setPreviewMode("interactive"); setSyntheticNotice(syntheticFallbackNotice(reason, code)); }}
                  sourceResolver={previewSourceResolver}
                  resourceTier={resourceTier}
                  forceCopyTo={forceCopyTo}
                  snapshotRef={syntheticSnapshotRef}
                  proxyEpoch={proxyReadyEpoch}
                  onDecodeBudget={onDecodeBudget}
                  onSession={session => { if (!session) previewSessionRef.current?.endScrubStorm(); previewSessionRef.current = session; }}
                />
              )}
              {previewMode === "interactive" && previewAsset?.media_url && previewAsset.asset.kind === "video" && (
                <div className="preview-transform" style={mainTransformStyle}>
                  <video className="preview-background" src={previewAsset.media_url} muted aria-hidden="true" />
                  <video
                    ref={videoRef}
                    className="preview-foreground"
                    src={previewAsset.media_url}
                    muted={!selectedClip?.audio.enabled || previewReverse || !interactiveMediaRatePlayable || (clipAtPlayhead ? !isClipAudible(clipAtPlayhead) : false)}
                    aria-label="交互预览视频"
                    onTimeUpdate={event => { if (libraryPreviewId) dispatchPlayhead("external", Math.round(event.currentTarget.currentTime * 1_000_000), true); }}
                    onEnded={handleVideoEnded}
                  />
                </div>
              )}
              {previewMode === "interactive" && audioAsset?.media_url && <audio ref={audioRef} src={audioAsset.media_url} style={{ display: "none" }} />}
              {previewMode === "interactive" && previewAsset?.media_url && previewAsset.asset.kind === "image" && (
                <div className="preview-transform" style={mainTransformStyle}>
                  <img className="preview-background" src={previewAsset.media_url} alt="" aria-hidden="true" />
                  <img className="preview-foreground" src={previewAsset.media_url} alt={previewAsset.asset.display_name} />
                </div>
              )}
              {(previewMode === "interactive" || (previewMode === "synthetic" && (!working || working.clips.length === 0))) && !previewAsset?.media_url && overlayPips.length === 0 && (
                <div className="preview-empty">选择或追加素材以开始编辑</div>
              )}
              {previewMode === "interactive" && visibleCaption && <div className={`caption-overlay ${visibleCaption.preset_id}`}>{visibleCaption.text}</div>}
              {previewMode === "interactive" && overlayPips.length > 0 && (
                <PreviewPipOverlays
                  items={overlayPips}
                  tracks={tracksAtPlayhead}
                  selectedClipId={pipSelectedId}
                  locked={pipLocked}
                  onSelect={clipId => setSelection({ kind: "clip", id: clipId })}
                  onDraftTransform={draftPipTransform}
                  onCommitTransform={commitPipTransform}
                  onDraftMask={draftPipMask}
                  onCommitMask={commitPipMask}
                  onGesturePause={pausePreviewPlayback}
                  onGestureResume={resumePreviewPlayback}
                  playheadUs={playhead}
                  playing={playing}
                  playbackRate={uiRate}
                />
              )}
            </div>
            {!overlayClipSelected && (
              <div className="sel-box" ref={selBoxRef} onClick={event => event.stopPropagation()} aria-hidden="true">
                <i className="sel-border" />
                <span className="sel-dims" style={selDimsText ? undefined : { display: "none" }}>{selDimsText}</span>
                <span className="h h-nw" data-dir="nw" title="等比缩放（左上）" onPointerDown={beginSelDrag("nw")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} />
                <span className="h h-n" data-dir="n" title="单轴缩放（上）" onPointerDown={beginSelDrag("n")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} />
                <span className="h h-ne" data-dir="ne" title="等比缩放（右上）" onPointerDown={beginSelDrag("ne")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} />
                <span className="h h-e" data-dir="e" title="单轴缩放（右）" onPointerDown={beginSelDrag("e")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} />
                <span className="h h-se" data-dir="se" title="等比缩放（右下）" onPointerDown={beginSelDrag("se")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} />
                <span className="h h-s" data-dir="s" title="单轴缩放（下）" onPointerDown={beginSelDrag("s")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} />
                <span className="h h-sw" data-dir="sw" title="等比缩放（左下）" onPointerDown={beginSelDrag("sw")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} />
                <span className="h h-w" data-dir="w" title="单轴缩放（左）" onPointerDown={beginSelDrag("w")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} />
              </div>
            )}
          </div>
          {(previewIsStale && previewMode === "authoritative" && !exportPlayback) || exportPlayback || reframePlayback ? (
            <span className={`interactive-label ${previewIsStale && previewMode === "authoritative" && !exportPlayback ? "stale" : ""}`}>
              {previewMode === "interactive" ? "交互预览 · 非权威"
                : previewMode === "synthetic" ? "合成预览 · 实时（非权威）"
                  : reframePlayback ? "静态焦点重构图 · 权威预览"
                    : exportPlayback ? `导出 · ${exportPlayback.export_record.destination_display_name}`
                      : previewIsStale ? "权威预览 · 已过期"
                        : "权威预览 · 当前 Revision"}
            </span>
          ) : null}
          {syntheticNotice && (
            <span role="note" aria-label="合成预览回退提示" className="synthetic-note">
              {syntheticNotice}
              <button className="synthetic-note-retry" onClick={() => { setSyntheticNotice(null); setPreviewMode("synthetic"); }}>重试合成预览</button>
            </span>
          )}
          <div
            className={`progress${!libraryPreviewId && !isFullscreen ? " project-progress" : ""}${progressDragging ? " dragging" : ""}`}
            ref={progressRef}
            role="slider"
            tabIndex={0}
            aria-label="时间线播放头"
            aria-valuemin={0}
            aria-valuemax={Math.max(totalUs, 1)}
            aria-valuenow={Math.min(playhead, totalUs)}
            onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setProgressDragging(true); seekFromProgress(event.clientX); }}
            onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) scrubFromProgress(event.clientX); }}
            onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const rect = event.currentTarget.getBoundingClientRect(); event.currentTarget.releasePointerCapture(event.pointerId); commitScrub(Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * Math.max(totalUs, 1))); } setProgressDragging(false); }}
            onKeyDown={event => {
              if (event.key === "ArrowLeft") { event.preventDefault(); seekFromProgressRatio(Math.max(0, playhead / Math.max(totalUs, 1) - 1 / 300)); }
              else if (event.key === "ArrowRight") { event.preventDefault(); seekFromProgressRatio(Math.min(1, playhead / Math.max(totalUs, 1) + 1 / 300)); }
              else if (event.key === "Home") { event.preventDefault(); seekFromProgressRatio(0); }
              else if (event.key === "End") { event.preventDefault(); seekFromProgressRatio(1); }
            }}
          >
            <div className="pg-bubble" ref={pgBubbleRef} style={{ left: `${progressPct}%` }}>{formatSmpteTimecode(playhead, previewFps)}</div>
            <div className="pg-rail"><div className="pg-fill" ref={pgFillRef} style={{ width: `${progressPct}%` }}><i className="pg-dot" /></div></div>
          </div>
        </div>
        <div className="playback-bar">
          <div className="pb-left"><span className="tc"><b ref={tcTimeRef}>{formatSmpteTimecode(playhead, previewFps)}</b><i> / </i><span className="tot">{formatSmpteTimecode(totalUs, previewFps)}</span></span></div>
          <div className="pb-center"><button type="button" className="pb-play" aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停" : "播放"} onClick={togglePlayback}>{playing ? <Pause /> : <Play />}</button></div>
          <div className="pb-right" role="group" aria-label="播放器控制">
            <span className="rate-anchor">
              <button className="pb-icon rate-btn" aria-haspopup="dialog" aria-expanded={ratePopOpen} title="播放设置（循环 / 倍速）" aria-label="播放设置" onClick={event => { event.stopPropagation(); setRatePopOpen(value => !value); setVolPopOpen(false); setZoomPopOpen(false); }}>
                {loopPlayback && <Repeat size={14} aria-hidden="true" />}
                <span aria-hidden="true">{`${uiRate}×`}</span>
              </button>
              <div className={`rate-pop${ratePopOpen ? " open" : ""}`} ref={ratePopRef} role="dialog" aria-label="播放设置" onClick={event => event.stopPropagation()}>
                <div className="rp-head">播放设置</div>
                <button type="button" role="switch" aria-checked={loopPlayback} aria-label="循环播放" className="rp-row rp-loop" onClick={() => { if (!loopSeekPending.current) cancelLoopRestart(); setLoopPlayback(value => !value); }}>
                  <Repeat />
                  <span className="rp-loop-label">{playbackRange ? "循环播放区间" : "循环播放"}</span>
                  <span aria-hidden className={`rp-switch${loopPlayback ? " on" : ""}`}><i /></span>
                </button>
                <div className="rp-row rp-speed" aria-hidden="true"><span>倍速</span></div>
                {(() => {
                  const speeds = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
                  const perRow = 4;
                  const at = Math.max(0, speeds.indexOf(uiRate as typeof speeds[number]) === -1 ? speeds.findIndex(s => s > uiRate) : speeds.indexOf(uiRate as typeof speeds[number]));
                  return (
                    <div className="rate-grid" role="radiogroup" aria-label="播放倍速">
                      <span aria-hidden className="rate-mark" style={{ width: `calc((100% - 4px) / ${perRow})`, height: `calc((100% - 4px) / 2)`, transform: `translate(${(at % perRow) * 100}%, ${Math.floor(at / perRow) * 100}%)` }} />
                      {speeds.map((r, i) => (
                        <button key={r} type="button" role="radio" aria-checked={i === at} className={`rate-opt${i === at ? " active" : ""}`} onClick={() => setUiRate(r)}>{`${r}×`}</button>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </span>
            <span className="vol-anchor">
              <button type="button" className="pb-icon" aria-haspopup="dialog" aria-expanded={volPopOpen} title={`音量 ${volume}%`} aria-label={`音量 ${volume}%`} onClick={event => { event.stopPropagation(); setVolPopOpen(value => !value); setZoomPopOpen(false); }}>{volume === 0 ? <VolumeX /> : <Volume2 />}</button>
              <div className={`vol-pop${volPopOpen ? " open" : ""}`} ref={volPopRef} role="dialog" aria-label="音量" onClick={event => event.stopPropagation()}>
                <div
                  className="vol-rail"
                  ref={volRailRef}
                  role="slider"
                  tabIndex={0}
                  aria-label="预览音量"
                  aria-orientation="vertical"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={volume}
                  aria-valuetext={`${volume}%`}
                  onKeyDown={event => {
                    const delta = event.key === "ArrowUp" || event.key === "ArrowRight" ? 5 : event.key === "ArrowDown" || event.key === "ArrowLeft" ? -5 : 0;
                    if (delta || event.key === "Home" || event.key === "End") {
                      event.preventDefault();
                      event.stopPropagation();
                      setVolume(event.key === "Home" ? 0 : event.key === "End" ? 100 : Math.max(0, Math.min(100, volume + delta)));
                    }
                  }}
                  onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); seekVolumeFrom(event.clientY); }}
                  onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) seekVolumeFrom(event.clientY); }}
                  onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
                >
                  <div className="vol-fill" style={{ height: `${volume}%` }} />
                  <div className="vol-thumb" style={{ bottom: `${volume}%` }} />
                </div>
              </div>
            </span>
            <button type="button" className="pb-icon zoom-btn" aria-haspopup="dialog" aria-expanded={zoomPopOpen} aria-label={`预览缩放，${previewZoom === "fit" ? "适应画布" : `${Math.round(previewZoom * 100)}%`}`} title="预览缩放" onClick={event => { event.stopPropagation(); setZoomPopOpen(value => !value); setVolPopOpen(false); }}>
              <ZoomIn />
              <span className="zoom-label">{previewZoom === "fit" ? "适应" : `${Math.round(previewZoom * 100)}%`}</span>
            </button>
            <div className={`zoom-pop${zoomPopOpen ? " open" : ""}`} ref={zoomPopRef} role="dialog" aria-label="预览缩放" onClick={event => event.stopPropagation()}>
              <div className="zp-head">
                <button type="button" className={`zp-fit${previewZoom === "fit" ? " on" : ""}`} aria-pressed={previewZoom === "fit"} onClick={resetZoom}>{previewZoom === "fit" ? "✓ 适应画布" : "适应画布"}</button>
                <span className="zp-val">{previewZoom === "fit" ? "原始" : `${Math.round(previewZoom * 100)}%`}</span>
              </div>
              <input type="range" min={0} max={1000} value={previewZoom === "fit" ? zoomT(1) : zoomT(previewZoom)} onChange={event => applySliderZoom(Number(event.target.value))} aria-label="预览缩放级别" aria-valuetext={previewZoom === "fit" ? "适应画布" : `${Math.round(previewZoom * 100)}%`} />
              <div className="zp-scale"><span>25%</span><span>100%</span><span>500%</span></div>
            </div>
            <button type="button" className="pb-icon" aria-label={isFullscreen ? "退出全屏" : "全屏"} title={isFullscreen ? "退出全屏" : "全屏"} onClick={() => void toggleFullscreen()}>{isFullscreen ? <Minimize /> : <Maximize />}</button>
          </div>
        </div>
      </div>
    </section>
  );
}
