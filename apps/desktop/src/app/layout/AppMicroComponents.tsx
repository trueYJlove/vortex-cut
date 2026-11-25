import type React from "react";
import type { TimelineClip, TranscriptSegment } from "@aivideo/contracts";
import type { RenditionReframePreviewPresentation } from "../../../electron/preload/index.js";
import {
  anchorLabels,
  formatTime,
  horizontalAnchors,
  verticalAnchors,
  type ReframeAnchor,
} from "../appHelpers.js";

export function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className="icon-btn" title={label} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function ReframeTargetEditor({ clips, selections, preview, pending, onSelect, onGenerate, onPlay }: {
  clips: TimelineClip[];
  selections: Record<string, ReframeAnchor>;
  preview?: RenditionReframePreviewPresentation;
  pending: boolean;
  onSelect: (clipId: string, anchor: ReframeAnchor) => void;
  onGenerate: () => void;
  onPlay: () => void;
}) {
  const adjustmentCount = Object.keys(selections).length;
  return <section className="reframe-editor" aria-label="静态焦点重构图">
    <div className="reframe-heading"><strong>静态焦点重构图</strong><small>本地 3×3 静态锚点；非自动识别、非动态跟踪，也不保证平台审核安全区。</small></div>
    {!clips.length && <p className="reframe-unavailable">此基础目标没有解析为 crop_fill 的 Clip，不能使用静态焦点。</p>}
    {clips.map(clip => { const selected = selections[clip.clip_id] ?? { horizontal_anchor: "center", vertical_anchor: "center" }; return <div className="reframe-clip" key={clip.clip_id}><span>Clip {clip.order_index + 1}</span><div className="anchor-grid" role="group" aria-label={`Clip ${clip.order_index + 1} 静态焦点`}>{verticalAnchors.flatMap(vertical => horizontalAnchors.map(horizontal => { const key = `${horizontal}:${vertical}`; const active = selected.horizontal_anchor === horizontal && selected.vertical_anchor === vertical; return <button key={key} className={active ? "active" : ""} aria-label={`Clip ${clip.order_index + 1} ${anchorLabels[key]}`} aria-pressed={active} onClick={() => onSelect(clip.clip_id, { horizontal_anchor: horizontal, vertical_anchor: vertical })}>{anchorLabels[key]}</button>; }))}</div></div>; })}
    <div className="reframe-actions"><small>{adjustmentCount ? `${adjustmentCount} 个非中心调整；交互构图仅为非权威近似。` : "中心为基础行为，不会持久化或发送。"}</small><button disabled={!adjustmentCount || pending} onClick={onGenerate}>{pending ? "正在生成重构图预览" : preview ? "重新生成重构图预览" : "生成重构图权威预览"}</button>{preview && <button onClick={onPlay}>播放重构图预览</button>}</div>
  </section>;
}

export function SegmentRow({ segment, selected, onToggle }: { segment: TranscriptSegment; selected: boolean; onToggle: () => void }) {
  return <label className="segment-row"><input type="checkbox" checked={selected} onChange={onToggle} /><span>{formatTime(segment.start_us)}-{formatTime(segment.end_us)}</span><p>{segment.text}</p></label>;
}
