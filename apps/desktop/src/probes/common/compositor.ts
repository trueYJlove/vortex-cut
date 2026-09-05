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

const VERT = `#version 300 es
in vec2 a_pos;
uniform vec4 u_rect;     // x,y(左上,y向下),w,h（画布像素）
uniform vec2 u_canvas;
out vec2 v_box;          // 0..1 盒内坐标（x 右，y 下）
void main() {
  vec2 px = u_rect.xy + a_pos * u_rect.zw;
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

  private createYuvTexture(): WebGLTexture {
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
  ): void {
    const gl = this.gl;
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
    gl.uniform2f(this.uniforms.u_canvas, this.ir.canvas.width, this.ir.canvas.height);
    gl.uniform1f(this.uniforms.u_alpha, alpha);
    // 权威端 rotate 单位缺陷已修复（456c89a：度→弧度换算入滤镜）——
    // GL 端同步度数语义；负号为采样方向对齐（ffmpeg rotate 正角方向，P2 实证校准）。
    gl.uniform1f(this.uniforms.u_rotation, -(rotationDeg * Math.PI) / 180);
    gl.uniform1f(this.uniforms.u_premultiplied, premultiplied ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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

  /** 主轨段条目绘制（alphaScale 供转场两遍绘制使用；shadow 取影子纹理对）。 */
  drawMainSegment(entry: IrMainSegment, alphaScale = 1, shadow = false): void {
    const handle = this.videos.get(entry.input_id);
    if (!handle) return;
    const y = shadow ? this.shadowY(entry.input_id) : handle.textureY;
    const uv = shadow ? this.shadowTextureUV(entry.input_id) : handle.textureUV;
    this.drawRectYuv(y, uv, null, Compositor.shifted(entry.content, entry.shift), entry.alpha * alphaScale, 0, false,
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

  /** WebCodecs 帧上传（P2 步进帧源）：VideoFrame → 纹理，上传后立即 close()。 */
  /**
   * WebCodecs 帧上传（P2 步进帧源）：VideoFrame.copyTo 取 NV12 平面，Y/UV
   * 分别上传为 R8/RG8 平面纹理，着色器内 BT.709 limited→full 转换。不经
   * ANGLE 的视频→RGB 转换（其色度相位/滤波与 libswscale 不一致，实测在第
   * 0 步自校准中表现为水平色度渐变帧 B 通道 +5~10 系统偏置）。
   * shadow=true 时上传到影子纹理对（共享输入转场的第二帧）。
   */
  async uploadVideoFrame(handle: VideoHandle, frame: VideoFrame, shadow = false): Promise<void> {
    const gl = this.gl;
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    const cw = width >> 1;
    const ch = height >> 1;
    // copyTo 返回真实平面布局（解码器 stride 对齐不可假设 == width）；
    // CPU 重打包为紧致 Y + 交错 UV（NV12 直取；I420 由 U/V 平面合成）。
    const buffer = new ArrayBuffer(frame.allocationSize());
    const layout = await frame.copyTo(buffer);
    const raw = new Uint8Array(buffer);
    const yPacked = new Uint8Array(width * height);
    for (let row = 0; row < height; row++) {
      yPacked.set(raw.subarray(layout[0]!.offset + row * layout[0]!.stride, layout[0]!.offset + row * layout[0]!.stride + width), row * width);
    }
    const uvPacked = new Uint8Array(cw * ch * 2);
    const ySize = layout[0]!.stride * height;
    if (frame.format === "NV12") {
      const uvLayout = layout[1]!;
      for (let row = 0; row < ch; row++) {
        uvPacked.set(raw.subarray(uvLayout.offset + row * uvLayout.stride, uvLayout.offset + row * uvLayout.stride + cw * 2), row * cw * 2);
      }
    } else if (frame.format === "I420") {
      const uLayout = layout[1]!;
      const vLayout = layout[2]!;
      for (let row = 0; row < ch; row++) {
        const uRow = raw.subarray(uLayout.offset + row * uLayout.stride, uLayout.offset + row * uLayout.stride + cw);
        const vRow = raw.subarray(vLayout.offset + row * vLayout.stride, vLayout.offset + row * vLayout.stride + cw);
        for (let col = 0; col < cw; col++) {
          uvPacked[(row * cw + col) * 2] = uRow[col]!;
          uvPacked[(row * cw + col) * 2 + 1] = vRow[col]!;
        }
      }
    } else {
      throw new Error(`unsupported decoded frame format: ${frame.format} (ySize=${ySize})`);
    }
    const targetY = shadow ? this.shadowY(handle.inputId) : handle.textureY;
    const targetUV = shadow ? this.shadowTextureUV(handle.inputId) : handle.textureUV;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targetY);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, yPacked);
    if (this.mipmapEnabled) gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, targetUV);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, cw, ch, 0, gl.RG, gl.UNSIGNED_BYTE, uvPacked);
    if (this.mipmapEnabled) gl.generateMipmap(gl.TEXTURE_2D);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
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
        this.sourceWidthScale.get(overlay.input_id) ?? 1920);
    }
  }

  endFrame(): void {
    this.gl.flush();
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
