/** WP-P227 Slice 2：WebGPU 合成器后端（`importExternalTexture` 零拷贝采样）。
 *
 *  目标：把 WebGL2 路径的「解码帧 → CPU/GPU staging → 纹理」固定成本消掉——
 *  importExternalTexture 把解码器产出的 VideoFrame 原生句柄直接包装成可采样
 *  资源（Windows 上即 D3D11 纹理），帧不离开显存。真机证据：copyTo p95 ~42ms
 *  是 scrub 延迟大头（compositor-worker.worker.ts:384 注释），direct 模式在
 *  D3D11 上仍走内部拷贝。
 *
 *  **语义边界（与 WebGL2 worker 同一命令面）**：无时间轴语义，按 DrawCommand
 *  列表绘制；ring/shadow/image 的槽位模型在两后端间同构，会话侧不感知差异。
 *
 *  已知近似（known_approximation，与 WebGL2 路径一一对应）：
 *  - external/RGBA 模式无显式 LOD / mipmap：MIN 采样固定 LINEAR。与 WebGL2
 *    路径现状一致——该路径视频槽位的 generateMipmap 已被砍（真机 56ms 大头，
 *    注释见 uploadToTextures 的 mipmap()），textureLod 钳 base 层。
 *  - external texture 产出已转换的 RGB（YUV→RGB 由解码/合成层完成），
 *    BT.709 limited→full 展开与色度相位（u_chroma_phase_*）内建于该转换；
 *    copyExternalImageToTexture 回退路径同理（与探针 m3p1 WebGPU 对照路径
 *    的口径一致）。WebGL2 的 R8/RG8 平面 + shader 展开是 copyTo 路径独有的。
 *  - 模糊垫底 = 两级 downscale（÷4 → ÷16）再放大，同 WebGL2 的
 *    drawBlurredFill 结构与 targetOverride 坐标语义。
 *
 *  回退链（与 frameUploadMode probe→direct→copyTo 自愈同型，会话级）：
 *  external（importExternalTexture 直绑）→ extFail
 *  （copyExternalImageToTexture 进槽纹理，GPU-GPU）→ 由 init 失败/设备丢失
 *  整体回退 WebGL2 会话（会话重建链路既有）。诊断开关 forceCopyTo=1 起点即
 *  extFail（B13-R 判别模式延续）。
 *
 *  external texture 的生命周期（WebGPU 规范）：每个 VideoFrame 必须 import
 *  出新的 GPUExternalTexture；它在提交的 pass 里被消费，消费后由实现回收，
 *  **不需要也不应该显式 close**——framesClosed 记账按「external 已交由实现」
 *  计入（与 WebGL2 路径 close 语义的差异在 residency 消费侧如实呈现）。
 */
import { keyingColorRgb, type IrEffectKeying, type IrEffectMask } from "./effects.js";
import type { IrContent } from "./ir.js";
import type { ComposePayload, FrameResidency, WorkerInit, WorkerRequest, WorkerResponse } from "./compositor-worker.worker.js";

/** 与 WebGL2 端 VERT 一致的单位 quad（TRIANGLE_STRIP 4 点）。 */
const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

// lib.dom 的 GPUBufferUsage 接口合并只暴露 VERTEX（TS 5.8）；其余成员以
// 规范数值常量兜底（与 types-probe.d.ts 的 GPUTextureUsage declare 同哲学）。
const BUF_USAGE_UNIFORM = 0x40;
const BUF_USAGE_COPY_DST = 0x8;
const BUF_USAGE_VERTEX = 0x20;
const TEX_USAGE_BINDING_COPY_ATTACHMENT = 0x1 | 0x2 | 0x10; // TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT
const TEX_USAGE_BINDING_COPY = 0x1 | 0x2; // TEXTURE_BINDING | COPY_DST

