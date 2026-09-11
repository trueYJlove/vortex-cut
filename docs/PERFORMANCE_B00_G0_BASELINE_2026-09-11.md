# B00 G0 基线采样报告(2026-09-11)

## 1. 状态与范围

**B00 正式 G0 采样轮完成:七场景全量(5 轮 × off/on × 100 seek × 300s 播放)。**
样本形状达到计划第 4 节口径,`run-config.baseline_status = "B00-G0-baseline-sample"`。
独立验收:**待验收**——本报告是开发者自测级基线数据,不构成 G0 Gate 批准;
探针开销 A/B 与独立评审仍未执行(见第 7 节)。

- 证据目录:`evidence/performance/g0-baseline-20260911-v2/`
  (结构:`<Fxx>/warmup-on|run-N-on|run-N-off/{result.json, editor.png, user-data}`,
  汇总 `results-<Fxx>.json`,每轮导出产物在 `exports/`)。
- 首轮尝试 `g0-baseline-20260911/`:F01 五轮有效,F02–F07 因 harness 装配
  缺陷失败(见第 5 节,先证后修);该目录保留作为缺陷证据。
- 汇总工具:`tools/performance/summarize_results.py`(本轮新增)。

## 2. 采样口径与环境指纹(冻结)

| 项 | 值 |
|---|---|
| commit / 代码指纹 | `5583ec6` / `736802ad77f749f4…`(含未提交 harness 改动,见第 5 节) |
| 场景 | F01,F02,F03,F04,F05,F06,F07(每场景 1 warmup + 5 × off/on 对) |
| seek 负载 | 每轮 100 次,seed 20260908,固定 300ms 间隔 |
| 播放负载 | 每轮 300s(warmup 5s);播放循环每秒采一次进程指标 |
| 构建模式 | production-diagnostics(VITE_AIVS_PERF=1) |
| CPU / RAM | i7-1165G7 @ 2.80GHz,8 逻辑核,32GiB |
| GPU / 驱动 | Intel Iris Xe (0x9a49),驱动 31.0.101.3222;60Hz,1440x816 @ dpr1.25 |
| OS / Electron | Windows 10.0.26200 x64 |
| 夹具 | `g0-fixtures-20260911/`,schema_version 2,seed 20260908;F01/F03/F05 复用冒烟期生成文件(SHA 一致),F02/F04/F07 本轮生成 |

G0 冻结的是本机代表门槛;跨机器结果不直接做百分比对比(计划第 4 节)。

## 3. 逐场景中位数结果(5 轮 on)

完整逐轮表见 `summarize_results.py --results evidence/performance/g0-baseline-20260911-v2` 输出。中位数速览:

| 场景 | ready_ms | seek p95 (ms) | decode p95 (ms) | upload p95 (ms) | submitted p95 seek/playback (ms) | decode/s | Tab/GPU 峰值 WS (MB) |
|---|---:|---:|---:|---:|---:|---:|---|
| F01 基础 CFR | 2386 | 29.2 | 28.2 | 1.3 | 3.8 / 3.0 | 29.5 | 331 / 340 |
| F02 900段+900字幕 | 5780 | 38.2 | 37.3 | 1.2 | 5.7 / 5.5 | 26.2 | **16697** / 385 |
| F03 60min 深定位 | 6306 | 30.8 | 29.8 | 1.3 | 3.7 / n/a* | (595)† | 2613 / 340 |
| F04 48素材4层 | 23524 | 44.4 | 47.0 | 14.9 | 20.5 / 16.1 | 2.7 | 993 / 1366 |
| F05 4K60 | 2695 | (219.8)‡ | 411.3 | 5.9 | 4.6 / 3.1 | 29.5 | 510 / 1546 |
| F06 播放+导出 | 2344 | 29.5 | 28.7 | 1.4 | 3.6 / 3.0 | 29.5 | 331 / 339 |
| F07 速度矩阵 | 2565 | 28.4 | 27.6 | 1.3 | 4.5 / 3.2 | 30.0 | 364 / 367 |

\* F03 播放段 submitted p95 缺失:合成帧提交计数正常(1469/300s),但事件窗口
(4096 环形缓冲,overwritten=0)被 decode/upload 淹没——121.9 个 decode 事件对应
1 个 compose。30s 时间轴在 300s 内循环 10 次,每帧重新解码(B12 Range 命中后
decode 仍逐帧记录),事件产出速率 >> compose。播放段 compose/submitted 拟合
p95 属窗口截断问题,登记为 unavailable,后续轮次可加大环形缓冲或拆分窗口。
† F03 decode/s ≈ 595 是 10 倍循环 + 每帧重复解码的产物,不是真实吞吐;口径
解读为"深 seek 场景逐帧解码成本由 Range 供给兜住,但未做帧复用"。
‡ F05 seek p95 是部分样本(96/100 有事件),且 4K60 seek 路径有已登记缺陷(4b)。

轮内稳定性:各场景逐轮 p95 波动普遍 <±10%(F04 upload 12.1–16.8ms 最大),
无离群轮,5 轮采样有效。

## 4. 门口径对照(计划拟定目标,最终以冻结值为准)

1. **F06 竞争门(p95 提交延迟增幅 ≤20%)**:**通过**。F06 vs F01 同机同负载:
   playback submitted p95 中位 3.0ms vs 3.0ms(**+0.0%**),seek p95 +1.0%。
   10/10 轮(含 off 轮)导出任务全部 `succeeded`,产物 10.0MB × 11 文件。
   run4-on 出现单次 +48.4% 离散(4.6ms),中位数不受影响;正式量化时以
   轮分布报告,不以单轮断言。
