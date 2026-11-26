import { useRef, type MutableRefObject } from "react";
import { Eye, EyeOff, Lock, LockOpen, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Volume2, VolumeX } from "lucide-react";
import type { TimelineClip, TimelinePatchOperation, TimelineTrack } from "@aivideo/contracts";
import type { TrackRowLayout } from "../geometry.js";
import type { TimelineSelection } from "../types.js";

/** OpenFilm-style track head resize target. Pointer dragging edits one row;
 * keyboard arrows resize it too, and Home/double-click restore its role height. */
function TrackResizeHandle({
  trackId,
  height,
  onResize,
}: {
  trackId: string;
  height: number;
  onResize: (height: number | null, done: boolean) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number; lastHeight: number } | null>(null);
  const minimum = 28;
  const clamp = (value: number) => Math.max(minimum, Math.min(160, Math.round(value)));
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height, lastHeight: height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clamp(drag.startHeight + event.clientY - drag.startY);
    if (next === drag.lastHeight) return;
    drag.lastHeight = next;
    onResize(next, false);
  };
  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onResize(drag.lastHeight, true);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      event.stopPropagation();
      onResize(null, true);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 4;
    onResize(clamp(height + (event.key === "ArrowDown" ? step : -step)), true);
  };
  return (
    <div
      className="timeline-track-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label={`调整轨道 ${trackId} 高度`}
      aria-valuemin={minimum}
      aria-valuemax={160}
      aria-valuenow={height}
      aria-valuetext={`${height} 像素`}
      aria-keyshortcuts="ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown Home"
      tabIndex={0}
      title={`拖动调整轨道 ${trackId} 高度；方向键微调；Home 恢复默认`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onResize(null, true);
      }}
      onKeyDown={onKeyDown}
    />
  );
}

export interface TrackHeadColumnProps {
  tracks: readonly TimelineTrack[];
  trackRows: readonly TrackRowLayout[];
  clips: readonly TimelineClip[];
  selection: TimelineSelection;
  scrollX: number;
  trackHeadWidth: number;
  contentHeight: number;
  rulerHeight: number;
  headsCollapsed: boolean;
  onToggleHeadsCollapsed: () => void;
  trackDragTarget: string | null;
  setTrackDragTarget: (target: string | null) => void;
  trackDragRef: MutableRefObject<{ id: string; startY: number; moved: boolean } | null>;
  trackDropTarget: (clientY: number) => { dynamic: readonly TrackRowLayout[]; id: string | null; targetIndex: number };
  resizeTrack: (trackId: string, height: number | null, done: boolean) => void;
  patchTrackFlags: (trackId: string, flags: { locked?: boolean; hidden?: boolean; muted?: boolean; solo?: boolean }) => void;
  onPatch: (operations: TimelinePatchOperation[], summary: string) => Promise<void> | void;
  onOpenTrackMenu: (menu: { trackId: string; x: number; y: number; trigger: HTMLElement }) => void;
}

