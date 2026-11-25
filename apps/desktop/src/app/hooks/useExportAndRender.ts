import { useEffect, useRef, useState } from "react";
import type React from "react";
import type {
  DestinationGrant,
  DirectoryGrant,
  EncoderMode,
  ExportBatch,
  ExportFrameRate,
  ExportQuality,
  ExportResolution,
  Job,
  OutputRatio,
  PlatformPreset,
  Project,
  ReframeExportBatch,
  RenditionPreset,
  RenditionReframeAdjustment,
  TimelineClip,
  TimelineDocument,
  TimelineState,
} from "@aivideo/contracts";
import type {
  AuthoritativePreviewPresentation,
  ExportRecordPresentation,
  RenditionPreviewPresentation,
  RenditionReframePreviewPresentation,
} from "../../../electron/preload/index.js";
import type { ExportSettings } from "../ExportDialog.js";
import type { NoticeTone, ReframeAnchor, ReframeSelections, RenditionTarget } from "../appHelpers.js";
import { safeErrorMessage } from "../safeErrors.js";

export interface UseExportAndRenderParams {
  project: Project | undefined;
  projectRef: React.MutableRefObject<Project | undefined>;
  projectDataEpochRef: React.MutableRefObject<number>;
  timeline: TimelineState | undefined;
  timelineRef: React.MutableRefObject<TimelineState | undefined>;
  working: TimelineDocument | undefined;
  setJobs: React.Dispatch<React.SetStateAction<Job[]>>;
  jobs: Job[];
  previewMode: "interactive" | "authoritative" | "synthetic";
  setPreviewMode: React.Dispatch<React.SetStateAction<"interactive" | "authoritative" | "synthetic">>;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  getRenderRatio: () => OutputRatio;
  showNotice: (text: string, tone?: NoticeTone) => void;
}

