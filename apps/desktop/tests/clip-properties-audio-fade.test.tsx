import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip, TimelineDocument } from "@aivideo/contracts";
import { ClipProperties } from "../src/app/PropertyPanels.js";

/**
 * 音频「淡入时长 / 淡出时长」滑块必须是真控件：
 * - 不是 disabled 的规划占位；
 * - 拖动走既有 onPatch(set_audio) 通道（不新开 IPC）；
 * - 值能从 clip.audio.fade_*_us 读回（面板重开不是空的）。
 *
 * 负向对照 4：把这两个滑块改回 disabled 占位 ⇒ 本文件的用例全红。
 */

function clip(audio: Partial<TimelineClip["audio"]> = {}): TimelineClip {
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
    audio: { enabled: true, gain_db: 0, ...audio },
  } as TimelineClip;
}

function documentOf(value: TimelineClip): TimelineDocument {
  return {
    schema_version: 1,
    project_id: "project_1",
    canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1, background_color: "#000000" },
    tracks: [],
    clips: [value],
    captions: [],
    provenance: { created_by: "user", source_transcript_ids: [] },
  } as unknown as TimelineDocument;
}

/**
 * 受控宿主：RangeRow 是受控组件（值来自 clip 属性），真实应用里 onDraft 会把
 * 草稿回灌到 clip。测试里也必须回灌，否则松手时读到的是被 React 重置回旧值
 * 的 input.value——那会掩盖「拖动到底有没有生效」。
 */
function Harness({ initial, onPatch, onDraft }: {
  initial: TimelineClip;
  onPatch: ReturnType<typeof vi.fn>;
  onDraft: ReturnType<typeof vi.fn>;
}) {
  const [value, setValue] = useState(initial);
  return <ClipProperties
    clip={value}
    working={documentOf(value)}
    baseRevisionId={"revision_1" as never}
    locked={false}
    onPatch={onPatch}
    onDraft={(doc: TimelineDocument) => {
      onDraft(doc);
      setValue(doc.clips[0] as TimelineClip);
    }}
  />;
}

function setup(audio: Partial<TimelineClip["audio"]> = {}) {
  const value = clip(audio);
  const onPatch = vi.fn().mockResolvedValue(undefined);
  const onDraft = vi.fn();
  render(<Harness initial={value} onPatch={onPatch} onDraft={onDraft} />);
  fireEvent.click(screen.getByRole("tab", { name: /音频/ }));
  return { onPatch, onDraft, value };
}

/** 滑杆本体：RangeRow 把同一个 aria-label 同时给了 range 与数字步进器，按 type 唯一定位。 */
function slider(ariaLabel: string): HTMLInputElement {
  const found = screen.getAllByLabelText(ariaLabel).filter(
    element => (element as HTMLInputElement).type === "range",
  );
  expect(found).toHaveLength(1);
  return found[0] as HTMLInputElement;
}

describe("音频淡入/淡出滑块：真控件", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("滑块可用（不是规划占位），初始值来自 clip.audio", () => {
    setup({ fade_in_us: 1_200_000, fade_out_us: 800_000 });
    const fadeIn = slider("淡入时长");
    const fadeOut = slider("淡出时长");
    expect(fadeIn).toBeEnabled();
    expect(fadeOut).toBeEnabled();
    // 单位与既有 UI 一致：秒（1.2s / 0.8s）。
    expect(fadeIn.value).toBe("1.2");
    expect(fadeOut.value).toBe("0.8");
  });

  it("拖动只改本地草稿，不发 patch（onCommit 才写时间线）", () => {
    const { onPatch, onDraft } = setup();
    fireEvent.change(slider("淡入时长"), { target: { value: "2.5" } });
    expect(onPatch).not.toHaveBeenCalled();
    expect(onDraft).toHaveBeenCalledTimes(1);
    const draft = onDraft.mock.calls[0]![0] as TimelineDocument;
    expect(draft.clips[0]!.audio.fade_in_us).toBe(2_500_000);
  });

  it("松手发 set_audio（含 fade_in_us），走既有 onPatch 通道", () => {
    const { onPatch } = setup({ fade_out_us: 400_000 });
    const fadeIn = slider("淡入时长");
    fireEvent.change(fadeIn, { target: { value: "3" } });
    fireEvent.pointerUp(fadeIn);

    expect(onPatch).toHaveBeenCalledTimes(1);
    const [ops, summary] = onPatch.mock.calls[0]!;
    expect(summary).toBe("调整淡入时长");
    expect(ops).toEqual([{
      op: "set_audio", clip_id: "clip_1", enabled: true, gain_db: 0,
      fade_in_us: 3_000_000, fade_out_us: 400_000,
    }]);
  });

  it("淡出同理，且带上已设的淡入（互相不覆盖）", () => {
    const { onPatch } = setup({ fade_in_us: 500_000 });
    const fadeOut = slider("淡出时长");
    fireEvent.change(fadeOut, { target: { value: "1" } });
    fireEvent.pointerUp(fadeOut);

    const [ops, summary] = onPatch.mock.calls[0]!;
    expect(summary).toBe("调整淡出时长");
    expect(ops[0]).toEqual({
      op: "set_audio", clip_id: "clip_1", enabled: true, gain_db: 0,
      fade_out_us: 1_000_000, fade_in_us: 500_000,
    });
  });

  it("拖回 0 必须显式写 0（否则 set_audio 会保留旧值，等于拖不动）", () => {
    const { onPatch } = setup({ fade_in_us: 2_000_000 });
    const fadeIn = slider("淡入时长");
    fireEvent.change(fadeIn, { target: { value: "0" } });
    fireEvent.pointerUp(fadeIn);

    const [ops] = onPatch.mock.calls[0]!;
    expect(ops[0].fade_in_us).toBe(0);
  });
});
