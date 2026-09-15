# C20 第二阶段(Renderer v2 数据面)实施报告(2026-09-11)

## 1. 状态与范围

**C20 第二阶段代码完成 + 功能验证完成(Desktop 616 项全过)。**
独立验收:**待验收**。F 场景 v2 on 实测(Planning Gate §5.2 验收)待下一
基准轮执行——本阶段交付默认 off 的开关路径,v1 行为逐字节不变。

依据:
- Planning Gate:`docs/PERFORMANCE_C20_PHASE2_PLANNING_GATE_2026-09-11.md`
  (LiuWei 提案;范围 = windowedFrameSource + buffering 态 + 开关接入 +
  pip 索引窗口化;明确不做 C20c/增量投影/抬上限)。
- G0 实测驱动:F02 v1 全量 Tab 工作集 16,706MiB(≈16.3GiB)——消除全量
  传输与驻留是已证实的首要瓶颈。

## 2. 修改单(模板)

```text
修改单:C20 第二阶段——Renderer v2 数据面(windowedFrameSource + 开关接入)
基线HEAD / 工作树标识:032da74(内存长测);一个本地提交
目标与不修改范围:
  目标 1(windowedFrameSource)——frame-source.ts 新增 v2 窗口帧源:
    LRU 整窗缓存(字节记账,预算 8MiB 默认;逐出整窗——窗口内帧对象
    共享生命周期,getFrame 同帧同引用直到逐出,引用稳定性契约保持);
    single-flight 按窗口 start 键;在途上限 2(计划次序 4),超出时不
    排队(seek 优先当前目标,调用方下次 ensureRange 重试);abort 取消
    未发出的请求(已发出照常入缓存——合法数据);manifest_id 失配响应
    整窗丢弃;非法帧行(无 n)整窗丢弃;失败窗口保持未就绪可重试;
    isBuffering(frame)= 不在缓存也不在途(显式 buffering 判定);
    buffered() 报告就绪区间。窗口粒度 = 契约常量 300。
  目标 2(会话注入)——PreviewSession.create/replaceIr 接受外部
    FrameSource(缺省 = v1 arrayFrameSource,行为不变);pip 索引
    (A04)在 v2 模式下按已就绪帧增量构建(extendPipOverlayIndex,
    pump 触达新帧后并入),v1 全量重建语义不变;pump 在 v2 模式先
    ensureRange(目标窗 + 预取窗)。
  目标 3(开关接入)——SyntheticPreview:VITE_AIVS_PREVIEW_IR_V2=1 时
    getPreviewIrV2Manifest(parse 契约校验)→ windowedFrameSource →
    首屏 ensureRange(首窗+预取窗,≤600 帧)→ 会话注入;manifest 字段
    构造 v1 形状元数据(schema/projector_version/canvas/inputs/segments/
    captions/caption_styles/transition_windows/known_approximations,
    frames 不驻留);revision 变更走既有"输入变化→整会话重建"判定
    (v2 下 replaceIr 由调用方传入新帧源)。默认 off = v1 路径逐字节
    不变(getPreviewIr 全量路径无任何改动)。
  不修改——C20c(dirty-range 复用)不做;Core 侧增量投影不做(首次
    manifest 仍全量投影一次,缓存层语义);27000 帧上限不抬高;音频/
    解码/GL/B13 输入池路径零改动;v1 端点与响应形状零改动。
实际修改文件(绝对路径):
  apps/desktop/src/app/preview/frame-source.ts(windowedFrameSource +
    FrameSource.isBuffering 可选成员;arrayFrameSource 补 isBuffering=false)
  apps/desktop/src/app/preview/preview-session.ts(create/replaceIr 接受
    外部帧源;pipIndexCoveredUpTo 游标 + extendPipOverlayIndex;pump
    ensureRange 钩子)
  apps/desktop/src/app/preview/SyntheticPreview.tsx(previewIrV2Enabled
    开关 + v2 manifest→窗口帧源→会话注入路径;错误路径与 v1 一致)
  apps/desktop/src/probes/env.d.ts(+VITE_AIVS_PREVIEW_IR_V2 声明)
  apps/desktop/tests/frame-source.test.ts(+8 项 v2 行为契约测试)
  docs/PERFORMANCE_C20_PHASE2_PLANNING_GATE_2026-09-11.md(Gate 提案)
  docs/PERFORMANCE_C20_PHASE2_IMPLEMENTATION_2026-09-11.md(本报告)
前置Gate与接口版本:Planning Gate 2026-09-11(自评批准,待独立复核);
  C20a/b 四层(manifest/window 端点+契约+IPC);B00 G0 实测。
算法/状态机变化:
  - 窗口缓存:LRU 整窗粒度(非单帧),字节记账 = Σ frameBytesOf(帧);
    逐出后窗口内全部帧同时不可用(下次触达重取)——引用稳定性以窗口
    生命周期为界。
  - 在途满载语义:ensureRange 对无法发起新请求的窗口**不排队不等待**
    (立即返回既有在途 Promise);饥饿窗口由调用方下一轮 ensureRange
    重试(播放 pump 每帧驱动,天然重试)。
  - buffering 判定:isBuffering = !cache.has(win) && !inFlight.has(win);
    会话侧缺帧 = getFrame undefined → compose 跳过(既有"保持最后
    完整画面"路径,零新机制)。
授权、取消、资源所有权、缓存失效规则:
  - fetchWindow AbortSignal:取消未开始请求(abortedStarts 标记);已
    发出请求的响应仍入缓存(合法数据,仅调用方不等待)。
  - dispose:清空缓存/在途/abort 标记;后续 ensureRange/getFrame 幂等
    安全(空行为)。
  - manifest_id 不匹配(跨 revision 竞态响应)整窗丢弃,不污染当前帧源。
新增/修改测试与命令:
  Desktop:vitest run tests/frame-source.test.ts(13 = 5 v1 + 8 v2:
    基本判定/装配+引用稳定/single-flight/在途上限重试/LRU 逐出/abort/
    失配丢弃/dispose+buffered)。
功能回归结果(含跳过):Desktop 69 文件 616 项通过(+8);2 unhandled
  rejection 为 B13 已知噪音(C20a/b 报告登记,非本次引入);lint(=tsc)
  通过。
before / after / 同机环境:
  功能等价(单测):v1 路径断言不变全过(默认 off = 逐字节不变);
  v2 帧源行为契约 8 项新锁。
  性能实测(待 F 场景 v2 on 基准轮):预期 F02 ready 不随总帧数线性、
  Tab WS <2GiB(窗口预算);本报告不声称已达成——不实测不宣称。
开关、兼容与回退:
  - VITE_AIVS_PREVIEW_IR_V2 默认 off;on 需显式构建(env.d.ts 已声明)。
  - 回退:关开关即回 v1;代码回退 = revert 单提交。
已知限制、未解决问题:
  1. F 场景 v2 on 实测(Gate §5.2:ready <2s / WS <2GiB / 指标退化
     ≤20% / off 复测 ±5%)未执行——待下一基准轮(previewIrV2=1 构建)。
  2. v2 模式下 pip 索引以"已就绪帧"为准:手势对未就绪窗口内 overlay
     不生效(需先触达装配);LRU 逐出后旧帧手势态丢失(交互秒级 <<
     窗口存活时间,Planning Gate §3.2 接受)。
  3. 缓冲态 UI(SyntheticPreview 预览状态扩展"缓冲中")未加——缺帧
     当前表现为画面保持(与 starving 语义一致);显式 buffering 提示
     待 UX 评审后补。
  4. Core 首次 manifest 请求仍全量投影一次(C20a/b 登记的缓存层语义);
     长项目首投影延迟未改善——增量投影(C20b 完整形态)另行立项。
开发者自测:通过(见上)。
独立Reviewer结论:通过(2026-09-13 PERFORMANCE_B13_C20T_INDEPENDENT_ACCEPTANCE_2026-09-13.md §C20 二阶段;尾部状态行 2026-09-15 回填)
Gate决策与下一步:F 场景 v2 on/off A/B 基准轮(previewIrV2=1 构建 +
B00 harness F01/F02/F03 复测)→ 达标则 C20c 立项(revision 换 manifest
沿用会话),未达标按 profile 解释。
```

## 3. 与 Planning Gate 的偏差

- Planning Gate §2.4 要求"pip 索引从全帧扫描改为按已就绪窗口增量构建"——
  实现一致,另保留 v1 全量重建语义(`extendPipOverlayIndex` 分支)。
- Planning Gate §2.3 的 buffering 状态上报未做(见已知限制 3)——缺帧
  行为(画面保持)与目标一致,仅 UI 提示层缺失,不阻塞实测。
- 其余范围/边界逐条落实,无未登记偏差。
