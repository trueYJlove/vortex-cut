# C20c-2(缓存窗口迁移/manifest_id 等值复用)实施报告(2026-09-13)

依据:`PERFORMANCE_C20C_PLANNING_GATE_2026-09-13.md` §2 C20c-2(批准);
前置:C20c-1 已交付(同日,`PERFORMANCE_C20C1_SESSION_SWAP_IMPLEMENTATION_2026-09-13.md`)。

## 1. 结论速览(含一项经证据裁定的范围收敛)

**交付:manifest_id 相等 ⇒ 缓存窗口整体迁移**——撤销/重做/空转 revision
(内容未变的编辑闭环,`manifest_id = content_fingerprint@mode@profile`,
不含 revision id)零窗口取窗换装,帧对象跨源同引用。**范围收敛(宁重算
不猜测的必然结果):manifest_id 不等时不做部分复用**——代码证据链:

1. `plan.py:358-359`:plan segments 内嵌 keyframes/transform;
2. `ir.py:456-467`:投影输出的 manifest segments **显式字段列表剥离
   keyframes/transform**——关键帧/transform 编辑在 manifest 中不可见;
3. `plan.py:427-434` + compile_rendition:content_fingerprint 覆盖
   {inputs, segments, captions.items, preset_version, font_bundle_version}
   + timeline_document_sha256 + rendition_snapshot_sha256 + output——
   **全文档哈希在内**,任何内容编辑都改变 fingerprint;
4. 结论:fingerprint(⇒manifest_id)相等 ⇒ 同 plan ⇒ 同投影(纯函数,
   `ir_window.py` 模块注释)⇒ 逐帧字节相同 ⇒ **全量复用健全**;
   manifest_id 不等 ⇒ 渲染器侧结构 diff(segments/captions/transition
   的时序/源映射字段)虽能定位可见变更,但**无法排除不可见变更**
   (关键帧/transform/预设/字体版本)落在"未变"区间——部分复用不健全。

Gate §4 风险条款("任何无法证明未变的区间一律重算,宁慢不错")由此
主导本轮口径;**部分复用转 C20c-2b(契约扩展,§5)**。

## 2. 交付内容

### 2.1 frame-source:种子窗口机制(`frame-source.ts`)

- `WindowSeed { startFrame, frames }` + `seedWindows?` 选项:构造期装填,
  与 loadWindow 同记账口径(逐帧 frameBytesOf),参与 LRU 逐出;
- 防御性过滤:越界窗口(start ≥ totalFrames)整窗忽略,越界/超窗帧剔除,
  空窗不建条目(部分种子窗容忍——getFrame undefined = 既有未就绪语义);
- `snapshotWindows()` 导出:缓存窗口快照,帧 Map 原引用导出——旧源
  dispose 只清条目不清 Map,新源种子继续持有同一批帧对象
  (**引用稳定性契约跨源延续**,golden 语义 = 引用同一强于深度相等)。

### 2.2 SyntheticPreview:seed 决策接线

- `frameManifestRef` 与 `frameSourceRef` **成对持有**:仅在采纳点
  (换装成功/新建成功)同轮更新,中断装配不触碰——保证 seed 判定的
  manifest 与旧源严格同源;
- 换装装配(parse 后、建源前):`prevManifest.manifest_id === manifest.manifest_id`
  ⇒ seed = 旧源 `snapshotWindows()`;不等 ⇒ 无种子(现行为);
- 不变量:manifest_id 相等 ⇒ fingerprint 相等 ⇒ inputs 相等 ⇒
  replaceIr sig 必过 ⇒ seed 仅在换装路径生效(重建路径天然无种子);
- 预热窗 0(T2 并行化)在迁移轮冗余但幂等:装配头部盲发 1 次
  (响应弃用,catch 挂钩无孤儿),实测取窗数 3 vs 无种子 4(见 §3)。

## 3. 验证

