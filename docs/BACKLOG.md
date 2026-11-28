# 开放承诺、风险对策与技术债追踪（Backlog）

> 本文件承接 [`STATUS.md`](STATUS.md) §4 的开放工作包、风险对策、未闭环缺陷与工程待办明细；当前整体阶段与已交付能力边界统一见 [`STATUS.md`](STATUS.md)。
> 一旦条目完成验收并核销，请同步从本文件与 `STATUS.md` §4 移除（历史由 Git 追溯），长期结论并入 [`specs/`](specs/README.md)。

---

## 1. 在研核心工作包（`plans/`）

### P237 · 0.1.0 发布门与后续路线图 {#p237}
- **类型 / 状态**：工作包｜⏳ **已立项（2026-11-28），按阶段逐步执行**
- **出处**：[`plans/P237_RELEASE_0_1_0_AND_ROADMAP_PLAN.md`](plans/P237_RELEASE_0_1_0_AND_ROADMAP_PLAN.md)
- **要点**：阶段 0 签字/补证收口 → 阶段 1 P235 R1–R3 → 并行 iPhone 素材兼容包与 P200 限期排查 → 0.1.0 发布门；P236 作为 0.2.0 主题（S0 TD-01 先行）。记录用户裁决 D1（P161 暂按可用）、D2（R4 挂起）、D3（P220 Graphite 单源）、D4（版本节奏）。

### P236 · 时间线数据解耦与 Agent 协作工作区 {#p236}
- **类型 / 状态**：工作包｜⏳ **已立项（2026-11-24），待规划门与实施切片拆解**
- **出处**：[`plans/P236_TIMELINE_DECOUPLING_AND_AGENT_WORKSPACE_PLAN_2026-11-24.md`](plans/P236_TIMELINE_DECOUPLING_AND_AGENT_WORKSPACE_PLAN_2026-11-24.md)
- **要点**：采用 Core 领域权威 + SQLite 不可变 Revision 账本 + 声明式无损工作区投影/双向摄入（整数微秒）+ MCP/CLI 优先暴露层；明确否决删 SQLite 时间线表、浮点秒持久化与 Electron Main 校验器反模式。

### P235 · OpenFilm 时间线视觉 / 交互 / 功能 / 性能完整收口 {#p235}
- **类型 / 状态**：工作包｜🟡 **持续实现与验收中（固定参照 OpenFilm commit `b125a3d9`）**
- **出处**：[`plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md`](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md)
- **要点**：初始缩放、固定标题、`trusted wheel`、跨轨拖动、V3-B 延长与 `Place→Insert→Place` 预览已对齐；区域像素验收 46 区尚未全部达标（4 片段 perimeter 97.48%–98.93%、文字轮廓 33/39），仍待补齐完整双端手势矩阵、`Replace`/未知时长、Core revision/undo、转场/`page` 与冷热性能对照。

### P235-R1 · Replace 语义：无音轨 video 与未知时长 {#p235-r1}
- **类型 / 状态**：风险对策｜🟡 **实现与证据未闭环**
- **出处**：[`plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md`](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) §2
- **要点**：无音轨 video 替换 sound 目标需映射为静音片段并保持 preview/export 成功；有限源时长未知时按 OpenFilm 的目标需求长度 fallback 规划，不能因探测缺失改变目标时长或直接拒绝；需覆盖时间线校验、预览与成片源 EOF 结果。

### P235-R2 · Replace 时长保留与 audio-only 导出解码成本 {#p235-r2}
- **类型 / 状态**：风险对策｜🟡 **设计经独立复审通过，实现与证据未闭环**
- **出处**：[`plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md`](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) §2–§3
- **要点**：移除原 30s image 上限、统一 100ms 到 `Number.MAX_SAFE_INTEGER` 微秒；视频作为音频使用时不得进入 `resolution="original"` 视觉源分辨率计算，也不得产生视觉 decoded frame；须落地 `video_required`/`audio_required`、Desktop rig 过滤、原始音频票据与 proxy 分离、FFmpeg input-side `-vn` 及解码计数对拍证据。

