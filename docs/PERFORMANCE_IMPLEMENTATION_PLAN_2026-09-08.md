# Vortex Cut 性能工程实施方案

- 日期：2026-09-08
- 参考基线：`b15015b`；开工前重新核对 HEAD 与相关实现，行号不作为补丁定位依据。
- 工作区：`C:\DataFolder\codes\AI-Vidio`。下文文件路径均相对此根目录。
- 依据：`docs/PERFORMANCE_ASSESSMENT_2026-09-08.md`。
- 状态：**待设计评审的执行方案；没有修改业务代码，没有宣称 Gate 已批准。**
- **执行状态（2026-09-10 更新·二）**：B00-A、A01–A08（G1 达成）、
  B10–B17（G2 达成）、C20a+b、C21a+b、C22 已交付；C23/C24 按
  `docs/PERFORMANCE_G3_CLOSEOUT_2026-09-10.md` 结项（C23 不实施+内存
  预算护栏，C24 进入条件不满足不实施）。F03 深定位收益已实测（编码
  阶段 wall time 降 29.2%/31.1%，见
  `docs/PERFORMANCE_F03_DEEP_SEEK_MEASUREMENT_2026-09-10.md`）。
  **B00-B 第一阶段已交付**（F01 保留 + F02/F04/F07 完整 App 场景装配 +
  runner 多场景调度，四场景冒烟全绿）；过程中发现并修复 B12 完整 App
  回归（refreshTicket 闭包经 postMessage 不可克隆 → 合成预览自 B12 起
  不可用；消息往返桥修复 + 回归锁单测），详见
  `docs/PERFORMANCE_B00B_SCENE_ASSEMBLY_2026-09-10.md`。**B00-B 第二阶段已交付**
  （2026-09-11:F03 深定位/F05 4K60/F06 播放+导出竞争三场景装配,冒烟
  全绿;F06 导出并行 succeeded 验证;新登记 4K60 seek 缺陷与会话挂起
  两个被测系统行为,详见 B00-B 报告 6b 节)。剩余：F04 升回 100 素材
  口径（依赖 list_assets 分页修复）、4K60 两缺陷的产品侧工作单、正式
  G0 采样（重复采样/长测/探针开销/独立评审）、各修改单独立验收
  （"待验收"未变）、C20c 与 C20 Renderer v2 数据面（实测驱动）。
- **执行状态（2026-09-11 更新·三）**：**B00 正式 G0 采样轮完成**
  （七场景 × 5 轮 × off/on × 100 seek × 300s 播放，
  `evidence/performance/g0-baseline-20260911-v2/`，报告
  `docs/PERFORMANCE_B00_G0_BASELINE_2026-09-11.md`）。F06 竞争门
  +0.0%（门 ≤20%）、探针 off/on 墙钟差 ≤0.1%（门 <3%）；关键实测：
  F02（27000 帧 IR）Tab 工作集峰值 16.7GiB、F04 四层合成 submitted
  p95 16.1ms、F03 播放段 decode:compose ≈ 122:1（逐帧重解码）、
  F05 4K60 seek 缺陷更新为部分样本 86–96/100 有事件。期间修复 harness
  多场景 runDir 冲突（首轮 F02–F07 失败留证）。**G0 独立评审已完成：
  有条件批准**（LiuKeAi,2026-09-11：无 Blocker,3 Major 均为报告/字段
  更正,4 条条件已全部落实——overwritten 口径更正、F02 内存 16,706MiB
  ≈16.3GiB 与 ~3min 达峰、F06 缺转录竞争维度偏差登记、单轮值改五轮中位）。
  **30–60 分钟内存长测已完成**（g0-memlong-20260911,F02+F06 各 off/on
  2400s:无晚发增长,F02 ~5min 达平台后 35min 波动 <20MB;F06 40min 导出
  竞争 succeeded）。剩余：C20c 与 C20 Renderer v2 数据面（实测依据齐备,
  可启动）。
- **执行状态（2026-09-11 更新·四）**：**C20 第二阶段已交付**
  （Renderer v2 数据面：windowedFrameSource LRU 整窗缓存/single-flight/
  在途上限/abort/失配丢弃 + `VITE_AIVS_PREVIEW_IR_V2` 开关接入
  （默认 off,v1 逐字节不变）+ pip 索引 v2 增量构建;Planning Gate
  `docs/PERFORMANCE_C20_PHASE2_PLANNING_GATE_2026-09-11.md`,Desktop
  616 项全过）。F 场景 v2 on/off A/B 实测待下一基准轮;达标后 C20c
  （revision 换 manifest 沿用会话）立项。
- **执行状态（2026-09-12 更新·五）**：**C20 v2 A/B 实测完成**
  （`docs/PERFORMANCE_C20_PHASE2_AB_2026-09-12.md`）。过程中发现并修复
  ensureRange 窗口枚举错位（播放/seek 停滞根因,window_fetch 遥测定位）;
  **F02 16.3GiB 归因修正**——与 IR 帧表无关（13.5MB 可忽略）,由 B13/B11
  解码驻留主导,C20 v2 价值重述为协议上限解除+C20c 基础。Gate §5.2:
  行为正确性达标;seek p95 +29~31%（取窗等待）、ready<2s 未达,列为调优
  清单。下一工作包建议：**B13/B11 解码驻留上限**（F02 内存的正解）+
  C20 调优（预取/并行化）+ F02 低频崩溃待查（trace 留证）。
- **执行状态（2026-09-11 更新·六）**：**B13/R 解码驻留判别完成**
  （`PERFORMANCE_B13_RESIDENCY_PLANNING_GATE_2026-09-11.md` +
  `PERFORMANCE_B13_RESIDENCY_IMPLEMENTATION_2026-09-11.md`）。三轴判别
  实验（copyTo/direct、HW/SW、v1/v2）曲线重合:F02 16.6GiB 为 **Chromium
  层有界池高水位**（随 unique 帧数饱和,~600KB/帧,2400s 长测无晚发增长）,
  **应用 JS 层无泄漏**（framesLive=0 遥测）——"环槽/VideoFrame 预算硬上限"
  路线撤销,真实方向转 Chromium 上游/B11 代理降档。交付:两 worker 驻留
  遥测（1Hz）、错误路径 frame.close 修复、驻留平台预测器+会话预警
  （resource-budget）。Desktop 619 项全过。C20 §6.1 "trace 留证"已勘误
  （实际无崩溃 dump）;崩溃可诊断性缺口（failure.json 不含脱敏错误文本）
  登记待修。
- **执行状态（2026-09-12 更新·七）**：**下一工作包 C20-T/B11-D Planning
  Gate 批准**（`docs/PERFORMANCE_C20T_B11D_PLANNING_GATE_2026-09-12.md`,
  LiuWei 签署）。三子包：**S1 小修**（input-pool-protocol 2 个
  unhandled rejection + failure.json 脱敏错误文本持久化——F02 低频崩溃
  待查的前提）；**C20-T1 seek 取窗调优**（缓存预算/预取窗数/在途上限
  入 resource-budget 档位表 + seek 落定后方向性预取 ±2 窗,验收门：
  seek p95 退化收敛 ≤20%）；**C20-T2 ready 并行化**（首选无契约方案,
  附 ready 分段遥测与 F02 5.7s 归因分解,绝对值 <2s 不设门）；**B11-D
  代理降档决策轮**（F02 320×180 spike 验证 predictResidencyBytes
  ±25%,决策备忘录三问——auto 降档触发线/低于源短边档位/质量降级
  UX 登记,不预授权实施）。次序 S1→T1→T2→D；v2 默认 on 挂起至 T1/T2
  达标且 B13+C20 二阶段独立验收通过后单独决策。同日仓库整理：分支
  `uiux-polish-round3` 推送远端备份,master fast-forward 至该分支
  （127 提交,纯 ff 零冲突）。
- **执行状态（2026-09-12 更新·八）**：**C20-T1/T2 验收 A/B 轮完成 +
  B11-D1 spike 判定落锤**（`docs/PERFORMANCE_C20T_AB_ACCEPTANCE_2026-09-12.md`、
  B11-D 备忘录 §2.1；证据 `c20t-ab-20260912-v1/-v2/-v2-f03retry、
  b11d-spike-20260912`）。**T1 达标**：F01/F03 seek p95 退化消除
  （-0.4%/-4.1%，T1 前 +31%）；**T2 达标（F01/F02）**：ready +2.6%/
  -10.7%，F03 +7.7% 超线但与 T1/T2 前 c20v2 持平（-0.3%，v2 manifest
  投影固有，非本轮引入）；**F02 ready 归因分解交付**：主导项为 Core
  manifest 投影 IPC（随源大小缩放，900s→1.8s/3600s→4.3s）+ 段外启动
  链残差 ~56%（未分段）。F02 v2 seek +111% 为 v2 窗协议固有（T1 前后
  持平），登记不改。**B11-D1 spike：代理降档无效**——320×180 解码输入
  Tab WS 16,649MB vs 640×360 16,707MB（-0.35%），缩放律证伪，~630KB/
  帧为分辨率无关固定成本，现行 predictResidencyBytes 无需补 w×h 项；
  D2 三问推荐"不实施"，挂 LiuWei 裁决。off 复测 ±5% 全过（最大
  +3.9%）；harness 修正两项入库（F02P 项目名缺陷修复——上轮只过单测
  未跑 E2E 的教训登记；ready 分段 reset 前捕获），装配竞态偶发
  （~1/50 启动）登记为 harness 已知脆点。c20v2 报告 F03 seek 39.7ms
  勘误候选登记（其目录不可复算，per-run 中位 31.1ms）。v2 默认 off
  维持；"默认 on"待独立验收后按 Gate §3 单独提请。同日 D2 已裁决
  （LiuWei）：三问均不实施，B11-D 方向关闭（备忘录 §3）。
- **执行状态(2026-09-13 更新·九)**:**B13+C20 二阶段+C20-T 独立验收
  完成——有条件批准**(LiuKeAi,
  `PERFORMANCE_B13_C20T_INDEPENDENT_ACCEPTANCE_2026-09-13.md`)。全部
  关键数字独立重算(summarize 重跑 + 原始 JSON 重算 + Desktop 625 项
  本机复跑零 rejection + 代码抽查 + 指纹核对):S1/T1/T2/C20 二阶段/
  B13-R 五交付物验收通过,B11-D 关闭证据链复核无误。3 个 Minor 均为
  报告更正并已落实——①F01 seek 百分比基线混用(对 fresh v1 实为
  -2.0%,非 -0.4%,门不变);②F03 ready 分段子集未标注(合并 n=8 =
  m4144/i165/w166);③spike ready 中位 5,507→5,484。**c20v2-F03 seek
  39.7ms 勘误候选升级为确认**(= 修复前目录 c20v2-ab-20260911 逐轮
  中位;正确值 31.1ms,+1% vs G0),登记销账。两项裁量同意原定性:
  F03 ready +7.7% 属 v2 manifest 投影固有(重算 6869.5 vs 6888 =
  -0.3% 持平);F02 段外残差 ~2.9s(~56%)列为"ready <2s"主战场进
  下一工作包候选。"默认 on"两项前提成立,**LiuWei 同日裁决:批准 v2
  默认 on**(`PERFORMANCE_C20V2_DEFAULT_ON_DECISION_2026-09-13.md`)——
  `previewIrV2Enabled()` 缺省翻转(`VITE_AIVS_PREVIEW_IR_V2=0` 显式
  回退,长期保留),两组 v1 形状单测经 `vi.stubEnv` 显式钉 v1,
  typecheck + 625 项复跑全过;**基准口径变化:未来 v1 基线构建必须
  显式 `VITE_AIVS_PREVIEW_IR_V2=0`**(G0 冻结面不动)。C20c Planning
  Gate 同日起草(`PERFORMANCE_C20C_PLANNING_GATE_2026-09-13.md`)。
