import { describe, expect, it, vi } from "vitest";
import { registerStage4dIpc } from "../electron/main/stage4d-ipc.js";

const now = "2026-08-19T00:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;
const otherHash = `sha256:${"b".repeat(64)}`;
const config = {
  provider_config_id: "image_provider_1", project_id: "project_1", provider_kind: "apikey_fun_images",
  adapter_id: "apikey_fun_images_sse_v1", capability: "image_text_to_image", protocol_version: "1",
  display_name: "APIKEY.FUN Images", model: "gpt-image-2", enabled: true, price_per_image: 0.1, price_2k_per_image: 0.15, price_currency: "CNY",
  credential_status: "configured", created_at: now, updated_at: now,
};
const preview = {
  preview_id: "preview_1", project_id: "project_1", execution_mode: "provider_image_v1",
  prompt_sha256: hash, payload_sha256: otherHash, size: "1024x1024", output_format: "png", image_count: 1,
  provider: { provider_config_id: "image_provider_1", provider_kind: "apikey_fun_images", adapter_id: "apikey_fun_images_sse_v1", model: "gpt-image-2" },
  estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K", expires_at: now,
};
const request = {
  request_id: "request_1", project_id: "project_1", generation_kind: "image", execution_mode: "provider_image_v1",
  prompt_sha256: hash, parameters: { size: "1024x1024" }, request_sha256: otherHash, created_at: now,
};
const task = {
  task_id: "task_1", request_id: "request_1", job_id: "job_1", attempt: 1, status: "queued", stage: "queued",
  retry_of_task_id: null, provider_call_count: 0, provider_may_have_processed: false, estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K",
  output_asset_id: null, output_sha256: null, result_summary: null, error: null,
  created_at: now, updated_at: now, finished_at: null,
};

type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
function setup() {
  const handlers = new Map<string, Handler>();
  const fetchWithUi = vi.fn();
  const admin = { setImageProviderSecret: vi.fn(), deleteImageProviderSecret: vi.fn() };
  const getAdmin = vi.fn(() => admin as never);
  const secrets = { available: vi.fn(() => true), set: vi.fn(), delete: vi.fn(), load: vi.fn().mockResolvedValue([]) };
  registerStage4dIpc({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    fetchWithUi,
    getAdmin,
    secrets: secrets as never,
  });
  return { handlers, fetchWithUi, admin, getAdmin, secrets };
}

