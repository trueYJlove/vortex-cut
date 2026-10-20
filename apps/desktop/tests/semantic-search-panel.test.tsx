/**
 * W3.1 语义检索面板测试。
 *
 * 重点不是「能渲染」，而是钉住这些纪律：
 * 1) A8 留空 ⇒ UI 不得出现命中率/准确率话术（P142）；
 * 2) 模型未装 ⇒ 给人话出路，不抛内部错误串；
 * 3) 空结果与失败是不同状态（不把失败显示成「没有匹配」）；
 * 4) 索引是检索的前提 ⇒ 面板必须给出建索引入口，且调用时 generate: true。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetPresentation, ProjectId } from "@aivideo/contracts";
import { SemanticSearchPanel } from "../src/app/semantic-search/SemanticSearchPanel.js";

const PROJECT = "project_1" as ProjectId;
const now = "2026-08-11T00:00:00.000Z";

const asset = (id: string, displayName: string, kind: "video" | "image" | "audio") => ({
  asset: {
    asset_id: id, project_id: PROJECT, kind, storage_mode: "external", display_name: displayName,
    fingerprint: "a".repeat(64), size_bytes: 10, modified_at: now, availability: "available",
    media_info: null, created_at: now, updated_at: now,
  },
  media_url: null,
}) as unknown as AssetPresentation;

const ASSETS = [asset("asset_1", "素材一.mp4", "video"), asset("asset_2", "海报.png", "image")];

const indexSummary = (overrides: Record<string, unknown> = {}) => ({
  index_id: null, status: null, job_id: null, frame_count: null,
  algorithm_version: null, model_id: null, reason: null, ...overrides,
});

function mount(overrides: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  const desktop = {
    searchSemantic: vi.fn().mockResolvedValue({ query: "car", hits: [] }),
    indexSemanticAsset: vi.fn().mockResolvedValue(indexSummary()),
    subscribeJob: vi.fn().mockReturnValue(() => undefined),
    ...overrides
  };
  (window as unknown as { desktop: unknown }).desktop = desktop;
  render(
    <SemanticSearchPanel
      projectId={PROJECT}
      assetNames={{ asset_1: "素材一" }}
      assets={ASSETS}
      onClose={() => {}}
      {...props}
    />
  );
  return desktop;
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("SemanticSearchPanel", () => {
  it("不显示任何命中率/准确率话术（A8 留空，P142）", () => {
    mount();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/命中率|准确率|精准度/);
    // 正向：必须存在免责说明（断言语义而非某个字面词——措辞可改，纪律不可丢）
    expect(text).toMatch(/不构成|不代表|不是/);
  });

  it("检索后按分数列出素材名", async () => {
    mount({
      searchSemantic: vi.fn().mockResolvedValue({
        query: "car",
        hits: [{ asset_id: "asset_1", score: 0.276 }, { asset_id: "asset_2", score: 0.211 }]
      })
    });
    fireEvent.change(screen.getByLabelText("检索内容"), { target: { value: "car" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    await waitFor(() => expect(screen.getByText("素材一")).toBeInTheDocument());
    expect(screen.getByText("0.276")).toBeInTheDocument();
    expect(screen.getByText("asset_2")).toBeInTheDocument();
  });

  it("模型未安装：给人话出路而非内部错误串", async () => {
    mount({
      searchSemantic: vi.fn().mockRejectedValue(new Error("SEMANTIC_MODEL_NOT_INSTALLED"))
    });
    fireEvent.change(screen.getByLabelText("检索内容"), { target: { value: "car" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const msg = screen.getByRole("alert").textContent ?? "";
    expect(msg).toContain("尚未安装");
    expect(msg).not.toContain("SEMANTIC_MODEL_NOT_INSTALLED");
  });

  it("空结果与失败是不同状态", async () => {
    mount({ searchSemantic: vi.fn().mockResolvedValue({ query: "car", hits: [] }) });
    fireEvent.change(screen.getByLabelText("检索内容"), { target: { value: "car" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    await waitFor(() => expect(document.body.textContent).toContain("没有匹配素材"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("空查询不发起调用", async () => {
    const desktop = mount();
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("请输入"));
    expect(desktop.searchSemantic).not.toHaveBeenCalled();
  });

  it("建索引入口以 generate: true 逐条调用，且只针对画面素材", async () => {
    const desktop = mount({
      indexSemanticAsset: vi.fn().mockResolvedValue(indexSummary({ status: "queued", job_id: "job_1" }))
    });
    // 音频素材不该出现：Core 对无画面轨的素材只会落 unavailable。
    expect(document.body.textContent).not.toMatch(/旁白\.mp3/);
    fireEvent.click(screen.getByRole("button", { name: "为此项目建索引" }));
    await waitFor(() => expect(desktop.indexSemanticAsset).toHaveBeenCalledTimes(2));
    expect(desktop.indexSemanticAsset).toHaveBeenCalledWith({
      project_id: PROJECT, asset_id: "asset_1", generate: true
    });
    expect(desktop.indexSemanticAsset).toHaveBeenCalledWith({
      project_id: PROJECT, asset_id: "asset_2", generate: true
    });
  });

  it("建索引后显示排队状态与素材名", async () => {
    mount({
      indexSemanticAsset: vi.fn().mockResolvedValue(indexSummary({ status: "queued", job_id: "job_1" }))
    });
    fireEvent.click(screen.getByRole("button", { name: "为此项目建索引" }));
    await waitFor(() => expect(screen.getAllByText("排队中").length).toBe(2));
  });

  it("必须是居中弹窗：走 Dialog 的 modal-backdrop，不能裸渲染 .modal", () => {
    // 回归锁（2026-10-20 真实缺陷）：面板最初直接返回 <div className="modal">，
    // 而居中完全由 .modal-backdrop（position: fixed; inset: 0; place-items: center）提供
    // ⇒ 实际 UI 被挤到窗口左下角。当时 9 条测试全绿，因为都不检查 DOM 结构。
    // 这里钉住「弹窗必须被 backdrop 包裹」，防止再次裸渲染。
    mount();
    const dialog = screen.getByRole("dialog", { name: "素材语义检索" });
    expect(dialog.className).toContain("modal");
    expect(dialog.parentElement?.className).toContain("modal-backdrop");
    // aria-modal 只有 Dialog 会设：裸 div 没有
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("模型未安装：建索引给出可读提示而不是崩掉", async () => {
    const desktop = mount({
      indexSemanticAsset: vi.fn().mockResolvedValue(
        indexSummary({ status: "unavailable", reason: "model_not_installed" })
      )
    });
    fireEvent.click(screen.getByRole("button", { name: "为此项目建索引" }));
    await waitFor(() => expect(document.body.textContent).toContain("语义模型尚未安装，请先在设置中下载 CLIP 模型"));
    expect(document.body.textContent).not.toContain("model_not_installed");
    expect(desktop.indexSemanticAsset).toHaveBeenCalledTimes(2);
    // 面板仍在（没有抛异常炸掉整棵树）。
    expect(screen.getByRole("dialog", { name: "素材语义检索" })).toBeInTheDocument();
  });

  it("建索引抛 SEMANTIC_MODEL_NOT_INSTALLED：给可操作提示而非内部错误串", async () => {
    mount({
      indexSemanticAsset: vi.fn().mockRejectedValue(new Error("SEMANTIC_MODEL_NOT_INSTALLED"))
    });
    fireEvent.click(screen.getByRole("button", { name: "为此项目建索引" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("CLIP 模型"));
    expect(screen.getByRole("alert").textContent).not.toContain("SEMANTIC_MODEL_NOT_INSTALLED");
    expect(screen.getByRole("dialog", { name: "素材语义检索" })).toBeInTheDocument();
  });
});
