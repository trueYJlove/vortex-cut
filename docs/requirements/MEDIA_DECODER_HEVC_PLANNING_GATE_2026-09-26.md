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
| 合成预览 | 手写 BMFF demux（`bmff-demux.ts` 仅 `avc1`，`decode-frame` 内联 worker 同源）+ WebCodecs + WebGL | ❌ `BMFF_CODEC_UNSUPPORTED` 回退 |
| 权威预览 / 导出 | Core FFmpeg | ✅ |
| 代理（preview_source） | Core → H.264 CFR30；UI 侧 `mode=auto` 消费 ready 代理（`source-resolver.ts`），显式生成入口在 IPC 层存在但渲染层未接线（`createPreviewSourceJob` 无调用方） | 可作加速 |

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
export interface VideoFrameDecodedFrame {
  kind: "video_frame";
  frame: VideoFrame;
  timestampUs: number;
  frameN: number;
  /** 上传完成后释放（= frame.close()）。B13-R closed 计数依赖该契约。 */
  release(): void;
}

export interface PlanePayloadDecodedFrame {
  kind: "plane_payload";
  timestampUs: number;
  frameN: number;
  width: number;
  height: number;
  /** NV12（y+uv）或 I420（y+u+v）；transfer 语义与 VideoFrame 零拷贝路径对齐 */
  planes: { y: Uint8Array; uv?: Uint8Array; u?: Uint8Array; v?: Uint8Array };
  /** 缺省 BT.709，与冻结方案一致 */
  colorSpace?: "bt709";
  /** 上传完成后释放（detach 平面缓冲；与 video_frame 分支语义对齐）。 */
  release(): void;
}

export type DecodedFrame = VideoFrameDecodedFrame | PlanePayloadDecodedFrame;