### P235-R3 · OpenFilm 转场来源事实与最终布局投影 {#p235-r3}
- **类型 / 状态**：风险对策｜🟡 **架构已冻结，实现及投影测试未闭环**
- **出处**：[`plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md`](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) §2
- **要点**：active pair 供 Timeline、预览、RenderPlan/FFmpeg 与编辑校验共用，旧 `{after_clip_id, kind, duration}` 不得重新绑定到新后继；migration 45 仅从不可变历史修订/操作快照恢复原 incoming identity，不可恢复时保留 null/dormant。

### P235-R4 · OpenFilm HTML `page` 时间线功能与隔离渲染 {#p235-r4}
- **类型 / 状态**：风险对策｜⏸ **2026-11-28 用户裁决挂起（P237 D2）**
- **出处**：[`plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md`](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) §2
- **要点**：包含 `asset_kind=page` 安全源窗、`page_overrides[]` 校验与 Replace 清理、entrypoint 参与 cache hash；执行用户 HTML 前必须通过独立安全复核（sandbox、资源白名单、网络/导航边界、超时/取消与越权负例）；实时预览、authoritative preview 与 final export 共用同一页面帧源。重启条件：P236 Agent 工作区落地且出现真实 Agent 生成动效需求后单独立项。

---

## 2. 预览引擎、渲染与解码缺陷

### P227 · 预览丝滑收口（WebGPU 零拷贝合成器 + 软解推断提示） {#p227}
- **类型 / 状态**：工作包｜⏳ **代码已合入（默认 WebGL2，`VITE_AIVS_GPU=1` 门控），待真机矩阵核销**
- **出处**：[`specs/preview-and-rendering.md`](specs/preview-and-rendering.md) §4.1
- **要点**：已完成 WebGPU `importExternalTexture` 路径、四级回退、`suspected_software_decode` 提示及单测；待补真机 4K 对照、`VITE_AIVS_GPU=1` 回退无黑屏与假硬解提示验证。

### P196 · 设计门与状态源对账：长时线遗留收口 {#p196}
- **类型 / 状态**：工作包｜🟡 **6 项门内遗留中 (1)(3)(4)(5)(6) 已实施或取证，第 (2) 项转入 P200**
- **出处**：`evidence/performance/manifest-ir-disk-cache-20261024/`
- **要点**：缓冲态 UI、manifest IR 冷/热实测、图片代理与错误上下文已落地；「30 分钟跨窗无卡顿」因 `MAX_IR_FRAMES=27_000` 结构上限转交 P200。

### P197 · B13-R 解码驻留 `textureBytesOf` 口径与 Chromium 上游挂起 {#p197}
- **类型 / 状态**：工作包｜🟡 **已裁决处置：遗留一显式挂起、遗留二暂不立项**
- **出处**：`apps/desktop/src/app/preview/compositor-worker.worker.ts`
- **要点**：`textureBytesOf` 仍按 `w*h*1.5*(4/3)` 记账而非随 `frameUploadMode` 变化，待 Chromium 上游修复驻留问题或确需自建补丁时再解冻。

### P200 · 长时线合成预览退化（约 8 分钟以上每 ~10s 冻结 2–11s） {#p200}
- **类型 / 状态**：缺陷修复｜🟡 **现象已实证、经 7 轮归因排查仍待定位根因与修复**
- **出处**：`evidence/performance/P196_CROSSWINDOW_30MIN_MEASUREMENT_2026-10-27.md`、`evidence/performance/p200-window-attribution-20261028/`
- **要点**：14.49 分钟长时线出现 `window_fetch` p50 2512.6ms / p95 8733.1ms 冻结尖峰；已排除 Core/IPC 慢、主线程长任务与 `reanchor → missingStuck` 假设，待进一步隔离触发状态量。P237 并行线 B：限期 3 个工作日定位触发状态量，未果则降级为已知边界并写入规格与用户手册。

