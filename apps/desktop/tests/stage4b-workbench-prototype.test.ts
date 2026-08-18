import { describe, expect, it, vi } from "vitest";
import {
  Stage4BWorkbenchPrototype,
  type CreateResponse,
  type GenerationDraft,
  type PreparedRequest,
  type RequestRecord,
  type TaskRecord,
  type WorkbenchDesktopApi,
} from "../../../tools/prototypes/stage4b_generation_workbench_model.js";

const SECRET_PROMPT = "S4B_PROMPT_SENTINEL_不要持久化";
const PATH_SENTINEL = "C:\\private\\media\\secret.mp4";
const RAW_ERROR_SENTINEL = "RAW_STACK_TOKEN_SHOULD_NOT_ESCAPE";

const imageDraft = (prompt = SECRET_PROMPT): GenerationDraft => ({
  generation_kind: "image",
  prompt,
  input_refs: ["asset_current"],
  parameters: { width: 1024, height: 1024, seed: 7 },
});

const prepared: PreparedRequest = {
  schema_version: 1,
  project_id: "project_a",
  generation_kind: "image",
  execution_mode: "simulation_only",
  prompt_sha256: "sha256:prompt",
  input_refs: ["asset_current"],
  parameters: { width: 1024, height: 1024, seed: 7 },
  request_sha256: "sha256:request",
};

const request: RequestRecord = {
  request_id: "request_1",
  project_id: "project_a",
  generation_kind: "image",
  execution_mode: "simulation_only",
  prompt_sha256: "sha256:prompt",
  input_refs: ["asset_current"],
  parameters: { width: 1024, height: 1024, seed: 7 },
  request_sha256: "sha256:request",
  created_at: "2026-08-18T00:00:00Z",
};

const task = (status: TaskRecord["status"], attempt = 1, id = `task_${attempt}`): TaskRecord => ({
  task_id: id,
  request_id: "request_1",
  job_id: `job_${attempt}`,
  attempt,
  status,
  stage: status === "succeeded" ? "completed" : status,
  retry_of_task_id: attempt === 1 ? null : "task_1",
  output_asset_id: null,
  output_sha256: null,
  result_summary: status === "succeeded" ? {
    execution_mode: "simulation_only",
    outcome: "validated_without_media",
    provider_call_count: 0,
  } : null,
  error: ["failed", "cancelled", "interrupted"].includes(status) ? { code: `GENERATION_${status.toUpperCase()}`, message: "安全摘要" } : null,
});

