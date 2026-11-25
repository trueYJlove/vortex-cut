/** P195 装配失败恢复：旧实现只在 project_id 变化时装时间线，首个
 *  getTimeline 若撞上 TIMELINE_NOT_FOUND（启动轮询在 createProject 与
 *  createTimeline 之间认领了新项目）或一次瞬时失败，就再无重载机会，界面
 *  永久停在「时间线为空」。这里只验证 App 的装载时序，不启动 worker 或画布
 *  ——两个重型子组件按 project-switch-isolation 的先例桥接掉。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, TimelineDocument, TimelineState } from "@aivideo/contracts";
import { App } from "../src/app/App.js";
import { buildDesktopApi } from "./fixtures/desktop-api-factory.js";

vi.mock("../src/app/preview/SyntheticPreview.js", async () => {
  const React = await import("react");
  return { SyntheticPreview: () => React.createElement("div", { "data-testid": "synthetic-preview-bridge" }) };
});

// 记录每次渲染时间线面板拿到的 document：幂等短路若失效（误写 state），
// 服务端副本会替换掉本地 working，这里就能看到。
const panelDocuments = vi.hoisted(() => [] as TimelineDocument[]);

vi.mock("../src/app/timeline/TimelineCanvas.js", async () => {
  const React = await import("react");
  return {
    TimelinePanel: (props: { document?: TimelineDocument; setSelection: (selection: { kind: "clip"; id: string }) => void }) => {
      if (props.document) panelDocuments.push(props.document);
      // 选区走真实回调：草稿只能由片段属性面板的滑杆（onDraft = queueDraft）驱动。
      return React.createElement("div", { "data-testid": "timeline-panel-bridge" },
        (props.document?.clips ?? []).map(clip => React.createElement("button", {
          key: clip.clip_id, onClick: () => props.setSelection({ kind: "clip", id: clip.clip_id }),
        }, `pick-${clip.clip_id}`)));
    },
  };
});

const now = "2026-08-11T00:00:00.000Z";
const later = "2026-08-11T00:00:07.000Z";
const canvas = { width: 1080, height: 1920, fps_num: 30, fps_den: 1 };

type Id = string & { readonly __brand: never };
const id = (value: string) => value as Id;

function makeProject(revisionId: string | null, updatedAt: string): Project {
  return {
    project_id: id("project_p195"), name: "装配恢复项目", status: "active", canvas,
    root_dir_name: "P195", current_timeline_revision_id: revisionId, created_at: now, updated_at: updatedAt, last_opened_at: now,
  };
}

function makeTimeline(revisionId: string): TimelineState {
  const document: TimelineDocument = {
    schema_version: 1, project_id: id("project_p195"), canvas: { ...canvas, background_color: "#000000" },
    tracks: [{ id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false }],
    clips: [{
      clip_id: id("clip_p195"), track_id: "V1", order_index: 0, asset_id: id("asset_p195"), asset_kind: "video",
      source_start_us: 0, source_end_us: 1_000_000, timeline_start_us: 0, timeline_end_us: 1_000_000,
      layout: "fit", audio: { enabled: true, gain_db: 0 },
    }],
    captions: [], provenance: { created_by: "user", source_transcript_ids: [] },
  };
  return {
    project_id: id("project_p195"),
    current_revision: {
      timeline_revision_id: id(revisionId), project_id: id("project_p195"), parent_revision_id: null,
      document_sha256: revisionId.padEnd(64, "a"), summary: "fixture", created_by: "user", created_at: now,
      schema_version: 1, document,
    },
    draft: null, can_undo: false, can_redo: false, current_preview: null, active_transitions: [],
  };
}

/** 空态按钮的存在与否就是「renderer 有没有装载到时间线」的观测量：
 *  App 只在 !timeline 时渲染它（App.tsx:2612）。 */
const emptyTimelinePrompt = () => screen.queryByRole("button", { name: "创建空时间线" });

/** 推进一次轮询：走 App 自己的「回到前台立即刷新」通道
 *  （visibilitychange → scheduler.refresh()），与真实用户切回窗口同一条路径，
 *  不依赖真实毫秒，也不伪造调度器的定时器。 */
async function pollRefresh() {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}

