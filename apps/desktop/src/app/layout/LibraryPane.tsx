import type { Dispatch, DragEvent, SetStateAction } from "react";
import {
  Archive,
  ArrowUpDown,
  AudioLines,
  Captions,
  Clapperboard,
  FileText,
  FolderOpen,
  History,
  ImagePlus,
  LayoutGrid,
  List,
  Play,
  RefreshCw,
  Scissors,
  Search,
  Sparkles,
  Star,
  Trash2,
  Type,
  Video,
} from "lucide-react";
import type {
  Asset,
  AssetId,
  AssetKind,
  AssetPresentation,
  CvAnalysisSummary,
  CvSample,
  Job,
  ModelSummary,
  Project,
  TimelineState,
  Transcript,
  TranscriptSummary,
} from "@aivideo/contracts";
import { ContextMenu, type ContextMenuItem } from "../../ui/of/ContextMenu.js";
import { JobEta } from "../JobEta.js";
import { safeTaskErrorMessage } from "../safeErrors.js";
import {
  assetDurationLabel,
  assetKindLabels,
  assetKinds,
  assetMetaText,
  availabilityLabels,
  cvSparkPath,
  isTranscribable,
  jobDetailText,
  jobKindLabels,
  jobPhaseLabels,
  jobStatusLabels,
  modelBadgeLabels,
  modelStatusLabels,
  navigateAssetLibrary,
  transcriptStatusLabels,
  type AssetFilter,
} from "../appHelpers.js";
import { IconButton } from "./AppMicroComponents.js";

