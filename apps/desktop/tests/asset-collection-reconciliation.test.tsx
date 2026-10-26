/** P199 资产列表装配竞态：装配 effect 只在 project_id 变化时装载一次，而素材导入
 *  不推进 projects.updated_at（Core projects.py 只有改名/归档/重开 UPDATE projects），
 *  P195 的时间线键在这里不可用。首次 listAssets 若在 createProject 与 importAsset 之间
 *  认领到空项目，界面就永久停在「没有素材」，直到用户手动刷新或切项目。
 *  这里只验证 App 的装载时序，重型子组件按 timeline-assembly-recovery 的先例桥接掉。 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, Project, TimelineDocument } from "@aivideo/contracts";
import { App } from "../src/app/App.js";
import { buildDesktopApi } from "./fixtures/desktop-api-factory.js";

vi.mock("../src/app/preview/SyntheticPreview.js", async () => {
  const React = await import("react");
  return { SyntheticPreview: () => React.createElement("div", { "data-testid": "synthetic-preview-bridge" }) };
});

// 同 timeline-assembly-recovery：记录时间线面板收到的 document，用来排除"顺带
// 把时间线也重装了一遍"这类越界副作用。
const panelDocuments = vi.hoisted(() => [] as TimelineDocument[]);

vi.mock("../src/app/timeline/TimelineCanvas.js", async () => {
  const React = await import("react");
  return {
    TimelinePanel: (props: { document?: TimelineDocument }) => {
      if (props.document) panelDocuments.push(props.document);
      return React.createElement("div", { "data-testid": "timeline-panel-bridge" });
    },
  };
});

const now = "2026-08-11T00:00:00.000Z";
const canvas = { width: 1080, height: 1920, fps_num: 30, fps_den: 1 };

type Id = string & { readonly __brand: never };
const id = (value: string) => value as Id;

function makeProject(): Project {
  return {
    project_id: id("project_p199"), name: "资产对账项目", status: "active", canvas,
    root_dir_name: "P199", current_timeline_revision_id: "revision_p199", created_at: now, updated_at: now, last_opened_at: now,
  };
}

function makeAsset(assetId: string, displayName: string): Asset {
  return {
    asset_id: id(assetId), project_id: id("project_p199"), kind: "video", storage_mode: "external",
    display_name: displayName, fingerprint: "a".repeat(64), size_bytes: 10, modified_at: now,
    availability: "available", media_info: { duration_us: 5_000_000 }, created_at: now, updated_at: now,
  };
}

const presentation = (asset: Asset) => ({ asset, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH" });

/** 素材名在界面上的可见证据：素材行把 display_name 渲染成 <strong>。 */
const assetRowNames = () => screen.queryAllByTitle(/^P199-/).map(node => node.getAttribute("title"));

/** 推进一次轮询：走 App 自己的「回到前台立即刷新」通道
 *  （visibilitychange → scheduler.refresh()），与真实用户切回窗口同一条路径。 */
async function pollRefresh() {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}

const sleep = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });

