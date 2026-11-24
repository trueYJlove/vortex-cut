/** M3-0 中立 IR 草案类型（schema 见 tools/m3_0/ir_projector.py，不冻结、不进契约）。 */

export interface IrGeometry {
  width: number;
  height: number;
  sar: number;
  /** 按 display matrix 换轴后的**显示方向**尺寸（P206/P212）。布局 fit/cover
   *  必须用它算内容盒；缺字段时回落 width/height（老 IR 兼容）。 */
  display_width?: number;
  display_height?: number;
  /** 显示矩阵旋转（0/90/180/270）。width/height 是**旋转前**的解码平面方向。 */
  rotation?: number;
}

export interface IrInput {
  input_id: string;
  asset_id: string;
  asset_kind: string;
  duration_us: number;
  has_audio: boolean;
  /** 底层 video 是否有可见片段消费者。缺省仅为旧 IR 兼容；新 IR 必须显式提供。 */
  video_required?: boolean;
  /** 源有音轨且有当前音频消费者。缺省仅为旧 IR 兼容；新 IR 必须显式提供。 */
  audio_required?: boolean;
  geometry: IrGeometry;
  /** P203：该输入是否为 HDR 素材（Core 侧由 ffprobe 的 color_transfer 判定）。
   *  **默认 false**：老 IR 或非视频输入没有该字段，按 SDR 处理（保守，不误报）。 */
  hdr?: boolean;
}

/** 视频素材可以只作音源；asset_kind 描述来源，video_required 描述解码用途。 */
export function inputNeedsVideo(input: Pick<IrInput, "asset_kind" | "video_required">): boolean {
  return input.asset_kind === "video" && (input.video_required ?? true);
}

/** 新 IR 显式表达音频消费者；旧 IR 仅能从纯音频来源推断。 */
export function inputNeedsAudio(input: Pick<IrInput, "asset_kind" | "audio_required">): boolean {
  return input.audio_required ?? (input.asset_kind === "audio");
}

/** 静图仍需上传到 compositor；视频只在有可见视觉消费者时装配。 */
export function inputNeedsVisual(input: Pick<IrInput, "asset_kind" | "video_required">): boolean {
  return input.asset_kind === "image" || inputNeedsVideo(input);
}

export interface IrContent { x: number; y: number; w: number; h: number }

export interface IrMainSegment {
  kind: "segment";
  clip_id: string;
  input_id: string;
  src_n: number;
  src_t_us: number;
  content: IrContent;
  shift: { dx: number; dy: number };
  alpha: number;
  /** V1 静态/关键帧 rotate（度）。IR v0.2+ 携带；旧 IR 缺省 0。 */
  rotation_deg?: number;
  /** 主轨布局（IR v0.3+）：blurred_background = 先画模糊垫底再画 fit 内容。 */
  layout?: string;
}

export interface IrMainTransition {
  kind: "transition";
  transition: string;
  p: number;
  left: IrMainSegment;
  right: IrMainSegment;
}

export type IrMain = IrMainSegment | IrMainTransition | { kind: "black" };

export interface IrOverlay {
  clip_id: string;
  input_id: string;
  src_n: number;
  src_t_us: number;
  box: IrContent;
  rotation_deg: number;
  alpha: number;
  /** 覆盖轨 alpha 效果（IR v0.4+）：mask/keying 静态参数，缺省 = 无效果。 */
  effects?: {
    mask?: import("./effects.js").IrEffectMask;
    keying?: import("./effects.js").IrEffectKeying;
  };
}

/** P231 统一盒条目（layers）：全视觉段（含首段）逐条带 box/transform/effects。
 *  构造序 = 轨道数组序（z 序：上层在前、后绘制覆盖先绘制）。 */
export interface IrLayer {
  clip_id: string;
  input_id: string;
  src_n: number;
  src_t_us: number;
  box: IrContent;
  /** 关键帧 position 平移（画布像素，作用于 box 之外的整体偏移）。 */
  shift?: { dx: number; dy: number };
  rotation_deg: number;
  alpha: number;
  layout?: string;
  effects?: {
    mask?: import("./effects.js").IrEffectMask;
    keying?: import("./effects.js").IrEffectKeying;
  };
}

