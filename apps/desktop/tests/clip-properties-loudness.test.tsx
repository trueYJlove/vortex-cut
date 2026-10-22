import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditingGrammarPrepareResult, EditingGrammarProposal, TimelineClip, TimelineDocument } from "@aivideo/contracts";
import { ClipProperties } from "../src/app/PropertyPanels.js";

/** E8：属性面板的「响度统一」必须是真入口（走 Core 三段式），不是只改本地状态。 */

const now = "2026-10-11T00:00:00.000Z";

function clip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    clip_id: "clip_1",
    track_id: "V1",
    order_index: 0,
    asset_id: "asset_1",
    asset_kind: "video",
    source_start_us: 0,
    source_end_us: 5_000_000,
    timeline_start_us: 0,
    timeline_end_us: 5_000_000,
    layout: "fit",
    audio: { enabled: true, gain_db: 0 },
    ...overrides,
  } as TimelineClip;
}

function documentOf(value: TimelineClip): TimelineDocument {
  return {
    schema_version: 1,
    project_id: "project_1" as never,
    canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1, background_color: "#000000" },
    tracks: [],
    clips: [value],
    captions: [],
    provenance: { created_by: "user", source_transcript_ids: [] },
  } as TimelineDocument;
}

function prepareResult(overrides: Partial<EditingGrammarPrepareResult> = {}): EditingGrammarPrepareResult {
  return {
    planner: "unify_loudness",
    params: { clip_ids: ["clip_1"] },
    summary: "响度归一：1 段调整到 -16 LUFS",
    operations: [{ op: "set_audio", clip_id: "clip_1" as never, enabled: true, gain_db: 8.4 }],
    operations_count: 1,
    noop: false,
    rationale: {
      planner: "unify_loudness",
      params: { target_lufs: -16, tolerance_lufs: 0.5 },
      algorithm_version: "ebu-r128-ebur128-v1",
      clips: [{ clip_id: "clip_1", measured_lufs: -24.4, decision: "adjust" }],
    },
    base_revision_id: "revision_1" as never,
    base_document_sha256: "a".repeat(64),
    ...overrides,
  };
}

function proposalOf(): EditingGrammarProposal {
  return {
    editing_grammar_proposal_id: "egp_1",
    project_id: "project_1" as never,
    planner: "unify_loudness",
    params: { clip_ids: ["clip_1"] },
    base_revision_id: "revision_1" as never,
    base_document_sha256: "a".repeat(64),
    patch: { summary: "响度归一", operations: [{ op: "set_audio", clip_id: "clip_1" as never, enabled: true, gain_db: 8.4 }] },
    patch_sha256: "b".repeat(64),
    proposed_document_sha256: "c".repeat(64),
    rationale: {},
    diff: {} as never,
    created_at: now,
    applied_revision_id: null,
  } as EditingGrammarProposal;
}

function setup(options: {
  prepare?: ReturnType<typeof vi.fn>;
  propose?: ReturnType<typeof vi.fn>;
  apply?: ReturnType<typeof vi.fn>;
  onPatch?: ReturnType<typeof vi.fn>;
  baseRevisionId?: string | null;
} = {}) {
  const desktop = {
    prepareEditingGrammar: options.prepare ?? vi.fn().mockResolvedValue(prepareResult()),
    proposeEditingGrammar: options.propose ?? vi.fn().mockResolvedValue(proposalOf()),
    applyEditingGrammarProposal: options.apply ?? vi.fn().mockResolvedValue({
      project_id: "project_1",
      current_revision: { timeline_revision_id: "revision_2", project_id: "project_1" },
      draft: null, can_undo: true, can_redo: false, current_preview: null,
    }),
  };
  (window as unknown as { desktop: unknown }).desktop = desktop;
  const value = clip();
  const onAppliedTimeline = vi.fn();
  render(<ClipProperties
    clip={value}
    working={documentOf(value)}
    baseRevisionId={(options.baseRevisionId === undefined ? "revision_1" : options.baseRevisionId) as never}
    locked={false}
    onPatch={options.onPatch ?? vi.fn()}
    onDraft={() => undefined}
    onAppliedTimeline={onAppliedTimeline}
  />);
  return { desktop, onAppliedTimeline };
}

/** 打开「音频」页签（视频片段才有）。 */
function openAudioTab(): void {
  fireEvent.click(screen.getByRole("tab", { name: /音频/ }));
}

function loudnessRow(): HTMLElement {
  const row = screen.getByText("响度统一").closest(".pp-row");
  if (!row) throw new Error("响度统一 row not found");
  return row as HTMLElement;
}