export interface MediaDecoder {
  readonly backend: "webcodecs" | "ffmpeg";
  readonly codec: string;          // 如 avc1.640028 / hvc1.1.6.L120
  readonly width: number;
  readonly height: number;
  /** 实际解码模式（诊断呈现用，**不参与后端决策**）；对齐现 worker 值。 */
  readonly hardware: "prefer-hardware" | "no-preference" | null;
  /** 随机访问：frameN 为合成时间轴帧号（与现 DecodeWorker.decode 同义）。
   *  取样定位：PTS 最近邻，diff > 33_334μs（一帧@30fps）报错
   *  （decode-worker.worker.ts:346）；输出匹配：半帧容差 ±16_667μs
   *  （同文件:95——旧 33_334 会错配相邻帧，系统性早一帧）。后端 B
   *  必须复刻**两段**容差，不可只抄 33ms。 */
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
  /** 实测解码模式（"prefer-hardware" / "no-preference" / null=未探测）；
   *  仅呈现用——见下方判定顺序的“无硬解陷阱”。 */
  webcodecs_mode: "prefer-hardware" | "no-preference" | null;
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

1. `VideoDecoder.isConfigSupported({ codec: "hvc1…" / "hev1…" })` 为 `supported` → **webcodecs**（软解是合法路径：**硬解不可得时 FFmpeg 旁路才是代价项**；与现实 `forceSwDecode` 软解路径并存一致）
2. 否则若 Core FFmpeg 能解（`media_info` + `ffmpeg -decoders`）→ **ffmpeg**
3. 否则合成预览回退交互预览（文案改为「编码不受支持」而非「仅 AVC」）

> **无硬解陷阱（评审修正 2026-09-26）**：Electron/Windows 上
> `isConfigSupported` **不保证**返回硬件/软件信息，且 probe 的 codec string
> 与实际 hvcC（profile/tier/level）可能错位——**不能把「硬件非空」当 1 的
> 前置条件**（原稿会误伤仅软解可用的机器，让 HEVC 无谓落 B 路径）。1 的
> 判定依据是 `supported` 本身；软/硬模式与实测 hvcC 一起进 `webcodecs_mode`
> 作诊断呈现。

### 2.3 帧回传（后端 B 的唯一难点）

目标：**解码帧不以 JPEG/PNG 中转，不进 CPU 大位图往返**。

| 代 | 方案 | 采用 |
|---|---|---|
| F0 | Core 出 BGRA → `SharedArrayBuffer`/IPC → `ImageBitmap` | 可作冒烟，不进正式路径 |
| F1 | Core 解码（硬解优先，软解兜底）后出 **NV12 平面** → `postMessage` transfer → `compositor-worker` 与 `uploadToTextures` 同一入口 | **本门正式方案** |
| F2 | 共享 GPU 句柄 / IOSurface / DMA-BUF | 另立研究单；Windows 上成本高 |

正式约定：

- 与现有 `uploadToTextures`（worker 内，`compositor-worker.worker.ts:369`）对齐：**Y/UV 平面进既有纹理槽**，合成器不新增混合格式分支。注意主线程 `Compositor.uploadVideoFrameToTextures`（`compositor.ts:543`）是 worker 化前的回退路径，**不是**平面载荷的接入点。
- 两类 `DecodedFrame` 均带 `release()`：`video_frame` 分支 = `frame.close()`，`plane_payload` 分支 = detach 平面缓冲（§2.1）。**生命周期单点化**——现有代码用「是否拿到 `VideoFrame`」隐式决定是否 `close()`，那是后端知识泄漏的起点，本次显式化。
- 内存记账继续走 B13-R residency（`decoded/posted/closed/live`）；`plane_payload` 的字节量由 plane 尺寸推算计入。

### 2.4 现有代码收编（不改合成语义）

| 现文件 | 去向 |
|---|---|
| `decode-worker.ts` / `decode-worker.worker.ts` | 实现 `WebCodecsDecoder` |
| `bmff-demux.ts` | 阶段 1 保留并扩 hev1/hvcC；阶段 2 仅服务 WebCodecs 喂包或删除 |
| `compositor-worker.uploadToTextures` | 增加平面载荷入口（F1） |
| `source-resolver.ts` | 只解释票；**不再决定编解码后端** |
| Core `media_info` / probe | 能力表数据源 |

### 2.5 后端 B 的 Core 侧契约（本门必须新增，原稿缺失）

FfmpegFrameDecoder 不是渲染进程内部件——它跨 Renderer→Main→Core 三层。现有
Core API（`app.py`）**没有任何窗口帧解码端点**（probe/代理/渲染都是整段作业），
因此本门必须新增，且属 §4 验收项 1 的契约范围：

```text
POST /api/v1/projects/{pid}/assets/{aid}/decode-frames
  请求: { frame_numbers: [uint32], fps: number, pixel_format: "nv12",
          ticket_ref: string }        # ticket_ref = aivideo:// 票据标识
                                      # fps 用 number（非 uint16）：须承载 23.976/29.97
  响应: { frames: [{ frame_n, planes: {y, uv}, stride_y, stride_uv,
                      color_space: "bt709" }] }   # 二进制平面在 IPC 层 transfer
  约束: 帧窗口大小上限（复用 PREVIEW_IR_V2_MAX_WINDOW_FRAMES 思路）；
        decode 长驻进程 vs 按 request 起进程——本门先按 request 起短命
        进程（正确性优先，延迟由 H3 门限约束），长驻进程列为 H4 后优化。
```

- **VFR 映射必须钉死**：后端 B 拿到的是合成帧号（`frameN/fps`），FFmpeg 侧
  需 `-vf select='between(t,...)'` 类按 PTS 取帧——VFR/含 B 帧素材的「取到
  哪一帧」必须与后端 A 的取帧语义**一致**（PTS 最近邻 ±33_334μs 选样 +
  输出半帧 ±16_667μs 匹配，见 §2.1），否则 A/B 切换或混用（多素材时间线
  各走各后端）时同帧号显示不同画面。该一致性进 H3 验收（A/B 同素材同帧号
  逐帧对比测试）。
- **票据复用**：路径永不下发渲染进程（app.py 既有纪律）；Core 侧凭
  ticket_ref 换路径，与 restricted-media 同一鉴权面。
- **能力表数据源**：`ffmpeg -decoders` 探测在 Core 启动时做一次，随
  `DecodeCapabilityTable` 一起经 IPC 提供给 Desktop。

### 2.6 错误码透传链（回退文案的真实工作量）

「不再出现『仅 AVC』文案」不只是改 `bmff-demux.ts:182` 的字符串——该错误
从 worker `postMessage` 到 `fallback-notice.ts` 的 `syntheticFallbackNotice`
中间有两处映射会吞掉结构化错误码：

1. `decode-worker.worker.ts` 错误消息只带 `message`（`BmffUnsupportedError.code`
   已存在但未上捎）——需把 `code` 加进 error 消息结构；
2. `SyntheticPreview.tsx` 启动失败路径用正则子串识别
   （`/PREVIEW_IR_UNSUPPORTED/` 等）——需增加 `BMFF_CODEC_UNSUPPORTED` 的
   子串识别（与既有「IPC 包装前缀」现实一致），`fallback-notice.ts` 加
   人话映射（「该视频编码暂不支持实时合成预览，已回退交互预览」）。

`BMFF_CODEC_UNSUPPORTED` 建议与 §2.2 判定 3 共用同一条用户文案。

## 3. HEVC 接入顺序（建议执行序）

| 序 | 包 | 内容 | 验收 |
|---|---|---|---|
| **H1** | 能力表 + 工厂 + 文案 | `DecodeCapabilityTable` 探测写入；`MediaDecoderFactory` 选择 A/B；错误码透传链（§2.6）打通 + 回退文案去「仅 AVC」 | 无 HEVC 硬解机器上工厂稳定选 B 或明确回退；HEVC 素材回退时用户看到「编码不受支持」人话文案 |
| **H2** | A 路径 HEVC demux | `bmff-demux` 支持 `hev1`/`hvc1` + `hvcC`；codec string 交给 `VideoDecoder` | 平台支持时 HEVC 合成预览可播（与剪映同等） |
| **H3** | B 路径帧回传 F1 | Core 解码窗口帧（对齐 `frameN`/fps，契约见 §2.5）→ NV12 平面 → 合成纹理 | 无硬解机器上 HEVC 合成预览可用；p95 解码延迟入门限；**A/B 同素材同帧号取帧一致（VFR 映射对拍）** |
| **H4** | 长期 demux 收敛 | 容器解析迁 Core；渲染侧只喂 encoded chunk | 手写 sample entry 移出主路径 |
| **H5** | 代理降级为加速 | UI/产品语义改为可选；文档与 STATUS 能力边界同步 | HEVC 不再依赖代理准入 |

依赖：H2 ⊥ H3 可并行；H1 先行；H4 在 H2/H3 后；H5 收尾。

## 4. 验收（本门）

1. **契约**：`MediaDecoder` / `DecodedFrame` / 能力表类型进 `@aivideo/contracts`（或 desktop preview 包）并有单测锁定；**后端 B 的 Core 端点契约（§2.5）含 VFR 取帧语义说明**。  
2. **HEVC 真素材**：`fdf0f0e2…mp4`（hevc + aac）在支持硬解的机器上合成预览可播、可 seek。  
3. **降级**：`forceSwDecode` / 无硬解环境下走 F1 或合法回退交互预览，**不再出现「仅 AVC」文案**。  
4. **回归**：AVC 合成预览、权威预览、导出无回归（Desktop 测试 + Core 全量）。  
5. **架构**：合成器不出现 codec if/else；后端可替换。
6. **生命周期**：`DecodedFrame` 两分支均经 `release()` 释放；B13-R 计数在 F1 路径无泄漏（residency 快照前后对账）。  

## 5. 风险

> 本节各行的「对策」即 AGENTS.md 规定的风险对策承诺——**已逐项登记
> STATUS.md §4（P28–P32）**，核销以该表为准。

| 风险 | 对策（登记号） |
|---|---|
| 平台无 HEVC 硬解 → WebCodecs 解 HEVC 失败 | 能力表启动探测；**软解是合法 A 路径**（§2.2 判定修正）；F1 兜底；禁止静默掉帧（P28） |
| `isConfigSupported` 报 supported 但实际 configure 失败（探测与实配错位） | 工厂 create 失败即落次选后端（既有 fallback 语义）；能力表标 `supported` 但实配失败要回写降级，防止每素材反复试错（P28） |
| F1 帧回传带宽/延迟不足 | 先窗口短 GOP；复用 B13 预算；不达标再评 F2（P29） |
| VFR/含 B 帧素材 A/B 取帧不一致 | §2.5 VFR 映射钉死 + H3 对拍验收（P29） |
| 后端 B Core 端点引入新的进程攻击面 | 复用 restricted-media 票据鉴权；路径不下发渲染进程；窗口上限约束（P30） |
| 手写 demux 扩 hev1 出边界情况 | H2 只覆盖主流 MP4；异常容器强制 B 后端（P31） |
| 预览/导出色彩不一致 | 色彩矩阵钉死 BT.709（沿冻结方案）；H3 契约带 `colorSpace`（P31） |
| 与代理功能纠缠 | H5 明确：代理只加速，能力表不读代理状态（P32） |
| 能力表探测结果缓存过期（换 FFmpeg/驱动后不刷新） | `probed_at` + FFmpeg build 指纹键（probe_cache.py 既有思路）；Core 重启重探（P30） |

## 6. 不做即知的代价

若只扩 `hev1` 而不做后端抽象：AV1/ProRes/坏文件会再次在渲染进程爆表，且 FFmpeg 旁路无法干净接入——与「长远最优」裁决相反。

## 7. 评审修订记录

- **2026-09-26（LiuWei 复核，独立评审轮）**：① §2.2 判定 1 去掉「硬件非空」
  前置——`isConfigSupported` 不保证暴露软/硬信息，且该条件会误伤仅软解可用
  的机器（软解本就是合法 A 路径，代价项是 FFmpeg 旁路不是软解本身）；
  ② `DecodedFrame` 两分支显式 `release()`，`gpu_texture_payload` 更名
  `plane_payload`（CPU 平面载荷冒 GPU 名词误导后续实现）；③ 补 §2.5 后端 B
  的 Core 侧契约（端点/VFR 语义/票据鉴权）——原稿只有渲染侧接口，B 路径
  跨 Renderer→Main→Core 三层却无任何 Core 端点设计，是本稿最大缺口；
  ④ 补 §2.6 错误码透传链两处断点（worker 消息未捎 code / SyntheticPreview
  子串识别未含 `BMFF_CODEC_UNSUPPORTED`）；⑤ §5 风险对策逐项登记 STATUS.md
  §4（P28–P32），闭合 AGENTS.md Rule 3。
- **2026-09-26（LiuKeAi 独立核对）**：对照代码修正三处文实不符——① §2.1
  PTS 容差拆清两段（选样 ±33_334μs / 输出匹配 ±16_667μs），原稿统称 ±33ms
  会让 H3 复刻出「系统性早一帧」的旧缺陷；② §2.2「与 A03 结论一致」误引
  （A03 是 PTS/关键帧索引，与软解合法性无关），改为对照现实 `forceSwDecode`
  路径；③ §2.5 端点契约 `frame_ns`/`fps:uint16` 改为 `frame_numbers`/
  `fps:number`（避免 ns=纳秒误读；uint16 装不下 23.976/29.97），并改指向
  §4 验收项 1（原「§1.1」在本文无此节号）。
