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
    expect([...handlers.keys()]).toEqual(["planning-patch:prepare", "planning-patch:test-provider-capability", "planning-patch:create", "planning-patch:generation-get", "planning-patch:proposal-list", "planning-patch:proposal-get", "planning-patch:proposal-apply", "captions-provider:test-capability", "captions-provider:prepare", "captions-provider:create", "captions-provider:get", "captions-provider:proposal-apply", "captions-provider:proposal-get", "captions-provider:proposal-from-generation", "worklist:list", "worklist:prepare", "worklist:create", "worklist:cancel", "worklist:apply", "timeline:revision-diff", "agent-session:prepare", "agent-session:create", "agent-session:list", "agent-session:get", "cv-analysis:get", "beat-analysis:get", "angle-sync:groups", "angle-sync:create", "angle-sync:get", "angle-sync:sync", "angle-sync:delete", "angle-sync:offset", "semantic:index", "semantic:search", "cv-samples:list", "editing-grammar:planners", "editing-grammar:prepare", "editing-grammar:propose", "editing-grammar:proposal-list", "editing-grammar:proposal-get", "editing-grammar:proposal-apply"]);
    fetchWithUi.mockResolvedValueOnce({ timeline_patch_egress_preview_id: "preview_1", provider: { display_name: "Provider", origin: "https://provider.test", model: "model" }, prompt_template_version: "timeline-patch-v1", output_schema_version: "timeline-patch-output-v1", sent_fields: ["instruction"], payload_sha256: hash, character_count: 10, estimated_tokens: 3, clip_count: 1, caption_count: 0, locked_count: 0, expires_at: now });
    await handlers.get("planning-patch:prepare")?.({}, { project_id: "project_1", base_revision_id: "revision_1", provider_config_id: "provider_1", instruction: "缩短开头" });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/timeline-patch-generations/prepare", { method: "POST", body: JSON.stringify({ base_revision_id: "revision_1", provider_config_id: "provider_1", instruction: "缩短开头" }) });
  });

  it("captions provider：prepare/create/get 精确转发并解析响应，响应敏感字段被裁剪", async () => {
    const { handlers, fetchWithUi } = setup();
    const preview = { captions_provider_egress_preview_id: "caption_preview_1", provider: { display_name: "Provider", origin: "https://provider.test", model: "model" }, prompt_template_version: "captions_provider_v1", output_schema_version: "caption-text-output-v1", sent_fields: ["language", "preset_id", "max_chars_per_caption"], payload_sha256: hash, segment_count: 2, character_count: 12, expires_at: now, raw_response: "must-not-pass" };
    fetchWithUi.mockResolvedValueOnce(preview);
    const prepared = await handlers.get("captions-provider:prepare")?.({}, { project_id: "project_1", base_revision_id: "revision_1", provider_config_id: "provider_1", transcript_id: "transcript_1", segment_ids: ["segment_1", "segment_2"], language: "zh-CN", preset_id: "default-bottom", max_chars_per_caption: 24 });
    const { raw_response: _rawResponse, ...safePreview } = preview;
    expect(prepared).toEqual(safePreview);
    expect(prepared).not.toHaveProperty("raw_response");
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/captions-provider/prepare", { method: "POST", body: JSON.stringify({ base_revision_id: "revision_1", provider_config_id: "provider_1", transcript_id: "transcript_1", segment_ids: ["segment_1", "segment_2"], language: "zh-CN", preset_id: "default-bottom", max_chars_per_caption: 24 }) });
    fetchWithUi.mockResolvedValueOnce({ captions_provider_generation_id: "caption_generation_1", status: "queued", consent_id: "consent_1", secret: "must-not-pass" });
    await expect(handlers.get("captions-provider:create")?.({}, { project_id: "project_1", captions_provider_egress_preview_id: "caption_preview_1", payload_sha256: hash })).resolves.toEqual({ captions_provider_generation_id: "caption_generation_1", status: "queued", consent_id: "consent_1" });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/captions-provider", { method: "POST", body: JSON.stringify({ captions_provider_egress_preview_id: "caption_preview_1", payload_sha256: hash }) });
    const generation = { captions_provider_generation_id: "caption_generation_1", project_id: "project_1", base_revision_id: "revision_1", status: "succeeded", payload_sha256: hash, created_at: now, updated_at: now, finished_at: now };
    fetchWithUi.mockResolvedValueOnce(generation);
    await expect(handlers.get("captions-provider:get")?.({}, { project_id: "project_1", generation_id: "caption_generation_1" })).resolves.toEqual(generation);
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/captions-provider-generations/caption_generation_1", undefined);
  });

  it("captions provider：非法输入拒绝且不 fetch", async () => {
    const { handlers, fetchWithUi } = setup();
    const base = { project_id: "project_1", base_revision_id: "revision_1", provider_config_id: "provider_1", transcript_id: "transcript_1", segment_ids: ["segment_1"], language: null, preset_id: "default-bottom", max_chars_per_caption: 24 };
    for (const input of [
      { ...base, segment_ids: ["segment_1", "segment_1"] },
      { ...base, segment_ids: ["bad id"] },
      { ...base, segment_ids: [] },
      { ...base, language: "   " },
      { ...base, language: "x".repeat(33) },
      { ...base, preset_id: "custom" },
      { ...base, max_chars_per_caption: true },
      { ...base, max_chars_per_caption: 0 },
      { ...base, extra: true }
    ]) await expect(handlers.get("captions-provider:prepare")?.({}, input)).rejects.toThrow();
    await expect(handlers.get("captions-provider:create")?.({}, { project_id: "project_1", captions_provider_egress_preview_id: "preview_1", payload_sha256: "bad", extra: true })).rejects.toThrow();
    await expect(handlers.get("captions-provider:get")?.({}, { project_id: "project_1", generation_id: "bad id" })).rejects.toThrow();
    expect(fetchWithUi).not.toHaveBeenCalled();
  });

  it("captions proposal：只读获取和按 generation 创建，拒绝 raw/完整 Timeline", async () => {
    const { handlers, fetchWithUi } = setup();
    const proposal = { captions_provider_proposal_id: "captions_proposal_1", generation_id: "captions_generation_1", project_id: "project_1", base_revision_id: "revision_1", base_document_sha256: hash, patch: { summary: "Provider 字幕文本提案", operations: [{ op: "update_caption", caption_id: "caption_1", text: "new" }] }, patch_sha256: hash, proposed_document_sha256: hash, created_at: now, applied_revision_id: null };
    fetchWithUi.mockResolvedValueOnce(proposal);
    await expect(handlers.get("captions-provider:proposal-get")?.({}, { project_id: "project_1", proposal_id: "captions_proposal_1" })).resolves.toEqual(proposal);
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/captions-provider-proposals/captions_proposal_1", undefined);
    fetchWithUi.mockResolvedValueOnce(proposal);
    await expect(handlers.get("captions-provider:proposal-from-generation")?.({}, { project_id: "project_1", generation_id: "captions_generation_1" })).resolves.toEqual(proposal);
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/captions-provider-generations/captions_generation_1/proposal", { method: "POST" });
    fetchWithUi.mockResolvedValueOnce({ ...proposal, raw_response: "secret", timeline: { clips: [] } });
    await expect(handlers.get("captions-provider:proposal-get")?.({}, { project_id: "project_1", proposal_id: "captions_proposal_1" })).rejects.toThrow();
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

  it("cv-analysis：密度旋钮可选透传，非法值拒绝", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({ analysis_id: "cv_analysis_1", status: "queued", job_id: "job_1", algorithm_version: "3", sample_count: null, scene_cut_count: null, signals: ["scene_cut"], density_status: null });
    await handlers.get("cv-analysis:get")?.({}, { project_id: "project_1", asset_id: "asset_1", generate: true, target_gap_us: 1_000_000, budget_per_minute_s: 20 });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/assets/asset_1/cv-analysis", { method: "POST", body: JSON.stringify({ generate: true, target_gap_us: 1_000_000, budget_per_minute_s: 20 }) });
    await expect(handlers.get("cv-analysis:get")?.({}, { project_id: "project_1", asset_id: "asset_1", generate: true, target_gap_us: 10 })).rejects.toThrow();
    await expect(handlers.get("cv-analysis:get")?.({}, { project_id: "project_1", asset_id: "asset_1", generate: true, budget_per_minute_s: 999 })).rejects.toThrow();
    expect(fetchWithUi).toHaveBeenCalledTimes(1);
  });


  it("angle-sync：建组精确转发（参考机位 + 成员）并校验入参", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({
      group_id: "angle_group_1", project_id: "project_1", name: "双机位",
      reference_asset_id: "asset_a", algorithm_version: "1",
      angles: [{ asset_id: "asset_a", is_reference: true, status: "missing", reason: null,
                 offset_us: null, confidence: null, source: null, stale: false, recorded_at: null }],
      created_at: "2026-10-10T00:00:00Z", updated_at: "2026-10-10T00:00:00Z"
    });
    await expect(handlers.get("angle-sync:create")?.({}, {
      project_id: "project_1", name: " 双机位 ", reference_asset_id: "asset_a",
      member_asset_ids: ["asset_a", "asset_b"]
    })).resolves.toMatchObject({ group_id: "angle_group_1", angles: [{ status: "missing" }] });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/angle-groups", {
      method: "POST",
      body: JSON.stringify({ name: "双机位", reference_asset_id: "asset_a", member_asset_ids: ["asset_a", "asset_b"] })
    });
    await expect(handlers.get("angle-sync:create")?.({}, {
      project_id: "project_1", name: "x", reference_asset_id: "asset_a", member_asset_ids: []
    })).rejects.toThrow();
    expect(fetchWithUi).toHaveBeenCalledTimes(1);
  });

  it("angle-sync：同步允许 job_id=null（幂等短路）；人工偏移只接受整数微秒", async () => {
    const { handlers, fetchWithUi } = setup();
    const group = {
      group_id: "angle_group_1", project_id: "project_1", name: "双机位",
      reference_asset_id: "asset_a", algorithm_version: "1",
      angles: [{ asset_id: "asset_a", is_reference: true, status: "ready", reason: null,
                 offset_us: 0, confidence: 1, source: "auto", stale: false, recorded_at: null }],
      created_at: "2026-10-10T00:00:00Z", updated_at: "2026-10-10T00:00:00Z"
    };
    fetchWithUi.mockResolvedValueOnce({ job_id: null, group });
    await expect(handlers.get("angle-sync:sync")?.({}, {
      project_id: "project_1", group_id: "angle_group_1", generate: true
    })).resolves.toMatchObject({ job_id: null });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/angle-groups/angle_group_1/sync", {
      method: "POST", body: JSON.stringify({ generate: true })
    });

    fetchWithUi.mockResolvedValueOnce(group);
    await handlers.get("angle-sync:offset")?.({}, {
      project_id: "project_1", group_id: "angle_group_1", asset_id: "asset_b", offset_us: -253_000
    });
    expect(fetchWithUi).toHaveBeenLastCalledWith(
      "/api/v1/projects/project_1/angle-groups/angle_group_1/angles/asset_b/offset",
      { method: "POST", body: JSON.stringify({ offset_us: -253_000 }) }
    );
    await expect(handlers.get("angle-sync:offset")?.({}, {
      project_id: "project_1", group_id: "angle_group_1", asset_id: "asset_b", offset_us: 1.5
    })).rejects.toThrow();

    fetchWithUi.mockResolvedValueOnce({ group_id: "angle_group_1", deleted: true });
    await expect(handlers.get("angle-sync:delete")?.({}, {
      project_id: "project_1", group_id: "angle_group_1"
    })).resolves.toEqual({ group_id: "angle_group_1", deleted: true });
    expect(fetchWithUi).toHaveBeenLastCalledWith(
      "/api/v1/projects/project_1/angle-groups/angle_group_1", { method: "DELETE" }
    );
    await expect(handlers.get("angle-sync:delete")?.({}, {
      project_id: "project_1"
    })).rejects.toThrow();
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

  it("editing-grammar：零 egress 干跑/提案/采纳链路", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({ items: [{ name: "drop_short_clips", title: "删除过短片段", description: "d", parameters_schema: { type: "object" }, preconditions: ["p"] }] });
    await expect(handlers.get("editing-grammar:planners")?.({}, "project_1")).resolves.toMatchObject({ items: [{ name: "drop_short_clips" }] });

    const prepareBody = { planner: "drop_short_clips", params: { min_duration_us: 500000 }, operations: [{ op: "remove_clip", clip_id: "c1" }], operations_count: 1, noop: false, rationale: { rules: [] }, base_revision_id: "revision_1", base_document_sha256: hash, summary: "删除 1 条过短片段" };
    fetchWithUi.mockResolvedValueOnce(prepareBody);
    const preview = await handlers.get("editing-grammar:prepare")?.({}, { project_id: "project_1", base_revision_id: "revision_1", planner: "drop_short_clips", params: { min_duration_us: 500000 } });
    expect(preview).toMatchObject({ planner: "drop_short_clips", operations_count: 1 });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/editing-grammar/prepare", { method: "POST", body: JSON.stringify({ base_revision_id: "revision_1", planner: "drop_short_clips", params: { min_duration_us: 500000 } }) });

    await expect(handlers.get("editing-grammar:prepare")?.({}, { project_id: "project_1", base_revision_id: "revision_1", planner: "drop_short_clips", params: [] })).rejects.toThrow();
  });
});
