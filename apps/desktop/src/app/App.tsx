import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, AudioLines, BookOpen, Captions, ChevronDown, ChevronLeft, ChevronRight, Clapperboard, Command as CommandIcon, Download, Eye, FileAudio, FileText, FlaskConical, FolderCog, FolderOpen, FolderPlus, GitCompare, History, Image as ImageIcon, ImagePlus, Keyboard, LayoutPanelLeft, Lock, LockOpen, MapPin, Maximize, Minimize, Monitor, MonitorPlay, Music, Pause, Play, Plus, Redo2, RefreshCw, RotateCcw, Save, Scissors, Search, Sparkles, Square, SquarePlus, Trash2, Type as TypeIcon2, Type, Undo2, Upload, Video, Volume2, VolumeX, WandSparkles, X, Minus, ZoomIn } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Asset, AssetId, AssetKind, AssetPresentation, BriefInput, CaptionPresetId, CvAnalysisSummary, CvSample, DestinationGrant, DirectoryGrant, EncoderMode, EgressPreview, ExportBatch, ExportFrameRate, ExportQuality, ExportResolution, HorizontalAnchor, Job, LayoutPolicy, MediaInfo, ModelDetail, ModelSummary, OutputRatio, PlatformPreset, Project, ProviderConfig, ReframeExportBatch, RenditionPreset, RenditionReframeAdjustment, TimelineCaption, TimelineClip, TimelineDiff, TimelineDocument, TimelineLayout, TimelinePatchEgressPreview, TimelinePatchOperation, TimelinePatchProposal, TimelineRevisionId, TimelineRevisionSummary, TimelineState, Transcript, TranscriptSegment, TranscriptSummary, VerticalAnchor } from "@aivideo/contracts";
import { ExportDialog, type ExportSettings } from "./ExportDialog.js";
import { CoverDialog } from "./CoverDialog.js";
import type { AuthoritativePreviewPresentation, ExportRecordPresentation, RenditionPreviewPresentation, RenditionReframePreviewPresentation } from "../../electron/preload/index.js";
import { CONTRACT_VERSION } from "@aivideo/contracts";
import { MediaGenerationWorkbench } from "./media-generation/MediaGenerationWorkbench.js";
import { ProviderImageGenerationWorkbench } from "./provider-image-generation/ProviderImageGenerationWorkbench.js";
import { ShotRequirementWorkbench } from "./shot-requirements/ShotRequirementWorkbench.js";
import { SettingsDialog } from "./settings/SettingsDialog.js";
import { AgentSessionPanel } from "./agent-session/AgentSessionPanel.js";
import { EditingGrammarPanel } from "./editing-grammar/EditingGrammarPanel.js";
import { WorklistPanel } from "./worklist/WorklistPanel.js";
import { CaptionsProviderPanel } from "./captions-provider/CaptionsProviderPanel.js";
import { ProviderSettingsDialog } from "./provider-settings/ProviderSettingsDialog.js";
import { EditingToolsPanel } from "./editing-grammar/EditingToolsPanel.js";
import { Dialog } from "./Dialog.js";
import { errorCode, safeErrorMessage, safeTaskErrorMessage } from "./safeErrors.js";
import { formatLocalStamp } from "./localTime.js";
import { PreviewPipOverlays, type PipOverlay, type PipTransform } from "./PreviewPipOverlays.js";
import { SyntheticPreview } from "./preview/SyntheticPreview.js";
import { PreviewSourceResolver } from "./preview/source-resolver.js";
import { syntheticFallbackNotice } from "./preview/fallback-notice.js";
import { WaveformCache } from "./timeline/waveform-cache.js";
import { editorCommands, type EditorCommand } from "./editorCommands.js";
import { bindingLabel, findConflict, loadShortcuts, matchesBinding, normalizeRecordedBinding, saveShortcuts, DEFAULT_SHORTCUTS, type ShortcutCommandId, type ShortcutEntry } from "./shortcuts.js";
import { TimelinePanel } from "./timeline/TimelineCanvas.js";
import { createPlayheadStore, type PlayheadStore } from "./timeline/playhead-store.js";
import { RequestScheduler, BoundedTaskQueue } from "./request-scheduling.js";
import { parseSubtitleFile } from "./subtitleImport.js";
import { ClipProperties, CaptionProperties, ProjectProperties, TimelineDiffView, TransitionProperties } from "./PropertyPanels.js";
import { JobEta } from "./JobEta.js";

