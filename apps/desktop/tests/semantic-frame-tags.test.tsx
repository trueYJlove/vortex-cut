/**
 * W3.3 S5a：面板「按画面标签过滤」（D1 的最小可见面）。
 *
 * 这些用例刻意**打真实端点**（mock 的是 desktop API，不是组件内部状态），
 * 因为 D1 的验收口径是「面板按落库标签过滤」——
 * 若面板读的是硬编码或本地伪造数据，用例必须红。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { SemanticSearchPanel } from "../src/app/semantic-search/SemanticSearchPanel.js";

const projectId = "project_1" as never;

function setup(overrides: Record<string, unknown> = {}) {
  const filterFramesByLabel = vi.fn().mockResolvedValue({ label: "人物", hits: [] });
  const searchSemantic = vi.fn().mockResolvedValue({ query: "", hits: [] });
  const indexSemanticAsset = vi.fn().mockResolvedValue({
    index_id: null, status: null, job_id: null, frame_count: null,
    algorithm_version: null, model_id: null, reason: null
  });
  (window as unknown as { desktop: Record<string, unknown> }).desktop = {
    filterFramesByLabel, searchSemantic, indexSemanticAsset, subscribeJob: vi.fn(() => () => {}),
    ...overrides
  };
  return { filterFramesByLabel, searchSemantic, indexSemanticAsset };
}

afterEach(cleanup);

describe("SemanticSearchPanel 按标签过滤", () => {
  it("按标签过滤会真的调用端点，并把结果渲染出来", async () => {
    const { filterFramesByLabel } = setup();
    filterFramesByLabel.mockResolvedValueOnce({
      label: "人物",
      hits: [{ asset_id: "asset_1", frame_index: 3, timestamp_us: 65_000_000, labels: ["人物", "室内"], notes: null }]
    });
    render(<SemanticSearchPanel projectId={projectId} assetNames={{ asset_1: "素材甲" }} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText("画面标签"), { target: { value: "人物" } });
    fireEvent.click(screen.getByRole("button", { name: "按标签过滤" }));

    await waitFor(() => expect(filterFramesByLabel).toHaveBeenCalledWith({
      project_id: projectId, label: "人物", limit: 100
    }));
    // 渲染的是**落库回来的**标签，不是组件自己编的
    expect(await screen.findByText("#3 · 1:05.00")).toBeTruthy();
    expect(screen.getByText("人物、室内")).toBeTruthy();
    expect(screen.getByText("素材甲")).toBeTruthy();
  });

  it("空标签在客户端就被拦下，不发请求", async () => {
    const { filterFramesByLabel } = setup();
    render(<SemanticSearchPanel projectId={projectId} assetNames={{}} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "按标签过滤" }));

    expect(filterFramesByLabel).not.toHaveBeenCalled();
    expect(screen.getByText("请输入标签")).toBeTruthy();
  });

  it("无命中时给出可操作的说明（而不是空白）", async () => {
    const { filterFramesByLabel } = setup();
    filterFramesByLabel.mockResolvedValueOnce({ label: "动物", hits: [] });
    render(<SemanticSearchPanel projectId={projectId} assetNames={{}} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText("画面标签"), { target: { value: "动物" } });
    fireEvent.click(screen.getByRole("button", { name: "按标签过滤" }));

    await waitFor(() => expect(filterFramesByLabel).toHaveBeenCalled());
    expect(await screen.findByText(/没有帧带该标签/)).toBeTruthy();
  });

  it("端点失败时只给稳定文案，不泄漏上游细节", async () => {
    const { filterFramesByLabel } = setup();
    filterFramesByLabel.mockRejectedValueOnce(new Error("INTERNAL_ERROR at C:/secret/path.db"));
    render(<SemanticSearchPanel projectId={projectId} assetNames={{}} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText("画面标签"), { target: { value: "人物" } });
    fireEvent.click(screen.getByRole("button", { name: "按标签过滤" }));

    expect(await screen.findByText("过滤失败，请稍后重试")).toBeTruthy();
    expect(screen.queryByText(/secret\/path/)).toBeNull();
  });

  it("面板明确说明标签需要显式开启 Layer 2 才会产生", async () => {
    setup();
    render(<SemanticSearchPanel projectId={projectId} assetNames={{}} onClose={() => {}} />);

    // 这句是 D4 的可见性要求：不能让用户以为标签是自动来的。
    expect(screen.getByText(/需要你显式开启并逐张审阅/)).toBeTruthy();
  });
});