beforeEach(() => { panelDocuments.length = 0; vi.restoreAllMocks(); });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("P199 资产集合对账", () => {
  it("首次装载得到空列表、之后服务端出现素材时，界面自动补上（不再永久为空）", async () => {
    // 第一轮装配：轮询在 createProject 与 importAsset 之间认领了项目，资产表还是空的。
    // 此后同一 project_id 不会再触发装配 effect——只有集合对账能把素材带回来。
    // 服务端内容由 serverAssets 控制，保证"空 → 有"的切换点就在我们推进轮询的那一刻。
    const project = makeProject();
    let serverAssets: Asset[] = [];
    const listAssets = vi.fn().mockImplementation(async () => ({
      items: serverAssets.map(presentation), next_cursor: null,
    }));
    window.desktop = buildDesktopApi({
      overrides: {
        listProjects: vi.fn().mockResolvedValue({ items: [project], next_cursor: null }),
        listAssets,
      },
    });
    render(<App />);
    await waitFor(() => expect(listAssets).toHaveBeenCalled());
    // 缺陷态：装配装载到空列表，且 project_id 不变 ⇒ 装配 effect 不再重入。
    expect(assetRowNames()).toEqual([]);
    const beforeImport = listAssets.mock.calls.length;

    // 素材在这之后才落库（绕开 renderer 的 importAsset，没有本地乐观追加）。
    serverAssets = [makeAsset("asset_p199", "P199-迟到素材.mp4")];
    await pollRefresh();

    await waitFor(() => expect(assetRowNames()).toEqual(["P199-迟到素材.mp4"]));
    // 补上素材走的是"集合变了 → 完整重载"，不是装配 effect 重入。
    expect(listAssets.mock.calls.length).toBeGreaterThan(beforeImport);
  }, 30_000);

  it("集合没变时不重复装载（签名相同短路，不因触发 loadProjectData 而翻页暴增）", async () => {
    // 同一集合始终返回：apply 必须短路。若"变了"的判断写错（比如拿整体内容比较、
    // 或每次触发重载后忘了记录签名），每轮轮询都会再跑一次 loadProjectData，
    // listAssets 的调用次数会随轮次二次增长——这里就是那个不变量。
    const project = makeProject();
    const listAssets = vi.fn().mockResolvedValue({ items: [presentation(makeAsset("asset_p199", "P199-稳定素材.mp4"))], next_cursor: null });
    window.desktop = buildDesktopApi({
      overrides: {
        listProjects: vi.fn().mockResolvedValue({ items: [project], next_cursor: null }),
        listAssets,
      },
    });
    render(<App />);
    await waitFor(() => expect(assetRowNames()).toEqual(["P199-稳定素材.mp4"]));
    const baseline = listAssets.mock.calls.length;

    // 连续推进三轮：每轮最多新增 1 次（对账端点自己那一次），装配不重入。
    const afterEachRound: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      await pollRefresh();
      await sleep(20);
      afterEachRound.push(listAssets.mock.calls.length - baseline);
    }

    expect(afterEachRound).toEqual([1, 2, 3]);
    // 装配没有被重复触发：素材行没有重装，时间线面板也没有被重刷。
    expect(assetRowNames()).toEqual(["P199-稳定素材.mp4"]);
    const timelineLoads = panelDocuments.length;
    await sleep(50);
    expect(panelDocuments.length).toBe(timelineLoads);
  }, 30_000);

  // 覆盖缺口（复核实测补入）：上面第二条只在**单页**场景守着"不重复装载"，
  // 而这条不变量真正的危险区是**多页**——对账端点只取首页 50 条，若拿它去和
  // 界面的完整集合比较（而不是同长度前缀），120 条素材的项目每轮都会判成"变了"，
  // 于是每轮重载 3 页：实测调用数 [4,8,12]（每轮 +4 = 端点 1 + 完整装载 3）。
  // 单页场景下这个错误写法**测不出来**（两集合恰好相等），故必须单独守。
  it("多页集合（120 条 / 3 页）下对账不自我循环：每轮仅增加端点自身 1 次调用", async () => {
    const project = makeProject();
    const all = Array.from({ length: 120 }, (_, index) => makeAsset(`asset_mp_${String(index).padStart(3, "0")}`, `P199-多页-${index}.mp4`));
    const listAssets = vi.fn().mockImplementation(async ({ cursor }: { cursor?: string } = {}) => {
      const offset = cursor ? Number(cursor) : 0;
      const items = all.slice(offset, offset + 50).map(presentation);
      return { items, next_cursor: offset + items.length < all.length ? String(offset + items.length) : null };
    });
    window.desktop = buildDesktopApi({
      overrides: { listProjects: vi.fn().mockResolvedValue({ items: [project], next_cursor: null }), listAssets },
    });
    render(<App />);
    // 首次装配翻完 3 页，界面拿到全部 120 条。
    await waitFor(() => expect(screen.queryAllByTitle(/^P199-多页-/).length).toBe(120), { timeout: 10_000 });
    const baseline = listAssets.mock.calls.length;
    const perRound: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      await pollRefresh();
      await sleep(30);
      perRound.push(listAssets.mock.calls.length - baseline);
    }
    // 集合没变 ⇒ 只有对账端点自己的那一次；任何"每轮重载"都会让差值变成 4 的倍数。
    expect(perRound).toEqual([1, 2, 3]);
    expect(screen.queryAllByTitle(/^P199-多页-/).length).toBe(120);
  }, 40_000);
});
