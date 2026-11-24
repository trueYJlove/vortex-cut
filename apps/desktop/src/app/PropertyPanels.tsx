import { useState } from "react";
import { Archive, FileText, Lock, RotateCcw, Save } from "lucide-react";
import type { CaptionPresetId, EditingGrammarPrepareResult, EditingGrammarProposal, Project, TimelineCaption, TimelineClip, TimelineDiff, TimelineDocument, TimelineLayout, TimelinePatchOperation, TimelineState, TimelineTransition } from "@aivideo/contracts";
import type { AuthoritativePreviewPresentation } from "../../electron/preload/index.js";
import { PanelTabs, SubTabs, PGroup, PSep, PRow, Switch, Seg, SoonBadge, PNote, NumberField, RangeRow } from "./PropertyControls.js";
import { AlignBar, type AlignEdge } from "../ui/of/AlignBar.js";
import type { FrameBounds, GroupBoundsField } from "./timeline/frame-alignment.js";
import { MenuSelect } from "../ui/of/MenuSelect.js";
import { InspectorWorkspace, InspectorReadOnly } from "../ui/of/InspectorWorkspace.js";
import type { InspectorKind } from "../ui/of/inspector-sections.js";
import { Section, NumField } from "../ui/of/inspector-fields.js";
import { errorCode } from "./safeErrors.js";
import { planMagneticSpeed, readTimelineBehaviorPrefs } from "./timeline/magnetic-plan.js";

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

const speedPresets = [100, 1000, 2000, 5000, 10000, 100000];
const speedLabel = (speed: number) => `${Number((speed / 1000).toPrecision(3))}×`;

/**
 * set_audio 的淡变字段：set_audio 是「整段覆盖」操作，未带的字段保留旧值——
 * 但用户在滑块上把值改回 0 时必须**显式写 0**（Core 归一为清除键），否则
 * 保留旧值会让"拖回 0 秒"看起来没反应。
 */
function audioFadeOf(clip: TimelineClip, field: "fade_in_us" | "fade_out_us", seconds: number): Partial<Record<"fade_in_us" | "fade_out_us", number>> {
  const us = Math.max(0, Math.round(seconds * 1_000_000));
  const other = field === "fade_in_us" ? "fade_out_us" : "fade_in_us";
  const carried = clip.audio[other];
  return { [field]: us, ...(carried === undefined ? {} : { [other]: carried }) };
}

const keyframePropertyLabels: Array<{ property: "position" | "scale" | "rotate" | "opacity"; label: string }> = [
  { property: "position", label: "位置" },
  { property: "scale", label: "缩放" },
  { property: "rotate", label: "旋转" },
  { property: "opacity", label: "透明度" },
];

/**
 * 片段属性面板 v2：按 docs/design/ui-mockups/property-panel/DESIGN.md §1.1 信息架构分页签。
 * 视频/图片：画面（基础·抠像·蒙版）/ 音频 / 变速（含倒放）/ 动画；音频素材：基础 / 换音色 / 声音效果 / 变速。
 * 仅重组 UI，patch 操作与字段语义与 v1 完全一致；「规划中」为静态占位。
 */
/** 一键统一音量（E8）的 UI 状态机：预览 → 提案 → 显式采纳。 */
type UnifyLoudnessState =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "prepared"; preview: EditingGrammarPrepareResult }
  | { phase: "proposing"; preview: EditingGrammarPrepareResult }
  | { phase: "proposed"; proposal: EditingGrammarProposal }
  | { phase: "applying"; proposal: EditingGrammarProposal }
  | { phase: "applied"; revisionId: string }
  | { phase: "error"; message: string };

/** 规划器失败的业务码 → 可操作提示（不吞掉原因，也不一律「操作失败」）。 */
const LOUDNESS_FAILURE_LABELS: Record<string, string> = {
  EDITING_GRAMMAR_BASE_CONFLICT: "时间线已变化，请重新打开属性面板后重试。",
  EDITING_GRAMMAR_PARAMS_INVALID: "响度归一参数不合法，请重新选择片段。",
  EDITING_GRAMMAR_PLANNER_NOT_FOUND: "响度归一步骤不存在，请重启应用后重试。",
  EDITING_GRAMMAR_PROPOSAL_APPLIED: "该提案已应用过，请重新发起。",
  EDITING_GRAMMAR_PROPOSAL_CONFLICT: "提案与当前时间线不一致，请重新发起。",
};

function loudnessErrorText(caught: unknown): string {
  const code = errorCode(caught);
  if (LOUDNESS_FAILURE_LABELS[code]) return LOUDNESS_FAILURE_LABELS[code];
  const raw = caught instanceof Error ? caught.message : "";
  return raw ? `响度归一失败：${raw.slice(0, 160)}` : "响度归一失败，请重试。";
}

