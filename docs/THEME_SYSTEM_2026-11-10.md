# 主题系统实施记录（2026-11-10 · Round 8）

## 交付
三态主题：深色（默认）/ 浅色 / 跟随系统。参照 OpenFilm 的 `settings/theme.ts`。

### 新增文件
- `src/app/theme.ts`：`ThemeMode` 类型、`setThemeMode`、`useThemeMode`、
  `useResolvedTheme`、`initTheme`；键 `vortexcut.theme`。

### 关键实现点
1. **首帧无闪白**：`src/renderer/index.html` 内联脚本在样式表求值前写
   `<html data-theme>` 与 `colorScheme`。与 `theme.ts` 规则严格一致
   （键名、默认 dark、system 解析方式），改一处必须同步另一处。
2. **system 实时跟随**：`matchMedia('(prefers-color-scheme: dark)')` 的 change
   事件里重新解析并广播——不只在启动时判定一次。
3. **跨窗口同步**：`storage` 事件，兄弟窗口改主题时本窗口跟随。
4. **令牌覆盖而非改选择器**：全部通过覆盖 CSS 变量实现，
   不触碰任何布局/交互规则。

## 踩到的两个真实问题（都已修）

### 1. `--ws-*` 覆盖无效：元素自身声明胜过继承
`--ws-*` 定义在 `.editor-shell` 元素上，而 `[data-theme="light"]` 挂在 `<html>`。
CSS 自定义属性在**元素自身**的声明优先于从祖先继承的值，因此光写
`[data-theme="light"] { --ws-panel: ... }` 完全不生效。
实测：只写后者时 `.library-pane` 仍是 `rgb(24,24,27)`。
修法：改成 `[data-theme="light"] .editor-shell { --ws-panel: ... }`。

### 2. 追加到文件末尾破坏了令牌终值测试
`dialog-graphite-style.test.ts` 断言深色令牌的**最后一次定义**必须落在
文件最后 20% 内（防止历史块反超追加层）。我把浅色覆盖追加在末尾，
导致 `lastIndexOf` 命中浅色值，测试红。
修法：把浅色块移到“令牌终值：必须位于文件最末”注释块**之前**。
约束仍然成立（深色终值依旧在末尾），浅色覆盖靠选择器特异性生效。

## 覆盖范围
- `--ws-*`（工作区，64 处使用）——需 `.editor-shell` 前缀
- `--vc-*`（旧体系，106 处使用）——直接挂 `[data-theme]`
- `--dlg-*`（弹窗）——只覆盖颜色令牌，**不改任何选择器或尺寸**，
  因此不违反“不改已完成弹窗”的约束
- `--tl-playhead-*`：浅色下改为深红线以保证对比度

## 验证（真实软件实测）
| 项 | 深色 | 浅色 |
|---|---|---|
| `data-theme` | dark | light |
| body 背景 | rgb(20,20,22) | rgb(236,236,237) |
| 面板背景 | rgb(24,24,27) | rgb(247,247,248) |
| 面板文字 | — | rgb(26,26,31) |
| 弹窗 | 深色 | 浅色（截图确认） |

桌面 143 文件 / 1327 测试通过，typecheck 通过。

## 未完成（后续轮次）
1. 系统设置页重构（左侧导航 + 分区 + 搜索）——当前仍是单页 fieldset 堆叠
2. 时间线视觉规格对齐（标尺 20 / 轨高 56-44 / 行间隙 2 / 留白 10）
3. 时间线交互补齐（吸附提示 / 热光标 / 滚轮缩放 / 框选 / 轨道排序）
4. 区间选取与标记（新功能，需先定语义）