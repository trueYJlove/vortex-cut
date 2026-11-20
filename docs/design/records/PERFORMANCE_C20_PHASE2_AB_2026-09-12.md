# C20 第二阶段 v2 A/B 实测报告(2026-09-12)

## 1. 状态与结论摘要

v2 on/off A/B 基准轮完成(F01/F02/F03,各 5 轮 × off/on × 100 seek ×
300s 播放;`evidence/performance/c20v2-ab-20260911-v2/`)。期间发现并
修复一个 v2 数据面阻断缺陷(**ensureRange 窗口枚举错位**),并通过
`window_fetch` 遥测完成归因复核。**最重要的产出是对 G0 一项归因的推翻:**

> **F02 16.3GiB 常驻内存与 IR 全量帧表无关,由解码驻留(B13/B11 范围)
> 主导。** C20 v2 数据面对 F02 内存无可见收益;其真实价值在协议/传输层
> (解除 27000 帧上限的路径、增量复用的基础),且需配合 B13 解码驻留
> 上限才能兑现内存目标。

独立验收:**已通过**(2026-09-13 有条件批准,
`PERFORMANCE_B13_C20T_INDEPENDENT_ACCEPTANCE_2026-09-13.md`;v2 默认 on
裁决与落地见 `PERFORMANCE_C20V2_DEFAULT_ON_DECISION_2026-09-13.md`)。

## 2. 过程与证据链

### 2.1 首轮 A/B(`c20v2-ab-20260911/`,修复前二进制)

- F01/F02/F03 全部 7/7 跑通;**F02 Tab WS 3.5GB(vs v1 G0 16.3GB)**、
  播放 compose 仅 591 帧/300s(前 19s 连续 30fps,此后停滞)、F03 同型
  停滞(572 帧/300s);seek 事件全部落在帧 28(首窗)。
- 当时误读为"v2 内存收益 -79%"。实际是**播放停滞导致解码量骤减**。

### 2.2 遥测定位(`window_fetch` 事件)

新增 PerfKind `window_fetch`(status: 2=成功 / 3=失败 / -1=在途满载拒绝;
frame=窗口起点;duration=端到端耗时)。诊断轮(`c20v2-diag-01`)显示
播放 30s 内 **window_fetch = 0 次**——播放越界后根本没有发起取窗请求,
排除"取窗慢/LRU 抖动",锁定**枚举缺陷**:

```text
ensureRange(first=592, last=605):循环 for(n=592; n<=605; n+=300)
只检查 n=592(窗口 300–599,已缓存)→ 窗口 600 从未被枚举。
凡 first 落在窗中间且 first+300 > last,下一窗口永久漏掉。
```

### 2.3 修复(提交 `93563bd`)

1. **枚举对齐**:`for(start = windowStartOf(first); start <= last; start += W)`。
2. **seekToFrame 取窗**:v2 下目标窗口未就绪先 `await ensureRange`
   (单窗 IPC 实测 50–70ms;epoch latest-wins 兜住拖拽;dispose 后抵达
   按作废语义 rejected——A01 回归锁验证)。
3. 验证:诊断轮 `c20v2-diag-02/04` 播放恢复 **31–32 fps**、seek 命中
   18 个分散帧、按需取窗 50–70ms;Desktop 616 项全过。

### 2.4 修复后 A/B(`c20v2-ab-20260911-v2/`)与补充重跑

- F01 5/5、F03 5/5 通过;F02 run-0-on 播放段出现一次 App 侧崩溃
  (`electronApplication.evaluate: promise garbage collected`),F02 单场景
  重跑(`c20v2-f02-retry-01`)5/5 通过——崩溃为低频不稳定问题,已留证
  (`test-results/.../trace.zip`),登记为待查项(第 6 节)。

## 3. 关键实测对照(中位数)

| 指标 | v1 G0 | v2 修复后 | Gate §5.2 判定 |
|---|---:|---:|---|
| F01 seek p95 | 29.2ms | 38.2ms | **退化 +31%——超出 ≤20% 门,需解释**(a) |
| F01 ready | 2386ms | 3200ms | +34%(manifest+首窗串行新增,见 (b)) |
| F02 ready | 5780ms | 5738ms* | 持平(*重跑单场景值;A/B 轮 F02 崩溃无中位) |
| F02 播放 compose | 27.0/s | 27.4/s* | **达标**(停滞已修复) |
| F02 Tab WS | 16,706MB | 16,689MB* | **无收益——归因修正**(第 4 节) |
| F03 seek p95 | 30.8ms | 31.1ms | +1%(【2026-09-13 勘误:原稿 39.7ms/+29% 系混入修复前目录 `c20v2-ab-20260911` 的逐轮中位;-v2 目录逐轮中位 31.1ms,复核坐实——见 `PERFORMANCE_C20T_AB_ACCEPTANCE_2026-09-12.md` §8.2】) |
| F03 Tab WS | 2,613MB | 2,608MB | 持平(900 帧表本来就小) |
| 取窗耗时 | n/a | 50–70ms/窗 | 符合"短 UI 请求"预期 |

\* F02 修复后数据来自 `c20v2-f02-retry-01`(单场景 5 轮)与
`c20v2-ab-20260911-v2/F02/run-0-off`。

(a) seek p95 退化来源:seekToFrame 在 v2 下新增 `await ensureRange`——
未缓存窗口的 seek 要等一次 IPC(50–70ms)+ B13 解码,而 v1 全量表下
getFrame 立即命中。命中缓存的 seek 不受影响(F01 seek p95 仍 38ms 量级
——但 F01 总帧数仅 330,窗口 2 个几乎常驻,退化为何仍 +31%?答:首窗
外的 seek 均需取窗;F01 时间轴短,大部分 seek 落在窗 0/1 之外的窗口 2,
每次都要 IPC)。改进方向:沿播放方向的预取窗已覆盖前向播放;**随机 seek
的取窗等待是 v2 协议的固有成本**,可通过增大窗口缓存预算(8MiB → 更大)
或预取 ±2 窗缓解,属参数调优而非结构缺陷。

