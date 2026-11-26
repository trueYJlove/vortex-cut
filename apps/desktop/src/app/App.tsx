import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Clapperboard, Command as CommandIcon, FlaskConical, FolderCog, GitCompare, Image as ImageIcon, Keyboard, LayoutPanelLeft, MonitorPlay, Redo2, RefreshCw, Scissors, Search, Sparkles, SquarePlus, Undo2, Upload, Video, WandSparkles } from "lucide-react";
import type { Job, ModelSummary, Project, TimelineClip, TimelineDocument, TimelinePatchOperation, TimelineRevisionId, TimelineState } from "@aivideo/contracts";
import { CONTRACT_VERSION } from "@aivideo/contracts";
import { alignmentBox, alignmentPreviewSize, groupFrameBounds, planFrameAlignment, planFrameDistribution, planGroupBoundsEdit, type GroupBoundsField } from "./timeline/frame-alignment.js";
import type { AlignDistribution, AlignEdge } from "../ui/of/AlignBar.js";
import { errorCode, safeErrorMessage } from "./safeErrors.js";
import { PreviewPipOverlays, type PipOverlay, type PipTransform } from "./PreviewPipOverlays.js";
import {
  createEditorCommandDispatcher,
  editorCommands,
  type ClipboardClipSnapshot,
  type CommandRuntimeContext,
  type EditorCommand,
} from "./editorCommands.js";
import { TimelinePanel } from "./timeline/TimelineCanvas.js";
import { parseSubtitleFile } from "./subtitleImport.js";
import { AssetSelectionProperties, ClipGroupAlignmentProperties, ClipProperties, CaptionProperties, ProjectProperties, TransitionProperties } from "./PropertyPanels.js";
import { WorkspaceFooter } from "./workspace/WorkspaceFooter.js";
import {
  assetDurationLabel,
  assetKindLabels,
  assetMetaText,
  availabilityLabels,
  jobKindLabels,
  type Notice,
  type NoticeTone,
  type SaveState,
  type Selection,
} from "./appHelpers.js";
import { EditorTitlebar, type MenuEntry } from "./layout/EditorTitlebar.js";
import { LibraryPane } from "./layout/LibraryPane.js";
import { PreviewStage } from "./layout/PreviewStage.js";
import { AppDialogs } from "./layout/AppDialogs.js";
import { useWorkspaceLayout } from "./hooks/useWorkspaceLayout.js";
import { useAiWorkflows } from "./hooks/useAiWorkflows.js";
import { useExportAndRender } from "./hooks/useExportAndRender.js";
import { useAssetAndMediaLibrary } from "./hooks/useAssetAndMediaLibrary.js";
import { usePreviewPlayback } from "./hooks/usePreviewPlayback.js";
import { useStageViewport } from "./hooks/useStageViewport.js";
import { useShortcuts } from "./hooks/useShortcuts.js";
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
  const assetLibrary = useAssetAndMediaLibrary({
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
    assets, setAssets, assetsRef, assetsMirrorTruncatedRef,
    assetQuery, setAssetQuery, assetFilter, setAssetFilter,
    libraryScope, changeLibraryScope, setAssetFavorites, favoriteAssetIds,
    assetView, changeAssetView, assetSortByName, setAssetSortByName,
    semanticAssetNames, visibleAssets, setTranscriptSummaries,
    transcriptSummaryQueueRef, visibleAssetOrder,
    selectedAssetIds, selectedAssetId, assetMenu, setAssetMenu, menuAsset,
    resetAssetSelection, selectAsset, setPickedAssetIds, setPendingDeleteAsset, refreshingAssets,
    setCvOptionsOpen, setCvOptionsAsset, setCvTargetGapS, setCvBudgetPerMin,
    cvSummaries, cvBusy, cvSparkAssetId, cvSparkSamples,
    resetAssetLibraryOnSwitch, isDraggableAsset, dropAsset,
    importAsset, refreshAssets, deleteJob, usedAssetIds, cvSummaryText, toggleCvSpark,
    revealAsset, assetDragProps, openModel, cancelModel,
    startTranscription, retryTranscription, cancelJob,
    openDeleteTranscriptDialog, viewTranscript, loadedTranscript, transcriptRows,
  } = assetLibrary;
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
  const exportRender = useExportAndRender({
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
    coverUrl, setCoverUrl, encoderMode, setEncoderMode,
    setExportDialogOpen, setCoverDialogOpen,
    setExports, exportPlayback, setExportPlayback,
    setRenderPanelOpen, renderPanelOpenRef,
    reframePlayback, setReframePlayback,
    syntheticSnapshotRef, loadRenderData, resetRenderOnProjectSwitch, resetReframeOnProjectChange,
    trackRenderJob, generatePreview,
    openExportDialog, createExport, openExportBatch,
    authoritativePreview, previewIsStale, authoritativeMediaUrl, renderDisabledReason, renderActivity,
  } = exportRender;
  const aiWorkflows = useAiWorkflows({
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
    setRevisionOpen, setRevisionDiff, resetAiOnProjectSwitch,
    openAi, closePatch, openPatch, openRevisionCompare,
  } = aiWorkflows;
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
    const result = await commandDispatcher.dispatch("timeline.patch", {
      operations,
      summary,
      ...(base ? { baseRevisionId: base.current_revision.timeline_revision_id } : {}),
    });
    return result.ok;
  };
  // 文本素材（剪映式）：默认文本 = 在播放头处插入 3s 手工字幕；
  // 导入本地字幕 = 解析 SRT/ASS/SSA/LRC 为条目批量落库（可替换旧手工字幕）。
  const insertDefaultText = async () => {
    const result = await commandDispatcher.dispatch("timeline.addCaption", {
      startUs: Math.round(playhead),
      endUs: Math.round(playhead) + 3_000_000,
      text: "默认文本",
      presetId: "default-bottom",
    });
    if (result.ok) setNotice("");
  };
  const importSubtitleFile = async () => {
    if (!project) return;
    try {
      const picked = await window.desktop.importSubtitle();
      if (!picked) return;
      const entries = parseSubtitleFile(picked.file_name, picked.content);
      const hasManual = (working?.captions ?? []).some(caption => caption.origin === "user");
      const result = await commandDispatcher.dispatch("timeline.importCaptions", {
        fileName: picked.file_name,
        entries,
        presetId: "default-bottom",
        replaceExisting: hasManual,
      });
      if (result.ok) setNotice("");
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
    const result = await commandDispatcher.dispatch("timeline.create", { source });
    return result.ok ? (result.data as { timelineState?: TimelineState }).timelineState : undefined;
  };
  const overlayClipSelected = Boolean(selectedClip && selectedClip.asset_kind !== "audio" && trackById.get(selectedClip.track_id)?.kind === "video");
  const showSelBox = !overlayClipSelected;
  const {
    previewRatio, previewZoom, isViewerFit,
    stageMarquee, previewClickGuardRef, previewFrameRef,
    isFullscreen, stagePaneRef, stageColumnRef,
    canvasRef, selBoxRef, canvasSize, selDimsText,
    effectiveRatio, renderRatio, previewClass,
    changePreviewRatio, zoomT, resetZoom, applySliderZoom, toggleFullscreen,
    onPreviewPointerDown, onPreviewPointerMove, onPreviewPointerUp, onPreviewPointerCancel, onPreviewKeyDown,
    beginSelDrag, moveSelDrag, endSelDrag,
  } = useStageViewport({
    project,
    working,
    previewMode,
    trackById,
    tracksAtPlayhead,
    selectedClipIds,
    showSelBox,
    getOverlayPips: () => overlayPips,
    setSelection,
    patchTimeline: (operations, summary) => patchTimeline(operations, summary),
    showNotice: (text, tone) => showNotice(text, tone),
  });
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
  const pipLocked = pipSelectedId ? Boolean(working?.locked_elements?.includes(pipSelectedId)) : false;
  // 应用内剪贴板（M2 A3）：复制 V1 视频片段快照，粘贴回放到播放头。
  const clipboardClips = useRef<ClipboardClipSnapshot[]>([]);
  const insertableClipboardAssets = (snapshots: ClipboardClipSnapshot[]) => snapshots.filter(item => {
    const asset = assets.find(candidate => candidate.asset.asset_id === item.asset_id);
    return Boolean(asset && (item.asset_kind === "image" || asset.asset.availability === "available"));
  });
  // 点击预览画面：选中播放头处的片段（剪映式选中），无片段时清空选择。
  const selectClipAtPlayhead = () => {
    if (previewMode === "synthetic") return;
    if (previewClickGuardRef.current) { previewClickGuardRef.current = false; return; }
    exitLibraryPreview();
    setSelection(clipAtPlayhead ? { kind: "clip", id: clipAtPlayhead.clip_id } : null);
  };
  const previewSelected = Boolean(selectedClip && !libraryPreviewId);
  const undoRedoInFlight = useRef(false);
  const undoRedo = (kind: "undo" | "redo") =>
    commandDispatcher.dispatch(kind === "undo" ? "timeline.undo" : "timeline.redo", {});
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

  const commandContextRef = useRef<CommandRuntimeContext>(null!);
  commandContextRef.current = {
    project,
    isCurrentProject: projectId => projectRef.current?.project_id === projectId,
    timeline,
    working,
    selectedClips,
    selectedCaption,
    trackById,
    visualClips,
    previewAssetMediaUrl: previewAsset?.media_url,
    playhead,
    playheadStore,
    clipboardClips: clipboardClips.current,
    setClipboardClips: next => { clipboardClips.current = next; },
    areClipboardAssetsInsertable: snapshots => insertableClipboardAssets(snapshots).length === snapshots.length,
    undoRedoInFlightRef: undoRedoInFlight,
    acceptState,
    clearPendingDraft: () => {
      pendingDraftRef.current = null;
      if (draftTimer.current) clearTimeout(draftTimer.current);
    },
    setSaveState,
    handleConflict,
    showNotice,
    togglePlayback,
    exitLibraryPreview,
    seekFromUser,
    seekWhileScrubbing,
    renderDisabledReason,
    generatePreview: options => generatePreview(options),
    createExport: payload => createExport(payload),
    openRenderPanel: () => setRenderPanelOpen(true),
    openAi: () => openAi(),
    openPatch: () => openPatch(),
    openProjectManager: () => setProjectDialogOpen(true),
    refreshProjects: () => refreshProjects(),
    resetLayout: () => { setLeftWidth(320); setRightWidth(300); setTimelineHeight(230); },
    openShortcuts: () => setShortcutsOpen(true),
    openRevisionCompare: () => openRevisionCompare(),
    openShotRequirements: () => setShotRequirementsOpen(true),
    openGeneration: () => setGenerationOpen(true),
    openImageGeneration: () => setProviderImageGenerationOpen(true),
    openCommandSearch: () => setCommandSearchOpen(true),
  };
  const commandDispatcher = useMemo(() => createEditorCommandDispatcher(() => commandContextRef.current), []);

  const commandDisabledReason = (id: EditorCommand["id"]): string | undefined => commandDispatcher.disabledReason(id);

  const runCommand = (id: EditorCommand["id"]) => {
    void commandDispatcher.dispatch(id, {});
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

  const {
    shortcuts,
    shortcutsRef,
    shortcutsOpen,
    setShortcutsOpen,
    recordingId,
    setRecordingId,
    resetShortcutsToDefault,
    handleRecordKey,
    menuShortcut,
  } = useShortcuts({
    commandSearchOpen,
    dispatchCommand: (id, payload) => commandDispatcher.dispatch(id, payload),
    showNotice: (text, tone) => showNotice(text, tone),
  });

  const menuItems: Record<string, MenuEntry[]> = {
    项目: [{ label: "项目管理", icon: FolderCog, action: () => setProjectDialogOpen(true) }, { label: "刷新项目", icon: RefreshCw, action: () => void refreshProjects() }],
    编辑: [{ label: "撤销", icon: Undo2, action: () => void undoRedo("undo"), disabled: Boolean(commandDisabledReason("timeline.undo")) }, { label: "重做", icon: Redo2, action: () => void undoRedo("redo"), disabled: Boolean(commandDisabledReason("timeline.redo")) }],
    时间线: [{ label: "创建空时间线", icon: SquarePlus, action: () => void createTimeline({ kind: "empty" }), disabled: Boolean(commandDisabledReason("timeline.create")) }, { divider: true }, { label: "拆分所选片段", icon: Scissors, action: () => runCommand("timeline.split"), disabled: Boolean(commandDisabledReason("timeline.split")) }, { label: "生成预览", icon: MonitorPlay, action: () => runCommand("preview.generate"), disabled: Boolean(commandDisabledReason("preview.generate")) }, { label: "导出", icon: Upload, action: () => runCommand("export.open"), disabled: Boolean(commandDisabledReason("export.open")) }],
    界面: [{ label: "恢复默认布局", icon: LayoutPanelLeft, action: () => { setLeftWidth(320); setRightWidth(300); setTimelineHeight(230); } }, { label: "命令搜索", icon: CommandIcon, action: () => setCommandSearchOpen(true) }, { label: "快捷键设置", icon: Keyboard, action: () => setShortcutsOpen(true) }],
    工具: [{ group: "AI" }, { label: "Provider 设置", icon: FolderCog, action: () => setProviderSettingsOpen(true) }, { label: "AI 助手", icon: WandSparkles, action: () => setAgentOpen(true), disabled: !project }, { label: "AI 工作单", icon: WandSparkles, action: () => setWorklistOpen(true), disabled: !project }, { label: "AI 粗剪", icon: Sparkles, action: () => void openAi(), disabled: Boolean(commandDisabledReason("ai.open")) }, { label: "AI 修改", icon: WandSparkles, action: () => void openPatch(), disabled: Boolean(commandDisabledReason("ai.revise")) }, { label: "剪辑手法", icon: Scissors, action: () => openEditingTools("remove_pauses"), disabled: !project }, { label: "机位同步", icon: Video, action: () => setAngleSyncOpen(true), disabled: !project }, { label: "素材语义检索", icon: Search, action: () => setSemanticSearchOpen(true), disabled: !project }, { label: "关键帧外传审阅", icon: ImageIcon, action: () => setKeyframeReviewOpen(true), disabled: !project || !selectedAssetId }, { label: "剪辑语法（高级）", icon: Scissors, action: () => { setEditingToolsTool(null); setEditingGrammarOpen(true); }, disabled: !project }, { label: "版本比较", icon: GitCompare, action: () => void openRevisionCompare(), disabled: Boolean(commandDisabledReason("tools.compare")) }, { divider: true }, { label: "镜头需求", icon: Clapperboard, action: () => setShotRequirementsOpen(true), disabled: Boolean(commandDisabledReason("tools.shots")) }, { label: "生成验证（模拟）", icon: FlaskConical, action: () => setGenerationOpen(true), disabled: Boolean(commandDisabledReason("tools.verify")) }, { label: "真实图片生成", icon: ImageIcon, action: () => setProviderImageGenerationOpen(true), disabled: Boolean(commandDisabledReason("tools.imageGen")) }],
    帮助: [{ label: "用户使用手册", icon: BookOpen, action: () => showNotice("请查看 docs/requirements/VORTEX_CUT_USER_MANUAL.md", "info") }]
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
    <EditorTitlebar
      project={project}
      projects={projects}
      openProjects={openProjects}
      switchProject={switchProject}
      closeProjectTab={closeProjectTab}
      onOpenProjectDialog={() => setProjectDialogOpen(true)}
      activeMenu={activeMenu}
      setActiveMenu={setActiveMenu}
      appMenuTriggerRef={appMenuTriggerRef}
      appMenuCategoryRefs={appMenuCategoryRefs}
      appMenuPopoverRef={appMenuPopoverRef}
      menuItems={menuItems}
      menuShortcut={menuShortcut}
      projectSwitcherOpen={projectSwitcherOpen}
      setProjectSwitcherOpen={setProjectSwitcherOpen}
      projectSwitcherQuery={projectSwitcherQuery}
      setProjectSwitcherQuery={setProjectSwitcherQuery}
      projectSwitcherRef={projectSwitcherRef}
    />
    <div className="banner-stack">{notice !== "" && <div className={`notice notice-${notice.tone}`} role="alert">{notice.text}</div>}{timeline?.draft && <div className="draft-banner"><span>{timeline.draft.conflict ? "检测到冲突草稿" : "检测到上次未恢复草稿"}</span><button disabled={timeline.draft.conflict} onClick={() => { setWorking(timeline.draft!.document); setSaveState("已保存"); }}>恢复</button><button onClick={() => void (async () => { await window.desktop.deleteTimelineDraft(project!.project_id); setTimeline({ ...timeline, draft: null }); })()}>丢弃</button></div>}</div>
    <div className={`editor-workspace${leftPaneOpen ? "" : " library-closed"}`}>
      <LibraryPane
        leftPaneOpen={leftPaneOpen}
        tab={tab}
        setTab={setTab}
        project={project}
        timeline={timeline}
        assets={assets}
        visibleAssets={visibleAssets}
        visibleAssetOrder={visibleAssetOrder}
        models={models}
        jobs={jobs}
        libraryScope={libraryScope}
        changeLibraryScope={changeLibraryScope}
        assetFilter={assetFilter}
        setAssetFilter={setAssetFilter}
        assetQuery={assetQuery}
        setAssetQuery={setAssetQuery}
        assetView={assetView}
        changeAssetView={changeAssetView}
        assetSortByName={assetSortByName}
        setAssetSortByName={setAssetSortByName}
        refreshingAssets={refreshingAssets}
        refreshAssets={refreshAssets}
        selectedAssetIds={selectedAssetIds}
        selectAsset={selectAsset}
        setPickedAssetIds={setPickedAssetIds}
        resetAssetSelection={resetAssetSelection}
        usedAssetIds={usedAssetIds}
        favoriteAssetIds={favoriteAssetIds}
        setAssetFavorites={setAssetFavorites}
        assetMenu={assetMenu}
        setAssetMenu={setAssetMenu}
        menuAsset={menuAsset}
        isDraggableAsset={isDraggableAsset}
        assetDragProps={assetDragProps}
        previewFromLibrary={previewFromLibrary}
        importAsset={importAsset}
        insertDefaultText={insertDefaultText}
        importSubtitleFile={importSubtitleFile}
        startTranscription={startTranscription}
        cvBusy={cvBusy}
        cvSummaries={cvSummaries}
        cvSparkAssetId={cvSparkAssetId}
        cvSparkSamples={cvSparkSamples}
        cvSummaryText={cvSummaryText}
        toggleCvSpark={toggleCvSpark}
        onOpenCvOptions={item => { setCvOptionsAsset(item); setCvOptionsOpen(true); setCvTargetGapS(""); setCvBudgetPerMin(""); }}
        onOpenEditingTools={() => openEditingTools("remove_pauses")}
        revealAsset={revealAsset}
        setPendingDeleteAsset={setPendingDeleteAsset}
        transcriptRows={transcriptRows}
        loadedTranscript={loadedTranscript}
        viewTranscript={viewTranscript}
        openDeleteTranscriptDialog={openDeleteTranscriptDialog}
        openModel={openModel}
        cancelModel={cancelModel}
        retryTranscription={retryTranscription}
        cancelJob={cancelJob}
        deleteJob={deleteJob}
        onCreateEmptyTimeline={() => void createTimeline({ kind: "empty" })}
      />
      {leftPaneOpen && <div className="resize-handle resize-handle-left" role="separator" aria-label="调整左侧面板宽度" onPointerDown={event => beginResize("left", event)} />}
    <div className="editor-stack">
    <section className={`editor-grid editor-grid-nolib${rightPaneOpen ? "" : " properties-closed"}`}>
      <PreviewStage
        project={project}
        timeline={timeline}
        working={working}
        selection={selection}
        setSelection={setSelection}
        selectedClip={selectedClip}
        clipAtPlayhead={clipAtPlayhead}
        audioAsset={audioAsset}
        previewAsset={previewAsset}
        mainTransformStyle={mainTransformStyle}
        visibleCaption={visibleCaption}
        tracksAtPlayhead={tracksAtPlayhead}
        trackIndexByClipId={trackIndexByClipId}
        isClipAudible={isClipAudible}
        overlayPips={overlayPips}
        overlayClipSelected={overlayClipSelected}
        pipSelectedId={pipSelectedId}
        pipLocked={pipLocked}
        draftPipTransform={draftPipTransform}
        commitPipTransform={commitPipTransform}
        draftPipMask={draftPipMask}
        commitPipMask={commitPipMask}
        leftPaneOpen={leftPaneOpen}
        setLeftPaneOpen={setLeftPaneOpen}
        rightPaneOpen={rightPaneOpen}
        setRightPaneOpen={setRightPaneOpen}
        paneSettingsOpen={paneSettingsOpen}
        setPaneSettingsOpen={setPaneSettingsOpen}
        paneSettingsRef={paneSettingsRef}
        effectiveRatio={effectiveRatio}
        changePreviewRatio={changePreviewRatio}
        encoderMode={encoderMode}
        setEncoderMode={setEncoderMode}
        setRenderPanelOpen={setRenderPanelOpen}
        renderActivity={renderActivity}
        renderRatio={renderRatio}
        previewClass={previewClass}
        previewSelected={previewSelected}
        isViewerFit={isViewerFit}
        previewZoom={previewZoom}
        zoomT={zoomT}
        resetZoom={resetZoom}
        applySliderZoom={applySliderZoom}
        stagePaneRef={stagePaneRef}
        stageColumnRef={stageColumnRef}
        previewFrameRef={previewFrameRef}
        canvasRef={canvasRef}
        selBoxRef={selBoxRef}
        stageMarquee={stageMarquee}
        selDimsText={selDimsText}
        isFullscreen={isFullscreen}
        toggleFullscreen={toggleFullscreen}
        onPreviewPointerDown={onPreviewPointerDown}
        onPreviewPointerMove={onPreviewPointerMove}
        onPreviewPointerUp={onPreviewPointerUp}
        onPreviewPointerCancel={onPreviewPointerCancel}
        onPreviewKeyDown={onPreviewKeyDown}
        selectClipAtPlayhead={selectClipAtPlayhead}
        beginSelDrag={beginSelDrag}
        moveSelDrag={moveSelDrag}
        endSelDrag={endSelDrag}
        previewMode={previewMode}
        setPreviewMode={setPreviewMode}
        authoritativeMediaUrl={authoritativeMediaUrl}
        reframePlayback={reframePlayback}
        setReframePlayback={setReframePlayback}
        exportPlayback={exportPlayback}
        setExportPlayback={setExportPlayback}
        previewIsStale={previewIsStale}
        syntheticNotice={syntheticNotice}
        setSyntheticNotice={setSyntheticNotice}
        projectStateReady={projectStateReady}
        preparePreviewPlaybackRef={preparePreviewPlaybackRef}
        previewSessionRef={previewSessionRef}
        syntheticMediaUrls={syntheticMediaUrls}
        syntheticAudioByClip={syntheticAudioByClip}
        syntheticPipClips={syntheticPipClips}
        previewSourceResolver={previewSourceResolver}
        resourceTier={resourceTier}
        forceCopyTo={forceCopyTo}
        syntheticSnapshotRef={syntheticSnapshotRef}
        proxyReadyEpoch={proxyReadyEpoch}
        onDecodeBudget={onDecodeBudget}
        seenAnyTicketRef={seenAnyTicketRef}
        pausePreviewPlayback={pausePreviewPlayback}
        resumePreviewPlayback={resumePreviewPlayback}
        gestureHoldRef={gestureHoldRef}
        playing={playing}
        setPlaying={setPlaying}
        playhead={playhead}
        playheadStore={playheadStore}
        uiRate={uiRate}
        setUiRate={setUiRate}
        previewReverse={previewReverse}
        interactiveMediaRatePlayable={interactiveMediaRatePlayable}
        libraryPreviewId={libraryPreviewId}
        totalUs={totalUs}
        previewFps={previewFps}
        progressPct={progressPct}
        progressDragging={progressDragging}
        setProgressDragging={setProgressDragging}
        progressRef={progressRef}
        pgBubbleRef={pgBubbleRef}
        pgFillRef={pgFillRef}
        tcTimeRef={tcTimeRef}
        volRailRef={volRailRef}
        videoRef={videoRef}
        audioRef={audioRef}
        togglePlayback={togglePlayback}
        dispatchPlayhead={dispatchPlayhead}
        seekFromPlayback={seekFromPlayback}
        handlePreviewEnded={handlePreviewEnded}
        handleVideoEnded={handleVideoEnded}
        seekFromProgress={seekFromProgress}
        scrubFromProgress={scrubFromProgress}
        commitScrub={commitScrub}
        seekFromProgressRatio={seekFromProgressRatio}
        ratePopOpen={ratePopOpen}
        setRatePopOpen={setRatePopOpen}
        ratePopRef={ratePopRef}
        volPopOpen={volPopOpen}
        setVolPopOpen={setVolPopOpen}
        volPopRef={volPopRef}
        zoomPopOpen={zoomPopOpen}
        setZoomPopOpen={setZoomPopOpen}
        zoomPopRef={zoomPopRef}
        loopPlayback={loopPlayback}
        setLoopPlayback={setLoopPlayback}
        playbackRange={playbackRange}
        loopSeekPending={loopSeekPending}
        cancelLoopRestart={cancelLoopRestart}
        volume={volume}
        setVolume={setVolume}
        seekVolumeFrom={seekVolumeFrom}
      />
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
    <AppDialogs
      project={project}
      projects={projects}
      working={working}
      timeline={timeline}
      jobs={jobs}
      renderRatio={renderRatio}
      setPreviewMode={setPreviewMode}
      acceptState={acceptState}
      showNotice={showNotice}
      switchProject={switchProject}
      aiWorkflows={aiWorkflows}
      exportRender={exportRender}
      assetLibrary={assetLibrary}
      newProject={newProject}
      setNewProject={setNewProject}
      newProjectRatio={newProjectRatio}
      setNewProjectRatio={setNewProjectRatio}
      projectDialogOpen={projectDialogOpen}
      setProjectDialogOpen={setProjectDialogOpen}
      projectManagerRefreshing={projectManagerRefreshing}
      createProject={createProject}
      refreshProjectManager={refreshProjectManager}
      renameManagedProject={renameManagedProject}
      toggleManagedProjectArchive={toggleManagedProjectArchive}
      settingsOpen={settingsOpen}
      setSettingsOpen={setSettingsOpen}
      providerSettingsOpen={providerSettingsOpen}
      setProviderSettingsOpen={setProviderSettingsOpen}
      agentOpen={agentOpen}
      setAgentOpen={setAgentOpen}
      worklistOpen={worklistOpen}
      setWorklistOpen={setWorklistOpen}
      editingGrammarOpen={editingGrammarOpen}
      setEditingGrammarOpen={setEditingGrammarOpen}
      editingToolsTool={editingToolsTool}
      setEditingToolsTool={setEditingToolsTool}
      editingToolsClipId={editingToolsClipId}
      angleSyncOpen={angleSyncOpen}
      setAngleSyncOpen={setAngleSyncOpen}
      semanticSearchOpen={semanticSearchOpen}
      setSemanticSearchOpen={setSemanticSearchOpen}
      keyframeReviewOpen={keyframeReviewOpen}
      setKeyframeReviewOpen={setKeyframeReviewOpen}
      providerImageGenerationOpen={providerImageGenerationOpen}
      setProviderImageGenerationOpen={setProviderImageGenerationOpen}
      shotRequirementsOpen={shotRequirementsOpen}
      setShotRequirementsOpen={setShotRequirementsOpen}
      generationOpen={generationOpen}
      setGenerationOpen={setGenerationOpen}
      commandSearchOpen={commandSearchOpen}
      commandQuery={commandQuery}
      setCommandQuery={setCommandQuery}
      commandSearchInputRef={commandSearchInputRef}
      commandIndex={commandIndex}
      setCommandIndex={setCommandIndex}
      filteredCommands={filteredCommands}
      commandDisabledReason={commandDisabledReason}
      runCommand={runCommand}
      closeCommandSearch={closeCommandSearch}
      handleCommandPaletteKeyDown={handleCommandPaletteKeyDown}
      shortcuts={shortcuts}
      shortcutsRef={shortcutsRef}
      shortcutsOpen={shortcutsOpen}
      setShortcutsOpen={setShortcutsOpen}
      recordingId={recordingId}
      setRecordingId={setRecordingId}
      resetShortcutsToDefault={resetShortcutsToDefault}
      handleRecordKey={handleRecordKey}
    />
</main>;
}

