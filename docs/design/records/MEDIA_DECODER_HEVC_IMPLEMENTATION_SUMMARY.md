# HEVC 合成预览实现汇总（H1–H3，2026-09）

> **历史实施摘要。** H1、H2 与 H3 的四份逐轮实施稿合并于此。范围与验收门见[规划门](../../requirements/MEDIA_DECODER_HEVC_PLANNING_GATE_2026-09-26.md)；真机性能定档见[P29 测量记录](MEDIA_DECODER_HEVC_P29_REALMACHINE_2026-10-09.md)。当前项目状态以 [`STATUS.md`](../../STATUS.md) 为准。

## 实现链路

| 切片 | 合并后的交付结论 |
|---|---|
| H1 能力选择 | `DecodeCapabilityTable` 探测 WebCodecs 与 FFmpeg 能力；`MediaDecoderFactory` 选择 A/B；错误码透传并显示可理解的回退提示。软解是合法的 WebCodecs 路径。 |
| H2 HEVC 容器 | `bmff-demux` 支持主流 MP4 中的 `hev1` / `hvc1` 与 `hvcC`，生成 `VideoDecoder` 所需 codec string；非支持容器由 B 路径承接，色彩按登记范围处理。 |
| H3 后端 B | Core 使用 FFmpeg 按帧号窗口解码 NV12；PTS 最近邻映射容差 33,334μs、每窗最多 32 帧。Main/preload 使用受限媒体票据调用 Core，渲染进程不接收本机路径。 |
| H3 汇合 | `preview-session` 通过工厂创建 A/B 解码器；compositor 将 `VideoFrame` 与平面载荷送入统一纹理槽，并在 `finally` 收口 `release()`。FFmpeg build 能力进入 Core capabilities。 |

## 验收交叉核对

| 规划门验收 | 结果与证据 |
|---|---|
| 能力探测、后端 A/B 选择、错误码与回退提示 | H1 已实现；无可用后端时返回明确错误。 |
| HEVC `hev1` / `hvc1` + `hvcC` 解复用 | H2 已实现并覆盖非法配置与 AVC 回归；分片 MP4 不在 A 路径支持范围。 |
| 后端 B 帧窗口解码、VFR 帧号对拍、路径与票据边界 | H3 代码与测试已覆盖；Core 端点要求 UI 票据，响应只含平面载荷。 |
| 合成会话与平面上传接线、解码帧释放 | H3 收口已接线并通过对应测试。 |
| 真机 scrub 延迟与 A/B 同帧一致 | P29 三类真机素材均 A/B 对拍通过；实测 p95 分别为 720p HEVC 250ms、1080p50 H.264 313ms、3440×1440 H.264 698ms。1080p HEVC 未能直接编码取样，门限按保守外推冻结为 p95 ≤1,200ms，不能把估算称为该分辨率 HEVC 的直接实测。 |
| App 内真实 HEVC 端到端 | STATUS §4 P33 的复测记录补足；P29 收口了 P27 的真机门禁。 |

## 保留的边界

- A 路径仅覆盖登记的主流 MP4；异常容器走 B 路径，未承诺任意容器都能硬解。
- 后端 B 为离散 scrub 窗口解码，不用于持续播放帧流。
- 早期实现稿中的小夹具 2s p95 初值被 P29 的真机定档取代；PTS 冷建耗时问题后来按 STATUS §4 P69 收口。
- 各实现轮次的测试数量是历史读数，不代表当前测试规模。
