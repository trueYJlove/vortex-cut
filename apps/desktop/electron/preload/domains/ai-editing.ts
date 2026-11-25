import { ipcRenderer } from "electron";
import type {
  AgentSession,
  AgentSessionCreateResponse,
  AgentSessionEgressPreview,
  AngleGroup,
  AngleGroupCreateInput,
  AngleGroupId,
  AngleSyncResponse,
  AssetFrameTagsSummary,
  AssetId,
  BeatAnalysisSummary,
  Brief,
  BriefInput,
  CandidatePlan,
  CaptionsProviderCreateResponse,
  CaptionsProviderEgressPreview,
  CaptionsProviderGeneration,
  CaptionsProviderProposal,
  CvAnalysisSummary,
  CvSamplesPage,
  EditingGrammarPrepareResult,
  EditingGrammarProposal,
  EditingGrammarProposalListItem,
  EditingGrammarTool,
  EgressPreview,
  FrameTagFilterResponse,
  Job,
  KeyframeEgressCreateResponse,
  KeyframeEgressPreview,
  KeyframeGenerationStatus,
  ProjectId,
  ProviderCapabilityTestResult,
  ProviderConfig,
  Recipe,
  SemanticIndexSummary,
  SemanticSearchResponse,
  TimelineDiff,
  TimelinePatchCapabilityTestResponse,
  TimelinePatchEgressPreview,
  TimelinePatchGeneration,
  TimelinePatchGenerationCreateResponse,
  TimelinePatchProposal,
  TimelineRevisionId,
  TimelineState,
  TranscriptId,
  Worklist,
} from "@aivideo/contracts";

