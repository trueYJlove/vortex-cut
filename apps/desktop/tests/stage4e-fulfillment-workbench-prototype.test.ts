import { describe, expect, it, vi } from "vitest";
import {
  Stage4ERequirementFulfillmentPrototype,
  type Adoption,
  type CreateFulfillmentResponse,
  type FulfillmentState,
  type FulfillmentTask,
  type PreparedFulfillment,
  type Requirement,
  type Stage4EFulfillmentApi,
} from "../../../tools/prototypes/stage4e_requirement_fulfillment_workbench_model.js";

const SECRET_PROMPT = "SENTINEL_PROMPT_DO_NOT_LEAK";
const PATH_SENTINEL = "C:\\private\\media\\secret.png";
const RAW_ERROR = "TRACEBACK_RAW_EXCEPTION";

const requirement = (overrides: Partial<Requirement> = {}): Requirement => ({
  project_id: "project_a",
  shot_list_revision_id: "revision_a",
  shot_requirement_id: "requirement_a",
  visual_kind: "image",
  visual_source_asset_id: null,
  visual_direction: SECRET_PROMPT,
  ...overrides,
});

const prepared: PreparedFulfillment = {
  preview_id: "preview_1",
  payload_sha256: "sha256:payload",
  shot_list_revision_id: "revision_a",
  shot_requirement_id: "requirement_a",
  requirement_sha256: "sha256:requirement",
  provider_kind: "apikey_fun_images",
  adapter_id: "apikey_fun_images_sse_v1",
  model: "gpt-image-2",
  protocol_version: "1",
  size: "1024x1024",
  price_per_image: 0.1,
  price_currency: "CNY",
  expires_at: "2026-08-19T00:05:00Z",
};

const task = (status: FulfillmentTask["status"] = "queued"): FulfillmentTask => ({
  task_id: "task_1",
  request_id: "request_1",
  job_id: "job_1",
  status,
  output_asset_id: status === "succeeded" ? "asset_1" : null,
});

const adoption: Adoption = {
  adoption_id: "adoption_1",
  generation_link_id: "link_1",
  task_id: "task_1",
  asset_id: "asset_1",
  adoption_ordinal: 1,
  previous_adoption_id: null,
};

const state = (overrides: Partial<FulfillmentState> = {}): FulfillmentState => ({
  project_id: "project_a",
  shot_list_revision_id: "revision_a",
  shot_requirement_id: "requirement_a",
  requirement_sha256: "sha256:requirement",
  currently_confirmed: true,
  lifecycle: "in_progress",
  link_count: 1,
  current_adoption: null,
  current_asset_availability: null,
  ...overrides,
});

const created = (overrides: Partial<CreateFulfillmentResponse> = {}): CreateFulfillmentResponse => ({
  generation_link_id: "link_1",
  request_id: "request_1",
  task: task(),
  generation_reused: false,
  link_reused: false,
  ...overrides,
});

type MutableApi = Stage4EFulfillmentApi & {
  prepare: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  adopt: ReturnType<typeof vi.fn>;
  subscribeJob: ReturnType<typeof vi.fn>;
};

function fakeApi(overrides: Partial<Stage4EFulfillmentApi> = {}): MutableApi {
  return {
    prepare: vi.fn(async () => prepared),
    create: vi.fn(async () => created()),
    getState: vi.fn(async () => state()),
    adopt: vi.fn(async () => ({ adoption, reused: false })),
    subscribeJob: vi.fn(() => () => undefined),
    providerCalls: 0,
    timelineWrites: 0,
    previewRequests: 0,
    renderRequests: 0,
    exportRequests: 0,
    batchRequests: 0,
    ...overrides,
  } as MutableApi;
}

function opened(api = fakeApi(), item = requirement()) {
  const model = new Stage4ERequirementFulfillmentPrototype(api);
  model.open("project_a", item.shot_list_revision_id, "revision_a", [item]);
  model.selectRequirement(item.shot_requirement_id);
  return { model, api };
}

