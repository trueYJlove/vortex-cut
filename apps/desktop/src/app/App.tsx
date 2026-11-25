import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, AudioLines, BookOpen, Captions, ChevronDown, ChevronLeft, ChevronRight, Clapperboard, Command as CommandIcon, Download, Eye, FileText, FlaskConical, FolderCog, FolderOpen, FolderPlus, GitCompare, History, Image as ImageIcon, ImagePlus, Keyboard, LayoutPanelLeft, Lock, LockOpen, MapPin, Maximize, Minimize, MonitorPlay, Pause, Play, Plus, Redo2, RefreshCw, RotateCcw, Save, Scissors, Search, Sparkles, Repeat, Square, SquarePlus, Settings2, Trash2, Type as TypeIcon2, Type, Undo2, Upload, Video, Volume2, VolumeX, WandSparkles, Minus, ZoomIn, SlidersHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ArrowUpDown, LayoutGrid, List } from "lucide-react";
import { Star } from "lucide-react";
import type { Asset, AssetId, AssetKind, AssetPresentation, ImportedAsset, BriefInput, CaptionPresetId, CvAnalysisSummary, CvSample, DestinationGrant, DirectoryGrant, EncoderMode, EgressPreview, ExportBatch, ExportFrameRate, ExportQuality, ExportResolution, HorizontalAnchor, Job, LayoutPolicy, MediaInfo, ModelDetail, ModelSummary, OutputRatio, PlatformPreset, Project, ProviderConfig, ReframeExportBatch, RenditionPreset, RenditionReframeAdjustment, TimelineCaption, TimelineClip, TimelineDiff, TimelineDocument, TimelineLayout, TimelinePatchEgressPreview, TimelinePatchOperation, TimelinePatchProposal, TimelineRevisionId, TimelineRevisionSummary, TimelineState, Transcript, TranscriptSegment, TranscriptSummary, VerticalAnchor } from "@aivideo/contracts";
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
import { AngleSyncPanel } from "./angle-sync/AngleSyncPanel.js";
import { SemanticSearchPanel } from "./semantic-search/SemanticSearchPanel.js";
import { KeyframeReviewPanel } from "./keyframe-review/KeyframeReviewPanel.js";
import { Dialog } from "./Dialog.js";
import { ContextMenu, type ContextMenuItem } from "../ui/of/ContextMenu.js";
import { pickMedia } from "../ui/of/media-selection.js";
import { ProjectTabStrip } from "./workspace/ProjectTabStrip.js";
import { ASSET_BATCH_DRAG, ASSET_DRAG, SYSTEM_FILE_DROP_ID, clearSystemFileDrop, draggedAssetIds, planAssetDrop, resolveTimelineAssetDropIntent, setActiveDraggedAssetIds, takeSystemFileDrop } from "./timeline/asset-drop.js";
import type { TimelineAssetDropIntent } from "./timeline/types.js";
import { alignmentBox, alignmentPreviewSize, groupFrameBounds, planFrameAlignment, planFrameDistribution, planGroupBoundsEdit, type GroupBoundsField } from "./timeline/frame-alignment.js";
import type { AlignDistribution, AlignEdge } from "../ui/of/AlignBar.js";
import { errorCode, safeErrorMessage, safeTaskErrorMessage } from "./safeErrors.js";
import { formatLocalStamp } from "./localTime.js";
import { PreviewPipOverlays, type PipOverlay, type PipTransform } from "./PreviewPipOverlays.js";
import { SyntheticPreview } from "./preview/SyntheticPreview.js";
import { syntheticFallbackNotice } from "./preview/fallback-notice.js";
import { FIT_VIEW, ZOOM_SETTLE_MS, createWheelCoalescer, createZoomSettle, fittedSize, isFit, panBy, wheelPx, wheelZoomFactor, zoomAt, zoomLayout, zoomMax, type ViewerView } from "./preview/viewer-zoom.js";
import { IDLE_PRESS, pickTopmostBox, reducePreviewPress, selectionFromOutcome, type HitBox, type PreviewPress } from "./preview/stage-interaction.js";
import { editorCommands, type EditorCommand } from "./editorCommands.js";
import { bindingLabel, findConflict, loadShortcuts, matchesBinding, normalizeRecordedBinding, saveShortcuts, DEFAULT_SHORTCUTS, type ShortcutCommandId, type ShortcutEntry } from "./shortcuts.js";
import { TimelinePanel } from "./timeline/TimelineCanvas.js";
import { splitSelectionAt } from "./timeline/split-point.js";
import { removeLinkedClips } from "./timeline/linked-clips.js";
import { planMagneticDelete, planRippleDelete, readTimelineBehaviorPrefs } from "./timeline/magnetic-plan.js";
import type { TimeRange } from "./timeline/time-range.js";
import { RequestScheduler, BoundedTaskQueue } from "./request-scheduling.js";
import { parseSubtitleFile } from "./subtitleImport.js";
import { AssetSelectionProperties, ClipGroupAlignmentProperties, ClipProperties, CaptionProperties, ProjectProperties, TimelineDiffView, TransitionProperties } from "./PropertyPanels.js";
import { JobEta } from "./JobEta.js";
import { WorkspaceFooter } from "./workspace/WorkspaceFooter.js";
import { ProjectLibraryDialog } from "./ProjectLibraryDialog.js";
import {
  ASSET_FAVORITES_KEY,
  assetCollectionSignature,
  assetDurationLabel,
  assetKindLabels,
  assetKinds,
  assetMetaText,
  assetReconcilePageLimit,
  availabilityLabels,
  cvSparkPath,
  duration,
  fallbackReasonLabel,
  FINALIZING_MS,
  formatBytes,
  formatRelativeTime,
  formatSmpteTimecode,
  isTranscribable,
  jobDetailText,
  jobKindLabels,
  jobPhaseLabels,
  jobStatusLabels,
  layoutPolicies,
  modelBadgeLabels,
  modelStatusLabels,
  navigateAssetLibrary,
  previewRatios,
  projectCanvasPresets,
  readAssetFavorites,
  reconcileTimelineSelection,
  storedAssetView,
  timelineRetryDelaysMs,
  toggle,
  transcriptStatusLabels,
  type AssetFilter,
  type Notice,
  type NoticeTone,
  type ReframeAnchor,
  type ReframeSelections,
  type RenditionTarget,
  type SaveState,
  type Selection,
} from "./appHelpers.js";
import { IconButton, ReframeTargetEditor, SegmentRow } from "./layout/AppMicroComponents.js";
import { useWorkspaceLayout } from "./hooks/useWorkspaceLayout.js";
import { useAiWorkflows } from "./hooks/useAiWorkflows.js";
import { useExportAndRender } from "./hooks/useExportAndRender.js";
import { useAssetAndMediaLibrary } from "./hooks/useAssetAndMediaLibrary.js";
import { usePreviewPlayback } from "./hooks/usePreviewPlayback.js";
import { useProjectLifecycle } from "./hooks/useProjectLifecycle.js";

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project>();
  const [openProjectIds, setOpenProjectIds] = useState<Project["project_id"][]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  // 轮询 effect 的闭包持有的是 effect 建立时的 jobs——活跃判定与终态对账
  // 都必须读最新值（hasActiveWork 同理），否则会以陈旧列表误判退避/终态。
  const jobsRef = useRef<Job[]>([]);
  jobsRef.current = jobs;
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [timeline, setTimeline] = useState<TimelineState>();
  const [working, setWorking] = useState<TimelineDocument>();
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<"assets" | "transcripts" | "models" | "jobs">("assets");
  const [saveState, setSaveState] = useState<SaveState>("已保存");
  // 提示条：按严重级别配色（成功绿/警告琥珀/错误红/信息灰），数秒后自动消失（错误停留更久）。
  const [notice, setNotice] = useState<Notice>("");
  const [newProject, setNewProject] = useState("");
  const [newProjectRatio, setNewProjectRatio] = useState("916");
  const [previewRatio, setPreviewRatio] = useState("fit");
  const [previewRatioTouched, setPreviewRatioTouched] = useState(false);
  // Provider 设置独立入口：Provider 是各 AI 功能共用的前置，不再藏在 AI 粗剪里。
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [worklistOpen, setWorklistOpen] = useState(false);
  const [editingGrammarOpen, setEditingGrammarOpen] = useState(false);
  const [angleSyncOpen, setAngleSyncOpen] = useState(false);
  const [semanticSearchOpen, setSemanticSearchOpen] = useState(false);
  const [keyframeReviewOpen, setKeyframeReviewOpen] = useState(false);
  const [editingToolsTool, setEditingToolsTool] = useState<"remove_pauses" | "beat_sync" | "lj_cut" | null>(null);
  const [editingToolsClipId, setEditingToolsClipId] = useState<string | null>(null);
  const openEditingTools = (tool: "remove_pauses" | "beat_sync" | "lj_cut", clipId?: string | null) => {
    setEditingToolsTool(tool);
    setEditingToolsClipId(clipId ?? selectedClip?.clip_id ?? null);
    setEditingGrammarOpen(true);
  };
  const [generationOpen, setGenerationOpen] = useState(false);
  const [commandSearchOpen, setCommandSearchOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const commandSearchInputRef = useRef<HTMLInputElement>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [providerImageGenerationOpen, setProviderImageGenerationOpen] = useState(false);
  const [shotRequirementsOpen, setShotRequirementsOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectManagerRefreshing, setProjectManagerRefreshing] = useState(false);
  const {
    projectSwitcherOpen, setProjectSwitcherOpen,
    projectSwitcherQuery, setProjectSwitcherQuery, projectSwitcherRef,
    activeMenu, setActiveMenu, appMenuTriggerRef, appMenuCategoryRefs, appMenuPopoverRef,
    leftWidth, setLeftWidth, rightWidth, setRightWidth, timelineHeight, setTimelineHeight,
    leftPaneOpen, setLeftPaneOpen, rightPaneOpen, setRightPaneOpen,
    paneSettingsOpen, setPaneSettingsOpen, paneSettingsRef, beginResize,
    zoomPopOpen, setZoomPopOpen, zoomPopRef,
    volPopOpen, setVolPopOpen, volPopRef,
    ratePopOpen, setRatePopOpen, ratePopRef,
  } = useWorkspaceLayout();
  // C3：快捷键自定义（注册表 + localStorage 持久化 + 面板录制状态）。
  const [shortcuts, setShortcuts] = useState<Record<ShortcutCommandId, ShortcutEntry>>(() => loadShortcuts());
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [recordingId, setRecordingId] = useState<ShortcutCommandId | null>(null);
  const [previewZoom, setPreviewZoom] = useState<number | "fit">("fit");
  const [viewerView, setViewerView] = useState<ViewerView>(FIT_VIEW);
  const [zoomDrawn, setZoomDrawn] = useState(1);
  const [stageMarquee, setStageMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const frameRatioRef = useRef({ w: 16, h: 9 });
  const viewerViewRef = useRef(viewerView);
  viewerViewRef.current = viewerView;
  const previewPressRef = useRef<PreviewPress>(IDLE_PRESS);
  const previewClickGuardRef = useRef(false);
  const pressRafRef = useRef(0);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const stagePaneRef = useRef<HTMLElement | null>(null);
  const stageColumnRef = useRef<HTMLDivElement | null>(null);
  // 画面选中框：白色边框 + 8 向拖拽手柄（角等比 / 边单轴），缩放时随画面一起缩放。
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const selBoxRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null);
  const [selDimsText, setSelDimsText] = useState("");
  const selDragRef = useRef<{ dir: string; startX: number; startY: number; w: number; h: number; ratio: number } | null>(null);
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
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 草稿/revision 镜像 ref：定时器触发时读取最新事实，避免闭包捕获过期 base。
  const timelineRef = useRef(timeline);
  const projectRef = useRef(project);
  const pendingDraftRef = useRef<{ base: TimelineRevisionId; epoch: number; document: TimelineDocument } | null>(null);
  timelineRef.current = timeline;
  projectRef.current = project;
  const timelineLoadEpoch = useRef(0);
  // P195：「装载在途作废」的专用代次，与 timelineLoadEpoch（草稿/Revision 作废）
  // 故意分开：updated_at 会被改名/归档/重开等与时间线无关的写入推进
  // （projects.py 的 UPDATE projects），若共用代次，排队中的草稿会在这些
  // 时刻被当成"内容已取代"静默丢弃。
  const timelineFetchSeq = useRef(0);
  // resize 与 timelineHeight 跟随视口已拆入 hooks/useWorkspaceLayout.ts
  // A08：loadProjectData 摘要优先与请求代次/票据重试状态
  const projectDataEpochRef = useRef(0);
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
  /** S8：zRank 唯一来源 = working.tracks 数组索引（0=最上层），与 Core layers
   *  下层先画/上层后画的绘制序同源；绝不按 document.clips / order_index 取 z 序。 */
  const trackIndexByClipId = useMemo(() => {
    const tracks = working?.tracks ?? [];
    const rank = new Map(tracks.map((track, index) => [track.id, index]));
    return new Map((working?.clips ?? []).map(clip => [clip.clip_id, rank.get(clip.track_id) ?? tracks.length]));
  }, [working?.tracks, working?.clips]);
  // 时间线终点（所有片段最大 timeline_end）：播放到达即停，标尺停在末尾。
  const timelineEndUs = useMemo(() => sortedClips.reduce((max, c) => Math.max(max, c.timeline_end_us), 0), [sortedClips]);
  const tracksAtPlayhead = working?.tracks ?? [];
  const trackById = useMemo(() => new Map(tracksAtPlayhead.map(track => [track.id, track])), [tracksAtPlayhead]);
  // P231：全视觉轨片段（含 V1）用于粘贴位置序号（Q2 裁决：copy/cut/paste
  // 扩展到全视觉轨）。a1Clips 保留（音频轨独立语义）。
  const visualClips = useMemo(() => sortedClips.filter(c => {
    const track = trackById.get(c.track_id);
    return track?.kind === "video";
  }), [sortedClips, trackById]);
  const anySoloTrack = tracksAtPlayhead.some(track => track.solo);
  /** 轨道级声音开关：静音关闭；存在独奏轨道时仅独奏轨出声。 */
  const isClipAudible = useCallback((clip: TimelineClip) => {
    const track = trackById.get(clip.track_id);
    if (!track) return clip.audio.enabled;
    return clip.audio.enabled && !track.muted && (!anySoloTrack || track.solo);
  }, [trackById, anySoloTrack]);
  const {
    assets, setAssets, assetsRef, assetsMirrorTruncatedRef,
    assetQuery, setAssetQuery, assetFilter, setAssetFilter,
    libraryScope, changeLibraryScope, setAssetFavorites, favoriteAssetIds,
    assetView, changeAssetView, assetSortByName, setAssetSortByName,
    semanticAssetNames, visibleAssets, transcriptSummaries, setTranscriptSummaries,
    transcriptSummaryQueueRef, confirmModel, setConfirmModel,
    licenseAccepted, setLicenseAccepted, transcriptionAsset, setTranscriptionAsset,
    pendingDeleteAsset, setPendingDeleteAsset, visibleAssetOrder,
    selectedAssetIds, selectedAssetId, assetMenu, setAssetMenu, menuAsset,
    resetAssetSelection, selectAsset, setPickedAssetIds, deleteBusy, refreshingAssets,
    viewingTranscript, setViewingTranscript, language, setLanguage,
    wordTimestamps, setWordTimestamps, selectedSegments, setSelectedSegments,
    captionsOptimize, setCaptionsOptimize, pendingDeleteTranscript, setPendingDeleteTranscript,
    deleteTranscriptBusy, cvSummaries, cvBusy, cvOptionsOpen, setCvOptionsOpen,
    cvOptionsAsset, setCvOptionsAsset, cvTargetGapS, setCvTargetGapS,
    cvBudgetPerMin, setCvBudgetPerMin, cvSparkAssetId, cvSparkSamples,
    resetAssetLibraryOnSwitch, isDraggableAsset, adoptImportedAsset, dropAsset,
    insertSegments, importAsset, refreshAssets, deleteAsset, deleteTranscript,
    openDeleteTranscriptDialog, deleteJob, usedAssetIds, cvSummaryText, toggleCvSpark,
    revealAsset, originalShortEdge, assetDragProps, openModel, downloadModel, cancelModel,
    startTranscription, submitTranscription, retryTranscription, cancelJob,
    startCvAnalysis, submitCvOptions, viewTranscript,
    firstMediaAsset, loadedTranscript, transcriptRows,
  } = useAssetAndMediaLibrary({
    project,
    projectRef,
    projectDataEpochRef,
    timeline,
    working,
    models,
    setModels,
    setJobs,
    setSaveState,
    acceptState: state => acceptState(state),
    patchTimeline: (operations, summary, base) => patchTimeline(operations, summary, base),
    createTimeline: source => createTimeline(source),
    loadProjectData: selected => loadProjectData(selected),
    ensureFilmstripForAsset: assetId => ensureFilmstripForAsset(assetId),
    requestProxyJob: assetId => requestProxyJob(assetId),
    exitLibraryPreview: () => exitLibraryPreview(),
    showNotice: (text, tone) => showNotice(text, tone),
  });
  const {
    libraryPreviewId, setLibraryPreviewId,
    playbackSettings, setPlaybackSettings,
    proxyReadyEpoch,
    requestProxyJob, onDecodeBudget,
    playing, setPlaying,
    playhead, setPlayhead,
    playheadStore,
    previewMode, setPreviewMode,
    syntheticNotice, setSyntheticNotice,
    volume, setVolume, volumeRef,
    loopPlayback, setLoopPlayback,
    playbackRange, setPlaybackRange,
    uiRate, setUiRate,
    previewSessionRef, preparePreviewPlaybackRef,
    progressDragging, setProgressDragging,
    progressRef, volRailRef, pgBubbleRef, pgFillRef, tcTimeRef,
    videoRef, audioRef,
    resetPreviewOnProjectSwitch,
    clipAtPlayhead, audioClipAtPlayhead,
    previewAsset, mainTransformStyle, audioAsset,
    previewReverse, interactiveMediaRatePlayable,
    seenAnyTicketRef, loopSeekPending, cancelLoopRestart,
    meterLevels, visibleCaption, totalUs, previewFps, progressPct,
    togglePlayback, dispatchPlayhead, seekWhileScrubbing, commitScrub, seekFromUser, seekFromPlayback,
    handlePreviewEnded, handleVideoEnded,
    timelineAssetMedia, ensureFilmstripForAsset,
    syntheticMediaUrls, projectStateReady, previewSourceResolver,
    waveformCache, syntheticAudioByClip, syntheticPipClips,
    gestureHoldRef, pausePreviewPlayback, resumePreviewPlayback,
    previewFromLibrary, exitLibraryPreview,
    scrubFromProgress, seekFromProgressRatio, seekFromProgress, seekVolumeFrom,
  } = usePreviewPlayback({
    project,
    timeline,
    working,
    assets,
    jobs,
    sortedClips,
    trackById,
    timelineEndUs,
    isClipAudible,
    selectedCaption,
    setExportPlayback: value => setExportPlayback(value),
    loadProjectData: selected => loadProjectData(selected),
    showNotice: (text, tone) => showNotice(text, tone),
  });
  const {
    coverUrl, setCoverUrl, encoderMode, setEncoderMode,
    exportQuality, setExportQuality, exportResolution, setExportResolution,
    exportFrameRate, setExportFrameRate, exportDialogOpen, setExportDialogOpen,
    exportBusy, coverDialogOpen, setCoverDialogOpen,
    exports, setExports, exportPlayback, setExportPlayback,
    batchOpen, setBatchOpen, renderPanelOpen, setRenderPanelOpen, renderPanelOpenRef,
    platformPresets, renditionPresets, renditionTargets, setRenditionTargets,
    activeBatch, setActiveBatch, batchError, setBatchError,
    reframeSelections, reframePreviews, reframePending, reframePlayback, setReframePlayback,
    reframeDirectoryGrant, directoryGrant, activeReframeBatch, setActiveReframeBatch, reframeError, setReframeError,
    syntheticSnapshotRef, loadRenderData, resetRenderOnProjectSwitch, resetReframeOnProjectChange,
    removeMissingExport, captureCover, applyCover, trackRenderJob, generatePreview,
    openExportDialog, submitExport, targetPreview, openExportBatch, addTarget, updateTarget,
    generateRenditionPreview, chooseBatchDirectory, createBatch, retryBatchItems,
    reframeClips, targetAdjustments, selectReframeAnchor, generateReframePreview,
    chooseReframeDirectory, createReframeBatch, retryReframeBatchItems,
    authoritativePreview, previewIsStale, authoritativeMediaUrl, renderDisabledReason, renderActivity,
  } = useExportAndRender({
    project,
    projectRef,
    projectDataEpochRef,
    timeline,
    timelineRef,
    working,
    setJobs,
    jobs,
    previewMode,
    setPreviewMode,
    videoRef,
    getRenderRatio: () => renderRatio,
    showNotice: (text, tone) => showNotice(text, tone),
  });
  const {
    aiOpen, setAiOpen, aiStep, setAiStep, aiEgressConfirmed, setAiEgressConfirmed,
    aiError, setAiError, aiProviders, setAiProviders, aiRecipes, aiPreview, setAiPreview,
    aiCandidates, setAiCandidates, aiJob, setAiJob, aiCapabilityTesting,
    aiPlayback, setAiPlayback, aiForm, setAiForm,
    patchOpen, patchStep, setPatchStep, patchEgressConfirmed, setPatchEgressConfirmed,
    patchInstruction, patchProviderId, setPatchProviderId, patchProviders,
    patchPreview, setPatchPreview, patchProposal, patchJob, patchError,
    patchCapabilityTesting, setPatchInstruction,
    revisionOpen, setRevisionOpen, revisions, revisionPair, setRevisionPair,
    revisionDiff, setRevisionDiff, mergedProviders, resetAiOnProjectSwitch,
    openAi, prepareAi, createAi, testCandidateProviderCapability, playAiClip, adoptAi,
    closePatch, openPatch, preparePatch, testPatchProviderCapability,
    createPatch, cancelPatch, applyPatchProposal, openRevisionCompare, compareRevisions,
  } = useAiWorkflows({
    project,
    projectRef,
    projectDataEpochRef,
    timeline,
    setTimeline,
    setWorking,
    acceptState: state => acceptState(state),
    loadProjectData: selected => loadProjectData(selected),
    loadRenderData,
    trackRenderJob,
    showNotice: (text, tone) => showNotice(text, tone),
  });
  const {
    runtimeReady, resourceTier, forceCopyTo, loadProjectData,
    refreshProjects, switchProject, createProject,
    renameManagedProject, toggleManagedProjectArchive, refreshProjectManager,
    openProjects, closeProjectTab,
  } = useProjectLifecycle({
    projects,
    setProjects,
    project,
    setProject,
    projectRef,
    openProjectIds,
    setOpenProjectIds,
    newProject,
    setNewProject,
    newProjectRatio,
    setProjectDialogOpen,
    setProjectManagerRefreshing,
    setModels,
    jobs,
    setJobs,
    jobsRef,
    timelineRef,
    setTimeline,
    setWorking,
    setSelection,
    timelineLoadEpoch,
    timelineFetchSeq,
    projectDataEpochRef,
    assetsRef,
    assetsMirrorTruncatedRef,
    setAssets,
    setTranscriptSummaries,
    transcriptSummaryQueueRef,
    renderPanelOpenRef,
    setExports,
    loadRenderData,
    resetAiOnProjectSwitch,
    closePatch,
    setRevisionOpen,
    setRevisionDiff,
    resetRenderOnProjectSwitch,
    resetReframeOnProjectChange,
    resetAssetLibraryOnSwitch,
    resetPreviewOnProjectSwitch,
    showNotice: (text, tone) => showNotice(text, tone),
  });

  // 代次推进 + 装载代次一并推进：既作废排队中的草稿（patch 已涵盖其内容），
  // 也作废在途装载——否则一次在 patch 之前发出的 getTimeline 晚到，会把这
  // 刚被接受的新 Revision 回滚成它取到的旧 Revision。
  const acceptState = (next: TimelineState) => { timelineLoadEpoch.current += 1; timelineFetchSeq.current += 1; setTimeline(next); setWorking(next.current_revision.document); setSaveState("已保存"); setNotice(""); };
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
  /** 返回是否落库成功（S6 手势失败回滚用）；既有 void 调用方无需改动。 */
  const patchTimeline = async (operations: TimelinePatchOperation[], summary: string, base = timeline): Promise<boolean> => {
    if (!project || !base) return false;
    setSaveState("保存中");
    try {
      const next = await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: base.current_revision.timeline_revision_id, operations, summary } });
      if (projectRef.current?.project_id !== project.project_id) return false;
      // patch 已包含草稿内容：作废挂起草稿，防止用过期 base 触发 409。
      pendingDraftRef.current = null;
      if (draftTimer.current) clearTimeout(draftTimer.current);
      acceptState(next);
      setSaveState("已保存");
      return true;
    }
    catch (error) {
      if (projectRef.current?.project_id === project.project_id) await handleConflict(error);
      return false;
    }
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
    try {
      const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
      if (projectRef.current?.project_id !== project.project_id) return;
      acceptState(created);
      return created;
    } catch (error) {
      if (projectRef.current?.project_id === project.project_id) await handleConflict(error);
    }
  };
  // P1 画中画：交互预览画布上展示覆盖轨片段（V2+，轨道未隐藏）。
  // 播放头区间内的片段常驻；**被选中的覆盖轨片段无论播放头在哪都显示**——
  // 否则在时间线上选中片段调属性时，画布上没有盒子可看（"调了没效果"）。
  // 盒子尺寸 = 内容实际大小（素材等比适配进画布；剪映式选中框紧贴真实内容）。
  const overlayPips = useMemo<PipOverlay[]>(() => {
    if (previewMode !== "interactive" || !working) return [];
    const result: PipOverlay[] = [];
    // P231 Q2：全视觉轨片段均可选中上 PIP 手势层（不再排除 V1/A1——A1 音频仍排除）。
    const selectedOverlay = selectedClip && selectedClip.asset_kind !== "audio" && trackById.get(selectedClip.track_id)?.kind === "video" ? selectedClip : undefined;
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
    // P231 Q2：全视觉轨片段均可上 PIP 手势层（不再排除 V1/A1——A1 音频轨 kind=audio 已排除）。
    for (const track of tracksAtPlayhead) {
      if (track.kind !== "video" || track.hidden) continue;
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
  const commitPipTransform = (clipId: TimelineClip["clip_id"], transform: PipTransform): Promise<boolean> =>
    patchTimeline([{ op: "set_clip_transform", clip_id: clipId, transform }], "画中画画布局");
  /** 既有 props 契约是 Promise<void>；布尔结果只给手势回滚通道用。 */
  const patchTimelineVoid = async (operations: TimelinePatchOperation[], summary: string): Promise<void> => { await patchTimeline(operations, summary); };
  // P2 画布蒙版边界：draft 走本地文档，pointerup 提交 set_clip_mask（与属性面板同一 op）。
  const draftPipMask = (clipId: TimelineClip["clip_id"], mask: NonNullable<TimelineClip["mask"]>) => {
    setWorking(doc => doc ? { ...doc, clips: doc.clips.map(c => c.clip_id === clipId ? { ...c, mask } : c) } : doc);
  };
  const commitPipMask = (clipId: TimelineClip["clip_id"], mask: NonNullable<TimelineClip["mask"]>) => {
    void patchTimeline([{ op: "set_clip_mask", clip_id: clipId, mask }], "画中画蒙版");
  };
  const pipSelectedId = selectedClip?.clip_id ?? null;
  // P231 Q2：任意视觉轨片段选中时隐藏「画布尺寸框」（白框贴合整个画布，会盖过
  // 浮层自己的内容选中框）；浮层的选中框 + 8 向手柄由 PreviewPipOverlays 提供。
  // A1 音频片段不显示浮层盒子，保留画布尺寸框。
  const overlayClipSelected = Boolean(selectedClip && selectedClip.asset_kind !== "audio" && trackById.get(selectedClip.track_id)?.kind === "video");
  const showSelBox = !overlayClipSelected;
  const pipLocked = pipSelectedId ? Boolean(working?.locked_elements?.includes(pipSelectedId)) : false;
  // 应用内剪贴板（M2 A3）：复制 V1 视频片段快照，粘贴回放到播放头。
  const clipboardClips = useRef<Array<{ asset_id: AssetId; asset_kind: "video" | "image"; source_start_us: number | null; source_end_us: number | null; speed_milli: number; reverse_playback: boolean; layout: TimelineLayout }>>([]);
  const insertableClipboardAssets = (snapshots: typeof clipboardClips.current) => snapshots.filter(item => {
    const asset = assets.find(candidate => candidate.asset.asset_id === item.asset_id);
    return Boolean(asset && (item.asset_kind === "image" || asset.asset.availability === "available"));
  });
  const assetThumb = (item: AssetPresentation) => (
    <span className="asset-thumb">
      {item.asset.kind === "image"
        ? <img src={item.media_url ?? undefined} alt="" loading="lazy" />
        : item.asset.kind === "video"
          ? <video src={item.media_url ?? undefined} muted preload="metadata" aria-hidden="true" />
          : item.asset.kind === "audio"
            ? <AudioLines className="asset-thumb-icon" aria-hidden="true" />
            : <FileText className="asset-thumb-icon" aria-hidden="true" />}
      {/* 仅异常态显示角标（缺失/已变更/不支持）；可用是常态，不占视觉。 */}
      {item.asset.availability !== "available" && <span className={`availability ${item.asset.availability}`}>{availabilityLabels[item.asset.availability]}</span>}
    </span>
  );
  const assetActionItems = (item: AssetPresentation) => {
    const { asset } = item;
    const actions: (ContextMenuItem & { onSelect: () => void })[] = [{
      id: "preview", label: `预览播放 ${asset.display_name}`, icon: <Play size={13} />,
      disabled: asset.availability !== "available" || !item.media_url,
      onSelect: () => previewFromLibrary(item)
    }];
    if (isTranscribable(asset)) {
      actions.push({ id: "transcribe", label: "转录", icon: <FileText size={13} />, onSelect: () => startTranscription(asset) });
    }
    if (asset.kind === "video" && asset.availability === "available") {
      actions.push(
        { id: "edit", label: "剪辑手法", icon: <Scissors size={13} />, disabled: cvBusy !== null, onSelect: () => openEditingTools("remove_pauses") },
        {
          id: "analyze", label: "AI 信号分析", icon: <Sparkles size={13} />, disabled: cvBusy !== null,
          onSelect: () => { setCvOptionsAsset(item); setCvOptionsOpen(true); setCvTargetGapS(""); setCvBudgetPerMin(""); }
        }
      );
    }
    actions.push(
      { id: "favorite", label: favoriteAssetIds.has(asset.asset_id) ? "取消收藏" : "收藏素材", icon: <Star size={13} />,
        onSelect: () => setAssetFavorites(ids => ids.includes(asset.asset_id) ? ids.filter(id => id !== asset.asset_id) : [...ids, asset.asset_id]) },
      { id: "reveal", label: `打开 ${asset.display_name} 所在文件夹`, icon: <FolderOpen size={13} />, onSelect: () => void revealAsset(asset) },
      { id: "delete", label: `删除 ${asset.display_name}`, icon: <Trash2 size={13} />, danger: true, onSelect: () => setPendingDeleteAsset(asset) }
    );
    return actions;
  };
  // 点击预览画面：选中播放头处的片段（剪映式选中），无片段时清空选择。
  // P231 修复：合成模式由 sp-layer 的 S3/S4 状态机全权负责选择（盒子点击选盒、
  // 空白 release 清选/框选）——这里的 onClick 只服务 interactive 模式，
  // 否则空白点击的清选会被冒泡 click 立即用「播放头片段」覆盖回去。
  const selectClipAtPlayhead = () => {
    if (previewMode === "synthetic") return;
    // S4：release 已判定过 click/marquee，pointerup 后浏览器补发的 click 不得覆盖。
    if (previewClickGuardRef.current) { previewClickGuardRef.current = false; return; }
    exitLibraryPreview();
    setSelection(clipAtPlayhead ? { kind: "clip", id: clipAtPlayhead.clip_id } : null);
  };
  const previewSelected = Boolean(selectedClip && !libraryPreviewId);
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
  // 比例语义（2026-11-18 用户裁决，推翻 P231 Q1 的「跟随素材原画」）：
  // - 选具体比例码 → 渲染画幅 = 该比例（权威预览/导出/合成预览同步切换）。
  // - 「原始」→ 渲染画幅 = **16:9 恒定**（同类型软件的「原始」即 16:9）。
  //   黑框（预览画布）比例 = 渲染画幅，二者永不分叉——黑色区域整体就是
  //   排版/裁剪范围，不再出现内容 letterbox 死区。
  const renderRatio: OutputRatio = effectiveRatio === "fit" ? "169" : effectiveRatio;
  // 「原始」显示模式：预览框按渲染画幅比例约束（恒 16:9），画布内容
  // 等比 contain 居中；选具体比例 = 显式切换渲染画幅并按该比例约束预览框。
  const previewClass = `ratio-${renderRatio}`;
  frameRatioRef.current = renderRatio === "916" || renderRatio === "34" ? { w: 9, h: 16 }
    : renderRatio === "11" ? { w: 1, h: 1 }
      : renderRatio === "43" ? { w: 4, h: 3 }
        : { w: 16, h: 9 };
  const framePixelSizeRef = useRef({ w: 1920, h: 1080 });
  framePixelSizeRef.current = {
    w: Math.max(1, working?.canvas.width ?? project?.canvas.width ?? 1920),
    h: Math.max(1, working?.canvas.height ?? project?.canvas.height ?? 1080),
  };
  // 时间码帧率：优先画布帧率，缺省 30fps。
  // 比例切换（剪映式）：选具体比例时**全视觉轨**布局切为 crop_fill（裁切填满——
  // 等比放大到短边顶满、长边溢出裁剪，剪映同款默认，P231 Q3 裁决：全轨一致）；
  // blurred_background 模糊垫底是竖版包装风格，不随比例切换自动套用。切回"原始"
  // 不动时间线布局。
  const changePreviewRatio = (value: string) => {
    setPreviewRatio(value);
    setPreviewRatioTouched(true);
    setCanvasSize(null);
    if (canvasRef.current) { canvasRef.current.style.width = ""; canvasRef.current.style.height = ""; }
    if (value !== "fit" && working) {
      const layoutOps = working.clips
        .filter(clip => clip.layout === "blurred_background" && (clip.asset_kind === "video" || clip.asset_kind === "image") && trackById.get(clip.track_id)?.kind === "video")
        .map(clip => ({ op: "set_layout" as const, clip_id: clip.clip_id, layout: "crop_fill" as const }));
      if (layoutOps.length > 0) void patchTimeline(layoutOps, "切换比例：全视觉轨裁切填满");
    }
  };
  // 预览缩放（剪映式）：点击缩放按钮弹出滑条，对数刻度 25%–500%，缩小时以画面中心整体缩小。
  const zoomT = (z: number) => Math.round(Math.log(z / 0.25) / Math.log(20) * 1000);
  const zoomZ = (t: number) => 0.25 * Math.exp(Math.log(20) * t / 1000);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stagePaneRef.current?.requestFullscreen();
    } catch { showNotice("进入全屏失败。", "warning"); }
  };
  useEffect(() => { setGenerationOpen(false); setShotRequirementsOpen(false); setCoverUrl(project?.project_id ? localStorage.getItem(`vortex-cut.cover.${project.project_id}`) : null); }, [project?.project_id]);

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
      case "timeline.split": if (!selectedClips.length) return "请先选择时间线片段"; return splitSelectionAt(selectedClips, playheadStore.get(), working).length ? undefined : "请把播放头移到可拆分的选中视频片段内";
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
      case "timeline.split": {
        const operations = splitSelectionAt(selectedClips, playheadStore.get(), working);
        if (operations.length) void patchTimeline(operations, "在播放头处拆分");
        break;
      }
      case "timeline.copy": {
        // P231 Q2：复制扩展到全视觉轨（不再限定 V1）。
        const snapshot = selectedClips
          .filter(item => (item.asset_kind === "video" || item.asset_kind === "image") && trackById.get(item.track_id)?.kind === "video")
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
        if (selectedClips.some(item => item.link_group_id)) {
          showNotice("链接片段暂不支持剪切粘贴，请先取消链接。", "info");
          break;
        }
        // 复用复制快照逻辑后按删除路径移除（撤销可恢复）。
        // P231 Q2：剪切扩展到全视觉轨（不再限定 V1）。
        const snapshot = selectedClips
          .filter(item => (item.asset_kind === "video" || item.asset_kind === "image") && trackById.get(item.track_id)?.kind === "video" && !working?.locked_elements?.includes(item.clip_id))
          .map(item => ({
            asset_id: item.asset_id,
            asset_kind: item.asset_kind as "video" | "image",
            source_start_us: item.source_start_us,
            source_end_us: item.source_end_us,
            speed_milli: item.speed_milli ?? 1000,
            reverse_playback: item.reverse_playback ?? false,
            layout: item.layout,
          }));
        const prefs = readTimelineBehaviorPrefs();
        const cutPlan = prefs.mainTrackMagnet && working && selectedClips.some(clip => clip.track_id === "V1")
          ? planMagneticDelete(working, selectedClips, prefs.linkageEnabled)
          : { operations: removeLinkedClips(selectedClips, working) };
        const deletable = cutPlan.operations;
        if (!deletable.length) { if (cutPlan.reason) showNotice(cutPlan.reason, "info"); break; }
        clipboardClips.current = snapshot;
        void patchTimeline(deletable, prefs.mainTrackMagnet ? "主轨磁吸剪切" : "剪切片段").then(() => showNotice(`已剪切 ${deletable.length} 组片段（Ctrl+V 粘贴）。`));
        break;
      }
      case "timeline.paste": {
        const insertable = insertableClipboardAssets(clipboardClips.current);
        if (!project || !timeline || !insertable.length) return;
        // 粘贴位置：播放头处片段的 V1 序号（无片段则取播放头前序，末端追加为兜底）。
        const pasteIndex = (() => {
          // P231 Q2：粘贴位置按全视觉轨序号（不再限定 V1）。
          const atHead = visualClips.findIndex(c => playhead >= c.timeline_start_us && playhead < c.timeline_end_us);
          if (atHead >= 0) return atHead + 1;
          const before = visualClips.filter(c => c.timeline_end_us <= playhead).length;
          return Math.min(before, visualClips.length);
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
          const prefs = readTimelineBehaviorPrefs();
          const plan = prefs.mainTrackMagnet && working && selectedClips.some(clip => clip.track_id === "V1")
            ? planMagneticDelete(working, selectedClips, prefs.linkageEnabled)
            : { operations: removeLinkedClips(selectedClips, working) };
          if (plan.operations.length > 0) void patchTimeline(plan.operations, prefs.mainTrackMagnet ? "主轨磁吸删除" : "删除片段");
          else if (plan.reason) showNotice(plan.reason, "info");
        }
        break;
      case "preview.generate": void generatePreview(); break;
      case "export.open": setRenderPanelOpen(true); break;
      case "ai.open": void openAi(); break;
      case "ai.revise": void openPatch(); break;
      case "project.manage": setProjectDialogOpen(true); break;
      case "project.refresh": void refreshProjects(); break;
      case "timeline.create": void createTimeline({ kind: "empty" }); break;
      case "ui.resetLayout": setLeftWidth(320); setRightWidth(300); setTimelineHeight(230); break;
      case "ui.shortcuts": setShortcutsOpen(true); break;
      case "tools.compare": void openRevisionCompare(); break;
      case "tools.shots": setShotRequirementsOpen(true); break;
      case "tools.verify": setGenerationOpen(true); break;
      case "tools.imageGen": setProviderImageGenerationOpen(true); break;
      case "help.manual": showNotice("请查看 docs/requirements/VORTEX_CUT_USER_MANUAL.md", "info"); break;
      case "command.search": setCommandSearchOpen(true); break;
    }
  };

  const closeCommandSearch = () => { setCommandSearchOpen(false); setCommandQuery(""); setCommandIndex(0); };

  // 共享 Dialog 自带关闭钮且会聚焦第一个可聚焦元素；命令搜索必须落在输入框上，
  // 否则 ↑↓/Enter 会作用在关闭钮上（Enter 变成关闭而不是执行选中命令）。
  useEffect(() => { if (commandSearchOpen) commandSearchInputRef.current?.focus(); }, [commandSearchOpen]);
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
    if (!(event.ctrlKey || event.metaKey) && (key === "backspace" || key === "delete") && inTimeline) {
      event.preventDefault();
      if (event.shiftKey && working) {
        const plan = planRippleDelete(working, selectedClips, readTimelineBehaviorPrefs().linkageEnabled);
        if (plan.operations.length) void patchTimeline(plan.operations, "波纹删除");
        else if (plan.reason) showNotice(plan.reason, "info");
      } else runCommand("timeline.delete");
      return;
    }
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
      const availW = Math.max(1, isFs ? window.innerWidth - 24 : host.clientWidth - 24);
      const availH = Math.max(1, isFs ? window.innerHeight - 24 - 40 - 40 - 16 : host.clientHeight - 24 - 40 - 40 - 16);
      // Keep the player inside the available viewport even when the app is narrower/shorter than 320px.
      const w = Math.min(availW, availH * 16 / 9);
      el.style.width = `${w}px`;
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(pane);
    window.addEventListener("resize", layout);
    document.addEventListener("fullscreenchange", layout);
    return () => { ro.disconnect(); window.removeEventListener("resize", layout); document.removeEventListener("fullscreenchange", layout); };
  }, []);
  // S1/S2：预览缩放 = 布局尺寸（不用 transform:scale，手柄恒为屏幕 px）。
  const zoomZValue = previewZoom === "fit" ? viewerView.z : (typeof previewZoom === "number" ? previewZoom : viewerView.z);
  useEffect(() => {
    const el = previewFrameRef.current;
    if (!el) return;
    const coalescer = createWheelCoalescer(
      fn => requestAnimationFrame(fn),
      id => cancelAnimationFrame(id),
      (factor, dx, dy, anchor) => {
        const viewer = { w: el.clientWidth || 1, h: el.clientHeight || 1 };
        const fitted = fittedSize(viewer, frameRatioRef.current);
        let next = viewerViewRef.current;
        if (factor !== 1) next = zoomAt(next, factor, anchor, viewer, fitted, zoomMax(fitted.w / framePixelSizeRef.current.w));
        if (dx || dy) next = panBy(next, dx, dy, fitted);
        if (next !== viewerViewRef.current) { viewerViewRef.current = next; setViewerView(next); setPreviewZoom(next.z); }
      },
    );
    let stopPan = () => {};
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        // Prevent the browser page zoom; this gesture belongs to the preview canvas.
        event.preventDefault();
        if (event.buttons) return;
        const rect = el.getBoundingClientRect();
        coalescer.pushZoom(wheelZoomFactor(wheelPx(event, event.deltaY)), { x: event.clientX - rect.left, y: event.clientY - rect.top });
        return;
      }
      // OpenFilm pans the picture with the ordinary wheel only after it has been enlarged.
      if (isFit(viewerViewRef.current)) return;
      event.preventDefault();
      if (event.buttons) return;
      const sideways = event.shiftKey && !event.deltaX;
      coalescer.pushPan(wheelPx(event, sideways ? event.deltaY : event.deltaX), sideways ? 0 : wheelPx(event, event.deltaY));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 1 || isFit(viewerViewRef.current)) return;
      event.preventDefault();
      event.stopPropagation();
      el.dataset.panActive = "true";
      let last = { x: event.clientX, y: event.clientY };
      const move = (next: PointerEvent) => {
        coalescer.pushPan(last.x - next.clientX, last.y - next.clientY);
        last = { x: next.clientX, y: next.clientY };
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        el.removeAttribute("data-pan-active");
        stopPan = () => {};
      };
      stopPan = cleanup;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      stopPan();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown, true);
      coalescer.dispose();
    };
  }, []);
  /** 缩放静止 ZOOM_SETTLE_MS 后同步一次 DOM 几何；SyntheticPreview 的
   *  ResizeObserver 随后按稳定后的容器尺寸重排合成缓冲并恢复暂停帧。 */
  const zoomSettleRef = useRef(createZoomSettle(
    ZOOM_SETTLE_MS,
    (fn, ms) => window.setTimeout(fn, ms),
    id => clearTimeout(id),
    () => {
      // 触发一次布局同步；画面尺寸由 SyntheticPreview 的观察器统一处理，
      // 避免这里与窗口尺寸变化路径重复 resize/seek。
      setZoomDrawn(value => value + 1);
    },
  ));
  useEffect(() => {
    // 初始 fitted 视图无需重绘；只有真实缩放变化才排队。
    if (zoomZValue === 1 && previewZoom === "fit") return;
    zoomSettleRef.current.schedule();
    return () => zoomSettleRef.current.dispose();
  }, [zoomZValue, previewZoom]);
  /** 布局尺寸：显式 width/height（不是 transform）。
   *  P231 比例守恒：黑框（.preview-canvas）尺寸恒 = fittedSize(viewer, 比例)——
   *  「原始/具体比例」时也精确按容器内最大等比尺寸摆放，不再交给 CSS
   *  aspect-ratio 兜底（height:100% 曾把 16:9 拉成容器形状，width:auto
   *  又塌回 canvas intrinsic 300×150，两条路都实测失败）。
   *  缩放（滚轮/滑条）= 在 fitted 基础上乘 viewerView.z，仍由布局尺寸表达。 */
  useEffect(() => {
    const el = previewFrameRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    const sync = () => {
      const viewer = { w: el.clientWidth || 1, h: el.clientHeight || 1 };
      const fitted = fittedSize(viewer, frameRatioRef.current);
      const layout = zoomLayout(viewerViewRef.current, fitted, viewer);
      const fit = isFit(viewerViewRef.current);
      canvas.style.position = fit ? "relative" : "absolute";
      canvas.style.left = fit ? "" : `${layout.x}px`;
      canvas.style.top = fit ? "" : `${layout.y}px`;
      canvas.style.width = `${layout.w}px`;
      canvas.style.height = `${layout.h}px`;
      const nextSize = { w: Math.round(layout.w), h: Math.round(layout.h) };
      setCanvasSize(previous => previous?.w === nextSize.w && previous.h === nextSize.h ? previous : nextSize);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener("resize", sync);
    return () => { observer.disconnect(); window.removeEventListener("resize", sync); };
  }, [viewerView, previewZoom, previewClass, zoomDrawn]);
  /** S4：空白按下 → rAF move → release 判定 click/marquee；绝不定位播放头。 */
  const stageBoxesForPress = useCallback((): HitBox[] => {
    if (previewMode === "synthetic") return [];
    return overlayPips.map((item, index) => ({
      clipId: item.clip.clip_id,
      x: (item.clip.transform?.x ?? 0.5) * (canvasSize?.w ?? 0) - item.fit_w * (item.clip.transform?.scale ?? 1) / 2,
      y: (item.clip.transform?.y ?? 0.5) * (canvasSize?.h ?? 0) - item.fit_h * (item.clip.transform?.scale ?? 1) / 2,
      w: item.fit_w * (item.clip.transform?.scale ?? 1),
      h: item.fit_h * (item.clip.transform?.scale ?? 1),
      rotate: item.clip.transform?.rotate ?? 0,
      renderOrder: index,
    }));
  }, [previewMode, overlayPips, canvasSize]);
  const rankForPress = useCallback((box: HitBox) => {
    const clip = (working?.clips ?? []).find(item => item.clip_id === box.clipId);
    return clip ? tracksAtPlayhead.findIndex(track => track.id === clip.track_id) : tracksAtPlayhead.length;
  }, [working?.clips, tracksAtPlayhead]);
  const onPreviewPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // 合成层自有 S3/S4 命中状态机；此处只处理 interactive 空白画布。
    // target 排除只挡「盒子/手柄自身」的按下（它们有自己的 begin/beginSelDrag）——
    // 黑区在 .preview-canvas 子层上，target !== currentTarget 若一刀切，
    // interactive 的框选/清选在黑区永远不触发（S4 语义缺口，实测）。
    if (previewMode === "synthetic") return;
    const onInteractiveOverlay = (event.target as HTMLElement).closest(".pip-overlay, .sel-box");
    if (onInteractiveOverlay) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = canvasRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const boxes = stageBoxesForPress();
    const hit = pickTopmostBox(boxes, point, rankForPress);
    previewPressRef.current = reducePreviewPress(IDLE_PRESS, { type: "down", x: point.x, y: point.y, additive: event.shiftKey || event.metaKey || event.ctrlKey, hitClipId: hit?.clipId ?? null }).state;
  };
  const onPreviewPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (previewPressRef.current.phase !== "press") return;
    const canvasRect = canvasRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    const frameRect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - canvasRect.left, y = event.clientY - canvasRect.top;
    const result = reducePreviewPress(previewPressRef.current, { type: "move", x, y });
    previewPressRef.current = result.state;
    if (pressRafRef.current) cancelAnimationFrame(pressRafRef.current);
    pressRafRef.current = requestAnimationFrame(() => {
      pressRafRef.current = 0;
      setStageMarquee(result.marquee ? {
        x: result.marquee.x + canvasRect.left - frameRect.left,
        y: result.marquee.y + canvasRect.top - frameRect.top,
        w: result.marquee.w,
        h: result.marquee.h,
      } : null);
    });
  };
  const onPreviewPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (previewPressRef.current.phase !== "press") return;
    const rect = canvasRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    const result = reducePreviewPress(previewPressRef.current, { type: "up", x: event.clientX - rect.left, y: event.clientY - rect.top });
    previewPressRef.current = IDLE_PRESS;
    previewClickGuardRef.current = true;
    setStageMarquee(null);
    if (!result.outcome) return;
    const ids = selectionFromOutcome(result.outcome, stageBoxesForPress(), rankForPress, selectedClipIds);
    if (result.outcome.kind === "marquee") setSelection(ids.length ? { kind: "clips", ids } : null);
    else if (ids.length === 1) setSelection({ kind: "clip", id: ids[0] });
    else setSelection(null);
  };
  // 画面选中框：8 向手柄拖拽改画面大小（角 = 等比保持比例，边 = 单轴）；布局尺寸缩放。
  const selZoomFactor = 1;
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

  const COMMAND_ICON_MAP: Record<string, LucideIcon> = {
    "play.pause": Play, "timeline.undo": Undo2, "timeline.redo": Redo2,
    "timeline.split": Scissors, "timeline.copy": FileText, "timeline.cut": Scissors,
    "timeline.paste": Download, "timeline.delete": Trash2, "timeline.create": SquarePlus,
    "preview.generate": MonitorPlay, "export.open": Upload, "ai.open": Sparkles,
    "ai.revise": WandSparkles, "project.manage": FolderCog, "project.refresh": RefreshCw,
    "ui.resetLayout": LayoutPanelLeft, "ui.shortcuts": Keyboard, "tools.compare": GitCompare,
    "tools.shots": Clapperboard, "tools.verify": FlaskConical, "tools.imageGen": ImageIcon,
    "help.manual": BookOpen, "command.search": CommandIcon,
  };

  const menuItems: Record<string, MenuEntry[]> = {
    项目: [{ label: "项目管理", icon: FolderCog, action: () => setProjectDialogOpen(true) }, { label: "刷新项目", icon: RefreshCw, action: () => void refreshProjects() }],
    编辑: [{ label: "撤销", icon: Undo2, action: () => void undoRedo("undo"), disabled: Boolean(commandDisabledReason("timeline.undo")) }, { label: "重做", icon: Redo2, action: () => void undoRedo("redo"), disabled: Boolean(commandDisabledReason("timeline.redo")) }],
    时间线: [{ label: "创建空时间线", icon: SquarePlus, action: () => void createTimeline({ kind: "empty" }), disabled: Boolean(commandDisabledReason("timeline.create")) }, { divider: true }, { label: "拆分所选片段", icon: Scissors, action: () => runCommand("timeline.split"), disabled: Boolean(commandDisabledReason("timeline.split")) }, { label: "生成预览", icon: MonitorPlay, action: () => runCommand("preview.generate"), disabled: Boolean(commandDisabledReason("preview.generate")) }, { label: "导出", icon: Upload, action: () => runCommand("export.open"), disabled: Boolean(commandDisabledReason("export.open")) }],
    界面: [{ label: "恢复默认布局", icon: LayoutPanelLeft, action: () => { setLeftWidth(320); setRightWidth(300); setTimelineHeight(230); } }, { label: "命令搜索", icon: CommandIcon, action: () => setCommandSearchOpen(true) }, { label: "快捷键设置", icon: Keyboard, action: () => setShortcutsOpen(true) }],
    工具: [{ group: "AI" }, { label: "Provider 设置", icon: FolderCog, action: () => setProviderSettingsOpen(true) }, { label: "AI 助手", icon: WandSparkles, action: () => setAgentOpen(true), disabled: !project }, { label: "AI 工作单", icon: WandSparkles, action: () => setWorklistOpen(true), disabled: !project }, { label: "AI 粗剪", icon: Sparkles, action: () => void openAi(), disabled: Boolean(commandDisabledReason("ai.open")) }, { label: "AI 修改", icon: WandSparkles, action: () => void openPatch(), disabled: Boolean(commandDisabledReason("ai.revise")) }, { label: "剪辑手法", icon: Scissors, action: () => openEditingTools("remove_pauses"), disabled: !project }, { label: "机位同步", icon: Video, action: () => setAngleSyncOpen(true), disabled: !project }, { label: "素材语义检索", icon: Search, action: () => setSemanticSearchOpen(true), disabled: !project }, { label: "关键帧外传审阅", icon: ImageIcon, action: () => setKeyframeReviewOpen(true), disabled: !project || !selectedAssetId }, { label: "剪辑语法（高级）", icon: Scissors, action: () => { setEditingToolsTool(null); setEditingGrammarOpen(true); }, disabled: !project }, { label: "版本比较", icon: GitCompare, action: () => void openRevisionCompare(), disabled: Boolean(commandDisabledReason("tools.compare")) }, { divider: true }, { label: "镜头需求", icon: Clapperboard, action: () => setShotRequirementsOpen(true), disabled: Boolean(commandDisabledReason("tools.shots")) }, { label: "生成验证（模拟）", icon: FlaskConical, action: () => setGenerationOpen(true), disabled: Boolean(commandDisabledReason("tools.verify")) }, { label: "真实图片生成", icon: ImageIcon, action: () => setProviderImageGenerationOpen(true), disabled: Boolean(commandDisabledReason("tools.imageGen")) }],
    帮助: [{ label: "用户使用手册", icon: BookOpen, action: () => showNotice("请查看 docs/requirements/VORTEX_CUT_USER_MANUAL.md", "info") }]
  };
  const menuCategories = Object.keys(menuItems);
  const openBrandMenu = () => {
    if (activeMenu) { setActiveMenu(null); return; }
    setActiveMenu(menuCategories[0] ?? null);
    requestAnimationFrame(() => appMenuCategoryRefs.current[0]?.focus({ preventScroll: true }));
  };
  const handleMenuCategoryKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = Math.max(0, menuCategories.indexOf(activeMenu ?? menuCategories[0] ?? ""));
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); setActiveMenu(null);
      appMenuTriggerRef.current?.focus({ preventScroll: true });
    } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? menuCategories.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + menuCategories.length) % menuCategories.length;
      setActiveMenu(menuCategories[next]);
      requestAnimationFrame(() => appMenuCategoryRefs.current[next]?.focus({ preventScroll: true }));
    } else if (event.key === "ArrowRight") {
      event.preventDefault(); event.stopPropagation();
      appMenuPopoverRef.current?.querySelector<HTMLButtonElement>("[role='tabpanel'] [role='menuitem']:not(:disabled)")?.focus({ preventScroll: true });
    }
  };
  const handleMenuActionsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const actions = Array.from(appMenuPopoverRef.current?.querySelectorAll<HTMLButtonElement>("[role='tabpanel'] [role='menuitem']:not(:disabled)") ?? []);
    const current = actions.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); setActiveMenu(null);
      appMenuTriggerRef.current?.focus({ preventScroll: true });
    } else if (event.key === "ArrowLeft") {
      event.preventDefault(); event.stopPropagation();
      appMenuCategoryRefs.current[menuCategories.indexOf(activeMenu ?? "")]?.focus({ preventScroll: true });
    } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) && actions.length) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? actions.length - 1
        : (Math.max(0, current) + (event.key === "ArrowDown" ? 1 : -1) + actions.length) % actions.length;
      actions[next]?.focus({ preventScroll: true });
    }
  };
  const alignmentCanvas = working && alignmentPreviewSize[renderRatio];
  const alignmentSubjects = alignmentCanvas ? selectedClips.flatMap(clip => {
    const source = assets.find(({ asset }) => asset.asset_id === clip.asset_id)?.asset;
    const box = alignmentBox(clip, source, alignmentCanvas);
    return box ? [{ clip, box }] : [];
  }) : [];
  const alignmentHint = selectedClips.some(clip => clip.asset_kind === "audio")
    ? "仅支持视频和图片片段对齐。"
    : selectedClips.some(clip => working?.locked_elements?.includes(clip.clip_id) || trackById.get(clip.track_id)?.locked)
      ? "选中片段或所在轨道已锁定。"
      : selectedClips.some(clip => clip.keyframes?.position || clip.keyframes?.scale || clip.keyframes?.rotate)
        ? "带位置、缩放或旋转关键帧的片段暂不支持静态对齐。"
        : alignmentSubjects.length !== selectedClips.length ? "素材尺寸尚未就绪。" : undefined;
  const visualSelectedCount = selectedClips.filter(clip => clip.asset_kind !== "audio").length;
  const alignSelectedFrames = (edge: AlignEdge) => {
    if (!alignmentCanvas || alignmentHint) return;
    const operations = planFrameAlignment(edge, alignmentCanvas, alignmentSubjects);
    if (operations === null || operations.length > 100) {
      showNotice("这组片段无法一次对齐，请调整缩放或减少选择。", "warning");
    } else if (operations.length) {
      void patchTimeline(operations, alignmentSubjects.length === 1 ? "对齐到画布" : "对齐选中片段");
    }
  };
  const distributeSelectedFrames = (axis: AlignDistribution) => {
    if (!alignmentCanvas || alignmentHint || visualSelectedCount < 3) return;
    const operations = planFrameDistribution(axis, alignmentCanvas, alignmentSubjects);
    if (operations === null || operations.length > 100) {
      showNotice("这组片段无法一次等距分布，请调整缩放或减少选择。", "warning");
    } else if (operations.length) {
      void patchTimeline(operations, axis === "horizontal" ? "水平等距分布选中片段" : "垂直等距分布选中片段");
    }
  };
  const selectionBounds = alignmentCanvas && !alignmentHint ? groupFrameBounds(alignmentSubjects) : null;
  const groupBounds = alignmentCanvas && selectionBounds
    ? { ...selectionBounds, canvasWidth: alignmentCanvas.width, canvasHeight: alignmentCanvas.height }
    : undefined;
  const editGroupBounds = (field: GroupBoundsField, value: number) => {
    if (!alignmentCanvas || !groupBounds) return;
    const operations = planGroupBoundsEdit(field, value, alignmentCanvas, alignmentSubjects);
    if (!operations || operations.length > 100) {
      showNotice("选区超出可用的移动或缩放范围，请调整数值或减少选择。", "warning");
    } else if (operations.length) {
      void patchTimeline(operations, field === "x" || field === "y" ? "移动选中画面" : "等比缩放选中画面");
    }
  };

  return <main className="editor-shell" style={{ "--left-width": `${leftWidth}px`, "--right-width": `${rightWidth}px`, "--timeline-height": `${timelineHeight}px` } as React.CSSProperties} onClick={() => activeMenu && setActiveMenu(null)}>
    <div className="editor-titlebar">
      <div className="custom-titlebar-drag">
        <div className="brand-lockup" title="Vortex Cut">
          <div className="brand-menu-anchor">
            <button ref={appMenuTriggerRef} type="button" className="brand-menu-trigger" aria-label="Vortex Cut 主菜单" aria-haspopup="dialog" aria-expanded={Boolean(activeMenu)} aria-controls={activeMenu ? "brand-menu-popover" : undefined} title="主菜单" onClick={event => { event.stopPropagation(); openBrandMenu(); }}>
              <span className="brand-mark"><img src="./icons/256.png" alt="" /></span>
            </button>
            {activeMenu && <div ref={appMenuPopoverRef} id="brand-menu-popover" className="brand-menu-popover" role="dialog" aria-label="Vortex Cut 主菜单" onClick={event => event.stopPropagation()} onBlur={event => {
              const next = event.relatedTarget as Node | null;
              if (next && !appMenuPopoverRef.current?.contains(next) && !appMenuTriggerRef.current?.contains(next)) setActiveMenu(null);
            }}>
              <div className="brand-menu-categories" role="tablist" aria-label="主菜单分类" onKeyDown={handleMenuCategoryKeyDown}>
                {menuCategories.map((menu, menuPosition) => <button ref={element => { appMenuCategoryRefs.current[menuPosition] = element; }} key={menu} type="button" role="tab" id={`brand-menu-tab-${menu}`} aria-selected={activeMenu === menu} aria-controls="brand-menu-actions" tabIndex={activeMenu === menu ? 0 : -1} className={activeMenu === menu ? "active" : ""} onMouseEnter={() => setActiveMenu(menu)} onClick={() => setActiveMenu(menu)}>{menu}<ChevronRight size={13} aria-hidden="true" /></button>)}
              </div>
              <section className="brand-menu-content" role="tabpanel" id="brand-menu-actions" aria-labelledby={`brand-menu-tab-${activeMenu}`}>
                <h2>{activeMenu}</h2>
                <div className="menu-dropdown brand-menu-actions" role="menu" aria-label={`${activeMenu}菜单`} onKeyDown={handleMenuActionsKeyDown}>
                  {menuItems[activeMenu].map((item, entryIndex) => {
                    if (isMenuDivider(item)) return <div key={`divider-${entryIndex}`} className="menu-divider" role="separator" />;
                    if (isMenuGroup(item)) return <div key={`group-${entryIndex}`} className="menu-group-label">{item.group}</div>;
                    return <button key={item.label} type="button" role="menuitem" disabled={item.disabled} onClick={() => { item.action(); setActiveMenu(null); }}><span className="menu-item-ico">{item.icon && <item.icon size={14} aria-hidden="true" />}</span><span className="menu-item-label">{item.label}</span>{menuShortcut(item.label) && <kbd className="menu-item-shortcut">{menuShortcut(item.label)}</kbd>}</button>;
                  })}
                </div>
              </section>
            </div>}
          </div>
          <strong>Vortex Cut</strong>
        </div>
        <ProjectTabStrip projects={openProjects} current={project} onSelect={switchProject} onClose={closeProjectTab}
          onNew={() => setProjectDialogOpen(true)} />
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
    <div className={`editor-workspace${leftPaneOpen ? "" : " library-closed"}`}>
      <section className={"library-pane" + (leftPaneOpen ? "" : " pane-closed")} aria-label="媒体库" hidden={!leftPaneOpen}>
        <div className="left-seg" role="tablist" aria-label="工作区分区">
          <button role="tab" aria-selected={tab === "assets"} className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}><Clapperboard size={15} aria-hidden="true" />素材</button>
          <button role="tab" aria-selected={tab === "transcripts"} className={tab === "transcripts" ? "active" : ""} onClick={() => setTab("transcripts")}><Captions size={15} aria-hidden="true" />转录</button>
          <button role="tab" aria-selected={tab === "models"} className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}><Archive size={15} aria-hidden="true" />模型</button>
          <button role="tab" aria-selected={tab === "jobs"} className={tab === "jobs" ? "active" : ""} onClick={() => setTab("jobs")}><History size={15} aria-hidden="true" />任务</button>
        </div>
        {tab === "assets" ? <div className="asset-drawer">
        <nav className="asset-category-rail" aria-label="素材分类">
          <button type="button" aria-pressed={libraryScope === "import" && assetFilter === "all"} onClick={() => changeLibraryScope("import")}>导入</button>
          <button type="button" aria-pressed={libraryScope === "favorites"} onClick={() => changeLibraryScope("favorites")}>收藏</button>
          {assetKinds.map(kind => <button type="button" key={kind} aria-pressed={libraryScope === "import" && assetFilter === kind}
            onClick={() => changeLibraryScope("import", kind)}>{assetKindLabels[kind]}</button>)}
        </nav>
        <div className="asset-drawer-content">
        {libraryScope === "import" && <>
        <div className="library-toolbar">{["video", "audio", "image"].map(kind => <button key={kind} disabled={!project || project.status !== "active"} onClick={() => void importAsset(kind as AssetKind)} title={`导入${assetKindLabels[kind as AssetKind]}素材`} aria-label={`导入${assetKindLabels[kind as AssetKind]}`}><span className="lib-card-ico">{kind === "video" ? <Video size={17} /> : kind === "audio" ? <AudioLines size={17} /> : <ImagePlus size={17} />}</span><span>{assetKindLabels[kind as AssetKind]}</span></button>)}</div>
        <div className="text-materials" aria-label="文本素材"><button disabled={!project || project.status !== "active"} onClick={() => void insertDefaultText()} title="插入到播放头处（3 秒）"><Type size={13} />默认文本</button><button disabled={!project || project.status !== "active"} onClick={() => void importSubtitleFile()} title="支持 SRT / ASS / SSA / LRC"><Captions size={13} />导入字幕</button></div>
        </>}
        <div className="library-filter-toolbar">
          <label className="asset-search">
            <Search size={14} aria-hidden="true" />
            <input type="search" aria-label="搜索素材" placeholder="搜索" value={assetQuery} onChange={event => setAssetQuery(event.target.value)} />
          </label>
          <button type="button" className="icon-btn" aria-label={assetView === "grid" ? "切换到列表视图" : "切换到网格视图"}
            title={assetView === "grid" ? "切换到列表视图" : "切换到网格视图"} onClick={() => changeAssetView(assetView === "grid" ? "list" : "grid")}>
            {assetView === "grid" ? <List size={15} aria-hidden="true" /> : <LayoutGrid size={15} aria-hidden="true" />}
          </button>
          <select aria-label="素材类型" value={assetFilter} onChange={event => setAssetFilter(event.target.value as AssetFilter)}>
            <option value="all">全部</option>
            {assetKinds.map(kind => <option value={kind} key={kind}>{assetKindLabels[kind]}</option>)}
          </select>
          <button type="button" className="icon-btn" aria-label="按名称排序" aria-pressed={assetSortByName}
            title={assetSortByName ? "恢复默认排序" : "按名称排序"} onClick={() => setAssetSortByName(value => !value)}>
            <ArrowUpDown size={15} aria-hidden="true" />
          </button>
          <IconButton label={refreshingAssets ? "正在刷新素材库" : "刷新素材库"} disabled={refreshingAssets || !project} onClick={() => void refreshAssets()}>
            <RefreshCw size={15} className={refreshingAssets ? "spin" : ""} />
          </IconButton>
        </div>
        <div className="asset-library-status" role="status">
          {refreshingAssets ? "正在检查本地素材…" : `${libraryScope === "favorites" ? "收藏" : assetFilter === "all" ? "全部" : assetKindLabels[assetFilter]} · ${visibleAssets.length} 项${selectedAssetIds.size > 1 ? ` · 已选 ${selectedAssetIds.size} 项` : ""}`}
        </div>
        {visibleAssets.length === 0 && <div className="asset-library-empty">
          <Clapperboard size={22} aria-hidden="true" />
          <span>{!project ? "请先打开项目" : assetQuery.trim() || assetFilter !== "all" ? "没有匹配的素材" : libraryScope === "favorites" ? "还没有收藏的素材" : "还没有素材，请先导入"}</span>
          {(assetQuery.trim() || assetFilter !== "all") && <button type="button" onClick={() => { setAssetQuery(""); setAssetFilter("all"); }}>清除筛选</button>}
        </div>}
        <div className={`asset-list asset-table asset-view-${assetView}`} aria-label="项目素材">
          {visibleAssets.map(item => {
            const { asset } = item;
            const selected = selectedAssetIds.has(asset.asset_id);
            const duration = assetDurationLabel(asset);
            const cvSummary = cvSummaryText(asset);
            const sparkOpen = cvSparkAssetId === asset.asset_id;
            const openAssetMenu = (trigger: HTMLButtonElement, x: number, y: number) => {
              if (!selected) selectAsset(asset.asset_id);
              setAssetMenu({ id: asset.asset_id, trigger, x, y });
            };
            return <div className={`asset-item asset-row${selected ? " sel" : ""}${isDraggableAsset(asset.kind) ? " draggable-asset" : ""}`}
              key={asset.asset_id} {...assetDragProps(item)}
              onDoubleClick={event => {
                const target = event.target as Element;
                if (target === event.currentTarget || target.closest(".asset-select")) previewFromLibrary(item);
              }}
              onContextMenu={event => {
                const trigger = event.currentTarget.querySelector<HTMLButtonElement>(".asset-select");
                if (trigger) {
                  event.preventDefault();
                  openAssetMenu(trigger, event.clientX, event.clientY);
                }
              }}
              onKeyDown={event => {
                if (event.key === "Escape" && event.currentTarget.querySelector(".asset-actions")?.contains(event.target as Node)) {
                  event.stopPropagation();
                  event.currentTarget.querySelector<HTMLButtonElement>(".asset-select")?.focus();
                }
              }}>
              <button type="button" className="asset-select" data-asset-id={asset.asset_id} aria-pressed={selected} aria-haspopup="menu"
                aria-label={`${asset.display_name}，${assetKindLabels[asset.kind]}${asset.availability === "available" ? "" : `，${availabilityLabels[asset.availability]}`}`}
                title={asset.display_name} onClick={event => selectAsset(asset.asset_id, event)}
                onKeyDown={event => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    selectAsset(asset.asset_id);
                    previewFromLibrary(item);
                  } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openAssetMenu(event.currentTarget, rect.left, rect.bottom);
                  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
                    event.preventDefault();
                    event.stopPropagation();
                    setPickedAssetIds(visibleAssetOrder);
                  } else if (event.key === "Escape") {
                    event.stopPropagation();
                    resetAssetSelection();
                  } else {
                    const next = navigateAssetLibrary(event, assetView);
                    if (next) selectAsset(next, event);
                  }
                }}>
                <span className="asset-select-media">
                  {assetThumb(item)}
                  {usedAssetIds.has(asset.asset_id) && <span className="asset-used">已添加</span>}
                  {favoriteAssetIds.has(asset.asset_id) && <span className="asset-favorite-mark"><Star size={11} fill="currentColor" aria-label="已收藏" /></span>}
                  {duration !== "—" && <span className="asset-time-badge">{duration}</span>}
                </span>
                <span className="asset-filename">{asset.display_name}</span>
                <span className="asset-row-meta" title={assetMetaText(asset)}>{assetMetaText(asset)}</span>
                <span className="asset-row-time">{duration}</span>
              </button>
              <div className="asset-actions">
                {assetActionItems(item).map(action => <IconButton key={action.id} label={action.label} disabled={action.disabled}
                  onClick={action.onSelect}>{action.icon}</IconButton>)}
              </div>
              {cvSummary && <div className="asset-cv-summary" title={cvSummary}>{cvSummary}</div>}
              {asset.kind === "video" && cvSummaries[asset.asset_id]?.status === "ready" &&
                <button type="button" className="cv-spark-toggle" aria-expanded={sparkOpen} aria-label={`${sparkOpen ? "收起" : "展开"} ${asset.display_name} 的信号曲线`}
                  onClick={() => toggleCvSpark(asset)}>{sparkOpen ? "收起信号" : "信号曲线"}</button>}
              {sparkOpen && <div className="cv-spark">
                {cvSparkSamples === null ? <small role="status">加载中…</small> : cvSparkSamples.length < 2 ? <small>暂无样本数据</small> : <>
                  <svg viewBox="0 0 100 1" preserveAspectRatio="none" aria-label="CV 信号曲线">
                    <path d={cvSparkPath(cvSparkSamples, "motion_energy")} fill="none" stroke="#7aa2f7" strokeWidth="0.02" />
                    <path d={cvSparkPath(cvSparkSamples, "audio_energy")} fill="none" stroke="#9ece6a" strokeWidth="0.02" opacity="0.7" />
                    {cvSparkSamples.filter(sample => sample.scene_cut).map((sample, index) => {
                      const x = sample.timestamp_us / (cvSparkSamples.at(-1)?.timestamp_us || 1) * 100;
                      return <line key={index} x1={x} x2={x} y1={0} y2={1} stroke="#f7768e" strokeWidth="0.03" />;
                    })}
                  </svg>
                  <small className="cv-spark-legend"><span style={{ color: "#7aa2f7" }}>运动能量</span> · <span style={{ color: "#9ece6a" }}>音频能量</span> · <span style={{ color: "#f7768e" }}>场景切换</span></small>
                </>}
              </div>}
            </div>;
          })}
        </div>
        {assetMenu && menuAsset && <ContextMenu x={assetMenu.x} y={assetMenu.y} items={assetActionItems(menuAsset)}
          onClose={() => { setAssetMenu(null); assetMenu.trigger.focus({ preventScroll: true }); }} />}
      </div></div> : tab === "transcripts" ? <div className="transcript-list"><p className="panel-hint">只读展示语音识别结果；点开一条记录后勾选片段，可追加到时间线并生成字幕。</p>{transcriptRows.length === 0 && <p className="panel-hint">尚未生成转录：在"素材"页对视频/音频素材点击"转录"按钮后，结果会出现在这里。</p>}{transcriptRows.map(({ summary, assetName }) => { const loaded = loadedTranscript(summary.transcript_id); return <div className="transcript-item" key={summary.transcript_id}><div className="transcript-item-head"><button className="transcript-open-button" aria-label={`查看转录 ${summary.transcript_id}`} onClick={() => void viewTranscript(summary)} title="查看并选择转录片段"><strong title={assetName}>{assetName}</strong><small>{transcriptStatusLabels[summary.status]} · {summary.language}{loaded ? ` · ${loaded.segments.length} 段` : ""} · 点击查看内容与操作</small></button><IconButton label={`删除转录 ${summary.transcript_id}`} onClick={() => openDeleteTranscriptDialog(summary)}><Trash2 size={13} /></IconButton></div></div>; })}</div>
        : tab === "models" ? <div className="model-page"><p className="panel-hint">本地语音识别模型：下载后可在视频/音频素材上发起转录，生成带时间戳的字幕底稿；下载中可取消，失败可重试。</p>{models.map(model => { const dl = ["queued", "downloading", "verifying", "paused"].includes(model.status); const pct = model.progress !== null && model.progress !== undefined ? `${Math.round(model.progress * 100)}%` : "—"; return <div className={`model-row${dl ? " dl" : ""}`} key={model.model_id}><div className="model-ico"><FileText size={14} /></div><div className="model-main"><div className="model-head"><strong title={model.display_name}>{model.display_name}</strong><span className={`badge ${model.status === "ready" ? "ok" : dl ? "run" : model.status === "failed" || model.status === "corrupt" ? "bad" : "dim"}`}>{modelBadgeLabels[model.status]}</span>{dl && <span className="mpct">{pct}</span>}</div>{dl && <div className="model-down"><progress className="model-progress" max={1} value={model.progress ?? 0} /><button className="mini-btn" title="取消模型下载" onClick={() => void cancelModel(model)}>取消下载</button></div>}<small className="model-sub">{modelStatusLabels[model.status]} · {model.provider}</small></div>{!dl && ["unavailable", "failed", "cancelled", "paused", "corrupt"].includes(model.status) && <button className="mini-btn" onClick={() => void openModel(model)}>{model.status === "failed" ? "重试下载" : model.status === "corrupt" ? "重新下载" : model.status === "paused" ? "继续下载" : "下载模型"}</button>}</div>; })}</div>
        : <div className="jobs-page"><p className="panel-hint">转录、权威预览与导出的后台进度会显示在这里；运行中的任务可取消，失败的转录可重试。</p>{jobs.length === 0 && <p className="panel-hint">暂无任务。</p>}{(() => { const activeJobs = jobs.filter(job => ["running", "cancelling"].includes(job.status)); const queuedJobs = jobs.filter(job => job.status === "queued"); const doneJobs = jobs.filter(job => ["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)); const renderJobRow = (job: Job) => { const badgeClass = job.status === "succeeded" ? "ok" : job.status === "failed" ? "bad" : job.status === "running" ? "run" : "dim"; const phaseText = job.phase ? (jobPhaseLabels[job.phase] ?? job.phase) : null; const phasePct = phaseText && job.phase_progress !== null && job.phase_progress !== undefined ? ` ${Math.round(job.phase_progress * 100)}%` : ""; return <div className="job-row" key={job.job_id}><div className="jmain"><div className="jhead"><strong>{jobKindLabels[job.kind] ?? job.kind}</strong><span className={`badge ${badgeClass}`}>{jobStatusLabels[job.status]}</span><span className="jpct">{job.progress !== null ? `${Math.round(job.progress * 100)}%` : "—"}</span></div>{job.progress !== null && <div className="jbar"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}<div className="jmeta"><span>{jobDetailText(job, assets.find(item => item.asset.asset_id === job.asset_id)?.asset.display_name)}{phaseText || job.stage ? ` · ${phaseText ? `${phaseText}${phasePct}` : job.stage}` : ""}{job.error ? ` · ${safeTaskErrorMessage(job.error)}` : ""}</span>{job.status === "running" && <JobEta job={job} />}</div><div className="jops">{job.kind === "transcription" && (job.status === "failed" || job.status === "interrupted") && <button className="mini-btn" onClick={() => void retryTranscription(job)}>重试转录</button>}{["queued", "running", "cancelling"].includes(job.status) && <button className="mini-btn" onClick={() => void cancelJob(job)}>取消</button>}{["succeeded", "failed", "cancelled", "interrupted"].includes(job.status) && <button className="mini-btn danger-ghost" aria-label={`删除任务 ${job.job_id}`} title="从列表移除这条任务记录" onClick={() => void deleteJob(job)}>删除</button>}</div></div></div>; }; return <>{activeJobs.length > 0 && <div className="jobs-group">进行中</div>}{activeJobs.map(renderJobRow)}{queuedJobs.length > 0 && <div className="jobs-group">排队</div>}{queuedJobs.map(renderJobRow)}{doneJobs.length > 0 && <div className="jobs-group">已完成 / 失败</div>}{doneJobs.map(renderJobRow)}</>; })()}</div>}
        {!timeline && project && <div className="empty-timeline"><button onClick={() => void createTimeline({ kind: "empty" })}>创建空时间线</button></div>}
      </section>
      {leftPaneOpen && <div className="resize-handle resize-handle-left" role="separator" aria-label="调整左侧面板宽度" onPointerDown={event => beginResize("left", event)} />}
    <div className="editor-stack">
    <section className={`editor-grid editor-grid-nolib${rightPaneOpen ? "" : " properties-closed"}`}>
      <section ref={stagePaneRef} className={`stage-pane${isFullscreen ? " fullscreen" : ""}`} aria-label="项目预览">
        <div className="stage-column" ref={stageColumnRef}>
          {/* 预览窗格栏（2026-11-16 按参照 ProjectView.tsx:4639 的 PANE_BAR 形态）：
              参照这里是 40px 高、**只有图标按钮**（图层/属性面板开关），没有带文字的控件。
              我们原来塞了「比例 select / 编码 select / 渲染与导出 按钮」三个带文字的控件，
              于是画面上方出现一条参照里不存在的工具条——这是预览区结构差最大的一处。
              功能不删：三项收进右侧图标按钮（比例与编码仍是可访问的 select，只是外观走
              参照的 28×28 图标盒 + tooltip 说明），渲染与导出同理。 */}
          {/* P4 参照 ProjectView.tsx:4639-4661：窗格栏 = 左侧 layers/inspector 两个 28×28 图标开关，
              无标题、无带文字控件。ours 映射：图层图标→左素材池显隐；检查器图标→右属性栏显隐；
              比例/编码/渲染导出（ours 功能）收进最右「预览设置」图标弹层，功能一项不删。 */}
          <div className="pane-bar">
            <button type="button" className={`pane-bar-btn${leftPaneOpen ? " on" : ""}`} aria-pressed={leftPaneOpen} aria-label="媒体库面板开关" title={leftPaneOpen ? "收起媒体库" : "展开媒体库"} onClick={() => setLeftPaneOpen(value => !value)}><LayoutPanelLeft size={16} aria-hidden="true" /></button>
            <span className="pane-bar-spacer" />
            {/* P4 顺序修正（ProjectView.tsx:4640-4661）：layers 左端、inspector 右端，ours 的预览设置在其右。 */}
            <button type="button" className={`pane-bar-btn${rightPaneOpen ? " on" : ""}`} aria-pressed={rightPaneOpen} aria-label="属性面板开关" title={rightPaneOpen ? "收起属性面板" : "展开属性面板"} onClick={() => setRightPaneOpen(value => !value)}><SlidersHorizontal size={16} aria-hidden="true" /></button>
            <span className="pane-settings-anchor" ref={paneSettingsRef}>
              <button type="button" className={`pane-bar-btn${paneSettingsOpen ? " on" : ""}`} aria-haspopup="dialog" aria-expanded={paneSettingsOpen} aria-label="预览设置" title="预览设置（比例 / 编码）" onClick={event => { event.stopPropagation(); setPaneSettingsOpen(value => !value); }}><Settings2 size={16} aria-hidden="true" /></button>
              {paneSettingsOpen && <div className="pane-settings-pop" role="dialog" aria-label="预览设置" onClick={event => event.stopPropagation()}>
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
              </div>}
            </span>
          </div>
          <div className="stage-view">
            <div ref={previewFrameRef} className={`preview-frame ${previewClass}${previewSelected ? " selected" : ""}${isFit(viewerView) ? "" : " zoomed"}`} role="button" tabIndex={0} aria-label="预览画布。Ctrl 或 Command 加滚轮缩放，中键拖动画面；放大后可用方向键平移" title="Ctrl / Command + 滚轮缩放；放大后中键拖动或用方向键平移" onPointerDown={onPreviewPointerDown} onPointerMove={onPreviewPointerMove} onPointerUp={onPreviewPointerUp} onPointerCancel={() => { previewPressRef.current = IDLE_PRESS; setStageMarquee(null); }} onClick={selectClipAtPlayhead} onKeyDown={event => {
              if (!isFit(viewerView) && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                const viewer = { w: event.currentTarget.clientWidth || 1, h: event.currentTarget.clientHeight || 1 };
                const fitted = fittedSize(viewer, frameRatioRef.current);
                const step = event.shiftKey ? 80 : 32;
                const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
                const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
                const next = panBy(viewerViewRef.current, dx, dy, fitted);
                viewerViewRef.current = next; setViewerView(next); setPreviewZoom(next.z);
              } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectClipAtPlayhead(); }
            }}>
          {stageMarquee && <div className="preview-marquee" aria-hidden="true" style={{ left: stageMarquee.x, top: stageMarquee.y, width: stageMarquee.w, height: stageMarquee.h }} />}
          <div className="preview-canvas" ref={canvasRef}>
            {previewMode === "authoritative" && authoritativeMediaUrl && <video ref={videoRef} className="preview-foreground authoritative-video" src={authoritativeMediaUrl} aria-label={reframePlayback ? "重构图权威预览视频" : exportPlayback ? "导出视频" : "权威预览视频"} controls onEnded={() => { setPlaying(false); setExportPlayback(undefined); setReframePlayback(undefined); setPreviewMode("synthetic"); }} />}
            {/* 合成预览仅在时间线有可见片段时挂载；空时间线显示引导文案（剪映式），
                避免对空时间线请求 preview-ir 被 Core 以 TIMELINE_EMPTY 拒绝而回退。 */}
            {previewMode === "synthetic" && projectStateReady && project && working && timeline && working.clips.length > 0 && <SyntheticPreview preparePlaybackRef={preparePreviewPlaybackRef} key={project.project_id} outputRatio={renderRatio} projectId={project.project_id} revisionId={timeline.current_revision.timeline_revision_id} mediaUrls={syntheticMediaUrls} audioByClip={syntheticAudioByClip} pipClips={syntheticPipClips} lockedClipIds={working.locked_elements} selectedClipId={pipSelectedId} selectedClipIds={selection?.kind === "clips" ? selection.ids : undefined} onSelectClip={clipId => setSelection(clipId ? { kind: "clip", id: clipId as never } : null)} onSelectClips={ids => setSelection(ids.length ? { kind: "clips", ids } : null)} trackIndexByClipId={trackIndexByClipId} onCommitPipTransform={async (clipId, transform) => { const clip = (working?.clips ?? []).find(item => item.clip_id === clipId); return commitPipTransform(clipId as never, { ...(clip?.transform ?? {}), ...transform }); }} onDraftPipMask={(clipId, mask) => draftPipMask(clipId as never, mask)} onCommitPipMask={(clipId, mask) => commitPipMask(clipId as never, mask)} onGesturePause={pausePreviewPlayback} onGestureResume={resumePreviewPlayback} playing={playing && !gestureHoldRef.current} playheadUs={playhead} playheadStore={playheadStore} playbackRate={uiRate} onTimeUs={us => seekFromPlayback(us)} onEnded={handlePreviewEnded} onFallback={(reason, code) => { if (!seenAnyTicketRef.current) return; setPreviewMode("interactive"); setSyntheticNotice(syntheticFallbackNotice(reason, code)); }} sourceResolver={previewSourceResolver} resourceTier={resourceTier} forceCopyTo={forceCopyTo} snapshotRef={syntheticSnapshotRef} proxyEpoch={proxyReadyEpoch} onDecodeBudget={onDecodeBudget} onSession={session => { if (!session) previewSessionRef.current?.endScrubStorm(); previewSessionRef.current = session; }} />}
            {previewMode === "interactive" && previewAsset?.media_url && previewAsset.asset.kind === "video" && <div className="preview-transform" style={mainTransformStyle}><video className="preview-background" src={previewAsset.media_url} muted aria-hidden="true" /><video ref={videoRef} className="preview-foreground" src={previewAsset.media_url} muted={!selectedClip?.audio.enabled || previewReverse || !interactiveMediaRatePlayable || (clipAtPlayhead ? !isClipAudible(clipAtPlayhead) : false)} aria-label="交互预览视频" onTimeUpdate={event => { if (libraryPreviewId) dispatchPlayhead("external", Math.round(event.currentTarget.currentTime * 1_000_000), true); }} onEnded={handleVideoEnded} /></div>}
            {previewMode === "interactive" && audioAsset?.media_url && <audio ref={audioRef} src={audioAsset.media_url} style={{ display: "none" }} />}
            {previewMode === "interactive" && previewAsset?.media_url && previewAsset.asset.kind === "image" && <div className="preview-transform" style={mainTransformStyle}><img className="preview-background" src={previewAsset.media_url} alt="" aria-hidden="true" /><img className="preview-foreground" src={previewAsset.media_url} alt={previewAsset.asset.display_name} /></div>}
            {(previewMode === "interactive" || (previewMode === "synthetic" && (!working || working.clips.length === 0))) && !previewAsset?.media_url && overlayPips.length === 0 && <div className="preview-empty">选择或追加素材以开始编辑</div>}
            {previewMode === "interactive" && visibleCaption && <div className={`caption-overlay ${visibleCaption.preset_id}`}>{visibleCaption.text}</div>}
            {previewMode === "interactive" && overlayPips.length > 0 && <PreviewPipOverlays items={overlayPips} tracks={tracksAtPlayhead} selectedClipId={pipSelectedId} locked={pipLocked} onSelect={clipId => setSelection({ kind: "clip", id: clipId })} onDraftTransform={draftPipTransform} onCommitTransform={commitPipTransform} onDraftMask={draftPipMask} onCommitMask={commitPipMask} onGesturePause={pausePreviewPlayback} onGestureResume={resumePreviewPlayback} playheadUs={playhead} playing={playing} playbackRate={uiRate} />}
          </div>
          {/* 选中框：白色边框 + 8 向拖拽手柄，缩放时随画面一起缩放；仅选中片段时可见。 */}
          {!overlayClipSelected && <div className="sel-box" ref={selBoxRef} onClick={event => event.stopPropagation()} aria-hidden="true"><i className="sel-border" />{/* P6 修正：参照标签 = 手势实时值（StageTransformFrame.tsx:224-244 常驻 Label 属 layer；
    ours 无 layer，常态显示画布全尺寸有误导——只在拖拽中显示（selDimsText 非空） */}
<span className="sel-dims" style={selDimsText ? undefined : { display: "none" }}>{selDimsText}</span><span className="h h-nw" data-dir="nw" title="等比缩放（左上）" onPointerDown={beginSelDrag("nw")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-n" data-dir="n" title="单轴缩放（上）" onPointerDown={beginSelDrag("n")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-ne" data-dir="ne" title="等比缩放（右上）" onPointerDown={beginSelDrag("ne")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-e" data-dir="e" title="单轴缩放（右）" onPointerDown={beginSelDrag("e")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-se" data-dir="se" title="等比缩放（右下）" onPointerDown={beginSelDrag("se")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-s" data-dir="s" title="单轴缩放（下）" onPointerDown={beginSelDrag("s")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-sw" data-dir="sw" title="等比缩放（左下）" onPointerDown={beginSelDrag("sw")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /><span className="h h-w" data-dir="w" title="单轴缩放（左）" onPointerDown={beginSelDrag("w")} onPointerMove={moveSelDrag} onPointerUp={endSelDrag} onPointerCancel={endSelDrag} /></div>}
        </div>
          {/* P9 参照 ProjectView.tsx:4699-4741：画面上只有瞬态通知，无常驻模式胶囊。
     interactive-label 仅在 stale（权威预览过期）或导出/重构播放这类瞬态时显示；
     常驻的 preview-context 已删——模式信息收进窗格栏（见窗格栏 title/弹层）。 */}
{(previewIsStale && previewMode === "authoritative" && !exportPlayback) || exportPlayback || reframePlayback ? <span className={`interactive-label ${previewIsStale && previewMode === "authoritative" && !exportPlayback ? "stale" : ""}`}>{previewMode === "interactive" ? "交互预览 · 非权威" : previewMode === "synthetic" ? "合成预览 · 实时（非权威）" : reframePlayback ? "静态焦点重构图 · 权威预览" : exportPlayback ? `导出 · ${exportPlayback.export_record.destination_display_name}` : previewIsStale ? "权威预览 · 已过期" : "权威预览 · 当前 Revision"}</span> : null}
{syntheticNotice && <span role="note" aria-label="合成预览回退提示" className="synthetic-note">{syntheticNotice}<button className="synthetic-note-retry" onClick={() => { setSyntheticNotice(null); setPreviewMode("synthetic"); }}>重试合成预览</button></span>}
          <div className={`progress${!libraryPreviewId && !isFullscreen ? " project-progress" : ""}${progressDragging ? " dragging" : ""}`} ref={progressRef} role="slider" tabIndex={0} aria-label="时间线播放头" aria-valuemin={0} aria-valuemax={Math.max(totalUs, 1)} aria-valuenow={Math.min(playhead, totalUs)} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setProgressDragging(true); seekFromProgress(event.clientX); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) scrubFromProgress(event.clientX); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const rect = event.currentTarget.getBoundingClientRect(); event.currentTarget.releasePointerCapture(event.pointerId); commitScrub(Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * Math.max(totalUs, 1))); } setProgressDragging(false); }} onKeyDown={event => { if (event.key === "ArrowLeft") { event.preventDefault(); seekFromProgressRatio(Math.max(0, playhead / Math.max(totalUs, 1) - 1 / 300)); } else if (event.key === "ArrowRight") { event.preventDefault(); seekFromProgressRatio(Math.min(1, playhead / Math.max(totalUs, 1) + 1 / 300)); } else if (event.key === "Home") { event.preventDefault(); seekFromProgressRatio(0); } else if (event.key === "End") { event.preventDefault(); seekFromProgressRatio(1); } }}>
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
                {/* P12/P13 参照 PlaybackMenu.tsx:86-137：循环=整行 switch（自绘 18×30 ink 开关）、
                    倍速=两行×4 的 segmented（滑动选中标记、role=radiogroup）。速度集合保 ours 域 0.25–4×。 */}
                <button type="button" role="switch" aria-checked={loopPlayback} aria-label="循环播放" className="rp-row rp-loop" onClick={() => { if (!loopSeekPending.current) cancelLoopRestart(); setLoopPlayback(value => !value); }}>
                  <Repeat />
                  <span className="rp-loop-label">{playbackRange ? "循环播放区间" : "循环播放"}</span>
                  <span aria-hidden className={`rp-switch${loopPlayback ? " on" : ""}`}><i /></span>
                </button>
                <div className="rp-row rp-speed" aria-hidden="true"><span>倍速</span></div>
                {(() => { const speeds = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const; const perRow = 4; const at = Math.max(0, speeds.indexOf(uiRate as typeof speeds[number]) === -1 ? speeds.findIndex(s => s > uiRate) : speeds.indexOf(uiRate as typeof speeds[number])); return <div className="rate-grid" role="radiogroup" aria-label="播放倍速">
                  <span aria-hidden className="rate-mark" style={{ width: `calc((100% - 4px) / ${perRow})`, height: `calc((100% - 4px) / 2)`, transform: `translate(${(at % perRow) * 100}%, ${Math.floor(at / perRow) * 100}%)` }} />
                  {speeds.map((r, i) => (
                    <button key={r} type="button" role="radio" aria-checked={i === at} className={`rate-opt${i === at ? " active" : ""}`} onClick={() => setUiRate(r)}>{`${r}×`}</button>
                  ))}
                </div>; })()}
              </div>
            </span>
            <span className="vol-anchor">
              <button type="button" className="pb-icon" aria-haspopup="dialog" aria-expanded={volPopOpen} title={`音量 ${volume}%`} aria-label={`音量 ${volume}%`} onClick={event => { event.stopPropagation(); setVolPopOpen(value => !value); setZoomPopOpen(false); }}>{volume === 0 ? <VolumeX /> : <Volume2 />}</button>
              <div className={`vol-pop${volPopOpen ? " open" : ""}`} ref={volPopRef} role="dialog" aria-label="音量" onClick={event => event.stopPropagation()}>
                <div className="vol-rail" ref={volRailRef} role="slider" tabIndex={0} aria-label="预览音量" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={100} aria-valuenow={volume} aria-valuetext={`${volume}%`} onKeyDown={event => {
                  const delta = event.key === "ArrowUp" || event.key === "ArrowRight" ? 5 : event.key === "ArrowDown" || event.key === "ArrowLeft" ? -5 : 0;
                  if (delta || event.key === "Home" || event.key === "End") {
                    event.preventDefault(); event.stopPropagation();
                    setVolume(event.key === "Home" ? 0 : event.key === "End" ? 100 : Math.max(0, Math.min(100, volume + delta)));
                  }
                }} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); seekVolumeFrom(event.clientY); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) seekVolumeFrom(event.clientY); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}>
                  <div className="vol-fill" style={{ height: `${volume}%` }} />
                  <div className="vol-thumb" style={{ bottom: `${volume}%` }} />
                </div>
              </div>
            </span>
            <button type="button" className="pb-icon zoom-btn" aria-haspopup="dialog" aria-expanded={zoomPopOpen} aria-label={`预览缩放，${previewZoom === "fit" ? "适应画布" : `${Math.round(previewZoom * 100)}%`}`} title="预览缩放" onClick={event => { event.stopPropagation(); setZoomPopOpen(value => !value); setVolPopOpen(false); }}><ZoomIn /><span className="zoom-label">{previewZoom === "fit" ? "适应" : `${Math.round(previewZoom * 100)}%`}</span></button>
            <div className={`zoom-pop${zoomPopOpen ? " open" : ""}`} ref={zoomPopRef} role="dialog" aria-label="预览缩放" onClick={event => event.stopPropagation()}>
              <div className="zp-head">
                <button type="button" className={`zp-fit${previewZoom === "fit" ? " on" : ""}`} aria-pressed={previewZoom === "fit"} onClick={() => { viewerViewRef.current = FIT_VIEW; setViewerView(FIT_VIEW); setPreviewZoom("fit"); }}>{previewZoom === "fit" ? "✓ 适应画布" : "适应画布"}</button>
                <span className="zp-val">{previewZoom === "fit" ? "原始" : `${Math.round(previewZoom * 100)}%`}</span>
              </div>
              <input type="range" min={0} max={1000} value={previewZoom === "fit" ? zoomT(1) : zoomT(previewZoom)} onChange={event => { const z = Math.round(zoomZ(Number(event.target.value)) * 100) / 100; const next = { ...viewerViewRef.current, z }; viewerViewRef.current = next; setViewerView(next); setPreviewZoom(z); }} aria-label="预览缩放级别" aria-valuetext={previewZoom === "fit" ? "适应画布" : `${Math.round(previewZoom * 100)}%`} />
              <div className="zp-scale"><span>25%</span><span>100%</span><span>500%</span></div>
            </div>
            <button type="button" className="pb-icon" aria-label={isFullscreen ? "退出全屏" : "全屏"} title={isFullscreen ? "退出全屏" : "全屏"} onClick={() => void toggleFullscreen()}>{isFullscreen ? <Minimize /> : <Maximize />}</button>
          </div>
        </div>
        </div>
      </section>
      {rightPaneOpen && <div className="resize-handle resize-handle-right" role="separator" aria-label="调整右侧面板宽度" onPointerDown={event => beginResize("right", event)} />}
      <aside className={"properties-pane" + (rightPaneOpen ? "" : " pane-closed")} aria-label="上下文属性" role="region" hidden={!rightPaneOpen}>{selectedClip ? <ClipProperties clip={selectedClip} clipName={semanticAssetNames[selectedClip.asset_id]} locked={Boolean(working?.locked_elements?.includes(selectedClip.clip_id) || trackById.get(selectedClip.track_id)?.locked)} onAlign={alignmentHint ? undefined : alignSelectedFrames} alignmentHint={alignmentHint} onPatch={patchTimelineVoid} onDraft={queueDraft} working={working!} playheadUs={playhead} onOpenEditingTools={tool => openEditingTools(tool, selectedClip.clip_id)} baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null} onAppliedTimeline={acceptState} /> : selectedCaption ? <CaptionProperties caption={selectedCaption} locked={Boolean(selectedCaption.source_clip_id && working?.locked_elements?.includes(selectedCaption.source_clip_id))} onPatch={patchTimelineVoid} onDraft={queueDraft} working={working!} /> : selectedTransition ? <TransitionProperties transition={selectedTransition} onPatch={patchTimelineVoid} /> : selectedClips.length > 1 ? <ClipGroupAlignmentProperties count={selectedClips.length} hint={alignmentHint} onAlign={alignmentHint ? undefined : alignSelectedFrames} onDistribute={visualSelectedCount >= 3 ? distributeSelectedFrames : undefined} distributionDisabled={Boolean(alignmentHint)} groupBounds={groupBounds} onEditBounds={editGroupBounds} /> : selectedAssetIds.size > 0 ? <AssetSelectionProperties entries={visibleAssets.filter(({ asset }) => selectedAssetIds.has(asset.asset_id)).map(({ asset }) => ({ id: asset.asset_id, name: asset.display_name, kind: assetKindLabels[asset.kind], meta: assetMetaText(asset), duration: assetDurationLabel(asset), status: availabilityLabels[asset.availability] }))} /> : <ProjectProperties project={project} saveState={saveState} authoritativePreview={authoritativePreview} previewIsStale={previewIsStale} renderDisabledReason={renderDisabledReason} onGeneratePreview={() => void generatePreview()} onCreateExport={openExportDialog} onOpenProjectDialog={() => setProjectDialogOpen(true)} />}</aside>
    </section>
    <div className="timeline-resize-handle" role="separator" aria-label="调整时间线高度" onPointerDown={event => beginResize("timeline", event)} />
    <TimelinePanel projectId={project?.project_id} document={working} activeTransitions={timeline?.active_transitions ?? []} selection={selection} setSelection={(sel) => { setSelection(sel); exitLibraryPreview(); }} onPatch={patchTimelineVoid} onDropAsset={dropAsset} onReplaceAssetDrop={(ids, targetClipId, intent) => dropAsset(ids, intent.slot, intent.trackId ?? undefined, undefined, intent, targetClipId)} coverUrl={coverUrl} onCaptureCover={() => setCoverDialogOpen(true)} canUndo={Boolean(timeline?.can_undo)} canRedo={Boolean(timeline?.can_redo)} onUndo={() => void undoRedo("undo")} onRedo={() => void undoRedo("redo")} assetMedia={timelineAssetMedia} waveformCache={waveformCache} playheadStore={playheadStore} onSeek={(timeUs) => { if (libraryPreviewId) exitLibraryPreview(); seekWhileScrubbing(timeUs); }} onSeekCommit={timeUs => { exitLibraryPreview(); commitScrub(timeUs); }} onRangeChange={setPlaybackRange} onCommand={(id) => runCommand(id)} meterLevels={meterLevels} playing={playing} />
    </div>
    </div>
    <WorkspaceFooter
      saveState={saveState}
      runtimeReady={runtimeReady}
      previewIsStale={previewIsStale}
      renderDisabledReason={renderDisabledReason}
      renderActivity={renderActivity}
      runningProgressText={runningProgressText}
      hasProject={Boolean(project)}
      hasTimeline={Boolean(timeline)}
      contractVersion={CONTRACT_VERSION}
      onGeneratePreview={() => runCommand("preview.generate")}
      onOpenJobs={() => setTab("jobs")}
      onOpenExportBatch={() => void openExportBatch()}
      onOpenAi={() => void openAi()}
      onOpenPatch={() => void openPatch()}
      onOpenRevisionCompare={() => void openRevisionCompare()}
      onOpenProviderSettings={() => setProviderSettingsOpen(true)}
      onOpenSettings={() => setSettingsOpen(true)}
    />
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
      {projectDialogOpen && <ProjectLibraryDialog
        projects={projects}
        activeProjectId={project?.project_id}
        newProject={newProject}
        newProjectRatio={newProjectRatio}
        creating={false}
        refreshing={projectManagerRefreshing}
        onNewProjectChange={setNewProject}
        onNewProjectRatioChange={setNewProjectRatio}
        onCreateProject={createProject}
        onRefresh={refreshProjectManager}
        onOpen={item => { switchProject(item); setProjectDialogOpen(false); }}
        onRename={renameManagedProject}
        onToggleArchive={toggleManagedProjectArchive}
        onClose={() => setProjectDialogOpen(false)}
      />}
    {batchOpen && <Dialog titleId="export-batch-title" closeLabel="关闭多平台导出" title="多平台导出" subtitle="平台与画幅独立选择；仅同一 Revision 的权威预览可进入批次。" footer={<><button disabled={renditionTargets.length >= 8 || !platformPresets.length} onClick={addTarget}>添加目标</button><button onClick={() => void chooseBatchDirectory()}>{directoryGrant ? `输出目录：{directoryGrant.display_name}` : "选择输出目录"}</button><button disabled={!directoryGrant || !renditionTargets.length || renditionTargets.some(target => !targetPreview(target))} onClick={() => void createBatch()}>创建批次</button></>} label="多平台导出" onClose={() => setBatchOpen(false)} className="export-batch-modal">{batchError && <p className="ai-status" role="status">{batchError}</p>}<div className="rendition-targets">{renditionTargets.map(target => { const platform = platformPresets.find(item => item.platform_preset_id === target.platform_preset_id); const rendition = renditionPresets.find(item => item.rendition_preset_id === target.rendition_preset_id); const preview = targetPreview(target); return <section key={target.key} className="rendition-target"><label>平台<select aria-label="导出平台" value={target.platform_preset_id} onChange={event => { const next = platformPresets.find(item => item.platform_preset_id === event.target.value); if (next) updateTarget(target.key, { platform_preset_id: next.platform_preset_id, rendition_preset_id: next.default_rendition_id, key: `${next.platform_preset_id}:${next.default_rendition_id}` }); }}><option value="">选择平台</option>{platformPresets.map(item => <option value={item.platform_preset_id} key={item.platform_preset_id}>{item.display_name}</option>)}</select></label><label>画幅<select aria-label="导出画幅" value={target.rendition_preset_id} onChange={event => updateTarget(target.key, { rendition_preset_id: event.target.value, key: `${target.platform_preset_id}:${event.target.value}` })}>{platform?.allowed_rendition_ids.map(id => <option value={id} key={id}>{renditionPresets.find(item => item.rendition_preset_id === id)?.display_name ?? id}</option>)}</select></label><label>布局<select aria-label="目标布局策略" value={target.layout_policy} onChange={event => updateTarget(target.key, { layout_policy: event.target.value as LayoutPolicy })}>{layoutPolicies.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label><div className="target-summary"><small>{rendition ? `${rendition.export.width}×${rendition.export.height} · H.264/AAC · 30fps` : "预设加载中"}</small><small>{preview ? `权威预览已就绪${preview.preview.warnings.length ? ` · ${preview.preview.warnings.join(", ")}` : ""}` : "需要本目标权威预览"}</small></div><div className="target-actions"><button onClick={() => void generateRenditionPreview(target)}>{preview ? "重新生成权威预览" : "生成权威预览"}</button><button disabled={renditionTargets.length === 1} onClick={() => setRenditionTargets(items => items.filter(item => item.key !== target.key))}>移除</button></div>{preview && <ReframeTargetEditor clips={reframeClips(target)} selections={reframeSelections[target.key] ?? {}} preview={reframePreviews[target.key]} pending={Boolean(reframePending[target.key])} onSelect={(clipId, anchor) => selectReframeAnchor(target, clipId, anchor)} onGenerate={() => void generateReframePreview(target)} onPlay={() => { setReframePlayback(reframePreviews[target.key]); setExportPlayback(undefined); setPreviewMode("authoritative"); }} />}</section>; })}</div><section className="reframe-batch-actions" aria-label="静态焦点批量导出"><h3>静态焦点批量导出</h3><p>独立于基础 Stage 3A 批次；所有目标的重构图权威预览就绪后才可创建。</p>{reframeError && <p className="ai-status" role="status">{reframeError}</p>}<div className="modal-actions"><button disabled={renditionTargets.some(target => !targetAdjustments(target).length || !reframePreviews[target.key])} onClick={() => void chooseReframeDirectory()}>{reframeDirectoryGrant ? `重构图输出目录：${reframeDirectoryGrant.display_name}` : "选择重构图输出目录"}</button><button disabled={!reframeDirectoryGrant || renditionTargets.some(target => !targetAdjustments(target).length || !reframePreviews[target.key])} onClick={() => void createReframeBatch()}>创建重构图批次</button></div></section>{activeBatch && <section className="batch-status"><h3>批次 {activeBatch.status}</h3><p>目录：{activeBatch.directory_display_name}</p>{activeBatch.items.map(item => <div key={item.export_batch_item_id}><strong>{item.rendition_snapshot.platform_preset_id} · {item.rendition_snapshot.rendition_preset_id}</strong><small>{item.status} · {item.progress === null ? "--" : `${Math.round(item.progress * 100)}%`}{item.destination_display_name ? ` · ${item.destination_display_name}` : ""}{item.error_code ? ` · ${item.error_code}` : ""}</small></div>)}<div className="modal-actions">{["queued", "running"].includes(activeBatch.status) && <button onClick={() => void window.desktop.cancelExportBatch(activeBatch.export_batch_id).then(setActiveBatch).catch(() => setBatchError("取消批次失败。"))}>取消批次</button>}{activeBatch.items.some(item => ["failed", "cancelled", "interrupted"].includes(item.status)) && <button onClick={() => void retryBatchItems()}>重新授权并重试失败项</button>}</div></section>}{activeReframeBatch && <section className="batch-status reframe-batch-status"><h3>重构图批次{activeReframeBatch.status}</h3><p>目录：{activeReframeBatch.directory_display_name}</p>{activeReframeBatch.items.map(item => <div key={item.reframe_export_batch_item_id}><strong>{item.rendition_reframe_snapshot.platform_preset_id} · {item.rendition_reframe_snapshot.rendition_preset_id}</strong><small>{item.status} · {item.progress === null ? "--" : `${Math.round(item.progress * 100)}%`}{item.destination_display_name ? ` · ${item.destination_display_name}` : ""}{item.error_code ? ` · ${item.error_code}` : ""}</small></div>)}<div className="modal-actions">{["queued", "running"].includes(activeReframeBatch.status) && <button onClick={() => void window.desktop.cancelReframeExportBatch(activeReframeBatch.reframe_export_batch_id).then(setActiveReframeBatch).catch(() => setReframeError("取消重构图批次失败。"))}>取消重构图批次</button>}{activeReframeBatch.items.some(item => ["failed", "cancelled", "interrupted"].includes(item.status)) && <button onClick={() => void retryReframeBatchItems()}>重新授权并重试重构图失败项</button>}</div></section>}</Dialog>}
    {confirmModel && <Dialog titleId="model-confirm-title" closeLabel="关闭" title="确认下载本地模型" footer={<><button onClick={() => setConfirmModel(undefined)}>暂不下载</button><button disabled={confirmModel.license.acceptance_required && !licenseAccepted} onClick={() => void downloadModel()}>确认并下载</button></>} label="确认下载本地模型" onClose={() => setConfirmModel(undefined)} className="compact-dialog"><h3>{confirmModel.display_name}</h3><p>{confirmModel.purpose}</p><dl><dt>下载大小</dt><dd>{formatBytes(confirmModel.model_size_bytes)}</dd><dt>许可证</dt><dd>{confirmModel.license.name}</dd><dt>隐私</dt><dd>模型在本机运行，不上传媒体或转录正文。</dd></dl>{confirmModel.license.acceptance_required && <label className="check-line"><input type="checkbox" checked={licenseAccepted} onChange={event => setLicenseAccepted(event.target.checked)} />我已阅读并接受该许可证</label>}</Dialog>}
    {transcriptionAsset && <Dialog titleId="transcription-title" closeLabel="关闭" title="创建本地转录" footer={<><button onClick={() => setTranscriptionAsset(undefined)}>取消</button><button onClick={() => void submitTranscription()}>开始转录</button></>} label="创建本地转录" onClose={() => setTranscriptionAsset(undefined)} className="compact-dialog"><p>{transcriptionAsset.display_name}</p><label>语言<select value={language} onChange={event => setLanguage(event.target.value)}><option value="auto">自动检测</option><option value="zh">中文</option><option value="en">English</option></select></label><label className="check-line"><input type="checkbox" checked={wordTimestamps} onChange={event => setWordTimestamps(event.target.checked)} />生成词级时间戳</label></Dialog>}
    {pendingDeleteTranscript && <Dialog titleId="transcript-delete-title" closeLabel="关闭" title="删除转录" footer={<><button className="btn ghost" disabled={deleteTranscriptBusy} onClick={() => setPendingDeleteTranscript(undefined)}>取消</button><button className="btn danger" disabled={deleteTranscriptBusy} onClick={() => void deleteTranscript(pendingDeleteTranscript)}>{deleteTranscriptBusy ? "删除中…" : "删除转录"}</button></>} label="删除转录" onClose={() => setPendingDeleteTranscript(undefined)} className="asset-delete-modal"><p className="confirm-object">确定要删除这条转录吗？</p><div className="warning" id="transcript-delete-desc"><svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg><span>该转录的片段与词级时间戳将一并删除，此操作不可撤销。若其片段已被时间线字幕引用，删除会被拒绝——请先移除相关字幕或片段。</span></div></Dialog>}    {pendingDeleteAsset && <Dialog titleId="asset-delete-title" closeLabel="关闭" title="删除素材" footer={<><button className="btn ghost" disabled={deleteBusy} onClick={() => setPendingDeleteAsset(undefined)}>取消</button><button className="btn danger" disabled={deleteBusy} onClick={() => void deleteAsset(pendingDeleteAsset)}>{deleteBusy ? "删除中…" : "删除素材"}</button></>} label="删除素材" onClose={() => setPendingDeleteAsset(undefined)} className="asset-delete-modal"><p className="confirm-object">确定要删除素材「<strong>{pendingDeleteAsset.display_name}</strong>」吗？</p><div className="warning" id="asset-delete-desc"><svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg><span>如果该素材已添加到时间线，其相关片段（含关联字幕与转场）将一并删除，此操作不可撤销。</span></div></Dialog>}
    {viewingTranscript && <Dialog titleId="transcript-title" closeLabel="关闭" title="原始转录" subtitle={<>{viewingTranscript.language} · {viewingTranscript.provider} · {viewingTranscript.model_revision}</>} footer={<div className="transcript-viewer-actions" style={{ flex: "1 1 auto" }}><button className="append-btn" disabled={!(selectedSegments[viewingTranscript.transcript_id] ?? []).length} onClick={() => insertSegments(viewingTranscript)}>追加所选片段</button><button className="append-btn" disabled={!(selectedSegments[viewingTranscript.transcript_id] ?? []).length} title="把选中片段的字幕文本交给 Provider 改写成更短的字幕" onClick={() => { setCaptionsOptimize({ transcript: viewingTranscript, segmentIds: [...(selectedSegments[viewingTranscript.transcript_id] ?? [])] }); setViewingTranscript(undefined); }}>AI 优化字幕文本</button></div>} label="原始转录" onClose={() => setViewingTranscript(undefined)} className="transcript-viewer"><div className="readonly-note readonly-note--plain">原始 ASR 结果只读。勾选片段后，可追加到时间线或交给 AI 优化字幕文本。</div><div className="transcript-viewer-toolbar"><strong>已选 {(selectedSegments[viewingTranscript.transcript_id] ?? []).length} / {viewingTranscript.segments.length} 段</strong><button className="mini-btn" onClick={() => setSelectedSegments(state => ({ ...state, [viewingTranscript.transcript_id]: viewingTranscript.segments.map(segment => segment.segment_id) }))}>全选</button><button className="mini-btn" onClick={() => setSelectedSegments(state => ({ ...state, [viewingTranscript.transcript_id]: [] }))}>清空</button></div><div className="readonly-segments transcript-selectable-segments">{viewingTranscript.segments.map(segment => <SegmentRow key={segment.segment_id} segment={segment} selected={(selectedSegments[viewingTranscript.transcript_id] ?? []).includes(segment.segment_id)} onToggle={() => setSelectedSegments(state => ({ ...state, [viewingTranscript.transcript_id]: toggle(state[viewingTranscript.transcript_id] ?? [], segment.segment_id) }))} />)}</div></Dialog>}
    {aiOpen && <Dialog titleId="ai-roughcut-title" closeLabel="关闭 AI 粗剪" title="AI 粗剪" subtitle="仅在确认外传内容后调用 Provider。" label="AI 粗剪" onClose={() => setAiOpen(false)} className="ai-roughcut">{aiError && <p className="ai-status" role="status">{aiError}</p>}{aiStep === "form" && <><label>主题<input value={aiForm.topic} onChange={e => setAiForm(v => ({ ...v, topic: e.target.value }))} /></label><label>受众<input value={aiForm.audience} onChange={e => setAiForm(v => ({ ...v, audience: e.target.value }))} /></label><label>叙事目标<textarea value={aiForm.narrative_goal} onChange={e => setAiForm(v => ({ ...v, narrative_goal: e.target.value }))} /></label><label>风格说明<textarea value={aiForm.style_notes} onChange={e => setAiForm(v => ({ ...v, style_notes: e.target.value }))} /></label><label>制作配方<select value={aiForm.recipe_id} onChange={e => setAiForm(v => ({ ...v, recipe_id: e.target.value }))}><option value="">选择配方</option>{aiRecipes.map(item => <option key={item.recipe_id} value={item.recipe_id}>{item.name ?? item.display_name} · {item.summary}</option>)}</select></label><label>Provider<select value={aiForm.provider_id} onChange={e => setAiForm(v => ({ ...v, provider_id: e.target.value }))}><option value="">选择 Provider</option>{aiProviders.map(item => <option key={item.provider_config_id} value={item.provider_config_id} disabled={!item.enabled || item.credential_status !== "configured" || item.candidate_capability_status !== "supported"}>{item.display_name} · {item.candidate_capability_status === "supported" ? "AI 粗剪可用" : item.candidate_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 粗剪"}</option>)}</select></label><div className="provider-capability-list">{aiProviders.map(item => <div key={item.provider_config_id}><span>{item.display_name} · {item.candidate_capability_status === "supported" ? "AI 粗剪可用" : item.candidate_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 粗剪"}</span><button disabled={aiCapabilityTesting} onClick={() => void testCandidateProviderCapability(item.provider_config_id)}>{aiCapabilityTesting ? "正在测试兼容性" : "测试 AI 粗剪兼容性"}</button></div>)}</div><p className="readonly-note readonly-note--plain">Provider 的创建、密钥与连接测试已移至「Provider 设置」（工具菜单 / 设置）。<button className="mini-btn" onClick={() => { setProviderSettingsOpen(true); }}>打开 Provider 设置</button></p><label>就绪转录<select value={aiForm.transcript_id} onChange={e => setAiForm(v => ({ ...v, transcript_id: e.target.value }))}><option value="">选择已就绪转录</option>{Object.values(transcriptSummaries).flat().filter(item => item.status === "ready").map(item => <option key={item.transcript_id} value={item.transcript_id}>{item.language} · 就绪</option>)}</select></label><label>召回来源<select value={aiForm.candidate_source} onChange={e => setAiForm(v => ({ ...v, candidate_source: e.target.value as "auto" | "transcript" | "cv" | "fused" }))}><option value="auto">自动（有转录用转录，否则 CV）</option><option value="transcript">仅转录</option><option value="cv">仅画面（CV）</option><option value="fused">融合（转录 + 画面 + 节拍）</option></select></label><p className="readonly-note">「融合」会把转录关键词、画面特征与节拍落拍三项综合排序。<strong>权重为等权且尚未调优</strong>，不代表优劣已评测。</p><div className="modal-actions"><button disabled={!aiForm.topic || !aiForm.audience || !aiForm.narrative_goal || !aiForm.provider_id || !aiForm.recipe_id || !aiForm.transcript_id || aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.candidate_capability_status !== "supported" || aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.credential_status !== "configured" || !aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.enabled} onClick={() => void prepareAi()}>准备外传确认</button></div></>}{aiStep === "confirm" && aiPreview && <><h3>确认发送的精确内容</h3>
<dl className="egress-meta">
  <dt>发送给谁</dt><dd>{aiPreview.provider.origin} · {aiPreview.provider.model}</dd>
  <dt>发什么</dt><dd>{aiPreview.sent_fields.join("、")}</dd>
  <dt>规模</dt><dd>{aiPreview.stats.segment_count} 段 / {aiPreview.stats.character_count} 字 · 估算 {aiPreview.stats.estimated_tokens} Token</dd>
  <dt>费用</dt><dd className="egress-cost">按 Provider 配置单价估算，最终以服务商账单为准</dd>
  <dt>凭据</dt><dd className="egress-hash">{aiPreview.payload_sha256}</dd>
  <dt>有效期</dt><dd>{aiPreview.expires_at}</dd>
</dl>
<div className="egress-text">{Array.isArray(aiPreview.payload.segments) && (aiPreview.payload.segments as Array<Record<string, unknown>>).map(segment => <p key={String(segment.segment_ref)}>{String(segment.text)}</p>)}</div>
{/* 外发是隐私边界：勾选框紧贴内容预览，不与底栏按钮混排——
    混排时用户会跳过勾选直接点按钮。 */}
<div className="egress-confirm">
  <p className="egress-warn">这不是匿名化：Provider 会看到上述全部文本。画面与时间码不会离开本机。</p>
  <label><input type="checkbox" checked={aiEgressConfirmed} onChange={event => setAiEgressConfirmed(event.target.checked)} aria-label="我已核对以上外发内容" />我已核对以上内容，同意发送给该 Provider</label>
</div>
<div className="modal-actions"><button onClick={() => { setAiPreview(undefined); setAiStep("form"); setAiEgressConfirmed(false); }}>返回修改</button><button className="danger" disabled={!aiEgressConfirmed} onClick={() => void createAi()}>我确认发送以上内容</button></div></>}{aiStep === "running" && <><h3>正在生成候选方案</h3><p>任务进度与取消操作沿用现有任务中心；如失败或取消，请重新准备并再次确认。</p></>}{aiStep === "candidates" && <><h3>三个候选方案</h3><div className="candidate-columns">{(["balanced", "compact", "bold"] as const).map((variant, index) => { const item = aiCandidates.find(candidate => candidate.variant === variant); const title = ["稳妥版", "紧凑版", "高能版"][index]; return <section key={variant}><h4>{title}</h4>{item ? <><strong>{String(item.title_suggestion)}</strong><p>{String(item.summary)}</p><small>{Number(item.duration_us) / 1_000_000}s · 模型参考</small>{Array.isArray(item.clips) && (item.clips as Array<Record<string, unknown>>).map(clip => <div className="candidate-clip" key={String(clip.clip_id)}><span>{Number(clip.source_start_us) / 1_000_000}s–{Number(clip.source_end_us) / 1_000_000}s</span><button onClick={() => void playAiClip(clip)}>试播片段</button><p>{String(clip.reason)}</p></div>)}<button onClick={() => void adoptAi(item)}>采用此方案</button></> : <p>等待有效响应</p>}</section>; })}</div>{aiPlayback && <video className="candidate-player" src={aiPlayback.media_url} controls autoPlay onLoadedMetadata={e => { e.currentTarget.currentTime = aiPlayback.source_start_us / 1_000_000; }} onTimeUpdate={e => { if (e.currentTarget.currentTime >= aiPlayback.source_end_us / 1_000_000) e.currentTarget.pause(); }} />}</>}</Dialog>}
     {aiOpen && aiStep === "running" && <section className="ai-job-progress" aria-live="polite" aria-label="AI 粗剪任务进度"><strong>阶段：{aiJob?.stage ?? "queued"}</strong><span>进度：{Math.round((aiJob?.progress ?? 0) * 100)}%</span><progress aria-label="AI 粗剪进度" max="1" value={aiJob?.progress ?? 0} /><button disabled={!aiJob || !["queued", "running", "cancelling"].includes(aiJob.status)} onClick={() => { if (!aiJob) return; void window.desktop.cancelJob(aiJob.job_id).then(job => { setAiJob(job); setAiPreview(undefined); setAiCandidates([]); setAiPlayback(undefined); setAiStep("form"); setAiError("生成已取消。请重新准备外传内容并再次确认。"); }).catch(() => setAiError("取消请求失败；请等待当前任务状态刷新。")); }}>取消生成</button></section>}
    {patchOpen && <Dialog titleId="planning-patch-title" closeLabel="关闭 AI 修改" title="AI 修改" subtitle="提案不会自动修改正式 Timeline。" label="AI 修改" onClose={closePatch} className="planning-patch">{patchError && <p className="ai-status" role="status">{patchError}</p>}{patchStep === "form" && <><label>修改指令<textarea aria-label="修改指令" maxLength={4000} value={patchInstruction} onChange={event => setPatchInstruction(event.target.value)} /></label><label>Provider<select aria-label="AI 修改 Provider" value={patchProviderId} onChange={event => setPatchProviderId(event.target.value)}><option value="">选择已配置 Provider</option>{patchProviders.map(item => <option value={item.provider_config_id} key={item.provider_config_id} disabled={item.timeline_patch_capability_status !== "supported"}>{item.display_name} · {item.model} · {item.timeline_patch_capability_status === "supported" ? "AI 修改可用" : item.timeline_patch_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 修改"}</option>)}</select></label><div className="provider-capability-list">{patchProviders.map(item => <div key={item.provider_config_id}><span>{item.display_name} · {item.timeline_patch_capability_status === "supported" ? "AI 修改可用" : item.timeline_patch_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 修改"}</span><button disabled={patchCapabilityTesting} onClick={() => void testPatchProviderCapability(item.provider_config_id)}>{patchCapabilityTesting ? "正在测试兼容性" : "测试 AI 修改兼容性"}</button></div>)}</div><div className="modal-actions"><button disabled={!patchProviderId || !patchInstruction.trim() || patchProviders.find(item => item.provider_config_id === patchProviderId)?.timeline_patch_capability_status !== "supported"} onClick={() => void preparePatch()}>准备外传确认</button></div></>}{patchStep === "confirm" && patchPreview && <><h3>确认本次外传</h3><div className="instruction-preview"><strong>你的本地指令</strong><p>{patchInstruction}</p></div><dl className="egress-meta">
  <dt>发送给谁</dt><dd>{patchPreview.provider.display_name} · {patchPreview.provider.origin} · {patchPreview.provider.model}</dd>
  <dt>发什么</dt><dd>{patchPreview.sent_fields.join("、")}</dd>
  <dt>规模</dt><dd>{patchPreview.clip_count} Clip / {patchPreview.caption_count} Caption / {patchPreview.locked_count} 锁定 · {patchPreview.character_count} 字 / 估算 {patchPreview.estimated_tokens} Token</dd>
  <dt>费用</dt><dd className="egress-cost">最终费用以 Provider 账单为准</dd>
  <dt>凭据</dt><dd className="egress-hash">{patchPreview.payload_sha256}</dd>
</dl>
<p className="readonly-note">上方指令来自当前本地输入；Core 确认 DTO 不包含正文。</p>
<div className="egress-confirm">
  <p className="egress-warn">这不是匿名化：Provider 会看到上述字段。正文与时间码不会离开本机。</p>
  <label><input type="checkbox" checked={patchEgressConfirmed} onChange={event => setPatchEgressConfirmed(event.target.checked)} aria-label="我已核对以上外发内容" />我已核对以上内容，同意发送给该 Provider</label>
</div>
<div className="modal-actions"><button onClick={() => { setPatchPreview(undefined); setPatchStep("form"); setPatchEgressConfirmed(false); }}>返回修改</button><button className="danger" disabled={!patchEgressConfirmed} onClick={() => void createPatch()}>确认并发送一次</button></div></>}{patchStep === "running" && <><h3>正在生成提案</h3><p>{patchJob?.stage ?? "queued"} · {Math.round((patchJob?.progress ?? 0) * 100)}%</p><progress max="1" value={patchJob?.progress ?? 0} /><div className="modal-actions"><button disabled={!patchJob || !["queued", "running", "cancelling"].includes(patchJob.status)} onClick={() => void cancelPatch()}>取消生成</button></div></>}{patchStep === "proposal" && patchProposal && <><h3>提案差异</h3><TimelineDiffView diff={patchProposal.diff} /><div className="modal-actions"><button onClick={closePatch}>放弃</button><button disabled={patchProposal.applied_revision_id !== null} onClick={() => void applyPatchProposal()}>应用修改</button></div></>}</Dialog>}
    {generationOpen && project && <MediaGenerationWorkbench key={project.project_id} project={project} assets={assets} onClose={() => setGenerationOpen(false)} />}
    {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onNotify={message => showNotice(message, "info")} onOpenProviderSettings={() => setProviderSettingsOpen(true)} />}
    {providerSettingsOpen && <ProviderSettingsDialog providers={mergedProviders} onProvidersChange={setAiProviders} onClose={() => setProviderSettingsOpen(false)} onNotify={message => showNotice(message, "info")} />}
    {captionsOptimize && project && <CaptionsProviderPanel projectId={project.project_id} baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null} providers={mergedProviders} transcript={captionsOptimize.transcript} segmentIds={captionsOptimize.segmentIds} onClose={() => setCaptionsOptimize(undefined)} onApplied={() => { void loadRenderData(project); }} onNotify={message => showNotice(message, "info")} />}
    {agentOpen && project && <AgentSessionPanel projectId={project.project_id} baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null} providers={mergedProviders} onClose={() => setAgentOpen(false)} onNotify={message => showNotice(message, "info")} />}
    {worklistOpen && project && <WorklistPanel key={project.project_id} projectId={project.project_id} baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null} onClose={() => setWorklistOpen(false)} onApplied={() => { void window.desktop.getTimeline(project.project_id).then(state => { acceptState(state); }); }} onNotify={message => showNotice(message, "success")} />}
    {cvOptionsOpen && cvOptionsAsset && <Dialog titleId="cv-density-title" title="AI 信号分析" subtitle="本地零外传。可选密度旋钮：留空则用默认（目标间隔 4s、预算 10s/分钟源）。" closeLabel="关闭 AI 信号分析" footer={<>
        <button onClick={() => { startCvAnalysis(cvOptionsAsset); setCvOptionsOpen(false); setCvOptionsAsset(null); }}>使用默认设置</button>
        <button onClick={submitCvOptions}>按上述设置分析</button>
      </>} label="AI 信号分析" onClose={() => { setCvOptionsOpen(false); setCvOptionsAsset(null); }} className="cv-density">
      <label>目标采样间隔（秒，可选）<input aria-label="目标采样间隔秒" type="number" min={0.1} max={60} step={0.1} value={cvTargetGapS} onChange={event => setCvTargetGapS(event.target.value)} placeholder="默认 4" /></label>
      <label>每分钟预算（秒，可选）<input aria-label="每分钟预算秒" type="number" min={1} max={120} step={1} value={cvBudgetPerMin} onChange={event => setCvBudgetPerMin(event.target.value)} placeholder="默认 10" /></label>
      <p className="readonly-note readonly-note--plain">间隔越小越密；预算不足时自动退到预算内尽量密，并如实标记密度。</p>
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
    {angleSyncOpen && project && <AngleSyncPanel
      projectId={project.project_id}
      assets={assets}
      onClose={() => setAngleSyncOpen(false)}
      onNotify={message => showNotice(message, "success")}
    />}
    {semanticSearchOpen && project && <SemanticSearchPanel
      projectId={project.project_id}
      assetNames={semanticAssetNames}
      assets={assets}
      onClose={() => setSemanticSearchOpen(false)}
    />}
    {keyframeReviewOpen && project && <KeyframeReviewPanel
      projectId={project.project_id}
      assetId={(selectedAssetId ?? null) as AssetId | null}
      assetName={semanticAssetNames[selectedAssetId ?? ""] ?? "（未在素材库中选择素材）"}
      onClose={() => setKeyframeReviewOpen(false)}
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
    {revisionOpen && <Dialog titleId="revision-compare-title" closeLabel="关闭版本比较" title="版本比较" subtitle="只读操作，不改变当前 Revision、草稿或渲染记录。" footer={<><button disabled={!revisionPair.base || !revisionPair.target || revisionPair.base === revisionPair.target} onClick={() => void compareRevisions()}>比较</button></>} label="版本比较" onClose={() => { setRevisionOpen(false); setRevisionDiff(undefined); }} className="revision-compare"><div className="revision-selectors"><label>基线<select aria-label="基线 Revision" value={revisionPair.base} onChange={event => setRevisionPair(value => ({ ...value, base: event.target.value }))}>{revisions.map(item => <option value={item.timeline_revision_id} key={`base-${item.timeline_revision_id}`}>{item.summary} · {item.created_at}</option>)}</select></label><label>目标<select aria-label="目标 Revision" value={revisionPair.target} onChange={event => setRevisionPair(value => ({ ...value, target: event.target.value }))}>{revisions.map(item => <option value={item.timeline_revision_id} key={`target-${item.timeline_revision_id}`}>{item.summary} · {item.created_at}</option>)}</select></label></div>{revisionDiff && <TimelineDiffView diff={revisionDiff} />}</Dialog>}
       {renderPanelOpen && <Dialog titleId="render-panel-title" closeLabel="关闭渲染与导出" title="渲染与导出" subtitle="任务为本次会话的过程记录；导出产物为持久记录，关闭后任务继续在后台推进。" label="渲染与导出" onClose={() => setRenderPanelOpen(false)} className="render-panel-dialog">
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
    {commandSearchOpen && <Dialog titleId="command-search-title" title="命令搜索" subtitle="输入命令名过滤；↑↓ 选择 · Enter 执行 · Esc 关闭。" footer={<div className="command-footer"><div className="key-hints"><span><kbd>↑↓</kbd>选择</span><span><kbd>↵</kbd>执行</span><span><kbd>esc</kbd>关闭</span></div></div>} label="命令搜索" onClose={closeCommandSearch} className="command-palette">
      <div className="search-wrap">
        <Search className="icon" size={16} aria-hidden="true" />
        <input ref={commandSearchInputRef} type="search" aria-label="命令搜索" aria-controls="command-list" aria-activedescendant={filteredCommands[commandIndex] ? `command-option-${filteredCommands[commandIndex].id}` : undefined} placeholder="输入命令名称…" value={commandQuery} onChange={event => { setCommandQuery(event.target.value); setCommandIndex(0); }} onKeyDown={handleCommandPaletteKeyDown} />
      </div>
      <ul role="listbox" aria-label="命令列表" id="command-list" className="command-list">
        {filteredCommands.map((command, index) => { const reason = commandDisabledReason(command.id); const group = command.group; const shownGroup = index === 0 || filteredCommands[index - 1].group !== group; return <Fragment key={command.id}>{shownGroup && <li className="command-group" role="presentation">{group}</li>}<li id={`command-option-${command.id}`} role="option" aria-selected={index === commandIndex} className={index === commandIndex ? "active" : ""}><button className="command-option" disabled={Boolean(reason)} onClick={() => { if (!reason) { runCommand(command.id); closeCommandSearch(); } }}>{(() => { const Icon = COMMAND_ICON_MAP[command.id]; return Icon ? <Icon className="icon" size={14} aria-hidden="true" /> : <span className="icon" aria-hidden="true" />; })()}<span className="command-label">{command.label}</span>{(shortcutsRef.current as Record<string, ShortcutEntry> | undefined)?.[command.id as ShortcutCommandId] ? <kbd className="command-shortcut">{bindingLabel((shortcutsRef.current as Record<string, ShortcutEntry>)[command.id as ShortcutCommandId].binding)}</kbd> : <kbd className="command-shortcut" aria-hidden="true" />}<span className={reason ? "command-reason" : "command-state"}>{reason ?? "可用"}</span></button></li></Fragment>; })}
        {filteredCommands.length === 0 && <li className="command-empty">没有匹配的命令</li>}
      </ul>
    </Dialog>}
    {shortcutsOpen && <Dialog titleId="shortcuts-title" closeLabel="关闭快捷键设置" title="快捷键设置" subtitle={<>点击"录制"后按下新键位；Ctrl+Shift+Z（重做）与 Backspace（删除）为固定别名，不参与自定义。</>} footer={<><button onClick={() => { applyShortcuts(structuredClone(DEFAULT_SHORTCUTS)); setRecordingId(null); showNotice("已恢复默认快捷键。"); }}>恢复默认</button></>} label="快捷键设置" onClose={() => { setShortcutsOpen(false); setRecordingId(null); }} className="shortcuts-dialog">
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
    </Dialog>}
</main>;
}