- **执行状态(2026-09-13 更新·十)**:**C20c-1(revision 换 manifest 沿用
  会话)已交付**(`PERFORMANCE_C20C1_SESSION_SWAP_IMPLEMENTATION_2026-09-13.md`,
  Gate 同日批准)。v2 数据面补齐 v1 既有的"同输入 revision 变更 → 会话
  保活"语义:编辑/撤销/重做/AI 提交的 revision 切换不再整会话重建,
  新 manifest 帧源经 `replaceIr(ir, frameSource)` 就地换装(worker/GL/
  池/音频全保留——会话侧机制 C20a/b 时已预留,本轮接通装配侧);暂停态
  `refineAfterDrag` 重锚、播放态 pump 按引用自愈;`frameSourceRef`
  所有权闭环顺带闭合项目切换/卸载两处既有帧源泄漏面。Desktop
  typecheck/lint 通过,单测 **70 文件 629 项全过**(625+4 新增,v1 零
  改动不动即过);测试桩抽至 `tests/fixtures/preview-worker-stubs.ts`
  共享。A/B 行为正确性轮与 C20c-2 合并(改动面不触稳态路径)。遗留:
  C20c-2 dirty-range 复用(下一工作单)、Core manifest 投影缓存/增量
  与 F02 段外残差按 C20c Gate §2 排除清单另立。
- **执行状态(2026-09-13 更新·十一)**:**C20c-2(缓存窗口迁移)已交付 +
  C20c-2b(契约扩展)登记**(`PERFORMANCE_C20C2_SEED_REUSE_IMPLEMENTATION_2026-09-13.md`)。
  经代码证据裁定范围收敛:manifest_id(=content_fingerprint@mode@profile)
  相等 ⇒ 同投影 ⇒ 缓存窗口整体迁移健全(覆盖撤销/重做/空转 revision 的
  编辑闭环,零取窗换装、帧对象跨源同引用);**不等时不做部分复用**——
  投影输出剥离 keyframes/transform(ir.py:456-467)、DTO 无预设/字体版本,
  渲染器无法证明段外帧未变,按 Gate §4"宁重算不猜测"全局重算。交付
  frame-source 种子机制(seedWindows/snapshotWindows,LRU 记账 + 防御性
  过滤 + 引用稳定性跨源延续)+ SyntheticPreview 成对 ref 判定接线。
  Desktop 635 项全过(629+6),v1 零改动。**C20c-2b 登记(契约扩展)**:
  段级 visual hash(keyframes/transform)+ caption 语义 hash 下发后激活
  结构 diff 部分复用(机制载体本轮已就绪,含 1 帧 halo + 窗口粒度扩展
  与 golden 对拍硬门);Core 投影缓存 LRU=2 的深撤销重投影成本维持
  C20c 排除项另立。
- **执行状态(2026-09-13 更新·十二)**:**C20c-1/-2 验收 A/B 轮完成——
  达标**(`PERFORMANCE_C20C_AB_ACCEPTANCE_2026-09-13.md`;证据
  c20c-ab-20260913(留证)/-v2/-v2-f03retry)。稳态零回归:F01 2452/29.2、
  F02 5130/76.9、F03(合并 n=8)6834/30.5——对 c20t-v2 基线全部 ≤±2%;
  **108 个 revision 转换零整会话重建**(ready_inject=0),换装 wall 与
  v1 replaceIr 持平(±1%),取窗形状符合设计(F01 2 窗/F02 7 窗/F03
  2–3 窗)。**新发现:热进程 manifest 重投影便宜**(F03 转换 42–62ms vs
  冷装配 4,144ms;F02 66–350ms vs 1,796ms——4.1s 冷成本属首投影预热),
  **C20c-2b 优先级下修**(部分复用收益从 4.1s/切换 修正为 50–130ms/
  切换,待产品反馈再议)。**装配竞态升级登记**:本轮 3/60 启动(主轮
  F01 warmup-on + F03 run-4-on、重跑 F03 run-4-on 同槽位,desktop.log
  干净),高于 ~1/50 估计,疑与 F03/晚槽位相关——建议独立小工作单:
  harness setup 超时 page.reload 恢复路径 + 根因排查。种子路径 e2e
  触发器(同文档 revision)不在自然编辑负载内,单测覆盖维持。
- **执行状态(2026-09-13 更新·十三)**:**harness setup 装配竞态恢复路径
  落地**(`PERFORMANCE_HARNESS_SETUP_RECOVERY_2026-09-13.md`)——setup
  序列重构为 ≤3 次有界循环:canvas 可见性超时且状态仍 synthetic(= 竞态
  形态)时 page.reload 重建装配再试(≤2 次恢复,计入
  setup_recovery_count;超限或非 synthetic 状态按原样响亮失败,最坏情形
  = 原行为)。仅 harness 改动,产品代码零改动;F01 冒烟常规路径全过
  (recovery 计数 0,循环透明)。恢复分支由真实轮次机会性验证(计数
  可审计);**产品侧根因排查独立挂账**(工作假设:canvas 尺寸仅靠
  ResizeObserver 事件更新,就绪时容器 0 尺寸则不再触发——待恢复路径
  积累现场后定位)。
- **执行状态(2026-09-14 更新·十四)**:**D11 立项——解码驻留显式天花板 +
  Chromium 池行为测量型 spike**(`PERFORMANCE_D11_RESIDENCY_CEILING_PLANNING_GATE_2026-09-14.md`,
  同日批准)。性质重述:v2 默认 on 解除 IR 协议 27k 上限后,~631KB/unique 帧
  的 Chromium 池高水位成为事实天花板,不标注即为隐性约束——**产品约束登记:
  实用 unique 帧上限 ≈ (Tab 可用预算 − 0.4GB) ÷ 631KB**(16GiB 机器 ≈1.6 万帧
  ≈9 分钟 unique 内容;32GiB ≈2.7 万帧=现行协议上限恰好贴合;64GiB ≈7.1 万帧),
  预警内侧表面 = R3 `predictResidencyBytes`(不阻断,超档位预算一次性提示;
  harness 本轮补 `residency_warning` 采集点,由 F02 最小轮坐实真实触发)。
  第二步为测量型 spike(只测不承诺):bench 分支 Electron 升版对拍
  (现 36.2.1,对拍 16,649MB 基线,判定标准 ±5%/灰色加倍/<1% 未命中)+
  Chromium flags 探测;命中才另立 Electron 升级工作单(27k 压力验证轮同理,
  C20c Gate §7.9 依赖本判定),未命中则接受现状、D11 关闭。F02 段外残差
  分段测量、Core 投影缓存评估、C20c 独立验收打包在 D11 判定后接续。
- 新增模块/协议/脚本均是本方案拟新增，不代表仓库已经存在。


### 阅读与执行导航

- 第3节：修改单、负责人和依赖；第4节：B00基线。
- 第5节：第一轮A01–A08；第6节：第二轮B10–B17；第7节：第三轮C20–C24。
- 第8节：验收矩阵；第9节：命令与证据；第10节：发布/回退；第11节：工作单模板。
- 共22个修改单（含B00），其中C23是受限倒放实验、C24是条件GPU实验；不要求盲目全部默认启用。

### 文件路径解析约定

为避免同名文件误改，正文省略的模块路径以以下绝对目录为准；明确写出的仓库相对路径不再套前缀：

| 正文简写 | 绝对目录/文件 |
|---|---|
| Core `aivs_core/`、`rendering/`、`media/`、Core顶层 `.py` | `C:\DataFolder\codes\AI-Vidio\services\core\src\aivs_core` |
| Core `tests/unit/`、`tests/integration/` | `C:\DataFolder\codes\AI-Vidio\services\core\tests` |
| Desktop `preview/`、`timeline/`、`App.tsx`、`styles.css` | `C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app` |
| `preview-session.ts`、`SyntheticPreview.tsx`、`ir.ts`、解码/合成worker | `C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app\preview` |
| `TimelineCanvas.tsx`、`geometry.ts`、timeline `types.ts` | `C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app\timeline` |
| Desktop `tests/` | `C:\DataFolder\codes\AI-Vidio\apps\desktop\tests` |
| `restricted-media.ts`、Main IPC模块 | `C:\DataFolder\codes\AI-Vidio\apps\desktop\electron\main` |
| Main入口 | `C:\DataFolder\codes\AI-Vidio\apps\desktop\electron\main\index.ts` |
| Preload入口 | `C:\DataFolder\codes\AI-Vidio\apps\desktop\electron\preload\index.ts` |
| Desktop Core client | `C:\DataFolder\codes\AI-Vidio\apps\desktop\src\lib\core-client.ts` |
| 公共契约入口 | `C:\DataFolder\codes\AI-Vidio\packages\contracts\src\index.ts` |

正文“新增”中的路径也是设计建议，开工前查现有同职责模块，避免重复实现；调整落点需在工作单登记。

## 1. 目标、边界和不可破坏约束

目标是让播放、seek、时间轴拖动、编辑提交、素材导入和后台导出同时具备可预测的响应与资源使用。按三轮实施，先止住确定性放大器，再解决长素材和内存，最后优化长项目与导出。

### 1.1 不在本轮自动扩大的范围

- 不重写原生引擎，不整体迁移 WebGPU，不顺带重构 AI/Provider 产品流程。
- 不改变时间轴编辑语义、转场借用规则、素材源时间映射或导出画质标准。
- 不因性能指标删掉字幕、音频、蒙版、校验等工作；不同功能覆盖必须单独比较。
- 不将真实 Provider 调用或真实用户数据库用作自动测试夹具。
- 不将“把函数放进 async”视为后台执行，不将 `to_thread` 视为 Python CPU 并行方案。

### 1.2 必须保留

1. Renderer 无系统路径/任意文件权限；媒体通过现有授权、白名单 IPC、受控票据访问。
2. PreviewSession 持有时间轴编排，GL Worker 只执行绘制；不要把独立可修改 IR 副本塞进 GL Worker。
3. direct VideoFrame 上传优先及 copyTo 回退、VideoFrame.close、同输入上传顺序、seek epoch 失效处理。
4. 同输入 revision 的 replaceIr 保活；不能每次拖动/提交都销毁会话。
5. 现有硬件编码回退、进程树回收、最终完整性校验和原子发布。
6. 每次优化有独立正确性回归；性能改好但花屏、错帧、变调或漏音，均判失败。
7. 迁移只允许前向、追加式；迁移编号开工时从实际最大版本取下一号，不预先硬占 v18。

## 2. 角色、交付和 Gate

| 角色 | 职责 |
|---|---|
| LiuWei | 范围、依赖、资源预算、跨模块契约与 Gate 决策 |
| ZhangSan | Core、IR、缓存元数据、FFmpeg、任务调度、正确性基准 |
| YeJing | Desktop、IPC、预览 Worker、音频、Canvas、性能探针 |
| LiuKeAi | 独立复核输出语义、生命周期、安全边界与性能证据 |