const loudnessBusy = (state: UnifyLoudnessState) =>
  state.phase === "preparing" || state.phase === "proposing" || state.phase === "applying";

function loudnessStatusText(state: UnifyLoudnessState): string {
  switch (state.phase) {
    case "preparing": return "测量中…";
    case "prepared": return "已测量";
    case "proposing": return "生成提案…";
    case "proposed": return "待采纳";
    case "applying": return "应用中…";
    case "applied": return "已应用";
    case "error": return "失败";
    default: return "";
  }
}

function loudnessButtonTitle(state: UnifyLoudnessState, ready: boolean): string {
  if (!ready) return "时间线尚未就绪";
  if (loudnessBusy(state)) return "正在处理…";
  if (state.phase === "prepared") return "生成提案（采纳后才写时间线）";
  return "测量本片段响度并生成统一音量提案";
}

/** rationale 里的实测值/目标值：只读展示，缺失时如实标注。 */
function loudnessMeasured(preview: EditingGrammarPrepareResult): string {
  const clips = preview.rationale.clips;
  const list = Array.isArray(clips) ? clips as Array<Record<string, unknown>> : [];
  const values = list.map(item => item.measured_lufs).filter((value): value is number => typeof value === "number");
  return values.length ? values.map(value => value.toFixed(1)).join(" / ") : "无法测量";
}

function loudnessTarget(preview: EditingGrammarPrepareResult): string {
  const params = preview.rationale.params;
  const target = params && typeof params === "object" ? (params as Record<string, unknown>).target_lufs : undefined;
  return typeof target === "number" ? target.toFixed(0) : "—";
}