/** 管理权威预览、单条导出、多平台批量导出、静态焦点重构图与项目封面截取。 */
export function useExportAndRender({
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
  getRenderRatio,
  showNotice,
}: UseExportAndRenderParams) {
  // 项目封面：截取当前播放头画面（本地持久化，per-project）。
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [encoderMode, setEncoderMode] = useState<EncoderMode>("auto");
  const [exportQuality, setExportQuality] = useState<ExportQuality>("standard");
  // 剪映式导出弹窗（2026-09-23）：分辨率/帧率与画质并列；弹窗与封面弹窗开关。
  const [exportResolution, setExportResolution] = useState<ExportResolution>("1080p");
  const [exportFrameRate, setExportFrameRate] = useState<ExportFrameRate>(30);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [coverDialogOpen, setCoverDialogOpen] = useState(false);
  const [previews, setPreviews] = useState<AuthoritativePreviewPresentation[]>([]);
  const [exports, setExports] = useState<ExportRecordPresentation[]>([]);
  const [exportPlayback, setExportPlayback] = useState<ExportRecordPresentation>();
  /** 导出前核验：generatePreview 请求后等待当前 Revision 的权威预览就绪。 */
  const [pendingVerify, setPendingVerify] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [renderPanelOpen, setRenderPanelOpen] = useState(false);
  // 轮询 effect 闭包读面板开关最新值（决定 exports 对账端点是否参与本轮）。
  const renderPanelOpenRef = useRef(false);
  renderPanelOpenRef.current = renderPanelOpen;

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

  const renderDataEpochRef = useRef(0);
  // 项目封面：从预览画布截取当前播放头帧（本地持久化；无后端依赖）。
  // 合成模式（默认主力）无 video 元素——帧画在 OffscreenCanvas，经会话的
  // snapshotPng 回读（含 fit 几何：裁掉 contain 留边）后解码裁剪缩放为
  // JPEG（≤540px，localStorage 容量安全）；交互/权威模式沿用 video 元素。
  const syntheticSnapshotRef = useRef<(() => Promise<{ buffer: ArrayBuffer; contentX: number; contentY: number; contentW: number; contentH: number } | null>) | null>(null);

  const loadRenderData = async (selected: Project) => {
    const epoch = ++renderDataEpochRef.current;
    const [previewPage, exportPage] = await Promise.all([
      window.desktop.listPreviews({ project_id: selected.project_id, limit: 100 }),
      window.desktop.listExports({ project_id: selected.project_id, limit: 100 }),
    ]);
    if (epoch !== renderDataEpochRef.current || projectRef.current?.project_id !== selected.project_id) return;
    setPreviews(previewPage.items);
    setExports(exportPage.items);
    // P9（参照行为）：刷新/切项目后若当前 Revision 已有就绪的权威预览，直接回到核验观看，
    // stale 与否由瞬态标签承担（参照画面无常驻模式胶囊）。不打断导出/重构播放。
    const current =
      previewPage.items.find(item => item.preview.timeline_revision_id === selected.current_timeline_revision_id) ??
      (previewPage.items[0]?.preview.timeline_revision_id === timelineRef.current?.current_revision.timeline_revision_id
        ? previewPage.items[0]
        : undefined);
    if (current?.preview.status === "ready" && !exportPlayback && !reframePlayback) setPreviewMode("authoritative");
  };

  const resetRenderOnProjectSwitch = () => {
    renderDataEpochRef.current += 1;
    setPreviews([]);
    setExports([]);
    setExportPlayback(undefined);
    setReframePlayback(undefined);
    setCoverUrl(null);
  };

  const resetReframeOnProjectChange = () => {
    setPreviews([]);
    setExports([]);
    setExportPlayback(undefined);
    setReframePlayback(undefined);
    setCoverUrl(null);
    setReframeSelections({});
    setReframePreviews({});
    setReframePending({});
    setReframeDirectoryGrant(undefined);
    setActiveReframeBatch(undefined);
    setReframeError("");
  };

  // 移除一条文件已缺失的导出记录（问题2：成品文件在系统层被删后，记录
  // 保留会让列表堆积不可用条目；Core 校验文件仍存在时拒绝——UI 端不提供
  // 静默销毁成品的通道）。移除后从本地列表去掉，产物计数同步。
  const removeMissingExport = async (item: ExportRecordPresentation) => {
    if (!project) return;
    try {
      await window.desktop.deleteExportRecord({
        project_id: project.project_id,
        export_record_id: item.export_record.export_record_id,
      });
      setExports(items => items.filter(entry => entry.export_record.export_record_id !== item.export_record.export_record_id));
      showNotice(`已移除导出记录「${item.export_record.destination_display_name}」。`);
    } catch (error) {
      showNotice(safeErrorMessage(error, "移除导出记录失败，请稍后重试。"), "warning");
    }
  };

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
            const sx = snapshot.contentX;
            const sy = snapshot.contentY;
            const sw = snapshot.contentW;
            const sh = snapshot.contentH;
            const scale = Math.min(1, 540 / sw);
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(2, Math.round(sw * scale));
            canvas.height = Math.max(2, Math.round(sh * scale));
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              resolve(null);
              return;
            }
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", 0.85));
          };
          img.onerror = () => {
            URL.revokeObjectURL(blobUrl);
            resolve(null);
          };
          img.src = blobUrl;
        });
      }
    }
    if (!url) {
      const video = videoRef.current;
      if (!video || !video.videoWidth) {
        return null;
      }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      url = canvas.toDataURL("image/jpeg", 0.85);
    }
    if (!url) return null;
    setCoverUrl(url);
    try {
      localStorage.setItem(`vortex-cut.cover.${project?.project_id ?? "default"}`, url);
    } catch {
      /* 配额不足忽略 */
    }
    return url;
  };

  const applyCover = (url: string | null) => {
    setCoverUrl(url);
    const key = `vortex-cut.cover.${project?.project_id ?? "default"}`;
    try {
      if (url) localStorage.setItem(key, url);
      else localStorage.removeItem(key);
    } catch {
      /* 配额不足忽略 */
    }
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
        void loadRenderData({ ...projectRef.current!, project_id: projectId }).catch(error =>
          showNotice(safeErrorMessage(error, "渲染记录加载失败，请刷新后重试。")),
        );
      }
    });
  };

  const generatePreview = async () => {
    if (!project || !timeline || !working?.clips.length) return;
    if (timeline.draft) {
      showNotice("请先提交或丢弃草稿，再生成权威预览。", "warning");
      return;
    }
    try {
      const result = await window.desktop.createPreview({
        project_id: project.project_id,
        preview: {
          timeline_revision_id: timeline.current_revision.timeline_revision_id,
          encoder_mode: encoderMode,
          output_ratio: getRenderRatio(),
        },
      });
      setPendingVerify(true);
      if (result.preview) {
        setPreviews(items => [result.preview!, ...items.filter(item => item.preview.render_artifact_id !== result.preview!.preview.render_artifact_id)]);
        setPreviewMode("authoritative");
      }
      if (result.job) {
        trackRenderJob(result.job);
        setRenderPanelOpen(true);
      }
    } catch (error) {
      showNotice(safeErrorMessage(error, "操作未完成，请刷新后重试。"));
    }
  };

  // 导出前核验（Phase 2：权威预览不再是一个常驻模式，收敛为"生成后观看核验"）：
  // 异步任务完成路径——当前 Revision 的权威预览一旦就绪即自动切换观看；
  // 立即返回 preview 的复用路径已在 generatePreview 内直接切换。
  useEffect(() => {
    if (!pendingVerify) return;
    const ready = previews.find(
      item => item.preview.timeline_revision_id === timeline?.current_revision.timeline_revision_id && item.preview.status === "ready",
    );
    if (!ready) return;
    setPendingVerify(false);
    setPreviewMode("authoritative");
  }, [pendingVerify, previews, timeline?.current_revision.timeline_revision_id]);

  const openExportDialog = () => {
    if (!project || !timeline || !working?.clips.length) return;
    if (timeline.draft) {
      showNotice("请先提交或丢弃草稿，再导出正式 Revision。", "warning");
      return;
    }
    setExportDialogOpen(true);
  };

  const submitExport = async (grant: DestinationGrant | null, settings: ExportSettings) => {
    if (!project || !timeline) return;
    setExportBusy(true);
    try {
      const selected = grant ?? (await window.desktop.chooseExportDestination(project.project_id, settings.fileName));
      if (!selected) return;
      const result = await window.desktop.createExport({
        project_id: project.project_id,
        export: {
          timeline_revision_id: timeline.current_revision.timeline_revision_id,
          destination_grant_id: selected.destination_grant_id,
          encoder_mode: encoderMode,
          output_ratio: getRenderRatio(),
          quality: settings.quality,
          resolution: settings.resolution,
          frame_rate: settings.frameRate,
        },
      });
      if (result.export_record) {
        setExports(items => [
          result.export_record!,
          ...items.filter(item => item.export_record.export_record_id !== result.export_record!.export_record.export_record_id),
        ]);
      }
      trackRenderJob(result.job);
      setRenderPanelOpen(true);
      setExportDialogOpen(false);
    } catch (error) {
      showNotice(safeErrorMessage(error, "操作未完成，请刷新后重试。"));
    } finally {
      setExportBusy(false);
    }
  };

  const targetPreview = (target: RenditionTarget) =>
    renditionPreviews.find(
      item =>
        item.preview.platform_preset_id === target.platform_preset_id &&
        item.preview.rendition_preset_id === target.rendition_preset_id &&
        item.preview.layout_policy === target.layout_policy &&
        item.preview.timeline_revision_id === timeline?.current_revision.timeline_revision_id &&
        item.preview.status === "ready",
    );

  const openExportBatch = async () => {
    if (!project || !timeline || timeline.draft) {
      showNotice("请先提交或丢弃草稿，再创建多平台导出。", "warning");
      return;
    }
    try {
      setBatchError("");
      setBatchOpen(true);
      const [platforms, renditions, previewList, batches, reframeBatches] = await Promise.all([
        window.desktop.listPlatformPresets(),
        window.desktop.listRenditionPresets(),
        window.desktop.listRenditionPreviews({ project_id: project.project_id, limit: 100 }),
        window.desktop.listExportBatches({ project_id: project.project_id, limit: 20 }),
        window.desktop.listReframeExportBatches({ project_id: project.project_id, limit: 20 }),
      ]);
      setPlatformPresets(platforms.items);
      setRenditionPresets(renditions.items);
      setRenditionPreviews(previewList.items);
      setActiveBatch(batches.items[0]);
      setActiveReframeBatch(reframeBatches.items[0]);
      if (!renditionTargets.length && platforms.items[0]) {
        setRenditionTargets([
          {
            key: `${platforms.items[0].platform_preset_id}:${platforms.items[0].default_rendition_id}`,
            platform_preset_id: platforms.items[0].platform_preset_id,
            rendition_preset_id: platforms.items[0].default_rendition_id,
            layout_policy: "preserve_timeline",
          },
        ]);
      }
    } catch {
      setBatchError("无法加载平台预设或批次状态。");
    }
  };

  const addTarget = () => {
    const platform = platformPresets[0];
    if (!platform || renditionTargets.length >= 8) return;
    const available = platform.allowed_rendition_ids.find(
      id => !renditionTargets.some(target => target.platform_preset_id === platform.platform_preset_id && target.rendition_preset_id === id),
    );
    if (!available) return;
    setRenditionTargets(items => [
      ...items,
      {
        key: `${platform.platform_preset_id}:${available}`,
        platform_preset_id: platform.platform_preset_id,
        rendition_preset_id: available,
        layout_policy: "preserve_timeline",
      },
    ]);
  };

  const updateTarget = (key: string, update: Partial<RenditionTarget>) => {
    setRenditionTargets(items => items.map(item => (item.key === key ? { ...item, ...update } : item)));
    setReframeSelections(current => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setReframePreviews(current => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setReframePending(current => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setReframeDirectoryGrant(undefined);
  };

  const generateRenditionPreview = async (target: RenditionTarget) => {
    if (!project || !timeline) return;
    try {
      const result = await window.desktop.createRenditionPreview({
        project_id: project.project_id,
        preview: {
          timeline_revision_id: timeline.current_revision.timeline_revision_id,
          platform_preset_id: target.platform_preset_id as never,
          rendition_preset_id: target.rendition_preset_id as never,
          layout_policy: target.layout_policy,
          encoder_mode: encoderMode,
        },
      });
      if (result.preview) {
        setRenditionPreviews(items => [result.preview!, ...items.filter(item => item.preview.render_artifact_id !== result.preview!.preview.render_artifact_id)]);
      }
      if (result.job) trackRenderJob(result.job);
    } catch (error) {
      setBatchError(safeErrorMessage(error, "生成权威预览失败。"));
    }
  };

  const chooseBatchDirectory = async () => {
    if (!project) return;
    try {
      setDirectoryGrant((await window.desktop.chooseExportDirectory(project.project_id)) ?? undefined);
    } catch {
      setBatchError("选择导出目录失败。");
    }
  };

  const createBatch = async () => {
    if (!project || !timeline || !directoryGrant || renditionTargets.some(target => !targetPreview(target))) return;
    try {
      const result = await window.desktop.createExportBatch({
        project_id: project.project_id,
        batch: {
          timeline_revision_id: timeline.current_revision.timeline_revision_id,
          directory_grant_id: directoryGrant.directory_grant_id,
          items: renditionTargets.map(target => ({
            rendition_snapshot_id: targetPreview(target)!.preview.rendition_snapshot_id,
            preview_artifact_id: targetPreview(target)!.preview.render_artifact_id,
            encoder_mode: encoderMode,
          })),
        },
      });
      setActiveBatch(result.batch);
      setDirectoryGrant(undefined);
      result.jobs.forEach(trackRenderJob);
    } catch (error) {
      setBatchError(safeErrorMessage(error, "创建批次失败。"));
    }
  };

  const retryBatchItems = async () => {
    if (!activeBatch || !project) return;
    const retryable = activeBatch.items.filter(item => ["failed", "cancelled", "interrupted"].includes(item.status));
    if (!retryable.length) return;
    try {
      const grant = await window.desktop.chooseExportDirectory(project.project_id);
      if (!grant) return;
      const result = await window.desktop.retryExportBatch({
        batch_id: activeBatch.export_batch_id,
        retry: { directory_grant_id: grant.directory_grant_id, export_batch_item_ids: retryable.map(item => item.export_batch_item_id) },
      });
      setActiveBatch(result.batch);
      result.jobs.forEach(trackRenderJob);
    } catch (error) {
      setBatchError(safeErrorMessage(error, "重试批次失败。"));
    }
  };

  const reframeClips = (target: RenditionTarget): TimelineClip[] => {
    if (!working) return [];
    if (target.layout_policy === "crop_fill_all") return working.clips;
    if (target.layout_policy === "preserve_timeline") return working.clips.filter(clip => clip.layout === "crop_fill");
    return [];
  };

  const targetAdjustments = (target: RenditionTarget): RenditionReframeAdjustment[] =>
    Object.entries(reframeSelections[target.key] ?? {}).map(([clip_id, anchor]) => ({ clip_id: clip_id as never, ...anchor }));

  const selectReframeAnchor = (target: RenditionTarget, clipId: string, anchor: ReframeAnchor) => {
    setReframeSelections(current => {
      const targetSelections = { ...(current[target.key] ?? {}) };
      if (anchor.horizontal_anchor === "center" && anchor.vertical_anchor === "center") delete targetSelections[clipId];
      else targetSelections[clipId] = anchor;
      return { ...current, [target.key]: targetSelections };
    });
    setReframePreviews(current => {
      const next = { ...current };
      delete next[target.key];
      return next;
    });
    setReframePending(current => {
      const next = { ...current };
      delete next[target.key];
      return next;
    });
    setReframeDirectoryGrant(undefined);
  };

  const generateReframePreview = async (target: RenditionTarget) => {
    if (!project) return;
    const base = targetPreview(target);
    const adjustments = targetAdjustments(target);
    if (!base || !adjustments.length) return;
    setReframeError("");
    try {
      const result = await window.desktop.createRenditionReframePreview({
        project_id: project.project_id,
        preview: { base_rendition_snapshot_id: base.preview.rendition_snapshot_id, adjustments, encoder_mode: encoderMode },
      });
      if (result.preview) {
        setReframePreviews(current => ({ ...current, [target.key]: result.preview! }));
        setReframePending(current => {
          const next = { ...current };
          delete next[target.key];
          return next;
        });
      }
      if (result.job) {
        const job = result.job;
        const snapshotId = typeof job.input.rendition_reframe_snapshot_id === "string" ? job.input.rendition_reframe_snapshot_id : "";
        if (snapshotId) setReframePending(current => ({ ...current, [target.key]: snapshotId }));
        setJobs(items => [job, ...items.filter(item => item.job_id !== job.job_id)]);
        const unsubscribe = window.desktop.subscribeJob(job.job_id, updated => {
          setJobs(items => [updated, ...items.filter(item => item.job_id !== updated.job_id)]);
          if (!["succeeded", "failed", "cancelled", "interrupted"].includes(updated.status)) return;
          unsubscribe();
          setReframePending(current => {
            const next = { ...current };
            delete next[target.key];
            return next;
          });
          if (updated.status === "succeeded" && snapshotId) {
            void window.desktop
              .listRenditionReframePreviews({ project_id: project.project_id, limit: 100 })
              .then(page => {
                const ready = page.items.find(item => item.preview.rendition_reframe_snapshot_id === snapshotId && item.preview.status === "ready");
                if (ready) setReframePreviews(current => ({ ...current, [target.key]: ready }));
              })
              .catch(() => setReframeError("重构图预览已完成，但刷新失败。"));
          } else if (updated.status !== "succeeded") {
            setReframeError("重构图预览未完成，请稍后刷新任务状态。");
          }
        });
      }
    } catch (error) {
      setReframeError(safeErrorMessage(error, "生成重构图预览失败。"));
    }
  };

  const chooseReframeDirectory = async () => {
    if (!project) return;
    try {
      setReframeDirectoryGrant((await window.desktop.chooseExportDirectory(project.project_id)) ?? undefined);
    } catch {
      setReframeError("选择重构图导出目录失败。");
    }
  };

  const createReframeBatch = async () => {
    if (!project || !reframeDirectoryGrant || renditionTargets.some(target => !reframePreviews[target.key] || !targetAdjustments(target).length)) return;
    try {
      const result = await window.desktop.createReframeExportBatch({
        project_id: project.project_id,
        batch: {
          directory_grant_id: reframeDirectoryGrant.directory_grant_id,
          items: renditionTargets.map(target => ({
            rendition_reframe_snapshot_id: reframePreviews[target.key].preview.rendition_reframe_snapshot_id,
            preview_artifact_id: reframePreviews[target.key].preview.render_artifact_id,
            encoder_mode: encoderMode,
          })),
        },
      });
      setActiveReframeBatch(result.batch);
      setReframeDirectoryGrant(undefined);
      result.jobs.forEach(trackRenderJob);
    } catch (error) {
      setReframeError(safeErrorMessage(error, "创建重构图批次失败。"));
    }
  };

  const retryReframeBatchItems = async () => {
    if (!activeReframeBatch || !project) return;
    const retryable = activeReframeBatch.items.filter(item => ["failed", "cancelled", "interrupted"].includes(item.status));
    if (!retryable.length) return;
    try {
      const grant = await window.desktop.chooseExportDirectory(project.project_id);
      if (!grant) return;
      const result = await window.desktop.retryReframeExportBatch({
        batch_id: activeReframeBatch.reframe_export_batch_id,
        retry: { directory_grant_id: grant.directory_grant_id, reframe_export_batch_item_ids: retryable.map(item => item.reframe_export_batch_item_id) },
      });
      setActiveReframeBatch(result.batch);
      result.jobs.forEach(trackRenderJob);
    } catch (error) {
      setReframeError(safeErrorMessage(error, "重试重构图批次失败。"));
    }
  };

  const authoritativePreview = previews.find(item => item.preview.timeline_revision_id === timeline?.current_revision.timeline_revision_id) ?? previews[0];
  const previewIsStale = Boolean(
    authoritativePreview &&
      (authoritativePreview.preview.status === "stale" || authoritativePreview.preview.timeline_revision_id !== timeline?.current_revision.timeline_revision_id),
  );
  const authoritativeMediaUrl = reframePlayback?.media_url ?? exportPlayback?.media_url ?? authoritativePreview?.media_url;
  const renderDisabledReason = !timeline || !working?.clips.length ? "时间线为空" : timeline.draft ? "存在未提交草稿，请先形成正式 Revision" : undefined;
  const renderJobs = jobs.filter(item => item.kind === "authoritative_preview" || item.kind === "final_export");
  const renderActivity = renderJobs.filter(item => ["queued", "running", "cancelling"].includes(item.status)).length;

  return {
    coverUrl,
    setCoverUrl,
    encoderMode,
    setEncoderMode,
    exportQuality,
    setExportQuality,
    exportResolution,
    setExportResolution,
    exportFrameRate,
    setExportFrameRate,
    exportDialogOpen,
    setExportDialogOpen,
    exportBusy,
    coverDialogOpen,
    setCoverDialogOpen,
    previews,
    exports,
    setExports,
    exportPlayback,
    setExportPlayback,
    batchOpen,
    setBatchOpen,
    renderPanelOpen,
    setRenderPanelOpen,
    renderPanelOpenRef,
    platformPresets,
    renditionPresets,
    renditionTargets,
    setRenditionTargets,
    activeBatch,
    setActiveBatch,
    batchError,
    setBatchError,
    reframeSelections,
    reframePreviews,
    reframePending,
    reframePlayback,
    setReframePlayback,
    reframeDirectoryGrant,
    directoryGrant,
    activeReframeBatch,
    setActiveReframeBatch,
    reframeError,
    setReframeError,
    syntheticSnapshotRef,
    loadRenderData,
    resetRenderOnProjectSwitch,
    resetReframeOnProjectChange,
    removeMissingExport,
    captureCover,
    applyCover,
    trackRenderJob,
    generatePreview,
    openExportDialog,
    submitExport,
    targetPreview,
    openExportBatch,
    addTarget,
    updateTarget,
    generateRenditionPreview,
    chooseBatchDirectory,
    createBatch,
    retryBatchItems,
    reframeClips,
    targetAdjustments,
    selectReframeAnchor,
    generateReframePreview,
    chooseReframeDirectory,
    createReframeBatch,
    retryReframeBatchItems,
    authoritativePreview,
    previewIsStale,
    authoritativeMediaUrl,
    renderDisabledReason,
    renderActivity,
  };
}
