/**
 * M3-0 探针本地类型兜底（冻结方案 §4 技术基线：WebGPU 类型以本地 d.ts 兜底，
 * 不新增生产依赖；WebCodecs 硬件加速枚举与仓内 TS lib 差异在此对齐）。
 * 仅被 src/probes/** 引用路径触及；生产代码不使用这些全局声明之外的行为。
 */
interface HardwareAccelerationFix {
  /** "prefer-hardware"（硬解优先）/ "prefer-software" / "no-preference"（WebCodecs HardwarePreference 枚举） */
  hardwareAcceleration?: "no-preference" | "prefer-hardware" | "prefer-software";
}

interface GPUAdapterInfoLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

interface GPUAdapterLike {
  info?: GPUAdapterInfoLike;
  requestDevice: (options?: { label?: string }) => Promise<GPUDeviceLike>;
}

interface GPUDeviceLike {
  createShaderModule: (options: { code: string }) => unknown;
  createRenderPipeline: (options: Record<string, unknown>) => GPURenderPipelineLike;
  createSampler: (options?: Record<string, unknown>) => unknown;
  createTexture: (options: { size: [number, number]; format: string; usage: number }) => GPUTextureLike;
  createBindGroup: (options: Record<string, unknown>) => unknown;
  createBuffer: (options: { size: number; usage: number; mappedAtCreation?: boolean }) => GPUBufferLike;
  queue: {
    submit: (commandBuffers: unknown[]) => number;
    copyExternalImageToTexture: (source: { source: HTMLVideoElement }, destination: { texture: GPUTextureLike }, size: [number, number]) => void;
    createCommandEncoder?: never;
  };
  createCommandEncoder: () => GPUCommandEncoderLike;
  destroy?: () => void;
}

interface GPURenderPipelineLike {
  getBindGroupLayout: (index: number) => unknown;
}

interface GPUTextureLike {
  createView: (options?: Record<string, unknown>) => unknown;
}

interface GPUBufferLike {
  getMappedRange: () => ArrayBuffer;
  unmap: () => void;
}

interface GPUCommandEncoderLike {
  beginRenderPass: (options: Record<string, unknown>) => GPURenderPassLike;
  finish: () => unknown;
}

interface GPURenderPassLike {
  setPipeline: (pipeline: GPURenderPipelineLike) => void;
  setVertexBuffer: (slot: number, buffer: GPUBufferLike) => void;
  setBindGroup: (index: number, bindGroup: unknown) => void;
  draw: (vertexCount: number) => void;
  end: () => void;
}

interface GPUCanvasContextLike {
  configure: (options: { device: GPUDeviceLike; format: string; alphaMode?: string }) => void;
  getCurrentTexture: () => GPUTextureLike;
}

interface GPULike {
  requestAdapter: (options?: Record<string, unknown>) => Promise<GPUAdapterLike | null>;
  getPreferredCanvasFormat: () => string;
}

interface Navigator {
  readonly gpu?: GPULike;
}

interface HTMLCanvasElement {
  getContext(contextId: "webgpu", options?: Record<string, unknown>): GPUCanvasContextLike | null;
}

// WebGPU usage 常量（探针所需子集，值与规范一致）
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };
declare const GPUBufferUsage: { VERTEX: number };
declare type GPUVertexFormat = "float32x2";
