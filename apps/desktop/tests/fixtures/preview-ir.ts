/** 合成预览测试夹具：与 app/editor 测试的默认时间线夹具（clip_1 = asset_video
 *  1080x1920@30，5s）一致的 preview-ir-v1。jsdom 无 WebGL2，会话创建必然失败
 *  走回退——夹具的价值在于让 getPreviewIr 成功、parseIr 通过，使"IR 可用但
 *  环境不可渲染"的回退路径确定化（区别于 PREVIEW_IR_UNSUPPORTED 语义）。 */

export function fixturePreviewIr(): Record<string, unknown> {
  const fps = 30;
  const durationFrames = 150;
  const frames = Array.from({ length: durationFrames }, (_, n) => ({
    n,
    t_us: Math.round((n * 1_000_000) / fps),
    main: {
      kind: "segment",
      clip_id: "clip_1",
      input_id: "in_1",
      src_n: n,
      src_t_us: Math.round((n * 1_000_000) / fps),
      content: { x: 0, y: 0, w: 1080, h: 1920 },
      shift: { dx: 0, dy: 0 },
      alpha: 1,
    },
    overlays: [],
    captions: [],
  }));
  return {
    schema: "preview-ir-v1",
    projector_version: "test-fixture",
    canvas: { width: 1080, height: 1920, fps, duration_frames: durationFrames, duration_us: 5_000_000, background: "#000000" },
    inputs: [{
      input_id: "in_1",
      asset_id: "asset_video",
      asset_kind: "video",
      duration_us: 5_000_000,
      has_audio: true,
      geometry: { width: 1080, height: 1920, sar: 1 },
    }],
    segments: [{
      clip_id: "clip_1",
      track_id: "V1",
      input_id: "in_1",
      source_start_us: 0,
      source_end_us: 5_000_000,
      timeline_start_us: 0,
      timeline_end_us: 5_000_000,
      layout: "fit",
      speed_milli: 1000,
    }],
    captions: [],
    caption_styles: {},
    transition_windows: [],
    known_approximations: [],
    frames,
  };
}

/** getPreviewIr 的完整 Presentation 形状（preload PreviewIrPresentation）。 */
export function fixturePreviewIrPresentation(outputRatio = "916"): Record<string, unknown> {
  return {
    schema_version: 1,
    content_fingerprint: "fixture",
    timeline_revision_id: "revision_1",
    output_ratio: outputRatio,
    ir: fixturePreviewIr(),
  };
}
