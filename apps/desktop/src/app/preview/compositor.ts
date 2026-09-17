/**
 * M3-0 探针 WebGL2 合成器：消费 Core 投影的中立 IR（逐帧数值表），只做"应用"。
 * P1（实时合成性能）与 P2（逐帧一致性采样出图）共用本实现 —— 直接支撑 R4
 * "Core 生成 IR、Renderer 只消费"的架构方向验证。
 *
 * 语义对齐（全部以 ffmpeg.py 权威行为为准，见 IR known_approximations）：
 * - 主轨 fit 内容盒 + position 关键帧整体平移 + opacity fade=alpha 整体渐入近似；
 * - xfade fade/fadeblack 借用式重叠（IR 已解析 offset 与逐帧 p）；
 * - PiP 内容盒 transform（旋转/缩放/位移；transform.opacity 被权威端忽略）；
 * - 字幕层（基础样式，IR 携带已解析数值；libass vs 浏览器光栅化为预期系统差）。
 */
import type { Ir, IrContent, IrMainSegment, IrFrame } from "./ir.js";
import { keyingColorRgb, type IrEffectKeying, type IrEffectMask } from "./effects.js";

const VERT = `#version 300 es
in vec2 a_pos;
uniform vec4 u_rect;     // x,y(左上,y向下),w,h（IR 画布像素）
uniform vec2 u_canvas;   // 实际后备缓冲尺寸（= IR 画布时为恒等视图）
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
uniform float u_rotation;        // 弧度；正向 = 顺时针（与 ffmpeg rotate 对齐，P2 实证校验）
uniform float u_premultiplied;   // 字幕纹理为预乘 alpha
uniform float u_yuv_mode;        // 1 = NV12 平面 + BT.709 limited→full
uniform float u_chroma_phase_x;  // 色度采样相位（源色度坐标偏移，第 0 步自校准定标）
uniform float u_chroma_phase_y;
uniform float u_lod;             // 显式纹理层级 = log2(源尺寸/内容盒尺寸)
// IR v0.4 覆盖轨 alpha 效果（与 worker 版同式；语义镜像 effects.ts）。
uniform float u_mask_kind;       // 0=无 1=linear 2=rect 3=ellipse
uniform vec4 u_mask_geom;        // cx, cy, half_w, half_h（pip 帧像素）
uniform vec4 u_mask_extra;       // rotation_rad, feather_x_pw, invert, unused
uniform vec2 u_box_size;         // 内容盒像素尺寸（mask px 坐标基准 = v_box × 盒尺寸）
uniform float u_key_mode;        // 0=无 1=colorkey
uniform vec4 u_key_params;       // key_r, key_g, key_b, similarity
uniform float u_key_blend;
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
    // 显式 LOD：按 内容盒/源分辨率 计算（log2 缩放比），不依赖梯度启发式
    // （实测梯度 LOD 在缩放四边形上过高，周期图案被跨级模糊吞掉）。
    float y = textureLod(u_tex_y, norm, u_lod).r;
    vec2 chroma = textureLod(u_tex_uv, norm + vec2(u_chroma_phase_x, u_chroma_phase_y), u_lod).rg;
    return vec4(clamp(yuv2rgb709(y, chroma.x, chroma.y), 0.0, 1.0), 1.0);
  }
  return texture(u_tex, norm);
}
float maskAlpha() {
  // px = 盒内像素坐标（v_box × 盒尺寸 u_box_size）；u_mask_geom.z/w 是**半轴**，
  // 不能当盒尺寸乘回（width≠0.5 时蒙版被缩放+偏移——P2 v0.4 重跑留证抓出）。
  vec2 px = v_box * u_box_size;
  float ux = cos(u_mask_extra.x) * (px.x - u_mask_geom.x) + sin(u_mask_extra.x) * (px.y - u_mask_geom.y);
  if (u_mask_kind < 1.5) {
    float v = 0.5 + ux / max(u_mask_extra.y, 1.0);
    float a = clamp(v, 0.0, 1.0);
    return u_mask_extra.z > 0.5 ? 1.0 - a : a;
  }
  float uy = -sin(u_mask_extra.x) * (px.x - u_mask_geom.x) + cos(u_mask_extra.x) * (px.y - u_mask_geom.y);
  float inner;
  if (u_mask_kind < 2.5) {
    float norm = max(abs(ux) / u_mask_geom.z, abs(uy) / u_mask_geom.w);
    inner = clamp(1.0 - min(1.0, norm), 0.0, 1.0);
  } else {
    vec2 q = vec2(ux / u_mask_geom.z, uy / u_mask_geom.w);
    inner = clamp(1.0 - length(q), 0.0, 1.0);
  }
  // feather>0：过渡带收进边界内侧（inner/feather，u_mask_extra.w = 原始 feather）；
  // =0：真硬边（一步跳变，v0.4 权威端同式）
  float a = u_mask_extra.w > 0.001 ? clamp(inner / u_mask_extra.w, 0.0, 1.0) : (inner > 0.0 ? 1.0 : 0.0);
  return u_mask_extra.z > 0.5 ? 1.0 - a : a;
}
float keyAlpha(vec3 rgb) {
  float dist = distance(rgb, u_key_params.rgb) / 1.7320508;
  float sim = u_key_params.w;
  if (dist <= sim) return 0.0;
  if (dist >= sim + u_key_blend) return 1.0;
  return (dist - sim) / u_key_blend;
}
void main() {
  vec2 norm;
  if (u_rotation != 0.0) {
    // 权威端 rotate 语义：固定输出盒，内容在盒内旋转、角落透明（fillcolor=black@0）。
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
  if (u_mask_kind > 0.5) a *= maskAlpha();
  if (u_key_mode > 0.5) a *= keyAlpha(tex.rgb);
  frag = u_premultiplied > 0.5 ? vec4(tex.rgb * a, a) : vec4(tex.rgb, a);
}`;

