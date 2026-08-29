import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ChevronDown, ChevronLeft, ChevronRight, Download, Eye, FileAudio, FileText, FolderPlus, History, ImagePlus, LayoutGrid, List, Lock, LockOpen, MapPin, Pause, Play, Plus, Redo2, RefreshCw, RotateCcw, Save, Scissors, Sparkles, Square, Trash2, Undo2, Video, Volume2, VolumeX, X, Minus, Maximize2 } from "lucide-react";
import type { Asset, AssetId, AssetKind, AssetPresentation, BriefInput, CaptionPresetId, DirectoryGrant, EncoderMode, EgressPreview, ExportBatch, HorizontalAnchor, Job, LayoutPolicy, MediaInfo, ModelDetail, ModelSummary, PlatformPreset, Project, ProviderConfig, ReframeExportBatch, RenditionPreset, RenditionReframeAdjustment, TimelineCaption, TimelineClip, TimelineDiff, TimelineDocument, TimelineLayout, TimelinePatchEgressPreview, TimelinePatchOperation, TimelinePatchProposal, TimelineRevisionSummary, TimelineState, Transcript, TranscriptSegment, TranscriptSummary, VerticalAnchor } from "@aivideo/contracts";
import type { AuthoritativePreviewPresentation, ExportRecordPresentation, RenditionPreviewPresentation, RenditionReframePreviewPresentation } from "../../electron/preload/index.js";
import { CONTRACT_VERSION } from "@aivideo/contracts";
import { MediaGenerationWorkbench } from "./media-generation/MediaGenerationWorkbench.js";
import { ProviderImageGenerationWorkbench } from "./provider-image-generation/ProviderImageGenerationWorkbench.js";
import { ShotRequirementWorkbench } from "./shot-requirements/ShotRequirementWorkbench.js";
import { Dialog } from "./Dialog.js";
import { errorCode, safeErrorMessage, safeTaskErrorMessage } from "./safeErrors.js";
import { editorCommands, type EditorCommand } from "./editorCommands.js";
import { bindingLabel, findConflict, loadShortcuts, matchesBinding, normalizeRecordedBinding, saveShortcuts, DEFAULT_SHORTCUTS, type ShortcutCommandId, type ShortcutEntry } from "./shortcuts.js";
import { TimelinePanel } from "./timeline/TimelineCanvas.js";
import { ClipProperties, CaptionProperties, ProjectProperties, TimelineDiffView, TransitionProperties } from "./PropertyPanels.js";
import { JobEta } from "./JobEta.js";

type SaveState = "已保存" | "保存中" | "保存失败" | "草稿冲突";
type Selection = { kind: "clip"; id: string } | { kind: "clips"; ids: string[] } | { kind: "caption"; id: string } | { kind: "transition"; id: string } | null;
const layouts: { value: TimelineLayout; label: string }[] = [{ value: "blurred_background", label: "模糊背景" }, { value: "crop_fill", label: "裁切填满" }, { value: "fit", label: "完整适配" }];
const previewRatios: { value: string; label: string; ratio: number | null }[] = [{ value: "fit", label: "适应", ratio: null }, { value: "169", label: "16:9", ratio: 16 / 9 }, { value: "916", label: "9:16", ratio: 9 / 16 }, { value: "11", label: "1:1", ratio: 1 }, { value: "43", label: "4:3", ratio: 4 / 3 }, { value: "34", label: "3:4", ratio: 3 / 4 }];
const presets: { value: CaptionPresetId; label: string }[] = [{ value: "default-bottom", label: "默认底部" }, { value: "game-safe-bottom", label: "游戏安全区" }, { value: "high-contrast", label: "高对比" }];
const formatTime = (us: number) => {
  const totalSeconds = us / 1_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(Math.floor(seconds)).padStart(2, "0")}`;
  if (minutes > 0) return `${minutes}:${String(Math.floor(seconds)).padStart(2, "0")}`;
  return `${seconds.toFixed(2)}s`;
};
const duration = (document?: TimelineDocument) => document?.clips.at(-1)?.timeline_end_us ?? 0;
const formatRulerTime = (us: number) => {
  const totalSeconds = us / 1_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};
const ZOOM_MIN_PPS = 4;
const ZOOM_MAX_PPS = 400;
const zoomPctToPps = (zoom: number) => ZOOM_MIN_PPS * Math.pow(ZOOM_MAX_PPS / ZOOM_MIN_PPS, zoom / 100);
const ppsToZoomPct = (pps: number) => 100 * Math.log(pps / ZOOM_MIN_PPS) / Math.log(ZOOM_MAX_PPS / ZOOM_MIN_PPS);
function buildClipFrames(url: string | null, assetKind: AssetKind, sourceStartUs: number, sourceEndUs: number, pps: number): { kind: "video" | "image"; src: string }[] {
  if (!url) return [];
  if (assetKind === "image") return [{ kind: "image", src: url }];
  if (assetKind !== "video") return [];
  const sourceDurationUs = sourceEndUs - sourceStartUs;
  if (sourceDurationUs <= 0) return [];
  const widthPx = (sourceDurationUs / 1_000_000) * pps;
  const count = Math.max(1, Math.min(16, Math.round(widthPx / 56)));
  const frames: { kind: "video"; src: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const tUs = sourceStartUs + ((i + 0.5) * sourceDurationUs) / count;
    frames.push({ kind: "video", src: `${url}#t=${tUs / 1_000_000}` });
  }
  return frames;
}
const assetKinds: AssetKind[] = ["video", "audio", "image", "text"];
const assetKindLabels: Record<AssetKind, string> = { video: "视频", audio: "音频", image: "图片", text: "文本" };
type AssetFilter = "all" | AssetKind;
const availabilityLabels = { available: "可用", missing: "缺失", changed: "已变更", unsupported: "不支持" } as const;
const modelStatusLabels: Record<ModelSummary["status"], string> = { unavailable: "未安装", queued: "排队中", downloading: "下载中", paused: "已暂停", verifying: "校验中", ready: "已就绪", cancelled: "已取消", failed: "下载失败" };
const jobStatusLabels: Record<Job["status"], string> = { queued: "排队中", running: "运行中", succeeded: "已完成", failed: "失败", cancelling: "取消中", cancelled: "已取消", interrupted: "已中断" };
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const isTranscribable = (asset: Asset) => (asset.kind === "video" || asset.kind === "audio") && asset.availability === "available";
type RenditionTarget = { key: string; platform_preset_id: string; rendition_preset_id: string; layout_policy: LayoutPolicy };
type ReframeAnchor = Pick<RenditionReframeAdjustment, "horizontal_anchor" | "vertical_anchor">;
type ReframeSelections = Record<string, Record<string, ReframeAnchor>>;
const horizontalAnchors: HorizontalAnchor[] = ["left", "center", "right"];
const verticalAnchors: VerticalAnchor[] = ["top", "center", "bottom"];
const anchorLabels: Record<string, string> = { "left:top": "左上", "center:top": "上", "right:top": "右上", "left:center": "左", "center:center": "中心", "right:center": "右", "left:bottom": "左下", "center:bottom": "下", "right:bottom": "右下" };
const layoutPolicies: { value: LayoutPolicy; label: string }[] = [{ value: "preserve_timeline", label: "沿用时间线" }, { value: "fit_all", label: "完整适配" }, { value: "crop_fill_all", label: "裁切填满" }, { value: "blurred_background_all", label: "模糊背景" }];

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className="icon-btn" title={label} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

