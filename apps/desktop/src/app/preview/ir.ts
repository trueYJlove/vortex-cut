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
  geometry: IrGeometry;
  /** P203：该输入是否为 HDR 素材（Core 侧由 ffprobe 的 color_transfer 判定）。
   *  **默认 false**：老 IR 或非视频输入没有该字段，按 SDR 处理（保守，不误报）。 */
  hdr?: boolean;
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

/** 帧活动输入集合（主轨 + 覆盖轨）。 */
export function activeInputIds(frame: IrFrame): Set<string> {
  const ids = new Set<string>();
  const main = frame.main;
  if (main.kind === "segment") ids.add(main.input_id);
  if (main.kind === "transition") { ids.add(main.left.input_id); ids.add(main.right.input_id); }
  for (const overlay of frame.overlays) ids.add(overlay.input_id);
  return ids;
}

/** 输入在指定帧的源帧号（转场左/右各自取帧）。 */
export function sourceFrameAt(frame: IrFrame, inputId: string): number | null {
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