每个修改单必须交付：代码、对应测试、前后证据、失败/回退验证、变更文件清单、已知限制。分阶段 Gate：

- G0：同机基线与夹具冻结，指标口径可复算。
- G1：第一轮功能等价，所有关键结构性问题有自动化断言；短项目无显著退化。
- G2：长素材/多轨资源有界，代理和分块协议冻结，完整 App 并发场景通过。
- G3：长时间轴和导出优化在相同输出质量下达标，失败路径和回退经过验证。

独立验收未实际执行时只能标“待验收”，不能替代成开发者自测通过。

## 3. 修改单总表与依赖

| ID | 修改单 | Owner | 前置 | 建议复杂度 |
|---|---|---|---|---|
| B00 | 完整 App 性能探针和基线 | YeJing + ZhangSan | 无 | 中 |
| A01 | 初始化失败/取消清理 | YeJing | B00 的计数接口 | 小 |
| A02 | 音频在途去重与有限预热 | YeJing | A01 | 中 |
| A03 | 解码 PTS/关键帧索引 | YeJing | B00 | 小–中 |
| A04 | IR 扫线、PiP 索引 | ZhangSan + YeJing | B00 | 中 |
| A05 | Core 哈希/IR 后台执行 | ZhangSan | A04 | 中 |
| A06 | 时间轴尺寸保护、分离播放头 | YeJing | B00 | 中 |
| A07 | probe/编码能力缓存 | ZhangSan | B00 | 小–中 |
| A08 | 轮询、转录加载和缩略图生命周期 | YeJing | A01、A06 | 中 |
| B10 | 派生媒体缓存与契约 | ZhangSan + YeJing | G1 | 中 |
| B11 | 全源代理与预览源选择 | ZhangSan + YeJing | B10 | 大 |
| B12 | MP4 Range 数据源 | YeJing | B10、A03 | 大 |
| B13 | 活跃输入池、显存预算和负载降级 | YeJing | B11、B12 | 大 |
| B14 | 素材级持久化波形 | ZhangSan + YeJing | B10 | 中 |
| B15 | 分块 PCM 与流式 AudioWorklet | ZhangSan + YeJing | A02、B10 | 大 |
| B16 | 有资源配额的任务调度 | ZhangSan + YeJing | B10；先做内部调度 | 大 |
| B17 | 时间轴分层、二维可见区与状态订阅 | YeJing | A06、A08、B14 | 大 |
| C20 | 窗口/增量 IR v2 | ZhangSan + YeJing | A04、A05、B13、G2 | 大 |
| C21 | 导出输入深定位 | ZhangSan | A07、G2 | 大 |
| C22 | 可取消的最终校验与进度 | ZhangSan + YeJing | A05、B16 | 中 |
| C23 | 分块倒放/区间缓存 | ZhangSan | C21、B10 | 大 |
| C24 | GPU 滤镜路径实验 | ZhangSan + YeJing | 导出分阶段 profile | 实验，不默认上线 |

建议 PR 顺序：B00 → A01 → A02 → A03 → A04 → A05 → A06 → A07 → A08 → G1。
第二轮先 B10，之后按上表前置条件推进；B13 和 B15 改同一会话时串行集成。第三轮先 C20/C21/C22，再决定 C23/C24。

并行实现只允许写集不重叠；A02/A04/B13/B15 都涉及 preview-session.ts，不允许未经协调同时修改。Core service/app/contracts 也按同一原则管理。

复杂度不是工期承诺。大项至少拆“契约+服务/算法+客户端接入+回归”四个可审查提交，不在一个 PR 混入整轮重构。

## 4. B00：基线与诊断先行

### 文件

修改：
- `apps/desktop/src/app/preview/preview-session.ts`
- `apps/desktop/src/app/preview/compositor-worker.ts` / `compositor-worker.worker.ts`
- `apps/desktop/src/probes/m3p5.ts`
- `apps/desktop/tests/playwright.config.ts`（保持性能用例单 Worker）

新增：
- `apps/desktop/src/app/preview/perf-metrics.ts`
- `apps/desktop/e2e/performance-editor.spec.ts`
- `tools/performance/make_fixtures.py`、`run_editor_benchmark.mjs`、`compare_results.py`
- `evidence/performance/<commit>/<scenario>/result.json`

### 具体步骤

1. 在现有短片探针之外，新增真正打开 App、时间轴、素材面板的端到端用例。沿用 E2E 的隔离 user-data/Core 数据目录，不连接日常数据库。
2. 新建数值事件环形缓冲，默认关闭明细；开关只能由测试/开发入口设置。不得每帧 console.log。
3. session/request/input/epoch ID 关联 decode/upload/compose；每个 `compose` 加 `seq`，Worker 回 `submitted(seq)`。
4. `submitted` 只表示 GL 命令已提交，不命名为 `presented`。真实呈现延迟用 Chromium trace 支持的事件推导；无法取到时分别报告提交延迟和外部观测代理值，禁止伪造 presentation 指标。
5. 累计计数独立于滑动统计窗口：composedTotal、uniqueFrames、skippedFrames、reanchorCount、maxFreezeMs、audioUnderrunFrames。rAF 落后次数保留旧字段兼容但更名解释。
6. Renderer 记录 Long Tasks（能力允许时）、React commit、Canvas 各层 draw 次数；Main 收集各进程内存/CPU。GPU 纹理按格式/尺寸/槽数记估算值，标明不是硬件实测 VRAM。
7. Core 记录请求等待、event-loop lag、compile/project/hash/probe/encode/validate 各阶段时间。
8. JSON 不记录路径、票据、字幕正文、Provider 内容或凭据；素材用夹具 ID。

### 夹具与采样

- F01：沿用历史 10–11 秒、1x/1.25x、PiP、非 4 对齐宽度；保存 IR 与媒体指纹。
- F02：15 分钟同源，900 切段/900 字幕；本次纯 IR 基准作为 CPU 对照。
- F03：60 分钟源文件，时间轴只用开头/中间/末尾各 10 秒，专测深 seek/整文件加载。
- F04：100 个短素材、4 视觉层、字幕、混音；分别打开/浏览/播放。
- F05：4K、60fps、长 GOP、VFR/B 帧输入；有不支持格式时验证代理/回退。
- F06：播放同时导出、转录（本地固定模型或模拟资源任务，不能假装模拟即真实 ASR 性能）。
- F07：0.5x/1x/2x/4x，双片段重叠音频、无音轨、静音→开启、seek 后立即切项目。

每次记录 commit、构建模式、CPU/GPU/驱动、RAM、刷新率、DPR、分辨率、代理状态。发布性能用构建后完整 App，开发模式另列。冷缓存与热缓存独立；“冷”默认指应用缓存冷，不谎称清除了 OS 文件缓存。

短基准 1 次预热 + 5 次测量，每轮至少 100 次 seek；报告每轮分位数及其范围。播放至少 5 分钟、内存 30–60 分钟；截图/readback 与计时分开运行。

### 验收

旧指标读者兼容；关闭明细时不产生每帧跨 IPC 上报。探针同负载开启/关闭开销中位数 <3%，超限先修探针。G0 冻结代表硬件和相对门槛，跨机器结果不直接做百分比对比。

## 5. 第一轮：小改动消除确定性放大器

### A01：创建失败与异步生命周期

**修改文件**：`preview/decode-worker.ts`、`compositor-worker.ts`、`preview-session.ts`、`SyntheticPreview.tsx`。
**新增测试**：`apps/desktop/tests/preview-lifecycle.test.ts`。

步骤：
1. DecodeWorker.create 和 CompositorWorkerClient.create 接受可选 AbortSignal，统一握手超时；保持当前解码初始化 15 秒为初始值。
2. 创建器用 try/catch 清理自身已创建 Worker、监听器、计时器。terminate 幂等，拒绝全部 pending Promise；错误事件不是只拒绝 init。
3. PreviewSession.create 用资源栈注册 canvas、compositor、decoder、AudioContext；中途任一输入失败则逆序 dispose 后重新抛错。
4. SyntheticPreview 用 generation + AbortController；revision/project 改变中止旧 create/fetch；仍保留可 replaceIr 的现有会话。
5. dispose 后结果只能释放，不得重新挂 canvas、写 rig、更新 UI；已 transfer 的帧按所有权在 Worker 关闭，不能双方重复 close。

测试：第 2 个输入失败、第 1 个输入超时、font fetch 失败、create 中卸载、seek 在途 dispose、连续切项目 100 次；计数断言活跃 Worker/监听器/pending 回基线。

### A02：音频止血，不提前实现流式引擎

**修改文件**：`preview-session.ts`、`SyntheticPreview.tsx`、`App.tsx`。
**新增**：`preview/audio-source-cache.ts`、`tests/preview-audio-cache.test.ts`。

缓存 key：第一轮只在 session 范围内使用 `asset_id + input binding generation + AudioContext.sampleRate`；不要用临时 ticket 字符串作为稳定内容标识。跨 session 共享要等 B10 的 fingerprint 契约。

```ts
// 拟新增：只表示应用内音频加载，不扩展公开 IPC。
interface AudioSourceEntry {
  state: "queued" | "loading" | "ready" | "error";
  promise: Promise<AudioBuffer>;
  controller: AbortController;
  buffer: AudioBuffer | null;
  decodedBytes: number;
  users: Set<string>; // clip IDs / consumer handles
  generation: number;
}
```

步骤：
1. ensureAudioBuffer 首次调用**同步登记 pending Promise**，之后才 await fetch/decode；同 key 请求返回同 Promise，finally 只清理同 generation 条目。
2. 初始并发上限 2；只预热当前音频段和未来 2 秒会进入的段，暂停时仅当前段。移除全 segments eager fetch。
3. buffer 等待期间每 tick 不增加请求；failed 状态保留，显式重试或票据刷新后重试，不每帧失败重试。
4. 已解码 AudioBuffer 可供多个 clip 读取，但 transfer 给 worklet 必须使用各自副本；绝不能 transfer 缓存原始 channel 数据导致其他消费者 buffer detach。
5. 同时出声的片段仍各有 worklet/playhead，不能因同 asset 合并成一个声音位置。离场释放非活跃 clip worklet；保留少量预热，记录所有副本字节。
6. seek epoch 管请求优先级，不必取消仍被另一活跃 clip 使用的共享源；最后消费者释放且不再预热才 abort。
7. decodeAudioData 无法可靠强制中止；abort 后禁止安装结果，解码 token 在底层完成前不能假装已释放，以免“取消后新任务”突破并发上限。
8. replaceIr 后同步音频 rigs：删除移除的 clip；修改 input/source window 的 clip 重置播放位置；保留未变 clip。检查 load.status 不变时的音频更新。

测试：同源 50 clip 只 fetch/decode 一次；就绪前调用 100 tick 仍只有一次；4 输入并发≤2；移除 clip、静音开启、同源双位置混音；0.5x/2x 音高及现有 worklet 测试不回退。

**限制**：第一轮仍可能解码整个长源文件，内存只改善不承诺有界；B15 完成前，不宣传“支持任意长度音频”。短素材缓存可设置上限，单大源超限必须显式释放/提示，不能静默漏音。

### A03：PTS 与关键帧定位索引

**修改**：`decode-worker.worker.ts`。
**新增**：`preview/sample-index.ts`、`tests/sample-index.test.ts`。

