/** 票据迟到重建回归（2026-09-15 F04 复测暴露）：分页装载/项目数据晚于
 *  时间线到位时，SyntheticPreview 会先以空 mediaUrls 建会话；旧实现会话
 *  重建依赖数组漏了 mediaUrls，票据迟到后不再重试（合成预览永久回退
 *  "no ticket for asset_..."）。修法 = mediaUrls 进重建依赖。
 *  曾试过"票据齐备才挂载"的门槛，但素材库未就绪时会把预览永久卡在
 *  装载态（F07 复测暴露），已回退。 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../electron/preload/index.js";
import { buildDesktopApi } from "./fixtures/desktop-api-factory.js";

const now = "2026-08-11T00:00:00.000Z";
const project = { project_id: "project_1" as never, name: "票据竞态项目", status: "active" as const, canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 }, root_dir_name: "Demo", current_timeline_revision_id: "revision_1", created_at: now, updated_at: now, last_opened_at: now };
const makeAsset = (ordinal: number) => ({ asset_id: `asset_${ordinal}` as never, project_id: project.project_id, kind: "video" as const, storage_mode: "external" as const, display_name: `素材-${String(ordinal).padStart(3, "0")}.mp4`, fingerprint: "a".repeat(64), size_bytes: 10, modified_at: now, availability: "available" as const, media_info: { duration_us: 5_000_000 }, created_at: now, updated_at: now });
const clipDoc = (assetIds: string[]) => ({
  schema_version: 1, project_id: project.project_id, canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1, background_color: "#000000" },
  tracks: [{ id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false }],
  clips: assetIds.map((assetId, index) => ({ clip_id: `clip_${index}` as never, track_id: "V1", order_index: index, asset_id: assetId as never, asset_kind: "video", source_start_us: 0, source_end_us: 5_000_000, timeline_start_us: index * 5_000_000, timeline_end_us: (index + 1) * 5_000_000, layout: "fit", audio: { enabled: true, gain_db: 0 } })),
  captions: [], provenance: { created_by: "user", source_transcript_ids: [] },
});

describe("SyntheticPreview 票据迟到重建（分页装载时序）", () => {
  afterAll(() => { vi.unstubAllEnvs(); });
  beforeEach(() => {
    // App 级测试钉住 v1 数据面（factory 的 v2 端点是 reject stub；同
    // editor-shell.test.tsx 惯例——v2 数据面由 harness E2E 覆盖）。
    vi.stubEnv("VITE_AIVS_PREVIEW_IR_V2", "0");
    vi.clearAllMocks();
  });
  afterEach(() => { cleanup(); delete (window as { desktop?: unknown }).desktop; });

  it("素材装载慢于时间线：先挂载（不永久卡装载态），票据到位后自动恢复", async () => {
    // 真实时序（F04 100 素材复测暴露）：working/timeline 先到位、assets 翻页
    // 装载后到位。旧实现会话用空票据建好后不再重建；本测试锁"票据到位触发
    // 重建"这一行为（jsdom 无真实 worker，以合成预览容器挂载为准）。
    const timelineState = (doc: ReturnType<typeof clipDoc>) => ({
      project_id: project.project_id,
      current_revision: { timeline_revision_id: "revision_1" as never, project_id: project.project_id, parent_revision_id: null, document_sha256: "a".repeat(64), summary: "创建", created_by: "user", created_at: now, schema_version: 1, document: doc },
      draft: null, can_undo: true, can_redo: true, current_preview: null,
    });
    let releaseAssets: (() => void) | undefined;
    const assetsGate = new Promise<void>(resolve => { releaseAssets = resolve; });
    let listAssetsCalls = 0;
    const api = buildDesktopApi({
      overrides: {
        listAssets: vi.fn(async () => {
          listAssetsCalls += 1;
          if (listAssetsCalls === 1) await assetsGate;
          return { items: [0, 1, 2].map(n => ({ asset: makeAsset(n), media_url: `aivideo://media/t${n}` })), next_cursor: null };
        }),
        getTimeline: vi.fn(async () => timelineState(clipDoc(["asset_0", "asset_1", "asset_2"]))) as never,
      },
    });
    (window as { desktop?: DesktopApi }).desktop = api;
    const { App } = await import("../src/app/App.js");
    render(<App />);
    // 时间线已到位但 assets 未到（翻页在途）：预览组件不设门槛、照常挂载，
    // 不出现"正在装载素材票据…"式的永久等待。
    await waitFor(() => expect(document.querySelector(".synthetic-preview")).not.toBeNull(), { timeout: 5000 });
    // 素材装载完成（票据齐备）：listAssets 被再次调用（重建触发数据面收敛）
    releaseAssets?.();
    await waitFor(() => expect(listAssetsCalls).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    expect(screen.queryByText("正在装载素材票据…")).toBeNull();
  });
});