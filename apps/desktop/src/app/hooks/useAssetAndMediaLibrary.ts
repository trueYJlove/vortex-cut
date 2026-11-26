import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type {
  Asset,
  AssetId,
  AssetKind,
  AssetPresentation,
  CvAnalysisSummary,
  CvSample,
  ImportedAsset,
  Job,
  MediaInfo,
  ModelDetail,
  ModelSummary,
  Project,
  TimelineDocument,
  TimelinePatchOperation,
  TimelineState,
  Transcript,
  TranscriptSummary,
} from "@aivideo/contracts";
import { pickMedia } from "../../ui/of/media-selection.js";
import { BoundedTaskQueue } from "../request-scheduling.js";
import { errorCode, safeErrorMessage } from "../safeErrors.js";
import {
  ASSET_FAVORITES_KEY,
  isTranscribable,
  readAssetFavorites,
  storedAssetView,
  type AssetFilter,
  type NoticeTone,
  type SaveState,
} from "../appHelpers.js";
import {
  ASSET_BATCH_DRAG,
  ASSET_DRAG,
  SYSTEM_FILE_DROP_ID,
  clearSystemFileDrop,
  draggedAssetIds,
  planAssetDrop,
  resolveTimelineAssetDropIntent,
  setActiveDraggedAssetIds,
  takeSystemFileDrop,
} from "../timeline/asset-drop.js";
import { readTimelineBehaviorPrefs } from "../timeline/magnetic-plan.js";
import type { TimelineAssetDropIntent } from "../timeline/types.js";

export interface UseAssetAndMediaLibraryParams {
  project: Project | undefined;
  projectRef: React.MutableRefObject<Project | undefined>;
  projectDataEpochRef: React.MutableRefObject<number>;
  timeline: TimelineState | undefined;
  working: TimelineDocument | undefined;
  models: ModelSummary[];
  setModels: React.Dispatch<React.SetStateAction<ModelSummary[]>>;
  setJobs: React.Dispatch<React.SetStateAction<Job[]>>;
  setSaveState: React.Dispatch<React.SetStateAction<SaveState>>;
  acceptState: (next: TimelineState) => void;
  patchTimeline: (operations: TimelinePatchOperation[], summary: string, base?: TimelineState) => Promise<boolean>;
  createTimeline: (
    source: Parameters<typeof window.desktop.createTimeline>[0]["timeline"]["source"],
  ) => Promise<TimelineState | undefined>;
  loadProjectData: (selected: Project) => Promise<void>;
  ensureFilmstripForAsset: (assetId: string) => void;
  requestProxyJob: (assetId: string) => void;
  exitLibraryPreview: () => void;
  showNotice: (text: string, tone?: NoticeTone) => void;
}