1. demux 完成后构建 `Float64Array ptsUs` 和排序索引 `Uint32Array sampleByPts`；decode 输入仍按原始 DTS/sample 顺序，排序绝不改变喂包顺序。
2. 相同 PTS tie-break = 原 sample index 小者；最近距离相同也选择原 sample index 小者，写成单测。
3. 随机 seek 在排序 PTS 中 lowerBound，比较左右邻居；保留当前目标容差和错误返回，不在性能 PR 改容差。
4. 顺播维护最近 PTS 游标，目标单调时局部推进；反向/跨段跳转回二分。
5. 关键帧 sample 索引也二分；保留解码队列、热态 GOP 喂入、输出帧寿命和驱动规避逻辑。
6. 原算法对异常 PTS 顺序的提前 break 不能当正确性金标准；使用“完整扫描、不提前退出”的 oracle 比较。

测试：108k samples、随机/递增/回退目标、B 帧非单调 CTS、负/重复 PTS、VFR、tie、最后一帧和范围外。比较次数断言随机 O(log N)，避免靠 CI 毫秒阈值判断。m3p4/m3p5 与像素/目标时间校验必跑。

### A04：IR 扫线与手势索引

**修改**：`rendering/ir.py`、`preview-session.ts`。
**新增**：`rendering/interval_index.py`、`tests/unit/test_render_ir_index.py`、`tests/preview-ir-patch.test.ts`。

Core：
1. 保留旧投影器为测试 oracle（从改动前版本提取测试模块，不在生产长期双跑）。
2. 主轨 regions 允许 overlap；旧语义是“倒序遍历首先命中”，新扫线 active 集必须选**原 regions 顺序最大的有效项**，不能简单只看 start 最大值。
3. 主轨端点保持 `[t0,t1)`；overlay/字幕保留当前包含 end 的行为。这些差异是兼容要求，不在优化中修正。
4. 为开始/结束时间生成有序事件；frame 时刻按原 t_exact_us 算法比较，维持稳定原始顺序输出 overlay/caption。
5. 索引在单次投影开始时建一次；转场 anchor 预先映射；不能在每帧创建索引。
6. 输出字段、known_approximations、顺序与浮点舍入一致，完整 IR 深比较；不改变 v1 协议。

Desktop：
1. create/replaceIr 后建立 clipId→overlay 引用列表。
2. 手势增加内部 `setPipGeometry(clipId, {cx,cy,w,h,rotation})`，每 move 最多一次索引遍历；不要再分别全表 setPipBox/setPipRotation。
3. rAF 合并几何变更；索引在 replaceIr 原子替换后重建，不保留旧帧引用。
4. 若单 clip 覆盖全部长项目仍耗时，第一轮记录剩余成本，B17/C20 再改 transient override；不声称索引让所有情形 O(1)。

验收：现有 IR 全部测试、随机密集 timeline 对 oracle；本次 15min/900clip/900caption 基准同机投影中位数目标≤350ms，未到目标必须解释 profile，不能删除输出内容。这个目标待 G0 冻结，不是跨机器硬门槛。

### A05：Core 后台执行与事件循环

**修改**：`projects.py`、`rendering/service.py`、`rendering/validation.py`、`app.py`、`state.py`、`config.py`、`bootstrap.py`（若冻结进程入口需要）。
**新增**：`aivs_core/background_work.py`、`tests/unit/test_background_work.py`。

分两个提交：

A05a（I/O）：
- 哈希与大文件复制使用专用 ThreadPoolExecutor，初始 max_workers=2，前置 semaphore 限制提交队列；不能只靠 executor 限线程而无限排队。
- 哈希分块检查取消令牌，计算前后比对 stat；变化时沿现有 MEDIA_CHANGED/域错误路径返回。
- 线程内打开/关闭自己的文件，不向线程传活动 SQLite connection；主逻辑完成结果校验后才写数据库。
- 对没有取消契约的 API，先保证不阻塞事件循环；明确不能强制终止已开始的系统调用。

A05b（IR CPU）：
- 先剖析 A04 之后 compile/project/序列化残余成本；IR 投影采用单独 spawn ProcessPoolExecutor，max_workers=1，最多一个运行+一个最新等待请求（作用域为相同项目/编辑器消费者）。
- 入参仅不可变 plan/probes/styles/version，不传 service、数据库连接、令牌、路径访问能力。
- 相同 fingerprint single-flight；不同 revision 不可串错。运行中旧计算可完成并丢弃，等待中的旧计算被替换；返回方按 request generation 忽略旧结果。
- 进程池取消 Future 不等于终止运行任务；不能把 token 提前归还。shutdown 等待有界并回收子进程。
- Windows 开发与 PyInstaller 模式分别验证 spawn/freeze_support，防止子进程重启整个 sidecar。若冻结支持未验证，不能默认启用进程模式；临时保留 A04 优化后的旧执行路径并披露 event-loop 指标不达标。
- compile 内若还有阻塞 I/O，单独重构不可变 snapshot 读取；不把整个有副作用的 service 方法盲目丢进进程。

验收：F02 投影/大文件哈希期间 `/health` 或等价无副作用探测请求保持响应，event-loop lag p95 目标<20ms；缓存同 key 20 并发只投影一次；关应用后无残留进程。最终 API 序列化是否仍阻塞单独测，不把 A05 视为完整解决。

### A06：Canvas 最小失效范围

**修改**：`timeline/TimelineCanvas.tsx`、`App.tsx`、`preview/SyntheticPreview.tsx`、`styles.css`。
**新增**：`timeline/TimelinePlayheadLayer.tsx`、`timeline/playhead-store.ts`、`tests/timeline-redraw.test.tsx`。

1. 所有 canvas 尺寸赋值前比较 backing width/height；相同尺寸不重置状态。
2. 将 drawTimeline 中播放头/游标线拆为单独绝对定位覆盖层，底层不再依赖 playheadUs；DOM 线/小 Canvas 二选一，第一轮默认 DOM transform，pointer-events:none。
3. PlayheadStore 在每编辑器实例创建，非全局单例：`getSnapshot/subscribe/set`，微秒为单位。预览每帧写轻量层；App 时间文本/外部状态仍10Hz。
4. 用户 seek 为独立 command，不与播放回传互相触发；支持 source="playback"|"user"|"external" 和递增 request ID，沿用暂停态精修。
5. assetMedia、mediaUrls、audioByClip、clip lookup Maps 用稳定依赖 useMemo；子组件 props 稳定后再 memo，不能只套 memo 但每次仍传新数组。
6. geometry/ticks 只随文档、视口、缩放变化；hover/播放头变化不重建全量几何。
7. 顶部固定 ruler、滚动条及拖动命中坐标保持现有逻辑；第一轮不同时改二维虚拟化。

验收：静态时间轴播放 10 秒，底层 draw 次数≤2（不包含真实素材加载/resize）；播放头连续刷新但每秒 App commit 不随 rAF 提升；现有 timeline interactions/geometry/filmstrip 全通过；1000 clip 的拖动/滚动 trace 对比。

### A07：重复探测缓存

**修改**：`media/encoders.py`、`media/ffprobe.py`、`rendering/service.py`。
**新增**：`tests/unit/test_media_probe_cache.py`；扩展 test_encoders/test_render_service_stage1c。

- probe cache key=asset fingerprint + stat(size,mtime_ns) + ffprobe build；相同任务的 segment probes 按唯一 input 生成，再映射回 segment 顺序。
- 初始 probe 并发≤2，缓存≤256条，TTL/字节后续纳入 B10；失败缓存短暂（如5秒），文件变化立即失效。
- 编码器可用性与 smoke cache 为进程内 session 缓存，key=FFmpeg build + encoder + test profile；single-flight，初始成功 TTL30分钟/失败30秒，重测入口明确。
- 渲染中编码失败清除此 encoder 的成功结果，保留现有软件回退；不因缓存跳过实际渲染错误判断。
- _toolchain 的 ffmpeg version 同 build 读取一次；不能缓存“最终输出文件验证成功”。

验收：900同源切段仅 probe一次；并发 choose同key只smoke一次；替换工具/素材后失效；缓存命中 preview reuse不触发多次编码探测。

### A08：轮询、缩略图和转录加载

**修改**：`App.tsx`、`timeline/TimelineCanvas.tsx`。
**新增**：`timeline/thumbnail-loader.ts`、`tests/thumbnail-loader.test.ts`、`tests/app-request-scheduling.test.tsx`。

- setInterval 改“上次请求结束后再 setTimeout”；同 endpoint single-flight。成功且内容未变不写大 state；不要每轮 JSON.stringify 整项目做昂贵比较，使用明确字段/version。
- 任务订阅优先，1.5s轮询保留为活跃任务兜底；无任务/后台窗口退避，模型列表只在模型事件或较低频刷新。前后台变化恢复一次刷新。
- loadProjectData 首先返回素材/任务/摘要，转录正文选中时加载；并发上限4，切项目 generation作废旧返回。
- 缩略图 loader 改组件/项目作用域 owner；请求含 owner、viewportEpoch、priority、assetKey、sourceTime、sizeBucket。
- 尚未开始的旧viewport任务取消，active任务最多一个；loadeddata/seeked超时初值5秒，finally无条件清监听器并继续队列。
- seek同currentTime时允许直接取当前已就绪帧，不能等待不会发生的seeked。
- 缩略图 key按 asset+source time+size+content generation 共享；完成回调按rAF批量通知；缓存维持条数上限并增加bytes记账。

验收：快速滚动/缩放50次无无界排队；坏媒体不堵住后续请求；卸载无state更新；网络/后端慢于1.5秒时同endpoint最多1在途；旧项目转录不写入新项目。

### G1：第一轮退出条件

A01–A08对应功能断言全部通过，F01无新增花屏/音频回归，F02 IR达到同机目标或有批准的例外；F03音频/视频仍全源读取的限制明确记录。G1不要求完成长素材内存硬上限，也不允许宣称已经完成。

## 6. 第二轮：长素材、内存和资源竞争

### 6.1 跨进程新增契约的统一规则

B10/B11/B14/B15/B16/C20新增API必须贯穿：
- `packages/contracts/src/performance.ts`（新增，导出类型+运行时校验）与 `src/index.ts`；
- `services/core/src/aivs_core/app.py` 和服务实现；
- `apps/desktop/electron/main/performance-ipc.ts`（新增，由main/index.ts注册）；
- `apps/desktop/electron/preload/index.ts` 的 DesktopApi与白名单；
- `apps/desktop/src/lib/core-client.ts`；必要时更新Renderer类型声明。

Core可在受控Main内部响应中返回本地派生路径，但Renderer presentation必须剥离，仅返回票据URL。拒绝Renderer传任意路径、任意URL、任意FFmpeg参数。所有请求校验project/asset归属、revision、范围、枚举与最大长度。

每个新增IPC至少有 contracts、preload白名单、main未授权/越权、Core API错误码四层测试；不只改TS interface。

### B10：派生媒体存储与缓存键

**新增服务文件**：`aivs_core/media/derived_cache.py`、`aivs_core/media/derived_service.py`。
**修改**：`database.py`、`config.py`、`state.py`及实际下一版本迁移模块；在项目现有迁移登记体系注册，不能只添加孤立SQL文件。

派生项类别：`video_proxy`、`waveform`、`audio_pcm_chunk`、后续 `reverse_chunk`。新类型不直接塞进旧表的受限CHECK枚举；本方案优先新增独立 `derived_media_cache` 表。