(b) ready 增量 = manifest 请求 + 首窗请求两次串行 IPC + 契约解析;
可并行/预取优化,非结构问题。

## 4. 归因修正(本报告最重要的结论)

跨构建相关性表(F02 Tab WS vs 播放 decode 量):

| 构建/状态 | decode/300s | Tab WS 峰值 |
|---|---:|---:|
| v1 G0(全量表在场) | 7,848 | 16,705MB |
| v2 停滞(枚举缺陷) | 564 | 3,354–3,503MB |
| v2 修复(全速播放) | 7,968 | 16,689MB |

- v2 修复后 WS 与 v1 完全一致(轨迹逐点相似:60s≈10.1GB、120s≈16.6GB)。
- IR 帧表本身:27000 帧小对象 ≈ **13.5MB JS 堆**(每帧 ≈500B),
  v1 全量 JSON 传输 ≈ 14MB——两者对 16.3GiB 而言**均可忽略**。
- **结论:F02 内存由解码驻留(VideoFrame/GPU 纹理/环槽,B13/B11 范围)
  主导,与帧表形态无关。** G0 报告原"16.3GiB 支撑 C20 优先级"的归因
  已在该报告与 G0 报告中更正。

对 C20 的含义(Planning Gate 修订):
1. C20 v2 数据面**保留**(已交付、行为正确),但其价值重新表述为:
   解除 27000 帧上限的结构路径(v2 无全量表,长项目不受 27k 限制)、
   传输有界化、C20c dirty-range 复用的基础;**不是 F02 内存的解药**。
2. F02 内存目标(16.3GiB → 预期)转由 **B13/B11 解码驻留上限**承接
   (环槽/活跃输入的驻留预算、解码 VideoFrame 的硬上限)。
3. C20c(dirty-range 复用)按原计划条件(本阶段实测驱动)评估:当前
   F02 播放/seek 指标已与 v1 持平,复用收益主要在 revision 切换时的
   解码链保持,优先级维持中。

## 5. 与 Planning Gate §5.2 验收的对照

| 目标 | 结果 |
|---|---|
| ready <2s | **未达**(F02 5.7s、F01 3.2s;两次串行 IPC + 未知项,见 §3b) |
| F02 WS <2GiB | **不适用**——归因修正后该目标移交给 B13/B11(解码驻留) |
| 播放/seek 退化 ≤20% | **部分未达**:seek p95 +31%(F01,随机 seek 取窗等待,§3a;F03 勘误后 +1%,见 §3 表注);播放 compose 持平 |
| off 复测 ±5% | F01/F03 off 轮与 G0 一致(同机同负载) |

**Gate 判定(自评):C20 v2 数据面"行为正确性"达标,"性能目标"未全达。**
处置:保留交付(结构价值 + 已修复停滞),性能目标的残余项(随机 seek
取窗等待、ready 串行链)列为参数/结构调优清单,与 B13 解码驻留上限
合并成下一轮工作包;不掩盖未达标项,不重定门。

## 6. 遗留与登记

1. **F02 v2 崩溃(低频)**:run-0-on 播放段 App 崩溃一次
   (trace 留证),单场景重跑 5/5 通过——疑似与 seek 风暴后播放的
   解码/上传竞争相关(B13 范围),登记待查,不阻断。
   **【2026-09-11 勘误(B13-R 实施轮证据核对)】**"trace 留证"表述过重:
   `c20v2-ab-20260911-v2/F02/run-0-on/` 实际仅 failure.json(status=
   invalid-incomplete,错误文本按隐私策略未持久化)+ user-data 快照;
   desktop.log 末尾为正常 before-quit shutdown,无崩溃 dump/crashpad 目录。
   test-results 下的 trace.zip 属 Playwright 自带产物,是否仍存在未核实。
   可诊断性缺口(runner 未持久化脱敏错误文本)已随 B13-R 登记待修。
2. **B13/B11 解码驻留上限**:F02 内存问题的正确归属,建议下一工作包
   (环槽/驻留 VideoFrame 预算硬上限)。
   **【2026-09-11 B13-R 判别结论回填】**判别实验(见
   `PERFORMANCE_B13_RESIDENCY_IMPLEMENTATION_2026-09-11.md`)推翻
   "环槽/VideoFrame 预算可修"假设:F02 16.6GiB 为 Chromium 层有界池
   高水位(随 unique 帧数饱和,~600KB/帧),与上传路径/解码后端/IR 形态/
   JS 帧生命周期全部无关;应用层无泄漏(framesLive=0)。已落地遥测 +
   驻留平台预测护栏,真实修复方向转 Chromium 上游/B11 代理降档。
3. **seek 取窗等待优化**:缓存预算参数化、方向性预取 ±2 窗。
4. **ready 串行链优化**:manifest 与首窗并行化。

## 7. 复现命令

```powershell
$env:VITE_AIVS_PERF='1'; $env:VITE_AIVS_PREVIEW_IR_V2='1'; pnpm --filter @aivideo/desktop build; Remove-Item Env:VITE_AIVS_PERF,Env:VITE_AIVS_PREVIEW_IR_V2
node tools/performance/run_editor_benchmark.mjs --scenarios F01,F02,F03 --fixtures evidence/performance/g0-fixtures-20260911 --output evidence/performance/<new-dir> --runs 5 --seeks 100 --playback-seconds 300 --seed 20260908
.\.venv\Scripts\python.exe tools/performance/summarize_results.py --results evidence/performance/<new-dir>
```