type SaveState = "已保存" | "保存中" | "保存失败" | "草稿冲突";
type NoticeTone = "success" | "warning" | "error" | "info";
type Notice = { text: string; tone: NoticeTone } | "";
type Selection = { kind: "clip"; id: string } | { kind: "clips"; ids: string[] } | { kind: "caption"; id: string } | { kind: "transition"; id: string } | null;
const layouts: { value: TimelineLayout; label: string }[] = [{ value: "blurred_background", label: "模糊背景" }, { value: "crop_fill", label: "裁切填满" }, { value: "fit", label: "完整适配" }];
const previewRatios: { value: string; label: string; ratio: number | null }[] = [{ value: "fit", label: "适应", ratio: null }, { value: "169", label: "16:9", ratio: 16 / 9 }, { value: "916", label: "9:16", ratio: 9 / 16 }, { value: "11", label: "1:1", ratio: 1 }, { value: "43", label: "4:3", ratio: 4 / 3 }, { value: "34", label: "3:4", ratio: 3 / 4 }];
/** 新建项目画布预设（比例真源 = 项目画布）：PlayRes 基准 1080 短边，@30fps。 */
const projectCanvasPresets: Record<string, { width: number; height: number; fps_num: number; fps_den: number }> = {
  "169": { width: 1920, height: 1080, fps_num: 30, fps_den: 1 },
  "916": { width: 1080, height: 1920, fps_num: 30, fps_den: 1 },
  "11": { width: 1080, height: 1080, fps_num: 30, fps_den: 1 },
  "43": { width: 1440, height: 1080, fps_num: 30, fps_den: 1 },
  "34": { width: 1080, height: 1440, fps_num: 30, fps_den: 1 },
};
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
// 剪映式 SMPTE 时间码：HH:MM:SS:FF（FF 为帧号，按画布帧率取整）。
const formatSmpteTimecode = (us: number, fps: number) => {
  const safeFps = fps > 0 ? fps : 30;
  const totalSeconds = Math.max(0, us) / 1_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const frames = Math.min(Math.round(safeFps) - 1, Math.floor((totalSeconds - Math.floor(totalSeconds)) * safeFps));
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
};
const duration = (document?: TimelineDocument) => document?.clips.reduce((max, clip) => Math.max(max, clip.timeline_end_us), 0) ?? 0;
const formatRulerTime = (us: number) => {
  const totalSeconds = us / 1_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};
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
const modelStatusLabels: Record<ModelSummary["status"], string> = { unavailable: "未安装", queued: "排队中", downloading: "下载中", paused: "已暂停", verifying: "校验中", ready: "已就绪", cancelled: "已取消", failed: "下载失败", corrupt: "模型文件已损坏" };
const jobStatusLabels: Record<Job["status"], string> = { queued: "排队中", running: "运行中", succeeded: "已完成", failed: "失败", cancelling: "取消中", cancelled: "已取消", interrupted: "已中断" };
// C22 渲染/校验细分阶段标签；未知 phase 原样显示（旧 Core 无 phase 字段时退回 stage 文本）。
const jobPhaseLabels: Record<string, string> = { preparing: "准备中", encoding: "编码中", validating_probe: "校验（探测）", validating_decode: "校验（完整解码）", hashing: "完整性哈希", publishing: "正在完成发布" };
const modelBadgeLabels: Record<ModelSummary["status"], string> = { unavailable: "未下载", queued: "排队中", downloading: "下载中", paused: "已暂停", verifying: "校验中", ready: "就绪", cancelled: "已取消", failed: "失败", corrupt: "已损坏" };
const jobKindLabels: Partial<Record<Job["kind"], string>> = { transcription: "本地转录", proxy: "代理素材", portrait_sample: "竖版样本", authoritative_preview: "权威预览", final_export: "最终导出", waveform: "音频波形" };
/** 任务行副标题：同类任务（如多次转录）必须能区分是哪一条。 */
const jobDetailText = (job: Job, assetName?: string): string => {
  const parts: string[] = [];
  if (assetName) parts.push(assetName);
  // Core 落库的是 UTC ISO 串；直接 slice 会显示 UTC 时间（用户实测
  // 本地 19:25 的事件显示成 11:25）。必须转本地时区后再格式化。
  if (job.created_at) parts.push(formatLocalStamp(job.created_at));
  return parts.join(" · ");
};
// 任务从最后一次可见进度平滑跑到 100% 的收尾窗口（问题1：短片在两次轮询
// 间隔内完成时 56%→成功跳变突兀）。进度条 CSS transition .4s + 完成停留。
const FINALIZING_MS = 900;
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
// ISO 时间 → 相对时间（导出产物行锚点："3 分钟前"比绝对时间戳更易扫读）。
const formatRelativeTime = (iso: string) => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(then).toLocaleDateString();
};
// fallback_reason 是 Core 的 API 语义值（encoders.py 硬编码英文串），UI 层映射为
// 中文；未知值原样透出兜底。导出不受影响，仅是编码器选择的补充说明。
const fallbackReasonLabel = (reason: string) => reason === "hardware encoder smoke test failed; fell back to software" ? "硬件编码不可用，已用软件编码完成" : reason;
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
  const [assetView] = useState<"list" | "grid">("list");
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
  // 轮询 effect 的闭包持有的是 effect 建立时的 jobs——活跃判定与终态对账
  // 都必须读最新值（hasActiveWork 同理），否则会以陈旧列表误判退避/终态。
  const jobsRef = useRef<Job[]>([]);
  jobsRef.current = jobs;
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [confirmModel, setConfirmModel] = useState<ModelDetail>();
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  const [transcriptionAsset, setTranscriptionAsset] = useState<Asset>();
  // 素材删除确认（应用内弹窗，替代原生 confirm）；pendingDeleteAsset 显示警告文案。
  const [pendingDeleteAsset, setPendingDeleteAsset] = useState<Asset>();
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  // 项目封面：截取当前播放头画面（本地持久化，per-project）。
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // 素材库刷新：逐个向 Core 校验素材文件是否仍在本地。
  const [refreshingAssets, setRefreshingAssets] = useState(false);
  const [viewingTranscript, setViewingTranscript] = useState<Transcript>();
  const [language, setLanguage] = useState("auto");
  const [wordTimestamps, setWordTimestamps] = useState(true);
  const [timeline, setTimeline] = useState<TimelineState>();
  const [working, setWorking] = useState<TimelineDocument>();
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<"assets" | "transcripts" | "models" | "jobs">("assets");
  const [saveState, setSaveState] = useState<SaveState>("已保存");
  // 提示条：按严重级别配色（成功绿/警告琥珀/错误红/信息灰），数秒后自动消失（错误停留更久）。
  const [notice, setNotice] = useState<Notice>("");
  const [newProject, setNewProject] = useState("");
  const [newProjectRatio, setNewProjectRatio] = useState("916");
  const [projectName, setProjectName] = useState("");
  const [selectedSegments, setSelectedSegments] = useState<Record<string, string[]>>({});
  // AI 字幕优化（Slice 5）：发起入口在转录页，紧挨“追加所选片段”；
  // 记录发起时锁定的转录与片段，避免对话框打开期间勾选变化导致外传内容漂移。
  const [captionsOptimize, setCaptionsOptimize] = useState<{ transcript: Transcript; segmentIds: string[] }>();
  // 转录删除确认（危险操作需显式确认；仍被时间线字幕引用时 Core 拒绝）。
  const [pendingDeleteTranscript, setPendingDeleteTranscript] = useState<Transcript>();
  const [deleteTranscriptBusy, setDeleteTranscriptBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  /** B13：Main 离散资源档位（getRuntime 注入；驱动会话环深/预算决策）。 */
  const [resourceTier, setResourceTier] = useState<"conservative" | "balanced" | "high">("balanced");
  /** B13-R 判别诊断开关（perf 诊断构建 + AIVS_FORCE_COPYTO=1 时 Main 下发）。 */
  const [forceCopyTo, setForceCopyTo] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  // 播放头命令存储（A06）：预览每帧写入（高频、不驱动 React 全树重渲染）；
  // `playhead` 10Hz 状态只喂 App 自身的时间显示/属性面板。用户 seek 统一走
  // seekFromUser（递增 requestId，旧回传按 ID 作废），播放回传走 seekFromPlayback。
  const playheadStoreRef = useRef<PlayheadStore | null>(null);
  if (!playheadStoreRef.current) playheadStoreRef.current = createPlayheadStore();
  const playheadStore = playheadStoreRef.current;
  const [encoderMode, setEncoderMode] = useState<EncoderMode>("auto");
  const [exportQuality, setExportQuality] = useState<ExportQuality>("standard");
  // 剪映式导出弹窗（2026-09-23）：分辨率/帧率与画质并列；弹窗与封面弹窗开关。
  const [exportResolution, setExportResolution] = useState<ExportResolution>("1080p");
  const [exportFrameRate, setExportFrameRate] = useState<ExportFrameRate>(30);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [coverDialogOpen, setCoverDialogOpen] = useState(false);
  // 默认交互预览；合成预览经工具栏切换（Phase 2：手势层迁移完成 + 测试基建
  // 更新后再设为默认——默认翻转需同步更新大量假设交互默认的测试）。
  // 默认合成预览（Phase 2 主预览）：所见即所得；IR 不支持/不可用时自动回退
  // 交互预览（onFallback → 内联 syntheticNote，不打全局告警）。
  const [previewMode, setPreviewMode] = useState<"interactive" | "authoritative" | "synthetic">("synthetic");
  const [syntheticNotice, setSyntheticNotice] = useState<string | null>(null);
  const [previewRatio, setPreviewRatio] = useState("fit");
  const [previewRatioTouched, setPreviewRatioTouched] = useState(false);
  const [previews, setPreviews] = useState<AuthoritativePreviewPresentation[]>([]);
  const [exports, setExports] = useState<ExportRecordPresentation[]>([]);
  const [exportPlayback, setExportPlayback] = useState<ExportRecordPresentation>();
  /** 导出前核验：generatePreview 请求后等待当前 Revision 的权威预览就绪。 */
  const [pendingVerify, setPendingVerify] = useState(false);
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
  // Provider 设置独立入口：Provider 是各 AI 功能共用的前置，不再藏在 AI 粗剪里。
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [aiForm, setAiForm] = useState({ topic: "", audience: "", narrative_goal: "", style_notes: "", provider_id: "", recipe_id: "", transcript_id: "" });
  const aiRunRef = useRef<{ generation: number; stop?: () => void; timer?: ReturnType<typeof setTimeout> }>({ generation: 0 });
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [worklistOpen, setWorklistOpen] = useState(false);
  const [editingGrammarOpen, setEditingGrammarOpen] = useState(false);
  const [editingToolsTool, setEditingToolsTool] = useState<"remove_pauses" | "beat_sync" | "lj_cut" | null>(null);
  const [editingToolsClipId, setEditingToolsClipId] = useState<string | null>(null);
  const openEditingTools = (tool: "remove_pauses" | "beat_sync" | "lj_cut", clipId?: string | null) => {
    setEditingToolsTool(tool);
    setEditingToolsClipId(clipId ?? selectedClip?.clip_id ?? null);
    setEditingGrammarOpen(true);
  };
  const [generationOpen, setGenerationOpen] = useState(false);
  const [renderPanelOpen, setRenderPanelOpen] = useState(false);
  // 轮询 effect 闭包读面板开关最新值（决定 exports 对账端点是否参与本轮）。
  const renderPanelOpenRef = useRef(false);
  renderPanelOpenRef.current = renderPanelOpen;
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
  const [projectSwitcherQuery, setProjectSwitcherQuery] = useState("");
  const projectSwitcherRef = useRef<HTMLDivElement | null>(null);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const menuButtonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuActionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(336);
  const [timelineHeight, setTimelineHeight] = useState(230);
  const resizeRef = useRef<{ kind: "left" | "right" | "timeline"; start: number; value: number } | undefined>(undefined);
  // C3：快捷键自定义（注册表 + localStorage 持久化 + 面板录制状态）。
  const [shortcuts, setShortcuts] = useState<Record<ShortcutCommandId, ShortcutEntry>>(() => loadShortcuts());
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [recordingId, setRecordingId] = useState<ShortcutCommandId | null>(null);
  // 剪映式播放器控件状态：画布缩放（点击弹滑条）、音量（点击弹竖向滑条）、全屏、电平表。
  const [zoomPopOpen, setZoomPopOpen] = useState(false);
  const zoomPopRef = useRef<HTMLDivElement | null>(null);
  const [volPopOpen, setVolPopOpen] = useState(false);
  const volPopRef = useRef<HTMLDivElement | null>(null);
  const [volume, setVolume] = useState(80);
  const volumeRef = useRef(volume);
  const [progressDragging, setProgressDragging] = useState(false);
  const [previewZoom, setPreviewZoom] = useState<number | "fit">("fit");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const stagePaneRef = useRef<HTMLElement | null>(null);
  const stageColumnRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const volRailRef = useRef<HTMLDivElement | null>(null);
  // 画面选中框：白色边框 + 8 向拖拽手柄（角等比 / 边单轴），缩放时随画面一起缩放。
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const selBoxRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null);
  const [selDimsText, setSelDimsText] = useState("");
  const selDragRef = useRef<{ dir: string; startX: number; startY: number; w: number; h: number; ratio: number } | null>(null);
  const [vuEpoch, setVuEpoch] = useState(0);
  const applyShortcuts = (next: Record<ShortcutCommandId, ShortcutEntry>) => { setShortcuts(next); saveShortcuts(next); };
  const handleRecordKey = (event: React.KeyboardEvent, id: ShortcutCommandId) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") { setRecordingId(null); return; }
    const binding = normalizeRecordedBinding(event.nativeEvent);
    if (!binding) { showNotice("该按键不可用：单字符键需配合 Ctrl 使用；可用的还有空格与 Delete。", "warning"); return; }
    const conflict = findConflict(shortcuts, id, binding);
    if (conflict) { showNotice(`按键与「${shortcuts[conflict].label}」冲突，请先改绑后者。`, "warning"); return; }
    applyShortcuts({ ...shortcuts, [id]: { ...shortcuts[id], binding } });
    setRecordingId(null);
  };
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisions, setRevisions] = useState<TimelineRevisionSummary[]>([]);
  const [revisionPair, setRevisionPair] = useState({ base: "", target: "" });
  const [revisionDiff, setRevisionDiff] = useState<TimelineDiff>();
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 草稿/revision 镜像 ref：定时器触发时读取最新事实，避免闭包捕获过期 base。
  const timelineRef = useRef(timeline);
  const projectRef = useRef(project);
  const pendingDraftRef = useRef<{ base: TimelineRevisionId; epoch: number; document: TimelineDocument } | null>(null);
  timelineRef.current = timeline;
  projectRef.current = project;
  const projectNameProjectId = useRef<Project["project_id"] | undefined>(undefined);
  const projectNameDirty = useRef(false);
  const timelineLoadEpoch = useRef(0);
  // 新建项目自动补建空时间线（剪映/喵影式：项目即有时间线，无需手动创建）。
  // 仅对新建项目生效——存量无时间线项目仍走菜单「创建空时间线」。
  const autoProvisionProjectId = useRef<Project["project_id"] | undefined>(undefined);
  const pollInstanceRef = useRef<symbol | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  // B16b：编辑器负载上报（playing/scrubbing/idle）——状态转换即时推送 +
  // 1s 保活（Main 侧 lease 心跳消费；Renderer 崩溃 = 无推送 = Core TTL
  // 过期回 idle，不永久饿死后台任务）。推送失败静默（辅助通道）。
  useEffect(() => {
    const mode = progressDragging ? "scrubbing" : playing ? "playing" : "idle";
    const push = () => {
      window.desktop.updateEditorLoad(mode).catch(() => undefined);
    };
    push();
    const keepAlive = window.setInterval(push, 1_000);
    return () => {
      window.clearInterval(keepAlive);
    };
  }, [playing, progressDragging]);
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
  const beginResize = (kind: "left" | "right" | "timeline", event: React.PointerEvent) => {
    event.preventDefault();
    resizeRef.current = { kind, start: kind === "timeline" ? event.clientY : event.clientX, value: kind === "left" ? leftWidth : kind === "right" ? rightWidth : timelineHeight };
    document.body.classList.add("is-resizing");
  };

  const refreshProjects = async () => {
    const page = await window.desktop.listProjects({ limit: 100 });
    setProjects(page.items);
    const next = page.items.find(item => item.project_id === projectRef.current?.project_id) ?? page.items[0];
    if (!next) {
      projectDataEpochRef.current += 1;
      setAssets([]); setTimeline(undefined); setWorking(undefined); setSelection(null); setProject(undefined);
    } else if (next.project_id !== projectRef.current?.project_id) {
      switchProject(next);
    } else {
      setProject(next);
    }
  };
  const loadModels = async () => { const page = await window.desktop.listModels({ limit: 100 }); setModels(page.items); };
  // 活跃任务拉取（初始加载与轮询共用）：按三个活跃状态各查一页合并去重。
  // Core 的 /jobs 端点只支持单 status 过滤，历史终态任务不进 UI（会话内终态
  // 由 trackRenderJob 维持展示）；同 job_id 多页出现时以先到者为准（mock 环境
  // 三次查询可能回同一份列表，生产三状态互斥）。
  const fetchActiveJobs = async (projectId: Project["project_id"]): Promise<Job[]> => {
    const statuses = ["queued", "running", "cancelling"] as const;
    const pages = await Promise.all(statuses.map(status => window.desktop.listJobs({ project_id: projectId, status })));
    const seen = new Set<string>();
    return pages.flatMap(page => page.items).filter(item => { if (seen.has(item.job_id)) return false; seen.add(item.job_id); return true; });
  };
  // A08：loadProjectData 摘要优先——素材/任务先落库，转录正文不再全量预取
  // （正文由 viewTranscript 选中时加载，旧内容按项目代次作废不写入新状态）。
  const projectDataEpochRef = useRef(0);
  const renderDataEpochRef = useRef(0);
  const seenAnyTicketRef = useRef(false);
  const noTicketRetryRef = useRef(0);
  const noTicketFinalRetryRef = useRef(false);
  const transcriptQueueRef = useRef<BoundedTaskQueue<Transcript> | null>(null);
  /** 转录摘要分页（listTranscripts）专用队列：与正文队列分开类型，同样 ≤4 并发。 */
  const transcriptSummaryQueueRef = useRef<BoundedTaskQueue<{ items: TranscriptSummary[] }> | null>(null);
  const loadProjectData = async (selected: Project) => {
    const epoch = ++projectDataEpochRef.current;
    // GAP-LIST-ASSETS-PAGING：assets 跟随 next_cursor 翻页装载（Core 默认
    // limit=50，旧实现只取第一页——第 51+ 素材无 media ticket，合成预览回退
    // "no ticket for asset_..."，刷新素材库亦不可恢复）。200 页 = 10,000 条
    // 防病态游标环；触顶即止（行为不劣于单页现状）。
    const listAllAssets = async (projectId: Project["project_id"]) => {
      const items: Awaited<ReturnType<typeof window.desktop.listAssets>>["items"] = [];
      let cursor: string | null | undefined;
      for (let page = 0; page < 200; page++) {
        const assetPage = await window.desktop.listAssets({ project_id: projectId, ...(cursor ? { cursor } : {}) });
        items.push(...assetPage.items);
        if (!assetPage.next_cursor) break;
        cursor = assetPage.next_cursor;
      }
      return items;
    };
    const [assetsAll, activeJobs] = await Promise.all([listAllAssets(selected.project_id), fetchActiveJobs(selected.project_id)]);
    if (epoch !== projectDataEpochRef.current) return;
    setAssets(assetsAll); setJobs(activeJobs);
    // 转录摘要：每素材一次 listTranscripts——必须经有界队列（≤4 并发）。旧实现
    // 直接 Promise.all 对全部素材并发（100 素材 = 100 个并发 HTTP），会在项目
    // 装载瞬间打满本地 Core 的 accept 队列，同刻发出的 manifest 请求被
    // ECONNREFUSED（F04 复测现场）。此处落实注释承诺的"并发受限 ≤4"。
    const queue = transcriptSummaryQueueRef.current ??= new BoundedTaskQueue<{ items: TranscriptSummary[] }>(4);
    const summaries = await Promise.all(assetsAll.filter(item => isTranscribable(item.asset)).map(async item => {
      const summaryPage = await queue.push(() => window.desktop.listTranscripts(item.asset.asset_id));
      if (typeof summaryPage === "symbol") return null; // 代次过期：丢弃
      return [String(item.asset.asset_id), summaryPage.items] as const;
    }));
    if (epoch !== projectDataEpochRef.current) return; // 切项目：旧返回作废
    setTranscriptSummaries(Object.fromEntries(summaries.filter((entry): entry is readonly [string, TranscriptSummary[]] => entry !== null)));
  };
  const loadRenderData = async (selected: Project) => {
    const epoch = ++renderDataEpochRef.current;
    const [previewPage, exportPage] = await Promise.all([
      window.desktop.listPreviews({ project_id: selected.project_id, limit: 100 }),
      window.desktop.listExports({ project_id: selected.project_id, limit: 100 })
    ]);
    if (epoch !== renderDataEpochRef.current || projectRef.current?.project_id !== selected.project_id) return;
    setPreviews(previewPage.items);
    setExports(exportPage.items);
  };
  const switchProject = (next: Project) => {
    if (next.project_id === projectRef.current?.project_id) return;
    aiRunRef.current.generation += 1;
    aiRunRef.current.stop?.();
    if (aiRunRef.current.timer) clearTimeout(aiRunRef.current.timer);
    aiRunRef.current.stop = undefined;
    aiRunRef.current.timer = undefined;
    setAiOpen(false); setAiStep("form"); setAiError(""); setAiPreview(undefined); setAiCandidates([]); setAiJob(undefined); setAiPlayback(undefined);
    projectDataEpochRef.current += 1;
    renderDataEpochRef.current += 1;
    transcriptQueueRef.current?.advanceGeneration();
    transcriptSummaryQueueRef.current?.advanceGeneration();
    setAssets([]); setJobs([]); setTimeline(undefined); setWorking(undefined); setSelection(null);
    setTranscripts({}); setTranscriptSummaries({}); setViewingTranscript(undefined);
    setPreviews([]); setExports([]); setLibraryPreviewId(null); setSelectedAssetId(null);
    setPlaying(false); setSyntheticNotice(null); setPreviewMode("synthetic");
    setExportPlayback(undefined); setReframePlayback(undefined); setCoverUrl(null);
    setCvSummaries({}); setCvSparkAssetId(null); setCvSparkSamples(null); setCvBusy(null);
    setCvOptionsOpen(false); setCvOptionsAsset(null); setTranscriptionAsset(undefined); setPendingDeleteAsset(undefined);
    seenAnyTicketRef.current = false; noTicketRetryRef.current = 0; noTicketFinalRetryRef.current = false;
    if (autoProvisionProjectId.current !== next.project_id) autoProvisionProjectId.current = undefined;
    setProject(next);
  };
  // 移除一条文件已缺失的导出记录（问题2：成品文件在系统层被删后，记录
  // 保留会让列表堆积不可用条目；Core 校验文件仍存在时拒绝——UI 端不提供
  // 静默销毁成品的通道）。移除后从本地列表去掉，产物计数同步。
  const removeMissingExport = async (item: ExportRecordPresentation) => {
    if (!project) return;
    try {
      await window.desktop.deleteExportRecord({ project_id: project.project_id, export_record_id: item.export_record.export_record_id });
      setExports(items => items.filter(entry => entry.export_record.export_record_id !== item.export_record.export_record_id));
      showNotice(`已移除导出记录「${item.export_record.destination_display_name}」。`);
    } catch (error) {
      showNotice(safeErrorMessage(error, "移除导出记录失败，请稍后重试。"), "warning");
    }
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
    const projectId = project.project_id;
    const epoch = projectDataEpochRef.current;
    const generation = ++aiRunRef.current.generation;
    aiRunRef.current.stop?.();
    if (aiRunRef.current.timer) clearTimeout(aiRunRef.current.timer);
    const current = () => projectRef.current?.project_id === projectId && projectDataEpochRef.current === epoch && aiRunRef.current.generation === generation;
    try {
      setAiStep("running");
      const result = await window.desktop.createPlanning({ project_id: projectId, egress_preview_id: aiPreview.egress_preview_id, payload_sha256: aiPreview.payload_sha256 });
      if (!current()) return;
      setAiJob(result.job);
      trackRenderJob(result.job);
      const stop = window.desktop.subscribeJob(result.job.job_id, job => {
        if (!current()) { stop(); return; }
        setAiJob(job);
        if (["failed", "cancelled", "interrupted"].includes(job.status)) {
          stop(); setAiPreview(undefined); setAiStep("form"); setAiError("生成未完成。请重新准备外传内容并再次确认。");
        }
      });
      aiRunRef.current.stop = stop;
      const poll = async (): Promise<void> => {
        if (!current()) return;
        const items = await window.desktop.listCandidatePlans?.(projectId);
        if (!current()) return;
        if (items?.items.length) {
          stop(); aiRunRef.current.stop = undefined;
          setAiCandidates(items.items as unknown as Array<Record<string, unknown>>); setAiStep("candidates");
        } else {
          aiRunRef.current.timer = setTimeout(() => void poll(), 1500);
        }
      };
      void poll();
    } catch {
      if (!current()) return;
      setAiPreview(undefined); setAiError("调用失败；重试前必须重新准备并确认外传内容。"); setAiStep("form");
    }
  };
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
  const adoptAi = async (candidate: Record<string, unknown>) => { if (!project || !window.desktop.adoptCandidatePlan) return; try { const state = await window.desktop.adoptCandidatePlan({ project_id: project.project_id, candidate_plan_id: String(candidate.candidate_plan_id), adoption: { schema_version: 1, candidate_document_sha256: String(candidate.document_sha256), base_revision_id: timeline?.current_revision.timeline_revision_id ?? null } }); setTimeline(state); setWorking(state.current_revision.document); setAiOpen(false); showNotice("候选已采用为正式时间线；可使用撤销恢复。", "success"); } catch { setAiError("采用冲突：请先处理当前草稿或刷新 Timeline 后重试。"); } };
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
    try { const next = await window.desktop.applyTimelinePatchProposal({ project_id: project.project_id, proposal_id: patchProposal.timeline_patch_proposal_id, base_revision_id: patchProposal.base_revision_id, proposed_document_sha256: patchProposal.proposed_document_sha256 }); acceptState(next); closePatch(); await loadRenderData(project); showNotice("AI 修改已应用为新的正式 Revision；旧权威预览已过期。", "success"); }
    catch { setPatchError("应用冲突。请刷新 Timeline 后重新生成提案。"); }
  };
  const openRevisionCompare = async () => { if (!project) return; setRevisionDiff(undefined); setRevisionOpen(true); try { const page = await window.desktop.listTimelineRevisions({ project_id: project.project_id, limit: 100 }); setRevisions(page.items); setRevisionPair({ base: page.items[1]?.timeline_revision_id ?? page.items[0]?.timeline_revision_id ?? "", target: page.items[0]?.timeline_revision_id ?? "" }); } catch { showNotice("无法加载 Revision 历史。"); } };
  const compareRevisions = async () => { if (!project || !revisionPair.base || !revisionPair.target) return; try { setRevisionDiff(await window.desktop.compareTimelineRevisions({ project_id: project.project_id, base_revision_id: revisionPair.base as never, target_revision_id: revisionPair.target as never })); } catch { showNotice("Revision 比较失败。"); } };
  useEffect(() => {
    // The preload bridge is immutable in production, but capture it for this
    // mounted editor instance.  This prevents a late startup continuation from
    // an unmounted window from issuing requests through a subsequently created
    // renderer bridge and racing its project/timeline state.
    const desktop = window.desktop;
    let active = true;
    void desktop.getRuntime().then(async runtime => {
      if (runtime?.resource_tier) setResourceTier(runtime.resource_tier);
      if (runtime?.force_copy_to) setForceCopyTo(true);
      const [projectPage, modelPage] = await Promise.all([
        desktop.listProjects({ limit: 100 }),
        desktop.listModels({ limit: 100 })
      ]);
      if (!active) return;
      setRuntimeReady(true);
      setProjects(projectPage.items);
      const initialProject = projectPage.items[0];
      if (initialProject) switchProject(initialProject);
      else setProject(undefined);
      setModels(modelPage.items);
    }).catch(error => { if (active) showNotice(safeErrorMessage(error, "运行环境初始化失败，请刷新后重试。")); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!project) return;
    // 防御性清理：直接由外部状态驱动项目变化时，也不能保留上一项目数据。
    setAssets([]); setJobs([]); setTimeline(undefined); setWorking(undefined); setSelection(null);
    setTranscripts({}); setTranscriptSummaries({}); setViewingTranscript(undefined);
    setPreviews([]); setExports([]); setLibraryPreviewId(null); setSelectedAssetId(null);
    setPlaying(false); setSyntheticNotice(null); setPreviewMode("synthetic"); setExportPlayback(undefined); setReframePlayback(undefined); setCoverUrl(null);
    seenAnyTicketRef.current = false; noTicketRetryRef.current = 0; noTicketFinalRetryRef.current = false;
    closePatch(); setRevisionOpen(false); setRevisionDiff(undefined);
    setReframeSelections({}); setReframePreviews({}); setReframePending({}); setReframePlayback(undefined); setReframeDirectoryGrant(undefined); setActiveReframeBatch(undefined); setReframeError("");
    let active = true;
    const epoch = ++timelineLoadEpoch.current;
    // A08：切项目推进转录队列代次——在途 getTranscript 的旧返回不再写入
    // 新项目状态（viewTranscript 按 epoch 丢弃）；已缓存正文随项目清空。
    transcriptQueueRef.current?.advanceGeneration();
    transcriptSummaryQueueRef.current?.advanceGeneration();
    setTranscripts({});
    setViewingTranscript(undefined);
    void loadProjectData(project).catch(error => active && showNotice(safeErrorMessage(error, "项目数据加载失败，请刷新后重试。")));
    void loadRenderData(project).catch(error => active && showNotice(safeErrorMessage(error, "渲染记录加载失败，请刷新后重试。")));
    void window.desktop.getTimeline(project.project_id).then(value => { if (active && epoch === timelineLoadEpoch.current) { setTimeline(value); setWorking(value.current_revision.document); setSelection(null); } }).catch(async error => {
      if (!active || epoch !== timelineLoadEpoch.current) return;
      const code = errorCode(error);
      // 新建项目尚未有时间线：自动补建空时间线（剪映/喵影式，项目即有时间线），无需手动创建。
      if (autoProvisionProjectId.current === project.project_id && (code.includes("TIMELINE_NOT_FOUND") || code.includes("404"))) {
        autoProvisionProjectId.current = undefined;
        try {
          const value = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "empty" }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
          if (active && epoch === timelineLoadEpoch.current) { setTimeline(value); setWorking(value.current_revision.document); setSelection(null); }
        } catch { if (active && epoch === timelineLoadEpoch.current) showNotice(safeErrorMessage(error, "时间线加载失败，请刷新后重试。")); }
        return;
      }
      setTimeline(undefined); setWorking(undefined);
      if (!code.includes("TIMELINE_NOT_FOUND") && !code.includes("404")) showNotice(safeErrorMessage(error, "时间线加载失败，请刷新后重试。"));
    });
    return () => { active = false; };
  }, [project?.project_id]);
  useEffect(() => {
    if (!runtimeReady) return;
    // A08：轮询改「上次请求结束后再 setTimeout」（RequestScheduler）：
    // - 同端点 single-flight（后端慢于间隔时不再叠加在途请求）；
    // - 无活跃任务/后台退避 6s；前后台恢复时立即刷新一轮；
    // - 项目/任务列表内容未变不写大 state（浅比较短路）；
    // - 模型列表退出快频（只在模型事件/低频兜底刷新——见 modelEvents 计数）。
    const instance = Symbol("app-poll-instance");
    pollInstanceRef.current = instance;
    const projectsSignature = { value: "" };
    const jobsSignature = { value: "" };
    const exportsSignature = { value: "" };
    const scheduler = new RequestScheduler({
      hasActiveWork: () => jobsRef.current.some(job => ["queued", "running", "cancelling"].includes(job.status)),
    });
    scheduler.register({
      key: "projects",
      fetch: async () => window.desktop.listProjects({ limit: 100 }),
      apply: (page) => {
        if (pollInstanceRef.current !== instance) return false;
        const signature = page.items.map(item => `${item.project_id}:${item.updated_at}`).join("|");
        if (signature === projectsSignature.value) return false;
        projectsSignature.value = signature;
        setProjects(page.items);
        const next = page.items.find(item => item.project_id === projectRef.current?.project_id) ?? page.items[0];
        if (!next) {
          projectDataEpochRef.current += 1;
          setAssets([]); setTimeline(undefined); setWorking(undefined); setSelection(null); setProject(undefined);
        } else if (next.project_id !== projectRef.current?.project_id) switchProject(next);
        else setProject(next);
        return true;
      },
    });
    scheduler.register({
      key: "jobs",
      enabled: () => pollInstanceRef.current === instance,
      // 只拉活跃任务：终态任务行是会话内过程记录，历史终态不进 UI（重启即清）；
      // 轮询结果与本地合并而非覆盖，避免把会话内失败/中断记录冲掉。
      fetch: async () => {
        if (!project) return { items: [], next_cursor: null };
        return { items: await fetchActiveJobs(project.project_id), next_cursor: null };
      },
      apply: (page) => {
        if (pollInstanceRef.current !== instance) return false;
        const activeIds = new Set(page.items.map(item => item.job_id));
        // 终态对账：订阅推送（job:event）当前未接通，活跃列表是终态的唯一
        // 来源。本地仍活跃、但已不在服务端活跃列表的任务 = 刚进入终态——
        // getJob 回填真实状态，否则行会永久冻结在最后一次轮询到的运行中
        // 进度（产物实际已生成，看似卡死）。stale 数量进签名：对账请求
        // 失败时下一轮签名不同，会重试而不是被浅比较短路。
        const staleActive = jobsRef.current.filter(item => ["queued", "running", "cancelling"].includes(item.status) && !activeIds.has(item.job_id));
        const signature = `${page.items.map(item => `${item.job_id}:${item.status}:${item.progress ?? ""}`).join("|")}#${staleActive.length}`;
        if (signature === jobsSignature.value) return false;
        jobsSignature.value = signature;
        setJobs(items => [...page.items, ...items.filter(item => !activeIds.has(item.job_id))]);
        for (const job of staleActive) {
          void window.desktop.getJob(job.job_id).then(updated => {
            if (pollInstanceRef.current !== instance) return;
            const wasRunning = jobsRef.current.find(item => item.job_id === updated.job_id)?.status === "running";
            setJobs(items => {
              const current = items.find(item => item.job_id === updated.job_id);
              if (!current || current.status === updated.status) return items;
              // 成功收尾：最后一次可见进度与 100% 之间可能差一整个轮询
              // 间隔（短片校验+哈希在间隔内跑完），直接跳变很突兀——
              // 先以「收尾中」行（保留最后进度，进度条 CSS 过渡跑满）
              // 展示 finalizingMs，再落到真实终态。
              if (updated.status === "succeeded" && wasRunning && current.progress !== null && current.progress < 1) {
                const finishing: Job = { ...updated, status: "running", progress: 1 };
                setTimeout(() => {
                  if (pollInstanceRef.current !== instance) return;
                  setJobs(items => items.map(item => item.job_id === updated.job_id && item.status === "running" && item.progress === 1 ? updated : item));
                }, FINALIZING_MS);
                return [finishing, ...items.filter(item => item.job_id !== updated.job_id)];
              }
              return [updated, ...items.filter(item => item.job_id !== updated.job_id)];
            });
            // 渲染类任务终态顺带刷新产物/预览列表（导出成功立即可见）。
            if (["succeeded", "failed", "cancelled", "interrupted"].includes(updated.status)
              && (updated.kind === "authoritative_preview" || updated.kind === "final_export")
              && project) {
              void loadRenderData(project).catch(() => undefined);
            }
          }).catch(() => undefined);
        }
        return true;
      },
    });
    scheduler.register({
      key: "exports",
      enabled: () => pollInstanceRef.current === instance && renderPanelOpenRef.current,
      // 产物列表文件存在性对账（问题2）：export_dto 每次列出都实时 stat 文件，
      // 手动删除本地产物后 status 会变 missing——但此前只在任务终态/挂载时拉
      // 一次，面板开着期间永远不更新。面板打开期间随轮询刷新（签名短路，
      // 无变化不写 state；关闭面板即停，不增加常驻负载）。
      fetch: async () => {
        if (!project) return { items: [], next_cursor: null };
        return window.desktop.listExports({ project_id: project.project_id, limit: 100 });
      },
      apply: (page) => {
        if (pollInstanceRef.current !== instance) return false;
        const signature = page.items.map(item => `${item.export_record.export_record_id}:${item.export_record.status}`).join("|");
        if (signature === exportsSignature.value) return false;
        exportsSignature.value = signature;
        setExports(page.items);
        return true;
      },
    });
    scheduler.start();
    const handleVisibility = () => { if (!document.hidden) scheduler.refresh(); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      scheduler.dispose();
      if (pollInstanceRef.current === instance) pollInstanceRef.current = null;
    };
    // project 变化时重建 jobs 端点闭包（projects/models 端点与项目无关）。
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
  useEffect(() => { if (project && terminalRenderJobs) void loadRenderData(project).catch(error => showNotice(safeErrorMessage(error, "渲染记录加载失败，请刷新后重试。"))); }, [project?.project_id, terminalRenderJobs]);

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
  // 时间线终点（所有片段最大 timeline_end）：播放到达即停，标尺停在末尾。
  const timelineEndUs = useMemo(() => sortedClips.reduce((max, c) => Math.max(max, c.timeline_end_us), 0), [sortedClips]);
  const v1Clips = useMemo(() => sortedClips.filter(c => c.track_id === "V1"), [sortedClips]);
  const a1Clips = useMemo(() => sortedClips.filter(c => c.track_id === "A1"), [sortedClips]);
  const tracksAtPlayhead = working?.tracks ?? [];
  const trackById = useMemo(() => new Map(tracksAtPlayhead.map(track => [track.id, track])), [tracksAtPlayhead]);
  const anySoloTrack = tracksAtPlayhead.some(track => track.solo);
  /** 轨道级声音开关：静音关闭；存在独奏轨道时仅独奏轨出声。 */
  const isClipAudible = useCallback((clip: TimelineClip) => {
    const track = trackById.get(clip.track_id);
    if (!track) return clip.audio.enabled;
    return clip.audio.enabled && !track.muted && (!anySoloTrack || track.solo);
  }, [trackById, anySoloTrack]);
  // 预览背景 = 主轨（V1）片段（画中画合成语义：V2+ 一律以浮层叠加）。
  // V1 空档 → 背景留黑（浮层悬浮于黑底之上，对齐剪映）；**禁止回退到上层片段
  // 当全幅背景**——否则覆盖轨内容既当背景又当浮层，拖拽时"满屏不动 + 盒子飘"。
  const clipAtPlayhead = useMemo(() => {
    return sortedClips.find(c => c.track_id === "V1" && playhead >= c.timeline_start_us && playhead < c.timeline_end_us);
  }, [sortedClips, playhead]);
  const audioClipAtPlayhead = a1Clips.length > 0 ? a1Clips.find(c => playhead >= c.timeline_start_us && playhead < c.timeline_end_us) : undefined;
  const previewSpeedMilli = clipAtPlayhead?.speed_milli ?? (libraryPreviewId ? undefined : 1000);
  const previewReverse = Boolean(clipAtPlayhead?.reverse_playback);
  // 预览素材：素材箱预览优先；时间线交互预览只认播放头处的 V1 背景——
  // 不回退到选中片段/首片段（否则 V1 空档时覆盖轨内容被错误地满屏铺底）。
  const previewAsset = (libraryPreviewId ? assets.find(item => item.asset.asset_id === libraryPreviewId) : undefined) ?? (clipAtPlayhead ? assets.find(item => item.asset.asset_id === clipAtPlayhead.asset_id) : undefined);
  // P1 扩展：主轨片段静态变换同样作用于交互预览（中心点语义，与渲染一致）。
  const mainTransform = clipAtPlayhead?.transform;
  const mainTransformStyle = mainTransform
    ? { transform: `translate(${((mainTransform.x ?? 0.5) - 0.5) * 100}%, ${((mainTransform.y ?? 0.5) - 0.5) * 100}%) scale(${mainTransform.scale ?? 1}) rotate(${mainTransform.rotate ?? 0}deg)`, opacity: mainTransform.opacity ?? 1 }
    : undefined;
  const audioAsset = audioClipAtPlayhead ? assets.find(item => item.asset.asset_id === audioClipAtPlayhead.asset_id) : undefined;
  useEffect(() => {
    const media = videoRef.current;
    if (media) {
      if (pendingSeekRef.current !== null) { media.currentTime = pendingSeekRef.current; pendingSeekRef.current = null; }
      // 交互预览跟随片段变速（倒放无法反向播放，仅回退原速）。
      media.playbackRate = previewReverse ? 1 : Math.max(0.25, Math.min(4, (previewSpeedMilli ?? 1000) / 1000));
      if (!libraryPreviewId && clipAtPlayhead) {
        // 标尺跟随校正：播放头是唯一时钟，媒体时间与标尺偏差 >0.18s 时对齐——
        // 防止内容错位（标尺在 A 片段却播着 B 片段内容）。
        const sourceStart = (clipAtPlayhead.source_start_us ?? 0) / 1_000_000;
        const speed = previewReverse ? 1 : Math.max(0.25, Math.min(4, (previewSpeedMilli ?? 1000) / 1000));
        const expected = sourceStart + ((playhead - clipAtPlayhead.timeline_start_us) / 1_000_000) * speed;
        if (media.readyState >= 1 && Math.abs(media.currentTime - expected) > 0.18) media.currentTime = Math.max(0, expected);
      }
      if (playing && (libraryPreviewId || clipAtPlayhead)) {
        media.play().catch(() => {
          // 预览模式切换后元素为全新挂载、媒体仍在加载：play 以 AbortError
          // （interrupted by a new load request）被打断属瞬态——播放头时钟每
          // 100ms 会重入本 effect 自动重试；仅真实解码错误（media.error）才停播。
          // 此前无条件 setPlaying(false) → 权威预览切回交互后"无法播放"。
          if (media.error) setPlaying(false);
        });
      } else {
        media.pause();
      }
    }
    const audio = audioRef.current;
    if (audio) {
      if (audioClipAtPlayhead && isClipAudible(audioClipAtPlayhead)) {
        const sourceStart = (audioClipAtPlayhead.source_start_us ?? 0) / 1_000_000;
        const elapsed = (playhead - audioClipAtPlayhead.timeline_start_us) / 1_000_000;
        audio.currentTime = sourceStart + elapsed * ((audioClipAtPlayhead.speed_milli ?? 1000) / 1000);
        audio.playbackRate = Math.max(0.25, Math.min(4, (audioClipAtPlayhead.speed_milli ?? 1000) / 1000));
        if (playing) void audio.play().catch(() => {}); else audio.pause();
      } else {
        audio.pause();
      }
    }
  }, [playing, previewMode, previewAsset?.media_url, audioAsset?.media_url, playhead, previewSpeedMilli, previewReverse, audioClipAtPlayhead, isClipAudible]);
  // 音量动画（电平表）：挂接预览视频的实时输出电平，左右声道各一根跳动条。
  // MediaElementAudioSourceNode 对同一元素只能创建一次且会接管出声路由，
  // 因此音频图为按元素缓存的持久结构：暂停只停轮询，不销毁图（销毁会让元素永久失声）。
  // 电平值直接写 DOM 高度，避免 60fps 触发整棵组件树重渲。
  type VuGraph = { ctx: AudioContext; analyserL: AnalyserNode; analyserR: AnalyserNode; dataL: Uint8Array<ArrayBuffer>; dataR: Uint8Array<ArrayBuffer>; raf: number };
  const vuGraphRef = useRef<{ el: HTMLMediaElement; graph: VuGraph } | null>(null);
  const vuBarLRef = useRef<HTMLElement | null>(null);
  const vuBarRRef = useRef<HTMLElement | null>(null);
  const stopVuPolling = useCallback(() => {
    const entry = vuGraphRef.current;
    if (entry) cancelAnimationFrame(entry.graph.raf);
    if (vuBarLRef.current) vuBarLRef.current.style.height = "30%";
    if (vuBarRRef.current) vuBarRRef.current.style.height = "30%";
  }, []);
  useEffect(() => {
    if (!playing) { stopVuPolling(); return; }
    const media = videoRef.current;
    if (!media || media.readyState === 0) {
      // 元素尚未加载出元数据（刚切素材就按播放）：等 canplay 后重试一次挂接。
      if (media) {
        const retry = () => setVuEpoch(epoch => epoch + 1);
        media.addEventListener("canplay", retry, { once: true });
        return () => media.removeEventListener("canplay", retry);
      }
      return;
    }
    const AudioCtx = window.AudioContext;
    if (!AudioCtx) return;
    const attach = (): VuGraph | null => {
      if (vuGraphRef.current?.el === media) return vuGraphRef.current.graph;
      const graph = vuGraphRef.current?.graph;
      if (graph) cancelAnimationFrame(graph.raf);
      try {
        const ctx = new AudioCtx();
        const source = ctx.createMediaElementSource(media);
        const splitter = ctx.createChannelSplitter(2);
        const analyserL = ctx.createAnalyser();
        const analyserR = ctx.createAnalyser();
        analyserL.fftSize = 256;
        analyserR.fftSize = 256;
        source.connect(splitter);
        splitter.connect(analyserL, 0);
        splitter.connect(analyserR, 1);
        source.connect(ctx.destination);
        const entry = { el: media, graph: { ctx, analyserL, analyserR, dataL: new Uint8Array(analyserL.frequencyBinCount), dataR: new Uint8Array(analyserR.frequencyBinCount), raf: 0 } };
        vuGraphRef.current = entry;
        return entry.graph;
      } catch {
        // 元素已被其他图接管（理论不可达：图按元素缓存复用）时静默降级，改用模拟电平。
        return null;
      }
    };
    const entryGraph = attach();
    // 模拟电平：无真实音频图（AudioContext 不可用 / 挂接失败 / 媒体无声音轨）时，
    // 用当前音量值驱动两条跳动，保证播放中每帧都有动画 —— 杜绝"点了播放却一动不动"。
    const paintVu = (levelL: number, levelR: number) => {
      if (vuBarLRef.current) vuBarLRef.current.style.height = `${(30 + levelL * 70).toFixed(1)}%`;
      if (vuBarRRef.current) vuBarRRef.current.style.height = `${(30 + levelR * 70).toFixed(1)}%`;
    };
    if (!entryGraph) {
      let simL = 0.3, simR = 0.3, tL = 0.3, tR = 0.3, raf = 0;
      const tick = () => {
        simL += (tL - simL) * 0.3; simR += (tR - simR) * 0.3;
        if (Math.random() < 0.35) { tL = 0.3 + Math.random() * 0.7; tR = 0.3 + Math.random() * 0.7; }
        const amp = Math.max(0.2, volumeRef.current / 100);
        paintVu(simL * amp, simR * amp);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    void entryGraph.ctx.resume().catch(() => undefined);
    const avg = (data: Uint8Array<ArrayBuffer>) => data.reduce((sum, value) => sum + value, 0) / (data.length * 255);
    const tick = () => {
      const entry = vuGraphRef.current;
      if (!entry || entry.graph !== entryGraph) return;
      entry.graph.analyserL.getByteFrequencyData(entry.graph.dataL);
      entry.graph.analyserR.getByteFrequencyData(entry.graph.dataR);
      const levelL = Math.min(1, avg(entry.graph.dataL) * 1.6);
      const levelR = Math.min(1, avg(entry.graph.dataR) * 1.6);
      // 真实音频无声（电平均为 0）时也退化为音量模拟，保证有可见动画。
      if (levelL + levelR < 0.02) {
        const amp = Math.max(0.2, volumeRef.current / 100);
        paintVu((0.3 + Math.random() * 0.5) * amp, (0.3 + Math.random() * 0.5) * amp);
      } else {
        paintVu(levelL, levelR);
      }
      entry.graph.raf = requestAnimationFrame(tick);
    };
    entryGraph.raf = requestAnimationFrame(tick);
    return stopVuPolling;
  }, [playing, previewAsset?.media_url, previewMode, vuEpoch, stopVuPolling]);
  const visibleCaption = working?.captions.find(item => playhead >= item.start_us && playhead < item.end_us) ?? selectedCaption;
  const totalUs = duration(working);
  // 播放/暂停统一入口：播放头停在时间线末尾时，再次播放从头开始。
  const togglePlayback = () => {
    if (!playing && timelineEndUs > 0 && playhead >= timelineEndUs) setPlayhead(0);
    setPlaying(value => !value);
  };
  // ── 播放头命令通道（A06）──────────────────────────────────────────────────
  // source 语义（计划 A06 第 4 条）：user = 用户主动 seek（拖动标尺/点字幕/
  // 方向键），playback = 预览播放回传，external = 库预览等其余路径。
  // 用户命令递增 requestId；播放回传按「当前请求 ID 是否仍等于发出时 ID」
  // 判定是否作废——连续快速拖动时旧回传不再回写 UI。
  // 两条通道都写 playheadStore（覆盖层高频跟随），React `playhead` 状态仍保持
  // 10Hz 节流更新（App commit 频率不随 rAF 提升——A06 验收指标）。
  const dispatchPlayhead = useCallback((source: "user" | "playback" | "external", timeUs: number, commitReact: boolean) => {
    playheadStore.dispatch({ source, timeUs });
    if (commitReact) setPlayhead(timeUs);
  }, [playheadStore]);
  /** 用户主动 seek：立即同步 React 状态（交互跟手），后续 playback 回传在
   *  新的用户命令到达前被 10Hz 节流合并。播放中 seek = 暂停 + 跳转（剪映
   *  语义）：合成预览在 playing 时忽略外部 seek（防自身上报回环）、交互
   *  预览的 100ms 播放时钟会把播放头拉回播放轨道——不先暂停则点击被吞。 */
  const seekFromUser = useCallback((timeUs: number) => {
    setPlaying(false);
    dispatchPlayhead("user", timeUs, true);
  }, [dispatchPlayhead]);
  /** 预览播放回传：只写 store（覆盖层命令式跟随）+ 节流 React。
   *
   *  P33 W10（dev 流畅度收口）：**播放期间不再提交 React** —— 时间码/进度条的
   *  每个显示位在播放中由 `applyPlayheadDom` 直接写 DOM（见下），App 组件树在
   *  整个播放段保持静止。实测依据：dev 构建下每次 App 提交 ~36ms（StrictMode
   *  双渲染 + 未压缩协调），4Hz 提交即把主线程切成 rAF p95 ~50ms 的碎片，呈现
   *  循环因此跳帧；生产构建每次提交便宜得多，结论同向（更多余量）。
   *  暂停/用户 seek/片尾结束时仍走 React 提交，保证状态与 DOM 一致。 */
  const lastReactTimeReport = useRef(0);
  const PLAYBACK_COMMIT_INTERVAL_MS = import.meta.env.DEV ? 250 : 100;
  /** 播放态 ref 镜像：会话回调（onTimeUs）在会话创建时只捕获一次闭包，
   *  必须经 ref 读「此刻是否在播放」，不能依赖每次渲染新生成的闭包。 */
  const playingRef = useRef(false);
  /** 播放中播放头 DOM 直写（时间码 / 进度气泡 / 填充 / aria-valuenow）。
   *  每次渲染重新赋值 → 闭包内始终是当前 totalUs/previewFps/refs。 */
  const playheadDomRef = useRef<(us: number) => void>(() => undefined);
  const seekFromPlayback = useCallback((timeUs: number) => {
    const now = performance.now();
    if (playingRef.current) {
      playheadDomRef.current(timeUs); // 播放中：零 React 提交
      lastReactTimeReport.current = now;
      return;
    }
    const commit = now - lastReactTimeReport.current >= PLAYBACK_COMMIT_INTERVAL_MS;
    dispatchPlayhead("playback", timeUs, commit);
    if (commit) lastReactTimeReport.current = now;
  }, [dispatchPlayhead]);
  // 时间线驱动播放：播放头是唯一时钟（100ms 步进推进，媒体元素跟随标尺——
  // 所见即所得：标尺在哪个片段，播放的就是那个片段的内容）。
  // 到达时间线末尾：停在末尾（不回跳、不自动续播），再次播放从头开始。
  useEffect(() => {
    if (!playing || previewMode !== "interactive" || libraryPreviewId) return;
    const timer = window.setInterval(() => {
      // 交互预览的 100ms 时钟：直接派发 playback 源（store + React 同步——
      // 本 interval 本身就是 10Hz，节流层不再叠加延迟）。
      const ph = playheadStore.get();
      const next = ph + 100_000;
      if (timelineEndUs > 0 && next >= timelineEndUs) {
        dispatchPlayhead("playback", timelineEndUs, true);
        setPlaying(false);
        return;
      }
      dispatchPlayhead("playback", next, true);
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing, previewMode, libraryPreviewId, timelineEndUs, playheadStore, dispatchPlayhead]);
  const handleVideoEnded = () => {
    // 素材箱预览只有一个媒体源，ended 才代表本次播放结束。时间线交互
    // 预览的 video 只是当前片段的源窗口：源文件 EOF 不等于时间线 EOF，
    // 播放头时钟会在下一个 tick 切到后续片段（或保持 V1 空档黑场）。
    if (libraryPreviewId) setPlaying(false);
  };

  // ── 稳定依赖（A06 第 5 条）：传给 TimelinePanel / SyntheticPreview 的数组与
  // Map 改为 useMemo——播放头 10Hz 更新不再重建这些 props，下游 memo 化的
  // 子组件不再整树重渲（此前每次 App 渲染都 new Map/new array）。
  const timelineAssetMedia = useMemo(
    () => assets.map(item => ({ asset_id: item.asset.asset_id, media_url: item.media_url, kind: item.asset.kind, display_name: item.asset.display_name })),
    [assets],
  );
  const syntheticMediaUrls = useMemo(
    () => new Map(assets.flatMap(item => item.media_url ? [[item.asset.asset_id, item.media_url] as const] : [])),
    [assets],
  );
  // B11：预览源解析器（视频输入优先代理票据；失败/未 ready 静默回退原源，
  // 预览永不因代理缺失阻塞）。项目切换即换实例（resolver 绑定项目授权域）。
  const projectStateReady = Boolean(project && timeline && working && timeline.project_id === project.project_id && timeline.current_revision.project_id === project.project_id && working.project_id === project.project_id);
  const previewSourceResolver = useMemo(
    () => project ? new PreviewSourceResolver({
      getPreviewSource: input => window.desktop.getPreviewSource({ ...input, project_id: project.project_id }),
      previewSourceMediaUrl: input => window.desktop.previewSourceMediaUrl({ ...input, project_id: project.project_id }),
    }, project.project_id) : null,
    [project],
  );
  // B14：素材级持久化波形缓存（时间轴峰值来源；会话内 LRU 字节上限，
  // 切项目换实例）。Renderer 不再 fetch 整媒体 + decodeAudioData 生成波形。
  const waveformCache = useMemo(
    () => project ? new WaveformCache({
      getWaveform: input => window.desktop.getWaveform({ ...input, project_id: project.project_id }),
      waveformMediaUrl: input => window.desktop.waveformMediaUrl({ ...input, project_id: project.project_id }),
    }, project.project_id) : null,
    [project?.project_id],
  );
  useEffect(() => () => { waveformCache?.dispose(); }, [waveformCache]);
  const syntheticAudioByClip = useMemo(
    () => new Map((working?.clips ?? []).flatMap(clip => clip.audio ? [[clip.clip_id, { enabled: isClipAudible(clip), gainDb: clip.audio.gain_db }] as const] : [])),
    [working, isClipAudible],
  );
  const syntheticPipClips = useMemo(
    () => (working?.clips ?? []).filter(clip => clip.track_id !== "V1" && clip.track_id !== "A1" && clip.asset_kind !== "audio").map(clip => ({ clipId: clip.clip_id, transform: { x: clip.transform?.x, y: clip.transform?.y, scale: clip.transform?.scale, rotate: clip.transform?.rotate, opacity: clip.transform?.opacity }, mask: clip.mask ?? undefined })),
    [working],
  );
  // GAP-LIST-ASSETS-PAGING 后续（2026-09-15 F04 复测暴露）：100 素材翻页装载
  // 时窗内 working/timeline 先到位 → SyntheticPreview 以空 mediaUrls 建会话
  // → "no ticket" 回退并卸载组件，此后票据到位也无人重挂。修法 = 两段：
  // (a) SyntheticPreview 侧 mediaUrls 进会话重建依赖（票据变更即重建）；
  // (b) 此处对"缺票据"型回退做自动恢复——票据齐备即切回合成预览。
  // 挂载不设门槛：门槛会把"素材库未就绪"变成永久挂起（F07 复测暴露）。
  const syntheticTicketsReady = useMemo(
    () => Boolean(working) && working!.clips.every(clip => syntheticMediaUrls.has(clip.asset_id)),
    [working, syntheticMediaUrls],
  );
  /** 启动时序（2026-09-23 用户反馈）：getTimeline 先于 listAssets 落地时，
   *  SyntheticPreview 以空 mediaUrls 建会话 → 回退（"no ticket"，或装载窗内
   *  的其他瞬时错误如字体抓取失败）。这不是故障而是装载次序——首个 ticket
   *  到达前项目数据仍在装载，回退不亮错误不切交互预览（保持 synthetic，
   *  票据到位由 mediaUrls 依赖自动重建会话）。一旦见过任一票据（装载完成、
   *  mediaUrls 进入稳态），后续回退即视为真实故障，走原有回退+重试链。
   *  F07 门控教训仍有效：挂载本身不设门槛。 */
  if (syntheticMediaUrls.size > 0) seenAnyTicketRef.current = true;
  useEffect(() => {
    // 静默窗：票据从未就绪（项目数据装载中）且非用户手动重试 → 不亮错误，
    // synthetic 模式保持挂载，票据到位（mediaUrls 变化）自动重建会话。
    if (previewMode === "synthetic" && syntheticNotice === null && !seenAnyTicketRef.current) return;
    // 仅恢复"缺票据"回退；其余回退（子集不支持/WebGL 不可用等）保持交互预览，
    // 否则会与真实失败形成重试环。
    if (previewMode !== "interactive" || !syntheticNotice?.includes("no ticket")) return;
    if (syntheticTicketsReady) {
      setSyntheticNotice(null);
      setPreviewMode("synthetic");
      return;
    }
    // 装载窗内的回退（从未见过票据）：静默拉回合成模式——票据到位由
    // syntheticMediaUrls 依赖自动驱动重建，重取反而打满装载中的项目数据链。
    // 已见过票据后的缺票才走有界重签重试。
    if (!seenAnyTicketRef.current) {
      setSyntheticNotice(null);
      setPreviewMode("synthetic");
      return;
    }
    // 票据签发是瞬时操作，而 assetPresentation 会把失败的 resolveAsset 折成
    // media_url=null 且不重试——缺票因此永久化（F04 复测现场）。此处重取一次
    // 素材列表（重新签发全部票据）；有界 3 次，避免与真实失败形成重试环。
    if (!project) return;
    if (noTicketRetryRef.current >= 3) {
      // 预算耗尽后一次延迟终验：前 3 次重取可能全部撞上 Core 瞬时抖动而整页
      // 缺票；5s 后（退避覆盖抖动窗）做第 4 次也是最后一次重取，票据到位则
      // 恢复，否则如实停在回退态（不再环）。
      if (noTicketFinalRetryRef.current) return;
      noTicketFinalRetryRef.current = true;
      const timer = window.setTimeout(() => { void loadProjectData(project).catch(() => undefined); }, 5000);
      return () => window.clearTimeout(timer);
    }
    noTicketRetryRef.current += 1;
    void loadProjectData(project).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, syntheticNotice, syntheticTicketsReady, project?.project_id, syntheticMediaUrls]);

  const acceptState = (next: TimelineState) => { timelineLoadEpoch.current += 1; setTimeline(next); setWorking(next.current_revision.document); setSaveState("已保存"); setNotice(""); };
  // 提示条统一入口：显式分级（默认错误红色），并在数秒后自动消失；连续提示会重置计时。
  const showNotice = useCallback((text: string, tone: NoticeTone = "error") => { setNotice(text ? { text, tone } : ""); }, []);
  useEffect(() => {
    if (notice === "") return;
    const timer = window.setTimeout(() => setNotice(""), notice.tone === "error" ? 10_000 : 4_500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const handleConflict = async (error: unknown) => {
    const text = errorCode(error);
    if (text.includes("TIMELINE_CONFLICT") || text.includes("TIMELINE_DRAFT_CONFLICT") || text.includes("409")) {
      setSaveState("草稿冲突"); showNotice("时间线已在其他操作中更新。已刷新当前事实，请检查后重新应用你的修改。", "warning");
      if (project) acceptState(await window.desktop.getTimeline(project.project_id));
    } else { setSaveState("保存失败"); showNotice(safeErrorMessage(error, "时间线保存失败，请刷新后重试。")); }
  };
  const patchTimeline = async (operations: TimelinePatchOperation[], summary: string) => {
    if (!project || !timeline) return;
    setSaveState("保存中");
    try {
      const next = await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: timeline.current_revision.timeline_revision_id, operations, summary } });
      // patch 已包含草稿内容：作废挂起草稿，防止用过期 base 触发 409。
      pendingDraftRef.current = null;
      if (draftTimer.current) clearTimeout(draftTimer.current);
      acceptState(next);
    }
    catch (error) { await handleConflict(error); }
  };
  // 文本素材（剪映式）：默认文本 = 在播放头处插入 3s 手工字幕；
  // 导入本地字幕 = 解析 SRT/ASS/SSA/LRC 为条目批量落库（可替换旧手工字幕）。
  const insertDefaultText = async () => {
    if (!project) return;
    const start = Math.round(playhead);
    await patchTimeline(
      [{ op: "add_caption", start_us: start, end_us: start + 3_000_000, text: "默认文本", preset_id: "default-bottom", source_clip_id: null }],
      "添加默认文本",
    );
    setNotice("");
  };
  const importSubtitleFile = async () => {
    if (!project) return;
    try {
      const picked = await window.desktop.importSubtitle();
      if (!picked) return;
      const entries = parseSubtitleFile(picked.file_name, picked.content);
      const hasManual = (working?.captions ?? []).some(caption => caption.origin === "user");
      await patchTimeline(
        [{ op: "import_captions", entries, preset_id: "default-bottom", replace_existing: hasManual }],
        `导入字幕 ${picked.file_name}（${entries.length} 条）`,
      );
      setNotice("");
    } catch (error) {
      showNotice(safeErrorMessage(error, "字幕导入失败：仅支持 SRT / ASS / SSA / LRC。"));
    }
  };
  const queueDraft = (document: TimelineDocument) => {
    setWorking(document); setSaveState("保存中");
    // 记录排队时的草稿基线 + revision epoch；触发时比对——
    // patch 已前进 revision（epoch 变化）→ 草稿内容已被 patch 涵盖，直接丢弃，
    // 避免用过期 base 打 draft-save 造成 409 风暴。
    const queuedBase = timelineRef.current?.current_revision.timeline_revision_id;
    if (!queuedBase) return;
    pendingDraftRef.current = {
      base: queuedBase,
      epoch: timelineLoadEpoch.current,
      document,
    };
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      const pending = pendingDraftRef.current;
      pendingDraftRef.current = null;
      const projectNow = projectRef.current;
      const timelineNow = timelineRef.current;
      if (!pending || !projectNow || !timelineNow) return;
      if (timelineLoadEpoch.current !== pending.epoch || timelineNow.current_revision.timeline_revision_id !== pending.base) {
        // 已被 patch 取代：丢弃草稿，不落库。
        setSaveState("已保存");
        return;
      }
      void window.desktop.saveTimelineDraft({ project_id: projectNow.project_id, draft: { schema_version: 1, base_revision_id: pending.base, document: pending.document } }).then(() => setSaveState("已保存")).catch(error => {
        // 草稿是临时态：409（基线过期）说明已被更新事实取代，静默丢弃，避免错误风暴。
        const text = errorCode(error);
        if (text.includes("DRAFT_CONFLICT") || text.includes("409")) { setSaveState("已保存"); return; }
        setSaveState("保存失败");
        showNotice(safeErrorMessage(error, "时间线保存失败，请刷新后重试。"));
      });
    }, 400);
  };
  const createTimeline = async (source: Parameters<typeof window.desktop.createTimeline>[0]["timeline"]["source"]) => {
    if (!project) return;
    setSaveState("保存中");
    try { acceptState(await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source, default_layout: "blurred_background", caption_preset_id: "default-bottom" } })); }
    catch (error) { await handleConflict(error); }
  };
  const nextVideoTrackId = useCallback(() => {
    const used = new Set((working?.tracks ?? []).map(track => track.id));
    let number = 2;
    while (used.has(`V${number}`)) number += 1;
    return `V${number}`;
  }, [working?.tracks]);
  // P1 画中画：交互预览画布上展示覆盖轨片段（V2+，轨道未隐藏）。
  // 播放头区间内的片段常驻；**被选中的覆盖轨片段无论播放头在哪都显示**——
  // 否则在时间线上选中片段调属性时，画布上没有盒子可看（"调了没效果"）。
  // 盒子尺寸 = 内容实际大小（素材等比适配进画布；剪映式选中框紧贴真实内容）。
  const overlayPips = useMemo<PipOverlay[]>(() => {
    if (previewMode !== "interactive" || !working) return [];
    const result: PipOverlay[] = [];
    const selectedOverlay = selectedClip && selectedClip.track_id !== "V1" && selectedClip.track_id !== "A1" && selectedClip.asset_kind !== "audio" ? selectedClip : undefined;
    const canvasW = canvasSize?.w || canvasRef.current?.clientWidth || 540;
    const canvasH = canvasSize?.h || canvasRef.current?.clientHeight || 960;
    // 内容适配尺寸：等比适配进画布（未知尺寸回退满画布）。
    const fitted = (assetId: string) => {
      const asset = assets.find(item => item.asset.asset_id === assetId);
      const info = asset?.asset.media_info;
      const stream = info && "video_streams" in info && Array.isArray(info.video_streams) ? info.video_streams[0] : undefined;
      const codedW = stream?.width ?? 0;
      const codedH = stream?.height ?? 0;
      if (!codedW || !codedH) return { w: canvasW, h: canvasH };
      const fit = Math.min(canvasW / codedW, canvasH / codedH);
      return { w: Math.max(2, Math.round(codedW * fit)), h: Math.max(2, Math.round(codedH * fit)) };
    };
    for (const track of tracksAtPlayhead) {
      if (track.kind !== "video" || track.hidden || track.id === "V1" || track.id === "A1") continue;
      const clip = selectedOverlay?.track_id === track.id
        ? (sortedClips.find(c => c.clip_id === selectedOverlay.clip_id) ?? selectedOverlay)
        : sortedClips.find(c => c.track_id === track.id && playhead >= c.timeline_start_us && playhead < c.timeline_end_us);
      if (!clip) continue;
      const asset = assets.find(item => item.asset.asset_id === clip.asset_id);
      if (!asset?.media_url) continue;
      const fit = fitted(clip.asset_id);
      result.push({
        clip,
        media_url: asset.media_url,
        fit_w: clip.layout === "crop_fill" ? canvasW : fit.w,
        fit_h: clip.layout === "crop_fill" ? canvasH : fit.h,
      });
    }
    return result;
  }, [previewMode, working, tracksAtPlayhead, sortedClips, playhead, assets, selectedClip, canvasSize]);
  const draftPipTransform = (clipId: TimelineClip["clip_id"], transform: PipTransform) => {
    setWorking(doc => doc ? { ...doc, clips: doc.clips.map(c => c.clip_id === clipId ? { ...c, transform: { ...c.transform, ...transform } } : c) } : doc);
  };
  const commitPipTransform = (clipId: TimelineClip["clip_id"], transform: PipTransform) => {
    void patchTimeline([{ op: "set_clip_transform", clip_id: clipId, transform }], "画中画画布局");
  };
  // P2 画布蒙版边界：draft 走本地文档，pointerup 提交 set_clip_mask（与属性面板同一 op）。
  const draftPipMask = (clipId: TimelineClip["clip_id"], mask: NonNullable<TimelineClip["mask"]>) => {
    setWorking(doc => doc ? { ...doc, clips: doc.clips.map(c => c.clip_id === clipId ? { ...c, mask } : c) } : doc);
  };
  const commitPipMask = (clipId: TimelineClip["clip_id"], mask: NonNullable<TimelineClip["mask"]>) => {
    void patchTimeline([{ op: "set_clip_mask", clip_id: clipId, mask }], "画中画蒙版");
  };
  // 画中画手势期间暂停预览播放：播放头前进会越出片段区间，浮层会被移除（"弹出去"）。
  // 注意必须冻结播放头时钟本身（interval 检查该标记），只暂停视频元素是不够的。
  const gestureHoldRef = useRef(false);
  const pausePreviewPlayback = () => { gestureHoldRef.current = true; const video = videoRef.current; if (video && !video.paused) { video.pause(); return true; } return false; };
  const resumePreviewPlayback = (wasPlaying: boolean) => { gestureHoldRef.current = false; if (wasPlaying) void videoRef.current?.play().catch(() => {}); };
  const pipSelectedId = selectedClip?.clip_id ?? null;
  // 覆盖轨片段选中时隐藏「画布尺寸框」（白框贴合整个画布，会盖过浮层自己的
  // 内容选中框）；浮层的选中框 + 8 向手柄由 PreviewPipOverlays 提供。
  const overlayClipSelected = Boolean(selectedClip && selectedClip.track_id !== "V1" && selectedClip.track_id !== "A1");
  const showSelBox = !overlayClipSelected;
  const pipLocked = pipSelectedId ? Boolean(working?.locked_elements?.includes(pipSelectedId)) : false;
  const insertAsset = (item: AssetPresentation, atIndex = working?.clips.length ?? 0, trackId?: string | "new") => {
    if (!timeline) return void createTimeline({ kind: "full_asset", asset_id: item.asset.asset_id });
    const isVisual = item.asset.kind === "video" || item.asset.kind === "image";
    // 自动建轨（剪映式）：视频/图片素材落到上部空白区（"new"）或文本轨上时，
    // 先新建一条视频轨再把素材放进去；音频素材固定 A1。
    if (isVisual && trackId === "new") {
      const newTrackId = nextVideoTrackId();
      void patchTimeline([
        { op: "add_track", kind: "video" },
        { op: "insert_asset_clip", asset_id: item.asset.asset_id, at_index: 0, track_id: newTrackId, ...(item.asset.kind === "image" ? { duration_us: 3_000_000 } : {}) },
      ], `新增视频轨并放入 ${item.asset.display_name}`);
      return;
    }
    // 目标轨道类型校验：视频/图片素材可落入任意视频轨（默认主轨 V1）。
    let targetTrackId: string | undefined;
    if (isVisual && trackId) {
      const target = working?.tracks.find(track => track.id === trackId);
      if (target?.kind === "video") targetTrackId = target.id;
    }
    void patchTimeline([{
      op: "insert_asset_clip",
      asset_id: item.asset.asset_id,
      at_index: atIndex,
      ...(item.asset.kind === "image" ? { duration_us: 3_000_000 } : {}),
      ...(targetTrackId ? { track_id: targetTrackId } : {}),
    }], `追加素材 ${item.asset.display_name}`);
  };
  // 应用内剪贴板（M2 A3）：复制 V1 视频片段快照，粘贴回放到播放头。
  const clipboardClips = useRef<Array<{ asset_id: AssetId; asset_kind: "video" | "image"; source_start_us: number | null; source_end_us: number | null; speed_milli: number; reverse_playback: boolean; layout: TimelineLayout }>>([]);
  const insertableClipboardAssets = (snapshots: typeof clipboardClips.current) => snapshots.filter(item => {
    const asset = assets.find(candidate => candidate.asset.asset_id === item.asset_id);
    return Boolean(asset && (item.asset_kind === "image" || asset.asset.availability === "available"));
  });
  const dropAsset = (assetId: string, atIndex: number, trackId?: string | "new") => {
    const item = assets.find(candidate => candidate.asset.asset_id === assetId);
    if (!item || item.asset.availability !== "available") { showNotice("该素材当前不可用，无法加入时间线。", "warning"); return; }
    if (item.asset.kind !== "video" && item.asset.kind !== "image" && item.asset.kind !== "audio") { showNotice("该素材类型暂不支持拖入时间线。", "warning"); return; }
    // 视频素材落到 A1 音频轨：取其音轨作为音频片段（M3-3 as_audio 语义）。
    if (item.asset.kind === "video" && trackId === "A1") {
      void patchTimeline([{
        op: "insert_asset_clip",
        asset_id: item.asset.asset_id,
        at_index: atIndex,
        as_audio: true,
      }], `以音轨形式加入音频轨 ${item.asset.display_name}`).catch(() => undefined);
      return;
    }
    // 视频/图片素材落到文本轨上：同样自动新建视频轨（剪映式）。
    let resolvedTrackId: string | "new" | undefined = trackId;
    const isVisual = item.asset.kind === "video" || item.asset.kind === "image";
    if (isVisual && typeof trackId === "string" && trackId !== "new") {
      const target = working?.tracks.find(track => track.id === trackId);
      if (target && target.kind !== "video") resolvedTrackId = "new";
    }
    insertAsset(item, atIndex, resolvedTrackId);
  };
  const insertSegments = (transcript: Transcript) => {
    const ids = selectedSegments[transcript.transcript_id] ?? [];
    if (!ids.length) return;
    const source = { kind: "transcript_selection" as const, transcript_id: transcript.transcript_id, segment_ids: ids as never[], padding_before_us: 150_000, padding_after_us: 150_000, create_captions: true };
    if (timeline) void patchTimeline([{ op: "insert_transcript_segments", transcript_id: transcript.transcript_id, segment_ids: ids as never[], at_index: working?.clips.length ?? 0, padding_before_us: 150_000, padding_after_us: 150_000, create_captions: true, layout: "blurred_background" }], "追加转录选段"); else void createTimeline(source);
  };
  const createProject = async () => { if (!newProject.trim()) return; const created = await window.desktop.createProject({ name: newProject.trim(), canvas: projectCanvasPresets[newProjectRatio] }); setNewProject(""); autoProvisionProjectId.current = created.project_id; await refreshProjects(); switchProject(created); setProjectDialogOpen(false); };
  const renameProject = async () => { if (!project || !projectName.trim()) return; const updated = await window.desktop.renameProject({ project_id: project.project_id, name: projectName.trim() }); projectNameDirty.current = false; setProject(updated); setProjects(items => items.map(item => item.project_id === updated.project_id ? updated : item)); };
  const toggleArchive = async () => { if (!project) return; const updated = project.status === "archived" ? await window.desktop.reopenProject(project.project_id) : await window.desktop.archiveProject(project.project_id); setProject(updated); setProjects(items => items.map(item => item.project_id === updated.project_id ? updated : item)); };
  const importAsset = async (kind: AssetKind) => { if (!project) return; const result = await window.desktop.importAsset({ project_id: project.project_id, kind }); if (result) setAssets(items => [...items, { asset: result.asset, media_url: result.media_url }]); };
  // 素材库刷新：逐个让 Core 重扫本地文件；已删除的素材清理出列表
  // （无时间线引用时直接删除，仍被引用时保留并标记缺失）。
  const refreshAssets = async () => {
    if (!project || refreshingAssets) return;
    const projectId = project.project_id;
    const epoch = projectDataEpochRef.current;
    setRefreshingAssets(true);
    try {
      const current = assets;
      const refreshed = await Promise.all(current.map(async item => {
        try { return await window.desktop.refreshAsset(item.asset.asset_id); } catch { return item; }
      }));
      const missing = refreshed.filter(item => item.asset.availability === "missing");
      const removedIds = new Set<string>();
      for (const item of missing) {
        try { await window.desktop.deleteAsset({ asset_id: item.asset.asset_id }); removedIds.add(item.asset.asset_id); } catch { /* 仍被时间线/生成记录引用：保留在列表中 */ }
      }
      const kept = refreshed.filter(item => !removedIds.has(item.asset.asset_id));
      if (projectRef.current?.project_id !== projectId || projectDataEpochRef.current !== epoch) return;
      setAssets(kept);
      if (removedIds.size > 0) {
        showNotice(`已刷新素材库：清理了 ${removedIds.size} 个本地文件已删除的素材。`, "success");
      } else if (missing.length > 0) {
        showNotice(`已刷新素材库：${missing.length} 个素材本地文件缺失（仍被时间线引用，已保留）。`, "warning");
      } else {
        showNotice("已刷新素材库：所有素材文件均正常。", "success");
      }
    } catch (error) {
      showNotice(safeErrorMessage(error, "素材库刷新失败，请稍后重试。"));
    } finally {
      if (projectRef.current?.project_id === projectId && projectDataEpochRef.current === epoch) setRefreshingAssets(false);
    }
  };
  const deleteAsset = async (asset: Asset) => {
    if (!project) return;
    const projectId = project.project_id;
    const epoch = projectDataEpochRef.current;
    setDeleteBusy(true);
    try {
      const counts = await window.desktop.deleteAsset({ asset_id: asset.asset_id, remove_timeline_clips: true });
      if (projectRef.current?.project_id !== projectId || projectDataEpochRef.current !== epoch) return;
      setAssets(items => items.filter(item => item.asset.asset_id !== asset.asset_id));
      setPendingDeleteAsset(undefined);
      setSaveState("已保存");
      // 级联删除重写了时间线 Revision：重新拉取最新时间线，保持本地状态一致。
      // 项目尚未创建时间线时无需刷新（Core 会报 TIMELINE_NOT_FOUND，忽略即可）。
      if (projectRef.current?.project_id === projectId && projectDataEpochRef.current === epoch && timeline) {
        try {
          const latest = await window.desktop.getTimeline(projectId);
          if (projectRef.current?.project_id !== projectId || projectDataEpochRef.current !== epoch) return;
          acceptState(latest);
        } catch (timelineError) {
          if (!errorCode(timelineError).includes("TIMELINE_NOT_FOUND")) throw timelineError;
        }
      }
      showNotice(counts.removed_clips > 0 ? `已删除素材「${asset.display_name}」，并从时间线移除 ${counts.removed_clips} 个相关片段。` : `已删除素材「${asset.display_name}」。`, "success");
    } catch (error) {
      setPendingDeleteAsset(undefined);
      showNotice(safeErrorMessage(error, "素材删除失败，请刷新后重试。"));
    } finally {
      if (projectRef.current?.project_id === projectId && projectDataEpochRef.current === epoch) setDeleteBusy(false);
    }
  };
  const deleteTranscript = async (transcript: Transcript) => {
    const projectId = projectRef.current?.project_id;
    const epoch = projectDataEpochRef.current;
    setDeleteTranscriptBusy(true);
    try {
      if (!window.desktop.deleteTranscript) throw new Error("TRANSCRIPTION_DELETE_UNAVAILABLE");
      await window.desktop.deleteTranscript(transcript.transcript_id);
      if (projectRef.current?.project_id !== projectId || projectDataEpochRef.current !== epoch) return;
      setPendingDeleteTranscript(undefined);
      setViewingTranscript(current => current?.transcript_id === transcript.transcript_id ? undefined : current);
      setTranscripts(current => {
        const next = { ...current };
        for (const assetId of Object.keys(next)) {
          const kept = next[assetId].filter(item => item.transcript_id !== transcript.transcript_id);
          if (kept.length) next[assetId] = kept; else delete next[assetId];
        }
        return next;
      });
      setSelectedSegments(current => {
        if (!(transcript.transcript_id in current)) return current;
        const next = { ...current };
        delete next[transcript.transcript_id];
        return next;
      });
      showNotice("已删除该转录。", "success");
      // 摘要由服务端权威列表决定，重拉以覆盖分页/状态细节。
      if (projectRef.current) void loadProjectData(projectRef.current).catch(() => undefined);
    } catch (error) {
      const code = errorCode(error);
      setPendingDeleteTranscript(undefined);
      showNotice(
        code === "TRANSCRIPTION_IN_USE"
          ? "该转录已被时间线字幕引用，请先移除相关字幕或片段后再删除。"
          : safeErrorMessage(error, "转录删除失败，请刷新后重试。"),
      );
    } finally {
      if (projectRef.current?.project_id === projectId && projectDataEpochRef.current === epoch) setDeleteTranscriptBusy(false);
    }
  };
  const deleteJob = async (job: Job) => {
    const projectId = projectRef.current?.project_id;
    const epoch = projectDataEpochRef.current;
    try {
      if (!window.desktop.deleteJob) throw new Error("JOB_DELETE_UNAVAILABLE");
      await window.desktop.deleteJob(job.job_id);
      if (projectRef.current?.project_id !== projectId || projectDataEpochRef.current !== epoch) return;
      setJobs(items => items.filter(item => item.job_id !== job.job_id));
    } catch (error) {
      const code = errorCode(error);
      showNotice(
        code === "JOB_INVALID_STATE"
          ? "任务仍在进行中，请先取消后再删除。"
          : code === "JOB_REFERENCED"
            ? "该任务被渲染产物或生成记录引用，无法删除。"
            : safeErrorMessage(error, "任务删除失败，请刷新后重试。"),
      );
    }
  };
  const previewFromLibrary = (item: AssetPresentation) => {
    if (!item.media_url) return;
    setLibraryPreviewId(item.asset.asset_id);
    setPreviewMode("interactive");
    setExportPlayback(undefined);
    setPlaying(true);
  };
  const exitLibraryPreview = () => {
    if (!libraryPreviewId) return;
    setLibraryPreviewId(null);
    // 素材预览结束回合成预览（回退过的环境保持交互预览，避免再次触发回退）。
    if (previewMode === "interactive" && !syntheticNotice) setPreviewMode("synthetic");
  };
  const isDraggableAsset = (kind: AssetKind) => kind === "video" || kind === "image" || kind === "audio";
  // 素材类型图标（列表行的类型标识，替代文字标签——剪映式）。
  const assetKindIcon = (kind: AssetKind) =>
    kind === "video" ? <Video /> : kind === "audio" ? <FileAudio /> : kind === "image" ? <ImagePlus /> : <FileText />;
  const assetThumb = (item: AssetPresentation) => (
    <div className="asset-thumb">
      {item.asset.kind === "image"
        ? <img src={item.media_url ?? undefined} alt="" loading="lazy" />
        : item.asset.kind === "video"
          ? <video src={item.media_url ?? undefined} muted preload="metadata" aria-hidden="true" />
          : <FileAudio className="asset-thumb-icon" aria-hidden="true" />}
      {/* 仅异常态显示角标（缺失/已变更/不支持）；可用是常态，不占视觉。 */}
      {item.asset.availability !== "available" && <span className={`availability ${item.asset.availability}`}>{availabilityLabels[item.asset.availability]}</span>}
    </div>
  );
  const assetActions = (item: AssetPresentation) => (
    <div className="asset-actions">
      <IconButton label={`预览播放 ${item.asset.display_name}`} disabled={item.asset.availability !== "available"} onClick={() => previewFromLibrary(item)}><Play size={13} /></IconButton>
      {isTranscribable(item.asset) && <IconButton label="转录" onClick={() => startTranscription(item.asset)}><FileText size={13} /></IconButton>}
      {item.asset.kind === "video" && item.asset.availability === "available" && <IconButton label="剪辑手法" disabled={cvBusy !== null} onClick={() => openEditingTools("remove_pauses")}><Scissors size={13} /></IconButton>}
      {item.asset.kind === "video" && item.asset.availability === "available" && <IconButton label="AI 信号分析" disabled={cvBusy !== null} onClick={() => { setCvOptionsAsset(item); setCvOptionsOpen(true); setCvTargetGapS(""); setCvBudgetPerMin(""); }}><Sparkles size={13} /></IconButton>}
      <IconButton label={`打开 ${item.asset.display_name} 所在文件夹`} onClick={() => void revealAsset(item.asset)}><FolderOpen size={13} /></IconButton>
      <IconButton label={`删除 ${item.asset.display_name}`} onClick={() => setPendingDeleteAsset(item.asset)}><Trash2 size={13} /></IconButton>
    </div>
  );
  // AI-2：CV 摘要文本行（视频条目副标题下方；状态 + 采样数 + 场景切换数 + 密度）。
  const cvSummaryText = (asset: Asset): string | undefined => {
    const summary = cvSummaries[asset.asset_id];
    if (!summary?.status) return undefined;
    if (summary.status === "queued") return "AI 信号分析排队中";
    if (summary.status === "running") return "AI 信号分析进行中";
    if (summary.status === "ready" || summary.status === "stale") {
      const density = summary.density_status === "sparse" ? "密度 sparse" : summary.density_status === "full" ? "密度 full" : null;
      return `AI 信号${summary.status === "stale" ? "（已过期）" : ""} · 采样 ${summary.sample_count ?? 0} · 场景切换 ${summary.scene_cut_count ?? 0}${density ? ` · ${density}` : ""}`;
    }
    return "AI 信号分析失败";
  };
  // 阶段 C 稳定性包：CV 信号 sparkline——选中视频素材时懒加载样本并以
  // 内联 SVG 折线呈现（运动能量 + 场景切换标记）；无展开状态时零请求。
  const [cvSparkAssetId, setCvSparkAssetId] = useState<AssetId | null>(null);
  const [cvSparkSamples, setCvSparkSamples] = useState<CvSample[] | null>(null);
  const toggleCvSpark = (asset: Asset) => {
    if (cvSparkAssetId === asset.asset_id) { setCvSparkAssetId(null); setCvSparkSamples(null); return; }
    if (!project) return;
    const projectId = project.project_id;
    const epoch = projectDataEpochRef.current;
    setCvSparkAssetId(asset.asset_id);
    setCvSparkSamples(null);
    void window.desktop.listCvSamples({ project_id: projectId, asset_id: asset.asset_id })
      .then(page => { if (projectRef.current?.project_id === projectId && projectDataEpochRef.current === epoch) setCvSparkSamples(page.samples); })
      .catch(() => { if (projectRef.current?.project_id === projectId && projectDataEpochRef.current === epoch) { setCvSparkSamples([]); showNotice("CV 信号样本加载失败。", "error"); } });
  };
  const cvSparkPath = (samples: CvSample[], key: "motion_energy" | "audio_energy"): string => {
    if (samples.length < 2) return "";
    const maxT = samples[samples.length - 1].timestamp_us || 1;
    return samples.map((s, i) => `${i === 0 ? "M" : "L"}${(s.timestamp_us / maxT * 100).toFixed(2)},${(1 - Math.min(1, s[key])).toFixed(3)}`).join(" ");
  };
  // 素材元信息行：视频=高度p · 帧率fps · 体积；音频=编码 · 体积；图片=体积（时长单独展示在行尾）。
  const assetMediaInfo = (asset: Asset): MediaInfo | undefined => (asset.media_info && typeof asset.media_info === "object" && "video_streams" in asset.media_info ? asset.media_info as MediaInfo : undefined);
  const formatAssetSize = (bytes: number) => bytes >= 1_073_741_824 ? `${(bytes / 1_073_741_824).toFixed(1)} GB` : bytes >= 1_048_576 ? `${Math.round(bytes / 1_048_576)} MB` : `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  const assetMetaIcon = (asset: Asset) => asset.kind === "audio" ? <Music size={12} /> : <Monitor size={12} />;
  const assetMetaText = (asset: Asset) => {
    const info = assetMediaInfo(asset);
    const size = formatAssetSize(asset.size_bytes);
    if (asset.kind === "video") {
      const stream = info?.video_streams?.[0];
      const fps = stream?.avg_frame_rate_num && stream?.avg_frame_rate_den ? Math.round(stream.avg_frame_rate_num / stream.avg_frame_rate_den) : undefined;
      return [stream?.height ? `${stream.height}p` : null, fps ? `${fps}fps` : null, size].filter(Boolean).join(" · ") || size;
    }
    if (asset.kind === "audio") {
      const codec = info?.audio_streams?.[0]?.codec;
      return [codec ? codec.toUpperCase() : null, size].filter(Boolean).join(" · ") || size;
    }
    return size;
  };
  const assetDurationLabel = (asset: Asset) => {
    const info = assetMediaInfo(asset);
    if (!info?.duration_us) return "—";
    const total = Math.round(info.duration_us / 1_000_000);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  };
  // 打开素材所在文件夹：文件缺失时弹框提供 重新定位 / 移除 恢复路径（主进程完成交互）。
  const revealAsset = async (asset: Asset) => {
    try {
      const result = await window.desktop.revealAsset(asset.asset_id);
      if (result.status === "relocated" || result.status === "deleted") await refreshAssets();
    } catch (error) {
      showNotice(safeErrorMessage(error, "打开素材所在文件夹失败。"), "error");
    }
  };
  // 项目封面：从预览画布截取当前播放头帧（本地持久化；无后端依赖）。
  // 合成模式（默认主力）无 video 元素——帧画在 OffscreenCanvas，经会话的
  // snapshotPng 回读（含 fit 几何：裁掉 contain 留边）后解码裁剪缩放为
  // JPEG（≤540px，localStorage 容量安全）；交互/权威模式沿用 video 元素。
  const syntheticSnapshotRef = useRef<(() => Promise<{ buffer: ArrayBuffer; contentX: number; contentY: number; contentW: number; contentH: number } | null>) | null>(null);
  const captureCover = async () => {
    let url: string | null = null;
    if (previewMode === "synthetic") {
      const snapshot = await syntheticSnapshotRef.current?.();
      if (snapshot && snapshot.contentW > 0 && snapshot.contentH > 0) {
        url = await new Promise<string | null>(resolve => {
          const blob = new Blob([snapshot.buffer], { type: "image/png" });
          const blobUrl = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(blobUrl);
            const sx = snapshot.contentX, sy = snapshot.contentY, sw = snapshot.contentW, sh = snapshot.contentH;
            const scale = Math.min(1, 540 / sw);
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(2, Math.round(sw * scale));
            canvas.height = Math.max(2, Math.round(sh * scale));
            const ctx = canvas.getContext("2d");
            if (!ctx) { resolve(null); return; }
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", 0.85));
          };
          img.onerror = () => { URL.revokeObjectURL(blobUrl); resolve(null); };
          img.src = blobUrl;
        });
      }
    }
    if (!url) {
      const video = videoRef.current;
      if (!video || !video.videoWidth) { return null; }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      url = canvas.toDataURL("image/jpeg", 0.85);
    }
    if (!url) return null;
    setCoverUrl(url);
    try { localStorage.setItem(`vortex-cut.cover.${project?.project_id ?? "default"}`, url); } catch { /* 配额不足忽略 */ }
    return url;
  };
  const applyCover = (url: string | null) => {
    setCoverUrl(url);
    const key = `vortex-cut.cover.${project?.project_id ?? "default"}`;
    try { if (url) localStorage.setItem(key, url); else localStorage.removeItem(key); } catch { /* 配额不足忽略 */ }
  };
  // "原始"分辨率档：素材最大短边（与 Core plan.py 同口径：无视频流兜底 1080，8K 钳 4K）。
  const originalShortEdge = useMemo(() => {
    let maxShort = 0;
    for (const item of assets) {
      const info = item.asset.media_info as MediaInfo | null;
      for (const stream of info?.video_streams ?? []) {
        const w = Number(stream.width ?? 0), h = Number(stream.height ?? 0);
        if (w > 0 && h > 0) maxShort = Math.max(maxShort, Math.min(w, h));
      }
    }
    return maxShort > 0 ? Math.min(maxShort, 2160) : null;
  }, [assets]);
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
  const startTranscription = (asset: Asset) => { const ready = models.find(model => model.status === "ready" && model.provider_status === "installed"); if (!ready) { const candidate = models[0]; if (candidate) void openModel(candidate); else showNotice("当前没有可用的本地 ASR 模型", "warning"); return; } setTranscriptionAsset(asset); };
  const submitTranscription = async () => { if (!transcriptionAsset) return; const model = models.find(item => item.status === "ready" && item.provider_status === "installed"); if (!model) return; const result = await window.desktop.createTranscription({ asset_id: transcriptionAsset.asset_id, model_id: model.model_id, language, word_timestamps: wordTimestamps, license_acceptance: null }); setJobs(items => [result.job, ...items]); setTranscriptionAsset(undefined); trackTranscriptionJob(result.job); };
  // 转录完成必须刷新转录摘要，否则转录页拿的是打开项目时的旧列表——
  // 用户点完转录在"任务"页看到成功，转录页却仍显示"尚未生成转录"
  //（2026-10-06 现场：转录已落库 24 段，UI 却无可勾选片段）。
  const trackTranscriptionJob = (job: Job) => {
    const projectId = project?.project_id;
    const epoch = projectDataEpochRef.current;
    if (!projectId) return;
    const unsubscribe = window.desktop.subscribeJob(job.job_id, updated => {
      if (projectRef.current?.project_id !== projectId || projectDataEpochRef.current !== epoch) {
        unsubscribe();
        return;
      }
      setJobs(items => [updated, ...items.filter(item => item.job_id !== updated.job_id)]);
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(updated.status)) {
        unsubscribe();
        // 成功：重新拉取转录摘要，使转录页出现"查看转录"入口；
        // 失败/取消：无需刷新（没有新转录产生）。
        if (updated.status === "succeeded" && projectRef.current) {
          void loadProjectData(projectRef.current).catch(() => undefined);
        }
      }
    });
  };
  const retryTranscription = async (job: Job) => { if (!job.asset_id || !job.model_id) return; const result = await window.desktop.createTranscription({ asset_id: job.asset_id, model_id: job.model_id, language: "auto", word_timestamps: true, license_acceptance: null }); setJobs(items => [result.job, ...items]); trackTranscriptionJob(result.job); };
  const cancelJob = async (job: Job) => { const updated = await window.desktop.cancelJob(job.job_id); setJobs(items => items.map(item => item.job_id === updated.job_id ? updated : item)); };
  // AI-2（Layer 0）：素材 CV 信号分析——视频条目动作发起，完成后文本摘要展示
  //（signal 可视化为独立小单）。generate=True 登记作业；subscribeJob 跟踪完
  // 成后拉取一次摘要（无 generate，只读）。
  const [cvSummaries, setCvSummaries] = useState<Partial<Record<AssetId, CvAnalysisSummary>>>({});
  const [cvBusy, setCvBusy] = useState<AssetId | null>(null);
  // ADR-0005 阶段 2：密度旋钮（可选高级项；空 = 默认 4s / 10s·min⁻¹）。
  const [cvOptionsOpen, setCvOptionsOpen] = useState(false);
  const [cvOptionsAsset, setCvOptionsAsset] = useState<AssetPresentation | null>(null);
  const [cvTargetGapS, setCvTargetGapS] = useState("");
  const [cvBudgetPerMin, setCvBudgetPerMin] = useState("");
  const refreshCvSummary = useCallback(async (assetId: AssetId) => {
    if (!project) return;
    try { const summary = await window.desktop.getCvAnalysis({ project_id: project.project_id, asset_id: assetId, generate: false }); setCvSummaries(current => ({ ...current, [assetId]: summary })); } catch { /* 摘要拉取失败不打断素材列表 */ }
  }, [project]);
  const startCvAnalysis = (item: AssetPresentation, knobs?: { target_gap_us?: number; budget_per_minute_s?: number }) => {
    const assetId = item.asset.asset_id;
    if (!project || cvBusy) return;
    setCvBusy(assetId);
    void (async () => {
      try {
        const summary = await window.desktop.getCvAnalysis({
          project_id: project.project_id,
          asset_id: assetId,
          generate: true,
          ...(knobs?.target_gap_us ? { target_gap_us: knobs.target_gap_us } : {}),
          ...(knobs?.budget_per_minute_s ? { budget_per_minute_s: knobs.budget_per_minute_s } : {}),
        });
        setCvSummaries(current => ({ ...current, [assetId]: summary }));
        if (summary.job_id) {
          const unsubscribe = window.desktop.subscribeJob(summary.job_id, job => {
            if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) { unsubscribe(); void refreshCvSummary(assetId); }
          });
        } else { void refreshCvSummary(assetId); }
      } catch (caught) { showNotice(safeErrorMessage(caught, "CV 信号分析发起失败。"), "error"); }
      finally { setCvBusy(null); }
    })();
  };
  const submitCvOptions = () => {
    if (!cvOptionsAsset) return;
    const gapMs = Number(cvTargetGapS);
    const budget = Number(cvBudgetPerMin);
    const knobs = {
      ...(cvTargetGapS.trim() !== "" && Number.isFinite(gapMs) && gapMs > 0 ? { target_gap_us: Math.round(gapMs * 1_000_000) } : {}),
      ...(cvBudgetPerMin.trim() !== "" && Number.isFinite(budget) && budget > 0 ? { budget_per_minute_s: budget } : {}),
    };
    startCvAnalysis(cvOptionsAsset, knobs);
    setCvOptionsOpen(false);
    setCvOptionsAsset(null);
    setCvTargetGapS("");
    setCvBudgetPerMin("");
  };
  // A08：转录正文按需加载（选中 chip 时才 getTranscript，经并发≤4 队列 +
  // 项目代次作废——旧项目迟到结果不写入新项目）；已加载内容缓存复用。
  const viewTranscript = async (summary: TranscriptSummary) => {
    const cached = Object.values(transcripts).flat().find(item => item.transcript_id === summary.transcript_id);
    if (cached) { setViewingTranscript(cached); return; }
    const epoch = projectDataEpochRef.current;
    const queue = transcriptQueueRef.current ??= new BoundedTaskQueue<Transcript>(4);
    const result = await queue.push(() => window.desktop.getTranscript(summary.transcript_id));
    if (result === queue.skipped || epoch !== projectDataEpochRef.current) return; // 已切项目：丢弃
    const transcript = result as Transcript;
    setViewingTranscript(transcript);
    setTranscripts(current => ({ ...current, [transcript.asset_id]: [...(current[transcript.asset_id] ?? []), transcript] }));
  };
  const undoRedoInFlight = useRef(false);
  const undoRedo = async (kind: "undo" | "redo") => {
    // 连按 Ctrl+Z 时 React 状态还没更新，会拿同一个 base_revision_id 发多次请求，
    // 第一次之后全部 409。用在途标记丢弃多余的按键，等状态回写后再撤销下一刀。
    if (undoRedoInFlight.current || !project || !timeline) return;
    undoRedoInFlight.current = true;
    setSaveState("保存中");
    try {
      acceptState(await window.desktop[kind === "undo" ? "undoTimeline" : "redoTimeline"]({ project_id: project.project_id, base_revision_id: timeline.current_revision.timeline_revision_id }));
    } catch (error) { await handleConflict(error); } finally { undoRedoInFlight.current = false; }
  };

  const trackRenderJob = (job: Job) => {
    const projectId = project?.project_id;
    const epoch = projectDataEpochRef.current;
    if (!projectId) return;
    setJobs(items => [job, ...items.filter(item => item.job_id !== job.job_id)]);
    const unsubscribe = window.desktop.subscribeJob(job.job_id, updated => {
      if (projectRef.current?.project_id !== projectId || projectDataEpochRef.current !== epoch) {
        unsubscribe();
        return;
      }
      setJobs(items => [updated, ...items.filter(item => item.job_id !== updated.job_id)]);
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(updated.status)) {
        unsubscribe();
        void loadRenderData({ ...projectRef.current!, project_id: projectId }).catch(error => showNotice(safeErrorMessage(error, "渲染记录加载失败，请刷新后重试。")));
      }
    });
  };
  const generatePreview = async () => {
    if (!project || !timeline || !working?.clips.length) return;
    if (timeline.draft) { showNotice("请先提交或丢弃草稿，再生成权威预览。", "warning"); return; }
    try {
      const result = await window.desktop.createPreview({ project_id: project.project_id, preview: { timeline_revision_id: timeline.current_revision.timeline_revision_id, encoder_mode: encoderMode, output_ratio: renderRatio } });
      setPendingVerify(true);
      if (result.preview) {
        setPreviews(items => [result.preview!, ...items.filter(item => item.preview.render_artifact_id !== result.preview!.preview.render_artifact_id)]);
        setPreviewMode("authoritative");
      }
      if (result.job) { trackRenderJob(result.job); setRenderPanelOpen(true); }
    } catch (error) { showNotice(safeErrorMessage(error, "操作未完成，请刷新后重试。")); }
  };
  // 导出前核验（Phase 2：权威预览不再是一个常驻模式，收敛为"生成后观看核验"）：
  // 异步任务完成路径——当前 Revision 的权威预览一旦就绪即自动切换观看；
  // 立即返回 preview 的复用路径已在 generatePreview 内直接切换。
  useEffect(() => {
    if (!pendingVerify) return;
    const ready = previews.find(item => item.preview.timeline_revision_id === timeline?.current_revision.timeline_revision_id && item.preview.status === "ready");
    if (!ready) return;
    setPendingVerify(false);
    setPreviewMode("authoritative");
  }, [pendingVerify, previews, timeline?.current_revision.timeline_revision_id]);
  const openExportDialog = () => {
    if (!project || !timeline || !working?.clips.length) return;
    if (timeline.draft) { showNotice("请先提交或丢弃草稿，再导出正式 Revision。", "warning"); return; }
    setExportDialogOpen(true);
  };
  const submitExport = async (grant: DestinationGrant | null, settings: ExportSettings) => {
    if (!project || !timeline) return;
    setExportBusy(true);
    try {
      const selected = grant ?? await window.desktop.chooseExportDestination(project.project_id, settings.fileName);
      if (!selected) return;
      const result = await window.desktop.createExport({ project_id: project.project_id, export: { timeline_revision_id: timeline.current_revision.timeline_revision_id, destination_grant_id: selected.destination_grant_id, encoder_mode: encoderMode, output_ratio: renderRatio, quality: settings.quality, resolution: settings.resolution, frame_rate: settings.frameRate } });
      if (result.export_record) setExports(items => [result.export_record!, ...items.filter(item => item.export_record.export_record_id !== result.export_record!.export_record.export_record_id)]);
      trackRenderJob(result.job);
      setRenderPanelOpen(true);
      setExportDialogOpen(false);
    } catch (error) { showNotice(safeErrorMessage(error, "操作未完成，请刷新后重试。")); } finally { setExportBusy(false); }
  };
  const targetPreview = (target: RenditionTarget) => renditionPreviews.find(item => item.preview.platform_preset_id === target.platform_preset_id && item.preview.rendition_preset_id === target.rendition_preset_id && item.preview.layout_policy === target.layout_policy && item.preview.timeline_revision_id === timeline?.current_revision.timeline_revision_id && item.preview.status === "ready");
  const openExportBatch = async () => {
    if (!project || !timeline || timeline.draft) { showNotice("请先提交或丢弃草稿，再创建多平台导出。", "warning"); return; }
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
  // 预览/导出比例真源 = 项目画布（所见即所得；素材比例不再反客为主）。
  // 旧实现按素材原生分辨率解析：横版素材 + 竖版项目时下拉显示 16:9、导出/预览
  // 却与项目画布相悖，且播放头进入无片段区间时退化为 "fit"（合成预览拉取 IR
  // 被核心以"画布比例不合法"拒绝）。项目画布恒为五档之一，恒稳定。
  // 注意：必须读 project.canvas 而非 working.canvas——时间线文档画布受 v1
  // 契约钉死为 1080×1920（timeline.py _normalize_and_validate），不反映项目比例；
  // 渲染管线的唯一比例源是 preview-ir 的 output_ratio（OUTPUT_RATIO_DIMENSIONS）。
  const canvasInfo = project?.canvas;
  const autoRatio = canvasInfo
    ? (Math.abs(canvasInfo.width / canvasInfo.height - 16 / 9) < 0.02 ? "169"
      : Math.abs(canvasInfo.width / canvasInfo.height - 9 / 16) < 0.02 ? "916"
      : Math.abs(canvasInfo.width / canvasInfo.height - 1) < 0.02 ? "11"
      : Math.abs(canvasInfo.width / canvasInfo.height - 4 / 3) < 0.02 ? "43"
      : Math.abs(canvasInfo.width / canvasInfo.height - 3 / 4) < 0.02 ? "34"
      : "fit")
    : "fit"; // 挂载由 working/timeline 门控，此分支仅理论可达
  const effectiveRatio: OutputRatio = (previewRatioTouched ? previewRatio : autoRatio) as OutputRatio;
  // 比例语义（剪映式，下拉随时改渲染画幅；项目画布只是新建时的默认值）：
  // - 选具体比例码 → 渲染画幅 = 该比例（权威预览/导出/合成预览同步切换）。
  // - "适应"（原画）→ 渲染画幅 = **当前主轨首片段素材的原始比例**（剪映"原画"）：
  //   从素材 media_info.video_streams[0] 宽高推比例码；无素材/无法判定时回退
  //   项目画布比例。切素材后"适应"随之跟随。
  const assetOriginalRatio = useMemo((): OutputRatio => {
    const firstVideo = (working?.clips ?? []).find(clip => clip.track_id === "V1" && clip.asset_kind === "video");
    const asset = firstVideo ? assets.find(item => item.asset.asset_id === firstVideo.asset_id)?.asset : undefined;
    const stream = (asset?.media_info && "video_streams" in asset.media_info ? (asset.media_info as { video_streams?: Array<{ width?: number; height?: number }> }).video_streams?.[0] : undefined);
    if (!stream?.width || !stream?.height) return autoRatio === "fit" ? "169" : (autoRatio as OutputRatio);
    const ratio = stream.width / stream.height;
    return Math.abs(ratio - 16 / 9) < 0.02 ? "169"
      : Math.abs(ratio - 9 / 16) < 0.02 ? "916"
      : Math.abs(ratio - 1) < 0.02 ? "11"
      : Math.abs(ratio - 4 / 3) < 0.02 ? "43"
      : Math.abs(ratio - 3 / 4) < 0.02 ? "34"
      : "169"; // 非标准比例就近归入 16:9（渲染档位只有五档）
  }, [working, assets, autoRatio]);
  const renderRatio: OutputRatio = effectiveRatio === "fit" ? assetOriginalRatio : effectiveRatio;
  // "适应"显示模式：预览框按渲染画幅比例约束（原画比例即素材比例），画布内容
  // 等比 contain 居中；选具体比例 = 显式切换渲染画幅并按该比例约束预览框。
  const previewClass = `${previewLayout} ratio-${renderRatio}`;
  // 时间码帧率：优先画布帧率，缺省 30fps。
  // 比例切换（剪映式）：选具体比例时主轨布局切为 crop_fill（裁切填满——等比
  // 放大到短边顶满、长边溢出裁剪，剪映同款默认）；blurred_background 模糊垫底
  // 是竖版包装风格，不随比例切换自动套用。切回"适应"不动时间线布局。
  const changePreviewRatio = (value: string) => {
    setPreviewRatio(value);
    setPreviewRatioTouched(true);
    setCanvasSize(null);
    if (canvasRef.current) { canvasRef.current.style.width = ""; canvasRef.current.style.height = ""; }
    if (value !== "fit" && working) {
      const layoutOps = working.clips
        .filter(clip => clip.track_id === "V1" && clip.layout === "blurred_background" && (clip.asset_kind === "video" || clip.asset_kind === "image"))
        .map(clip => ({ op: "set_layout" as const, clip_id: clip.clip_id, layout: "crop_fill" as const }));
      if (layoutOps.length > 0) void patchTimeline(layoutOps, "切换比例：主轨裁切填满");
    }
  };
  const previewFps = working?.canvas.fps_num && working.canvas.fps_den ? working.canvas.fps_num / working.canvas.fps_den : 30;
  // 预览缩放（剪映式）：点击缩放按钮弹出滑条，对数刻度 25%–500%，缩小时以画面中心整体缩小。
  const zoomT = (z: number) => Math.round(Math.log(z / 0.25) / Math.log(20) * 1000);
  const zoomZ = (t: number) => 0.25 * Math.exp(Math.log(20) * t / 1000);
  // 悬浮进度条：以比例换算播放头（与剪映进度条一致）。
  const progressPct = Math.max(0, Math.min(100, (playhead / Math.max(totalUs, 1)) * 100));
  /** 播放头 DOM 直写实现（P33 W10）：播放期间 React 不提交，时间码/气泡/填充/
   *  aria 由这里按 store 回传逐帧更新——观感与 10Hz 提交一致（甚至更密），
   *  但主线程不再为整棵编辑器树做协调。暂停/seek 后由 React 提交重新接管。 */
  const pgBubbleRef = useRef<HTMLDivElement | null>(null);
  const pgFillRef = useRef<HTMLDivElement | null>(null);
  const tcTimeRef = useRef<HTMLElement | null>(null);
  playheadDomRef.current = (us: number): void => {
    const clamped = Math.max(0, Math.min(us, totalUs));
    const pct = totalUs > 0 ? (clamped / totalUs) * 100 : 0;
    const text = formatSmpteTimecode(clamped, previewFps);
    if (tcTimeRef.current && tcTimeRef.current.textContent !== text) tcTimeRef.current.textContent = text;
    if (pgBubbleRef.current) {
      pgBubbleRef.current.textContent = text;
      pgBubbleRef.current.style.left = `${pct}%`;
    }
    if (pgFillRef.current) pgFillRef.current.style.width = `${pct}%`;
    progressRef.current?.setAttribute("aria-valuenow", String(clamped));
  };
  // 播放态 ref 镜像（会话回调经它读最新值）
  playingRef.current = playing && !gestureHoldRef.current;
  const seekFromProgressRatio = (ratio: number) => {
    exitLibraryPreview();
    const value = Math.round(ratio * Math.max(totalUs, 1));
    seekFromUser(value);
    const clip = sortedClips.find(c => value >= c.timeline_start_us && value < c.timeline_end_us);
    if (clip && videoRef.current) {
      const sourceStart = (clip.source_start_us ?? 0) / 1_000_000;
      const elapsed = (value - clip.timeline_start_us) / 1_000_000 * ((clip.speed_milli ?? 1000) / 1000);
      videoRef.current.currentTime = sourceStart + elapsed;
    } else if (videoRef.current) {
      videoRef.current.currentTime = value / 1_000_000;
    }
  };
  const seekFromProgress = (clientX: number) => {
    const el = progressRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    seekFromProgressRatio((clientX - rect.left) / rect.width);
  };
  const seekVolumeFrom = (clientY: number) => {
    const rail = volRailRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    if (rect.height <= 0) return;
    setVolume(Math.round(Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height)) * 100));
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stagePaneRef.current?.requestFullscreen();
    } catch { showNotice("进入全屏失败。", "warning"); }
  };
  const authoritativePreview = previews.find(item => item.preview.timeline_revision_id === timeline?.current_revision.timeline_revision_id) ?? previews[0];
  const previewIsStale = Boolean(authoritativePreview && (authoritativePreview.preview.status === "stale" || authoritativePreview.preview.timeline_revision_id !== timeline?.current_revision.timeline_revision_id));
  const firstMediaAsset = assets.find(item => (item.asset.kind === "video" || item.asset.kind === "image") && item.asset.availability === "available");
  const firstTranscribableAsset = assets.find(item => isTranscribable(item.asset));
  useEffect(() => { setGenerationOpen(false); setShotRequirementsOpen(false); setCoverUrl(project?.project_id ? localStorage.getItem(`vortex-cut.cover.${project.project_id}`) : null); }, [project?.project_id]);

  const authoritativeMediaUrl = reframePlayback?.media_url ?? exportPlayback?.media_url ?? authoritativePreview?.media_url;
  const renderDisabledReason = !timeline || !working?.clips.length ? "时间线为空" : timeline.draft ? "存在未提交草稿，请先形成正式 Revision" : undefined;
  const renderJobs = jobs.filter(item => item.kind === "authoritative_preview" || item.kind === "final_export");
  const renderActivity = renderJobs.filter(item => ["queued", "running", "cancelling"].includes(item.status)).length;
  // 状态栏任务摘要：取第一个有进度的运行中任务展示「类型 xx%」；
  // 收尾任务（progress=1）显示「即将完成」，0.9s 后随终态回落。
  const runningProgressJob = jobs.find(job => job.status === "running" && job.progress !== null);
  const runningProgressText = runningProgressJob
    ? (runningProgressJob.progress! >= 1
      ? `${jobKindLabels[runningProgressJob.kind] ?? runningProgressJob.kind} 即将完成`
      : `${jobKindLabels[runningProgressJob.kind] ?? runningProgressJob.kind} ${Math.round(runningProgressJob.progress! * 100)}%`)
    : "";

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
      case "ai.revise": return timeline ? undefined : "需要时间线";
      case "project.manage": return undefined;
      case "project.refresh": return undefined;
      case "timeline.create": return project ? timeline ? "时间线已存在" : undefined : "需要项目";
      case "ui.resetLayout": return undefined;
      case "ui.shortcuts": return undefined;
      case "tools.compare": return project ? undefined : "需要项目";
      case "tools.shots": return !project ? "需要项目" : project.status !== "active" ? "项目已归档" : undefined;
      case "tools.verify": return !project ? "需要项目" : project.status !== "active" ? "项目已归档" : undefined;
      case "tools.imageGen": return !project ? "需要项目" : project.status !== "active" ? "项目已归档" : undefined;
      case "help.manual": return undefined;
      case "command.search": return undefined;
      default: return "未知命令";
    }
  };

  const runCommand = (id: EditorCommand["id"]) => {
    if (commandDisabledReason(id)) return;
    switch (id) {
      case "play.pause": togglePlayback(); break;
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
        if (snapshot.length) showNotice(`已复制 ${snapshot.length} 个片段（应用内剪贴板）。`, "info");
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
        void patchTimeline(deletable.map(item => ({ op: "remove_clip", clip_id: item.clip_id })), "剪切片段").then(() => showNotice(`已剪切 ${deletable.length} 个片段（Cttable.length} 个片段（Ctrl+V 粘贴）。`));
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
        void patchTimeline(operations, "粘贴片段").then(() => showNotice("已粘贴到播放头位置。", "success"));
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
      case "ai.revise": void openPatch(); break;
      case "project.manage": setProjectDialogOpen(true); break;
      case "project.refresh": void refreshProjects(); break;
      case "timeline.create": void createTimeline({ kind: "empty" }); break;
      case "ui.resetLayout": setLeftWidth(280); setRightWidth(300); setTimelineHeight(230); break;
      case "ui.shortcuts": setShortcutsOpen(true); break;
      case "tools.compare": void openRevisionCompare(); break;
      case "tools.shots": setShotRequirementsOpen(true); break;
      case "tools.verify": setGenerationOpen(true); break;
      case "tools.imageGen": setProviderImageGenerationOpen(true); break;
      case "help.manual": showNotice("请查看 docs/VORTEX_CUT_USER_MANUAL.md", "info"); break;
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
    // C3：固定别名（不进自定义表）——Ctrl+Shift+Z 重做、Backspace/Delete 删除。
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "z") { event.preventDefault(); runCommand("timeline.redo"); return; }
    if (!(event.ctrlKey || event.metaKey) && (key === "backspace" || key === "delete") && inTimeline) { event.preventDefault(); runCommand("timeline.delete"); return; }
    // 方向键逐帧步进（C1）：1 帧，Shift 加速 5 帧。
    if (!(event.ctrlKey || event.metaKey) && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      if (inTimeline) {
        event.preventDefault();
        const frameUs = Math.round(1_000_000 / (working?.canvas.fps_num && working.canvas.fps_den ? working.canvas.fps_num / working.canvas.fps_den : 30));
        const step = frameUs * (event.shiftKey ? 5 : 1);
        exitLibraryPreview();
        seekFromUser(Math.max(0, Math.min(duration(working), playheadStore.get() + (event.key === "ArrowRight" ? step : -step))));
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
    if (!zoomPopOpen && !volPopOpen) return;
    const listener = (event: MouseEvent) => {
      if (zoomPopRef.current && !zoomPopRef.current.contains(event.target as Node)) setZoomPopOpen(false);
      if (volPopRef.current && !volPopRef.current.contains(event.target as Node)) setVolPopOpen(false);
    };
    window.addEventListener("mousedown", listener);
    return () => window.removeEventListener("mousedown", listener);
  }, [zoomPopOpen, volPopOpen]);
  // 全屏：跟随浏览器全屏状态（Esc 退出时按钮图标同步复原）。
  useEffect(() => {
    const listener = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", listener);
    return () => document.removeEventListener("fullscreenchange", listener);
  }, []);
  // 基准宽：工具栏 / 舞台 / 进度条 / 播放条共享 16:9 适应宽度（剪映同款），其余比例在该列内居中。
  useEffect(() => {
    const pane = stagePaneRef.current;
    const col = stageColumnRef.current;
    if (!pane || !col) return;
    const layout = () => {
      const el = stageColumnRef.current;
      const host = stagePaneRef.current;
      if (!el || !host) return;
      const isFs = document.fullscreenElement === host;
      const availW = isFs ? window.innerWidth - 24 : host.clientWidth - 24;
      const availH = isFs ? window.innerHeight - 24 - 40 - 40 - 16 : host.clientHeight - 24 - 40 - 40 - 16;
      const w = Math.max(320, Math.min(availW, availH * 16 / 9));
      el.style.width = `${w}px`;
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(pane);
    window.addEventListener("resize", layout);
    document.addEventListener("fullscreenchange", layout);
    return () => { ro.disconnect(); window.removeEventListener("resize", layout); document.removeEventListener("fullscreenchange", layout); };
  }, []);
  // 音量：应用到当前播放的媒体元素（0-100 → 0-1）；同时同步给 VU 模拟电平使用。
  useEffect(() => {
    volumeRef.current = volume;
    const vol = Math.max(0, Math.min(1, volume / 100));
    if (videoRef.current) videoRef.current.volume = vol;
    if (audioRef.current) audioRef.current.volume = vol;
  }, [volume, previewAsset?.media_url, audioAsset?.media_url]);
  // 画面选中框：8 向手柄拖拽改画面大小（角 = 等比保持比例，边 = 单轴）；缩放时随 frame 一起缩放。
  const selZoomFactor = previewZoom === "fit" ? 1 : previewZoom;
  const beginSelDrag = (dir: string) => (event: React.PointerEvent<HTMLElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selDragRef.current = { dir, startX: event.clientX, startY: event.clientY, w: canvas.offsetWidth, h: canvas.offsetHeight, ratio: canvas.offsetWidth / Math.max(1, canvas.offsetHeight) };
    setSelDimsText(`${Math.round(canvas.offsetWidth)} × ${Math.round(canvas.offsetHeight)}`);
  };
  const moveSelDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = selDragRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;
    const dx = (event.clientX - drag.startX) / selZoomFactor;
    const dy = (event.clientY - drag.startY) / selZoomFactor;
    let w = drag.w, h = drag.h;
    const d = drag.dir;
    if (d.includes("e")) w = drag.w + dx;
    if (d.includes("s")) h = drag.h + dy;
    if (d.includes("w")) w = drag.w - dx;
    if (d.includes("n")) h = drag.h - dy;
    if (d === "nw" || d === "ne" || d === "sw" || d === "se") {
      const byW = Math.abs(w - drag.w), byH = Math.abs(h - drag.h);
      if (byW >= byH) h = w / drag.ratio; else w = h * drag.ratio;
    }
    w = Math.max(80, Math.min(2400, w));
    h = Math.max(45, Math.min(1350, h));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    setCanvasSize({ w: Math.round(w), h: Math.round(h) });
    setSelDimsText(`${Math.round(w)} × ${Math.round(h)}`);
  };
  const endSelDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    selDragRef.current = null;
  };
  // 选中框同步：框贴合画面（canvas）的布局矩形；frame 的 transform 缩放会同时作用于 canvas 与框。
  // 依赖含 showSelBox：盒子随选中切换被卸载/重挂载（V2 选中隐藏、V1 恢复显示）时
  // 必须重新同步尺寸——否则重挂载的盒子没有写入样式，8 向手柄全部堆积在左上角（0×0）。
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = selBoxRef.current;
    if (!canvas || !box) return;
    const sync = () => {
      box.style.left = `${canvas.offsetLeft}px`;
      box.style.top = `${canvas.offsetTop}px`;
      box.style.width = `${canvas.offsetWidth}px`;
      box.style.height = `${canvas.offsetHeight}px`;
      setSelDimsText(`${Math.round(canvas.offsetWidth)} × ${Math.round(canvas.offsetHeight)}`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    window.addEventListener("resize", sync);
    return () => { ro.disconnect(); window.removeEventListener("resize", sync); };
  }, [previewClass, canvasSize, showSelBox]);
  useEffect(() => {
    if (!projectSwitcherOpen) return;
    const listener = (event: MouseEvent) => {
      if (projectSwitcherRef.current && !projectSwitcherRef.current.contains(event.target as Node)) { setProjectSwitcherOpen(false); setProjectSwitcherQuery(""); }
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

  type MenuEntry =
    | { label: string; icon?: LucideIcon; action: () => void; disabled?: boolean }
    | { divider: true }
    | { group: string };
  const isMenuDivider = (entry: MenuEntry): entry is { divider: true } => "divider" in entry;
  const isMenuGroup = (entry: MenuEntry): entry is { group: string } => "group" in entry;
  const menuActions = (menu: string) => menuItems[menu].filter((entry): entry is { label: string; action: () => void; disabled?: boolean } => !isMenuDivider(entry) && !isMenuGroup(entry));

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
    项目: [{ label: "项目管理", icon: FolderCog, action: () => setProjectDialogOpen(true) }, { label: "刷新项目", icon: RefreshCw, action: () => void refreshProjects() }],
    编辑: [{ label: "撤销", icon: Undo2, action: () => void undoRedo("undo"), disabled: Boolean(commandDisabledReason("timeline.undo")) }, { label: "重做", icon: Redo2, action: () => void undoRedo("redo"), disabled: Boolean(commandDisabledReason("timeline.redo")) }],
    时间线: [{ label: "创建空时间线", icon: SquarePlus, action: () => void createTimeline({ kind: "empty" }), disabled: Boolean(commandDisabledReason("timeline.create")) }, { divider: true }, { label: "拆分所选片段", icon: Scissors, action: () => runCommand("timeline.split"), disabled: Boolean(commandDisabledReason("timeline.split")) }, { label: "生成预览", icon: MonitorPlay, action: () => runCommand("preview.generate"), disabled: Boolean(commandDisabledReason("preview.generate")) }, { label: "导出", icon: Upload, action: () => runCommand("export.open"), disabled: Boolean(commandDisabledReason("export.open")) }],
    界面: [{ label: "恢复默认布局", icon: LayoutPanelLeft, action: () => { setLeftWidth(280); setRightWidth(300); setTimelineHeight(230); } }, { label: "命令搜索", icon: CommandIcon, action: () => setCommandSearchOpen(true) }, { label: "快捷键设置", icon: Keyboard, action: () => setShortcutsOpen(true) }],
    工具: [{ group: "AI" }, { label: "Provider 设置", icon: FolderCog, action: () => setProviderSettingsOpen(true) }, { label: "AI 助手", icon: WandSparkles, action: () => setAgentOpen(true), disabled: !project }, { label: "AI 工作单", icon: WandSparkles, action: () => setWorklistOpen(true), disabled: !project }, { label: "AI 粗剪", icon: Sparkles, action: () => void openAi(), disabled: Boolean(commandDisabledReason("ai.open")) }, { label: "AI 修改", icon: WandSparkles, action: () => void openPatch(), disabled: Boolean(commandDisabledReason("ai.revise")) }, { label: "剪辑手法", icon: Scissors, action: () => openEditingTools("remove_pauses"), disabled: !project }, { label: "剪辑语法（高级）", icon: Scissors, action: () => { setEditingToolsTool(null); setEditingGrammarOpen(true); }, disabled: !project }, { label: "版本比较", icon: GitCompare, action: () => void openRevisionCompare(), disabled: Boolean(commandDisabledReason("tools.compare")) }, { divider: true }, { label: "镜头需求", icon: Clapperboard, action: () => setShotRequirementsOpen(true), disabled: Boolean(commandDisabledReason("tools.shots")) }, { label: "生成验证（模拟）", icon: FlaskConical, action: () => setGenerationOpen(true), disabled: Boolean(commandDisabledReason("tools.verify")) }, { label: "真实图片生成", icon: ImageIcon, action: () => setProviderImageGenerationOpen(true), disabled: Boolean(commandDisabledReason("tools.imageGen")) }],
    帮助: [{ label: "用户使用手册", icon: BookOpen, action: () => showNotice("请查看 docs/VORTEX_CUT_USER_MANUAL.md", "info") }]
  };
  return <main className="editor-shell" style={{ "--left-width": `${leftWidth}px`, "--right-width": `${rightWidth}px`, "--timeline-height": `${timelineHeight}px` } as React.CSSProperties} onClick={() => activeMenu && setActiveMenu(null)}>
    <div className="editor-titlebar">
      <div className="custom-titlebar-drag">
        <div className="brand-lockup" title="Vortex Cut">
          <span className="brand-mark"><img src="./icons/256.png" alt="" /></span>
          <strong>Vortex Cut</strong>
        </div>
        <nav className="menu-bar" aria-label="主菜单" onKeyDown={handleMenuBarKeyDown}>
          {Object.keys(menuItems).map((menu, menuPosition) => <div className="menu-item" key={menu}>
            <button ref={element => { menuButtonRefs.current[menuPosition] = element; }} aria-haspopup="menu" aria-expanded={activeMenu === menu} aria-controls={activeMenu === menu ? `menu-${menu}` : undefined} onClick={event => { event.stopPropagation(); setActiveMenu(activeMenu === menu ? null : menu); setDropdownIndex(0); }} onMouseEnter={() => { if (activeMenu) { setActiveMenu(menu); setDropdownIndex(0); } }}>{menu}</button>
            {activeMenu === menu && <div className="menu-dropdown" id={`menu-${menu}`} role="menu" aria-label={menu}>{(() => { let actionIndex = 0; const entries: React.ReactNode[] = []; for (const item of menuItems[menu]) { if (isMenuDivider(item)) { entries.push(<div key={`divider-${entries.length}`} className="menu-divider" role="separator" />); } else if (isMenuGroup(item)) { entries.push(<div key={`group-${entries.length}`} className="menu-group-label">{item.group}</div>); } else { const currentIndex = actionIndex; entries.push(<button key={item.label} ref={element => { menuActionRefs.current[currentIndex] = element; }} role="menuitem" disabled={item.disabled} className={currentIndex === dropdownIndex ? "focused" : ""} onMouseEnter={() => setDropdownIndex(currentIndex)} onClick={() => { item.action(); setActiveMenu(null); }}><span className="menu-item-ico">{item.icon && <item.icon size={14} />}</span><span className="menu-item-label">{item.label}</span>{menuShortcut(item.label) && <kbd className="menu-item-shortcut">{menuShortcut(item.label)}</kbd>}</button>); actionIndex += 1; } } return entries; })()}</div>}
          </div>)}
        </nav>
      </div>
      <div className="titlebar-project-switcher" ref={projectSwitcherRef}>
        <button className="titlebar-project-switcher-toggle" aria-label="切换项目" aria-haspopup="listbox" aria-expanded={projectSwitcherOpen} onClick={event => { event.stopPropagation(); const next = !projectSwitcherOpen; setProjectSwitcherOpen(next); if (!next) setProjectSwitcherQuery(""); }}>
          {project && <span className={`pdot ${project.status === "active" ? "active" : project.status === "archived" ? "archived" : "missing"}`} />}
          <span className="titlebar-project-name">{project?.name ?? "未选择项目"}</span>
          {project && <span className="project-switcher-state">{project.status === "active" ? "活跃" : project.status === "archived" ? "已归档" : "目录缺失"}</span>}
          <ChevronDown className="titlebar-switcher-chevron" size={11} />
        </button>
        {projectSwitcherOpen && <div className="project-switcher-dropdown" role="listbox" aria-label="选择项目">
          <div className="project-switcher-head">切换项目<small>本机项目</small></div>
          <label className="project-switcher-search" onClick={event => event.stopPropagation()}><Search size={13} /><input value={projectSwitcherQuery} onChange={event => setProjectSwitcherQuery(event.target.value)} placeholder="搜索项目名…" /></label>
          {(projectSwitcherQuery.trim() ? projects.filter(item => item.name.toLowerCase().includes(projectSwitcherQuery.trim().toLowerCase())) : projects).map(item => <button key={item.project_id} role="option" aria-selected={item.project_id === project?.project_id} className={item.project_id === project?.project_id ? "active" : ""} onClick={event => { event.stopPropagation(); if (item.project_id !== project?.project_id) switchProject(item); setProjectSwitcherOpen(false); setProjectSwitcherQuery(""); }}><span className={`pdot ${item.status === "active" ? "active" : item.status === "archived" ? "archived" : "missing"}`} /><span className="project-switcher-name">{item.name}</span><span className="project-switcher-state">{item.status === "active" ? "活跃" : item.status === "archived" ? "已归档" : "目录缺失"}</span></button>)}
          {!(projectSwitcherQuery.trim() ? projects.filter(item => item.name.toLowerCase().includes(projectSwitcherQuery.trim().toLowerCase())) : projects).length && <div className="project-switcher-none">没有匹配的项目</div>}
          {!projects.length && <div className="project-switcher-empty">尚无项目，请先创建</div>}
          <div className="project-switcher-actions"><button role="menuitem" className="project-switcher-manage" onClick={event => { event.stopPropagation(); setProjectSwitcherOpen(false); setProjectSwitcherQuery(""); setProjectDialogOpen(true); }}>项目管理</button></div>
        </div>}
      </div>
    </div>
    <div className="banner-stack">{notice !== "" && <div className={`notice notice-${notice.tone}`} role="alert">{notice.text}</div>}{timeline?.draft && <div className="draft-banner"><span>{timeline.draft.conflict ? "检测到冲突草稿" : "检测到上次未恢复草稿"}</span><button disabled={timeline.draft.conflict} onClick={() => { setWorking(timeline.draft!.document); setSaveState("已保存"); }}>恢复</button><button onClick={() => void (async () => { await window.desktop.deleteTimelineDraft(project!.project_id); setTimeline({ ...timeline, draft: null }); })()}>丢弃</button></div>}</div>
    <section className="editor-grid">
      <section className="library-pane" aria-label="媒体库">
        <div className="left-seg" role="tablist" aria-label="工作区分区">
          <button role="tab" aria-selected={tab === "assets"} className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>素材</button>
          <button role="tab" aria-selected={tab === "transcripts"} className={tab === "transcripts" ? "active" : ""} onClick={() => setTab("transcripts")}>转录</button>
          <button role="tab" aria-selected={tab === "models"} className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}>模型</button>
          <button role="tab" aria-selected={tab === "jobs"} className={tab === "jobs" ? "active" : ""} onClick={() => setTab("jobs")}>任务</button>
        </div>
        {tab === "assets" ? <>
        <div className="library-toolbar">{["video", "audio", "image"].map(kind => <button key={kind} disabled={!project || project.status !== "active"} onClick={() => void importAsset(kind as AssetKind)} title={`导入${assetKindLabels[kind as AssetKind]}素材`} aria-label={`导入${assetKindLabels[kind as AssetKind]}`}><span className="lib-card-ico">{kind === "video" ? <Video size={17} /> : kind === "audio" ? <AudioLines size={17} /> : <ImagePlus size={17} />}</span><span>{assetKindLabels[kind as AssetKind]}</span></button>)}</div>
        <div className="text-materials" aria-label="文本素材"><button disabled={!project || project.status !== "active"} onClick={() => void insertDefaultText()} title="插入到播放头处（3 秒）"><Type size={13} />默认文本</button><button disabled={!project || project.status !== "active"} onClick={() => void importSubtitleFile()} title="支持 SRT / ASS / SSA / LRC"><Captions size={13} />导入字幕</button></div>
        <div className="library-filter-toolbar"><input role="searchbox" type="search" aria-label="搜索素材" placeholder="搜索素材" value={assetQuery} onChange={event => setAssetQuery(event.target.value)} /><select aria-label="素材类型" value={assetFilter} onChange={event => setAssetFilter(event.target.value as AssetFilter)}><option value="all">全部</option>{assetKinds.map(kind => <option value={kind} key={kind}>{assetKindLabels[kind]}</option>)}</select><IconButton label="刷新素材库" disabled={refreshingAssets || !project} onClick={() => void refreshAssets()}><RefreshCw size={13} className={refreshingAssets ? "spin" : ""} /></IconButton></div>
        <div className="asset-list asset-table">{visibleAssets.map(item => <div className={`asset-item asset-row ${selectedAssetId === item.asset.asset_id ? "sel" : ""} ${isDraggableAsset(item.asset.kind) ? "draggable-asset" : ""}`} key={item.asset.asset_id} onClick={() => setSelectedAssetId(item.asset.asset_id)} onDoubleClick={() => previewFromLibrary(item)} {...assetDragProps(item)}><div className="asset-thumb">{item.asset.kind === "image" ? <img src={item.media_url ?? undefined} alt="" loading="lazy" /> : item.asset.kind === "video" ? <video src={item.media_url ?? undefined} muted preload="metadata" aria-hidden="true" /> : <FileAudio className="asset-thumb-icon" />}</div><div className="asset-name"><strong title={item.asset.display_name}>{item.asset.display_name}</strong><small>{assetMetaIcon(item.asset)}{assetMetaText(item.asset)}{cvSummaryText(item.asset) ? ` · ${cvSummaryText(item.asset)}` : ""}</small>{item.asset.kind === "video" && cvSummaries[item.asset.asset_id]?.status === "ready" && <button className="cv-spark-toggle" aria-label={`展开 ${item.asset.display_name} 的信号曲线`} onClick={event => { event.stopPropagation(); toggleCvSpark(item.asset); }}>{cvSparkAssetId === item.asset.asset_id ? "收起信号" : "信号曲线"}</button>}{cvSparkAssetId === item.asset.asset_id && item.asset.asset_id === cvSparkAssetId && <div className="cv-spark" onClick={event => event.stopPropagation()}>{cvSparkSamples === null ? <small>加载中…</small> : cvSparkSamples.length < 2 ? <small>暂无样本数据</small> : <><svg viewBox="0 0 100 1" preserveAspectRatio="none" aria-label="CV 信号曲线"><path d={cvSparkPath(cvSparkSamples, "motion_energy")} fill="none" stroke="#7aa2f7" strokeWidth="0.02" /><path d={cvSparkPath(cvSparkSamples, "audio_energy")} fill="none" stroke="#9ece6a" strokeWidth="0.02" opacity="0.7" />{cvSparkSamples.filter(s => s.scene_cut).map((s, i) => <line key={i} x1={(s.timestamp_us / (cvSparkSamples[cvSparkSamples.length - 1]?.timestamp_us || 1)) * 100} y1={0} x2={(s.timestamp_us / (cvSparkSamples[cvSparkSamples.length - 1]?.timestamp_us || 1)) * 100} y2={1} stroke="#f7768e" strokeWidth={0.03} />)}</svg><small className="cv-spark-legend"><span style={{ color: "#7aa2f7" }}>运动能量</span> · <span style={{ color: "#9ece6a" }}>音频能量</span> · <span style={{ color: "#f7768e" }}>场景切换</span></small></>}</div>}</div><div className="asset-side"><span className="asset-dur">{assetDurationLabel(item.asset)}</span>{assetActions(item)}</div></div>)}</div>
      </> : tab === "transcripts" ? <div className="transcript-list"><p className="panel-hint">只读展示语音识别结果；勾选片段后点"追加所选片段"，会把它们插入时间线并生成字幕。</p>{Object.values(transcripts).flat().length === 0 && <p className="panel-hint">尚未生成转录：在"素材"页对视频/音频素材点击"转录"按钮后，结果会出现在这里。</p>}{assets.filter(item => isTranscribable(item.asset)).map(assetItem => <div className="transcript-row" key={assetItem.asset.asset_id}><strong title={assetItem.asset.display_name}>{assetItem.asset.display_name}</strong><div className="transcript-variants">{(transcriptSummaries[assetItem.asset.asset_id] ?? []).map(summary => <button key={summary.transcript_id} className="ts-chip" aria-label={`查看转录 ${summary.transcript_id}`} onClick={() => void viewTranscript(summary)}><Eye size={12} />{summary.language} · {summary.status}</button>)}</div></div>)}{Object.values(transcripts).flat().map(item => <div className="transcript-item" key={item.transcript_id}><div className="transcript-item-head"><button className="transcript-open-button" onClick={() => setViewingTranscript(item)} title="查看并选择转录片段"><strong>{assets.find(asset => asset.asset.asset_id === item.asset_id)?.asset.display_name ?? "转录"}</strong><small>{item.segments.length} 段 · 点击查看内容与操作</small></button><button className="mini-btn danger-ghost" aria-label={`删除转录 ${item.transcript_id}`} title="删除这条转录（仍被时间线字幕引用时会拒绝）" onClick={() => setPendingDeleteTranscript(item)}>删除转录</button></div></div>)}</div>
        : tab === "models" ? <div className="model-page"><p className="panel-hint">本地语音识别模型：下载后可在视频/音频素材上发起转录，生成带时间戳的字幕底稿；下载中可取消，失败可重试。</p>{models.map(model => { const dl = ["queued", "downloading", "verifying", "paused"].includes(model.status); const pct = model.progress !== null && model.progress !== undefined ? `${Math.round(model.progress * 100)}%` : "—"; return <div className={`model-row${dl ? " dl" : ""}`} key={model.model_id}><div className="model-ico"><FileText size={14} /></div><div className="model-main"><div className="model-head"><strong title={model.display_name}>{model.display_name}</strong><span className={`badge ${model.status === "ready" ? "ok" : dl ? "run" : model.status === "failed" || model.status === "corrupt" ? "bad" : "dim"}`}>{modelBadgeLabels[model.status]}</span>{dl && <span className="mpct">{pct}</span>}</div>{dl && <div className="model-down"><progress className="model-progress" max={1} value={model.progress ?? 0} /><button className="mini-btn" title="取消模型下载" onClick={() => void cancelModel(model)}>取消下载</button></div>}<small className="model-sub">{modelStatusLabels[model.status]} · {model.provider}</small></div>{!dl && ["unavailable", "failed", "cancelled", "paused", "corrupt"].includes(model.status) && <button className="mini-btn" onClick={() => void openModel(model)}>{model.status === "failed" ? "重试下载" : model.status === "corrupt" ? "重新下载" : model.status === "paused" ? "继续下载" : "下载模型"}</button>}</div>; })}</div>
        : <div className="jobs-page"><p className="panel-hint">转录、权威预览与导出的后台进度会显示在这里；运行中的任务可取消，失败的转录可重试。</p>{jobs.length === 0 && <p className="panel-hint">暂无任务。</p>}{(() => { const activeJobs = jobs.filter(job => ["running", "cancelling"].includes(job.status)); const queuedJobs = jobs.filter(job => job.status === "queued"); const doneJobs = jobs.filter(job => ["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)); const renderJobRow = (job: Job) => { const badgeClass = job.status === "succeeded" ? "ok" : job.status === "failed" ? "bad" : job.status === "running" ? "run" : "dim"; const phaseText = job.phase ? (jobPhaseLabels[job.phase] ?? job.phase) : null; const phasePct = phaseText && job.phase_progress !== null && job.phase_progress !== undefined ? ` ${Math.round(job.phase_progress * 100)}%` : ""; return <div className="job-row" key={job.job_id}><div className="jmain"><div className="jhead"><strong>{jobKindLabels[job.kind] ?? job.kind}</strong><span className={`badge ${badgeClass}`}>{jobStatusLabels[job.status]}</span><span className="jpct">{job.progress !== null ? `${Math.round(job.progress * 100)}%` : "—"}</span></div>{job.progress !== null && <div className="jbar"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}<div className="jmeta"><span>{jobDetailText(job, assets.find(item => item.asset.asset_id === job.asset_id)?.asset.display_name)}{phaseText || job.stage ? ` · ${phaseText ? `${phaseText}${phasePct}` : job.stage}` : ""}{job.error ? ` · ${safeTaskErrorMessage(job.error)}` : ""}</span>{job.status === "running" && <JobEta job={job} />}</div><div className="jops">{job.kind === "transcription" && (job.status === "failed" || job.status === "interrupted") && <button className="mini-btn" onClick={() => void retryTranscription(job)}>重试转录</button>}{["queued", "running", "cancelling"].includes(job.status) && <button className="mini-btn" onClick={() => void cancelJob(job)}>取消</button>}{["succeeded", "failed", "cancelled", "interrupted"].includes(job.status) && <button className="mini-btn danger-ghost" aria-label={`删除任务 ${job.job_id}`} title="从列表移除这条任务记录" onClick={() => void deleteJob(job)}>删除</button>}</div></div></div>; }; return <>{activeJobs.length > 0 && <div className="jobs-group">进行中</div>}{activeJobs.map(renderJobRow)}{queuedJobs.length > 0 && <div className="jobs-group">排队</div>}{queuedJobs.map(renderJobRow)}{doneJobs.length > 0 && <div className="jobs-group">已完成 / 失败</div>}{doneJobs.map(renderJobRow)}</>; })()}</div>}
        {!timeline && project && <div className="empty-timeline"><button onClick={() => void createTimeline({ kind: "empty" })}>创建空时间线</button></div>}
      </section>
      <div className="resize-handle resize-handle-left" role="separator" aria-label="调整左侧面板宽度" onPointerDown={event => beginResize("left", event)} />
      <section ref={stagePaneRef} className={`stage-pane${isFullscreen ? " fullscreen" : ""}`} aria-label="项目预览">
        <div className="stage-column" ref={stageColumnRef}>
          <div className="preview-toolbar">
            <div className="tb-right">
              <label className="tb-field">比例<select aria-label="预览比例" value={effectiveRatio} onChange={event => changePreviewRatio(event.target.value)}>{previewRatios.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
              <span className="tb-sep" aria-hidden="true" />
              <label className="tb-field">编码<select aria-label="编码模式" value={encoderMode} onChange={event => setEncoderMode(event.target.value as EncoderMode)}><option value="auto">自动</option><option value="software">软件</option></select></label>
              <button className="render-panel-toggle" onClick={() => setRenderPanelOpen(true)}>渲染与导出{renderActivity ? <span className="render-badge" aria-hidden="true">{renderActivity}</span> : null}</button>
            </div>
          </div>
          <div className="stage-view">
            <div className={`preview-frame ${previewClass}${previewSelected ? " selected" : ""}`} style={previewZoom === "fit" ? undefined : { transform: `scale(${previewZoom})` }} role="button" tabIndex={0} aria-label="选中播放头处的片段" title="点击选中播放头处的片段" onClick={selectClipAtPlayhead} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectClipAtPlayhead(); } }}>
          <div className="preview-canvas" ref={canvasRef}>
            {previewMode === "authoritative" && authoritativeMediaUrl && <video ref={videoRef} className="preview-foreground authoritative-video" src={authoritativeMediaUrl} aria-label={reframePlayback ? "重构图权威预览视频" : exportPlayback ? "导出视频" : "权威预览视频"} controls onEnded={() => { setPlaying(false); setExportPlayback(undefined); setReframePlayback(undefined); setPreviewMode("synthetic"); }} />}
            {/* 合成预览仅在时间线有可见片段时挂载；空时间线显示引导文案（剪映式），
                避免对空时间线请求 preview-ir 被 Core 以 TIMELINE_EMPTY 拒绝而回退。 */}
            {previewMode === "synthetic" && projectStateReady && project && working && timeline && working.clips.length > 0 && <SyntheticPreview key={project.project_id} outputRatio={renderRatio} projectId={project.project_id} revisionId={timeline.current_revision.timeline_revision_id} mediaUrls={syntheticMediaUrls} audioByClip={syntheticAudioByClip} pipClips={syntheticPipClips} selectedClipId={pipSelectedId} onSelectClip={clipId => setSelection({ kind: "clip", id: clipId as never })} onCommitPipTransform={(clipId, transform) => { const clip = (working?.clips ?? []).find(item => item.clip_id === clipId); commitPipTransform(clipId as never, { ...(clip?.transform ?? {}), ...transform }); }} onDraftPipMask={(clipId, mask) => draftPipMask(clipId as never, mask)} onCommitPipMask={(clipId, mask) => commitPipMask(clipId as never, mask)} onGesturePause={pausePreviewPlayback} onGestureResume={resumePreviewPlayback} playing={playing && !gestureHoldRef.current} playheadUs={playhead} playheadStore={playheadStore} onTimeUs={us => seekFromPlayback(us)} onEnded={() => setPlaying(false)} onFallback={(reason, code) => { if (!seenAnyTicketRef.current) return; setPreviewMode("interactive"); setSyntheticNotice(syntheticFallbackNotice(reason, code)); }} sourceResolver={previewSourceResolver} resourceTier={resourceTier} forceCopyTo={forceCopyTo} snapshotRef={syntheticSnapshotRef} />}
            {previewMode === "interactive" && previewAsset?.media_url && previewAsset.asset.kind === "video" && <div className="preview-transform" style={mainTransformStyle}><video className="preview-background" src={previewAsset.media_url} muted aria-hidden="true" /><video ref={videoRef} className="preview-foreground" src={previewAsset.media_url} muted={!selectedClip?.audio.enabled || previewReverse || (clipAtPlayhead ? !isClipAudible(clipAtPlayhead) : false)} aria-label="交互预览视频" onTimeUpdate={event => { if (libraryPreviewId) dispatchPlayhead("external", Math.round(event.currentTarget.currentTime * 1_000_000), true); }} onEnded={handleVideoEnded} /></div>}
            {previewMode === "interactive" && audioAsset?.media_url && <audio ref={audioRef} src={audioAsset.media_url} style={{ display: "none" }} />}
            {previewMode === "interactive" && previewAsset?.media_url && previewAsset.asset.kind === "image" && <div className="preview-transform" style={mainTransformStyle}><img className="preview-background" src={previewAsset.media_url} alt="" aria-hidden="true" /><img className="preview-foreground" src={previewAsset.media_url} alt={previewAsset.asset.display_name} /></div>}
            {(previewMode === "interactive" || (previewMode === "synthetic" && (!working || working.clips.length === 0))) && !previewAsset?.media_url && overlayPips.length === 0 && <div className="preview-empty">选择或追加素材以开始编辑</div>}
            {previewMode === "interactive" && visibleCaption && <div className={`caption-overlay ${visibleCaption.preset_id}`}>{visibleCaption.text}</div>}
            {previewMode === "interactive" && overlayPips.length > 0 && <PreviewPipOverlays items={overlayPips} selectedClipId={pipSelectedId} locked={pipLocked} onSelect={clipId => setSelection({ kind: "clip", id: clipId })} onDraftTransform={draftPipTransform} onCommitTransform={commitPipTransform} onDraftMask={draftPipMask} onCommitMask={commitPipMask} onGesturePause={pausePreviewPlayback} onGestureResume={resumePreviewPlayback} playheadUs={playhead} playing={playing} />}
          </div>
          {/* 选中框：白色边框 + 8 向拖拽手柄，缩放时随画面一起缩放；仅选中片段时可见。 */}
          {!overlayClipSelected && <div className="sel-box" ref={selBoxRef} onClick={event => event.stopPropagation()} aria-hidden="true"><i className="sel-border" /><span className="sel-dims">{selDimsText || `${Math.round((canvasRef.current?.offsetWidth ?? 0))} × ${Math.round((canvasRef.current?.offsetHeight ?? 0))}`}</span><span className="h h-nw" data-dir="nw" title="等比缩放（左上）" onPointerDown={beginSelDrag("nw")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-n" data-dir="n" title="单轴缩放（上）" onPointerDown={beginSelDrag("n")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-ne" data-dir="ne" title="等比缩放（右上）" onPointerDown={beginSelDrag("ne")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-e" data-dir="e" title="单轴缩放（右）" onPointerDown={beginSelDrag("e")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-se" data-dir="se" title="等比缩放（右下）" onPointerDown={beginSelDrag("se")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-s" data-dir="s" title="单轴缩放（下）" onPointerDown={beginSelDrag("s")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-sw" data-dir="sw" title="等比缩放（左下）" onPointerDown={beginSelDrag("sw")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-w" data-dir="w" title="单轴缩放（左）" onPointerDown={beginSelDrag("w")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /></div>}
        </div>
          <span className={`interactive-label ${previewIsStale && previewMode === "authoritative" && !exportPlayback ? "stale" : ""}`}>{previewMode === "interactive" ? "交互预览 · 非权威" : previewMode === "synthetic" ? "合成预览 · 实时（非权威）" : reframePlayback ? "静态焦点重构图 · 权威预览" : exportPlayback ? `导出 · ${exportPlayback.export_record.destination_display_name}` : previewIsStale ? "权威预览 · 已过期" : "权威预览 · 当前 Revision"}</span><span role="status" aria-label="预览状态" className={`preview-context ${previewMode === "authoritative" ? "authoritative" : previewMode === "synthetic" ? "synthetic" : "interactive"}${previewIsStale ? " stale" : ""}`}>{previewMode === "authoritative" ? (previewIsStale ? "权威预览已过期" : authoritativePreview ? "权威预览" : "尚未生成权威预览") : previewMode === "synthetic" ? "合成预览" : "交互预览"}</span>{syntheticNotice && <span role="note" aria-label="合成预览回退提示" className="synthetic-note">{syntheticNotice}<button className="synthetic-note-retry" onClick={() => { setSyntheticNotice(null); setPreviewMode("synthetic"); }}>重试合成预览</button></span>}
          <div className={`progress${progressDragging ? " dragging" : ""}`} ref={progressRef} role="slider" tabIndex={0} aria-label="时间线播放头" aria-valuemin={0} aria-valuemax={Math.max(totalUs, 1)} aria-valuenow={Math.min(playhead, totalUs)} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setProgressDragging(true); seekFromProgress(event.clientX); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFromProgress(event.clientX); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setProgressDragging(false); }} onKeyDown={event => { if (event.key === "ArrowLeft") { event.preventDefault(); seekFromProgressRatio(Math.max(0, playhead / Math.max(totalUs, 1) - 1 / 300)); } else if (event.key === "ArrowRight") { event.preventDefault(); seekFromProgressRatio(Math.min(1, playhead / Math.max(totalUs, 1) + 1 / 300)); } else if (event.key === "Home") { event.preventDefault(); seekFromProgressRatio(0); } else if (event.key === "End") { event.preventDefault(); seekFromProgressRatio(1); } }}>
            <div className="pg-bubble" ref={pgBubbleRef} style={{ left: `${progressPct}%` }}>{formatSmpteTimecode(playhead, previewFps)}</div>
            <div className="pg-rail"><div className="pg-fill" ref={pgFillRef} style={{ width: `${progressPct}%` }}><i className="pg-dot" /></div></div>
          </div>
        </div>
        <div className="playback-bar">
          <div className="pb-left"><span className="tc"><b ref={tcTimeRef}>{formatSmpteTimecode(playhead, previewFps)}</b><i> / </i><span className="tot">{formatSmpteTimecode(totalUs, previewFps)}</span></span><span className={`vu${playing ? " active" : ""}`} aria-hidden="true"><i ref={vuBarLRef} /><i ref={vuBarRRef} /></span></div>
          <div className="pb-center"><button className="pb-play" aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停" : "播放"} onClick={togglePlayback}>{playing ? <Pause /> : <Play />}</button></div>
          <div className="pb-right" role="group" aria-label="播放器控制">
            <span className="vol-anchor">
              <button className="pb-icon" aria-haspopup="dialog" aria-expanded={volPopOpen} title={`音量 ${volume}%`} aria-label="音量" onClick={event => { event.stopPropagation(); setVolPopOpen(value => !value); setZoomPopOpen(false); }}>{volume === 0 ? <VolumeX /> : <Volume2 />}</button>
              <div className={`vol-pop${volPopOpen ? " open" : ""}`} ref={volPopRef} onClick={event => event.stopPropagation()}>
                <div className="vol-rail" ref={volRailRef} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); seekVolumeFrom(event.clientY); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) seekVolumeFrom(event.clientY); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}>
                  <div className="vol-fill" style={{ height: `${volume}%` }} />
                  <div className="vol-thumb" style={{ bottom: `${volume}%` }} />
                </div>
              </div>
            </span>
            <button className="pb-icon zoom-btn" aria-haspopup="dialog" aria-expanded={zoomPopOpen} title="预览缩放" onClick={event => { event.stopPropagation(); setZoomPopOpen(value => !value); setVolPopOpen(false); }}><ZoomIn /><span className="zoom-label">{previewZoom === "fit" ? "适应" : `${Math.round(previewZoom * 100)}%`}</span></button>
            <div className={`zoom-pop${zoomPopOpen ? " open" : ""}`} ref={zoomPopRef} onClick={event => event.stopPropagation()}>
              <div className="zp-head">
                <button className={`zp-fit${previewZoom === "fit" ? " on" : ""}`} onClick={() => setPreviewZoom("fit")}>{previewZoom === "fit" ? "✓ 适应画布" : "适应画布"}</button>
                <span className="zp-val">{previewZoom === "fit" ? "适应" : `${Math.round(previewZoom * 100)}%`}</span>
              </div>
              <input type="range" min={0} max={1000} value={previewZoom === "fit" ? zoomT(1) : zoomT(previewZoom)} onChange={event => setPreviewZoom(Math.round(zoomZ(Number(event.target.value)) * 100) / 100)} aria-label="预览缩放百分比" />
              <div className="zp-scale"><span>25%</span><span>100%</span><span>500%</span></div>
            </div>
            <button className="pb-icon" aria-label={isFullscreen ? "退出全屏" : "全屏"} title={isFullscreen ? "退出全屏" : "全屏"} onClick={() => void toggleFullscreen()}>{isFullscreen ? <Minimize /> : <Maximize />}</button>
          </div>
        </div>
        </div>
      </section>
      <div className="resize-handle resize-handle-right" role="separator" aria-label="调整右侧面板宽度" onPointerDown={event => beginResize("right", event)} />
      <aside className="properties-pane" aria-label="上下文属性" role="region">{selectedClip ? <ClipProperties clip={selectedClip} locked={Boolean(working?.locked_elements?.includes(selectedClip.clip_id))} onPatch={patchTimeline} onDraft={queueDraft} working={working!} playheadUs={playhead} onOpenEditingTools={tool => openEditingTools(tool, selectedClip.clip_id)} /> : selectedCaption ? <CaptionProperties caption={selectedCaption} locked={Boolean(selectedCaption.source_clip_id && working?.locked_elements?.includes(selectedCaption.source_clip_id))} onPatch={patchTimeline} onDraft={queueDraft} working={working!} /> : selectedTransition ? <TransitionProperties transition={selectedTransition} onPatch={patchTimeline} /> : <ProjectProperties project={project} saveState={saveState} authoritativePreview={authoritativePreview} previewIsStale={previewIsStale} renderDisabledReason={renderDisabledReason} onGeneratePreview={() => void generatePreview()} onCreateExport={openExportDialog} onOpenProjectDialog={() => setProjectDialogOpen(true)} />}</aside>
    </section>
    <div className="timeline-resize-handle" role="separator" aria-label="调整时间线高度" onPointerDown={event => beginResize("timeline", event)} />
    <TimelinePanel document={working} selection={selection} setSelection={(sel) => { setSelection(sel); exitLibraryPreview(); }} onPatch={patchTimeline} onDropAsset={dropAsset} coverUrl={coverUrl} onCaptureCover={() => setCoverDialogOpen(true)} canUndo={Boolean(timeline?.can_undo)} canRedo={Boolean(timeline?.can_redo)} onUndo={() => void undoRedo("undo")} onRedo={() => void undoRedo("redo")} assetMedia={timelineAssetMedia} waveformCache={waveformCache} playheadStore={playheadStore} onSeek={(timeUs) => { exitLibraryPreview(); seekFromUser(timeUs); const clip = sortedClips.find(c => timeUs >= c.timeline_start_us && timeUs < c.timeline_end_us); if (clip && videoRef.current) { const sourceStart = (clip.source_start_us ?? 0) / 1_000_000; const elapsed = (timeUs - clip.timeline_start_us) / 1_000_000 * ((clip.speed_milli ?? 1000) / 1000); pendingSeekRef.current = sourceStart + elapsed; videoRef.current.currentTime = pendingSeekRef.current; } else if (videoRef.current) { videoRef.current.currentTime = timeUs / 1_000_000; } }} onCommand={(id) => runCommand(id)} />
    <footer>
      <div className="footer-status">
        <div role="status" aria-label="保存状态" className={`save-state ${saveState === "保存失败" || saveState === "草稿冲突" ? "error" : ""}`} title={saveState === "草稿冲突" ? "检测到冲突草稿，请在顶部提示中处理" : undefined}><Save />{saveState}</div>
        <div className="footer-sep" aria-hidden="true" />
        <div className="job-state" role="status" aria-label="Core 连接状态"><span className={`core-dot ${runtimeReady ? "on" : ""}`} />{runtimeReady ? "Core 已连接" : "Core 连接中"}</div>
        {previewIsStale && <button className="status-chip stale" disabled={Boolean(renderDisabledReason)} title={renderDisabledReason ?? "点击立即生成权威预览"} onClick={() => runCommand("preview.generate")}><span className="chip-dot" aria-hidden="true" />权威预览已过期</button>}
      </div>
      <div className="footer-tasks">
        {renderActivity > 0 ? (
          <button className="tasks-summary" onClick={() => setTab("jobs")} title="点击查看任务列表">
            <span className="tasks-spinner" aria-hidden="true" />
            {renderActivity} 个任务进行中{runningProgressText ? ` · ${runningProgressText}` : ""}
          </button>
        ) : (
          <span className="tasks-idle">后台空闲</span>
        )}
      </div>
      <div className="footer-actions"><button className="ai-entry" disabled={!project || !timeline} onClick={() => void openExportBatch()}><Download size={12} />多平台导出</button><button className="ai-entry" disabled={!project} onClick={() => void openAi()}>AI 粗剪</button><button className="ai-entry" disabled={!timeline} onClick={() => void openPatch()}><Sparkles size={12} />AI 修改</button><button className="ai-entry" disabled={!timeline} onClick={() => void openRevisionCompare()}><History size={12} />版本比较</button><button className="ai-entry" title="管理 Provider、密钥与连接测试" onClick={() => setProviderSettingsOpen(true)}>Provider 设置</button><button className="ai-entry" title="应用设置" onClick={() => setSettingsOpen(true)}>设置</button></div>
      <span className="footer-version" title="权威预览与最终导出均由冻结 Timeline Revision 生成。">{CONTRACT_VERSION}</span>
    </footer>
     {exportDialogOpen && project && working && timeline && <ExportDialog
        projectId={project.project_id} projectName={project.name}
        durationUs={working.clips.reduce((max, item) => Math.max(max, item.timeline_end_us), 0)}
        clipCount={working.clips.length} captionCount={working.captions?.length ?? 0}
        canvas={project.canvas} ratio={renderRatio} coverUrl={coverUrl}
        previewReady={Boolean(authoritativePreview && !previewIsStale && authoritativePreview.preview.status === "ready")}
        encoderMode={encoderMode} onEncoderModeChange={setEncoderMode}
        quality={exportQuality} onQualityChange={setExportQuality}
        resolution={exportResolution} onResolutionChange={setExportResolution}
        frameRate={exportFrameRate} onFrameRateChange={setExportFrameRate}
        originalShortEdge={originalShortEdge} busy={exportBusy}
        onClose={() => setExportDialogOpen(false)} onOpenCover={() => setCoverDialogOpen(true)}
        onExport={submitExport}
      />}
      {coverDialogOpen && <CoverDialog coverUrl={coverUrl} onClose={() => setCoverDialogOpen(false)} onCapture={() => captureCover()} onChange={applyCover} />}
      {projectDialogOpen && <Dialog titleId="project-management-title" label="项目管理" onClose={() => setProjectDialogOpen(false)} className="project-management-modal"><div className="modal-heading"><div><h2 id="project-management-title">项目管理</h2><p>集中管理项目名称与生命周期，编辑区只保留当前项目选择。</p></div><IconButton label="关闭项目管理" onClick={() => setProjectDialogOpen(false)}><X /></IconButton></div><div className="project-steps"><span className="active"><i>1</i>导入素材</span><span><i>2</i>编辑时间线</span><span><i>3</i>预览检查</span><span><i>4</i>导出视频</span></div><section className="project-management-section"><h3>新建项目</h3><div className="project-form-row"><input aria-label="新项目名称" value={newProject} onChange={event => setNewProject(event.target.value)} placeholder="例如：品牌宣传片" /><label className="tb-field">画布<select aria-label="新建项目画布比例" value={newProjectRatio} onChange={event => setNewProjectRatio(event.target.value)}>{[{ value: "169", label: "16:9" }, { value: "916", label: "9:16" }, { value: "11", label: "1:1" }, { value: "43", label: "4:3" }, { value: "34", label: "3:4" }].map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><button className="compact-command" disabled={!newProject.trim()} onClick={() => void createProject()}><FolderPlus />创建项目</button></div></section><section className="project-management-section"><h3>当前项目</h3>{project ? <><p className="project-current-name">{project.name} · {project.status === "active" ? "活动" : project.status === "archived" ? "已归档" : "目录缺失"}</p><div className="project-form-row"><input aria-label="重命名项目" value={projectName} onChange={event => { projectNameProjectId.current = project.project_id; projectNameDirty.current = true; setProjectName(event.target.value); }} /><button className="compact-command" disabled={!projectName.trim()} onClick={() => void renameProject()}><Save />保存名称</button></div><div className="modal-actions"><button onClick={() => void toggleArchive()}>{project.status === "archived" ? <RotateCcw /> : <Archive />} {project.status === "archived" ? "重新打开项目" : "归档项目"}</button></div></> : <p>请先选择一个项目。</p>}</section></Dialog>}
    {batchOpen && <Dialog titleId="export-batch-title" label="多平台导出" onClose={() => setBatchOpen(false)} className="export-batch-modal"><div className="modal-heading"><div><h2 id="export-batch-title">多平台导出</h2><p>平台与画幅独立选择；仅同一 Revision 的权威预览可进入批次。</p></div><IconButton label="关闭多平台导出" onClick={() => setBatchOpen(false)}><X /></IconButton></div>{batchError && <p className="ai-status" role="status">{batchError}</p>}<div className="rendition-targets">{renditionTargets.map(target => { const platform = platformPresets.find(item => item.platform_preset_id === target.platform_preset_id); const rendition = renditionPresets.find(item => item.rendition_preset_id === target.rendition_preset_id); const preview = targetPreview(target); return <section key={target.key} className="rendition-target"><label>平台<select aria-label="导出平台" value={target.platform_preset_id} onChange={event => { const next = platformPresets.find(item => item.platform_preset_id === event.target.value); if (next) updateTarget(target.key, { platform_preset_id: next.platform_preset_id, rendition_preset_id: next.default_rendition_id, key: `${next.platform_preset_id}:${next.default_rendition_id}` }); }}><option value="">选择平台</option>{platformPresets.map(item => <option value={item.platform_preset_id} key={item.platform_preset_id}>{item.display_name}</option>)}</select></label><label>画幅<select aria-label="导出画幅" value={target.rendition_preset_id} onChange={event => updateTarget(target.key, { rendition_preset_id: event.target.value, key: `${target.platform_preset_id}:${event.target.value}` })}>{platform?.allowed_rendition_ids.map(id => <option value={id} key={id}>{renditionPresets.find(item => item.rendition_preset_id === id)?.display_name ?? id}</option>)}</select></label><label>布局<select aria-label="目标布局策略" value={target.layout_policy} onChange={event => updateTarget(target.key, { layout_policy: event.target.value as LayoutPolicy })}>{layoutPolicies.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label><div className="target-summary"><small>{rendition ? `${rendition.export.width}×${rendition.export.height} · H.264/AAC · 30fps` : "预设加载中"}</small><small>{preview ? `权威预览已就绪${preview.preview.warnings.length ? ` · ${preview.preview.warnings.join(", ")}` : ""}` : "需要本目标权威预览"}</small></div><div className="target-actions"><button onClick={() => void generateRenditionPreview(target)}>{preview ? "重新生成权威预览" : "生成权威预览"}</button><button disabled={renditionTargets.length === 1} onClick={() => setRenditionTargets(items => items.filter(item => item.key !== target.key))}>移除</button></div>{preview && <ReframeTargetEditor clips={reframeClips(target)} selections={reframeSelections[target.key] ?? {}} preview={reframePreviews[target.key]} pending={Boolean(reframePending[target.key])} onSelect={(clipId, anchor) => selectReframeAnchor(target, clipId, anchor)} onGenerate={() => void generateReframePreview(target)} onPlay={() => { setReframePlayback(reframePreviews[target.key]); setExportPlayback(undefined); setPreviewMode("authoritative"); }} />}</section>; })}</div><div className="modal-actions"><button disabled={renditionTargets.length >= 8 || !platformPresets.length} onClick={addTarget}>添加目标</button><button onClick={() => void chooseBatchDirectory()}>{directoryGrant ? `输出目录：{directoryGrant.display_name}` : "选择输出目录"}</button><button disabled={!directoryGrant || !renditionTargets.length || renditionTargets.some(target => !targetPreview(target))} onClick={() => void createBatch()}>创建批次</button></div><section className="reframe-batch-actions" aria-label="静态焦点批量导出"><h3>静态焦点批量导出</h3><p>独立于基础 Stage 3A 批次；所有目标的重构图权威预览就绪后才可创建。</p>{reframeError && <p className="ai-status" role="status">{reframeError}</p>}<div className="modal-actions"><button disabled={renditionTargets.some(target => !targetAdjustments(target).length || !reframePreviews[target.key])} onClick={() => void chooseReframeDirectory()}>{reframeDirectoryGrant ? `重构图输出目录：${reframeDirectoryGrant.display_name}` : "选择重构图输出目录"}</button><button disabled={!reframeDirectoryGrant || renditionTargets.some(target => !targetAdjustments(target).length || !reframePreviews[target.key])} onClick={() => void createReframeBatch()}>创建重构图批次</button></div></section>{activeBatch && <section className="batch-status"><h3>批次 {activeBatch.status}</h3><p>目录：{activeBatch.directory_display_name}</p>{activeBatch.items.map(item => <div key={item.export_batch_item_id}><strong>{item.rendition_snapshot.platform_preset_id} · {item.rendition_snapshot.rendition_preset_id}</strong><small>{item.status} · {item.progress === null ? "--" : `${Math.round(item.progress * 100)}%`}{item.destination_display_name ? ` · ${item.destination_display_name}` : ""}{item.error_code ? ` · ${item.error_code}` : ""}</small></div>)}<div className="modal-actions">{["queued", "running"].includes(activeBatch.status) && <button onClick={() => void window.desktop.cancelExportBatch(activeBatch.export_batch_id).then(setActiveBatch).catch(() => setBatchError("取消批次失败。"))}>取消批次</button>}{activeBatch.items.some(item => ["failed", "cancelled", "interrupted"].includes(item.status)) && <button onClick={() => void retryBatchItems()}>重新授权并重试失败项</button>}</div></section>}{activeReframeBatch && <section className="batch-status reframe-batch-status"><h3>重构图批次{activeReframeBatch.status}</h3><p>目录：{activeReframeBatch.directory_display_name}</p>{activeReframeBatch.items.map(item => <div key={item.reframe_export_batch_item_id}><strong>{item.rendition_reframe_snapshot.platform_preset_id} · {item.rendition_reframe_snapshot.rendition_preset_id}</strong><small>{item.status} · {item.progress === null ? "--" : `${Math.round(item.progress * 100)}%`}{item.destination_display_name ? ` · ${item.destination_display_name}` : ""}{item.error_code ? ` · ${item.error_code}` : ""}</small></div>)}<div className="modal-actions">{["queued", "running"].includes(activeReframeBatch.status) && <button onClick={() => void window.desktop.cancelReframeExportBatch(activeReframeBatch.reframe_export_batch_id).then(setActiveReframeBatch).catch(() => setReframeError("取消重构图批次失败。"))}>取消重构图批次</button>}{activeReframeBatch.items.some(item => ["failed", "cancelled", "interrupted"].includes(item.status)) && <button onClick={() => void retryReframeBatchItems()}>重新授权并重试重构图失败项</button>}</div></section>}</Dialog>}
    {confirmModel && <Dialog titleId="model-confirm-title" label="确认下载本地模型" onClose={() => setConfirmModel(undefined)} className="compact-dialog"><div className="modal-heading"><h2 id="model-confirm-title">确认下载本地模型</h2><IconButton label="关闭" onClick={() => setConfirmModel(undefined)}><X /></IconButton></div><h3>{confirmModel.display_name}</h3><p>{confirmModel.purpose}</p><dl><dt>下载大小</dt><dd>{formatBytes(confirmModel.model_size_bytes)}</dd><dt>许可证</dt><dd>{confirmModel.license.name}</dd><dt>隐私</dt><dd>模型在本机运行，不上传媒体或转录正文。</dd></dl>{confirmModel.license.acceptance_required && <label className="check-line"><input type="checkbox" checked={licenseAccepted} onChange={event => setLicenseAccepted(event.target.checked)} />我已阅读并接受该许可证</label>}<div className="modal-actions"><button onClick={() => setConfirmModel(undefined)}>暂不下载</button><button disabled={confirmModel.license.acceptance_required && !licenseAccepted} onClick={() => void downloadModel()}>确认并下载</button></div></Dialog>}
    {transcriptionAsset && <Dialog titleId="transcription-title" label="创建本地转录" onClose={() => setTranscriptionAsset(undefined)} className="compact-dialog"><div className="modal-heading"><h2 id="transcription-title">创建本地转录</h2><IconButton label="关闭" onClick={() => setTranscriptionAsset(undefined)}><X /></IconButton></div><p>{transcriptionAsset.display_name}</p><label>语言<select value={language} onChange={event => setLanguage(event.target.value)}><option value="auto">自动检测</option><option value="zh">中文</option><option value="en">English</option></select></label><label className="check-line"><input type="checkbox" checked={wordTimestamps} onChange={event => setWordTimestamps(event.target.checked)} />生成词级时间戳</label><div className="modal-actions"><button onClick={() => setTranscriptionAsset(undefined)}>取消</button><button onClick={() => void submitTranscription()}>开始转录</button></div></Dialog>}
    {pendingDeleteTranscript && <Dialog titleId="transcript-delete-title" label="删除转录" onClose={() => setPendingDeleteTranscript(undefined)} className="asset-delete-modal"><div className="modal-heading"><h2 id="transcript-delete-title">删除转录</h2><IconButton label="关闭" onClick={() => setPendingDeleteTranscript(undefined)}><X /></IconButton></div><p>确定要删除这条转录吗？</p><div className="delete-warning">该转录的片段与词级时间戳将一并删除，此操作不可撤销。若其片段已被时间线字幕引用，删除会被拒绝——请先移除相关字幕或片段。</div><div className="modal-actions"><button disabled={deleteTranscriptBusy} onClick={() => setPendingDeleteTranscript(undefined)}>取消</button><button className="danger" disabled={deleteTranscriptBusy} onClick={() => void deleteTranscript(pendingDeleteTranscript)}>{deleteTranscriptBusy ? "删除中…" : "删除转录"}</button></div></Dialog>}    {pendingDeleteAsset && <Dialog titleId="asset-delete-title" label="删除素材" onClose={() => setPendingDeleteAsset(undefined)} className="asset-delete-modal"><div className="modal-heading"><h2 id="asset-delete-title">删除素材</h2><IconButton label="关闭" onClick={() => setPendingDeleteAsset(undefined)}><X /></IconButton></div><p>确定要删除素材「{pendingDeleteAsset.display_name}」吗？</p><div className="delete-warning">如果该素材已添加到时间线，其相关片段（含关联字幕与转场）将一并删除，此操作不可撤销。</div><div className="modal-actions"><button disabled={deleteBusy} onClick={() => setPendingDeleteAsset(undefined)}>取消</button><button className="danger" disabled={deleteBusy} onClick={() => void deleteAsset(pendingDeleteAsset)}>{deleteBusy ? "删除中…" : "删除素材"}</button></div></Dialog>}
    {viewingTranscript && <Dialog titleId="transcript-title" label="原始转录" onClose={() => setViewingTranscript(undefined)} className="transcript-viewer"><div className="modal-heading"><div><h2 id="transcript-title">原始转录</h2><small>{viewingTranscript.language} · {viewingTranscript.provider} · {viewingTranscript.model_revision}</small></div><IconButton label="关闭" onClick={() => setViewingTranscript(undefined)}><X /></IconButton></div><div className="readonly-note">原始 ASR 结果只读。勾选片段后，可追加到时间线或交给 AI 优化字幕文本。</div><div className="transcript-viewer-toolbar"><strong>已选 {(selectedSegments[viewingTranscript.transcript_id] ?? []).length} / {viewingTranscript.segments.length} 段</strong><button className="mini-btn" onClick={() => setSelectedSegments(state => ({ ...state, [viewingTranscript.transcript_id]: viewingTranscript.segments.map(segment => segment.segment_id) }))}>全选</button><button className="mini-btn" onClick={() => setSelectedSegments(state => ({ ...state, [viewingTranscript.transcript_id]: [] }))}>清空</button></div><div className="readonly-segments transcript-selectable-segments">{viewingTranscript.segments.map(segment => <SegmentRow key={segment.segment_id} segment={segment} selected={(selectedSegments[viewingTranscript.transcript_id] ?? []).includes(segment.segment_id)} onToggle={() => setSelectedSegments(state => ({ ...state, [viewingTranscript.transcript_id]: toggle(state[viewingTranscript.transcript_id] ?? [], segment.segment_id) }))} />)}</div><div className="transcript-viewer-actions"><button className="append-btn" disabled={!(selectedSegments[viewingTranscript.transcript_id] ?? []).length} onClick={() => insertSegments(viewingTranscript)}>追加所选片段</button><button className="append-btn" disabled={!(selectedSegments[viewingTranscript.transcript_id] ?? []).length} title="把选中片段的字幕文本交给 Provider 改写成更短的字幕" onClick={() => { setCaptionsOptimize({ transcript: viewingTranscript, segmentIds: [...(selectedSegments[viewingTranscript.transcript_id] ?? [])] }); setViewingTranscript(undefined); }}>AI 优化字幕文本</button></div></Dialog>}
    {aiOpen && <Dialog titleId="ai-roughcut-title" label="AI 粗剪" onClose={() => setAiOpen(false)} className="ai-roughcut"><div className="modal-heading"><div><h2 id="ai-roughcut-title">AI 粗剪</h2><p>仅在确认外传内容后调用 Provider。</p></div><IconButton label="关闭 AI 粗剪" onClick={() => setAiOpen(false)}><X /></IconButton></div>{aiError && <p className="ai-status" role="status">{aiError}</p>}{aiStep === "form" && <><label>主题<input value={aiForm.topic} onChange={e => setAiForm(v => ({ ...v, topic: e.target.value }))} /></label><label>受众<input value={aiForm.audience} onChange={e => setAiForm(v => ({ ...v, audience: e.target.value }))} /></label><label>叙事目标<textarea value={aiForm.narrative_goal} onChange={e => setAiForm(v => ({ ...v, narrative_goal: e.target.value }))} /></label><label>风格说明<textarea value={aiForm.style_notes} onChange={e => setAiForm(v => ({ ...v, style_notes: e.target.value }))} /></label><label>制作配方<select value={aiForm.recipe_id} onChange={e => setAiForm(v => ({ ...v, recipe_id: e.target.value }))}><option value="">选择配方</option>{aiRecipes.map(item => <option key={item.recipe_id} value={item.recipe_id}>{item.name ?? item.display_name} · {item.summary}</option>)}</select></label><label>Provider<select value={aiForm.provider_id} onChange={e => setAiForm(v => ({ ...v, provider_id: e.target.value }))}><option value="">选择 Provider</option>{aiProviders.map(item => <option key={item.provider_config_id} value={item.provider_config_id} disabled={!item.enabled || item.credential_status !== "configured" || item.candidate_capability_status !== "supported"}>{item.display_name} · {item.candidate_capability_status === "supported" ? "AI 粗剪可用" : item.candidate_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 粗剪"}</option>)}</select></label><div className="provider-capability-list">{aiProviders.map(item => <div key={item.provider_config_id}><span>{item.display_name} · {item.candidate_capability_status === "supported" ? "AI 粗剪可用" : item.candidate_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 粗剪"}</span><button disabled={aiCapabilityTesting} onClick={() => void testCandidateProviderCapability(item.provider_config_id)}>{aiCapabilityTesting ? "正在测试兼容性" : "测试 AI 粗剪兼容性"}</button></div>)}</div><p className="readonly-note">Provider 的创建、密钥与连接测试已移至「Provider 设置」（工具菜单 / 设置）。<button className="mini-btn" onClick={() => { setProviderSettingsOpen(true); }}>打开 Provider 设置</button></p><label>就绪转录<select value={aiForm.transcript_id} onChange={e => setAiForm(v => ({ ...v, transcript_id: e.target.value }))}><option value="">选择已就绪转录</option>{Object.values(transcriptSummaries).flat().filter(item => item.status === "ready").map(item => <option key={item.transcript_id} value={item.transcript_id}>{item.language} · 就绪</option>)}</select></label><div className="modal-actions"><button disabled={!aiForm.topic || !aiForm.audience || !aiForm.narrative_goal || !aiForm.provider_id || !aiForm.recipe_id || !aiForm.transcript_id || aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.candidate_capability_status !== "supported" || aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.credential_status !== "configured" || !aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.enabled} onClick={() => void prepareAi()}>准备外传确认</button></div></>}{aiStep === "confirm" && aiPreview && <><h3>确认发送的精确内容</h3><dl><dt>目标</dt><dd>{aiPreview.provider.origin}</dd><dt>模型</dt><dd>{aiPreview.provider.model}</dd><dt>字段</dt><dd>{aiPreview.sent_fields.join("、")}</dd><dt>段落/字符</dt><dd>{aiPreview.stats.segment_count} 段 / {aiPreview.stats.character_count} 字</dd><dt>估算 Token</dt><dd>{aiPreview.stats.estimated_tokens}</dd><dt>费用提示</dt><dd>指 Provider 配置的单价估算，最终费用以服务商账单为准。</dd><dt>哈希</dt><dd>{aiPreview.payload_sha256}</dd><dt>有效期</dt><dd>{aiPreview.expires_at}</dd></dl><div className="egress-text">{Array.isArray(aiPreview.payload.segments) && (aiPreview.payload.segments as Array<Record<string, unknown>>).map(segment => <p key={String(segment.segment_ref)}>{String(segment.text)}</p>)}</div><div className="modal-actions"><button onClick={() => { setAiPreview(undefined); setAiStep("form"); }}>返回修改</button><button onClick={() => void createAi()}>我确认发送以上内容</button></div></>}{aiStep === "running" && <><h3>正在生成候选方案</h3><p>任务进度与取消操作沿用现有任务中心；如失败或取消，请重新准备并再次确认。</p></>}{aiStep === "candidates" && <><h3>三个候选方案</h3><div className="candidate-columns">{(["balanced", "compact", "bold"] as const).map((variant, index) => { const item = aiCandidates.find(candidate => candidate.variant === variant); const title = ["稳妥版", "紧凑版", "高能版"][index]; return <section key={variant}><h4>{title}</h4>{item ? <><strong>{String(item.title_suggestion)}</strong><p>{String(item.summary)}</p><small>{Number(item.duration_us) / 1_000_000}s · 模型参考</small>{Array.isArray(item.clips) && (item.clips as Array<Record<string, unknown>>).map(clip => <div className="candidate-clip" key={String(clip.clip_id)}><span>{Number(clip.source_start_us) / 1_000_000}s–{Number(clip.source_end_us) / 1_000_000}s</span><button onClick={() => void playAiClip(clip)}>试播片段</button><p>{String(clip.reason)}</p></div>)}<button onClick={() => void adoptAi(item)}>采用此方案</button></> : <p>等待有效响应</p>}</section>; })}</div>{aiPlayback && <video className="candidate-player" src={aiPlayback.media_url} controls autoPlay onLoadedMetadata={e => { e.currentTarget.currentTime = aiPlayback.source_start_us / 1_000_000; }} onTimeUpdate={e => { if (e.currentTarget.currentTime >= aiPlayback.source_end_us / 1_000_000) e.currentTarget.pause(); }} />}</>}</Dialog>}
     {aiOpen && aiStep === "running" && <section className="ai-job-progress" aria-live="polite" aria-label="AI 粗剪任务进度"><strong>阶段：{aiJob?.stage ?? "queued"}</strong><span>进度：{Math.round((aiJob?.progress ?? 0) * 100)}%</span><progress aria-label="AI 粗剪进度" max="1" value={aiJob?.progress ?? 0} /><button disabled={!aiJob || !["queued", "running", "cancelling"].includes(aiJob.status)} onClick={() => { if (!aiJob) return; void window.desktop.cancelJob(aiJob.job_id).then(job => { setAiJob(job); setAiPreview(undefined); setAiCandidates([]); setAiPlayback(undefined); setAiStep("form"); setAiError("生成已取消。请重新准备外传内容并再次确认。"); }).catch(() => setAiError("取消请求失败；请等待当前任务状态刷新。")); }}>取消生成</button></section>}
    {patchOpen && <Dialog titleId="planning-patch-title" label="AI 修改" onClose={closePatch} className="planning-patch"><div className="modal-heading"><div><h2 id="planning-patch-title">AI 修改</h2><p>提案不会自动修改正式 Timeline。</p></div><IconButton label="关闭 AI 修改" onClick={closePatch}><X /></IconButton></div>{patchError && <p className="ai-status" role="status">{patchError}</p>}{patchStep === "form" && <><label>修改指令<textarea aria-label="修改指令" maxLength={4000} value={patchInstruction} onChange={event => setPatchInstruction(event.target.value)} /></label><label>Provider<select aria-label="AI 修改 Provider" value={patchProviderId} onChange={event => setPatchProviderId(event.target.value)}><option value="">选择已配置 Provider</option>{patchProviders.map(item => <option value={item.provider_config_id} key={item.provider_config_id} disabled={item.timeline_patch_capability_status !== "supported"}>{item.display_name} · {item.model} · {item.timeline_patch_capability_status === "supported" ? "AI 修改可用" : item.timeline_patch_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 修改"}</option>)}</select></label><div className="provider-capability-list">{patchProviders.map(item => <div key={item.provider_config_id}><span>{item.display_name} · {item.timeline_patch_capability_status === "supported" ? "AI 修改可用" : item.timeline_patch_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 修改"}</span><button disabled={patchCapabilityTesting} onClick={() => void testPatchProviderCapability(item.provider_config_id)}>{patchCapabilityTesting ? "正在测试兼容性" : "测试 AI 修改兼容性"}</button></div>)}</div><div className="modal-actions"><button disabled={!patchProviderId || !patchInstruction.trim() || patchProviders.find(item => item.provider_config_id === patchProviderId)?.timeline_patch_capability_status !== "supported"} onClick={() => void preparePatch()}>准备外传确认</button></div></>}{patchStep === "confirm" && patchPreview && <><h3>确认本次外传</h3><div className="instruction-preview"><strong>你的本地指令</strong><p>{patchInstruction}</p></div><dl><dt>Provider</dt><dd>{patchPreview.provider.display_name} · {patchPreview.provider.origin}</dd><dt>模型</dt><dd>{patchPreview.provider.model}</dd><dt>字段类别</dt><dd>{patchPreview.sent_fields.join("、")}</dd><dt>内容计数</dt><dd>{patchPreview.clip_count} Clip / {patchPreview.caption_count} Caption / {patchPreview.locked_count} 锁定</dd><dt>字符 / Token</dt><dd>{patchPreview.character_count} / {patchPreview.estimated_tokens}</dd><dt>哈希</dt><dd>{patchPreview.payload_sha256}</dd><dt>费用</dt><dd>最终费用以 Provider 账单为准。</dd></dl><p className="readonly-note">上方指令来自当前本地输入；Core 确认 DTO 不包含正文。</p><div className="modal-actions"><button onClick={() => { setPatchPreview(undefined); setPatchStep("form"); }}>返回修改</button><button onClick={() => void createPatch()}>确认并发送一次</button></div></>}{patchStep === "running" && <><h3>正在生成提案</h3><p>{patchJob?.stage ?? "queued"} · {Math.round((patchJob?.progress ?? 0) * 100)}%</p><progress max="1" value={patchJob?.progress ?? 0} /><div className="modal-actions"><button disabled={!patchJob || !["queued", "running", "cancelling"].includes(patchJob.status)} onClick={() => void cancelPatch()}>取消生成</button></div></>}{patchStep === "proposal" && patchProposal && <><h3>提案差异</h3><TimelineDiffView diff={patchProposal.diff} /><div className="modal-actions"><button onClick={closePatch}>放弃</button><button disabled={patchProposal.applied_revision_id !== null} onClick={() => void applyPatchProposal()}>应用修改</button></div></>}</Dialog>}
    {generationOpen && project && <MediaGenerationWorkbench key={project.project_id} project={project} assets={assets} onClose={() => setGenerationOpen(false)} />}
    {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onNotify={message => showNotice(message, "info")} onOpenProviderSettings={() => setProviderSettingsOpen(true)} />}
    {providerSettingsOpen && <ProviderSettingsDialog providers={[...aiProviders, ...patchProviders.filter(item => !aiProviders.some(p => p.provider_config_id === item.provider_config_id))]} onProvidersChange={setAiProviders} onClose={() => setProviderSettingsOpen(false)} onNotify={message => showNotice(message, "info")} />}
    {captionsOptimize && project && <CaptionsProviderPanel projectId={project.project_id} baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null} providers={[...aiProviders, ...patchProviders.filter(item => !aiProviders.some(p => p.provider_config_id === item.provider_config_id))]} transcript={captionsOptimize.transcript} segmentIds={captionsOptimize.segmentIds} onClose={() => setCaptionsOptimize(undefined)} onApplied={() => { void loadRenderData(project); }} onNotify={message => showNotice(message, "info")} />}
    {agentOpen && project && <AgentSessionPanel projectId={project.project_id} baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null} providers={[...aiProviders, ...patchProviders.filter(item => !aiProviders.some(p => p.provider_config_id === item.provider_config_id))]} onClose={() => setAgentOpen(false)} onNotify={message => showNotice(message, "info")} />}
    {worklistOpen && project && <WorklistPanel key={project.project_id} projectId={project.project_id} baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null} onClose={() => setWorklistOpen(false)} onApplied={() => { void window.desktop.getTimeline(project.project_id).then(state => { acceptState(state); }); }} onNotify={message => showNotice(message, "success")} />}
    {cvOptionsOpen && cvOptionsAsset && <Dialog titleId="cv-density-title" label="AI 信号分析" onClose={() => { setCvOptionsOpen(false); setCvOptionsAsset(null); }} className="cv-density">
      <div className="modal-heading"><div><h2 id="cv-density-title">AI 信号分析</h2><p>本地零外传。可选密度旋钮：留空则用默认（目标间隔 4s、预算 10s/分钟源）。</p></div><button className="icon-button" aria-label="关闭 AI 信号分析" onClick={() => { setCvOptionsOpen(false); setCvOptionsAsset(null); }}>×</button></div>
      <label>目标采样间隔（秒，可选）<input aria-label="目标采样间隔秒" type="number" min={0.1} max={60} step={0.1} value={cvTargetGapS} onChange={event => setCvTargetGapS(event.target.value)} placeholder="默认 4" /></label>
      <label>每分钟预算（秒，可选）<input aria-label="每分钟预算秒" type="number" min={1} max={120} step={1} value={cvBudgetPerMin} onChange={event => setCvBudgetPerMin(event.target.value)} placeholder="默认 10" /></label>
      <p className="readonly-note">间隔越小越密；预算不足时自动退到预算内尽量密，并如实标记密度。</p>
      <div className="modal-actions">
        <button onClick={() => { startCvAnalysis(cvOptionsAsset); setCvOptionsOpen(false); setCvOptionsAsset(null); }}>使用默认设置</button>
        <button onClick={submitCvOptions}>按上述设置分析</button>
      </div>
    </Dialog>}
    {editingGrammarOpen && project && editingToolsTool && <EditingToolsPanel
      projectId={project.project_id}
      baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null}
      clips={working?.clips ?? []}
      initialClipId={editingToolsClipId}
      initialTool={editingToolsTool}
      onClose={() => { setEditingGrammarOpen(false); setEditingToolsTool(null); }}
      onApplied={state => { acceptState(state); void loadRenderData(project); }}
      onNotify={message => showNotice(message, "success")}
    />}
    {editingGrammarOpen && project && !editingToolsTool && <EditingGrammarPanel
      projectId={project.project_id}
      baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null}
      onClose={() => setEditingGrammarOpen(false)}
      onApplied={state => { acceptState(state); void loadRenderData(project); }}
      onNotify={message => showNotice(message, "success")}
    />}
    {providerImageGenerationOpen && project && <ProviderImageGenerationWorkbench key={`provider-image-${project.project_id}`} project={project} assets={assets} onClose={() => setProviderImageGenerationOpen(false)} />}
    {shotRequirementsOpen && project && <ShotRequirementWorkbench key={project.project_id} project={project} assets={assets} onClose={() => setShotRequirementsOpen(false)} />}
    {revisionOpen && <Dialog titleId="revision-compare-title" label="版本比较" onClose={() => { setRevisionOpen(false); setRevisionDiff(undefined); }} className="revision-compare"><div className="modal-heading"><div><h2 id="revision-compare-title">版本比较</h2><p>只读操作，不改变当前 Revision、草稿或渲染记录。</p></div><IconButton label="关闭版本比较" onClick={() => { setRevisionOpen(false); setRevisionDiff(undefined); }}><X /></IconButton></div><div className="revision-selectors"><label>基线<select aria-label="基线 Revision" value={revisionPair.base} onChange={event => setRevisionPair(value => ({ ...value, base: event.target.value }))}>{revisions.map(item => <option value={item.timeline_revision_id} key={`base-${item.timeline_revision_id}`}>{item.summary} · {item.created_at}</option>)}</select></label><label>目标<select aria-label="目标 Revision" value={revisionPair.target} onChange={event => setRevisionPair(value => ({ ...value, target: event.target.value }))}>{revisions.map(item => <option value={item.timeline_revision_id} key={`target-${item.timeline_revision_id}`}>{item.summary} · {item.created_at}</option>)}</select></label></div><div className="modal-actions"><button disabled={!revisionPair.base || !revisionPair.target || revisionPair.base === revisionPair.target} onClick={() => void compareRevisions()}>比较</button></div>{revisionDiff && <TimelineDiffView diff={revisionDiff} />}</Dialog>}
       {renderPanelOpen && <Dialog titleId="render-panel-title" label="渲染与导出" onClose={() => setRenderPanelOpen(false)} className="render-panel-dialog"><div className="modal-heading"><div><h2 id="render-panel-title">渲染与导出</h2><p>任务为本次会话的过程记录；导出产物为持久记录，关闭后任务继续在后台推进。</p></div><IconButton label="关闭渲染与导出" onClick={() => setRenderPanelOpen(false)}><X /></IconButton></div>
        <section className="render-tasks-card" aria-label="任务">
          {(() => {
            // 任务区分组：进行中/排队 → 失败/中断（保留原因）→ 成功折叠为一行
            // 摘要（任务行的价值在过程，终态后不再逐条占位；产物区才是结果）。
            const panelJobs = jobs.filter(item => item.kind === "authoritative_preview" || item.kind === "final_export");
            const activeJobs = panelJobs.filter(item => ["queued", "running", "cancelling"].includes(item.status));
            const failedJobs = panelJobs.filter(item => ["failed", "cancelled", "interrupted"].includes(item.status));
            const succeededCount = panelJobs.filter(item => item.status === "succeeded").length;
            const renderJobRow = (item: Job) => {
              const pct = item.progress === null ? null : Math.round(item.progress * 100);
              const isActive = ["queued", "running", "cancelling"].includes(item.status);
              // 收尾窗口：任务实际已成功，正在做 100% 平滑展示——不显示
              // 「运行中」（误导，像还要跑很久）也不显示取消/ETA。
              const finishing = isActive && item.progress === 1;
              return <div className={`render-job${isActive ? " active" : ""}${finishing ? " finishing" : ""}`} key={item.job_id}>
                <div className="render-job-main">
                  <div className="render-job-title"><strong>{jobKindLabels[item.kind] ?? item.kind}</strong><span className={`render-job-state ${item.status === "failed" || item.status === "interrupted" ? "bad" : isActive ? "run" : "dim"}`}>{finishing ? "即将完成" : jobStatusLabels[item.status]}</span>{item.status === "running" && !finishing && <JobEta job={item} />}</div>
                  <small>{item.phase ? `${jobPhaseLabels[item.phase] ?? item.phase}${item.phase_progress !== null && item.phase_progress !== undefined ? ` ${Math.round(item.phase_progress * 100)}%` : ""}` : ""}{item.error ? `${item.phase ? " · " : ""}${safeTaskErrorMessage(item.error)}` : ""}</small>
                  {pct !== null && <div className="render-job-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>}
                </div>
                {isActive && !finishing && <IconButton label="取消渲染任务" onClick={() => void cancelJob(item)}><Square /></IconButton>}
              </div>;
            };
            return <>{(activeJobs.length > 0 || failedJobs.length > 0 || succeededCount > 0) && <div className="render-group-title">任务{activeJobs.length > 0 && <span className="render-group-count">{activeJobs.length} 个进行中</span>}</div>}
            {activeJobs.length === 0 && failedJobs.length === 0 && succeededCount === 0 && <div className="render-empty">暂无任务。{!authoritativePreview && "当前没有权威预览，仍可直接导出。"}</div>}
            {activeJobs.map(renderJobRow)}
            {failedJobs.length > 0 && <div className="render-group-subtitle">失败 / 中断</div>}
            {failedJobs.map(renderJobRow)}
            {succeededCount > 0 && <div className="render-done-summary">本轮已完成 {succeededCount} 个任务，产物见下方。</div>}</>;
          })()}
        </section>
        <section className="render-products-card" aria-label="导出产物">
          <div className="render-group-title">导出产物{exports.length > 0 && <span className="render-group-count">{exports.length} 个文件</span>}</div>
          {exports.length === 0 && <div className="render-empty">尚无导出产物。</div>}
          {exports.map(item => { const info = item.export_record.media_info; const dims = info ? `${info.video.width}×${info.video.height}` : null; const fps = info ? Math.round(info.video.fps_num / info.video.fps_den) : null; const missing = item.export_record.status !== "succeeded"; return <div className={`export-record${missing ? " missing" : ""}`} key={item.export_record.export_record_id}><div><strong>{item.export_record.destination_display_name}</strong><small>{formatRelativeTime(item.export_record.created_at)}{dims ? ` · ${dims}${fps ? ` · ${fps}fps` : ""}` : ""} · {formatBytes(item.export_record.size_bytes)} · {missing ? "文件缺失（本地文件已被移动或删除）" : "成功"}</small>{item.export_record.fallback_reason && <small className="render-fallback-note">{fallbackReasonLabel(item.export_record.fallback_reason)}</small>}</div><div>{missing ? <IconButton label="移除记录" onClick={() => void removeMissingExport(item)}><Trash2 /></IconButton> : <IconButton label="定位导出" onClick={() => void window.desktop.openArtifactFolder(item.export_record.render_artifact_id)}><MapPin /></IconButton>}<IconButton label="播放导出" disabled={missing} onClick={() => { setExportPlayback(item); setPreviewMode("authoritative"); }}><Play /></IconButton><IconButton label="打开导出" disabled={missing} onClick={() => void window.desktop.openArtifact(item.export_record.render_artifact_id)}><Eye /></IconButton></div></div>; })}
        </section></Dialog>}
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
      <div className="modal-actions"><button onClick={() => { applyShortcuts(structuredClone(DEFAULT_SHORTCUTS)); setRecordingId(null); showNotice("已恢复默认快捷键。"); }}>恢复默认</button></div>
    </Dialog>}
</main>;
}

function SegmentRow({ segment, selected, onToggle }: { segment: TranscriptSegment; selected: boolean; onToggle: () => void }) { return <label className="segment-row"><input type="checkbox" checked={selected} onChange={onToggle} /><span>{formatTime(segment.start_us)}-{formatTime(segment.end_us)}</span><p>{segment.text}</p></label>; }
function toggle(items: string[], id: string) { return items.includes(id) ? items.filter(item => item !== id) : [...items, id]; }