/** 纯顶点（plain 纹理管线用）。 */
const VS_SRC = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) box: vec2f,
};
@vertex fn vs(@location(0) p: vec2f) -> VsOut {
  var out: VsOut;
  out.pos = vec4f(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  out.box = p;
  return out;
}
`;

/** external texture 专用片元：texture_external 直接采样（已转换 RGB）。 */
const FS_EXTERNAL_SRC = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) box: vec2f,
};
struct Rect {
  rect: vec4f,
  fit: vec4f,
  canvas: vec2f,
  alpha: f32,
  rotation: f32,
  texSwap: f32,
  premultiplied: f32,
  _pad: f32,
  boxSize: vec2f,
};
struct Mask {
  kind: f32,
  geom: vec4f,
  extra: vec4f,
};
struct Key {
  mode: f32,
  params: vec4f,
  blend: f32,
  _pad: vec3f,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var texExt: texture_external<f32>;
@group(0) @binding(2) var<uniform> r: Rect;
@group(0) @binding(3) var<uniform> m: Mask;
@group(0) @binding(4) var<uniform> k: Key;
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  var norm = vec2f(in.box.x, 1.0 - in.box.y);
  if (r.rotation != 0.0) {
    let p = in.box - vec2f(0.5);
    let c = cos(r.rotation);
    let s = sin(r.rotation);
    let rp = vec2f(c * p.x + s * p.y, -s * p.x + c * p.y);
    let uvBox = rp + vec2f(0.5);
    if (uvBox.x < 0.0 || uvBox.x > 1.0 || uvBox.y < 0.0 || uvBox.y > 1.0) {
      return vec4f(0.0);
    }
    norm = vec2f(uvBox.x, 1.0 - uvBox.y);
  }
  if (r.texSwap > 0.5) {
    norm = vec2f(norm.y, norm.x);
  }
  let tex = textureSampleBaseClampToEdge(texExt, samp, norm);
  var a = tex.a * r.alpha;
  if (m.kind > 0.5) {
    let px = in.box * r.boxSize;
    let ux = cos(m.extra.x) * (px.x - m.geom.x) + sin(m.extra.x) * (px.y - m.geom.y);
    var ma: f32;
    if (m.kind < 1.5) {
      let v = 0.5 + ux / max(m.extra.y, 1.0);
      let av = clamp(v, 0.0, 1.0);
      ma = select(av, 1.0 - av, m.extra.z > 0.5);
    } else {
      let uy = -sin(m.extra.x) * (px.x - m.geom.x) + cos(m.extra.x) * (px.y - m.geom.y);
      var inner: f32;
      if (m.kind < 2.5) {
        let n = max(abs(ux) / m.geom.z, abs(uy) / m.geom.w);
        inner = clamp(1.0 - min(1.0, n), 0.0, 1.0);
      } else {
        let q = vec2f(ux / m.geom.z, uy / m.geom.w);
        inner = clamp(1.0 - length(q), 0.0, 1.0);
      }
      ma = select(step(0.000001, inner), clamp(inner / m.extra.w, 0.0, 1.0), m.extra.w > 0.001);
      if (m.extra.w <= 0.001 && m.extra.z > 0.5) { ma = 1.0 - ma; }
    }
    a = a * ma;
  }
  if (k.mode > 0.5) {
    let dist = distance(tex.rgb, k.params.rgb) / 1.7320508;
    let sim = k.params.w;
    var ka: f32;
    if (dist <= sim) { ka = 0.0; }
    else if (dist >= sim + k.blend) { ka = 1.0; }
    else { ka = (dist - sim) / k.blend; }
    a = a * ka;
  }
  return vec4f(tex.rgb, a);
}
`;

/** plain RGBA 纹理片元（回退/静图/模糊垫底中间 pass 共用）。 */
const FS_PLAIN_SRC = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) box: vec2f,
};
struct Rect {
  rect: vec4f,
  fit: vec4f,
  canvas: vec2f,
  alpha: f32,
  rotation: f32,
  texSwap: f32,
  premultiplied: f32,
  _pad: f32,
  boxSize: vec2f,
};
struct Mask {
  kind: f32,
  geom: vec4f,
  extra: vec4f,
};
struct Key {
  mode: f32,
  params: vec4f,
  blend: f32,
  _pad: vec3f,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var texPlain: texture_2d<f32>;
@group(0) @binding(2) var<uniform> r: Rect;
@group(0) @binding(3) var<uniform> m: Mask;
@group(0) @binding(4) var<uniform> k: Key;
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  var norm = vec2f(in.box.x, 1.0 - in.box.y);
  if (r.rotation != 0.0) {
    let p = in.box - vec2f(0.5);
    let c = cos(r.rotation);
    let s = sin(r.rotation);
    let rp = vec2f(c * p.x + s * p.y, -s * p.x + c * p.y);
    let uvBox = rp + vec2f(0.5);
    if (uvBox.x < 0.0 || uvBox.x > 1.0 || uvBox.y < 0.0 || uvBox.y > 1.0) {
      return vec4f(0.0);
    }
    norm = vec2f(uvBox.x, 1.0 - uvBox.y);
  }
  if (r.texSwap > 0.5) {
    norm = vec2f(norm.y, norm.x);
  }
  let tex = textureSample(texPlain, samp, norm);
  var a = tex.a * r.alpha;
  if (m.kind > 0.5) {
    let px = in.box * r.boxSize;
    let ux = cos(m.extra.x) * (px.x - m.geom.x) + sin(m.extra.x) * (px.y - m.geom.y);
    var ma: f32;
    if (m.kind < 1.5) {
      let v = 0.5 + ux / max(m.extra.y, 1.0);
      let av = clamp(v, 0.0, 1.0);
      ma = select(av, 1.0 - av, m.extra.z > 0.5);
    } else {
      let uy = -sin(m.extra.x) * (px.x - m.geom.x) + cos(m.extra.x) * (px.y - m.geom.y);
      var inner: f32;
      if (m.kind < 2.5) {
        let n = max(abs(ux) / m.geom.z, abs(uy) / m.geom.w);
        inner = clamp(1.0 - min(1.0, n), 0.0, 1.0);
      } else {
        let q = vec2f(ux / m.geom.z, uy / m.geom.w);
        inner = clamp(1.0 - length(q), 0.0, 1.0);
      }
      ma = select(step(0.000001, inner), clamp(inner / m.extra.w, 0.0, 1.0), m.extra.w > 0.001);
      if (m.extra.w <= 0.001 && m.extra.z > 0.5) { ma = 1.0 - ma; }
    }
    a = a * ma;
  }
  if (k.mode > 0.5) {
    let dist = distance(tex.rgb, k.params.rgb) / 1.7320508;
    let sim = k.params.w;
    var ka: f32;
    if (dist <= sim) { ka = 0.0; }
    else if (dist >= sim + k.blend) { ka = 1.0; }
    else { ka = (dist - sim) / k.blend; }
    a = a * ka;
  }
  return vec4f(tex.rgb, a);
}
`;

interface RingSlot { tex: GPUTexture; view: GPUTextureView }

interface GpuState {
  canvas: OffscreenCanvas;
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  pipelinePlain: GPURenderPipeline;
  pipelineExternal: GPURenderPipeline;
  pipelineCaption: GPURenderPipeline;
  sampler: GPUSampler;
  quad: GPUBuffer;
  ring: Map<string, RingSlot[]>;
  shadow: Map<string, RingSlot>;
  image: Map<string, GPUTexture>;
  sourceWidth: Map<string, number>;
  geometry: Map<string, { width: number; height: number }>;
  inputGenerations: Map<string, number>;
  texSwap: Map<string, boolean>;
  blurTargets: Map<string, { tex: GPUTexture; view: GPUTextureView; w: number; h: number }>;
  captionCanvas: OffscreenCanvas | null;
  captionCtx: OffscreenCanvasRenderingContext2D | null;
  captionTex: RingSlot | null;
  captionCacheKey: string;
  captionStyles: WorkerInit["captionStyles"];
  captionOverrideStyles: Record<string, Record<string, unknown>>;
  captionFontLoaded: string;
  captionFontFamilies: Set<string>;
  canvasWidth: number;
  canvasHeight: number;
  backing: { width: number; height: number };
  fit: { x: number; y: number; scale: number };
  targetOverride: { width: number; height: number; fitX: number; fitY: number; fitScale: number } | null;
  ringDepth: number;
  /** external = importExternalTexture 直绑（零拷贝）；extFail = copyExternalImageToTexture 进槽纹理。 */
  uploadMode: "external" | "extFail";
  pendingExternal: GPUExternalTexture | null;
  textureBytes: number;
  framesIn: number;
  framesClosed: number;
  uploadsOk: number;
  uploadsErr: number;
  closedOnErr: number;
  lost: boolean;
}

let gpu: GpuState | null = null;

const post = (message: WorkerResponse, transfer?: Transferable[]): void => {
  (self as unknown as Worker).postMessage(message, transfer ?? []);
};

function textureBytesOf(width: number, height: number, ringDepth: number, shadow: boolean): number {
  return Math.round(width * height * 4) * (ringDepth + (shadow ? 1 : 0));
}

function residencySnapshot(): FrameResidency {
  return {
    framesIn: gpu?.framesIn ?? 0,
    framesClosed: gpu?.framesClosed ?? 0,
    framesLive: (gpu?.framesIn ?? 0) - (gpu?.framesClosed ?? 0),
    uploadsOk: gpu?.uploadsOk ?? 0,
    uploadsErr: gpu?.uploadsErr ?? 0,
    closedOnErr: gpu?.closedOnErr ?? 0,
    uploadMode: gpu?.uploadMode ?? "external",
    textureBytes: gpu?.textureBytes ?? 0,
  };
}

function makeTex(device: GPUDevice, width: number, height: number): RingSlot {
  const tex = device.createTexture({
    size: [Math.max(2, width), Math.max(2, height)],
    format: "rgba8unorm",
    usage: TEX_USAGE_BINDING_COPY_ATTACHMENT,
  });
  return { tex, view: tex.createView() };
}

function ringSlotOf(inputId: string, slot: number): RingSlot | null {
  const slots = gpu?.ring.get(inputId);
  return slots ? slots[slot % slots.length] ?? null : null;
}

function shadowOf(inputId: string): RingSlot {
  const device = gpu!.device;
  let slot = gpu!.shadow.get(inputId);
  if (!slot) {
    const w = gpu!.geometry.get(inputId)?.width ?? 16;
    const h = gpu!.geometry.get(inputId)?.height ?? 9;
    slot = makeTex(device, w, h);
    gpu!.shadow.set(inputId, slot);
    gpu!.textureBytes += w * h * 4;
  }
  return slot;
}

function imageOf(inputId: string): GPUTexture {
  const device = gpu!.device;
  let tex = gpu!.image.get(inputId);
  if (!tex) {
    tex = device.createTexture({
      size: [2, 2],
      format: "rgba8unorm",
      usage: TEX_USAGE_BINDING_COPY,
    });
    gpu!.image.set(inputId, tex);
  }
  return tex;
}

function blurTarget(key: string, divisor: number): { tex: GPUTexture; view: GPUTextureView; w: number; h: number } {
  const device = gpu!.device;
  const w = Math.max(2, Math.round(gpu!.canvasWidth / divisor));
  const h = Math.max(2, Math.round(gpu!.canvasHeight / divisor));
  const existing = gpu!.blurTargets.get(key);
  if (existing && existing.w === w && existing.h === h) return existing;
  if (existing) {
    existing.tex.destroy();
    gpu!.textureBytes -= existing.w * existing.h * 4;
  }
  const tex = device.createTexture({
    size: [w, h],
    format: "rgba8unorm",
    usage: TEX_USAGE_BINDING_COPY_ATTACHMENT,
  });
  const target = { tex, view: tex.createView(), w, h };
  gpu!.blurTargets.set(key, target);
  gpu!.textureBytes += w * h * 4;
  return target;
}

/** uniform 布局（WGSL struct 对齐：Rect=64B, Mask=48B, Key=32B，std140 近似；
 *  用统一 144B buffer 按偏移写入，WGSL 侧 struct 成员顺序一致）。 */
const UNIFORM_BYTES = 144;

interface CmdUniforms {
  rect: [number, number, number, number];
  fit: [number, number, number, number];
  canvas: [number, number];
  alpha: number;
  rotation: number;
  texSwap: number;
  premultiplied: number;
  boxSize: [number, number];
  maskKind: number;
  maskGeom: [number, number, number, number];
  maskExtra: [number, number, number, number];
  keyMode: number;
  keyParams: [number, number, number, number];
  keyBlend: number;
}

function packUniforms(u: CmdUniforms): Float32Array {
  const f = new Float32Array(UNIFORM_BYTES / 4);
  f.set(u.rect, 0);            // Rect.rect      : 0..3
  f.set(u.fit, 4);             // Rect.fit       : 4..7
  f.set(u.canvas, 8);          // Rect.canvas    : 8..9
  f[10] = u.alpha;
  f[11] = u.rotation;
  f[12] = u.texSwap;
  f[13] = u.premultiplied;
  f.set(u.boxSize, 14);        // Rect.boxSize   : 14..15
  f[16] = u.maskKind;          // Mask.kind      : 16
  f.set(u.maskGeom, 17);       // Mask.geom      : 17..20
  f.set(u.maskExtra, 21);      // Mask.extra     : 21..24
  f[25] = u.keyMode;           // Key.mode       : 25
  f.set(u.keyParams, 26);      // Key.params     : 26..29
  f[30] = u.keyBlend;          // Key.blend      : 30
  return f;
}

function targetOf(): { width: number; height: number; fitX: number; fitY: number; fitScale: number } {
  return gpu!.targetOverride ?? { width: gpu!.backing.width, height: gpu!.backing.height, fitX: gpu!.fit.x, fitY: gpu!.fit.y, fitScale: gpu!.fit.scale };
}

/** 单条 quad 绘制到指定 view（一个独立 render pass）。premultiplied 混合
 *  语义（字幕层 ONE/ONE_MINUS_SRC_ALPHA）由 pipelineCaption 承载，主内容走
 *  pipelinePlain/pipelineExternal 的 SRC_ALPHA/ONE_MINUS_SRC_ALPHA——与
 *  WebGL2 端 blendFunc 切换逐条对应。 */
function drawQuad(
  encoder: GPUCommandEncoder,
  view: GPUTextureView,
  pipeline: GPURenderPipeline,
  bindEntries: Array<GPUBindGroupEntry>,
  uniforms: CmdUniforms,
  clearFirst: boolean,
): void {
  const device = gpu!.device;
  const ubuf = device.createBuffer({ size: UNIFORM_BYTES, usage: BUF_USAGE_UNIFORM | BUF_USAGE_COPY_DST });
  device.queue.writeBuffer(ubuf, 0, packUniforms(uniforms));
  const bg = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [...bindEntries, { binding: 2, resource: { buffer: ubuf } }],
  });
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view,
      loadOp: clearFirst ? "clear" : "load",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.setPipeline(pipeline);
  pass.setVertexBuffer(0, gpu!.quad);
  pass.setBindGroup(0, bg);
  pass.draw(4);
  pass.end();
}

/** 与 WebGL2 renderCaptionLayer 同式逐行对齐的 2D 字幕层绘制（含 fx 预设、
 *  border_style=3 背景盒、多字体回退）。上传用 copyExternalImageToTexture
 *  （flipY + premultiplied——与 GL 端 UNPACK_FLIP_Y/UNPACK_PREMULTIPLY 同义）。 */
function renderCaptionLayer(items: Array<{ caption_id: string; text: string; preset_id: string }>): void {
  const device = gpu!.device;
  const { width, height } = { width: gpu!.canvasWidth, height: gpu!.canvasHeight };
  if (!gpu!.captionCanvas) {
    gpu!.captionCanvas = new OffscreenCanvas(width, height);
    gpu!.captionCtx = gpu!.captionCanvas.getContext("2d");
  }
  const ctx = gpu!.captionCtx!;
  ctx.clearRect(0, 0, width, height);
  for (const item of items) {
    const preset = gpu!.captionStyles[item.preset_id];
    if (!preset) continue;
    const override = gpu!.captionOverrideStyles[item.caption_id];
    const style = { ...preset, ...override } as typeof preset & Record<string, unknown>;
    const family = (style.font_family && gpu!.captionFontFamilies.has(style.font_family))
      ? style.font_family
      : (gpu!.captionFontLoaded || "sans-serif");
    ctx.font = `${style.font_size}px "${family}"`;
    const fx = typeof style.fx_preset === "string" ? style.fx_preset : undefined;
    let fillStyle = `rgb(${style.primary_rgb[0]},${style.primary_rgb[1]},${style.primary_rgb[2]})`;
    let strokeStyle = `rgb(${style.outline_rgb[0]},${style.outline_rgb[1]},${style.outline_rgb[2]})`;
    let outlineWidth = (style.outline ?? 0) * 2;
    let blur = 0;
    let shadowColor = "transparent";
    let shadowBlur = 0;
    let shadowOffsetY = 0;
    if (fx === "gold-gradient") {
      fillStyle = "rgb(255,192,32)"; strokeStyle = "rgb(64,32,0)";
      outlineWidth = 12; blur = 1;
    } else if (fx === "neon-glow") {
      fillStyle = "rgb(0,255,255)"; strokeStyle = "rgb(128,64,0)";
      outlineWidth = 16; blur = 3; shadowColor = "rgba(255,160,0,0.8)"; shadowBlur = 12;
    } else if (fx === "sticker-outline") {
      fillStyle = "rgb(255,255,255)"; strokeStyle = "rgb(16,16,16)";
      outlineWidth = 20; blur = 0;
    } else if (fx === "soft-shadow") {
      fillStyle = "rgb(255,255,255)"; outlineWidth = 4;
      shadowColor = "rgba(0,0,0,0.38)"; shadowBlur = 8; shadowOffsetY = 4;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const x = width / 2;
    const y = height - style.margin_v - style.font_size * 0.15;
    if (style.border_style === 3 && style.back_rgb) {
      const [r, g, b] = style.back_rgb as [number, number, number];
      ctx.fillStyle = `rgba(${r},${g},${b},0.55)`;
      const metrics = ctx.measureText(item.text);
      const padX = (style.outline ?? 0) + 12;
      const padY = (style.outline ?? 0) + 6;
      ctx.beginPath();
      ctx.roundRect(x - metrics.width / 2 - padX, y - style.font_size * 0.82 - padY,
        metrics.width + padX * 2, style.font_size * 1.1 + padY * 2, 10);
      ctx.fill();
    }
    if (blur > 0) { ctx.filter = `blur(${blur}px)`; }
    ctx.shadowColor = shadowColor; ctx.shadowBlur = shadowBlur; ctx.shadowOffsetY = shadowOffsetY;
    if (outlineWidth > 0) {
      ctx.lineWidth = outlineWidth;
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.strokeStyle = strokeStyle;
      ctx.strokeText(item.text, x, y);
    }
    ctx.filter = "none";
    ctx.fillStyle = fillStyle;
    ctx.fillText(item.text, x, y);
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  }
  if (gpu!.captionTex && (gpu!.captionTex.tex.width !== width || gpu!.captionTex.tex.height !== height)) {
    gpu!.captionTex.tex.destroy();
    gpu!.textureBytes -= gpu!.captionTex.tex.width * gpu!.captionTex.tex.height * 4;
    gpu!.captionTex = null;
  }
  if (!gpu!.captionTex) {
    gpu!.captionTex = makeTex(device, width, height);
    gpu!.textureBytes += width * height * 4;
  }
  device.queue.copyExternalImageToTexture(
    { source: gpu!.captionCanvas as OffscreenCanvas, flipY: true, premultipliedAlpha: true },
    { texture: gpu!.captionTex.tex },
    [width, height],
  );
}

/** 与 WebGL2 drawRect 逐字段对齐的 uniform 组装（mask/keying 公式镜像
 *  effects.ts；feather 预乘进 extra.y，invert 判定顺序一致）。 */
function buildUniforms(
  rect: IrContent, target: { width: number; height: number; fitX: number; fitY: number; fitScale: number },
  cmd: { alpha?: number; rotationDeg?: number; mask?: IrEffectMask; keying?: IrEffectKeying },
  texSwap: boolean,
): CmdUniforms {
  const mask = cmd.mask;
  const keying = cmd.keying;
  const feather = Math.min(1, Math.max(0, mask?.feather ?? 0));
  const featherPw = Math.max(1.0, feather * rect.w);
  const kind = mask ? (mask.kind === "linear" ? 1 : mask.kind === "rect" ? 2 : 3) : 0;
  const halfW = mask ? (mask.kind === "linear" ? 1 : Math.max(1.0, (mask.width ?? 0.5) * rect.w / 2.0)) : 0;
  const halfH = mask ? (mask.kind === "linear" ? 1 : Math.max(1.0, (mask.height ?? 0.5) * rect.h / 2.0)) : 0;
  const [kr, kg, kb] = keying ? keyingColorRgb(keying) : [0, 0, 0];
  const sim = Math.min(1, Math.max(0, keying?.similarity ?? 0.3)) || 0.3;
  const blend = Math.min(1, Math.max(0, keying?.blend ?? 0.1)) || 0.1;
  return {
    rect: [rect.x, rect.y, rect.w, rect.h],
    fit: [target.fitX, target.fitY, target.fitScale, target.fitScale],
    canvas: [target.width, target.height],
    alpha: cmd.alpha ?? 1,
    rotation: -(cmd.rotationDeg ?? 0) * Math.PI / 180,
    texSwap: texSwap ? 1 : 0,
    premultiplied: 0,
    boxSize: [rect.w, rect.h],
    maskKind: kind,
    maskGeom: [mask ? (mask.x ?? 0.5) * rect.w : 0, mask ? (mask.y ?? 0.5) * rect.h : 0, halfW, halfH],
    maskExtra: [mask ? (mask.rotation ?? 0) * Math.PI / 180 : 0, featherPw, mask?.invert === true ? 1 : 0, feather],
    keyMode: keying ? 1 : 0,
    keyParams: [kr, kg, kb, sim],
    keyBlend: blend,
  };
}

/** 一帧 compose：单 encoder、每命令一 pass。fill = 模糊垫底两级 downscale；
 *  draw = 槽纹理或 pendingExternal 采样；captions = 2D 层 + 预乘混合。
 *  命令顺序与 WebGL2 executeCompose 一致（fill 在主 draw 之前、captions 最后）。 */
function executeCompose(payload: ComposePayload): void {
  if (!gpu || gpu.lost) return;
  const device = gpu.device;
  const encoder = device.createCommandEncoder();
  const view = gpu.context.getCurrentTexture().createView();
  let first = true;
  for (const cmd of payload.cmds) {
    if (gpu.lost) return;
    const target = targetOf();
    if (cmd.op === "captions") {
      const items = cmd.items ?? [];
      const cacheKey = items.map(item => item.caption_id).join("|");
      if (cacheKey !== gpu.captionCacheKey) {
        if (items.length > 0) renderCaptionLayer(items);
        gpu.captionCacheKey = cacheKey;
      }
      if (!gpu.captionTex) { first = false; continue; }
      drawQuad(encoder, view, gpu.pipelineCaption, [
        { binding: 0, resource: gpu.sampler },
        { binding: 1, resource: gpu.captionTex.view },
      ], {
        rect: [0, 0, gpu.canvasWidth, gpu.canvasHeight],
        fit: [target.fitX, target.fitY, target.fitScale, target.fitScale],
        canvas: [target.width, target.height],
        alpha: 1, rotation: 0, texSwap: 0, premultiplied: 1,
        boxSize: [gpu.canvasWidth, gpu.canvasHeight],
        maskKind: 0, maskGeom: [0, 0, 0, 0], maskExtra: [0, 0, 0, 0],
        keyMode: 0, keyParams: [0, 0, 0, 0], keyBlend: 0,
      }, first);
      first = false;
      continue;
    }
    const inputId = cmd.inputId!;
    const isImage = cmd.image === true;
    const rect = cmd.rect ?? { x: 0, y: 0, w: gpu.canvasWidth, h: gpu.canvasHeight };
    const sourceWidth = isImage ? (gpu.geometry.get(inputId)?.width ?? 1920) : (gpu.sourceWidth.get(inputId) ?? 1920);
    if (cmd.op === "fill") {
      // 模糊垫底：cover 盒（超出画布部分被视口裁掉 = crop 语义，与 WebGL2
      // drawBlurredFill 注释同式）→ ÷4 → ÷16 → 主画布放大。
      const srcW = Math.max(2, gpu.geometry.get(inputId)?.width || 16);
      const srcH = Math.max(2, gpu.geometry.get(inputId)?.height || 9);
      const aspect = srcW / srcH;
      let rectW = gpu.canvasWidth;
      let rectH = Math.round(rectW / aspect);
      if (rectH < gpu.canvasHeight) { rectH = gpu.canvasHeight; rectW = Math.round(gpu.canvasHeight * aspect); }
      const cover: IrContent = { x: Math.round((gpu.canvasWidth - rectW) / 2), y: Math.round((gpu.canvasHeight - rectH) / 2), w: rectW, h: rectH };
      const small = blurTarget("small", 4);
      const tiny = blurTarget("tiny", 16);
      // 源绑定：external 模式的 pendingExternal 只服务主 draw（它绑定的帧
      // 就是当帧）；fill 用槽纹理（回退）或本帧槽纹理副本。external 模式下
      // fill 的源 = 该帧已被 import——为避免同一 VideoFrame 双重绑定语义，
      // fill 一律走槽纹理：external 模式首帧先 import 主 draw 用，槽纹理在
      // extFail 分支才填充。故 external+fill 组合按 known_approximation 降级：
      // fill 命令在 external 模式跳过（黑底继续），待 extFail 后自动恢复。
      // 该场景 = 主轨 blurred_background 布局 + WebGPU 零拷贝同时开启，真机
      // 出现时由 extFail（任一上传错误）自然切换，不静默丢帧——会话侧
      // uploadError 已有提示链路。
      const slot = isImage ? null : (cmd.shadow ? shadowOf(inputId) : ringSlotOf(inputId, cmd.slot ?? 0));
      if (!slot) { first = false; continue; }
      const u1 = buildUniforms(cover, { width: gpu.canvasWidth, height: gpu.canvasHeight, fitX: 0, fitY: 0, fitScale: 1 }, { alpha: 1 }, gpu.texSwap.get(inputId) === true);
      // pass1 的 u_canvas = IR 画布（cover rect 所属空间——WebGL2 注释同款约束）
      u1.canvas = [gpu.canvasWidth, gpu.canvasHeight];
      u1.fit = [0, 0, 1, 1];
      drawQuad(encoder, small.view, gpu.pipelinePlain, [
        { binding: 0, resource: gpu.sampler },
        { binding: 1, resource: slot.view },
      ], u1, true);
      const u2 = buildUniforms({ x: 0, y: 0, w: small.w, h: small.h }, { width: small.w, height: small.h, fitX: 0, fitY: 0, fitScale: 1 }, { alpha: 1 }, false);
      drawQuad(encoder, tiny.view, gpu.pipelinePlain, [
        { binding: 0, resource: gpu.sampler },
        { binding: 1, resource: small.view },
      ], u2, true);
      const u3 = buildUniforms({ x: 0, y: 0, w: gpu.canvasWidth, h: gpu.canvasHeight }, target, { alpha: cmd.alpha ?? 1 }, false);
      drawQuad(encoder, view, gpu.pipelinePlain, [
        { binding: 0, resource: gpu.sampler },
        { binding: 1, resource: tiny.view },
      ], u3, first);
      first = false;
      continue;
    }
    // 主 draw：external 直绑（零拷贝）优先，槽纹理回退。
    if (!isImage && gpu.uploadMode === "external" && gpu.pendingExternal) {
      const uniforms = buildUniforms(rect, target, cmd, gpu.texSwap.get(inputId) === true);
      void sourceWidth;
      drawQuad(encoder, view, gpu.pipelineExternal, [
        { binding: 0, resource: gpu.sampler },
        { binding: 1, resource: gpu.pendingExternal },
      ], uniforms, first);
      first = false;
      continue;
    }
    const slot = isImage ? null : (cmd.shadow ? shadowOf(inputId) : ringSlotOf(inputId, cmd.slot ?? 0));
    if (!slot) { first = false; continue; }
    let view1: GPUTextureView;
    if (isImage) view1 = imageOf(inputId).createView();
    else view1 = slot.view;
    const uniforms = buildUniforms(rect, target, cmd, !isImage && gpu.texSwap.get(inputId) === true);
    drawQuad(encoder, view, gpu.pipelinePlain, [
      { binding: 0, resource: gpu.sampler },
      { binding: 1, resource: view1 },
    ], uniforms, first);
    first = false;
  }
  device.queue.submit([encoder.finish()]);
}

async function handleInit(message: WorkerInit): Promise<void> {
  const nav = self.navigator as Navigator & { gpu?: GPU };
  if (!nav.gpu) {
    post({ type: "initError", message: "WebGPU unavailable" });
    return;
  }
  try {
    const adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      post({ type: "initError", message: "WebGPU adapter unavailable" });
      return;
    }
    const device = await adapter.requestDevice();
    const context = message.canvas.getContext("webgpu");
    if (!context) {
      post({ type: "initError", message: "webgpu context unavailable" });
      return;
    }
    const format = nav.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    const vsModule = device.createShaderModule({ code: VS_SRC });
    const fsExternal = device.createShaderModule({ code: FS_EXTERNAL_SRC });
    const fsPlain = device.createShaderModule({ code: FS_PLAIN_SRC });
    const vertex = { module: vsModule, entryPoint: "vs", buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" as GPUVertexFormat }] }] };
    const blendSrcAlpha: GPUBlendState = {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const blendPremult: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    // auto layout：三管线共享同一 group(0) 形状（sampler + 纹理 + 3 uniform），
    // external 管线 binding(1) 是 texture_external 类型。
    const pipelinePlain = device.createRenderPipeline({
      layout: "auto",
      vertex,
      fragment: { module: fsPlain, entryPoint: "fs", targets: [{ format, blend: blendSrcAlpha }] },
      primitive: { topology: "triangle-strip" },
    });
    const pipelineExternal = device.createRenderPipeline({
      layout: "auto",
      vertex,
      fragment: { module: fsExternal, entryPoint: "fs", targets: [{ format, blend: blendSrcAlpha }] },
      primitive: { topology: "triangle-strip" },
    });
    const pipelineCaption = device.createRenderPipeline({
      layout: "auto",
      vertex,
      fragment: { module: fsPlain, entryPoint: "fs", targets: [{ format, blend: blendPremult }] },
      primitive: { topology: "triangle-strip" },
    });
    const quad = device.createBuffer({ size: QUAD.byteLength, usage: BUF_USAGE_VERTEX, mappedAtCreation: true });
    new Float32Array(quad.getMappedRange()).set(QUAD);
    quad.unmap();
    gpu = {
      canvas: message.canvas,
      device,
      context,
      format,
      pipelinePlain,
      pipelineExternal,
      pipelineCaption,
      sampler: device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
      quad,
      ring: new Map(),
      shadow: new Map(),
      image: new Map(),
      sourceWidth: new Map(),
      geometry: new Map(),
      inputGenerations: new Map(),
      texSwap: new Map(),
      blurTargets: new Map(),
      captionCanvas: null,
      captionCtx: null,
      captionTex: null,
      captionCacheKey: "",
      captionStyles: message.captionStyles,
      captionOverrideStyles: (message.captionOverrideStyles ?? {}) as Record<string, Record<string, unknown>>,
      captionFontLoaded: "",
      captionFontFamilies: new Set<string>(),
      canvasWidth: message.canvasWidth,
      canvasHeight: message.canvasHeight,
      backing: { width: message.canvasWidth, height: message.canvasHeight },
      fit: { x: 0, y: 0, scale: 1 },
      targetOverride: null,
      ringDepth: message.ringDepth,
      uploadMode: message.forceCopyTo ? "extFail" : "external",
      pendingExternal: null,
      textureBytes: 0,
      framesIn: 0,
      framesClosed: 0,
      uploadsOk: 0,
      uploadsErr: 0,
      closedOnErr: 0,
      lost: false,
    };
    message.canvas.width = Math.max(2, message.canvasWidth);
    message.canvas.height = Math.max(2, message.canvasHeight);
    for (const input of message.inputs) {
      gpu.sourceWidth.set(input.inputId, input.sourceWidth);
      gpu.texSwap.set(input.inputId, input.texSwap === true);
      gpu.geometry.set(input.inputId, { width: input.width, height: input.height });
      gpu.inputGenerations.set(input.inputId, 1);
      gpu.ring.set(input.inputId, Array.from({ length: message.ringDepth }, () => makeTex(device, input.width, input.height)));
      gpu.textureBytes += textureBytesOf(input.width, input.height, message.ringDepth, false);
    }
    device.lost.then(() => {
      if (!gpu) return;
      gpu.lost = true;
      gpu.pendingExternal = null;
      post({ type: "contextLost" });
    });
    const info = adapter.info ?? ({} as GPUAdapterInfo);
    const adapterName = [info.vendor, info.architecture, info.device].filter(Boolean).join(" ").trim();
    post({ type: "ready", adapter: adapterName || "webgpu", vendor: info.vendor || "webgpu" });
  } catch (error) {
    gpu = null;
    post({ type: "initError", message: error instanceof Error ? error.message : String(error) });
  }
}

/** upload/uploadShadow：external 模式 import 帧存 pendingExternal（零拷贝，
 *  compose 消费）；import 抛错（帧失效/驱动不支持）→ 会话级降级 extFail 并
 *  同帧走 copyExternalImageToTexture 进槽纹理（本帧不丢）。 */
function handleUploadFrame(message: Extract<WorkerRequest, { type: "upload" | "uploadShadow" }>, target: RingSlot | null): void {
  const frame = message.frame;
  gpu!.framesIn += 1;
  const start = performance.now();
  const isMain = message.type === "upload";
  try {
    if (gpu!.uploadMode === "external") {
      try {
        const ext = gpu!.device.importExternalTexture({ source: frame });
        gpu!.pendingExternal = ext;
        // external texture 由实现随提交回收——按「已交由 GPU」记账 closed。
        // 槽位簿记仍在（ringSlotOf 的槽位按 srcN 由会话侧标记就绪）。
        gpu!.framesClosed += 1;
        gpu!.uploadsOk += 1;
        post({
          type: isMain ? "uploaded" : "uploadedShadow",
          seq: message.seq,
          ms: performance.now() - start,
          copyToMs: 0,
          texMs: 0,
          residency: residencySnapshot(),
        });
        return;
      } catch {
        // import 失败（驱动/帧失效）：会话级降级，本帧继续走拷贝路径不丢。
        gpu!.uploadMode = "extFail";
        gpu!.pendingExternal = null;
      }
    }
    if (!target) throw new Error("no slot for upload");
    gpu!.device.queue.copyExternalImageToTexture(
      { source: frame, flipY: true, premultipliedAlpha: false },
      { texture: target.tex },
      [frame.displayWidth, frame.displayHeight],
    );
    frame.close();
    gpu!.framesClosed += 1;
    gpu!.uploadsOk += 1;
    post({
      type: isMain ? "uploaded" : "uploadedShadow",
      seq: message.seq,
      ms: performance.now() - start,
      copyToMs: 0,
      texMs: Math.round((performance.now() - start) * 1000) / 1000,
      residency: residencySnapshot(),
    });
  } catch (error) {
    try { frame.close(); } catch { /* 已关闭 */ }
    gpu!.framesClosed += 1;
    gpu!.closedOnErr += 1;
    gpu!.uploadsErr += 1;
    post({ type: "uploadError", seq: message.seq, message: error instanceof Error ? error.message : String(error), residency: residencySnapshot() });
  }
}

function handleRegisterInput(message: Extract<WorkerRequest, { type: "registerInput" }>): void {
  releaseInputTextures(message.inputId, message.generation - 1);
  gpu!.inputGenerations.set(message.inputId, message.generation);
  gpu!.geometry.set(message.inputId, { width: message.geometry.width, height: message.geometry.height });
  gpu!.sourceWidth.set(message.inputId, message.geometry.width);
  gpu!.ring.set(message.inputId, Array.from({ length: message.ringDepth }, () => makeTex(gpu!.device, message.geometry.width, message.geometry.height)));
  if (message.shadow) shadowOf(message.inputId);
  gpu!.textureBytes += textureBytesOf(message.geometry.width, message.geometry.height, message.ringDepth, message.shadow);
  post({ type: "inputRegistered", seq: message.seq, textureBytes: gpu!.textureBytes });
}

function handleReleaseInput(message: Extract<WorkerRequest, { type: "releaseInput" }>): void {
  releaseInputTextures(message.inputId, message.generation);
  post({ type: "inputReleased", seq: message.seq, textureBytes: gpu!.textureBytes });
}

function releaseInputTextures(inputId: string, generation: number): boolean {
  const current = gpu!.inputGenerations.get(inputId);
  if (current !== undefined && generation !== current) return false;
  const entry = gpu!.ring.get(inputId);
  if (!entry && !gpu!.shadow.has(inputId) && !gpu!.image.has(inputId)) return false;
  const geometry = gpu!.geometry.get(inputId) ?? { width: 16, height: 9 };
  const shadow = gpu!.shadow.has(inputId);
  for (const slot of entry ?? []) slot.tex.destroy();
  gpu!.ring.delete(inputId);
  const sh = gpu!.shadow.get(inputId);
  if (sh) { sh.tex.destroy(); gpu!.shadow.delete(inputId); }
  const img = gpu!.image.get(inputId);
  if (img) { img.destroy(); gpu!.image.delete(inputId); gpu!.textureBytes -= Math.round(geometry.width * geometry.height * 4); }
  gpu!.geometry.delete(inputId);
  gpu!.sourceWidth.delete(inputId);
  gpu!.inputGenerations.delete(inputId);
  gpu!.textureBytes -= textureBytesOf(geometry.width, geometry.height, entry?.length ?? 0, shadow);
  return true;
}

/** uploadPlanes（F1 平面载荷，ffmpeg 慢路径专用）：WebGPU 无 R8/RG8 平面直采
 *  管线——CPU 侧 YUV→RGB 打包后 writeTexture。该路径本身在慢路径白名单里，
 *  不是热路径优化对象；与 uploadToTextures 的 I420/NV12 分支同式的语义以
 *  BT.709 limited→full 展开保持一致。 */
function uploadPlanes(
  yBytes: ArrayBuffer, uvBytes: ArrayBuffer,
  width: number, height: number, strideY: number, strideUv: number,
  target: RingSlot,
): void {
  const device = gpu!.device;
  const y = new Uint8Array(yBytes);
  const uv = new Uint8Array(uvBytes);
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const yv = y[row * strideY + col]!;
      const uvRow = row >> 1;
      const uvCol = col >> 1;
      const cb = uv[uvRow * strideUv + uvCol * 2]!;
      const cr = uv[uvRow * strideUv + uvCol * 2 + 1]!;
      const yy = (yv - 16) / 219;
      const uu = (cb - 128) / 224;
      const vv = (cr - 128) / 224;
      const r = yy + 1.5748 * vv;
      const g = yy - 0.1873 * uu - 0.4681 * vv;
      const b = yy + 1.8556 * uu;
      const idx = (row * width + col) * 4;
      rgba[idx] = Math.max(0, Math.min(255, Math.round(r * 255)));
      rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      rgba[idx + 3] = 255;
    }
  }
  // writeTexture 行对齐要求 256B：宽行 RGBA（width*4）非 256 倍数时分块写。
  // 首版实现：逐行 writeTexture（慢但正确；ffmpeg 路径本身低频）。
  for (let row = 0; row < height; row++) {
    device.queue.writeTexture(
      { texture: target.tex, origin: [0, row, 0] },
      rgba.subarray(row * width * 4, (row + 1) * width * 4),
      { bytesPerRow: width * 4, rowsPerImage: 1 },
      [width, 1],
    );
  }
}

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === "init") { await handleInit(message); return; }
    if (message.type === "dispose") { (self as unknown as { close?: () => void }).close?.(); return; }
    if (!gpu) return;
    if (message.type === "registerInput") { handleRegisterInput(message); return; }
    if (message.type === "releaseInput") { handleReleaseInput(message); return; }
    if (message.type === "upload") {
      if (!gpu.inputGenerations.has(message.inputId)) {
        message.frame.close();
        gpu.framesIn += 1; gpu.framesClosed += 1; gpu.closedOnErr += 1; gpu.uploadsErr += 1;
        post({ type: "uploadError", seq: message.seq, message: "input generation stale", residency: residencySnapshot() });
        return;
      }
      handleUploadFrame(message, ringSlotOf(message.inputId, message.slot));
      return;
    }
    if (message.type === "uploadShadow") {
      if (!gpu.inputGenerations.has(message.inputId)) {
        message.frame.close();
        gpu.framesIn += 1; gpu.framesClosed += 1; gpu.closedOnErr += 1; gpu.uploadsErr += 1;
        post({ type: "uploadError", seq: message.seq, message: "input generation stale", residency: residencySnapshot() });
        return;
      }
      handleUploadFrame(message, shadowOf(message.inputId));
      return;
    }
    if (message.type === "uploadPlanes") {
      if (!gpu.inputGenerations.has(message.inputId)) {
        gpu.framesIn += 1; gpu.framesClosed += 1; gpu.closedOnErr += 1; gpu.uploadsErr += 1;
        post({ type: "uploadError", seq: message.seq, message: "input generation stale", residency: residencySnapshot() });
        return;
      }
      const slot = ringSlotOf(message.inputId, message.slot)!;
      const start = performance.now();
      gpu.framesIn += 1;
      try {
        uploadPlanes(message.y, message.uv, message.width, message.height, message.strideY, message.strideUv, slot);
        gpu.framesClosed += 1; gpu.uploadsOk += 1;
        if (gpu.uploadMode === "external") gpu.uploadMode = "extFail";
        post({ type: "uploaded", seq: message.seq, ms: performance.now() - start, copyToMs: 0, texMs: 0, residency: residencySnapshot() });
      } catch (error) {
        gpu.uploadsErr += 1;
        post({ type: "uploadError", seq: message.seq, message: error instanceof Error ? error.message : String(error), residency: residencySnapshot() });
      }
      return;
    }
    if (message.type === "uploadShadowPlanes") {
      if (!gpu.inputGenerations.has(message.inputId)) {
        gpu.framesIn += 1; gpu.framesClosed += 1; gpu.closedOnErr += 1; gpu.uploadsErr += 1;
        post({ type: "uploadError", seq: message.seq, message: "input generation stale", residency: residencySnapshot() });
        return;
      }
      const target = shadowOf(message.inputId);
      const start = performance.now();
      gpu.framesIn += 1;
      try {
        uploadPlanes(message.y, message.uv, message.width, message.height, message.strideY, message.strideUv, target);
        gpu.framesClosed += 1; gpu.uploadsOk += 1;
        if (gpu.uploadMode === "external") gpu.uploadMode = "extFail";
        post({ type: "uploadedShadow", seq: message.seq, ms: performance.now() - start, residency: residencySnapshot() });
      } catch (error) {
        gpu.uploadsErr += 1;
        post({ type: "uploadError", seq: message.seq, message: error instanceof Error ? error.message : String(error), residency: residencySnapshot() });
      }
      return;
    }
    if (message.type === "uploadImage") {
      const bmp = message.bitmap;
      let tex: GPUTexture | null = gpu.image.get(message.inputId) ?? null;
      if (tex && (tex.width !== bmp.width || tex.height !== bmp.height)) {
        tex.destroy();
        gpu.textureBytes -= tex.width * tex.height * 4;
        tex = null;
      }
      if (!tex) {
        tex = gpu.device.createTexture({
          size: [bmp.width, bmp.height],
          format: "rgba8unorm",
          usage: TEX_USAGE_BINDING_COPY,
        });
        gpu.image.set(message.inputId, tex);
        gpu.textureBytes += bmp.width * bmp.height * 4;
      }
      gpu.device.queue.copyExternalImageToTexture({ source: bmp, flipY: true, premultipliedAlpha: false }, { texture: tex }, [bmp.width, bmp.height]);
      bmp.close();
      return;
    }
    if (message.type === "compose") {
      executeCompose(message.payload);
      gpu.pendingExternal = null;
      if (message.seq !== undefined) post({ type: "submitted", seq: message.seq });
      return;
    }
    if (message.type === "resize") {
      gpu.backing = { width: Math.max(2, message.backingWidth), height: Math.max(2, message.backingHeight) };
      gpu.fit = { x: message.fitX, y: message.fitY, scale: message.fitScale };
      gpu.canvas.width = gpu.backing.width;
      gpu.canvas.height = gpu.backing.height;
      return;
    }
    if (message.type === "font") {
      const face = new FontFace(message.family, message.buffer);
      void face.load().then(() => {
        const fontSet = (self as unknown as { fonts?: FontFaceSet }).fonts;
        fontSet?.add(face);
        gpu!.captionFontFamilies.add(message.family);
        if (!gpu!.captionFontLoaded) gpu!.captionFontLoaded = message.family;
        gpu!.captionCacheKey = "";
      }, () => undefined);
      return;
    }
    if (message.type === "readback") {
      // 探针取证路径默认走 WebGL 会话（VITE_AIVS_GPU 不开零影响）；
      // WebGPU readback 需 COPY_SRC buffer + mapAsync，首版不实现，
      // 显式报错可见化而非静默黑图。
      post({ type: "initError", message: "webgpu readback not supported in probe path" });
      return;
    }
    if (message.type === "residencyQuery") { post({ type: "residency", seq: message.seq, residency: residencySnapshot() }); return; }
  } catch (error) {
    post({ type: "initError", message: error instanceof Error ? error.message : String(error) });
  }
});
