/** 覆盖轨 alpha 效果参考实现（IR v0.4）——mask/keying 逐像素 alpha 的 TS 镜像。
 *
 * 权威语义源：`services/core/src/aivs_core/rendering/ffmpeg.py`
 * - `_mask_alpha_expr`（:679）：linear/rect/ellipse 三种蒙版的 geq alpha 表达式
 * - `_keying_alpha_expr`：colorkey 色距斜坡（rgba-geq a 通道，权威端 v0.4 起
 *   不再使用 colorkey 滤镜——alphamerge 在本环境污染 RGB 平面，见该函数注释）
 *
 * 本模块与 worker 内 GLSL（compositor-worker.worker.ts effectAlpha）逐式对应，
 * 单测在两侧用同一组参数比对采样网格（fallback-notice 同款纪律）。语义要点：
 * - 坐标系 = PiP 帧像素（v_box × 盒尺寸），即 rotate 之后的内容盒——与 geq 的
 *   (X,Y)∈pip 帧同构；蒙版旋转在盒坐标内做（先 rotate 内容再套蒙版，双端同序）。
 * - feather：椭圆/矩形过渡带收进边界内侧（feather=0 硬边）；linear 为软边带宽。
 * - keyAlpha 色距 = RGB 欧氏 / 255√3（0..1），与权威端 geq 表达式同式（实测
 *   标定 2026-09-17）。keying.invert 权威端不消费——同语义忽略。
 */

import { clamp01 } from "../math.js";

export interface IrEffectMask {
  kind: "linear" | "rect" | "ellipse";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  feather?: number;
  invert?: boolean;
}

export interface IrEffectKeying {
  color?: string;
  similarity?: number;
  blend?: number;
  invert?: boolean;
}

/** FFmpeg colorkey key 色 → 归一化 RGB（0..1）。非法/缺省回绿幕 00FF00。 */
export function keyingColorRgb(keying: IrEffectKeying): [number, number, number] {
  const raw = typeof keying.color === "string" && /^[0-9A-Fa-f]{6}$/.test(keying.color) ? keying.color : "00FF00";
  return [
    parseInt(raw.slice(0, 2), 16) / 255,
    parseInt(raw.slice(2, 4), 16) / 255,
    parseInt(raw.slice(4, 6), 16) / 255,
  ];
}

/** 蒙版 alpha（0..1）——盒内归一化坐标 (nx, ny)（x 右、y 下）× 盒尺寸 (pw, ph)。
 *  与 geq 的 (X,Y) 逐像素对应：px = nx·pw, py = ny·ph。
 *  feather 语义（v0.4，与权威端 `_mask_alpha_expr` 同式）：过渡带收进形状边界
 *  内侧——alpha 在归一化距离 d/norm ∈ [1−feather, 1] 线性从 1 降到 0，边界处
 *  恒 0（不外溢）；feather=0 → 硬边 clamp(1−d)。linear 的 feather·pw 为软边
 *  带宽（分界线两侧，历史语义不变）。 */
export function maskAlpha(mask: IrEffectMask, nx: number, ny: number, pw: number, ph: number): number {
  const cx = (typeof mask.x === "number" ? mask.x : 0.5) * pw;
  const cy = (typeof mask.y === "number" ? mask.y : 0.5) * ph;
  const feather = clamp01(typeof mask.feather === "number" ? mask.feather : 0);
  const rot = ((typeof mask.rotation === "number" ? mask.rotation : 0.0) * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const px = nx * pw;
  const py = ny * ph;
  const ux = cos * (px - cx) + sin * (py - cy);
  // feather=0 → 真硬边（形状内 1、形状外 0，一步跳变）；>0 → 过渡带 [1−feather, 1] 内线性。
  const hardInside = (inside: boolean): number => (inside !== (mask.invert === true) ? 1 : 0);
  if (mask.kind === "ellipse") {
    const ax = Math.max(1.0, (typeof mask.width === "number" ? mask.width : 0.5) * pw / 2.0);
    const ay = Math.max(1.0, (typeof mask.height === "number" ? mask.height : 0.5) * ph / 2.0);
    const uy = -sin * (px - cx) + cos * (py - cy);
    const d = Math.sqrt((ux * ux) / (ax * ax) + (uy * uy) / (ay * ay));
    if (feather > 0) {
      const alpha = clamp01((1 - d) / feather);
      return mask.invert === true ? 1 - alpha : alpha;
    }
    return hardInside(d < 1);
  }
  if (mask.kind === "rect") {
    const halW = Math.max(1.0, (typeof mask.width === "number" ? mask.width : 0.5) * pw / 2.0);
    const halH = Math.max(1.0, (typeof mask.height === "number" ? mask.height : 0.5) * ph / 2.0);
    const uy = -sin * (px - cx) + cos * (py - cy);
    const norm = Math.max(Math.abs(ux) / halW, Math.abs(uy) / halH);
    if (feather > 0) {
      const alpha = clamp01((1 - Math.min(1, norm)) / feather);
      return mask.invert === true ? 1 - alpha : alpha;
    }
    return hardInside(norm < 1);
  }
  // linear：分界线过 (cx,cy)、方向 rotation；feather·pw = 软边过渡带宽
  const inside = Math.min(255, Math.max(0, 255 * (0.5 + ux / Math.max(1.0, feather * pw))));
  let alpha = inside / 255;
  if (mask.invert === true) alpha = 1 - alpha;
  return alpha;
}

/** 抠像 alpha（0..1）——FFmpeg colorkey：色距 < similarity 全透明，
 *  similarity+blend 处起全不透明，中间线性（smoothstep 的几何解释即线性斜坡）。 */
export function keyingAlpha(keying: IrEffectKeying, r: number, g: number, b: number): number {
  const sim = clamp01(typeof keying.similarity === "number" ? keying.similarity : 0.3) || 0.3;
  const blend = clamp01(typeof keying.blend === "number" ? keying.blend : 0.1) || 0.1;
  const [kr, kg, kb] = keyingColorRgb(keying);
  // RGB 欧氏距离（0..1 空间，√3 归一后与 colorkey 0..1 similarity 口径对齐——
  // 常数因子由 P2 step0 自校准吸收，双端同式即一致）。
  const dist = Math.sqrt((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2) / Math.sqrt(3);
  if (dist <= sim) return 0.0;
  if (dist >= sim + blend) return 1.0;
  return (dist - sim) / blend;
}