export interface AiEditingPreloadApi {
  getBrief?: (projectId: ProjectId) => Promise<Brief>;
  putBrief?: (input: { project_id: ProjectId; brief: BriefInput }) => Promise<Brief>;
  listRecipes?: () => Promise<{ items: Recipe[] }>;
  listProviders?: () => Promise<{ items: ProviderConfig[] }>;
  createProvider?: (input: Record<string, unknown>) => Promise<ProviderConfig>;
  setProviderSecret?: (input: { provider_config_id: string; secret: string }) => Promise<{ provider_config_id: string; credential_status: "configured" }>;
  deleteProviderSecret?: (providerId: string) => Promise<{ provider_config_id: string; credential_status: "missing" }>;
  /** 更新 Provider 配置（含 enabled 停用/启用）。Core 只接受非空字段。 */
  updateProvider?: (input: { provider_config_id: string; patch: { display_name?: string; base_url?: string; model?: string; enabled?: boolean } }) => Promise<ProviderConfig>;
  /** 删除 Provider 配置；被外发/生成历史引用时由 Core 拒绝（PROVIDER_IN_USE）。 */
  deleteProvider?: (providerId: string) => Promise<{ provider_config_id: string; deleted: boolean }>;
  testProvider?: (providerId: string) => Promise<{ ok?: boolean; message?: string }>;
  testCandidateProviderCapability: (providerId: string) => Promise<ProviderCapabilityTestResult>;
  preparePlanning?: (input: { project_id: ProjectId; provider_config_id: string; recipe_id: string; transcript_ids: string[]; candidate_source?: "auto" | "transcript" | "cv" | "fused" }) => Promise<EgressPreview>;
  createPlanning?: (input: { project_id: ProjectId; egress_preview_id: string; payload_sha256: string }) => Promise<{ job: Job }>;
  listCandidatePlans?: (projectId: ProjectId) => Promise<{ items: CandidatePlan[] }>;
  getCandidateClipMedia?: (input: { project_id: ProjectId; candidate_plan_id: string; candidate_clip_id: string }) => Promise<{ media_url: string; source_start_us: number; source_end_us: number }>;
  adoptCandidatePlan?: (input: { project_id: ProjectId; candidate_plan_id: string; adoption: { schema_version: 1; candidate_document_sha256: string; base_revision_id: TimelineRevisionId | null } }) => Promise<TimelineState>;
  prepareTimelinePatch: (input: { project_id: ProjectId; base_revision_id: TimelineRevisionId; provider_config_id: string; instruction: string }) => Promise<TimelinePatchEgressPreview>;
  testTimelinePatchProviderCapability: (providerId: string) => Promise<TimelinePatchCapabilityTestResponse>;
  createTimelinePatchGeneration: (input: { project_id: ProjectId; timeline_patch_egress_preview_id: string; payload_sha256: string }) => Promise<TimelinePatchGenerationCreateResponse>;
  getTimelinePatchGeneration: (generationId: string) => Promise<TimelinePatchGeneration>;
  testCaptionsProviderCapability?: (providerId: string) => Promise<Record<string, unknown>>;
  prepareCaptionsProvider?: (input: { project_id: ProjectId; base_revision_id: TimelineRevisionId; provider_config_id: string; transcript_id: TranscriptId; segment_ids: string[]; language?: string | null; preset_id: string; max_chars_per_caption: number }) => Promise<CaptionsProviderEgressPreview>;
  createCaptionsProvider?: (input: { project_id: ProjectId; captions_provider_egress_preview_id: string; payload_sha256: string }) => Promise<CaptionsProviderCreateResponse>;
  getCaptionsProviderGeneration?: (input: { project_id: ProjectId; generation_id: string }) => Promise<CaptionsProviderGeneration>;
  applyCaptionsProviderProposal?: (input: { project_id: ProjectId; proposal_id: string; base_revision_id: TimelineRevisionId; proposed_document_sha256: string }) => Promise<TimelineState>;
  getCaptionsProviderProposal?: (input: { project_id: ProjectId; proposal_id: string }) => Promise<CaptionsProviderProposal>;
  createCaptionsProviderProposal?: (input: { project_id: ProjectId; generation_id: string }) => Promise<CaptionsProviderProposal>;
  listTimelinePatchProposals: (projectId: ProjectId) => Promise<{ items: TimelinePatchProposal[] }>;
  getTimelinePatchProposal: (proposalId: string) => Promise<TimelinePatchProposal>;
  applyTimelinePatchProposal: (input: { project_id: ProjectId; proposal_id: string; base_revision_id: TimelineRevisionId; proposed_document_sha256: string }) => Promise<TimelineState>;
  compareTimelineRevisions: (input: { project_id: ProjectId; base_revision_id: TimelineRevisionId; target_revision_id: TimelineRevisionId }) => Promise<TimelineDiff>;
  // AI-1 内置多步 agent 会话 + AI-2 素材 CV 信号分析
  prepareAgentSession: (input: { project_id: ProjectId; base_revision_id: TimelineRevisionId; provider_config_id: string; instruction: string }) => Promise<AgentSessionEgressPreview>;
  createAgentSession: (input: { project_id: ProjectId; agent_session_egress_preview_id: string; payload_sha256: string }) => Promise<AgentSessionCreateResponse>;
  listAgentSessions: (projectId: ProjectId) => Promise<{ items: AgentSession[] }>;
  getAgentSession: (sessionId: string) => Promise<AgentSession>;
  getCvAnalysis: (input: { project_id: ProjectId; asset_id: string; generate: boolean; target_gap_us?: number | null; budget_per_minute_s?: number | null }) => Promise<CvAnalysisSummary>;
  listCvSamples: (input: { project_id: ProjectId; asset_id: string }) => Promise<CvSamplesPage>;
  /** Wave1 L2：BGM 节拍网格摘要（generate=true 登记分析作业；卡点面板消费）。 */
  getBeatAnalysis: (input: { project_id: ProjectId; asset_id: string; generate: boolean }) => Promise<BeatAnalysisSummary>;
  /** W2.1 机位同步：机位组（只产元数据；同步作业登记与人工偏移）。 */
  listAngleGroups: (projectId: ProjectId) => Promise<{ items: AngleGroup[] }>;
  createAngleGroup: (input: AngleGroupCreateInput & { project_id: ProjectId }) => Promise<AngleGroup>;
  getAngleGroup: (input: { project_id: ProjectId; group_id: AngleGroupId }) => Promise<AngleGroup>;
  syncAngleGroup: (input: { project_id: ProjectId; group_id: AngleGroupId; generate: boolean }) => Promise<AngleSyncResponse>;
  setAngleOffset: (input: { project_id: ProjectId; group_id: AngleGroupId; asset_id: string; offset_us: number }) => Promise<AngleGroup>;
  deleteAngleGroup: (input: { project_id: ProjectId; group_id: AngleGroupId }) => Promise<{ group_id: AngleGroupId; deleted: boolean }>;
  indexSemanticAsset: (input: { project_id: ProjectId; asset_id: AssetId; generate: boolean }) => Promise<SemanticIndexSummary>;
  searchSemantic: (input: { project_id: ProjectId; query: string; limit?: number }) => Promise<SemanticSearchResponse>;
  prepareKeyframePreview: (input: { project_id: ProjectId; asset_id: AssetId; provider_config_id: string }) => Promise<KeyframeEgressPreview>;
  excludeKeyframeFrames: (input: { project_id: ProjectId; preview_id: string; frame_indices: number[] }) => Promise<KeyframeEgressPreview>;
  createKeyframeGeneration: (input: { project_id: ProjectId; preview_id: string; payload_sha256: string }) => Promise<KeyframeEgressCreateResponse>;
  getKeyframeGeneration: (input: { project_id: ProjectId; generation_id: string }) => Promise<KeyframeGenerationStatus>;
  getFrameTags: (input: { project_id: ProjectId; asset_id: AssetId; label?: string }) => Promise<AssetFrameTagsSummary>;
  filterFramesByLabel: (input: { project_id: ProjectId; label: string; limit?: number }) => Promise<FrameTagFilterResponse>;
  // W1.1 剪辑语法层（零 egress）
  listEditingGrammarPlanners: (projectId: ProjectId) => Promise<{ items: EditingGrammarTool[] }>;
  prepareEditingGrammar: (input: { project_id: ProjectId; base_revision_id: TimelineRevisionId; planner: string; params: Record<string, unknown> }) => Promise<EditingGrammarPrepareResult>;
  proposeEditingGrammar: (input: { project_id: ProjectId; base_revision_id: TimelineRevisionId; planner: string; params: Record<string, unknown> }) => Promise<EditingGrammarProposal>;
  listEditingGrammarProposals: (projectId: ProjectId) => Promise<{ items: EditingGrammarProposalListItem[] }>;
  getEditingGrammarProposal: (input: { project_id: ProjectId; proposal_id: string }) => Promise<EditingGrammarProposal>;
  applyEditingGrammarProposal: (input: { project_id: ProjectId; proposal_id: string; base_revision_id: TimelineRevisionId; proposed_document_sha256: string }) => Promise<TimelineState>;
  listWorklists?: (projectId: ProjectId) => Promise<{ items: Worklist[] }>;
  prepareWorklist?: (input: { project_id: ProjectId; base_revision_id: TimelineRevisionId; steps: Array<{ kind: string; planner: string; params: Record<string, unknown> }>; max_steps: number; token_budget: number }) => Promise<Worklist>;
  createWorklist?: (input: { project_id: ProjectId; worklist_id: string; base_revision_id: TimelineRevisionId }) => Promise<Worklist>;
  cancelWorklist?: (input: { project_id: ProjectId; worklist_id: string }) => Promise<Worklist>;
  applyWorklistStep?: (input: { project_id: ProjectId; worklist_id: string; step_id: string; base_revision_id: TimelineRevisionId; proposed_document_sha256: string }) => Promise<Worklist>;
}

