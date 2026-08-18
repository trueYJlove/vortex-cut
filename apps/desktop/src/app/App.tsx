import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ChevronLeft, ChevronRight, Download, Eye, FileAudio, FileText, FolderPlus, History, ImagePlus, Lock, LockOpen, MapPin, Pause, Play, Plus, Redo2, RefreshCw, RotateCcw, Save, Scissors, Sparkles, Square, Trash2, Undo2, Video, Volume2, VolumeX, X } from "lucide-react";
import type { Asset, AssetKind, AssetPresentation, BriefInput, CaptionPresetId, DirectoryGrant, EncoderMode, EgressPreview, ExportBatch, HorizontalAnchor, Job, LayoutPolicy, ModelDetail, ModelSummary, PlatformPreset, Project, ProviderConfig, ReframeExportBatch, RenditionPreset, RenditionReframeAdjustment, TimelineCaption, TimelineClip, TimelineDiff, TimelineDocument, TimelineLayout, TimelinePatchEgressPreview, TimelinePatchOperation, TimelinePatchProposal, TimelineRevisionSummary, TimelineState, Transcript, TranscriptSegment, TranscriptSummary, VerticalAnchor } from "@aivideo/contracts";
import type { AuthoritativePreviewPresentation, ExportRecordPresentation, RenditionPreviewPresentation, RenditionReframePreviewPresentation } from "../../electron/preload/index.js";
import { CONTRACT_VERSION } from "@aivideo/contracts";

