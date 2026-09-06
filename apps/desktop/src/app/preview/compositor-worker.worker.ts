/** 合成预览 GL 执行器 worker（Phase 2 完全体）：持有 OffscreenCanvas 上的
 * WebGL2 上下文与全部 GL 状态（环形/影子纹理、字幕层、模糊垫底 FBO），执行
 * 主线程会话下发的绘制命令列表（upload/compose/resize/readback）。
 *
 * 动机（实测数据见 docs/PHASE2_HANDOFF.md）：compose p95 0.4ms 非瓶颈，
 * upload（copyTo + texImage2D + mipmap）p95 14~25ms 在主线程是拖帧元凶——
 * 迁入 worker 后与解码抖动物理隔离，主线程只剩编排与 React。
 *
 * 边界约定：worker **无时间轴语义**——IR/帧表/纹理就绪判定全在会话侧；本层
 * 只按命令驱动 GL。VideoFrame 经 transfer 到达（零拷贝），copyTo/texImage2D
 * 在 worker 线程执行。 */
import type { IrContent } from "./ir.js";

const VERT = `#version 300 es
in vec2 a_pos;
uniform vec4 u_rect;     // x,y(左上,y向下),w,h（IR 画布像素 / 目标空间）
uniform vec2 u_canvas;   // 目标尺寸（rect 所属空间；默认=后备缓冲）
uniform vec4 u_fit;      // 视口适配 (offsetX, offsetY, scaleX, scaleY)：IR 画布 → 后备缓冲
out vec2 v_box;          // 0..1 盒内坐标（x 右，y 下）
void main() {
  vec2 px = u_rect.xy + a_pos * u_rect.zw;
  px = px * u_fit.zw + u_fit.xy;
  vec2 clip = vec2(px.x / u_canvas.x * 2.0 - 1.0, 1.0 - px.y / u_canvas.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_box = a_pos;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_box;
uniform sampler2D u_tex;      // rgba 模式：颜色纹理
uniform sampler2D u_tex_y;    // yuv 模式：Y 平面（R8）
uniform sampler2D u_tex_uv;   // yuv 模式：UV 平面（RG8）
uniform float u_alpha;
uniform float u_rotation;        // 弧度；正向 = 顺时针（与 ffmpeg rotate 对齐）
uniform float u_premultiplied;   // 字幕纹理为预乘 alpha
uniform float u_yuv_mode;        // 1 = NV12 平面 + BT.709 limited→full
uniform float u_chroma_phase_x;  // 色度采样相位（源色度坐标偏移）
uniform float u_chroma_phase_y;
uniform float u_lod;             // 显式纹理层级 = log2(源尺寸/内容盒尺寸)
out vec4 frag;
vec3 yuv2rgb709(float yv, float cb, float cr) {
  float y = (yv * 255.0 - 16.0) / 219.0;
  float u = (cb * 255.0 - 128.0) / 224.0;
  float v = (cr * 255.0 - 128.0) / 224.0;
  return vec3(
    y + 1.5748 * v,
    y - 0.1873 * u - 0.4681 * v,
    y + 1.8556 * u);
}
vec4 samplePixel(vec2 norm) {
  if (u_yuv_mode > 0.5) {
    float y = textureLod(u_tex_y, norm, u_lod).r;
    vec2 chroma = textureLod(u_tex_uv, norm + vec2(u_chroma_phase_x, u_chroma_phase_y), u_lod).rg;
    return vec4(clamp(yuv2rgb709(y, chroma.x, chroma.y), 0.0, 1.0), 1.0);
  }
  return texture(u_tex, norm);
}
void main() {
  vec2 norm;
  if (u_rotation != 0.0) {
    vec2 p = v_box - 0.5;
    float c = cos(u_rotation), s = sin(u_rotation);
    vec2 rp = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
    vec2 uv_box = rp + 0.5;
    if (uv_box.x < 0.0 || uv_box.x > 1.0 || uv_box.y < 0.0 || uv_box.y > 1.0) {
      frag = vec4(0.0, 0.0, 0.0, 0.0);
      return;
    }
    norm = vec2(uv_box.x, 1.0 - uv_box.y);
  } else {
    norm = vec2(v_box.x, 1.0 - v_box.y);
  }
  vec4 tex = samplePixel(norm);
  float a = tex.a * u_alpha;
  frag = u_premultiplied > 0.5 ? vec4(tex.rgb * a, a) : vec4(tex.rgb, a);
}`;