describe("Stage 4D Provider Image IPC", () => {
  it("只注册十二个独立白名单 channel，且注册阶段不要求 Core ready", () => {
    const { handlers, getAdmin } = setup();
    expect(getAdmin).not.toHaveBeenCalled();
    expect([...handlers.keys()]).toEqual([
      "provider-image-config:list", "provider-image-config:create", "provider-image-config:set-secret", "provider-image-config:delete-secret",
      "provider-image-generation:prepare", "provider-image-generation:create", "provider-image-generation:list", "provider-image-generation:get",
      "provider-image-generation:tasks", "provider-image-generation:retry-prepare", "provider-image-generation:retry", "provider-image-generation:cancel",
    ]);
  });

  it("Prompt 只进入 prepare/retry-prepare 请求，响应敏感字段不会进入 Renderer", async () => {
    const { handlers, fetchWithUi } = setup();
    const sentinel = "PROMPT_SENTINEL_NEVER_RETURN";
    fetchWithUi
      .mockResolvedValueOnce({ ...preview, prompt: sentinel, absolute_path: "C:\\private\\image.png", raw_response: "private" })
      .mockResolvedValueOnce({ ...preview, prompt: sentinel, path: "private", base64: "private" });
    const prepared = await handlers.get("provider-image-generation:prepare")?.({}, {
      project_id: "project_1", request: { provider_config_id: "image_provider_1", prompt: sentinel, size: "1024x1024" },
    });
    const retryPrepared = await handlers.get("provider-image-generation:retry-prepare")?.({}, {
      task_id: "task_1", request: { prompt: sentinel },
    });
    expect(fetchWithUi.mock.calls[0]).toEqual([
      "/api/v1/projects/project_1/provider-image-generations/prepare",
      { method: "POST", body: JSON.stringify({ provider_config_id: "image_provider_1", prompt: sentinel, size: "1024x1024" }) },
    ]);
    expect(fetchWithUi.mock.calls[1]).toEqual([
      "/api/v1/provider-image-generation-tasks/task_1/retry/prepare",
      { method: "POST", body: JSON.stringify({ prompt: sentinel }) },
    ]);
    expect(JSON.stringify([prepared, retryPrepared])).not.toContain(sentinel);
    expect(JSON.stringify([prepared, retryPrepared])).not.toContain("private");
  });

  it("严格拒绝未知字段、非法 ID/分页及非敏感响应扩展", async () => {
    const { handlers, fetchWithUi } = setup();
    await expect(handlers.get("provider-image-generation:prepare")?.({}, {
      project_id: "project_1", request: { provider_config_id: "image_provider_1", prompt: "p", size: "1024x1024" }, extra: true,
    })).rejects.toThrow();
    await expect(handlers.get("provider-image-generation:get")?.({}, "../private")).rejects.toThrow("Invalid request_id");
    await expect(handlers.get("provider-image-generation:list")?.({}, { project_id: "project_1", limit: 101 })).rejects.toThrow("Invalid limit");
    await expect(handlers.get("provider-image-generation:tasks")?.({}, { request_id: "request_1", cursor: "../private" })).rejects.toThrow("Invalid cursor");
    expect(fetchWithUi).not.toHaveBeenCalled();
    fetchWithUi.mockResolvedValue({ ...request, unexpected: "must-fail-closed" });
    await expect(handlers.get("provider-image-generation:get")?.({}, "request_1")).rejects.toThrow();
  });

  it("配置密钥只走 Main admin，且不会把密钥回传 Renderer", async () => {
    const { handlers, admin, getAdmin, secrets } = setup();
    const sentinel = "SENTINEL-IMAGE-KEY";
    expect(getAdmin).not.toHaveBeenCalled();
    const saved = await handlers.get("provider-image-config:set-secret")?.({}, { provider_config_id: "image_provider_1", secret: sentinel });
    const deleted = await handlers.get("provider-image-config:delete-secret")?.({}, "image_provider_1");
    expect(secrets.set).toHaveBeenCalledWith("image_provider_1", sentinel);
    expect(admin.setImageProviderSecret).toHaveBeenCalledWith("image_provider_1", sentinel);
    expect(admin.deleteImageProviderSecret).toHaveBeenCalledWith("image_provider_1");
    expect(getAdmin).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([saved, deleted])).not.toContain(sentinel);
  });

  it("覆盖独立列表、创建、读取、任务、retry 与 cancel 路由", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi
      .mockResolvedValueOnce({ items: [config] }).mockResolvedValueOnce(config)
      .mockResolvedValueOnce({ request, task, reused: false }).mockResolvedValueOnce({ items: [request], next_cursor: null })
      .mockResolvedValueOnce(request).mockResolvedValueOnce({ items: [task], next_cursor: null })
      .mockResolvedValueOnce({ ...task, task_id: "task_2", attempt: 2, retry_of_task_id: "task_1" })
      .mockResolvedValueOnce({ ...task, status: "cancelled", stage: "cancelled", finished_at: now });
    await handlers.get("provider-image-config:list")?.({}, { project_id: "project_1" });
    await handlers.get("provider-image-config:create")?.({}, { project_id: "project_1", config: { display_name: "APIKEY.FUN Images", enabled: true } });
    await handlers.get("provider-image-generation:create")?.({}, { project_id: "project_1", request: { preview_id: "preview_1", payload_sha256: otherHash, confirmed: true } });
    await handlers.get("provider-image-generation:list")?.({}, { project_id: "project_1", limit: 20, cursor: "0" });
    await handlers.get("provider-image-generation:get")?.({}, "request_1");
    await handlers.get("provider-image-generation:tasks")?.({}, { request_id: "request_1" });
    await handlers.get("provider-image-generation:retry")?.({}, { task_id: "task_1", request: { preview_id: "preview_1", payload_sha256: otherHash, confirmed: true } });
    await handlers.get("provider-image-generation:cancel")?.({}, "task_1");
    expect(fetchWithUi.mock.calls.map(call => call[0])).toEqual([
      "/api/v1/projects/project_1/image-provider-configs",
      "/api/v1/projects/project_1/image-provider-configs",
      "/api/v1/projects/project_1/provider-image-generations",
      "/api/v1/projects/project_1/provider-image-generations?limit=20&cursor=0",
      "/api/v1/provider-image-generations/request_1",
      "/api/v1/provider-image-generations/request_1/tasks",
      "/api/v1/provider-image-generation-tasks/task_1/retry",
      "/api/v1/provider-image-generation-tasks/task_1/cancel",
    ]);
    expect(fetchWithUi.mock.calls.at(-1)?.[1]?.body).toBe("{}");
  });
});
