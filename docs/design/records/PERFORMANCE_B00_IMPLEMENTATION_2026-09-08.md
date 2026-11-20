# B00 实施进度与自检报告（2026-09-08）

## 1. 状态与范围

**B00 部分实现，完整 App 诊断冒烟通过；B00 未完成，G0 未通过。**

按性能实施方案从 B00 开始，未进入 A01 或之后的优化。
没有 commit/push、打包安装、真实 Provider 调用、模型下载或日常用户数据库操作。
原有评估、实施方案、纯 IR 基准及失败运行证据均保留。
基于 HEAD `b15015b6682ec900ae1a7a3500e82ff12663b942` 的未提交工作区实现。

角色：本次由单一执行者合并架构/桌面/Core职责并做自检；没有独立 reviewer 批准，
不将测试通过写作 AGENTS.md 的独立 Verification/Release Gate 通过。

## 2. 已落地

### Renderer / Worker

- 数值事件环形缓冲（4096 条），默认禁用；累计次数、耗时总和/最大值独立于窗口。
- session/request/input/epoch/frame 关联；每个诊断 compose 的 seq 对应 Worker submitted 回执。
- Worker 关联表上限 512；过期 reset generation 回执丢弃；terminate 清理表。
- submitted 是 GL 调用返回后的消息往返，不是 GPU 完成或实际呈现。不加入 finish/readback。
- 主环 decode/upload、seek、compose/submitted、reanchor、session open/close、Long Tasks、
  时间轴主体 draw 埋点；影子槽 decode 已覆盖，影子槽 upload 和图像上传仍未单列。
- 真正 App 的 React Profiler 接入，但普通 production React 不保证回调，明确标为 unavailable。
- 只有 `VITE_AIVS_PERF=1` 构建暴露 `window.__editorPerf`；关闭诊断不增加逐帧 Worker ack。
- 保留原有短片探针和旧统计字段，不把旧 dropped/rAF 指标改名包装成真实掉帧。

### Core

- 环境变量启用的同步/异步计时装饰器，关闭时返回原函数，保留返回值和异常语义。
- hash、probe、compile、IR project、encode、validate_decode 分阶段计时。
- event-loop lag 采样，4096 条窗口和独立累计计数。
- 使用锁拷贝快照；每约 5 秒在线程中写临时文件并原子替换，正常关闭时另做 flush。
  IO 失败不传播至业务；Windows 强制退出可能损失最后一个 flush 周期。
- 不记录媒体路径/票据/字幕/Provider 内容；事件只含阶段名与耗时。

### 夹具与完整 App 入口

- 合成 testsrc2 + sine CFR 媒体、固定 seed、SHA256/FFmpeg 工具链清单。
- 基础场景 `F01/basic-cfr`：12 秒 640×360 30fps 单素材，完整 App 打开、导入、seek、播放。
- **这不是计划中的历史 F01**（PiP/1.25x/非对齐宽度）；F02–F07 完整场景尚未实现。
  生成器的其他媒体配方仅是原料，运行器拒绝冒充这些场景。
- 预热和每组 off/on 分别启动独立 Electron/Core user-data；不覆盖既有输出。
- UI 检查合成预览状态与播放头前进；截图在计时区间结束后获取。
- 项目载入缺票据时允许一次显式 UI 重试，记录 setup_recovery_count；不能当无故障冷启动。
- CPU/RAM/OS/GPU/驱动/刷新率/DPR/viewport/runtime、源码指纹、素材 SHA、每进程 Electron CPU/内存采样。
- seek action wall 包含 300ms 固定等待；内部 seek 时长只到数据就绪，不是 click-to-photon。
- 开关快照断言；安全 failure.json；比较器拒绝环境/场景/夹具/工作量/恢复次数不一致以及误标开启的空快照。
- 对比入口输出每轮保留窗口 p95 的中位数，仅用于探索性比较，不负责批准 Gate。

## 3. 验证结果

| 项目 | 结果 |
|---|---|
| Desktop TypeScript typecheck | 通过 |
| Desktop 相关 Vitest | 6 文件、78 项通过 |
| Core 相关 pytest | 65 项通过（最终重跑） |
| 新增 Python 文件 Ruff | 全部通过 |
| 诊断构建 | 通过 |
| 完整 App 冒烟 04 | 1 用例通过；预热 + 1 off/on 对，3 seek、5s 播放 |
| 完整 App 冒烟 05 | 1 用例通过，约 3.3 分钟；预热 + 1 off/on 对，每次 100 seek，测量组 30s 播放 |
| 比较器自比较入口 | 通过；只是工具自检，不是性能改善证据 |
| 恢复普通 production 构建 | 通过 |
| 现有 verify:probe-isolation | 通过 |
| 普通 renderer 产物 `__editorPerf` 检索 | 零命中 |
| git diff --check | 通过（存在仓库既有 LF/CRLF 提示） |

