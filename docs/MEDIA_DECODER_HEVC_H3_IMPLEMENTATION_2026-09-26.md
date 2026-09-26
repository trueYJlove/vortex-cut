# H3 后端 B 帧回传 F1——实施记录

> 实施：2026-09-26。规划门：`MEDIA_DECODER_HEVC_PLANNING_GATE_2026-09-26.md`
> §2.5 / §3 H3。与 H2（demux 扩 HEVC）并行。

## 0. 范围

| 包 | 内容 | 验收 |
|---|---|---|
| **H3** | Core 解码窗口帧（对齐 frameN/fps，契约见 §2.5）→ NV12 平面 → 合成纹理 | 无硬解机器上 HEVC 合成预览可用；p95 解码延迟入门限；**A/B 同素材同帧号取帧一致（VFR 映射对拍）** |

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `services/core/src/aivs_core/media/frame_decode.py` | PTS 最近邻映射（±33_334μs）+ ffmpeg NV12 窗口解码 + AIV1 打包 |
| `services/core/src/aivs_core/app.py` | `POST …/decode-frames`（require_ui；路径永不进响应） |
| `packages/contracts/src/performance.ts` | `DecodeFramesRequest` + 窗口上限 32 |
| `apps/desktop/src/app/preview/decode-capability.ts` | `unpackNv12Response` + `FfmpegMediaDecoder`（plane_payload + release()） |
| `apps/desktop/src/app/preview/media-decoder.ts` | 工厂输入注入 `decodeFrames` 回调 |
| Desktop Main/preload | `decode-frames` IPC（fetchBinaryWithUi → ArrayBuffer） |

## 2. 验收核对表（H3）

| # | H3 验收 | 结果 | 证据 |
|---|---|---|---|
| 1 | Core 窗口帧解码 NV12 | ✅ | `test_frame_decode_real.py`：320×180 几何/stride/平面长度 |
| 2 | VFR/帧号映射与 A 一致 | ✅ | `map_frame_numbers_to_pts` 与 A 同公式（target_us=floor 前 round）+ 同容差 33_334μs；`test_a_b_same_frame_number_same_pts` 对拍 |
| 3 | 票据/路径不下发渲染 | ✅ | 端点 require_ui + `_preview_source_asset_row`；响应仅平面字节（AIV1），无 path |
| 4 | 窗口上限 | ✅ | `MAX_DECODE_FRAMES_PER_REQUEST=32`（Core + contracts 双侧强制） |
| 5 | 后端 B 可创建并出 plane_payload | ✅ | `decode-capability.test.ts` 注入 decodeFrames 用例；`release()` 幂等 |
| 6 | p95 延迟入门限 | ⏳ **待实测** | 见 §4；单请求短命 ffmpeg（正确性优先），门限数字需在 H3 收口时用真机 scrub 场景定档 |

### 规划门 §4 对照（本门全量尚未收口）

| # | §4 | H3 状态 |
|---|---|---|
| 1 | 契约 + Core 端点含 VFR 语义 | ✅ 端点与 VFR 语义已落地；契约含请求形状 |
| 2 | HEVC 真素材可播 | 依赖 H2 demux + 本后端（端到端待 H2 合入后对拍） |
| 3 | 降级人话 | H1 已做 |
| 4 | AVC 回归 | 既有测试 |
| 5 | 合成器无 codec if/else | ✅ 工厂收口 |
| 6 | release() 生命周期 | ✅ FfmpegMediaDecoder 两分支之一；F1 对账快照待 preview-session 接线时补 |

## 3. 取帧语义（与后端 A 对齐）

```text
target_us = round(frameN / fps * 1e6)
选样：PTS 最近邻，diff > 33_334μs → DECODE_FRAME_NOT_FOUND
抽取：ffmpeg select=eq(n,index) + pix_fmt nv12（短命进程）
回填：按请求帧号（同一物理帧可服务多个请求帧号）
```

## 4. 遗留

| 项 | 归属 |
|---|---|
| p95 门限数字与真机测量 | H3 收口（P29） |
| preview-session 接线 MediaDecoderFactory + compositor plane 上传 | H2/H3 汇合（P29） |
| 能力表 Core `ffmpeg -decoders` 注入 | H3 尾（P30） |
| 长驻 decode 进程 | H4 |

## 5. 测试

- `services/core/tests/unit/test_frame_decode.py`（6）
- `services/core/tests/integration/test_frame_decode_real.py`（3，真实 ffmpeg）
- `apps/desktop/tests/decode-frames-payload.test.ts`（2）
- `apps/desktop/tests/decode-capability.test.ts` +plane_payload
- contracts + desktop typecheck 绿