export function ClipProperties({ clip, clipName, working, baseRevisionId, locked, onAlign, alignmentHint, onPatch, onDraft, playheadUs, onOpenEditingTools, onAppliedTimeline }: { clip: TimelineClip; clipName?: string; working: TimelineDocument; baseRevisionId?: string | null; locked: boolean; onAlign?: (edge: AlignEdge) => void; alignmentHint?: string; onPatch: (ops: TimelinePatchOperation[], summary: string) => Promise<void>; onDraft: (doc: TimelineDocument) => void; playheadUs?: number; onOpenEditingTools?: (tool: "remove_pauses" | "beat_sync" | "lj_cut") => void; onAppliedTimeline?: (state: TimelineState) => void }) {
  const isVideo = clip.asset_kind === "video";
  const isImage = clip.asset_kind === "image";
  const isAudioClip = clip.asset_kind === "audio";
  // P231 Q2：统一盒模型后全视觉轨同语义（mask/keying/动画全段生效），
  // overlay 门控已无意义——恒 false（保留变量以免下游 JSX 大改）。
  const overlay = false;
  const updateLocal = (next: Partial<TimelineClip>) => onDraft({ ...working, clips: working.clips.map(item => item.clip_id === clip.clip_id ? { ...item, ...next } : item) });
  const speed = clip.speed_milli ?? 1000;
  const setSpeed = (value: number) => {
    const prefs = readTimelineBehaviorPrefs();
    const plan = planMagneticSpeed(working, clip, value, prefs.mainTrackMagnet, prefs.linkageEnabled);
    const operations = plan.operations.length ? plan.operations : [{ op: "set_speed" as const, clip_id: clip.clip_id, speed_milli: value, ripple: false }];
    void onPatch(operations, value === 1000 ? "恢复原速" : `调整速度 ${speedLabel(value)}`);
  };
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

  // 等比缩放：可点开关（原型交互）。当前版本缩放恒为等比，开关仅承载视觉状态。
  const [ratioOn, setRatioOn] = useState(true);
  const RatioSwitch = () => <Switch on={ratioOn} onToggle={() => setRatioOn(v => !v)} title="当前版本仅支持等比缩放" />;

  // ---- E8 响度统一：干跑 → 提案 → 显式采纳（三段式，绝不直接改文档） ----
  // 实测由 Core 的随包 ffmpeg（EBU R128）现测；面板只发起请求与呈现象。
  const [loudness, setLoudness] = useState<UnifyLoudnessState>({ phase: "idle" });
  const runLoudnessPrepare = () => {
    if (!baseRevisionId) { setLoudness({ phase: "error", message: "时间线尚未就绪，请稍后重试。" }); return; }
    setLoudness({ phase: "preparing" });
    void window.desktop.prepareEditingGrammar({ project_id: working.project_id, base_revision_id: baseRevisionId as never, planner: "unify_loudness", params: { clip_ids: [clip.clip_id] } })
      .then(preview => { setLoudness({ phase: "prepared", preview }); })
      .catch(caught => { setLoudness({ phase: "error", message: loudnessErrorText(caught) }); });
  };
  const runLoudnessPropose = () => {
    if (loudness.phase !== "prepared" || !baseRevisionId) return;
    const preview = loudness.preview;
    setLoudness({ phase: "proposing", preview });
    void window.desktop.proposeEditingGrammar({ project_id: working.project_id, base_revision_id: baseRevisionId as never, planner: "unify_loudness", params: preview.params })
      .then(proposal => { setLoudness({ phase: "proposed", proposal }); })
      .catch(caught => { setLoudness({ phase: "error", message: loudnessErrorText(caught) }); });
  };
  const runLoudnessApply = () => {
    if (loudness.phase !== "proposed") return;
    const proposal = loudness.proposal;
    setLoudness({ phase: "applying", proposal });
    void window.desktop.applyEditingGrammarProposal({ project_id: working.project_id, proposal_id: proposal.editing_grammar_proposal_id, base_revision_id: proposal.base_revision_id, proposed_document_sha256: proposal.proposed_document_sha256 })
      .then(state => { setLoudness({ phase: "applied", revisionId: state.current_revision.timeline_revision_id }); onAppliedTimeline?.(state); })
      .catch(caught => { setLoudness({ phase: "error", message: loudnessErrorText(caught) }); });
  };

  // ---- 画面 → 基础 ----
  /* 「位置与大小」按参照 FilmInspector.tsx:2378 的结构重排：
     对齐条 → X/Y 一行 → W/H + 锁一行 → 旋转一行。
     原来我们把「缩放」放成滑杆、没有对齐条、没有 W/H、没有锁——第一屏就看得出结构不同。
     参照的 W/H 是舞台像素，我们目前只有 scale，故 W/H 用「相对舞台的百分比」
     表达同一件事，并在 aria-label 上写明，避免假装是像素。
     教训：`//` 与 `/* *\/` 都不能直接写在 JSX 表达式容器里——会被当成文本渲染。
     注释要么放在 JSX 外面（像这里），要么用 {`{/* ... *\/}`} 包起来。 */
  /* 「外观」独立成组（参照 inspector-look.tsx:625 appearance = 不透明度 + 圆角 + 混合模式）。
     原来不透明度混在「位置与大小」里，与参照的分组归属不同。
     圆角与混合模式我们暂无 patch 通道（Core 没有对应操作），故本组只放不透明度，
     不摆改不动的控件——与「裁剪与填充」的处理一致。 */
  /* 「淡入淡出」独立成组（参照 inspector-look.tsx:1106 把它做成效果组里的独立段落）：
     两个并排数值框 grid-cols-2，不是两条滑杆。原来它混在「音频」分组里、以两条滑杆出现，
     与参照的分组归属和控件形态都不同。 */
  /* 「裁剪与填充」按参照 inspector-look.tsx:142 的段落结构：
     段控（适应 / 填充 / 拉伸）→ 四边数值 → 比例芯片。
     我们是「完整适配 / 裁切填满 / 模糊背景」三选一（我们的布局语义，比参照多一档模糊背景）。
     四边裁切与比例芯片我们还没有对应的数据（Core 没有 crop 四边与 clip-path 的 patch 操作），
     故这一段只做段控 + 分组标题与重置入口——**不摆不能改的假控件**，比摆出来更不容易误导。 */
  /* I1：原 picBasic 的 PGroup 壳上移为 Section（骨架处），此处只保留分组内层。 */
  const picBasicInner = <>
    {!isAudioClip && <AlignBar onAlign={locked ? undefined : onAlign} />}
    {!isAudioClip && alignmentHint && <PNote>{alignmentHint}</PNote>}
    <div className="pp-grid2">
      <NumberField value={Math.round((fixedTf.x - 0.5) * 200)} min={-100} max={100} step={1} ariaLabel="位置 X" mark="X"
        onDraft={v => updateLocal({ transform: { ...clip.transform, x: 0.5 + v / 200 } })}
        onCommit={v => setTransform({ x: 0.5 + v / 200 }, "调整画中画水平位置")} />
      <NumberField value={Math.round((fixedTf.y - 0.5) * 200)} min={-100} max={100} step={1} ariaLabel="位置 Y" mark="Y"
        onDraft={v => updateLocal({ transform: { ...clip.transform, y: 0.5 + v / 200 } })}
        onCommit={v => setTransform({ y: 0.5 + v / 200 }, "调整画中画垂直位置")} />
    </div>
    <div className="pp-grid2-lock">
      <NumberField value={Math.round(fixedTf.scale * 100)} min={5} max={500} step={1} unit="%" ariaLabel="宽度（相对舞台）" mark="W"
        onDraft={v => updateLocal({ transform: { ...clip.transform, scale: v / 100 } })}
        onCommit={v => setTransform({ scale: v / 100 }, `调整画面宽度 ${Math.round(v)}%`)} />
      <NumberField value={Math.round(fixedTf.scale * 100)} min={5} max={500} step={1} unit="%" ariaLabel="高度（相对舞台）" mark="H"
        onDraft={v => updateLocal({ transform: { ...clip.transform, scale: v / 100 } })}
        onCommit={v => setTransform({ scale: v / 100 }, `调整画面高度 ${Math.round(v)}%`)} />
      <RatioSwitch />
    </div>
    <div className="pp-grid2">
      <NumberField value={fixedTf.rotate} min={-180} max={180} step={1} unit="°" decimals={2} ariaLabel="旋转" mark="∠"
        onDraft={v => updateLocal({ transform: { ...clip.transform, rotate: v } })}
        onCommit={v => setTransform({ rotate: v }, "调整画中画旋转")} />
      <span />
    </div>
    {isImage && <>
      <div className="pp-row">
        <label>图片时长</label>
        <span className="pp-num">
          <NumberField value={(clip.timeline_end_us - clip.timeline_start_us) / 1_000_000} min={0.5} max={30} step={0.5} unit="s" decimals={1} ariaLabel="图片时长" mark="⏱"
            onDraft={v => updateLocal({ timeline_end_us: clip.timeline_start_us + Math.round(v * 1_000_000) })}
            onCommit={v => void onPatch([{ op: "set_image_duration", clip_id: clip.clip_id, duration_us: Math.round(v * 1_000_000) }], "调整图片时长")} />
        </span>
      </div>
    </>}
  </>;
  /* I6 参照 inspector-look.tsx:638-646：外观组 = 不透明度 + 圆角 + 混合模式。
     圆角/混合模式暂无 patch 通道——按参照形态摆 disabled 控件（AlignBar disabled 先例），版面完整但不误导。 */
  const picAppearance = <>
    <RangeRow label="不透明度" value={fixedTf.opacity * 100} min={0} max={100} step={1} unit="%" decimals={0} w66
      onDraft={v => updateLocal({ transform: { ...clip.transform, opacity: v / 100 } })}
      onCommit={v => setTransform({ opacity: v / 100 }, "调整画中画不透明度")} />
    <div className="pp-row">
      <label>圆角</label>
      <span className="pp-num"><NumberField min={0} max={0} placeholder="规划中" ariaLabel="圆角（规划中）" disabled onCommit={() => {}} /></span>
    </div>
    <div className="pp-row">
      <label>混合模式</label>
      <span className="pp-num"><NumberField min={0} max={0} placeholder="规划中" ariaLabel="混合模式（规划中）" disabled onCommit={() => {}} /></span>
    </div>
  </>;
  const morePicture = <>
    <PRow label="变形" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
    <PRow label="视频防抖" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
    <PRow label="画质增强" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
  </>;
  const picCropFill = <Seg value={clip.layout}
    options={[{ value: "fit", label: "完整适配" }, { value: "crop_fill", label: "裁切填满" }, { value: "blurred_background", label: "模糊背景" }]}
    onChange={v => void onPatch([{ op: "set_layout", clip_id: clip.clip_id, layout: v as TimelineLayout }], "调整布局")} />;

  // ---- 画面 → 抠像 ----
  const picKey = <>
    {/* P231：抠像全视觉轨生效（统一盒模型），警告文案已移除。 */}
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
    {/* P231：蒙版全视觉轨生效（统一盒模型），警告文案已移除。 */}
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
            <NumberField value={clip.mask.rotation ?? 0} min={-180} max={180} step={1} unit="°" decimals={0} ariaLabel="蒙版方向" mark="∠"
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
            <NumberField value={clip.mask.rotation ?? 0} min={-180} max={180} step={1} unit="°" decimals={0} ariaLabel="蒙版旋转" mark="∠"
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

  /* ---- 声音组（I1：PGroup 壳上移为 Section；I9：淡入淡出 max 随片段时长、step=1/fps） ---- */
  const fadeMaxS = (clip.timeline_end_us - clip.timeline_start_us) / 1_000_000;
  const fadeStep = (() => { const f = working.canvas.fps_num && working.canvas.fps_den ? working.canvas.fps_num / working.canvas.fps_den : 30; return 1 / Math.max(1, Math.min(120, f)); })();
  const audioFadeSection = <>
    <div className="pp-grid2">
      <NumberField value={(clip.audio.fade_in_us ?? 0) / 1_000_000} min={0} max={fadeMaxS} step={fadeStep} unit="s" decimals={2} ariaLabel="淡入时长" mark="入"
        onDraft={v => updateLocal({ audio: { ...clip.audio, fade_in_us: Math.round(v * 1_000_000) } })}
        onCommit={v => void onPatch([{ op: "set_audio", clip_id: clip.clip_id, enabled: clip.audio.enabled, gain_db: clip.audio.gain_db, ...audioFadeOf(clip, "fade_in_us", v) }], "调整淡入时长")} />
      <NumberField value={(clip.audio.fade_out_us ?? 0) / 1_000_000} min={0} max={fadeMaxS} step={fadeStep} unit="s" decimals={2} ariaLabel="淡出时长" mark="出"
        onDraft={v => updateLocal({ audio: { ...clip.audio, fade_out_us: Math.round(v * 1_000_000) } })}
        onCommit={v => void onPatch([{ op: "set_audio", clip_id: clip.clip_id, enabled: clip.audio.enabled, gain_db: clip.audio.gain_db, ...audioFadeOf(clip, "fade_out_us", v) }], "调整淡出时长")} />
    </div>
    <PNote>时长上限为片段时长；步长按画布帧率对齐（1/fps）。</PNote>
  </>;
  /* ---- 时间组（I2 参照 FilmInspector.tsx:1594-1741 TimingSection + SpeedField）：
     开始/入点/时长 + 倍速 + 倒放。开始=position_clip（timeline_start_us，真实通道）；
     入点/出点=trim_clip（源端点）；时长无直接 op（trim 源端点间接改变）→只读展示；
     倍速按 OpenFilm 支持 0.1–100×；数据仍以 milli-speed 精确到 0.001×。 ---- */
  const timingSection = <>
    <div className="pp-grid2">
      <NumberField value={clip.timeline_start_us / 1_000_000} min={0} max={36_000} step={0.1} unit="s" decimals={2} ariaLabel="开始时刻" mark="始"
        onDraft={v => updateLocal({ timeline_start_us: Math.max(0, Math.round(v * 1_000_000)) })}
        onCommit={v => void onPatch([{ op: "position_clip", clip_id: clip.clip_id, timeline_start_us: Math.max(0, Math.round(v * 1_000_000)) }], "调整开始时刻")} />
      <NumberField value={(clip.timeline_end_us - clip.timeline_start_us) / 1_000_000} min={0} max={36_000} step={0.1} unit="s" decimals={2} ariaLabel="时长（只读）" mark="长" disabled onCommit={() => {}} />
    </div>
    <div className="pp-grid2">
      <NumberField value={clip.source_start_us! / 1_000_000} min={0} max={clip.source_end_us! / 1_000_000} step={0.1} unit="s" decimals={2} ariaLabel="入点（源起点）" mark="入"
        onDraft={v => updateLocal({ source_start_us: Math.round(v * 1_000_000) })}
        onCommit={v => void onPatch([{ op: "trim_clip", clip_id: clip.clip_id, source_start_us: Math.round(v * 1_000_000), source_end_us: clip.source_end_us! }], "微调片段起点")} />
      <NumberField value={clip.source_end_us! / 1_000_000} min={clip.source_start_us! / 1_000_000} max={36_000} step={0.1} unit="s" decimals={2} ariaLabel="出点（源终点）" mark="出"
        onDraft={v => updateLocal({ source_end_us: Math.round(v * 1_000_000) })}
        onCommit={v => void onPatch([{ op: "trim_clip", clip_id: clip.clip_id, source_start_us: clip.source_start_us!, source_end_us: Math.round(v * 1_000_000) }], "微调片段终点")} />
    </div>
    <Seg value={String(speed)} columns={4} options={speedPresets.map(p => ({ value: String(p), label: speedLabel(p) }))}
      onChange={v => setSpeed(Number(v))} />
    <PRow label="自定义">
      <NumberField value={speed / 1000} min={0.1} max={100} step={0.001} decimals={3} ariaLabel="自定义倍速"
        onDraft={v => updateLocal({ speed_milli: Math.round(v * 1000) as TimelineClip["speed_milli"] })}
        onCommit={v => setSpeed(Math.round(v * 1000))} />
      <span className="tail">0.1 – 100</span>
    </PRow>
    {isVideo && <div className="pp-chk">
      <input type="checkbox" checked={clip.reverse_playback ?? false} onChange={event => void onPatch([{ op: "set_reverse_playback", clip_id: clip.clip_id, reverse_playback: event.target.checked }], event.target.checked ? "开启倒放" : "关闭倒放")} />
      <span>倒放<span className="pp-subtext">（权威预览生效；音频静音）</span></span>
    </div>}
    <PNote>音频随画面同变速；当前版本倒放片段以静音占位保证轨长正确。时长由入点/出点间接决定，此处只读。</PNote>
  </>;
  const audioBasics = <>
    <PRow label="启用音频">
      <Switch on={clip.audio.enabled} title={clip.audio.enabled ? "关闭音频" : "启用音频"}
        onToggle={() => void onPatch([{ op: "set_audio", clip_id: clip.clip_id, enabled: !clip.audio.enabled, gain_db: clip.audio.gain_db }], clip.audio.enabled ? "关闭音频" : "启用音频")} />
    </PRow>
    <RangeRow label="音量" value={clip.audio.gain_db} min={-60} max={12} step={0.5} unit="dB" decimals={1} ariaLabel="音频增益"
      onDraft={v => updateLocal({ audio: { ...clip.audio, gain_db: v } })}
      onCommit={v => void onPatch([{ op: "set_audio", clip_id: clip.clip_id, enabled: clip.audio.enabled, gain_db: v }], "调整音频增益")} />
    <PRow label="响度统一" tail={<span className="pp-tailtext">{loudnessStatusText(loudness)}</span>}>
      <Switch on={loudness.phase === "prepared" || loudness.phase === "proposed" || loudness.phase === "applying"}
        disabled={loudnessBusy(loudness) || !baseRevisionId}
        title={loudnessButtonTitle(loudness, Boolean(baseRevisionId))}
        onToggle={() => { if (loudness.phase === "prepared") runLoudnessPropose(); else { setLoudness({ phase: "idle" }); runLoudnessPrepare(); } }} />
    </PRow>
    {loudness.phase === "prepared" && loudness.preview && <div className="pp-loudness" data-testid="pp-loudness-preview">
      <p className="pp-loudness-line">{loudness.preview.summary}</p>
      <p className="pp-loudness-line">实测 {loudnessMeasured(loudness.preview)} → 目标 {loudnessTarget(loudness.preview)} LUFS</p>
      <button type="button" className="pp-btn" onClick={runLoudnessPropose}>生成提案</button>
    </div>}
    {loudness.phase === "proposed" && loudness.proposal && <div className="pp-loudness" data-testid="pp-loudness-proposal">
      <p className="pp-loudness-line">{loudness.proposal.patch.summary}</p>
      <p className="pp-loudness-line">待采纳 {loudness.proposal.patch.operations.length} 项改动</p>
      <button type="button" className="pp-btn" onClick={runLoudnessApply}>应用提案</button>
    </div>}
    {loudness.phase === "applying" && <PNote>正在应用提案…</PNote>}
    {loudness.phase === "applied" && <PNote>已应用为新的正式 Revision（{loudness.revisionId.slice(0, 12)}…）。</PNote>}
    {loudness.phase === "error" && <PNote warn>{loudness.message}</PNote>}
  </>;

  const voiceSoon = <>
    <PNote>变声 / 音色模板，布局对齐剪映（音色列表 + 参数）。当前版本未实现，仅占位。</PNote>
  </>;

  const fxSoon = <>
    <PRow label="音频降噪" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
    <PRow label="人声美化" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
    <PRow label="声音分离" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
    <PRow label="变调" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
    <PRow label="立体声平衡" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
    <PRow label="声道配置" dim><Switch on={false} onToggle={() => {}} disabled /><SoonBadge /></PRow>
  </>;

  /* 剪辑手法（ours 独有，I1：落「高级」分类；原「手法」页签整组迁来，功能不减） */
  const toolsSection = <>
    <PNote>本地确定性规划 · 零外传。提案不自动改 Timeline，采纳后落新 Revision。</PNote>
    <div className="properties-actions" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button type="button" disabled={!onOpenEditingTools} onClick={() => onOpenEditingTools?.("remove_pauses")}>去停顿</button>
      <button type="button" disabled={!onOpenEditingTools} onClick={() => onOpenEditingTools?.("beat_sync")}>卡点</button>
      {isVideo && <button type="button" disabled={!onOpenEditingTools} onClick={() => onOpenEditingTools?.("lj_cut")}>L/J cut</button>}
      {!isVideo && <PNote>音频片段可先用于卡点 BGM；去停顿 / L-J 需视频片段。</PNote>}
    </div>
  </>;

  /* ---- 动画（关键帧打点，逻辑不变；I1 壳上移为 Section） ---- */
  const animSection = isVideo && clipRelativeUs !== undefined
    ? <>
      <span className="pp-tailtext">播放头 {formatTime(clipRelativeUs)}</span>
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
      <PNote>按播放头位置打点；随片段变速等比重映射；动画全视觉轨生效（P231 统一盒模型）。</PNote>
    </>
    : <PNote>动画当前仅支持视频片段。</PNote>;

  /* I1 IA 重构（参照 FilmInspector/InspectorWorkspace）：双级固定页签 → 单条分类条 + 分组垂直流。
     分类条由 Section 注册动态派生（inspector-sections.ts 的 categories 映射）；
     「属性」页默认选中并承载 位置→淡入淡出→裁剪→时间 的垂直流（参照次序 FilmInspector.tsx:1475-1525）；
     ours 独有组（更多画面能力/剪辑手法/换音色/声音效果）落「高级」页签——功能一项不删。
     InspectorReadOnly 提供锁定语义（导航仍可用，控件禁用），替换原 fieldset disabled。 */
  const kind: InspectorKind = isAudioClip ? "audio" : isImage ? "image" : "video";
  return <fieldset className="pp-panel locked-fieldset" aria-label="片段属性">
    <InspectorReadOnly.Provider value={locked}>
      <InspectorWorkspace kind={kind} label="片段属性">
        {clipName && <Section id="clip-overview" title="属性"><PNote>{clipName}</PNote></Section>}
        <Section id="transform" title="位置与大小" aside={<button type="button" className="pp-mini" title="重置画面变换" onClick={() => void onPatch([{ op: "set_clip_transform", clip_id: clip.clip_id, transform: {} }], "重置画面变换")}><RotateCcw size={11} /></button>}>
          {picBasicInner}
        </Section>
        <Section id="fade" title="淡入淡出">{audioFadeSection}</Section>
        {!isAudioClip && <Section id="crop-fill" title="裁剪与填充" aside={<button type="button" className="pp-mini" title="重置裁剪与填充" onClick={() => void onPatch([{ op: "set_layout", clip_id: clip.clip_id, layout: "fit" as TimelineLayout }], "重置裁剪与填充")}><RotateCcw size={11} /></button>}>{picCropFill}</Section>}
        {!isAudioClip && <Section id="appearance" title="外观">{picAppearance}</Section>}
        {!isAudioClip && <Section id="mask" title="蒙版">{picMask}</Section>}
        {!isAudioClip && <Section id="keying" title="抠像">{picKey}</Section>}
        <Section id="timing" title="时间">{timingSection}</Section>
        <Section id="sound" title="声音">{audioBasics}</Section>
        <Section id="motion" title="关键帧动画">{animSection}</Section>
        <Section id="more-picture" title="更多画面能力" closedByDefault>{morePicture}</Section>
        <Section id="voice" title="换音色" closedByDefault>{voiceSoon}</Section>
        <Section id="sound-fx" title="声音效果" closedByDefault>{fxSoon}</Section>
        <Section id="tools" title="剪辑手法" closedByDefault>{toolsSection}</Section>
      </InspectorWorkspace>
    </InspectorReadOnly.Provider>
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
  /* I4 参照 FilmPanel（FilmInspector.tsx:418-535）：未选中素材时属性栏 = 影片面板（舞台信息/影片信息/空态）。
     ours 的项目操作三按钮是真实工作流入口——保留为底部「项目操作」Section，形态走参照按钮。 */
  const filmInfo = project
    ? <>
      <div className="pp-row"><label>项目名称</label><span className="pp-tailtext">{project.name}</span></div>
      <div className="pp-row"><label>画布</label><span className="pp-tailtext">{project.canvas.width}×{project.canvas.height} · {project.canvas.fps_num}fps</span></div>
      <div className="pp-row"><label>保存状态</label><span className="pp-tailtext">{saveState}</span></div>
      <div className="pp-row"><label>权威预览</label><span className="pp-tailtext">{authoritativePreview ? (previewIsStale ? "已过期" : "已就绪") : "尚未生成"}</span></div>
    </>
    : <PNote>未选择项目。</PNote>;
  return <div className="pp-panel"><InspectorWorkspace kind="film" label="项目属性">
    <Section id="film-panel-info" title="影片信息" bare>{filmInfo}</Section>
    <Section id="project-actions" title="项目操作">
      <div className="properties-actions">
        <button type="button" className="pp-btn" disabled={Boolean(renderDisabledReason)} title={renderDisabledReason} onClick={onGeneratePreview}>生成权威预览</button>
        <button type="button" className="pp-btn" disabled={Boolean(renderDisabledReason)} title={renderDisabledReason} onClick={onCreateExport}>导出正式视频</button>
        <button type="button" className="pp-btn" onClick={onOpenProjectDialog}>打开项目管理</button>
      </div>
    </Section>
  </InspectorWorkspace></div>;
}

