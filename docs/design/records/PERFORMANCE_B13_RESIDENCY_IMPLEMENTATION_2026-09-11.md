# B13-R(解码驻留上限)实施报告(2026-09-11)

依据:`PERFORMANCE_B13_RESIDENCY_PLANNING_GATE_2026-09-11.md`(同日批准)。
提交:`9d9cad4`(R1 遥测 + catch-close)+ 本报告提交(判别开关 + R3 护栏 + 文档)。

## 0. 结论速览(判别实验推翻了开工假设)

**F02 的 16.6GiB Tab 常驻不是泄漏,是 Chromium 层有界池的高水位**:随
**unique 源帧解码数**饱和增长,平台 ≈ base(~0.4GiB)+ uniqueFrames × ~600KB,
与以下全部应用层变量**无关**(曲线逐点重合):

| 判别轴 | 对照组 | 结果 |
|---|---|---|
| 上传路径 | direct texImage2D vs copyTo 强制回退 | 曲线重合(120s 组,d02 vs d01) |
| 解码后端 | HW(D3D11)vs 强制 SW(内置软解) | 曲线重合(180s 组,SW 平台 16.66GiB vs HW 16.6GiB) |
| IR 形态 | v1 全量表 vs C20 v2 窗口 | 重合(G0/2400s 长测既有数据) |
| JS 帧生命周期 | — | framesLive=0(framesIn==framesClosed),无泄漏 |

场景拟合:F01 331MB(360 帧)、F02 16.7GiB(27000 帧)、F03 2.6GiB(~4000 帧)
均吻合 ~600KB/帧 + base;F05 4K60(510MB)**不符合**该律——大帧 SW 解码 DPB
有界,已在预测器中封顶处理。

**含义**:R2(按判别修复)无可修对象——三个候选(direct 路径表面滞留、
驱动 staging、JS 在途帧)全部被数据排除;16.6GiB 平台在 2400s 长测中已确认
无晚发增长(G0 补充证据)。按 Gate §2 预案,本轮落地形态 = R1 遥测 + R3
护栏,如实登记"应用 JS 层不可修",候选 Chromium 上游方向(未立项)。

## 1. R1:驻留遥测(已交付)

- **compositor worker**(`compositor-worker.worker.ts`):`framesIn/framesClosed/
  framesLive/uploadsOk/uploadsErr/closedOnErr/uploadMode/textureBytes` 计数,
  随 `uploaded/uploadError` ack 捎带 + `residencyQuery` 主动查询。
- **decode worker**(`decode-worker.worker.ts`):`decoded/posted/cached/closed/live/
  cacheBytes/cacheSize` 计数,`stats` 往返取回(客户端单飞行 + 5s 超时;
  此前 `stats` 消息已定义但从未被客户端使用)。
- **聚合**(`perf-metrics.ts`/`preview-session.ts`):`ResidencySnapshot` 随
  `__editorPerf.snapshot()` 输出;播放 tick 1Hz 取样;`residency` 事件时间线
  (1Hz 限流)进 events。
- **附带修复**:`uploadToTextures` catch 分支补 `frame.close()`(错误路径泄漏,
  fixed);`unsupported format` 分支去重复 close;direct 模式 `textureBytesOf`
  记账口径问题已在 Gate §2 登记,随 Chromium 层归因一并挂起(不产生实测差异)。

## 2. 判别实验(证据:`evidence/performance/b13r-d0{1,2,4}-*`)

- **d01/d02(direct vs copyTo,F02 120s)**:两轮 Tab WS 终值 1269/1266MB,
  增量曲线重合;`uploadMode` 遥测确认开关生效(copyTo-fixed 轮报 `copyTo`)。
  过程发现并修复一处穿链缺口(v1 路径 `PreviewSession.create` 调用点漏穿
  `forceCopyTo`,d01 的 copyTo 轮实际仍走 direct——修复后 d02 复跑确认)。
- **d04(强制 SW,F02 180s)**:`VITE_AIVS_FORCE_SW_DECODE=1` 构建期注入,
  App bundle 确认 `forceSwDecode=true` 编译在内;Tab WS 平台 16.66GiB
  (5415 decode,150s 达平台),与 HW 基线(retry-01,300s,7900 decode)
  完全一致。首轮 300s 尝试 run-0-on 失败一次(错误未持久化,清洁 shutdown,
  180s 重试通过)。
- **300s/2400s 轨迹再分析**(retry-01 + G0 memlong):增长段 ~150s,此后
  平台波动 <20MB/35min;饱和曲线非线性泄漏——推翻 Planning Gate §1 的
  "1.78MB/decode 线性外推"假设(该斜率实为高水位逼近段的割线斜率)。

## 3. R3:驻留护栏(按 Gate §2 预案的驱动侧变体)

`resource-budget.ts` 新增 `predictResidencyBytes(uniqueFrames, w, h)`:锚定
640×360 实测 ~600KB/帧线性 + 0.4GiB base;≥4× 锚定尺寸(≈1080p+)不外推
(F05 反例),给常数档。`preview-session.ts` 会话创建时按 `frameCount` 预测,
超档位预算 8× 纹理值时一次性 `lastError` 提示(量级预期,不阻断——无分配
可挡,与 Gate §2 R3"无分配可挡只能限速/告警"条款一致)。单测 3 项
(F02/F01 复现口径 + F05 反例封顶)。

## 4. 验证

- Desktop typecheck/lint 通过;单测 **69 文件 619 项全过**(616+3 新增);
  2 个 unhandled rejection 经 `git stash` 对照确认为 **HEAD 既有问题**
  (input-pool-protocol 测试 ack promise 在 terminate 后 reject 无人消费),
  非本轮引入,登记待修。
- 生产构建已恢复(无 perf/判别 env 注入,flag 均编译为 undefined 路径)。
- 行为正确性:d01–d04 四轮 e2e 全程 compose/decode/seek 事件正常,
  smoke 5/5(含一次 300s 失败重试)。

## 5. 验收对照(Gate §3)

| 项 | 判定 |
|---|---|
| 判别报告 | **达标**——三轴对照 + 场景拟合,证据链闭合 |
| 修复后斜率 | **不适用→如实改判**:无应用层可修对象;平台曲线本身达标(末 60s ≤0.42MB/s ≤ 10MiB/min) |
| 行为正确性 | **达标**(619 单测/e2e 冒烟) |
| R3 | **达标(变体)**——预测器+预警落地,单测覆盖 |
| 不掩盖 | **达标**——Gate §1 线性假设被自家数据推翻,如实改写;C20 报告 §6.1 "trace 留证"表述同步勘误 |

## 6. 遗留与登记

1. **Chromium 上游方向**(未立项):decoded-frame 缓冲在 transfer+close 消费
   模式下的进程内保留(HW/SW 同型)——如需真正压平 F02 平台,方向是代理降档
   (B11,帧字节 4× 减小不改变结构)或 Chromium 层行为变更/升级验证。
2. **input-pool-protocol 测试 2 个 unhandled rejection**(HEAD 既有):ack
   promise terminate 后 reject 未消费;下轮顺手修。
3. **direct 模式纹理记账口径**(Gate §2 R2-2):随上游方向挂起。
4. **C20 调优清单**(seek 预取/ready 并行化)不变,与本轮无关。

## 7. 主计划同步

头部"下一工作包"更新:B13/B11 解码驻留上限 → **判别完成,应用层无泄漏,
护栏落地**;B13 独立验收建议与本报告一并提交评审(代码完成 + 判别证据 +
护栏,状态从"待验收"推进"验收材料齐备")。
