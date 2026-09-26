# 合成预览解码后端与 HEVC 接入——Planning Gate

> 起草：LiuWei，2026-09-26。来源：HEVC 生活素材合成预览回退现场
> （`采样入口 hev1 不支持（仅 AVC）`）+ 架构讨论裁决（用户 2026-09-26）。
>
> **产品裁决**：不推翻 WebCodecs 合成快路径；**demux 兼容收进媒体层，解码双后端**；
> 代理降级为性能选项，不再是 HEVC 准入条件。追求长远正确，不赶工。

## 0. 现状结论（代码级，2026-09-26）

| 链路 | 实现 | HEVC |
|---|---|---|
| 交互预览 | `HTMLMediaElement` | ✅ 系统解码可播 |
| 合成预览 | 手写 BMFF demux（`bmff-demux.ts` 仅 `avc1`）+ WebCodecs + WebGL | ❌ `BMFF_CODEC_UNSUPPORTED` 回退 |
| 权威预览 / 导出 | Core FFmpeg | ✅ |
| 代理（preview_source） | Core → H.264 CFR30 | 可作加速，UI 未接线 |

根因不是 WebCodecs 本身，而是 **demux 能力面被冻在 avc1**，且兼容逻辑长在渲染进程。

## 1. 范围

### 必须实现

1. **`MediaDecoder` 抽象**（帧源统一接口）：合成器只认 `decode(frameN) → Frame`，不关心后端。
2. **能力表**（单一真相）：codec/container/profile → 后端选择；预览与导出探测共用 `media_info`。
3. **后端 A `WebCodecsDecoder`**：现有 `DecodeWorker` 收编为实现之一（保留 GPU `VideoFrame` 快路径）。
4. **后端 B `FfmpegFrameDecoder`**：Core demux+解码（与导出同 FFmpeg）；帧回传为合成器可上传的纹理载荷。
5. **HEVC 接入**：能力表允许时走 A（硬解），否则自动落 B；用户无「HEVC 专属」开关。
6. **demux 策略**：
   - 短期（本阶段）：A 路径 demux 扩 `hev1`/`hvc1`+`hvcC`（只为 WebCodecs 喂包）；
   - 长期：A 路径容器解析迁到 Core FFmpeg remux/探针产物，渲染侧不再维护多编码 sample entry。

### 明确不做（本阶段）

- 推倒 WebGL 合成器 / `compositor-worker`；
- 代理 UI 产品化（仅保留 API；性能项另单）；
- AV1/ProRes/RAW 全覆盖（能力表预留，不在本门实现）；
- 浏览器外播内核（不引入完整 FFmpeg 播放器进程）。

## 2. 接口草案

### 2.1 帧与后端（Renderer）

```ts
/** 合成器唯一消费的解码结果。像素已可被 compositor-worker 上传。 */
export type DecodedFrame =
  | { kind: "video_frame"; frame: VideoFrame; timestampUs: number; frameN: number }
  | {
      kind: "gpu_texture_payload";
      timestampUs: number;
      frameN: number;
      width: number;
      height: number;
      /** NV12/I420 平面；transfer 语义与 VideoFrame 零拷贝路径对齐 */
      planes: { y: Uint8Array; uv?: Uint8Array; u?: Uint8Array; v?: Uint8Array };
      /** 缺省 BT.709，与冻结方案一致 */
      colorSpace?: "bt709";
    };

export interface MediaDecoder {
  readonly backend: "webcodecs" | "ffmpeg";
  readonly codec: string;          // 如 avc1.640028 / hvc1.1.6.L120
  readonly width: number;
  readonly height: number;
  readonly hardware: string | null;
  /** 随机访问：frameN 为合成时间轴帧号（与现 DecodeWorker.decode 同义）。 */
  decode(frameN: number, fps: number, signal?: AbortSignal): Promise<DecodedFrame>;
  residency(): Promise<DecodeResidencyInfo | null>;
  dispose(): void;
}

export interface MediaDecoderFactory {
  /** 能力表决策后调用；失败可 fallback 到次选后端。 */
  create(input: {
    mediaUrl: string;          // aivideo:// 票据
    probe: MediaProbeSummary;  // 与 Core media_info 对齐
    forceSwDecode?: boolean;
    cacheCapBytes?: number;
  }, signal?: AbortSignal): Promise<MediaDecoder>;
}
```

### 2.2 能力表（Desktop + Core 共用契约）

```ts
export type DecodeBackendId = "webcodecs" | "ffmpeg";

export interface DecodeCapabilityRow {
  /** 规范化 codec：avc / hevc / av1 / ... */
  codec: string;
  /** 平台实测结果（启动后探测写入，非写死） */
  webcodecs_supported: boolean;
  webcodecs_hardware: string | null;
  ffmpeg_supported: boolean;
  /** 决策：首选后端；webcodecs 不可用时自动 ffmpeg */
  preferred: DecodeBackendId;
}

export interface DecodeCapabilityTable {
  rows: DecodeCapabilityRow[];
  probed_at: string;
}
```

