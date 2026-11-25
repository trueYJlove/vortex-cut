import { describe, expect, it, vi } from "vitest";
import { registerPlanningProviderIpc, rendererSafe } from "../electron/main/ipc/planning-provider-ipc.js";
import { issueCandidateClipMedia as realCandidateClipMedia } from "../electron/main/candidate-media.js";

type Handler = (_event: unknown, input?: unknown) => Promise<unknown> | unknown;
const hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function setup() {
  const handlers = new Map<string, Handler>();
  const fetchWithUi = vi.fn(async (path: string): Promise<unknown> => {
    if (path.endsWith("/timeline")) return { project_id: "project_1", current_revision: { timeline_revision_id: "revision_1" }, path: "C:\\hidden", token: "hidden" };
    if (path === "/api/v1/recipes") return { items: [{ recipe_id: "recipe_1", name: "Recipe", secret: "hidden" }] };
    return { provider_config_id: "provider_1", secret: "hidden", raw_response: "hidden" };
  });
  const saveSecret = vi.fn(async () => undefined);
  const deleteSecret = vi.fn(async () => undefined);
  const issueCandidateClipMedia = vi.fn(realCandidateClipMedia);
  registerPlanningProviderIpc({
    handle: (channel, handler) => handlers.set(channel, handler), fetchWithUi: fetchWithUi as never, saveSecret, deleteSecret,
    issueCandidateClipMedia: issueCandidateClipMedia as never,
    candidateMediaDependencies: {
      fetchPlan: vi.fn().mockResolvedValue({ project_id: "project_1", clips: [{ clip_id: "candidate_clip_1", asset_id: "asset_1", source_start_us: 0, source_end_us: 1_000_000 }] }),
      listProjectAssets: vi.fn().mockResolvedValue({ items: [{ asset_id: "asset_1", availability: "available", kind: "video" }] }),
      issueAssetTicket: vi.fn().mockResolvedValue("aivideo://media/ticket")
    }
  });
  return { handlers, fetchWithUi, saveSecret, deleteSecret, issueCandidateClipMedia };
}

