# C20 第二阶段(Renderer v2 数据面)Planning Gate 提案(2026-09-11)

- 角色:LiuWei(Architect)提案 → 待 ZhangSan/YeJing 设计评审 → LiuKeAi 验收
- 依据:`docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 7 节 C20
  (实施次序 3–9)、`docs/PERFORMANCE_C20_IMPLEMENTATION_2026-09-10.md`
  (C20a+b 已交付)、B00 G0 基线实测(`docs/PERFORMANCE_B00_G0_BASELINE_2026-09-11.md`)。

## 1. 实测驱动的立项依据(G0 数据)

| 实测事实 | 对 C20 第二阶段的含义 |
|---|---|
| F02(27000 帧 v1 全量)Tab 工作集峰值 16,706MiB(≈16.3GiB),40 分钟无回落 | v1 全量帧表驻留 Renderer 是首要内存事实;v2 窗口化的直接目标场景 |
| F03 播放段 decode:compose ≈ 121.6:1(逐帧重解码) | 与帧表无关(解码侧),**不在本阶段范围**;防止范围蔓延 |
| F04 合成 submitted p95 16.1ms(4 层) | 合成路径问题(Worker/GL),**不在本阶段范围**(C20c/B17 层) |
| F02 ready 5.8s、F01/F06 ready 2.3–2.4s | v1 首屏传输在 900s 项目已可感知;27000 帧(F02 上限)传输量随帧线性增长,v2 manifest+首窗后首屏不随总帧数增长 |
| v2 端点/契约/IPC 四层已交付,Renderer 零调用方 | 数据面接入是让 v2 产生实际收益的唯一路径 |

结论:**立项成立**。核心目标 = Renderer 帧消费切到 v2 窗口协议,
消除全量帧表的 Renderer 驻留与全量传输;预期收益:F02 类长项目 Tab
工作集从 16.3GiB 降至窗口缓存上界(初值 8MiB 帧缓存 + IR 元数据),
首屏就绪不随总帧数线性增长。

## 2. 范围(本阶段做)

1. **windowedFrameSource**(新,`frame-source.ts`):实现既有 FrameSource
   接口(计划次序 4–5):
   - 构造输入:manifest(getPreviewIrV2Manifest)、window 取数函数
     (getPreviewIrV2Window)、窗口参数(每窗 300 帧,对齐 Core 硬上限)。
   - LRU 窗口缓存:初值 8MiB(按帧对象估算字节记账,计划明示不声称
     JS 堆精确等于 JSON 大小),同时最多 2 个在途窗口请求(single-flight
     按 manifest_id+start_frame+count 键)。
   - ensureRange(start,end,signal):当前窗口必需 + 下一窗口预取;
     seek 优先当前目标(不为从 0 起的旧窗口排队)。
   - getFrame 未就绪返回 undefined(接口既有语义);**不伪造空帧**。
   - **对象引用稳定性**:同帧同对象(缓存内),直至该窗口被 LRU 逐出;
     逐出窗口的帧对象冻结为只读快照语义——PiP 手势仅操作当前帧
     (见 3.2 约束)。
   - manifest_id 不匹配的窗口响应丢弃(不进入当前会话)。
2. **buffering 显式态**(计划次序 5):窗口未就绪时保持最后完整画面
   (合成侧已天然保持——getFrame undefined 时 compose 跳过),新增
   buffering 状态上报(SyntheticPreview 预览状态扩展),音频时钟与画面
   的协调维持现状(音频按墙钟独立推进,已有行为)。
3. **SyntheticPreview 切换 + 开关**:`previewIrV2` 开关组(默认 off;
   测试/基准环境显式开启)——on 时 getPreviewIrV2Manifest →
   windowedFrameSource → PreviewSession;off 时 v1 路径逐字节不变。
   首屏只取首窗(+预取窗),不再等全量。
4. **piP 索引窗口化**(前置小改,见 3.2):`rebuildPipOverlayIndex`
   从"全帧扫描"改为"按已就绪窗口增量构建"——v2 下全帧扫描不可能
   (帧表不在场);手势语义以当前活跃窗口为准。
5. **测试**:windowedFrameSource 单测(缓存命中/LRU 逐出/single-flight/
   manifest_id 失配丢弃/abort 语义/引用稳定性);SyntheticPreview 开关
   路径测试(off=v1 不变,on=v2 建链);契约层已有校验器复用。

## 3. 边界与约束(不做,防蔓延)

1. **C20c(revision 换 manifest 沿用会话、dirty-range 复用)不做**——
   v2 下 revision 变更 = 新 manifest_id = 重建帧源(会话沿用判定仍走
   v1 输入 sig 路径,行为与现状一致);C20c 依赖本阶段实测数据再立项。
2. **PiP 手势只在当前窗口语义**:手势期间拖动的帧在缓存内,对象可变;
   窗口被逐出后手势提交已完成(交互秒级 << LRU 8MiB 窗口存活时间),
   不做跨窗口手势补偿。计划次序 8 的"session 规范化局部 override"
   维持现状(A04 已交付的 setPipGeometry 路径)。
3. **Core 侧增量投影不做**——首次 manifest 请求仍全量投影一次(缓存层
   语义,C20a/b 报告已诚实登记);本阶段收益在传输与 Renderer 驻留,
   不在 Core 首投影耗时。增量投影(C20b 完整形态)按本阶段实测再立项。
4. **27000 帧上限不抬高**(计划次序 9:时长/帧数/整数边界/资源压力
   通过后才提高;本阶段正是"通过"的取证阶段,不先抬)。
5. **音频、解码、GL、B13 输入池路径零改动**——帧表只是合成需求的
   静态描述,解码供给机制不受帧表来源影响。
6. **v1 路径不删**——开关默认 off;v2 故障时明确回退 v1(能力限制提示),
   不偷偷截断(计划次序 9)。

## 4. 灰度与回退

- 开关:`previewIrV2`(env/构建常量,默认 off;B00 harness F 场景可
  显式开启做 A/B)。
- 回退:关开关即回 v1(v1 路径零改动是回归断言);代码回退 = revert。

## 5. 验收(设计 Gate 后冻结)

1. 随机窗口序列装配的帧表与 v1 全量逐帧深相等(复用 C20b 的构造性
   等价语义,Renderer 侧再加窗口边界/逐出后重取等价断言)。
2. v2 on:F02 场景 ready_ms 不随总帧数线性增长(27000 帧 ready ≤ v1 的
   5.8s × 显著系数,目标 <2s);Tab 工作集峰值显著低于 16.3GiB(目标
   <2GiB,由窗口缓存上界决定);播放/seek 指标不显著退化(p95 增幅
   ≤20%,对齐 F06 门)。
3. v2 off:G0 七场景基线复测与 `g0-baseline-20260911-v2` 中位一致
   (±5%)。
4. 连续 100 次 seek / revision 切换无旧帧安装;跨窗播放 30 分钟无
   周期性卡顿(计划验收原文)。

## 6. Gate 决策请求

- 批准范围(第 2 节)与边界(第 3 节);
- 验收目标数值(第 5.2 节)作为工程目标冻结(非跨机器硬门槛);
- Owner:YeJing(Renderer/开关/测试)+ ZhangSan(契约/Core 配合);
  复杂度:中–大。

**决策(自评,待独立复核):批准进入设计 Gate。** 依据:计划次序 3–5
原文直接授权;C20a/b 四层已就绪;G0 实测把"消除全量传输"从计划假设
升级为已证实的首要瓶颈(16.3GiB 驻留)。
