import { useState } from "react";
import { Archive, FileText, Lock, RotateCcw, Save } from "lucide-react";
import type { CaptionPresetId, Project, TimelineCaption, TimelineClip, TimelineDiff, TimelineDocument, TimelineLayout, TimelinePatchOperation, TimelineTransition } from "@aivideo/contracts";
import type { AuthoritativePreviewPresentation } from "../../electron/preload/index.js";
import { PanelTabs, SubTabs, PGroup, PSep, PRow, Switch, Seg, SoonBadge, PNote, NumberField, RangeRow } from "./PropertyControls.js";

type SaveState = "已保存" | "保存中" | "保存失败" | "草稿冲突";
const captionPresets: { value: CaptionPresetId; label: string }[] = [{ value: "default-bottom", label: "默认底部" }, { value: "game-safe-bottom", label: "游戏安全区" }, { value: "high-contrast", label: "高对比" }];
const formatTime = (us: number) => {
  const totalSeconds = us / 1_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(Math.floor(seconds)).padStart(2, "0")}`;
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}`;
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

/**
 * 片段属性面板 v2：按 docs/ui-mockups/property-panel/DESIGN.md §1.1 信息架构分页签。
 * 视频/图片：画面（基础·抠像·蒙版）/ 音频 / 变速（含倒放）/ 动画；音频素材：基础 / 换音色 / 声音效果 / 变速。
 * 仅重组 UI，patch 操作与字段语义与 v1 完全一致；「规划中」为静态占位。
 */
