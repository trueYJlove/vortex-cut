import { Fragment, type KeyboardEvent, type RefObject } from "react";
import {
  BookOpen,
  Clapperboard,
  Command as CommandIcon,
  Download,
  Eye,
  FileText,
  FlaskConical,
  FolderCog,
  GitCompare,
  Image as ImageIcon,
  Keyboard,
  LayoutPanelLeft,
  MapPin,
  MonitorPlay,
  Play,
  Redo2,
  RefreshCw,
  Scissors,
  Search,
  Sparkles,
  Square,
  SquarePlus,
  Trash2,
  Undo2,
  Upload,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import type {
  AssetId,
  Job,
  LayoutPolicy,
  OutputRatio,
  Project,
  TimelineDocument,
  TimelineState,
} from "@aivideo/contracts";
import { AgentSessionPanel } from "../agent-session/AgentSessionPanel.js";
import { AngleSyncPanel } from "../angle-sync/AngleSyncPanel.js";
import { CaptionsProviderPanel } from "../captions-provider/CaptionsProviderPanel.js";
import { CoverDialog } from "../CoverDialog.js";
import { Dialog } from "../Dialog.js";
import { EditingGrammarPanel } from "../editing-grammar/EditingGrammarPanel.js";
import { EditingToolsPanel } from "../editing-grammar/EditingToolsPanel.js";
import { ExportDialog } from "../ExportDialog.js";
import { JobEta } from "../JobEta.js";
import { KeyframeReviewPanel } from "../keyframe-review/KeyframeReviewPanel.js";
import { MediaGenerationWorkbench } from "../media-generation/MediaGenerationWorkbench.js";
import { ProjectLibraryDialog } from "../ProjectLibraryDialog.js";
import { TimelineDiffView } from "../PropertyPanels.js";
import { ProviderImageGenerationWorkbench } from "../provider-image-generation/ProviderImageGenerationWorkbench.js";
import { ProviderSettingsDialog } from "../provider-settings/ProviderSettingsDialog.js";
import { SemanticSearchPanel } from "../semantic-search/SemanticSearchPanel.js";
import { SettingsDialog } from "../settings/SettingsDialog.js";
import { ShotRequirementWorkbench } from "../shot-requirements/ShotRequirementWorkbench.js";
import { WorklistPanel } from "../worklist/WorklistPanel.js";
import { bindingLabel, type ShortcutCommandId, type ShortcutEntry } from "../shortcuts.js";
import type { EditorCommand } from "../editorCommands.js";
import { safeTaskErrorMessage } from "../safeErrors.js";
import {
  fallbackReasonLabel,
  formatBytes,
  formatRelativeTime,
  jobKindLabels,
  jobPhaseLabels,
  jobStatusLabels,
  layoutPolicies,
  toggle,
  type NoticeTone,
} from "../appHelpers.js";
import type { useAiWorkflows } from "../hooks/useAiWorkflows.js";
import type { useAssetAndMediaLibrary } from "../hooks/useAssetAndMediaLibrary.js";
import type { useExportAndRender } from "../hooks/useExportAndRender.js";
import { IconButton, ReframeTargetEditor, SegmentRow } from "./AppMicroComponents.js";

const COMMAND_ICON_MAP: Record<string, LucideIcon> = {
  "play.pause": Play,
  "timeline.undo": Undo2,
  "timeline.redo": Redo2,
  "timeline.split": Scissors,
  "timeline.copy": FileText,
  "timeline.cut": Scissors,
  "timeline.paste": Download,
  "timeline.delete": Trash2,
  "timeline.create": SquarePlus,
  "preview.generate": MonitorPlay,
  "export.open": Upload,
  "ai.open": Sparkles,
  "ai.revise": WandSparkles,
  "project.manage": FolderCog,
  "project.refresh": RefreshCw,
  "ui.resetLayout": LayoutPanelLeft,
  "ui.shortcuts": Keyboard,
  "tools.compare": GitCompare,
  "tools.shots": Clapperboard,
  "tools.verify": FlaskConical,
  "tools.imageGen": ImageIcon,
  "help.manual": BookOpen,
  "command.search": CommandIcon,
};

export interface AppDialogsProps {
  project: Project | undefined;
  projects: Project[];
  working: TimelineDocument | undefined;
  timeline: TimelineState | undefined;
  jobs: Job[];
  renderRatio: OutputRatio;
  setPreviewMode: (mode: "interactive" | "authoritative" | "synthetic") => void;
  acceptState: (next: TimelineState) => void;
  showNotice: (text: string, tone?: NoticeTone) => void;
  switchProject: (selected: Project) => void;
  aiWorkflows: ReturnType<typeof useAiWorkflows>;
  exportRender: ReturnType<typeof useExportAndRender>;
  assetLibrary: ReturnType<typeof useAssetAndMediaLibrary>;
  newProject: string;
  setNewProject: (value: string) => void;
  newProjectRatio: string;
  setNewProjectRatio: (value: string) => void;
  projectDialogOpen: boolean;
  setProjectDialogOpen: (open: boolean) => void;
  projectManagerRefreshing: boolean;
  createProject: () => Promise<void>;
  refreshProjectManager: () => Promise<void>;
  renameManagedProject: (target: Project, name: string) => Promise<void>;
  toggleManagedProjectArchive: (target: Project) => Promise<void>;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  providerSettingsOpen: boolean;
  setProviderSettingsOpen: (open: boolean) => void;
  agentOpen: boolean;
  setAgentOpen: (open: boolean) => void;
  worklistOpen: boolean;
  setWorklistOpen: (open: boolean) => void;
  editingGrammarOpen: boolean;
  setEditingGrammarOpen: (open: boolean) => void;
  editingToolsTool: "remove_pauses" | "beat_sync" | "lj_cut" | null;
  setEditingToolsTool: (tool: "remove_pauses" | "beat_sync" | "lj_cut" | null) => void;
  editingToolsClipId: string | null;
  angleSyncOpen: boolean;
  setAngleSyncOpen: (open: boolean) => void;
  semanticSearchOpen: boolean;
  setSemanticSearchOpen: (open: boolean) => void;
  keyframeReviewOpen: boolean;
  setKeyframeReviewOpen: (open: boolean) => void;
  providerImageGenerationOpen: boolean;
  setProviderImageGenerationOpen: (open: boolean) => void;
  shotRequirementsOpen: boolean;
  setShotRequirementsOpen: (open: boolean) => void;
  generationOpen: boolean;
  setGenerationOpen: (open: boolean) => void;
  commandSearchOpen: boolean;
  commandQuery: string;
  setCommandQuery: (query: string) => void;
  commandSearchInputRef: RefObject<HTMLInputElement | null>;
  commandIndex: number;
  setCommandIndex: (index: number) => void;
  filteredCommands: readonly EditorCommand[];
  commandDisabledReason: (id: EditorCommand["id"]) => string | undefined;
  runCommand: (id: EditorCommand["id"]) => void;
  closeCommandSearch: () => void;
  handleCommandPaletteKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  shortcuts: Record<ShortcutCommandId, ShortcutEntry>;
  shortcutsRef: RefObject<Record<ShortcutCommandId, ShortcutEntry>>;
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
  recordingId: ShortcutCommandId | null;
  setRecordingId: (id: ShortcutCommandId | null) => void;
  resetShortcutsToDefault: () => void;
  handleRecordKey: (event: KeyboardEvent, id: ShortcutCommandId) => void;
}

export function AppDialogs(props: AppDialogsProps) {
  const {
    project,
    projects,
    working,
    timeline,
    jobs,
    renderRatio,
    setPreviewMode,
    acceptState,
    showNotice,
    switchProject,
    aiWorkflows,
    exportRender,
    assetLibrary,
    newProject,
    setNewProject,
    newProjectRatio,
    setNewProjectRatio,
    projectDialogOpen,
    setProjectDialogOpen,
    projectManagerRefreshing,
    createProject,
    refreshProjectManager,
    renameManagedProject,
    toggleManagedProjectArchive,
    settingsOpen,
    setSettingsOpen,
    providerSettingsOpen,
    setProviderSettingsOpen,
    agentOpen,
    setAgentOpen,
    worklistOpen,
    setWorklistOpen,
    editingGrammarOpen,
    setEditingGrammarOpen,
    editingToolsTool,
    setEditingToolsTool,
    editingToolsClipId,
    angleSyncOpen,
    setAngleSyncOpen,
    semanticSearchOpen,
    setSemanticSearchOpen,
    keyframeReviewOpen,
    setKeyframeReviewOpen,
    providerImageGenerationOpen,
    setProviderImageGenerationOpen,
    shotRequirementsOpen,
    setShotRequirementsOpen,
    generationOpen,
    setGenerationOpen,
    commandSearchOpen,
    commandQuery,
    setCommandQuery,
    commandSearchInputRef,
    commandIndex,
    setCommandIndex,
    filteredCommands,
    commandDisabledReason,
    runCommand,
    closeCommandSearch,
    handleCommandPaletteKeyDown,
    shortcuts,
    shortcutsRef,
    shortcutsOpen,
    setShortcutsOpen,
    recordingId,
    setRecordingId,
    resetShortcutsToDefault,
    handleRecordKey,
  } = props;

  const {
    coverUrl,
    encoderMode, setEncoderMode,
    exportQuality, setExportQuality,
    exportResolution, setExportResolution,
    exportFrameRate, setExportFrameRate,
    exportDialogOpen, setExportDialogOpen,
    exportBusy,
    coverDialogOpen, setCoverDialogOpen,
    exports,
    setExportPlayback,
    batchOpen, setBatchOpen,
    renderPanelOpen, setRenderPanelOpen,
    platformPresets, renditionPresets, renditionTargets, setRenditionTargets,
    activeBatch, setActiveBatch, batchError, setBatchError,
    reframeSelections, reframePreviews, reframePending, setReframePlayback,
    reframeDirectoryGrant, directoryGrant, activeReframeBatch, setActiveReframeBatch, reframeError, setReframeError,
    loadRenderData, removeMissingExport, captureCover, applyCover,
    submitExport, targetPreview, addTarget, updateTarget,
    generateRenditionPreview, chooseBatchDirectory, createBatch, retryBatchItems,
    reframeClips, targetAdjustments, selectReframeAnchor, generateReframePreview,
    chooseReframeDirectory, createReframeBatch, retryReframeBatchItems,
    authoritativePreview, previewIsStale,
  } = exportRender;

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
    revisionDiff, setRevisionDiff, mergedProviders,
    prepareAi, createAi, testCandidateProviderCapability, playAiClip, adoptAi,
    closePatch, preparePatch, testPatchProviderCapability,
    createPatch, cancelPatch, applyPatchProposal, compareRevisions,
  } = aiWorkflows;

  const {
    assets, semanticAssetNames, transcriptSummaries,
    confirmModel, setConfirmModel, licenseAccepted, setLicenseAccepted,
    transcriptionAsset, setTranscriptionAsset, pendingDeleteAsset, setPendingDeleteAsset,
    selectedAssetId, deleteBusy, viewingTranscript, setViewingTranscript,
    language, setLanguage, wordTimestamps, setWordTimestamps,
    selectedSegments, setSelectedSegments, captionsOptimize, setCaptionsOptimize,
    pendingDeleteTranscript, setPendingDeleteTranscript, deleteTranscriptBusy,
    cvOptionsOpen, setCvOptionsOpen, cvOptionsAsset, setCvOptionsAsset,
    cvTargetGapS, setCvTargetGapS, cvBudgetPerMin, setCvBudgetPerMin,
    insertSegments, deleteAsset, deleteTranscript, originalShortEdge,
    downloadModel, submitTranscription, cancelJob, startCvAnalysis, submitCvOptions,
  } = assetLibrary;

  return (
    <>
      {exportDialogOpen && project && working && timeline && (
        <ExportDialog
          projectId={project.project_id}
          projectName={project.name}
          durationUs={working.clips.reduce((max, item) => Math.max(max, item.timeline_end_us), 0)}
          clipCount={working.clips.length}
          captionCount={working.captions?.length ?? 0}
          canvas={project.canvas}
          ratio={renderRatio}
          coverUrl={coverUrl}
          previewReady={Boolean(authoritativePreview && !previewIsStale && authoritativePreview.preview.status === "ready")}
          encoderMode={encoderMode}
          onEncoderModeChange={setEncoderMode}
          quality={exportQuality}
          onQualityChange={setExportQuality}
          resolution={exportResolution}
          onResolutionChange={setExportResolution}
          frameRate={exportFrameRate}
          onFrameRateChange={setExportFrameRate}
          originalShortEdge={originalShortEdge}
          busy={exportBusy}
          onClose={() => setExportDialogOpen(false)}
          onOpenCover={() => setCoverDialogOpen(true)}
          onExport={submitExport}
        />
      )}
      {coverDialogOpen && (
        <CoverDialog
          coverUrl={coverUrl}
          onClose={() => setCoverDialogOpen(false)}
          onCapture={() => captureCover()}
          onChange={applyCover}
        />
      )}
      {projectDialogOpen && (
        <ProjectLibraryDialog
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
        />
      )}
      {batchOpen && (
        <Dialog
          titleId="export-batch-title"
          closeLabel="关闭多平台导出"
          title="多平台导出"
          subtitle="平台与画幅独立选择；仅同一 Revision 的权威预览可进入批次。"
          footer={(
            <>
              <button disabled={renditionTargets.length >= 8 || !platformPresets.length} onClick={addTarget}>添加目标</button>
              <button onClick={() => void chooseBatchDirectory()}>{directoryGrant ? `输出目录：${directoryGrant.display_name}` : "选择输出目录"}</button>
              <button disabled={!directoryGrant || !renditionTargets.length || renditionTargets.some(target => !targetPreview(target))} onClick={() => void createBatch()}>创建批次</button>
            </>
          )}
          label="多平台导出"
          onClose={() => setBatchOpen(false)}
          className="export-batch-modal"
        >
          {batchError && <p className="ai-status" role="status">{batchError}</p>}
          <div className="rendition-targets">
            {renditionTargets.map(target => {
              const platform = platformPresets.find(item => item.platform_preset_id === target.platform_preset_id);
              const rendition = renditionPresets.find(item => item.rendition_preset_id === target.rendition_preset_id);
              const preview = targetPreview(target);
              return (
                <section key={target.key} className="rendition-target">
                  <label>
                    平台
                    <select
                      aria-label="导出平台"
                      value={target.platform_preset_id}
                      onChange={event => {
                        const next = platformPresets.find(item => item.platform_preset_id === event.target.value);
                        if (next) updateTarget(target.key, { platform_preset_id: next.platform_preset_id, rendition_preset_id: next.default_rendition_id, key: `${next.platform_preset_id}:${next.default_rendition_id}` });
                      }}
                    >
                      <option value="">选择平台</option>
                      {platformPresets.map(item => <option value={item.platform_preset_id} key={item.platform_preset_id}>{item.display_name}</option>)}
                    </select>
                  </label>
                  <label>
                    画幅
                    <select
                      aria-label="导出画幅"
                      value={target.rendition_preset_id}
                      onChange={event => updateTarget(target.key, { rendition_preset_id: event.target.value, key: `${target.platform_preset_id}:${event.target.value}` })}
                    >
                      {platform?.allowed_rendition_ids.map(id => <option value={id} key={id}>{renditionPresets.find(item => item.rendition_preset_id === id)?.display_name ?? id}</option>)}
                    </select>
                  </label>
                  <label>
                    布局
                    <select
                      aria-label="目标布局策略"
                      value={target.layout_policy}
                      onChange={event => updateTarget(target.key, { layout_policy: event.target.value as LayoutPolicy })}
                    >
                      {layoutPolicies.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}
                    </select>
                  </label>
                  <div className="target-summary">
                    <small>{rendition ? `${rendition.export.width}×${rendition.export.height} · H.264/AAC · 30fps` : "预设加载中"}</small>
                    <small>{preview ? `权威预览已就绪${preview.preview.warnings.length ? ` · ${preview.preview.warnings.join(", ")}` : ""}` : "需要本目标权威预览"}</small>
                  </div>
                  <div className="target-actions">
                    <button onClick={() => void generateRenditionPreview(target)}>{preview ? "重新生成权威预览" : "生成权威预览"}</button>
                    <button disabled={renditionTargets.length === 1} onClick={() => setRenditionTargets(items => items.filter(item => item.key !== target.key))}>移除</button>
                  </div>
                  {preview && (
                    <ReframeTargetEditor
                      clips={reframeClips(target)}
                      selections={reframeSelections[target.key] ?? {}}
                      preview={reframePreviews[target.key]}
                      pending={Boolean(reframePending[target.key])}
                      onSelect={(clipId, anchor) => selectReframeAnchor(target, clipId, anchor)}
                      onGenerate={() => void generateReframePreview(target)}
                      onPlay={() => { setReframePlayback(reframePreviews[target.key]); setExportPlayback(undefined); setPreviewMode("authoritative"); }}
                    />
                  )}
                </section>
              );
            })}
          </div>
          <section className="reframe-batch-actions" aria-label="静态焦点批量导出">
            <h3>静态焦点批量导出</h3>
            <p>独立于基础 Stage 3A 批次；所有目标的重构图权威预览就绪后才可创建。</p>
            {reframeError && <p className="ai-status" role="status">{reframeError}</p>}
            <div className="modal-actions">
              <button disabled={renditionTargets.some(target => !targetAdjustments(target).length || !reframePreviews[target.key])} onClick={() => void chooseReframeDirectory()}>{reframeDirectoryGrant ? `重构图输出目录：${reframeDirectoryGrant.display_name}` : "选择重构图输出目录"}</button>
              <button disabled={!reframeDirectoryGrant || renditionTargets.some(target => !targetAdjustments(target).length || !reframePreviews[target.key])} onClick={() => void createReframeBatch()}>创建重构图批次</button>
            </div>
          </section>
          {activeBatch && (
            <section className="batch-status">
              <h3>批次 {activeBatch.status}</h3>
              <p>目录：{activeBatch.directory_display_name}</p>
              {activeBatch.items.map(item => (
                <div key={item.export_batch_item_id}>
                  <strong>{item.rendition_snapshot.platform_preset_id} · {item.rendition_snapshot.rendition_preset_id}</strong>
                  <small>{item.status} · {item.progress === null ? "--" : `${Math.round(item.progress * 100)}%`}{item.destination_display_name ? ` · ${item.destination_display_name}` : ""}{item.error_code ? ` · ${item.error_code}` : ""}</small>
                </div>
              ))}
              <div className="modal-actions">
                {["queued", "running"].includes(activeBatch.status) && <button onClick={() => void window.desktop.cancelExportBatch(activeBatch.export_batch_id).then(setActiveBatch).catch(() => setBatchError("取消批次失败。"))}>取消批次</button>}
                {activeBatch.items.some(item => ["failed", "cancelled", "interrupted"].includes(item.status)) && <button onClick={() => void retryBatchItems()}>重新授权并重试失败项</button>}
              </div>
            </section>
          )}
          {activeReframeBatch && (
            <section className="batch-status reframe-batch-status">
              <h3>重构图批次{activeReframeBatch.status}</h3>
              <p>目录：{activeReframeBatch.directory_display_name}</p>
              {activeReframeBatch.items.map(item => (
                <div key={item.reframe_export_batch_item_id}>
                  <strong>{item.rendition_reframe_snapshot.platform_preset_id} · {item.rendition_reframe_snapshot.rendition_preset_id}</strong>
                  <small>{item.status} · {item.progress === null ? "--" : `${Math.round(item.progress * 100)}%`}{item.destination_display_name ? ` · ${item.destination_display_name}` : ""}{item.error_code ? ` · ${item.error_code}` : ""}</small>
                </div>
              ))}
              <div className="modal-actions">
                {["queued", "running"].includes(activeReframeBatch.status) && <button onClick={() => void window.desktop.cancelReframeExportBatch(activeReframeBatch.reframe_export_batch_id).then(setActiveReframeBatch).catch(() => setReframeError("取消重构图批次失败。"))}>取消重构图批次</button>}
                {activeReframeBatch.items.some(item => ["failed", "cancelled", "interrupted"].includes(item.status)) && <button onClick={() => void retryReframeBatchItems()}>重新授权并重试重构图失败项</button>}
              </div>
            </section>
          )}
        </Dialog>
      )}
      {confirmModel && (
        <Dialog
          titleId="model-confirm-title"
          closeLabel="关闭"
          title="确认下载本地模型"
          footer={<><button onClick={() => setConfirmModel(undefined)}>暂不下载</button><button disabled={confirmModel.license.acceptance_required && !licenseAccepted} onClick={() => void downloadModel()}>确认并下载</button></>}
          label="确认下载本地模型"
          onClose={() => setConfirmModel(undefined)}
          className="compact-dialog"
        >
          <h3>{confirmModel.display_name}</h3>
          <p>{confirmModel.purpose}</p>
          <dl>
            <dt>下载大小</dt><dd>{formatBytes(confirmModel.model_size_bytes)}</dd>
            <dt>许可证</dt><dd>{confirmModel.license.name}</dd>
            <dt>隐私</dt><dd>模型在本机运行，不上传媒体或转录正文。</dd>
          </dl>
          {confirmModel.license.acceptance_required && (
            <label className="check-line">
              <input type="checkbox" checked={licenseAccepted} onChange={event => setLicenseAccepted(event.target.checked)} />
              我已阅读并接受该许可证
            </label>
          )}
        </Dialog>
      )}
      {transcriptionAsset && (
        <Dialog
          titleId="transcription-title"
          closeLabel="关闭"
          title="创建本地转录"
          footer={<><button onClick={() => setTranscriptionAsset(undefined)}>取消</button><button onClick={() => void submitTranscription()}>开始转录</button></>}
          label="创建本地转录"
          onClose={() => setTranscriptionAsset(undefined)}
          className="compact-dialog"
        >
          <p>{transcriptionAsset.display_name}</p>
          <label>
            语言
            <select value={language} onChange={event => setLanguage(event.target.value)}>
              <option value="auto">自动检测</option>
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="check-line">
            <input type="checkbox" checked={wordTimestamps} onChange={event => setWordTimestamps(event.target.checked)} />
            生成词级时间戳
          </label>
        </Dialog>
      )}
      {pendingDeleteTranscript && (
        <Dialog
          titleId="transcript-delete-title"
          closeLabel="关闭"
          title="删除转录"
          footer={<><button className="btn ghost" disabled={deleteTranscriptBusy} onClick={() => setPendingDeleteTranscript(undefined)}>取消</button><button className="btn danger" disabled={deleteTranscriptBusy} onClick={() => void deleteTranscript(pendingDeleteTranscript)}>{deleteTranscriptBusy ? "删除中…" : "删除转录"}</button></>}
          label="删除转录"
          onClose={() => setPendingDeleteTranscript(undefined)}
          className="asset-delete-modal"
        >
          <p className="confirm-object">确定要删除这条转录吗？</p>
          <div className="warning" id="transcript-delete-desc">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
            <span>该转录的片段与词级时间戳将一并删除，此操作不可撤销。若其片段已被时间线字幕引用，删除会被拒绝——请先移除相关字幕或片段。</span>
          </div>
        </Dialog>
      )}
      {pendingDeleteAsset && (
        <Dialog
          titleId="asset-delete-title"
          closeLabel="关闭"
          title="删除素材"
          footer={<><button className="btn ghost" disabled={deleteBusy} onClick={() => setPendingDeleteAsset(undefined)}>取消</button><button className="btn danger" disabled={deleteBusy} onClick={() => void deleteAsset(pendingDeleteAsset)}>{deleteBusy ? "删除中…" : "删除素材"}</button></>}
          label="删除素材"
          onClose={() => setPendingDeleteAsset(undefined)}
          className="asset-delete-modal"
        >
          <p className="confirm-object">确定要删除素材「<strong>{pendingDeleteAsset.display_name}</strong>」吗？</p>
          <div className="warning" id="asset-delete-desc">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
            <span>如果该素材已添加到时间线，其相关片段（含关联字幕与转场）将一并删除，此操作不可撤销。</span>
          </div>
        </Dialog>
      )}
      {viewingTranscript && (
        <Dialog
          titleId="transcript-title"
          closeLabel="关闭"
          title="原始转录"
          subtitle={<>{viewingTranscript.language} · {viewingTranscript.provider} · {viewingTranscript.model_revision}</>}
          footer={(
            <div className="transcript-viewer-actions" style={{ flex: "1 1 auto" }}>
              <button className="append-btn" disabled={!(selectedSegments[viewingTranscript.transcript_id] ?? []).length} onClick={() => insertSegments(viewingTranscript)}>追加所选片段</button>
              <button className="append-btn" disabled={!(selectedSegments[viewingTranscript.transcript_id] ?? []).length} title="把选中片段的字幕文本交给 Provider 改写成更短的字幕" onClick={() => { setCaptionsOptimize({ transcript: viewingTranscript, segmentIds: [...(selectedSegments[viewingTranscript.transcript_id] ?? [])] }); setViewingTranscript(undefined); }}>AI 优化字幕文本</button>
            </div>
          )}
          label="原始转录"
          onClose={() => setViewingTranscript(undefined)}
          className="transcript-viewer"
        >
          <div className="readonly-note readonly-note--plain">原始 ASR 结果只读。勾选片段后，可追加到时间线或交给 AI 优化字幕文本。</div>
          <div className="transcript-viewer-toolbar">
            <strong>已选 {(selectedSegments[viewingTranscript.transcript_id] ?? []).length} / {viewingTranscript.segments.length} 段</strong>
            <button className="mini-btn" onClick={() => setSelectedSegments(state => ({ ...state, [viewingTranscript.transcript_id]: viewingTranscript.segments.map(segment => segment.segment_id) }))}>全选</button>
            <button className="mini-btn" onClick={() => setSelectedSegments(state => ({ ...state, [viewingTranscript.transcript_id]: [] }))}>清空</button>
          </div>
          <div className="readonly-segments transcript-selectable-segments">
            {viewingTranscript.segments.map(segment => (
              <SegmentRow
                key={segment.segment_id}
                segment={segment}
                selected={(selectedSegments[viewingTranscript.transcript_id] ?? []).includes(segment.segment_id)}
                onToggle={() => setSelectedSegments(state => ({ ...state, [viewingTranscript.transcript_id]: toggle(state[viewingTranscript.transcript_id] ?? [], segment.segment_id) }))}
              />
            ))}
          </div>
        </Dialog>
      )}
      {aiOpen && (
        <Dialog titleId="ai-roughcut-title" closeLabel="关闭 AI 粗剪" title="AI 粗剪" subtitle="仅在确认外传内容后调用 Provider。" label="AI 粗剪" onClose={() => setAiOpen(false)} className="ai-roughcut">
          {aiError && <p className="ai-status" role="status">{aiError}</p>}
          {aiStep === "form" && (
            <>
              <label>主题<input value={aiForm.topic} onChange={e => setAiForm(v => ({ ...v, topic: e.target.value }))} /></label>
              <label>受众<input value={aiForm.audience} onChange={e => setAiForm(v => ({ ...v, audience: e.target.value }))} /></label>
              <label>叙事目标<textarea value={aiForm.narrative_goal} onChange={e => setAiForm(v => ({ ...v, narrative_goal: e.target.value }))} /></label>
              <label>风格说明<textarea value={aiForm.style_notes} onChange={e => setAiForm(v => ({ ...v, style_notes: e.target.value }))} /></label>
              <label>
                制作配方
                <select value={aiForm.recipe_id} onChange={e => setAiForm(v => ({ ...v, recipe_id: e.target.value }))}>
                  <option value="">选择配方</option>
                  {aiRecipes.map(item => <option key={item.recipe_id} value={item.recipe_id}>{item.name ?? item.display_name} · {item.summary}</option>)}
                </select>
              </label>
              <label>
                Provider
                <select value={aiForm.provider_id} onChange={e => setAiForm(v => ({ ...v, provider_id: e.target.value }))}>
                  <option value="">选择 Provider</option>
                  {aiProviders.map(item => (
                    <option key={item.provider_config_id} value={item.provider_config_id} disabled={!item.enabled || item.credential_status !== "configured" || item.candidate_capability_status !== "supported"}>
                      {item.display_name} · {item.candidate_capability_status === "supported" ? "AI 粗剪可用" : item.candidate_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 粗剪"}
                    </option>
                  ))}
                </select>
              </label>
              <div className="provider-capability-list">
                {aiProviders.map(item => (
                  <div key={item.provider_config_id}>
                    <span>{item.display_name} · {item.candidate_capability_status === "supported" ? "AI 粗剪可用" : item.candidate_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 粗剪"}</span>
                    <button disabled={aiCapabilityTesting} onClick={() => void testCandidateProviderCapability(item.provider_config_id)}>{aiCapabilityTesting ? "正在测试兼容性" : "测试 AI 粗剪兼容性"}</button>
                  </div>
                ))}
              </div>
              <p className="readonly-note readonly-note--plain">Provider 的创建、密钥与连接测试已移至「Provider 设置」（工具菜单 / 设置）。<button className="mini-btn" onClick={() => { setProviderSettingsOpen(true); }}>打开 Provider 设置</button></p>
              <label>
                就绪转录
                <select value={aiForm.transcript_id} onChange={e => setAiForm(v => ({ ...v, transcript_id: e.target.value }))}>
                  <option value="">选择已就绪转录</option>
                  {Object.values(transcriptSummaries).flat().filter(item => item.status === "ready").map(item => <option key={item.transcript_id} value={item.transcript_id}>{item.language} · 就绪</option>)}
                </select>
              </label>
              <label>
                召回来源
                <select value={aiForm.candidate_source} onChange={e => setAiForm(v => ({ ...v, candidate_source: e.target.value as "auto" | "transcript" | "cv" | "fused" }))}>
                  <option value="auto">自动（有转录用转录，否则 CV）</option>
                  <option value="transcript">仅转录</option>
                  <option value="cv">仅画面（CV）</option>
                  <option value="fused">融合（转录 + 画面 + 节拍）</option>
                </select>
              </label>
              <p className="readonly-note">「融合」会把转录关键词、画面特征与节拍落拍三项综合排序。<strong>权重为等权且尚未调优</strong>，不代表优劣已评测。</p>
              <div className="modal-actions">
                <button disabled={!aiForm.topic || !aiForm.audience || !aiForm.narrative_goal || !aiForm.provider_id || !aiForm.recipe_id || !aiForm.transcript_id || aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.candidate_capability_status !== "supported" || aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.credential_status !== "configured" || !aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.enabled} onClick={() => void prepareAi()}>准备外传确认</button>
              </div>
            </>
          )}
          {aiStep === "confirm" && aiPreview && (
            <>
              <h3>确认发送的精确内容</h3>
              <dl className="egress-meta">
                <dt>发送给谁</dt><dd>{aiPreview.provider.origin} · {aiPreview.provider.model}</dd>
                <dt>发什么</dt><dd>{aiPreview.sent_fields.join("、")}</dd>
                <dt>规模</dt><dd>{aiPreview.stats.segment_count} 段 / {aiPreview.stats.character_count} 字 · 估算 {aiPreview.stats.estimated_tokens} Token</dd>
                <dt>费用</dt><dd className="egress-cost">按 Provider 配置单价估算，最终以服务商账单为准</dd>
                <dt>凭据</dt><dd className="egress-hash">{aiPreview.payload_sha256}</dd>
                <dt>有效期</dt><dd>{aiPreview.expires_at}</dd>
              </dl>
              <div className="egress-text">{Array.isArray(aiPreview.payload.segments) && (aiPreview.payload.segments as Array<Record<string, unknown>>).map(segment => <p key={String(segment.segment_ref)}>{String(segment.text)}</p>)}</div>
              <div className="egress-confirm">
                <p className="egress-warn">这不是匿名化：Provider 会看到上述全部文本。画面与时间码不会离开本机。</p>
                <label><input type="checkbox" checked={aiEgressConfirmed} onChange={event => setAiEgressConfirmed(event.target.checked)} aria-label="我已核对以上外发内容" />我已核对以上内容，同意发送给该 Provider</label>
              </div>
              <div className="modal-actions"><button onClick={() => { setAiPreview(undefined); setAiStep("form"); setAiEgressConfirmed(false); }}>返回修改</button><button className="danger" disabled={!aiEgressConfirmed} onClick={() => void createAi()}>我确认发送以上内容</button></div>
            </>
          )}
          {aiStep === "running" && <><h3>正在生成候选方案</h3><p>任务进度与取消操作沿用现有任务中心；如失败或取消，请重新准备并再次确认。</p></>}
          {aiStep === "candidates" && (
            <>
              <h3>三个候选方案</h3>
              <div className="candidate-columns">
                {(["balanced", "compact", "bold"] as const).map((variant, index) => {
                  const item = aiCandidates.find(candidate => candidate.variant === variant);
                  const title = ["稳妥版", "紧凑版", "高能版"][index];
                  return (
                    <section key={variant}>
                      <h4>{title}</h4>
                      {item ? (
                        <>
                          <strong>{String(item.title_suggestion)}</strong>
                          <p>{String(item.summary)}</p>
                          <small>{Number(item.duration_us) / 1_000_000}s · 模型参考</small>
                          {Array.isArray(item.clips) && (item.clips as Array<Record<string, unknown>>).map(clip => (
                            <div className="candidate-clip" key={String(clip.clip_id)}>
                              <span>{Number(clip.source_start_us) / 1_000_000}s–{Number(clip.source_end_us) / 1_000_000}s</span>
                              <button onClick={() => void playAiClip(clip)}>试播片段</button>
                              <p>{String(clip.reason)}</p>
                            </div>
                          ))}
                          <button onClick={() => void adoptAi(item)}>采用此方案</button>
                        </>
                      ) : <p>等待有效响应</p>}
                    </section>
                  );
                })}
              </div>
              {aiPlayback && <video className="candidate-player" src={aiPlayback.media_url} controls autoPlay onLoadedMetadata={e => { e.currentTarget.currentTime = aiPlayback.source_start_us / 1_000_000; }} onTimeUpdate={e => { if (e.currentTarget.currentTime >= aiPlayback.source_end_us / 1_000_000) e.currentTarget.pause(); }} />}
            </>
          )}
        </Dialog>
      )}
      {aiOpen && aiStep === "running" && (
        <section className="ai-job-progress" aria-live="polite" aria-label="AI 粗剪任务进度">
          <strong>阶段：{aiJob?.stage ?? "queued"}</strong>
          <span>进度：{Math.round((aiJob?.progress ?? 0) * 100)}%</span>
          <progress aria-label="AI 粗剪进度" max="1" value={aiJob?.progress ?? 0} />
          <button
            disabled={!aiJob || !["queued", "running", "cancelling"].includes(aiJob.status)}
            onClick={() => {
              if (!aiJob) return;
              void window.desktop.cancelJob(aiJob.job_id).then(job => {
                setAiJob(job);
                setAiPreview(undefined);
                setAiCandidates([]);
                setAiPlayback(undefined);
                setAiStep("form");
                setAiError("生成已取消。请重新准备外传内容并再次确认。");
              }).catch(() => setAiError("取消请求失败；请等待当前任务状态刷新。"));
            }}
          >
            取消生成
          </button>
        </section>
      )}
      {patchOpen && (
        <Dialog titleId="planning-patch-title" closeLabel="关闭 AI 修改" title="AI 修改" subtitle="提案不会自动修改正式 Timeline。" label="AI 修改" onClose={closePatch} className="planning-patch">
          {patchError && <p className="ai-status" role="status">{patchError}</p>}
          {patchStep === "form" && (
            <>
              <label>修改指令<textarea aria-label="修改指令" maxLength={4000} value={patchInstruction} onChange={event => setPatchInstruction(event.target.value)} /></label>
              <label>
                Provider
                <select aria-label="AI 修改 Provider" value={patchProviderId} onChange={event => setPatchProviderId(event.target.value)}>
                  <option value="">选择已配置 Provider</option>
                  {patchProviders.map(item => (
                    <option value={item.provider_config_id} key={item.provider_config_id} disabled={item.timeline_patch_capability_status !== "supported"}>
                      {item.display_name} · {item.model} · {item.timeline_patch_capability_status === "supported" ? "AI 修改可用" : item.timeline_patch_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 修改"}
                    </option>
                  ))}
                </select>
              </label>
              <div className="provider-capability-list">
                {patchProviders.map(item => (
                  <div key={item.provider_config_id}>
                    <span>{item.display_name} · {item.timeline_patch_capability_status === "supported" ? "AI 修改可用" : item.timeline_patch_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 修改"}</span>
                    <button disabled={patchCapabilityTesting} onClick={() => void testPatchProviderCapability(item.provider_config_id)}>{patchCapabilityTesting ? "正在测试兼容性" : "测试 AI 修改兼容性"}</button>
                  </div>
                ))}
              </div>
              <div className="modal-actions">
                <button disabled={!patchProviderId || !patchInstruction.trim() || patchProviders.find(item => item.provider_config_id === patchProviderId)?.timeline_patch_capability_status !== "supported"} onClick={() => void preparePatch()}>准备外传确认</button>
              </div>
            </>
          )}
          {patchStep === "confirm" && patchPreview && (
            <>
              <h3>确认本次外传</h3>
              <div className="instruction-preview"><strong>你的本地指令</strong><p>{patchInstruction}</p></div>
              <dl className="egress-meta">
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
              <div className="modal-actions"><button onClick={() => { setPatchPreview(undefined); setPatchStep("form"); setPatchEgressConfirmed(false); }}>返回修改</button><button className="danger" disabled={!patchEgressConfirmed} onClick={() => void createPatch()}>确认并发送一次</button></div>
            </>
          )}
          {patchStep === "running" && (
            <>
              <h3>正在生成提案</h3>
              <p>{patchJob?.stage ?? "queued"} · {Math.round((patchJob?.progress ?? 0) * 100)}%</p>
              <progress max="1" value={patchJob?.progress ?? 0} />
              <div className="modal-actions"><button disabled={!patchJob || !["queued", "running", "cancelling"].includes(patchJob.status)} onClick={() => void cancelPatch()}>取消生成</button></div>
            </>
          )}
          {patchStep === "proposal" && patchProposal && (
            <>
              <h3>提案差异</h3>
              <TimelineDiffView diff={patchProposal.diff} />
              <div className="modal-actions"><button onClick={closePatch}>放弃</button><button disabled={patchProposal.applied_revision_id !== null} onClick={() => void applyPatchProposal()}>应用修改</button></div>
            </>
          )}
        </Dialog>
      )}
      {generationOpen && project && <MediaGenerationWorkbench key={project.project_id} project={project} assets={assets} onClose={() => setGenerationOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onNotify={message => showNotice(message, "info")} onOpenProviderSettings={() => setProviderSettingsOpen(true)} />}
      {providerSettingsOpen && <ProviderSettingsDialog providers={mergedProviders} onProvidersChange={setAiProviders} onClose={() => setProviderSettingsOpen(false)} onNotify={message => showNotice(message, "info")} />}
      {captionsOptimize && project && <CaptionsProviderPanel projectId={project.project_id} baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null} providers={mergedProviders} transcript={captionsOptimize.transcript} segmentIds={captionsOptimize.segmentIds} onClose={() => setCaptionsOptimize(undefined)} onApplied={() => { void loadRenderData(project); }} onNotify={message => showNotice(message, "info")} />}
      {agentOpen && project && <AgentSessionPanel projectId={project.project_id} baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null} providers={mergedProviders} onClose={() => setAgentOpen(false)} onNotify={message => showNotice(message, "info")} />}
      {worklistOpen && project && <WorklistPanel key={project.project_id} projectId={project.project_id} baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null} onClose={() => setWorklistOpen(false)} onApplied={() => { void window.desktop.getTimeline(project.project_id).then(state => { acceptState(state); }); }} onNotify={message => showNotice(message, "success")} />}
      {cvOptionsOpen && cvOptionsAsset && (
        <Dialog
          titleId="cv-density-title"
          title="AI 信号分析"
          subtitle="本地零外传。可选密度旋钮：留空则用默认（目标间隔 4s、预算 10s/分钟源）。"
          closeLabel="关闭 AI 信号分析"
          footer={(
            <>
              <button onClick={() => { startCvAnalysis(cvOptionsAsset); setCvOptionsOpen(false); setCvOptionsAsset(null); }}>使用默认设置</button>
              <button onClick={submitCvOptions}>按上述设置分析</button>
            </>
          )}
          label="AI 信号分析"
          onClose={() => { setCvOptionsOpen(false); setCvOptionsAsset(null); }}
          className="cv-density"
        >
          <label>目标采样间隔（秒，可选）<input aria-label="目标采样间隔秒" type="number" min={0.1} max={60} step={0.1} value={cvTargetGapS} onChange={event => setCvTargetGapS(event.target.value)} placeholder="默认 4" /></label>
          <label>每分钟预算（秒，可选）<input aria-label="每分钟预算秒" type="number" min={1} max={120} step={1} value={cvBudgetPerMin} onChange={event => setCvBudgetPerMin(event.target.value)} placeholder="默认 10" /></label>
          <p className="readonly-note readonly-note--plain">间隔越小越密；预算不足时自动退到预算内尽量密，并如实标记密度。</p>
        </Dialog>
      )}
      {editingGrammarOpen && project && editingToolsTool && (
        <EditingToolsPanel
          projectId={project.project_id}
          baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null}
          clips={working?.clips ?? []}
          initialClipId={editingToolsClipId}
          initialTool={editingToolsTool}
          onClose={() => { setEditingGrammarOpen(false); setEditingToolsTool(null); }}
          onApplied={state => { acceptState(state); void loadRenderData(project); }}
          onNotify={message => showNotice(message, "success")}
        />
      )}
      {angleSyncOpen && project && (
        <AngleSyncPanel
          projectId={project.project_id}
          assets={assets}
          onClose={() => setAngleSyncOpen(false)}
          onNotify={message => showNotice(message, "success")}
        />
      )}
      {semanticSearchOpen && project && (
        <SemanticSearchPanel
          projectId={project.project_id}
          assetNames={semanticAssetNames}
          assets={assets}
          onClose={() => setSemanticSearchOpen(false)}
        />
      )}
      {keyframeReviewOpen && project && (
        <KeyframeReviewPanel
          projectId={project.project_id}
          assetId={(selectedAssetId ?? null) as AssetId | null}
          assetName={semanticAssetNames[selectedAssetId ?? ""] ?? "（未在素材库中选择素材）"}
          onClose={() => setKeyframeReviewOpen(false)}
        />
      )}
      {editingGrammarOpen && project && !editingToolsTool && (
        <EditingGrammarPanel
          projectId={project.project_id}
          baseRevisionId={timeline?.current_revision.timeline_revision_id ?? null}
          onClose={() => setEditingGrammarOpen(false)}
          onApplied={state => { acceptState(state); void loadRenderData(project); }}
          onNotify={message => showNotice(message, "success")}
        />
      )}
      {providerImageGenerationOpen && project && <ProviderImageGenerationWorkbench key={`provider-image-${project.project_id}`} project={project} assets={assets} onClose={() => setProviderImageGenerationOpen(false)} />}
      {shotRequirementsOpen && project && <ShotRequirementWorkbench key={project.project_id} project={project} assets={assets} onClose={() => setShotRequirementsOpen(false)} />}
      {revisionOpen && (
        <Dialog
          titleId="revision-compare-title"
          closeLabel="关闭版本比较"
          title="版本比较"
          subtitle="只读操作，不改变当前 Revision、草稿或渲染记录。"
          footer={<><button disabled={!revisionPair.base || !revisionPair.target || revisionPair.base === revisionPair.target} onClick={() => void compareRevisions()}>比较</button></>}
          label="版本比较"
          onClose={() => { setRevisionOpen(false); setRevisionDiff(undefined); }}
          className="revision-compare"
        >
          <div className="revision-selectors">
            <label>
              基线
              <select aria-label="基线 Revision" value={revisionPair.base} onChange={event => setRevisionPair(value => ({ ...value, base: event.target.value }))}>
                {revisions.map(item => <option value={item.timeline_revision_id} key={`base-${item.timeline_revision_id}`}>{item.summary} · {item.created_at}</option>)}
              </select>
            </label>
            <label>
              目标
              <select aria-label="目标 Revision" value={revisionPair.target} onChange={event => setRevisionPair(value => ({ ...value, target: event.target.value }))}>
                {revisions.map(item => <option value={item.timeline_revision_id} key={`target-${item.timeline_revision_id}`}>{item.summary} · {item.created_at}</option>)}
              </select>
            </label>
          </div>
          {revisionDiff && <TimelineDiffView diff={revisionDiff} />}
        </Dialog>
      )}
      {renderPanelOpen && (
        <Dialog
          titleId="render-panel-title"
          closeLabel="关闭渲染与导出"
          title="渲染与导出"
          subtitle="任务为本次会话的过程记录；导出产物为持久记录，关闭后任务继续在后台推进。"
          label="渲染与导出"
          onClose={() => setRenderPanelOpen(false)}
          className="render-panel-dialog"
        >
          <section className="render-tasks-card" aria-label="任务">
            {(() => {
              const panelJobs = jobs.filter(item => item.kind === "authoritative_preview" || item.kind === "final_export");
              const activeJobs = panelJobs.filter(item => ["queued", "running", "cancelling"].includes(item.status));
              const failedJobs = panelJobs.filter(item => ["failed", "cancelled", "interrupted"].includes(item.status));
              const succeededCount = panelJobs.filter(item => item.status === "succeeded").length;
              const renderJobRow = (item: Job) => {
                const pct = item.progress === null ? null : Math.round(item.progress * 100);
                const isActive = ["queued", "running", "cancelling"].includes(item.status);
                const finishing = isActive && item.progress === 1;
                return (
                  <div className={`render-job${isActive ? " active" : ""}${finishing ? " finishing" : ""}`} key={item.job_id}>
                    <div className="render-job-main">
                      <div className="render-job-title">
                        <strong>{jobKindLabels[item.kind] ?? item.kind}</strong>
                        <span className={`render-job-state ${item.status === "failed" || item.status === "interrupted" ? "bad" : isActive ? "run" : "dim"}`}>{finishing ? "即将完成" : jobStatusLabels[item.status]}</span>
                        {item.status === "running" && !finishing && <JobEta job={item} />}
                      </div>
                      <small>{item.phase ? `${jobPhaseLabels[item.phase] ?? item.phase}${item.phase_progress !== null && item.phase_progress !== undefined ? ` ${Math.round(item.phase_progress * 100)}%` : ""}` : ""}{item.error ? `${item.phase ? " · " : ""}${safeTaskErrorMessage(item.error)}` : ""}</small>
                      {pct !== null && <div className="render-job-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>}
                    </div>
                    {isActive && !finishing && <IconButton label="取消渲染任务" onClick={() => void cancelJob(item)}><Square /></IconButton>}
                  </div>
                );
              };
              return (
                <>
                  {(activeJobs.length > 0 || failedJobs.length > 0 || succeededCount > 0) && <div className="render-group-title">任务{activeJobs.length > 0 && <span className="render-group-count">{activeJobs.length} 个进行中</span>}</div>}
                  {activeJobs.length === 0 && failedJobs.length === 0 && succeededCount === 0 && <div className="render-empty">暂无任务。{!authoritativePreview && "当前没有权威预览，仍可直接导出。"}</div>}
                  {activeJobs.map(renderJobRow)}
                  {failedJobs.length > 0 && <div className="render-group-subtitle">失败 / 中断</div>}
                  {failedJobs.map(renderJobRow)}
                  {succeededCount > 0 && <div className="render-done-summary">本轮已完成 {succeededCount} 个任务，产物见下方。</div>}
                </>
              );
            })()}
          </section>
          <section className="render-products-card" aria-label="导出产物">
            <div className="render-group-title">导出产物{exports.length > 0 && <span className="render-group-count">{exports.length} 个文件</span>}</div>
            {exports.length === 0 && <div className="render-empty">尚无导出产物。</div>}
            {exports.map(item => {
              const info = item.export_record.media_info;
              const dims = info ? `${info.video.width}×${info.video.height}` : null;
              const fps = info ? Math.round(info.video.fps_num / info.video.fps_den) : null;
              const missing = item.export_record.status !== "succeeded";
              return (
                <div className={`export-record${missing ? " missing" : ""}`} key={item.export_record.export_record_id}>
                  <div>
                    <strong>{item.export_record.destination_display_name}</strong>
                    <small>{formatRelativeTime(item.export_record.created_at)}{dims ? ` · ${dims}${fps ? ` · ${fps}fps` : ""}` : ""} · {formatBytes(item.export_record.size_bytes)} · {missing ? "文件缺失（本地文件已被移动或删除）" : "成功"}</small>
                    {item.export_record.fallback_reason && <small className="render-fallback-note">{fallbackReasonLabel(item.export_record.fallback_reason)}</small>}
                  </div>
                  <div>
                    {missing ? <IconButton label="移除记录" onClick={() => void removeMissingExport(item)}><Trash2 /></IconButton> : <IconButton label="定位导出" onClick={() => void window.desktop.openArtifactFolder(item.export_record.render_artifact_id)}><MapPin /></IconButton>}
                    <IconButton label="播放导出" disabled={missing} onClick={() => { setExportPlayback(item); setPreviewMode("authoritative"); }}><Play /></IconButton>
                    <IconButton label="打开导出" disabled={missing} onClick={() => void window.desktop.openArtifact(item.export_record.render_artifact_id)}><Eye /></IconButton>
                  </div>
                </div>
              );
            })}
          </section>
        </Dialog>
      )}
      {commandSearchOpen && (
        <Dialog
          titleId="command-search-title"
          title="命令搜索"
          subtitle="输入命令名过滤；↑↓ 选择 · Enter 执行 · Esc 关闭。"
          footer={<div className="command-footer"><div className="key-hints"><span><kbd>↑↓</kbd>选择</span><span><kbd>↵</kbd>执行</span><span><kbd>esc</kbd>关闭</span></div></div>}
          label="命令搜索"
          onClose={closeCommandSearch}
          className="command-palette"
        >
          <div className="search-wrap">
            <Search className="icon" size={16} aria-hidden="true" />
            <input ref={commandSearchInputRef} type="search" aria-label="命令搜索" aria-controls="command-list" aria-activedescendant={filteredCommands[commandIndex] ? `command-option-${filteredCommands[commandIndex].id}` : undefined} placeholder="输入命令名称…" value={commandQuery} onChange={event => { setCommandQuery(event.target.value); setCommandIndex(0); }} onKeyDown={handleCommandPaletteKeyDown} />
          </div>
          <ul role="listbox" aria-label="命令列表" id="command-list" className="command-list">
            {filteredCommands.map((command, index) => {
              const reason = commandDisabledReason(command.id);
              const group = command.group;
              const shownGroup = index === 0 || filteredCommands[index - 1].group !== group;
              return (
                <Fragment key={command.id}>
                  {shownGroup && <li className="command-group" role="presentation">{group}</li>}
                  <li id={`command-option-${command.id}`} role="option" aria-selected={index === commandIndex} className={index === commandIndex ? "active" : ""}>
                    <button className="command-option" disabled={Boolean(reason)} onClick={() => { if (!reason) { runCommand(command.id); closeCommandSearch(); } }}>
                      {(() => { const Icon = COMMAND_ICON_MAP[command.id]; return Icon ? <Icon className="icon" size={14} aria-hidden="true" /> : <span className="icon" aria-hidden="true" />; })()}
                      <span className="command-label">{command.label}</span>
                      {(shortcutsRef.current as Record<string, ShortcutEntry> | undefined)?.[command.id as ShortcutCommandId]
                        ? <kbd className="command-shortcut">{bindingLabel((shortcutsRef.current as Record<string, ShortcutEntry>)[command.id as ShortcutCommandId].binding)}</kbd>
                        : <kbd className="command-shortcut" aria-hidden="true" />}
                      <span className={reason ? "command-reason" : "command-state"}>{reason ?? "可用"}</span>
                    </button>
                  </li>
                </Fragment>
              );
            })}
            {filteredCommands.length === 0 && <li className="command-empty">没有匹配的命令</li>}
          </ul>
        </Dialog>
      )}
      {shortcutsOpen && (
        <Dialog
          titleId="shortcuts-title"
          closeLabel="关闭快捷键设置"
          title="快捷键设置"
          subtitle={<>点击"录制"后按下新键位；Ctrl+Shift+Z（重做）与 Backspace（删除）为固定别名，不参与自定义。</>}
          footer={<><button onClick={resetShortcutsToDefault}>恢复默认</button></>}
          label="快捷键设置"
          onClose={() => { setShortcutsOpen(false); setRecordingId(null); }}
          className="shortcuts-dialog"
        >
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
        </Dialog>
      )}
    </>
  );
}