type TexPair = { y: WebGLTexture; uv: WebGLTexture };

interface RingSlot { y: WebGLTexture; uv: WebGLTexture }

interface InitInputs { inputId: string; sourceWidth: number; width: number; height: number }

export interface DrawCommand {
  op: "fill" | "draw" | "captions";
  /** fill/draw：纹理来源——ring 槽位索引（会话侧环形簿记解析后的槽）、影子槽
   *  或静图纹理（image=true）。 */
  inputId?: string;
  slot?: number;
  shadow?: boolean;
  image?: true;
  rect?: IrContent;
  alpha?: number;
  rotationDeg?: number;
  /** captions：已解析的字幕条目（文本随命令携带，样式取 init 注入表）。 */
  items?: Array<{ caption_id: string; text: string; preset_id: string }>;
}

export interface ComposePayload {
  cmds: DrawCommand[];
}

export interface WorkerInit {
  type: "init";
  canvas: OffscreenCanvas;
  inputs: InitInputs[];
  ringDepth: number;
  canvasWidth: number;
  canvasHeight: number;
  captionStyles: Record<string, { font_size: number; primary_rgb: [number, number, number]; outline_rgb: [number, number, number]; outline: number; shadow: number; border_style: number; margin_v: number }>;
}

export type WorkerRequest =
  | WorkerInit
  | { type: "upload"; inputId: string; slot: number; srcN: number; frame: VideoFrame; seq: number }
  | { type: "uploadShadow"; inputId: string; srcN: number; frame: VideoFrame; seq: number }
  | { type: "uploadImage"; inputId: string; bitmap: ImageBitmap }
  | { type: "compose"; payload: ComposePayload }
  | { type: "resize"; backingWidth: number; backingHeight: number; fitX: number; fitY: number; fitScale: number }
  | { type: "font"; buffer: ArrayBuffer; family: string }
  | { type: "readback"; seq: number }
  | { type: "dispose" };

export type WorkerResponse =
  | { type: "ready"; adapter: string; vendor: string }
  | { type: "initError"; message: string }
  | { type: "uploaded"; seq: number; ms: number; copyToMs: number; texMs: number }
  | { type: "uploadedShadow"; seq: number; ms: number }
  | { type: "uploadError"; seq: number; message: string }
  | { type: "readback"; seq: number; buffer: ArrayBuffer }
  | { type: "contextLost" };

const state = {
  canvas: null as OffscreenCanvas | null,
  gl: null as WebGL2RenderingContext | null,
  program: null as WebGLProgram | null,
  quad: null as WebGLBuffer | null,
  uniforms: null as Record<string, WebGLUniformLocation | null> | null,
  ringDepth: 8,
  ring: new Map<string, RingSlot[]>(),
  shadowY: new Map<string, WebGLTexture>(),
  shadowUV: new Map<string, WebGLTexture>(),
  scratch: new Map<string, ArrayBuffer>(),
  sourceWidth: new Map<string, number>(),
  geometry: new Map<string, { width: number; height: number }>(),
  captionCanvas: null as OffscreenCanvas | null,
  captionCtx: null as OffscreenCanvasRenderingContext2D | null,
  captionTexture: null as WebGLTexture | null,
  captionCacheKey: "",
  captionFontLoaded: "",
  captionStyles: {} as WorkerInit["captionStyles"],
  fit: { x: 0, y: 0, scale: 1 },
  backing: { width: 2, height: 2 },
  canvasWidth: 540,
  canvasHeight: 960,
  blurTargets: new Map<string, { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }>(),
  targetOverride: null as null | { width: number; height: number; fitX: number; fitY: number; fitScale: number },
  imageTex: new Map<string, WebGLTexture>(),
  chromaPhaseX: 0,
  chromaPhaseY: 0,
  contextLost: false,
  /** mipmap 可用性（首次 generateMipmap 失败即降级 LINEAR-only，会话级）。 */
  mipSupported: true,
  allYuvTextures: [] as WebGLTexture[],
  /** 帧上传模式：probe（首帧尝试 direct）/ direct（GPU-GPU）/ copyTo（回退）。 */
  frameUploadMode: "probe" as "probe" | "direct" | "copyTo",
};