### P203 · iPhone HDR（10-bit HLG HEVC）素材播放挂死 {#p203}
- **类型 / 状态**：缺陷修复｜🟡 **挂死已不复现（走 FFmpeg 软解兜底），但根因未修故未关闭**
- **出处**：`evidence/2026-11-01-iphone-hevc-blockers/README.md`、`evidence/2026-11-05-p203-recheck/P203_RECHECK_2026-11-05.md`
- **要点**：Intel Iris Xe D3D11 `p010OverlaySupport: "SOFTWARE"` 导致 WebCodecs 产出 `fmt:null` 坏帧；已交付 HDR 检测告知、`DECODE_FRAME_FORMAT_NULL` 首次降级、`-noautorotate` 与白屏崩溃修复；仍缺「代理就绪后是否仍挂死」与冷却回切安全验证。

### P204 · 含 edit list（`elst`）偏移素材全帧 `no sample` {#p204}
- **类型 / 状态**：缺陷修复｜🟡 **已修复并由 remux 对照实机验证（首帧 85000→0），完整播放仍待 P203 收口**
- **出处**：`decode-worker.worker.ts` / `evidence/2026-11-01-iphone-hevc-blockers/README.md`
- **要点**：根因为 demuxer 未应用 `elst` `media_time` 导致索引首帧 PTS 偏移 0.625s；待结合 P203 完成完整播放闭环验收。

### P207 · 预览代理自动生成、自然切换与持久化边界 {#p207}
- **类型 / 状态**：缺陷修复｜🟡 **已交付导入自动生代理与暂停切换，保留两项非阻塞边界**
- **出处**：`apps/desktop/src/app/App.tsx` / `app/preview/source-resolver.ts`
- **要点**：① PiP 手势期间 `playing && !gestureHoldRef.current` 传 false 会被当作自然切换点重建会话；② 就绪切换仅认本会话 `importAsset` 登记的素材（早前会话素材需切项目/重启生效）。

### P216 · 解码能力探测使用固定合成 codec string 而非真实 `hvcC` {#p216}
- **类型 / 状态**：缺陷修复｜🟡 **暂依赖运行时坏帧降级兜底，待决定探测策略路线**
- **出处**：`apps/desktop/src/app/preview/decode-capability.ts:23-57`
- **要点**：`probeWebCodecsRow` 只探测固定 Main/Level120 串且 `p010OverlaySupport` 未接入生产决策；后续从「接入 `getGPUInfo` `overlayInfo` / 从 `ffprobe.py` 补全 `profile/level` / 契约明定仅粗筛」三选一推进。

### P188 / P187 · 音频淡入淡出与响度统一遗留边界 {#p187}
- **类型 / 状态**：工作包边界｜⏳ **权威/导出已对齐，两处交互/入口未补**
- **出处**：`STATUS.md` §3
- **要点**：① Interactive 预览路径（`HTMLMediaElement`）尚未应用 `fade_in_us`/`fade_out_us`（P188）；② 响度统一当前仅片段级单片段入口，「全片一键统一」独立入口未交付（P187）。

---

## 3. AI 能力线、多机位与评测边界

### P161 · 中文语义模型分发与许可未闭环（W3.1 对最终用户阻塞） {#p161}
- **类型 / 状态**：风险对策｜🟡 **`AIVS_MODEL_CDN` 通道已可配置，但无公网托管点导致装机用户仍不可用**（2026-11-28 用户裁决：路线规划中暂按可用对待，许可核实与托管延后，不阻塞 0.1.0，见 P237 D1）
- **出处**：[`specs/local-intelligence.md`](specs/local-intelligence.md) §2 / `resources/model-manifests/chinese-clip-vit-base-patch16.json`
- **要点**：fp32 中文双塔 719 MB 仅放行 `https://` 与本机 `file://`，`download_url: null` 暂存于私有备援；上游许可为 `upstream-undeclared`，对外分发前需确认许可或更换替代模型并重跑评测。

