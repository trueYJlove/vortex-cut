# F03 导出深定位收益实测报告(2026-09-10)

## 1. 状态与结论

**C21 深定位性能门首次实测:同机对拍,编码阶段耗时显著下降,正确性
门(帧序列逐位一致)在两档源上均保持。** 独立验收:**待验收**。

| 源规模 | tail 段 | legacy encode 中位 | 深定位 encode 中位 | 编码耗时降幅 |
|---|---|---:|---:|---:|
| 60s(GOP=60) | [50s,60s)→10s | 495.9ms | 351.0ms | **29.2%** |
| 300s(GOP=60) | [250s,300s)→50s | 2083.3ms | 1435.9ms | **31.1%** |

- 正确性前置:每轮实测前先跑 legacy/深定位双图,输出帧序列
  (rawvideo rgb24 压平)SHA256 逐位一致,不一致直接拒绝记录
  (`parity_frame_digest_equal: true`)。
- 校验解码阶段(validate_decode)两图持平(±2%,与预期一致——产物
  相同,解码成本不随输入定位方式变化)。
- 计划门槛是"源解码量减少 ≥80%",本实测口径是**端到端编码阶段
  wall time**——深定位跳过 [0,250s) 的解码供给,但合成/缩放/编码
  仍占大头,wall time 降幅(31%)与"解码量下降"是两个量纲;帧计数
  口径的验证留待 `-benchmark`/trace 支持时补充(见局限)。方向与
  幅度为同机真实 FFmpeg 实测,非估算。

## 2. 场景与口径

- 工具:`tools/performance/benchmark_input_seek.py`(本轮新增)。
- 场景:F03 语义(深源只用尾部段)。受机器预算约束,源取 60s/300s
  合成片(GOP=60,与 F03 长 GOP 语义一致),tail/源比 1/6 与 F03
  (600s/3600s)相同——深定位收益取决于 seek 深度比与 GOP 结构,
  非绝对时长;60 分钟源实测列完整 F 夹具轮。
- 对照:`input_windows=None`(legacy 图)vs `plan_input_windows`
  (深定位图),同机交替各 5 轮,取中位数;直接 FFmpeg 调用,不涉及
  probe 缓存(排除 A07 缓存命中混入收益)。
- 编码器 libopenh264(软件);硬件编码矩阵待测。
- 状态:`developer-measurement-not-G0`;证据含 commit 快照
  (`cfe41b6`)、平台/处理器指纹、每轮原始数据。

## 3. 证据

```
evidence/performance/f03-deep-20260910/
  f03-input-seek-60s.json    # 60s 源 5 轮(环境/每轮/中位数/降幅)
  f03-input-seek-300s.json   # 300s 源 5 轮
```

复现:

```powershell
.\.venv\Scripts\python.exe tools/performance/benchmark_input_seek.py `
  --output evidence/performance/<new-dir>/f03-input-seek-60s.json --rounds 5
.\.venv\Scripts\python.exe tools/performance/benchmark_input_seek.py `
  --output evidence/performance/<new-dir>/f03-input-seek-300s.json `
  --rounds 5 --source-seconds 300 --tail-seconds 50
```

## 4. 与实施计划的偏差 / 局限

- 计划 C21b-3"比较解码源帧数量/编码阶段耗时"——帧数量未直接计数
  (需要 `-benchmark`/pkt 计数支持);本轮以端到端编码 wall time +
  正确性对拍为准,口径已在 JSON `caveats` 声明。帧计数口径列为
  完整 F 轮增强项。
- 完整 App(桌面端到端导出)与 60 分钟源、硬件编码器矩阵、深定位
  对导出总耗时(含转码滤镜)的分阶段收益分解——列 F 场景夹具轮
  (B00 完整 App 工具链当前仅支持 F01 场景)。
- 首轮运行(60s)曾出现 encode 中位 550→437ms(20.7%)的早期结果;
  参数化重构后复测为 29.2%——证据文件只保留复测版(旧文件已删,
  未提交),避免双口径混淆。

## 5. 下一步

- F 完整夹具轮:F01 完整 App 回归(短项目不回退)+ F03 60 分钟源
  + F02 IR 投影复核(A04 目标 ≤350ms 已在 G1 轮证据中达标)。
- C23(分块倒放)/C24(GPU 滤镜)按实验条件评估是否投入。