describe("Stage 4E Requirement fulfillment workbench prototype", () => {
  it("当前 confirmed image Requirement 可编辑，历史 Revision 与 existing_media 只读", () => {
    const current = opened();
    expect(current.model.canGenerate()).toBe(true);
    current.model.setPrompt("edited prompt");

    const historical = opened(fakeApi(), requirement({ shot_list_revision_id: "revision_old" }));
    expect(historical.model.isReadOnly()).toBe(true);
    expect(() => historical.model.setPrompt("x")).toThrow("REQUIREMENT_NOT_ELIGIBLE");

    const media = opened(fakeApi(), requirement({ visual_kind: "existing_media", visual_source_asset_id: "asset_source" }));
    expect(media.model.canGenerate()).toBe(false);
    expect(() => media.model.setPrompt("x")).toThrow("REQUIREMENT_NOT_ELIGIBLE");
  });

  it("Prepare 确认摘要不含 Prompt，编辑后确认失效", async () => {
    const { model, api } = opened();
    await model.prepare("config_1");
    const confirmation = model.confirmation();
    expect(confirmation).toMatchObject({ provider_kind: "apikey_fun_images", model: "gpt-image-2", size: "1024x1024", price_per_image: 0.1 });
    expect(JSON.stringify(confirmation)).not.toContain(SECRET_PROMPT);
    expect(api.providerCalls).toBe(0);
    model.setPrompt("changed after prepare");
    expect(model.confirmation()).toBeNull();
    await expect(model.create(true)).rejects.toThrow("PREPARE_REQUIRED");
  });

  it("Create 必须显式确认并展示 fresh/reused 标识", async () => {
    const api = fakeApi({ create: vi.fn(async () => created({ generation_reused: true, link_reused: true })) });
    const { model } = opened(api);
    await model.prepare("config_1");
    await expect(model.create(false)).rejects.toThrow("CONFIRMATION_REQUIRED");
    await model.create(true);
    expect(model.createResult).toMatchObject({ generation_reused: true, link_reused: true });
    expect(api.subscribeJob).toHaveBeenCalledWith("job_1", expect.any(Function));
  });

  it("Job 事件只触发权威 state 回读，succeeded 映射 review_required", async () => {
    let listener: (() => void) | undefined;
    const api = fakeApi({
      subscribeJob: vi.fn((_jobId: string, callback: () => void) => { listener = callback; return () => undefined; }),
      getState: vi.fn(async () => state({ lifecycle: "review_required" })),
    });
    const { model } = opened(api);
    await model.prepare("config_1");
    await model.create(true);
    const callsBefore = api.getState.mock.calls.length;
    listener?.();
    await vi.waitFor(() => expect(api.getState.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(model.state?.lifecycle).toBe("review_required");
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("Adopt 必须显式确认，stale CAS 后刷新且不自动重发", async () => {
    let currentState = state({ lifecycle: "review_required" });
    const api = fakeApi({
      getState: vi.fn(async () => currentState),
      adopt: vi.fn(async () => { currentState = state({ lifecycle: "adopted", current_adoption: adoption, current_asset_availability: "available" }); throw new Error("ADOPTION_CONFLICT"); }),
    });
    const { model } = opened(api);
    await model.refreshState();
    model.beginAdopt("link_1", task("succeeded"));
    expect(model.adoptionConfirmation()).toMatchObject({ asset_id: "asset_1", expected_current_adoption_id: null });
    await expect(model.adopt(false)).rejects.toThrow("ADOPTION_CONFIRMATION_REQUIRED");
    await model.adopt(true);
    expect(api.adopt).toHaveBeenCalledTimes(1);
    expect(api.getState.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(model.state?.current_adoption?.adoption_id).toBe("adoption_1");
    expect(JSON.stringify(model.safeEvidence())).not.toContain(RAW_ERROR);
  });

  it("adopted_unavailable 保留当前 adoption 历史", async () => {
    const api = fakeApi({ getState: vi.fn(async () => state({ lifecycle: "adopted_unavailable", current_adoption: adoption, current_asset_availability: "missing" })) });
    const { model } = opened(api);
    await model.refreshState();
    expect(model.state).toMatchObject({ lifecycle: "adopted_unavailable", current_adoption: adoption, current_asset_availability: "missing" });
  });

  it("项目或 Revision 切换丢弃迟到响应并停止旧订阅", async () => {
    let resolveOld!: (value: FulfillmentState) => void;
    const late = new Promise<FulfillmentState>(resolve => { resolveOld = resolve; });
    const stop = vi.fn();
    const api = fakeApi({
      getState: vi.fn(async () => late),
      subscribeJob: vi.fn(() => stop),
    });
    const { model } = opened(api);
    const loading = model.refreshState();
    model.open("project_b", "revision_b", "revision_b", [requirement({ project_id: "project_b", shot_list_revision_id: "revision_b", shot_requirement_id: "requirement_b" })]);
    resolveOld(state());
    await loading;
    expect(model.state).toBeNull();
    expect(model.safeEvidence()).toMatchObject({ revision_id: "revision_b", selected_requirement_id: null });
  });

  it("安全证据不含 Prompt、路径、secret 或原始异常", async () => {
    const api = fakeApi({ prepare: vi.fn(async () => { throw new Error(`${RAW_ERROR} ${PATH_SENTINEL} ${SECRET_PROMPT}`); }) });
    const { model } = opened(api);
    await model.prepare("config_1");
    const evidence = JSON.stringify(model.safeEvidence());
    expect(evidence).toContain("操作未完成，请刷新后重试。");
    expect(evidence).not.toContain(SECRET_PROMPT);
    expect(evidence).not.toContain(PATH_SENTINEL);
    expect(evidence).not.toContain(RAW_ERROR);
  });

  it("不产生 Timeline/Preview/Render/Export/Batch 操作且 Provider=0", async () => {
    const { model, api } = opened();
    await model.prepare("config_1");
    await model.create(true);
    expect(model.safeEvidence()).toMatchObject({ provider_call_count: 0, forbidden_side_effect_count: 0 });
    expect(api.providerCalls).toBe(0);
    expect(api.timelineWrites + api.previewRequests + api.renderRequests + api.exportRequests + api.batchRequests).toBe(0);
  });
});