| 项 | 判定 |
|---|---|
| typecheck / lint | 通过 |
| Desktop 单测 | **70 文件 635 项全过**(629+6 新增:种子层 4 + 迁移行为 2) |
| 种子层(`frame-source.test.ts`) | ①零请求就绪 + getFrame 引用同一(golden);②计入 LRU 记账、超预算逐出后重取;③防御性过滤(越界窗/越界帧/部分窗);④snapshotWindows 导出 + dispose 后 Map 存活 + 新源同批帧对象复活 |
| 迁移行为(`preview-revision-swap.test.tsx`,多窗夹具 610 帧/播放头帧 300) | ①同 manifest_id(撤销/重做模拟):换装轮取窗恰为预热 1 次(3 vs 初始 2),窗 0/1 零按需取窗,worker 零重建;②manifest_id 变化:窗 1 按需重取(4 次),不迁移 |
| v1 数据面 | 零改动(625 项原有不动即过) |
| 行为正确性(e2e) | 待 A/B(与 C20c-1 合并一轮;改动面仅 revision 切换路径) |

## 4. 边界与已知限制

1. **Core 投影缓存 LRU=2**:深撤销(>2 个内容不同的 revision 交替)时
   Core `_ir_v2_bundle` 未命中 → manifest 重新投影(1.8–4.3s 随源缩放)
   ——渲染器种子迁移消除的是窗口取窗与解析,投影成本属 C20c Gate §2
   排除项(投影缓存/增量),维持另立;
2. 内容编辑(前向编辑)不享受窗口迁移:换装后按需取窗(当前窗 + 预取),
   与 C20c-1 行为一致——收益路径是撤销/重做/空转;
3. 预热窗 0 在迁移轮为幂等冗余(1 次元数据 IPC,~50-70ms 量级);
4. 字体在迁移/换装轮均不重载(C20c-1 既定语义)。

## 5. C20c-2b(登记,契约扩展后激活部分复用)

部分复用(结构 diff 定位 dirty 区间 + 区间外复用)的健全性前提是 manifest
可见"相关关键帧"与语义版本——需要契约扩展:

- **段级 visual hash**:Core 投影时对 segment 的 {keyframes, transform}
  求哈希随 manifest segments 下发(结构 diff 即可覆盖关键帧/transform
  编辑的定位——plan 侧字段已在,投影输出侧补暴露);
- **caption 语义 hash**:preset_version + font_bundle_version + 风格哈希
  随 manifest 下发(字体/预设版本变更 → 全局失效可见化);
- 契约兼容:`PreviewIrV2Manifest` 校验为 `only([...])` 严格键集,新增字段
  需兼容性处理(新字段 optional 化或版本化校验),旧渲染器读新 Core 的
  拒绝路径须按计划 §10 能力握手语义处理;
- 渲染器侧:`ir-diff` 纯函数(segments 按 clip_id 对齐 + 时序/源映射/
  visual hash 比对 → dirty 帧区间 + 1 帧 halo + 窗口粒度扩展)→
  seedWindows 只灌"证明未变"的窗口——机制载体(种子/快照)本轮已就绪,
  C20c-2b 仅补 diff 与判定;
- golden 帧对拍(Gate §3 硬门)在部分复用激活轮执行:复用窗口与全量重取
  逐字节深度相等(含窗口边界字幕 inclusive end、转场首尾、空隙、PiP
  关键帧夹具)。

## 6. 验收对照(C20c Gate §3)

| 项 | 判定 |
|---|---|
| 会话沿用正确性 | C20c-1 已达标;本轮迁移路径并入同型单测 |
| 帧数据等价 | **复用路径达标**(引用同一 = 投影确定性下最强等价;部分复用的逐字节 golden 对拍随 C20c-2b) |
| 行为正确性(F01/F02/F03 off/on) | 待 A/B(与 C20c-1 合并) |
| 回归 | 达标(635 单测 + typecheck/lint) |
| 性能 | 待 A/B:撤销/重做轮的窗口取窗数应为 0(预热除外)、ready 分段 ready_window/ready_manifest 显著下降(同指纹时 Core 投影缓存命中) |