拟定表字段：
```text
cache_key TEXT PRIMARY KEY
asset_fingerprint TEXT NOT NULL
kind TEXT NOT NULL
params_json TEXT NOT NULL
schema_version INTEGER NOT NULL
toolchain_fingerprint TEXT NOT NULL
relative_path TEXT NOT NULL
size_bytes INTEGER NOT NULL
status TEXT NOT NULL       -- building/ready/failed
created_at TEXT NOT NULL
last_accessed_at TEXT NOT NULL
```

引用与权限：另外建立project/asset到cache_key的引用记录或查询映射；内容相同可物理去重，但授权必须由当前project/asset引用证明，不能“知道cache_key即可访问”。访问pin只做运行时lease，不依赖易过期的永久refcount。

CacheKey=SHA256(canonicalJSON({kind,assetFingerprint,algorithmVersion,params,toolchain}))；不包含绝对路径和短期票据。

目录：`data_dir/cache/derived/<kind>/<key前2位>/<key>/`；build写同目录临时文件，验证后原子rename为ready。SQL ready只能在文件发布后更新；启动恢复building残留，禁止将半文件作为命中。

清理：默认磁盘预算先设10GiB并可配置，LRU只清未pin派生项；保留至少2GiB可用空间，否则暂停新生成并提示。此值是初始工程策略，G0/G2可按磁盘规格调整；绝不能删原素材、项目、导出文件。Windows递归清理前必须resolve验证路径落在专属cache根内，拒绝symlink/reparse越界，使用同一PowerShell/本地API完成操作。

测试：损坏文件、断电半产物、并发同key一次生成、原片变更、无引用项GC、活动项pin、跨项目越权、磁盘满和迁移前后打开旧项目。

### B11：真正可用于长源的代理与源选择

**修改**：`media/render.py`、`jobs.py`、`rendering/service.py`、Desktop `App.tsx`/`preview-session.ts`/`ir.ts`。
**新增**：`media/proxy_profiles.py`、`preview/source-resolver.ts`、相关契约和测试。

注意：当前通用build_render_args默认duration为10秒，不能把现有sample/proxy任务默认值当完整源代理。

代理初始规范：
- `preview-540-v1`、`preview-720-v1`、`preview-1080-v1`，目标是短边档位，禁止上采样；保持旋转/SAR后的显示比例，编码宽高为偶数。
- MP4/AVC、yuv420p、faststart、CFR30（当前合成时间域为30fps）；GOP≤15帧，优先闭合GOP/无B帧以减少seek和兼容复杂度。
- 原源PTS零点/首显示帧/时长归一化规则固定；不能直接用avg_frame_rate重算原片frame index。
- 音频仍从原素材B15服务读取，视频代理初始可不含音频，避免代理AAC延迟混入播放声音时间基。
- 使用已验证的编码器专属参数：禁止给所有硬件encoder无条件传 `-preset veryfast`。不支持profile参数则软件回退；现有许可/分发约束不变。

新增语义接口（名称在契约Gate冻结后实施）：
```text
POST /api/v1/projects/{project}/assets/{asset}/preview-source
{ profile_id, mode: "auto"|"original"|"proxy" }
→ { source_id, status: "ready"|"pending"|"unavailable", job_id?,
    asset_fingerprint, profile_id, duration_us, source_origin_us,
    fps_num, fps_den, coded_width, coded_height }
```
Main为ready source换票据，Renderer拿到 `media_url`；source描述和IR逻辑geometry分离，不能因为代理像素变小改变PiP/裁切坐标。GL LOD使用真实解码宽，布局仍用逻辑geometry。

source时间映射：以原源微秒为权威，`proxyTimeUs = sourceTimeUs - source_origin_us`；误差门限见下一段。不得用src_n直接猜代理sample index。

模式：auto在原源可用且负载轻时允许原源；不支持容器/codec或超预算时请求代理。pending期间保留旧预览/交互回退并显示生成状态，不等待整个代理任务才让UI可操作。禁止强制对每次导入立即编码整段长源。

切档：只在pause/seek边界或新源预热完成后原子切换，递增binding generation、撤销旧在途请求；活跃帧不被提前回收。

验收：F03源末尾可播（不是只有前10秒）；VFR/旋转/SAR/非零起始PTS/60fps源正确；代理对原源选帧时间误差≤一个输出帧，转场/音画同步没有新增偏差。质量变化记录为代理降级，不混同原片质量基准。

### B12：MP4 Range demux，禁止伪流式

**修改**：`decode-worker.worker.ts`、`decode-worker.ts`、`restricted-media.ts`。
**新增**：`preview/bmff-demux.ts`、`preview/range-source.ts`、`tests/range-source.test.ts`、`tests/bmff-demux.test.ts`。

拟定接口：
```ts
interface RangeSource {
  readonly size: number;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  close(): void;
}
```

实施：
1. 拆离当前依赖整ArrayBuffer的demux；先读取顶层box header（8/16字节），按size跳到下一box，只读取moov metadata，不读整个mdat。moov在尾部也按box偏移定位，禁止字符串扫描整个媒体。
2. 支持64位box/co64时校验Number安全整数，box大小/深度/样本数量设上限；mdat size=0、fragmented MP4、edit list等不在支持集的明确回退代理，不冒充已支持。
3. 初始化请求可用 bytes=0-65535 获总长并复用数据；解析206/Content-Range，校验范围与返回字节数。服务忽略Range返回200时，大文件必须拒绝整文件下载并走代理/错误；小文件阈值可配置（初值16MiB）。
4. decode队列当前请求只从关键帧到目标所需sample区间读取；合并连续range，chunk初值1MiB，并发read≤2。缓存按byte LRU；不得把所有chunk拼回dataBytes长期保存。
5. 增加request epoch，seek替换时取消尚未消费range；陈旧返回只释放。原Worker顺序GOP feed和close规避逻辑保持。
6. 媒体票据当前有TTL；持续播放超5分钟必须支持受控续票（main验证entity/asset仍授权），401/403只允许有限一次刷新，重新发相同range；refresh不能改变source fingerprint。
7. 调整restricted-media HEAD/Range/流取消语义并测试：HEAD不打开读流，客户端abort销毁底层stream，suffix-range和越界正确返回；不借此放宽任意文件访问。

验收：F03只取末尾10秒时读取字节随目标GOP/窗口而非源总长增长；计数断言无整文件arrayBuffer，缓存不超过预算；完整从前播到尾不因票据过期失败。B帧、VFR目标PTS与A03oracle一致。

### B13：活跃输入与GPU资源预算

**修改**：`preview-session.ts`、`compositor-worker.ts`、`compositor-worker.worker.ts`、`decode-worker.ts`。
**新增**：`preview/resource-budget.ts`、`preview/input-pool.ts`、对应测试。

内存默认预算（应用缓存，不是OS总RSS硬上限；单位MiB）：

| 档位 | 压缩Range缓存（总） | PCM缓存（总） | 纹理估算（总） | 未激活解码器保温数 |
|---|---:|---:|---:|---:|
| conservative（未知内存/≤8GiB） | 64 | 64 | 128 | 1 |
| balanced（约16GiB） | 128 | 128 | 256 | 2 |
| high（≥32GiB，需实测） | 256 | 256 | 512 | 2 |

Main只传离散档位，不向Renderer暴露额外主机信息。不能仅凭navigator.deviceMemory决定独显显存；GPU未知时按保守策略。

状态：`cold→initializing→warm→active→idle→evicting→cold`；另有failed。active为当前帧/转场/同时overlay全部输入，不能把“最多2个解码器”误解为只显示2轨。资源紧张先缩预热、清idle、降代理/池深，仍无法满足active则明确回退/暂停并提示，不能静默删图层。

Worker协议新增 `registerInput(inputId,generation,geometry,ringDepth)`、`releaseInput(inputId,generation)`、ack。每个上传/compose引用generation+slot token；释放必须等待当前引用和上传完成或通过generation明确作废。删除GL texture时更新byte accounting和全部纹理集合，防止悬挂引用。

环深初值仍8；后续按预算在3–8调节，LEAD必须同步下降以避免写入覆盖尚未展示的槽位。影子转场槽单独记账。current/next窗口pin不能被LRU淘汰；缓存空间不足时请求必须排队/降级，不能超预算后才统计。

验收：浏览100素材后回到开头，idle资源可回收；同GPU档位F04显存估算保持预算内；同源双位置转场正确；释放过程中seek/replaceIr无texture use-after-free；30–60分钟工作集进入平台而非持续增长。

### B14：波形移出Renderer整音频解码

**新增**：`media/waveform.py`、`timeline/waveform-cache.ts`、Core/IPC接口。
**修改**：`TimelineCanvas.tsx`，移除生产fetch完整媒体→decodeAudioPeaks→主线程扫描链。

1. 后台FFmpeg输出固定采样率mono（初值8000Hz），采用streaming stdout处理；不得先读全部PCM。worker线程/进程计算每256 samples的min/max并逐级2倍汇总形成金字塔。
2. 保留min/max而不是只取一个正向peak；base覆盖全部原素材，key按asset fingerprint+algorithm参数。
3. 结果采用小header+Float32 min/max二进制块，经Main受控票据访问；Renderer依据可见原源区间和pixels选择LOD，每次响应建议≤256KiB。
4. clip显示映射必须使用source_start/end、speed与reverse；同源不同trim不能都画成同一个全源200peak图。
5. 可见区优先生成/加载，后台预算由B16接管；跨项目重用受B10权限限制。

测试：脉冲在已知采样位置、静音、单/双声道、不同时长裁切、2x/倒放、min/max聚合与reference一致；同源50clip一次构建；Renderer不再调用decodeAudioData生成波形。

### B15：分块PCM和流式worklet（必须分阶段接入）

**新增**：`media/audio_chunks.py`、`preview/audio-stream.ts`、`preview/pcm-chunk-cache.ts`。
**修改**：`preview-session.ts`、`varispeed-worklet.ts`、B10派生服务和IPC。

#### 数据契约

- 采样率初值48000、channels=2、f32le；每块有效区2秒（96000样本/声道）；块key用整数sample offset，不能浮点秒累加。
- 服务返回 `{source_id, generation, start_sample, valid_samples, channels, sample_rate, media_url}`。尾块长度精确，EOF显式标记。
- FFmpeg以输入粗定位+精确采样裁切/统一resample规则输出；保留AAC priming/非零PTS/边界预滚。不能直接把独立 `-ss 2 -t 2` 输出当天然无缝。
- 开发验证用整段同参数参考PCM，对相邻块拼接比较sample alignment与误差；未能证明无缝时先改成连续解码会话按块产出，不上线独立随机块方案。

#### worklet协议

沿现有set-buffer兼容新增模式：
```text
configure(sourceGeneration, sampleRate, channels)
appendChunk(sourceGeneration, startSample, validSamples, channels[])
play(positionSample, speed, playbackEpoch)
setSpeed(speed)
stop(playbackEpoch)
releaseBefore(sample)
→ needRange(startSample,endSample), underrun(count), consumed(range), drained(epoch)
```

