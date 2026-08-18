import { describe, expect, it, vi } from "vitest";
import { registerStage4Ipc } from "../electron/main/stage4-ipc.js";

const now = "2026-08-18T00:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;
const prepared = { schema_version: 1, project_id: "project_1", generation_kind: "image", execution_mode: "simulation_only", prompt_sha256: hash, input_refs: ["asset_1"], parameters: { width: 1024, height: 1024 }, request_sha256: hash };
const request = { request_id: "generation_request_1", ...prepared, schema_version: undefined, created_at: now } as Record<string, unknown>;
delete request.schema_version;
const task = { task_id: "generation_task_1", request_id: "generation_request_1", job_id: "job_1", attempt: 1, status: "queued", stage: "queued", retry_of_task_id: null, output_asset_id: null, output_sha256: null, result_summary: null, error: null, created_at: now, updated_at: now, finished_at: null };

type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
function setup() {
  const handlers = new Map<string, Handler>();
  const fetchWithUi = vi.fn();
  registerStage4Ipc({ ipc: { handle: (channel, listener) => handlers.set(channel, listener) }, fetchWithUi });
  return { handlers, fetchWithUi };
}

describe("Stage 4A Media Generation IPC", () => {
  it("只注册七个固定白名单 channel", () => {
    expect([...setup().handlers.keys()]).toEqual([
      "media-generation:prepare", "media-generation:create", "media-generation:list",
      "media-generation:get", "media-generation:tasks", "media-generation:retry", "media-generation:cancel"
    ]);
  });

  it("允许命令瞬时携带 Prompt，但响应清理 Prompt、路径、正文与原始异常", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValue({ ...prepared, prompt: "response-secret", absolute_path: "private", transcript: "private", stderr: "private", traceback: "private" });
    const command = { generation_kind: "image", prompt: "input-only", input_refs: ["asset_1"], parameters: { width: 1024, height: 1024 } };
    const result = await handlers.get("media-generation:prepare")?.({}, { project_id: "project_1", request: command });
    expect(fetchWithUi).toHaveBeenCalledWith("/api/v1/projects/project_1/media-generation-requests/prepare", { method: "POST", body: JSON.stringify(command) });
    expect(JSON.stringify(result)).not.toContain("response-secret");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("严格校验命令字段、ID 与分页，不触发非冻结调用", async () => {
    const { handlers, fetchWithUi } = setup();
    const command = { generation_kind: "image", prompt: "p", input_refs: ["asset_1"], parameters: { width: 1024, height: 1024 } };
    await expect(handlers.get("media-generation:prepare")?.({}, { project_id: "project_1", request: command, extra: true })).rejects.toThrow();
    await expect(handlers.get("media-generation:prepare")?.({}, { project_id: "../private", request: command })).rejects.toThrow("Invalid project_id");
    await expect(handlers.get("media-generation:prepare")?.({}, { project_id: "project_1", request: { ...command, generation_kind: "video" } })).rejects.toThrow();
    await expect(handlers.get("media-generation:list")?.({}, { project_id: "project_1", limit: 101 })).rejects.toThrow("Invalid limit");
    await expect(handlers.get("media-generation:tasks")?.({}, { request_id: "generation_request_1", cursor: "../private" })).rejects.toThrow("Invalid cursor");
    expect(fetchWithUi).not.toHaveBeenCalled();
  });

  it("覆盖列表、读取、重试与取消，并为终端动作发送严格空对象", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi
      .mockResolvedValueOnce({ items: [request], next_cursor: null })
      .mockResolvedValueOnce(request)
      .mockResolvedValueOnce({ items: [task], next_cursor: null })
      .mockResolvedValueOnce({ ...task, attempt: 2, task_id: "generation_task_2", job_id: "job_2", retry_of_task_id: "generation_task_1" })
      .mockResolvedValueOnce({ ...task, status: "cancelled", stage: "cancelled", finished_at: now });
    await handlers.get("media-generation:list")?.({}, { project_id: "project_1", limit: 20, cursor: "0" });
    await handlers.get("media-generation:get")?.({}, "generation_request_1");
    await handlers.get("media-generation:tasks")?.({}, { request_id: "generation_request_1" });
    await handlers.get("media-generation:retry")?.({}, "generation_task_1");
    await handlers.get("media-generation:cancel")?.({}, "generation_task_1");
    expect(fetchWithUi.mock.calls.map(call => call[0])).toEqual([
      "/api/v1/projects/project_1/media-generation-requests?limit=20&cursor=0",
      "/api/v1/media-generation-requests/generation_request_1",
      "/api/v1/media-generation-requests/generation_request_1/tasks",
      "/api/v1/media-generation-tasks/generation_task_1/retry",
      "/api/v1/media-generation-tasks/generation_task_1/cancel"
    ]);
    expect(fetchWithUi.mock.calls.slice(3).map(call => call[1]?.body)).toEqual(["{}", "{}"]);
  });
});
