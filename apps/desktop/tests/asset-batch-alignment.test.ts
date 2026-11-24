import type { Asset, TimelineClip, TimelineTrack } from "@aivideo/contracts";
import { describe, expect, it } from "vitest";
import { draggedAssetIds, planAssetDrop } from "../src/app/timeline/asset-drop.js";
import { alignmentBox, groupFrameBounds, planFrameAlignment, planFrameDistribution, planGroupBoundsEdit } from "../src/app/timeline/frame-alignment.js";

const asset = (asset_id: string, kind: Asset["kind"]) => ({ asset_id, kind } as Asset);
const track = (id: string, kind: TimelineTrack["kind"]) => ({ id, kind } as TimelineTrack);
const canvas = { width: 1920, height: 1080 };
const clip = (clip_id: string, x: number, y = 0.5) => ({
  clip_id, layout: "fit", transform: { x, y, scale: 0.5, opacity: 0.7 }
} as TimelineClip);

describe("多片段选区变换", () => {
  const sources = [
    { clip: clip("a", 0.25, 0.25), box: { left: 380, top: 230, width: 200, height: 80 } },
    { clip: clip("b", 0.75, 0.75), box: { left: 1290, top: 745, width: 300, height: 130 } },
  ];

  it("按整个选区测量外框，平移 X 或 Y 时保留另一轴和片段属性", () => {
    expect(groupFrameBounds(sources)).toEqual({ left: 380, top: 230, width: 1210, height: 645 });
    const x = planGroupBoundsEdit("x", 476, canvas, sources);
    const y = planGroupBoundsEdit("y", 284, canvas, sources);
    expect(x).toMatchObject([
      { clip_id: "a", transform: { x: 0.3, y: 0.25, scale: 0.5, opacity: 0.7 } },
      { clip_id: "b", transform: { x: 0.8, y: 0.75, scale: 0.5, opacity: 0.7 } },
    ]);
    expect(y).toMatchObject([
      { clip_id: "a", transform: { x: 0.25, y: 0.3 } },
      { clip_id: "b", transform: { x: 0.75, y: 0.8 } },
    ]);
  });

  it("宽高均从外框左上角等比缩放，并拒绝会越界的整组操作", () => {
    const result = planGroupBoundsEdit("width", 605, canvas, sources);
    expect(result).toEqual(planGroupBoundsEdit("height", 322.5, canvas, sources));
    expect(result?.[0]).toMatchObject({ clip_id: "a", transform: { x: 430 / 1920, y: 250 / 1080, scale: 0.25 } });
    expect(result?.[1]).toMatchObject({ clip_id: "b", transform: { x: 910 / 1920, y: 520 / 1080, scale: 0.25 } });
    expect(planGroupBoundsEdit("width", 1210, canvas, sources)).toEqual([]);
    expect(planGroupBoundsEdit("x", 956, canvas, sources)).toBeNull();
    expect(planGroupBoundsEdit("height", 40, canvas, sources)).toBeNull();
  });
});

describe("批量素材拖放", () => {
  it("拖已选素材时按显示顺序带上选区，拖未选素材时只带该项", () => {
    const order = ["a", "b", "c"];
    const selection = new Set(["c", "a"]);
    expect(draggedAssetIds("c", order, selection)).toEqual(["a", "c"]);
    expect(draggedAssetIds("b", order, selection)).toEqual(["b"]);
  });

  it("整个选区建一条视频轨，画面连续插入，音频落 A1", () => {
    const result = planAssetDrop([asset("v", "video"), asset("a", "audio"), asset("i", "image")],
      [track("V1", "video"), track("V2", "video"), track("A1", "audio")], 4, "new");
    expect(result).toEqual([
      { op: "add_track", kind: "video" },
      { op: "insert_asset_clip", asset_id: "v", at_index: 0, track_id: "V3" },
      { op: "insert_asset_clip", asset_id: "a", at_index: 0 },
      { op: "insert_asset_clip", asset_id: "i", at_index: 1, track_id: "V3", duration_us: 4_000_000 }
    ]);
  });
});

describe("画面对齐", () => {
  const source = { media_info: { video_streams: [{ width: 1920, height: 1080 }] } } as unknown as Asset;
  it("单个片段向画布右边对齐，保留缩放、不透明度和垂直位置", () => {
    const item = clip("a", 0.4, 0.2);
    expect(planFrameAlignment("right", canvas, [{ clip: item, box: alignmentBox(item, source, canvas)! }])).toEqual([
      { op: "set_clip_transform", clip_id: "a", transform: { x: 0.75, y: 0.2, scale: 0.5, opacity: 0.7 } }
    ]);
  });

  it("多个片段按选区左边缘对齐，旋转后的外接框参与计算", () => {
    const first = clip("a", 0.3);
    const second = { ...clip("b", 0.7), transform: { ...clip("b", 0.7).transform, rotate: 90 } };
    const subjects = [first, second].map(item => ({ clip: item, box: alignmentBox(item, source, canvas)! }));
    expect(subjects[1].box.width).toBeCloseTo(540);
    const result = planFrameAlignment("left", canvas, subjects);
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({ op: "set_clip_transform", clip_id: "b", transform: { rotate: 90 } });
    if (result?.[0].op === "set_clip_transform") expect(result[0].transform.x).toBeCloseTo(0.190625);
  });
});

describe("画面等距分布", () => {
  const subject = (id: string, x: number, width: number) => ({
    clip: clip(id, x),
    box: { left: x * canvas.width - width / 2, top: 100, width, height: 80 },
  });

  it("水平分布按不同宽度计算间距并固定首尾", () => {
    const result = planFrameDistribution("horizontal", canvas, [
      subject("a", 0.1, 100), subject("b", 0.4, 200), subject("c", 0.8, 100),
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({ op: "set_clip_transform", clip_id: "b" });
    if (result?.[0].op === "set_clip_transform") {
      expect(result[0].transform.x).toBeCloseTo(0.45);
      expect(result[0].transform.y).toBe(0.5);
      expect(result[0].transform.scale).toBe(0.5);
      expect(result[0].transform.opacity).toBe(0.7);
    }
  });

  it("垂直分布只改中间片段的纵坐标", () => {
    const items = [subject("a", 0.3, 100), subject("b", 0.3, 100), subject("c", 0.3, 100)];
    items[0]!.box.top = 0;
    items[1]!.box.top = 200;
    items[2]!.box.top = 600;
    const result = planFrameDistribution("vertical", canvas, items);
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({ op: "set_clip_transform", clip_id: "b", transform: { x: 0.3, y: 0.5 + 100 / canvas.height } });
  });

  it("中间片段越界时拒绝整个分布批次", () => {
    const items = [subject("a", 0.1, 8000), subject("b", 0.2, 100), subject("c", 0.3, 100)];
    expect(planFrameDistribution("horizontal", canvas, items)).toBeNull();
  });
});
