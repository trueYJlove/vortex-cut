# Stage 4A 隔离原型验证记录

> 日期：2026-08-18
> 模式：`simulation_only`
> Provider 调用：`0`
> 性质：开发侧原型证据；LiuKeAi 独立验收已通过

## 1. 验证对象

- `tools/prototypes/stage4a_generation_model.py`
- `services/core/tests/prototype/test_stage4a_generation_model.py`

该记录最初用于 Gate 4A-2；生产 v11 落地后，原型工具已调整为在临时数据库中复用 `Database.initialize()` 验证正式 v11，不再重复追加 `v11-prototype`。工具不接触用户数据库、不调用 Core 路由或真实 Provider。

## 2. 执行结果

- Ruff：通过；
- 隔离 pytest：`1 passed`；
- 结构校验：14/14 预定义样例匹配；
- false accept：0；false reject：0；
- v1–v10 migration checksum：10/10 保持一致；
- 正式 v11：两张必需表及必要索引存在，Request UPDATE/DELETE 均被不可变触发器拒绝；
- 生命周期：Request 幂等复用、running→interrupted、retry attempt=2、父子 lineage、新 Job、非终态与重复 retry 拒绝全部通过；
- Provider invocation 计数：0；
- 安全：Prompt sentinel、secret sentinel、工作目录绝对路径均未出现在 SQLite dump，携带 secret 的输入被拒绝。

## 3. 性能结果

200 次本机隔离模拟：

| 操作 | p50 | p95 | 门槛 |
|---|---:|---:|---:|
| prepare | 0.093 ms | 0.190 ms | p95 ≤ 300 ms |
| create | 12.150 ms | 18.060 ms | p95 ≤ 300 ms |

该结果只说明本机 Python/SQLite 原型的结构处理和写入开销，不是生产 SLA，也不包含网络、模型推理、媒体编码或 UI 开销。

## 4. “准确率”含义

报告中的 100% 仅表示 14 个预定义结构化输入样例的预期接受/拒绝结果全部匹配，覆盖合法 image/TTS、非法 kind、空 Prompt、非法/重复引用、尺寸/类型边界、敏感键、TTS 语言/语速/voice ID 等。

它不是模型精度，不证明图片视觉质量、Prompt 遵循度、TTS 音质、发音或语义准确性。

## 5. 未验证项

以下全部为 `UNVERIFIED`：

- 真实图片生成质量；
- 真实 TTS 音质与语义准确性；
- 真实 Provider 的时延、费用、限流和错误适配；
- 视频生成；
- Windows 打包后的正式业务交互；
- Renderer 正式 UI、Windows 打包后的 Stage 4A 正式业务交互。

## 6. 开发侧结论

Gate 4A-2 的隔离原型门槛已满足，Gate 4A-3 独立复核已通过。生产骨架随后经明确授权进入 Gate 4A-4；本记录仍不得用于宣称真实生成能力或授权 Provider 调用。
