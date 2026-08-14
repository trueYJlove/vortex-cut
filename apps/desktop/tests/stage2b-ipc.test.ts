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
    expect([...handlers.keys()]).toEqual(["planning-patch:prepare", "planning-patch:test-provider-capability", "planning-patch:create", "planning-patch:generation-get", "planning-patch:proposal-list", "planning-patch:proposal-get", "planning-patch:proposal-apply", "timeline:revision-diff"]);
    fetchWithUi.mockResolvedValueOnce({ timeline_patch_egress_preview_id: "preview_1", provider: { display_name: "Provider", origin: "https://provider.test", model: "model" }, prompt_template_version: "timeline-patch-v1", output_schema_version: "timeline-patch-output-v1", sent_fields: ["instruction"], payload_sha256: hash, character_count: 10, estimated_tokens: 3, clip_count: 1, caption_count: 0, locked_count: 0, expires_at: now });
    await handlers.get("planning-patch:prepare")?.({}, { project_id: "project_1", base_revision_id: "revision_1", provider_config_id: "provider_1", instruction: "缩短开头" });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/timeline-patch-generations/prepare", { method: "POST", body: JSON.stringify({ base_revision_id: "revision_1", provider_config_id: "provider_1", instruction: "缩短开头" }) });
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