2. **探针开销(中位 <3%)**:off/on 对 seek 动作墙钟中位逐场景差 ≤0.1%
   (342–358ms,由固定 300ms 负载间隔主导);off 轮事件恒为空、计数为零,
   on 轮缓冲无覆盖(overwritten=0)。**探针开销达标,详细 per-phase A/B
   (off 下同负载 CPU/内存差)待独立评审轮补齐。**
3. **F02 密集 IR(投影 ≤350ms 目标待 G0 冻结)**:完整 App 下 seek/decode
   p95 ≈ 37ms,播放 26.2 decode/s、5.5ms submitted;**但 Tab 进程工作集
   峰值 16.7GiB**(853MB → 16.7GB 在播放前 30s 内增长,随后平台化)。
   900 段 27000 帧上限口径下这是首要内存事实,直接支撑 C20 Renderer v2
   数据面与 B13 显存/负载降级的优先级决策。
4. **F04 多层**:ready 23.5s(48 素材导入+装配,非预览指标);播放 decode/s
   仅 2.7、submitted p95 16.1ms——4 层同时活跃下合成提交是明确瓶颈,
   GPU 进程 1.37GiB。与 C20/B17 的目标场景吻合。
5. **F05 4K60**:播放 pump 正常(29.5 decode/s,submitted p95 3.1ms),
   decode p95 411ms / seek p95 220ms 仅部分 seek 产生事件(96±5/100)。

## 5. 本轮 harness 修复(多场景一次调用 runDir 冲突)

- **发现**:首轮 `g0-baseline-20260911` F01 通过后,F02–F07 全部在
  `expectCurrentProject` 失败,各自看到**前一个场景**的项目名
  (F02 看到 "B00 F01",F04 看到 "B00 F02",链式错位)。
- **根因**:spec 的运行目录不含场景名(`output/warmup-on` 等)。冒烟期每
  场景独立 output 无冲突;多场景单次调用时,F02 的 warmup 应用复用 F01 的
  `warmup-on/user-data` Core 数据库,App 启动轮询取 `listProjects()[0]`
  (最早创建的 "B00 F01")为当前项目,与断言 "B00 F02" 永不相等。
  冒烟未暴露是因为单场景调用目录隔离。
- **修复**(`performance-editor.spec.ts`):runDir 加场景层
  `output/<Fxx>/<run>-<on|off>`,目录隔离即项目隔离;F06 导出文件名相应带
  场景前缀(`export-<Fxx>-<run>-<on|off>.mp4`)。F01+F02 双场景 smoke 复验
  (`g0-rundir-check/`)通过后重跑全量。
- **证据**:首轮失败目录保留(`g0-baseline-20260911/`,F01 数据有效);
  修复后 v2 七场景 7/7 通过,6.8h。

## 6. 数据面速记(驱动 C20/C20c 决策的事实)

1. F02 16.7GiB Tab 工作集(27000 帧 IR 全量驻留)——C20 窗口/增量 IR v2 的
   直接动机;B13 显存预算护栏(F05 GPU 1.5GiB / F04 1.37GiB 次之)。
2. F04 合成提交 16.1ms p95 + 2.7 decode/s——多层合成的 per-frame 成本,
   C20c(PiP 链优化)与 B17 分层可见区应以此场景验收。
3. F03 播放段 decode:compose = 121.9:1——Range 供给下逐帧重解码,
   帧复用/解码去重(C20 数据面)在深定位场景收益最大。
4. F05 4K60 seek 0 事件缺陷(DEFECT-4K60-SEEK)在 5 轮 ×100 seek 下稳定
   复现为"部分样本 86–96/100 有事件、decode/upload 计数不齐",与冒烟期
   "全 0"观察不完全一致——缺陷表现分级,产品工作单应更新描述。

## 7. 剩余项(不因本报告关闭)

- **独立评审(G0 Gate)**:本报告数据待 LiuKeAi 复核后才可声明 G0 达成。
- **探针开销详细 A/B**:off 态 CPU/内存与 on 态同负载对照(现仅墙钟与
  事件计数口径)。
- **30–60 分钟内存长测**:计划 F06 口径,本轮播放 300s;F02 平台化在
  300s 内已可见,长测可确认无晚发增长。
- **F04 升回 100 素材**(list_assets 分页产品修复)、**F07 双位置混音**
  (跨轨重叠产品缺陷)按 B00-B 报告登记维持。
- **compare_results.py 场景间对拍**已支持 `--scenario <Fxx>`(本轮补齐,
  ruff 通过);基线→候选实际对拍在评审轮执行。

## 8. 复现命令

```powershell
# 夹具(F01/F03/F05 已存在于 b00b-fixtures-*,合并脚本见报告;新目录需重新生成)
.\.venv\Scripts\python.exe tools/performance/make_fixtures.py --scenarios F02,F04,F07 --output evidence/performance/g0-fixtures-20260911 --seed 20260908 --allow-large
# 诊断构建
$env:VITE_AIVS_PERF='1'; pnpm --filter @aivideo/desktop build; Remove-Item Env:VITE_AIVS_PERF
# G0 采样(约 6.8h,输出目录必须不存在)
node tools/performance/run_editor_benchmark.mjs --scenarios F01,F02,F03,F04,F05,F06,F07 --fixtures evidence/performance/g0-fixtures-20260911 --output evidence/performance/<new-dir> --runs 5 --seeks 100 --playback-seconds 300 --seed 20260908
# 汇总
.\.venv\Scripts\python.exe tools/performance/summarize_results.py --results evidence/performance/<new-dir>
```
