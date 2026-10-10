import {
  parseTimelineDiff,
  parseTimelinePatchEgressPreview,
  parseTimelinePatchGeneration,
  parseTimelinePatchGenerationCreateResponse,
  parseTimelinePatchProposal,
  parseTimelinePatchCapabilityTestResponse,
  parseTimelineState,
  parseAgentSessionEgressPreview,
  parseAgentSessionCreateResponse,
  parseAgentSession,
  parseCvAnalysisSummary,
  parseCvSamplesPage,
  parseBeatAnalysisSummary,
  parseEditingGrammarTool,
  parseEditingGrammarPrepareResult,
  parseEditingGrammarProposal,
  parseEditingGrammarProposalListItem,
  parseWorklist,
  parseCaptionsProviderEgressPreview,
  parseCaptionsProviderGeneration,
  parseCaptionsProviderCreateResponse,
  parseCaptionsProviderProposal,
  parseAngleGroup,
  parseAngleSyncResponse
} from "@aivideo/contracts";

type RequestInitLike = { method?: string; body?: string };
type IpcHandle = (channel: string, listener: (_event: unknown, input?: unknown) => Promise<unknown> | unknown) => void;

export interface Stage2bIpcDependencies {
  handle: IpcHandle;
  fetchWithUi: <T = unknown>(path: string, init?: RequestInitLike) => Promise<T>;
}

const API_PREFIX = "/api/v1";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const rendererSensitiveKeys = new Set([
  "path", "uri", "root_dir", "database", "database_path", "admin_token", "ui_token", "token", "authorization",
  "installed_path", "install_dir", "source_file", "model_path", "model_dir", "runtime_dir", "ready_file",
  "api_key", "secret", "prompt", "raw_response", "instruction", "payload", "http_body", "request_body", "system_message"
]);

export function stage2bRendererSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stage2bRendererSafe);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (!rendererSensitiveKeys.has(key.toLowerCase())) result[key] = stage2bRendererSafe(item);
  return result;
}

/**
 * agent-session DTO 允许 `instruction`：会话指令是用户本地输入的原样回显
 * （Core get_session 如实返回），不是 provider 生成内容——其余敏感键照旧
 * 裁剪，provider 响应正文（error_json 展开后的 message 等）不受豁免。
 */
export function stage2bRendererSafeAllowInstruction(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stage2bRendererSafeAllowInstruction);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (lowered === "instruction" || !rendererSensitiveKeys.has(lowered)) result[key] = stage2bRendererSafeAllowInstruction(item);
  }
  return result;
}

