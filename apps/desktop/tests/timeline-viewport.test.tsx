/** B17 画布 viewport 化测试：backing 尺寸随视口（非全内容）、scrollTop
 *  驱动画布 top（内容坐标基准随动）、滚动不重分配位图、越顶钳 0。
 *
 * 覆盖（计划第 6 节 B17 验收——jsdom 层）：100 轨场景画布高度 ≈ 视口 +
 * 2×overscan（不分配等于所有轨道高度的大位图）；纵向滚动 top 跟随。 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineDocument, TimelineTrack } from "@aivideo/contracts";
import { TimelinePanel } from "../src/app/timeline/TimelineCanvas.js";

/** 100 轨文档：C1 + A1 + 97 动态视频轨 V2..V98 + V1，每轨 1 clip。 */
function makeDocument(trackCount: number, clipCount: number): TimelineDocument {
  const tracks: TimelineTrack[] = [
    { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false },
  ];
  for (let i = 2; i <= trackCount; i += 1) {
    tracks.push({ id: `V${i}`, kind: "video", locked: false, hidden: false, muted: false, solo: false });
  }
  tracks.push(
    { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
    { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
  );
  const clips = Array.from({ length: clipCount }, (_, i) => ({
    clip_id: `clip_${i}` as never,
    track_id: i === 0 ? "V1" : i === 1 ? "A1" : `V${Math.min(trackCount, i + 1)}`,
    order_index: i,
    asset_id: "a1" as never,
    asset_kind: "video" as const,
    source_start_us: 0,
    source_end_us: 5_000_000,
    timeline_start_us: 0,
    timeline_end_us: 5_000_000,
    layout: "fit" as const,
    audio: { enabled: true, gain_db: 0 },
  }));
  return {
    schema_version: 1,
    project_id: "p1" as never,
    canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, background_color: "#000000" },
    tracks,
    clips,
    captions: [],
    transitions: [],
    provenance: { created_by: "user", source_transcript_ids: [] },
  };
}

/** 最小 2D 桩（jsdom 无 canvas 2D；只求渲染不崩、可读 style/backing）。
 * 传 counter 时同时记录 clip 体底色绘制次数（draw 访问量——B17 验收：
 * 100 轨 1000 clip 滚动时 draw 访问数量随可见元素增长）。 */
function installCanvas2DStub(counter?: { clipBodyDraws: number }): void {
  const stub = {
    setTransform: () => undefined, clearRect: () => undefined, fillRect: () => undefined,
    measureText: () => ({ width: 10 }) as TextMetrics, fillText: () => undefined,
    beginPath: () => undefined, moveTo: () => undefined, lineTo: () => undefined,
    stroke: () => undefined, fill: () => undefined, roundRect: () => undefined,
    rect: () => undefined, clip: () => undefined, save: () => undefined,
    restore: () => undefined, arc: () => undefined, closePath: () => undefined,
    setLineDash: () => undefined, drawImage: () => undefined, strokeRect: () => undefined,
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    quadraticCurveTo: () => undefined, ellipse: () => undefined, strokeText: () => undefined,
  };
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(function getContext(this: HTMLCanvasElement, kind: string) {
      if (kind !== "2d") return null;
      const target = this;
      return new Proxy(stub as unknown as CanvasRenderingContext2D, {
        get(obj, prop) {
          if (prop === "canvas") return target;
          return Reflect.get(obj, prop);
        },
        set(obj, prop, value) {
          // clip 体底色（palette.body：OpenFilm KIND_COLOR 令牌，视频 #354f6a /
          // 音频 #1c5757 的深色值）——每可见 clip 恰好一次（名称条/波形用其他色）。
          if (
            counter && prop === "fillStyle"
            && (value === "#354f6a" || value === "#1c5757")
          ) {
            counter.clipBodyDraws += 1;
          }
          return Reflect.set(obj, prop, value);
        },
      });
    }),
  });
}

const baseProps = () => ({
  selection: null,
  setSelection: vi.fn(),
  onPatch: vi.fn().mockResolvedValue(undefined),
  onDropAsset: vi.fn(),
  canUndo: false,
  canRedo: false,
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  assetMedia: [],
});

