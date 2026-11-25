import { memo, useLayoutEffect, useRef, type RefObject } from "react";
import { Film, X } from "lucide-react";
import type {
  TimelineCaption,
  TimelineClip,
  TimelineClipId,
  TimelinePatchOperation,
  TimelineTransition,
} from "@aivideo/contracts";
import { CLIP_HEADER_H, SCROLLBAR_HEIGHT_PX, TRACK_VIEW_PAD, timeToX, trackRowOf, xToTime, type TrackRowLayout } from "../geometry.js";
import type {
  ActiveTransitionRenderRect,
  ClipRenderRect,
  TimelineAssetDropIntent,
  TimelineInteraction,
  TimelineRuntimePrefs,
  TimelineSelection,
  TimelineViewState,
  TransitionRenderRect,
} from "../types.js";
import type { FilmstripOverlayCell, FilmstripOverlayGroup } from "./render/filmstrip-index.js";
import { CLIP_RADIUS, CLIP_ROW_INSET, KEYFRAME_LANE_HEIGHT, KEYFRAME_ORDER, formatTimelineHoverTime } from "./render/theme.js";
import type { CanvasContextMenuTarget } from "./contextMenuBuilder.js";

export const TRANSITION_KINDS = ["fade", "fadeblack", "dissolve", "wipeleft", "wiperight", "slideleft", "slideup", "zoomin"] as const;

export interface ClipLabelRect {
  id: string;
  title: string;
  headerColor: string;
  hidden: boolean;
  duration: string;
  speed?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pinShift: number;
  showDuration: boolean;
}

const TimelineFilmstripCanvas = memo(function TimelineFilmstripCanvas({ cell }: { cell: FilmstripOverlayCell }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width !== cell.sourceWidth || canvas.height !== cell.sourceHeight) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      cell.source,
      cell.sourceX,
      cell.sourceY,
      cell.sourceWidth,
      cell.sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }, [cell]);
  return (
    <canvas
      ref={canvasRef}
      data-timeline-filmstrip-cell={cell.key}
      width={cell.sourceWidth}
      height={cell.sourceHeight}
      aria-hidden="true"
      style={{
        position: "absolute",
        left: cell.x,
        top: 0,
        width: cell.width,
        height: cell.height,
        objectFit: "cover",
        objectPosition: "center",
        opacity: 0.9,
        pointerEvents: "none",
      }}
    />
  );
});

