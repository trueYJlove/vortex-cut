# H3 收口：session 接线 + 平面上传 + 能力表数据源——实施记录

> 实施：2026-09-26。承接 `MEDIA_DECODER_HEVC_H3_IMPLEMENTATION_2026-09-26.md` 遗留项。

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `compositor-worker.worker.ts` | F1 平面上传 `uploadPlanesToTextures` + `uploadPlanes`/`uploadShadowPlanes` 协议 |
| `compositor-worker.ts` | `uploadDecoded`/`uploadShadowDecoded`（DecodedFrame 统一入口，release 收口） |
| `preview-session.ts` | `InputRig.worker: MediaDecoder`；`factory.create(codec:"auto")`；decode→DecodedFrame→uploadDecoded |
| `decode-capability.ts` | `codec="auto"` 依次 A/B；优先抛首个后端错误；`WebCodecsMediaDecoder.lastFrameInfo` |
| `media-decoder.ts` | `PlanePayloadDecodedFrame.strideY/strideUv`；`MediaDecoder.lastFrameInfo?` |
| `encoders.py` | `decode_capability()`：`ffmpeg -decoders` → avc/hevc/av1；并入 `capabilities()` |

## 2. 验收核对表

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | preview-session 经 MediaDecoderFactory 建解码器 | ✅ | `create({codec:"auto"})`；webcodecs=DecodeWorker 包装，失败落 ffmpeg |
| 2 | compositor 平面载荷入口（F1） | ✅ | `uploadPlanesToTextures` 与 VideoFrame NV12 分支同一纹理槽 |
| 3 | DecodedFrame 两分支 release() | ✅ | `uploadDecoded` finally release；video_frame 后 close 幂等 |
| 4 | Core ffmpeg -decoders 能力表数据源 | ✅ | `decode_capability()` + `/system/capabilities.decode_capability`；单测 |
| 5 | p95 门限 | ⏳ **初值 2s（小夹具）** | `test_p95_latency_gate_small_fixture`；真机 1080p/HEVC scrub 待定档（P29） |
| 6 | 真机 HEVC 合成预览端到端 | ⏳ **待真机** | 代码链已通；需 Electron + 系统 HEVC 实测 |

## 3. 判定与回退

```text
preview-session
  └─ probeDecodeCapability() + factory.create(codec="auto")
       ├─ webcodecs（DecodeWorker/demux 发现编码；H2 吃 hev1/hvc1）
       │    失败 → 次选
       └─ ffmpeg（decodeFrames → Main → Core decode-frames → NV12）
            失败 → 抛首个后端错误（诊断不掩盖）
```

## 4. 遗留

| 项 | 归属 |
|---|---|
| Desktop 消费 `decode_capability` 回写 `ffmpeg_supported` | 可选增强（auto 路径已不依赖） |
| 真机 HEVC e2e + p95 门限定档 | P29 收口 |
| preview-session 内 p95 指标已有 `decode_ms_p95` | 消费现有 metrics 即可 |

## 5. 测试

- Desktop 相关 87 绿；typecheck 绿
- Core：`test_decode_capability` + `test_frame_decode` + `test_frame_decode_real` 12 passed
