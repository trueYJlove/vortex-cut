/** M3-0 中立 IR 草案类型（schema 见 tools/m3_0/ir_projector.py，不冻结、不进契约）。 */

export interface IrGeometry { width: number; height: number; sar: number }

export interface IrInput {
  input_id: string;
  asset_id: string;
  asset_kind: string;
  duration_us: number;
  has_audio: boolean;
  geometry: IrGeometry;
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
  segments: Array<{ clip_id: string; input_id: string; speed_milli: number }>;
  captions: IrCaptionItem[];
  caption_styles: Record<string, IrCaptionStyle>;
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