export function TimelineFilmstripOverlay({
  groups,
  canvasTopY,
  canvasWidth,
  canvasViewportHeight,
}: {
  groups: readonly FilmstripOverlayGroup[];
  canvasTopY: number;
  canvasWidth: number;
  canvasViewportHeight: number;
}) {
  if (!groups.length) return null;
  return (
    <div
      data-timeline-filmstrip-overlay="1"
      aria-hidden="true"
      style={{
        position: "absolute",
        left: 0,
        top: canvasTopY,
        width: canvasWidth,
        height: canvasViewportHeight,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      {groups.map((group) => (
        <div
          key={group.clipId}
          data-timeline-filmstrip-clip={group.clipId}
          style={{
            position: "absolute",
            left: group.x,
            top: group.y - canvasTopY,
            width: group.width,
            height: group.height,
            overflow: "hidden",
            borderRadius: `0 0 ${CLIP_RADIUS}px ${CLIP_RADIUS}px`,
            filter: group.filter,
          }}
        >
          {group.cells.map((cell) => <TimelineFilmstripCanvas key={cell.key} cell={cell} />)}
        </div>
      ))}
    </div>
  );
}

export function TimelineClipLabelsOverlay({ labels }: { labels: readonly ClipLabelRect[] }) {
  return (
    <div className="timeline-clip-label-layer" aria-hidden="true">
      {labels.map((label) => (
        <div
          key={label.id}
          className="timeline-clip-label"
          data-timeline-clip-label={label.id}
          data-speed={label.speed}
          style={{
            left: label.x,
            top: label.y,
            width: label.width,
            height: label.height,
            filter: label.hidden ? "grayscale(1)" : undefined,
          }}
        >
          <div className="timeline-clip-label-info" style={{ height: CLIP_HEADER_H, backgroundColor: label.headerColor }}>
            <span className="timeline-clip-label-pin" data-label-pin="" style={{ translate: label.pinShift > 0 ? `${label.pinShift}px 0` : undefined }}>
              <span className="timeline-clip-label-name" data-label-text="">{label.title}</span>
              {label.speed && <span className="timeline-clip-label-speed" data-label-text="">{label.speed}</span>}
              {label.showDuration && <span className="timeline-clip-label-duration" data-label-text="">{label.duration}</span>}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function TimelineInsertIndicator({
  interaction,
  trackRows,
  view,
}: {
  interaction: TimelineInteraction | null;
  trackRows: readonly TrackRowLayout[];
  view: TimelineViewState;
}) {
  if (
    interaction?.kind !== "move"
    || interaction.copyOnStart
    || interaction.moveMode !== "insert"
    || !interaction.dragPlan?.lead
    || interaction.dragPlan.reason
  ) {
    return null;
  }
  const lead = interaction.dragPlan.lead;
  const row = trackRowOf(trackRows as TrackRowLayout[], lead.trackId);
  if (!row) return null;
  const top = row.y + CLIP_ROW_INSET - 3;
  const clipHeight = Math.max(4, row.height - CLIP_ROW_INSET * 2);
  return (
    <div
      data-timeline-insert-point={Math.round(lead.startUs)}
      aria-hidden="true"
      style={{
        position: "absolute",
        zIndex: 3,
        pointerEvents: "none",
        left: Math.round(timeToX(lead.startUs, view)) - 1,
        top,
        width: 3,
        height: clipHeight + 6,
        borderRadius: 999,
        background: "var(--accent)",
        boxShadow: "0 0 6px color-mix(in srgb, var(--accent) 70%, transparent)",
      }}
    />
  );
}

export function TimelineAccessibleClipList({
  clips,
  captions,
  selection,
  setSelection,
  toggleClipSelection,
  linkedSelection,
}: {
  clips: readonly TimelineClip[];
  captions: readonly TimelineCaption[];
  selection: TimelineSelection;
  setSelection: (selection: TimelineSelection) => void;
  toggleClipSelection: (clip: TimelineClip, alone?: boolean) => TimelineSelection;
  linkedSelection: (clip: TimelineClip) => Extract<NonNullable<TimelineSelection>, { kind: "clip" | "clips" }>;
}) {
  return (
    <div
      className="timeline-a11y-clips"
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
        whiteSpace: "nowrap",
        border: 0,
      }}
    >
      {clips.map((clip, index) => {
        const isSelected = selection?.kind === "clip"
          ? selection.id === clip.clip_id
          : selection?.kind === "clips"
            ? selection.ids.includes(clip.clip_id)
            : false;
        return (
          <button
            key={clip.clip_id}
            data-clip-id={clip.clip_id}
            aria-label={`Clip ${index + 1} ${clip.asset_kind} ${formatTimelineHoverTime(clip.timeline_end_us - clip.timeline_start_us)}`}
            aria-pressed={isSelected}
            onClick={(event) =>
              setSelection(
                event.shiftKey || event.ctrlKey || event.metaKey
                  ? toggleClipSelection(clip, event.altKey)
                  : event.altKey
                    ? { kind: "clip", id: clip.clip_id }
                    : linkedSelection(clip),
              )
            }
          />
        );
      })}
      {captions.map((caption, index) => {
        const isSelected = selection?.kind === "caption" && selection.id === caption.caption_id;
        return (
          <button
            key={caption.caption_id}
            aria-label={caption.text || `字幕 ${index + 1}`}
            aria-pressed={isSelected}
            onClick={() => setSelection({ kind: "caption", id: caption.caption_id })}
          />
        );
      })}
    </div>
  );
}

export function TimelineTransitionAndKeyframeOverlays({
  transitionRects,
  activeTransitionRects,
  clips,
  clipRects,
  selection,
  view,
  canvasRef,
  canvasCoords,
  setSelection,
  setContextMenu,
  beginTransitionResize,
  moveTransitionResize,
  endTransitionResize,
  beginActiveTransitionResize,
  moveActiveTransitionResize,
  endActiveTransitionResize,
  onPatch,
}: {
  transitionRects: readonly TransitionRenderRect[];
  activeTransitionRects: readonly ActiveTransitionRenderRect[];
  clips: readonly TimelineClip[];
  clipRects: readonly ClipRenderRect[];
  selection: TimelineSelection;
  view: TimelineViewState;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  canvasCoords: (event: { clientX: number; clientY: number }) => { x: number; y: number } | null;
  setSelection: (selection: TimelineSelection) => void;
  setContextMenu: (menu: { x: number; y: number; target: CanvasContextMenuTarget; timeUs: number }) => void;
  beginTransitionResize: (transition: TimelineTransition, side: "start" | "end", event: React.PointerEvent) => void;
  moveTransitionResize: (event: React.PointerEvent) => void;
  endTransitionResize: () => void;
  beginActiveTransitionResize: (rect: ActiveTransitionRenderRect, edge: "start" | "end", event: React.PointerEvent) => void;
  moveActiveTransitionResize: (event: React.PointerEvent) => void;
  endActiveTransitionResize: () => void;
  onPatch: (operations: TimelinePatchOperation[], summary: string) => Promise<void> | void;
}) {
  return (
    <>
      {transitionRects.map((rect) => {
        const isSelected = selection?.kind === "transition" && selection.id === rect.transition.transition_id;
        const chipTop = Math.max(rect.y + 16, rect.y + Math.round(rect.height / 2) - 8);
        const chipW = Math.max(10, rect.width);
        return (
          <div
            key={rect.transition.transition_id}
            role="button"
            tabIndex={-1}
            className={`timeline-transition-marker${isSelected ? " selected" : ""}`}
            data-transition={rect.transition.kind}
            style={{
              position: "absolute",
              left: rect.x,
              top: chipTop,
              width: chipW,
              height: 16,
              pointerEvents: "auto",
            }}
            title={`转场 ${rect.transition.kind} · ${(rect.transition.duration_us / 1_000_000).toFixed(2)}s`}
            aria-label={`转场 ${rect.transition.kind} ${(rect.transition.duration_us / 1_000_000).toFixed(2)}秒`}
            aria-pressed={isSelected}
            onClick={(event) => {
              event.stopPropagation();
              setSelection({ kind: "transition", id: rect.transition.transition_id });
            }}
          >
            <svg aria-hidden className="transition-x" viewBox="0 0 100 16" preserveAspectRatio="none">
              <path d="M0 15 L100 1" vectorEffect="non-scaling-stroke" fill="none" />
              <path d="M0 1 L100 15" vectorEffect="non-scaling-stroke" fill="none" />
            </svg>
            {chipW > 70 ? <span className="transition-name">{rect.transition.kind}</span> : null}
            {(["start", "end"] as const).map((side) => (
              <span
                key={side}
                role="presentation"
                className={`transition-edge ${side}`}
                aria-label={`调整转场时长 ${side === "start" ? "起点" : "终点"}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  beginTransitionResize(rect.transition, side, event);
                }}
                onPointerMove={moveTransitionResize}
                onPointerUp={endTransitionResize}
                onPointerCancel={endTransitionResize}
              />
            ))}
          </div>
        );
      })}
      {activeTransitionRects.map((rect) => {
        const transition = rect.transition;
        const isSelected = selection?.kind === "active-transition" && selection.id === transition.transition_id;
        const chipTop = Math.max(rect.y + 16, rect.y + Math.round(rect.height / 2) - 8);
        const chipW = Math.max(10, rect.width);
        const title = `${transition.kind} · ${((transition.end_us - transition.start_us) / 1_000_000).toFixed(2)}s`;
        return (
          <div
            key={`active:${transition.transition_id}`}
            role="button"
            tabIndex={-1}
            className={`timeline-transition-marker timeline-active-transition-marker${isSelected ? " selected" : ""}${rect.editable ? " editable" : " read-only"}`}
            data-transition={transition.kind}
            data-active-transition-id={transition.transition_id}
            style={{
              position: "absolute",
              left: rect.x,
              top: chipTop,
              width: chipW,
              height: 16,
              pointerEvents: "auto",
            }}
            title={`${title}${transition.rest_clip_id ? ` · rest ${transition.rest_clip_id}` : ""}${rect.editable ? " · 拖动边缘调整" : " · 只读"}`}
            aria-label={`活动转场 ${title}`}
            aria-pressed={isSelected}
            onClick={(event) => {
              event.stopPropagation();
              setSelection({ kind: "active-transition", id: transition.transition_id });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const coords = canvasCoords(event);
              if (!coords) return;
              setSelection({ kind: "active-transition", id: transition.transition_id });
              setContextMenu({
                x: coords.x,
                y: coords.y,
                target: { kind: "active-transition", transitionId: transition.transition_id },
                timeUs: xToTime(coords.x, view),
              });
            }}
          >
            <svg aria-hidden className="transition-x" viewBox="0 0 100 16" preserveAspectRatio="none">
              <path d="M0 15 L100 1" vectorEffect="non-scaling-stroke" fill="none" />
              <path d="M0 1 L100 15" vectorEffect="non-scaling-stroke" fill="none" />
            </svg>
            {chipW > 70 ? <span className="transition-name">{transition.kind}</span> : null}
            {rect.editable
              ? (["start", "end"] as const).map((edge) => (
                  <span
                    key={edge}
                    role="presentation"
                    className={`transition-edge ${edge}`}
                    aria-label={`调整活动转场${edge === "start" ? "起点" : "终点"}`}
                    onPointerDown={(event) => beginActiveTransitionResize(rect, edge, event)}
                    onPointerMove={moveActiveTransitionResize}
                    onPointerUp={endActiveTransitionResize}
                    onPointerCancel={endActiveTransitionResize}
                  />
                ))
              : null}
          </div>
        );
      })}
      {clips.map((clip) => {
        if (!clip.keyframes || selection?.kind !== "clip" || selection.id !== clip.clip_id) return null;
        const rect = clipRects.find((item) => item.clip.clip_id === clip.clip_id);
        if (!rect) return null;
        const colors: Record<string, string> = { position: "#6fd3d3", scale: "#f0d264", rotate: "#f0a264", opacity: "#ffffff" };
        const props = KEYFRAME_ORDER.filter((property) => clip.keyframes?.[property]);
        return props.flatMap((property) => {
          const track = clip.keyframes?.[property as keyof NonNullable<TimelineClip["keyframes"]>];
          if (!track) return [];
          const laneIndex = props.indexOf(property);
          const laneCenterY = rect.y + rect.height + 2 + 4 + laneIndex * KEYFRAME_LANE_HEIGHT + KEYFRAME_LANE_HEIGHT / 2;
          return track.frames.map((frame: { t_us: number; x?: number; y?: number; v?: number }) => {
            const x = timeToX(clip.timeline_start_us + frame.t_us, view);
            if (x < rect.x || x > rect.x + rect.width) return null;
            const commit = (newTUs: number) => {
              const frames = track.frames
                .map((f: { t_us: number; x?: number; y?: number; v?: number }) =>
                  f.t_us === frame.t_us
                    ? { ...f, t_us: Math.max(0, Math.min(clip.timeline_end_us - clip.timeline_start_us, Math.round(newTUs))) }
                    : { ...f, t_us: Math.round(f.t_us) },
                )
                .sort((a: { t_us: number }, b: { t_us: number }) => a.t_us - b.t_us);
              void onPatch(
                [{ op: "set_clip_keyframes", clip_id: clip.clip_id, property: property as never, frames }],
                `调整${property}关键帧时间`,
              );
            };
            return (
              <button
                key={`${clip.clip_id}-${property}-${frame.t_us}`}
                className="timeline-keyframe-dot"
                data-property={property}
                style={{ position: "absolute", left: x - 4, top: laneCenterY - 4, width: 8, height: 8, background: colors[property] ?? "#fff", pointerEvents: "auto" }}
                aria-label={`${property} 关键帧 ${formatTimelineHoverTime(frame.t_us)}`}
                title={`${property} @ ${formatTimelineHoverTime(frame.t_us)}（拖动改时间）`}
                draggable
                onDragEnd={(event) => {
                  const canvas = canvasRef.current;
                  if (!canvas) return;
                  const bounds = canvas.getBoundingClientRect();
                  const scale = canvas.width / bounds.width || 1;
                  const newTUs = Math.max(0, Math.min(clip.timeline_end_us - clip.timeline_start_us, Math.round(xToTime((event.clientX - bounds.left) * scale, view))));
                  commit(newTUs);
                }}
                onClick={(event) => event.stopPropagation()}
              />
            );
          });
        });
      })}
    </>
  );
}

export function TimelineDropAndReplaceOverlays({
  dropIndex,
  dropIntent,
  dropItemCount,
  clips,
  trackRows,
  view,
  prefs,
  clipNames,
  replaceAssetRequest,
  cancelReplaceAsset,
  confirmReplaceAsset,
  replaceClipRequest,
  cancelReplaceClip,
  confirmReplaceClip,
}: {
  dropIndex: number | null;
  dropIntent: TimelineAssetDropIntent | null;
  dropItemCount: number;
  clips: readonly TimelineClip[];
  trackRows: readonly TrackRowLayout[];
  view: TimelineViewState;
  prefs: TimelineRuntimePrefs;
  clipNames: ReadonlyMap<string, string>;
  replaceAssetRequest: { targetClipId: TimelineClipId } | null;
  cancelReplaceAsset: () => void;
  confirmReplaceAsset: () => void;
  replaceClipRequest: { targetClipId: TimelineClipId } | null;
  cancelReplaceClip: () => void;
  confirmReplaceClip: () => void;
}) {
  return (
    <>
      {dropIndex !== null && (
        <div
          className="timeline-drop-overlay"
          style={{
            position: "absolute",
            left: view.headerWidth,
            top: view.rulerHeight,
            right: 0,
            bottom: 0,
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {dropIntent?.accepts && (() => {
            const row = dropIntent.trackId !== "new" && dropIntent.trackId ? trackRowOf(trackRows as TrackRowLayout[], dropIntent.trackId) : null;
            const anchor = dropIntent.newTrackAnchorId ? trackRowOf(trackRows as TrackRowLayout[], dropIntent.newTrackAnchorId) : null;
            const startX = timeToX(dropIntent.atUs, view) - view.headerWidth;
            const width = Math.max(8, timeToX(dropIntent.atUs + dropIntent.previewDurationUs, view) - timeToX(dropIntent.atUs, view));
            const previewColor = dropIntent.mode === "overwrite" ? "var(--warn, #f0b45a)" : "var(--accent, #16c7c2)";
            const rowTop = row ? row.y - view.rulerHeight : 0;
            const lineY = anchor
              ? dropIntent.newTrackSide === "after" ? anchor.y + anchor.height - view.rulerHeight : anchor.y - view.rulerHeight
              : 0;
            const shiftIds = new Set(clips.filter((clip) => row && clip.track_id === row.track.id && clip.timeline_start_us >= dropIntent.atUs).map((clip) => clip.clip_id));
            if (prefs.linkageEnabled) {
              const groups = new Set(clips.filter((clip) => shiftIds.has(clip.clip_id) && clip.link_group_id).map((clip) => clip.link_group_id));
              for (const clip of clips) if (clip.link_group_id && groups.has(clip.link_group_id)) shiftIds.add(clip.clip_id);
            }
            const ripples = dropIntent.mode === "insert" ? clips.filter((clip) => shiftIds.has(clip.clip_id)) : [];
            return (
              <>
                {row && dropIntent.trackId !== "new" && (
                  <div
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      left: startX,
                      top: rowTop,
                      width,
                      height: row.height,
                      boxSizing: "border-box",
                      border: `1px dashed ${previewColor}`,
                      background: dropIntent.mode === "overwrite" ? "rgba(240, 180, 90, 0.20)" : "rgba(22, 199, 194, 0.16)",
                      borderRadius: 3,
                    }}
                  />
                )}
                {dropIntent.trackId === "new" && (
                  <div
                    aria-hidden="true"
                    style={{ position: "absolute", left: 0, right: 0, top: lineY, height: 2, background: "var(--accent, #16c7c2)", boxShadow: "0 0 0 1px rgba(22, 199, 194, 0.18)" }}
                  />
                )}
                {ripples.map((clip) => {
                  const clipRow = trackRowOf(trackRows as TrackRowLayout[], clip.track_id);
                  if (!clipRow) return null;
                  const shiftedStart = clip.timeline_start_us + dropIntent.previewDurationUs;
                  const left = timeToX(shiftedStart, view) - view.headerWidth;
                  const right = timeToX(clip.timeline_end_us + dropIntent.previewDurationUs, view) - view.headerWidth;
                  return (
                    <div
                      key={`asset-drop-ripple-${clip.clip_id}`}
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        left,
                        top: clipRow.y - view.rulerHeight,
                        width: Math.max(2, right - left),
                        height: clipRow.height,
                        border: "1px dashed var(--accent, #16c7c2)",
                        boxSizing: "border-box",
                        background: "rgba(22, 199, 194, 0.08)",
                        borderRadius: 3,
                      }}
                    />
                  );
                })}
              </>
            );
          })()}
          {dropIntent?.accepts === false && <span className="drop-hint" role="status" aria-live="polite">无法放入已锁定或不兼容的轨道</span>}
          {dropIntent?.accepts && dropIntent.zone === "center" && dropItemCount === 1 && <span className="drop-hint" role="status" aria-live="polite">释放以确认替换此片段</span>}
          {dropIntent?.accepts && dropIntent.mode === "place" && <span className="drop-hint" role="status" aria-live="polite">{dropIntent.trackId === "new" ? "释放以新建轨道并放置素材" : "释放以放置素材"} · {formatTimelineHoverTime(dropIntent.atUs)}</span>}
          {dropIntent?.accepts && dropIntent.mode === "insert" && <span className="drop-hint" role="status" aria-live="polite">释放以插入到时间线（后续片段顺延） · {formatTimelineHoverTime(dropIntent.atUs)}</span>}
          {dropIntent?.accepts && dropIntent.mode === "overwrite" && dropIntent.zone !== "center" && <span className="drop-hint" role="status" aria-live="polite">释放以覆盖 · {formatTimelineHoverTime(dropIntent.atUs)}</span>}
        </div>
      )}
      {replaceAssetRequest && (
        <div className="modal-backdrop timeline-drop-replace-backdrop" onClick={cancelReplaceAsset}>
          <section
            className="modal timeline-drop-replace-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="timeline-drop-replace-title"
            aria-describedby="timeline-drop-replace-description"
            tabIndex={-1}
            ref={(element) => {
              if (element && !element.contains(window.document.activeElement)) element.focus();
            }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancelReplaceAsset();
              }
            }}
          >
            <div className="modal-heading">
              <div><h2 id="timeline-drop-replace-title">替换时间线素材？</h2></div>
              <button type="button" className="icon-btn" aria-label="取消替换" title="取消 · Esc" onClick={cancelReplaceAsset}><X size={15} /></button>
            </div>
            <div className="modal-body">
              <p id="timeline-drop-replace-description">
                将替换“{clipNames.get(replaceAssetRequest.targetClipId) ?? "此片段"}”引用的素材。确认后只提交一次时间线修改。
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn secondary" onClick={cancelReplaceAsset}>取消</button>
              <button type="button" className="btn primary" onClick={confirmReplaceAsset}>确认替换</button>
            </div>
          </section>
        </div>
      )}
      {replaceClipRequest && (
        <div className="modal-backdrop timeline-drop-replace-backdrop" onClick={cancelReplaceClip}>
          <section
            className="modal timeline-drop-replace-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="timeline-clip-replace-title"
            aria-describedby="timeline-clip-replace-description"
            tabIndex={-1}
            ref={(element) => {
              if (element && !element.contains(window.document.activeElement)) element.focus();
            }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancelReplaceClip();
              }
            }}
          >
            <div className="modal-heading">
              <div><h2 id="timeline-clip-replace-title">替换时间线片段？</h2></div>
              <button type="button" className="icon-btn" aria-label="取消替换" title="取消 · Esc" onClick={cancelReplaceClip}><X size={15} /></button>
            </div>
            <div className="modal-body">
              <p id="timeline-clip-replace-description">
                将移除“{clipNames.get(replaceClipRequest.targetClipId) ?? "目标片段"}”，并把拖动的片段放到该位置。确认后一次提交时间线修改。
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn secondary" onClick={cancelReplaceClip}>取消</button>
              <button type="button" className="btn primary" onClick={confirmReplaceClip}>确认替换</button>
            </div>
          </section>
        </div>
      )}
      {clips.length === 0 && (
        <div
          className="timeline-empty-drop"
          style={{
            position: "absolute",
            left: view.headerWidth,
            top: view.rulerHeight,
            right: 0,
            bottom: SCROLLBAR_HEIGHT_PX,
            margin: TRACK_VIEW_PAD,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <Film size={15} aria-hidden="true" style={{ marginRight: 8, flex: "0 0 auto", color: "var(--tl-label)" }} />
          将视频或图片拖到这里开始剪辑
        </div>
      )}
    </>
  );
}

export function TimelineAddTransitionDialog({
  anchorClipId,
  onClose,
  onPatch,
}: {
  anchorClipId: string | null;
  onClose: () => void;
  onPatch: (operations: TimelinePatchOperation[], summary: string) => Promise<void> | void;
}) {
  if (!anchorClipId) return null;
  return (
    <div className="modal-backdrop add-transition-popover" onClick={onClose}>
      <section
        className="modal add-transition-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-transition-title"
        tabIndex={-1}
        ref={(element) => {
          if (!element) return;
          const active = window.document.activeElement;
          if (active !== element && !element.contains(active)) element.focus();
        }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="modal-heading">
          <div><h2 id="add-transition-title">在此处添加转场</h2></div>
          <button type="button" className="icon-btn" aria-label="关闭添加转场" title="关闭 · Esc" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">
          <div className="add-transition-kinds">
            {TRANSITION_KINDS.map((kind) => (
              <button
                key={kind}
                className="add-transition-kind"
                onClick={() => {
                  void onPatch(
                    [{ op: "add_transition", after_clip_id: anchorClipId as never, kind, duration_us: 500_000 }],
                    `添加转场 ${kind}`,
                  );
                  onClose();
                }}
              >
                {kind}
              </button>
            ))}
          </div>
          <p className="modal-caption">默认 0.5s，添加后可在属性面板调整时长；仅权威预览渲染转场效果。</p>
        </div>
      </section>
    </div>
  );
}
