import { describe, expect, it, vi } from "vitest";
import { registerStage4eIpc } from "../electron/main/stage4e-ipc.js";

const now = "2026-08-20T00:00:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
const provider = {
  provider_config_id: "image_provider_1", provider_kind: "apikey_fun_images",
  adapter_id: "apikey_fun_images_sse_v1", model: "gpt-image-2",
};
const preview = {
  preview_id: "fulfillment_preview_1", project_id: "project_1", shot_list_revision_id: "revision_1",
  shot_requirement_id: "requirement_1", requirement_sha256: hashA, fulfillment_payload_sha256: hashB,
  execution_mode: "provider_image_v1", prompt_sha256: hashA, size: "1024x1024", output_format: "png",
  image_count: 1, provider, estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K", expires_at: now,
};
const link = {
  link_id: "link_1", project_id: "project_1", shot_list_revision_id: "revision_1",
  shot_requirement_id: "requirement_1", request_id: "request_1", requirement_sha256: hashA, created_at: now,
};
const adoption = {
  adoption_id: "adoption_1", project_id: "project_1", shot_list_revision_id: "revision_1",
  shot_requirement_id: "requirement_1", generation_link_id: "link_1", task_id: "task_1",
  asset_id: "asset_1", adoption_ordinal: 1, previous_adoption_id: null, created_at: now,
};
const state = {
  project_id: "project_1", shot_list_revision_id: "revision_1", shot_requirement_id: "requirement_1",
  requirement_sha256: hashA, currently_confirmed: true, lifecycle: "unstarted", link_count: 0,
  current_adoption: null, current_asset_availability: null,
};
const request = {
  request_id: "request_1", project_id: "project_1", generation_kind: "image", execution_mode: "provider_image_v1",
  prompt_sha256: hashA, parameters: { size: "1024x1024" }, request_sha256: hashB, created_at: now,
};
const task = {
  task_id: "task_1", request_id: "request_1", job_id: "job_1", attempt: 1, status: "queued", stage: "queued",
  retry_of_task_id: null, provider_call_count: 0, provider_may_have_processed: false,
  estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K", output_asset_id: null,
  output_sha256: null, result_summary: null, error: null, created_at: now, updated_at: now, finished_at: null,
};

type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
function setup() {
  const handlers = new Map<string, Handler>();
  const fetchWithUi = vi.fn();
  registerStage4eIpc({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    fetchWithUi,
  });
  return { handlers, fetchWithUi };
}