### P165 · W3.3 关键帧理解打标质量人工盲评 {#p165}
- **类型 / 状态**：验收项｜🟡 **盲评工具与 9 帧小样本记录已归档，仍不得宣称生产质量达标**
- **出处**：[`specs/keyframe-understanding.md`](specs/keyframe-understanding.md) §2 A9 / `evidence/2026-10-21-w33-keyframe-blind-eval/`
- **要点**：9 帧样本无对照（CI ±25pp），`test_keyframe_wording.py` 正则负向守卫已接入 CI。

### P181 · W3.3 探测路由 `project_id` 耦合细节 {#p181}
- **类型 / 状态**：架构待办｜⏳ **`POST /providers/{id}/vision-capability` 当前读取 `project_id` query 参数**
- **要点**：若将来收紧为纯 Provider 级探测，需要能承载探测载荷的非项目级载体。

### P149 · W4.1 工作单未实现步骤（`roughcut` / `style`）延后与拒收守卫 {#p149}
- **类型 / 状态**：工作包（延后）｜🟡 **已补测试守卫并维持延后，暂不立项**
- **出处**：[`specs/ai-platform.md`](specs/ai-platform.md) §3 / `worklist.py` / `test_worklist_service.py`
- **要点**：`prepare`/`create`/`advance` 对 `roughcut`/`style` 返回 `WORKLIST_STEP_UNAVAILABLE` 且零副作用；触发条件：`roughcut` 需出现真实全链一键需求并复用 `planning.adopt()` 七道校验，`style` 需先立独立设计门。

### P147 / P148 · W4.2 多信号融合排序质量真值与权重版本边界 {#p147}
- **类型 / 状态**：风险对策｜🟡 **结构正确性 F1–F6 与版本化等权表已落地，质量提升不作无真值承诺**
- **出处**：[`specs/local-intelligence.md`](specs/local-intelligence.md) §3
- **要点**：因无客观真值（P147），不声称比单源更优，质量待人工盲评协议；权重显式化写入契约 `FUSION_WEIGHTS_VERSION`（P148），当前登记为「未调优」。

### P198 · AI 能力矩阵远期未开展项登记 {#p198}
- **类型 / 状态**：工作包｜🟡 **按总纲定位暂未开展（非遗漏）**
- **出处**：[`specs/ai-platform.md`](specs/ai-platform.md) §2.2
- **要点**：覆盖 `W3.4` 蒙太奇/匹配剪辑、`W4.3` MCP 暴露层（与 P236 协同）、`W5.1` 全能力对标验收、`U8` 后续质量盲评、帧级 egress 审计扩展。

### P81 / P84 · W2.1 多机位时钟漂移分段拟合与真实多机位素材缺口 {#p81}
- **类型 / 状态**：风险对策｜🟡 / ⏳ **P81 已实现远距窗口拒绝（>10ms 报 `clock_drift`），缺真实多机位样片取证（P84）**
- **出处**：[`specs/camera-sync.md`](specs/camera-sync.md) §1
- **要点**：短于 `≈22s` 素材 `drift_us=None` 属已声明限制；分段偏移与验收 9（共同声音事件人眼对拍）待取得真实双机位样片后再定，禁止以合成素材顶替。

### P89 / W2.2-ADR0009 / P132 · W2.2 说话人层与 W2.3 冻结线 {#p132}
- **类型 / 状态**：冻结 / 验收约束｜❄️ / ⏳ **W2.2 停在 D3 降级形态，W2.3 按 ADR-0009 冻结**
- **出处**：[`adr/0009-w22-diarization-closeout.md`](adr/0009-w22-diarization-closeout.md) / [`specs/camera-sync.md`](specs/camera-sync.md) §3
- **要点**：`P89` 仍缺跨语言/重叠/远场单麦/用户自有语料精度证据；`P132`（下游 W2.3 读 speaker turn 前必须校验 `quality_status == 'validated'` 且含负向对照）必须随未来 W2.3 立项门一并落地。

