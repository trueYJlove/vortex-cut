/**
 * E8「全片一键统一音量」的入口回归锁。
 *
 * 这条入口不在片段属性面板（那里只能逐片段），而在通用剪辑语法面板：
 * 选 unify_loudness + 预设参数 {"target_lufs": -16}（**省略 clip_ids = 全片**）。
 *
 * 缺口背景：E8 收口时 STATUS P187 记的是「全片一键没有独立入口」。复核后发现
 * 入口其实存在（通用剪辑语法面板），只是**没有参数预设**——用户选中该规划器
 * 后参数框是 "{}"，等于要自己手写 JSON。本条钉住预设存在且真的发起 prepare。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditingGrammarPanel } from "../src/app/editing-grammar/EditingGrammarPanel.js";

const projectId = "project_1" as never;
const baseRevisionId = "revision_1" as never;

function setup() {
  const prepareEditingGrammar = vi.fn().mockResolvedValue({
    planner: "unify_loudness",
    summary: "统一响度到 -16 LUFS",
    operations: [{ op: "set_audio", clip_id: "clip_a", enabled: true, gain_db: 4.2 }],
    rationale: { clips: [{ clip_id: "clip_a", measured_lufs: -20.2, current_gain_db: 0 }] },
    params: { target_lufs: -16 },
    document: {},
  });
  const desktop = {
    listEditingGrammarPlanners: vi.fn().mockResolvedValue({
      items: [{ name: "unify_loudness", title: "响度归一 / 一键统一音量（E8）", description: "…" }],
    }),
    listEditingGrammarProposals: vi.fn().mockResolvedValue({ items: [] }),
    prepareEditingGrammar,
    proposeEditingGrammar: vi.fn(),
  };
  (window as unknown as { desktop: Record<string, unknown> }).desktop = desktop;
  render(
    <EditingGrammarPanel
      projectId={projectId}
      baseRevisionId={baseRevisionId}
      onClose={() => {}}
      onApplied={() => {}}
      onNotify={() => {}}
    />,
  );
  return { prepareEditingGrammar, desktop };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("E8 全片一键统一音量（通用剪辑语法面板入口）", () => {
  it("选中 unify_loudness 后参数框预填 target_lufs（不再是要手写的 {}）", async () => {
    setup();
    const textarea = await screen.findByLabelText("规划器参数");
    await waitFor(() => {
      expect((textarea as HTMLTextAreaElement).value).toContain("target_lufs");
    });
  });

  it("干跑会真的发起 prepare，且参数**不含 clip_ids**（= 全片）", async () => {
    const { prepareEditingGrammar } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "干跑预览" }));
    await waitFor(() => expect(prepareEditingGrammar).toHaveBeenCalledTimes(1));
    const call = prepareEditingGrammar.mock.calls[0][0] as { planner: string; params: Record<string, unknown> };
    expect(call.planner).toBe("unify_loudness");
    expect(call.params).toEqual({ target_lufs: -16 });
    expect(call.params).not.toHaveProperty("clip_ids");
  });
});
