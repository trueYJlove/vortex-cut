import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BeatAnalysisSummary, TimelineClip } from "@aivideo/contracts";
import { EditingToolsPanel } from "../src/app/editing-grammar/EditingToolsPanel.js";

/** Wave1 收尾（L1/L2）：卡点节拍触发与 L/J 词戳来源徽标。 */

const now = "2026-10-10T00:00:00.000Z";

function clip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    clip_id: "clip_1",
    track_id: "V1",
    order_index: 0,
    asset_id: "asset_bgm",
    asset_kind: "video",
    source_start_us: 0,
    source_end_us: 8_000_000,
    timeline_start_us: 0,
    timeline_end_us: 8_000_000,
    layout: "fit",
    audio: { enabled: false, gain_db: 0 },
    ...overrides,
  } as TimelineClip;
}

function beatSummary(overrides: Partial<BeatAnalysisSummary> = {}): BeatAnalysisSummary {
  return {
    beat_grid_id: null,
    status: null,
    job_id: null,
    bpm: null,
    confidence: null,
    beat_count: null,
    downbeat_count: null,
    algorithm_version: "1",
    reason: null,
    ...overrides,
  };
}

function setup(options: {
  clips?: TimelineClip[];
  getBeatAnalysis?: ReturnType<typeof vi.fn>;
  listTranscripts?: ReturnType<typeof vi.fn>;
  getTranscript?: ReturnType<typeof vi.fn>;
} = {}) {
  const desktop = {
    listEditingGrammarPlanners: vi.fn().mockResolvedValue({ items: [] }),
    listEditingGrammarProposals: vi.fn().mockResolvedValue({ items: [] }),
    prepareEditingGrammar: vi.fn(),
    proposeEditingGrammar: vi.fn(),
    getBeatAnalysis: options.getBeatAnalysis ?? vi.fn().mockResolvedValue(beatSummary()),
    listTranscripts: options.listTranscripts ?? vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    getTranscript: options.getTranscript ?? vi.fn(),
  };
  (window as unknown as { desktop: unknown }).desktop = desktop;
  render(<EditingToolsPanel
    projectId={"project_1" as never}
    baseRevisionId={"revision_1" as never}
    clips={options.clips ?? [clip()]}
    onClose={() => undefined}
    onApplied={() => undefined}
    onNotify={() => undefined}
  />);
  return { desktop };
}

function switchTab(name: RegExp): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("Wave1 L2：卡点节拍网格触发", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("无网格时提示并给「分析节拍」；点击登记作业、轮询到 ready 后收起按钮", async () => {
    const responses: BeatAnalysisSummary[] = [
      beatSummary({ status: null }),
      beatSummary({ status: "queued", job_id: "job_beat" as never }),
      beatSummary({ status: "queued", job_id: "job_beat" as never }),
      beatSummary({ status: "ready", beat_grid_id: "bg_1", bpm: 110.4, beat_count: 60, downbeat_count: 15 }),
    ];
    const getBeatAnalysis = vi.fn(async (input: { project_id: string; asset_id: string; generate: boolean }) => {
      expect(input.project_id).toBe("project_1");
      expect(input.asset_id).toBe("asset_bgm");
      // generate=true 的登记调用返回 queued；轮询调用按序列推进到 ready。
      const index = input.generate ? 1 : (getBeatAnalysis.mock.calls.filter((call: unknown[]) => !(call[0] as { generate: boolean }).generate).length - 1);
      const queue = input.generate ? [responses[1]!] : [responses[0]!, responses[2]!, responses[3]!];
      return queue[Math.min(index, queue.length - 1)]!;
    });
    setup({ getBeatAnalysis });
    switchTab(/卡点/);
    const dialog = screen.getByRole("dialog", { name: "剪辑手法" });
    expect(await within(dialog).findByText(/无节拍网格/)).toBeVisible();
    const analyze = within(dialog).getByRole("button", { name: "分析节拍" });
    // 未点击前不得自动登记（generate=true 只能由用户触发）。
    expect(getBeatAnalysis.mock.calls.some((call: unknown[]) => (call[0] as { generate: boolean }).generate)).toBe(false);
    fireEvent.click(analyze);
    await waitFor(() => {
      expect(getBeatAnalysis.mock.calls.some((call: unknown[]) => (call[0] as { generate: boolean }).generate)).toBe(true);
    });
    // 轮询（1.2s 间隔）到 ready：状态行出现 BPM，按钮收起。
    expect(await within(dialog).findByText(/已就绪 · BPM 110\.4 · 60 拍/, {}, { timeout: 5000 })).toBeVisible();
    await waitFor(() => {
      expect(within(dialog).queryByRole("button", { name: /分析节拍|重新分析节拍/ })).not.toBeInTheDocument();
    });
  });

  it("ready 时直接展示网格摘要且不给分析按钮（负向对照：按钮必须由状态驱动）", async () => {
    setup({ getBeatAnalysis: vi.fn().mockResolvedValue(beatSummary({ status: "ready", beat_grid_id: "bg_1", bpm: 128, beat_count: 64, downbeat_count: 16 })) });
    switchTab(/卡点/);
    const dialog = screen.getByRole("dialog", { name: "剪辑手法" });
    expect(await within(dialog).findByText(/已就绪 · BPM 128\.0/)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: /分析节拍/ })).not.toBeInTheDocument();
  });

  it("unavailable（无音轨/置信度不足）如实提示且仍可重试", async () => {
    setup({ getBeatAnalysis: vi.fn().mockResolvedValue(beatSummary({ status: "unavailable", reason: "low_confidence" })) });
    switchTab(/卡点/);
    const dialog = screen.getByRole("dialog", { name: "剪辑手法" });
    expect(await within(dialog).findByText(/无法检出节拍/)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "分析节拍" })).toBeVisible();
  });
});

describe("Wave1 L1：L/J 词戳来源徽标", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("有 ready 词级转录时显示 ASR ✓（Core 自动拉取，面板无需填 words）", async () => {
    setup({
      listTranscripts: vi.fn().mockResolvedValue({ items: [{ transcript_id: "transcript_1" as never, asset_id: "asset_bgm" as never, status: "ready", language: "zh", provider: "fixture", model_id: "model_1" as never, model_revision: "v1", source_media_fingerprint: "f", duration_us: 8_000_000, created_at: now, updated_at: now }], next_cursor: null }),
      getTranscript: vi.fn().mockResolvedValue({ transcript_id: "transcript_1", asset_id: "asset_bgm", status: "ready", language: "zh", segments: [], words: [{ start_us: 1_000_000, end_us: 1_400_000, text: "a" }], provider: "fixture", model_id: "model_1", model_revision: "v1", source_media_fingerprint: "f", duration_us: 8_000_000, created_at: now, updated_at: now }),
    });
    switchTab(/L\/J/);
    const dialog = screen.getByRole("dialog", { name: "剪辑手法" });
    expect(await within(dialog).findByText(/ASR 词级转录 ✓/)).toBeVisible();
  });

  it("无转录时给出可操作指引（不静默）", async () => {
    setup({ listTranscripts: vi.fn().mockResolvedValue({ items: [], next_cursor: null }) });
    switchTab(/L\/J/);
    const dialog = screen.getByRole("dialog", { name: "剪辑手法" });
    expect(await within(dialog).findByText(/无词级转录/)).toBeVisible();
  });
});
