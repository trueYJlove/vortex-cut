# 证据：浅色主题系统性治理（2026-11-11）

对应实现记录 `docs/LIGHT_THEME_FIXES_2026-11-11.md`，登记 `docs/STATUS.md` §4 **P224**。

**取图条件（before / after 完全一致）**：Electron 真实构建、内容区 **1440×900**、
同一项目（1 视频轨 + 1 图片轨 + 1 文字轨 + 1 音频轨）、同一浅色主题。
**唯一变量是 `styles.css`**：`before-*` 用改前快照 `.tmp/styles-backup.css` 重新
`electron-vite build` 后拍摄，`after-*` 用令牌化后的样式表同法拍摄。

| 文件对 | 内容 |
|---|---|
| `before-light-editor.png` / `after-light-editor.png` | 主编辑器全窗口 |
| `before-light-project-dropdown.png` / `after-light-project-dropdown.png` | 项目下拉展开态（用户报告的问题面） |
| `before-light-project-mgmt.png` / `after-light-project-mgmt.png` | 项目管理弹窗 |
| `before-light-command.png` / `after-light-command.png` | 命令搜索 |
| `before-light-provider.png` / `after-light-provider.png` | Provider 设置 |
| `before-light-export.png` / `after-light-export.png` | 渲染与导出 |
| `before-light-settings.png` / `after-light-settings.png` | 设置 |
| `before-dark-editor.png` / `after-dark-editor.png` | **深色回归基线**（令牌化必须不改深色） |
| `before-report.json` / `after-report.json` | 每个表面的自动扫描原始结果 |

## 扫描口径

对每个表面遍历可见元素，报两类：

1. **深色底** —— 背景平均亮度 < 70 且不透明度 ≥ 0.5（浅色外壳里不该出现的深色块）；
2. **低对比文字** —— 前景与"实际生效背景"的 WCAG 对比度 < 2.5。

## 结果

| 表面 | 深色底（前→后） | 低对比（前→后） |
|---|---|---|
| 主编辑器 | 3 → 1 | 0 → 0 |
| 项目下拉 | 4 → 1 | **2 → 0** |
| 项目管理 | 0 → 0 | 0 → 0 |
| 命令搜索 | 0 → 0 | 0 → 0 |
| Provider 设置 | 0 → 0 | 0 → 0 |
| 导出 | 0 → 0 | 0 → 0 |
| 设置 | **1 → 0** | 0 → 0 |
| 深色基线 | 28 → 29 | 0 → 0 |

**改前项目下拉的两处低对比**（就是用户说的"还是不正常"）：
`切换项目`/`本机项目` 标题 **1.18**（`rgb(232,237,240)` 落在白底上）、
`项目管理` **2.26**。

**改后剩下的 1 个深色底是 `.preview-canvas`（纯黑 205×365）** —— 视频画面显示容器，
浅色主题下也应为黑（与参照软件一致），非缺陷。

**深色基线 28→29 的差值是噪声**：预览区「缓冲中」徽标在两次截图里出现时机不同。
为此单独测了同构建连续两次截图的噪声底 = **25,781 像素（1.989%）**，
而"改前 vs 改后"深色逐像素 diff 只有 **1,387 像素（0.107%）**，全部落在预览画布内。