export interface LibraryPaneProps {
  leftPaneOpen: boolean;
  tab: "assets" | "transcripts" | "models" | "jobs";
  setTab: (tab: "assets" | "transcripts" | "models" | "jobs") => void;
  project: Project | undefined;
  timeline: TimelineState | undefined;
  assets: AssetPresentation[];
  visibleAssets: AssetPresentation[];
  visibleAssetOrder: AssetId[];
  models: ModelSummary[];
  jobs: Job[];
  libraryScope: "import" | "favorites";
  changeLibraryScope: (scope: "import" | "favorites", filter?: AssetFilter) => void;
  assetFilter: AssetFilter;
  setAssetFilter: (filter: AssetFilter) => void;
  assetQuery: string;
  setAssetQuery: (query: string) => void;
  assetView: "grid" | "list";
  changeAssetView: (view: "grid" | "list") => void;
  assetSortByName: boolean;
  setAssetSortByName: Dispatch<SetStateAction<boolean>>;
  refreshingAssets: boolean;
  refreshAssets: () => Promise<void>;
  selectedAssetIds: Set<AssetId>;
  selectAsset: (id: AssetId, mods?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => void;
  setPickedAssetIds: Dispatch<SetStateAction<AssetId[]>>;
  resetAssetSelection: () => void;
  usedAssetIds: Set<AssetId>;
  favoriteAssetIds: Set<AssetId>;
  setAssetFavorites: Dispatch<SetStateAction<AssetId[]>>;
  assetMenu: { id: AssetId; x: number; y: number; trigger: HTMLButtonElement } | null;
  setAssetMenu: Dispatch<SetStateAction<{ id: AssetId; x: number; y: number; trigger: HTMLButtonElement } | null>>;
  menuAsset: AssetPresentation | null | undefined;
  isDraggableAsset: (kind: Asset["kind"]) => boolean;
  assetDragProps: (item: AssetPresentation) => {
    draggable: boolean;
    onDragStart?: (event: DragEvent<HTMLElement>) => void;
    onDragEnd?: () => void;
  };
  previewFromLibrary: (item: AssetPresentation) => void;
  importAsset: (kind: AssetKind) => Promise<void>;
  insertDefaultText: () => Promise<void>;
  importSubtitleFile: () => Promise<void>;
  startTranscription: (asset: Asset) => void;
  cvBusy: AssetId | null;
  cvSummaries: Partial<Record<AssetId, CvAnalysisSummary>>;
  cvSparkAssetId: AssetId | null;
  cvSparkSamples: CvSample[] | null;
  cvSummaryText: (asset: Asset) => string | undefined;
  toggleCvSpark: (asset: Asset) => void;
  onOpenCvOptions: (item: AssetPresentation) => void;
  onOpenEditingTools: () => void;
  revealAsset: (asset: Asset) => Promise<void>;
  setPendingDeleteAsset: (asset: Asset) => void;
  transcriptRows: Array<{ summary: TranscriptSummary; assetName: string }>;
  loadedTranscript: (transcriptId: string) => Transcript | undefined;
  viewTranscript: (summary: TranscriptSummary) => Promise<void>;
  openDeleteTranscriptDialog: (summary: TranscriptSummary) => void;
  openModel: (model: ModelSummary) => Promise<void>;
  cancelModel: (model: ModelSummary) => Promise<void>;
  retryTranscription: (job: Job) => Promise<void>;
  cancelJob: (job: Job) => Promise<void>;
  deleteJob: (job: Job) => Promise<void>;
  onCreateEmptyTimeline: () => void;
}

export function LibraryPane({
  leftPaneOpen,
  tab,
  setTab,
  project,
  timeline,
  assets,
  visibleAssets,
  visibleAssetOrder,
  models,
  jobs,
  libraryScope,
  changeLibraryScope,
  assetFilter,
  setAssetFilter,
  assetQuery,
  setAssetQuery,
  assetView,
  changeAssetView,
  assetSortByName,
  setAssetSortByName,
  refreshingAssets,
  refreshAssets,
  selectedAssetIds,
  selectAsset,
  setPickedAssetIds,
  resetAssetSelection,
  usedAssetIds,
  favoriteAssetIds,
  setAssetFavorites,
  assetMenu,
  setAssetMenu,
  menuAsset,
  isDraggableAsset,
  assetDragProps,
  previewFromLibrary,
  importAsset,
  insertDefaultText,
  importSubtitleFile,
  startTranscription,
  cvBusy,
  cvSummaries,
  cvSparkAssetId,
  cvSparkSamples,
  cvSummaryText,
  toggleCvSpark,
  onOpenCvOptions,
  onOpenEditingTools,
  revealAsset,
  setPendingDeleteAsset,
  transcriptRows,
  loadedTranscript,
  viewTranscript,
  openDeleteTranscriptDialog,
  openModel,
  cancelModel,
  retryTranscription,
  cancelJob,
  deleteJob,
  onCreateEmptyTimeline,
}: LibraryPaneProps) {
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
      id: "preview",
      label: `预览播放 ${asset.display_name}`,
      icon: <Play size={13} />,
      disabled: asset.availability !== "available" || !item.media_url,
      onSelect: () => previewFromLibrary(item),
    }];
    if (isTranscribable(asset)) {
      actions.push({ id: "transcribe", label: "转录", icon: <FileText size={13} />, onSelect: () => startTranscription(asset) });
    }
    if (asset.kind === "video" && asset.availability === "available") {
      actions.push(
        { id: "edit", label: "剪辑手法", icon: <Scissors size={13} />, disabled: cvBusy !== null, onSelect: onOpenEditingTools },
        {
          id: "analyze",
          label: "AI 信号分析",
          icon: <Sparkles size={13} />,
          disabled: cvBusy !== null,
          onSelect: () => onOpenCvOptions(item),
        },
      );
    }
    actions.push(
      {
        id: "favorite",
        label: favoriteAssetIds.has(asset.asset_id) ? "取消收藏" : "收藏素材",
        icon: <Star size={13} />,
        onSelect: () => setAssetFavorites(ids => ids.includes(asset.asset_id) ? ids.filter(id => id !== asset.asset_id) : [...ids, asset.asset_id]),
      },
      { id: "reveal", label: `打开 ${asset.display_name} 所在文件夹`, icon: <FolderOpen size={13} />, onSelect: () => void revealAsset(asset) },
      { id: "delete", label: `删除 ${asset.display_name}`, icon: <Trash2 size={13} />, danger: true, onSelect: () => setPendingDeleteAsset(asset) },
    );
    return actions;
  };

  return (
    <section className={"library-pane" + (leftPaneOpen ? "" : " pane-closed")} aria-label="媒体库" hidden={!leftPaneOpen}>
      <div className="left-seg" role="tablist" aria-label="工作区分区">
        <button role="tab" aria-selected={tab === "assets"} className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}><Clapperboard size={15} aria-hidden="true" />素材</button>
        <button role="tab" aria-selected={tab === "transcripts"} className={tab === "transcripts" ? "active" : ""} onClick={() => setTab("transcripts")}><Captions size={15} aria-hidden="true" />转录</button>
        <button role="tab" aria-selected={tab === "models"} className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}><Archive size={15} aria-hidden="true" />模型</button>
        <button role="tab" aria-selected={tab === "jobs"} className={tab === "jobs" ? "active" : ""} onClick={() => setTab("jobs")}><History size={15} aria-hidden="true" />任务</button>
      </div>
      {tab === "assets" ? (
        <div className="asset-drawer">
          <nav className="asset-category-rail" aria-label="素材分类">
            <button type="button" aria-pressed={libraryScope === "import" && assetFilter === "all"} onClick={() => changeLibraryScope("import")}>导入</button>
            <button type="button" aria-pressed={libraryScope === "favorites"} onClick={() => changeLibraryScope("favorites")}>收藏</button>
            {assetKinds.map(kind => (
              <button
                type="button"
                key={kind}
                aria-pressed={libraryScope === "import" && assetFilter === kind}
                onClick={() => changeLibraryScope("import", kind)}
              >
                {assetKindLabels[kind]}
              </button>
            ))}
          </nav>
          <div className="asset-drawer-content">
            {libraryScope === "import" && (
              <>
                <div className="library-toolbar">
                  {["video", "audio", "image"].map(kind => (
                    <button
                      key={kind}
                      disabled={!project || project.status !== "active"}
                      onClick={() => void importAsset(kind as AssetKind)}
                      title={`导入${assetKindLabels[kind as AssetKind]}素材`}
                      aria-label={`导入${assetKindLabels[kind as AssetKind]}`}
                    >
                      <span className="lib-card-ico">{kind === "video" ? <Video size={17} /> : kind === "audio" ? <AudioLines size={17} /> : <ImagePlus size={17} />}</span>
                      <span>{assetKindLabels[kind as AssetKind]}</span>
                    </button>
                  ))}
                </div>
                <div className="text-materials" aria-label="文本素材">
                  <button disabled={!project || project.status !== "active"} onClick={() => void insertDefaultText()} title="插入到播放头处（3 秒）"><Type size={13} />默认文本</button>
                  <button disabled={!project || project.status !== "active"} onClick={() => void importSubtitleFile()} title="支持 SRT / ASS / SSA / LRC"><Captions size={13} />导入字幕</button>
                </div>
              </>
            )}
            <div className="library-filter-toolbar">
              <label className="asset-search">
                <Search size={14} aria-hidden="true" />
                <input type="search" aria-label="搜索素材" placeholder="搜索" value={assetQuery} onChange={event => setAssetQuery(event.target.value)} />
              </label>
              <button
                type="button"
                className="icon-btn"
                aria-label={assetView === "grid" ? "切换到列表视图" : "切换到网格视图"}
                title={assetView === "grid" ? "切换到列表视图" : "切换到网格视图"}
                onClick={() => changeAssetView(assetView === "grid" ? "list" : "grid")}
              >
                {assetView === "grid" ? <List size={15} aria-hidden="true" /> : <LayoutGrid size={15} aria-hidden="true" />}
              </button>
              <select aria-label="素材类型" value={assetFilter} onChange={event => setAssetFilter(event.target.value as AssetFilter)}>
                <option value="all">全部</option>
                {assetKinds.map(kind => <option value={kind} key={kind}>{assetKindLabels[kind]}</option>)}
              </select>
              <button
                type="button"
                className="icon-btn"
                aria-label="按名称排序"
                aria-pressed={assetSortByName}
                title={assetSortByName ? "恢复默认排序" : "按名称排序"}
                onClick={() => setAssetSortByName(value => !value)}
              >
                <ArrowUpDown size={15} aria-hidden="true" />
              </button>
              <IconButton label={refreshingAssets ? "正在刷新素材库" : "刷新素材库"} disabled={refreshingAssets || !project} onClick={() => void refreshAssets()}>
                <RefreshCw size={15} className={refreshingAssets ? "spin" : ""} />
              </IconButton>
            </div>
            <div className="asset-library-status" role="status">
              {refreshingAssets ? "正在检查本地素材…" : `${libraryScope === "favorites" ? "收藏" : assetFilter === "all" ? "全部" : assetKindLabels[assetFilter]} · ${visibleAssets.length} 项${selectedAssetIds.size > 1 ? ` · 已选 ${selectedAssetIds.size} 项` : ""}`}
            </div>
            {visibleAssets.length === 0 && (
              <div className="asset-library-empty">
                <Clapperboard size={22} aria-hidden="true" />
                <span>{!project ? "请先打开项目" : assetQuery.trim() || assetFilter !== "all" ? "没有匹配的素材" : libraryScope === "favorites" ? "还没有收藏的素材" : "还没有素材，请先导入"}</span>
                {(assetQuery.trim() || assetFilter !== "all") && <button type="button" onClick={() => { setAssetQuery(""); setAssetFilter("all"); }}>清除筛选</button>}
              </div>
            )}
            <div className={`asset-list asset-table asset-view-${assetView}`} aria-label="项目素材">
              {visibleAssets.map(item => {
                const { asset } = item;
                const selected = selectedAssetIds.has(asset.asset_id);
                const durationLabel = assetDurationLabel(asset);
                const cvSummary = cvSummaryText(asset);
                const sparkOpen = cvSparkAssetId === asset.asset_id;
                const openAssetMenu = (trigger: HTMLButtonElement, x: number, y: number) => {
                  if (!selected) selectAsset(asset.asset_id);
                  setAssetMenu({ id: asset.asset_id, trigger, x, y });
                };
                return (
                  <div
                    className={`asset-item asset-row${selected ? " sel" : ""}${isDraggableAsset(asset.kind) ? " draggable-asset" : ""}`}
                    key={asset.asset_id}
                    {...assetDragProps(item)}
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
                    }}
                  >
                    <button
                      type="button"
                      className="asset-select"
                      data-asset-id={asset.asset_id}
                      aria-pressed={selected}
                      aria-haspopup="menu"
                      aria-label={`${asset.display_name}，${assetKindLabels[asset.kind]}${asset.availability === "available" ? "" : `，${availabilityLabels[asset.availability]}`}`}
                      title={asset.display_name}
                      onClick={event => selectAsset(asset.asset_id, event)}
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
                      }}
                    >
                      <span className="asset-select-media">
                        {assetThumb(item)}
                        {usedAssetIds.has(asset.asset_id) && <span className="asset-used">已添加</span>}
                        {favoriteAssetIds.has(asset.asset_id) && <span className="asset-favorite-mark"><Star size={11} fill="currentColor" aria-label="已收藏" /></span>}
                        {durationLabel !== "—" && <span className="asset-time-badge">{durationLabel}</span>}
                      </span>
                      <span className="asset-filename">{asset.display_name}</span>
                      <span className="asset-row-meta" title={assetMetaText(asset)}>{assetMetaText(asset)}</span>
                      <span className="asset-row-time">{durationLabel}</span>
                    </button>
                    <div className="asset-actions">
                      {assetActionItems(item).map(action => (
                        <IconButton key={action.id} label={action.label} disabled={action.disabled} onClick={action.onSelect}>
                          {action.icon}
                        </IconButton>
                      ))}
                    </div>
                    {cvSummary && <div className="asset-cv-summary" title={cvSummary}>{cvSummary}</div>}
                    {asset.kind === "video" && cvSummaries[asset.asset_id]?.status === "ready" && (
                      <button
                        type="button"
                        className="cv-spark-toggle"
                        aria-expanded={sparkOpen}
                        aria-label={`${sparkOpen ? "收起" : "展开"} ${asset.display_name} 的信号曲线`}
                        onClick={() => toggleCvSpark(asset)}
                      >
                        {sparkOpen ? "收起信号" : "信号曲线"}
                      </button>
                    )}
                    {sparkOpen && (
                      <div className="cv-spark">
                        {cvSparkSamples === null ? <small role="status">加载中…</small> : cvSparkSamples.length < 2 ? <small>暂无样本数据</small> : (
                          <>
                            <svg viewBox="0 0 100 1" preserveAspectRatio="none" aria-label="CV 信号曲线">
                              <path d={cvSparkPath(cvSparkSamples, "motion_energy")} fill="none" stroke="#7aa2f7" strokeWidth="0.02" />
                              <path d={cvSparkPath(cvSparkSamples, "audio_energy")} fill="none" stroke="#9ece6a" strokeWidth="0.02" opacity="0.7" />
                              {cvSparkSamples.filter(sample => sample.scene_cut).map((sample, index) => {
                                const x = sample.timestamp_us / (cvSparkSamples.at(-1)?.timestamp_us || 1) * 100;
                                return <line key={index} x1={x} x2={x} y1={0} y2={1} stroke="#f7768e" strokeWidth="0.03" />;
                              })}
                            </svg>
                            <small className="cv-spark-legend"><span style={{ color: "#7aa2f7" }}>运动能量</span> · <span style={{ color: "#9ece6a" }}>音频能量</span> · <span style={{ color: "#f7768e" }}>场景切换</span></small>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {assetMenu && menuAsset && (
              <ContextMenu
                x={assetMenu.x}
                y={assetMenu.y}
                items={assetActionItems(menuAsset)}
                onClose={() => { setAssetMenu(null); assetMenu.trigger.focus({ preventScroll: true }); }}
              />
            )}
          </div>
        </div>
      ) : tab === "transcripts" ? (
        <div className="transcript-list">
          <p className="panel-hint">只读展示语音识别结果；点开一条记录后勾选片段，可追加到时间线并生成字幕。</p>
          {transcriptRows.length === 0 && <p className="panel-hint">尚未生成转录：在"素材"页对视频/音频素材点击"转录"按钮后，结果会出现在这里。</p>}
          {transcriptRows.map(({ summary, assetName }) => {
            const loaded = loadedTranscript(summary.transcript_id);
            return (
              <div className="transcript-item" key={summary.transcript_id}>
                <div className="transcript-item-head">
                  <button
                    className="transcript-open-button"
                    aria-label={`查看转录 ${summary.transcript_id}`}
                    onClick={() => void viewTranscript(summary)}
                    title="查看并选择转录片段"
                  >
                    <strong title={assetName}>{assetName}</strong>
                    <small>{transcriptStatusLabels[summary.status]} · {summary.language}{loaded ? ` · ${loaded.segments.length} 段` : ""} · 点击查看内容与操作</small>
                  </button>
                  <IconButton label={`删除转录 ${summary.transcript_id}`} onClick={() => openDeleteTranscriptDialog(summary)}>
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      ) : tab === "models" ? (
        <div className="model-page">
          <p className="panel-hint">本地语音识别模型：下载后可在视频/音频素材上发起转录，生成带时间戳的字幕底稿；下载中可取消，失败可重试。</p>
          {models.map(model => {
            const dl = ["queued", "downloading", "verifying", "paused"].includes(model.status);
            const pct = model.progress !== null && model.progress !== undefined ? `${Math.round(model.progress * 100)}%` : "—";
            return (
              <div className={`model-row${dl ? " dl" : ""}`} key={model.model_id}>
                <div className="model-ico"><FileText size={14} /></div>
                <div className="model-main">
                  <div className="model-head">
                    <strong title={model.display_name}>{model.display_name}</strong>
                    <span className={`badge ${model.status === "ready" ? "ok" : dl ? "run" : model.status === "failed" || model.status === "corrupt" ? "bad" : "dim"}`}>{modelBadgeLabels[model.status]}</span>
                    {dl && <span className="mpct">{pct}</span>}
                  </div>
                  {dl && (
                    <div className="model-down">
                      <progress className="model-progress" max={1} value={model.progress ?? 0} />
                      <button className="mini-btn" title="取消模型下载" onClick={() => void cancelModel(model)}>取消下载</button>
                    </div>
                  )}
                  <small className="model-sub">{modelStatusLabels[model.status]} · {model.provider}</small>
                </div>
                {!dl && ["unavailable", "failed", "cancelled", "paused", "corrupt"].includes(model.status) && (
                  <button className="mini-btn" onClick={() => void openModel(model)}>
                    {model.status === "failed" ? "重试下载" : model.status === "corrupt" ? "重新下载" : model.status === "paused" ? "继续下载" : "下载模型"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="jobs-page">
          <p className="panel-hint">转录、权威预览与导出的后台进度会显示在这里；运行中的任务可取消，失败的转录可重试。</p>
          {jobs.length === 0 && <p className="panel-hint">暂无任务。</p>}
          {(() => {
            const activeJobs = jobs.filter(job => ["running", "cancelling"].includes(job.status));
            const queuedJobs = jobs.filter(job => job.status === "queued");
            const doneJobs = jobs.filter(job => ["succeeded", "failed", "cancelled", "interrupted"].includes(job.status));
            const renderJobRow = (job: Job) => {
              const badgeClass = job.status === "succeeded" ? "ok" : job.status === "failed" ? "bad" : job.status === "running" ? "run" : "dim";
              const phaseText = job.phase ? (jobPhaseLabels[job.phase] ?? job.phase) : null;
              const phasePct = phaseText && job.phase_progress !== null && job.phase_progress !== undefined ? ` ${Math.round(job.phase_progress * 100)}%` : "";
              return (
                <div className="job-row" key={job.job_id}>
                  <div className="jmain">
                    <div className="jhead">
                      <strong>{jobKindLabels[job.kind] ?? job.kind}</strong>
                      <span className={`badge ${badgeClass}`}>{jobStatusLabels[job.status]}</span>
                      <span className="jpct">{job.progress !== null ? `${Math.round(job.progress * 100)}%` : "—"}</span>
                    </div>
                    {job.progress !== null && <div className="jbar"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}
                    <div className="jmeta">
                      <span>{jobDetailText(job, assets.find(item => item.asset.asset_id === job.asset_id)?.asset.display_name)}{phaseText || job.stage ? ` · ${phaseText ? `${phaseText}${phasePct}` : job.stage}` : ""}{job.error ? ` · ${safeTaskErrorMessage(job.error)}` : ""}</span>
                      {job.status === "running" && <JobEta job={job} />}
                    </div>
                    <div className="jops">
                      {job.kind === "transcription" && (job.status === "failed" || job.status === "interrupted") && <button className="mini-btn" onClick={() => void retryTranscription(job)}>重试转录</button>}
                      {["queued", "running", "cancelling"].includes(job.status) && <button className="mini-btn" onClick={() => void cancelJob(job)}>取消</button>}
                      {["succeeded", "failed", "cancelled", "interrupted"].includes(job.status) && <button className="mini-btn danger-ghost" aria-label={`删除任务 ${job.job_id}`} title="从列表移除这条任务记录" onClick={() => void deleteJob(job)}>删除</button>}
                    </div>
                  </div>
                </div>
              );
            };
            return (
              <>
                {activeJobs.length > 0 && <div className="jobs-group">进行中</div>}
                {activeJobs.map(renderJobRow)}
                {queuedJobs.length > 0 && <div className="jobs-group">排队</div>}
                {queuedJobs.map(renderJobRow)}
                {doneJobs.length > 0 && <div className="jobs-group">已完成 / 失败</div>}
                {doneJobs.map(renderJobRow)}
              </>
            );
          })()}
        </div>
      )}
      {!timeline && project && (
        <div className="empty-timeline">
          <button onClick={onCreateEmptyTimeline}>创建空时间线</button>
        </div>
      )}
    </section>
  );
}