判定顺序（HEVC 落地规则）：

1. `VideoDecoder.isConfigSupported({ codec: "hvc1…" / "hev1…" })` 且硬件非空 → **webcodecs**  
2. 否则若 Core FFmpeg 能解（`media_info` + `ffmpeg -decoders`）→ **ffmpeg**  
3. 否则合成预览回退交互预览（文案改为「编码不受支持」而非「仅 AVC」）

### 2.3 帧回传（后端 B 的唯一难点）

目标：**解码帧不以 JPEG/PNG 中转，不进 CPU 大位图往返**。

| 代 | 方案 | 采用 |
|---|---|---|
| F0 | Core 出 BGRA → `SharedArrayBuffer`/IPC → `ImageBitmap` | 可作冒烟，不进正式路径 |
| F1 | Core 硬解后 **NV12 平面** → `postMessage` transfer → `compositor-worker` 与 `uploadToTextures` 同一入口 | **本门正式方案** |
| F2 | 共享 GPU 句柄 / IOSurface / DMA-BUF | 另立研究单；Windows 上成本高 |

正式约定：

- 与现有 `uploadVideoFrameToTextures` 对齐：**Y/UV 平面进既有纹理槽**，合成器不新增混合格式分支。
- `DecodedFrame.kind = "gpu_texture_payload"` 的 `close()` 语义改为 `release()`（无 `VideoFrame` 对象时）。
- 内存记账继续走 B13-R residency（`decoded/posted/closed/live`）。

### 2.4 现有代码收编（不改合成语义）

| 现文件 | 去向 |
|---|---|
| `decode-worker.ts` / `decode-worker.worker.ts` | 实现 `WebCodecsDecoder` |
| `bmff-demux.ts` | 阶段 1 保留并扩 hev1/hvcC；阶段 2 仅服务 WebCodecs 喂包或删除 |
| `compositor-worker.uploadToTextures` | 增加平面载荷入口（F1） |
| `source-resolver.ts` | 只解释票；**不再决定编解码后端** |
| Core `media_info` / probe | 能力表数据源 |

## 3. HEVC 接入顺序（建议执行序）

| 序 | 包 | 内容 | 验收 |
|---|---|---|---|
| **H1** | 能力表 + 工厂 | `DecodeCapabilityTable` 探测写入；`MediaDecoderFactory` 选择 A/B；回退文案去「仅 AVC」 | 无 HEVC 硬解机器上工厂稳定选 B 或明确回退 |
| **H2** | A 路径 HEVC demux | `bmff-demux` 支持 `hev1`/`hvc1` + `hvcC`；codec string 交给 `VideoDecoder` | 平台支持时 HEVC 合成预览可播（与剪映同等） |
| **H3** | B 路径帧回传 F1 | Core 解码窗口帧（对齐 `frameN`/fps）→ NV12 平面 → 合成纹理 | 无硬解机器上 HEVC 合成预览可用；p95 解码延迟入门限 |
| **H4** | 长期 demux 收敛 | 容器解析迁 Core；渲染侧只喂 encoded chunk | 手写 sample entry 移出主路径 |
| **H5** | 代理降级为加速 | UI/产品语义改为可选；文档与 STATUS 能力边界同步 | HEVC 不再依赖代理准入 |

依赖：H2 ⊥ H3 可并行；H1 先行；H4 在 H2/H3 后；H5 收尾。

## 4. 验收（本门）

1. **契约**：`MediaDecoder` / `DecodedFrame` / 能力表类型进 `@aivideo/contracts`（或 desktop preview 包）并有单测锁定。  
2. **HEVC 真素材**：`fdf0f0e2…mp4`（hevc + aac）在支持硬解的机器上合成预览可播、可 seek。  
3. **降级**：`forceSwDecode` / 无硬解环境下走 F1 或合法回退交互预览，**不再出现「仅 AVC」文案**。  
4. **回归**：AVC 合成预览、权威预览、导出无回归（Desktop 测试 + Core 全量）。  
5. **架构**：合成器不出现 codec if/else；后端可替换。

## 5. 风险

| 风险 | 对策 |
|---|---|
| 平台无 HEVC 硬解 → WebCodecs 解 HEVC 失败 | 能力表启动探测；F1 兜底；禁止静默掉帧 |
| F1 帧回传带宽/延迟不足 | 先窗口短 GOP；复用 B13 预算；不达标再评 F2 |
| 手写 demux 扩 hev1 出边界情况 | H2 只覆盖主流 MP4；异常容器强制 B 后端 |
| 预览/导出色彩不一致 | 色彩矩阵钉死 BT.709（沿冻结方案）；H3 契约带 `colorSpace` |
| 与代理功能纠缠 | H5 明确：代理只加速，能力表不读代理状态 |

## 6. 不做即知的代价

若只扩 `hev1` 而不做后端抽象：AV1/ProRes/坏文件会再次在渲染进程爆表，且 FFmpeg 旁路无法干净接入——与「长远最优」裁决相反。
