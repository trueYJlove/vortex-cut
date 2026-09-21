import { describe, expect, it, vi } from "vitest";
import { registerStage2bIpc, stage2bRendererSafe } from "../electron/main/stage2b-ipc.js";

const now = "2026-08-12T00:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;

function setup() {
  const handlers = new Map<string, (_event: unknown, input?: unknown) => unknown>();
  const fetchWithUi = vi.fn();
  registerStage2bIpc({ handle: (channel, listener) => handlers.set(channel, listener), fetchWithUi });
  return { handlers, fetchWithUi };
}

describe("Stage2B IPC", () => {
  it("只注册冻结白名单并精确转发 prepare/create", async () => {
    const { handlers, fetchWithUi } = setup();
    expect([...handlers.keys()]).toEqual(["planning-patch:prepare", "planning-patch:test-provider-capability", "planning-patch:create", "planning-patch:generation-get", "planning-patch:proposal-list", "planning-patch:proposal-get", "planning-patch:proposal-apply", "timeline:revision-diff", "agent-session:prepare", "agent-session:create", "agent-session:list", "agent-session:get", "cv-analysis:get", "cv-samples:list"]);
    fetchWithUi.mockResolvedValueOnce({ timeline_patch_egress_preview_id: "preview_1", provider: { display_name: "Provider", origin: "https://provider.test", model: "model" }, prompt_template_version: "timeline-patch-v1", output_schema_version: "timeline-patch-output-v1", sent_fields: ["instruction"], payload_sha256: hash, character_count: 10, estimated_tokens: 3, clip_count: 1, caption_count: 0, locked_count: 0, expires_at: now });
    await handlers.get("planning-patch:prepare")?.({}, { project_id: "project_1", base_revision_id: "revision_1", provider_config_id: "provider_1", instruction: "缩短开头" });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/timeline-patch-generations/prepare", { method: "POST", body: JSON.stringify({ base_revision_id: "revision_1", provider_config_id: "provider_1", instruction: "缩短开头" }) });
  });

  it("agent session：精确转发 prepare/create 并解析 get_session（含 steps）", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({ agent_session_egress_preview_id: "agent_preview_1", provider: { display_name: "Provider", origin: "https://provider.test", model: "model" }, prompt_template_version: "agent-session-v1", output_schema_version: "agent-session-output-v1", sent_fields: ["instruction", "multi_step_feedback"], payload_sha256: hash, character_count: 10, estimated_tokens: 3, clip_count: 1, caption_count: 0, locked_count: 0, max_steps: 6, token_budget: 200000, expires_at: now });
    const preview = await handlers.get("agent-session:prepare")?.({}, { project_id: "project_1", base_revision_id: "revision_1", provider_config_id: "provider_1", instruction: "剪短并加字幕" });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/agent-sessions/prepare", { method: "POST", body: JSON.stringify({ base_revision_id: "revision_1", provider_config_id: "provider_1", instruction: "剪短并加字幕" }) });
    expect(preview).toMatchObject({ agent_session_egress_preview_id: "agent_preview_1", max_steps: 6 });
    fetchWithUi.mockResolvedValueOnce({ agent_session_id: "agent_session_1", job: { job_id: "job_1", project_id: "project_1", asset_id: null, kind: "agent_session", status: "queued", stage: "queued", progress: 0, attempt: 1, model_id: null, model_revision: null, input_fingerprint: null, input: {}, error: null, created_at: now, updated_at: now, started_at: null, finished_at: null } });
    const created = await handlers.get("agent-session:create")?.({}, { project_id: "project_1", agent_session_egress_preview_id: "agent_preview_1", payload_sha256: hash });
    expect(created).toMatchObject({ agent_session_id: "agent_session_1" });
    const session = { agent_session_id: "agent_session_1", project_id: "project_1", base_revision_id: "revision_1", instruction: "剪短并加字幕", max_steps: 6, status: "succeeded", payload_sha256: hash, created_at: now, updated_at: now, finished_at: now, steps: [{ ordinal: 1, status: "succeeded", stage: "persisting_step", summary: "ok", error: null, duration_ms: 900, created_at: now }] };
    fetchWithUi.mockResolvedValueOnce(session);
    await expect(handlers.get("agent-session:get")?.({}, "agent_session_1")).resolves.toEqual(session);
    await expect(handlers.get("agent-session:prepare")?.({}, { project_id: "project_1", base_revision_id: "revision_1", provider_config_id: "provider_1", instruction: "" })).rejects.toThrow();
  });

  it("cv-samples:list：GET 样本页（sparkline 数据）", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({ asset_id: "asset_1", samples: [{ timestamp_us: 0, scene_cut: false, motion_energy: 0.1, sharpness: 0.2, brightness: 0.3, audio_energy: 0.4 }] });
    await expect(handlers.get("cv-samples:list")?.({}, { project_id: "project_1", asset_id: "asset_1" })).resolves.toMatchObject({ asset_id: "asset_1" });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/assets/asset_1/cv-samples", undefined);
  });

  it("cv-analysis：generate 透传布尔，摘要返回不含路径字段", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({ analysis_id: "cv_analysis_1", status: "ready", job_id: "job_1", algorithm_version: "v21", sample_count: 24, scene_cut_count: 5, signals: ["scene_cut"] });
    await expect(handlers.get("cv-analysis:get")?.({}, { project_id: "project_1", asset_id: "asset_1", generate: true })).resolves.toMatchObject({ status: "ready", sample_count: 24 });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/assets/asset_1/cv-analysis", { method: "POST", body: JSON.stringify({ generate: true }) });
    await expect(handlers.get("cv-analysis:get")?.({}, { project_id: "project_1", asset_id: "asset_1", generate: "yes" })).rejects.toThrow();
    expect(fetchWithUi).toHaveBeenCalledTimes(1);
  });

  it("能力测试只接受 Provider ID，并返回严格脱敏状态 DTO", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({ timeline_patch_capability_status: "unsupported", timeline_patch_response_adapter_id: null, timeline_patch_probe_protocol_version: null, timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: "PROVIDER_SCHEMA_MISMATCH", timeline_patch_capability_probe_sha256: hash, raw_response: "must-not-pass" });
    await expect(handlers.get("planning-patch:test-provider-capability")?.({}, "provider_1")).resolves.toEqual({ timeline_patch_capability_status: "unsupported", timeline_patch_response_adapter_id: null, timeline_patch_probe_protocol_version: null, timeline_patch_capability_tested_at: now, timeline_patch_capability_failure_code: "PROVIDER_SCHEMA_MISMATCH", timeline_patch_capability_probe_sha256: hash });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/providers/provider_1/timeline-patch-capability-test", { method: "POST" });
    await expect(handlers.get("planning-patch:test-provider-capability")?.({}, { provider_config_id: "provider_1" })).rejects.toThrow();
  });

  it("拒绝多余键、非法 hash、空指令和超长指令", async () => {
    const { handlers, fetchWithUi } = setup();
    await expect(handlers.get("planning-patch:prepare")?.({}, { project_id: "project_1", base_revision_id: "revision_1", provider_config_id: "provider_1", instruction: "", extra: true })).rejects.toThrow();
    await expect(handlers.get("planning-patch:prepare")?.({}, { project_id: "project_1", base_revision_id: "revision_1", provider_config_id: "provider_1", instruction: "中".repeat(4001) })).rejects.toThrow();
    await expect(handlers.get("planning-patch:create")?.({}, { project_id: "project_1", timeline_patch_egress_preview_id: "preview_1", payload_sha256: "bad" })).rejects.toThrow();
    expect(fetchWithUi).not.toHaveBeenCalled();
  });

  it("递归裁剪正文和敏感键，Core 错误统一脱敏", async () => {
    expect(stage2bRendererSafe({ instruction: "secret", payload: { captions: ["正文"] }, nested: { Authorization: "Bearer x", ok: true }, raw_response: "body" })).toEqual({ nested: { ok: true } });
    const { handlers, fetchWithUi } = setup(); fetchWithUi.mockRejectedValue(new Error("C:\\private api_key prompt"));
    await expect(handlers.get("planning-patch:generation-get")?.({}, "generation_1")).rejects.toThrow("Core request failed");
  });
});