未执行全仓全量测试、正式打包、参考图像/音频一致性验收。
构建有既有 logging.ts 同时静态/动态导入警告，不是本次性能诊断失败。

最新冒烟 05 摘要：

| 指标 | 关闭组 | 开启组 |
|---|---:|---:|
| 显式回退重试 | 0 | 0 |
| 导入到预览可用（含 reload/初始播放验证） | 4461ms | 4335ms |
| 外部 seek 点击 | 100 | 100 |
| 内部完成 seek 事件 | 不采集 | 194 |
| 30s 播放 Worker submitted | 不采集 | 893 |
| 30s 播放 decode / upload | 不采集 | 899 / 899 |
| 进程采样次数 | 30 | 30 |
| 播放事件窗口覆盖丢失数 | 0 | 0 |

单击可能产生多个内部 seek，所以 194 不是“多完成了 94 次用户操作”。
893 个 submitted 不是显示帧数；不能计算出有效 FPS 或掉帧达标结论。
一次 off/on 顺序对照的 ready_ms 差异不足以证明性能收益或 <3% 探针开销。
设备：i7-1165G7、约 32GiB RAM、75Hz；详细 GPU/驱动/运行时见结果 JSON。

证据目录：
- `C:\DataFolder\codes\AI-Vidio\evidence\performance\b00-fixtures-20260908`
- `C:\DataFolder\codes\AI-Vidio\evidence\performance\b00-smoke-20260908-04`
- `C:\DataFolder\codes\AI-Vidio\evidence\performance\b00-smoke-20260908-05`
- `C:\DataFolder\codes\AI-Vidio\evidence\performance\B00_ATTEMPTS.md`

05 的源码指纹对应启动时的工作区；随后仅新增说明/测试断言并对新增 Python 文件格式化，
不是同一源码指纹。当前 out 已恢复普通构建，不能直接拿它重复诊断运行，必须重新诊断构建。

## 4. 失败证据与真实风险

01：沙箱中 Python/窗口启动失败。
02：旧 E2E 项目选择器失效（当前 UI 已无旧 data-project-id），改为真实 App reload 初始化。
03：reload 后诊断自动关闭，导致 warmup 标签与快照不一致；**该次数据无效**，现有断言/比较器拒绝此情况。
03 后续 off 启动实际出现 `no ticket for asset` 并回退交互预览。没有修改业务层修复此竞态，
将它作为后续单独调查项；04/05 均没有触发恢复，不证明该竞态已消失。

单元测试阶段曾误用 client.dispose（实际接口是 terminate），修正测试后 78 项通过。

## 5. B00 剩余工作清单（不能进入 A01 的原因）

1. 完整实现并保存 F01 历史场景/IR指纹和 F02–F07 场景，特别是长素材深 seek、
   多层混音、VFR/B 帧、并行导出/本地转录或明确标记模拟负载、变速切项目边界。
2. 实现严格口径的 uniqueFrames/skippedFrames/maxFreeze/audioUnderrun 累计指标；
   排除 seek/buffering/暂停/循环窗口，不能用 compose 或 rAF 次数替代。
3. VideoFrame/Worker/ObjectURL 生命周期、纹理估算字节、Core 进程资源、
   Canvas 分层统计、支持 React profiling 的独立构建和 Core 请求排队等待时间。
4. 跨线程/进程时间关联与实际 presentation trace 或校准外部代理；
   decode/upload 旧异步请求跨 reset 窗口的隔离仍需完善（目前只隔离 compose ack）。
5. 场景失败清单和总运行完成标志、自动进程退出验证；当前 app.close 返回不等于完整泄漏验证。
   外部截图失败时可能仍留有 sample/result，同时有 failure.json；不能仅凭 results 存在判断成功。
6. 固定代表硬件/夹具后执行 1 预热+5 测量、每轮至少100 seek、5分钟播放、30–60分钟内存。
7. 有效的开关探针开销统计（处理固定等待、热缓存、顺序偏差），验证中位数 <3%。
8. 独立审查并冻结 G0 门槛和证据。上述条件满足前，不把本次冒烟包装成完整 B00 验收。

## 6. 后续操作入口

详见：`C:\DataFolder\codes\AI-Vidio\tools\performance\README.md`。
该文档包含可复制命令、构建/运行顺序、数据解释与限制。
下一步继续 B00 第 5 节，不开始 A01，不以本次单对照宣称“渲染更流畅”。
