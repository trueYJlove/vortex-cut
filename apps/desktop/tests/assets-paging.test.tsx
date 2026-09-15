/** GAP-LIST-ASSETS-PAGING 验收（2026-09-15 缺陷批 W3）：loadProjectData 跟随
 *  next_cursor 翻页装载全部素材——旧实现只取 Core 默认 limit=50 第一页，
 *  第 51+ 素材无 media ticket（合成预览回退 "no ticket for asset_..."，
 *  刷新素材库不可恢复）。App 级渲染断言素材库含跨页条目。 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../electron/preload/index.js";
import { buildDesktopApi } from "./fixtures/desktop-api-factory.js";

const now = "2026-08-11T00:00:00.000Z";
const project = { project_id: "project_1" as never, name: "分页项目", status: "active" as const, canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 }, root_dir_name: "Demo", current_timeline_revision_id: "revision_1", created_at: now, updated_at: now, last_opened_at: now };
const makeAsset = (ordinal: number) => ({ asset_id: `asset_${ordinal}` as never, project_id: project.project_id, kind: "video" as const, storage_mode: "external" as const, display_name: `素材-${String(ordinal).padStart(3, "0")}.mp4`, fingerprint: "a".repeat(64), size_bytes: 10, modified_at: now, availability: "available" as const, media_info: { duration_us: 5_000_000 }, created_at: now, updated_at: now });

describe("W3 GAP-LIST-ASSETS-PAGING：分页装载", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { cleanup(); delete (window as { desktop?: unknown }).desktop; });

  it("三页（cursor 链）素材全部装载进素材库", async () => {
    const pages = [
      { items: [1, 2].map(n => ({ asset: makeAsset(n), media_url: `aivideo://media/${n}` })), next_cursor: "c1" },
      { items: [3, 4].map(n => ({ asset: makeAsset(n), media_url: `aivideo://media/${n}` })), next_cursor: "c2" },
      { items: [5].map(n => ({ asset: makeAsset(n), media_url: `aivideo://media/${n}` })), next_cursor: null },
    ];
    let call = 0;
    const api = buildDesktopApi({
      overrides: {
        listAssets: vi.fn(async (input: { cursor?: string }) => {
          const page = call === 0 ? pages[0] : input.cursor === "c1" ? pages[1] : input.cursor === "c2" ? pages[2] : pages[2];
          call += 1;
          return page;
        }),
        getTimeline: vi.fn().mockRejectedValue(new Error("TIMELINE_NOT_FOUND 404")),
      },
    });
    (window as { desktop?: DesktopApi }).desktop = api;
    const { App } = await import("../src/app/App.js");
    render(<App />);
    // 5 条素材全部出现在素材库列表（跨 3 页）
    await waitFor(() => expect(screen.getByText("素材-005.mp4")).toBeTruthy());
    expect(screen.getByText("素材-001.mp4")).toBeTruthy();
    expect(screen.getByText("素材-003.mp4")).toBeTruthy();
    // 分页请求按 cursor 链发起
    const calls = (api.listAssets as ReturnType<typeof vi.fn>).mock.calls.map(args => args[0]?.cursor);
    expect(calls.filter(Boolean)).toEqual(["c1", "c2"]);
  });

  it("游标环防护：200 页上限触顶即止（不劣于单页现状）", async () => {
    let calls = 0;
    const api = buildDesktopApi({
      overrides: {
        listAssets: vi.fn(async () => {
          calls += 1;
          // 病态服务器：恒回非空 cursor（游标环）
          return { items: [{ asset: makeAsset(calls), media_url: "aivideo://media/x" }], next_cursor: `c${calls}` };
        }),
        getTimeline: vi.fn().mockRejectedValue(new Error("TIMELINE_NOT_FOUND 404")),
      },
    });
    (window as { desktop?: DesktopApi }).desktop = api;
    const { App } = await import("../src/app/App.js");
    render(<App />);
    await waitFor(() => expect(calls).toBe(200));
    // 触顶后不再发第 201 页请求（留一个宏任务窗口确认）
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toBe(200);
  });
});
