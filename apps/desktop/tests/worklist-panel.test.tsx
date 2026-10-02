import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

  it("loads only the current project and exposes local worklist action", async () => {
    const api = { listWorklists: vi.fn().mockResolvedValue({ items: [] }), prepareWorklist: vi.fn(), createWorklist: vi.fn() };
    Object.defineProperty(window, "desktop", { configurable: true, value: api });
    render(<WorklistPanel projectId={"p1" as never} baseRevisionId={"r1" as never} onClose={vi.fn()} onApplied={vi.fn()} onNotify={vi.fn()} />);
    expect(await screen.findByText("已有工作单：0 个")).toBeVisible();
    expect(api.listWorklists).toHaveBeenCalledWith("p1");
  });
});