/** 管理媒体库素材、收藏/筛选/多选/拖放导入、转录与本地模型、以及 CV 信号分析状态。 */
export function useAssetAndMediaLibrary({
  project,
  projectRef,
  projectDataEpochRef,
  timeline,
  working,
  models,
  setModels,
  setJobs,
  setSaveState,
  acceptState,
  patchTimeline,
  createTimeline,
  loadProjectData,
  ensureFilmstripForAsset,
  requestProxyJob,
  exitLibraryPreview,
  showNotice,
}: UseAssetAndMediaLibraryParams) {
  const [assets, setAssets] = useState<AssetPresentation[]>([]);
  // P199：资产对账要读"界面此刻到底有哪些素材"。直接用 state 镜像而不是另存一份
  // "上次看到的签名"——装载、UI 导入的乐观追加、刷新素材库都写同一个 state。
  const assetsRef = useRef<AssetPresentation[]>([]);
  assetsRef.current = assets;
  // GAP-LIST-ASSETS-PAGING：上一次提交的镜像是否被 200 页上限**截断**。
  const assetsMirrorTruncatedRef = useRef(false);

  const [assetQuery, setAssetQuery] = useState("");
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
  const [libraryScope, setLibraryScope] = useState<"import" | "favorites">("import");
  const [assetFavorites, setAssetFavorites] = useState(readAssetFavorites);
  const favoriteAssetIds = useMemo(() => new Set(assetFavorites), [assetFavorites]);
  useEffect(() => {
    try {
      localStorage.setItem(ASSET_FAVORITES_KEY, JSON.stringify(assetFavorites));
    } catch {
      /* In-memory favorites remain usable. */
    }
  }, [assetFavorites]);

  const [assetViews, setAssetViews] = useState<Record<string, "list" | "grid">>({});
  const projectAssetKey = project?.project_id ?? "";
  const assetView = assetViews[projectAssetKey] ?? storedAssetView(projectAssetKey);
  const changeAssetView = (view: "grid" | "list") => {
    setAssetViews(current => ({ ...current, [projectAssetKey]: view }));
    try {
      localStorage.setItem(`vortex.asset-view.${projectAssetKey}`, view);
    } catch {
      // The current session still keeps its view when storage is unavailable.
    }
  };
  const [assetSortByName, setAssetSortByName] = useState(false);

  // W3.1 语义检索命中只带 asset_id，显示名由素材列表派生（字段是 asset.display_name）。
  const semanticAssetNames = useMemo(
    () => Object.fromEntries(assets.map(item => [item.asset.asset_id, item.asset.display_name])),
    [assets],
  );
  const visibleAssets = useMemo(() => {
    const query = assetQuery.trim().toLocaleLowerCase();
    const filtered = assets.filter(
      ({ asset }) =>
        asset.display_name.toLocaleLowerCase().includes(query) &&
        (libraryScope !== "favorites" || favoriteAssetIds.has(asset.asset_id)) &&
        (assetFilter === "all" || asset.kind === assetFilter),
    );
    if (assetSortByName) {
      filtered.sort((a, b) => a.asset.display_name.localeCompare(b.asset.display_name, undefined, { numeric: true }));
    }
    return filtered;
  }, [assetQuery, assetFilter, assetSortByName, assets, favoriteAssetIds, libraryScope]);

  const [transcripts, setTranscripts] = useState<Record<string, Transcript[]>>({});
  const [transcriptSummaries, setTranscriptSummaries] = useState<Record<string, TranscriptSummary[]>>({});
  const transcriptQueueRef = useRef<BoundedTaskQueue<Transcript> | null>(null);
  /** 转录摘要分页（listTranscripts）专用队列：与正文队列分开类型，同样 ≤4 并发。 */
  const transcriptSummaryQueueRef = useRef<BoundedTaskQueue<{ items: TranscriptSummary[] }> | null>(null);

  const [confirmModel, setConfirmModel] = useState<ModelDetail>();
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  const [transcriptionAsset, setTranscriptionAsset] = useState<Asset>();
  // 素材删除确认（应用内弹窗，替代原生 confirm）；pendingDeleteAsset 显示警告文案。
  const [pendingDeleteAsset, setPendingDeleteAsset] = useState<Asset>();
  const [pickedAssetIds, setPickedAssetIds] = useState<AssetId[]>([]);
  const assetAnchor = useRef<AssetId | null>(null);
  const visibleAssetOrder = useMemo(() => visibleAssets.map(item => item.asset.asset_id), [visibleAssets]);
  const visibleAssetSet = useMemo(() => new Set(visibleAssetOrder), [visibleAssetOrder]);
  const selectedAssetIds = useMemo(
    () => new Set(pickedAssetIds.filter(id => visibleAssetSet.has(id))),
    [pickedAssetIds, visibleAssetSet],
  );
  const selectedAssetId = selectedAssetIds.size === 1 ? [...selectedAssetIds][0] : null;
  const [assetMenu, setAssetMenu] = useState<{ id: AssetId; x: number; y: number; trigger: HTMLButtonElement } | null>(null);
  const menuAsset = assetMenu && visibleAssets.find(item => item.asset.asset_id === assetMenu.id);
  const resetAssetSelection = () => {
    assetAnchor.current = null;
    setPickedAssetIds([]);
    setAssetMenu(null);
  };
  const selectAsset = (id: AssetId, mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}) => {
    const anchor = assetAnchor.current;
    if (!mods.shiftKey) assetAnchor.current = id;
    setPickedAssetIds(current =>
      pickMedia(
        current.filter(item => visibleAssetSet.has(item)),
        id,
        visibleAssetOrder,
        anchor,
        { toggle: Boolean(mods.ctrlKey || mods.metaKey), range: Boolean(mods.shiftKey) },
      ),
    );
  };
  const changeLibraryScope = (scope: typeof libraryScope, kind: AssetFilter = "all") => {
    resetAssetSelection();
    setLibraryScope(scope);
    setAssetFilter(kind);
    setAssetQuery("");
  };

  const [deleteBusy, setDeleteBusy] = useState(false);
  // 素材库刷新：逐个向 Core 校验素材文件是否仍在本地。
  const [refreshingAssets, setRefreshingAssets] = useState(false);
  const [viewingTranscript, setViewingTranscript] = useState<Transcript>();
  const [language, setLanguage] = useState("auto");
  const [wordTimestamps, setWordTimestamps] = useState(true);
  const [selectedSegments, setSelectedSegments] = useState<Record<string, string[]>>({});
  // AI 字幕优化（Slice 5）：发起入口在转录页，紧挨“追加所选片段”；
  // 记录发起时锁定的转录与片段，避免对话框打开期间勾选变化导致外传内容漂移。
  const [captionsOptimize, setCaptionsOptimize] = useState<{ transcript: Transcript; segmentIds: string[] }>();
  // 转录删除确认（危险操作需显式确认；仍被时间线字幕引用时 Core 拒绝）。
  const [pendingDeleteTranscript, setPendingDeleteTranscript] = useState<Pick<TranscriptSummary, "transcript_id">>();
  const [deleteTranscriptBusy, setDeleteTranscriptBusy] = useState(false);

  // AI-2（Layer 0）：素材 CV 信号分析
  const [cvSummaries, setCvSummaries] = useState<Partial<Record<AssetId, CvAnalysisSummary>>>({});
  const [cvBusy, setCvBusy] = useState<AssetId | null>(null);
  // ADR-0005 阶段 2：密度旋钮（可选高级项；空 = 默认 4s / 10s·min⁻¹）。
  const [cvOptionsOpen, setCvOptionsOpen] = useState(false);
  const [cvOptionsAsset, setCvOptionsAsset] = useState<AssetPresentation | null>(null);
  const [cvTargetGapS, setCvTargetGapS] = useState("");
  const [cvBudgetPerMin, setCvBudgetPerMin] = useState("");
  // 阶段 C 稳定性包：CV 信号 sparkline
  const [cvSparkAssetId, setCvSparkAssetId] = useState<AssetId | null>(null);
  const [cvSparkSamples, setCvSparkSamples] = useState<CvSample[] | null>(null);

  const resetAssetLibraryOnSwitch = (hardReset: boolean) => {
    transcriptQueueRef.current?.advanceGeneration();
    transcriptSummaryQueueRef.current?.advanceGeneration();
    setAssets([]);
    setTranscripts({});
    setTranscriptSummaries({});
    setViewingTranscript(undefined);
    resetAssetSelection();
    if (hardReset) {
      setAssetQuery("");
      setAssetFilter("all");
      setLibraryScope("import");
      setCvSummaries({});
      setCvSparkAssetId(null);
      setCvSparkSamples(null);
      setCvBusy(null);
      setCvOptionsOpen(false);
      setCvOptionsAsset(null);
      setTranscriptionAsset(undefined);
      setPendingDeleteAsset(undefined);
      setPendingDeleteTranscript(undefined);
      setDeleteTranscriptBusy(false);
      setDeleteBusy(false);
      setRefreshingAssets(false);
    }
  };

  const isDraggableAsset = (kind: AssetKind) => kind === "video" || kind === "image" || kind === "audio";

  const adoptImportedAsset = (result: ImportedAsset) => {
    setAssets(items => [...items.filter(item => item.asset.asset_id !== result.asset.asset_id), { asset: result.asset, media_url: result.media_url }]);
    ensureFilmstripForAsset(String(result.asset.asset_id));
    if (result.asset.kind === "video") requestProxyJob(String(result.asset.asset_id));
  };

  const dropAsset = async (
    ids: string[],
    atIndex: number,
    trackId?: string,
    edit?: { mode: "overwrite"; atUs: number },
    intent?: TimelineAssetDropIntent,
    replaceTargetClipId?: string,
  ) => {
    const systemDrop = ids.length === 1 && ids[0] === SYSTEM_FILE_DROP_ID;
    const files = systemDrop ? takeSystemFileDrop() : [];
    if (systemDrop && !files.length) {
      showNotice("没有读取到拖入的文件；请重新拖放。", "warning");
      return;
    }
    const currentDocument = working ?? timeline?.current_revision.document;
    const targetTrack = trackId && trackId !== "new" ? currentDocument?.tracks.find(track => track.id === trackId) : undefined;
    if (trackId && trackId !== "new" && !targetTrack) {
      showNotice("时间线目标轨道已不存在，请重新拖放。", "warning");
      return;
    }
    if (targetTrack?.locked) {
      showNotice("目标轨道已锁定，无法放入素材。", "warning");
      return;
    }
    let partialImportNotice = "";
    const byId = new Map(assets.map(({ asset }) => [asset.asset_id as string, asset]));
    let incoming: Asset[] = [];
    if (systemDrop) {
      if (!project || project.status !== "active") {
        showNotice("请先打开一个可编辑的项目，再将文件放入时间线。", "warning");
        return;
      }
      try {
        const imported = await window.desktop.importDroppedAssets({ project_id: project.project_id, files });
        imported.imported.forEach(adoptImportedAsset);
        incoming = imported.imported.map(item => item.asset).filter(asset => asset.availability === "available" && isDraggableAsset(asset.kind));
        if (imported.failures.length) {
          partialImportNotice = `已导入 ${incoming.length} 项；${imported.failures.length} 个文件因格式不支持、文件无效或导入失败而跳过。`;
        }
      } catch (error) {
        showNotice(safeErrorMessage(error, "系统文件导入失败；时间线未修改。"), "warning");
        return;
      }
    } else {
      for (const id of ids) {
        const asset = byId.get(id);
        if (!asset || asset.availability !== "available" || !isDraggableAsset(asset.kind)) {
          showNotice("所选素材中有不可用或不支持的文件，无法放入时间线。", "warning");
          return;
        }
        incoming.push(asset);
      }
    }
    if (!incoming.length) {
      if (partialImportNotice) showNotice(partialImportNotice, "warning");
      return;
    }
    if (!timeline && incoming.length === 1) {
      await createTimeline({ kind: "full_asset", asset_id: incoming[0].asset_id });
      if (partialImportNotice) showNotice(partialImportNotice, "warning");
      return;
    }
    if (incoming.length > 100 || (incoming.length === 100 && trackId === "new")) {
      showNotice("这组素材超出单次时间线操作上限，请分批拖入。", "warning");
      return;
    }
    const base = timeline ?? (await createTimeline({ kind: "empty" }));
    if (!base || projectRef.current?.project_id !== project?.project_id) return;
    const latestDocument = working ?? base.current_revision.document;
    const dropPrefs = readTimelineBehaviorPrefs();
    const tracks = latestDocument.tracks;
    if (replaceTargetClipId) {
      if (incoming.length !== 1 || !intent || intent.zone !== "center" || intent.targetClipId !== replaceTargetClipId) {
        showNotice("替换目标已变化；时间线未修改。", "warning");
        return;
      }
      const target = latestDocument.clips.find(clip => clip.clip_id === replaceTargetClipId);
      const targetTrack = target ? tracks.find(track => track.id === target.track_id) : undefined;
      if (!target || !targetTrack || targetTrack.locked || latestDocument.locked_elements?.includes(target.clip_id)) {
        showNotice("替换目标已删除或锁定；时间线未修改。", "warning");
        return;
      }
      const committed = await patchTimeline(
        [{ op: "replace_clip_source", clip_id: target.clip_id, asset_id: incoming[0]!.asset_id }],
        `替换素材：${incoming[0]!.display_name}`,
        base,
      );
      if (committed) {
        exitLibraryPreview();
        if (partialImportNotice) showNotice(partialImportNotice, "warning");
      } else if (systemDrop) {
        showNotice(`${partialImportNotice ? `${partialImportNotice} ` : ""}成功导入的素材已保留在素材栏；时间线未修改。`, "warning");
      }
      return;
    }
    let resolvedIntent = intent;
    if (intent) {
      resolvedIntent = resolveTimelineAssetDropIntent({
        hit: {
          trackId: intent.hitTrackId,
          band: intent.band,
          clipId: intent.targetClipId,
          zone: intent.boundary ?? (intent.zone === "center" ? "replace" : null),
        },
        clips: latestDocument.clips,
        tracks,
        lockedClipIds: latestDocument.locked_elements,
        assetKinds: incoming.map(asset => asset.kind),
        itemCount: incoming.length,
        canReplace: true,
        pointerUs: intent.pointerUs,
        fpsNum: latestDocument.canvas.fps_num,
        fpsDen: latestDocument.canvas.fps_den,
        hasCoordinates: intent.hasCoordinates,
        defaultSlot: atIndex,
        altKey: intent.mode === "overwrite",
        mainTrackMagnet: dropPrefs.mainTrackMagnet,
        assetDurationsUs: incoming.map(asset => {
          const itemDuration = asset.media_info?.duration_us;
          return asset.kind === "image" ? 4_000_000 : typeof itemDuration === "number" ? itemDuration : null;
        }),
      });
      if (!resolvedIntent.accepts) {
        showNotice("素材落点在导入期间发生变化或目标轨道不可用；时间线未修改。", "warning");
        return;
      }
    }
    let operations: TimelinePatchOperation[];
    try {
      operations = planAssetDrop(
        incoming,
        tracks,
        resolvedIntent?.slot ?? atIndex,
        resolvedIntent?.trackId ?? trackId,
        edit?.mode === "overwrite" ? { atUs: edit.atUs } : undefined,
        resolvedIntent
          ? {
              intent: resolvedIntent,
              clips: latestDocument.clips,
              linkageEnabled: dropPrefs.linkageEnabled,
              fpsNum: latestDocument.canvas.fps_num,
              fpsDen: latestDocument.canvas.fps_den,
            }
          : undefined,
      );
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "无法规划素材覆盖。", "warning");
      return;
    }
    if (operations.length > 100) {
      showNotice("这组素材超出单次时间线操作上限，请分批拖入。", "warning");
      return;
    }
    const committed = await patchTimeline(
      operations,
      incoming.length > 1 ? `批量放入 ${incoming.length} 项素材` : `放入 ${incoming[0].display_name}`,
      base,
    );
    if (committed) {
      exitLibraryPreview();
      if (partialImportNotice) showNotice(partialImportNotice, "warning");
    } else if (systemDrop) {
      showNotice(`${partialImportNotice ? `${partialImportNotice} ` : ""}成功导入的素材已保留在素材栏；时间线未修改。`, "warning");
    }
  };

  const insertSegments = (transcript: Transcript) => {
    const ids = selectedSegments[transcript.transcript_id] ?? [];
    if (!ids.length) return;
    const source = {
      kind: "transcript_selection" as const,
      transcript_id: transcript.transcript_id,
      segment_ids: ids as never[],
      padding_before_us: 150_000,
      padding_after_us: 150_000,
      create_captions: true,
    };
    if (timeline) {
      void patchTimeline(
        [
          {
            op: "insert_transcript_segments",
            transcript_id: transcript.transcript_id,
            segment_ids: ids as never[],
            at_index: working?.clips.length ?? 0,
            padding_before_us: 150_000,
            padding_after_us: 150_000,
            create_captions: true,
            layout: "blurred_background",
          },
        ],
        "追加转录选段",
      );
    } else {
      void createTimeline(source);
    }
  };

  const importAsset = async (kind: AssetKind) => {
    if (!project) return;
    const result = await window.desktop.importAsset({ project_id: project.project_id, kind });
    if (!result) return;
    adoptImportedAsset(result);
  };

  const refreshAssets = async () => {
    if (!project || refreshingAssets) return;
    const projectId = project.project_id;
    const epoch = projectDataEpochRef.current;
    setRefreshingAssets(true);
    try {
      const current = assets;
      const results = await Promise.all(
        current.map(async item => {
          try {
            return { item: await window.desktop.refreshAsset(item.asset.asset_id), failed: false };
          } catch {
            return { item, failed: true };
          }
        }),
      );
      const refreshed = results.map(result => result.item);
      const missing = refreshed.filter(item => item.asset.availability === "missing");
      const removedIds = new Set<string>();
      for (const item of missing) {
        try {
          await window.desktop.deleteAsset({ asset_id: item.asset.asset_id });
          removedIds.add(item.asset.asset_id);
        } catch {
          /* 仍被时间线/生成记录引用：保留在列表中 */
        }
      }
      const kept = refreshed.filter(item => !removedIds.has(item.asset.asset_id));
      if (projectRef.current?.project_id !== projectId || projectDataEpochRef.current !== epoch) return;
      setAssets(kept);
      const failed = results.filter(result => result.failed).length;
      const unavailable = kept.filter(item => item.asset.availability !== "available").length;
      if (failed || unavailable) {
        const detail = [
          removedIds.size && `已清理 ${removedIds.size} 项`,
          unavailable && `${unavailable} 项不可用，已保留`,
          failed && `${failed} 项未能检查，可重试`,
        ]
          .filter(Boolean)
          .join("，");
        showNotice(`已刷新素材库：${detail}。`, "warning");
      } else if (removedIds.size > 0) {
        showNotice(`已刷新素材库：清理了 ${removedIds.size} 个本地文件已删除的素材。`, "success");
      } else {
        showNotice("已刷新素材库：所有素材文件均正常。", "success");
      }
    } catch (error) {
      showNotice(safeErrorMessage(error, "素材库刷新失败，请稍后重试。"));
    } finally {
      setRefreshingAssets(false);
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
      if (projectRef.current?.project_id === projectId && projectDataEpochRef.current === epoch && timeline) {
        try {
          const latest = await window.desktop.getTimeline(projectId);
          if (projectRef.current?.project_id !== projectId || projectDataEpochRef.current !== epoch) return;
          acceptState(latest);
        } catch (timelineError) {
          if (!errorCode(timelineError).includes("TIMELINE_NOT_FOUND")) throw timelineError;
        }
      }
      showNotice(
        counts.removed_clips > 0
          ? `已删除素材「${asset.display_name}」，并从时间线移除 ${counts.removed_clips} 个相关片段。`
          : `已删除素材「${asset.display_name}」。`,
        "success",
      );
    } catch (error) {
      setPendingDeleteAsset(undefined);
      showNotice(safeErrorMessage(error, "素材删除失败，请刷新后重试。"));
    } finally {
      setDeleteBusy(false);
    }
  };

  const deleteTranscript = async (transcript: Pick<TranscriptSummary, "transcript_id">) => {
    const projectId = projectRef.current?.project_id;
    const epoch = projectDataEpochRef.current;
    setDeleteTranscriptBusy(true);
    try {
      if (!window.desktop.deleteTranscript) throw new Error("TRANSCRIPTION_DELETE_UNAVAILABLE");
      await window.desktop.deleteTranscript(transcript.transcript_id);
      if (projectRef.current?.project_id !== projectId || projectDataEpochRef.current !== epoch) return;
      setPendingDeleteTranscript(undefined);
      setViewingTranscript(current => (current?.transcript_id === transcript.transcript_id ? undefined : current));
      setTranscripts(current => {
        const next = { ...current };
        for (const assetId of Object.keys(next)) {
          const kept = next[assetId].filter(item => item.transcript_id !== transcript.transcript_id);
          if (kept.length) next[assetId] = kept;
          else delete next[assetId];
        }
        return next;
      });
      setSelectedSegments(current => {
        if (!(transcript.transcript_id in current)) return current;
        const next = { ...current };
        delete next[transcript.transcript_id];
        return next;
      });
      setTranscriptSummaries(current => {
        const next = { ...current };
        for (const assetId of Object.keys(next)) {
          const kept = next[assetId].filter(item => item.transcript_id !== transcript.transcript_id);
          if (kept.length) next[assetId] = kept;
          else delete next[assetId];
        }
        return next;
      });
      showNotice("已删除该转录。", "success");
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
      setDeleteTranscriptBusy(false);
    }
  };

  const openDeleteTranscriptDialog = (summary: Pick<TranscriptSummary, "transcript_id">) => {
    setDeleteTranscriptBusy(false);
    setPendingDeleteTranscript(summary);
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

  const usedAssetIds = useMemo(() => new Set(working?.clips.map(clip => clip.asset_id)), [working?.clips]);

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

  const toggleCvSpark = (asset: Asset) => {
    if (cvSparkAssetId === asset.asset_id) {
      setCvSparkAssetId(null);
      setCvSparkSamples(null);
      return;
    }
    if (!project) return;
    const projectId = project.project_id;
    const epoch = projectDataEpochRef.current;
    setCvSparkAssetId(asset.asset_id);
    setCvSparkSamples(null);
    void window.desktop
      .listCvSamples({ project_id: projectId, asset_id: asset.asset_id })
      .then(page => {
        if (projectRef.current?.project_id === projectId && projectDataEpochRef.current === epoch) setCvSparkSamples(page.samples);
      })
      .catch(() => {
        if (projectRef.current?.project_id === projectId && projectDataEpochRef.current === epoch) {
          setCvSparkSamples([]);
          showNotice("CV 信号样本加载失败。", "error");
        }
      });
  };

  const revealAsset = async (asset: Asset) => {
    try {
      const result = await window.desktop.revealAsset(asset.asset_id);
      if (result.status === "relocated" || result.status === "deleted") await refreshAssets();
    } catch (error) {
      showNotice(safeErrorMessage(error, "打开素材所在文件夹失败。"), "error");
    }
  };

  // "原始"分辨率档：素材最大短边（与 Core plan.py 同口径：无视频流兜底 1080，8K 钳 4K）。
  const originalShortEdge = useMemo(() => {
    let maxShort = 0;
    for (const item of assets) {
      const info = item.asset.media_info as MediaInfo | null;
      for (const stream of info?.video_streams ?? []) {
        const w = Number(stream.width ?? 0);
        const h = Number(stream.height ?? 0);
        if (w > 0 && h > 0) maxShort = Math.max(maxShort, Math.min(w, h));
      }
    }
    return maxShort > 0 ? Math.min(maxShort, 2160) : null;
  }, [assets]);

  const assetDragProps = (item: AssetPresentation) => ({
    draggable: isDraggableAsset(item.asset.kind) && item.asset.availability === "available",
    onDragStart: (event: React.DragEvent) => {
      if (!isDraggableAsset(item.asset.kind) || item.asset.availability !== "available") {
        event.preventDefault();
        return;
      }
      const ids = draggedAssetIds(item.asset.asset_id, visibleAssetOrder, selectedAssetIds);
      setActiveDraggedAssetIds(ids);
      if (ids.length > 1) event.dataTransfer.setData(ASSET_BATCH_DRAG, JSON.stringify(ids));
      else event.dataTransfer.setData(ASSET_DRAG, ids[0]);
      event.dataTransfer.effectAllowed = "copy";
    },
    onDragEnd: () => setActiveDraggedAssetIds([]),
    title: isDraggableAsset(item.asset.kind) ? "拖到 V1 时间线以插入；双击在预览播放" : undefined,
  });

  useEffect(() => {
    const clearAbortedAssetDrop = () => {
      clearSystemFileDrop();
      setActiveDraggedAssetIds([]);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearAbortedAssetDrop();
    };
    window.addEventListener("dragend", clearAbortedAssetDrop, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("dragend", clearAbortedAssetDrop, true);
      window.removeEventListener("keydown", onKeyDown, true);
      clearSystemFileDrop();
    };
  }, []);

  const openModel = async (model: ModelSummary) => {
    const detail = await window.desktop.getModel(model.model_id);
    setConfirmModel(detail);
    setLicenseAccepted(!detail.license.acceptance_required);
  };
  const downloadModel = async () => {
    if (!confirmModel) return;
    const result = await window.desktop.downloadModel({
      model_id: confirmModel.model_id,
      license_acceptance: confirmModel.license.acceptance_required ? confirmModel.license.id : null,
    });
    setModels(items => items.map(item => (item.model_id === result.model.model_id ? result.model : item)));
    setJobs(items => [result.job, ...items]);
    setConfirmModel(undefined);
  };
  const cancelModel = async (model: ModelSummary) => {
    const result = await window.desktop.cancelModelDownload(model.model_id);
    setModels(items => items.map(item => (item.model_id === result.model.model_id ? result.model : item)));
    setJobs(items => [result.job, ...items.filter(item => item.job_id !== result.job.job_id)]);
  };
  const startTranscription = (asset: Asset) => {
    const ready = models.find(model => model.status === "ready" && model.provider_status === "installed");
    if (!ready) {
      const candidate = models[0];
      if (candidate) void openModel(candidate);
      else showNotice("当前没有可用的本地 ASR 模型", "warning");
      return;
    }
    setTranscriptionAsset(asset);
  };
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
        if (updated.status === "succeeded" && projectRef.current) {
          void loadProjectData(projectRef.current).catch(() => undefined);
        }
      }
    });
  };
  const submitTranscription = async () => {
    if (!transcriptionAsset) return;
    const model = models.find(item => item.status === "ready" && item.provider_status === "installed");
    if (!model) return;
    const result = await window.desktop.createTranscription({
      asset_id: transcriptionAsset.asset_id,
      model_id: model.model_id,
      language,
      word_timestamps: wordTimestamps,
      license_acceptance: null,
    });
    setJobs(items => [result.job, ...items]);
    setTranscriptionAsset(undefined);
    trackTranscriptionJob(result.job);
  };
  const retryTranscription = async (job: Job) => {
    if (!job.asset_id || !job.model_id) return;
    const result = await window.desktop.createTranscription({
      asset_id: job.asset_id,
      model_id: job.model_id,
      language: "auto",
      word_timestamps: true,
      license_acceptance: null,
    });
    setJobs(items => [result.job, ...items]);
    trackTranscriptionJob(result.job);
  };
  const cancelJob = async (job: Job) => {
    const updated = await window.desktop.cancelJob(job.job_id);
    setJobs(items => items.map(item => (item.job_id === updated.job_id ? updated : item)));
  };

  const refreshCvSummary = useCallback(
    async (assetId: AssetId) => {
      if (!project) return;
      try {
        const summary = await window.desktop.getCvAnalysis({ project_id: project.project_id, asset_id: assetId, generate: false });
        setCvSummaries(current => ({ ...current, [assetId]: summary }));
      } catch {
        /* 摘要拉取失败不打断素材列表 */
      }
    },
    [project],
  );
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
            if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) {
              unsubscribe();
              void refreshCvSummary(assetId);
            }
          });
        } else {
          void refreshCvSummary(assetId);
        }
      } catch (caught) {
        showNotice(safeErrorMessage(caught, "CV 信号分析发起失败。"), "error");
      } finally {
        setCvBusy(null);
      }
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

  // A08：转录正文按需加载（选中 chip 时才 getTranscript，经并发≤4 队列 + 项目代次作废）
  const viewTranscript = async (summary: TranscriptSummary) => {
    const cached = Object.values(transcripts).flat().find(item => item.transcript_id === summary.transcript_id);
    if (cached) {
      setViewingTranscript(cached);
      return;
    }
    const epoch = projectDataEpochRef.current;
    const queue = (transcriptQueueRef.current ??= new BoundedTaskQueue<Transcript>(4));
    const result = await queue.push(() => window.desktop.getTranscript(summary.transcript_id));
    if (result === queue.skipped || epoch !== projectDataEpochRef.current) return;
    const transcript = result as Transcript;
    setViewingTranscript(transcript);
    setTranscripts(current => ({ ...current, [transcript.asset_id]: [...(current[transcript.asset_id] ?? []), transcript] }));
  };

  const firstMediaAsset = assets.find(item => (item.asset.kind === "video" || item.asset.kind === "image") && item.asset.availability === "available");
  const firstTranscribableAsset = assets.find(item => isTranscribable(item.asset));
  const loadedTranscript = (transcriptId: string) =>
    Object.values(transcripts).flat().find(item => item.transcript_id === transcriptId);
  const transcriptRows = assets
    .filter(item => isTranscribable(item.asset))
    .flatMap(assetItem => (transcriptSummaries[assetItem.asset.asset_id] ?? []).map(summary => ({ summary, assetName: assetItem.asset.display_name })));

  return {
    assets,
    setAssets,
    assetsRef,
    assetsMirrorTruncatedRef,
    assetQuery,
    setAssetQuery,
    assetFilter,
    setAssetFilter,
    libraryScope,
    changeLibraryScope,
    assetFavorites,
    setAssetFavorites,
    favoriteAssetIds,
    assetView,
    changeAssetView,
    assetSortByName,
    setAssetSortByName,
    semanticAssetNames,
    visibleAssets,
    transcripts,
    transcriptSummaries,
    setTranscriptSummaries,
    transcriptSummaryQueueRef,
    confirmModel,
    setConfirmModel,
    licenseAccepted,
    setLicenseAccepted,
    transcriptionAsset,
    pendingDeleteAsset,
    setPendingDeleteAsset,
    visibleAssetOrder,
    selectedAssetIds,
    selectedAssetId,
    assetMenu,
    setAssetMenu,
    menuAsset,
    resetAssetSelection,
    selectAsset,
    setPickedAssetIds,
    deleteBusy,
    refreshingAssets,
    viewingTranscript,
    setViewingTranscript,
    language,
    setLanguage,
    wordTimestamps,
    setWordTimestamps,
    selectedSegments,
    setSelectedSegments,
    captionsOptimize,
    setCaptionsOptimize,
    pendingDeleteTranscript,
    setPendingDeleteTranscript,
    deleteTranscriptBusy,
    cvSummaries,
    cvBusy,
    cvOptionsOpen,
    setCvOptionsOpen,
    cvOptionsAsset,
    setCvOptionsAsset,
    cvTargetGapS,
    setCvTargetGapS,
    cvBudgetPerMin,
    setCvBudgetPerMin,
    cvSparkAssetId,
    cvSparkSamples,
    resetAssetLibraryOnSwitch,
    isDraggableAsset,
    adoptImportedAsset,
    dropAsset,
    insertSegments,
    importAsset,
    refreshAssets,
    deleteAsset,
    deleteTranscript,
    openDeleteTranscriptDialog,
    deleteJob,
    usedAssetIds,
    cvSummaryText,
    toggleCvSpark,
    revealAsset,
    originalShortEdge,
    assetDragProps,
    openModel,
    downloadModel,
    cancelModel,
    startTranscription,
    submitTranscription,
    retryTranscription,
    cancelJob,
    startCvAnalysis,
    submitCvOptions,
    viewTranscript,
    firstMediaAsset,
    firstTranscribableAsset,
    loadedTranscript,
    transcriptRows,
    setTranscriptionAsset,
  };
}