type SaveState = "已保存" | "保存中" | "保存失败" | "草稿冲突";
type Selection = { kind: "clip"; id: string } | { kind: "caption"; id: string } | null;
const layouts: { value: TimelineLayout; label: string }[] = [{ value: "blurred_background", label: "模糊背景" }, { value: "crop_fill", label: "裁切填满" }, { value: "fit", label: "完整适配" }];
const presets: { value: CaptionPresetId; label: string }[] = [{ value: "default-bottom", label: "默认底部" }, { value: "game-safe-bottom", label: "游戏安全区" }, { value: "high-contrast", label: "高对比" }];
const formatTime = (us: number) => `${(us / 1_000_000).toFixed(2)}s`;
const duration = (document?: TimelineDocument) => document?.clips.at(-1)?.timeline_end_us ?? 0;
const assetKinds: AssetKind[] = ["video", "audio", "image", "text"];
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
  const [playhead, setPlayhead] = useState(0);
  const [encoderMode, setEncoderMode] = useState<EncoderMode>("auto");
  const [previewMode, setPreviewMode] = useState<"interactive" | "authoritative">("interactive");
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
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisions, setRevisions] = useState<TimelineRevisionSummary[]>([]);
  const [revisionPair, setRevisionPair] = useState({ base: "", target: "" });
  const [revisionDiff, setRevisionDiff] = useState<TimelineDiff>();
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const projectNameProjectId = useRef<Project["project_id"] | undefined>(undefined);
  const projectNameDirty = useRef(false);
  const timelineLoadEpoch = useRef(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const refreshProjects = async () => {
    const page = await window.desktop.listProjects({ limit: 100 });
    setProjects(page.items);
    setProject(current => page.items.find(item => item.project_id === current?.project_id) ?? page.items[0]);
  };
  const loadModels = async () => { const page = await window.desktop.listModels({ limit: 100 }); setModels(page.items); };
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
    catch (error) { setPatchPreview(undefined); const message = error instanceof Error ? error.message : ""; setPatchError(message === "TIMELINE_PATCH_PROVIDER_UNTESTED" ? "该 Provider 尚未完成 AI 修改兼容性测试。" : message === "TIMELINE_PATCH_PROVIDER_UNSUPPORTED" ? "该 Provider 不支持当前 AI 修改响应格式。" : "准备失败。请刷新 Timeline 并重新输入指令。"); }
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
    }).catch(error => { if (active) setNotice(String(error)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!project) return;
    closePatch(); setRevisionOpen(false); setRevisionDiff(undefined);
    setReframeSelections({}); setReframePreviews({}); setReframePending({}); setReframePlayback(undefined); setReframeDirectoryGrant(undefined); setActiveReframeBatch(undefined); setReframeError("");
    let active = true;
    const epoch = ++timelineLoadEpoch.current;
    void loadProjectData(project).catch(error => active && setNotice(String(error)));
    void loadRenderData(project).catch(error => active && setNotice(String(error)));
    void window.desktop.getTimeline(project.project_id).then(value => { if (active && epoch === timelineLoadEpoch.current) { setTimeline(value); setWorking(value.current_revision.document); setSelection(null); } }).catch(error => {
      if (active && epoch === timelineLoadEpoch.current) { setTimeline(undefined); setWorking(undefined); if (!String(error).includes("TIMELINE_NOT_FOUND") && !String(error).includes("404")) setNotice(String(error)); }
    });
    return () => { active = false; };
  }, [project?.project_id]);
  useEffect(() => {
    if (!runtimeReady) return;
    const timer = setInterval(() => {
      void refreshProjects().catch(() => undefined);
      if (project) void loadProjectData(project).catch(() => undefined);
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
  useEffect(() => { if (project && terminalRenderJobs) void loadRenderData(project).catch(error => setNotice(String(error))); }, [project?.project_id, terminalRenderJobs]);

  const selectedClip = selection?.kind === "clip" ? working?.clips.find(item => item.clip_id === selection.id) : undefined;
  const selectedCaption = selection?.kind === "caption" ? working?.captions.find(item => item.caption_id === selection.id) : undefined;
  const previewAsset = assets.find(item => item.asset.asset_id === selectedClip?.asset_id) ?? assets.find(item => item.asset.asset_id === working?.clips[0]?.asset_id);
  useEffect(() => { const media = videoRef.current; if (!media) return; if (playing) void media.play().catch(() => setPlaying(false)); else media.pause(); }, [playing, previewAsset?.media_url]);
  const visibleCaption = working?.captions.find(item => playhead >= item.start_us && playhead < item.end_us) ?? selectedCaption;
  const totalUs = duration(working);

  const acceptState = (next: TimelineState) => { timelineLoadEpoch.current += 1; setTimeline(next); setWorking(next.current_revision.document); setSaveState("已保存"); setNotice(""); };
  const handleConflict = async (error: unknown) => {
    const text = String(error);
    if (text.includes("TIMELINE_CONFLICT") || text.includes("TIMELINE_DRAFT_CONFLICT") || text.includes("409")) {
      setSaveState("草稿冲突"); setNotice("时间线已在其他操作中更新。已刷新当前事实，请检查后重新应用你的修改。");
      if (project) acceptState(await window.desktop.getTimeline(project.project_id));
    } else { setSaveState("保存失败"); setNotice(text); }
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
  const insertAsset = (item: AssetPresentation) => timeline ? void patchTimeline([{ op: "insert_asset_clip", asset_id: item.asset.asset_id, at_index: working?.clips.length ?? 0, ...(item.asset.kind === "image" ? { duration_us: 3_000_000 } : {}) }], `追加素材 ${item.asset.display_name}`) : void createTimeline({ kind: "full_asset", asset_id: item.asset.asset_id });
  const insertSegments = (transcript: Transcript) => {
    const ids = selectedSegments[transcript.transcript_id] ?? [];
    if (!ids.length) return;
    const source = { kind: "transcript_selection" as const, transcript_id: transcript.transcript_id, segment_ids: ids as never[], padding_before_us: 150_000, padding_after_us: 150_000, create_captions: true };
    if (timeline) void patchTimeline([{ op: "insert_transcript_segments", transcript_id: transcript.transcript_id, segment_ids: ids as never[], at_index: working?.clips.length ?? 0, padding_before_us: 150_000, padding_after_us: 150_000, create_captions: true, layout: "blurred_background" }], "追加转录选段"); else void createTimeline(source);
  };
  const createProject = async () => { if (!newProject.trim()) return; const created = await window.desktop.createProject({ name: newProject.trim() }); setNewProject(""); await refreshProjects(); setProject(created); };
  const renameProject = async () => { if (!project || !projectName.trim()) return; const updated = await window.desktop.renameProject({ project_id: project.project_id, name: projectName.trim() }); projectNameDirty.current = false; setProject(updated); setProjects(items => items.map(item => item.project_id === updated.project_id ? updated : item)); };
  const toggleArchive = async () => { if (!project) return; const updated = project.status === "archived" ? await window.desktop.reopenProject(project.project_id) : await window.desktop.archiveProject(project.project_id); setProject(updated); setProjects(items => items.map(item => item.project_id === updated.project_id ? updated : item)); };
  const importAsset = async (kind: AssetKind) => { if (!project) return; const result = await window.desktop.importAsset({ project_id: project.project_id, kind }); if (result) setAssets(items => [...items, { asset: result.asset, media_url: result.media_url }]); };
  const refreshAsset = async (asset: Asset) => { const result = await window.desktop.refreshAsset(asset.asset_id); setAssets(items => items.map(item => item.asset.asset_id === asset.asset_id ? result : item)); };
  const relocateAsset = async (asset: Asset) => { const result = await window.desktop.relocateAsset({ asset_id: asset.asset_id }); if (result) setAssets(items => items.map(item => item.asset.asset_id === asset.asset_id ? { asset: result.asset, media_url: result.media_url } : item)); };
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
        if (project) void loadRenderData(project).catch(error => setNotice(String(error)));
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
      if (result.job) trackRenderJob(result.job);
    } catch (error) { setNotice(String(error)); }
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
    } catch (error) { setNotice(String(error)); }
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
    } catch (error) { setBatchError(error instanceof Error ? error.message : "生成权威预览失败。"); }
  };
  const chooseBatchDirectory = async () => { if (!project) return; try { setDirectoryGrant((await window.desktop.chooseExportDirectory(project.project_id)) ?? undefined); } catch { setBatchError("选择导出目录失败。"); } };
  const createBatch = async () => {
    if (!project || !timeline || !directoryGrant || renditionTargets.some(target => !targetPreview(target))) return;
    try {
      const result = await window.desktop.createExportBatch({ project_id: project.project_id, batch: { timeline_revision_id: timeline.current_revision.timeline_revision_id, directory_grant_id: directoryGrant.directory_grant_id, items: renditionTargets.map(target => ({ rendition_snapshot_id: targetPreview(target)!.preview.rendition_snapshot_id, preview_artifact_id: targetPreview(target)!.preview.render_artifact_id, encoder_mode: encoderMode })) } });
      setActiveBatch(result.batch); setDirectoryGrant(undefined); result.jobs.forEach(trackRenderJob);
    } catch (error) { setBatchError(error instanceof Error ? error.message : "创建批次失败。"); }
  };
  const retryBatchItems = async () => {
    if (!activeBatch || !project) return;
    const retryable = activeBatch.items.filter(item => ["failed", "cancelled", "interrupted"].includes(item.status));
    if (!retryable.length) return;
    try { const grant = await window.desktop.chooseExportDirectory(project.project_id); if (!grant) return; const result = await window.desktop.retryExportBatch({ batch_id: activeBatch.export_batch_id, retry: { directory_grant_id: grant.directory_grant_id, export_batch_item_ids: retryable.map(item => item.export_batch_item_id) } }); setActiveBatch(result.batch); result.jobs.forEach(trackRenderJob); }
    catch (error) { setBatchError(error instanceof Error ? error.message : "重试批次失败。"); }
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
          else if (updated.status !== "succeeded") setReframeError(`重构图预览未完成：${updated.error?.code ?? updated.status}`);
        });
      }
    } catch (error) { setReframeError(error instanceof Error ? error.message : "生成重构图预览失败。"); }
  };
  const chooseReframeDirectory = async () => { if (!project) return; try { setReframeDirectoryGrant((await window.desktop.chooseExportDirectory(project.project_id)) ?? undefined); } catch { setReframeError("选择重构图导出目录失败。"); } };
  const createReframeBatch = async () => {
    if (!project || !reframeDirectoryGrant || renditionTargets.some(target => !reframePreviews[target.key] || !targetAdjustments(target).length)) return;
    try {
      const result = await window.desktop.createReframeExportBatch({ project_id: project.project_id, batch: { directory_grant_id: reframeDirectoryGrant.directory_grant_id, items: renditionTargets.map(target => ({ rendition_reframe_snapshot_id: reframePreviews[target.key].preview.rendition_reframe_snapshot_id, preview_artifact_id: reframePreviews[target.key].preview.render_artifact_id, encoder_mode: encoderMode })) } });
      setActiveReframeBatch(result.batch); setReframeDirectoryGrant(undefined); result.jobs.forEach(trackRenderJob);
    } catch (error) { setReframeError(error instanceof Error ? error.message : "创建重构图批次失败。"); }
  };
  const retryReframeBatchItems = async () => {
    if (!activeReframeBatch || !project) return;
    const retryable = activeReframeBatch.items.filter(item => ["failed", "cancelled", "interrupted"].includes(item.status));
    if (!retryable.length) return;
    try { const grant = await window.desktop.chooseExportDirectory(project.project_id); if (!grant) return; const result = await window.desktop.retryReframeExportBatch({ batch_id: activeReframeBatch.reframe_export_batch_id, retry: { directory_grant_id: grant.directory_grant_id, reframe_export_batch_item_ids: retryable.map(item => item.reframe_export_batch_item_id) } }); setActiveReframeBatch(result.batch); result.jobs.forEach(trackRenderJob); }
    catch (error) { setReframeError(error instanceof Error ? error.message : "重试重构图批次失败。"); }
  };

  const previewClass = selectedClip?.layout ?? working?.clips[0]?.layout ?? "fit";
  const authoritativePreview = previews.find(item => item.preview.timeline_revision_id === timeline?.current_revision.timeline_revision_id) ?? previews[0];
  const previewIsStale = Boolean(authoritativePreview && (authoritativePreview.preview.status === "stale" || authoritativePreview.preview.timeline_revision_id !== timeline?.current_revision.timeline_revision_id));
  const authoritativeMediaUrl = reframePlayback?.media_url ?? exportPlayback?.media_url ?? authoritativePreview?.media_url;
  const renderDisabledReason = !timeline || !working?.clips.length ? "时间线为空" : timeline.draft ? "存在未提交草稿，请先形成正式 Revision" : undefined;
  return <main className="editor-shell">
    <header className="editor-topbar">
      <div className="project-control"><strong>AIVideo Studio</strong>{project && <><h1 className="project-title">{project.name}</h1><span className={`project-state ${project.status}`}>{project.status === "active" ? "活动" : project.status === "archived" ? "已归档" : "目录缺失"}</span></>}<select aria-label="当前项目" value={project?.project_id ?? ""} onChange={event => setProject(projects.find(item => item.project_id === event.target.value))}><option value="">选择项目</option>{projects.map(item => <option key={item.project_id} value={item.project_id}>{item.name}</option>)}</select><input aria-label="重命名项目" value={projectName} disabled={!project} onChange={event => { if (project) projectNameProjectId.current = project.project_id; projectNameDirty.current = true; setProjectName(event.target.value); }} /><IconButton label="重命名" disabled={!project} onClick={() => void renameProject()}><Save /></IconButton><IconButton label={project?.status === "archived" ? "重新打开" : "归档"} disabled={!project} onClick={() => void toggleArchive()}>{project?.status === "archived" ? <RotateCcw /> : <Archive />}</IconButton><input aria-label="项目名称" value={newProject} onChange={event => setNewProject(event.target.value)} placeholder="新项目" /><button className="compact-command" disabled={!newProject.trim()} onClick={() => void createProject()}><FolderPlus />创建</button></div>
      <div className={`save-state ${saveState === "保存失败" || saveState === "草稿冲突" ? "error" : ""}`}><Save />{saveState}</div>
      <div className="top-actions"><IconButton label="撤销" disabled={!timeline?.can_undo} onClick={() => void undoRedo("undo")}><Undo2 /></IconButton><IconButton label="重做" disabled={!timeline?.can_redo} onClick={() => void undoRedo("redo")}><Redo2 /></IconButton><span className="job-state">{runtimeReady ? "Core 已连接 · 任务空闲" : "Core 连接中"}</span><select aria-label="编码模式" value={encoderMode} onChange={event => setEncoderMode(event.target.value as EncoderMode)}><option value="auto">自动编码</option><option value="software">软件编码</option></select><button disabled={Boolean(renderDisabledReason)} title={renderDisabledReason} onClick={() => void generatePreview()}><Video /> 生成预览</button><button disabled={Boolean(renderDisabledReason)} title={renderDisabledReason ?? (authoritativePreview ? "" : "无需先生成预览，可直接导出")} onClick={() => void createExport()}><Download /> 导出</button></div>
    </header>
    <div className="banner-stack">{notice && <div className="notice" role="alert">{notice}</div>}{timeline?.draft && <div className="draft-banner"><span>{timeline.draft.conflict ? "检测到冲突草稿" : "检测到上次未恢复草稿"}</span><button disabled={timeline.draft.conflict} onClick={() => { setWorking(timeline.draft!.document); setSaveState("已保存"); }}>恢复</button><button onClick={() => void (async () => { await window.desktop.deleteTimelineDraft(project!.project_id); setTimeline({ ...timeline, draft: null }); })()}>丢弃</button></div>}</div>
    <section className="editor-grid">
      <aside className="library-pane">
        <div className="tabs"><button className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>素材</button><button className={tab === "transcripts" ? "active" : ""} onClick={() => setTab("transcripts")}>转录</button></div>
        {tab === "assets" ? <><h2 className="pane-title">素材工作区</h2><div className="library-toolbar">{assetKinds.map(kind => <button key={kind} disabled={!project || project.status !== "active"} onClick={() => void importAsset(kind)}>{kind === "video" ? <Video /> : kind === "audio" ? <FileAudio /> : kind === "image" ? <ImagePlus /> : <FileText />}导入{kind}</button>)}</div><div className="asset-list asset-table">{assets.map(item => <div className="asset-item asset-row" key={item.asset.asset_id}><div className="asset-name"><strong title={item.asset.display_name}>{item.asset.display_name}</strong><small title={item.media_url ?? "受限媒体 URL 不可用"}>{item.media_url ?? "受限媒体 URL 不可用"}</small><span className={`availability ${item.asset.availability}`}>{availabilityLabels[item.asset.availability]}</span></div><div className="asset-actions"><IconButton label="刷新" onClick={() => void refreshAsset(item.asset)}><RefreshCw /></IconButton><IconButton label="重新定位" onClick={() => void relocateAsset(item.asset)}><MapPin /></IconButton>{isTranscribable(item.asset) && <IconButton label="转录" onClick={() => startTranscription(item.asset)}><FileAudio /></IconButton>}{(item.asset.kind === "video" || item.asset.kind === "image") && <IconButton label={`追加 ${item.asset.display_name}`} disabled={item.asset.availability !== "available"} onClick={() => insertAsset(item)}><Plus /></IconButton>}</div></div>)}</div><section className="legacy-section model-panel"><h2>本地转录模型</h2>{models.map(model => <div className="model-row" key={model.model_id}><div><strong>{model.display_name}</strong><small>{modelStatusLabels[model.status]} · {model.provider}</small>{["queued", "downloading", "verifying", "paused"].includes(model.status) && <progress max="1" value={model.progress ?? 0} />}</div><div>{["unavailable", "failed", "cancelled", "paused"].includes(model.status) && <button onClick={() => void openModel(model)}>{model.status === "failed" ? "重试下载" : model.status === "paused" ? "继续下载" : "下载模型"}</button>}{["queued", "downloading", "verifying", "paused"].includes(model.status) && <IconButton label="取消模型下载" onClick={() => void cancelModel(model)}><Square /></IconButton>}</div></div>)}</section><section className="legacy-section jobs-panel"><h2>任务</h2>{jobs.map(job => <div className="job-row" key={job.job_id}><div><strong>{job.kind === "transcription" ? "本地转录" : job.kind === "proxy" ? "代理素材" : job.kind}</strong><small>{jobStatusLabels[job.status]} · {job.stage}</small></div><div>{job.kind === "transcription" && (job.status === "failed" || job.status === "interrupted") && <button onClick={() => void retryTranscription(job)}>重试转录</button>}{["queued", "running", "cancelling"].includes(job.status) && <IconButton label="取消任务" onClick={() => void cancelJob(job)}><Square /></IconButton>}</div></div>)}</section></> : <div className="transcript-list"><h2 className="pane-title">原始转录</h2>{assets.filter(item => isTranscribable(item.asset)).map(assetItem => <div className="transcript-row" key={assetItem.asset.asset_id}><strong title={assetItem.asset.display_name}>{assetItem.asset.display_name}</strong><div>{(transcriptSummaries[assetItem.asset.asset_id] ?? []).map(summary => <button key={summary.transcript_id} aria-label={`查看转录 ${summary.transcript_id}`} onClick={() => void viewTranscript(summary)}><Eye />{summary.language} · {summary.status}</button>)}</div></div>)}{Object.values(transcripts).flat().map(item => <div className="transcript-item" key={item.transcript_id}><strong>{assets.find(asset => asset.asset.asset_id === item.asset_id)?.asset.display_name ?? "转录"}</strong>{item.segments.map(segment => <SegmentRow key={segment.segment_id} segment={segment} selected={(selectedSegments[item.transcript_id] ?? []).includes(segment.segment_id)} onToggle={() => setSelectedSegments(state => ({ ...state, [item.transcript_id]: toggle(state[item.transcript_id] ?? [], segment.segment_id) }))} />)}<button onClick={() => insertSegments(item)}>追加所选片段</button></div>)}</div>}
        {!timeline && project && <div className="empty-timeline"><button onClick={() => void createTimeline({ kind: "empty" })}>创建空时间线</button></div>}
      </aside>
      <section className="stage-pane">
        <div className="preview-mode-switch" aria-label="预览模式"><button className={previewMode === "interactive" ? "active" : ""} onClick={() => { setPreviewMode("interactive"); setExportPlayback(undefined); }}>交互预览</button><button className={previewMode === "authoritative" ? "active" : ""} disabled={!authoritativePreview && !exportPlayback} onClick={() => { setPreviewMode("authoritative"); setExportPlayback(undefined); }}>权威预览</button></div>
        <div className={`preview-frame ${previewClass}`}>
          {previewMode === "authoritative" && authoritativeMediaUrl && <video ref={videoRef} className="preview-foreground authoritative-video" src={authoritativeMediaUrl} aria-label={reframePlayback ? "重构图权威预览视频" : exportPlayback ? "导出视频" : "权威预览视频"} controls onEnded={() => setPlaying(false)} />}
          {previewMode === "interactive" && previewAsset?.media_url && previewAsset.asset.kind === "video" && <><video className="preview-background" src={previewAsset.media_url} muted aria-hidden="true" /><video ref={videoRef} className="preview-foreground" src={previewAsset.media_url} muted={!selectedClip?.audio.enabled} aria-label="交互预览视频" onTimeUpdate={event => setPlayhead(Math.round(event.currentTarget.currentTime * 1_000_000))} onEnded={() => setPlaying(false)} /></>}
          {previewMode === "interactive" && previewAsset?.media_url && previewAsset.asset.kind === "image" && <><img className="preview-background" src={previewAsset.media_url} alt="" aria-hidden="true" /><img className="preview-foreground" src={previewAsset.media_url} alt={previewAsset.asset.display_name} /></>}
          {previewMode === "interactive" && !previewAsset?.media_url && <div className="preview-empty">选择或追加素材以开始编辑</div>}
          {previewMode === "interactive" && visibleCaption && <div className={`caption-overlay ${visibleCaption.preset_id}`}>{visibleCaption.text}</div>}
          <span className={`interactive-label ${previewIsStale && previewMode === "authoritative" && !exportPlayback ? "stale" : ""}`}>{previewMode === "interactive" ? "交互预览 · 非权威" : reframePlayback ? "静态焦点重构图 · 权威预览" : exportPlayback ? `导出 · ${exportPlayback.export_record.destination_display_name}` : previewIsStale ? "权威预览 · 已过期" : "权威预览 · 当前 Revision"}</span>
        </div>
        <div className="playback"><IconButton label={playing ? "暂停" : "播放"} onClick={() => setPlaying(value => !value)}>{playing ? <Pause /> : <Play />}</IconButton><input aria-label="播放位置" type="range" min={0} max={Math.max(totalUs, 1)} value={Math.min(playhead, totalUs)} onChange={event => { const value = Number(event.target.value); setPlayhead(value); if (videoRef.current) videoRef.current.currentTime = value / 1_000_000; }} /><span>{formatTime(playhead)} / {formatTime(totalUs)}</span></div>
        <div className="layout-switch" aria-label="布局切换">{layouts.map(item => <button key={item.value} className={previewClass === item.value ? "active" : ""} disabled={!selectedClip} onClick={() => selectedClip && void patchTimeline([{ op: "set_layout", clip_id: selectedClip.clip_id, layout: item.value }], "调整布局")}>{item.label}</button>)}</div>
        <section className="export-records">
          <div><strong>渲染与导出</strong>{!authoritativePreview && <small>当前没有权威预览，仍可直接导出。</small>}</div>
          {jobs.filter(item => item.kind === "authoritative_preview" || item.kind === "final_export").map(item => <div className="render-job" key={item.job_id}><div><strong>{item.kind === "authoritative_preview" ? "权威预览" : "最终导出"}</strong><small>{jobStatusLabels[item.status]} · {item.stage} · {item.progress === null ? "--" : `${Math.round(item.progress * 100)}%`}{item.error ? ` · ${item.error.message}` : ""}</small></div>{["queued", "running", "cancelling"].includes(item.status) && <IconButton label="取消渲染任务" onClick={() => void cancelJob(item)}><Square /></IconButton>}</div>)}
          {exports.map(item => <div className="export-record" key={item.export_record.export_record_id}><div><strong>{item.export_record.destination_display_name}</strong><small>{item.export_record.status} · {item.export_record.encoder}{item.export_record.fallback_reason ? ` · ${item.export_record.fallback_reason}` : ""}</small></div><div><IconButton label="播放导出" onClick={() => { setExportPlayback(item); setPreviewMode("authoritative"); }}><Play /></IconButton><IconButton label="打开导出" onClick={() => void window.desktop.openArtifact(item.export_record.render_artifact_id)}><Eye /></IconButton><IconButton label="定位导出" onClick={() => void window.desktop.openArtifactFolder(item.export_record.render_artifact_id)}><MapPin /></IconButton></div></div>)}
        </section>
      </section>
      <aside className="properties-pane">{selectedClip ? <ClipProperties clip={selectedClip} locked={Boolean(working?.locked_elements?.includes(selectedClip.clip_id))} onPatch={patchTimeline} onDraft={queueDraft} working={working!} /> : selectedCaption ? <CaptionProperties caption={selectedCaption} locked={Boolean(selectedCaption.source_clip_id && working?.locked_elements?.includes(selectedCaption.source_clip_id))} onPatch={patchTimeline} onDraft={queueDraft} working={working!} /> : <div className="properties-empty"><strong>属性</strong><p>选择 V1 片段或 C1 字幕后编辑。</p></div>}</aside>
    </section>
    <TimelinePanel document={working} selection={selection} setSelection={setSelection} onPatch={patchTimeline} />
    <footer><button className="ai-entry" disabled={!project || !timeline} onClick={() => void openExportBatch()}><Download />多平台导出</button><button className="ai-entry" disabled={!project} onClick={() => void openAi()}>AI 粗剪</button><button className="ai-entry" disabled={!timeline} onClick={() => void openPatch()}><Sparkles />AI 修改</button><button className="ai-entry" disabled={!timeline} onClick={() => void openRevisionCompare()}><History />版本比较</button><button className="ai-entry" disabled={!aiForm.provider_id} onClick={() => void deleteAiSecret()}>删除当前 Provider 密钥</button>{CONTRACT_VERSION} · 权威预览与最终导出均由冻结 Timeline Revision 生成。</footer>
    {batchOpen && <div className="modal-backdrop"><section className="modal export-batch-modal" role="dialog" aria-modal="true" aria-labelledby="export-batch-title"><div className="modal-heading"><div><h2 id="export-batch-title">多平台导出</h2><p>平台与画幅独立选择；仅同一 Revision 的权威预览可进入批次。</p></div><IconButton label="关闭多平台导出" onClick={() => setBatchOpen(false)}><X /></IconButton></div>{batchError && <p className="ai-status" role="status">{batchError}</p>}<div className="rendition-targets">{renditionTargets.map(target => { const platform = platformPresets.find(item => item.platform_preset_id === target.platform_preset_id); const rendition = renditionPresets.find(item => item.rendition_preset_id === target.rendition_preset_id); const preview = targetPreview(target); return <section key={target.key} className="rendition-target"><label>平台<select aria-label="导出平台" value={target.platform_preset_id} onChange={event => { const next = platformPresets.find(item => item.platform_preset_id === event.target.value); if (next) updateTarget(target.key, { platform_preset_id: next.platform_preset_id, rendition_preset_id: next.default_rendition_id, key: `${next.platform_preset_id}:${next.default_rendition_id}` }); }}><option value="">选择平台</option>{platformPresets.map(item => <option value={item.platform_preset_id} key={item.platform_preset_id}>{item.display_name}</option>)}</select></label><label>画幅<select aria-label="导出画幅" value={target.rendition_preset_id} onChange={event => updateTarget(target.key, { rendition_preset_id: event.target.value, key: `${target.platform_preset_id}:${event.target.value}` })}>{platform?.allowed_rendition_ids.map(id => <option value={id} key={id}>{renditionPresets.find(item => item.rendition_preset_id === id)?.display_name ?? id}</option>)}</select></label><label>布局<select aria-label="目标布局策略" value={target.layout_policy} onChange={event => updateTarget(target.key, { layout_policy: event.target.value as LayoutPolicy })}>{layoutPolicies.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label><div className="target-summary"><small>{rendition ? `${rendition.export.width}×${rendition.export.height} · H.264/AAC · 30fps` : "预设加载中"}</small><small>{preview ? `权威预览已就绪${preview.preview.warnings.length ? ` · ${preview.preview.warnings.join("、")}` : ""}` : "需要本目标权威预览"}</small></div><div className="target-actions"><button onClick={() => void generateRenditionPreview(target)}>{preview ? "重新生成权威预览" : "生成权威预览"}</button><button disabled={renditionTargets.length === 1} onClick={() => setRenditionTargets(items => items.filter(item => item.key !== target.key))}>移除</button></div>{preview && <ReframeTargetEditor clips={reframeClips(target)} selections={reframeSelections[target.key] ?? {}} preview={reframePreviews[target.key]} pending={Boolean(reframePending[target.key])} onSelect={(clipId, anchor) => selectReframeAnchor(target, clipId, anchor)} onGenerate={() => void generateReframePreview(target)} onPlay={() => { setReframePlayback(reframePreviews[target.key]); setExportPlayback(undefined); setPreviewMode("authoritative"); }} />}</section>; })}</div><div className="modal-actions"><button disabled={renditionTargets.length >= 8 || !platformPresets.length} onClick={addTarget}>添加目标</button><button onClick={() => void chooseBatchDirectory()}>{directoryGrant ? `输出目录：${directoryGrant.display_name}` : "选择输出目录"}</button><button disabled={!directoryGrant || !renditionTargets.length || renditionTargets.some(target => !targetPreview(target))} onClick={() => void createBatch()}>创建批次</button></div><section className="reframe-batch-actions" aria-label="静态焦点批量导出"><h3>静态焦点批量导出</h3><p>独立于基础 Stage 3A 批次；所有目标的重构图权威预览就绪后才可创建。</p>{reframeError && <p className="ai-status" role="status">{reframeError}</p>}<div className="modal-actions"><button disabled={renditionTargets.some(target => !targetAdjustments(target).length || !reframePreviews[target.key])} onClick={() => void chooseReframeDirectory()}>{reframeDirectoryGrant ? `重构图输出目录：${reframeDirectoryGrant.display_name}` : "选择重构图输出目录"}</button><button disabled={!reframeDirectoryGrant || renditionTargets.some(target => !targetAdjustments(target).length || !reframePreviews[target.key])} onClick={() => void createReframeBatch()}>创建重构图批次</button></div></section>{activeBatch && <section className="batch-status"><h3>批次 {activeBatch.status}</h3><p>目录：{activeBatch.directory_display_name}</p>{activeBatch.items.map(item => <div key={item.export_batch_item_id}><strong>{item.rendition_snapshot.platform_preset_id} · {item.rendition_snapshot.rendition_preset_id}</strong><small>{item.status} · {item.progress === null ? "--" : `${Math.round(item.progress * 100)}%`}{item.destination_display_name ? ` · ${item.destination_display_name}` : ""}{item.error_code ? ` · ${item.error_code}` : ""}</small></div>)}<div className="modal-actions">{["queued", "running"].includes(activeBatch.status) && <button onClick={() => void window.desktop.cancelExportBatch(activeBatch.export_batch_id).then(setActiveBatch).catch(() => setBatchError("取消批次失败。"))}>取消批次</button>}{activeBatch.items.some(item => ["failed", "cancelled", "interrupted"].includes(item.status)) && <button onClick={() => void retryBatchItems()}>重新授权并重试失败项</button>}</div></section>}{activeReframeBatch && <section className="batch-status reframe-batch-status"><h3>重构图批次 {activeReframeBatch.status}</h3><p>目录：{activeReframeBatch.directory_display_name}</p>{activeReframeBatch.items.map(item => <div key={item.reframe_export_batch_item_id}><strong>{item.rendition_reframe_snapshot.platform_preset_id} · {item.rendition_reframe_snapshot.rendition_preset_id}</strong><small>{item.status} · {item.progress === null ? "--" : `${Math.round(item.progress * 100)}%`}{item.destination_display_name ? ` · ${item.destination_display_name}` : ""}{item.error_code ? ` · ${item.error_code}` : ""}</small></div>)}<div className="modal-actions">{["queued", "running"].includes(activeReframeBatch.status) && <button onClick={() => void window.desktop.cancelReframeExportBatch(activeReframeBatch.reframe_export_batch_id).then(setActiveReframeBatch).catch(() => setReframeError("取消重构图批次失败。"))}>取消重构图批次</button>}{activeReframeBatch.items.some(item => ["failed", "cancelled", "interrupted"].includes(item.status)) && <button onClick={() => void retryReframeBatchItems()}>重新授权并重试重构图失败项</button>}</div></section>}</section></div>}
    {confirmModel && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="model-confirm-title"><div className="modal-heading"><h2 id="model-confirm-title">确认下载本地模型</h2><IconButton label="关闭" onClick={() => setConfirmModel(undefined)}><X /></IconButton></div><h3>{confirmModel.display_name}</h3><p>{confirmModel.purpose}</p><dl><dt>下载大小</dt><dd>{formatBytes(confirmModel.model_size_bytes)}</dd><dt>许可证</dt><dd>{confirmModel.license.name}</dd><dt>隐私</dt><dd>模型在本机运行，不上传媒体或转录正文。</dd></dl>{confirmModel.license.acceptance_required && <label className="check-line"><input type="checkbox" checked={licenseAccepted} onChange={event => setLicenseAccepted(event.target.checked)} />我已阅读并接受该许可证</label>}<div className="modal-actions"><button onClick={() => setConfirmModel(undefined)}>暂不下载</button><button disabled={confirmModel.license.acceptance_required && !licenseAccepted} onClick={() => void downloadModel()}>确认并下载</button></div></section></div>}
    {transcriptionAsset && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="transcription-title"><div className="modal-heading"><h2 id="transcription-title">创建本地转录</h2><IconButton label="关闭" onClick={() => setTranscriptionAsset(undefined)}><X /></IconButton></div><p title={transcriptionAsset.display_name}>{transcriptionAsset.display_name}</p><label>语言<select value={language} onChange={event => setLanguage(event.target.value)}><option value="auto">自动检测</option><option value="zh">中文</option><option value="en">English</option></select></label><label className="check-line"><input type="checkbox" checked={wordTimestamps} onChange={event => setWordTimestamps(event.target.checked)} />生成词级时间戳</label><div className="modal-actions"><button onClick={() => setTranscriptionAsset(undefined)}>取消</button><button onClick={() => void submitTranscription()}>开始转录</button></div></section></div>}
    {viewingTranscript && <div className="modal-backdrop"><section className="modal transcript-viewer" role="dialog" aria-modal="true" aria-labelledby="transcript-title"><div className="modal-heading"><div><h2 id="transcript-title">原始转录</h2><small>{viewingTranscript.language} · {viewingTranscript.provider} · {viewingTranscript.model_revision}</small></div><IconButton label="关闭" onClick={() => setViewingTranscript(undefined)}><X /></IconButton></div><div className="readonly-note">原始 ASR 结果只读。字幕修订不会覆盖这份记录。</div><div className="readonly-segments">{viewingTranscript.segments.map(segment => <div key={segment.segment_id}><span>{formatTime(segment.start_us)}-{formatTime(segment.end_us)}</span><p>{segment.text}</p></div>)}</div></section></div>}
    {aiOpen && <div className="modal-backdrop"><section className="modal ai-roughcut" role="dialog" aria-modal="true" aria-labelledby="ai-roughcut-title"><div className="modal-heading"><div><h2 id="ai-roughcut-title">AI 粗剪</h2><p>仅在确认外传内容后调用 Provider。</p></div><IconButton label="关闭 AI 粗剪" onClick={() => setAiOpen(false)}><X /></IconButton></div>{aiError && <p className="ai-status" role="status">{aiError}</p>}{aiStep === "form" && <><label>主题<input value={aiForm.topic} onChange={e => setAiForm(v => ({ ...v, topic: e.target.value }))} /></label><label>受众<input value={aiForm.audience} onChange={e => setAiForm(v => ({ ...v, audience: e.target.value }))} /></label><label>叙事目标<textarea value={aiForm.narrative_goal} onChange={e => setAiForm(v => ({ ...v, narrative_goal: e.target.value }))} /></label><label>风格说明<textarea value={aiForm.style_notes} onChange={e => setAiForm(v => ({ ...v, style_notes: e.target.value }))} /></label><label>制作配方<select value={aiForm.recipe_id} onChange={e => setAiForm(v => ({ ...v, recipe_id: e.target.value }))}><option value="">选择配方</option>{aiRecipes.map(item => <option key={item.recipe_id} value={item.recipe_id}>{item.name ?? item.display_name} · {item.summary}</option>)}</select></label><label>Provider<select value={aiForm.provider_id} onChange={e => setAiForm(v => ({ ...v, provider_id: e.target.value }))}><option value="">选择 Provider</option>{aiProviders.map(item => <option key={item.provider_config_id} value={item.provider_config_id} disabled={!item.enabled || item.credential_status !== "configured" || item.candidate_capability_status !== "supported"}>{item.display_name} · {item.candidate_capability_status === "supported" ? "AI 粗剪可用" : item.candidate_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 粗剪"}</option>)}</select></label><div className="provider-capability-list">{aiProviders.map(item => <div key={item.provider_config_id}><span>{item.display_name} · {item.candidate_capability_status === "supported" ? "AI 粗剪可用" : item.candidate_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 粗剪"}</span><button disabled={aiCapabilityTesting} onClick={() => void testCandidateProviderCapability(item.provider_config_id)}>{aiCapabilityTesting ? "正在测试兼容性" : "测试 AI 粗剪兼容性"}</button></div>)}</div><div className="ai-inline"><input id="ai-provider-secret" aria-label="Provider 密钥" type="password" autoComplete="off" placeholder="仅提交新密钥" /><button onClick={() => void saveAiSecret()}>安全保存密钥</button><button onClick={() => void testAiProvider()}>连接测试</button></div><fieldset><legend>新建 Provider（可选）</legend><input aria-label="Provider 名称" value={aiProviderDraft.display_name} onChange={e => setAiProviderDraft(v => ({ ...v, display_name: e.target.value }))} placeholder="名称" /><input aria-label="Provider 地址" value={aiProviderDraft.base_url} onChange={e => setAiProviderDraft(v => ({ ...v, base_url: e.target.value }))} placeholder="https://…" /><input aria-label="Provider 模型" value={aiProviderDraft.model} onChange={e => setAiProviderDraft(v => ({ ...v, model: e.target.value }))} placeholder="模型" /><button onClick={() => void saveAiProvider()}>创建 Provider</button></fieldset><label>就绪转录<select value={aiForm.transcript_id} onChange={e => setAiForm(v => ({ ...v, transcript_id: e.target.value }))}><option value="">选择已就绪转录</option>{Object.values(transcripts).flat().map(item => <option key={item.transcript_id} value={item.transcript_id}>{item.language} · {item.segments.length} 段</option>)}</select></label><div className="modal-actions"><button disabled={!aiForm.topic || !aiForm.audience || !aiForm.narrative_goal || !aiForm.provider_id || !aiForm.recipe_id || !aiForm.transcript_id || aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.candidate_capability_status !== "supported" || aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.credential_status !== "configured" || !aiProviders.find(item => item.provider_config_id === aiForm.provider_id)?.enabled} onClick={() => void prepareAi()}>准备外传确认</button></div></>}{aiStep === "confirm" && aiPreview && <><h3>确认发送的精确内容</h3><dl><dt>目标</dt><dd>{aiPreview.provider.origin}</dd><dt>模型</dt><dd>{aiPreview.provider.model}</dd><dt>字段</dt><dd>{aiPreview.sent_fields.join("、")}</dd><dt>段落/字符</dt><dd>{aiPreview.stats.segment_count} 段 / {aiPreview.stats.character_count} 字</dd><dt>估算 Token</dt><dd>{aiPreview.stats.estimated_tokens}</dd><dt>费用提示</dt><dd>按 Provider 配置的单价估算，最终费用以服务商账单为准。</dd><dt>哈希</dt><dd>{aiPreview.payload_sha256}</dd><dt>有效期</dt><dd>{aiPreview.expires_at}</dd></dl><div className="egress-text">{Array.isArray(aiPreview.payload.segments) && (aiPreview.payload.segments as Array<Record<string, unknown>>).map(segment => <p key={String(segment.segment_ref)}>{String(segment.text)}</p>)}</div><div className="modal-actions"><button onClick={() => { setAiPreview(undefined); setAiStep("form"); }}>返回修改</button><button onClick={() => void createAi()}>我确认发送以上内容</button></div></>}{aiStep === "running" && <><h3>正在生成候选方案</h3><p>任务进度与取消操作沿用现有任务中心；如失败或取消，请重新准备并再次确认。</p></>}{aiStep === "candidates" && <><h3>三个候选方案</h3><div className="candidate-columns">{(["balanced", "compact", "bold"] as const).map((variant, index) => { const item = aiCandidates.find(candidate => candidate.variant === variant); const title = ["稳妥版", "紧凑版", "高能版"][index]; return <section key={variant}><h4>{title}</h4>{item ? <><strong>{String(item.title_suggestion)}</strong><p>{String(item.summary)}</p><small>{Number(item.duration_us) / 1_000_000}s · 模型参考</small>{Array.isArray(item.clips) && (item.clips as Array<Record<string, unknown>>).map(clip => <div className="candidate-clip" key={String(clip.clip_id)}><span>{Number(clip.source_start_us) / 1_000_000}s–{Number(clip.source_end_us) / 1_000_000}s</span><button onClick={() => void playAiClip(clip)}>试播片段</button><p>{String(clip.reason)}</p></div>)}<button onClick={() => void adoptAi(item)}>采用此方案</button></> : <p>等待有效响应</p>}</section>; })}</div>{aiPlayback && <video className="candidate-player" src={aiPlayback.media_url} controls autoPlay onLoadedMetadata={e => { e.currentTarget.currentTime = aiPlayback.source_start_us / 1_000_000; }} onTimeUpdate={e => { if (e.currentTarget.currentTime >= aiPlayback.source_end_us / 1_000_000) e.currentTarget.pause(); }} />}</>}</section></div>}
     {aiOpen && aiStep === "running" && <section className="ai-job-progress" aria-live="polite" aria-label="AI 粗剪任务进度"><strong>阶段：{aiJob?.stage ?? "queued"}</strong><span>进度：{Math.round((aiJob?.progress ?? 0) * 100)}%</span><progress aria-label="AI 粗剪进度" max="1" value={aiJob?.progress ?? 0} /><button disabled={!aiJob || !["queued", "running", "cancelling"].includes(aiJob.status)} onClick={() => { if (!aiJob) return; void window.desktop.cancelJob(aiJob.job_id).then(job => { setAiJob(job); setAiPreview(undefined); setAiCandidates([]); setAiPlayback(undefined); setAiStep("form"); setAiError("生成已取消。请重新准备外传内容并再次确认。"); }).catch(() => setAiError("取消请求失败；请等待当前任务状态刷新。")); }}>取消生成</button></section>}
    {patchOpen && <div className="modal-backdrop"><section className="modal planning-patch" role="dialog" aria-modal="true" aria-labelledby="planning-patch-title"><div className="modal-heading"><div><h2 id="planning-patch-title">AI 修改</h2><p>提案不会自动修改正式 Timeline。</p></div><IconButton label="关闭 AI 修改" onClick={closePatch}><X /></IconButton></div>{patchError && <p className="ai-status" role="status">{patchError}</p>}{patchStep === "form" && <><label>修改指令<textarea aria-label="修改指令" maxLength={4000} value={patchInstruction} onChange={event => setPatchInstruction(event.target.value)} /></label><label>Provider<select aria-label="AI 修改 Provider" value={patchProviderId} onChange={event => setPatchProviderId(event.target.value)}><option value="">选择已配置 Provider</option>{patchProviders.map(item => <option value={item.provider_config_id} key={item.provider_config_id} disabled={item.timeline_patch_capability_status !== "supported"}>{item.display_name} · {item.model} · {item.timeline_patch_capability_status === "supported" ? "AI 修改可用" : item.timeline_patch_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 修改"}</option>)}</select></label><div className="provider-capability-list">{patchProviders.map(item => <div key={item.provider_config_id}><span>{item.display_name} · {item.timeline_patch_capability_status === "supported" ? "AI 修改可用" : item.timeline_patch_capability_status === "untested" ? "未测试" : "当前 Provider 不支持 AI 修改"}</span><button disabled={patchCapabilityTesting} onClick={() => void testPatchProviderCapability(item.provider_config_id)}>{patchCapabilityTesting ? "正在测试兼容性" : "测试 AI 修改兼容性"}</button></div>)}</div><div className="modal-actions"><button disabled={!patchProviderId || !patchInstruction.trim() || patchProviders.find(item => item.provider_config_id === patchProviderId)?.timeline_patch_capability_status !== "supported"} onClick={() => void preparePatch()}>准备外传确认</button></div></>}{patchStep === "confirm" && patchPreview && <><h3>确认本次外传</h3><div className="instruction-preview"><strong>你的本地指令</strong><p>{patchInstruction}</p></div><dl><dt>Provider</dt><dd>{patchPreview.provider.display_name} · {patchPreview.provider.origin}</dd><dt>模型</dt><dd>{patchPreview.provider.model}</dd><dt>字段类别</dt><dd>{patchPreview.sent_fields.join("、")}</dd><dt>内容计数</dt><dd>{patchPreview.clip_count} Clip / {patchPreview.caption_count} Caption / {patchPreview.locked_count} 锁定</dd><dt>字符 / Token</dt><dd>{patchPreview.character_count} / 约 {patchPreview.estimated_tokens}</dd><dt>哈希</dt><dd>{patchPreview.payload_sha256}</dd><dt>费用</dt><dd>最终费用以 Provider 账单为准。</dd></dl><p className="readonly-note">上方指令来自当前本地输入；Core 确认 DTO 不包含正文。</p><div className="modal-actions"><button onClick={() => { setPatchPreview(undefined); setPatchStep("form"); }}>返回修改</button><button onClick={() => void createPatch()}>确认并发送一次</button></div></>}{patchStep === "running" && <><h3>正在生成提案</h3><p>{patchJob?.stage ?? "queued"} · {Math.round((patchJob?.progress ?? 0) * 100)}%</p><progress max="1" value={patchJob?.progress ?? 0} /><div className="modal-actions"><button disabled={!patchJob || !["queued", "running", "cancelling"].includes(patchJob.status)} onClick={() => void cancelPatch()}>取消生成</button></div></>}{patchStep === "proposal" && patchProposal && <><h3>提案差异</h3><TimelineDiffView diff={patchProposal.diff} /><div className="modal-actions"><button onClick={closePatch}>放弃</button><button disabled={patchProposal.applied_revision_id !== null} onClick={() => void applyPatchProposal()}>应用修改</button></div></>}</section></div>}
    {revisionOpen && <div className="modal-backdrop"><section className="modal revision-compare" role="dialog" aria-modal="true" aria-labelledby="revision-compare-title"><div className="modal-heading"><div><h2 id="revision-compare-title">版本比较</h2><p>只读操作，不改变当前 Revision、草稿或渲染记录。</p></div><IconButton label="关闭版本比较" onClick={() => { setRevisionOpen(false); setRevisionDiff(undefined); }}><X /></IconButton></div><div className="revision-selectors"><label>基线<select aria-label="基线 Revision" value={revisionPair.base} onChange={event => setRevisionPair(value => ({ ...value, base: event.target.value }))}>{revisions.map(item => <option value={item.timeline_revision_id} key={`base-${item.timeline_revision_id}`}>{item.summary} · {item.created_at}</option>)}</select></label><label>目标<select aria-label="目标 Revision" value={revisionPair.target} onChange={event => setRevisionPair(value => ({ ...value, target: event.target.value }))}>{revisions.map(item => <option value={item.timeline_revision_id} key={`target-${item.timeline_revision_id}`}>{item.summary} · {item.created_at}</option>)}</select></label></div><div className="modal-actions"><button disabled={!revisionPair.base || !revisionPair.target || revisionPair.base === revisionPair.target} onClick={() => void compareRevisions()}>比较</button></div>{revisionDiff && <TimelineDiffView diff={revisionDiff} />}</section></div>}
   </main>;
}

function SegmentRow({ segment, selected, onToggle }: { segment: TranscriptSegment; selected: boolean; onToggle: () => void }) { return <label className="segment-row"><input type="checkbox" checked={selected} onChange={onToggle} /><span>{formatTime(segment.start_us)}-{formatTime(segment.end_us)}</span><p>{segment.text}</p></label>; }
function toggle(items: string[], id: string) { return items.includes(id) ? items.filter(item => item !== id) : [...items, id]; }

function ClipProperties({ clip, working, locked, onPatch, onDraft }: { clip: TimelineClip; working: TimelineDocument; locked: boolean; onPatch: (ops: TimelinePatchOperation[], summary: string) => Promise<void>; onDraft: (doc: TimelineDocument) => void }) {
  const updateLocal = (next: Partial<TimelineClip>) => onDraft({ ...working, clips: working.clips.map(item => item.clip_id === clip.clip_id ? { ...item, ...next } : item) });
  return <fieldset className="property-form locked-fieldset" disabled={locked}><h2>Clip 属性</h2>{locked && <p className="locked-note"><Lock />此 Clip 已锁定，直接编辑和关联 Caption 编辑已禁用。</p>}<label>布局<select value={clip.layout} onChange={event => void onPatch([{ op: "set_layout", clip_id: clip.clip_id, layout: event.target.value as TimelineLayout }], "调整布局")}>{layouts.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>{clip.asset_kind === "video" ? <><label className="check"><input type="checkbox" checked={clip.audio.enabled} onChange={event => void onPatch([{ op: "set_audio", clip_id: clip.clip_id, enabled: event.target.checked, gain_db: clip.audio.gain_db }], "调整音频")} />{clip.audio.enabled ? <Volume2 /> : <VolumeX />}启用音频</label><label>增益 {clip.audio.gain_db.toFixed(1)} dB<input type="range" min={-60} max={12} step={0.5} value={clip.audio.gain_db} onChange={event => updateLocal({ audio: { ...clip.audio, gain_db: Number(event.target.value) } })} onPointerUp={event => void onPatch([{ op: "set_audio", clip_id: clip.clip_id, enabled: clip.audio.enabled, gain_db: Number((event.target as HTMLInputElement).value) }], "调整音频增益")} /></label><label>源起点（秒）<input type="number" step="0.1" value={clip.source_start_us! / 1_000_000} onChange={event => updateLocal({ source_start_us: Number(event.target.value) * 1_000_000 })} onBlur={event => void onPatch([{ op: "trim_clip", clip_id: clip.clip_id, source_start_us: Number(event.target.value) * 1_000_000, source_end_us: clip.source_end_us! }], "微调片段起点")} /></label><label>源终点（秒）<input type="number" step="0.1" value={clip.source_end_us! / 1_000_000} onChange={event => updateLocal({ source_end_us: Number(event.target.value) * 1_000_000 })} onBlur={event => void onPatch([{ op: "trim_clip", clip_id: clip.clip_id, source_start_us: clip.source_start_us!, source_end_us: Number(event.target.value) * 1_000_000 }], "微调片段终点")} /></label></> : <label>图片时长（秒）<input type="number" min={0.5} max={30} step={0.5} value={(clip.timeline_end_us - clip.timeline_start_us) / 1_000_000} onChange={event => updateLocal({ timeline_end_us: clip.timeline_start_us + Number(event.target.value) * 1_000_000 })} onBlur={event => void onPatch([{ op: "set_image_duration", clip_id: clip.clip_id, duration_us: Number(event.target.value) * 1_000_000 }], "调整图片时长")} /></label>}</fieldset>;
}
function CaptionProperties({ caption, working, locked, onPatch, onDraft }: { caption: TimelineCaption; working: TimelineDocument; locked: boolean; onPatch: (ops: TimelinePatchOperation[], summary: string) => Promise<void>; onDraft: (doc: TimelineDocument) => void }) {
  const updateLocal = (next: Partial<TimelineCaption>) => onDraft({ ...working, captions: working.captions.map(item => item.caption_id === caption.caption_id ? { ...item, ...next } : item) });
  return <fieldset className="property-form locked-fieldset" disabled={locked}><h2>Caption 属性</h2>{locked && <p className="locked-note"><Lock />关联 Clip 已锁定，此 Caption 只读。</p>}<label>文本<textarea value={caption.text} maxLength={200} onChange={event => updateLocal({ text: event.target.value })} onBlur={event => void onPatch([{ op: "update_caption", caption_id: caption.caption_id, text: event.target.value }], "修正字幕文本")} /></label><label>开始（秒）<input type="number" step="0.1" value={caption.start_us / 1_000_000} onChange={event => updateLocal({ start_us: Number(event.target.value) * 1_000_000 })} onBlur={event => void onPatch([{ op: "set_caption_timing", caption_id: caption.caption_id, start_us: Number(event.target.value) * 1_000_000, end_us: caption.end_us }], "调整字幕时间")} /></label><label>结束（秒）<input type="number" step="0.1" value={caption.end_us / 1_000_000} onChange={event => updateLocal({ end_us: Number(event.target.value) * 1_000_000 })} onBlur={event => void onPatch([{ op: "set_caption_timing", caption_id: caption.caption_id, start_us: caption.start_us, end_us: Number(event.target.value) * 1_000_000 }], "调整字幕时间")} /></label><label>预设<select value={caption.preset_id} onChange={event => void onPatch([{ op: "set_caption_preset", caption_id: caption.caption_id, preset_id: event.target.value as CaptionPresetId }], "调整字幕预设")}>{presets.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label></fieldset>;
}
function TimelinePanel({ document, selection, setSelection, onPatch }: { document?: TimelineDocument; selection: Selection; setSelection: (selection: Selection) => void; onPatch: (ops: TimelinePatchOperation[], summary: string) => Promise<void> }) {
  const clip = selection?.kind === "clip" ? document?.clips.find(item => item.clip_id === selection.id) : undefined;
  const caption = selection?.kind === "caption" ? document?.captions.find(item => item.caption_id === selection.id) : undefined;
  const clipLocked = Boolean(clip && document?.locked_elements?.includes(clip.clip_id));
  const captionLocked = Boolean(caption?.source_clip_id && document?.locked_elements?.includes(caption.source_clip_id));
  return <section className="timeline-pane"><div className="timeline-toolbar"><strong>时间线</strong><IconButton label={clipLocked ? "解锁片段" : "锁定片段"} disabled={!clip} onClick={() => clip && void onPatch([{ op: "set_clip_locked", clip_id: clip.clip_id, locked: !clipLocked }], clipLocked ? "解锁片段" : "锁定片段")}>{clipLocked ? <LockOpen /> : <Lock />}</IconButton><IconButton label="向前移动" disabled={!clip || clipLocked || clip.order_index === 0} onClick={() => clip && void onPatch([{ op: "move_clip", clip_id: clip.clip_id, to_index: clip.order_index - 1 }], "移动片段")}><ChevronLeft /></IconButton><IconButton label="向后移动" disabled={!clip || clipLocked || clip.order_index === (document?.clips.length ?? 1) - 1} onClick={() => clip && void onPatch([{ op: "move_clip", clip_id: clip.clip_id, to_index: clip.order_index + 1 }], "移动片段")}><ChevronRight /></IconButton><IconButton label="拆分片段" disabled={!clip || clipLocked || clip.asset_kind !== "video"} onClick={() => clip && void onPatch([{ op: "split_clip", clip_id: clip.clip_id, source_time_us: clip.source_start_us! + Math.floor((clip.source_end_us! - clip.source_start_us!) / 2) }], "拆分片段")}><Scissors /></IconButton><IconButton label="删除所选" disabled={!selection || clipLocked || captionLocked} onClick={() => selection && void onPatch([selection.kind === "clip" ? { op: "remove_clip", clip_id: selection.id as never } : { op: "remove_caption", caption_id: selection.id as never }], selection.kind === "clip" ? "删除片段" : "删除字幕")}><Trash2 /></IconButton></div><div className="track"><span>V1</span><div className="track-content">{document?.clips.map(item => { const locked = Boolean(document.locked_elements?.includes(item.clip_id)); return <button key={item.clip_id} className={`clip-block ${selection?.id === item.clip_id ? "selected" : ""} ${locked ? "locked" : ""}`} style={{ flexGrow: Math.max(1, item.timeline_end_us - item.timeline_start_us) }} onClick={() => setSelection({ kind: "clip", id: item.clip_id })}>{locked ? <Lock /> : <Video />}<span>{item.asset_kind} {formatTime(item.timeline_end_us - item.timeline_start_us)}</span></button>; })}</div></div><div className="track"><span>C1</span><div className="track-content">{document?.captions.map(item => <button key={item.caption_id} className={`caption-block ${selection?.id === item.caption_id ? "selected" : ""} ${item.source_clip_id && document.locked_elements?.includes(item.source_clip_id) ? "locked" : ""}`} onClick={() => setSelection({ kind: "caption", id: item.caption_id })} title={item.text}>{item.text}</button>)}</div></div></section>;
}
function TimelineDiffView({ diff }: { diff: TimelineDiff }) {
  return <div className="diff-groups"><section><h4>概览</h4><p>Clip {diff.summary.clip_changes} · Caption {diff.summary.caption_changes} · 锁定 {diff.summary.lock_changes} · 时长 {formatTime(diff.duration_delta_us)}</p></section><section><h4>Clip</h4>{diff.clip_changes.length ? diff.clip_changes.map((item, index) => <p key={`${item.clip_id}-${item.type}-${index}`}>{item.type} · {item.clip_id}{item.created_clip_ids ? ` -> ${item.created_clip_ids.join(", ")}` : ""}</p>) : <p>无变化</p>}</section><section><h4>Caption</h4>{diff.caption_changes.length ? diff.caption_changes.map((item, index) => <p key={`${item.caption_id}-${item.type}-${index}`}>{item.type} · {item.caption_id}</p>) : <p>无变化</p>}</section><section><h4>锁定</h4>{diff.lock_changes.length ? diff.lock_changes.map((item, index) => <p key={`${item.clip_id}-${item.type}-${index}`}>{item.type} · {item.clip_id}</p>) : <p>无变化</p>}</section><section><h4>锁定 Clip 间接平移</h4>{diff.indirect_locked_timing_shifts.length ? diff.indirect_locked_timing_shifts.map(item => <p key={item.clip_id}>{item.clip_id} · {formatTime(item.from_start_us)}-{formatTime(item.from_end_us)} {"->"} {formatTime(item.to_start_us)}-{formatTime(item.to_end_us)}</p>) : <p>无变化</p>}</section></div>;
}