describe("Stage 4E Shot Requirement Image Fulfillment IPC", () => {
  it("只注册六个独立白名单 channel", () => {
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual([
      "shot-requirement-image-fulfillment:get",
      "shot-requirement-image-fulfillment:list-links",
      "shot-requirement-image-fulfillment:list-adoptions",
      "shot-requirement-image-fulfillment:prepare",
      "shot-requirement-image-fulfillment:create",
      "shot-requirement-image-fulfillment:adopt",
    ]);
  });

  it("覆盖六条固定路由、分页及请求体", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi
      .mockResolvedValueOnce(state)
      .mockResolvedValueOnce({ items: [link], next_cursor: null })
      .mockResolvedValueOnce({ items: [adoption], next_cursor: null })
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ link, request, task, generation_reused: false, link_reused: false })
      .mockResolvedValueOnce({ adoption, reused: false });
    const identity = { project_id: "project_1", requirement_id: "requirement_1" };
    await handlers.get("shot-requirement-image-fulfillment:get")?.({}, identity);
    await handlers.get("shot-requirement-image-fulfillment:list-links")?.({}, { ...identity, limit: 20, cursor: "0" });
    await handlers.get("shot-requirement-image-fulfillment:list-adoptions")?.({}, identity);
    await handlers.get("shot-requirement-image-fulfillment:prepare")?.({}, { ...identity, request: { expected_confirmed_revision_id: "revision_1", provider_config_id: "image_provider_1", prompt: "仅进入准备请求" } });
    await handlers.get("shot-requirement-image-fulfillment:create")?.({}, { ...identity, request: { preview_id: "fulfillment_preview_1", fulfillment_payload_sha256: hashB, expected_confirmed_revision_id: "revision_1", confirmed: true } });
    await handlers.get("shot-requirement-image-fulfillment:adopt")?.({}, { ...identity, request: { generation_link_id: "link_1", task_id: "task_1", asset_id: "asset_1", expected_current_adoption_id: null, confirmed: true } });
    expect(fetchWithUi.mock.calls.map(call => call[0])).toEqual([
      "/api/v1/projects/project_1/shot-requirements/requirement_1/image-fulfillment",
      "/api/v1/projects/project_1/shot-requirements/requirement_1/image-fulfillment/links?limit=20&cursor=0",
      "/api/v1/projects/project_1/shot-requirements/requirement_1/image-fulfillment/adoptions",
      "/api/v1/projects/project_1/shot-requirements/requirement_1/image-fulfillment/prepare",
      "/api/v1/projects/project_1/shot-requirements/requirement_1/image-fulfillment/create",
      "/api/v1/projects/project_1/shot-requirements/requirement_1/image-fulfillment/adopt",
    ]);
    expect(JSON.parse(String(fetchWithUi.mock.calls[3][1].body))).toHaveProperty("prompt", "仅进入准备请求");
    expect(fetchWithUi.mock.calls.slice(4).map(call => String(call[1].body))).not.toContain("仅进入准备请求");
  });

  it("严格拒绝未知键、非法 ID、分页和把 Prompt 带入非 Prepare 输入", async () => {
    const { handlers, fetchWithUi } = setup();
    await expect(handlers.get("shot-requirement-image-fulfillment:get")?.({}, { project_id: "project_1", requirement_id: "requirement_1", extra: true })).rejects.toThrow();
    await expect(handlers.get("shot-requirement-image-fulfillment:get")?.({}, { project_id: "../private", requirement_id: "requirement_1" })).rejects.toThrow("Invalid project_id");
    await expect(handlers.get("shot-requirement-image-fulfillment:list-links")?.({}, { project_id: "project_1", requirement_id: "requirement_1", limit: 101 })).rejects.toThrow("Invalid limit");
    await expect(handlers.get("shot-requirement-image-fulfillment:list-adoptions")?.({}, { project_id: "project_1", requirement_id: "requirement_1", cursor: "../private" })).rejects.toThrow("Invalid cursor");
    await expect(handlers.get("shot-requirement-image-fulfillment:create")?.({}, { project_id: "project_1", requirement_id: "requirement_1", request: { preview_id: "fulfillment_preview_1", fulfillment_payload_sha256: hashB, expected_confirmed_revision_id: "revision_1", confirmed: true, prompt: "forbidden" } })).rejects.toThrow();
    expect(fetchWithUi).not.toHaveBeenCalled();
  });

  it("响应递归清理敏感字段，Core 原始异常仅投影为白名单错误", async () => {
    const { handlers, fetchWithUi } = setup();
    const sentinel = "PROMPT_NEVER_RENDER";
    fetchWithUi.mockResolvedValueOnce({ ...preview, prompt: sentinel, absolute_path: "C:\\private\\image.png", raw_response: "private" });
    const result = await handlers.get("shot-requirement-image-fulfillment:prepare")?.({}, {
      project_id: "project_1", requirement_id: "requirement_1",
      request: { expected_confirmed_revision_id: "revision_1", provider_config_id: "image_provider_1", prompt: sentinel },
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain("private");

    fetchWithUi.mockRejectedValueOnce(Object.assign(new Error("raw provider payload"), { code: "SHOT_REQUIREMENT_IMAGE_ADOPTION_CONFLICT" }));
    await expect(handlers.get("shot-requirement-image-fulfillment:get")?.({}, { project_id: "project_1", requirement_id: "requirement_1" })).rejects.toThrow("SHOT_REQUIREMENT_IMAGE_ADOPTION_CONFLICT");
    fetchWithUi.mockRejectedValueOnce(new Error("raw provider payload"));
    await expect(handlers.get("shot-requirement-image-fulfillment:get")?.({}, { project_id: "project_1", requirement_id: "requirement_1" })).rejects.toThrow("Core request failed");
  });
});
