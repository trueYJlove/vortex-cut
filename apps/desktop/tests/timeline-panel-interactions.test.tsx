import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TimelineDocument } from "@aivideo/contracts";
import { TimelinePanel } from "../src/app/timeline/TimelineCanvas.js";
import { DEFAULT_VIEW_STATE } from "../src/app/timeline/types.js";

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
      // trackHeight 默认值 2026-11-10 起为 56（对齐 OpenFilm 的 TRACK_H.visual）。
    ).toEqual({ snappingEnabled: false, trackHeight: 56, waveformRatio: 0.4 });
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
    // T10：参照 ContextMenu 的 role=menu 无 aria-label（aria-orientation 承担），按角色定位。
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除片段" }));
    expect(props.onPatch).toHaveBeenCalledWith(
      [{ op: "remove_clip", clip_id: "clip_1" }],
      "删除片段",
    );
    expect(screen.queryByRole("menu")).toBeNull();
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
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // T10：参照菜单自带 pointerdown capture 关闭（mouseDown 事件不算——监听的是 pointerdown）。
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("右键菜单的定位播放头使用点击位置", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    /* 时间 = (x − headerWidth) / pps。**不要写死 headerWidth**：
       它已按参照从 120 改为 108（OpenFilm HEAD_W），写死字面量会让
       「改了轨道头宽度」表现为「定位播放头算错了」——错误信息指错方向。
       从默认视图状态取，跟随常量。 */
    const headerW = DEFAULT_VIEW_STATE.headerWidth;
    const pps = DEFAULT_VIEW_STATE.pixelsPerSecond;
    fireEvent.contextMenu(canvas, { clientX: 500, clientY: 124 });
    fireEvent.click(screen.getByRole("menuitem", { name: "定位播放头" }));
    expect(props.onSeek).toHaveBeenCalledWith(expect.closeTo(((500 - headerW) / pps) * 1_000_000, 0));
  });
});

describe("Timeline Round 4 — 空区单击定位播放头", () => {
  it("空区单击（无拖动）移动播放头并清除选择；超过素材终点时钳制到终点", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    // 点击 500px → 6.33s，超出 2s 素材终点 → 钳制到 2s（标尺不超过素材长度）。
    fireEvent.mouseDown(canvas, { clientX: 500, clientY: 124, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 500, clientY: 124 });
    expect(props.onSeek).toHaveBeenCalledWith(expect.closeTo(2_000_000, 0));
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