export function createAiEditingPreloadApi(): AiEditingPreloadApi {
  return {
    getBrief: projectId => ipcRenderer.invoke("brief:get", projectId),
    putBrief: input => ipcRenderer.invoke("brief:put", input),
    listRecipes: () => ipcRenderer.invoke("recipe:list"),
    listProviders: () => ipcRenderer.invoke("provider:list"),
    createProvider: input => ipcRenderer.invoke("provider:create", input),
    setProviderSecret: input => ipcRenderer.invoke("provider:set-secret", input),
    deleteProviderSecret: providerId => ipcRenderer.invoke("provider:delete-secret", providerId),
    updateProvider: input => ipcRenderer.invoke("provider:update", input),
    deleteProvider: providerId => ipcRenderer.invoke("provider:delete", providerId),
    testProvider: providerId => ipcRenderer.invoke("provider:test", providerId),
    testCandidateProviderCapability: providerId => ipcRenderer.invoke("planning:test-provider-capability", providerId),
    preparePlanning: input => ipcRenderer.invoke("planning:prepare", input),
    createPlanning: input => ipcRenderer.invoke("planning:create", input),
    listCandidatePlans: projectId => ipcRenderer.invoke("planning:list", projectId),
    getCandidateClipMedia: input => ipcRenderer.invoke("planning:clip-media", input),
    adoptCandidatePlan: input => ipcRenderer.invoke("planning:adopt", input),
    prepareTimelinePatch: input => ipcRenderer.invoke("planning-patch:prepare", input),
    testCaptionsProviderCapability: providerId => ipcRenderer.invoke("captions-provider:test-capability", providerId),
    prepareCaptionsProvider: input => ipcRenderer.invoke("captions-provider:prepare", input),
    createCaptionsProvider: input => ipcRenderer.invoke("captions-provider:create", input),
    getCaptionsProviderGeneration: input => ipcRenderer.invoke("captions-provider:get", input),
    applyCaptionsProviderProposal: input => ipcRenderer.invoke("captions-provider:proposal-apply", input),
    getCaptionsProviderProposal: input => ipcRenderer.invoke("captions-provider:proposal-get", input),
    createCaptionsProviderProposal: input => ipcRenderer.invoke("captions-provider:proposal-from-generation", input),
    testTimelinePatchProviderCapability: providerId => ipcRenderer.invoke("planning-patch:test-provider-capability", providerId),
    createTimelinePatchGeneration: input => ipcRenderer.invoke("planning-patch:create", input),
    getTimelinePatchGeneration: generationId => ipcRenderer.invoke("planning-patch:generation-get", generationId),
    listTimelinePatchProposals: projectId => ipcRenderer.invoke("planning-patch:proposal-list", projectId),
    getTimelinePatchProposal: proposalId => ipcRenderer.invoke("planning-patch:proposal-get", proposalId),
    applyTimelinePatchProposal: input => ipcRenderer.invoke("planning-patch:proposal-apply", input),
    compareTimelineRevisions: input => ipcRenderer.invoke("timeline:revision-diff", input),
    prepareAgentSession: input => ipcRenderer.invoke("agent-session:prepare", input),
    createAgentSession: input => ipcRenderer.invoke("agent-session:create", input),
    listAgentSessions: projectId => ipcRenderer.invoke("agent-session:list", projectId),
    getAgentSession: sessionId => ipcRenderer.invoke("agent-session:get", sessionId),
    getCvAnalysis: input => ipcRenderer.invoke("cv-analysis:get", input),
    listCvSamples: input => ipcRenderer.invoke("cv-samples:list", input),
    getBeatAnalysis: input => ipcRenderer.invoke("beat-analysis:get", input),
    listAngleGroups: projectId => ipcRenderer.invoke("angle-sync:groups", projectId),
    createAngleGroup: input => ipcRenderer.invoke("angle-sync:create", input),
    getAngleGroup: input => ipcRenderer.invoke("angle-sync:get", input),
    syncAngleGroup: input => ipcRenderer.invoke("angle-sync:sync", input),
    setAngleOffset: input => ipcRenderer.invoke("angle-sync:offset", input),
    deleteAngleGroup: input => ipcRenderer.invoke("angle-sync:delete", input),
    indexSemanticAsset: input => ipcRenderer.invoke("semantic:index", input),
    searchSemantic: input => ipcRenderer.invoke("semantic:search", input),
    prepareKeyframePreview: input => ipcRenderer.invoke("keyframe:preview", input),
    excludeKeyframeFrames: input => ipcRenderer.invoke("keyframe:exclude", input),
    createKeyframeGeneration: input => ipcRenderer.invoke("keyframe:create", input),
    getKeyframeGeneration: input => ipcRenderer.invoke("keyframe:generation", input),
    getFrameTags: input => ipcRenderer.invoke("keyframe:frame-tags", input),
    filterFramesByLabel: input => ipcRenderer.invoke("keyframe:filter-by-label", input),
    listEditingGrammarPlanners: projectId => ipcRenderer.invoke("editing-grammar:planners", projectId),
    prepareEditingGrammar: input => ipcRenderer.invoke("editing-grammar:prepare", input),
    listWorklists: projectId => ipcRenderer.invoke("worklist:list", projectId),
    prepareWorklist: input => ipcRenderer.invoke("worklist:prepare", input),
    createWorklist: input => ipcRenderer.invoke("worklist:create", input),
    cancelWorklist: input => ipcRenderer.invoke("worklist:cancel", input),
    applyWorklistStep: input => ipcRenderer.invoke("worklist:apply", input),
    proposeEditingGrammar: input => ipcRenderer.invoke("editing-grammar:propose", input),
    listEditingGrammarProposals: projectId => ipcRenderer.invoke("editing-grammar:proposal-list", projectId),
    getEditingGrammarProposal: input => ipcRenderer.invoke("editing-grammar:proposal-get", input),
    applyEditingGrammarProposal: input => ipcRenderer.invoke("editing-grammar:proposal-apply", input),
  };
}
