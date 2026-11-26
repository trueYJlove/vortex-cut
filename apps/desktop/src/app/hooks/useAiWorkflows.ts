import { useMemo, useRef, useState } from "react";
import type React from "react";
import type {
  BriefInput,
  EgressPreview,
  Job,
  Project,
  ProviderConfig,
  TimelineDiff,
  TimelineDocument,
  TimelinePatchEgressPreview,
  TimelinePatchProposal,
  TimelineRevisionSummary,
  TimelineState,
} from "@aivideo/contracts";
import type { NoticeTone } from "../appHelpers.js";
import { safeErrorMessage } from "../safeErrors.js";

export interface UseAiWorkflowsParams {
  project: Project | undefined;
  projectRef: React.MutableRefObject<Project | undefined>;
  projectDataEpochRef: React.MutableRefObject<number>;
  timeline: TimelineState | undefined;
  setTimeline: React.Dispatch<React.SetStateAction<TimelineState | undefined>>;
  setWorking: React.Dispatch<React.SetStateAction<TimelineDocument | undefined>>;
  acceptState: (next: TimelineState) => void;
  loadProjectData: (selected: Project) => Promise<void>;
  loadRenderData: (selected: Project) => Promise<void>;
  trackRenderJob: (job: Job) => void;
  showNotice: (text: string, tone?: NoticeTone) => void;
}

