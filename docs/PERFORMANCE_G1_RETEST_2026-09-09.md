# G1 第一轮退出条件复测报告（2026-09-09）

## 1. 状态与范围

**G1 功能复测通过（开发者自测口径）；独立验收仍为"待验收"。**

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 5 节 G1 退出条件，
在 A08（`059a77c`）之上执行复测。本次复测**发现并修复一处 A05a 引入的
生产路径 NameError 回归**（见第 4 节），修复后全部复测项通过。

- 复测范围：A01–A08 功能断言（全量测试套件）、F01 短项目完整 App 回归
  （B00 诊断入口）、F02 IR 同机基准复测、探针隔离恢复验证。
- 未执行：F03–F07 场景（B00 完整场景仍未实现——见 B00 报告剩余清单）；
  正式 5 次重复采样、5 分钟播放长测、探针开销 <3% 成对统计（属 B00-B
  性能验证阶段，非 G1 功能门槛）。
- 单一执行者自检，不冒充独立 Gate 审查（AGENTS.md 角色规则不变）。

## 2. G1 退出条件逐项核对

计划原文：A01–A08 对应功能断言全部通过，F01 无新增花屏/音频回归，
F02 IR 达到同机目标或有批准的例外；F03 音频/视频仍全源读取的限制明确记录。

| 退出条件 | 结果 | 证据 |
|---|---|---|
| A01–A08 功能断言全部通过 | ✅ | Desktop 56 文件 / 467 项全绿；Core 489 项全绿（含本次新增 3 项） |
| F01 完整 App 回归 | ✅ | 1 用例通过（3.1 分钟：预热 + off/on 各一轮，100 seek + 30s 播放，零 fallback 恢复）；诊断构建提交延迟 playback submitted p95 = 10.2ms |
| F02 IR 同机目标（≤350ms） | ✅ | 900 段/900 字幕：**2701ms → 173ms**（-93.6%）；4 案例 JSON 字节与历史基线逐字节一致（输出等价） |
| F03 全源读取限制记录 | ✅ | 见第 6 节已知限制（B12 Range demux 前不承诺长源有界读取） |
| 探针隔离恢复 | ✅ | 恢复普通生产构建后 `verify:probe-isolation` PASS（renderer/preload/main 三层零探针符号） |

### F02 复测明细（同机：i7-1165G7 / Python 3.13.1 / 3 次重复取中位）

| 案例 | 历史基线投影中位 | 本次复测投影中位 | JSON 字节 |
|---|---:|---:|---:|
| 60s / 1 seg | 10.0ms | 9.7ms | 470129（一致） |
| 900s / 1 seg | 154.0ms | 165.3ms | 7154535（一致） |
| 300s / 300 seg / 300 cap | 344.2ms | 64.8ms | 2555337（一致） |
| 900s / 900 seg / 900 cap | 2701.4ms | **173.3ms** | 7704738（一致） |

说明：900s/1seg（纯 27000 帧、无区间查找负载）的 154→165ms 在同机
噪声范围内（该案例成本由帧数本身决定，A04 扫线不针对它优化）；两个
密集段案例分别提速 5.3×/15.6×。工具迁移：`tools/performance/benchmark_ir.py`
（带显式 `--output`，拒绝覆盖既有输出；历史 `evidence/performance-2026-09-08/`
证据未动）。执行命令：
`python tools/performance/benchmark_ir.py --output evidence/performance/g1-20260909/ir-benchmark.json`

### F01 冒烟摘要（run-0，诊断开启组）

- ready_ms 2429(off)/2532(on)（vs B00 时期 4461/4335ms——非同构建同条件，仅供参考不作为改善证据）
- 100 次 UI seek → 194 内部 seek 事件；seek 窗口 decode p95 44.9ms / submitted p95 6.1ms
- 30s 播放 900 compose / 900 submitted；playback submitted p50 3.8ms / p95 10.2ms / max 19.3ms
- setup_recovery_count = 0（三轮启动全部干净冷启动，无票据竞态触发）
- 提交延迟是 Worker 往返（非 GPU presentation）——口径与 B00 相同，不冒充呈现指标

## 3. 复测执行命令

```powershell
pnpm test                              # Desktop 56 文件 467 项
pnpm typecheck && pnpm lint            # 均通过
.venv\Scripts\python.exe -m pytest services/core/tests/unit -m 'not real_provider' -q
                                       # 489 项（含新增 test_projects_sync_paths 3 项）
.venv\Scripts\python.exe tools\performance\benchmark_ir.py --output evidence\performance\g1-20260909\ir-benchmark.json
# VITE_AIVS_PERF=1 诊断构建后：
node tools\performance\run_editor_benchmark.mjs --fixtures evidence\performance\b00-fixtures-20260908 --output evidence\performance\g1-20260909\f01-smoke-2 --runs 1 --seeks 100 --playback-seconds 30
# 复测后恢复普通构建：
pnpm --filter @aivideo/desktop build && pnpm --filter @aivideo/desktop verify:probe-isolation
```