### 其他已知 AI / 信号边界 {#ai-misc}
- **4K60 常态约 1.0s 未归因差异**：同素材三次复跑约 `7.3–7.8s`（原 `5.4s`，已归因 ~19% 机器变慢，余 ~1.0s 未归因，仍远低于 10s 门限），见 [`specs/local-intelligence.md`](specs/local-intelligence.md) §1。
- **`json_schema` 适配器网关兼容性**：部分网关对 `oneOf` 拒绝返回 400，`script` 类适配器为当前主兼容通路；Provider 域独立工作单持续跟踪兼容面。

---

## 4. 桌面 UI、E2E 与手工验收欠账

### P220 · 旧 `--vc-*` 令牌与 Graphite `--dlg-primary` 并存技术债 {#p220}
- **类型 / 状态**：技术债｜⏳ **已裁决（P237 D3），待实施**
- **出处**：`apps/desktop/src/styles.css`（`--vc-accent: #25d3ac` 约 29 处引用 vs `--dlg-primary: #35d6ae`）
- **要点**：影响全局时间线/面板/工具栏视觉；已裁决以 `--dlg-primary` 为单源：先 `--vc-accent: var(--dlg-primary)` 别名，再逐步替换，最后删旧令牌。

### P192 / P194 · E2E 共享选择器与剩余缺陷地图 {#p194}
- **类型 / 状态**：工作包｜🟡 **族1/族2/族4 与 stage2a/stage2b/m5-timeline/p33-eof-replay 已修或定性，仍余少量待办**
- **出处**：`apps/desktop/e2e/`
- **要点**：`P192`（`selectProject` 选择器链）已完成核心修复；`P194` 剩余项为 `stage4d:323`（本地网关不支持 `/images/generations`）、`stage4d` env-gate 凭据用例与 `p33-seek-play`（`test.fixme`）。

### Wave1-L3 · 剪辑手法桌面真机听感 / 审美人工签字 {#wave1-l3}
- **类型 / 状态**：人工验收｜⏳ **自动化（`wave1-editing-tools.electron.spec.ts`）已覆机器可判项，待人工听感签字**
- **出处**：[`specs/timeline-and-editing.md`](specs/timeline-and-editing.md) §5.4

---

## 5. 代码与测试结构债（Wave D 延后专题） {#td-wave-d}

> 来源：2026-11-28 代码与测试审计中识别的重型结构重构项，均已从日常加速/去重轮次中显式延后，后续按专题独立规划门推进。

- **TD-01 · Core 巨型单文件拆层**：`services/core/src/aivs_core/{timeline,database,rendering/ffmpeg,rendering/ir}.py` 职责高度耦合（Schema / 迁移 / 领域校验 / 命令编译同文件），后续按子域垂直拆包。
- **TD-02 · Desktop 巨型会话与根组件拆分**：`apps/desktop/src/app/preview/preview-session.ts`（~2,840 行）与 `App.tsx` 状态编排待拆分为独立控制器与子视图钩子。
- **TD-03 · 跨 IPC 域敏感字段与分页校验统一**：各 Electron Main IPC 模块对 `rendererSafe` 敏感键集合存在域内特化要求（如 `document`、`requirement`、`visual_direction` 等）；需逐域审计统一策略后，再收敛 `rendererSafe` 与 `pageQuery`。
- **TD-04 · SQLite 历史迁移快照归并**：`database.py` 当前保留 44 个增量 SQLite 迁移版本（仅做初始化空库时的单次预备与同版兼容检查加速）；长期需评估基线 Schema 快照归并与旧版升级验证方案。
- **TD-05 · CSS 样式守卫测试与真实 DOM/布局快照收敛**：`apps/desktop/tests/` 中约 20 份静态 CSS 级联守卫测试已收敛解析/特异性公共辅助函数；长期可逐步将脆弱规则文本断言替换为集中令牌契约与真实布局测试。
