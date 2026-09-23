import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TimelineDocument } from "@aivideo/contracts";
import { TimelinePanel } from "../src/app/timeline/TimelineCanvas.js";

const doc = (): TimelineDocument => ({
  schema_version: 1,
  project_id: "p1" as never,
  canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, background_color: "#000000" },
  tracks: [
    { id: "V2", kind: "video", locked: false, hidden: false, muted: false, solo: false },
    { id: "T1", kind: "text", locked: false, hidden: false, muted: false, solo: false },
    { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false },
    { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
    { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
  ],
  clips: [
    {
      clip_id: "clip_v2" as never,
      track_id: "V2",
      order_index: 0,
      asset_id: "a2" as never,
      asset_kind: "video",
      source_start_us: 0,
      source_end_us: 1_000_000,
      timeline_start_us: 0,
      timeline_end_us: 1_000_000,
      layout: "fit",
      audio: { enabled: true, gain_db: 0 },
    },
  ],
  captions: [],
  provenance: { created_by: "user", source_transcript_ids: [] },
});

describe("轨道属性头", () => {
  afterEach(() => cleanup());
  it("下移轨道按钮提交 move_track patch", () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    render(<TimelinePanel document={doc()} selection={null} setSelection={vi.fn()} onPatch={onPatch} onDropAsset={vi.fn()} canUndo={false} canRedo={false} onUndo={vi.fn()} onRedo={vi.fn()} assetMedia={[]} onSeek={vi.fn()} onCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "下移轨道 V2" }));
    expect(onPatch).toHaveBeenCalledWith([{ op: "move_track", track_id: "V2", to_index: 1 }], "调整轨道顺序");
  });
  it("锁定/隐藏按钮提交 set_track_flags patch；文本轨无静音按钮", () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    render(<TimelinePanel document={doc()} selection={null} setSelection={vi.fn()} onPatch={onPatch} onDropAsset={vi.fn()} canUndo={false} canRedo={false} onUndo={vi.fn()} onRedo={vi.fn()} assetMedia={[]} onSeek={vi.fn()} onCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "隐藏轨道 V2" }));
    expect(onPatch).toHaveBeenCalledWith([{ op: "set_track_flags", track_id: "V2", hidden: true }], "调整轨道属性");
    expect(screen.queryByRole("button", { name: "静音轨道 T1" })).toBeNull();
  });
  it("封面入口钉在 V1 行（上方有 V2/T1/C1 时不再错挂首行），高度与 V1 轨道头一致", () => {
    // 剪映式：封面与 V1 轨道头（左侧图标区）同高齐平。V1 之上有动态轨时，
    // 封面必须跟随 V1 行 y——旧实现写死 top=rulerHeight+2（首行），加了
    // 字幕轨/动态视频轨就错位（2026-09-23 用户反馈）。
    const onCaptureCover = vi.fn();
    render(<TimelinePanel document={doc()} selection={null} setSelection={vi.fn()} onPatch={vi.fn().mockResolvedValue(undefined)} onDropAsset={vi.fn()} canUndo={false} canRedo={false} onUndo={vi.fn()} onRedo={vi.fn()} assetMedia={[]} onSeek={vi.fn()} onCommand={vi.fn()} coverUrl={null} onCaptureCover={onCaptureCover} />);
    const entry = document.querySelector(".timeline-cover-entry") as HTMLElement | null;
    expect(entry).not.toBeNull();
    const top = parseFloat(entry!.style.top);
    const height = parseFloat(entry!.style.height);
    // 默认视图：rulerHeight=16，V2/T1/C1 均为 0.7×80=56px 行高 → V1 y=184。
    expect(top).toBe(16 + 3 * 56 + 2);
    // V1 是主轨：全行高 80（不受 0.7 副行比影响）→ 入口高 = 80-4。
    expect(height).toBe(80 - 4);
    fireEvent.click(entry!);
    expect(onCaptureCover).toHaveBeenCalled();
  });
});
