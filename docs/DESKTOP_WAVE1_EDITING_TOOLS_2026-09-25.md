# Desktop Wave 1 剪辑手法 UI —— 实施记录

> 实施：YeJing（Desktop），2026-09-25。验收：LiuKeAi。
> 设计：`docs/ui-mockups/wave1-editing-tools/DESIGN.md`（2026-09-25 用户确认四点）。
> 目录：原 `docs/uiux/` 已并入 `docs/ui-mockups/`。

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

| # | 项 |
|---|---|
| L1 | L/J 词戳自动拉取（ASR transcript → words） |
| L2 | 卡点 beat 自动从 BGM 分析结果注入 `beats_us` |
| L3 | 真机手测清单签字 |
