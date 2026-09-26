# H1 能力表 + MediaDecoderFactory + 错误码透传——实施记录

> 实施：2026-09-26。规划门：`MEDIA_DECODER_HEVC_PLANNING_GATE_2026-09-26.md`
> （含 §7 评审修订）。对应 STATUS P27 执行序 **H1**。

## 0. 范围（H1 一行）

| 包 | 内容 | 验收 |
|---|---|---|
| **H1** | `DecodeCapabilityTable` 探测写入；`MediaDecoderFactory` 选择 A/B；错误码透传链（§2.6）打通 + 回退文案去「仅 AVC」 | 无 HEVC 硬解机器上工厂稳定选 B 或明确回退；HEVC 素材回退时用户看到「编码不受支持」人话文案 |

**不在本单**：H2 hev1/hvc1 demux、H3 FfmpegFrameDecoder 与 Core `decode-frames` 端点、H4/H5。

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `packages/contracts/src/performance.ts` | `DecodeBackendId` / `DecodeCapabilityRow` / `DecodeCapabilityTable` + 校验器 |
| `apps/desktop/src/app/preview/media-decoder.ts` | `DecodedFrame` 两分支（`video_frame` / `plane_payload`，均 `release()`）+ `MediaDecoder` / `MediaDecoderFactory` |
| `apps/desktop/src/app/preview/decode-capability.ts` | `probeDecodeCapability` / `selectCapabilityRow` / `MediaDecoderFactoryImpl` |
| `decode-worker.worker.ts` | `errorText()`：错误消息带 `CODE:` 前缀上捎 |
| `SyntheticPreview.tsx` | 子串识别增加 `BMFF_CODEC_UNSUPPORTED` |
| `fallback-notice.ts` | 人话映射：「该视频编码暂不支持实时合成预览，已回退交互预览。」 |
| `bmff-demux.ts` | 文案去「仅 AVC」→「编码不受支持」 |

## 2. 验收核对表（H1）

| # | H1 验收 | 结果 | 证据 |
|---|---|---|---|
| 1 | 能力表探测写入 | ✅ | `probeDecodeCapability`：WebCodecs `isConfigSupported`（硬解优先、软解 `no-preference` 合法）；`probed_at` 落表 |
| 2 | `MediaDecoderFactory` 选择 A/B | ✅ | WebCodecs supported → A；否则 ffmpeg → B；双无 → `BMFF_CODEC_UNSUPPORTED`。软解不否决 A |
| 3 | 无 HEVC 硬解机器上工厂稳定选 B 或明确回退 | ✅ | 仅 ffmpeg → preferred=ffmpeg，H3 未就绪抛 `DECODE_BACKEND_UNAVAILABLE`；双无抛 `BMFF_CODEC_UNSUPPORTED` |
| 4 | 错误码透传链（§2.6） | ✅ | worker `errorText` 上捎 code；`SyntheticPreview` 子串识别；`fallback-notice` 人话映射 |
| 5 | 回退文案去「仅 AVC」 | ✅ | demux 文案改为「编码不受支持」；测试断言；源码「仅 AVC」清零 |

### 规划门 §4 本门验收对照

| # | §4 验收项 | H1 状态 | 说明 |
|---|---|---|---|
| 1 | 契约锁定；Core 端点契约含 VFR 语义 | **部分** | 能力表契约进 contracts 并锁定；`MediaDecoder`/`DecodedFrame` 进 preview 包（VideoFrame 属浏览器类型）。§2.5 Core 端点 **H3 落地** |
| 2 | HEVC 真素材可播 | ❌ H2/H3 | 不在本单 |
| 3 | 降级不再出现「仅 AVC」 | ✅ | 见上表 #4/#5 |
| 4 | AVC 回归 | ✅ | 定向测试 + 预览路径 38 项；全量 714/720（6 项 editor-shell/commands 并行抖动，单跑 26/26 绿） |
| 5 | 合成器无 codec if/else | ✅ | 决策收口工厂/能力表；compositor 未改 |
| 6 | `DecodedFrame` 两分支 `release()` | **类型已立** | 接口与 `WebCodecsMediaDecoder` 已带 `release()`；F1 平面路径对账属 H3 |

## 3. 判定顺序

```text
normalize codec → selectCapabilityRow
  ├─ webcodecs_supported → create WebCodecsDecoder（DecodeWorker 包装）
  │     失败 → 次选
  ├─ ffmpeg_supported → create FfmpegFrameDecoder
  │     H3 未就绪：抛 DECODE_BACKEND_UNAVAILABLE（明确，不静默）
  └─ 双无 / 双失败 → BMFF_CODEC_UNSUPPORTED（UI 人话回退）
```

## 4. 遗留（显式登记）

| 项 | 归属 |
|---|---|
| Core `ffmpeg -decoders` 探测与能力表 IPC 注入 | H3（P30） |
| `FfmpegFrameDecoder` + `decode-frames` 端点 + NV12 F1 | H3（P29） |
| `bmff-demux` 扩 hev1/hvc1 + hvcC | H2（P31） |
| 能力表指纹失效重探 | H3/H4（P30） |
| preview-session 尚未接线 `MediaDecoderFactory`（仍直用 DecodeWorker） | H2 接入点 |

## 5. 测试

- `tests/decode-capability.test.ts`：规范化 codec / 探测两态 / 工厂三例
- `tests/fallback-notice.test.ts`：+BMFF_CODEC_UNSUPPORTED 人话
- `tests/contracts.test.ts`：+H1 能力表形状锁
- `tests/bmff-demux.test.ts`：文案断言「编码不受支持」
- contracts + desktop typecheck 绿