- transfer的chunk为consumer副本/所有权独占；同源同时混音两个clip不能把同一ArrayBuffer transfer两次。
- 初始用MessagePort+transfer，不以SharedArrayBuffer/跨源隔离作为前置；将来单独论证SAB。
- worklet渲染回调不fetch、不阻塞、不await、不做无界分配；消息到达时填固定池，render只访问有界窗口。
- WSOLA保留window2048、delta240等算法语义；跨块提供至少window+delta的边缘数据，prevTail状态连续，不在每2秒重新play重置颗粒。
- 缺数据时明确补零/短淡出并累计underrun，保持时间语义可观测；是否暂停视频必须由session统一决策，不能音频线程私自倒退时钟。
- 以实际AudioContext.sampleRate换算时间；48k块与非48k context必须重采样或初始化时拒绝该路径并回退，不能按相同sample index播放变调。

#### 加载策略

当前音频位置前后窗口覆盖至少2秒播放时间，4x速度按源时间扩大需求；缓存按byte限制，全局同key single-flight。seek增加generation/epoch，旧块不能接入新位置；dispose清理所有port监听、在途生成引用。

A02整段模式只保留为**小素材**兼容回退（阈值初值30秒且预计PCM≤32MiB），长素材不能在流式失败时无条件退回GB级解码。长素材显示明确错误或切到能正确输出音频的既有交互预览，不静默无声。

验收：60分钟源只播10秒，PCM驻留不随源总长增长；2s块边界无新增点击/空洞；F07全通过；0.5x/2x音高沿用现有±3%测试门，额外人声/鼓点听感验收；streaming过程中4x/seek不会越界读取。听感门不能仅靠440Hz正弦替代。

### B16：优先级和资源配额，不承诺无代价抢占

**新增**：`aivs_core/job_scheduler.py`、`tests/unit/test_job_scheduler.py`。
**修改**：`jobs.py`、`state.py`、`app.py`、预览负载IPC。

任务描述由服务端kind→policy决定，Renderer不传任意优先级；用户显式后台导出优先级如要开放，另走产品契约。

初始资源：`cpuHeavy=1`、`gpuHeavy=1`、`diskHeavy=1`、`network=2`、轻量probe线程池2。多资源一次原子申请，禁止拿一个token等另一个造成死锁；unknown kind使用保守独占旧路径。

分级：
1. 已授权当前seek所需PCM/媒体块；
2. 用户主动权威预览/当前视口派生；
3. 当前项目代理/波形；
4. 导出/ASR/后台生成；
5. 预热和维护。

同级FIFO+aging；对同project/revision重复派生合并，不合并具有不同外传确认/目的路径的Provider或导出任务。

分两阶段：
- B16a先有界并发网络与轻量任务，CPU/GPU重任务仍单个；保留所有kind的状态机、special generation回调和batch recovery。
- B16b接收编辑器负载lease（playing/scrubbing/idle，Main注入window owner，TTL3s，每1s心跳）；无lease视idle，Renderer崩溃不会永久饿死任务。
- 播放时暂停新低优先GPU重任务入队执行，限制新FFmpeg线程参数；已运行不可抢占任务不能被“调整token”就自动降速。可取消的预热在阶段边界中断并重新排队；最终导出不强杀、不暗中重启。
- 若用户要求暂停导出，必须有显式UI/状态语义；本方案默认不实现无损导出暂停。
- PCM低延迟任务不能排在几分钟不可中断导出后：为其保留有界轻量CPU/IO服务容量；在集显资源不足档位，明确“播放优先：延后新导出/降低代理质量”策略。

测试：混合100任务无超token、无死锁、取消恰好释放一次、异常/retry不漏token、应用重启恢复和batch状态一致；unknown kind仍安全。F06测完整App，不仅检查scheduler单测。

### B17：时间轴二维可见区和精细状态

**修改**：`TimelineCanvas.tsx`、`geometry.ts`、`types.ts`、`App.tsx`、`styles.css`。
**新增**：`timeline/viewport-index.ts`、`timeline/render-cache.ts`和测试。

- DOM滚动空间可保持全内容尺寸，但Canvas backing仅覆盖viewport+小overscan；纵向scrollTop加入明确坐标变换，不能分配等于所有轨道高度的大位图。
- 四层：底图/轨道、clip缩略图与波形、选中/拖动叠加、播放头。dirty flags决定重画哪些层，rAF合帧。
- 区间索引按track检索可见clip/caption；overscan初值水平400CSS px、纵向2轨。命中/框选仍能处理自动滚动后跨视口选择，不能因为不画就丢文档元素。
- 静态层可按轨道/时间tile缓存，key=revision局部版本+scaleBucket+DPR+theme；先测需要再引入复杂tile，避免过度缓存。
- editing store只对订阅slice通知，保持undo/redo用权威timeline revision；不能把播放头写入可撤销文档。

验收：100轨、1000clip滚动时draw访问数量随可见元素增长；DPR1/1.5/2、缩放、自动边缘滚动、固定ruler、框选、trim、转场、字幕键帧所有现有交互测试通过。

### G2：退出条件

长源首帧不等待全文件；60分钟源PCM/压缩缓存/GPU估算遵守预算；同源多clip数据复用；F03–F07回归与30–60分钟压力证据齐全；代理/原片/不支持格式回退对用户可解释。预算只约束应用拥有的缓存，RSS/驱动内存另有实测曲线，不能用估算代替。

## 7. 第三轮：长时间轴、导出与受控实验

### C20：窗口化 IR v2，先消除全量传输，再做增量复用

**修改**：`services/core/src/aivs_core/rendering/ir.py`、`services/core/src/aivs_core/rendering/service.py`、`services/core/src/aivs_core/app.py`；Desktop Core client、预览 IPC、`preview-session.ts`、`SyntheticPreview.tsx`；B10 的性能契约模块。
**新增**：`services/core/src/aivs_core/rendering/ir_window.py`、`apps/desktop/src/app/preview/frame-source.ts`、`apps/desktop/tests/preview-ir-window.test.ts`、`services/core/tests/unit/test_render_ir_window.py`。

#### 契约和分层

保留 v1 endpoint 和响应；v2 使用独立、鉴权一致的 endpoint，不让同一路由静默改变 `frames` 形状。以下为拟定接口，必须在设计 Gate 冻结命名与运行时 validator 后实现：

```ts
interface PreviewIrManifestV2 {
  schema_version: "preview-ir-v2";
  manifest_id: string;        // 绑定 project/revision/output profile/toolchain
  timeline_revision_id: string;
  fps_num: number;
  fps_den: number;
  total_frames: number;
  window_frames: number;
  // inputs/styles/output/audio 的显式 DTO 沿用并规范化 v1，禁止系统路径。
}
interface PreviewIrWindowRequest {
  manifest_id: string;
  start_frame: number;        // 含，整数
  frame_count: number;        // 1..300；初值每窗150帧（30fps时5秒）
}
interface PreviewIrWindowV2 {
  manifest_id: string;
  start_frame: number;
  frames: PreviewFrame[];    // 复用当前单帧语义，不复制另一套 GL 指令体系
}
interface FrameSource {
  getFrame(frame: number): PreviewFrame | undefined;
  ensureRange(startFrame: number, endFrameExclusive: number,
              signal: AbortSignal): Promise<void>;
  dispose(): void;
}
```

这里 `PreviewFrame` 指当前帧结构的规范化类型，拟从现有 IR 定义提取，并非已存在同名导出。音频段/素材元数据如果本身过大，要分段索引或分页；不能只移除视频 frames，却在 manifest 中无上限塞入整项目媒体数据。

#### 实施次序

1. C20a：给 v1 加 `FrameSource` adapter。查找并替换所有 `ir.frames[n]`、`frames.length`、全量遍历依赖，包括 pump、seek、预热、PiP 手势和探针；先保持 v1 完全等价。
2. C20b：Core compile 一次生成不可变 manifest 和 A04 区间索引；投影窗口从绝对时间计算。窗口内首帧必须能恢复此前已激活的 region、字幕、转场和关键帧状态，不从零重放前面所有帧。
3. 按 `manifest_id + start_frame + count` single-flight；每窗最多300帧，并限制响应字节，超限返回明确错误/更小窗口指引，不允许任意客户端请求完整长项目。
4. Desktop 当前窗口必需、下一窗口预取；seek 优先当前目标，不先等从0开始的旧窗口。窗口缓存初值8MiB、同时最多2请求；按估算对象字节和实际序列化字节分别记账，不声称 JS 堆精确等于 JSON 大小。
5. 窗口未就绪进入显式 buffering，保持最后完整画面并协调音频时钟；不把缺帧当空白帧，也不让音频继续数秒而画面停住。旧 epoch 的响应可进入仍合法的共享缓存，但不能驱动当前播放。
6. C20c：先 revision 整体换 manifest，但 input 绑定未变时沿用会话/解码器；后续才做 dirty-range 复用。依赖指纹包括源片段映射、转场借用、字幕样式、输出规格和相关关键帧。
7. 移动/trim/变速可能使后续时间整体位移，dirty 区间必须覆盖受影响的后继；全局样式/画幅变化可使全部窗口失效。无法证明未变时就重算，不猜测复用。
8. 拖动中的 PiP box/rotation 用 session 的规范化局部 override；提交 revision 后清除或重基 override。GL Worker 仍不接管时间轴语义，禁止继续扫描整项目补丁帧数组。
9. 只有 v2 的时长、帧数、整数边界、资源压力通过后才提高长项目限制。v1 保留27000帧限制；v2失败且项目超出v1容量时显示能力限制，不偷偷截断或强行回退v1。

**测试/验收**：随机窗口拼接与v1逐帧深度相等（在v1支持范围）；窗口边界的字幕 inclusive end、转场首尾、空隙、PiP关键帧；连续100次seek/revision切换无旧帧安装。新增60分钟时间轴夹具，首窗耗时/字节不随总帧数线性增长，输入和区间索引成本单列；跨窗播放至少30分钟无周期性卡顿。禁止只测Core投影而遗漏IPC/JSON parse。

### C21：导出深定位，保持输入时间语义

**修改**：`services/core/src/aivs_core/rendering/ffmpeg.py`、`services/core/src/aivs_core/rendering/plan.py`、`services/core/src/aivs_core/rendering/service.py`。
**新增**：`services/core/src/aivs_core/rendering/input_window.py`、`services/core/tests/unit/test_render_input_window.py`、`services/core/tests/integration/test_render_seek_parity.py`。

问题是每段独立 `-i` 后通过filter trim读取深处区间；第一步优化不等于“所有同源段合成一个输入”。共享输入再split可能因消费者时间距离很远而产生大量缓存，须独立实验。

#### C21a：建立输入窗口规划器和等价性实验

每个实际FFmpeg输入生成 `InputWindow`：asset、流索引、源区间、前后转场借用、粗定位时间、输入时间原点、视频/音频精裁边界、eligibility/fallback reason。单位统一整数微秒，FFmpeg边界只在最终组装时转秒字符串。

- 初次仅放行：本地可seek、时间戳/时基可解释、正向1x、无转场/倒放/复杂时域滤镜的普通主轨视频。其余走旧参数图；不要因主轨合格误把PiP输入一起切换。
- 先从ffprobe得到容器start_time和流时间基准，建立“源时间→输入定位→解码输出PTS→精裁”的测试模型。
- 比较 input `-ss` 的准确定位行为、时间戳归零行为与保留时间戳方案后只保留一种验证通过的组合。**不能简单加 `-ss=start` 后仍用旧 `trim=start`，也不能未经验证把所有trim都减start。**
- 长GOP准确定位仍需从此前关键帧解码；是否额外留preroll由实测和编解码器行为决定，不能硬编码“一秒必够”。
- 视频与音频使用相同源窗口和独立流原点校正；AAC priming、非零/负start_time、VFR、B帧、旋转元数据和缺音轨都必须覆盖。无法解释时间戳的媒体明确fallback。