function record(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))) throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}
function id(value: unknown, name: string): string { if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid ${name}`); return value; }
function sha256(value: unknown, name: string): string { if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`Invalid ${name}`); return value; }
function instruction(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || [...value].length > 4000 || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error("Invalid instruction");
  return value;
}
const CAPTION_PRESETS = new Set(["default-bottom", "game-safe-bottom", "high-contrast"]);
function captionSegmentIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2000) throw new Error("Invalid segment_ids");
  const seen = new Set<string>();
  for (const segmentId of value) {
    if (typeof segmentId !== "string" || !ID.test(segmentId) || seen.has(segmentId)) throw new Error("Invalid segment_ids");
    seen.add(segmentId);
  }
  return value;
}
function captionLanguage(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length < 1 || [...value].length > 32) throw new Error("Invalid language");
  return value;
}
function captionPreset(value: unknown): string {
  if (typeof value !== "string" || !CAPTION_PRESETS.has(value)) throw new Error("Invalid preset_id");
  return value;
}
function captionMaxChars(value: unknown): number {
  if (typeof value !== "number" || typeof value === "boolean" || !Number.isInteger(value) || value < 1 || value > 200) throw new Error("Invalid max_chars_per_caption");
  return value;
}
async function safeInvoke<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code === "TIMELINE_PATCH_PROVIDER_UNTESTED" || code === "TIMELINE_PATCH_PROVIDER_UNSUPPORTED") throw new Error(code);
    // fetchWithUi 已 redact，并把业务码写成 "[CODE] message"；该形态原样上抛
    // 供渲染端 errorCode() / FAILURE_LABELS 识别。其余异常（可能含路径）
    // 统一折叠，避免泄漏。
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("[")) throw new Error(message);
    throw new Error("Core request failed");
  }
}

export function registerStage2bIpc(deps: Stage2bIpcDependencies): void {
  const fetchSafe = <T = unknown>(path: string, init?: RequestInitLike) => safeInvoke(() => deps.fetchWithUi<T>(path, init));
  deps.handle("planning-patch:prepare", async (_event, input) => {
    const value = record(input, ["project_id", "base_revision_id", "provider_config_id", "instruction"], "timeline patch prepare");
    const response = await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/timeline-patch-generations/prepare`, { method: "POST", body: JSON.stringify({ base_revision_id: id(value.base_revision_id, "base_revision_id"), provider_config_id: id(value.provider_config_id, "provider_config_id"), instruction: instruction(value.instruction) }) });
    return parseTimelinePatchEgressPreview(stage2bRendererSafe(response));
  });
  deps.handle("planning-patch:test-provider-capability", async (_event, providerId) => {
    const response = await fetchSafe(`${API_PREFIX}/providers/${id(providerId, "provider_config_id")}/timeline-patch-capability-test`, { method: "POST" });
    return parseTimelinePatchCapabilityTestResponse(stage2bRendererSafe(response));
  });
  deps.handle("planning-patch:create", async (_event, input) => {
    const value = record(input, ["project_id", "timeline_patch_egress_preview_id", "payload_sha256"], "timeline patch create");
    const response = await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/timeline-patch-generations`, { method: "POST", body: JSON.stringify({ timeline_patch_egress_preview_id: id(value.timeline_patch_egress_preview_id, "timeline_patch_egress_preview_id"), payload_sha256: sha256(value.payload_sha256, "payload_sha256") }) });
    return parseTimelinePatchGenerationCreateResponse(stage2bRendererSafe(response));
  });
  deps.handle("planning-patch:generation-get", async (_event, generationId) => parseTimelinePatchGeneration(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/timeline-patch-generations/${id(generationId, "timeline_patch_generation_id")}`))));
  deps.handle("planning-patch:proposal-list", async (_event, projectId) => {
    const page = stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(projectId, "project_id")}/timeline-patch-proposals`)) as { items?: unknown[] };
    if (!Array.isArray(page.items)) throw new Error("Core request failed");
    return { items: page.items.map(parseTimelinePatchProposal) };
  });
  deps.handle("planning-patch:proposal-get", async (_event, proposalId) => parseTimelinePatchProposal(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/timeline-patch-proposals/${id(proposalId, "timeline_patch_proposal_id")}`))));
  deps.handle("planning-patch:proposal-apply", async (_event, input) => {
    const value = record(input, ["project_id", "proposal_id", "base_revision_id", "proposed_document_sha256"], "timeline patch proposal apply");
    return parseTimelineState(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/timeline-patch-proposals/${id(value.proposal_id, "timeline_patch_proposal_id")}/apply`, { method: "POST", body: JSON.stringify({ base_revision_id: id(value.base_revision_id, "base_revision_id"), proposed_document_sha256: sha256(value.proposed_document_sha256, "proposed_document_sha256") }) })));
  });
  deps.handle("captions-provider:test-capability", async (_event, providerId) => {
    return stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/providers/${id(providerId, "provider_config_id")}/captions-provider-capability-test`, { method: "POST" }));
  });
  deps.handle("captions-provider:prepare", async (_event, input) => {
    const value = record(input, ["project_id", "base_revision_id", "provider_config_id", "transcript_id", "segment_ids", "language", "preset_id", "max_chars_per_caption"], "captions provider prepare");
    const response = await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/captions-provider/prepare`, { method: "POST", body: JSON.stringify({ base_revision_id: id(value.base_revision_id, "base_revision_id"), provider_config_id: id(value.provider_config_id, "provider_config_id"), transcript_id: id(value.transcript_id, "transcript_id"), segment_ids: captionSegmentIds(value.segment_ids), language: captionLanguage(value.language), preset_id: captionPreset(value.preset_id), max_chars_per_caption: captionMaxChars(value.max_chars_per_caption) }) });
    return parseCaptionsProviderEgressPreview(stage2bRendererSafe(response));
  });
  deps.handle("captions-provider:create", async (_event, input) => {
    const value = record(input, ["project_id", "captions_provider_egress_preview_id", "payload_sha256"], "captions provider create");
    return parseCaptionsProviderCreateResponse(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/captions-provider`, { method: "POST", body: JSON.stringify({ captions_provider_egress_preview_id: id(value.captions_provider_egress_preview_id, "captions_provider_egress_preview_id"), payload_sha256: sha256(value.payload_sha256, "payload_sha256") }) })));
  });
  deps.handle("captions-provider:get", async (_event, input) => {
    const value = record(input, ["project_id", "generation_id"], "captions provider get");
    return parseCaptionsProviderGeneration(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/captions-provider-generations/${id(value.generation_id, "generation_id")}`)));
  });
  deps.handle("captions-provider:proposal-apply", async (_event, input) => {
    const value = record(input, ["project_id", "proposal_id", "base_revision_id", "proposed_document_sha256"], "captions provider proposal apply");
    return parseTimelineState(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/captions-provider-proposals/${id(value.proposal_id, "captions_provider_proposal_id")}/apply`, { method: "POST", body: JSON.stringify({ base_revision_id: id(value.base_revision_id, "base_revision_id"), proposed_document_sha256: sha256(value.proposed_document_sha256, "proposed_document_sha256") }) })));
  });
  deps.handle("captions-provider:proposal-get", async (_event, input) => {
    const value = record(input, ["project_id", "proposal_id"], "captions provider proposal get");
    return parseCaptionsProviderProposal(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/captions-provider-proposals/${id(value.proposal_id, "captions_provider_proposal_id")}`)));
  });
  deps.handle("captions-provider:proposal-from-generation", async (_event, input) => {
    const value = record(input, ["project_id", "generation_id"], "captions provider proposal from generation");
    return parseCaptionsProviderProposal(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/captions-provider-generations/${id(value.generation_id, "generation_id")}/proposal`, { method: "POST" })));
  });
  deps.handle("worklist:list", async (_event, projectId) => {
    const page = stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(projectId, "project_id")}/worklists`)) as { items?: unknown[] };
    if (!Array.isArray(page.items)) throw new Error("Core request failed");
    return { items: page.items.map(parseWorklist) };
  });
  deps.handle("worklist:prepare", async (_event, input) => {
    const value = record(input, ["project_id", "base_revision_id", "steps", "max_steps", "token_budget"], "worklist prepare");
    return parseWorklist(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/worklists/prepare`, { method: "POST", body: JSON.stringify({ base_revision_id: id(value.base_revision_id, "base_revision_id"), steps: value.steps, max_steps: value.max_steps, token_budget: value.token_budget }) })));
  });
  deps.handle("worklist:create", async (_event, input) => {
    const value = record(input, ["project_id", "worklist_id", "base_revision_id"], "worklist create");
    return parseWorklist(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/worklists`, { method: "POST", body: JSON.stringify({ worklist_id: id(value.worklist_id, "worklist_id"), base_revision_id: id(value.base_revision_id, "base_revision_id") }) })));
  });
  deps.handle("worklist:cancel", async (_event, input) => {
    const value = record(input, ["project_id", "worklist_id"], "worklist cancel");
    return parseWorklist(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/worklists/${id(value.worklist_id, "worklist_id")}/cancel`, { method: "POST" })));
  });
  deps.handle("worklist:apply", async (_event, input) => {
    const value = record(input, ["project_id", "worklist_id", "step_id", "base_revision_id", "proposed_document_sha256"], "worklist apply");
    return parseWorklist(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/worklists/${id(value.worklist_id, "worklist_id")}/steps/${id(value.step_id, "step_id")}/apply`, { method: "POST", body: JSON.stringify({ base_revision_id: id(value.base_revision_id, "base_revision_id"), proposed_document_sha256: sha256(value.proposed_document_sha256, "proposed_document_sha256") }) })));
  });
  deps.handle("timeline:revision-diff", async (_event, input) => {
    const value = record(input, ["project_id", "base_revision_id", "target_revision_id"], "timeline revision diff");
    return parseTimelineDiff(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/timeline/revision-diffs`, { method: "POST", body: JSON.stringify({ base_revision_id: id(value.base_revision_id, "base_revision_id"), target_revision_id: id(value.target_revision_id, "target_revision_id") }) })));
  });
  // AI-1：内置多步 agent 会话（三段式对齐 planning-patch 先例；一项目一个
  // active session，Core 侧 AGENT_SESSION_ALREADY_ACTIVE 兜底）。
  deps.handle("agent-session:prepare", async (_event, input) => {
    const value = record(input, ["project_id", "base_revision_id", "provider_config_id", "instruction"], "agent session prepare");
    const response = await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/agent-sessions/prepare`, { method: "POST", body: JSON.stringify({ base_revision_id: id(value.base_revision_id, "base_revision_id"), provider_config_id: id(value.provider_config_id, "provider_config_id"), instruction: instruction(value.instruction) }) });
    return parseAgentSessionEgressPreview(stage2bRendererSafe(response));
  });
  deps.handle("agent-session:create", async (_event, input) => {
    const value = record(input, ["project_id", "agent_session_egress_preview_id", "payload_sha256"], "agent session create");
    const response = await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/agent-sessions`, { method: "POST", body: JSON.stringify({ agent_session_egress_preview_id: id(value.agent_session_egress_preview_id, "agent_session_egress_preview_id"), payload_sha256: sha256(value.payload_sha256, "payload_sha256") }) });
    return parseAgentSessionCreateResponse(stage2bRendererSafe(response));
  });
  deps.handle("agent-session:list", async (_event, projectId) => {
    const page = stage2bRendererSafeAllowInstruction(await fetchSafe(`${API_PREFIX}/projects/${id(projectId, "project_id")}/agent-sessions`)) as { items?: unknown[] };
    if (!Array.isArray(page.items)) throw new Error("Core request failed");
    return { items: page.items.map(parseAgentSession) };
  });
  deps.handle("agent-session:get", async (_event, sessionId) => parseAgentSession(stage2bRendererSafeAllowInstruction(await fetchSafe(`${API_PREFIX}/agent-sessions/${id(sessionId, "agent_session_id")}`))));
  // AI-2：素材 CV 信号分析摘要（generate=True 登记作业；Renderer 只见摘要）。
  // ADR-0005 阶段 2：可选密度旋钮（不传 = 默认）。
  deps.handle("cv-analysis:get", async (_event, input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid cv analysis input");
    const raw = input as Record<string, unknown>;
    const { target_gap_us, budget_per_minute_s, ...core } = raw;
    const value = record(core, ["project_id", "asset_id", "generate"], "cv analysis get");
    if (typeof value.generate !== "boolean") throw new Error("Invalid cv analysis input");
    const body: Record<string, unknown> = { generate: value.generate };
    if (target_gap_us !== undefined && target_gap_us !== null) {
      if (typeof target_gap_us !== "number" || !Number.isFinite(target_gap_us) || target_gap_us < 100_000 || target_gap_us > 60_000_000) throw new Error("Invalid target_gap_us");
      body.target_gap_us = target_gap_us;
    }
    if (budget_per_minute_s !== undefined && budget_per_minute_s !== null) {
      if (typeof budget_per_minute_s !== "number" || !Number.isFinite(budget_per_minute_s) || budget_per_minute_s < 1 || budget_per_minute_s > 120) throw new Error("Invalid budget_per_minute_s");
      body.budget_per_minute_s = budget_per_minute_s;
    }
    const response = await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/assets/${id(value.asset_id, "asset_id")}/cv-analysis`, { method: "POST", body: JSON.stringify(body) });
    return parseCvAnalysisSummary(stage2bRendererSafe(response));
  });
  // Wave1 L2：素材节拍网格摘要（generate=True 登记作业；Renderer 只见摘要）。
  deps.handle("beat-analysis:get", async (_event, input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid beat analysis input");
    const value = record(input, ["project_id", "asset_id", "generate"], "beat analysis get");
    if (typeof value.generate !== "boolean") throw new Error("Invalid beat analysis input");
    const response = await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/assets/${id(value.asset_id, "asset_id")}/beat-analysis`, { method: "POST", body: JSON.stringify({ generate: value.generate }) });
    return parseBeatAnalysisSummary(stage2bRendererSafe(response));
  });
  // W2.1 机位同步：机位组 / 触发同步 / 人工偏移（Renderer 只见元数据；DTO 无路径字段）。
  deps.handle("angle-sync:groups", async (_event, projectId) => {
    const response = await fetchSafe(`${API_PREFIX}/projects/${id(projectId, "project_id")}/angle-groups`);
    const value = record(response, ["items"], "angle groups");
    if (!Array.isArray(value.items)) throw new Error("Invalid angle groups");
    return { items: value.items.map(parseAngleGroup) };
  });
  deps.handle("angle-sync:create", async (_event, input) => {
    const value = record(input, ["project_id", "name", "reference_asset_id", "member_asset_ids"], "angle group create");
    if (typeof value.name !== "string" || value.name.trim().length < 1 || value.name.length > 120) throw new Error("Invalid angle group name");
    if (!Array.isArray(value.member_asset_ids) || value.member_asset_ids.length < 1 || value.member_asset_ids.length > 16) throw new Error("Invalid angle members");
    const members = value.member_asset_ids.map(assetId => id(assetId, "asset_id"));
    const response = await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/angle-groups`, {
      method: "POST",
      body: JSON.stringify({
        name: value.name.trim(),
        reference_asset_id: id(value.reference_asset_id, "asset_id"),
        member_asset_ids: members
      })
    });
    return parseAngleGroup(stage2bRendererSafe(response));
  });
  deps.handle("angle-sync:get", async (_event, input) => {
    const value = record(input, ["project_id", "group_id"], "angle group get");
    const response = await fetchSafe(
      `${API_PREFIX}/projects/${id(value.project_id, "project_id")}/angle-groups/${id(value.group_id, "group_id")}`
    );
    return parseAngleGroup(stage2bRendererSafe(response));
  });
  deps.handle("angle-sync:sync", async (_event, input) => {
    const value = record(input, ["project_id", "group_id", "generate"], "angle sync");
    if (typeof value.generate !== "boolean") throw new Error("Invalid angle sync input");
    const response = await fetchSafe(
      `${API_PREFIX}/projects/${id(value.project_id, "project_id")}/angle-groups/${id(value.group_id, "group_id")}/sync`,
      { method: "POST", body: JSON.stringify({ generate: value.generate }) }
    );
    return parseAngleSyncResponse(stage2bRendererSafe(response));
  });
  deps.handle("angle-sync:delete", async (_event, input) => {
    const value = record(input, ["project_id", "group_id"], "angle group delete");
    const response = await fetchSafe(
      `${API_PREFIX}/projects/${id(value.project_id, "project_id")}/angle-groups/${id(value.group_id, "group_id")}`,
      { method: "DELETE" }
    );
    const result = record(response, ["group_id", "deleted"], "angle group delete result");
    if (typeof result.deleted !== "boolean") throw new Error("Invalid angle group delete result");
    return { group_id: id(result.group_id, "group_id"), deleted: result.deleted };
  });
  deps.handle("angle-sync:offset", async (_event, input) => {
    const value = record(input, ["project_id", "group_id", "asset_id", "offset_us"], "angle offset");
    if (typeof value.offset_us !== "number" || !Number.isFinite(value.offset_us) || !Number.isInteger(value.offset_us)) throw new Error("Invalid angle offset");
    const response = await fetchSafe(
      `${API_PREFIX}/projects/${id(value.project_id, "project_id")}/angle-groups/${id(value.group_id, "group_id")}/angles/${id(value.asset_id, "asset_id")}/offset`,
      { method: "POST", body: JSON.stringify({ offset_us: value.offset_us }) }
    );
    return parseAngleGroup(stage2bRendererSafe(response));
  });
  // 阶段 C 稳定性包：CV 信号样本（sparkline 可视化数据）。
  deps.handle("cv-samples:list", async (_event, input) => {
    const value = record(input, ["project_id", "asset_id"], "cv samples list");
    const response = await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/assets/${id(value.asset_id, "asset_id")}/cv-samples`);
    return parseCvSamplesPage(stage2bRendererSafe(response));
  });
  // W1.1 剪辑语法层（P-A 零 egress）：工具目录 / 干跑 / 提案 / 采纳。
  deps.handle("editing-grammar:planners", async (_event, projectId) => {
    const page = stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(projectId, "project_id")}/editing-grammar/planners`)) as { items?: unknown[] };
    if (!Array.isArray(page.items)) throw new Error("Core request failed");
    return { items: page.items.map(parseEditingGrammarTool) };
  });
  deps.handle("editing-grammar:prepare", async (_event, input) => {
    const value = record(input, ["project_id", "base_revision_id", "planner", "params"], "editing grammar prepare");
    const params = value.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid editing grammar params");
    const response = await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/editing-grammar/prepare`, {
      method: "POST",
      body: JSON.stringify({ base_revision_id: id(value.base_revision_id, "base_revision_id"), planner: id(value.planner, "planner"), params })
    });
    return parseEditingGrammarPrepareResult(stage2bRendererSafe(response));
  });
  deps.handle("editing-grammar:propose", async (_event, input) => {
    const value = record(input, ["project_id", "base_revision_id", "planner", "params"], "editing grammar propose");
    const params = value.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid editing grammar params");
    const response = await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/editing-grammar/proposals`, {
      method: "POST",
      body: JSON.stringify({ base_revision_id: id(value.base_revision_id, "base_revision_id"), planner: id(value.planner, "planner"), params })
    });
    return parseEditingGrammarProposal(stage2bRendererSafe(response));
  });
  deps.handle("editing-grammar:proposal-list", async (_event, projectId) => {
    const page = stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(projectId, "project_id")}/editing-grammar/proposals`)) as { items?: unknown[] };
    if (!Array.isArray(page.items)) throw new Error("Core request failed");
    return { items: page.items.map(parseEditingGrammarProposalListItem) };
  });
  deps.handle("editing-grammar:proposal-get", async (_event, input) => {
    const value = record(input, ["project_id", "proposal_id"], "editing grammar proposal get");
    return parseEditingGrammarProposal(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/editing-grammar/proposals/${id(value.proposal_id, "proposal_id")}`)));
  });
  deps.handle("editing-grammar:proposal-apply", async (_event, input) => {
    const value = record(input, ["project_id", "proposal_id", "base_revision_id", "proposed_document_sha256"], "editing grammar proposal apply");
    return parseTimelineState(stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/editing-grammar/proposals/${id(value.proposal_id, "proposal_id")}/apply`, {
      method: "POST",
      body: JSON.stringify({ base_revision_id: id(value.base_revision_id, "base_revision_id"), proposed_document_sha256: sha256(value.proposed_document_sha256, "proposed_document_sha256") })
    })));
  });
}