describe("E8 响度统一：真实入口", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("点开关会发起 prepare（负向对照 3：改回 disabled ⇒ 本条红）", async () => {
    const { desktop } = setup();
    openAudioTab();
    const toggle = within(loudnessRow()).getByRole("switch");
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);

    await waitFor(() => expect(desktop.prepareEditingGrammar).toHaveBeenCalledTimes(1));
    const input = desktop.prepareEditingGrammar.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.planner).toBe("unify_loudness");
    expect(input.project_id).toBe("project_1");
    expect(input.base_revision_id).toBe("revision_1");
    expect(input.params).toEqual({ clip_ids: ["clip_1"] });
  });

  it("prepare 之后展示实测 LUFS，并要求显式生成提案（不直接改文档）", async () => {
    const onPatch = vi.fn();
    const { desktop } = setup({ onPatch });
    openAudioTab();
    fireEvent.click(within(loudnessRow()).getByRole("switch"));

    const panel = await screen.findByTestId("pp-loudness-preview");
    expect(within(panel).getByText(/实测 -24\.4 → 目标 -16 LUFS/)).toBeVisible();
    // 关键：并没有趁机写时间线（三段式里的第一步只是干跑）。
    expect(onPatch).not.toHaveBeenCalled();
    expect(desktop.proposeEditingGrammar).not.toHaveBeenCalled();
  });

  it("生成提案 → 应用提案，apply 后回调新的 TimelineState", async () => {
    const { desktop, onAppliedTimeline } = setup();
    openAudioTab();
    fireEvent.click(within(loudnessRow()).getByRole("switch"));
    const preview = await screen.findByTestId("pp-loudness-preview");

    fireEvent.click(within(preview).getByRole("button", { name: "生成提案" }));
    await waitFor(() => expect(desktop.proposeEditingGrammar).toHaveBeenCalledTimes(1));
    // 提案请求沿用 prepare 的参数（同一 clip 范围）。
    const proposeInput = desktop.proposeEditingGrammar.mock.calls[0]![0] as Record<string, unknown>;
    expect(proposeInput.params).toEqual({ clip_ids: ["clip_1"] });

    const proposal = await screen.findByTestId("pp-loudness-proposal");
    expect(within(proposal).getByText(/待采纳 1 项改动/)).toBeVisible();

    fireEvent.click(within(proposal).getByRole("button", { name: "应用提案" }));
    await waitFor(() => expect(desktop.applyEditingGrammarProposal).toHaveBeenCalledTimes(1));
    const applyInput = desktop.applyEditingGrammarProposal.mock.calls[0]![0] as Record<string, unknown>;
    expect(applyInput.proposal_id).toBe("egp_1");
    expect(applyInput.proposed_document_sha256).toBe("c".repeat(64));

    await waitFor(() => expect(onAppliedTimeline).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/已应用为新的正式 Revision/)).toBeVisible();
  });

  it("prepare 失败时如实显示原因，不假装成功", async () => {
    const failure = Object.assign(new Error("[EDITING_GRAMMAR_BASE_CONFLICT] 基线已变化"), { code: "EDITING_GRAMMAR_BASE_CONFLICT" });
    const prepare = vi.fn().mockRejectedValue(failure);
    setup({ prepare });
    openAudioTab();
    fireEvent.click(within(loudnessRow()).getByRole("switch"));
    expect(await screen.findByText(/时间线已变化，请重新打开属性面板后重试/)).toBeVisible();
    expect(screen.queryByTestId("pp-loudness-preview")).not.toBeInTheDocument();
  });

  it("时间线未就绪时开关禁用并给说明（不能点了没反应）", () => {
    setup({ baseRevisionId: null });
    openAudioTab();
    const toggle = within(loudnessRow()).getByRole("switch");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("title", "时间线尚未就绪");
  });

  it("已达标（noop）时如实说明 0 项改动，不给误导性按钮", async () => {
    const prepare = vi.fn().mockResolvedValue(prepareResult({
      summary: "响度归一：1 段已达标",
      operations: [],
      operations_count: 0,
      noop: true,
      rationale: {
        planner: "unify_loudness",
        params: { target_lufs: -16, tolerance_lufs: 0.5 },
        algorithm_version: "ebu-r128-ebur128-v1",
        clips: [{ clip_id: "clip_1", measured_lufs: -16.2, decision: "noop_within_tolerance" }],
        unchanged: ["clip_1"],
      },
    }));
    setup({ prepare });
    openAudioTab();
    fireEvent.click(within(loudnessRow()).getByRole("switch"));
    const panel = await screen.findByTestId("pp-loudness-preview");
    expect(within(panel).getByText("响度归一：1 段已达标")).toBeVisible();
    expect(within(panel).getByText(/实测 -16\.2 → 目标 -16 LUFS/)).toBeVisible();
  });
});
