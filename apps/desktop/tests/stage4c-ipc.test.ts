import { describe, expect, it, vi } from "vitest";
import { registerStage4cIpc } from "../electron/main/stage4c-ipc.js";

const now = "2026-08-18T00:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;
const requirement = {
  shot_requirement_id: "requirement_1", shot_list_revision_id: "revision_1", ordinal: 0,
  title: "镜头一", visual_direction: "固定机位", target_duration_us: 3_000_000,
  visual: { requirement_kind: "image", source_asset_id: null }, narration: null,
};
const summary = {
  schema_version: 1, shot_list_revision_id: "revision_1", shot_list_id: "shot_list_1", project_id: "project_1",
  parent_revision_id: null, title: "镜头清单", requirement_count: 1, document_sha256: hash, created_at: now,
};
const detail = {
  ...summary, shot_list_revision_id: "revision_1", shot_list_id: "shot_list_1", project_id: "project_1",
  parent_revision_id: null, title: "镜头清单", requirement_count: 1, document_sha256: hash, created_at: now,
  summary: "人工摘要", requirements: [requirement],
};
const state = { shot_list_id: "shot_list_1", project_id: "project_1", lifecycle: "drafted", current_revision: detail, confirmed_revision: null };
const createInput = { schema_version: 1, base_revision_id: null, title: "镜头清单", summary: "人工摘要", requirements: [{ title: "镜头一", visual_direction: "固定机位", target_duration_us: 3_000_000, visual: { requirement_kind: "image", source_asset_id: null }, narration: null }] };

type Handler = (_event: unknown, value?: unknown) => Promise<unknown> | unknown;
function setup() {
  const handlers = new Map<string, Handler>();
  const fetchWithUi = vi.fn();
  registerStage4cIpc({ ipc: { handle: (channel, listener) => handlers.set(channel, listener) }, fetchWithUi });
  return { handlers, fetchWithUi };
}

describe("Stage 4C Shot List IPC", () => {
  it("只注册五个固定白名单 channel", () => {
    expect([...setup().handlers.keys()]).toEqual(["shot-list:get", "shot-list:revisions", "shot-list:revision:get", "shot-list:revision:create", "shot-list:confirm"]);
  });

  it("固定路由状态、分页与详情读取，并严格校验 ID/分页", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce(state).mockResolvedValueOnce({ items: [summary], next_cursor: null }).mockResolvedValueOnce(detail);
    await handlers.get("shot-list:get")?.({}, "project_1");
    await handlers.get("shot-list:revisions")?.({}, { project_id: "project_1", limit: 20, cursor: "0" });
    await handlers.get("shot-list:revision:get")?.({}, "revision_1");
    expect(fetchWithUi.mock.calls.map(call => call[0])).toEqual([
      "/api/v1/projects/project_1/shot-list",
      "/api/v1/projects/project_1/shot-list/revisions?limit=20&cursor=0",
      "/api/v1/shot-list-revisions/revision_1",
    ]);
    await expect(handlers.get("shot-list:get")?.({}, "../private")).rejects.toThrow("Invalid project_id");
    await expect(handlers.get("shot-list:revisions")?.({}, { project_id: "project_1", limit: 101 })).rejects.toThrow("Invalid limit");
    await expect(handlers.get("shot-list:revisions")?.({}, { project_id: "project_1", cursor: "../private" })).rejects.toThrow("Invalid cursor");
  });

  it("保存与确认只发送 exact DTO，拒绝未知、敏感与非法组合", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValueOnce({ revision: detail, state, reused: false }).mockResolvedValueOnce({ state: { ...state, lifecycle: "confirmed", confirmed_revision: summary }, reused: false });
    await handlers.get("shot-list:revision:create")?.({}, { project_id: "project_1", revision: createInput });
    await handlers.get("shot-list:confirm")?.({}, { project_id: "project_1", confirmation: { revision_id: "revision_1", expected_current_revision_id: "revision_1" } });
    expect(fetchWithUi.mock.calls.map(call => call[0])).toEqual([
      "/api/v1/projects/project_1/shot-list/revisions", "/api/v1/projects/project_1/shot-list/confirm",
    ]);
    expect(fetchWithUi.mock.calls.map(call => call[1]?.method)).toEqual(["POST", "POST"]);
    await expect(handlers.get("shot-list:revision:create")?.({}, { project_id: "project_1", revision: { ...createInput, payload: "x" } })).rejects.toThrow();
    await expect(handlers.get("shot-list:revision:create")?.({}, { project_id: "project_1", revision: { ...createInput, requirements: [{ ...createInput.requirements[0], visual: { requirement_kind: "image", source_asset_id: "asset_1" } }] } })).rejects.toThrow();
    await expect(handlers.get("shot-list:confirm")?.({}, { project_id: "project_1", confirmation: { revision_id: "revision_1", expected_current_revision_id: "revision_1" }, extra: true })).rejects.toThrow();
  });

  it("只向 Renderer 透传固定 Shot List 错误码，隐藏其他异常", async () => {
    const conflict = setup();
    conflict.fetchWithUi.mockRejectedValue(Object.assign(new Error("private conflict detail"), { code: "SHOT_LIST_CONFLICT" }));
    await expect(conflict.handlers.get("shot-list:revision:create")?.({}, { project_id: "project_1", revision: createInput })).rejects.toThrow("SHOT_LIST_CONFLICT");
    const unknown = setup();
    unknown.fetchWithUi.mockRejectedValue(Object.assign(new Error("private failure"), { code: "UNEXPECTED_PRIVATE_CODE" }));
    await expect(unknown.handlers.get("shot-list:revision:create")?.({}, { project_id: "project_1", revision: createInput })).rejects.toThrow("Core request failed");
  });
  it("响应 fail-closed，不向 Renderer 透出路径、Provider 字段或未知字段", async () => {
    const { handlers, fetchWithUi } = setup();
    fetchWithUi.mockResolvedValue({ ...detail, absolute_path: "private" });
    await handlers.get("shot-list:revision:get")?.({}, "revision_1");
    fetchWithUi.mockResolvedValue({ ...detail, provider: "forbidden" });
    await expect(handlers.get("shot-list:revision:get")?.({}, "revision_1")).rejects.toThrow();
  });
});
