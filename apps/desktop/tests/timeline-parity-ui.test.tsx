import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineDocument } from "@aivideo/contracts";
import { TimelinePanel } from "../src/app/timeline/TimelineCanvas.js";
import {
  TIMELINE_HEAD_COLLAPSED_WIDTH,
  TIMELINE_HEAD_EMPTY_WIDTH,
  TIMELINE_HEAD_EXPANDED_WIDTH,
  TIMELINE_RULER_HEIGHT,
  TIMELINE_TOOLBAR_HEIGHT,
  TIMELINE_ZOOM_DEFAULT,
  TIMELINE_ZOOM_SLIDER_WIDTH,
} from "../src/app/timeline/types.js";
import { timelineSliderToZoom, timelineZoomToSlider } from "../src/app/timeline/geometry.js";

function makeDocument(withTracks = true): TimelineDocument {
  const tracks = withTracks
    ? [
      { id: "C1", kind: "text" as const, locked: false, hidden: false, muted: false, solo: false },
      { id: "V1", kind: "video" as const, locked: false, hidden: false, muted: false, solo: false },
      { id: "A1", kind: "audio" as const, locked: false, hidden: false, muted: false, solo: false },
    ]
    : [];
  return {
    schema_version: 1,
    project_id: "p-ui" as never,
    canvas: { width: 1920, height: 1080, fps_num: 30_000, fps_den: 1001, background_color: "#000000" },
    tracks,
    clips: withTracks ? [{
      clip_id: "clip-ui" as never,
      track_id: "V1",
      order_index: 0,
      asset_id: "asset-ui" as never,
      asset_kind: "video",
      source_start_us: 0,
      source_end_us: 2_000_000,
      timeline_start_us: 0,
      timeline_end_us: 2_000_000,
      layout: "fit",
      audio: { enabled: true, gain_db: 0 },
    }] : [],
    captions: [],
    transitions: [],
    provenance: { created_by: "user", source_transcript_ids: [] },
  };
}

const props = {
  selection: null,
  setSelection: () => undefined,
  onPatch: async () => undefined,
  onDropAsset: () => undefined,
  canUndo: false,
  canRedo: false,
  onUndo: () => undefined,
  onRedo: () => undefined,
  assetMedia: [],
};

afterEach(() => cleanup());

describe("P235 OpenFilm timeline UI metrics", () => {
  it("uses the reference foreground tokens for enabled and disabled toolbar tools", () => {
    render(<div className="editor-shell"><TimelinePanel document={makeDocument()} {...props} /></div>);

    expect(screen.getByRole("button", { name: "撤销" })).toHaveStyle({ color: "var(--editor-control-disabled)" });
    expect(screen.getByRole("button", { name: "添加标记" })).toHaveStyle({ color: "var(--editor-control)" });
  });

  it("uses the expanded/collapsed head, cover rail, ruler, toolbar and zoom slider dimensions", () => {
    const { container } = render(<div className="editor-shell"><TimelinePanel document={makeDocument()} {...props} /></div>);
    const head = container.querySelector<HTMLElement>(".timeline-left")!;
    const ruler = container.querySelector<HTMLCanvasElement>(".timeline-ruler-pin")!;
    const cover = screen.getByRole("button", { name: "封面" });
    const slider = screen.getByRole("slider", { name: "时间线缩放" }) as HTMLInputElement;
    const toolbar = container.querySelector<HTMLElement>(".timeline-toolbar")!;

    expect(head.style.width).toBe(`${TIMELINE_HEAD_EXPANDED_WIDTH}px`);
    expect(cover.style.width).toBe("38px");
    expect(cover.style.height).toBe("38px");
    expect(cover.style.left).toBe("5px");
    expect(ruler.style.height).toBe(`${TIMELINE_RULER_HEIGHT}px`);
    expect(toolbar.style.height).toBe(`${TIMELINE_TOOLBAR_HEIGHT}px`);
    expect(slider.style.width).toBe(`${TIMELINE_ZOOM_SLIDER_WIDTH}px`);
    expect(screen.queryByRole("button", { name: "全局预览缩放" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "时间线显示设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加轨道" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起轨道控制栏" }));
    expect(head.style.width).toBe(`${TIMELINE_HEAD_COLLAPSED_WIDTH}px`);
    fireEvent.click(screen.getByRole("button", { name: "展开轨道控制栏" }));
    expect(head.style.width).toBe(`${TIMELINE_HEAD_EXPANDED_WIDTH}px`);
  });

  it("keeps project-relative zoom at 0.8 initially, steps by 1.6, and fixes the empty view controls", () => {
    const { container, rerender } = render(<TimelinePanel document={makeDocument()} {...props} />);
    const slider = screen.getByRole("slider", { name: "时间线缩放" }) as HTMLInputElement;
    expect(Number(slider.value)).toBeCloseTo(timelineZoomToSlider(TIMELINE_ZOOM_DEFAULT, 2_000_000));

    fireEvent.click(screen.getByRole("button", { name: "放大时间线" }));
    expect(timelineSliderToZoom(Number(slider.value), 2_000_000)).toBeCloseTo(TIMELINE_ZOOM_DEFAULT * 1.6);

    rerender(<TimelinePanel document={makeDocument(false)} {...props} />);
    expect(container.querySelector<HTMLElement>(".timeline-left")!.style.width).toBe(`${TIMELINE_HEAD_EMPTY_WIDTH}px`);
    expect(slider).toBeDisabled();
  });

  it("renders clip names and duration in the OpenFilm-style visible label overlay", () => {
    const base = makeDocument();
    const clip = base.clips[0]!;
    const document = {
      ...base,
      clips: [{ ...clip, source_end_us: 10_000_000, timeline_end_us: 10_000_000 }],
    } satisfies TimelineDocument;
    const { container } = render(<TimelinePanel
      document={document}
      {...props}
      assetMedia={[{
        asset_id: "asset-ui",
        media_url: null,
        kind: "video",
        display_name: "openfilm-name.mp4",
        duration_us: 10_000_000,
        has_audio: true,
      }]}
    />);

    const label = container.querySelector<HTMLElement>('[data-timeline-clip-label="clip-ui"]');
    expect(label).not.toBeNull();
    expect(label?.querySelector(".timeline-clip-label-name")?.textContent).toBe("openfilm-name.mp4");
    expect(label?.querySelector(".timeline-clip-label-duration")?.textContent).toBe("10.0s");
    expect(label?.style.height).toBe("67px");
    expect(label?.querySelector<HTMLElement>(".timeline-clip-label-info")?.style.height).toBe("15px");
  });
});