/** 管理 AI 粗剪、AI 时间线修改与 Revision 版本比较三个多步流程的状态与异步订阅。 */
export function useAiWorkflows({
  project,
  projectRef,
  projectDataEpochRef,
  timeline,
  setTimeline,
  setWorking,
  acceptState,
  loadProjectData,
  loadRenderData,
  trackRenderJob,
  showNotice,
}: UseAiWorkflowsParams) {
  const [aiOpen, setAiOpen] = useState(false);
  const [aiStep, setAiStep] = useState<"form" | "confirm" | "running" | "candidates">("form");
  // 外发确认勾选：不可逆动作前的显式确认，防误点。仅前端状态，不改 IPC 契约。
  const [aiEgressConfirmed, setAiEgressConfirmed] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiProviders, setAiProviders] = useState<ProviderConfig[]>([]);
  const [aiRecipes, setAiRecipes] = useState<Array<{ recipe_id: string; name?: string; display_name?: string; summary: string }>>([]);
  const [aiPreview, setAiPreview] = useState<EgressPreview>();
  const [aiCandidates, setAiCandidates] = useState<Array<Record<string, unknown>>>([]);
  const [aiJob, setAiJob] = useState<Job>();
  const [aiCapabilityTesting, setAiCapabilityTesting] = useState(false);
  const [aiPlayback, setAiPlayback] = useState<{ media_url: string; source_start_us: number; source_end_us: number }>();
  const [aiForm, setAiForm] = useState({
    topic: "",
    audience: "",
    narrative_goal: "",
    style_notes: "",
    provider_id: "",
    recipe_id: "",
    transcript_id: "",
    candidate_source: "auto" as "auto" | "transcript" | "cv" | "fused",
  });
  const aiRunRef = useRef<{ generation: number; stop?: () => void; timer?: ReturnType<typeof setTimeout> }>({ generation: 0 });

  const [patchOpen, setPatchOpen] = useState(false);
  const [patchStep, setPatchStep] = useState<"form" | "confirm" | "running" | "proposal">("form");
  const [patchEgressConfirmed, setPatchEgressConfirmed] = useState(false);
  const [patchInstruction, setPatchInstruction] = useState("");
  const [patchProviderId, setPatchProviderId] = useState("");
  const [patchProviders, setPatchProviders] = useState<ProviderConfig[]>([]);
  const [patchPreview, setPatchPreview] = useState<TimelinePatchEgressPreview>();
  const [patchProposal, setPatchProposal] = useState<TimelinePatchProposal>();
  const [patchJob, setPatchJob] = useState<Job>();
  const [patchError, setPatchError] = useState("");
  const [patchCapabilityTesting, setPatchCapabilityTesting] = useState(false);

  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisions, setRevisions] = useState<TimelineRevisionSummary[]>([]);
  const [revisionPair, setRevisionPair] = useState({ base: "", target: "" });
  const [revisionDiff, setRevisionDiff] = useState<TimelineDiff>();

  const resetAiOnProjectSwitch = () => {
    aiRunRef.current.generation += 1;
    aiRunRef.current.stop?.();
    if (aiRunRef.current.timer) clearTimeout(aiRunRef.current.timer);
    aiRunRef.current.stop = undefined;
    aiRunRef.current.timer = undefined;
    setAiOpen(false);
    setAiStep("form");
    setAiError("");
    setAiPreview(undefined);
    setAiCandidates([]);
    setAiJob(undefined);
    setAiPlayback(undefined);
  };

  const openAi = async () => {
    if (!project || !window.desktop.listProviders || !window.desktop.listRecipes) return;
    setAiError("");
    setAiOpen(true);
    setAiStep("form");
    try {
      const [providers, recipes] = await Promise.all([window.desktop.listProviders(), window.desktop.listRecipes()]);
      if (!Array.isArray(recipes.items)) throw new Error("Recipe 响应无效");
      setAiProviders(providers.items);
      setAiRecipes(recipes.items);
      await loadProjectData(project);
      const current = await window.desktop.getBrief?.(project.project_id).catch(() => undefined);
      if (current) {
        setAiForm(value => ({
          ...value,
          topic: current.topic,
          audience: current.audience,
          narrative_goal: current.narrative_goal,
          style_notes: current.style_notes,
        }));
      }
    } catch {
      setAiError("无法加载 AI 粗剪配置。");
    }
  };

  const prepareAi = async () => {
    if (!project || !window.desktop.putBrief || !window.desktop.preparePlanning) return;
    const provider = aiProviders.find(item => item.provider_config_id === aiForm.provider_id);
    if (!provider || !provider.enabled || provider.credential_status !== "configured" || provider.candidate_capability_status !== "supported") return;
    const brief: BriefInput = {
      schema_version: 1,
      topic: aiForm.topic,
      audience: aiForm.audience,
      target_platform: "generic_vertical",
      target_duration_us: 30_000_000,
      narrative_goal: aiForm.narrative_goal,
      style_notes: aiForm.style_notes,
      must_keep: [],
      forbidden: [],
      original_audio_policy: "preserve",
      caption_policy: "auto_from_transcript",
      caption_preset_id: "default-bottom",
      default_layout: "fit",
    };
    try {
      setAiError("");
      await window.desktop.putBrief({ project_id: project.project_id, brief });
      const preview = await window.desktop.preparePlanning({
        project_id: project.project_id,
        provider_config_id: aiForm.provider_id,
        recipe_id: aiForm.recipe_id,
        transcript_ids: [aiForm.transcript_id],
        candidate_source: aiForm.candidate_source,
      });
      setAiPreview(preview);
      setAiStep("confirm");
    } catch (error) {
      setAiError(safeErrorMessage(error, "准备失败。请检查 Brief、Provider 凭据及就绪转录后重试。"));
    }
  };

  const createAi = async () => {
    if (!project || !aiPreview || !window.desktop.createPlanning) return;
    const projectId = project.project_id;
    const epoch = projectDataEpochRef.current;
    const generation = ++aiRunRef.current.generation;
    aiRunRef.current.stop?.();
    if (aiRunRef.current.timer) clearTimeout(aiRunRef.current.timer);
    const current = () =>
      projectRef.current?.project_id === projectId &&
      projectDataEpochRef.current === epoch &&
      aiRunRef.current.generation === generation;
    try {
      setAiStep("running");
      const result = await window.desktop.createPlanning({
        project_id: projectId,
        egress_preview_id: aiPreview.egress_preview_id,
        payload_sha256: aiPreview.payload_sha256,
      });
      if (!current()) return;
      setAiJob(result.job);
      trackRenderJob(result.job);
      const stop = window.desktop.subscribeJob(result.job.job_id, job => {
        if (!current()) {
          stop();
          return;
        }
        setAiJob(job);
        if (["failed", "cancelled", "interrupted"].includes(job.status)) {
          stop();
          setAiPreview(undefined);
          setAiStep("form");
          setAiError("生成未完成。请重新准备外传内容并再次确认。");
        }
      });
      aiRunRef.current.stop = stop;
      const poll = async (): Promise<void> => {
        if (!current()) return;
        const items = await window.desktop.listCandidatePlans?.(projectId);
        if (!current()) return;
        if (items?.items.length) {
          stop();
          aiRunRef.current.stop = undefined;
          setAiCandidates(items.items as unknown as Array<Record<string, unknown>>);
          setAiStep("candidates");
        } else {
          aiRunRef.current.timer = setTimeout(() => void poll(), 1500);
        }
      };
      void poll();
    } catch {
      if (!current()) return;
      setAiPreview(undefined);
      setAiError("调用失败；重试前必须重新准备并确认外传内容。");
      setAiStep("form");
    }
  };

  const testCandidateProviderCapability = async (providerId: string) => {
    if (!providerId) return;
    try {
      setAiCapabilityTesting(true);
      setAiError("");
      const result = await window.desktop.testCandidateProviderCapability(providerId);
      setAiProviders(current => current.map(item => item.provider_config_id === providerId ? { ...item, ...result } : item));
      setAiError(result.candidate_capability_status === "supported" ? "AI 粗剪可用。" : "当前 Provider 不支持 AI 粗剪。");
    } catch {
      setAiError("AI 粗剪兼容性测试失败；未显示 Provider 响应内容。");
    } finally {
      setAiCapabilityTesting(false);
    }
  };

  const playAiClip = async (candidateOrClip: Record<string, unknown>, selectedClip?: Record<string, unknown>) => {
    if (!project || !window.desktop.getCandidateClipMedia) return;
    const clip = selectedClip ?? candidateOrClip;
    const candidate = selectedClip
      ? candidateOrClip
      : aiCandidates.find(item => Array.isArray(item.clips) && (item.clips as Array<Record<string, unknown>>).some(item => item.clip_id === clip.clip_id));
    if (!candidate) {
      setAiError("候选片段当前不可播放。");
      return;
    }
    try {
      setAiPlayback(
        await window.desktop.getCandidateClipMedia({
          project_id: project.project_id,
          candidate_plan_id: String(candidate.candidate_plan_id),
          candidate_clip_id: String(clip.clip_id),
        }),
      );
    } catch {
      setAiError("候选片段当前不可播放。");
    }
  };

  const adoptAi = async (candidate: Record<string, unknown>) => {
    if (!project || !window.desktop.adoptCandidatePlan) return;
    try {
      const state = await window.desktop.adoptCandidatePlan({
        project_id: project.project_id,
        candidate_plan_id: String(candidate.candidate_plan_id),
        adoption: {
          schema_version: 1,
          candidate_document_sha256: String(candidate.document_sha256),
          base_revision_id: timeline?.current_revision.timeline_revision_id ?? null,
        },
      });
      setTimeline(state);
      setWorking(state.current_revision.document);
      setAiOpen(false);
      showNotice("候选已采用为正式时间线；可使用撤销恢复。", "success");
    } catch {
      setAiError("采用冲突：请先处理当前草稿或刷新 Timeline 后重试。");
    }
  };

  const clearPatchFlow = () => {
    setPatchInstruction("");
    setPatchPreview(undefined);
    setPatchProposal(undefined);
    setPatchJob(undefined);
    setPatchError("");
    setPatchStep("form");
  };

  const closePatch = () => {
    setPatchOpen(false);
    clearPatchFlow();
  };

  const openPatch = async () => {
    if (!project || !timeline) return;
    clearPatchFlow();
    setPatchOpen(true);
    try {
      const response = await window.desktop.listProviders?.();
      const available = (response?.items ?? []).filter(item => item.enabled && item.credential_status === "configured");
      setPatchProviders(available);
      const supported = available.filter(item => item.timeline_patch_capability_status === "supported");
      setPatchProviderId(current => (supported.some(item => item.provider_config_id === current) ? current : supported[0]?.provider_config_id ?? ""));
    } catch {
      setPatchError("无法加载可用 Provider。");
    }
  };

  const preparePatch = async () => {
    if (!project || !timeline || !patchProviderId || !patchInstruction.trim()) return;
    try {
      setPatchError("");
      const preview = await window.desktop.prepareTimelinePatch({
        project_id: project.project_id,
        base_revision_id: timeline.current_revision.timeline_revision_id,
        provider_config_id: patchProviderId,
        instruction: patchInstruction,
      });
      setPatchPreview(preview);
      setPatchStep("confirm");
    } catch (error) {
      setPatchPreview(undefined);
      setPatchError(safeErrorMessage(error, "准备失败。请刷新 Timeline 并重新输入指令。"));
    }
  };

  const testPatchProviderCapability = async (providerId: string) => {
    if (!providerId || !window.desktop.testTimelinePatchProviderCapability) return;
    try {
      setPatchCapabilityTesting(true);
      setPatchError("");
      const result = await window.desktop.testTimelinePatchProviderCapability(providerId);
      setPatchProviders(current => current.map(item => item.provider_config_id === providerId ? { ...item, ...result } : item));
      if (result.timeline_patch_capability_status === "supported") setPatchError("AI 修改可用。");
      else setPatchError("当前 Provider 不支持 AI 修改。");
    } catch {
      setPatchError("AI 修改兼容性测试失败；未显示 Provider 响应内容。");
    } finally {
      setPatchCapabilityTesting(false);
    }
  };

  const createPatch = async () => {
    if (!project || !patchPreview) return;
    try {
      const result = await window.desktop.createTimelinePatchGeneration({
        project_id: project.project_id,
        timeline_patch_egress_preview_id: patchPreview.timeline_patch_egress_preview_id,
        payload_sha256: patchPreview.payload_sha256,
      });
      setPatchPreview(undefined);
      setPatchJob(result.job);
      setPatchStep("running");
      const stop = window.desktop.subscribeJob(result.job.job_id, job => {
        setPatchJob(job);
        if (["failed", "cancelled", "interrupted"].includes(job.status)) {
          stop();
          setPatchInstruction("");
          setPatchStep("form");
          setPatchError("生成未完成。旧确认已失效，请重新输入并准备。");
        }
        if (job.status === "succeeded") {
          void window.desktop
            .listTimelinePatchProposals(project.project_id)
            .then(page => {
              const proposal = page.items.find(item => item.timeline_patch_generation_id === result.timeline_patch_generation_id);
              if (!proposal) throw new Error("proposal missing");
              stop();
              setPatchInstruction("");
              setPatchProposal(proposal);
              setPatchStep("proposal");
            })
            .catch(() => {
              stop();
              setPatchInstruction("");
              setPatchStep("form");
              setPatchError("提案读取失败，请从项目提案列表重试。");
            });
        }
      });
    } catch {
      setPatchPreview(undefined);
      setPatchInstruction("");
      setPatchStep("form");
      setPatchError("调用失败。必须重新输入指令并准备新的确认。");
    }
  };

  const cancelPatch = async () => {
    if (!patchJob) return;
    try {
      setPatchJob(await window.desktop.cancelJob(patchJob.job_id));
      setPatchInstruction("");
      setPatchPreview(undefined);
      setPatchStep("form");
      setPatchError("已请求取消。再次生成必须重新输入并准备。");
    } catch {
      setPatchError("取消请求失败，请等待任务状态更新。");
    }
  };

  const applyPatchProposal = async () => {
    if (!project || !patchProposal) return;
    try {
      const next = await window.desktop.applyTimelinePatchProposal({
        project_id: project.project_id,
        proposal_id: patchProposal.timeline_patch_proposal_id,
        base_revision_id: patchProposal.base_revision_id,
        proposed_document_sha256: patchProposal.proposed_document_sha256,
      });
      acceptState(next);
      closePatch();
      await loadRenderData(project);
      showNotice("AI 修改已应用为新的正式 Revision；旧权威预览已过期。", "success");
    } catch {
      setPatchError("应用冲突。请刷新 Timeline 后重新生成提案。");
    }
  };

  const openRevisionCompare = async () => {
    if (!project) return;
    setRevisionDiff(undefined);
    setRevisionOpen(true);
    try {
      const page = await window.desktop.listTimelineRevisions({ project_id: project.project_id, limit: 100 });
      setRevisions(page.items);
      setRevisionPair({
        base: page.items[1]?.timeline_revision_id ?? page.items[0]?.timeline_revision_id ?? "",
        target: page.items[0]?.timeline_revision_id ?? "",
      });
    } catch {
      showNotice("无法加载 Revision 历史。");
    }
  };

  const compareRevisions = async () => {
    if (!project || !revisionPair.base || !revisionPair.target) return;
    try {
      setRevisionDiff(
        await window.desktop.compareTimelineRevisions({
          project_id: project.project_id,
          base_revision_id: revisionPair.base as never,
          target_revision_id: revisionPair.target as never,
        }),
      );
    } catch {
      showNotice("Revision 比较失败。");
    }
  };

  const mergedProviders = useMemo(
    () => [
      ...aiProviders,
      ...patchProviders.filter(item => !aiProviders.some(provider => provider.provider_config_id === item.provider_config_id)),
    ],
    [aiProviders, patchProviders],
  );

  return {
    aiOpen,
    setAiOpen,
    aiStep,
    setAiStep,
    aiEgressConfirmed,
    setAiEgressConfirmed,
    aiError,
    setAiError,
    aiProviders,
    setAiProviders,
    aiRecipes,
    aiPreview,
    setAiPreview,
    aiCandidates,
    setAiCandidates,
    aiJob,
    setAiJob,
    aiCapabilityTesting,
    aiPlayback,
    setAiPlayback,
    aiForm,
    setAiForm,
    patchOpen,
    patchStep,
    setPatchStep,
    patchEgressConfirmed,
    setPatchEgressConfirmed,
    patchInstruction,
    patchProviderId,
    setPatchProviderId,
    patchProviders,
    patchPreview,
    setPatchPreview,
    patchProposal,
    patchJob,
    patchError,
    patchCapabilityTesting,
    setPatchInstruction,
    revisionOpen,
    setRevisionOpen,
    revisions,
    revisionPair,
    setRevisionPair,
    revisionDiff,
    setRevisionDiff,
    mergedProviders,
    resetAiOnProjectSwitch,
    openAi,
    prepareAi,
    createAi,
    testCandidateProviderCapability,
    playAiClip,
    adoptAi,
    closePatch,
    openPatch,
    preparePatch,
    testPatchProviderCapability,
    createPatch,
    cancelPatch,
    applyPatchProposal,
    openRevisionCompare,
    compareRevisions,
  };
}