export function AssetSelectionProperties({ entries }: {
  entries: { id: string; name: string; kind: string; meta: string; duration: string; status: string }[];
}) {
  const asset = entries.length === 1 ? entries[0] : null;
  return <div className="pp-panel">
    <InspectorWorkspace kind={asset ? "layer" : "multiple"} label="素材属性">
      <Section id="asset-information" title={asset ? "素材信息" : `已选 ${entries.length} 项素材`}>
        {asset ? <>
          <PNote>{asset.name}</PNote>
          <PRow label="类型"><span className="pp-tailtext">{asset.kind}</span></PRow>
          <PRow label="媒体信息"><span className="pp-tailtext">{asset.meta}</span></PRow>
          <PRow label="时长"><span className="pp-tailtext">{asset.duration}</span></PRow>
          <PRow label="状态"><span className="pp-tailtext">{asset.status}</span></PRow>
        </> : <ul className="inspector-picked-assets">{entries.map(item => <li key={item.id} title={item.name}>{item.name}</li>)}</ul>}
      </Section>
    </InspectorWorkspace>
  </div>;
}

export function ClipGroupAlignmentProperties({
  count, onAlign, onDistribute, distributionDisabled = false, hint, groupBounds, onEditBounds,
}: {
  count: number;
  onAlign?: (edge: AlignEdge) => void;
  onDistribute?: (axis: "horizontal" | "vertical") => void;
  distributionDisabled?: boolean;
  hint?: string;
  groupBounds?: FrameBounds & { canvasWidth: number; canvasHeight: number };
  onEditBounds: (field: GroupBoundsField, value: number) => void;
}) {
  return <div className="pp-panel">
    <InspectorWorkspace kind="multiple" label="多片段属性">
      <Section id="group-position" title="位置与大小">
        <PNote>已选 {count} 个片段</PNote>
        <AlignBar onAlign={onAlign} onDistribute={count >= 3 ? onDistribute : undefined} distributionDisabled={distributionDisabled} />
        {groupBounds && <>
          <div className="pp-grid2">
            <NumField label="选区 X" prefix="X" unit="px" value={groupBounds.left} ctx={{ percent: groupBounds.canvasWidth }}
              onCommit={value => onEditBounds("x", value)} />
            <NumField label="选区 Y" prefix="Y" unit="px" value={groupBounds.top} ctx={{ percent: groupBounds.canvasHeight }}
              onCommit={value => onEditBounds("y", value)} />
          </div>
          <div className="pp-grid2-lock">
            <NumField label="选区宽度" prefix="W" unit="px" value={groupBounds.width} min={1} ctx={{ percent: groupBounds.canvasWidth }}
              onCommit={value => onEditBounds("width", value)} />
            <NumField label="选区高度" prefix="H" unit="px" value={groupBounds.height} min={1} ctx={{ percent: groupBounds.canvasHeight }}
              onCommit={value => onEditBounds("height", value)} />
            <span title="选区宽高等比缩放" aria-label="选区宽高等比缩放" role="img"><Lock size={13} aria-hidden="true" /></span>
          </div>
        </>}
        {hint && <PNote>{hint}</PNote>}
      </Section>
    </InspectorWorkspace>
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
  // I5 参照 TransitionPanel（FilmInspector.tsx:2295-2317）：InspectorWorkspace + Section + NumField + 整宽移除按钮。
  // NumField 的 onDraft/onCommit 语义 = 参照 onPreview/onCommit（草稿不落 Revision，失焦/Enter 提交单条 patch）。
  return <fieldset className="pp-panel locked-fieldset" aria-label="转场属性">
    <InspectorWorkspace kind="transition" label="转场属性">
      <Section id="transition" title="转场" bare>
        <div className="pp-row">
          <label>类型</label>
          <MenuSelect
            label="转场类型"
            value={transition.kind}
            groups={[{ choices: transitionKinds.map(kind => ({ value: kind, label: kind })) }]}
            onPick={kind => update([{ op: "update_transition", transition_id: transition.transition_id, kind: kind as typeof transition.kind }], `转场类型 ${kind}`)}
          />
        </div>
        <div className="pp-row">
          <label>时长（秒）</label>
          <span className="pp-num">
            <NumField
              label="转场时长（秒）"
              word
              value={transition.duration_us / 1_000_000}
              min={0.1}
              max={2}
              step={0.1}
              unit="s"
              onCommit={v => { const s = Math.min(2, Math.max(0.1, v)); update([{ op: "update_transition", transition_id: transition.transition_id, duration_us: Math.round(s * 1_000_000) }], `转场时长 ${s}s`); }}
            />
          </span>
        </div>
        <button type="button" className="pp-btn danger" onClick={() => update([{ op: "remove_transition", transition_id: transition.transition_id }], "删除转场")}>删除转场</button>
        <p className="pp-note">转场仅在权威预览与最终导出中渲染；交互预览直接切换片段。</p>
      </Section>
    </InspectorWorkspace>
  </fieldset>;
}