export function ClipProperties({ clip, working, locked, onPatch, onDraft, playheadUs, onOpenEditingTools }: { clip: TimelineClip; working: TimelineDocument; locked: boolean; onPatch: (ops: TimelinePatchOperation[], summary: string) => Promise<void>; onDraft: (doc: TimelineDocument) => void; playheadUs?: number; onOpenEditingTools?: (tool: "remove_pauses" | "beat_sync" | "lj_cut") => void }) {
  const isVideo = clip.asset_kind === "video";
  const isImage = clip.asset_kind === "image";
  const isAudioClip = clip.asset_kind === "audio";
  const overlay = clip.track_id !== "V1" && clip.track_id !== "A1";
  const updateLocal = (next: Partial<TimelineClip>) => onDraft({ ...working, clips: working.clips.map(item => item.clip_id === clip.clip_id ? { ...item, ...next } : item) });
  const speed = clip.speed_milli ?? 1000;
  const setSpeed = (value: number) => void onPatch([{ op: "set_speed", clip_id: clip.clip_id, speed_milli: value }], value === 1000 ? "恢复原速" : `调整速度 ${speedLabel(value)}`);
  // B3：关键帧编辑基于播放头在片段内的相对时间。
  const clipRelativeUs = playheadUs !== undefined ? Math.max(0, Math.min(clip.timeline_end_us - clip.timeline_start_us, Math.round(playheadUs - clip.timeline_start_us))) : undefined;
  const setKeyframe = (property: "position" | "scale" | "rotate" | "opacity", frames: Array<{ t_us: number; x?: number; y?: number; v?: number }>) => {
    // B3：核心要求 t_us 为整数且严格递增。对历史遗留的小数做归一，避免持久化的旧帧再次提交被拒。
    const durUs = clip.timeline_end_us - clip.timeline_start_us;
    const normalized = frames
      .map(f => ({ ...f, t_us: Math.max(0, Math.min(durUs, Math.round(f.t_us))) }))
      .sort((a, b) => a.t_us - b.t_us);
    void onPatch([{ op: "set_clip_keyframes", clip_id: clip.clip_id, property, frames: normalized }], `设置${keyframePropertyLabels.find(item => item.property === property)?.label}关键帧`);
  };
  const clearKeyframe = (property: "position" | "scale" | "rotate" | "opacity") => void onPatch([{ op: "clear_clip_keyframes", clip_id: clip.clip_id, property }], `清除${keyframePropertyLabels.find(item => item.property === property)?.label}关键帧`);
  // P1：静态默认变换（画中画/覆盖轨定位）。缺省即无 transform（仅合成时隐式全屏）。
  const setTransform = (patch: Partial<NonNullable<TimelineClip["transform"]>>, summary: string) => void onPatch([{ op: "set_clip_transform", clip_id: clip.clip_id, transform: { ...clip.transform, ...patch } }], summary);
  const fixedTf = { x: clip.transform?.x ?? 0.5, y: clip.transform?.y ?? 0.5, scale: clip.transform?.scale ?? 1, rotate: clip.transform?.rotate ?? 0, opacity: clip.transform?.opacity ?? 1 };
  // P2：蒙版。空对象 = 无蒙版。
  const applyMask = (patch: Partial<NonNullable<TimelineClip["mask"]>>, summary: string) => void onPatch([{ op: "set_clip_mask", clip_id: clip.clip_id, mask: { kind: clip.mask?.kind ?? "ellipse", ...clip.mask, ...patch } }], summary);
  const draftMask = (patch: Partial<NonNullable<TimelineClip["mask"]>>) => updateLocal({ mask: { kind: clip.mask?.kind ?? "ellipse", ...clip.mask, ...patch } });
  // P3：抠像（纯色/绿幕）。空对象 = 清除。
  const applyKey = (patch: Partial<NonNullable<TimelineClip["keying"]>>, summary: string) => void onPatch([{ op: "set_clip_keying", clip_id: clip.clip_id, keying: { ...clip.keying, ...patch } }], summary);
  const draftKey = (patch: Partial<NonNullable<TimelineClip["keying"]>>) => updateLocal({ keying: { ...clip.keying, ...patch } });

  // ---- 页签状态（跨片段选择持久；按素材类型回退到首个可用页签） ----
  const topTabs = isAudioClip
    ? [{ id: "basic", label: "基础" }, { id: "voice", label: "换音色", soon: true }, { id: "fx", label: "声音效果", soon: true }, { id: "speed", label: "变速" }, { id: "tools", label: "手法" }]
    : isVideo
      ? [{ id: "pic", label: "画面" }, { id: "aud", label: "音频" }, { id: "speed", label: "变速" }, { id: "anim", label: "动画" }, { id: "tools", label: "手法" }]
      : [{ id: "pic", label: "画面" }, { id: "speed", label: "变速" }, { id: "anim", label: "动画" }];
  const [tab, setTab] = useState<string>(isAudioClip ? "basic" : "pic");
  const [picSub, setPicSub] = useState("basic");
  const [audSub, setAudSub] = useState("abasic");
  const activeTab = topTabs.some(t => t.id === tab) ? tab : topTabs[0].id;
  // 等比缩放：可点开关（原型交互）。当前版本缩放恒为等比，开关仅承载视觉状态。
  const [ratioOn, setRatioOn] = useState(true);
  const RatioSwitch = () => <Switch on={ratioOn} onToggle={() => setRatioOn(v => !v)} title="当前版本仅支持等比缩放" />;

  // ---- 画面 → 基础 ----
  const picBasic = <>
    <PGroup title="位置大小" chev onReset={() => void onPatch([{ op: "set_clip_transform", clip_id: clip.clip_id, transform: {} }], "重置画面变换")}>
      <RangeRow label="缩放" value={fixedTf.scale * 100} min={5} max={500} step={1} unit="%" decimals={0}
        onDraft={v => updateLocal({ transform: { ...clip.transform, scale: v / 100 } })}
        onCommit={v => setTransform({ scale: v / 100 }, `调整画中画缩放 ${Math.round(v)}%`)} />
      <PRow label="等比缩放"><RatioSwitch /></PRow>
      <PRow label="位置" tail="X / Y（中心偏移）">
        <NumberField value={Math.round((fixedTf.x - 0.5) * 200)} min={-100} max={100} step={1} ariaLabel="位置 X"
          onDraft={v => updateLocal({ transform: { ...clip.transform, x: 0.5 + v / 200 } })}
          onCommit={v => setTransform({ x: 0.5 + v / 200 }, "调整画中画水平位置")} />
        <NumberField value={Math.round((fixedTf.y - 0.5) * 200)} min={-100} max={100} step={1} ariaLabel="位置 Y"
          onDraft={v => updateLocal({ transform: { ...clip.transform, y: 0.5 + v / 200 } })}
          onCommit={v => setTransform({ y: 0.5 + v / 200 }, "调整画中画垂直位置")} />
      </PRow>
      <PRow label="旋转">
        <NumberField value={fixedTf.rotate} min={-180} max={180} step={1} unit="°" decimals={2} ariaLabel="旋转"
          onDraft={v => updateLocal({ transform: { ...clip.transform, rotate: v } })}
          onCommit={v => setTransform({ rotate: v }, "调整画中画旋转")} />
      </PRow>
      <RangeRow label="不透明度" value={fixedTf.opacity * 100} min={0} max={100} step={1} unit="%" decimals={0} w66
        onDraft={v => updateLocal({ transform: { ...clip.transform, opacity: v / 100 } })}
        onCommit={v => setTransform({ opacity: v / 100 }, "调整画中画不透明度")} />
  </PGroup>
    <PGroup title="更多画面能力" collapsible defaultClosed tail={<SoonBadge />}>
      <PRow label="混合模式" dim><Switch on={false} onToggle={() => {}} disabled /></PRow>
      <PRow label="变形" dim><Switch on={false} onToggle={() => {}} disabled /></PRow>
      <PRow label="视频防抖" dim><Switch on={false} onToggle={() => {}} disabled /></PRow>
      <PRow label="画质增强" dim><Switch on={false} onToggle={() => {}} disabled /></PRow>
    </PGroup>
    <PSep />
    <PGroup title="画面布局">
      <Seg value={clip.layout}
        options={[{ value: "fit", label: "完整适配" }, { value: "crop_fill", label: "裁切填满" }, { value: "blurred_background", label: "模糊背景" }]}
        onChange={v => void onPatch([{ op: "set_layout", clip_id: clip.clip_id, layout: v as TimelineLayout }], "调整布局")} />
    </PGroup>
    {isImage && <>
      <PSep />
      <PGroup title="素材时长">
        <PRow label="时长">
          <NumberField value={(clip.timeline_end_us - clip.timeline_start_us) / 1_000_000} min={0.5} max={30} step={0.5} unit="s" decimals={1} ariaLabel="图片时长"
            onDraft={v => updateLocal({ timeline_end_us: clip.timeline_start_us + Math.round(v * 1_000_000) })}
            onCommit={v => void onPatch([{ op: "set_image_duration", clip_id: clip.clip_id, duration_us: Math.round(v * 1_000_000) }], "调整图片时长")} />
        </PRow>
      </PGroup>
    </>}
    <PNote>对齐工具条（九宫格摆放）为规划占位，落地后显示在此处。</PNote>
  </>;

  // ---- 画面 → 抠像 ----
  const picKey = <>
    {!overlay && <PNote warn>抠像当前仅覆盖轨（画中画）片段参与成片渲染；主轨片段的抠像待后续支持。</PNote>}
    <PGroup title="色度抠像" tail={<span className="tail">绿幕 / 纯色背景</span>}>
      {!clip.keying ? <>
        <button type="button" className="pp-btn"
          onClick={() => void onPatch([{ op: "set_clip_keying", clip_id: clip.clip_id, keying: { color: "00FF00", similarity: 0.3, blend: 0.1 } }], "启用抠像")}>启用抠像</button>
        <PNote>抠除键色背景，透出<b>下层轨道画面</b>。适合绿幕素材、纯色背景拍摄。</PNote>
      </> : <>
        <PRow label="键色">
          <input type="color" className="pp-color" aria-label="抠像键色" value={`#${clip.keying.color ?? "00FF00"}`}
            onChange={event => draftKey({ color: event.target.value.slice(1).toUpperCase() })}
            onBlur={event => applyKey({ color: event.target.value.slice(1).toUpperCase() }, "设置抠像键色")} />
          <span className="tail">取绿幕实际颜色</span>
        </PRow>
        <RangeRow label="强度" value={clip.keying.similarity ?? 0.3} min={0} max={1} step={0.01} w66 ariaLabel="抠像强度"
          onDraft={v => draftKey({ similarity: v })}
          onCommit={v => applyKey({ similarity: v }, "调整抠像强度")} />
        <RangeRow label="边缘平滑" value={clip.keying.blend ?? 0.1} min={0} max={1} step={0.01} w66 ariaLabel="抠像边缘平滑"
          onDraft={v => draftKey({ blend: v })}
          onCommit={v => applyKey({ blend: v }, "调整抠像边缘平滑")} />
        <div className="pp-chk">
          <input type="checkbox" checked={Boolean(clip.keying.invert)} onChange={event => applyKey({ invert: event.target.checked }, event.target.checked ? "反选抠像" : "取消反选")} />
          <span>反选（保留键色、透明其余）</span>
        </div>
        <button type="button" className="pp-btn danger"
          onClick={() => void onPatch([{ op: "set_clip_keying", clip_id: clip.clip_id, keying: {} }], "清除抠像")}>清除抠像</button>
        <PNote><b>预览提示</b>　画布以底部棋盘格示意已启用抠像；精确边缘（发丝/半透明）以权威预览 / 成片为准。</PNote>
      </>}
    </PGroup>
  </>;

  // ---- 画面 → 蒙版 ----
  const picMask = <>
    {!overlay && <PNote warn>蒙版当前仅覆盖轨（画中画）片段参与成片渲染；主轨片段的蒙版待后续支持。</PNote>}
    <PGroup title="蒙版形状">
      <Seg value={clip.mask?.kind ?? "none"}
        options={[{ value: "none", label: "无" }, { value: "linear", label: "线性" }, { value: "rect", label: "矩形" }, { value: "ellipse", label: "椭圆" }]}
        onChange={kind => {
          if (kind === "none") void onPatch([{ op: "set_clip_mask", clip_id: clip.clip_id, mask: {} }], "清除蒙版");
          else applyMask({ kind: kind as "linear" | "rect" | "ellipse" }, `设置${kind === "linear" ? "线性" : kind === "rect" ? "矩形" : "椭圆"}蒙版`);
        }} />
      {clip.mask && <>
        <RangeRow label="中心 X" value={clip.mask.x ?? 0.5} min={0} max={1} step={0.01} w66 ariaLabel="蒙版中心 X"
          onDraft={v => draftMask({ x: v })} onCommit={v => applyMask({ x: v }, "调整蒙版中心 X")} />
        <RangeRow label="中心 Y" value={clip.mask.y ?? 0.5} min={0} max={1} step={0.01} w66 ariaLabel="蒙版中心 Y"
          onDraft={v => draftMask({ y: v })} onCommit={v => applyMask({ y: v }, "调整蒙版中心 Y")} />
        {clip.mask.kind === "linear" ? <>
          <PRow label="方向">
            <NumberField value={clip.mask.rotation ?? 0} min={-180} max={180} step={1} unit="°" decimals={0} ariaLabel="蒙版方向"
              onDraft={v => draftMask({ rotation: v })} onCommit={v => applyMask({ rotation: v }, "调整蒙版方向")} />
          </PRow>
          <RangeRow label="软边带宽" value={clip.mask.feather ?? 0.1} min={0} max={1} step={0.01} w66 ariaLabel="蒙版软边带宽"
            onDraft={v => draftMask({ feather: v })} onCommit={v => applyMask({ feather: v }, "调整蒙版软边")} />
        </> : <>
          <RangeRow label="宽" value={clip.mask.width ?? 0.5} min={0.01} max={1} step={0.01} w66 ariaLabel="蒙版宽"
            onDraft={v => draftMask({ width: v })} onCommit={v => applyMask({ width: v }, "调整蒙版宽")} />
          <RangeRow label="高" value={clip.mask.height ?? 0.5} min={0.01} max={1} step={0.01} w66 ariaLabel="蒙版高"
            onDraft={v => draftMask({ height: v })} onCommit={v => applyMask({ height: v }, "调整蒙版高")} />
          <PRow label="旋转">
            <NumberField value={clip.mask.rotation ?? 0} min={-180} max={180} step={1} unit="°" decimals={0} ariaLabel="蒙版旋转"
              onDraft={v => draftMask({ rotation: v })} onCommit={v => applyMask({ rotation: v }, "调整蒙版旋转")} />
          </PRow>
          <RangeRow label="羽化" value={clip.mask.feather ?? 0} min={0} max={1} step={0.01} w66 ariaLabel="蒙版羽化"
            onDraft={v => draftMask({ feather: v })} onCommit={v => applyMask({ feather: v }, "调整蒙版羽化")} />
        </>}
        <div className="pp-chk">
          <input type="checkbox" checked={Boolean(clip.mask.invert)} onChange={event => applyMask({ invert: event.target.checked }, event.target.checked ? "反选蒙版" : "取消反选")} />
          <span>反选（区域外保留）</span>
        </div>
      </>}
    </PGroup>
    <PNote>画布上<b>虚线框 = 蒙版边界</b>（相对本片段画面）：拖动平移、拖白点缩放；区域外透出下层画面。羽化向内柔化边界（0 = 硬边），预览与成片一致。</PNote>
  </>;

  // ---- 音频 → 基础（视频片段音频 / 音频素材共用） ----
  const audioBasics = <>
    <PGroup title="基础">
      <PRow label="启用音频">
        <Switch on={clip.audio.enabled} title={clip.audio.enabled ? "关闭音频" : "启用音频"}
          onToggle={() => void onPatch([{ op: "set_audio", clip_id: clip.clip_id, enabled: !clip.audio.enabled, gain_db: clip.audio.gain_db }], clip.audio.enabled ? "关闭音频" : "启用音频")} />
      </PRow>
      <RangeRow label="音量" value={clip.audio.gain_db} min={-60} max={12} step={0.5} unit="dB" decimals={1} ariaLabel="音频增益"
        onDraft={v => updateLocal({ audio: { ...clip.audio, gain_db: v } })}
        onCommit={v => void onPatch([{ op: "set_audio", clip_id: clip.clip_id, enabled: clip.audio.enabled, gain_db: v }], "调整音频增益")} />
      <PRow label="淡入时长" dim><input type="range" className="pp-range" disabled min={0} max={50} value={0} aria-label="淡入时长（规划中）" /><SoonBadge /></PRow>
      <PRow label="淡出时长" dim><input type="range" className="pp-range" disabled min={0} max={50} value={0} aria-label="淡出时长（规划中）" /><SoonBadge /></PRow>
      <PRow label="响度统一" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
    </PGroup>
    <PSep />
    <PGroup title="素材修剪">
      <PRow label="源起点">
        <NumberField value={clip.source_start_us! / 1_000_000} min={0} max={clip.source_end_us! / 1_000_000} step={0.1} unit="s" decimals={1} ariaLabel="源起点"
          onDraft={v => updateLocal({ source_start_us: Math.round(v * 1_000_000) })}
          onCommit={v => void onPatch([{ op: "trim_clip", clip_id: clip.clip_id, source_start_us: Math.round(v * 1_000_000), source_end_us: clip.source_end_us! }], "微调片段起点")} />
      </PRow>
      <PRow label="源终点">
        <NumberField value={clip.source_end_us! / 1_000_000} min={clip.source_start_us! / 1_000_000} max={36_000} step={0.1} unit="s" decimals={1} ariaLabel="源终点"
          onDraft={v => updateLocal({ source_end_us: Math.round(v * 1_000_000) })}
          onCommit={v => void onPatch([{ op: "trim_clip", clip_id: clip.clip_id, source_start_us: clip.source_start_us!, source_end_us: Math.round(v * 1_000_000) }], "微调片段终点")} />
      </PRow>
    </PGroup>
  </>;

  const voiceSoon = <PGroup title="换音色" tail={<SoonBadge />}>
    <PNote>变声 / 音色模板，布局对齐剪映（音色列表 + 参数）。当前版本未实现，仅占位。</PNote>
  </PGroup>;

  const fxSoon = <PGroup title="声音效果">
    <PRow label="音频降噪" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
    <PRow label="人声美化" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
    <PRow label="声音分离" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
    <PRow label="变调" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
    <PRow label="立体声平衡" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
    <PRow label="声道配置" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
  </PGroup>;

  // ---- 变速（含倒放，对齐剪映归属） ----
  const speedSection = <>
    <PGroup title="倍速">
      <Seg value={String(speed)} columns={4} options={speedPresets.map(p => ({ value: String(p), label: speedLabel(p) }))}
        onChange={v => setSpeed(Number(v))} />
      <PRow label="自定义">
        <NumberField value={speed / 1000} min={0.25} max={4} step={0.05} decimals={2} ariaLabel="自定义倍速"
          onDraft={v => updateLocal({ speed_milli: Math.round(v * 1000) as TimelineClip["speed_milli"] })}
          onCommit={v => setSpeed(Math.round(v * 1000))} />
        <span className="tail">0.25 – 4.0</span>
      </PRow>
      {isVideo && <div className="pp-chk">
        <input type="checkbox" checked={clip.reverse_playback ?? false} onChange={event => void onPatch([{ op: "set_reverse_playback", clip_id: clip.clip_id, reverse_playback: event.target.checked }], event.target.checked ? "开启倒放" : "关闭倒放")} />
        <span>倒放<span className="pp-subtext">（权威预览生效；音频静音）</span></span>
      </div>}
    </PGroup>
    <PNote>音频随画面同变速；当前版本倒放片段以静音占位保证轨长正确。</PNote>
  </>;

  // ---- 动画（关键帧打点，逻辑不变） ----
  const animSection = isVideo && clipRelativeUs !== undefined
    ? <PGroup title="关键帧动画" tail={<span className="pp-tailtext">播放头 {formatTime(clipRelativeUs)}</span>}>
      <div className="pp-kfrows">
        {keyframePropertyLabels.map(({ property, label }) => {
          const track = clip.keyframes?.[property];
          const hasTrack = Boolean(track);
          const t = clipRelativeUs;
          return <div className="pp-kfrow" key={property}>
            <span className="lab">{label}</span>
            <button type="button" className="pp-mini" title={hasTrack ? "在播放头处打关键帧" : "添加关键帧"}
              onClick={() => { const frames = (track?.frames ?? []).filter(f => f.t_us !== t); const seed = property === "position" ? { t_us: t, x: 0, y: 0 } : { t_us: t, v: property === "scale" ? 1 : property === "opacity" ? 1 : 0 }; setKeyframe(property, [...frames, seed].sort((a, b) => a.t_us - b.t_us)); }}>{hasTrack ? "打点" : "添加"}</button>
            {hasTrack && <button type="button" className="pp-mini" title="清除此属性全部关键帧" onClick={() => clearKeyframe(property)}>清除</button>}
            {hasTrack && <span className="cnt">{track?.frames.length} 帧</span>}
          </div>;
        })}
      </div>
      <PNote>按播放头位置打点；随片段变速等比重映射；动画仅权威预览渲染。{overlay && "覆盖轨片段的动画渲染待支持（见设计文档 §6）。"}</PNote>
    </PGroup>
    : <PGroup title="关键帧动画"><PNote>动画当前仅支持视频片段。</PNote></PGroup>;

  return <fieldset className="pp-panel locked-fieldset" aria-label="片段属性" disabled={locked}>
    {locked && <p className="locked-note"><Lock />此 Clip 已锁定，直接编辑和关联 Caption 编辑已禁用。</p>}
    <PanelTabs tabs={topTabs} active={activeTab} onChange={setTab} />
    {isAudioClip ? (
      <div className="pp-body">
        {activeTab === "basic" && audioBasics}
        {activeTab === "voice" && voiceSoon}
        {activeTab === "fx" && fxSoon}
        {activeTab === "speed" && speedSection}
      </div>
    ) : (
      <>
        {activeTab === "pic" && <>
          <SubTabs tabs={[{ id: "basic", label: "基础" }, { id: "key", label: "抠像" }, { id: "mask", label: "蒙版" }]} active={picSub} onChange={setPicSub} />
          <div className="pp-body">
            {picSub === "key" ? picKey : picSub === "mask" ? picMask : picBasic}
          </div>
        </>}
        {activeTab === "aud" && <>
          <SubTabs tabs={[{ id: "abasic", label: "基础" }, { id: "voice", label: "换音色", soon: true }, { id: "fx", label: "声音效果", soon: true }]} active={audSub} onChange={setAudSub} />
          <div className="pp-body">
            {audSub === "voice" ? voiceSoon : audSub === "fx" ? fxSoon : audioBasics}
          </div>
        </>}
        {activeTab === "speed" && <div className="pp-body">{speedSection}</div>}
        {activeTab === "anim" && <div className="pp-body">{animSection}</div>}
        {activeTab === "tools" && <div className="pp-body">
          <PGroup title="剪辑手法">
            <PNote>本地确定性规划 · 零外传。提案不自动改 Timeline，采纳后落新 Revision。</PNote>
            <div className="properties-actions" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button type="button" disabled={!onOpenEditingTools} onClick={() => onOpenEditingTools?.("remove_pauses")}>去停顿</button>
              <button type="button" disabled={!onOpenEditingTools} onClick={() => onOpenEditingTools?.("beat_sync")}>卡点</button>
              <button type="button" disabled={!onOpenEditingTools} onClick={() => onOpenEditingTools?.("lj_cut")}>L/J cut</button>
            </div>
          </PGroup>
        </div>}
      </>
    )}
    {isAudioClip && activeTab === "tools" && <div className="pp-body">
      <PGroup title="剪辑手法">
        <PNote>音频片段可先用于卡点 BGM；去停顿 / L-J 需视频片段。</PNote>
        <div className="properties-actions">
          <button type="button" disabled={!onOpenEditingTools} onClick={() => onOpenEditingTools?.("beat_sync")}>卡点</button>
        </div>
      </PGroup>
    </div>}
  </fieldset>;
}

