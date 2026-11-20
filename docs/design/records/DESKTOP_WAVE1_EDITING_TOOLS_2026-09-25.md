# Desktop Wave 1 剪辑手法 UI —— 实施记录

> 实施：YeJing（Desktop），2026-09-25。验收：LiuKeAi。
> 设计：`docs/design/ui-mockups/wave1-editing-tools/DESIGN.md`（2026-09-25 用户确认四点）。
> 目录：原 `docs/uiux/` 已并入 `docs/design/ui-mockups/`。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 面板 | `EditingToolsPanel`：去停顿 / 卡点 / L-J 三页壳 + 干跑→提案→采纳 |
| 参数 | 去停顿阈值/最短静音/pad；卡点时长/每镜拍数/镜头多选；L-J 自动/J/L + offset |
| 入口 | 工具菜单「剪辑手法」；属性面板「手法」页签；素材箱视频行「剪辑手法」 |
| 高级 | 工具菜单「剪辑语法（高级）」= 原 JSON 参数面板 |
| 样式 | `styles.css` `.editing-tools-*`（对齐原型暗色规范） |

## 2. 验收核对表

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 三页统一壳层 | ✅ | `EditingToolsPanel` tabs + 语境条 + 左右分栏 |
| 2 | 去停顿参数默认值对齐 Core | ✅ | 0.05 / 400ms / 50ms |
| 3 | 卡点 segments + beats_per_shot | ✅ | 镜头多选 → `beat_sync` params |
| 4 | L/J 方向三态 + offset 窗 300–500 | ✅ | seg 控件 + range |
| 5 | 干跑→提案→采纳链 | ✅ | 复用 `prepareEditingGrammar` / `propose` / `apply` |
| 6 | 属性面板「手法」页签 | ✅ | `ClipProperties` topTabs + `onOpenEditingTools` |
| 7 | 素材箱快捷入口 | ✅ | 视频行剪刀按钮 |
| 8 | 回归 | ✅ | Desktop **708 tests** + typecheck 绿 |

## 3. 边界

- **L/J 词戳**：`params.words` 为空时由 Core 从 `transcript_words` 注入；无转录则报 `NO_WORDS`（文案引导先转录）。
- **卡点 beat**：`beats_us` 从 `beat_grids` 注入（`bgm_asset_id` 或首 segment 素材）。
- **去停顿**：仍需该素材 CV 音频能量（先「AI 信号分析」）。

## 5. 验收反馈修复（2026-09-25 第二轮）

| 问题 | 修复 |
|---|---|
| UI 未 1:1 对齐原型 | 重做 `EditingToolsPanel`：et-shell/bar/timeline/av/proposal 卡 + 原型文案与布局 |
| 干跑/生成提案报错 | Core `_signals_for` 注入 beat/词戳；`lj_cut` 支持 `mode=auto`；Desktop 不再传空 words |

回归：Core 语法 36 项 + Desktop 708 项绿。

## 4. 剩余范围

| # | 项 | 状态 |
|---|---|---|
| L1 | L/J 词戳自动拉取（ASR transcript → words） | ✅ **2026-10-10 核销**——Core `_signals_for`（`params.words` 为空时按 clip 素材拉 `transcript_words`，`test_split_edit.py::TestLjSignalsInjection`）+ 面板词戳来源徽标（`EditingToolsPanel`：检查该素材 ready 转录的 words 非空 → 「ASR 词级转录 ✓ / Core 自动拉取」；无转录给「先在转录页转录」指引，不静默——设计 §3.3 的来源可见性落地）。能量代理路径按设计「禁止静默混用」**未实现**：无词即 `NO_WORDS` 显式引导 |
| L2 | 卡点 beat 自动从 BGM 分析结果注入 `beats_us` | ✅ **2026-10-10 核销**——注入半边早已在 Core（`_signals_for` beat_sync 分支），**产出半边此前全仓缺失**（`BeatGridService` 零调用方，`beat_grids` 生产环境永远为空 → 卡点必失败）。本次补齐触发链：`POST /api/v1/projects/{p}/assets/{a}/beat-analysis`（generate=True 登记作业，ready/queued/running 幂等短路，stale 让位，音频/视频素材均可）+ `jobs` kind=`beat_analysis` 派发（waveform 同型轻作业、light 档优先级 2）+ `BeatGridService.run_beat_job`（stat 守卫 → FFmpeg PCM → numpy 检测 → 落库）+ 面板「节拍网格」状态行与「分析节拍」按钮（轮询对账，subscribeJob 死通道不依赖）+ `_signals_for` 查询补 `algorithm_version` 过滤（与 `latest_beat_grid` 同口径，旧版本网格不进注入）。验证：单元 8 项（含 **110BPM 真实 click 素材全链**：登记→执行→落库→prepare 注入→非空操作；负向对照：去版本过滤即红）+ API 集成 5 项（登记/幂等/stale/401/越权）+ 面板 5 项（缺网格提示+按钮+轮询收起 / ready 无按钮负向对照 / unavailable 可重试 / 词戳徽标两态） |
| L3 | 真机手测清单签字 | ⏳ **机器可判定部分已完成（2026-10-10）**：`apps/desktop/e2e/wave1-editing-tools.electron.spec.ts` 覆盖三页「干跑→提案→采纳」全链 + 卡点分析节拍 + L/J 词戳两态 + 通用项（本轮 20 项通过 / 0 失败 / 2 观察），逐项证据见 `WAVE1_L3_AUTOMATION_EVIDENCE_2026-10-10.md`；执行中发现并修复 P74–P77。**人工签字项**：听感/审美（J/L 入声错位、卡点对拍、去停顿跳切观感）见 `WAVE1_MANUAL_CHECKLIST_2026-10-10.md` |