#### C21b：接入和扩展

1. 先纯 planner 单测，旧 `build_timeline_args` 可强制走legacy。
2. 只在合格输入前插入粗定位参数并调整其精裁坐标；输出全局timeline、黑场、字幕ASS、fps与音频padding保持不变。
3. 对F03末尾10秒比较“解码源帧数量/编码阶段耗时”，不把probe缓存命中混成深定位收益。
4. 正向变速、转场和PiP分别扩展eligibility，并分别补golden。转场窗口必须包括借用的源帧，裁剪结束也不能截掉尾部转场。
5. 如需输入 `-t`，必须包含合法借用、滤镜延迟及音频尾部；未证明前不加过紧读取终止。
6. 不对失败输出无条件多次重跑。规划器判不支持→旧图；优化路径运行失败→记录原因、仅一次legacy回退，和现有编码器候选重试统一管理，防止乘法重试。

**正确性门**：先用确定性无损/测试解码帧序列验证帧身份和时间映射，再比较正常交付编码的画质，不要求NVENC等硬编成品文件哈希相等。定位误差不得比旧正确路径新增一帧；若旧路径本身有错，另立correctness修复，不把错行为伪装性能基线。导出时长沿用现有校验上限83334µs，不借性能改动放宽。音频有效区间和A/V偏差必须保持既有标准，新增帧/样本级边界验证。

**性能门**：F03末尾片段的源解码量相对旧图减少≥80%作为初始目标，最终以G0夹具冻结；短片导出总耗时不显著退化。若滤镜/编码才是主耗时，报告分阶段收益，不承诺总耗时同幅度下降。

### C22：可取消的全量校验和诚实的阶段进度

**修改**：`services/core/src/aivs_core/rendering/validation.py`、`services/core/src/aivs_core/rendering/ffmpeg.py`、`services/core/src/aivs_core/rendering/service.py`、`services/core/src/aivs_core/jobs.py`，任务DTO与导出UI。
**新增**：`services/core/tests/unit/test_render_cancel_validation.py`；扩展既有 `test_render_validation_stage1c.py` / `test_render_service_stage1c.py`。

1. `validate_rendered_media` 增加显式 `cancel_event`、阶段回调；向ffprobe、full decode、哈希传递。保留“编码规格→时长→完整decode→SHA→发布”的全部校验，不改为抽帧冒充完整性验证。
2. `decode_validate` 改为可取消子进程执行器，复用现有进程树终止策略；同时消费stdout progress和stderr，所有完成/超时/取消路径都await进程回收。
3. stderr在读取时用有界ring保留末尾32KiB，而非先 `.read()` 整段再切片。所有FFmpeg长任务统一排查同类模式。
4. 超时拆为：启动无响应、进度停滞、绝对上限。初始停滞门120s；绝对上限用 `max(300s, 5×媒体时长秒)` 的可配置策略起步，G0按慢盘/代表CPU复核。定期收到日志不算媒体进度，优先跟踪out_time/处理帧；无法提供进度时采用保守明确的wall timeout，不能假装实现stall检测。
5. 文件哈希使用A05受限线程池，按1–4MiB块检查线程可见取消信号；取消Future并不终止线程，调用方须等待合作退出，不允许后台继续写最终状态。
6. 任务细阶段：`preparing / encoding / validating_probe / validating_decode / hashing / publishing`。保留旧stage兼容映射，通过可选 `phase` 和 `phase_progress` 扩展；未知phase的旧UI仍能显示通用状态。
7. phase_progress按编码输出时间、校验解码时间、哈希字节计算；不准确的准备/发布显示不定进度。总体百分比若使用历史权重，标为估计并保持单调；100%仅在发布及记录完成后出现。
8. 取消在“发布提交点”前必须阻止新成品出现；到达提交点后进入短不可取消的finalizing临界区，UI说明正在完成，完成后不能把成功文件标成已取消。
9. 文件rename与DB事务不是一个原子事务：沿用并检查现有orphan恢复机制，为“rename成功DB失败/崩溃”补恢复测试。跨卷输出不能假定 `os.replace` 有效；如已有支持不足，列为单独的发布正确性修复，采用目标目录同卷临时文件+完整校验/哈希策略后原子rename，禁止直接破坏旧目标。
10. cancel/timeout区分错误码；取消不触发换编码器重跑。记录用户取消至进程终止/线程退出延迟，不只测UI消失。

**验收**：编码、probe、decode、hash、发布前各阶段取消；120s以上的有效长输出校验不再因固定总120s误判失败；损坏末尾依然失败；stderr洪泛内存有界；慢盘、无进度进程、FFmpeg子进程树、磁盘满、目标冲突、DB提交失败、重启恢复全部覆盖。正常I/O夹具取消≤2秒为目标，进程树强制回收≤5秒；不可中断的系统I/O例外必须记录并提示，不能宣称绝对保证。

### C23：长区间倒放的分块方案——正确性实验通过再上线

**修改**：rendering输入窗口/FFmpeg规划器、B10派生缓存、B16调度。
**新增**：`services/core/src/aivs_core/rendering/reverse_chunks.py`、`services/core/tests/integration/test_reverse_chunks_real.py`。

现有 `reverse` 需缓存区间帧，长源不能仅通过增加机器内存解决。第一版只支持可证明边界正确的CFR视频倒放；音频沿用现有倒放片段处理语义，不顺带“新增倒放音频”。

1. 按C21源时间窗口解码，依据**解码后真实帧身份和PTS**划分半开区间；每块内部逆序，块顺序也逆序。不能按容器sample下标直接反喂压缩数据。
2. 块长由内存预算和实测像素格式计算，初值最多2秒；4K原始帧预算可能只允许更短块。固定“两秒一定安全”不成立，超预算应缩块。
3. 缓存key包含源fingerprint、源区间、帧率/时基、变速顺序、rotation/pixel/color规则、算法版本及必要toolchain，不含字幕/下游滤镜除非缓存的确已烘焙它们。
4. 优先实验无损中间视频或有界原始帧流。无损缓存会增加磁盘和IO，必须与内存收益一起报告；磁盘预算不够时明确失败/限制，不无限落盘。
5. 有损代理只用于允许降质的预览；最终导出不得静默反复有损转码。最终导出如无法在可接受IO下保持画质，此项维持关闭并保留区间限制说明。
6. 变速在倒放前还是后必须沿用现有语义；边界的fps取整、转场借用、末尾不足整块、VFR都逐类验证后放行。
7. 缓存ready前原子发布、失败临时清理、同key去重、取消释放与引用pin沿用B10；最终导出缓存未命中进入显式准备阶段，不伪装卡在0%。

**验收**：逐帧编号夹具跨2秒边界无重帧/漏帧，时长与旧正确结果一致；短区间与legacy逐帧比较；长倒放峰值驻留随块预算而非源区间长度增长；同时给出磁盘占用和总耗时，不接受“省内存但磁盘无上限”。

### C24：GPU滤镜仅是条件实验，不是默认第三轮必交大重构

**进入条件**：分阶段profile证明CPU decode/filter占导出主要时间，并且目标硬件支持拟用路径。仅发现“使用硬件编码器”不代表滤镜已在GPU，也不代表整体慢由滤镜造成。

**修改范围**：优先新增独立实验图生成器 `services/core/src/aivs_core/rendering/gpu_pipeline.py` 与硬件能力探针；现有CPU图保持默认。

- 第一组只做可控的scale/format及简单合成子集；按NVENC/QSV/AMF等设备实际能力分别验证，不把一种驱动结果推广所有Windows机器。
- 画出每段CPU↔GPU上传/下载边界并计时；ASS字幕、mask、chroma、转场和复杂色彩如需反复回CPU，比较是否净收益为负。
- 对每个放行的filter组合建立能力表和显式fallback；字体布局、alpha、色域/范围、旋转和采样差异须golden覆盖。
- shader编译/驱动初始化耗时与热态吞吐分开。播放同时导出若争抢同GPU更卡，即使单独导出快也不得作为播放优先默认。
- 错误/不支持回CPU整条已验证图，不混搭未知状态；重试次数仍受C21统一预算约束。

**结论允许是“不上线”**。通过条件为相同质量的代表负载总导出耗时中位数改善≥20%（G0可调整并冻结），F06播放无显著退化，驱动矩阵齐全；否则只保留实验报告，不增加长期默认路径维护成本。

### G3：退出条件

C20/C21/C22的正确性、资源和故障测试通过，跨层契约兼容和回退验证齐全。C23/C24按“已放行子集/实验未通过/不实施及理由”明确结项；不能以实验尚未做完就无限扩充本阶段。允许不启用实验项，但不能把未实现项标为性能收益。

## 8. 统一验收矩阵：性能门与正确性门分开

以下数值是**拟定工程目标，非本次实测结论**。G0以代表机/夹具冻结后才作为Gate门槛；不能事后为了让变更过关随意改阈值。硬件不足时分档并披露，不删除困难场景。

| 场景/指标 | 建议门槛 | 证据和责任项 |
|---|---|---|
| 正确性与权限 | 现有回归无新增失败；旧revision/票据不得跨项目复用 | 全轮；独立review |
| 性能探针开销 | 中位数<3%，无逐帧IPC/log | B00开/关对照 |
| 拖动/缩放输入至下一次绘制提交 | p95≤50ms，p99≤100ms；真实呈现另测 | A06/B17，完整App、DPR矩阵 |
| 30fps代理稳态播放 | unique有效帧覆盖≥99%，单次非用户触发freeze≤100ms；seek/buffering窗口单列 | B11/B13/B15，5分钟F01/F04 |
| 热态seek至目标帧提交 | 720档p95≤150ms；冷代理首帧另列，目标≤500ms | B12/B13，100随机seek；不含首次生成代理 |
| 短项目不回退 | 耗时类中位数和p95退化≤10%；超噪声时追加测量再判定 | 每轮同机5次，对照基线 |
| 密集IR纯投影 | F02由约2701ms向≤350ms优化；不得混用较宽松新夹具 | A04，旧脚本可复算，G0复测冻结 |
| 窗口化IR | 请求帧上限300，预取有界；首窗不扫描全部时间帧 | C20计数+端到端耗时 |
| 长源读取 | 首帧前不读全mdat；60分钟源的PCM缓存不按总长分配 | B12/B15计数、网络/磁盘字节 |
| 稳态内存 | 应用缓存守预算；预热后同一循环第10至30分钟RSS增长≤10%且无持续正斜率 | B13/B15；30–60分钟曲线及对象计数；驱动延迟回收单列 |
| 退出/切项目 | dispose后应用持有worker/pending/VideoFrame/音频node计数回基线；无不可解释增长 | A01及每个后续异步模块 |
| 播放+后台任务 | 相对同场景仅播放，p95提交延迟增幅≤20%，同时保留绝对交互门；不能长期饿死后台 | B16/F06，真实负载与模拟分别报告 |
| 深定位 | F03末尾10秒源解码量减少目标≥80%，保持帧/音频边界 | C21，阶段耗时和legacy对照 |
| 取消 | 正常I/O下≤2秒响应、≤5秒进程树回收目标，无误发布 | C22故障注入 |
| 画质/音频 | 先帧/样本边界和布局等价，再约定各编码器质量阈值；不以平均PSNR掩盖黑帧 | C21/C23/C24，差异帧+音频听测 |

