/**
 * WP-P227 Slice 2：WebGPU 合成器后端的本地类型兜底。
 *
 * 冻结方案沿用 M3-0 探针的先例（src/probes/types-probe.d.ts：WebGPU 类型以
 * 本地 d.ts 兜底，不新增生产依赖）。lib.dom（TS 5.8）只内置了
 * OffscreenRenderingContextId 的 "webgpu" 字面量与极少数全局（GPUError），
 * 完整 WebGPU 接口缺失——本文件按合成器 worker 实际使用的面声明。
 *
 * **声明范围纪律**：仅声明 compositor-webgpu.worker.ts 与 compositor-worker.ts
 * 用到的成员；不照抄规范全集（与 types-probe.d.ts 同一哲学——用到什么声明
 * 什么，规格演进时按编译错误逐个补）。
 */

interface GPUAdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

interface GPUAdapter {
  info?: GPUAdapterInfo;
  requestDevice: (options?: { powerPreference?: "low-power" | "high-performance" }) => Promise<GPUDevice>;
}

interface GPUDeviceLostInfo {
  reason: "unknown" | "destroyed";
  message: string;
}

interface GPUDevice extends EventTarget {
  destroy?: () => void;
  readonly lost: Promise<GPUDeviceLostInfo>;
  createShaderModule: (options: { code: string }) => GPUShaderModule;
  createRenderPipeline: (options: Record<string, unknown>) => GPURenderPipeline;
  createBindGroupLayout: (options: Record<string, unknown>) => GPUBindGroupLayout;
  createBindGroup: (options: { layout: GPUBindGroupLayout; entries: GPUBindGroupEntry[] }) => GPUBindGroup;
  createSampler: (options?: Record<string, unknown>) => GPUSampler;
  createTexture: (options: { size: [number, number] | [number, number, number]; format: string; usage: number }) => GPUTexture;
  createBuffer: (options: { size: number; usage: number; mappedAtCreation?: boolean }) => GPUBuffer;
  createCommandEncoder: () => GPUCommandEncoder;
  importExternalTexture: (options: { source: VideoFrame }) => GPUExternalTexture;
  readonly queue: GPUQueue;
}

interface GPUShaderModule {
  destroy?: () => void;
}

interface GPURenderPipeline {
  getBindGroupLayout: (index: number) => GPUBindGroupLayout;
}

interface GPUBindGroupLayout {
  // opaque handle
}

interface GPUBindGroup {
  // opaque handle
}

type GPUBindGroupEntry =
  | { binding: number; resource: GPUSampler | GPUExternalTexture | GPUTextureView | { buffer: GPUBuffer } };

interface GPUSampler {
  // opaque handle
}

interface GPUTexture {
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: string;
  createView: (options?: Record<string, unknown>) => GPUTextureView;
  destroy: () => void;
}

interface GPUTextureView {
  // opaque handle
}

interface GPUBuffer {
  getMappedRange: () => ArrayBuffer;
  unmap: () => void;
  destroy: () => void;
}

interface GPUQueue {
  submit: (commandBuffers: GPUCommandBuffer[]) => number;
  writeBuffer: (buffer: GPUBuffer, bufferOffset: number, data: BufferSource, dataOffset?: number, size?: number) => void;
  writeTexture: (destination: { texture: GPUTexture; origin?: [number, number, number] }, data: BufferSource, dataLayout: { bytesPerRow?: number; rowsPerImage?: number }, size: [number, number] | [number, number, number]) => void;
  copyExternalImageToTexture: (
    // 探针（m3p1）以 HTMLVideoElement 为源（live video 对照路径）；规范
    // GPUImageCopyExternalImage 同样接受 HTMLVideoElement/HTMLCanvasElement。
    source: { source: VideoFrame | ImageBitmap | OffscreenCanvas | HTMLVideoElement | HTMLCanvasElement; flipY?: boolean; premultipliedAlpha?: boolean },
    destination: { texture: GPUTexture },
    size: [number, number] | [number, number, number],
  ) => void;
  onSubmittedWorkDone: () => Promise<void>;
}

interface GPUCommandBuffer {
  // opaque handle
}

interface GPUCommandEncoder {
  beginRenderPass: (options: {
    colorAttachments: Array<{
      view: GPUTextureView;
      loadOp: "load" | "clear";
      storeOp: "store";
      clearValue?: { r: number; g: number; b: number; a: number };
    }>;
  }) => GPURenderPassEncoder;
  finish: () => GPUCommandBuffer;
}

interface GPURenderPassEncoder {
  setPipeline: (pipeline: GPURenderPipeline) => void;
  setVertexBuffer: (slot: number, buffer: GPUBuffer) => void;
  setBindGroup: (index: number, bindGroup: GPUBindGroup) => void;
  draw: (vertexCount: number) => void;
  end: () => void;
}

interface GPUCanvasContext {
  configure: (options: { device: GPUDevice; format: string; alphaMode?: "opaque" | "premultiplied" }) => void;
  getCurrentTexture: () => GPUTexture;
}

interface GPU {
  requestAdapter: (options?: { powerPreference?: "low-power" | "high-performance" }) => Promise<GPUAdapter | null>;
  getPreferredCanvasFormat: () => string;
}

interface Navigator {
  readonly gpu?: GPU;
}

interface OffscreenCanvas {
  getContext(contextId: "webgpu", options?: Record<string, unknown>): GPUCanvasContext | null;
}

interface HTMLCanvasElement {
  getContext(contextId: "webgpu", options?: Record<string, unknown>): GPUCanvasContext | null;
}


type GPUTextureFormat =
  | "rgba8unorm" | "rgba8unorm-srgb" | "bgra8unorm" | "bgra8unorm-srgb"
  | "rgba16float" | "r8unorm" | "rg8unorm" | "depth24plus" | "depth32float"
  | string & {};

interface GPUExternalTexture {
  // opaque handle（label 等可选成员按需补充）
  readonly label?: string;
}

interface GPUBlendState {
  color: { srcFactor: string; dstFactor: string; operation: string };
  alpha: { srcFactor: string; dstFactor: string; operation: string };
}

// GPUTextureUsage / GPUBufferUsage / GPUShaderStage 常量（值与 WebGPU 规范一致）。
// lib.dom 已有 GPUBufferUsage 的 VERTEX；这里补合成器用到的成员（接口合并）。
declare const GPUTextureUsage: {
  readonly TEXTURE_BINDING: number;
  readonly COPY_DST: number;
  readonly RENDER_ATTACHMENT: number;
};
declare type GPUVertexFormat = "float32x2" | "uint8x2" | "uint8x4" | "sint8x2" | "sint8x4" | "unorm8x2" | "unorm8x4" | "snorm8x2" | "snorm8x4" | "uint16x2" | "uint16x4" | "sint16x2" | "sint16x4" | "unorm16x2" | "unorm16x4" | "snorm16x2" | "snorm16x4" | "float16x2" | "float16x4" | "float32" | "float32x2" | "float32x3" | "float32x4" | "uint32" | "uint32x2" | "uint32x3" | "uint32x4" | "sint32" | "sint32x2" | "sint32x3" | "sint32x4";
