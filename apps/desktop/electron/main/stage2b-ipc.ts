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
  parseCvAnalysisSummary
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
async function safeInvoke<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code === "TIMELINE_PATCH_PROVIDER_UNTESTED" || code === "TIMELINE_PATCH_PROVIDER_UNSUPPORTED") throw new Error(code);
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
    const page = stage2bRendererSafe(await fetchSafe(`${API_PREFIX}/projects/${id(projectId, "project_id")}/agent-sessions`)) as { items?: unknown[] };
    if (!Array.isArray(page.items)) throw new Error("Core request failed");
    return { items: page.items.map(parseAgentSession) };
  });
  deps.handle("agent-session:get", async (_event, sessionId) => parseAgentSession(stage2bRendererSafeAllowInstruction(await fetchSafe(`${API_PREFIX}/agent-sessions/${id(sessionId, "agent_session_id")}`))));
  // AI-2：素材 CV 信号分析摘要（generate=True 登记作业；Renderer 只见摘要）。
  deps.handle("cv-analysis:get", async (_event, input) => {
    const value = record(input, ["project_id", "asset_id", "generate"], "cv analysis get");
    if (typeof value.generate !== "boolean") throw new Error("Invalid cv analysis input");
    const response = await fetchSafe(`${API_PREFIX}/projects/${id(value.project_id, "project_id")}/assets/${id(value.asset_id, "asset_id")}/cv-analysis`, { method: "POST", body: JSON.stringify({ generate: value.generate }) });
    return parseCvAnalysisSummary(stage2bRendererSafe(response));
  });
}