function ReframeTargetEditor({ clips, selections, preview, pending, onSelect, onGenerate, onPlay }: {
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

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project>();
  const [assets, setAssets] = useState<AssetPresentation[]>([]);
  const [assetQuery, setAssetQuery] = useState("");
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
  const [assetView, setAssetView] = useState<"list" | "grid">("list");
  // 素材箱双击预览：仅播放素材，不加入时间线。任何时间线交互都会退出该模式。
  const [libraryPreviewId, setLibraryPreviewId] = useState<string | null>(null);
  const visibleAssets = useMemo(() => assets.filter(item => {
    const matchesQuery = item.asset.display_name.toLocaleLowerCase().includes(assetQuery.trim().toLocaleLowerCase());
    const matchesKind = assetFilter === "all" || item.asset.kind === assetFilter;
    return matchesQuery && matchesKind;
  }), [assetQuery, assetFilter, assets]);
  const [transcripts, setTranscripts] = useState<Record<string, Transcript[]>>({});
  const [transcriptSummaries, setTranscriptSummaries] = useState<Record<string, TranscriptSummary[]>>({});
  const [jobs, setJobs] = useState<Job[]>([]);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [confirmModel, setConfirmModel] = useState<ModelDetail>();
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  const [transcriptionAsset, setTranscriptionAsset] = useState<Asset>();
  const [viewingTranscript, setViewingTranscript] = useState<Transcript>();
  const [language, setLanguage] = useState("auto");
  const [wordTimestamps, setWordTimestamps] = useState(true);
  const [timeline, setTimeline] = useState<TimelineState>();
  const [working, setWorking] = useState<TimelineDocument>();
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<"assets" | "transcripts">("assets");
  const [saveState, setSaveState] = useState<SaveState>("已保存");
  const [notice, setNotice] = useState("");
  const [newProject, setNewProject] = useState("");
  const [projectName, setProjectName] = useState("");
  const [selectedSegments, setSelectedSegments] = useState<Record<string, string[]>>({});
  const [playing, setPlaying] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [encoderMode, setEncoderMode] = useState<EncoderMode>("auto");
  const [previewMode, setPreviewMode] = useState<"interactive" | "authoritative">("interactive");
  const [previewRatio, setPreviewRatio] = useState("fit");
  const [previewRatioTouched, setPreviewRatioTouched] = useState(false);
  const [previews, setPreviews] = useState<AuthoritativePreviewPresentation[]>([]);
  const [exports, setExports] = useState<ExportRecordPresentation[]>([]);
  const [exportPlayback, setExportPlayback] = useState<ExportRecordPresentation>();
  const [aiOpen, setAiOpen] = useState(false);
  const [aiStep, setAiStep] = useState<"form" | "confirm" | "running" | "candidates">("form");
  const [aiError, setAiError] = useState("");
  const [aiProviders, setAiProviders] = useState<ProviderConfig[]>([]);
  const [aiRecipes, setAiRecipes] = useState<Array<{ recipe_id: string; name?: string; display_name?: string; summary: string }>>([]);
  const [aiPreview, setAiPreview] = useState<EgressPreview>();
  const [aiCandidates, setAiCandidates] = useState<Array<Record<string, unknown>>>([]);
  const [aiJob, setAiJob] = useState<Job>();
  const [aiCapabilityTesting, setAiCapabilityTesting] = useState(false);
  const [aiPlayback, setAiPlayback] = useState<{ media_url: string; source_start_us: number; source_end_us: number }>();
  const [aiProviderDraft, setAiProviderDraft] = useState({ display_name: "", base_url: "", model: "" });
  const [aiForm, setAiForm] = useState({ topic: "", audience: "", narrative_goal: "", style_notes: "", provider_id: "", recipe_id: "", transcript_id: "" });
  const [patchOpen, setPatchOpen] = useState(false);
  const [patchStep, setPatchStep] = useState<"form" | "confirm" | "running" | "proposal">("form");
  const [patchInstruction, setPatchInstruction] = useState("");
  const [patchProviderId, setPatchProviderId] = useState("");
  const [patchProviders, setPatchProviders] = useState<ProviderConfig[]>([]);
  const [patchPreview, setPatchPreview] = useState<TimelinePatchEgressPreview>();
  const [patchProposal, setPatchProposal] = useState<TimelinePatchProposal>();
  const [patchJob, setPatchJob] = useState<Job>();
  const [patchError, setPatchError] = useState("");
  const [patchCapabilityTesting, setPatchCapabilityTesting] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [generationOpen, setGenerationOpen] = useState(false);
  const [renderPanelOpen, setRenderPanelOpen] = useState(false);
  const [commandSearchOpen, setCommandSearchOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [providerImageGenerationOpen, setProviderImageGenerationOpen] = useState(false);
  const [shotRequirementsOpen, setShotRequirementsOpen] = useState(false);
  const [platformPresets, setPlatformPresets] = useState<PlatformPreset[]>([]);
  const [renditionPresets, setRenditionPresets] = useState<RenditionPreset[]>([]);
  const [renditionTargets, setRenditionTargets] = useState<RenditionTarget[]>([]);
  const [renditionPreviews, setRenditionPreviews] = useState<RenditionPreviewPresentation[]>([]);
  const [directoryGrant, setDirectoryGrant] = useState<DirectoryGrant>();
  const [activeBatch, setActiveBatch] = useState<ExportBatch>();
  const [batchError, setBatchError] = useState("");
  const [reframeSelections, setReframeSelections] = useState<ReframeSelections>({});
  const [reframePreviews, setReframePreviews] = useState<Record<string, RenditionReframePreviewPresentation>>({});
  const [reframePending, setReframePending] = useState<Record<string, string>>({});
  const [reframePlayback, setReframePlayback] = useState<RenditionReframePreviewPresentation>();
  const [reframeDirectoryGrant, setReframeDirectoryGrant] = useState<DirectoryGrant>();
  const [activeReframeBatch, setActiveReframeBatch] = useState<ReframeExportBatch>();
  const [reframeError, setReframeError] = useState("");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  const projectSwitcherRef = useRef<HTMLDivElement | null>(null);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const menuButtonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuActionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(300);
  const [timelineHeight, setTimelineHeight] = useState(230);
  const resizeRef = useRef<{ kind: "left" | "right" | "timeline"; start: number; value: number } | undefined>(undefined);
  // C3：快捷键自定义（注册表 + localStorage 持久化 + 面板录制状态）。
  const [shortcuts, setShortcuts] = useState<Record<ShortcutCommandId, ShortcutEntry>>(() => loadShortcuts());
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [recordingId, setRecordingId] = useState<ShortcutCommandId | null>(null);
  const [ratioMenuOpen, setRatioMenuOpen] = useState(false);
  const ratioMenuRef = useRef<HTMLDivElement | null>(null);
  const applyShortcuts = (next: Record<ShortcutCommandId, ShortcutEntry>) => { setShortcuts(next); saveShortcuts(next); };
  const handleRecordKey = (event: React.KeyboardEvent, id: ShortcutCommandId) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") { setRecordingId(null); return; }
    const binding = normalizeRecordedBinding(event.nativeEvent);
    if (!binding) { setNotice("该按键不可用：单字符键需配合 Ctrl 使用；可用的还有空格与 Delete。"); return; }
    const conflict = findConflict(shortcuts, id, binding);
    if (conflict) { setNotice(`按键与「${shortcuts[conflict].label}」冲突，请先改绑后者。`); return; }
    applyShortcuts({ ...shortcuts, [id]: { ...shortcuts[id], binding } });
    setRecordingId(null);
  };
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisions, setRevisions] = useState<TimelineRevisionSummary[]>([]);
  const [revisionPair, setRevisionPair] = useState({ base: "", target: "" });
  const [revisionDiff, setRevisionDiff] = useState<TimelineDiff>();
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const projectNameProjectId = useRef<Project["project_id"] | undefined>(undefined);
  const projectNameDirty = useRef(false);
  const timelineLoadEpoch = useRef(0);
  const pollInstanceRef = useRef<symbol | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      const delta = event.clientX - resize.start;
      if (resize.kind === "left") setLeftWidth(Math.max(220, Math.min(420, resize.value + delta)));
      else if (resize.kind === "right") setRightWidth(Math.max(240, Math.min(460, resize.value - delta)));
      else setTimelineHeight(Math.max(150, Math.min(520, resize.value - (event.clientY - resize.start))));
    };
    const end = () => { resizeRef.current = undefined; document.body.classList.remove("is-resizing"); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
  }, []);
  useEffect(() => {
    const query = window.desktop.isWindowMaximized?.();
    if (query) void query.then(setMaximized).catch(() => undefined);
    const unsubscribe = window.desktop.onWindowMaximizeChange?.(setMaximized);
    return () => { if (unsubscribe) unsubscribe(); };
  }, []);
  const beginResize = (kind: "left" | "right" | "timeline", event: React.PointerEvent) => {
    event.preventDefault();
    resizeRef.current = { kind, start: kind === "timeline" ? event.clientY : event.clientX, value: kind === "left" ? leftWidth : kind === "right" ? rightWidth : timelineHeight };
    document.body.classList.add("is-resizing");
  };

  const refreshProjects = async () => {
    const page = await window.desktop.listProjects({ limit: 100 });
    setProjects(page.items);
    setProject(current => page.items.find(item => item.project_id === current?.project_id) ?? page.items[0]);
  };
  const loadModels = async () => { const page = await window.desktop.listModels({ limit: 100 }); setModels(page.items); };
  const loadJobs = async (selected: Project) => { const page = await window.desktop.listJobs({ project_id: selected.project_id }); setJobs(page.items); };
  const loadProjectData = async (selected: Project) => {
    const [assetPage, jobPage] = await Promise.all([window.desktop.listAssets({ project_id: selected.project_id }), window.desktop.listJobs({ project_id: selected.project_id })]);
    setAssets(assetPage.items); setJobs(jobPage.items);
    const pairs = await Promise.all(assetPage.items.filter(item => isTranscribable(item.asset)).map(async item => {
      const summaryPage = await window.desktop.listTranscripts(item.asset.asset_id);
      const ready = await Promise.all(summaryPage.items.filter(summary => summary.status === "ready").map(summary => window.desktop.getTranscript(summary.transcript_id)));
      return [item.asset.asset_id, summaryPage.items, ready] as const;
    }));
    setTranscriptSummaries(Object.fromEntries(pairs.map(([assetId, summaries]) => [assetId, summaries])));
    setTranscripts(Object.fromEntries(pairs.map(([assetId, , ready]) => [assetId, ready])));
  };
  const loadRenderData = async (selected: Project) => {
    const [previewPage, exportPage] = await Promise.all([
      window.desktop.listPreviews({ project_id: selected.project_id, limit: 100 }),
      window.desktop.listExports({ project_id: selected.project_id, limit: 100 })
    ]);
    setPreviews(previewPage.items);
    setExports(exportPage.items);
  };
  const openAi = async () => {
    if (!project || !window.desktop.listProviders || !window.desktop.listRecipes) return;
    setAiError(""); setAiOpen(true); setAiStep("form");
    try {
      const [providers, recipes] = await Promise.all([window.desktop.listProviders(), window.desktop.listRecipes()]);
      if (!Array.isArray(recipes.items)) throw new Error("Recipe 响应无效");
      setAiProviders(providers.items); setAiRecipes(recipes.items);
      await loadProjectData(project);
      const current = await window.desktop.getBrief?.(project.project_id).catch(() => undefined);
      if (current) setAiForm(value => ({ ...value, topic: current.topic, audience: current.audience, narrative_goal: current.narrative_goal, style_notes: current.style_notes }));
    } catch { setAiError("无法加载 AI 粗剪配置。"); }
  };
  const prepareAi = async () => {
    if (!project || !window.desktop.putBrief || !window.desktop.preparePlanning) return;
    const provider = aiProviders.find(item => item.provider_config_id === aiForm.provider_id);
    if (!provider || !provider.enabled || provider.credential_status !== "configured" || provider.candidate_capability_status !== "supported") return;
    const brief: BriefInput = { schema_version: 1, topic: aiForm.topic, audience: aiForm.audience, target_platform: "generic_vertical", target_duration_us: 30_000_000, narrative_goal: aiForm.narrative_goal, style_notes: aiForm.style_notes, must_keep: [], forbidden: [], original_audio_policy: "preserve", caption_policy: "auto_from_transcript", caption_preset_id: "default-bottom", default_layout: "fit" };
    try { setAiError(""); await window.desktop.putBrief({ project_id: project.project_id, brief }); const preview = await window.desktop.preparePlanning({ project_id: project.project_id, provider_config_id: aiForm.provider_id, recipe_id: aiForm.recipe_id, transcript_ids: [aiForm.transcript_id] }); setAiPreview(preview); setAiStep("confirm"); }
    catch { setAiError("准备失败。请检查 Brief、Provider 凭据及就绪转录后重试。"); }
  };
  const createAi = async () => {
    if (!project || !aiPreview || !window.desktop.createPlanning) return;
    try { setAiStep("running"); const result = await window.desktop.createPlanning({ project_id: project.project_id, egress_preview_id: aiPreview.egress_preview_id, payload_sha256: aiPreview.payload_sha256 }); setAiJob(result.job); trackRenderJob(result.job); const stop = window.desktop.subscribeJob(result.job.job_id, job => { setAiJob(job); if (["failed", "cancelled", "interrupted"].includes(job.status)) { setAiPreview(undefined); setAiStep("form"); setAiError("生成未完成。请重新准备外传内容并再次确认。"); } }); const poll = async () => { const items = await window.desktop.listCandidatePlans?.(project.project_id); if (items?.items.length) { stop(); setAiCandidates(items.items as unknown as Array<Record<string, unknown>>); setAiStep("candidates"); } else setTimeout(() => void poll(), 1500); }; void poll(); }
    catch { setAiPreview(undefined); setAiError("调用失败；重试前必须重新准备并确认外传内容。"); setAiStep("form"); }
  };
  const saveAiProvider = async () => {
    if (!window.desktop.createProvider) return;
    try { const created = await window.desktop.createProvider({ kind: "openai_compatible_text", ...aiProviderDraft, enabled: true, input_price_per_million: null, output_price_per_million: null }); setAiProviders(current => [...current, created]); setAiForm(current => ({ ...current, provider_id: created.provider_config_id })); setAiProviderDraft({ display_name: "", base_url: "", model: "" }); }
    catch { setAiError("Provider 配置无效。请检查名称、HTTPS/HTTP 地址和模型名。"); }
  };
  const saveAiSecret = async () => {
    if (!window.desktop.setProviderSecret || !aiForm.provider_id) return;
    const input = document.getElementById("ai-provider-secret") as HTMLInputElement | null;
    const secret = input?.value ?? "";
    if (!secret) return;
    try { await window.desktop.setProviderSecret({ provider_config_id: aiForm.provider_id, secret }); if (input) input.value = ""; setAiProviders(current => current.map(item => item.provider_config_id === aiForm.provider_id ? { ...item, credential_status: "configured", candidate_capability_status: "untested", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: null, candidate_capability_failure_code: null, candidate_capability_probe_sha256: null } : item)); }
    catch { setAiError("密钥未能同步到本地核心；未显示或记录密钥内容。"); }
  };
  const deleteAiSecret = async () => { if (!window.desktop.deleteProviderSecret || !aiForm.provider_id) return; try { await window.desktop.deleteProviderSecret(aiForm.provider_id); setAiProviders(current => current.map(item => item.provider_config_id === aiForm.provider_id ? { ...item, credential_status: "missing" } : item)); setAiError("密钥已从本机安全存储与 Core 内存中删除。"); } catch { setAiError("删除密钥失败；未显示密钥内容。"); } };
  const testAiProvider = async () => { if (!window.desktop.testProvider || !aiForm.provider_id) return; try { await window.desktop.testProvider(aiForm.provider_id); setAiError("连接测试通过；仍需测试 AI 粗剪兼容性。"); } catch { setAiError("连接测试失败，请检查 Provider、网络和凭据。"); } };
  const testCandidateProviderCapability = async (providerId: string) => {
    if (!providerId) return;
    try {
      setAiCapabilityTesting(true); setAiError("");
      const result = await window.desktop.testCandidateProviderCapability(providerId);
      setAiProviders(current => current.map(item => item.provider_config_id === providerId ? { ...item, ...result } : item));
      setAiError(result.candidate_capability_status === "supported" ? "AI 粗剪可用。" : "当前 Provider 不支持 AI 粗剪。");
    } catch { setAiError("AI 粗剪兼容性测试失败；未显示 Provider 响应内容。"); }
    finally { setAiCapabilityTesting(false); }
  };
  const playAiClip = async (candidateOrClip: Record<string, unknown>, selectedClip?: Record<string, unknown>) => { if (!project || !window.desktop.getCandidateClipMedia) return; const clip = selectedClip ?? candidateOrClip; const candidate = selectedClip ? candidateOrClip : aiCandidates.find(item => Array.isArray(item.clips) && (item.clips as Array<Record<string, unknown>>).some(item => item.clip_id === clip.clip_id)); if (!candidate) { setAiError("候选片段当前不可播放。"); return; } try { setAiPlayback(await window.desktop.getCandidateClipMedia({ project_id: project.project_id, candidate_plan_id: String(candidate.candidate_plan_id), candidate_clip_id: String(clip.clip_id) })); } catch { setAiError("候选片段当前不可播放。"); } };
  const adoptAi = async (candidate: Record<string, unknown>) => { if (!project || !window.desktop.adoptCandidatePlan) return; try { const state = await window.desktop.adoptCandidatePlan({ project_id: project.project_id, candidate_plan_id: String(candidate.candidate_plan_id), adoption: { schema_version: 1, candidate_document_sha256: String(candidate.document_sha256), base_revision_id: timeline?.current_revision.timeline_revision_id ?? null } }); setTimeline(state); setWorking(state.current_revision.document); setAiOpen(false); setNotice("候选已采用为正式时间线；可使用撤销恢复。"); } catch { setAiError("采用冲突：请先处理当前草稿或刷新 Timeline 后重试。"); } };
  const clearPatchFlow = () => { setPatchInstruction(""); setPatchPreview(undefined); setPatchProposal(undefined); setPatchJob(undefined); setPatchError(""); setPatchStep("form"); };
  const closePatch = () => { setPatchOpen(false); clearPatchFlow(); };
  const openPatch = async () => {
    if (!project || !timeline) return;
    clearPatchFlow(); setPatchOpen(true);
    try { const response = await window.desktop.listProviders?.(); const available = (response?.items ?? []).filter(item => item.enabled && item.credential_status === "configured"); setPatchProviders(available); const supported = available.filter(item => item.timeline_patch_capability_status === "supported"); setPatchProviderId(current => supported.some(item => item.provider_config_id === current) ? current : supported[0]?.provider_config_id ?? ""); }
    catch { setPatchError("无法加载可用 Provider。"); }
  };
  const preparePatch = async () => {
    if (!project || !timeline || !patchProviderId || !patchInstruction.trim()) return;
    try { setPatchError(""); const preview = await window.desktop.prepareTimelinePatch({ project_id: project.project_id, base_revision_id: timeline.current_revision.timeline_revision_id, provider_config_id: patchProviderId, instruction: patchInstruction }); setPatchPreview(preview); setPatchStep("confirm"); }
    catch (error) { setPatchPreview(undefined); setPatchError(safeErrorMessage(error, "准备失败。请刷新 Timeline 并重新输入指令。")); }
  };
  const testPatchProviderCapability = async (providerId: string) => {
    if (!providerId || !window.desktop.testTimelinePatchProviderCapability) return;
    try {
      setPatchCapabilityTesting(true); setPatchError("");
      const result = await window.desktop.testTimelinePatchProviderCapability(providerId);
      setPatchProviders(current => current.map(item => item.provider_config_id === providerId ? { ...item, ...result } : item));
      if (result.timeline_patch_capability_status === "supported") setPatchError("AI 修改可用。");
      else setPatchError("当前 Provider 不支持 AI 修改。");
    } catch { setPatchError("AI 修改兼容性测试失败；未显示 Provider 响应内容。"); }
    finally { setPatchCapabilityTesting(false); }
  };
  const createPatch = async () => {
    if (!project || !patchPreview) return;
    try {
      const result = await window.desktop.createTimelinePatchGeneration({ project_id: project.project_id, timeline_patch_egress_preview_id: patchPreview.timeline_patch_egress_preview_id, payload_sha256: patchPreview.payload_sha256 });
      setPatchPreview(undefined); setPatchJob(result.job); setPatchStep("running");
      const stop = window.desktop.subscribeJob(result.job.job_id, job => {
        setPatchJob(job);
        if (["failed", "cancelled", "interrupted"].includes(job.status)) { stop(); setPatchInstruction(""); setPatchStep("form"); setPatchError("生成未完成。旧确认已失效，请重新输入并准备。"); }
        if (job.status === "succeeded") void window.desktop.listTimelinePatchProposals(project.project_id).then(page => { const proposal = page.items.find(item => item.timeline_patch_generation_id === result.timeline_patch_generation_id); if (!proposal) throw new Error("proposal missing"); stop(); setPatchInstruction(""); setPatchProposal(proposal); setPatchStep("proposal"); }).catch(() => { stop(); setPatchInstruction(""); setPatchStep("form"); setPatchError("提案读取失败，请从项目提案列表重试。"); });
      });
    } catch { setPatchPreview(undefined); setPatchInstruction(""); setPatchStep("form"); setPatchError("调用失败。必须重新输入指令并准备新的确认。"); }
  };
  const cancelPatch = async () => { if (!patchJob) return; try { setPatchJob(await window.desktop.cancelJob(patchJob.job_id)); setPatchInstruction(""); setPatchPreview(undefined); setPatchStep("form"); setPatchError("已请求取消。再次生成必须重新输入并准备。"); } catch { setPatchError("取消请求失败，请等待任务状态更新。"); } };
  const applyPatchProposal = async () => {
    if (!project || !patchProposal) return;
    try { const next = await window.desktop.applyTimelinePatchProposal({ project_id: project.project_id, proposal_id: patchProposal.timeline_patch_proposal_id, base_revision_id: patchProposal.base_revision_id, proposed_document_sha256: patchProposal.proposed_document_sha256 }); acceptState(next); closePatch(); await loadRenderData(project); setNotice("AI 修改已应用为新的正式 Revision；旧权威预览已过期。"); }
    catch { setPatchError("应用冲突。请刷新 Timeline 后重新生成提案。"); }
  };
  const openRevisionCompare = async () => { if (!project) return; setRevisionDiff(undefined); setRevisionOpen(true); try { const page = await window.desktop.listTimelineRevisions({ project_id: project.project_id, limit: 100 }); setRevisions(page.items); setRevisionPair({ base: page.items[1]?.timeline_revision_id ?? page.items[0]?.timeline_revision_id ?? "", target: page.items[0]?.timeline_revision_id ?? "" }); } catch { setNotice("无法加载 Revision 历史。"); } };
  const compareRevisions = async () => { if (!project || !revisionPair.base || !revisionPair.target) return; try { setRevisionDiff(await window.desktop.compareTimelineRevisions({ project_id: project.project_id, base_revision_id: revisionPair.base as never, target_revision_id: revisionPair.target as never })); } catch { setNotice("Revision 比较失败。"); } };
  useEffect(() => {
    // The preload bridge is immutable in production, but capture it for this
    // mounted editor instance.  This prevents a late startup continuation from
    // an unmounted window from issuing requests through a subsequently created
    // renderer bridge and racing its project/timeline state.
    const desktop = window.desktop;
    let active = true;
    void desktop.getRuntime().then(async () => {
      const [projectPage, modelPage] = await Promise.all([
        desktop.listProjects({ limit: 100 }),
        desktop.listModels({ limit: 100 })
      ]);
      if (!active) return;
      setRuntimeReady(true);
      setProjects(projectPage.items);
      setProject(current => projectPage.items.find(item => item.project_id === current?.project_id) ?? projectPage.items[0]);
      setModels(modelPage.items);
    }).catch(error => { if (active) setNotice(safeErrorMessage(error, "运行环境初始化失败，请刷新后重试。")); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!project) return;
    closePatch(); setRevisionOpen(false); setRevisionDiff(undefined);
    setReframeSelections({}); setReframePreviews({}); setReframePending({}); setReframePlayback(undefined); setReframeDirectoryGrant(undefined); setActiveReframeBatch(undefined); setReframeError("");
    let active = true;
    const epoch = ++timelineLoadEpoch.current;
    void loadProjectData(project).catch(error => active && setNotice(safeErrorMessage(error, "项目数据加载失败，请刷新后重试。")));
    void loadRenderData(project).catch(error => active && setNotice(safeErrorMessage(error, "渲染记录加载失败，请刷新后重试。")));
    void window.desktop.getTimeline(project.project_id).then(value => { if (active && epoch === timelineLoadEpoch.current) { setTimeline(value); setWorking(value.current_revision.document); setSelection(null); } }).catch(error => {
      if (active && epoch === timelineLoadEpoch.current) { setTimeline(undefined); setWorking(undefined); if (!errorCode(error).includes("TIMELINE_NOT_FOUND") && !errorCode(error).includes("404")) setNotice(safeErrorMessage(error, "时间线加载失败，请刷新后重试。")); }
    });
    return () => { active = false; };
  }, [project?.project_id]);
  useEffect(() => {
    if (!runtimeReady) return;
    // 轮询守卫：卸载/重挂载后，前一个实例仍在飞行的轮询响应不得覆盖新状态
    // （React 18 测试中 unmount 后 Promise 才 resolve 会更新已卸载组件的
    // 订阅闭包之外的全局 mock，污染下一个测试；见 editor-shell failed-job flaky）。
    const instance = Symbol("app-poll-instance");
    pollInstanceRef.current = instance;
    const timer = setInterval(() => {
      if (pollInstanceRef.current !== instance) return;
      void refreshProjects().catch(() => undefined);
      if (project) void loadJobs(project).catch(() => undefined);
      void loadModels().catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [runtimeReady, project?.project_id]);
  useEffect(() => {
    if (!project) {
      projectNameProjectId.current = undefined;
      projectNameDirty.current = false;
      setProjectName("");
      return;
    }
    if (projectNameProjectId.current !== project.project_id || !projectNameDirty.current) {
      projectNameProjectId.current = project.project_id;
      projectNameDirty.current = false;
      setProjectName(project.name);
    }
  }, [project?.project_id, project?.name]);
  const terminalRenderJobs = jobs.filter(item => (item.kind === "authoritative_preview" || item.kind === "final_export") && ["succeeded", "failed", "cancelled", "interrupted"].includes(item.status)).map(item => `${item.job_id}:${item.status}`).sort().join("|");
  useEffect(() => { if (project && terminalRenderJobs) void loadRenderData(project).catch(error => setNotice(safeErrorMessage(error, "渲染记录加载失败，请刷新后重试。"))); }, [project?.project_id, terminalRenderJobs]);

  const selectedClip = selection?.kind === "clip" ? working?.clips.find(item => item.clip_id === selection.id) : undefined;
  const selectedCaption = selection?.kind === "caption" ? working?.captions.find(item => item.caption_id === selection.id) : undefined;
  const selectedTransition = selection?.kind === "transition" ? working?.transitions?.find(item => item.transition_id === selection.id) : undefined;
  const selectedClipIds =
    selection?.kind === "clip"
      ? [selection.id]
      : selection?.kind === "clips"
        ? selection.ids
        : [];
  const selectedClips = selectedClipIds
    .map(id => working?.clips.find(item => item.clip_id === id))
    .filter((item): item is TimelineClip => Boolean(item));
  const sortedClips = useMemo(() => [...(working?.clips ?? [])].sort((a, b) => a.order_index - b.order_index), [working?.clips]);
  const v1Clips = useMemo(() => sortedClips.filter(c => c.track_id === "V1"), [sortedClips]);
  const a1Clips = useMemo(() => sortedClips.filter(c => c.track_id === "A1"), [sortedClips]);
  const clipAtPlayhead = v1Clips.length > 0 ? v1Clips.find(c => playhead >= c.timeline_start_us && playhead < c.timeline_end_us) : undefined;
  const audioClipAtPlayhead = a1Clips.length > 0 ? a1Clips.find(c => playhead >= c.timeline_start_us && playhead < c.timeline_end_us) : undefined;
  const previewSpeedMilli = clipAtPlayhead?.speed_milli ?? (libraryPreviewId ? undefined : 1000);
  const previewReverse = Boolean(clipAtPlayhead?.reverse_playback);
  const previewAsset = (libraryPreviewId ? assets.find(item => item.asset.asset_id === libraryPreviewId) : undefined) ?? (clipAtPlayhead ? assets.find(item => item.asset.asset_id === clipAtPlayhead.asset_id) : undefined) ?? assets.find(item => item.asset.asset_id === selectedClip?.asset_id) ?? assets.find(item => item.asset.asset_id === working?.clips[0]?.asset_id);
  const audioAsset = audioClipAtPlayhead ? assets.find(item => item.asset.asset_id === audioClipAtPlayhead.asset_id) : undefined;
  useEffect(() => {
    const media = videoRef.current;
    if (media) {
      if (pendingSeekRef.current !== null) { media.currentTime = pendingSeekRef.current; pendingSeekRef.current = null; }
      // 交互预览跟随片段变速（倒放无法反向播放，仅回退原速）。
      media.playbackRate = previewReverse ? 1 : Math.max(0.25, Math.min(4, (previewSpeedMilli ?? 1000) / 1000));
      if (playing) void media.play().catch(() => setPlaying(false)); else media.pause();
    }
    const audio = audioRef.current;
    if (audio) {
      if (audioClipAtPlayhead) {
        const sourceStart = (audioClipAtPlayhead.source_start_us ?? 0) / 1_000_000;
        const elapsed = (playhead - audioClipAtPlayhead.timeline_start_us) / 1_000_000;
        audio.currentTime = sourceStart + elapsed * ((audioClipAtPlayhead.speed_milli ?? 1000) / 1000);
        audio.playbackRate = Math.max(0.25, Math.min(4, (audioClipAtPlayhead.speed_milli ?? 1000) / 1000));
        if (playing) void audio.play().catch(() => {}); else audio.pause();
      } else {
        audio.pause();
      }
    }
  }, [playing, previewAsset?.media_url, audioAsset?.media_url, playhead, previewSpeedMilli, previewReverse]);
  const visibleCaption = working?.captions.find(item => playhead >= item.start_us && playhead < item.end_us) ?? selectedCaption;
  const totalUs = duration(working);
  const handleVideoEnded = () => {
    if (libraryPreviewId) { setPlaying(false); return; } // 素材箱预览播放结束即停，不跳到时间线片段
    const currentIdx = sortedClips.findIndex(c => playhead >= c.timeline_start_us && playhead < c.timeline_end_us);
    const nextIdx = currentIdx >= 0 ? currentIdx + 1 : 0;
    if (nextIdx < sortedClips.length) {
      const nextClip = sortedClips[nextIdx];
      pendingSeekRef.current = (nextClip.source_start_us ?? 0) / 1_000_000;
      setPlayhead(nextClip.timeline_start_us);
    } else {
      setPlaying(false);
    }
  };

  const acceptState = (next: TimelineState) => { timelineLoadEpoch.current += 1; setTimeline(next); setWorking(next.current_revision.document); setSaveState("已保存"); setNotice(""); };
  const handleConflict = async (error: unknown) => {
    const text = errorCode(error);
    if (text.includes("TIMELINE_CONFLICT") || text.includes("TIMELINE_DRAFT_CONFLICT") || text.includes("409")) {
      setSaveState("草稿冲突"); setNotice("时间线已在其他操作中更新。已刷新当前事实，请检查后重新应用你的修改。");
      if (project) acceptState(await window.desktop.getTimeline(project.project_id));
    } else { setSaveState("保存失败"); setNotice(safeErrorMessage(error, "时间线保存失败，请刷新后重试。")); }
  };
  const patchTimeline = async (operations: TimelinePatchOperation[], summary: string) => {
    if (!project || !timeline) return;
    setSaveState("保存中");
    try { acceptState(await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: timeline.current_revision.timeline_revision_id, operations, summary } })); }
    catch (error) { await handleConflict(error); }
  };
  const queueDraft = (document: TimelineDocument) => {
    setWorking(document); setSaveState("保存中");
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      if (!project || !timeline) return;
      void window.desktop.saveTimelineDraft({ project_id: project.project_id, draft: { schema_version: 1, base_revision_id: timeline.current_revision.timeline_revision_id, document } }).then(() => setSaveState("已保存")).catch(handleConflict);
    }, 400);
  };
  const createTimeline = async (source: Parameters<typeof window.desktop.createTimeline>[0]["timeline"]["source"]) => {
    if (!project) return;
    setSaveState("保存中");
    try { acceptState(await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source, default_layout: "blurred_background", caption_preset_id: "default-bottom" } })); }
    catch (error) { await handleConflict(error); }
  };
  const insertAsset = (item: AssetPresentation, atIndex = working?.clips.length ?? 0) => timeline ? void patchTimeline([{ op: "insert_asset_clip", asset_id: item.asset.asset_id, at_index: atIndex, ...(item.asset.kind === "image" ? { duration_us: 3_000_000 } : {}) }], `追加素材 ${item.asset.display_name}`) : void createTimeline({ kind: "full_asset", asset_id: item.asset.asset_id });
  // 应用内剪贴板（M2 A3）：复制 V1 视频片段快照，粘贴回放到播放头。
  const clipboardClips = useRef<Array<{ asset_id: AssetId; asset_kind: "video" | "image"; source_start_us: number | null; source_end_us: number | null; speed_milli: number; reverse_playback: boolean; layout: TimelineLayout }>>([]);
  const insertableClipboardAssets = (snapshots: typeof clipboardClips.current) => snapshots.filter(item => {
    const asset = assets.find(candidate => candidate.asset.asset_id === item.asset_id);
    return Boolean(asset && (item.asset_kind === "image" || asset.asset.availability === "available"));
  });
  const dropAsset = (assetId: string, atIndex: number) => {
    const item = assets.find(candidate => candidate.asset.asset_id === assetId);
    if (!item || item.asset.availability !== "available") { setNotice("该素材当前不可用，无法加入时间线。"); return; }
    if (item.asset.kind !== "video" && item.asset.kind !== "image" && item.asset.kind !== "audio") { setNotice("该素材类型暂不支持拖入时间线。"); return; }
    insertAsset(item, atIndex);
  };
  const insertSegments = (transcript: Transcript) => {
    const ids = selectedSegments[transcript.transcript_id] ?? [];
    if (!ids.length) return;
    const source = { kind: "transcript_selection" as const, transcript_id: transcript.transcript_id, segment_ids: ids as never[], padding_before_us: 150_000, padding_after_us: 150_000, create_captions: true };
    if (timeline) void patchTimeline([{ op: "insert_transcript_segments", transcript_id: transcript.transcript_id, segment_ids: ids as never[], at_index: working?.clips.length ?? 0, padding_before_us: 150_000, padding_after_us: 150_000, create_captions: true, layout: "blurred_background" }], "追加转录选段"); else void createTimeline(source);
  };
  const createProject = async () => { if (!newProject.trim()) return; const created = await window.desktop.createProject({ name: newProject.trim() }); setNewProject(""); await refreshProjects(); setProject(created); setProjectDialogOpen(false); };
  const renameProject = async () => { if (!project || !projectName.trim()) return; const updated = await window.desktop.renameProject({ project_id: project.project_id, name: projectName.trim() }); projectNameDirty.current = false; setProject(updated); setProjects(items => items.map(item => item.project_id === updated.project_id ? updated : item)); };
  const toggleArchive = async () => { if (!project) return; const updated = project.status === "archived" ? await window.desktop.reopenProject(project.project_id) : await window.desktop.archiveProject(project.project_id); setProject(updated); setProjects(items => items.map(item => item.project_id === updated.project_id ? updated : item)); };
  const importAsset = async (kind: AssetKind) => { if (!project) return; const result = await window.desktop.importAsset({ project_id: project.project_id, kind }); if (result) setAssets(items => [...items, { asset: result.asset, media_url: result.media_url }]); };
  const refreshAsset = async (asset: Asset) => { const result = await window.desktop.refreshAsset(asset.asset_id); setAssets(items => items.map(item => item.asset.asset_id === asset.asset_id ? result : item)); };
  const relocateAsset = async (asset: Asset) => { const result = await window.desktop.relocateAsset({ asset_id: asset.asset_id }); if (result) setAssets(items => items.map(item => item.asset.asset_id === asset.asset_id ? { asset: result.asset, media_url: result.media_url } : item)); };
  const previewFromLibrary = (item: AssetPresentation) => {
    if (!item.media_url) return;
    setLibraryPreviewId(item.asset.asset_id);
    setPreviewMode("interactive");
    setExportPlayback(undefined);
    setPlaying(true);
  };
  const exitLibraryPreview = () => { if (libraryPreviewId) setLibraryPreviewId(null); };
  const isDraggableAsset = (kind: AssetKind) => kind === "video" || kind === "image" || kind === "audio";
  const assetThumb = (item: AssetPresentation) => (
    <div className="asset-thumb">
      {item.asset.kind === "image"
        ? <img src={item.media_url ?? undefined} alt="" loading="lazy" />
        : item.asset.kind === "video"
          ? <video src={item.media_url ?? undefined} muted preload="metadata" aria-hidden="true" />
          : <FileAudio className="asset-thumb-icon" aria-hidden="true" />}
      <span className={`availability ${item.asset.availability}`}>{availabilityLabels[item.asset.availability]}</span>
    </div>
  );
  const assetActions = (item: AssetPresentation) => (
    <div className="asset-actions"><IconButton label="刷新" onClick={() => void refreshAsset(item.asset)}><RefreshCw /></IconButton><IconButton label="重新定位" onClick={() => void relocateAsset(item.asset)}><MapPin /></IconButton>{isTranscribable(item.asset) && <IconButton label="转录" onClick={() => startTranscription(item.asset)}><FileAudio /></IconButton>}{isDraggableAsset(item.asset.kind) && <IconButton label={`追加 ${item.asset.display_name}`} disabled={item.asset.availability !== "available"} onClick={() => insertAsset(item)}><Plus /></IconButton>}</div>
  );
  const assetDragProps = (item: AssetPresentation) => ({
    draggable: isDraggableAsset(item.asset.kind),
    onDragStart: (event: React.DragEvent) => { if (isDraggableAsset(item.asset.kind)) { event.dataTransfer.setData("application/x-vortex-cut-asset", item.asset.asset_id); event.dataTransfer.effectAllowed = "copy"; } },
    title: isDraggableAsset(item.asset.kind) ? "拖到 V1 时间线以插入；双击在预览播放" : undefined,
  });
  // 点击预览画面：选中播放头处的片段（剪映式选中），无片段时清空选择。
  const selectClipAtPlayhead = () => {
    exitLibraryPreview();
    setSelection(clipAtPlayhead ? { kind: "clip", id: clipAtPlayhead.clip_id } : null);
  };
  const previewSelected = Boolean(selectedClip && !libraryPreviewId);
  const openModel = async (model: ModelSummary) => { const detail = await window.desktop.getModel(model.model_id); setConfirmModel(detail); setLicenseAccepted(!detail.license.acceptance_required); };
  const downloadModel = async () => { if (!confirmModel) return; const result = await window.desktop.downloadModel({ model_id: confirmModel.model_id, license_acceptance: confirmModel.license.acceptance_required ? confirmModel.license.id : null }); setModels(items => items.map(item => item.model_id === result.model.model_id ? result.model : item)); setJobs(items => [result.job, ...items]); setConfirmModel(undefined); };
  const cancelModel = async (model: ModelSummary) => { const result = await window.desktop.cancelModelDownload(model.model_id); setModels(items => items.map(item => item.model_id === result.model.model_id ? result.model : item)); setJobs(items => [result.job, ...items.filter(item => item.job_id !== result.job.job_id)]); };
  const startTranscription = (asset: Asset) => { const ready = models.find(model => model.status === "ready" && model.provider_status === "installed"); if (!ready) { const candidate = models[0]; if (candidate) void openModel(candidate); else setNotice("当前没有可用的本地 ASR 模型"); return; } setTranscriptionAsset(asset); };
  const submitTranscription = async () => { if (!transcriptionAsset) return; const model = models.find(item => item.status === "ready" && item.provider_status === "installed"); if (!model) return; const result = await window.desktop.createTranscription({ asset_id: transcriptionAsset.asset_id, model_id: model.model_id, language, word_timestamps: wordTimestamps, license_acceptance: null }); setJobs(items => [result.job, ...items]); setTranscriptionAsset(undefined); };
  const retryTranscription = async (job: Job) => { if (!job.asset_id || !job.model_id) return; const result = await window.desktop.createTranscription({ asset_id: job.asset_id, model_id: job.model_id, language: "auto", word_timestamps: true, license_acceptance: null }); setJobs(items => [result.job, ...items]); };
  const cancelJob = async (job: Job) => { const updated = await window.desktop.cancelJob(job.job_id); setJobs(items => items.map(item => item.job_id === updated.job_id ? updated : item)); };
  const viewTranscript = async (summary: TranscriptSummary) => setViewingTranscript(await window.desktop.getTranscript(summary.transcript_id));
  const undoRedo = async (kind: "undo" | "redo") => { if (!project || !timeline) return; setSaveState("保存中"); try { acceptState(await window.desktop[kind === "undo" ? "undoTimeline" : "redoTimeline"]({ project_id: project.project_id, base_revision_id: timeline.current_revision.timeline_revision_id })); } catch (error) { await handleConflict(error); } };

  const trackRenderJob = (job: Job) => {
    setJobs(items => [job, ...items.filter(item => item.job_id !== job.job_id)]);
    const unsubscribe = window.desktop.subscribeJob(job.job_id, updated => {
      setJobs(items => [updated, ...items.filter(item => item.job_id !== updated.job_id)]);
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(updated.status)) {
        unsubscribe();
        if (project) void loadRenderData(project).catch(error => setNotice(safeErrorMessage(error, "渲染记录加载失败，请刷新后重试。")));
      }
    });
  };
  const generatePreview = async () => {
    if (!project || !timeline || !working?.clips.length) return;
    if (timeline.draft) { setNotice("请先提交或丢弃草稿，再生成权威预览。"); return; }
    try {
      const result = await window.desktop.createPreview({ project_id: project.project_id, preview: { timeline_revision_id: timeline.current_revision.timeline_revision_id, encoder_mode: encoderMode } });
      if (result.preview) {
        setPreviews(items => [result.preview!, ...items.filter(item => item.preview.render_artifact_id !== result.preview!.preview.render_artifact_id)]);
        setPreviewMode("authoritative");
      }
      if (result.job) { trackRenderJob(result.job); setRenderPanelOpen(true); }
    } catch (error) { setNotice(safeErrorMessage(error, "操作未完成，请刷新后重试。")); }
  };
  const createExport = async () => {
    if (!project || !timeline || !working?.clips.length) return;
    if (timeline.draft) { setNotice("请先提交或丢弃草稿，再导出正式 Revision。"); return; }
    try {
      const grant = await window.desktop.chooseExportDestination(project.project_id);
      if (!grant) return;
      const result = await window.desktop.createExport({ project_id: project.project_id, export: { timeline_revision_id: timeline.current_revision.timeline_revision_id, destination_grant_id: grant.destination_grant_id, encoder_mode: encoderMode } });
      if (result.export_record) setExports(items => [result.export_record!, ...items.filter(item => item.export_record.export_record_id !== result.export_record!.export_record.export_record_id)]);
      trackRenderJob(result.job);
      setRenderPanelOpen(true);
    } catch (error) { setNotice(safeErrorMessage(error, "操作未完成，请刷新后重试。")); }
  };
  const targetPreview = (target: RenditionTarget) => renditionPreviews.find(item => item.preview.platform_preset_id === target.platform_preset_id && item.preview.rendition_preset_id === target.rendition_preset_id && item.preview.layout_policy === target.layout_policy && item.preview.timeline_revision_id === timeline?.current_revision.timeline_revision_id && item.preview.status === "ready");
  const openExportBatch = async () => {
    if (!project || !timeline || timeline.draft) { setNotice("请先提交或丢弃草稿，再创建多平台导出。"); return; }
    try {
      setBatchError(""); setBatchOpen(true);
      const [platforms, renditions, previews, batches, reframeBatches] = await Promise.all([window.desktop.listPlatformPresets(), window.desktop.listRenditionPresets(), window.desktop.listRenditionPreviews({ project_id: project.project_id, limit: 100 }), window.desktop.listExportBatches({ project_id: project.project_id, limit: 20 }), window.desktop.listReframeExportBatches({ project_id: project.project_id, limit: 20 })]);
      setPlatformPresets(platforms.items); setRenditionPresets(renditions.items); setRenditionPreviews(previews.items); setActiveBatch(batches.items[0]); setActiveReframeBatch(reframeBatches.items[0]);
      if (!renditionTargets.length && platforms.items[0]) setRenditionTargets([{ key: `${platforms.items[0].platform_preset_id}:${platforms.items[0].default_rendition_id}`, platform_preset_id: platforms.items[0].platform_preset_id, rendition_preset_id: platforms.items[0].default_rendition_id, layout_policy: "preserve_timeline" }]);
    } catch { setBatchError("无法加载平台预设或批次状态。"); }
  };
  const addTarget = () => {
    const platform = platformPresets[0]; if (!platform || renditionTargets.length >= 8) return;
    const available = platform.allowed_rendition_ids.find(id => !renditionTargets.some(target => target.platform_preset_id === platform.platform_preset_id && target.rendition_preset_id === id));
    if (!available) return;
    setRenditionTargets(items => [...items, { key: `${platform.platform_preset_id}:${available}`, platform_preset_id: platform.platform_preset_id, rendition_preset_id: available, layout_policy: "preserve_timeline" }]);
  };
  const updateTarget = (key: string, update: Partial<RenditionTarget>) => {
    setRenditionTargets(items => items.map(item => item.key === key ? { ...item, ...update } : item));
    setReframeSelections(current => { const next = { ...current }; delete next[key]; return next; });
    setReframePreviews(current => { const next = { ...current }; delete next[key]; return next; });
    setReframePending(current => { const next = { ...current }; delete next[key]; return next; });
    setReframeDirectoryGrant(undefined);
  };
  const generateRenditionPreview = async (target: RenditionTarget) => {
    if (!project || !timeline) return;
    try {
      const result = await window.desktop.createRenditionPreview({ project_id: project.project_id, preview: { timeline_revision_id: timeline.current_revision.timeline_revision_id, platform_preset_id: target.platform_preset_id as never, rendition_preset_id: target.rendition_preset_id as never, layout_policy: target.layout_policy, encoder_mode: encoderMode } });
      if (result.preview) setRenditionPreviews(items => [result.preview!, ...items.filter(item => item.preview.render_artifact_id !== result.preview!.preview.render_artifact_id)]);
      if (result.job) trackRenderJob(result.job);
    } catch (error) { setBatchError(safeErrorMessage(error, "生成权威预览失败。")); }
  };
  const chooseBatchDirectory = async () => { if (!project) return; try { setDirectoryGrant((await window.desktop.chooseExportDirectory(project.project_id)) ?? undefined); } catch { setBatchError("选择导出目录失败。"); } };
  const createBatch = async () => {
    if (!project || !timeline || !directoryGrant || renditionTargets.some(target => !targetPreview(target))) return;
    try {
      const result = await window.desktop.createExportBatch({ project_id: project.project_id, batch: { timeline_revision_id: timeline.current_revision.timeline_revision_id, directory_grant_id: directoryGrant.directory_grant_id, items: renditionTargets.map(target => ({ rendition_snapshot_id: targetPreview(target)!.preview.rendition_snapshot_id, preview_artifact_id: targetPreview(target)!.preview.render_artifact_id, encoder_mode: encoderMode })) } });
      setActiveBatch(result.batch); setDirectoryGrant(undefined); result.jobs.forEach(trackRenderJob);
    } catch (error) { setBatchError(safeErrorMessage(error, "创建批次失败。")); }
  };
  const retryBatchItems = async () => {
    if (!activeBatch || !project) return;
    const retryable = activeBatch.items.filter(item => ["failed", "cancelled", "interrupted"].includes(item.status));
    if (!retryable.length) return;
    try { const grant = await window.desktop.chooseExportDirectory(project.project_id); if (!grant) return; const result = await window.desktop.retryExportBatch({ batch_id: activeBatch.export_batch_id, retry: { directory_grant_id: grant.directory_grant_id, export_batch_item_ids: retryable.map(item => item.export_batch_item_id) } }); setActiveBatch(result.batch); result.jobs.forEach(trackRenderJob); }
    catch (error) { setBatchError(safeErrorMessage(error, "重试批次失败。")); }
  };
  const reframeClips = (target: RenditionTarget): TimelineClip[] => {
    if (!working) return [];
    if (target.layout_policy === "crop_fill_all") return working.clips;
    if (target.layout_policy === "preserve_timeline") return working.clips.filter(clip => clip.layout === "crop_fill");
    return [];
  };
  const targetAdjustments = (target: RenditionTarget): RenditionReframeAdjustment[] => Object.entries(reframeSelections[target.key] ?? {}).map(([clip_id, anchor]) => ({ clip_id: clip_id as never, ...anchor }));
  const selectReframeAnchor = (target: RenditionTarget, clipId: string, anchor: ReframeAnchor) => {
    setReframeSelections(current => {
      const targetSelections = { ...(current[target.key] ?? {}) };
      if (anchor.horizontal_anchor === "center" && anchor.vertical_anchor === "center") delete targetSelections[clipId];
      else targetSelections[clipId] = anchor;
      return { ...current, [target.key]: targetSelections };
    });
    setReframePreviews(current => { const next = { ...current }; delete next[target.key]; return next; });
    setReframePending(current => { const next = { ...current }; delete next[target.key]; return next; });
    setReframeDirectoryGrant(undefined);
  };
  const generateReframePreview = async (target: RenditionTarget) => {
    if (!project) return;
    const base = targetPreview(target); const adjustments = targetAdjustments(target);
    if (!base || !adjustments.length) return;
    setReframeError("");
    try {
      const result = await window.desktop.createRenditionReframePreview({ project_id: project.project_id, preview: { base_rendition_snapshot_id: base.preview.rendition_snapshot_id, adjustments, encoder_mode: encoderMode } });
      if (result.preview) { setReframePreviews(current => ({ ...current, [target.key]: result.preview! })); setReframePending(current => { const next = { ...current }; delete next[target.key]; return next; }); }
      if (result.job) {
        const job = result.job;
        const snapshotId = typeof job.input.rendition_reframe_snapshot_id === "string" ? job.input.rendition_reframe_snapshot_id : "";
        if (snapshotId) setReframePending(current => ({ ...current, [target.key]: snapshotId }));
        setJobs(items => [job, ...items.filter(item => item.job_id !== job.job_id)]);
        const unsubscribe = window.desktop.subscribeJob(job.job_id, updated => {
          setJobs(items => [updated, ...items.filter(item => item.job_id !== updated.job_id)]);
          if (!["succeeded", "failed", "cancelled", "interrupted"].includes(updated.status)) return;
          unsubscribe();
          setReframePending(current => { const next = { ...current }; delete next[target.key]; return next; });
          if (updated.status === "succeeded" && snapshotId) void window.desktop.listRenditionReframePreviews({ project_id: project.project_id, limit: 100 }).then(page => {
            const ready = page.items.find(item => item.preview.rendition_reframe_snapshot_id === snapshotId && item.preview.status === "ready");
            if (ready) setReframePreviews(current => ({ ...current, [target.key]: ready }));
          }).catch(() => setReframeError("重构图预览已完成，但刷新失败。"));
          else if (updated.status !== "succeeded") setReframeError("重构图预览未完成，请稍后刷新任务状态。");
        });
      }
    } catch (error) { setReframeError(safeErrorMessage(error, "生成重构图预览失败。")); }
  };
  const chooseReframeDirectory = async () => { if (!project) return; try { setReframeDirectoryGrant((await window.desktop.chooseExportDirectory(project.project_id)) ?? undefined); } catch { setReframeError("选择重构图导出目录失败。"); } };
  const createReframeBatch = async () => {
    if (!project || !reframeDirectoryGrant || renditionTargets.some(target => !reframePreviews[target.key] || !targetAdjustments(target).length)) return;
    try {
      const result = await window.desktop.createReframeExportBatch({ project_id: project.project_id, batch: { directory_grant_id: reframeDirectoryGrant.directory_grant_id, items: renditionTargets.map(target => ({ rendition_reframe_snapshot_id: reframePreviews[target.key].preview.rendition_reframe_snapshot_id, preview_artifact_id: reframePreviews[target.key].preview.render_artifact_id, encoder_mode: encoderMode })) } });
      setActiveReframeBatch(result.batch); setReframeDirectoryGrant(undefined); result.jobs.forEach(trackRenderJob);
    } catch (error) { setReframeError(safeErrorMessage(error, "创建重构图批次失败。")); }
  };
  const retryReframeBatchItems = async () => {
    if (!activeReframeBatch || !project) return;
    const retryable = activeReframeBatch.items.filter(item => ["failed", "cancelled", "interrupted"].includes(item.status));
    if (!retryable.length) return;
    try { const grant = await window.desktop.chooseExportDirectory(project.project_id); if (!grant) return; const result = await window.desktop.retryReframeExportBatch({ batch_id: activeReframeBatch.reframe_export_batch_id, retry: { directory_grant_id: grant.directory_grant_id, reframe_export_batch_item_ids: retryable.map(item => item.reframe_export_batch_item_id) } }); setActiveReframeBatch(result.batch); result.jobs.forEach(trackRenderJob); }
    catch (error) { setReframeError(safeErrorMessage(error, "重试重构图批次失败。")); }
  };

  const previewLayout = selectedClip?.layout ?? working?.clips[0]?.layout ?? "fit";
  const nativeInfo = previewAsset?.asset.media_info as MediaInfo | null | undefined;
  const nativeStream = nativeInfo && "video_streams" in nativeInfo ? nativeInfo.video_streams[0] : undefined;
  const nativeRatio = nativeStream?.width && nativeStream?.height && nativeStream.width > 0 && nativeStream.height > 0 ? nativeStream.width / nativeStream.height : null;
  const autoRatio = nativeRatio ? (Math.abs(nativeRatio - 16 / 9) < 0.05 ? "169" : Math.abs(nativeRatio - 9 / 16) < 0.05 ? "916" : Math.abs(nativeRatio - 1) < 0.05 ? "11" : Math.abs(nativeRatio - 4 / 3) < 0.05 ? "43" : Math.abs(nativeRatio - 3 / 4) < 0.05 ? "34" : "fit") : "fit";
  const effectiveRatio = previewRatioTouched ? previewRatio : autoRatio;
  const previewClass = `${previewLayout} ratio-${effectiveRatio}`;
  const authoritativePreview = previews.find(item => item.preview.timeline_revision_id === timeline?.current_revision.timeline_revision_id) ?? previews[0];
  const previewIsStale = Boolean(authoritativePreview && (authoritativePreview.preview.status === "stale" || authoritativePreview.preview.timeline_revision_id !== timeline?.current_revision.timeline_revision_id));
  const firstMediaAsset = assets.find(item => (item.asset.kind === "video" || item.asset.kind === "image") && item.asset.availability === "available");
  const firstTranscribableAsset = assets.find(item => isTranscribable(item.asset));
  useEffect(() => { setGenerationOpen(false); setShotRequirementsOpen(false); }, [project?.project_id]);

  const authoritativeMediaUrl = reframePlayback?.media_url ?? exportPlayback?.media_url ?? authoritativePreview?.media_url;
  const renderDisabledReason = !timeline || !working?.clips.length ? "时间线为空" : timeline.draft ? "存在未提交草稿，请先形成正式 Revision" : undefined;
  const renderJobs = jobs.filter(item => item.kind === "authoritative_preview" || item.kind === "final_export");
  const renderActivity = renderJobs.filter(item => ["queued", "running", "cancelling"].includes(item.status)).length;

  const filteredCommands = useMemo(() => {
    const q = commandQuery.trim().toLocaleLowerCase();
    return q ? editorCommands.filter(command => command.label.toLocaleLowerCase().includes(q) || command.id.toLocaleLowerCase().includes(q)) : editorCommands;
  }, [commandQuery]);

  const commandDisabledReason = (id: EditorCommand["id"]): string | undefined => {
    switch (id) {
      case "play.pause": return previewAsset?.media_url ? undefined : "需要预览素材";
      case "timeline.undo": return timeline?.can_undo ? undefined : "没有可撤销的操作";
      case "timeline.redo": return timeline?.can_redo ? undefined : "没有可重做的操作";
      case "timeline.split": if (!timeline) return "需要时间线"; if (!selectedClip) return "请先选择时间线片段"; return undefined;
      case "timeline.copy": if (!timeline) return "需要时间线"; if (selectedClips.length === 0) return "请先选择要复制的片段"; return undefined;
      case "timeline.cut": if (!timeline) return "需要时间线"; if (selectedClips.length === 0 && !selectedCaption) return "请先选择要剪切的片段"; return undefined;
      case "timeline.paste": if (!clipboardClips.current.length) return "剪贴板为空，请先复制片段"; if (!project || !timeline) return "需要项目和时间线"; return insertableClipboardAssets(clipboardClips.current).length === clipboardClips.current.length ? undefined : "部分素材不可用或类型不支持粘贴";
      case "timeline.delete": if (!timeline) return "需要时间线"; if (selectedClips.length === 0 && !selectedCaption) return "请先选择要删除的对象"; return undefined;
      case "preview.generate": return renderDisabledReason ?? undefined;
      case "export.open": return undefined;
      case "ai.open": return project && timeline ? undefined : "需要项目和时间线";
      case "command.search": return undefined;
      default: return "未知命令";
    }
  };

  const runCommand = (id: EditorCommand["id"]) => {
    if (commandDisabledReason(id)) return;
    switch (id) {
      case "play.pause": setPlaying(value => !value); break;
      case "timeline.undo": void undoRedo("undo"); break;
      case "timeline.redo": void undoRedo("redo"); break;
      case "timeline.split":
        if (selectedClip) void patchTimeline([{ op: "split_clip", clip_id: selectedClip.clip_id, source_time_us: selectedClip.source_start_us! + Math.floor((selectedClip.source_end_us! - selectedClip.source_start_us!) / 2) }], "拆分片段");
        break;
      case "timeline.copy": {
        const snapshot = selectedClips
          .filter(item => item.track_id === "V1" && (item.asset_kind === "video" || item.asset_kind === "image"))
          .map(item => ({
            asset_id: item.asset_id,
            asset_kind: item.asset_kind as "video" | "image",
            source_start_us: item.source_start_us,
            source_end_us: item.source_end_us,
            speed_milli: item.speed_milli ?? 1000,
            reverse_playback: item.reverse_playback ?? false,
            layout: item.layout,
          }));
        clipboardClips.current = snapshot;
        if (snapshot.length) setNotice(`已复制 ${snapshot.length} 个片段（应用内剪贴板）。`);
        break;
      }
      case "timeline.cut": {
        // 复用复制快照逻辑后按删除路径移除（撤销可恢复）。
        const snapshot = selectedClips
          .filter(item => item.track_id === "V1" && (item.asset_kind === "video" || item.asset_kind === "image") && !working?.locked_elements?.includes(item.clip_id))
          .map(item => ({
            asset_id: item.asset_id,
            asset_kind: item.asset_kind as "video" | "image",
            source_start_us: item.source_start_us,
            source_end_us: item.source_end_us,
            speed_milli: item.speed_milli ?? 1000,
            reverse_playback: item.reverse_playback ?? false,
            layout: item.layout,
          }));
        const deletable = selectedClips.filter(item => !working?.locked_elements?.includes(item.clip_id));
        if (!deletable.length) break;
        clipboardClips.current = snapshot;
        void patchTimeline(deletable.map(item => ({ op: "remove_clip", clip_id: item.clip_id })), "剪切片段").then(() => setNotice(`已剪切 ${deletable.length} 个片段（Ctrl+V 粘贴）。`));
        break;
      }
      case "timeline.paste": {
        const insertable = insertableClipboardAssets(clipboardClips.current);
        if (!project || !timeline || !insertable.length) return;
        // 粘贴位置：播放头处片段的 V1 序号（无片段则取播放头前序，末端追加为兜底）。
        const pasteIndex = (() => {
          const atHead = v1Clips.findIndex(c => playhead >= c.timeline_start_us && playhead < c.timeline_end_us);
          if (atHead >= 0) return atHead + 1;
          const before = v1Clips.filter(c => c.timeline_end_us <= playhead).length;
          return Math.min(before, v1Clips.length);
        })();
        let cursor = pasteIndex;
        const operations: TimelinePatchOperation[] = insertable.map(snapshot => ({
          op: "insert_asset_clip",
          asset_id: snapshot.asset_id,
          at_index: cursor++,
          ...(snapshot.asset_kind === "image"
            ? { duration_us: 3_000_000 }
            : { source_start_us: snapshot.source_start_us ?? undefined, source_end_us: snapshot.source_end_us ?? undefined, speed_milli: snapshot.speed_milli !== 1000 ? snapshot.speed_milli : undefined, reverse_playback: snapshot.reverse_playback || undefined }),
        }));
        void patchTimeline(operations, "粘贴片段").then(() => setNotice("已粘贴到播放头位置。"));
        break;
      }
      case "timeline.delete":
        if (selectedCaption) void patchTimeline([{ op: "remove_caption", caption_id: selectedCaption.caption_id }], "删除字幕");
        else if (selectedClips.length > 0) {
          const deletable = selectedClips.filter(item => !working?.locked_elements?.includes(item.clip_id));
          if (deletable.length > 0) void patchTimeline(deletable.map(item => ({ op: "remove_clip", clip_id: item.clip_id })), "删除片段");
        }
        break;
      case "preview.generate": void generatePreview(); break;
      case "export.open": setRenderPanelOpen(true); break;
      case "ai.open": void openAi(); break;
      case "command.search": setCommandSearchOpen(true); break;
    }
  };

  const closeCommandSearch = () => { setCommandSearchOpen(false); setCommandQuery(""); setCommandIndex(0); };

  const handleCommandPaletteKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setCommandIndex(index => Math.min(index + 1, filteredCommands.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setCommandIndex(index => Math.max(index - 1, 0)); }
    else if (event.key === "Enter") {
      event.preventDefault();
      const command = filteredCommands[commandIndex];
      if (command && !commandDisabledReason(command.id)) { runCommand(command.id); closeCommandSearch(); }
    }
  };

  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyHandlerRef.current = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
    if (commandSearchOpen) return;
    // 按钮聚焦时保留原生激活语义：Space/Enter 触发按钮而非播放头。
    if (tag === "BUTTON" && (event.key === " " || event.key === "Enter")) return;
    const key = (event.key ?? "").toLowerCase();
    const inTimeline = Boolean(target?.closest?.(".timeline-pane"));
    // C3：固定别名（不进自定义表）——Ctrl+Shift+Z 重做、Backspace 删除。
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "z") { event.preventDefault(); runCommand("timeline.redo"); return; }
    if (!(event.ctrlKey || event.metaKey) && key === "backspace" && inTimeline) { event.preventDefault(); runCommand("timeline.delete"); return; }
    // 方向键逐帧步进（C1）：1 帧，Shift 加速 5 帧。
    if (!(event.ctrlKey || event.metaKey) && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      if (inTimeline) {
        event.preventDefault();
        const frameUs = Math.round(1_000_000 / (working?.canvas.fps_num && working.canvas.fps_den ? working.canvas.fps_num / working.canvas.fps_den : 30));
        const step = frameUs * (event.shiftKey ? 5 : 1);
        exitLibraryPreview();
        setPlayhead(value => Math.max(0, Math.min(duration(working), value + (event.key === "ArrowRight" ? step : -step))));
      }
      return;
    }
    // C3：自定义快捷键注册表命中检测（顺序即注册表定义顺序）。
    for (const [commandId, entry] of Object.entries(shortcutsRef.current) as Array<[ShortcutCommandId, ShortcutEntry]>) {
      if (matchesBinding(event, entry.binding)) {
        // Delete/播放暂停仅在时间线聚焦时生效（防全局误触）。
        if ((commandId === "timeline.delete" || commandId === "play.pause") && !inTimeline) continue;
        event.preventDefault();
        runCommand(commandId);
        return;
      }
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandlerRef.current?.(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    if (!activeMenu) return;
    const target = menuActionRefs.current[dropdownIndex];
    if (target) target.focus();
  }, [activeMenu, dropdownIndex]);

  useEffect(() => {
    if (!ratioMenuOpen) return;
    const listener = (event: MouseEvent) => {
      if (ratioMenuRef.current && !ratioMenuRef.current.contains(event.target as Node)) setRatioMenuOpen(false);
    };
    window.addEventListener("mousedown", listener);
    return () => window.removeEventListener("mousedown", listener);
  }, [ratioMenuOpen]);
  useEffect(() => {
    if (!projectSwitcherOpen) return;
    const listener = (event: MouseEvent) => {
      if (projectSwitcherRef.current && !projectSwitcherRef.current.contains(event.target as Node)) setProjectSwitcherOpen(false);
    };
    window.addEventListener("mousedown", listener);
    return () => window.removeEventListener("mousedown", listener);
  }, [projectSwitcherOpen]);

  const menuShortcut = (label: string): string | undefined => {
      const command = editorCommands.find(item => item.label === label);
      if (!command) return undefined;
      const entry = (shortcutsRef.current as Record<string, ShortcutEntry>)[command.id as ShortcutCommandId];
      return entry ? bindingLabel(entry.binding) : undefined;
    };

  type MenuEntry = { label: string; action: () => void; disabled?: boolean } | { divider: true };
  const isMenuDivider = (entry: MenuEntry): entry is { divider: true } => "divider" in entry;
  const menuActions = (menu: string) => menuItems[menu].filter((entry): entry is { label: string; action: () => void; disabled?: boolean } => !isMenuDivider(entry));

  const handleMenuBarKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const menus = Object.keys(menuItems);
    const currentIndex = menus.indexOf(activeMenu ?? menus[menuIndex] ?? "");
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const nextIndex = activeMenu ? (currentIndex + delta + menus.length) % menus.length : menuIndex;
      setMenuIndex(nextIndex);
      setActiveMenu(menus[nextIndex]);
      setDropdownIndex(0);
    } else if (event.key === "ArrowDown" && activeMenu) {
      event.preventDefault();
      const count = menuActions(activeMenu).length;
      setDropdownIndex(index => count ? (index + 1) % count : 0);
    } else if (event.key === "ArrowUp" && activeMenu) {
      event.preventDefault();
      const count = menuActions(activeMenu).length;
      setDropdownIndex(index => count ? (index - 1 + count) % count : 0);
    } else if (event.key === "Enter" && activeMenu) {
      event.preventDefault();
      const item = menuActions(activeMenu)[dropdownIndex];
      if (item && !item.disabled) { item.action(); setActiveMenu(null); }
    } else if (event.key === "Escape") {
      setActiveMenu(null);
      menuButtonRefs.current[menuIndex]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      setMenuIndex(0);
      if (activeMenu) setDropdownIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setMenuIndex(menus.length - 1);
      if (activeMenu) setDropdownIndex(Math.max(0, menuActions(activeMenu).length - 1));
    }
  };

  const menuItems: Record<string, MenuEntry[]> = {
    项目: [{ label: "项目管理", action: () => setProjectDialogOpen(true) }, { label: "刷新项目", action: () => void refreshProjects() }],
    编辑: [{ label: "撤销", action: () => void undoRedo("undo"), disabled: !timeline?.can_undo }, { label: "重做", action: () => void undoRedo("redo"), disabled: !timeline?.can_redo }],
    时间线: [{ label: "创建空时间线", action: () => void createTimeline({ kind: "empty" }), disabled: !project || Boolean(timeline) }, { divider: true }, { label: "拆分所选片段", action: () => selectedClip && void patchTimeline([{ op: "split_clip", clip_id: selectedClip.clip_id, source_time_us: selectedClip.source_start_us! + Math.floor((selectedClip.source_end_us! - selectedClip.source_start_us!) / 2) }], "拆分片段"), disabled: !selectedClip }, { divider: true }, { label: "生成预览", action: () => void generatePreview(), disabled: Boolean(renderDisabledReason) }, { label: "导出", action: () => void createExport(), disabled: Boolean(renderDisabledReason) }],
    界面: [{ label: "恢复默认布局", action: () => { setLeftWidth(280); setRightWidth(300); setTimelineHeight(230); } }, { label: "命令搜索", action: () => setCommandSearchOpen(true) }, { label: "快捷键设置", action: () => setShortcutsOpen(true) }],
    工具: [{ label: "AI 粗剪", action: () => void openAi(), disabled: !project || !timeline }, { label: "AI 修改", action: () => void openPatch(), disabled: !timeline }, { label: "版本比较", action: () => void openRevisionCompare(), disabled: !project }, { divider: true }, { label: "镜头需求", action: () => setShotRequirementsOpen(true), disabled: !project || project.status !== "active" }, { label: "生成验证（模拟）", action: () => setGenerationOpen(true), disabled: !project || project.status !== "active" }, { label: "真实图片生成", action: () => setProviderImageGenerationOpen(true), disabled: !project || project.status !== "active" }],
    帮助: [{ label: "用户使用手册", action: () => setNotice("请查看 docs/VORTEX_CUT_USER_MANUAL.md") }]
  };
  return <main className="editor-shell" style={{ "--left-width": `${leftWidth}px`, "--right-width": `${rightWidth}px`, "--timeline-height": `${timelineHeight}px` } as React.CSSProperties} onClick={() => activeMenu && setActiveMenu(null)}>
    <div className="editor-titlebar"><div className="custom-titlebar-drag"><div className="brand-lockup"><strong>Vortex Cut</strong></div><nav className="menu-bar" aria-label="主菜单" onKeyDown={handleMenuBarKeyDown}>{Object.keys(menuItems).map((menu, menuPosition) => <div className="menu-item" key={menu}><button ref={element => { menuButtonRefs.current[menuPosition] = element; }} aria-haspopup="menu" aria-expanded={activeMenu === menu} aria-controls={activeMenu === menu ? `menu-${menu}` : undefined} onClick={event => { event.stopPropagation(); setActiveMenu(activeMenu === menu ? null : menu); setDropdownIndex(0); }} onMouseEnter={() => { if (activeMenu) { setActiveMenu(menu); setDropdownIndex(0); } }}>{menu}</button>{activeMenu === menu && <div className="menu-dropdown" id={`menu-${menu}`} role="menu" aria-label={menu}>{(() => { let actionIndex = 0; const entries: React.ReactNode[] = []; for (const item of menuItems[menu]) { if (isMenuDivider(item)) { entries.push(<div key={`divider-${entries.length}`} className="menu-divider" role="separator" />); } else { const currentIndex = actionIndex; entries.push(<button key={item.label} ref={element => { menuActionRefs.current[currentIndex] = element; }} role="menuitem" disabled={item.disabled} className={currentIndex === dropdownIndex ? "focused" : ""} onMouseEnter={() => setDropdownIndex(currentIndex)} onClick={() => { item.action(); setActiveMenu(null); }}><span className="menu-item-label">{item.label}</span>{menuShortcut(item.label) && <kbd className="menu-item-shortcut">{menuShortcut(item.label)}</kbd>}</button>); actionIndex += 1; } } return entries; })()}</div>}</div>)}</nav></div><div className="titlebar-project-switcher" ref={projectSwitcherRef}><button className="titlebar-project-switcher-toggle" aria-label="切换项目" aria-haspopup="listbox" aria-expanded={projectSwitcherOpen} onClick={event => { event.stopPropagation(); setProjectSwitcherOpen(value => !value); }}><span className="titlebar-project-name">{project?.name ?? "未选择项目"}</span><ChevronDown className="titlebar-switcher-chevron" /></button>{projectSwitcherOpen && <div className="project-switcher-dropdown" role="listbox" aria-label="选择项目">{projects.map(item => <button key={item.project_id} role="option" data-project-id={item.project_id} aria-selected={item.project_id === project?.project_id} className={item.project_id === project?.project_id ? "active" : ""} onClick={event => { event.stopPropagation(); if (item.project_id !== project?.project_id) setProject(item); setProjectSwitcherOpen(false); }}><span className="project-switcher-name">{item.name}</span><span className="project-switcher-state">{item.status === "active" ? "活动" : item.status === "archived" ? "已归档" : "目录缺失"}</span></button>)}{!projects.length && <div className="project-switcher-empty">尚无项目，请先创建</div>}<div className="project-switcher-actions"><button role="menuitem" onClick={event => { event.stopPropagation(); setProjectSwitcherOpen(false); setProjectDialogOpen(true); }}>项目管理</button></div></div>}</div><div className="window-controls" aria-label="窗口控制"><button aria-label="最小化" onClick={() => void window.desktop.minimizeWindow?.()}><svg width="8" height="8" viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1" fill="currentColor"/></svg></button><button aria-label={maximized ? "还原" : "最大化"} title={maximized ? "还原" : "最大化"} onClick={() => void window.desktop.toggleMaximizeWindow?.()}>{maximized ? <svg width="8" height="8" viewBox="0 0 12 12"><path d="M3.5 3.5V1H11V8.5H8.5" fill="none" stroke="currentColor" strokeWidth="1"/><rect x="1" y="3.5" width="7.5" height="7.5" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1"/></svg> : <svg width="8" height="8" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1"/></svg>}</button><button aria-label="关闭" className="window-close" onClick={() => void window.desktop.closeWindow?.()}><svg width="8" height="8" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg></button></div></div>
    <div className="banner-stack">{notice && <div className="notice" role="alert">{notice}</div>}{timeline?.draft && <div className="draft-banner"><span>{timeline.draft.conflict ? "检测到冲突草稿" : "检测到上次未恢复草稿"}</span><button disabled={timeline.draft.conflict} onClick={() => { setWorking(timeline.draft!.document); setSaveState("已保存"); }}>恢复</button><button onClick={() => void (async () => { await window.desktop.deleteTimelineDraft(project!.project_id); setTimeline({ ...timeline, draft: null }); })()}>丢弃</button></div>}</div>
    <section className="editor-grid">
      <section className="library-pane" aria-label="媒体库">
        <div className="tabs"><button className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>素材</button><button className={tab === "transcripts" ? "active" : ""} onClick={() => setTab("transcripts")}>转录</button></div>
        {tab === "assets" ? <><h2 className="pane-title">素材工作区</h2><div className="library-toolbar">{assetKinds.map(kind => <button key={kind} disabled={!project || project.status !== "active"} onClick={() => void importAsset(kind)}>{kind === "video" ? <Video /> : kind === "audio" ? <FileAudio /> : kind === "image" ? <ImagePlus /> : <FileText />}导入{assetKindLabels[kind]}</button>)}</div><div className="library-filter-toolbar"><input role="searchbox" type="search" aria-label="搜索素材" placeholder="搜索素材" value={assetQuery} onChange={event => setAssetQuery(event.target.value)} /><select aria-label="素材类型" value={assetFilter} onChange={event => setAssetFilter(event.target.value as AssetFilter)}><option value="all">全部</option>{assetKinds.map(kind => <option value={kind} key={kind}>{assetKindLabels[kind]}</option>)}</select><span className="asset-count" aria-label="素材数量">共 {visibleAssets.length} 项</span><button className="asset-view-toggle" aria-label={assetView === "list" ? "切换为缩略图视图" : "切换为列表视图"} onClick={() => setAssetView(value => value === "list" ? "grid" : "list")}>{assetView === "list" ? <LayoutGrid /> : <List />}</button></div><div className={`asset-list ${assetView === "list" ? "asset-table" : "asset-grid"}`}>{visibleAssets.map(item => assetView === "list" ? <div className={`asset-item asset-row ${isDraggableAsset(item.asset.kind) ? "draggable-asset" : ""}`} key={item.asset.asset_id} onDoubleClick={() => previewFromLibrary(item)} {...assetDragProps(item)}><div className="asset-name"><strong title={item.asset.display_name}>{item.asset.display_name}</strong><small>受管媒体 · {assetKindLabels[item.asset.kind]}</small><span className={`availability ${item.asset.availability}`}>{availabilityLabels[item.asset.availability]}</span></div>{assetActions(item)}</div> : <div className={`asset-item asset-card ${isDraggableAsset(item.asset.kind) ? "draggable-asset" : ""}`} key={item.asset.asset_id} onDoubleClick={() => previewFromLibrary(item)} {...assetDragProps(item)}>{assetThumb(item)}<div className="asset-card-name"><strong title={item.asset.display_name}>{item.asset.display_name}</strong><small>{assetKindLabels[item.asset.kind]}</small></div>{assetActions(item)}</div>)}</div><section className="legacy-section model-panel"><h2>本地转录模型</h2><p className="panel-hint">本地语音识别模型：下载后可在视频/音频素材上发起转录，生成带时间戳的字幕底稿；下载中可取消，失败可重试。</p>{models.map(model => <div className="model-row" key={model.model_id}><div><strong>{model.display_name}</strong><small>{modelStatusLabels[model.status]} · {model.provider}</small>{["queued", "downloading", "verifying", "paused"].includes(model.status) && <progress max="1" value={model.progress ?? 0} />}</div><div>{["unavailable", "failed", "cancelled", "paused"].includes(model.status) && <button onClick={() => void openModel(model)}>{model.status === "failed" ? "重试下载" : model.status === "paused" ? "继续下载" : "下载模型"}</button>}{["queued", "downloading", "verifying", "paused"].includes(model.status) && <IconButton label="取消模型下载" onClick={() => void cancelModel(model)}><Square /></IconButton>}</div></div>)}</section><section className="legacy-section jobs-panel"><h2>任务</h2>{jobs.length === 0 && <p className="panel-hint">暂无任务。转录、权威预览与导出的后台进度会显示在这里；运行中的任务可取消，失败的转录可重试。</p>}{jobs.map(job => <div className="job-row" key={job.job_id}><div><strong>{job.kind === "transcription" ? "本地转录" : job.kind === "proxy" ? "代理素材" : job.kind}</strong><small>{jobStatusLabels[job.status]} · {job.stage}{job.status === "running" && job.progress !== null ? ` · ${Math.round(job.progress * 100)}%` : ""}</small>{job.status === "running" && <JobEta job={job} />}</div><div>{job.kind === "transcription" && (job.status === "failed" || job.status === "interrupted") && <button onClick={() => void retryTranscription(job)}>重试转录</button>}{["queued", "running", "cancelling"].includes(job.status) && <IconButton label="取消任务" onClick={() => void cancelJob(job)}><Square /></IconButton>}</div></div>)}</section></> : <div className="transcript-list"><h2 className="pane-title">原始转录</h2><p className="panel-hint">只读展示语音识别结果；勾选片段后点"追加所选片段"，会把它们插入时间线并生成字幕。</p>{Object.values(transcripts).flat().length === 0 && <p className="panel-hint">尚未生成转录：在"素材"页对视频/音频素材点击"转录"按钮后，结果会出现在这里。</p>}{assets.filter(item => isTranscribable(item.asset)).map(assetItem => <div className="transcript-row" key={assetItem.asset.asset_id}><strong title={assetItem.asset.display_name}>{assetItem.asset.display_name}</strong><div>{(transcriptSummaries[assetItem.asset.asset_id] ?? []).map(summary => <button key={summary.transcript_id} aria-label={`查看转录 ${summary.transcript_id}`} onClick={() => void viewTranscript(summary)}><Eye />{summary.language} · {summary.status}</button>)}</div></div>)}{Object.values(transcripts).flat().map(item => <div className="transcript-item" key={item.transcript_id}><strong>{assets.find(asset => asset.asset.asset_id === item.asset_id)?.asset.display_name ?? "转录"}</strong>{item.segments.map(segment => <SegmentRow key={segment.segment_id} segment={segment} selected={(selectedSegments[item.transcript_id] ?? []).includes(segment.segment_id)} onToggle={() => setSelectedSegments(state => ({ ...state, [item.transcript_id]: toggle(state[item.transcript_id] ?? [], segment.segment_id) }))} />)}<button onClick={() => insertSegments(item)}>追加所选片段</button></div>)}</div>}
        {!timeline && project && <div className="empty-timeline"><button onClick={() => void createTimeline({ kind: "empty" })}>创建空时间线</button></div>}
      </section>
      <div className="resize-handle resize-handle-left" role="separator" aria-label="调整左侧面板宽度" onPointerDown={event => beginResize("left", event)} />
      <section className="stage-pane" aria-label="项目预览">
        <div className="preview-toolbar"><div className="preview-mode-switch" aria-label="预览模式"><button className={previewMode === "interactive" ? "active" : ""} onClick={() => { setPreviewMode("interactive"); setExportPlayback(undefined); }}>交互预览</button><button className={previewMode === "authoritative" ? "active" : ""} disabled={!authoritativePreview && !exportPlayback} onClick={() => { setPreviewMode("authoritative"); setExportPlayback(undefined); }}>权威预览</button></div><label className="ratio-select">比例<select aria-label="预览比例" value={effectiveRatio} onChange={event => { setPreviewRatio(event.target.value); setPreviewRatioTouched(true); }}>{previewRatios.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label className="encoder-select">编码模式<select aria-label="编码模式" value={encoderMode} onChange={event => setEncoderMode(event.target.value as EncoderMode)}><option value="auto">自动</option><option value="software">软件</option><option value="hardware">硬件</option></select></label><button className="render-panel-toggle" onClick={() => setRenderPanelOpen(true)}>渲染与导出{renderActivity ? <span className="render-badge" aria-hidden="true">{renderActivity}</span> : null}</button></div>
        <div className={`preview-frame ${previewClass}${previewSelected ? " selected" : ""}`} role="button" tabIndex={0} aria-label="选中播放头处的片段" title="点击选中播放头处的片段" onClick={selectClipAtPlayhead} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectClipAtPlayhead(); } }}>
          <div className="preview-canvas">
            {previewMode === "authoritative" && authoritativeMediaUrl && <video ref={videoRef} className="preview-foreground authoritative-video" src={authoritativeMediaUrl} aria-label={reframePlayback ? "重构图权威预览视频" : exportPlayback ? "导出视频" : "权威预览视频"} controls onEnded={() => setPlaying(false)} />}
            {previewMode === "interactive" && previewAsset?.media_url && previewAsset.asset.kind === "video" && <><video className="preview-background" src={previewAsset.media_url} muted aria-hidden="true" /><video ref={videoRef} className="preview-foreground" src={previewAsset.media_url} muted={!selectedClip?.audio.enabled || previewReverse} aria-label="交互预览视频" onTimeUpdate={event => { const clip = clipAtPlayhead; if (clip) { const sourceStart = (clip.source_start_us ?? 0) / 1_000_000; const elapsed = (event.currentTarget.currentTime - sourceStart) * ((clip.speed_milli ?? 1000) / 1000); setPlayhead(Math.round(clip.timeline_start_us + elapsed * 1_000_000)); } else if (!libraryPreviewId) { setPlayhead(Math.round(event.currentTarget.currentTime * 1_000_000)); } }} onEnded={handleVideoEnded} /></>}
            {previewMode === "interactive" && audioAsset?.media_url && <audio ref={audioRef} src={audioAsset.media_url} style={{ display: "none" }} />}
            {previewMode === "interactive" && previewAsset?.media_url && previewAsset.asset.kind === "image" && <><img className="preview-background" src={previewAsset.media_url} alt="" aria-hidden="true" /><img className="preview-foreground" src={previewAsset.media_url} alt={previewAsset.asset.display_name} /></>}
            {previewMode === "interactive" && !previewAsset?.media_url && <div className="preview-empty">选择或追加素材以开始编辑</div>}
            {previewMode === "interactive" && visibleCaption && <div className={`caption-overlay ${visibleCaption.preset_id}`}>{visibleCaption.text}</div>}
          </div>
          <span className={`interactive-label ${previewIsStale && previewMode === "authoritative" && !exportPlayback ? "stale" : ""}`}>{previewMode === "interactive" ? "交互预览 · 非权威" : reframePlayback ? "静态焦点重构图 · 权威预览" : exportPlayback ? `导出 · ${exportPlayback.export_record.destination_display_name}` : previewIsStale ? "权威预览 · 已过期" : "权威预览 · 当前 Revision"}</span><span role="status" aria-label="预览状态" className={`preview-context ${previewMode === "authoritative" ? "authoritative" : "interactive"}${previewIsStale ? " stale" : ""}`}>{previewMode === "authoritative" ? (previewIsStale ? "权威预览已过期" : authoritativePreview ? "权威预览" : "尚未生成权威预览") : "交互预览"}</span>
        </div>
        <div className="playback">
          <div className="playback-left"><span className="playback-timecode">{formatTime(playhead)} / {formatTime(totalUs)}</span></div>
          <div className="playback-center"><IconButton label={playing ? "暂停" : "播放"} onClick={() => setPlaying(value => !value)}>{playing ? <Pause /> : <Play />}</IconButton><input aria-label="时间线播放头" type="range" min={0} max={Math.max(totalUs, 1)} value={Math.min(playhead, totalUs)} onChange={event => { exitLibraryPreview(); const value = Number(event.target.value); setPlayhead(value); const clip = sortedClips.find(c => value >= c.timeline_start_us && value < c.timeline_end_us); if (clip && videoRef.current) { const sourceStart = (clip.source_start_us ?? 0) / 1_000_000; const elapsed = (value - clip.timeline_start_us) / 1_000_000 * ((clip.speed_milli ?? 1000) / 1000); videoRef.current.currentTime = sourceStart + elapsed; } else if (videoRef.current) { videoRef.current.currentTime = value / 1_000_000; } }} /></div>
          <div className="playback-right" role="group" aria-label="画布比例" ref={ratioMenuRef}>
            <button
              className="ratio-current-btn"
              aria-haspopup="menu"
              aria-expanded={ratioMenuOpen}
              title="画布比例"
              onClick={() => setRatioMenuOpen((value) => !value)}
            >
              {previewRatioTouched ? (previewRatios.find((item) => item.value === previewRatio)?.label ?? "比例") : "适应"}
            </button>
            {ratioMenuOpen && (
              <div className="ratio-menu" role="menu" aria-label="选择画布比例">
                <button role="menuitem" className={!previewRatioTouched ? "active" : ""} onClick={() => { setPreviewRatio("fit"); setPreviewRatioTouched(false); setRatioMenuOpen(false); }}>适应</button>
                {previewRatios.filter((item) => item.value !== "fit").map((item) => (
                  <button key={item.value} role="menuitem" className={previewRatioTouched && previewRatio === item.value ? "active" : ""} onClick={() => { setPreviewRatio(item.value); setPreviewRatioTouched(true); setRatioMenuOpen(false); }}>{item.label}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
      <div className="resize-handle resize-handle-right" role="separator" aria-label="调整右侧面板宽度" onPointerDown={event => beginResize("right", event)} />
      <aside className="properties-pane" aria-label="上下文属性" role="region">{selectedClip ? <ClipProperties clip={selectedClip} locked={Boolean(working?.locked_elements?.includes(selectedClip.clip_id))} onPatch={patchTimeline} onDraft={queueDraft} working={working!} playheadUs={playhead} /> : selectedCaption ? <CaptionProperties caption={selectedCaption} locked={Boolean(selectedCaption.source_clip_id && working?.locked_elements?.includes(selectedCaption.source_clip_id))} onPatch={patchTimeline} onDraft={queueDraft} working={working!} /> : selectedTransition ? <TransitionProperties transition={selectedTransition} onPatch={patchTimeline} /> : <ProjectProperties project={project} saveState={saveState} authoritativePreview={authoritativePreview} previewIsStale={previewIsStale} renderDisabledReason={renderDisabledReason} onGeneratePreview={() => void generatePreview()} onCreateExport={() => void createExport()} onOpenProjectDialog={() => setProjectDialogOpen(true)} />}</aside>
    </section>
    <div className="timeline-resize-handle" role="separator" aria-label="调整时间线高度" onPointerDown={event => beginResize("timeline", event)} />
    <TimelinePanel document={working} selection={selection} setSelection={(sel) => { setSelection(sel); exitLibraryPreview(); }} onPatch={patchTimeline} onDropAsset={dropAsset} canUndo={Boolean(timeline?.can_undo)} canRedo={Boolean(timeline?.can_redo)} onUndo={() => void undoRedo("undo")} onRedo={() => void undoRedo("redo")} assetMedia={assets.map(item => ({ asset_id: item.asset.asset_id, media_url: item.media_url, kind: item.asset.kind }))} playheadUs={playhead} onSeek={(timeUs) => { exitLibraryPreview(); setPlayhead(timeUs); const clip = sortedClips.find(c => timeUs >= c.timeline_start_us && timeUs < c.timeline_end_us); if (clip && videoRef.current) { const sourceStart = (clip.source_start_us ?? 0) / 1_000_000; const elapsed = (timeUs - clip.timeline_start_us) / 1_000_000 * ((clip.speed_milli ?? 1000) / 1000); pendingSeekRef.current = sourceStart + elapsed; videoRef.current.currentTime = pendingSeekRef.current; } else if (videoRef.current) { videoRef.current.currentTime = timeUs / 1_000_000; } }} />
    <footer><div className="footer-status"><div role="status" aria-label="保存状态" className={`save-state ${saveState === "保存失败" || saveState === "草稿冲突" ? "error" : ""}`}><Save />{saveState}</div><div className="job-state" role="status" aria-label="任务状态">{runtimeReady ? "Core 已连接" : "Core 连接中"}{renderActivity ? ` · ${renderActivity} 个任务进行中` : ""}</div>{previewIsStale && <span className="stale">权威预览已过期</span>}</div><div className="footer-actions"><button className="ai-entry" disabled={!project || !timeline} onClick={() => void openExportBatch()}><Download />多平台导出</button><button className="ai-entry" disabled={!project} onClick={() => void openAi()}>AI 粗剪</button><button className="ai-entry" disabled={!timeline} onClick={() => void openPatch()}><Sparkles />AI 修改</button><button className="ai-entry" disabled={!timeline} onClick={() => void openRevisionCompare()}><History />版本比较</button><button className="ai-entry" disabled={!aiForm.provider_id} onClick={() => void deleteAiSecret()}>删除当前 Provider 密钥</button></div><span className="footer-version">{CONTRACT_VERSION} · 权威预览与最终导出均由冻结 Timeline Revision 生成。</span></footer>
     {projectDialogOpen && <Dialog titleId="project-management-title" label="项目管理" onClose={() => setProjectDialogOpen(false)} className="project-management-modal"><div className="modal-heading"><div><h2 id="project-management-title">项目管理</h2><p>集中管理项目名称与生命周期，编辑区只保留当前项目选择。</p></div><IconButton label="关闭项目管理" onClick={() => setProjectDialogOpen(false)}><X /></IconButton></div><div className="project-steps"><span className="active">1 导入素材</span><span>2 编辑时间线</span><span>3 预览检查</span><span>4 导出视频</span></div><section className="project-management-section"><h3>新建项目</h3><div className="project-form-row"><input aria-label="新项目名称" value={newProject} onChange={event => setNewProject(event.target.value)} placeholder="例如：品牌宣传片" /><button className="compact-command" disabled={!newProject.trim()} onClick={() => void createProject()}><FolderPlus />创建项目</button></div></section><section className="project-management-section"><h3>当前项目</h3>{project ? <><p className="project-current-name">{project.name} · {project.status === "active" ? "活动" : project.status === "archived" ? "已归档" : "目录缺失"}</p><div className="project-form-row"><input aria-label="重命名项目" value={projectName} onChange={event => { projectNameProjectId.current = project.project_id; projectNameDirty.current = true; setProjectName(event.target.value); }} /><button className="compact-command" disabled={!projectName.trim()} onClick={() => void renameProject()}><Save />保存名称</button></div><div className="modal-actions"><button onClick={() => void toggleArchive()}>{project.status === "archived" ? <RotateCcw /> : <Archive />} {project.status === "archived" ? "重新打开项目" : "归档项目"}</button></div></> : <p>请先选择一个项目。</p>}</section></Dialog>}
    {batchOpen && <Dialog titleId="export-batch-title" label="多平台导出" onClose={() => setBatchOpen(false)} className="export-batch-modal"><div className="modal-heading"><div><h2 id="export-batch-title">多平台导出</h2><p>平台与画幅独立选择；仅同一 Revision 的权威预览可进入批次。</p></div><IconButton label="关闭多平台导出" onClick={() => setBatchOpen(false)}><X /></IconButton></div>{batchError && <p className="ai-status" role="status">{batchError}</p>}<div className="rendition-targets">{renditionTargets.map(target => { const platform = platformPresets.find(item => item.platform_preset_id === target.platform_preset_id); const rendition = renditionPresets.find(item => item.rendition_preset_id === target.rendition_preset_id); const preview = targetPreview(target); return <section key={target.key} className="rendition-target"><label>平台<select aria-label="导出平台" value={target.platform_preset_id} onChange={event => { const next = platformPresets.find(item => item.platform_preset_id === event.target.value); if (next) updateTarget(target.key, { platform_preset_id: next.platform_preset_id, rendition_preset_id: next.default_rendition_id, key: `${next.platform_preset_id}:${next.default_rendition_id}` }); }}><option value="">选择平台</option>{platformPresets.map(item => <option value={item.platform_preset_id} key={item.platform_preset_id}>{item.display_name}</option>)}</select></label><label>画幅<select aria-label="导出画幅" value={target.rendition_preset_id} onChange={event => updateTarget(target.key, { rendition_preset_id: event.target.value, key: `${target.platform_preset_id}:${event.target.value}` })}>{platform?.allowed_rendition_ids.map(id => <option value={id} key={id}>{renditionPresets.find(item => item.rendition_preset_id === id)?.display_name ?? id}</option>)}</select></label><label>布局<select aria-label="目标布局策略" value={target.layout_policy} onChange={event => updateTarget(target.key, { layout_policy: event.target.value as LayoutPolicy })}>{layoutPolicies.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label><div className="target-summary"><small>{rendition ? `${rendition.export.width}×${rendition.export.height} · H.264/AAC · 30fps` : "预设加载中"}</small><small>{preview ? `权威预览已就绪${preview.preview.warnings.length ? ` · ${preview.preview.warnings.join(", ")}` : ""}` : "需要本目标权威预览"}</small></div><div className="target-actions"><button onClick={() => void generateRenditionPreview(target)}>{preview ? "重新生成权威预览" : "生成权威预览"}</button><button disabled={renditionTargets.length === 1} onClick={() => setRenditionTargets(items => items.filter(item => item.key !== target.key))}>移除</button></div>{preview && <ReframeTargetEditor clips={reframeClips(target)} selections={reframeSelections[target.key] ?? {}} preview={reframePreviews[target.key]} pending={Boolean(reframePending[target.key])} onSelect={(clipId, anchor) => selectReframeAnchor(target, clipId, anchor)} onGenerate={() => void generateReframePreview(target)} onPlay={() => { setReframePlayback(reframePreviews[target.key]); setExportPlayback(undefined); setPreviewMode("authoritative"); }} />}</section>; })}</div><div className="modal-actions"><button disabled={renditionTargets.length >= 8 || !platformPresets.length} onClick={addTarget}>添加目标</button><button onClick={() => void chooseBatchDirectory()}>{directoryGrant ? `输出目录：{directoryGrant.display_name}` : "选择输出目录"}</button><button disabled={!directoryGrant || !renditionTargets.length || renditionTargets.some(target => !targetPreview(target))} onClick={() => void createBatch()}>创建批次</button></div><section className="reframe-batch-actions" aria-label="静态焦点批量导出"><h3>静态焦点批量导出</h3><p>独立于基础 Stage 3A 批次；所有目标的重构图权威预览就绪后才可创建。</p>{reframeError && <p className="ai-status" role="status">{reframeError}</p>}<div className="modal-actions"><button disabled={renditionTargets.some(target => !targetAdjustments(target).length || !reframePreviews[target.key])} onClick={() => void chooseReframeDirectory()}>{reframeDirectoryGrant ? `重构图输出目录：${reframeDirectoryGrant.display_name}` : "选择重构图输出目录"}</button><button disabled={!reframeDirectoryGrant || renditionTargets.some(target => !targetAdjustments(target).length || !reframePreviews[target.key])} onClick={() => void createReframeBatch()}>创建重构图批次</button></div></section>{activeBatch && <section className="batch-status"><h3>批次 {activeBatch.status}</h3><p>目录：{activeBatch.directory_display_name}</p>{activeBatch.items.map(item => <div key={item.export_batch_item_id}><strong>{item.rendition_snapshot.platform_preset_id} · {item.rendition_snapshot.rendition_preset_id}</strong><small>{item.status} · {item.progress === null ? "--" : `${Math.round(item.progress * 100)}%`}{item.destination_display_name ? ` · ${item.destination_display_name}` : ""}{item.error_code ? ` · ${item.error_code}` : ""}</small></div>)}<div className="modal-actions">{["queued", "running"].includes(activeBatch.status) && <button onClick={() => void window.desktop.cancelExportBatch(activeBatch.export_batch_id).then(setActiveBatch).catch(() => setBatchError("取消批次失败。"))}>取消批次</button>}{activeBatch.items.some(item => ["failed", "cancelled", "interrupted"].includes(item.status)) && <button onClick={() => void retryBatchItems()}>重新授权并重试失败项</button>}</div></section>}{activeReframeBatch && <section className="batch-status reframe-batch-status"><h3>重构图批次{activeReframeBatch.status}</h3><p>目录：{activeReframeBatch.directory_display_name}</p>{activeReframeBatch.items.map(item => <div key={item.reframe_export_batch_item_id}><strong>{item.rendition_reframe_snapshot.platform_preset_id} · {item.rendition_reframe_snapshot.rendition_preset_id}</strong><small>{item.status} · {item.progress === null ? "--" : `${Math.round(item.progress * 100)}%`}{item.destination_display_name ? ` · ${item.destination_display_name}` : ""}{item.error_code ? ` · ${item.error_code}` : ""}</small></div>)}<div className="modal-actions">{["queued", "running"].includes(activeReframeBatch.status) && <button onClick={() => void window.desktop.cancelReframeExportBatch(activeReframeBatch.reframe_export_batch_id).then(setActiveReframeBatch).catch(() => setReframeError("取消重构图批次失败。"))}>取消重构图批次</button>}{activeReframeBatch.items.some(item => ["failed", "cancelled", "interrupted"].includes(item.status)) && <button onClick={() => void retryReframeBatchItems()}>重新授权并重试重构图失败项</button>}</div></section>}</Dialog>}
    {confirmModel && <Dialog titleId="model-confirm-title" label="确认下载本地模型" onClose={() => setConfirmModel(undefined)}><div className="modal-heading"><h2 id="model-confirm-title">确认下载本地模型</h2><IconButton label="关闭" onClick={() => setConfirmModel(undefined)}><X /></IconButton></div><h3>{confirmModel.display_name}</h3><p>{confirmModel.purpose}</p><dl><dt>下载大小</dt><dd>{formatBytes(confirmModel.model_size_bytes)}</dd><dt>许可证</dt><dd>{confirmModel.license.name}</dd><dt>隐私</dt><dd>模型在本机运行，不上传媒体或转录正文。</dd></dl>{confirmModel.license.acceptance_required && <label className="check-line"><input type="checkbox" checked={licenseAccepted} onChange={event => setLicenseAccepted(event.target.checked)} />我已阅读并接受该许可证</label>}<div className="modal-actions"><button onClick={() => setConfirmModel(undefined)}>暂不下载</button><button disabled={confirmModel.license.acceptance_required && !licenseAccepted} onClick={() => void downloadModel()}>确认并下载</button></div></Dialog>}
    {transcriptionAsset && <Dialog titleId="transcription-title" label="创建本地转录" onClose={() => setTranscriptionAsset(undefined)}><div className="modal-heading"><h2 id="transcription-title">创建本地转录</h2><IconButton label="关闭" onClick={() => setTranscriptionAsset(undefined)}><X /></IconButton></div><p>{transcriptionAsset.display_name}</p><label>语言<select value={language} onChange={event => setLanguage(event.target.value)}><option value="auto">自动检测</option><option value="zh">中文</option><option value="en">English</option></select></label><label className="check-line"><input type="checkbox" checked={wordTimestamps} onChange={event => setWordTimestamps(event.target.checked)} />生成词级时间戳</label><div className="modal-actions"><button onClick={() => setTranscriptionAsset(undefined)}>取消</button><button onClick={() => void submitTranscription()}>开始转录</button></div></Dialog>}
    {viewingTranscript && <Dialog titleId="transcript-title" label="原始转录" onClose={() => setViewingTranscript(undefined)} className="transcript-viewer"><div className="modal-heading"><div><h2 id="transcript-title">原始转录</h2><small>{viewingTranscript.language} · {viewingTranscript.provider} · {viewingTranscript.model_revision}</small></div><IconButton label="关闭" onClick={() => setViewingTranscript(undefined)}><X /></IconButton></div><div className="readonly-note">原始 ASR 结果只读。字幕修订不会覆盖这份记录。</div><div className="readonly-segments">{viewingTranscript.segments.map(segment => <div key={segment.segment_id}><span>{formatTime(segment.start_us)}-{formatTime(segment.end_us)}</span><p>{segment.text}</p></div>)}</div></Dialog>}
    {aiOpen && <Dialog titleId="ai-roughcut-title" label="AI 粗剪" onClose={() => setAiOpen(false)} className="ai-roughcut"><div className="modal-heading"><div><h2 id="ai-roughcut-title">AI 粗剪</h2><p>仅在确认外传内容后调用 Provider。</p></div><IconButton label="关闭 AI 粗剪" onClick={() => setAiOpen(false)}><X /></IconButton></div>{aiError && <p className="ai-status" role="status">{aiError}</p>}{aiStep === "form" && <><label>主题<input value={aiForm.topic} onChange={e => setAiForm(v => ({ ...v, topic: e.target.value }))} /></label><label>受众<input value={aiForm.audience} onChange={e => setAiForm(v => ({ ...v, audience: e.target.value }))} /></label><label>叙事目标<textarea value={aiForm.narrative_goal} onChange={e => setAiForm(v => ({ ...v, narrative_goal: e.target.value }))} /></label><label>风格说明<textarea value={aiForm.style_notes} onChange={e => setAiForm(v => ({ ...v, style_notes: e.target.value }))} /></label><label>制作配方<select value={aiForm.recipe_id} onChange={e => setAiForm(v => ({ ...v, recipe_id: e.target.value }))}><option value="">选择配方</option>{aiRecipes.map(item => <option key={item.recipe_id} value={item.recipe_id}>{item.name ?? item.display_name} · {item.summary}</option>)}</select></label><label>Provider<select value={aiForm.provider_id} onChange={e => setAiForm(v => ({ ...v, provider_id: e.target.value }))}><option value="">选择 Provider</option>{aiProviders.map(item => <option key={item.provider_config_id} value={item.provider_config_id} disabled={!item.enabled || item.credential_status !== "configured" || item.candidate_capability_status !== "supported"}>{item.display_name} · {item.candidate_capability_status === "supported" ? "AI 粗剪可用" : item.candidate_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 粗剪"}</option>)}</select></label><div className="provider-capability-list">{aiProviders.map(item => <div key={item.provider_config_id}><span>{item.display_name} · {item.candidate_capability_status === "supported" ? "AI 粗剪可用" : item.candidate_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 粗剪"}</span><button disabled={aiCapabilityTesting} onClick={() => void testCandidateProviderCapability(item.provider_config_id)}>{aiCapabilityTesting ? "正在测试兼容性" : "测试 AI 粗剪兼容性"}</button></div>)}</div><div className="ai-inline"><input id="ai-provider-secret" aria-label="Provider 密钥" type="password" autoComplete="off" placeholder="仅提交新密钥" /><button onClick={() => void saveAiSecret()}>安全保存密钥</button><button onClick={() => void testAiProvider()}>连接测试</button></div><fieldset><legend>新建 Provider（可选）</legend><input aria-label="Provider 名称" value={aiProviderDraft.display_name} onChange={e => setAiProviderDraft(v => ({ ...v, display_name: e.target.value }))} placeholder="名称" /><input aria-label="Provider 地址" value={aiProviderDraft.base_url} onChange={e => setAiProviderDraft(v => ({ ...v, base_url: e.target.value }))} placeholder="https://..." /><input aria-label="Provider 模型" value={aiProviderDraft.model} onChange={e => setAiProviderDraft(v => ({ ...v, model: e.target.value }))} placeholder="模型" /><button onClick={() => void saveAiProvider()}>创建 Provider</button></fieldset><label>就绪转录<select value={aiForm.transcript_id} onChange={e => setAiForm(v => ({ ...v, transcript_id: e.target.value }))}><option value="">选择已就绪转录</option>{Object.values(transcripts).flat().map(item => <option key={item.transcript_id} value={item.transcript_id}>{item.language} · {item.segments.length} 段</option>)}</select></label><div className="modal-actions"><button disabled={!aiForm.topic || !aiForm.audience || !aiForm.narrative_goal || !aiForm.provider_id || !aiForm.recipe_id || !aiForm.transcript_id || aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.candidate_capability_status !== "supported" || aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.credential_status !== "configured" || !aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.enabled} onClick={() => void prepareAi()}>准备外传确认</button></div></>}{aiStep === "confirm" && aiPreview && <><h3>确认发送的精确内容</h3><dl><dt>目标</dt><dd>{aiPreview.provider.origin}</dd><dt>模型</dt><dd>{aiPreview.provider.model}</dd><dt>字段</dt><dd>{aiPreview.sent_fields.join("、")}</dd><dt>段落/字符</dt><dd>{aiPreview.stats.segment_count} 段 / {aiPreview.stats.character_count} 字</dd><dt>估算 Token</dt><dd>{aiPreview.stats.estimated_tokens}</dd><dt>费用提示</dt><dd>指 Provider 配置的单价估算，最终费用以服务商账单为准。</dd><dt>哈希</dt><dd>{aiPreview.payload_sha256}</dd><dt>有效期</dt><dd>{aiPreview.expires_at}</dd></dl><div className="egress-text">{Array.isArray(aiPreview.payload.segments) && (aiPreview.payload.segments as Array<Record<string, unknown>>).map(segment => <p key={String(segment.segment_ref)}>{String(segment.text)}</p>)}</div><div className="modal-actions"><button onClick={() => { setAiPreview(undefined); setAiStep("form"); }}>返回修改</button><button onClick={() => void createAi()}>我确认发送以上内容</button></div></>}{aiStep === "running" && <><h3>正在生成候选方案</h3><p>任务进度与取消操作沿用现有任务中心；如失败或取消，请重新准备并再次确认。</p></>}{aiStep === "candidates" && <><h3>三个候选方案</h3><div className="candidate-columns">{(["balanced", "compact", "bold"] as const).map((variant, index) => { const item = aiCandidates.find(candidate => candidate.variant === variant); const title = ["稳妥版", "紧凑版", "高能版"][index]; return <section key={variant}><h4>{title}</h4>{item ? <><strong>{String(item.title_suggestion)}</strong><p>{String(item.summary)}</p><small>{Number(item.duration_us) / 1_000_000}s · 模型参考</small>{Array.isArray(item.clips) && (item.clips as Array<Record<string, unknown>>).map(clip => <div className="candidate-clip" key={String(clip.clip_id)}><span>{Number(clip.source_start_us) / 1_000_000}s–{Number(clip.source_end_us) / 1_000_000}s</span><button onClick={() => void playAiClip(clip)}>试播片段</button><p>{String(clip.reason)}</p></div>)}<button onClick={() => void adoptAi(item)}>采用此方案</button></> : <p>等待有效响应</p>}</section>; })}</div>{aiPlayback && <video className="candidate-player" src={aiPlayback.media_url} controls autoPlay onLoadedMetadata={e => { e.currentTarget.currentTime = aiPlayback.source_start_us / 1_000_000; }} onTimeUpdate={e => { if (e.currentTarget.currentTime >= aiPlayback.source_end_us / 1_000_000) e.currentTarget.pause(); }} />}</>}</Dialog>}
     {aiOpen && aiStep === "running" && <section className="ai-job-progress" aria-live="polite" aria-label="AI 粗剪任务进度"><strong>阶段：{aiJob?.stage ?? "queued"}</strong><span>进度：{Math.round((aiJob?.progress ?? 0) * 100)}%</span><progress aria-label="AI 粗剪进度" max="1" value={aiJob?.progress ?? 0} /><button disabled={!aiJob || !["queued", "running", "cancelling"].includes(aiJob.status)} onClick={() => { if (!aiJob) return; void window.desktop.cancelJob(aiJob.job_id).then(job => { setAiJob(job); setAiPreview(undefined); setAiCandidates([]); setAiPlayback(undefined); setAiStep("form"); setAiError("生成已取消。请重新准备外传内容并再次确认。"); }).catch(() => setAiError("取消请求失败；请等待当前任务状态刷新。")); }}>取消生成</button></section>}
    {patchOpen && <Dialog titleId="planning-patch-title" label="AI 修改" onClose={closePatch} className="planning-patch"><div className="modal-heading"><div><h2 id="planning-patch-title">AI 修改</h2><p>提案不会自动修改正式 Timeline。</p></div><IconButton label="关闭 AI 修改" onClick={closePatch}><X /></IconButton></div>{patchError && <p className="ai-status" role="status">{patchError}</p>}{patchStep === "form" && <><label>修改指令<textarea aria-label="修改指令" maxLength={4000} value={patchInstruction} onChange={event => setPatchInstruction(event.target.value)} /></label><label>Provider<select aria-label="AI 修改 Provider" value={patchProviderId} onChange={event => setPatchProviderId(event.target.value)}><option value="">选择已配置 Provider</option>{patchProviders.map(item => <option value={item.provider_config_id} key={item.provider_config_id} disabled={item.timeline_patch_capability_status !== "supported"}>{item.display_name} · {item.model} · {item.timeline_patch_capability_status === "supported" ? "AI 修改可用" : item.timeline_patch_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 修改"}</option>)}</select></label><div className="provider-capability-list">{patchProviders.map(item => <div key={item.provider_config_id}><span>{item.display_name} · {item.timeline_patch_capability_status === "supported" ? "AI 修改可用" : item.timeline_patch_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 修改"}</span><button disabled={patchCapabilityTesting} onClick={() => void testPatchProviderCapability(item.provider_config_id)}>{patchCapabilityTesting ? "正在测试兼容性" : "测试 AI 修改兼容性"}</button></div>)}</div><div className="modal-actions"><button disabled={!patchProviderId || !patchInstruction.trim() || patchProviders.find(item => item.provider_config_id === patchProviderId)?.timeline_patch_capability_status !== "supported"} onClick={() => void preparePatch()}>准备外传确认</button></div></>}{patchStep === "confirm" && patchPreview && <><h3>确认本次外传</h3><div className="instruction-preview"><strong>你的本地指令</strong><p>{patchInstruction}</p></div><dl><dt>Provider</dt><dd>{patchPreview.provider.display_name} · {patchPreview.provider.origin}</dd><dt>模型</dt><dd>{patchPreview.provider.model}</dd><dt>字段类别</dt><dd>{patchPreview.sent_fields.join("、")}</dd><dt>内容计数</dt><dd>{patchPreview.clip_count} Clip / {patchPreview.caption_count} Caption / {patchPreview.locked_count} 锁定</dd><dt>字符 / Token</dt><dd>{patchPreview.character_count} / {patchPreview.estimated_tokens}</dd><dt>哈希</dt><dd>{patchPreview.payload_sha256}</dd><dt>费用</dt><dd>最终费用以 Provider 账单为准。</dd></dl><p className="readonly-note">上方指令来自当前本地输入；Core 确认 DTO 不包含正文。</p><div className="modal-actions"><button onClick={() => { setPatchPreview(undefined); setPatchStep("form"); }}>返回修改</button><button onClick={() => void createPatch()}>确认并发送一次</button></div></>}{patchStep === "running" && <><h3>正在生成提案</h3><p>{patchJob?.stage ?? "queued"} · {Math.round((patchJob?.progress ?? 0) * 100)}%</p><progress max="1" value={patchJob?.progress ?? 0} /><div className="modal-actions"><button disabled={!patchJob || !["queued", "running", "cancelling"].includes(patchJob.status)} onClick={() => void cancelPatch()}>取消生成</button></div></>}{patchStep === "proposal" && patchProposal && <><h3>提案差异</h3><TimelineDiffView diff={patchProposal.diff} /><div className="modal-actions"><button onClick={closePatch}>放弃</button><button disabled={patchProposal.applied_revision_id !== null} onClick={() => void applyPatchProposal()}>应用修改</button></div></>}</Dialog>}
    {generationOpen && project && <MediaGenerationWorkbench key={project.project_id} project={project} assets={assets} onClose={() => setGenerationOpen(false)} />}
    {providerImageGenerationOpen && project && <ProviderImageGenerationWorkbench key={`provider-image-${project.project_id}`} project={project} assets={assets} onClose={() => setProviderImageGenerationOpen(false)} />}
    {shotRequirementsOpen && project && <ShotRequirementWorkbench key={project.project_id} project={project} assets={assets} onClose={() => setShotRequirementsOpen(false)} />}
    {revisionOpen && <Dialog titleId="revision-compare-title" label="版本比较" onClose={() => { setRevisionOpen(false); setRevisionDiff(undefined); }} className="revision-compare"><div className="modal-heading"><div><h2 id="revision-compare-title">版本比较</h2><p>只读操作，不改变当前 Revision、草稿或渲染记录。</p></div><IconButton label="关闭版本比较" onClick={() => { setRevisionOpen(false); setRevisionDiff(undefined); }}><X /></IconButton></div><div className="revision-selectors"><label>基线<select aria-label="基线 Revision" value={revisionPair.base} onChange={event => setRevisionPair(value => ({ ...value, base: event.target.value }))}>{revisions.map(item => <option value={item.timeline_revision_id} key={`base-${item.timeline_revision_id}`}>{item.summary} · {item.created_at}</option>)}</select></label><label>目标<select aria-label="目标 Revision" value={revisionPair.target} onChange={event => setRevisionPair(value => ({ ...value, target: event.target.value }))}>{revisions.map(item => <option value={item.timeline_revision_id} key={`target-${item.timeline_revision_id}`}>{item.summary} · {item.created_at}</option>)}</select></label></div><div className="modal-actions"><button disabled={!revisionPair.base || !revisionPair.target || revisionPair.base === revisionPair.target} onClick={() => void compareRevisions()}>比较</button></div>{revisionDiff && <TimelineDiffView diff={revisionDiff} />}</Dialog>}
       {renderPanelOpen && <Dialog titleId="render-panel-title" label="渲染与导出" onClose={() => setRenderPanelOpen(false)} className="render-panel-dialog"><div className="modal-heading"><div><h2 id="render-panel-title">渲染与导出</h2><p>权威预览与最终导出的任务与产物记录，关闭后任务继续在后台推进。</p></div><IconButton label="关闭渲染与导出" onClick={() => setRenderPanelOpen(false)}><X /></IconButton></div><section className="export-records dialog-export-records">          <div><strong>任务与产物</strong>{!authoritativePreview && <small>当前没有权威预览，仍可直接导出。</small>}</div>
          {jobs.filter(item => item.kind === "authoritative_preview" || item.kind === "final_export").map(item => <div className="render-job" key={item.job_id}><div><strong>{item.kind === "authoritative_preview" ? "权威预览" : "最终导出"}</strong><small>{jobStatusLabels[item.status]} · {item.stage} · {item.progress === null ? "--" : `${Math.round(item.progress * 100)}%`}{item.error ? ` · ${safeTaskErrorMessage(item.error)}` : ""}</small>{item.status === "running" && <JobEta job={item} />}</div>{["queued", "running", "cancelling"].includes(item.status) && <IconButton label="取消渲染任务" onClick={() => void cancelJob(item)}><Square /></IconButton>}</div>)}
          {exports.map(item => <div className="export-record" key={item.export_record.export_record_id}><div><strong>{item.export_record.destination_display_name}</strong><small>{item.export_record.status} · {item.export_record.encoder}{item.export_record.fallback_reason ? ` · ${item.export_record.fallback_reason}` : ""}</small></div><div><IconButton label="播放导出" onClick={() => { setExportPlayback(item); setPreviewMode("authoritative"); }}><Play /></IconButton><IconButton label="打开导出" onClick={() => void window.desktop.openArtifact(item.export_record.render_artifact_id)}><Eye /></IconButton><IconButton label="定位导出" onClick={() => void window.desktop.openArtifactFolder(item.export_record.render_artifact_id)}><MapPin /></IconButton></div></div>)}</section></Dialog>}
    {commandSearchOpen && <Dialog titleId="command-search-title" label="命令搜索" onClose={closeCommandSearch} className="command-palette">
      <div className="modal-heading"><div><h2 id="command-search-title">命令搜索</h2><p>输入命令名过滤；↑↓ 选择 · Enter 执行 · Esc 关闭。</p></div></div>
      <input type="search" aria-label="命令搜索" aria-controls="command-list" aria-activedescendant={filteredCommands[commandIndex] ? `command-option-${filteredCommands[commandIndex].id}` : undefined} placeholder="输入命令名称…" value={commandQuery} onChange={event => { setCommandQuery(event.target.value); setCommandIndex(0); }} onKeyDown={handleCommandPaletteKeyDown} />
      <ul role="listbox" aria-label="命令列表" id="command-list" className="command-list">
        {filteredCommands.map((command, index) => { const reason = commandDisabledReason(command.id); return <li key={command.id} id={`command-option-${command.id}`} role="option" aria-selected={index === commandIndex} className={index === commandIndex ? "active" : ""}><button disabled={Boolean(reason)} onClick={() => { if (!reason) { runCommand(command.id); closeCommandSearch(); } }}><span className="command-label">{command.label}</span>{(shortcutsRef.current as Record<string, ShortcutEntry> | undefined)?.[command.id as ShortcutCommandId] ? <kbd className="command-shortcut">{bindingLabel((shortcutsRef.current as Record<string, ShortcutEntry>)[command.id as ShortcutCommandId].binding)}</kbd> : null}<span className={reason ? "command-reason" : "command-ok"}>{reason ?? "可用"}</span></button></li>; })}
        {filteredCommands.length === 0 && <li className="command-empty">没有匹配的命令</li>}
      </ul>
    </Dialog>}
    {shortcutsOpen && <Dialog titleId="shortcuts-title" label="快捷键设置" onClose={() => { setShortcutsOpen(false); setRecordingId(null); }} className="shortcuts-dialog">
      <div className="modal-heading"><div><h2 id="shortcuts-title">快捷键设置</h2><p>点击"录制"后按下新键位；Ctrl+Shift+Z（重做）与 Backspace（删除）为固定别名，不参与自定义。</p></div><IconButton label="关闭快捷键设置" onClick={() => { setShortcutsOpen(false); setRecordingId(null); }}><X /></IconButton></div>
      <div className="shortcuts-list">
        {(Object.entries(shortcuts) as Array<[ShortcutCommandId, ShortcutEntry]>).map(([id, entry]) => (
          <div className="shortcut-row" key={id}>
            <span className="shortcut-label">{entry.label}</span>
            {recordingId === id
              ? <kbd className="shortcut-recording" tabIndex={0} autoFocus onKeyDown={event => handleRecordKey(event, id)}>请按键…（Esc 取消）</kbd>
              : <kbd className="shortcut-binding">{bindingLabel(entry.binding)}</kbd>}
            <button className="compact-command" onClick={() => setRecordingId(id)}>录制</button>
          </div>
        ))}
      </div>
      <div className="modal-actions"><button onClick={() => { applyShortcuts(structuredClone(DEFAULT_SHORTCUTS)); setRecordingId(null); setNotice("已恢复默认快捷键。"); }}>恢复默认</button></div>
    </Dialog>}
</main>;
}

function SegmentRow({ segment, selected, onToggle }: { segment: TranscriptSegment; selected: boolean; onToggle: () => void }) { return <label className="segment-row"><input type="checkbox" checked={selected} onChange={onToggle} /><span>{formatTime(segment.start_us)}-{formatTime(segment.end_us)}</span><p>{segment.text}</p></label>; }
function toggle(items: string[], id: string) { return items.includes(id) ? items.filter(item => item !== id) : [...items, id]; }

