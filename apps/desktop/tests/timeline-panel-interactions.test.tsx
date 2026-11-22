import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { isTimelinePatchOperation, type TimelineDocument } from "@aivideo/contracts";
import { TimelinePanel } from "../src/app/timeline/TimelineCanvas.js";
import { DEFAULT_VIEW_STATE } from "../src/app/timeline/types.js";
import { saveMarkers } from "../src/app/timeline/markers.js";
import { closeGapAt } from "../src/app/timeline/close-gap.js";
import { createPlayheadStore } from "../src/app/timeline/playhead-store.js";
import { planCompactMainTrack, planMagneticDelete, planMagneticDrop, planMagneticMove, planMagneticSpeed, planMagneticTrim } from "../src/app/timeline/magnetic-plan.js";

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
  it("关闭主轨空隙时联动短覆盖片段，并阻止重叠", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    const overlay = { ...first, clip_id: "overlay" as never, track_id: "V2", timeline_start_us: 3_200_000, timeline_end_us: 4_000_000 };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    const result = planCompactMainTrack(doc({ clips: [first, second, overlay], tracks }), true);
    expect(result.operations).toEqual([{ op: "position_clips", placements: [
      { clip_id: second.clip_id, timeline_start_us: 2_000_000 },
      { clip_id: overlay.clip_id, timeline_start_us: 2_200_000 },
    ] }]);
    const obstacle = { ...overlay, clip_id: "obstacle" as never, timeline_start_us: 2_000_000, timeline_end_us: 2_400_000 };
    expect(planCompactMainTrack(doc({ clips: [first, second, overlay, obstacle], tracks }), true).reason).toBe("联动后片段会重叠");
  });
  it("磁吸删除主轨时删除附着画面、保留声音并联动后续片段", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const overlay = { ...first, clip_id: "overlay" as never, track_id: "V2", timeline_start_us: 200_000, timeline_end_us: 1_000_000 };
    const later = { ...overlay, clip_id: "later" as never, timeline_start_us: 2_200_000, timeline_end_us: 3_000_000 };
    const sound = { ...overlay, clip_id: "sound" as never, track_id: "A1", asset_kind: "audio" as const };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    const plan = planMagneticDelete(doc({ clips: [first, second, overlay, later, sound], tracks }), [first], true);
    expect(plan.operations).toEqual([
      { op: "remove_clip", clip_id: first.clip_id },
      { op: "remove_clip", clip_id: overlay.clip_id },
      { op: "position_clips", placements: [
        { clip_id: second.clip_id, timeline_start_us: 0 },
        { clip_id: later.clip_id, timeline_start_us: 200_000 },
      ] },
    ]);
    const gapped = { ...second, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    expect(planMagneticDelete(doc({ clips: [first, gapped] }), [first], false).operations).toEqual([
      { op: "remove_clip", clip_id: first.clip_id },
      { op: "position_clips", placements: [{ clip_id: gapped.clip_id, timeline_start_us: 1_000_000 }] },
    ]);
  });
  it("主轨磁吸换序时将覆盖片段随宿主移动", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const overlay = { ...first, clip_id: "overlay" as never, track_id: "V2", timeline_start_us: 200_000, timeline_end_us: 1_000_000 };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    expect(planMagneticMove(doc({ clips: [first, second, overlay], tracks }), first.clip_id, 4_000_000, true).operations).toEqual([
      { op: "position_clips", placements: [
        { clip_id: first.clip_id, timeline_start_us: 2_000_000 },
        { clip_id: second.clip_id, timeline_start_us: 0 },
        { clip_id: overlay.clip_id, timeline_start_us: 2_200_000 },
      ] },
    ]);
  });
  it("主轨拖放换序自动闭合并联动后续覆盖片段", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const overlay = { ...first, clip_id: "overlay" as never, track_id: "V2", timeline_start_us: 2_200_000, timeline_end_us: 3_000_000 };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    expect(planMagneticMove(doc({ clips: [first, second, overlay], tracks }), second.clip_id, 0, true).operations).toEqual([
      { op: "position_clips", placements: [
        { clip_id: first.clip_id, timeline_start_us: 2_000_000 },
        { clip_id: second.clip_id, timeline_start_us: 0 },
        { clip_id: overlay.clip_id, timeline_start_us: 200_000 },
      ] },
    ]);
  });
  it("从其他视频轨拖入主轨时按指针插入并自动闭合", () => {
    const first = doc().clips[0];
    const incoming = { ...first, clip_id: "incoming" as never, track_id: "V2", timeline_start_us: 5_000_000, timeline_end_us: 7_000_000 };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    expect(planMagneticDrop(doc({ clips: [first, incoming], tracks }), incoming.clip_id, "V1", 1_000_000, 1_000_000, true).operations).toEqual([
      { op: "position_clips", placements: [{ clip_id: incoming.clip_id, timeline_start_us: 2_000_000, track_id: "V1" }] },
    ]);
  });
  it("将主轨片段移出时闭合主轨空隙", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    expect(planMagneticDrop(doc({ clips: [first, second], tracks }), first.clip_id, "V2", 5_000_000, 5_000_000, true).operations).toEqual([
      { op: "position_clips", placements: [{ clip_id: second.clip_id, timeline_start_us: 0 }] },
      { op: "position_clip", clip_id: first.clip_id, timeline_start_us: 5_000_000, track_id: "V2" },
    ]);
  });
  it("主轨修剪后自动推移后续内容并保持链接轨道的开头", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const result = planMagneticTrim(doc({ clips: [first, second] }), first, 0, 1_500_000, true);
    expect(result.operations).toEqual([
      { op: "trim_clip", clip_id: first.clip_id, source_start_us: 0, source_end_us: 1_500_000 },
      { op: "position_clips", placements: [{ clip_id: second.clip_id, timeline_start_us: 1_500_000 }] },
    ]);
  });
  it("主轨变速时磁吸开关控制后续推移，联动开关带动覆盖素材", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 };
    const overlay = { ...first, clip_id: "overlay" as never, track_id: "V2", timeline_start_us: 2_200_000, timeline_end_us: 3_000_000 };
    const tracks = [...doc().tracks, { id: "V2", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false }];
    expect(planMagneticSpeed(doc({ clips: [first, second, overlay], tracks }), first, 2000, true, true).operations).toEqual([
      { op: "set_speed", clip_id: first.clip_id, speed_milli: 2000, ripple: false },
      { op: "position_clips", placements: [
        { clip_id: second.clip_id, timeline_start_us: 1_000_000 },
        { clip_id: overlay.clip_id, timeline_start_us: 1_200_000 },
      ] },
    ]);
    expect(planMagneticSpeed(doc({ clips: [first, second, overlay], tracks }), first, 500, false, true).operations).toEqual([
      { op: "set_speed", clip_id: first.clip_id, speed_milli: 500, ripple: false },
    ]);
  });
  it("I/O 设置时间区间并在切换项目时清空", () => {
    const store = createPlayheadStore();
    store.dispatch({ source: "user", timeUs: 500_000 });
    const { rerender } = render(<TimelinePanel document={doc()} {...baseProps()} playheadStore={store} />);
    fireEvent.keyDown(window, { key: "i" });
    expect(screen.getByRole("slider", { name: "时间区间入点" })).toHaveAttribute("aria-valuenow", "0.5");
    store.dispatch({ source: "user", timeUs: 1_500_000 });
    fireEvent.keyDown(window, { key: "o" });
    expect(screen.getByRole("slider", { name: "时间区间出点" })).toHaveAttribute("aria-valuenow", "1.5");
    rerender(<TimelinePanel document={doc({ project_id: "p2" as never })} {...baseProps()} playheadStore={store} />);
    expect(screen.queryByRole("slider", { name: "时间区间入点" })).toBeNull();
  });
  it("关闭指定空隙时保留后续片段间距，且不移动锁定或链接片段", () => {
    const first = doc().clips[0];
    const next = { ...first, clip_id: "clip_2" as never, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    const last = { ...first, clip_id: "clip_3" as never, timeline_start_us: 6_000_000, timeline_end_us: 8_000_000 };
    expect(closeGapAt(doc({ clips: [first, next, last] }), "V1", 2_500_000)).toEqual([{ op: "position_clips", placements: [
      { clip_id: next.clip_id, timeline_start_us: 2_000_000 },
      { clip_id: last.clip_id, timeline_start_us: 5_000_000 },
    ] }]);
    const sound = { ...next, clip_id: "sound" as never, track_id: "A1", asset_kind: "audio" as const, link_group_id: "g" };
    expect(closeGapAt(doc({ clips: [first, { ...next, link_group_id: "g" }, last, sound] }), "V1", 2_500_000)).toEqual([{ op: "position_clips", placements: [
      { clip_id: next.clip_id, timeline_start_us: 2_000_000 },
      { clip_id: last.clip_id, timeline_start_us: 5_000_000 },
      { clip_id: sound.clip_id, timeline_start_us: 2_000_000 },
    ] }]);
    expect(closeGapAt(doc({ clips: [first, { ...next, link_group_id: "g" }, last, sound], locked_elements: [sound.clip_id] }), "V1", 2_500_000)).toEqual([]);
    expect(closeGapAt(doc({ clips: [first, next, last], locked_elements: [last.clip_id] }), "V1", 2_500_000)).toEqual([]);
    expect(isTimelinePatchOperation({ op: "position_clips", placements: [
      { clip_id: next.clip_id, timeline_start_us: 0 }, { clip_id: next.clip_id, timeline_start_us: 1 },
    ] })).toBe(false);
  });
  it("从轨道空隙右键菜单提交关闭空隙", () => {
    const first = doc().clips[0];
    const next = { ...first, clip_id: "clip_2" as never, timeline_start_us: 3_000_000, timeline_end_us: 5_000_000 };
    const props = baseProps();
    const { container } = render(<TimelinePanel document={doc({ clips: [first, next] })} {...props} />);
    fireEvent.contextMenu(container.querySelector("canvas")!, {
      clientX: DEFAULT_VIEW_STATE.headerWidth + DEFAULT_VIEW_STATE.pixelsPerSecond * 2.5,
      clientY: 102,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭空隙" }));
    expect(props.onPatch).toHaveBeenCalledWith([{ op: "position_clips", placements: [{ clip_id: next.clip_id, timeline_start_us: 2_000_000 }] }], "关闭空隙");
  });
  it("链接选中片段后可按组解除链接", () => {
    const first = doc().clips[0];
    const second = { ...first, clip_id: "clip_2" as never, track_id: "A1", asset_kind: "audio" as const };
    const props = baseProps();
    const selected = { kind: "clips" as const, ids: [first.clip_id, second.clip_id] };
    const { rerender } = render(<TimelinePanel document={doc({ clips: [first, second] })} {...props} selection={selected} />);
    fireEvent.click(screen.getByRole("button", { name: "链接片段" }));
    expect(props.onPatch).toHaveBeenCalledWith([{ op: "set_clip_link", clip_ids: [first.clip_id, second.clip_id] }], "链接片段");
    rerender(<TimelinePanel document={doc({ clips: [{ ...first, link_group_id: "g" }, { ...second, link_group_id: "g" }] })} {...props} selection={selected} />);
    fireEvent.click(screen.getByRole("button", { name: /Clip 1 video/ }));
    expect(props.setSelection).toHaveBeenLastCalledWith({ kind: "clips", ids: [first.clip_id, second.clip_id] });
    fireEvent.click(screen.getByRole("button", { name: "取消片段链接" }));
    expect(props.onPatch).toHaveBeenLastCalledWith([{ op: "clear_clip_link", clip_id: first.clip_id }], "取消片段链接");
    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    expect(props.onPatch).toHaveBeenLastCalledWith([{ op: "remove_clip", clip_id: first.clip_id }], "主轨磁吸删除");
  });
  it("Alt 拖动链接片段时只移动当前片段", () => {
    const first = { ...doc().clips[0], link_group_id: "g" };
    const second = { ...first, clip_id: "clip_2" as never, track_id: "A1", asset_kind: "audio" as const };
    const props = baseProps();
    const { container } = render(<TimelinePanel document={doc({ clips: [first, second] })} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    fireEvent.mouseDown(canvas, { clientX: 150, clientY: 102, button: 0, altKey: true });
    fireEvent.mouseMove(canvas, { clientX: 210, clientY: 102, buttons: 1, altKey: true });
    fireEvent.mouseUp(canvas, { clientX: 210, clientY: 102, button: 0, altKey: true });
    expect(props.setSelection).toHaveBeenCalledWith({ kind: "clip", id: first.clip_id });
    expect(props.onPatch).toHaveBeenCalledWith([expect.objectContaining({ op: "position_clip", clip_id: first.clip_id, ignore_link: true })], "移动片段");
  });
  it("拖动链接组时不会将较早的音频推到时间线零点之前", () => {
    const first = { ...doc().clips[0], link_group_id: "g", timeline_start_us: 1_000_000, timeline_end_us: 3_000_000 };
    const second = { ...first, clip_id: "clip_2" as never, track_id: "A1", asset_kind: "audio" as const, timeline_start_us: 0, timeline_end_us: 2_000_000 };
    const props = baseProps();
    const { container } = render(<TimelinePanel document={doc({ clips: [first, second] })} {...props} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    fireEvent.mouseDown(canvas, { clientX: 210, clientY: 102, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 150, clientY: 102, buttons: 1 });
    fireEvent.mouseUp(canvas, { clientX: 150, clientY: 102, button: 0 });
    expect(props.onPatch).not.toHaveBeenCalled();
  });
  it("标记可通过键盘打开并定位，编辑时可以修改颜色", () => {
    saveMarkers("p1", [{ id: "mark", timeUs: 1_000_000, color: "#ffd76e", label: "节拍" }]);
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const pin = screen.getByRole("button", { name: /标记 节拍/ });
    pin.focus();
    fireEvent.click(pin);
    expect(props.onSeek).toHaveBeenCalledWith(1_000_000);
    expect(screen.getByRole("dialog", { name: "编辑时间线标记" })).toBeInTheDocument();
    const color = screen.getByRole("button", { name: "标记颜色 #4ec9b0" });
    color.focus();
    fireEvent.click(color);
    expect(JSON.parse(window.localStorage.getItem("vortex-cut.timeline.markers.v1") ?? "{}").p1[0].color).toBe("#4ec9b0");
  });
  it("使用 M 创建标记并用 Shift+M 跳转到下一标记", () => {
    saveMarkers("p1", [{ id: "mark", timeUs: 1_000_000, color: "#ffd76e", label: "节拍" }]);
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    fireEvent.keyDown(window, { key: "M", shiftKey: true });
    expect(props.onSeek).toHaveBeenCalledWith(1_000_000);
    fireEvent.keyDown(window, { key: "m" });
    expect(screen.getByRole("dialog", { name: "编辑时间线标记" })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("vortex-cut.timeline.markers.v1") ?? "{}").p1).toHaveLength(2);
  });
  it("标尺靠近项目标记时吸附，关闭吸附后保留原始位置", () => {
    saveMarkers("p1", [{ id: "mark", timeUs: 1_000_000, color: "#ffd76e", label: "节拍" }]);
    const props = baseProps();
    const { container } = render(<TimelinePanel document={doc()} {...props} />);
    const ruler = container.querySelector(".timeline-ruler-pin") as HTMLCanvasElement;
    const x = DEFAULT_VIEW_STATE.headerWidth * 2 + DEFAULT_VIEW_STATE.pixelsPerSecond * 1.1;
    fireEvent.mouseDown(ruler, { clientX: x, button: 0 });
    expect(props.onSeek).toHaveBeenLastCalledWith(1_000_000);
    fireEvent.mouseUp(ruler, { clientX: x, button: 0 });
    fireEvent.click(screen.getByRole("button", { name: "磁吸吸附" }));
    fireEvent.mouseDown(ruler, { clientX: x, button: 0 });
    expect(props.onSeek).toHaveBeenLastCalledWith(expect.closeTo(1_100_000, 0));
  });
  it("切换开关并持久化到 localStorage", () => {
    const props = baseProps();
    render(<TimelinePanel document={doc()} {...props} />);
    const magnet = screen.getByRole("button", { name: "磁吸吸附" });
    expect(magnet).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(magnet);
    expect(magnet).toHaveAttribute("aria-pressed", "false");
    const mainMagnet = screen.getByRole("button", { name: "主轨磁吸" });
    const linkage = screen.getByRole("button", { name: "联动" });
    expect(mainMagnet).toHaveAttribute("aria-pressed", "true");
    expect(linkage).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(mainMagnet);
    fireEvent.click(linkage);
    expect(
      JSON.parse(window.localStorage.getItem("vortex-cut.timeline.prefs.v1") ?? "{}"),
      // trackHeight 默认值 2026-11-10 起为 56（对齐 OpenFilm 的 TRACK_H.visual）。
    ).toEqual({ snappingEnabled: false, mainTrackMagnet: false, linkageEnabled: false, trackHeight: 56, waveformRatio: 0.4 });
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
    fireEvent.click(screen.getByRole("menuitem", { name: "删除并闭合主轨" }));
    expect(props.onPatch).toHaveBeenCalledWith(
      [{ op: "remove_clip", clip_id: "clip_1" }],
      "主轨磁吸删除",
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