证据目录：`evidence/performance/g1-20260909/`（ir-benchmark.json、f01-smoke-2/
含 results.json / run-config.json / 每轮 user-data 与 core.json 诊断快照）。

## 4. 复测发现并修复的回归（A05a 遗留缺陷）

**现象**：F01 完整 App 冒烟首轮失败——`preview-ir:get` 返回 Core
`INTERNAL_ERROR`，合成预览回退交互预览。Core stderr：`NameError: name
'sha256_file' is not defined`（rendering/service.py:484 →
projects.resolve_asset_path）。

**根因**：A05a（`326735c`）把 import/refresh/relocate 三个 async 入口的
哈希改走后台线程池时，从 `projects.py` 的 import 行删除了 `sha256_file`，
但 `resolve_asset_path`（484 行）和 `current_source`（450 行）两个**同步**
调用点仍在使用该名字（当时注明"保留同步哈希"）。Core 单测原有用例只
覆盖域错误早退分支（ASSET_MISSING/ASSET_CHANGED 在哈希行之前抛出），
从未以正确指纹走完整路径，故 486 项全绿未暴露；只有真实 App 的
preview-ir:get → resolve_asset_path 路径才触发。该缺陷自 2026-09-09
A05a 合入起存在于所有提交（A05b–A08 的 Core pytest 均因同一盲区未发现），
B00 完整 App 冒烟在 A05a 之后首次复跑即捕获——这正是 G1 复测的价值。

**修复**：`services/core/src/aivs_core/projects.py` import 行恢复
`sha256_file`（单行变更）。

**防再犯**：新增 `services/core/tests/unit/test_projects_sync_paths.py`
（3 项）：真实文件 + 正确指纹走 resolve_asset_path / current_source 完整
成功路径 + 文件变化 ASSET_CHANGED 路径（同步更新 stat 避开早退分支，
强制走到指纹比较行）。已验证：临时还原缺陷时 3 项全红，修复后全绿。

**附带修复**：A07 的 `cached_probe` 在 ffprobe 可执行文件缺失的测试配置
下会在 `ffprobe_build()` 里直接 spawn 失败（WinError 2）——
`test_stage1c_timeline_api.py::test_internal_asset_resolve_is_admin_only_and_persistent`
因此失败。该失败在 A07 合入时被归入"23 失败与干净基线 diff 为空"的
预存在环境问题清单而漏检。本次将该 monkeypatch 点适配（fake_probe 换成
fake ffprobe_build 语义）随同验证。**该项属预存环境适配，未改生产代码。**

## 5. 结论与 Gate 决定

- **G1（功能复测口径）通过**：A01–A08 功能断言齐全、F01 无新增回归、
  F02 达同机目标且输出逐字节等价、F03 限制已记录。
- 独立 Reviewer 结论：**待验收**（单执行者自检不替代 LiuKeAi 独立复核）。
- 下一步：进入第二轮 **B10（派生媒体缓存与契约）**——按计划第 6.1 节
  跨进程契约规则推进（contracts/performance.ts → Core app+服务 →
  main IPC → preload 白名单 → core-client 五层贯穿 + 四层测试）。
- B00-B 正式性能验证（5 次重复采样、探针开销成对统计、F02–F07 完整场景）
  继续挂账：不阻塞 B10 编码，但 B13/B15 验收前必须补齐。

## 6. 已知限制（沿计划口径）

- F03（60 分钟源）音频/视频仍全源读取：B12 Range demux 与 B15 分块 PCM
  完成前，不承诺长源内存有界。
- F01 冒烟为 1 轮 off/on 对照（探索性），不足以宣称探针开销 <3% 或任何
  性能改善百分比；submitted 延迟非 GPU presentation。
- `compose` 事件时长恒 0（主线程记录点性质），实际 GL 成本看 submitted。
- 900s/1seg 案例同比 154→165ms：同机噪声范围内的持平，非回归信号
  （无区间查找负载的纯帧数瓶颈案例）。

## 7. 修改文件清单

```text
services/core/src/aivs_core/projects.py          # 恢复 sha256_file import（A05a 回归修复）
services/core/tests/unit/test_projects_sync_paths.py  # 新增：同步路径真实文件回归 3 项
tools/performance/benchmark_ir.py                # 新增：IR 基准迁移版（显式 --output）
evidence/performance/g1-20260909/                # 复测证据（IR 基准 + F01 冒烟两轮）
docs/PERFORMANCE_G1_RETEST_2026-09-09.md         # 本报告
```
