import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TimelineDocument } from "@aivideo/contracts";
import { TimelinePanel } from "../src/app/timeline/TimelineCanvas.js";

const doc = (overrides: Partial<TimelineDocument> = {}): TimelineDocument => ({
  schema_version: 1,
  project_id: "p1" as never,
  canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, background_color: "#000000" },
  tracks: [
    { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false },
    { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
    { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
  ],
  clips: [
    {
      clip_id: "clip_1" as never,
      track_id: "V1",
      order_index: 0,
      asset_id: "a1" as never,
      asset_kind: "video",
      source_start_us: 0,
      source_end_us: 2_000_000,
      timeline_start_us: 0,
      timeline_end_us: 2_000_000,
      layout: "fit",
      audio: { enabled: true, gain_db: 0 },
    },
  ],
  captions: [],
  provenance: { created_by: "user", source_transcript_ids: [] },
  ...overrides,
});

function baseProps() {
  return {
    selection: null,
    setSelection: vi.fn(),
    onPatch: vi.fn().mockResolvedValue(undefined),
    onDropAsset: vi.fn(),
    canUndo: false,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    assetMedia: [],
    playheadUs: 0,
    onSeek: vi.fn(),
    onCommand: vi.fn(),
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("Timeline Round 4 — 磁吸开关", () => {
  it("切换开关并持久化到 localStorage", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const magnet = screen.getByRole("button", { name: "磁吸吸附" });
    expect(magnet).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(magnet);
    expect(magnet).toHaveAttribute("aria-pressed", "false");
    expect(
      JSON.parse(window.localStorage.getItem("vortex-cut.timeline.prefs.v1") ?? "{}"),
    ).toEqual({ snappingEnabled: false, trackHeight: 80, waveformRatio: 0.4 });
  });

  it("从 localStorage 恢复上次的状态", () => {
    window.localStorage.setItem(
      "vortex-cut.timeline.prefs.v1",
      JSON.stringify({ snappingEnabled: false }),
    );
    render(<TimelinePanel document={doc()} {...baseProps()} />);
    expect(screen.getByRole("button", { name: "磁吸吸附" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("Timeline Round 4 — 右键菜单", () => {
  it("右键片段弹出菜单，删除片段提交 remove_clip patch", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    // 片段 rect：x [120, 240]、V1 行 y [92, 156]（默认 60pps、2s 片段；
    // 多轨道布局 C1=0 行、V1=1 行、A1=2 行）。
    fireEvent.contextMenu(canvas, { clientX: 150, clientY: 124 });
    expect(screen.getByRole("menu", { name: "时间线右键菜单" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除片段" }));
    expect(props.onPatch).toHaveBeenCalledWith(
      [{ op: "remove_clip", clip_id: "clip_1" }],
      "删除片段",
    );
    expect(screen.queryByRole("menu", { name: "时间线右键菜单" })).toBeNull();
  });

  it("右键空区弹出粘贴/定位菜单，复制走编辑器命令", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    fireEvent.contextMenu(canvas, { clientX: 500, clientY: 124 });
    fireEvent.click(screen.getByRole("menuitem", { name: "粘贴到播放头" }));
    expect(props.onCommand).toHaveBeenCalledWith("timeline.paste");
  });

  it("点击菜单外部关闭菜单", () => {
    render(<TimelinePanel document={doc()} {...baseProps()} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    fireEvent.contextMenu(canvas, { clientX: 150, clientY: 124 });
    expect(screen.getByRole("menu", { name: "时间线右键菜单" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu", { name: "时间线右键菜单" })).toBeNull();
  });

  it("右键菜单的定位播放头使用点击位置", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    // 空区 x 500 → 时间 ((500-120)/60)s ≈ 6.333s。
    fireEvent.contextMenu(canvas, { clientX: 500, clientY: 124 });
    fireEvent.click(screen.getByRole("menuitem", { name: "定位播放头" }));
    expect(props.onSeek).toHaveBeenCalledWith(expect.closeTo(6_333_333, 0));
  });
});

describe("Timeline Round 4 — 空区单击定位播放头", () => {
  it("空区单击（无拖动）移动播放头并清除选择", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    fireEvent.mouseDown(canvas, { clientX: 500, clientY: 124, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 500, clientY: 124 });
    expect(props.onSeek).toHaveBeenCalledWith(expect.closeTo(6_333_333, 0));
    expect(props.setSelection).toHaveBeenCalledWith(null);
  });

  it("空区按住拖动 = 拖动播放头（剪映式，鼠标不在素材上即可拖动）", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    fireEvent.mouseDown(canvas, { clientX: 500, clientY: 124, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 600, clientY: 124 });
    fireEvent.mouseUp(canvas, { clientX: 600, clientY: 124 });
    expect(props.onSeek).toHaveBeenCalled();
  });

  it("Shift + 拖动仍是框选，不移动播放头", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    fireEvent.mouseDown(canvas, { clientX: 400, clientY: 124, button: 0, shiftKey: true });
    fireEvent.mouseMove(canvas, { clientX: 600, clientY: 200, shiftKey: true });
    fireEvent.mouseUp(canvas, { clientX: 600, clientY: 200, shiftKey: true });
    expect(props.onSeek).not.toHaveBeenCalled();
  });
});
