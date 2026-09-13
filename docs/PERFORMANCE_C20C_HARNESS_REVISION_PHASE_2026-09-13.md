# C20c A/B harness 扩负载(revision 切换相位)工作单报告(2026-09-13)

依据:C20c-1/-2 实施报告遗留项("A/B 与行为正确性轮待跑,harness 需扩
revision 切换负载,另行小修")。本工作单 = harness 扩负载 + 顺带修复
两处测選机制潜伏缺陷(冒烟暴露,先证后修)。

## 1. 交付内容(`performance-editor.spec.ts` + `run_editor_benchmark.mjs`)

### 1.1 revision 切换相位(每个 run 一次,置于播放相位之后)

- **位置**:播放相位(含 F06 finishBackground)之后——前序相位负载不被
  编辑污染,保持与 G0/c20t 基线可比。
- **两种驱动模式**(按场景配置 `revisionPhase`):
  - `text-edit`(F01/F03/F05/F06/F07):播放头移位(prepare,不进测量窗)
    → "默认文本"按钮 → 字幕编辑。输入不变 → v2 必走换装路径;字幕位置
    轮换(20%/45%/70%)且夹紧距末尾 3.5s 内(避开重叠校验与越界)。
  - `undo-redo`(F02/F02P/F04):Ctrl+Z/Ctrl+Y 服务端 revision 导航
    (字幕铺满场景无法插字幕;window 级键盘监听,无需焦点)。
- **转换确认(测量效度核心)**:轮询 `getTimeline().current_revision`
  (HEAD 指针)前进 → 轮询预览状态回到"合成预览"(fallback 也算失败——
  换装路径回归响亮失败)→ 300ms 收敛(refineAfterDrag 250ms 去抖)→
  快照。**不用预览状态轮询做前进确认**——loading 窗口太短会错过造成
  假通过。
- **每转换记录**:`action / wall_ms / result / counts / durations /
  ready_events / window_fetch_events`。v2 记 ready_manifest/parse +
  window_fetch + seek(refine);v1 走 replaceIr 同路径(事件流为空,
  wall_ms 即 v1 就地换表基线)。
- 默认 6 转换(`AIVS_PERF_REVISIONS` 可调);样本新增
  `revision_transitions` 字段与 `workload.revisions`;on 通道断言全部
  转换就绪(数量 + result)。

### 1.2 顺带修复:两处潜伏缺陷(冒烟暴露)

1. **场景守卫环境变量错位**:runner 设 `AIVS_PERF_SCENES`(a087ced 起),
   spec 守卫读 `AIVS_PERF_SCENARIOS`(仅 B11-D spike 直连时手工设置)——
   **守卫自 a087ced 起从未生效**,场景选择完全依赖 `-g` 正则;被
   F01..F07 无子串关系掩盖。修复:spec 双名兼容
   (`AIVS_PERF_SCENES ?? AIVS_PERF_SCENARIOS`)。
2. **`-g` 子串碰撞**:`B00 complete editor F02` 正则命中
   `F02P/...` 标题——F02P 自入库起凡与 F02 同轮必被连带执行(夹具缺失
   即失败)。修复:grep 模式加负向断言 `(?![A-Za-z0-9])`。
   (c20t-ab 轮未触发的原因:该轮证据目录无 F02P 现场——待复核运行日志;
   两修复使该类隐患结构性消除。)

## 2. 验证(冒烟,v2 缺省二进制 + 真实 UI 驱动)

| 轮 | 结果 | 关键观察 |
|---|---|---|
| c20c-smoke-f01-01 | **失败(预期缺陷暴露)** | revision id 不前进——首轮探针用 listTimelineRevisions(历史列表),undo 只移动 HEAD 不新建 revision |
| c20c-smoke-f01-02 | **通过**(3 启动) | 探针改 HEAD;6 转换全就绪:add ~910-1030ms / undo ~870-900ms;每转换 ready_manifest ~45-65ms + window_fetch 恰 2(当前窗+预取,manifest_id 变化→无种子→按需重取,C20c-1 预期行为)+ refine seek 事件 |
| c20c-smoke-f02-01 | F02 通过;**F02P 连带失败(暴露 -g 碰撞)** | — |
| c20c-smoke-f02-02 | **通过**(仅 F02) | undo/redo 6 转换全就绪:wall ~900-950ms;每转换 manifest ~100-316ms + window_fetch 7(当前窗+回扫+预取,无种子路径预期);ready_manifest 波动与投影缓存命中状态一致 |

失败现场归档:c20c-smoke-f01-01(warmup-on failure.json + Core DB 双
revision 实证"补丁已落库、HEAD 未被探针读到")、c20c-smoke-f02-01
(F02P 碰撞)。

## 3. 验收对照

| 项 | 判定 |
|---|---|
| revision 相位贯通(text-edit/undo-redo) | **达标**(F01/F02 冒烟 12 转换全就绪,数据形状符合 C20c-1/-2 设计预期) |
| on 通道断言(全转换就绪) | 达标(响亮失败语义) |
| 前序相位基线可比性 | 达标(相位置于播放后,负载零污染) |
| 场景选择机制修复 | 达标(双名兼容 + 词边界;F02P 不再连带) |
| Desktop 单测 | 无涉(harness 为 e2e 层;635 项不受影响) |