export interface VideoHandle {
  video: HTMLVideoElement | null;
  inputId: string;
  texture: WebGLTexture;
  textureY: WebGLTexture;
  textureUV: WebGLTexture;
  lastUploadedFrame: number;
  presentedMediaTimeS: number;
  presentedCount: number;
}

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly quad: WebGLBuffer;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private readonly textures = new Map<string, WebGLTexture>();
  readonly videos = new Map<string, VideoHandle>();
  private readonly shadowTextures = new Map<string, WebGLTexture>();
  private readonly shadowTexturesUV = new Map<string, WebGLTexture>();
  chromaPhaseX = 0;
  chromaPhaseY = 0;
  mipmapEnabled = true;
  /** 视口适配（等比 contain）：IR 画布 → 后备缓冲。默认恒等。 */
  fitX = 0;
  fitY = 0;
  fitScale = 1;
  private captionCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private captionCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  private captionTexture: WebGLTexture | null = null;
  private captionCacheKey = "";
  captionFontLoaded = "";
  contextLost = false;
  readonly contextLostResolvers: Array<() => void> = [];

  constructor(readonly canvas: HTMLCanvasElement, private readonly ir: Ir) {
    const gl = canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: false, stencil: false,
      // preserveDrawingBuffer：readback 与分步绘制之间存在 await 边界，
      // 关闭时呈现后会清空绘制缓冲（实测校准第 0 步发现）。
      preserveDrawingBuffer: true, powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      this.contextLost = true;
      for (const resolve of this.contextLostResolvers.splice(0)) resolve();
    });
    this.program = this.buildProgram();
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    this.uniforms = {
      u_rect: gl.getUniformLocation(this.program, "u_rect"),
      u_canvas: gl.getUniformLocation(this.program, "u_canvas"),
      u_fit: gl.getUniformLocation(this.program, "u_fit"),
      u_tex: gl.getUniformLocation(this.program, "u_tex"),
      u_tex_y: gl.getUniformLocation(this.program, "u_tex_y"),
      u_tex_uv: gl.getUniformLocation(this.program, "u_tex_uv"),
      u_yuv_mode: gl.getUniformLocation(this.program, "u_yuv_mode"),
      u_chroma_phase_x: gl.getUniformLocation(this.program, "u_chroma_phase_x"),
      u_chroma_phase_y: gl.getUniformLocation(this.program, "u_chroma_phase_y"),
      u_lod: gl.getUniformLocation(this.program, "u_lod"),
      u_alpha: gl.getUniformLocation(this.program, "u_alpha"),
      u_rotation: gl.getUniformLocation(this.program, "u_rotation"),
      u_premultiplied: gl.getUniformLocation(this.program, "u_premultiplied"),
      u_mask_kind: gl.getUniformLocation(this.program, "u_mask_kind"),
      u_mask_geom: gl.getUniformLocation(this.program, "u_mask_geom"),
      u_mask_extra: gl.getUniformLocation(this.program, "u_mask_extra"),
      u_box_size: gl.getUniformLocation(this.program, "u_box_size"),
      u_key_mode: gl.getUniformLocation(this.program, "u_key_mode"),
      u_key_params: gl.getUniformLocation(this.program, "u_key_params"),
      u_key_blend: gl.getUniformLocation(this.program, "u_key_blend"),
    };
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 1);
  }

  private buildProgram(): WebGLProgram {
    const gl = this.gl;
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
    return program;
  }

  /** 新建一个 YUV 兼容纹理（R8/RG8/RGBA 皆可重指定）——环形槽位与影子槽位工厂。 */
  createYuvTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 性能 A/B（P1 取证）：mipmap=0 时用 LINEAR（跳过逐帧 mipmap 生成）；
    // 质量口径（P2）仍为 mipmap trilinear。默认开启 mipmap。
    const useMipmap = new URLSearchParams(location.search).get("mipmap") !== "0";
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, useMipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.mipmapEnabled = useMipmap;
    return texture;
  }

  registerVideo(inputId: string, video: HTMLVideoElement): void {
    const handle: VideoHandle = {
      video, inputId, texture: this.createYuvTexture(),
      textureY: this.createYuvTexture(), textureUV: this.createYuvTexture(),
      lastUploadedFrame: -1, presentedMediaTimeS: 0, presentedCount: 0,
    };
    type RvfcMeta = { mediaTime: number; presentedFrames: number };
    type RvfcVideo = HTMLVideoElement & {
      requestVideoFrameCallback: (cb: (now: number, meta: RvfcMeta) => void) => number;
    };
    const track = (_now: number, metadata: RvfcMeta): void => {
      handle.presentedMediaTimeS = metadata.mediaTime;
      handle.presentedCount = metadata.presentedFrames;
      (video as RvfcVideo).requestVideoFrameCallback(track);
    };
    if ("requestVideoFrameCallback" in video) {
      (video as RvfcVideo).requestVideoFrameCallback(track);
    }
    this.videos.set(inputId, handle);
  }

  /** 上传视频当前呈现帧（stepped 模式 force=true；realtime 模式按呈现帧号去重）。 */
  uploadVideo(handle: VideoHandle, force: boolean): boolean {
    const gl = this.gl;
    const video = handle.video;
    if (!video || video.readyState < 2) return false;
    const frame = Math.round(video.currentTime * this.ir.canvas.fps);
    if (!force && frame === handle.lastUploadedFrame) return false;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, handle.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    handle.lastUploadedFrame = frame;
    return true;
  }

  async seekVideo(handle: VideoHandle, sourceFrame: number): Promise<{ mediaTimeS: number; devFrames: number; debug?: Record<string, unknown> }> {
    const fps = this.ir.canvas.fps;
    const targetS = sourceFrame / fps;
    const video = handle.video;
    if (!video) throw new Error("seekVideo on texture-only handle");
    if (Math.abs(video.currentTime - targetS) < 0.5 / fps && handle.presentedMediaTimeS > 0
      && Math.abs(handle.presentedMediaTimeS - targetS) <= 1.02 / fps) {
      this.uploadVideo(handle, true);
      return { mediaTimeS: handle.presentedMediaTimeS, devFrames: 0 };
    }
    const seeked = new Promise<void>((resolve, reject) => {
      const done = () => { video.removeEventListener("seeked", done); resolve(); };
      video.addEventListener("seeked", done);
      video.addEventListener("error", () => reject(new Error("video error during seek")), { once: true });
    });
    video.currentTime = targetS;
    await seeked;
    // 沉降：两轮 rAF 让合成器真正呈现新帧（D3D11 视频帧异步就绪），
    // texImage2D 才能取到目标帧；本地 rVFC 仅用于 mediaTime 记录（短超时不阻塞）。
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    type RvfcVideo = HTMLVideoElement & {
      requestVideoFrameCallback: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    };
    const presentedViaRvfc = await Promise.race([
      new Promise<number>(resolve => {
        const rvfc = (video as Partial<RvfcVideo>).requestVideoFrameCallback;
        if (typeof rvfc === "function") rvfc.call(video, (_now, meta) => resolve(meta.mediaTime));
        else resolve(Number.NaN);
      }),
      new Promise<number>(resolve => window.setTimeout(() => resolve(Number.NaN), 250)),
    ]);
    const rvfcHit = !Number.isNaN(presentedViaRvfc);
    if (rvfcHit) handle.presentedMediaTimeS = presentedViaRvfc;
    else handle.presentedMediaTimeS = video.currentTime;
    this.uploadVideo(handle, true);
    const quality = video.getVideoPlaybackQuality?.();
    const devFrames = Math.abs(handle.presentedMediaTimeS - targetS) * fps;
    return {
      mediaTimeS: handle.presentedMediaTimeS, devFrames,
      debug: {
        target_s: Math.round(targetS * 1e6) / 1e6,
        current_time_after: Math.round(video.currentTime * 1e6) / 1e6,
        ready_state: video.readyState,
        rvfc_hit: rvfcHit ? 1 : 0,
        total_video_frames: quality?.totalVideoFrames ?? -1,
        dropped_video_frames: quality?.droppedVideoFrames ?? -1,
      },
    };
  }

  awaitPresented(handle: VideoHandle, targetS: number): Promise<{ mediaTimeS: number; devFrames: number }> {
    const fps = this.ir.canvas.fps;
    return new Promise(resolve => {
      const check = () => {
        const devFrames = Math.abs(handle.presentedMediaTimeS - targetS) * fps;
        if (handle.presentedMediaTimeS > 0 && devFrames <= 1.02) {
          resolve({ mediaTimeS: handle.presentedMediaTimeS, devFrames });
          return true;
        }
        return false;
      };
      if (check()) return;
      const poll = window.setInterval(() => { if (check()) window.clearInterval(poll); }, 2);
      const timeout = window.setTimeout(() => { window.clearInterval(poll); resolve({ mediaTimeS: handle.presentedMediaTimeS, devFrames: Math.abs(handle.presentedMediaTimeS - targetS) * fps }); }, 5000);
      void timeout;
    });
  }

  private drawRect(texture: WebGLTexture, rect: IrContent, alpha: number, rotationDeg: number, premultiplied: boolean): void {
    this.drawRectYuv(texture, null, null, rect, alpha, rotationDeg, premultiplied);
  }

  private sourceWidthScale = new Map<string, number>();
  setSourceWidthScale(map: Map<string, number>): void {
    this.sourceWidthScale = map;
  }

  private drawRectYuv(
    textureY: WebGLTexture, textureUV: WebGLTexture | null, textureRgba: WebGLTexture | null,
    rect: IrContent, alpha: number, rotationDeg: number, premultiplied: boolean,
    sourceWidth = 1920,
    mask?: IrEffectMask, keying?: IrEffectKeying,
  ): void {
    const gl = this.gl;
    const target = this.targetOverride ?? { width: this.canvas.width, height: this.canvas.height, fitX: this.fitX, fitY: this.fitY, fitScale: this.fitScale };
    gl.activeTexture(gl.TEXTURE0);
    if (textureUV !== null) {
      gl.bindTexture(gl.TEXTURE_2D, textureY);
      gl.uniform1i(this.uniforms.u_tex_y, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, textureUV);
      gl.uniform1i(this.uniforms.u_tex_uv, 1);
      gl.uniform1f(this.uniforms.u_yuv_mode, 1);
      gl.uniform1f(this.uniforms.u_chroma_phase_x, this.chromaPhaseX);
      gl.uniform1f(this.uniforms.u_chroma_phase_y, this.chromaPhaseY);
      gl.uniform1f(this.uniforms.u_lod, Math.max(0, Math.log2(Math.max(sourceWidth, 1) / Math.max(rect.w, 1))));
      gl.uniform1i(this.uniforms.u_tex, 0);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, textureRgba ?? textureY);
      gl.uniform1i(this.uniforms.u_tex, 0);
      gl.uniform1f(this.uniforms.u_yuv_mode, 0);
    }
    gl.uniform4f(this.uniforms.u_rect, rect.x, rect.y, rect.w, rect.h);
    gl.uniform2f(this.uniforms.u_canvas, target.width, target.height);
    gl.uniform4f(this.uniforms.u_fit, target.fitX, target.fitY, target.fitScale, target.fitScale);
    gl.uniform1f(this.uniforms.u_alpha, alpha);
    // 权威端 rotate 单位缺陷已修复（456c89a：度→弧度换算入滤镜）——
    // GL 端同步度数语义；负号为采样方向对齐（ffmpeg rotate 正角方向，P2 实证校准）。
    gl.uniform1f(this.uniforms.u_rotation, -(rotationDeg * Math.PI) / 180);
    gl.uniform1f(this.uniforms.u_premultiplied, premultiplied ? 1 : 0);
    this.setEffectUniforms(rect, mask, keying);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** v0.4 覆盖轨 alpha 效果 uniform（语义镜像 effects.ts；无效果走 0 快路径）。 */
  private setEffectUniforms(rect: IrContent, mask?: IrEffectMask, keying?: IrEffectKeying): void {
    const gl = this.gl;
    if (mask) {
      const kind = mask.kind === "linear" ? 1 : mask.kind === "rect" ? 2 : 3;
      gl.uniform1f(this.uniforms.u_mask_kind, kind);
      gl.uniform2f(this.uniforms.u_box_size, rect.w, rect.h);
      const halfW = mask.kind === "linear" ? 1 : Math.max(1.0, (mask.width ?? 0.5) * rect.w / 2.0);
      const halfH = mask.kind === "linear" ? 1 : Math.max(1.0, (mask.height ?? 0.5) * rect.h / 2.0);
      gl.uniform4f(this.uniforms.u_mask_geom, (mask.x ?? 0.5) * rect.w, (mask.y ?? 0.5) * rect.h, halfW, halfH);
      // linear 分支用 feather·pw 软边带宽（预乘进 uniform）；ellipse/rect 的
      // feather 分量（u_mask_extra.w）语义为「归一化过渡窗口」，0 = 硬边。
      const feather = Math.min(1, Math.max(0, mask.feather ?? 0));
      const featherPw = Math.max(1.0, feather * rect.w);
      gl.uniform4f(this.uniforms.u_mask_extra, (mask.rotation ?? 0) * Math.PI / 180, featherPw, mask.invert === true ? 1 : 0, feather);
    } else {
      gl.uniform1f(this.uniforms.u_mask_kind, 0);
    }
    if (keying) {
      const [kr, kg, kb] = keyingColorRgb(keying);
      const sim = Math.min(1, Math.max(0, keying.similarity ?? 0.3)) || 0.3;
      gl.uniform1f(this.uniforms.u_key_mode, 1);
      gl.uniform4f(this.uniforms.u_key_params, kr, kg, kb, sim);
      gl.uniform1f(this.uniforms.u_key_blend, Math.min(1, Math.max(0, keying.blend ?? 0.1)) || 0.1);
    } else {
      gl.uniform1f(this.uniforms.u_key_mode, 0);
    }
  }

  private static shifted(rect: IrContent, shift: { dx: number; dy: number }): IrContent {
    return { x: rect.x + shift.dx, y: rect.y + shift.dy, w: rect.w, h: rect.h };
  }

  /** 帧开始：清屏（黑底）。 */
  beginFrame(): void {
    const gl = this.gl;
    if (this.contextLost) throw new Error("webglcontextlost");
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** 预览框适配：后备缓冲设为盒子像素尺寸，IR 画布等比 contain 居中（黑边）。
   *  使合成预览与交互预览共享同一预览框观感（内容几何仍为权威 IR 画布）。
   *  后备缓冲上限 2048：源内容只有 960x540/1080x1920，全屏时超采样纯属浪费
   *  （5M+ 像素/帧的填充率 + 浏览器全屏画布合成），且是全屏卡顿的主要来源。 */
  setViewportBacking(backingWidth: number, backingHeight: number): void {
    const scaleFit = Math.min(backingWidth / this.ir.canvas.width, backingHeight / this.ir.canvas.height);
    const capped = Math.min(scaleFit, 2048 / Math.max(this.ir.canvas.width, this.ir.canvas.height));
    const width = Math.max(2, Math.round(this.ir.canvas.width * capped));
    const height = Math.max(2, Math.round(this.ir.canvas.height * capped));
    if (this.canvas.width === width && this.canvas.height === height) {
      this.recomposeSoon();
      return;
    }
    this.canvas.width = width;
    this.canvas.height = height;
    this.fitX = (width - this.ir.canvas.width * capped) / 2;
    this.fitY = (height - this.ir.canvas.height * capped) / 2;
    this.fitScale = capped;
    this.recomposeSoon();
  }

  /** 尺寸变化会清空绘制缓冲：rAF 合帧重呈现（连续拖拽窗口时避免每帧重建）。 */
  private recomposeRaf = 0;
  private recomposeSoon(): void {
    if (this.recomposeRaf || this.contextLost) return;
    this.recomposeRaf = requestAnimationFrame(() => {
      this.recomposeRaf = 0;
      this.onRecompose?.();
    });
  }
  onRecompose: (() => void) | null = null;

  /** 主轨段条目绘制（alphaScale 供转场两遍绘制使用；shadow 取影子纹理对）。
   * rotationDeg：rotate 关键帧逐帧值（绕画布中心旋转，角落为黑，与权威端一致）。 */
  drawMainSegment(entry: IrMainSegment & { rotation_deg?: number }, alphaScale = 1, shadow = false): void {
    const handle = this.videos.get(entry.input_id);
    if (!handle) return;
    const y = shadow ? this.shadowY(entry.input_id) : handle.textureY;
    const uv = shadow ? this.shadowTextureUV(entry.input_id) : handle.textureUV;
    const rotation = (entry as { rotation_deg?: number }).rotation_deg ?? 0;
    this.drawRectYuv(y, uv, null, Compositor.shifted(entry.content, entry.shift), entry.alpha * alphaScale, rotation, false,
      this.sourceWidthScale.get(entry.input_id) ?? 1920);
  }

  /** 主轨转场条目绘制（left/right 已各自上传到对应输入纹理）。 */
  drawMainTransition(main: Extract<IrFrame["main"], { kind: "transition" }>): void {
    const left = this.videos.get(main.left.input_id);
    const right = this.videos.get(main.right.input_id);
    if (main.transition === "fadeblack") {
      if (left) this.drawRect(left.texture, Compositor.shifted(main.left.content, main.left.shift), main.left.alpha * Math.max(0, 1 - 2 * main.p), 0, false);
      if (right && main.p >= 0.5) this.drawRect(right.texture, Compositor.shifted(main.right.content, main.right.shift), main.right.alpha * (2 * main.p - 1), 0, false);
    } else {
      if (left) this.drawRect(left.texture, Compositor.shifted(main.left.content, main.left.shift), main.left.alpha, 0, false);
      if (right) this.drawRect(right.texture, Compositor.shifted(main.right.content, main.right.shift), main.right.alpha * main.p, 0, false);
    }
  }

  /** 共享输入转场第二纹理（同一视频需同时提供左右两帧）。 */
  shadowTexture(inputId: string): WebGLTexture {
    return this.shadowY(inputId);
  }

  /** 影子槽位公共访问（会话侧影子上传/绘制解析用）。 */
  shadowYTexture(inputId: string): WebGLTexture {
    return this.shadowY(inputId);
  }

  shadowUVTexture(inputId: string): WebGLTexture {
    return this.shadowTextureUV(inputId);
  }

  private shadowY(inputId: string): WebGLTexture {
    let texture = this.shadowTextures.get(inputId);
    if (!texture) {
      texture = this.createYuvTexture();
      this.shadowTextures.set(inputId, texture);
    }
    return texture;
  }

  private shadowTextureUV(inputId: string): WebGLTexture {
    let texture = this.shadowTexturesUV.get(inputId);
    if (!texture) {
      texture = this.createYuvTexture();
      this.shadowTexturesUV.set(inputId, texture);
    }
    return texture;
  }

  /** WebCodecs 帧上传（P2 步进帧源）：VideoFrame → 纹理，上传后立即 close()。
   * shadow=true 时上传到影子纹理对（共享输入转场的第二帧）。
   * 完成前不得把该纹理对外标记为就绪（否则合成读到 Y 新/UV 旧 → 绿块）。 */
  async uploadVideoFrame(handle: VideoHandle, frame: VideoFrame, shadow = false): Promise<void> {
    const targetY = shadow ? this.shadowY(handle.inputId) : handle.textureY;
    const targetUV = shadow ? this.shadowTextureUV(handle.inputId) : handle.textureUV;
    await this.uploadVideoFrameToTextures(frame, targetY, targetUV);
  }

  /** 核心上传：解码帧 → 指定纹理对。NV12 走零拷贝快路径（UNPACK_ROW_LENGTH
   * 直接上传平面视图，省去 1080p 约 3MB 的 JS 逐行重打包）；I420 回退重打包。
   * scratch 可选：复用 copyTo 目标缓冲（消除每帧 ~3MB 分配的 GC 抖动；
   * 由调用方保证 ≥ allocationSize 且无并发使用）。 */
  async uploadVideoFrameToTextures(frame: VideoFrame, targetY: WebGLTexture, targetUV: WebGLTexture, scratch?: ArrayBuffer): Promise<void> {
    const gl = this.gl;
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    const cw = width >> 1;
    const ch = height >> 1;
    // copyTo 返回真实平面布局（解码器 stride 对齐不可假设 == width）
    const buffer = scratch && scratch.byteLength >= frame.allocationSize()
      ? scratch
      : new ArrayBuffer(frame.allocationSize());
    const layout = await frame.copyTo(buffer);
    const raw = new Uint8Array(buffer);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // 平面行紧致排布：行起点未必 4 字节对齐（如 682 宽 → Y stride 682）。
    // 默认 UNPACK_ALIGNMENT=4 会让 texImage2D 以 INVALID_OPERATION 静默失败
    // （GL 错误不抛 JS 异常 → 纹理全空 → YUV 路径绘制出纯绿 (0,77,0) 块，
    // 实证见 evidence/m3_2/playback-repro）。
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (frame.format === "NV12") {
      const yLayout = layout[0]!;
      const uvLayout = layout[1]!;
      // 快路径：平面视图直接上传（行距经 UNPACK_ROW_LENGTH 告知 GL）
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targetY);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, yLayout.stride);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE,
        new Uint8Array(buffer, yLayout.offset, yLayout.stride * (height - 1) + width));
      if (this.mipmapEnabled) gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, targetUV);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, uvLayout.stride >> 1); // RG 双字节像素：行长按像素计
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, cw, ch, 0, gl.RG, gl.UNSIGNED_BYTE,
        new Uint8Array(buffer, uvLayout.offset, uvLayout.stride * (ch - 1) + cw * 2));
      if (this.mipmapEnabled) gl.generateMipmap(gl.TEXTURE_2D);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    } else if (frame.format === "I420") {
      // 回退：Y 重打包 + U/V 平面交错打包为 RG（非对齐宽常见此格式）
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
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targetY);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, yPacked);
      if (this.mipmapEnabled) gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, targetUV);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, cw, ch, 0, gl.RG, gl.UNSIGNED_BYTE, uvPacked);
      if (this.mipmapEnabled) gl.generateMipmap(gl.TEXTURE_2D);
    } else {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      frame.close();
      throw new Error(`unsupported decoded frame format: ${frame.format}`);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // 显式轮询 GL 错误：纹理上传失败绝不允许静默（否则下游合成出空纹理绿块）
    const glError = gl.getError();
    if (glError !== gl.NO_ERROR) {
      frame.close();
      throw new Error(`texture upload GL error 0x${glError.toString(16)} (${width}x${height} ${frame.format})`);
    }
    frame.close();
  }

  registerTextureOnly(inputId: string): VideoHandle {
    const handle: VideoHandle = {
      video: null, inputId, texture: this.createYuvTexture(),
      textureY: this.createYuvTexture(), textureUV: this.createYuvTexture(),
      lastUploadedFrame: -1, presentedMediaTimeS: 0, presentedCount: 0,
    };
    this.videos.set(inputId, handle);
    return handle;
  }

  /** seek + 沉降 + 上传视频当前帧到指定纹理（转场双帧采集用）。 */
  async captureVideoToTexture(handle: VideoHandle, sourceFrame: number, texture: WebGLTexture): Promise<void> {
    await this.seekVideo(handle, sourceFrame);
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (!handle.video) return;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, handle.video);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /**
   * 转场双帧准备：left/right 为不同输入 → 直接返回各自纹理（视频已由调用方
   * seek 到位）；共享输入 → 依次采集左右帧到主纹理与影子纹理。全部 await
   * 完成后才允许开始绘制（绘制本身必须同步，见 preserveDrawingBuffer 注释）。
   */
  async prepareTransition(main: Extract<IrFrame["main"], { kind: "transition" }>): Promise<{ leftTex: WebGLTexture; rightTex: WebGLTexture }> {
    if (main.left.input_id === main.right.input_id) {
      const handle = this.videos.get(main.left.input_id)!;
      const shadow = this.shadowTexture(main.left.input_id);
      await this.captureVideoToTexture(handle, main.left.src_n, handle.texture);
      await this.captureVideoToTexture(handle, main.right.src_n, shadow);
      return { leftTex: handle.texture, rightTex: shadow };
    }
    const left = this.videos.get(main.left.input_id);
    const right = this.videos.get(main.right.input_id);
    if (!left || !right) throw new Error("transition input missing");
    if (main.left.src_n !== left.lastUploadedFrame) await this.captureVideoToTexture(left, main.left.src_n, left.texture);
    if (main.right.src_n !== right.lastUploadedFrame) await this.captureVideoToTexture(right, main.right.src_n, right.texture);
    return { leftTex: left.texture, rightTex: right.texture };
  }

  /** 转场绘制（左右帧已由 uploadVideoFrame 各自上传；shadow 标记第二帧在影子对上）。 */
  drawTransitionTextures(main: Extract<IrFrame["main"], { kind: "transition" }>, leftShadow: boolean, rightShadow: boolean): void {
    const left = this.videos.get(main.left.input_id);
    const right = this.videos.get(main.right.input_id);
    if (!left || !right) throw new Error("transition input missing");
    const leftY = leftShadow ? this.shadowY(main.left.input_id) : left.textureY;
    const leftUV = leftShadow ? this.shadowTextureUV(main.left.input_id) : left.textureUV;
    const rightY = rightShadow ? this.shadowY(main.right.input_id) : right.textureY;
    const rightUV = rightShadow ? this.shadowTextureUV(main.right.input_id) : right.textureUV;
    const lw = this.sourceWidthScale.get(main.left.input_id) ?? 1920;
    const rw = this.sourceWidthScale.get(main.right.input_id) ?? 1920;
    if (main.transition === "fadeblack") {
      this.drawRectYuv(leftY, leftUV, null, Compositor.shifted(main.left.content, main.left.shift), main.left.alpha * Math.max(0, 1 - 2 * main.p), 0, false, lw);
      if (main.p >= 0.5) this.drawRectYuv(rightY, rightUV, null, Compositor.shifted(main.right.content, main.right.shift), main.right.alpha * (2 * main.p - 1), 0, false, rw);
    } else {
      this.drawRectYuv(leftY, leftUV, null, Compositor.shifted(main.left.content, main.left.shift), main.left.alpha, 0, false, lw);
      this.drawRectYuv(rightY, rightUV, null, Compositor.shifted(main.right.content, main.right.shift), main.right.alpha * main.p, 0, false, rw);
    }
  }

  drawCaptionsOf(frame: IrFrame): void {
    if (frame.captions.length > 0) this.drawCaptions(frame.captions);
  }

  drawOverlays(frame: IrFrame): void {
    for (const overlay of frame.overlays) {
      const handle = this.videos.get(overlay.input_id);
      if (handle) this.drawRectYuv(handle.textureY, handle.textureUV, null, overlay.box, overlay.alpha, overlay.rotation_deg, false,
        this.sourceWidthScale.get(overlay.input_id) ?? 1920, overlay.effects?.mask, overlay.effects?.keying);
    }
  }

  /** 会话侧显式纹理绘制（环形槽位/静图；uv=null 走 RGBA 模式——静图修复绿块）。 */
  drawTextures(inputId: string, y: WebGLTexture, uv: WebGLTexture | null,
               rect: IrContent, alpha: number, rotationDeg: number): void {
    this.drawRectYuv(y, uv, null, rect, alpha, rotationDeg, false,
      this.sourceWidthScale.get(inputId) ?? 1920);
  }

  /** 模糊垫底 FBO 目标：IR 画布 ÷4 与 ÷16 两级（懒创建，LINEAR + CLAMP）。 */
  private blurTargets = new Map<string, { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }>();
  private targetOverride: { width: number; height: number; fitX: number; fitY: number; fitScale: number } | null = null;

  private ensureBlurTarget(key: string, divisor: number): { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number } {
    const w = Math.max(2, Math.round(this.ir.canvas.width / divisor));
    const h = Math.max(2, Math.round(this.ir.canvas.height / divisor));
    const existing = this.blurTargets.get(key);
    if (existing && existing.w === w && existing.h === h) return existing;
    if (existing) { this.gl.deleteFramebuffer(existing.fbo); this.gl.deleteTexture(existing.tex); }
    const gl = this.gl;
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
    this.blurTargets.set(key, target);
    return target;
  }

  /**
   * 模糊垫底（blurred_background）：权威端语义 = 源 scale-to-increase 覆盖画布
   * + crop + gblur sigma=20，其上再叠 fit 内容。实时端用两级降采样近似
   * （÷4 → ÷16，线性放大还原）——宽范围低频模糊观感与 gblur 相当，
   * 成本 2 个小目标 quad，known_approximation。
   * 由会话在内容绘制**之前**调用（垫底在下层）；转场两侧按各自 alpha 调用。
   */
  drawBlurredFill(inputId: string, y: WebGLTexture, uv: WebGLTexture | null, alpha: number): void {
    if (this.contextLost || alpha <= 0) return;
    const input = this.ir.inputs.find(item => item.input_id === inputId);
    const srcW = Math.max(2, input?.geometry.width || 16);
    const srcH = Math.max(2, input?.geometry.height || 9);
    const canvasW = this.ir.canvas.width;
    const canvasH = this.ir.canvas.height;
    const aspect = srcW / srcH;
    let rectW = canvasW;
    let rectH = Math.round(rectW / aspect);
    if (rectH < canvasH) { rectH = canvasH; rectW = Math.round(canvasH * aspect); }
    // cover 盒（超出画布部分被视口裁掉 = crop 语义）
    const rect: IrContent = { x: Math.round((canvasW - rectW) / 2), y: Math.round((canvasH - rectH) / 2), w: rectW, h: rectH };
    const gl = this.gl;
    const small = this.ensureBlurTarget("small", 4);
    const tiny = this.ensureBlurTarget("tiny", 16);
    const restoreViewport = [this.canvas.width, this.canvas.height] as const;
    gl.clearColor(0, 0, 0, 0); // FBO 目标清为透明黑（垫底 alpha<1 时与下层正确混合）
    // pass 1：源 → ÷4（YUV 直绘 cover，minification 4× 计入 LOD）
    gl.bindFramebuffer(gl.FRAMEBUFFER, small.fbo);
    gl.viewport(0, 0, small.w, small.h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // u_canvas 必须是 **IR 画布尺寸**（rect 在 IR 像素空间）：clip [-1,1] 铺满
    // 当前视口 → 整幅画布图像（cover 裁切后）以 ÷4 分辨率落入 FBO。若把
    // u_canvas 设为 FBO 尺寸，quad 只会把画布左上角一小块映射进视口（首版
    // 实测黑底的根因）。
    this.targetOverride = { width: canvasW, height: canvasH, fitX: 0, fitY: 0, fitScale: 1 };
    // alpha=1：真实 alpha 只在最终 pass 应用，否则与 FBO 混合会双重乘法变暗
    this.drawRectYuv(y, uv, null, rect, 1, 0, false, srcW * 4);
    // pass 2：÷4 → ÷16（rect 在 small 纹理空间：u_canvas=small，全图映射进 tiny）
    gl.bindFramebuffer(gl.FRAMEBUFFER, tiny.fbo);
    gl.viewport(0, 0, tiny.w, tiny.h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.targetOverride = { width: small.w, height: small.h, fitX: 0, fitY: 0, fitScale: 1 };
    this.drawRectYuv(small.tex, null, small.tex, { x: 0, y: 0, w: small.w, h: small.h }, 1, 0, false, small.w * 4);
    this.targetOverride = null;
    // pass 3：÷16 → 默认帧缓冲全画布（线性放大 = 模糊），此处应用垫底 alpha
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, restoreViewport[0], restoreViewport[1]);
    gl.clearColor(0, 0, 0, 1);
    this.drawRectYuv(tiny.tex, null, tiny.tex, { x: 0, y: 0, w: canvasW, h: canvasH }, alpha, 0, false, tiny.w);
  }

  /** 转场绘制（左右纹理对由会话环形/影子槽位解析；LOD 按各自输入源宽）。 */
  drawTransitionWithPairs(
    left: { y: WebGLTexture; uv: WebGLTexture | null },
    right: { y: WebGLTexture; uv: WebGLTexture | null },
    main: Extract<IrFrame["main"], { kind: "transition" }>,
  ): void {
    const lw = this.sourceWidthScale.get(main.left.input_id) ?? 1920;
    const rw = this.sourceWidthScale.get(main.right.input_id) ?? 1920;
    if (main.transition === "fadeblack") {
      this.drawRectYuv(left.y, left.uv, null, Compositor.shifted(main.left.content, main.left.shift), main.left.alpha * Math.max(0, 1 - 2 * main.p), 0, false, lw);
      if (main.p >= 0.5) this.drawRectYuv(right.y, right.uv, null, Compositor.shifted(main.right.content, main.right.shift), main.right.alpha * (2 * main.p - 1), 0, false, rw);
    } else {
      this.drawRectYuv(left.y, left.uv, null, Compositor.shifted(main.left.content, main.left.shift), main.left.alpha, 0, false, lw);
      this.drawRectYuv(right.y, right.uv, null, Compositor.shifted(main.right.content, main.right.shift), main.right.alpha * main.p, 0, false, rw);
    }
  }

  endFrame(): void {
    this.gl.flush();
  }

  /** 静图输入上传（Image/ImageBitmap → RGBA 纹理；静态图一次上传全程复用）。 */
  uploadImageFrame(handle: VideoHandle, source: ImageBitmap | HTMLImageElement): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, handle.textureY);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /** 按 IR 帧数值表合成一帧（不做任何插值/借位计算 —— 全部已由 Core 解析）。 */
  composeFrame(frame: IrFrame, options: { drawCaptions: boolean }): void {
    this.beginFrame();
    const main = frame.main;
    if (main.kind === "segment") this.drawMainSegment(main);
    else if (main.kind === "transition") this.drawMainTransition(main);
    this.drawOverlays(frame);
    if (options.drawCaptions && frame.captions.length > 0) this.drawCaptions(frame.captions);
    this.endFrame();
  }

  private drawCaptions(captionIds: string[]): void {
    const gl = this.gl;
    const cacheKey = captionIds.join("|");
    if (cacheKey !== this.captionCacheKey) {
      this.renderCaptionLayer(captionIds);
      this.captionCacheKey = cacheKey;
    }
    if (!this.captionTexture) return;
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawRect(this.captionTexture, { x: 0, y: 0, w: this.ir.canvas.width, h: this.ir.canvas.height }, 1, 0, true);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  async ensureCaptionFont(fontArrayBuffer: ArrayBuffer, family: string): Promise<void> {
    if (this.captionFontLoaded === family) return;
    const face = new FontFace(family, fontArrayBuffer);
    await face.load();
    document.fonts.add(face);
    this.captionFontLoaded = family;
    this.captionCacheKey = ""; // 字体就绪后强制重绘字幕层
  }

  private renderCaptionLayer(captionIds: string[]): void {
    const { width, height } = this.ir.canvas;
    if (!this.captionCanvas) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      this.captionCanvas = canvas;
      this.captionCtx = canvas.getContext("2d");
      const gl = this.gl;
      this.captionTexture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.captionTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    const ctx = this.captionCtx!;
    ctx.clearRect(0, 0, width, height);
    for (const captionId of captionIds) {
      const item = this.ir.captions.find(entry => entry.caption_id === captionId);
      if (!item) continue;
      const style = this.ir.caption_styles[item.preset_id];
      if (!style) continue;
      const family = this.captionFontLoaded || "sans-serif";
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
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.captionTexture!);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.captionCanvas as HTMLCanvasElement);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /** RGBA8 回读 → PNG Blob（readPixels 自下而上，需翻行）。 */
  async readbackPng(): Promise<Blob> {
    const gl = this.gl;
    const { width, height } = this.ir.canvas;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const image = ctx.createImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    }
    ctx.putImageData(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png"));
  }

  gpuRendererInfo(): { adapter: string; vendor: string } {
    const gl = this.gl;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const adapter = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "masked";
    const vendor = debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : "masked";
    return { adapter, vendor };
  }
}

export function assertHardwareRenderer(adapter: string): { hardware: boolean; software: boolean } {
  const lowered = adapter.toLowerCase();
  const software = lowered.includes("swiftshader") || lowered.includes("llvmpipe")
    || lowered.includes("software") || lowered.includes("basic render");
  const hardware = !software && lowered.length > 0;
  return { hardware, software };
}