对于UI 60Hz目标，16.7ms是显示帧预算，不要求视频素材从30fps变60fps。原视频重复帧、变速预期重复与真正漏帧必须分开统计；绝不通过简单提高rAF计数宣称播放达标。p95/p99取样窗口、启动阶段、主动seek排除规则写进结果JSON，保留原始事件摘要可追溯。

### 8.1 必跑故障矩阵

- 生命周期：快速切项目、关闭窗口、Core重启、worker崩溃、WebGL context lost、票据过期。
- 媒体：无音轨、损坏MP4、moov尾部、错误Range响应、长GOP、VFR、B帧、非零/负起始PTS、同源不同剪辑区间。
- 资源：低磁盘、缓存过期/被清理、内存档位不足、GPU不可用、FFmpeg卡死、stderr持续输出。
- 一致性：旧revision结果迟到、并发申请同key、缓存原子rename与DB提交之间崩溃、取消与任务完成竞争。
- 安全：跨项目asset ID、恶意相对路径/符号链接或reparse point、伪造priority/cache key、越界Range/PCM索引、临时票据不能持久化。

## 9. 执行命令与证据目录

### 9.1 开工检查

在 `C:\DataFolder\codes\AI-Vidio` 执行；检查实际HEAD、AGENTS、工作区变更和依赖是否就绪。不要覆盖本地未提交文件、不要自动下载大模型/访问真实Provider。依赖缺失先报告并获得安装所需授权。

```powershell
Set-Location -LiteralPath 'C:\DataFolder\codes\AI-Vidio'
git status --short
git rev-parse HEAD
node --version
pnpm --version
.\.venv\Scripts\python.exe --version
```

本方案参考项目声明Node24、pnpm10.12.1和Python≥3.12且<3.14；性能比较需保持同一版本，不在同一个性能PR顺带升级运行时。

### 9.2 已存在的回归入口

以下命令依据当前package scripts/pytest配置，不表示本轮已经执行。先看测试配置的隔离目录和外部依赖；涉及本机FFmpeg/GPU的集成项在授权测试环境运行。

```powershell
# 仓库根目录：契约、静态检查、Desktop单测与构建
pnpm contracts:generate
pnpm typecheck
pnpm test
pnpm build

# Core局部基线；每个修改单还要加本单新增测试
.\.venv\Scripts\python.exe -m pytest services/core/tests/unit/test_render_ir.py services/core/tests/unit/test_encoders.py services/core/tests/unit/test_jobs.py services/core/tests/unit/test_render_ass_ffmpeg_stage1c.py -q

# 阶段Gate的Core单测；确认夹具隔离、依赖就绪后执行
.\.venv\Scripts\python.exe -m pytest services/core/tests/unit -m 'not real_provider' -q

# Desktop局部回归
Push-Location -LiteralPath 'C:\DataFolder\codes\AI-Vidio\apps\desktop'
try {
    node node_modules/vitest/vitest.mjs run tests/timeline-geometry.test.ts tests/timeline-filmstrip.test.ts tests/varispeed-worklet.test.ts tests/restricted-media.test.ts
} finally {
    Pop-Location
}
```

真实媒体集成用例优先选 `test_preview_ir_api.py`、`test_stage1c_render_real.py`、`test_pip_render_real.py`、`test_transform_render_real.py`、`test_mask_render_real.py`、`test_chroma_render_real.py`，具体前置见文件；存在于 `services/core/tests/integration`。不能跳过后写“全套通过”。E2E用 `pnpm test:e2e`，保持单worker与隔离sidecar。性能E2E新增后可按文件过滤执行，不能拿测试mock结果代替GPU实测。

A05的Windows冻结进程spawn验证必须另设受控构建Gate，检查PyInstaller入口与worker无递归拉起；这不是默认执行完整安装包发布的授权。不要自动调用 `package:win`、真实Provider脚本或操作用户DB。

### 9.3 B00拟新增的统一性能入口

以下脚本**尚待B00实现**；为避免后续接口各自发明，推荐冻结为：

```powershell
.\.venv\Scripts\python.exe tools/performance/make_fixtures.py --output evidence/performance/fixtures --seed 20260908
node tools/performance/run_editor_benchmark.mjs --scenarios F01,F02,F03,F04,F05,F06,F07 --fixtures evidence/performance/fixtures --output evidence/performance/candidate --runs 5 --seeks 100
.\.venv\Scripts\python.exe tools/performance/compare_results.py --baseline evidence/performance/baseline --candidate evidence/performance/candidate --output evidence/performance/comparison.md
```

fixture生成器须检查FFmpeg可用性、目标目录所有权与可用空间，按场景选择性生成长源；不得每次CI生成大批4K一小时素材。单测用小合成夹具，性能机用固定大夹具。提供 `--scenarios` 选择性生成参数，记录种子和媒体SHA；bench不得把独立probe冒充完整App。比较脚本遇到硬件/场景参数不一致必须拒绝百分比Gate判定。

历史脚本 `evidence/performance-2026-09-08/benchmark_ir.py` 会写同目录 `ir-benchmark.json`。历史证据保持不变；后续benchmark应迁移逻辑至tools并显式指定新输出，或在隔离checkout中复跑，不直接覆盖旧证据。

每个修改单证据至少包含：

```text
evidence/performance/<commit-or-working-tree-id>/<work-item>/
  environment.json       # runtime/driver/fixture/profiles/flags/dirty patch ID
  before.json
  after.json
  tests.txt              # 命令、退出码、通过/失败/跳过及原因
  comparison.md          # 分阶段数据、正确性、资源、回退结论
  trace-manifest.json    # trace/媒体差异等大文件的位置和摘要，不含用户数据
```

长素材、trace和视频差异产物先检查仓库策略与大小；不自动把GB级二进制提交Git。工作树有未提交改动时不能只标HEAD，必须记录补丁摘要或内容标识以保证复现。

## 10. 开关、兼容、灰度与回退

### 10.1 集中配置，不散落临时布尔值

拟新增Core/ Desktop性能配置模块，Main读取受控配置并下发只读snapshot；Renderer无任意Core参数写权限。每份性能证据记录全量有效配置和版本。

- A类等价性修复：测试oracle/旧路径只在测试保留；生产长期维护双算法仅限风险较大的IR后台执行，Gate后决定移除。
- 跨层开关组：`derivedMediaV1`、`rangeDecodeV1`、`activeInputPoolV1`、`streamingAudioV1`、`resourceSchedulerV1`、`timelineLayersV1`、`previewIrV2`、`exportInputSeekV1`、`reverseChunksV1`、`gpuFiltersExperimental`。这些是拟定名称，不是现有环境变量。
- 开关依赖显式验证：active pool依赖有效source resolver和Range能力；streamingAudio依赖PCM服务/契约；IRv2依赖manifest/window能力。非法组合启动时拒绝/降级并说明，不能靠运行时随机失败。
- 同一App/Core版本能力握手后启用；旧Core没有新endpoint时保持兼容路径，不把所有404解释为素材不存在。
- 只回退失败模块。GPU上传失败使用已有copy路径；Range不支持→合格代理/既有交互预览；长音频流失败不退整源巨型解码；超v1时长不退截断v1；深定位失败使用一次旧输入图。
- 开关切换在会话重建/任务创建边界生效，单次导出中途不混用两种图；紧急关闭不强杀正在发布成品的任务。

### 10.2 每项发布顺序

1. 本地强制old/new对照，正确性先行。
2. 开发/内部测试默认关闭的新路径按场景开启，收集同机指标与故障结果。
3. Gate批准后只对能力满足的档位默认开启，提供明确降级原因。
4. 经过完整压力与回退测试再考虑删除旧实现；不在同一PR同时引入新链路并删除唯一回退。

### 10.3 数据回退

B10追加表对旧版本可忽略；不回滚删除用户数据库列/表，不改现有素材引用为“只能指向代理”。缓存算法版本提升生成新key，旧缓存按预算逐步回收；回退版本无法识别新cache kind时忽略即可。清理工具只操作已经验证归属的派生缓存目录，绝不递归清理计算出的未验证路径。

触发停止推广：错帧/漏音/跨项目数据暴露任何一例；资源持续无界；p95退化超门槛且复测成立；取消错误发布；能力fallback陷入重试循环。记录case、开关、输入指纹，回退最小模块后再修，不通过调整指标统计范围隐藏失败。

## 11. 后续实施者的工作单模板与完成定义

复制以下模板到每个PR/实施记录，保持一单一目标：

```text
修改单：Axx/Bxx/Cxx
基线HEAD / 工作树标识：
目标与不修改范围：
实际修改文件（绝对路径）：
前置Gate与接口版本：
算法/状态机变化：
授权、取消、资源所有权、缓存失效规则：
新增/修改测试与命令：
功能回归结果（含跳过）：
before / after / 同机环境：
质量与失败路径验证：
开关、兼容与回退验证：
已知限制、未解决问题：
开发者自测：
独立Reviewer结论：待验收 / 通过 / 不通过
Gate决策与下一步：
```

### 第一张实际开工单

先做 **B00**：在当前完整App里补观测和可复跑夹具，保持行为不变，冻结G0。随后 **A01 → A02 → A03 → A04 → A05 → A06 → A07 → A08**，每项独立回归和审查，不“一次性实现第一轮再测”。

第一轮结束先复测，再确认第二轮瓶颈排序。B10是跨模块基础，B11/B12/B15是长素材关键；B16从保守调度起步，不能先粗暴加并发。第三轮C20解决长项目帧数据，C21/C22解决导出低效及取消，C23/C24只在证据支持时推进。

### 本方案文档状态

本次交付是实施设计，不是实施完成报告。未执行这里拟新增的测试/benchmark，未宣称达到性能目标，未取得独立Gate批准。上一份评估中的局部测试与纯IR样本仅用于定位和起始参考，不能替代G0完整App基线。任何与后续实际HEAD不一致的文件/接口，开工时先校准方案并记录差异，再改代码。


## 12. 用户批准的推进规则调整（2026-09-08）

本节覆盖前文“必须完整 G0 后才允许 A01 编码”的顺序约束，不改变最终验收要求。
用户已批准：先本地提交当前 B00 基线，再逐项推进后续编码，不推送。

- B00-A：可复跑完整 App 诊断入口与短测，作为低风险编码起点；当前具备基础，非原 G0 通过。
- B00-B：完整 F01–F07、正式重复采样、长测、探针开销与独立评审，仍待完成。
- 每项实现独立限定范围、测试、更新报告并本地提交后，再进入下一项；不夹带无关变更。
- 分别标记“代码完成／功能验证完成／性能验证待完成”，不能以冒烟替代长测或独立 Gate。
- 生命周期、缓存、解码队列等高风险修改可先开发，但长期稳定性未验证前不认定可发布。
- 保存修改前提交与原始证据；证据保持实际运行时指纹，不倒填提交 SHA。
- 正式基准不与构建、其他测试或重负载并行，冷缓存/恢复启动分别解释。
- 本规则适用于后续阶段推进；单执行者自检不冒充独立审查，未完成验收不标为通过。