/** 100 轨内容高（ruler 16 + C1 行 56 + 97 动态行 56 + V1 行 80 + A1 行 64 + 滚动条 8）。 */
function expectedContentHeight(): number {
  return 16 + 56 + 97 * 56 + 80 + 64 + 8;
}

describe("B17 画布 viewport 化", () => {
  beforeEach(() => {
    installCanvas2DStub();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("backing 高度 = 视口 + 2×overscan（100 轨场景不分配全内容位图）", () => {
    const { container } = render(<TimelinePanel document={makeDocument(98, 99)} {...baseProps()} />);
    const canvas = container.querySelector("canvas[aria-label='时间线画布']") as HTMLCanvasElement;
    expect(canvas).not.toBeNull();
    const backingHeight = canvas.height / (window.devicePixelRatio || 1);
    // jsdom 无 ResizeObserver 回调 → 初始视口高 200（canvasSize 初值）；
    // 画布 ≈ 200 + 2×160 = 520（content ≈ 5595——远小于全内容位图）。
    expect(backingHeight).toBeGreaterThan(400);
    expect(backingHeight).toBeLessThan(800);
    expect(backingHeight).toBeLessThan(expectedContentHeight() / 2);
    expect(canvas.style.position).toBe("absolute");
    expect(canvas.style.top).toBe("0px");
  });

  it("纵向滚动：画布 top 跟随 scrollTop - overscan；backing 不重分配", () => {
    const { container } = render(<TimelinePanel document={makeDocument(98, 99)} {...baseProps()} />);
    const scroll = container.querySelector(".timeline-scroll") as HTMLDivElement;
    expect(scroll).not.toBeNull();
    const canvas = container.querySelector("canvas[aria-label='时间线画布']") as HTMLCanvasElement;
    Object.defineProperty(scroll, "scrollTop", { configurable: true, value: 1000 });
    fireEvent.scroll(scroll);
    // 视口 200：内容 1000..1200 在视窗内 → 画布覆盖 [840, 1360)。
    expect(canvas.style.top).toBe("840px");
    const heightAt1000 = canvas.height;
    Object.defineProperty(scroll, "scrollTop", { configurable: true, value: 2000 });
    fireEvent.scroll(scroll);
    expect(canvas.style.top).toBe("1840px");
    expect(canvas.height).toBe(heightAt1000); // 滚动不改 backing（无重分配）
  });

  it("越顶滚动（scrollTop < overscan）：画布顶钳 0", () => {
    const { container } = render(<TimelinePanel document={makeDocument(98, 99)} {...baseProps()} />);
    const scroll = container.querySelector(".timeline-scroll") as HTMLDivElement;
    Object.defineProperty(scroll, "scrollTop", { configurable: true, value: 100 });
    fireEvent.scroll(scroll);
    const canvas = container.querySelector("canvas[aria-label='时间线画布']") as HTMLCanvasElement;
    expect(canvas.style.top).toBe("0px");
  });

  it("draw 访问量随可见区而非文档增长（100 轨 99 clip，视口 200px 只画 ~6 行）", () => {
    const counter = { clipBodyDraws: 0 };
    installCanvas2DStub(counter);
    const doc = makeDocument(98, 99);
    const { container } = render(<TimelinePanel document={doc} {...baseProps()} />);
    // 初始视口高 200 + 上下 overscan 160 → 覆盖 [0, 520) ≈ 8 行 → 最多 ~9 clip
    //（视频行 56/V1 80 混合行高）；远小于 99 全量。
    expect(counter.clipBodyDraws).toBeGreaterThan(0);
    expect(counter.clipBodyDraws).toBeLessThanOrEqual(12);
    // 滚到底部：视口 [5395..5595)（content ≈ 5595）→ 同样只画末尾几行。
    const scroll = container.querySelector(".timeline-scroll") as HTMLDivElement;
    Object.defineProperty(scroll, "scrollTop", { configurable: true, value: 5390 });
    fireEvent.scroll(scroll);
    expect(counter.clipBodyDraws).toBeLessThanOrEqual(24); // 两次视口合计仍 ≪ 2×99
  });
});
