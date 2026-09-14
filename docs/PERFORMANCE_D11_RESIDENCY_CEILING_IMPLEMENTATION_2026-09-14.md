# D11 第一步(显式天花板 + R3 预警真实触发验证)实施报告(2026-09-14)

依据:`PERFORMANCE_D11_RESIDENCY_CEILING_PLANNING_GATE_2026-09-14.md`(同日
批准)。本报告覆盖 Gate 第一步(约束登记 + 预警验证);第二步(Electron
对拍 + flags 探测)独立开工,不在本报告。

## 1. 交付内容

1. **产品约束登记(Gate §5)**:实用 unique 帧上限 ≈ (Tab 可用预算 − 0.4GB)
   ÷ 631KB——16GiB 机器 ≈1.6 万帧(≈9 分钟 unique 内容@30fps)、32GiB ≈2.7 万
   (现行 IR 协议上限恰好贴合)、64GiB ≈7.1 万。主计划头部更新·十四同步。
2. **harness 预警采集点**(`performance-editor.spec.ts`,仅 harness 改动):
   ready 确认后读取 `.synthetic-metrics` 面板文本,匹配"长素材解码驻留预警"
   则进样本新字段 `residency_warning`,否则 `null`(之后 decode 失败可覆盖
   lastError 通道,null = 无预警或被覆盖,如实留样,不视为运行失败——
   响亮失败边界不变)。产品代码零改动。
3. **R3 预警真实触发验证(F02 正向 + F01 负向对照)**,见 §2。

## 2. 验证(证据 `evidence/performance/d11-residency-warn-20260914/` 与
`d11-residency-warn-f01-20260914/`)

| 轮 | 形状 | 结果 |
|---|---|---|
| F02(runs=1/seeks=1/5s,warmup-on + run-0-off/on 三次启动) | 全过 | **三次启动 `residency_warning` 全部触发**:"长素材解码驻留预警:预计常驻约 15.8 GiB(27000 帧,平台化不持续增长)";v1(off)/v2(on) 双通道一致(预警与 IR 形态无关,与 B13-R 判别一致) |
| F01(同形状) | 全过 | **三次启动均不触发**(`null`)——12s 项目 360 帧,预测 ~0.6GB 低于 high 档预算 4GiB,负向对照符合模型 |

**预测-实测校验**:F02 预测 15.8GiB vs G0 实测 Tab 工作集平台 16.6GiB,
偏差 **−4.8%**,Gate ±25% 门内——`predictResidencyBytes` 常数(600KB/帧 +
400MB base)**无需校准**,维持原样。

**机制确认**:预警在 `PreviewSession.create` 时按 IR 帧数计算(不依赖实际
解码量),冒烟形状(5s 播放)即可验证——与 Gate §2 第一步的设计预期一致。
预警经 `lastError` → `.synthetic-metrics` 面板渲染,现同时落 harness 样本
可审计。

## 3. 验证矩阵

| 项 | 判定 |
|---|---|
| 产品代码/契约/Core | **零改动**(仅 e2e spec + 文档) |
| Desktop typecheck | 通过 |
| F02 最小轮(预警触发) | **达标**(3/3 样本,v1/v2 双通道) |
| F01 冒烟(负向对照) | **达标**(3/3 不触发,常规场景零影响) |
| 预测精度 | −4.8%(门 ±25% 内),常数不动 |
| 约束登记 | Gate §5 表 + 主计划更新·十四 |

## 4. 遗留

- **第二步测量型 spike 独立开工**:bench 分支 Electron 升版对拍
  (现 36.2.1/chrome 136,对拍基线 16,649MB;判定标准 ±5%/灰色加倍/<1%
  未命中)+ Chromium flags 探测。本轮 environment 留证:electron 36.2.1、
  chrome 136.0.7103.93。
- 装配竞态现场积累:本轮 recovery 计数全 0(无新现场),继续由后续轮次
  机会性积累。

## 5. 复现命令

```bash
node tools/performance/run_editor_benchmark.mjs --scenarios F02 \
  --fixtures evidence/performance/g0-fixtures-20260911 \
  --output evidence/performance/<new-dir> --runs 1 --seeks 1 \
  --playback-seconds 5 --seed 20260914
python -c "import json; d=json.load(open('<dir>/results-F02.json')); \
  print([s.get('residency_warning') for s in d])"
```
