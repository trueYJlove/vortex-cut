import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { MARKER_COLORS, loadMarkers, saveMarkers, newMarkerId, sortMarkers, type TimelineMarker } from "./markers.js";
import { timeToX } from "./geometry.js";
import type { TimelineViewState } from "./types.js";

/**
 * 标记行（2026-11-10，对齐 OpenFilm 的 MARKER_ROW_H = 16）。
 *
 * 它**浮在**轨道区顶部、不占布局高度——因此加一个标记或删掉最后一个，
 * 轨道都不会上下跳动（OpenFilm 明确这么做，见其 MARKER_ROW_H 注释）。
 * 只在有标记时出现。
 *
 * 交互：点空位加标记；点已有标记选中它（可改色/删除）；拖标记改时间。
 * 双击空白加标记并立即进入编辑。右键删除。
 */
export interface MarkerLaneProps {
  ref?: Ref<{ addAtTime: (timeUs: number) => void }>;
  projectId: string;
  view: TimelineViewState;
  totalUs: number;
  /** 拖动/点击产生的吸附（与片段共用同一吸附逻辑）。 */
  snapUs: (valueUs: number) => number;
  /** 当前播放头时间（"+ "按钮按它加标记）。 */
  playheadUs: number;
  /** 标记被拖动时向外报告一条贯穿时间线的引导线；null 清除。 */
  onGuide: (guide: { timeUs: number; color: string; held: boolean } | null) => void;
  onMarkersChange: (markers: TimelineMarker[]) => void;
  onSeek: (timeUs: number) => void;
}

export function MarkerLane({ projectId, view, totalUs, snapUs, onGuide, onMarkersChange, onSeek, playheadUs, ref }: MarkerLaneProps) {
  const [markers, setMarkers] = useState<TimelineMarker[]>(() => sortMarkers(loadMarkers(projectId)));
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const [editing, setEditing] = useState<string | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  // 项目切换：重新载入（projectId 变化时 markers 属于另一个项目）
  useEffect(() => { setMarkers(sortMarkers(loadMarkers(projectId))); }, [projectId]);
  useEffect(() => { onMarkersChange(markers); }, [markers, onMarkersChange]);

  const commit = (next: TimelineMarker[]) => {
    const sorted = sortMarkers(next);
    markersRef.current = sorted;
    setMarkers(sorted);
    saveMarkers(projectId, sorted);
  };

  const timeAt = (clientX: number): number => {
    const el = laneRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    // 标记行与标尺同坐标系：减去 headerWidth（轨道头列宽）
    const x = clientX - rect.left - view.headerWidth + view.scrollX;
    const rawUs = (x / view.pixelsPerSecond) * 1_000_000;
    const clamped = Math.max(0, totalUs > 0 ? Math.min(rawUs, totalUs) : rawUs);
    return snapUs(clamped);
  };

  /** 在指定时间加一个标记（用于"+ "按钮——它按播放头位置加）。 */
  const addAtTime = (timeUs: number) => {
    const existing = markers.find(marker => Math.abs(marker.timeUs - timeUs) < 1_000);
    if (existing) { setEditing(existing.id); return; }
    const marker: TimelineMarker = {
      id: newMarkerId(),
      timeUs,
      color: MARKER_COLORS[markers.length % MARKER_COLORS.length],
      label: "",
    };
    commit([...markers, marker]);
    setEditing(marker.id);
  };

  useImperativeHandle(ref, () => ({ addAtTime }));
  const addAt = (clientX: number) => addAtTime(timeAt(clientX));

  const remove = (id: string) => commit(markers.filter(m => m.id !== id));
  const recolor = (id: string, color: string) => commit(markers.map(m => (m.id === id ? { ...m, color } : m)));
  const relabel = (id: string, label: string) => commit(markers.map(m => (m.id === id ? { ...m, label } : m)));

  // 拖动改时间：pointermove 只更新预览位置，松手才落库（与片段拖动同一语义）
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.moved = true;
      const timeUs = timeAt(event.clientX);
      const next = markersRef.current.map(m => (m.id === drag.id ? { ...m, timeUs } : m));
      markersRef.current = next;
      setMarkers(next);
      const marker = next.find(m => m.id === drag.id);
      onGuide({ timeUs, color: marker?.color ?? MARKER_COLORS[0], held: true });
    };
    const up = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      suppressClick.current = drag.moved;
      onGuide(null);
      if (drag.moved) commit(markersRef.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [markers, view, totalUs, onGuide]);

  if (markers.length === 0) return null;

  return (
    <div className="timeline-marker-lane" ref={laneRef} aria-label="时间线标记" role="group">
      <button
        type="button"
        className="timeline-marker-add"
        title="在当前播放头位置添加标记（也可双击标记行空白处）"
        aria-label="在播放头位置添加标记"
        onClick={() => addAtTime(Math.min(playheadUs, totalUs))}
      >+</button>
      {markers.map(marker => {
        const x = timeToX(marker.timeUs, view) + (view.headerWidth * 0);
        const isEditing = editing === marker.id;
        return (
          <div
            key={marker.id}
            className={`timeline-marker${isEditing ? " editing" : ""}`}
            style={{ transform: `translateX(${timeToX(marker.timeUs, view)}px)` }}
            onPointerEnter={() => onGuide({ timeUs: marker.timeUs, color: marker.color, held: false })}
            onPointerLeave={() => { if (!dragRef.current) onGuide(null); }}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onSeek(marker.timeUs); setEditing(marker.id); }}
          >
            <button
              type="button"
              className="timeline-marker-pin"
              style={{ background: marker.color }}
              aria-label={`标记 ${marker.label || "未命名"} @ ${(marker.timeUs / 1_000_000).toFixed(2)}s`}
              onPointerDown={event => {
                event.stopPropagation();
                (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
                dragRef.current = { id: marker.id, moved: false };
              }}
              onClick={event => {
                event.stopPropagation();
                if (suppressClick.current) { suppressClick.current = false; return; }
                onSeek(marker.timeUs);
                setEditing(marker.id);
              }}
              onDoubleClick={() => setEditing(marker.id)}
            />
            {isEditing && (
              <div className="timeline-marker-editor" role="dialog" aria-label="编辑时间线标记"
                onPointerDown={event => event.stopPropagation()}
                onClick={event => event.stopPropagation()}
                onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEditing(null); }}
                onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") setEditing(null); }}>
                <input
                  autoFocus
                  value={marker.label}
                  placeholder="标记备注"
                  aria-label="标记备注"
                  onChange={event => relabel(marker.id, event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter" || event.key === "Escape") setEditing(null); }}
                />
                <div className="timeline-marker-colors">
                  {MARKER_COLORS.map(color => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`标记颜色 ${color}`}
                      className={color === marker.color ? "swatch active" : "swatch"}
                      style={{ background: color }}
                      onClick={() => recolor(marker.id, color)}
                    />
                  ))}
                  <button type="button" className="timeline-marker-delete" aria-label="删除标记" onClick={() => remove(marker.id)}>删除</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