export interface IrCaptionItem {
  caption_id: string;
  start_us: number;
  end_us: number;
  text: string;
  preset_id: string;
}

export interface IrCaptionStyle {
  font_size: number;
  primary_rgb: [number, number, number];
  outline_rgb: [number, number, number];
  outline: number;
  shadow: number;
  border_style: number;
  margin_v: number;
  /** 多字体：bundle 默认族名（与预注册 FontFace 名一致）；缺省回退 sans-serif。 */
  font_family?: string;
  /** 气泡底衬色（B4 收官；border_style=3 时消费）。 */
  back_rgb?: [number, number, number];
  letter_spacing?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  alignment?: number;
  fx_preset?: string;
}

export interface IrFrame {
  n: number;
  t_us: number;
  main: IrMain;
  /** P231 统一盒条目（全视觉段，含首段），按轨道序（上层在前）。
   *  缺省（旧 IR）= 由 main/overlays 派生（兼容回退）。 */
  layers?: IrLayer[];
  /** 兼容层：非首段的旧形状条目（首段由 main 承载）。旧 IR 恒有此字段。 */
  overlays: IrOverlay[];
  captions: string[];
}

export interface Ir {
  schema: string;
  projector_version: string;
  canvas: { width: number; height: number; fps: number; duration_frames: number; duration_us: number; background: string };
  inputs: IrInput[];
  segments: Array<{
    clip_id: string;
    track_id: string;
    input_id: string;
    source_start_us: number;
    source_end_us: number;
    timeline_start_us: number;
    timeline_end_us: number;
    /** 转场借用重映射后的输出时间轴窗口（IR v0.3+；缺省回退 timeline_*）。 */
    output_start_us?: number;
    output_end_us?: number;
    layout: string;
    speed_milli: number;
  }>;
  captions: IrCaptionItem[];
  caption_styles: Record<string, IrCaptionStyle>;
  /** B4 收官：per-caption 数值样式覆盖（部分字段，与预设合并后消费）。 */
  caption_override_styles?: Record<string, Partial<IrCaptionStyle> & {
    letter_spacing?: number; bold?: boolean; italic?: boolean; underline?: boolean;
    alignment?: number; back_rgb?: [number, number, number]; fx_preset?: string;
  }>;
  transition_windows: Array<{ clip_id: string; kind: string; offset_us: number; duration_us: number }>;
  known_approximations: string[];
  frames: IrFrame[];
}

export function parseIr(value: string | Record<string, unknown>): Ir {
  const ir = (typeof value === "string" ? JSON.parse(value) : value) as Ir;
  if (!ir || !["preview-ir-v1", "m3-0-probe-ir-draft/1"].includes(ir.schema) || !Array.isArray(ir.frames)) {
    throw new Error("Unsupported probe IR schema");
  }
  return ir;
}

/** 帧活动输入集合（layers 优先，缺省回退 main + overlays）。 */
export function activeInputIds(frame: IrFrame): Set<string> {
  const ids = new Set<string>();
  if (frame.layers !== undefined) {
    for (const layer of frame.layers) ids.add(layer.input_id);
    return ids;
  }
  const main = frame.main;
  if (main.kind === "segment") ids.add(main.input_id);
  if (main.kind === "transition") { ids.add(main.left.input_id); ids.add(main.right.input_id); }
  for (const overlay of frame.overlays) ids.add(overlay.input_id);
  return ids;
}

/** 输入在指定帧的源帧号（layers 优先；转场左/右各自取帧）。 */
export function sourceFrameAt(frame: IrFrame, inputId: string): number | null {
  if (frame.layers !== undefined) {
    for (const layer of frame.layers) {
      if (layer.input_id === inputId) return layer.src_n;
    }
  }
  const main = frame.main;
  if (main.kind === "segment" && main.input_id === inputId) return main.src_n;
  if (main.kind === "transition") {
    if (main.left.input_id === inputId) return main.left.src_n;
    if (main.right.input_id === inputId) return main.right.src_n;
  }
  for (const overlay of frame.overlays) {
    if (overlay.input_id === inputId) return overlay.src_n;
  }
  return null;
}