describe("Stage2A Main IPC 安全编排", () => {
  it("注册精确白名单，且不注册自由媒体或密钥读取能力", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      "brief:get", "brief:put", "planning:adopt", "planning:clip-media", "planning:create", "planning:get", "planning:list", "planning:prepare",
      "planning:test-provider-capability", "provider:create", "provider:delete", "provider:delete-secret", "provider:list", "provider:set-secret", "provider:test", "provider:update", "recipe:get", "recipe:list"
    ]);
    expect(handlers.has("provider:get-secret")).toBe(false);
    expect(handlers.has("planning:clip-media-by-asset")).toBe(false);
  });

  it("拒绝非法输入，且不向 Core 发请求", async () => {
    const { handlers, fetchWithUi, saveSecret } = setup();
    await expect(handlers.get("provider:set-secret")!({}, { provider_config_id: "provider_1", secret: "", extra: true })).rejects.toThrow("Invalid provider secret");
    await expect(handlers.get("planning:prepare")!({}, { project_id: "project_1", provider_config_id: "provider_1", recipe_id: "recipe_1", transcript_ids: ["same", "same"] })).rejects.toThrow("Invalid transcript_ids");
    await expect(handlers.get("planning:create")!({}, { project_id: "project_1", egress_preview_id: "preview_1", payload_sha256: "wrong" })).rejects.toThrow("Invalid payload_sha256");
    await expect(handlers.get("planning:adopt")!({}, { project_id: "project_1", candidate_plan_id: "candidate_1", adoption: { schema_version: 1, candidate_document_sha256: hash, base_revision_id: "../escape" } })).rejects.toThrow("Invalid candidate adoption");
    expect(fetchWithUi).not.toHaveBeenCalled(); expect(saveSecret).not.toHaveBeenCalled();
  });

  it("密钥只被交给 Main 保存器，Renderer 仅得到状态且错误不回显密钥", async () => {
    const { handlers, saveSecret } = setup(); const secret = "SENTINEL-SECRET-DO-NOT-ECHO";
    await expect(handlers.get("provider:set-secret")!({}, { provider_config_id: "provider_1", secret })).resolves.toEqual({ provider_config_id: "provider_1", credential_status: "configured" });
    expect(saveSecret).toHaveBeenCalledWith("provider_1", secret);
    const failing = setup(); failing.saveSecret.mockRejectedValueOnce(new Error(secret));
    await expect(failing.handlers.get("provider:set-secret")!({}, { provider_config_id: "provider_1", secret })).rejects.toThrow("Core request failed");
  });

  it("prepare/create 仅发送规范请求；Core 错误会脱敏", async () => {
    const { handlers, fetchWithUi } = setup();
    await handlers.get("planning:prepare")!({}, { project_id: "project_1", provider_config_id: "provider_1", recipe_id: "recipe_1", transcript_ids: ["transcript_1"] });
    await handlers.get("planning:create")!({}, { project_id: "project_1", egress_preview_id: "preview_1", payload_sha256: hash });
    expect(fetchWithUi.mock.calls).toMatchObject([
      ["/api/v1/projects/project_1/candidate-generations/prepare", { method: "POST", body: JSON.stringify({ provider_config_id: "provider_1", recipe_id: "recipe_1", transcript_ids: ["transcript_1"] }) }],
      ["/api/v1/projects/project_1/candidate-generations", { method: "POST", body: JSON.stringify({ egress_preview_id: "preview_1", payload_sha256: hash }) }]
    ]);
    fetchWithUi.mockRejectedValueOnce(Object.assign(new Error("upstream secret must not escape"), { code: "PROVIDER_INVALID_REQUEST" }));
    await expect(handlers.get("provider:test")!({}, "provider_1")).rejects.toThrow("[PROVIDER_INVALID_REQUEST]");
    fetchWithUi.mockRejectedValueOnce(new Error("C:\\secret-path SENTINEL-SECRET"));
    await expect(handlers.get("provider:test")!({}, "provider_1")).rejects.toThrow("Core request failed");
  });

  it("PROVIDER_CAPABILITY_UNSUPPORTED 透传码但吞掉上游文本（P67 脱敏面不变）", async () => {
    // 为什么需要这条：网关静默忽略 response_format 时，Core 把它归为
    // PROVIDER_CAPABILITY_UNSUPPORTED。该码此前不在白名单 ⇒ 被吞成
    // "Core request failed"，渲染端只能提示「检查 Brief/凭据/转录」，把
    // 「换 Provider」误报成用户配置错。既要透出方向，又不得透出上游文本。
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockRejectedValueOnce(Object.assign(new Error("SENTINEL-SECRET upstream text"), { code: "PROVIDER_CAPABILITY_UNSUPPORTED" }));
    let failure: Error | null = null;
    try {
      await handlers.get("planning:prepare")!({}, { project_id: "project_1", provider_config_id: "provider_1", recipe_id: "recipe_1", transcript_ids: ["transcript_1"] });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain("[PROVIDER_CAPABILITY_UNSUPPORTED]");
    expect(failure!.message).not.toContain("SENTINEL-SECRET");
    // 对照：不在白名单的码仍被完全吞掉，证明这不是把 allowlist 整个打开。
    fetchWithUi.mockRejectedValueOnce(Object.assign(new Error("SENTINEL-SECRET"), { code: "SOME_OTHER_CODE" }));
    await expect(handlers.get("planning:prepare")!({}, { project_id: "project_1", provider_config_id: "provider_1", recipe_id: "recipe_1", transcript_ids: ["transcript_1"] })).rejects.toThrow("Core request failed");
  });

  it("AI 粗剪能力测试只接受 Provider ID，固定调用候选能力端点并严格脱敏", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockClear();
    fetchWithUi.mockResolvedValueOnce({ candidate_capability_status: "unsupported", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: "2026-08-14T00:00:00.000Z", candidate_capability_failure_code: "PROVIDER_FAILED", candidate_capability_probe_sha256: hash, raw_response: "must-not-pass", response: "must-not-pass" });
    await expect(handlers.get("planning:test-provider-capability")!({}, "provider_1")).resolves.toEqual({ candidate_capability_status: "unsupported", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: "2026-08-14T00:00:00.000Z", candidate_capability_failure_code: "PROVIDER_FAILED", candidate_capability_probe_sha256: hash });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/providers/provider_1/candidate-planning-capability-test", { method: "POST" });
    expect(() => handlers.get("planning:test-provider-capability")!({}, { provider_config_id: "provider_1" })).toThrow("Invalid provider_config_id");
  });

  it("provider:delete（P67）：行删除成功后必清密钥；IN_USE 码透传、其余脱敏", async () => {
    const { handlers, fetchWithUi, deleteSecret } = setup();
    fetchWithUi.mockClear();
    await expect(handlers.get("provider:delete")!({}, "provider_1")).resolves.toEqual({ provider_config_id: "provider_1", deleted: true });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/providers/provider_1", { method: "DELETE" });
    // 行删除成功后必须清除加密存储条目（否则重启时 reinject 携带孤儿密钥）
    expect(deleteSecret).toHaveBeenCalledWith("provider_1");

    const failing = setup();
    failing.fetchWithUi.mockRejectedValueOnce(Object.assign(new Error("historical audit trail"), { code: "PROVIDER_IN_USE" }));
    await expect(failing.handlers.get("provider:delete")!({}, "provider_1")).rejects.toThrow("[PROVIDER_IN_USE]");
    // 被拒绝时不得清密钥（fail-closed：行还在，密钥也应还在）
    expect(failing.deleteSecret).not.toHaveBeenCalled();

    const hostile = setup();
    hostile.fetchWithUi.mockRejectedValueOnce(new Error("C:\secret-path SENTINEL-SECRET"));
    await expect(hostile.handlers.get("provider:delete")!({}, "provider_1")).rejects.toThrow("Core request failed");
  });

  it("candidate ticket 只由已验证 plan/clip 签发，adopt 成功后必重读权威 Timeline", async () => {
    const { handlers, fetchWithUi, issueCandidateClipMedia } = setup();
    await expect(handlers.get("planning:clip-media")!({}, { project_id: "project_1", candidate_plan_id: "candidate_1", candidate_clip_id: "candidate_clip_1", source_start_us: 0 })).rejects.toThrow("Core request failed");
    await expect(handlers.get("planning:clip-media")!({}, { project_id: "project_1", candidate_plan_id: "candidate_1", candidate_clip_id: "candidate_clip_1" })).resolves.toEqual({ media_url: "aivideo://media/ticket", source_start_us: 0, source_end_us: 1_000_000 });
    expect(issueCandidateClipMedia).toHaveBeenCalledTimes(2);
    const adopted = await handlers.get("planning:adopt")!({}, { project_id: "project_1", candidate_plan_id: "candidate_1", adoption: { schema_version: 1, candidate_document_sha256: hash, base_revision_id: null } });
    expect(fetchWithUi.mock.calls.slice(-2).map(call => call[0])).toEqual(["/api/v1/projects/project_1/candidate-plans/candidate_1/adopt", "/api/v1/projects/project_1/timeline"]);
    expect(adopted).toEqual({ project_id: "project_1", current_revision: { timeline_revision_id: "revision_1" } });
  });

  it("递归裁剪 Core 响应中的敏感键", () => {
    expect(rendererSafe({ path: "C:\\a", nested: { Authorization: "Bearer x", request: "body", ok: true }, rows: [{ raw_response: "body", response: "body", value: 1 }] })).toEqual({ nested: { ok: true }, rows: [{ value: 1 }] });
  });
});