export function TrackHeadColumn({
  tracks,
  trackRows,
  clips,
  selection,
  scrollX,
  trackHeadWidth,
  contentHeight,
  rulerHeight,
  headsCollapsed,
  onToggleHeadsCollapsed,
  trackDragTarget,
  setTrackDragTarget,
  trackDragRef,
  trackDropTarget,
  resizeTrack,
  patchTrackFlags,
  onPatch,
  onOpenTrackMenu,
}: TrackHeadColumnProps) {
  return (
    <div
      className="timeline-left"
      data-scrolled={scrollX > 0 ? "1" : undefined}
      style={{ width: trackHeadWidth, height: contentHeight, position: "relative" }}
    >
      <div className="timeline-left-corner" style={{ height: rulerHeight }} />
      {tracks.length > 0 && (
        <button
          type="button"
          className="timeline-track-head-divider"
          aria-label={headsCollapsed ? "展开轨道控制栏" : "收起轨道控制栏"}
          aria-expanded={!headsCollapsed}
          title={headsCollapsed ? "展开轨道控制栏" : "收起轨道控制栏"}
          style={{ left: trackHeadWidth - 6, top: Math.max(rulerHeight + 4, contentHeight / 2 - 10) }}
          onClick={onToggleHeadsCollapsed}
        >
          {headsCollapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />}
        </button>
      )}
      {trackRows.map((row) => {
        const rawKind: string = row.track.kind;
        const kind = rawKind === "visual" ? "video" : rawKind === "caption" ? "text" : rawKind;
        const hasClips = clips.some((clip) => clip.track_id === row.track.id);
        return (
          <div
            key={row.track.id}
            className="timeline-track-head"
            data-track-kind={kind}
            data-track-id={row.track.id}
            data-head-collapsed={headsCollapsed ? "true" : undefined}
            data-track-drop-target={trackDragTarget === row.track.id ? "true" : undefined}
            tabIndex={0}
            role="group"
            aria-label={`轨道 ${row.track.id}`}
            aria-keyshortcuts={row.track.id !== "V1" && row.track.id !== "A1" ? "Alt+ArrowUp Alt+ArrowDown Shift+F10" : undefined}
            title={row.track.id !== "V1" && row.track.id !== "A1" ? "拖动轨道编号或使用 Alt+↑/↓ 排序；右键打开菜单" : undefined}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (["V1", "A1", "C1"].includes(row.track.id)) return;
              onOpenTrackMenu({ trackId: row.track.id, x: event.clientX, y: event.clientY, trigger: event.currentTarget });
            }}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                const dynamic = trackRows.filter((item) => item.track.id !== "V1" && item.track.id !== "A1");
                const from = dynamic.findIndex((item) => item.track.id === row.track.id);
                const to = from + (event.key === "ArrowUp" ? -1 : 1);
                if (from >= 0 && to >= 0 && to < dynamic.length) {
                  void onPatch([{ op: "move_track", track_id: row.track.id, to_index: to }], "调整轨道顺序");
                }
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault();
              event.stopPropagation();
              if (["V1", "A1", "C1"].includes(row.track.id)) return;
              const rect = event.currentTarget.getBoundingClientRect();
              onOpenTrackMenu({ trackId: row.track.id, x: rect.left, y: rect.bottom, trigger: event.currentTarget });
            }}
            data-flag-cols={kind === "text" ? "2" : "4"}
            data-lane-picked={
              trackRows.some(() => selection?.kind === "clip" && clips.some((c) => c.clip_id === selection.id && c.track_id === row.track.id))
                ? "1"
                : undefined
            }
            style={{ top: row.y, height: row.height }}
          >
            <TrackResizeHandle
              trackId={row.track.id}
              height={row.height}
              onResize={(height, done) => resizeTrack(row.track.id, height, done)}
            />
            <span
              className="timeline-track-badge"
              title={`${row.track.id} ${kind === "video" ? "视频" : kind === "text" ? "文本" : "音频"}轨道`}
              onPointerDown={(event) => {
                if (event.button !== 0 || row.track.id === "V1" || row.track.id === "A1") return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setPointerCapture?.(event.pointerId);
                trackDragRef.current = { id: row.track.id, startY: event.clientY, moved: false };
              }}
              onPointerMove={(event) => {
                const drag = trackDragRef.current;
                if (drag && Math.abs(event.clientY - drag.startY) >= 5) {
                  drag.moved = true;
                  setTrackDragTarget(trackDropTarget(event.clientY).id);
                }
              }}
              onPointerCancel={() => {
                trackDragRef.current = null;
                setTrackDragTarget(null);
              }}
              onPointerUp={(event) => {
                const drag = trackDragRef.current;
                trackDragRef.current = null;
                setTrackDragTarget(null);
                if (!drag?.moved) return;
                const { dynamic, targetIndex } = trackDropTarget(event.clientY);
                if (targetIndex !== dynamic.findIndex((item) => item.track.id === drag.id)) {
                  void onPatch([{ op: "move_track", track_id: drag.id, to_index: targetIndex }], "调整轨道顺序");
                }
              }}
            >
              <small>{row.track.id}</small>
            </span>
            {headsCollapsed && (
              <button
                type="button"
                className="timeline-track-collapsed-menu"
                aria-label={`打开轨道 ${row.track.id} 控制菜单`}
                aria-haspopup="menu"
                onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  onOpenTrackMenu({ trackId: row.track.id, x: rect.right + 4, y: rect.top, trigger: event.currentTarget });
                }}
              >
                <MoreHorizontal size={14} />
              </button>
            )}
            {!headsCollapsed && (
              <>
                <span aria-hidden />
                {hasClips && (
                  <>
                    <button
                      className="track-flag"
                      aria-label={`锁定轨道 ${row.track.id}`}
                      aria-pressed={row.track.locked}
                      title="锁定轨道"
                      onClick={() => patchTrackFlags(row.track.id, { locked: !row.track.locked })}
                    >
                      {row.track.locked ? <Lock size={11} /> : <LockOpen size={11} />}
                    </button>
                    <button
                      className="track-flag"
                      aria-label={`隐藏轨道 ${row.track.id}`}
                      aria-pressed={row.track.hidden}
                      title="隐藏轨道（预览不渲染该轨内容）"
                      onClick={() => patchTrackFlags(row.track.id, { hidden: !row.track.hidden })}
                    >
                      {row.track.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
                    </button>
                    {kind !== "text" && (
                      <button
                        className="track-flag"
                        aria-label={`静音轨道 ${row.track.id}`}
                        aria-pressed={row.track.muted}
                        title="关闭原声"
                        onClick={() => patchTrackFlags(row.track.id, { muted: !row.track.muted })}
                      >
                        {row.track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                      </button>
                    )}
                    {kind !== "text" && (
                      <button
                        className={`track-flag track-solo${row.track.solo ? " active" : ""}`}
                        aria-label={`独奏轨道 ${row.track.id}`}
                        aria-pressed={row.track.solo}
                        title="独奏（仅播放该轨声音）"
                        onClick={() => patchTrackFlags(row.track.id, { solo: !row.track.solo })}
                      >
                        S
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