const post = (message: WorkerResponse, transfer?: Transferable[]): void => {
  (self as unknown as Worker).postMessage(message, transfer ?? []);
};

function createYuvTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  state.allYuvTextures.push(texture);
  return texture;
}

function buildProgram(gl: WebGL2RenderingContext): { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> } {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  gl.useProgram(program);
  const names = ["u_rect", "u_canvas", "u_fit", "u_tex", "u_tex_y", "u_tex_uv", "u_yuv_mode", "u_chroma_phase_x", "u_chroma_phase_y", "u_lod", "u_alpha", "u_rotation", "u_premultiplied"];
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, uniforms };
}

function handleInit(message: WorkerInit): void {
  const gl = message.canvas.getContext("webgl2", {
    alpha: false, antialias: false, depth: false, stencil: false,
    // preserveDrawingBuffer：compose 为异步命令（会话侧 await 边界），呈现后不清空。
    preserveDrawingBuffer: true, powerPreference: "high-performance",
  });
  if (!gl) {
    post({ type: "initError", message: "WebGL2 unavailable" });
    return;
  }
  state.canvas = message.canvas;
  state.gl = gl;
  state.canvasWidth = message.canvasWidth;
  state.canvasHeight = message.canvasHeight;
  state.ringDepth = message.ringDepth;
  state.captionStyles = message.captionStyles;
  const built = buildProgram(gl);
  state.program = built.program;
  state.uniforms = built.uniforms;
  state.quad = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(state.program, "a_pos");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 1);
  message.canvas.addEventListener("webglcontextlost", event => {
    event.preventDefault();
    state.contextLost = true;
    post({ type: "contextLost" });
  });
  for (const input of message.inputs) {
    state.sourceWidth.set(input.inputId, input.sourceWidth);
    state.geometry.set(input.inputId, { width: input.width, height: input.height });
    state.ring.set(input.inputId, Array.from({ length: state.ringDepth }, () => ({ y: createYuvTexture(gl), uv: createYuvTexture(gl) })));
  }
  state.backing = { width: message.canvasWidth, height: message.canvasHeight };
  message.canvas.width = Math.max(2, message.canvasWidth);
  message.canvas.height = Math.max(2, message.canvasHeight);
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const adapter = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "masked";
  const vendor = debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : "masked";
  post({ type: "ready", adapter, vendor });
}