/**
 * 文本/字幕属性面板 v2：文本（基础·气泡·花字）/ 动画（§1.3）。
 * 文本编辑、时间、样式覆盖（style_override）的 patch 语义与 v1 一致。
 */
export function CaptionProperties({ caption, working, locked, onPatch, onDraft }: { caption: TimelineCaption; working: TimelineDocument; locked: boolean; onPatch: (ops: TimelinePatchOperation[], summary: string) => Promise<void>; onDraft: (doc: TimelineDocument) => void }) {
  const updateLocal = (next: Partial<TimelineCaption>) => onDraft({ ...working, captions: working.captions.map(item => item.caption_id === caption.caption_id ? { ...item, ...next } : item) });
  const setStyle = (style: Partial<NonNullable<TimelineCaption["style_override"]>>, summary: string) => void onPatch([{ op: "set_caption_style", caption_id: caption.caption_id, style }], summary);
  const isTextMaterial = caption.origin === "user";
  const styleOverride = caption.style_override ?? {};
  const alignment = styleOverride.alignment ?? 2;
  // 对齐六宫格（剪映式）：行 = 垂直位置（底部/居中/顶部），列 = 水平位置（左/中/右）。
  const alignmentGrid: Array<Array<{ value: number; label: string }>> = [
    [{ value: 7, label: "╴" }, { value: 8, label: "▔" }, { value: 9, label: "╶" }],
    [{ value: 4, label: "╌" }, { value: 5, label: "─" }, { value: 6, label: "╌" }],
    [{ value: 1, label: "▁" }, { value: 2, label: "▁" }, { value: 3, label: "▁" }],
  ];
  const bold = styleOverride.bold ?? false;
  const italic = styleOverride.italic ?? false;
  const underline = styleOverride.underline ?? false;
  const toggleFlag = (flag: "bold" | "italic" | "underline", current: boolean, label: string) =>
    setStyle({ [flag]: !current } as Partial<NonNullable<TimelineCaption["style_override"]>>, label);
  const [tab, setTab] = useState("text");
  const [sub, setSub] = useState("basic");
  // 气泡（B4 收官）：底衬块 = border_style 3 + back_color + shadow 深度。
  const bubbleOn = (styleOverride.border_style ?? 1) === 3;
  const toggleBubble = () => {
    if (bubbleOn) setStyle({ border_style: 1 }, "关闭气泡底衬");
    else setStyle({ border_style: 3, back_color: styleOverride.back_color ?? "&H80000000" }, "开启气泡底衬");
  };
  // 花字模板（fx_preset；none=清除）。选中模板后基础色由模板控制（渲染后置覆盖）。
  const fxPresets: Array<{ id: "none" | "gold-gradient" | "neon-glow" | "sticker-outline" | "soft-shadow"; label: string; hint: string }> = [
    { id: "none", label: "无", hint: "清除花字样式" },
    { id: "gold-gradient", label: "鎏金", hint: "金橙字·深棕描边" },
    { id: "neon-glow", label: "霓虹", hint: "青色字·暖光晕" },
    { id: "sticker-outline", label: "贴纸", hint: "白字·粗黑描边" },
    { id: "soft-shadow", label: "柔影", hint: "白字·柔和投影" },
  ];
  return <fieldset className="pp-panel locked-fieldset" aria-label={isTextMaterial ? "文本属性" : "字幕属性"} disabled={locked}>
    {locked && <p className="locked-note"><Lock />关联 Clip 已锁定，此 Caption 只读。</p>}
    <PanelTabs tabs={[{ id: "text", label: "文本" }, { id: "anim", label: "动画", soon: true }]} active={tab} onChange={setTab} />
    {tab === "anim"
      ? <div className="pp-body">
        <PGroup title="入场 / 出场动画" tail={<SoonBadge />}>
          <PNote>对齐剪映：动画模板列表 + 时长。当前版本字幕无动画；后续可复用 Clip 关键帧体系。</PNote>
        </PGroup>
      </div>
      : <>
        <SubTabs tabs={[{ id: "basic", label: "基础" }, { id: "bubble", label: "气泡" }, { id: "fx", label: "花字" }]} active={sub} onChange={setSub} />
        <div className="pp-body">
          {sub === "bubble" ? <PGroup title="气泡底衬">
            <PNote>文字底衬块：底色随文本自适应。圆角气泡尾巴造型后续版本支持。</PNote>
            <PRow>
              <label className="pp-inline">开启底衬
                <input type="checkbox" checked={bubbleOn} onChange={toggleBubble} aria-label="气泡底衬开关" />
              </label>
            </PRow>
            {bubbleOn && <>
              <PRow label="底衬颜色">
                <input type="color" className="pp-color" aria-label="底衬颜色"
                  value={assToRgb(styleOverride.back_color ?? "&H80000000")}
                  onChange={event => setStyle({ back_color: rgbToAss(event.target.value) }, "底衬颜色")} />
                <PNote>半透明底衬用颜色选择器带透明度的方案暂未支持，默认半透明黑。</PNote>
              </PRow>
              <PRow label="底衬深度">
                <NumberField value={styleOverride.shadow} min={0} max={10} step={1} ariaLabel="底衬深度" placeholder="0"
                  onCommit={v => setStyle({ shadow: Math.round(v) }, `底衬深度 ${Math.round(v)}`)} />
                <span className="tail">0 – 10</span>
              </PRow>
            </>}
          </PGroup> : sub === "fx" ? <PGroup title="花字模板">
            <PNote>{styleOverride.fx_preset && styleOverride.fx_preset !== "none" ? "花字模板控制字体颜色与描边（基础 Tab 颜色控件暂被模板覆盖）。" : "选择模板即套用；「无」清除花字。"}</PNote>
            <div className="pp-presets fx-grid" role="listbox" aria-label="花字模板">
              {fxPresets.map(p => (
                <button key={p.id} type="button" className={`pp-preset fx-card${(styleOverride.fx_preset ?? "none") === p.id ? " on" : ""}`}
                  title={p.hint} aria-label={`花字 ${p.label}`} aria-pressed={(styleOverride.fx_preset ?? "none") === p.id}
                  onClick={() => setStyle({ fx_preset: p.id }, p.id === "none" ? "清除花字" : `花字 ${p.label}`)}>{p.label}</button>
              ))}
            </div>
          </PGroup> : <>
            <label className="pp-ta">文本
              <textarea value={caption.text} maxLength={200} onChange={event => updateLocal({ text: event.target.value })}
                onBlur={event => void onPatch([{ op: "update_caption", caption_id: caption.caption_id, text: event.target.value }], "修正字幕文本")} />
            </label>
            <div className="pp-airow" aria-hidden="true">
              <div className="pp-aichip">✦ 文案推荐 <b>限免</b></div>
              <div className="pp-aichip">✎ AI 写旁白 <b>深度思考</b></div>
            </div>
            <PGroup title="字体">
              <PRow label="字体">
                <input type="text" className="pp-input" list="caption-font-options" maxLength={60} placeholder="预设字体" value={styleOverride.font_name ?? ""}
                  onBlur={event => { const value = event.target.value.trim(); if (value && value !== (caption.style_override?.font_name ?? "")) setStyle({ font_name: value }, `字体 ${value}`); }} />
                <datalist id="caption-font-options">
                  <option value="Noto Sans CJK SC" />
                  <option value="LXGW WenKai" />
                  <option value="Noto Serif CJK SC" />
                </datalist>
              </PRow>
              <RangeRow label="字号" value={styleOverride.font_size ?? 72} min={24} max={144} step={1} ariaLabel="字号"
                onDraft={() => { }}
                onCommit={v => setStyle({ font_size: Math.round(v) }, `字号 ${Math.round(v)}`)} />
            </PGroup>
            <PGroup title="样式">
              <PRow>
                <span className="text-style-flags" role="group" aria-label="文字样式">
                  <button type="button" className={bold ? "pp-active" : ""} aria-pressed={bold} title="粗体" onClick={() => toggleFlag("bold", bold, bold ? "取消粗体" : "粗体")}><strong>B</strong></button>
                  <button type="button" className={italic ? "pp-active" : ""} aria-pressed={italic} title="斜体" onClick={() => toggleFlag("italic", italic, italic ? "取消斜体" : "斜体")}><em>I</em></button>
                  <button type="button" className={underline ? "pp-active" : ""} aria-pressed={underline} title="下划线" onClick={() => toggleFlag("underline", underline, underline ? "取消下划线" : "下划线")}><u>U</u></button>
                </span>
              </PRow>
              <PRow label="颜色">
                <input type="color" className="pp-color" aria-label="字体颜色" value={assToRgb(styleOverride.primary_color ?? "&H00FFFFFF")}
                  onChange={event => setStyle({ primary_color: rgbToAss(event.target.value) }, "字体颜色")} />
              </PRow>
              <PRow label="描边">
                <input type="color" className="pp-color" aria-label="描边颜色" value={assToRgb(styleOverride.outline_color ?? "&H00000000")}
                  onChange={event => setStyle({ outline_color: rgbToAss(event.target.value) }, "描边颜色")} />
                <NumberField value={styleOverride.outline} min={0} max={10} step={1} ariaLabel="描边宽度" placeholder="预设"
                  onCommit={v => setStyle({ outline: Math.round(v) }, `描边宽度 ${Math.round(v)}`)} />
                <span className="tail">0 – 10</span>
              </PRow>
              <PRow label="字间距">
                <NumberField value={styleOverride.letter_spacing} min={0} max={50} step={1} ariaLabel="字间距" placeholder="预设"
                  onCommit={v => setStyle({ letter_spacing: v }, `字间距 ${v}`)} />
                <label className="pp-inline">行间距
                  <NumberField min={0} max={50} step={1} ariaLabel="行间距（规划中）" placeholder="预设" disabled onCommit={() => {}} />
                </label>
                <SoonBadge />
              </PRow>
            </PGroup>
            <PGroup title="对齐方式">
              <span className="pp-aligngrid" role="group" aria-label="对齐方式">
                {alignmentGrid.flat().map(cell => <button key={cell.value} type="button" className={alignment === cell.value ? "pp-active" : ""} aria-pressed={alignment === cell.value} title={`对齐 ${cell.value}`} onClick={() => setStyle({ alignment: cell.value }, `对齐 ${cell.value}`)}>{cell.label}</button>)}
              </span>
            </PGroup>
            <PGroup title="预设样式" onReset={caption.style_override ? () => void onPatch([{ op: "clear_caption_style", caption_id: caption.caption_id }], "恢复预设样式") : undefined} resetTitle="恢复预设样式">
              <div className="pp-presets">
                {captionPresets.map(p => (
                  <button key={p.value} type="button" className={`pp-preset${caption.preset_id === p.value ? " on" : ""}`} title={p.label} aria-label={p.label} aria-pressed={caption.preset_id === p.value}
                    onClick={() => void onPatch([{ op: "set_caption_preset", caption_id: caption.caption_id, preset_id: p.value }], "调整字幕预设")}>T</button>
                ))}
              </div>
              <div className="pp-saverow">
                <button type="button" className="pp-btn ghost" disabled title="保存预设（规划中）">保存预设</button>
                <SoonBadge />
              </div>
            </PGroup>
            <PSep />
            <PGroup title="时间与位置">
              <PRow label="开始">
                <NumberField value={caption.start_us / 1_000_000} min={0} max={caption.end_us / 1_000_000} step={0.1} unit="s" decimals={1} ariaLabel="字幕开始"
                  onDraft={v => updateLocal({ start_us: Math.round(v * 1_000_000) })}
                  onCommit={v => void onPatch([{ op: "set_caption_timing", caption_id: caption.caption_id, start_us: Math.round(v * 1_000_000), end_us: caption.end_us }], "调整字幕时间")} />
              </PRow>
              <PRow label="结束">
                <NumberField value={caption.end_us / 1_000_000} min={caption.start_us / 1_000_000} max={36_000} step={0.1} unit="s" decimals={1} ariaLabel="字幕结束"
                  onDraft={v => updateLocal({ end_us: Math.round(v * 1_000_000) })}
                  onCommit={v => void onPatch([{ op: "set_caption_timing", caption_id: caption.caption_id, start_us: caption.start_us, end_us: Math.round(v * 1_000_000) }], "调整字幕时间")} />
              </PRow>
              <PRow label="底边距">
                <NumberField value={styleOverride.margin_v} min={0} max={500} step={1} ariaLabel="字幕底边距" placeholder="预设"
                  onCommit={v => setStyle({ margin_v: Math.round(v) }, `字幕底边距 ${Math.round(v)}`)} />
                <span className="tail">PlayRes 1080 基准 px</span>
              </PRow>
            </PGroup>
            <PNote>仅内置字体（Noto Sans CJK SC）；样式仅覆盖所选字幕，预设其余字段保持不变。</PNote>
          </>}
        </div>
      </>}
  </fieldset>;
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

/** 差异类型标记：按类型着色（+青 −红 ~琥珀，样式见 styles.css 万兴喵影弹窗层）。 */
function DiffType({ t }: { t: string }) {
  return <span className={`diff-${t}`}>{t}</span>;
}

export function TimelineDiffView({ diff }: { diff: TimelineDiff }) {
  return <div className="diff-groups"><section><h4>概览</h4><p>Clip {diff.summary.clip_changes} · Caption {diff.summary.caption_changes} · 锁定 {diff.summary.lock_changes} · 时长 {formatTime(diff.duration_delta_us)}</p></section><section><h4>Clip</h4>{diff.clip_changes.length ? diff.clip_changes.map((item, index) => <p key={`${item.clip_id}-${item.type}-${index}`}><DiffType t={item.type} /> · {item.clip_id}{item.created_clip_ids ? ` -> ${item.created_clip_ids.join(", ")}` : ""}</p>) : <p>无变化</p>}</section><section><h4>Caption</h4>{diff.caption_changes.length ? diff.caption_changes.map((item, index) => <p key={`${item.caption_id}-${item.type}-${index}`}><DiffType t={item.type} /> · {item.caption_id}</p>) : <p>无变化</p>}</section><section><h4>锁定</h4>{diff.lock_changes.length ? diff.lock_changes.map((item, index) => <p key={`${item.clip_id}-${item.type}-${index}`}><DiffType t={item.type} /> · {item.clip_id}</p>) : <p>无变化</p>}</section><section><h4>锁定 Clip 间接平移</h4>{diff.indirect_locked_timing_shifts.length ? diff.indirect_locked_timing_shifts.map(item => <p key={item.clip_id}><span className="diff-moved">~ shifted</span> · {item.clip_id} · {formatTime(item.from_start_us)}-{formatTime(item.from_end_us)} {"->"} {formatTime(item.to_start_us)}-{formatTime(item.to_end_us)}</p>) : <p>无变化</p>}</section></div>;
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
