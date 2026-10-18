/**
 * W3.1 语义检索面板测试。
 *
 * 重点不是「能渲染」，而是钉住三条纪律：
 * 1) A8 留空 ⇒ UI 不得出现命中率/准确率话术（P142）；
 * 2) 模型未装 ⇒ 给人话出路，不抛内部错误串；
 * 3) 空结果与失败是不同状态（不把失败显示成「没有匹配」）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectId } from "@aivideo/contracts";
import { SemanticSearchPanel } from "../src/app/semantic-search/SemanticSearchPanel.js";

const PROJECT = "project_1" as ProjectId;

function mount(overrides: Record<string, unknown> = {}) {
  const desktop = {
    searchSemantic: vi.fn().mockResolvedValue({ query: "car", hits: [] }),
    indexSemanticAsset: vi.fn(),
    ...overrides
  };
  (window as unknown as { desktop: unknown }).desktop = desktop;
  render(
    <SemanticSearchPanel
      projectId={PROJECT}
      assetNames={{ asset_1: "素材一" }}
      onClose={() => {}}
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
});