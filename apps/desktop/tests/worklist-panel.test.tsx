import { describe, expect, it, vi } from "vitest";
import type { CaptionsProviderProposal } from "@aivideo/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import { WorklistPanel } from "../src/app/worklist/WorklistPanel.js";

const base = { id: "w1", project_id: "p1", base_revision_id: "r1", base_document_sha256: "sha256:a", status: "prepared", current_step_ordinal: 0, step_count: 1, max_steps: 1, token_budget: 1, steps: [], created_at: "now", updated_at: "now", finished_at: null } as never;

afterEach(() => cleanup());

describe("WorklistPanel", () => {
  it("drops a late A response after switching to B", async () => {
    let resolveA!: (value: { items: never[] }) => void;
    const a = new Promise<{ items: never[] }>(resolve => { resolveA = resolve; });
    const api = { listWorklists: vi.fn((projectId: string) => projectId === "p1" ? a : Promise.resolve({ items: [] })), prepareWorklist: vi.fn(), createWorklist: vi.fn() };
    Object.defineProperty(window, "desktop", { configurable: true, value: api });
    const view = render(<WorklistPanel projectId={"p1" as never} baseRevisionId={"r1" as never} onClose={vi.fn()} onApplied={vi.fn()} onNotify={vi.fn()} />);
    view.rerender(<WorklistPanel projectId={"p2" as never} baseRevisionId={"r2" as never} onClose={vi.fn()} onApplied={vi.fn()} onNotify={vi.fn()} />);
    resolveA({ items: [] });
    await waitFor(() => expect(api.listWorklists).toHaveBeenCalledWith("p2"));
    expect(screen.getByText("已有工作单：0 个")).toBeVisible();
  });

  it("drops a late captions proposal response after switching projects", async () => {
    let resolveProposal!: (value: CaptionsProviderProposal) => void;
    const proposal = new Promise<CaptionsProviderProposal>(resolve => { resolveProposal = resolve; });
    const api = { listWorklists: vi.fn().mockResolvedValue({ items: [] }), createCaptionsProviderProposal: vi.fn().mockReturnValue(proposal), prepareWorklist: vi.fn(), createWorklist: vi.fn() };
    Object.defineProperty(window, "desktop", { configurable: true, value: api });
    const view = render(<WorklistPanel projectId={"p1" as never} baseRevisionId={"r1" as never} onClose={vi.fn()} onApplied={vi.fn()} onNotify={vi.fn()} />);
    await screen.findByText("已有工作单：0 个");
    fireEvent.change(screen.getByLabelText("字幕 Provider generation ID"), { target: { value: "g1" } });
    fireEvent.click(screen.getByRole("button", { name: "查看字幕提案（只读）" }));
    view.rerender(<WorklistPanel projectId={"p2" as never} baseRevisionId={"r2" as never} onClose={vi.fn()} onApplied={vi.fn()} onNotify={vi.fn()} />);
    resolveProposal({ captions_provider_proposal_id: "cp1", generation_id: "g1", project_id: "p1", base_revision_id: "r1", base_document_sha256: "sha256:a", patch: { summary: "old", operations: [{ op: "update_caption", caption_id: "c1", text: "old" }] }, patch_sha256: "sha256:a", proposed_document_sha256: "sha256:a", created_at: "now", applied_revision_id: null } as CaptionsProviderProposal);
    await waitFor(() => expect(screen.getByLabelText("字幕 Provider generation ID")).toHaveValue(""));
    expect(screen.queryByText("提案：")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建本地工作单" })).not.toBeDisabled();
  });

  it("requires transcript and unique segments for captions step", async () => {
    const api = { listWorklists: vi.fn().mockResolvedValue({ items: [] }), prepareWorklist: vi.fn(), createWorklist: vi.fn() };
    Object.defineProperty(window, "desktop", { configurable: true, value: api });
    render(<WorklistPanel projectId={"p1" as never} baseRevisionId={"r1" as never} onClose={vi.fn()} onApplied={vi.fn()} onNotify={vi.fn()} />);
    await screen.findByText("已有工作单：0 个");
    fireEvent.change(screen.getByLabelText("工作单步骤类型"), { target: { value: "captions" } });
    fireEvent.change(screen.getByLabelText("Transcript ID"), { target: { value: "t1" } });
    fireEvent.change(screen.getByLabelText("Segment IDs"), { target: { value: "s1,s1" } });
    fireEvent.click(screen.getByRole("button", { name: "创建本地工作单" }));
    expect(await screen.findByRole("status")).toHaveTextContent("不重复");
    expect(api.prepareWorklist).not.toHaveBeenCalled();
  });

  it("clears current worklist and errors on project switch", async () => {
    const api = { listWorklists: vi.fn((projectId: string) => Promise.resolve({ items: projectId === "p1" ? [base] : [] })), createCaptionsProviderProposal: vi.fn(), prepareWorklist: vi.fn(), createWorklist: vi.fn() };
    Object.defineProperty(window, "desktop", { configurable: true, value: api });
    const view = render(<WorklistPanel projectId={"p1" as never} baseRevisionId={"r1" as never} onClose={vi.fn()} onApplied={vi.fn()} onNotify={vi.fn()} />);
    await screen.findByText("已有工作单：1 个");
    fireEvent.click(screen.getByRole("button", { name: /w1/ }));
    expect(screen.getByText("状态：prepared")).toBeVisible();
    view.rerender(<WorklistPanel projectId={"p2" as never} baseRevisionId={"r2" as never} onClose={vi.fn()} onApplied={vi.fn()} onNotify={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("状态：prepared")).not.toBeInTheDocument());
    expect(screen.getByText("已有工作单：0 个")).toBeVisible();
  });

  it("loads only the current project and exposes local worklist action", async () => {
    const api = { listWorklists: vi.fn().mockResolvedValue({ items: [] }), prepareWorklist: vi.fn(), createWorklist: vi.fn() };
    Object.defineProperty(window, "desktop", { configurable: true, value: api });
    render(<WorklistPanel projectId={"p1" as never} baseRevisionId={"r1" as never} onClose={vi.fn()} onApplied={vi.fn()} onNotify={vi.fn()} />);
    expect(await screen.findByText("已有工作单：0 个")).toBeVisible();
    expect(api.listWorklists).toHaveBeenCalledWith("p1");
  });
});