function fakeApi(overrides: Partial<WorkbenchDesktopApi> = {}): WorkbenchDesktopApi & {
  providerCalls: number;
  mediaWrites: number;
  assetRegistrations: number;
} {
  const base = {
    providerCalls: 0,
    mediaWrites: 0,
    assetRegistrations: 0,
    prepare: vi.fn(async () => prepared),
    create: vi.fn(async (): Promise<CreateResponse> => ({ request, task: task("succeeded"), reused: false })),
    listRequests: vi.fn(async () => ({ items: [request], next_cursor: null })),
    listTasks: vi.fn(async () => ({ items: [task("succeeded")], next_cursor: null })),
    cancel: vi.fn(async () => task("cancelled")),
    retry: vi.fn(async () => task("queued", 2)),
    subscribeJob: vi.fn(() => vi.fn()),
  };
  return Object.assign(base, overrides);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Stage 4B 隔离工作台模型", () => {
  it("prepare 只产生安全确认摘要，字段变化立即使确认失效", async () => {
    const api = fakeApi();
    const model = new Stage4BWorkbenchPrototype(api);
    model.open("project_a", ["asset_current"]);
    model.setDraft(imageDraft());
    await model.prepare();

    const confirmation = model.confirmation();
    expect(confirmation).toMatchObject({
      generation_kind: "image",
      execution_mode: "simulation_only",
      prompt_character_count: SECRET_PROMPT.length,
      prompt_sha256: "sha256:prompt",
      input_ref_count: 1,
      provider_call_count: 0,
    });
    expect(JSON.stringify(confirmation)).not.toContain(SECRET_PROMPT);

    model.setDraft({ generation_kind: "image", prompt: SECRET_PROMPT, input_refs: ["asset_current"], parameters: { width: 512, height: 512 } });
    expect(model.confirmation()).toBeNull();
    await expect(model.create()).rejects.toThrow("CONFIRMATION_REQUIRED");
  });

  it("create 使用原确认命令，成功后清除 Prompt 并立即回读快速终态", async () => {
    const api = fakeApi();
    const model = new Stage4BWorkbenchPrototype(api);
    model.open("project_a", ["asset_current"]);
    model.setDraft(imageDraft());
    await model.prepare();
    await model.create();

    expect(api.create).toHaveBeenCalledWith("project_a", expect.objectContaining({
      prompt: SECRET_PROMPT,
      request_sha256: "sha256:request",
    }));
    expect(api.listTasks).toHaveBeenCalledWith("request_1");
    expect(api.subscribeJob).not.toHaveBeenCalled();
    const evidence = JSON.stringify(model.safeEvidence());
    expect(evidence).toContain('"provider_call_count":0');
    expect(evidence).toContain('"media_created":false');
    expect(evidence).not.toContain(SECRET_PROMPT);
    expect(evidence).not.toContain(PATH_SENTINEL);
  });

  it("任务在订阅前完成时，通过订阅后的第二次回读得到终态", async () => {
    const snapshots = [[task("running")], [task("succeeded")]];
    const api = fakeApi({
      create: vi.fn(async () => ({ request, task: task("queued"), reused: false })),
      listTasks: vi.fn(async () => ({ items: snapshots.shift() ?? [task("succeeded")], next_cursor: null })),
    });
    const model = new Stage4BWorkbenchPrototype(api);
    model.open("project_a", ["asset_current"]);
    model.setDraft(imageDraft());
    await model.prepare();
    await model.create();

    expect(api.listTasks).toHaveBeenCalledTimes(2);
    expect(api.subscribeJob).toHaveBeenCalledWith("job_1", expect.any(Function));
    expect(model.tasks[0]?.status).toBe("succeeded");
  });

  it("Job 事件只触发 Task 权威回读，不直接写 Task 状态", async () => {
    let listener: (() => void) | undefined;
    let status: TaskRecord["status"] = "running";
    const api = fakeApi({
      create: vi.fn(async () => ({ request, task: task("running"), reused: false })),
      listTasks: vi.fn(async () => ({ items: [task(status)], next_cursor: null })),
      subscribeJob: vi.fn((_job, callback) => { listener = callback; return vi.fn(); }),
    });
    const model = new Stage4BWorkbenchPrototype(api);
    model.open("project_a", ["asset_current"]);
    model.setDraft(imageDraft());
    await model.prepare();
    await model.create();
    expect(model.tasks[0]?.status).toBe("running");

    status = "succeeded";
    listener?.();
    await flush();
    expect(model.tasks[0]?.status).toBe("succeeded");
    expect(api.listTasks).toHaveBeenCalledTimes(3);
  });

  it("cancel 与 retry 只在冻结状态集合可用，并保留新 attempt", async () => {
    let current = [task("running")];
    const api = fakeApi({
      listTasks: vi.fn(async () => ({ items: current, next_cursor: null })),
      cancel: vi.fn(async () => { current = [task("cancelled")]; return current[0]!; }),
      retry: vi.fn(async () => {
        current = [task("cancelled"), task("queued", 2)];
        return current[1]!;
      }),
    });
    const model = new Stage4BWorkbenchPrototype(api);
    model.open("project_a", ["asset_current"]);
    await model.selectRequest("request_1");
    await model.cancel("task_1");
    expect(model.tasks[0]?.status).toBe("cancelled");
    await expect(model.cancel("task_1")).rejects.toThrow("CANCEL_NOT_ALLOWED");

    await model.retry("task_1");
    expect(model.tasks.map(item => item.attempt)).toEqual([1, 2]);
    expect(model.tasks[1]?.retry_of_task_id).toBe("task_1");
    await expect(model.retry("task_2")).rejects.toThrow("RETRY_NOT_ALLOWED");
  });

  it("项目切换丢弃旧项目迟到响应，并清除 Prompt 与订阅", async () => {
    let resolveOld!: (value: { items: RequestRecord[]; next_cursor: null }) => void;
    const oldPage = new Promise<{ items: RequestRecord[]; next_cursor: null }>(resolve => { resolveOld = resolve; });
    const stop = vi.fn();
    const api = fakeApi({
      listRequests: vi.fn(async projectId => projectId === "project_a" ? oldPage : { items: [], next_cursor: null }),
      listTasks: vi.fn(async () => ({ items: [task("running")], next_cursor: null })),
      subscribeJob: vi.fn(() => stop),
      create: vi.fn(async () => ({ request, task: task("running"), reused: false })),
    });
    const model = new Stage4BWorkbenchPrototype(api);
    model.open("project_a", ["asset_current"]);
    model.setDraft(imageDraft());
    await model.prepare();
    const loading = model.loadHistory();
    await model.create();

    model.switchProject("project_b", ["asset_b"]);
    resolveOld({ items: [request], next_cursor: null });
    await loading;

    expect(model.requests).toEqual([]);
    expect(stop).toHaveBeenCalled();
    expect(JSON.stringify(model.safeEvidence())).not.toContain(SECRET_PROMPT);
    expect(() => model.setDraft({ ...imageDraft(), input_refs: ["asset_current"] })).toThrow("CROSS_PROJECT_INPUT_REF");
  });

  it("原始异常、绝对路径和 Prompt sentinel 不进入安全证据", async () => {
    const api = fakeApi({
      prepare: vi.fn(async () => { throw new Error(`${RAW_ERROR_SENTINEL} ${PATH_SENTINEL} ${SECRET_PROMPT}`); }),
    });
    const model = new Stage4BWorkbenchPrototype(api);
    model.open("project_a", ["asset_current"]);
    model.setDraft(imageDraft());
    await model.prepare();

    const evidence = JSON.stringify(model.safeEvidence());
    expect(evidence).toContain("操作未完成，请刷新后重试。");
    expect(evidence).not.toContain(RAW_ERROR_SENTINEL);
    expect(evidence).not.toContain(PATH_SENTINEL);
    expect(evidence).not.toContain(SECRET_PROMPT);
  });

  it("Provider、媒体写入和 Asset 注册调用计数始终为零", async () => {
    const api = fakeApi();
    const model = new Stage4BWorkbenchPrototype(api);
    model.open("project_a", ["asset_current"]);
    model.setDraft(imageDraft("合成测试指令"));
    await model.prepare();
    await model.create();
    await model.loadHistory();

    expect(api.providerCalls).toBe(0);
    expect(api.mediaWrites).toBe(0);
    expect(api.assetRegistrations).toBe(0);
  });
});