/** VideoFrame → 槽位纹理（NV12 直传/I420 重打包 + mipmap；GL 错误显式抛出）。 */
async function uploadToTextures(frame: VideoFrame, targetY: WebGLTexture, targetUV: WebGLTexture): Promise<{ copyToMs: number; texMs: number }> {
  const gl = state.gl!;
  let step = "start";
  let copyToMs = 0;
  let texMs = 0;
  try {
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    // 直接帧上传优先（GPU-GPU 路径）：texImage2D 直采 VideoFrame，跳过 copyTo
    // 的 GPU→CPU 回读（实测 copyTo p95 ~42ms 是 scrub 延迟大头）。首次 GL 失败
    // 自愈回退 copyTo 平面路径；direct 模式下槽纹理即 RGBA 单纹理
    // （MIN_FILTER=LINEAR，绘制走 rgba 分支），会话侧无需感知。
    if (state.frameUploadMode !== "copyTo") {
      step = "direct";
      const directStart = performance.now();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targetY);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      const directError = gl.getError();
      if (directError === gl.NO_ERROR) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        if (state.frameUploadMode !== "direct") {
          state.frameUploadMode = "direct";
          for (const tex of state.allYuvTextures) {
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          }
        }
        frame.close();
        return { copyToMs: 0, texMs: Math.round((performance.now() - directStart) * 1000) / 1000 };
      }
      state.frameUploadMode = "copyTo";
    }
    const cw = width >> 1;
    const ch = height >> 1;
    let scratch = state.scratch.get(`${width}x${height}`);
    if (!scratch || scratch.byteLength < frame.allocationSize()) {
      scratch = new ArrayBuffer(frame.allocationSize());
      state.scratch.set(`${width}x${height}`, scratch);
    }
    step = "copyTo";
    const copyStart = performance.now();
    const layout = await frame.copyTo(scratch);
    copyToMs = performance.now() - copyStart;
    const raw = new Uint8Array(scratch);
    step = "pixelStore";
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // 平面行紧致排布：行起点未必 4 字节对齐（如 682 宽 → Y stride 682）。
    // UNPACK_ALIGNMENT=1 防 INVALID_OPERATION 静默失败（否则绿块，见 evidence）。
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    step = `branch:${frame.format}`;
    const checkErr = (where: string): void => {
      const e = gl.getError();
      if (e !== gl.NO_ERROR) throw new Error(`GL 0x${e.toString(16)} @${where}`);
    };
    // mipmap 自愈：部分 OffscreenCanvas/D3D11 路径 generateMipmap(R8/RG8) 返回
    // INVALID_ENUM（主窗口同驱动可行——上下文差异）。首次失败即整会话降级
    // LINEAR-only（MIN_FILTER 非 mip 型 → textureLod 钳到 base 层，历史
    // mipmap=0 A/B 模式已验证可用；代价是缩小画面无双线性 mip 抗闪烁）。
    const mipmap = (target: WebGLTexture): void => {
      if (!state.mipSupported) return;
      gl.generateMipmap(gl.TEXTURE_2D);
      const e = gl.getError();
      if (e !== gl.NO_ERROR) {
        state.mipSupported = false;
        // 降级清扫：所有 YUV 纹理改 LINEAR（挂着不完整 mip 链的纹理会采黑）
        for (const tex of state.allYuvTextures) {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        }
      }
    };
    if (frame.format === "NV12") {
      const yLayout = layout[0]!;
      const uvLayout = layout[1]!;
      step = "texY";
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targetY);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, yLayout.stride);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE,
        new Uint8Array(scratch, yLayout.offset, yLayout.stride * (height - 1) + width));
      checkErr("texY");
      step = "mipY";
      mipmap(targetY);
      step = "texUV";
      gl.bindTexture(gl.TEXTURE_2D, targetUV);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, uvLayout.stride >> 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, cw, ch, 0, gl.RG, gl.UNSIGNED_BYTE,
        new Uint8Array(scratch, uvLayout.offset, uvLayout.stride * (ch - 1) + cw * 2));
      checkErr("texUV");
      step = "mipUV";
      mipmap(targetUV);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    } else if (frame.format === "I420") {
      const yLayout = layout[0]!;
      const uLayout = layout[1]!;
      const vLayout = layout[2]!;
      const yPacked = new Uint8Array(width * height);
      for (let row = 0; row < height; row++) {
        yPacked.set(raw.subarray(yLayout.offset + row * yLayout.stride, yLayout.offset + row * yLayout.stride + width), row * width);
      }
      const uvPacked = new Uint8Array(cw * ch * 2);
      for (let row = 0; row < ch; row++) {
        const uRow = raw.subarray(uLayout.offset + row * uLayout.stride, uLayout.offset + row * uLayout.stride + cw);
        const vRow = raw.subarray(vLayout.offset + row * vLayout.stride, vLayout.offset + row * vLayout.stride + cw);
        for (let col = 0; col < cw; col++) {
          uvPacked[(row * cw + col) * 2] = uRow[col]!;
          uvPacked[(row * cw + col) * 2 + 1] = vRow[col]!;
        }
      }
      step = "texY_i420";
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targetY);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, yPacked);
      mipmap(targetY);
      step = "texUV_i420";
      gl.bindTexture(gl.TEXTURE_2D, targetUV);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, cw, ch, 0, gl.RG, gl.UNSIGNED_BYTE, uvPacked);
      mipmap(targetUV);
    } else {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      frame.close();
      throw new Error(`unsupported decoded frame format: ${frame.format}`);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    step = "getError";
    texMs = performance.now() - copyStart - copyToMs;
    const glError = gl.getError();
    if (glError !== gl.NO_ERROR) {
      const format = frame.format;
      frame.close();
      throw new Error(`texture upload GL error 0x${glError.toString(16)} @${step} (${width}x${height} ${format})`);
    }
    frame.close();
    return { copyToMs: Math.round(copyToMs * 1000) / 1000, texMs: Math.round(texMs * 1000) / 1000 };
  } catch (error) {
    if (step !== "getError") {
      // 分步标记伴随抛出（定位用）
      throw new Error(`[${step}] ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  }
}

function drawRect(textureY: WebGLTexture, textureUV: WebGLTexture | null, textureRgba: WebGLTexture | null,
                  rect: IrContent, alpha: number, rotationDeg: number, premultiplied: boolean, sourceWidth = 1920): void {
  const gl = state.gl!;
  const u = state.uniforms!;
  const target = state.targetOverride ?? { width: state.backing.width, height: state.backing.height, fitX: state.fit.x, fitY: state.fit.y, fitScale: state.fit.scale };
  gl.activeTexture(gl.TEXTURE0);
  if (textureUV !== null) {
    gl.bindTexture(gl.TEXTURE_2D, textureY);
    gl.uniform1i(u.u_tex_y, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, textureUV);
    gl.uniform1i(u.u_tex_uv, 1);
    gl.uniform1f(u.u_yuv_mode, 1);
    gl.uniform1f(u.u_chroma_phase_x, state.chromaPhaseX);
    gl.uniform1f(u.u_chroma_phase_y, state.chromaPhaseY);
    gl.uniform1f(u.u_lod, Math.max(0, Math.log2(Math.max(sourceWidth, 1) / Math.max(rect.w, 1))));
    gl.uniform1i(u.u_tex, 0);
  } else {
    gl.bindTexture(gl.TEXTURE_2D, textureRgba ?? textureY);
    gl.uniform1i(u.u_tex, 0);
    gl.uniform1f(u.u_yuv_mode, 0);
  }
  gl.uniform4f(u.u_rect, rect.x, rect.y, rect.w, rect.h);
  gl.uniform2f(u.u_canvas, target.width, target.height);
  gl.uniform4f(u.u_fit, target.fitX, target.fitY, target.fitScale, target.fitScale);
  gl.uniform1f(u.u_alpha, alpha);
  gl.uniform1f(u.u_rotation, -(rotationDeg * Math.PI) / 180);
  gl.uniform1f(u.u_premultiplied, premultiplied ? 1 : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function ensureBlurTarget(key: string, divisor: number): { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number } {
  const w = Math.max(2, Math.round(state.canvasWidth / divisor));
  const h = Math.max(2, Math.round(state.canvasHeight / divisor));
  const existing = state.blurTargets.get(key);
  if (existing && existing.w === w && existing.h === h) return existing;
  const gl = state.gl!;
  if (existing) { gl.deleteFramebuffer(existing.fbo); gl.deleteTexture(existing.tex); }
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const target = { fbo, tex, w, h };
  state.blurTargets.set(key, target);
  return target;
}

/** 模糊垫底（blurred_background）：两级降采样近似 gblur（语义与主线程版一致——
 *  u_canvas 必须用 rect 所属坐标空间：pass1=IR 画布、pass2=small 纹理）。 */
function drawBlurredFill(inputId: string, y: WebGLTexture, uv: WebGLTexture | null, alpha: number): void {
  if (state.contextLost || alpha <= 0) return;
  const gl = state.gl!;
  const srcW = Math.max(2, state.geometry.get(inputId)?.width || 16);
  const srcH = Math.max(2, state.geometry.get(inputId)?.height || 9);
  const canvasW = state.canvasWidth;
  const canvasH = state.canvasHeight;
  const aspect = srcW / srcH;
  let rectW = canvasW;
  let rectH = Math.round(rectW / aspect);
  if (rectH < canvasH) { rectH = canvasH; rectW = Math.round(canvasH * aspect); }
  const rect: IrContent = { x: Math.round((canvasW - rectW) / 2), y: Math.round((canvasH - rectH) / 2), w: rectW, h: rectH };
  const small = ensureBlurTarget("small", 4);
  const tiny = ensureBlurTarget("tiny", 16);
  const restoreViewport = [state.backing.width, state.backing.height] as const;
  gl.clearColor(0, 0, 0, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, small.fbo);
  gl.viewport(0, 0, small.w, small.h);
  gl.clear(gl.COLOR_BUFFER_BIT);
  state.targetOverride = { width: canvasW, height: canvasH, fitX: 0, fitY: 0, fitScale: 1 };
  drawRect(y, uv, null, rect, 1, 0, false, srcW * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, tiny.fbo);
  gl.viewport(0, 0, tiny.w, tiny.h);
  gl.clear(gl.COLOR_BUFFER_BIT);
  state.targetOverride = { width: small.w, height: small.h, fitX: 0, fitY: 0, fitScale: 1 };
  drawRect(small.tex, null, small.tex, { x: 0, y: 0, w: small.w, h: small.h }, 1, 0, false, small.w * 4);
  state.targetOverride = null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, restoreViewport[0], restoreViewport[1]);
  gl.clearColor(0, 0, 0, 1);
  drawRect(tiny.tex, null, tiny.tex, { x: 0, y: 0, w: canvasW, h: canvasH }, alpha, 0, false, tiny.w);
}

function ringSlot(inputId: string, slot: number): RingSlot | null {
  const slots = state.ring.get(inputId);
  return slots ? slots[slot % slots.length] ?? null : null;
}

function shadowPair(inputId: string): RingSlot {
  const gl = state.gl!;
  let y = state.shadowY.get(inputId);
  if (!y) { y = createYuvTexture(gl); state.shadowY.set(inputId, y); }
  let uv = state.shadowUV.get(inputId);
  if (!uv) { uv = createYuvTexture(gl); state.shadowUV.set(inputId, uv); }
  return { y, uv };
}

/** 静图 RGBA 纹理（一次上传全程复用；LINEAR 无 mipmap）。 */
function imageTexture(inputId: string): WebGLTexture {
  const gl = state.gl!;
  let tex = state.imageTex.get(inputId);
  if (!tex) {
    tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    state.imageTex.set(inputId, tex);
  }
  return tex;
}

function uploadImage(inputId: string, bitmap: ImageBitmap): void {
  const gl = state.gl!;
  const tex = imageTexture(inputId);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  bitmap.close();
}

function renderCaptionLayer(items: Array<{ caption_id: string; text: string; preset_id: string }>): void {
  const { width, height } = { width: state.canvasWidth, height: state.canvasHeight };
  const gl = state.gl!;
  if (!state.captionCanvas) {
    const canvas = new OffscreenCanvas(width, height);
    state.captionCanvas = canvas;
    state.captionCtx = canvas.getContext("2d");
    state.captionTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, state.captionTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }
  const ctx = state.captionCtx!;
  ctx.clearRect(0, 0, width, height);
  for (const item of items) {
    const style = state.captionStyles[item.preset_id];
    if (!style) continue;
    const family = state.captionFontLoaded || "sans-serif";
    ctx.font = `${style.font_size}px "${family}"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const x = width / 2;
    const y = height - style.margin_v - style.font_size * 0.15;
    if (style.outline > 0) {
      ctx.lineWidth = style.outline * 2;
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.strokeStyle = `rgb(${style.outline_rgb[0]},${style.outline_rgb[1]},${style.outline_rgb[2]})`;
      ctx.strokeText(item.text, x, y);
    }
    ctx.fillStyle = `rgb(${style.primary_rgb[0]},${style.primary_rgb[1]},${style.primary_rgb[2]})`;
    ctx.fillText(item.text, x, y);
  }
  gl.bindTexture(gl.TEXTURE_2D, state.captionTexture!);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, state.captionCanvas as OffscreenCanvas);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

function executeCompose(payload: ComposePayload): void {
  const gl = state.gl!;
  if (state.contextLost) return;
  gl.viewport(0, 0, state.backing.width, state.backing.height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  for (const cmd of payload.cmds) {
    if (cmd.op === "captions") {
      const items = cmd.items ?? [];
      const cacheKey = items.map(item => item.caption_id).join("|");
      if (cacheKey !== state.captionCacheKey) {
        if (items.length > 0) renderCaptionLayer(items);
        state.captionCacheKey = cacheKey;
      }
      if (!state.captionTexture) continue;
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      drawRect(state.captionTexture, null, state.captionTexture, { x: 0, y: 0, w: state.canvasWidth, h: state.canvasHeight }, 1, 0, true);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      continue;
    }
    const inputId = cmd.inputId!;
    const image = cmd.image === true;
    // direct 帧上传模式：槽纹理即 RGBA 单纹理 → 绘制走 rgba 分支（uv=null）
    const rgbaMode = image || state.frameUploadMode === "direct";
    let pair: RingSlot | null;
    if (image) pair = { y: imageTexture(inputId), uv: null as unknown as WebGLTexture };
    else if (cmd.shadow) pair = shadowPair(inputId);
    else {
      const slots = state.ring.get(inputId);
      pair = slots ? slots[(cmd.slot ?? 0) % slots.length] ?? null : null;
    }
    if (!pair) continue;
    const uv = rgbaMode ? null : pair.uv;
    const rgba = rgbaMode ? pair.y : null;
    if (cmd.op === "fill") { drawBlurredFill(inputId, pair.y, uv, cmd.alpha ?? 1); continue; }
    const sourceWidth = image ? (state.geometry.get(inputId)?.width ?? 1920) : (state.sourceWidth.get(inputId) ?? 1920);
    const rect = cmd.rect ?? { x: 0, y: 0, w: state.canvasWidth, h: state.canvasHeight };
    drawRect(pair.y, uv, rgba, rect, cmd.alpha ?? 1, cmd.rotationDeg ?? 0, false, sourceWidth);
  }
  gl.flush();
}

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === "init") { handleInit(message); return; }
    if (message.type === "dispose") { (self as unknown as { close?: () => void }).close?.(); return; }
    if (!state.gl) return;
    if (message.type === "upload") {
      const slot = ringSlot(message.inputId, message.slot)!;
      const start = performance.now();
      void uploadToTextures(message.frame, slot.y, slot.uv).then((split) => {
        post({ type: "uploaded", seq: message.seq, ms: performance.now() - start, copyToMs: split.copyToMs, texMs: split.texMs });
      }, (error: unknown) => {
        post({ type: "uploadError", seq: message.seq, message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (message.type === "uploadShadow") {
      const pair = shadowPair(message.inputId);
      const start = performance.now();
      void uploadToTextures(message.frame, pair.y, pair.uv).then(() => {
        post({ type: "uploadedShadow", seq: message.seq, ms: performance.now() - start });
      }, (error: unknown) => {
        post({ type: "uploadError", seq: message.seq, message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (message.type === "uploadImage") { uploadImage(message.inputId, message.bitmap); return; }
    if (message.type === "compose") { executeCompose(message.payload); return; }
    if (message.type === "resize") {
      state.backing = { width: Math.max(2, message.backingWidth), height: Math.max(2, message.backingHeight) };
      state.fit = { x: message.fitX, y: message.fitY, scale: message.fitScale };
      state.canvas!.width = state.backing.width;
      state.canvas!.height = state.backing.height;
      return;
    }
    if (message.type === "font") {
      const face = new FontFace(message.family, message.buffer);
      void face.load().then(() => {
        const fontSet = (self as unknown as { fonts?: FontFaceSet }).fonts;
        fontSet?.add(face);
        state.captionFontLoaded = message.family;
        state.captionCacheKey = ""; // 字体就绪后强制重绘字幕层
      }, () => undefined);
      return;
    }
    if (message.type === "readback") {
      // 转 ArrayBuffer 再传（Blob 克隆到主线程会丢原型方法；ArrayBuffer 可 transfer）
      const blob = await state.canvas!.convertToBlob({ type: "image/png" });
      const buffer = await blob.arrayBuffer();
      post({ type: "readback", seq: message.seq, buffer }, [buffer]);
      return;
    }
  } catch (error) {
    post({ type: "initError", message: error instanceof Error ? error.message : String(error) });
  }
});
