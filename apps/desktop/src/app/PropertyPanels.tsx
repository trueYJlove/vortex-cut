import { Archive, FileText, Lock, RotateCcw, Save, Volume2, VolumeX } from "lucide-react";
import type { CaptionPresetId, Project, TimelineCaption, TimelineClip, TimelineDiff, TimelineDocument, TimelineLayout, TimelinePatchOperation, TimelineTransition } from "@aivideo/contracts";
import type { AuthoritativePreviewPresentation } from "../../electron/preload/index.js";

type SaveState = "已保存" | "保存中" | "保存失败" | "草稿冲突";
const layouts: { value: TimelineLayout; label: string }[] = [{ value: "blurred_background", label: "模糊背景" }, { value: "crop_fill", label: "裁切填满" }, { value: "fit", label: "完整适配" }];
const captionPresets: { value: CaptionPresetId; label: string }[] = [{ value: "default-bottom", label: "默认底部" }, { value: "game-safe-bottom", label: "游戏安全区" }, { value: "high-contrast", label: "高对比" }];
const formatTime = (us: number) => {
  const totalSeconds = us / 1_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(Math.floor(seconds)).padStart(2, "0")}`;
  if (minutes > 0) return `${minutes}:${String(Math.floor(seconds)).padStart(2, "0")}`;
  return `${seconds.toFixed(2)}s`;
};
export { formatTime };
export type { SaveState };

const speedPresets = [250, 500, 750, 1000, 1250, 1500, 2000, 4000];
const speedLabel = (speed: number) => `${(speed / 1000).toFixed(speed % 1000 === 0 ? 0 : 2).replace(/\.?0+$/, "")}x`;

const keyframePropertyLabels: Array<{ property: "position" | "scale" | "rotate" | "opacity"; label: string }> = [
  { property: "position", label: "位置" },
  { property: "scale", label: "缩放" },
  { property: "rotate", label: "旋转" },
  { property: "opacity", label: "透明度" },
];

export function ClipProperties({ clip, working, locked, onPatch, onDraft, playheadUs }: { clip: TimelineClip; working: TimelineDocument; locked: boolean; onPatch: (ops: TimelinePatchOperation[], summary: string) => Promise<void>; onDraft: (doc: TimelineDocument) => void; playheadUs?: number }) {
  const updateLocal = (next: Partial<TimelineClip>) => onDraft({ ...working, clips: working.clips.map(item => item.clip_id === clip.clip_id ? { ...item, ...next } : item) });
  const speed = clip.speed_milli ?? 1000;
  const setSpeed = (value: number) => void onPatch([{ op: "set_speed", clip_id: clip.clip_id, speed_milli: value }], value === 1000 ? "恢复原速" : `调整速度 ${speedLabel(value)}`);
  // B3：关键帧编辑基于播放头在片段内的相对时间。
  const clipRelativeUs = playheadUs !== undefined ? Math.max(0, Math.min(clip.timeline_end_us - clip.timeline_start_us, Math.round(playheadUs - clip.timeline_start_us))) : undefined;
  const setKeyframe = (property: "position" | "scale" | "rotate" | "opacity", frames: Array<{ t_us: number; x?: number; y?: number; v?: number }>) => void onPatch([{ op: "set_clip_keyframes", clip_id: clip.clip_id, property, frames }], `设置${keyframePropertyLabels.find(item => item.property === property)?.label}关键帧`);
  const clearKeyframe = (property: "position" | "scale" | "rotate" | "opacity") => void onPatch([{ op: "clear_clip_keyframes", clip_id: clip.clip_id, property }], `清除${keyframePropertyLabels.find(item => item.property === property)?.label}关键帧`);
  return <fieldset className="property-form locked-fieldset" disabled={locked}><h2>片段属性</h2>{locked && <p className="locked-note"><Lock />此 Clip 已锁定，直接编辑和关联 Caption 编辑已禁用。</p>}<label>布局<select value={clip.layout} onChange={event => void onPatch([{ op: "set_layout", clip_id: clip.clip_id, layout: event.target.value as TimelineLayout }], "调整布局")}>{layouts.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>{(clip.asset_kind === "video" || clip.asset_kind === "audio") && <div className="speed-editor"><span className="speed-editor-title">速度 {speedLabel(speed)}{speed !== 1000 && <button className="speed-reset" title="恢复原速" onClick={() => setSpeed(1000)}>重置</button>}</span><div className="speed-presets" role="group" aria-label="速度预设">{speedPresets.map(value => <button key={value} className={value === speed ? "active" : ""} aria-pressed={value === speed} onClick={() => setSpeed(value)}>{speedLabel(value)}</button>)}</div><label className="speed-custom">自定义倍速<input type="number" min={0.25} max={4} step={0.05} value={speed / 1000} onChange={event => { const parsed = Number(event.target.value); if (Number.isFinite(parsed) && parsed >= 0.25 && parsed <= 4) updateLocal({ speed_milli: Math.round(parsed * 1000) as TimelineClip["speed_milli"] }); }} onBlur={event => { const parsed = Number(event.target.value); if (Number.isFinite(parsed) && parsed >= 0.25 && parsed <= 4) setSpeed(Math.round(parsed * 1000)); else event.target.value = String(speed / 1000); }} /></label></div>}
  {clip.asset_kind === "video" && clipRelativeUs !== undefined && <div className="keyframe-editor"><span className="speed-editor-title">动画（播放头 {formatTime(clipRelativeUs)}）</span><div className="keyframe-rows">{keyframePropertyLabels.map(({ property, label }) => {
    const track = clip.keyframes?.[property];
    const hasTrack = Boolean(track);
    const t = clipRelativeUs;
    return <div className="keyframe-row" key={property}><span className="keyframe-label">{label}</span><button title={hasTrack ? "在播放头处打关键帧" : "添加关键帧"} onClick={() => { const frames = (track?.frames ?? []).filter(f => f.t_us !== t); const seed = property === "position" ? { t_us: t, x: 0, y: 0 } : { t_us: t, v: property === "scale" ? 1 : property === "opacity" ? 1 : 0 }; setKeyframe(property, [...frames, seed].sort((a, b) => a.t_us - b.t_us)); }}>{hasTrack ? "打点" : "添加"}</button>{hasTrack && <button className="speed-reset" title="清除此属性全部关键帧" onClick={() => clearKeyframe(property)}>清除</button>}{hasTrack && <span className="keyframe-value">{track?.frames.length} 帧</span>}</div>;
  })}</div><p className="properties-muted">按播放头位置打点；随片段变速等比重映射；动画仅权威预览渲染。</p></div>}
  {clip.asset_kind === "video" && <label className="check two-part"><input type="checkbox" checked={clip.reverse_playback ?? false} onChange={event => void onPatch([{ op: "set_reverse_playback", clip_id: clip.clip_id, reverse_playback: event.target.checked }], event.target.checked ? "开启倒放" : "关闭倒放")} />倒放（权威预览生效；音频静音）</label>}
  {clip.asset_kind === "video" ? <><label className="check"><input type="checkbox" checked={clip.audio.enabled} onChange={event => void onPatch([{ op: "set_audio", clip_id: clip.clip_id, enabled: event.target.checked, gain_db: clip.audio.gain_db }], "调整音频")} />{clip.audio.enabled ? <Volume2 /> : <VolumeX />}启用音频</label><label>增益 {clip.audio.gain_db.toFixed(1)} dB<input type="range" min={-60} max={12} step={0.5} value={clip.audio.gain_db} onChange={event => updateLocal({ audio: { ...clip.audio, gain_db: Number(event.target.value) } })} onPointerUp={event => void onPatch([{ op: "set_audio", clip_id: clip.clip_id, enabled: clip.audio.enabled, gain_db: Number((event.target as HTMLInputElement).value) }], "调整音频增益")} /></label><label>源起点（秒）<input type="number" step="0.1" value={clip.source_start_us! / 1_000_000} onChange={event => updateLocal({ source_start_us: Number(event.target.value) * 1_000_000 })} onBlur={event => void onPatch([{ op: "trim_clip", clip_id: clip.clip_id, source_start_us: Number(event.target.value) * 1_000_000, source_end_us: clip.source_end_us! }], "微调片段起点")} /></label><label>源终点（秒）<input type="number" step="0.1" value={clip.source_end_us! / 1_000_000} onChange={event => updateLocal({ source_end_us: Number(event.target.value) * 1_000_000 })} onBlur={event => void onPatch([{ op: "trim_clip", clip_id: clip.clip_id, source_start_us: clip.source_start_us!, source_end_us: Number(event.target.value) * 1_000_000 }], "微调片段终点")} /></label></> : <label>图片时长（秒）<input type="number" min={0.5} max={30} step={0.5} value={(clip.timeline_end_us - clip.timeline_start_us) / 1_000_000} onChange={event => updateLocal({ timeline_end_us: clip.timeline_start_us + Number(event.target.value) * 1_000_000 })} onBlur={event => void onPatch([{ op: "set_image_duration", clip_id: clip.clip_id, duration_us: Number(event.target.value) * 1_000_000 }], "调整图片时长")} /></label>}</fieldset>;
}

export function CaptionProperties({ caption, working, locked, onPatch, onDraft }: { caption: TimelineCaption; working: TimelineDocument; locked: boolean; onPatch: (ops: TimelinePatchOperation[], summary: string) => Promise<void>; onDraft: (doc: TimelineDocument) => void }) {
  const updateLocal = (next: Partial<TimelineCaption>) => onDraft({ ...working, captions: working.captions.map(item => item.caption_id === caption.caption_id ? { ...item, ...next } : item) });
  return <fieldset className="property-form locked-fieldset" disabled={locked}><h2>字幕属性</h2>{locked && <p className="locked-note"><Lock />关联 Clip 已锁定，此 Caption 只读。</p>}<label>文本<textarea value={caption.text} maxLength={200} onChange={event => updateLocal({ text: event.target.value })} onBlur={event => void onPatch([{ op: "update_caption", caption_id: caption.caption_id, text: event.target.value }], "修正字幕文本")} /></label><label>开始（秒）<input type="number" step="0.1" value={caption.start_us / 1_000_000} onChange={event => updateLocal({ start_us: Number(event.target.value) * 1_000_000 })} onBlur={event => void onPatch([{ op: "set_caption_timing", caption_id: caption.caption_id, start_us: Number(event.target.value) * 1_000_000, end_us: caption.end_us }], "调整字幕时间")} /></label><label>结束（秒）<input type="number" step="0.1" value={caption.end_us / 1_000_000} onChange={event => updateLocal({ end_us: Number(event.target.value) * 1_000_000 })} onBlur={event => void onPatch([{ op: "set_caption_timing", caption_id: caption.caption_id, start_us: caption.start_us, end_us: Number(event.target.value) * 1_000_000 }], "调整字幕时间")} /></label><label>预设<select value={caption.preset_id} onChange={event => void onPatch([{ op: "set_caption_preset", caption_id: caption.caption_id, preset_id: event.target.value as CaptionPresetId }], "调整字幕预设")}>{captionPresets.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label><div className="caption-style-editor"><span className="speed-editor-title">样式{caption.style_override && <button className="speed-reset" title="恢复预设样式" onClick={() => void onPatch([{ op: "clear_caption_style", caption_id: caption.caption_id }], "恢复预设样式")}>恢复预设</button>}</span><div className="keyframe-rows"><label className="keyframe-row"><span className="keyframe-label">字号</span><input type="number" min={24} max={144} step={1} value={caption.style_override?.font_size ?? ""} placeholder="预设" onBlur={event => { const parsed = Number(event.target.value); if (Number.isFinite(parsed) && parsed >= 24 && parsed <= 144) void onPatch([{ op: "set_caption_style", caption_id: caption.caption_id, style: { font_size: Math.round(parsed) } }], `字号 ${parsed}`); }} /></label><label className="keyframe-row"><span className="keyframe-label">字色</span><input type="color" aria-label="字体颜色" value={assToRgb(caption.style_override?.primary_color ?? "&H00FFFFFF")} onChange={event => void onPatch([{ op: "set_caption_style", caption_id: caption.caption_id, style: { primary_color: rgbToAss(event.target.value) } }], "字体颜色")} /></label><label className="keyframe-row"><span className="keyframe-label">描边色</span><input type="color" aria-label="描边颜色" value={assToRgb(caption.style_override?.outline_color ?? "&H00000000")} onChange={event => void onPatch([{ op: "set_caption_style", caption_id: caption.caption_id, style: { outline_color: rgbToAss(event.target.value) } }], "描边颜色")} /></label><label className="keyframe-row"><span className="keyframe-label">描边宽</span><input type="number" min={0} max={10} step={1} value={caption.style_override?.outline ?? ""} placeholder="预设" onBlur={event => { const parsed = Number(event.target.value); if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 10) void onPatch([{ op: "set_caption_style", caption_id: caption.caption_id, style: { outline: Math.round(parsed) } }], `描边宽度 ${parsed}`); }} /></label><label className="keyframe-row"><span className="keyframe-label">位置</span><select value={String(caption.style_override?.alignment ?? "")} onChange={event => { const value = Number(event.target.value); if ([2, 5, 8].includes(value)) void onPatch([{ op: "set_caption_style", caption_id: caption.caption_id, style: { alignment: value } }], value === 2 ? "位置底部" : value === 5 ? "位置居中" : "位置顶部"); }}><option value="">预设</option><option value="2">底部</option><option value="5">居中</option><option value="8">顶部</option></select></label></div><p className="properties-muted">仅内置字体（Noto Sans CJK SC）；样式仅覆盖所选字幕，预设其余字段保持不变。</p></div></fieldset>;
}

export function ProjectProperties({ project, saveState, authoritativePreview, previewIsStale, renderDisabledReason, onGeneratePreview, onCreateExport, onOpenProjectDialog }: {
  project?: Project;
  saveState: SaveState;
  authoritativePreview?: AuthoritativePreviewPresentation;
  previewIsStale: boolean;
  renderDisabledReason?: string;
  onGeneratePreview: () => void;
  onCreateExport: () => void;
  onOpenProjectDialog: () => void;
}) {
  return <div className="properties-project">
    <section className="property-block" aria-label="项目概览"><h2>项目概览</h2>{project ? <><div className="property-line"><span>项目名称</span><strong>{project.name}</strong></div><div className="property-line"><span>状态</span><strong>{project.status === "active" ? "活动" : project.status === "archived" ? "已归档" : "目录缺失"}</strong></div><div className="property-line"><span>画布</span><strong>{project.canvas.width}×{project.canvas.height} · {project.canvas.fps_num}fps</strong></div></> : <p className="properties-muted">未选择项目。</p>}</section>
    <section className="property-block" aria-label="保存/预览检查"><h2>保存/预览检查</h2><div className="properties-status">保存状态：{saveState}</div><div className="properties-status">权威预览：{authoritativePreview ? (previewIsStale ? "已过期" : "已就绪") : "尚未生成"}</div></section>
    <section className="property-block" aria-label="下一步动作"><h2>下一步动作</h2><div className="properties-actions"><button disabled={Boolean(renderDisabledReason)} title={renderDisabledReason} onClick={onGeneratePreview}>生成权威预览</button><button disabled={Boolean(renderDisabledReason)} title={renderDisabledReason} onClick={onCreateExport}>导出正式视频</button><button onClick={onOpenProjectDialog}>打开项目管理</button></div></section>
  </div>;
}

export function TimelineDiffView({ diff }: { diff: TimelineDiff }) {
  return <div className="diff-groups"><section><h4>概览</h4><p>Clip {diff.summary.clip_changes} · Caption {diff.summary.caption_changes} · 锁定 {diff.summary.lock_changes} · 时长 {formatTime(diff.duration_delta_us)}</p></section><section><h4>Clip</h4>{diff.clip_changes.length ? diff.clip_changes.map((item, index) => <p key={`${item.clip_id}-${item.type}-${index}`}>{item.type} · {item.clip_id}{item.created_clip_ids ? ` -> ${item.created_clip_ids.join(", ")}` : ""}</p>) : <p>无变化</p>}</section><section><h4>Caption</h4>{diff.caption_changes.length ? diff.caption_changes.map((item, index) => <p key={`${item.caption_id}-${item.type}-${index}`}>{item.type} · {item.caption_id}</p>) : <p>无变化</p>}</section><section><h4>锁定</h4>{diff.lock_changes.length ? diff.lock_changes.map((item, index) => <p key={`${item.clip_id}-${item.type}-${index}`}>{item.type} · {item.clip_id}</p>) : <p>无变化</p>}</section><section><h4>锁定 Clip 间接平移</h4>{diff.indirect_locked_timing_shifts.length ? diff.indirect_locked_timing_shifts.map(item => <p key={item.clip_id}>{item.clip_id} · {formatTime(item.from_start_us)}-{formatTime(item.from_end_us)} {"->"} {formatTime(item.to_start_us)}-{formatTime(item.to_end_us)}</p>) : <p>无变化</p>}</section></div>;
}

// 从 App.tsx 平移的通用小部件与常量。
export const segmentPresets = captionPresets;
export const panelIcons = { Archive, RotateCcw, Save, FileText };

const transitionKinds = ["fade", "fadeblack", "dissolve", "wipeleft", "wiperight", "slideleft", "slideup", "zoomin"] as const;

/** RGB(#rrggbb) → ASS &Haabbggrr（alpha 固定 00 不透明）。 */
function rgbToAss(rgb: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(rgb);
  if (!m) return "&H00FFFFFF";
  const r = m[1].slice(0, 2), g = m[1].slice(2, 4), b = m[1].slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}
/** ASS &Haabbggrr → RGB(#rrggbb)。 */
function assToRgb(ass: string): string {
  const m = /^&H00([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(ass);
  if (!m) return "#ffffff";
  return `#${m[3]}${m[2]}${m[1]}`.toLowerCase();
}

export function TransitionProperties({ transition, onPatch }: { transition: TimelineTransition; onPatch: (ops: TimelinePatchOperation[], summary: string) => Promise<void> }) {
  const update = (ops: TimelinePatchOperation[], summary: string) => void onPatch(ops, summary);
  return <fieldset className="property-form"><h2>转场属性</h2><label>类型<select value={transition.kind} onChange={event => update([{ op: "update_transition", transition_id: transition.transition_id, kind: event.target.value as typeof transition.kind }], `转场类型 ${event.target.value}`)}>{transitionKinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label><label>时长（秒）<input type="number" min={0.1} max={2} step={0.1} value={transition.duration_us / 1_000_000} onChange={event => { const parsed = Number(event.target.value); if (Number.isFinite(parsed) && parsed >= 0.1 && parsed <= 2) update([{ op: "update_transition", transition_id: transition.transition_id, duration_us: Math.round(parsed * 1_000_000) }], `转场时长 ${parsed}s`); }} /></label><div className="properties-actions"><button onClick={() => update([{ op: "remove_transition", transition_id: transition.transition_id }], "删除转场")}>删除转场</button></div><p className="properties-muted">转场仅在权威预览与最终导出中渲染；交互预览直接切换片段。</p></fieldset>;
}
