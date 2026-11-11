/** 代理链路缺失的一环（方案 A）：素材导入后自动登记代理生成作业，代理就绪后
 *  让预览自动切到代理。
 *
 *  验收映射（任务书 Goal/Constraints）：
 *   - 视频导入 → createPreviewSourceJob，档位 preview-1080-v1；
 *   - 非视频导入 → 不调用；
 *   - 登记被拒/失败 → 导入依旧成功，且不弹错误；
 *   - 代理作业到达终态成功 → PreviewSourceResolver.invalidate(asset_id) 被调用
 *     （下次解析走代理；不重建预览会话）。
 *
 *  就绪检测走 App 里既有的 jobs 状态（既有 listJobs 轮询），因此这里的"作业
 *  完成"通过 listJobs 的返回值推进轮询来模拟，而不是直接调 App 内部函数。 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Job, Project } from "@aivideo/contracts";
import { App } from "../src/app/App.js";
import { buildDesktopApi } from "./fixtures/desktop-api-factory.js";
import { PreviewSourceResolver } from "../src/app/preview/source-resolver.js";

// 重型子组件桥接掉（同 timeline-assembly-recovery / asset-collection-reconciliation
// 的先例）：本用例断言的是 App 的登记与失效时序，不是预览/时间线的渲染。
vi.mock("../src/app/preview/SyntheticPreview.js", async () => {
  const React = await import("react");
  return { SyntheticPreview: () => React.createElement("div", { "data-testid": "synthetic-preview-bridge" }) };
});
vi.mock("../src/app/timeline/TimelineCanvas.js", async () => {
  const React = await import("react");
  return { TimelinePanel: () => React.createElement("div", { "data-testid": "timeline-panel-bridge" }) };
});

const now = "2026-08-11T00:00:00.000Z";
type Id = string & { readonly __brand: never };
const id = (value: string): Id => value as Id;

const project: Project = {
  project_id: id("project_proxy"), name: "代理自动生成", status: "active",
  canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1 }, root_dir_name: "Proxy",
  current_timeline_revision_id: "revision_proxy", created_at: now, updated_at: now, last_opened_at: now,
};

const importedVideo = {
  asset_id: id("asset_imported_video"), project_id: project.project_id, kind: "video" as const,
  storage_mode: "external" as const, display_name: "导入的视频.mp4", fingerprint: "a".repeat(64),
  size_bytes: 10, modified_at: now, availability: "available" as const,
  media_info: { duration_us: 5_000_000 }, created_at: now, updated_at: now,
};
const importedImage = { ...importedVideo, asset_id: id("asset_imported_image"), kind: "image" as const, display_name: "导入的图片.png" };

/** 导入产物（ImportedAsset 含 grant；这里只用到 asset/media_url）。 */
const importResult = (asset: typeof importedVideo | typeof importedImage) =>
  ({ grant: {}, asset, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFG" });

function proxyJob(assetId: Id, status: Job["status"]): Job {
  return {
    job_id: id("job_proxy_1"), project_id: project.project_id, asset_id: assetId, kind: "proxy",
    status, stage: status === "succeeded" ? ("completed" as Job["stage"]) : ("queued" as Job["stage"]),
    progress: status === "succeeded" ? 1 : 0, attempt: 1, model_id: null, model_revision: null,
    input_fingerprint: null, input: { asset_id: assetId }, error: null,
    created_at: now, updated_at: now, started_at: now, finished_at: status === "succeeded" ? now : null,
  };
}

/** 推进一轮既有轮询（与用户切回窗口同一条通道：visibilitychange → refresh）。 */
async function pollRefresh() {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}

const importButton = (label: "视频" | "图片") => screen.getByRole("button", { name: `导入${label}` });

function setup(options: { createPreviewSourceJob?: ReturnType<typeof vi.fn> } = {}) {
  const listJobs = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
  // **listAssets 必须反映已导入的素材**（2026-11-03 修）：
  // App 有资产集合对账（P199）——轮询发现「Core 首页集合 ≠ 本地镜像」会用
  // listAssets 的结果整体覆盖 assets。若这里恒返回 []，刚乐观追加的素材会被
  // 下一轮对账冲掉，`findByTitle` 必然超时。之前把它当「并行负载 flaky」并
  // 抬高超时只是治标；真因是 mock 与对账语义矛盾，与负载无关。
  const importedAssets: Array<{ asset: unknown; media_url: string | null }> = [];
  const importAsset = vi.fn()
    .mockImplementation(async ({ kind }: { kind: string }) => {
      const result = importResult(kind === "video" ? importedVideo : importedImage);
      importedAssets.push({ asset: result.asset, media_url: result.media_url });
      return result;
    });
  const createPreviewSourceJob = options.createPreviewSourceJob
    ?? vi.fn().mockResolvedValue({ job_id: "job_proxy_1", cache_key: null, status: "queued" });
  window.desktop = buildDesktopApi({
    overrides: {
      listProjects: vi.fn().mockResolvedValue({ items: [project], next_cursor: null }),
      listAssets: vi.fn().mockImplementation(async () => ({ items: [...importedAssets], next_cursor: null })),
      listJobs, importAsset, createPreviewSourceJob,
    },
  });
  return { listJobs, importAsset, createPreviewSourceJob };
}

/** 每个用例重建 spy：afterEach 的 vi.restoreAllMocks 会把模块级 spy 还原成
 *  原方法，模块级只建一次的话从第二个用例起就永远收不到调用。 */
let resolverInvalidate: MockInstance<(assetId?: string) => void>;

beforeEach(() => { resolverInvalidate = vi.spyOn(PreviewSourceResolver.prototype, "invalidate"); });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("素材导入后自动登记代理生成作业（方案 A）", () => {
  it("视频素材导入后登记代理作业（档位由 Core 自动选择）", async () => {
    const { createPreviewSourceJob } = setup();
    render(React.createElement(App));
    await waitFor(() => expect(importButton("视频")).not.toBeDisabled());
    fireEvent.click(importButton("视频"));
    await waitFor(() => expect(createPreviewSourceJob).toHaveBeenCalledTimes(1));
    // 档位不再写死：默认 auto 由 Core 按素材显示短边选档，因此这里不传 profile_id。
    // （写死 1080 会让 4K 源按 1080 代理，解码量翻倍、反而更卡。）
    expect(createPreviewSourceJob).toHaveBeenCalledWith({
      project_id: project.project_id, asset_id: importedVideo.asset_id,
    });
  }, 30_000);

  it("非视频（图片）素材导入不登记代理作业", async () => {
    const { createPreviewSourceJob, importAsset } = setup();
    render(React.createElement(App));
    await waitFor(() => expect(importButton("图片")).not.toBeDisabled());
    fireEvent.click(importButton("图片"));
    await waitFor(() => expect(importAsset).toHaveBeenCalledWith({ project_id: project.project_id, kind: "image" }));
    // 导入确实完成了（素材落进列表）：排除"按钮没生效所以没调用"的假绿。
    await screen.findByTitle(importedImage.display_name, {}, { timeout: 15_000 });
    expect(createPreviewSourceJob).not.toHaveBeenCalled();
  }, 30_000);

  it("登记失败时导入仍成功且不弹错误", async () => {
    const { createPreviewSourceJob } = setup({
      createPreviewSourceJob: vi.fn().mockRejectedValue(new Error("DERIVED_CACHE_UNAVAILABLE")),
    });
    render(React.createElement(App));
    await waitFor(() => expect(importButton("视频")).not.toBeDisabled());
    fireEvent.click(importButton("视频"));
    await waitFor(() => expect(createPreviewSourceJob).toHaveBeenCalledTimes(1));
    // 导入结果照常落进素材列表（代理是加速项，失败不影响导入）。
    await screen.findByTitle(importedVideo.display_name, {}, { timeout: 15_000 });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector(".notice")).toBeNull();
  }, 30_000);

  it("代理作业就绪后失效该素材的解析缓存（下次解析走代理）", async () => {
    const { listJobs } = setup();
    render(React.createElement(App));
    await waitFor(() => expect(importButton("视频")).not.toBeDisabled());
    fireEvent.click(importButton("视频"));
    await screen.findByTitle(importedVideo.display_name, {}, { timeout: 15_000 });

    // 代理作业在途期间：不失效（否则每次轮询都清缓存）。
    listJobs.mockResolvedValue({ items: [proxyJob(importedVideo.asset_id, "running")], next_cursor: null });
    await pollRefresh();
    expect(resolverInvalidate).not.toHaveBeenCalled();

    // 作业成功 → 清该素材缓存，下次解析即可拿到代理票据。
    listJobs.mockResolvedValue({ items: [proxyJob(importedVideo.asset_id, "succeeded")], next_cursor: null });
    await pollRefresh();
    await waitFor(() => expect(resolverInvalidate).toHaveBeenCalledWith(importedVideo.asset_id));
    // 只清被导入素材的那一条，不整表清空（清空会连带丢弃其它素材的就绪结论）。
    const calls = resolverInvalidate.mock.calls.map(call => call[0]);
    expect(calls).toEqual([importedVideo.asset_id]);
  }, 30_000);
});