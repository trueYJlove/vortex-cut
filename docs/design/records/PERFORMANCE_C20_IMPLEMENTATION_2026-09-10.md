# C20 实施进度与自检报告(2026-09-10)

## 1. 状态与范围

**C20(窗口化 IR v2,第一阶段 C20a+C20b)代码完成 + 功能验证完成。**
独立验收:**通过**(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)

依据 `docs/design/records/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 7 节 C20,在
B17(`4744bb6`)之上实施。C20 计划分为 a(manifest)/b(window)/c(dirty-range)
三步;本次交付 C20a(FrameSource 适配层)+ C20b(Core 窗口投影 + 契约 +
IPC 四层贯通)。C20c(编辑增量复用)按计划"先消除全量传输,再做增量
复用"的次序留待实测驱动。

提交(本地,未 push):
- (提交 1)C20a+C20b:Desktop FrameSource + Core ir_window/v2 端点 +
  contracts v2 段 + performance-ipc/preload 通道 + 测试 + 本报告

## 2. 修改单(模板)

```text
修改单:C20 窗口化 IR v2(第一阶段:C20a 适配层 + C20b 契约/端点/贯通)
基线HEAD / 工作树标识:4744bb6(B17);一个本地提交
目标与不修改范围:
  目标(C20a)——Renderer 帧消费统一走 FrameSource 接口
  (getFrame/frameCount/ensureRange/dispose):v1 = 全量数组零拷贝适配
  (与 ir.frames[n] 逐点等价,引用身份保持——就地补丁语义依赖);
  v2 窗口接入点就绪(ensureRange/dispose 预留)。查找并替换全部
  ir.frames 直访:preview-session 10 处 + probes m3p1/m3p2 3 处。
  目标(C20b)——Core 窗口化投影:ir_window.py(manifest 构造 + 常量
  300/150 + manifest_id 绑定指纹/模式/规格);service manifest/window
  方法(全量投影一次 → v2 bundle 缓存 LRU2,窗口从同一投影切片——
  manifest 与窗口数据同源,一致性构造性保证);app.py 两个独立 UI
  端点(preview-ir-v2/manifest + preview-ir-v2/window)。契约四层贯穿:
  contracts performance.ts C20 段(输入/DTO/响应校验器 + only() 键白名单
  + path 剥离语义)、performance-ipc 通道(rendererSafe + 契约 parse)、
  preload 白名单(+2 方法)、Core 端点(参数闸门 400 + require_ui 401)。
  不修改——v1 endpoint/response 形状与语义完全不动(独立路由,不让同
  一路由静默改变 frames 形状);v1 27000 帧限制保留(v2 窗口不抬高上限
  ——C20 计划"只有 v2 的时长/帧数/整数边界/资源压力通过后才提高长项目
  限制",本阶段不启用 v2 数据面,只交付协议与端点);Renderer 消费端
  (SyntheticPreview→getPreviewIr→arrayFrameSource)不切换 v2——v2 数据
  面接入(窗口缓存/buffering 态/seek 优先)待下一阶段按实测灰度;
  C20c dirty-range 复用不做;GL Worker 不接管时间轴语义。
实际修改文件(绝对路径):
  apps/desktop/src/app/preview/frame-source.ts(新增:FrameSource 接口 +
    arrayFrameSource v1 适配)
  apps/desktop/src/app/preview/preview-session.ts(10 处 ir.frames 直访
    → getFrame/frameCount;replaceIr 同步换源)
  apps/desktop/src/probes/m3p1.ts / m3p2.ts(探针帧访问同一层)
  apps/desktop/tests/frame-source.test.ts(新增,5 项)
  services/core/src/aivs_core/rendering/ir_window.py(新增:build_manifest
    /manifest_id_of/常量;MAX_WINDOW_FRAMES=300)
  services/core/src/aivs_core/rendering/service.py(preview_ir_manifest/
    preview_ir_window/_ir_v2_bundle/_project_plan 抽取;v2 缓存 LRU2)
  services/core/src/aivs_core/app.py(两个 v2 端点;v1 端点不动)
  services/core/tests/unit/test_render_ir_window.py(新增,14 项)
  services/core/tests/integration/test_preview_ir_api.py(+3 项 v2 端点)
  packages/contracts/src/performance.ts(C20 段:4 类型 + 4 校验器)
  apps/desktop/electron/main/performance-ipc.ts(2 个 v2 通道)
  apps/desktop/electron/preload/index.ts(+2 方法白名单)
  apps/desktop/tests/performance-ipc.test.ts(+4 项 C20 段)
  apps/desktop/tests/preload.test.ts(+2 行)
前置Gate与接口版本:B00-A15 全链(ir.py 投影/interval_index 扫线/
  A05b 后台执行);计划第 6.1 节四层贯穿模式(B10-B15 同链)。
算法/状态机变化:
  - FrameSource:v1 适配为纯函数视图(frameCount=ir.frames.length;
    getFrame 引用恒等;ensureRange 立即 resolve);replaceIr 换表时同步
    替换帧源(手势可变性与引用一致性保持)。
  - v2 manifest_id = content_fingerprint@mode@output.profile_id——
    revision/编辑/比例变化 → 新指纹 → 新 manifest;同指纹窗口请求共享
    同一投影缓存。
  - 窗口投影 = 同 plan 的 v1 全量投影切片([start, start+count),count
    上限 300、尾窗收拢到 total);帧语义是 t_exact 纯函数 + 扫线
    active_at 状态恢复语义与逐帧推进一致——窗口内任意帧与 v1 同帧
    逐位相等(构造性保证,单测随机窗口拼接覆盖全表断言)。
  - 端点参数闸门:start_frame>=0、frame_count 1..300、start<total、
    ratio 枚举 → 400(PREVIEW_IR_WINDOW_INVALID/PREVIEW_IR_RATIO_
    UNSUPPORTED);未授权 401(集成测试覆盖)。
授权、取消、资源所有权、缓存失效规则:
  - v2 端点与 v1 同鉴权(require_ui;无 admin 路径、无路径字段);
    契约 only() 键白名单 + rendererSafe 剥离路径形态字段(与 B10-B15
    通道同语义——路径只存在于 Core↔Main admin 响应,v2 纯 UI 通道
    无路径)。
  - v2 bundle 缓存键 = content_fingerprint(素材变化→新指纹→旧缓存
    自然失效);LRU 2 条(帧表体量,与 v1 缓存 4 条分池);无持久化。
  - 无新增取消路径(窗口请求是短 UI 请求;AbortSignal 语义留待
    Renderer v2 数据面接入时接)。
新增/修改测试与命令:
  Core:pytest services/core/tests/unit/test_render_ir_window.py -q(14)
    + tests/integration/test_preview_ir_api.py(6,含 v2×3)
  Desktop:vitest run tests/frame-source.test.ts(5)
    tests/performance-ipc.test.ts(27,+4) tests/preload.test.ts(3)
功能回归结果(含跳过):Core unit 全量 599 通过(B17 时 585;+14);
  Desktop 全量 69 文件 607 项通过(B17 时 68/598;+1 文件 +9 项);
  typecheck/lint 通过。已知噪音:input-pool-protocol 2 个 unhandled
  rejection("compositor worker disposed")在 B17 前的 HEAD 已复现
  (B13 遗留),非本次引入,测试本身通过。
before / after / 同机环境:
  结构性等价(jsdom/pytest 断言,非性能实测):v1 数据面行为逐位不变
  (preview-session/probes 全部既有测试不改断言通过);v2 端点交付
  manifest(无帧)+ 窗口切片(帧与 v1 深相等——含转场边界/字幕含端/
  PiP/黑场空隙,随机窗口拼接全表覆盖);"首窗不扫描全部时间帧"的
  服务端侧 = 全量投影一次后窗口零投影(缓存层);Core→Renderer 传输
  减负要待 v2 数据面接入后量化(本阶段 Renderer 仍走 v1 全量)。
质量与失败路径验证:
  - 窗口参数闸门四类非法(负 start/零 count/超 300/越界)→ 400
    (service ValueError + 端点双保险,单测+集成);
  - v1 形状冒充 v2(schema 不匹配)→ 契约 parse 拒绝;
  - frames.length != frame_count → 契约拒绝;path 字段 → rendererSafe
    剥离(与既有通道一致)后 parse;
  - manifest 与窗口 manifest_id 不一致可由调用方校验(manifest_id
    在两响应中同源)。
开关、兼容与回退:
  纯增量:v1 端点/响应/Renderer 路径零改动(回归证明);v2 端点新路由
  无调用方(能力就绪,默认不启用——与计划"previewIrV2 开关组"的
  灰度次序一致);回退 = revert 单提交。
已知限制、未解决问题:
  - "首窗不扫描全部时间帧"目前是缓存层语义(同 revision 重复采样后
    窗口零投影),**首次** manifest 请求仍做一次全量投影——真正的
    增量投影(窗口从索引直接计算、不物化全量帧)需要把 ir.py 帧循环
    重构为可从任意帧起算的投影上下文(计划 C20b 的完整形态);本阶段
    选择切片等价路径(正确性由构造保证),增量投影列为 C20 下一阶段
    与实测一并推进——诚实口径:长项目的首次延迟未改善,传输与内存
    改善待 v2 数据面接入。
  - Renderer v2 数据面(窗口缓存 8MiB/双请求在途/缓冲态/seek 优先/
    播放预取)未接入——SyntheticPreview 仍走 v1 getPreviewIr;
    接入时机按计划 10.2 灰度次序(先实测 v1 瓶颈排序,再切 v2)。
  - C20c(revision 换 manifest 但 input 绑定未变时沿用会话/解码器 +
    dirty-range 复用)未做。
  - 跨窗播放 30 分钟无周期性卡顿、60 分钟时间轴夹具首窗耗时/字节
    计量(F 场景)未跑——列 F 场景复测轮。
开发者自测:通过(见上)。
独立Reviewer结论:通过(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)
Gate决策与下一步:C20 第二阶段(Renderer v2 数据面接入:windowed
  FrameSource + 窗口缓存/预取/缓冲态)或 C21(导出输入深定位);
  F 场景复测轮量化 v1 全量传输的实测瓶颈后决定优先级。
```

## 3. 测试证据摘要

| 层 | 文件 | 项数 | 覆盖 |
|---|---|---:|---|
| FrameSource | frame-source.test.ts | 5 | getFrame 数组逐点等价(引用身份)/越界 undefined/空表/ensureRange 立即完成/dispose 不破坏数组所有权/就地修改可见性 |
| Core 窗口 | test_render_ir_window.py | 14 | 随机窗口拼接全表覆盖深比较/转场边界(blend 起/止)/字幕含端/PiP 与黑场空隙/manifest 字段与 v1 同源/纯函数路径=缓存路径/manifest_id 组分/常量/尾窗收拢/右开边界/service 参数闸门四类 |
| Core 端点 | test_preview_ir_api.py | +3 | manifest+window 与 v1 逐帧深相等/参数闸门 400(四类+ratio)/竖屏 manifest 换档/未授权 401 |
| Main IPC | performance-ipc.test.ts | +4 | 12 通道白名单/manifest+window 走 UI 通道(query 形状)/严格拒绝未知键与非法参数/path 剥离后契约校验/v1 形状冒充拒绝 |
| preload | preload.test.ts | +2 行 | v2 两方法固定 channel |
| 全量 | — | — | Core unit 599 / Desktop 69 文件 607 项 / typecheck / lint |

## 4. 与实施计划的偏差

- 计划"窗口内首帧必须能恢复此前已激活的 region、字幕、转场和关键帧
  状态,不从零重放前面所有帧":实现为"同 plan 全量投影一次 + 切片"——
  首次请求物化全量帧(内存中,缓存 LRU2),窗口请求零投影零重放;
  RegionSweep/IntervalLookup 的 active_at 恢复语义在文档与测试中锁定,
  但生产路径未走到"从任意帧起算的增量投影"(见已知限制——正确性
  优先的切片等价路径,增量投影留待实测驱动)。
- 计划"manifest_id 绑定 project/revision/output profile/toolchain":
  实现 = content_fingerprint@mode@profile_id(指纹已含 revision 内容、
  输出规格与素材指纹;toolchain 不参与——IR 投影与 FFmpeg 工具链无关,
  v1 语义亦无此维度)。
- 计划"窗口请求限制响应字节,超限返回更小窗口指引":实现上限帧数
  (300)而非字节——帧对象字节预算依内容浮动,字节闸门列 Renderer
  数据面接入时按实测校准(与"不预先进硬编码"的计划精神一致)。
- C20a 计划原文为"给 v1 加 FrameSource adapter 并替换所有 ir.frames[n]
  访问"——已完整交付(preview-session + probes + 测试)。

## 5. 复现命令

```powershell
.\.venv\Scripts\python.exe -m pytest services/core/tests/unit/test_render_ir_window.py services/core/tests/integration/test_preview_ir_api.py -q
.\.venv\Scripts\python.exe -m pytest services/core/tests/unit -m 'not real_provider' -q
Push-Location -LiteralPath 'C:\DataFolder\codes\AI-Vidio\apps\desktop'
node node_modules/vitest/vitest.mjs run tests/frame-source.test.ts tests/performance-ipc.test.ts tests/preload.test.ts tests/preview-ir-patch.test.ts
node node_modules/vitest/vitest.mjs run
pnpm lint
Pop-Location
```