/** 真实定时器上的等待（退避重试本来就是真实窗口，不伪造）。 */
const sleep = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });

beforeEach(() => { panelDocuments.length = 0; vi.restoreAllMocks(); });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("P195 项目装配失败后的时间线恢复", () => {
  it("updated_at 推进（时间线被建出来）后自动重载，界面不再停在「时间线为空」", async () => {
    const getTimelineMissing = vi.fn().mockRejectedValue(new Error("[TIMELINE_NOT_FOUND] 当前项目还没有时间线。"));
    const api = buildDesktopApi({
      overrides: {
        // 首轮：轮询在 createProject 与 createTimeline 之间认领了项目（时间线尚未建）。
        listProjects: vi.fn().mockResolvedValue({ items: [makeProject(null, now)], next_cursor: null }),
        getTimeline: getTimelineMissing,
      },
    });
    window.desktop = api;
    render(<App />);
    // 缺陷态：装载失败 ⇒ timeline 为空 ⇒ 空态按钮出现、权威预览恒不可用。
    // 先等首次装载真的发生再断言：空态按钮在 project 落定、timeline 未装载时
    // 就已渲染，早于 getTimeline 返回，直接断言次数会与 IPC 返回赛跑。
    await waitFor(() => expect(getTimelineMissing).toHaveBeenCalled());
    expect(getTimelineMissing).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(emptyTimelinePrompt()).not.toBeNull());

    // 时间线被建出来：projects.updated_at 推进（Core 每次时间线写入都 UPDATE
    // projects），getTimeline 从此可用——这就是产品侧真实发生的愈合条件。
    const created = makeTimeline("revision_p195");
    const getTimelineCreated = vi.fn().mockResolvedValue(created);
    api.listProjects = vi.fn().mockResolvedValue({ items: [makeProject(created.current_revision.timeline_revision_id, later)], next_cursor: null });
    api.getTimeline = getTimelineCreated;
    await pollRefresh();

    await waitFor(() => expect(emptyTimelinePrompt()).toBeNull());
    expect(getTimelineCreated).toHaveBeenCalledWith("project_p195");
    // 权威预览的禁用理由不再恒为「时间线为空」。
    expect(screen.getByRole("button", { name: "生成权威预览" })).toBeEnabled();
  }, 30_000);

  it("非 404 的瞬时失败在 1s 后退避重试并装载；重试耗尽后收敛不再增长", async () => {
    const timeline = makeTimeline("revision_p195_retry");
    const transient = new Error("connect ECONNREFUSED 127.0.0.1:8765");
    // 第 1 次瞬时失败 → 1s 后退避的第 2 次成功。
    const retryThenLoad = vi.fn().mockRejectedValueOnce(transient).mockResolvedValue(timeline);
    window.desktop = buildDesktopApi({
      overrides: { listProjects: vi.fn().mockResolvedValue({ items: [makeProject("revision_p195_retry", now)], next_cursor: null }), getTimeline: retryThenLoad },
    });
    render(<App />);
    // 旧实现在这里永久停在空态：失败分支只 setTimeline(undefined)，没有重试。
    // 同上：先等首次装载发生，再断言它此刻只有 1 次（重试还没到点）。
    await waitFor(() => expect(retryThenLoad).toHaveBeenCalled());
    expect(retryThenLoad).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(emptyTimelinePrompt()).not.toBeNull());
    await waitFor(() => expect(emptyTimelinePrompt()).toBeNull(), { timeout: 5000 });
    expect(retryThenLoad).toHaveBeenCalledTimes(2);
    cleanup();

    // 上限收敛：连续瞬时失败时装载 = 首次 + 2 次重试 = 3，此后不再发起（不是无限环）。
    const alwaysFails = vi.fn().mockRejectedValue(transient);
    window.desktop = buildDesktopApi({
      overrides: { listProjects: vi.fn().mockResolvedValue({ items: [makeProject(null, now)], next_cursor: null }), getTimeline: alwaysFails },
    });
    render(<App />);
    await waitFor(() => expect(emptyTimelinePrompt()).not.toBeNull());
    await waitFor(() => expect(alwaysFails).toHaveBeenCalledTimes(3), { timeout: 8000 });
    await sleep(2000);
    expect(alwaysFails).toHaveBeenCalledTimes(3);
    // 放弃后如实报错（沿用既有文案口径），而不是静默停在空态。
    expect(screen.getByRole("alert").textContent).toContain("时间线加载失败");
  }, 30_000);

  it("updated_at 推进但 Revision 未变时不覆盖本地 working（幂等短路）", async () => {
    const loaded = makeTimeline("revision_p195_stable");
    // 第二次装载（updated_at 推进后）拿回**同一个 Revision**，正文是服务端副本。
    const serverCopy = makeTimeline("revision_p195_stable");
    serverCopy.current_revision.document.clips[0].clip_id = id("clip_should_never_render");
    const getTimeline = vi.fn().mockResolvedValueOnce(loaded).mockResolvedValue(serverCopy);
    const api = buildDesktopApi({
      overrides: {
        listProjects: vi.fn().mockResolvedValue({ items: [makeProject("revision_p195_stable", now)], next_cursor: null }),
        getTimeline,
      },
    });
    window.desktop = api;
    render(<App />);
    // 首次装载完成：时间线正文已进入面板（此后才有可被覆盖的本地 working）。
    await waitFor(() => expect(panelDocuments.length).toBeGreaterThan(0));
    expect(getTimeline).toHaveBeenCalledTimes(1);
    panelDocuments.length = 0;

    // 保存一次 Revision 会推进 projects.updated_at（Core timeline.py 的
    // UPDATE projects）→ 轮询 apply 回写新 Project → 装载 effect 以新
    // updated_at 重入（旧代码根本不会重入）。
    api.listProjects = vi.fn().mockResolvedValue({ items: [makeProject("revision_p195_stable", later)], next_cursor: null });
    await pollRefresh();
    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));
    await sleep(50);

    // 幂等短路：Revision 相同 ⇒ 不写 state ⇒ 本地 working 不被服务端副本覆盖。
    expect(panelDocuments.length).toBeGreaterThan(0);
    expect(panelDocuments.some(document => document.clips.some(clip => clip.clip_id === "clip_should_never_render"))).toBe(false);
    expect(panelDocuments.every(document => document.clips.every(clip => clip.clip_id === "clip_p195"))).toBe(true);
  }, 30_000);

  // 回归面：装载代次若与草稿代次共用，projects.updated_at 的任何推进（改名/
  // 归档/重开同样 UPDATE projects）都会让排队中的草稿被当成"内容已被取代"
  // 静默丢弃并谎报「已保存」。本用例冻结时间线正文、只推进 updated_at。
  it("时间线未变、仅 updated_at 推进时，排队中的草稿不被静默丢弃", async () => {
    const timeline = makeTimeline("revision_p195_draft");
    // 服务端始终回同一个 Revision：正文一个字节都没变。
    const getTimeline = vi.fn().mockResolvedValue(timeline);
    const saveTimelineDraft = vi.fn().mockResolvedValue({
      project_id: timeline.project_id, base_revision_id: timeline.current_revision.timeline_revision_id,
      document: timeline.current_revision.document, updated_at: now, conflict: false,
    });
    const api = buildDesktopApi({
      overrides: {
        listProjects: vi.fn().mockResolvedValue({ items: [makeProject("revision_p195_draft", now)], next_cursor: null }),
        getTimeline, saveTimelineDraft,
      },
    });
    window.desktop = api;
    render(<App />);

    // 经面板滑杆触发一次编辑：RangeRow.onDraft → ClipProperties.updateLocal
    // → App.queueDraft（400ms 后才落库）。
    fireEvent.click(await screen.findByRole("button", { name: "pick-clip_p195" }, { timeout: 10_000 }));
    const opacity = await screen.findByRole("slider", { name: "不透明度" });
    fireEvent.change(opacity, { target: { value: "50" } });

    // 草稿窗口内推进一次轮询：projects.updated_at 变了，时间线没变。
    api.listProjects = vi.fn().mockResolvedValue({ items: [makeProject("revision_p195_draft", later)], next_cursor: null });
    await pollRefresh();

    // 草稿必须真的落库（不能被代次比对 return 掉）。
    await waitFor(() => expect(saveTimelineDraft).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(saveTimelineDraft.mock.calls[0][0].draft.base_revision_id).toBe("revision_p195_draft");
  }, 30_000);
});
