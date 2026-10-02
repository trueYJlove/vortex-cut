import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorklistPanel } from "../src/app/worklist/WorklistPanel.js";

const base = { id: "w1", project_id: "p1", base_revision_id: "r1", base_document_sha256: "sha256:a", status: "prepared", current_step_ordinal: 0, step_count: 1, max_steps: 1, token_budget: 1, steps: [], created_at: "now", updated_at: "now", finished_at: null } as never;

describe("WorklistPanel", () => {
  it("loads only the current project and exposes local worklist action", async () => {
    const api = { listWorklists: vi.fn().mockResolvedValue({ items: [] }), prepareWorklist: vi.fn(), createWorklist: vi.fn() };
    Object.defineProperty(window, "desktop", { configurable: true, value: api });
    render(<WorklistPanel projectId={"p1" as never} baseRevisionId={"r1" as never} onClose={vi.fn()} onApplied={vi.fn()} onNotify={vi.fn()} />);
    expect(await screen.findByText("已有工作单：0 个")).toBeVisible();
    expect(api.listWorklists).toHaveBeenCalledWith("p1");
  });
});
