# P233 OpenFilm 主界面交互对齐续项验收记录

> 本记录描述一次验收时点；项目当前状态以 [`docs/STATUS.md`](../STATUS.md) 为准。

## 1. OpenFilm 源码参照

| Vortex Cut 改造 | OpenFilm 参照源码 | 对齐内容 |
|---|---|---|
| 左上品牌菜单 | `packages/openfilm/studio/ui/src/components/AppMenu.tsx`、`shell/ProjectFrame.tsx` | 菜单入口从顶栏移到品牌标志；保留 Vortex Cut 命令与视觉规范，并补键盘方向键、Escape 关闭和焦点归还。 |
| 项目管理 | `components/ProjectsView.tsx`、`ProjectsSidebar.tsx`、`ProjectCard.tsx` | 采用桌面项目库结构，支持搜索、状态筛选、排序、卡片/列表浏览及项目切换；项目操作限定为 Core 已有的创建、打开、改名、归档和恢复。 |
| 预览窗格控制 | `components/ProjectView.tsx`、`components/InspectorWorkspace.tsx` | 素材窗格和属性窗格的按钮实际收缩网格列；保留 Vortex 专属预览设置，并提供 Escape、外部点击关闭与焦点归还。 |
| 逐轨高度 | `components/Timeline.tsx`、`lib/track-heights.ts` | 逐轨调高/调低、双击复位、键盘调整，并按项目分别保存高度。 |
| 预览缩放与平移 | `components/ViewerZoom.tsx`、`lib/viewer-zoom.ts` | 指针锚定缩放、放大后滚轮/中键/键盘平移、适应画布，以及容器尺寸变化后的画面恢复。 |

## 2. 验收交叉表

| 验收项 | 结果 | 证据 |
|---|---|---|
| A1 品牌菜单及键盘可达性 | 通过 | Electron E2E 从左上 Vortex Cut 品牌按钮打开主菜单；方向键导航到项目管理，Escape 关闭后焦点回到触发按钮。 |
| A2 项目管理操作和状态反馈 | 通过 | Electron E2E 验证搜索、状态筛选、卡片/列表切换、新建项目、重命名、归档/恢复及项目切换；归档/恢复后的状态徽标按 Core 返回值更新。 |
| A3 预览工作区面板开关 | 通过 | Electron E2E 验证素材栏关闭时左侧网格列消失、属性栏关闭时预览区变宽；设置弹层支持 Escape/外部点击关闭并返回焦点。 |
| A4 时间线逐轨高度 | 通过 | Electron E2E 拖动行分隔线、以 Home 复位，并切换项目检查高度不会串用；`timeline-geometry.test.ts` 56 项覆盖行高边界与几何计算。 |
| A5 预览缩放、平移和尺寸变化 | 通过 | Electron E2E 使用实拍视频验证 Ctrl/Command+滚轮锚点缩放、普通滚轮平移、中键拖动、方向键平移、适应画布、1040×760 与 1440×900 窗口尺寸布局；缩放过程中暂停帧在布局稳定后恢复。 |
| A6 真实素材和多轨时间线 | 通过 | Electron E2E 使用 `test-results/m6-multi-track-33712-1795350332861/素材.mp4` 实拍视频，验证新增视频/文本轨、跨轨移动、拖入素材、轨道属性、轨道顺序及删除约束。最终整窗截图中预览与 V1/V2/V3 片段均显示同一实拍内容。 |
| A7 窄窗项目库搜索布局 | 通过 | 900×720 下验证搜索输入框完整位于搜索字段边界内；修复通用 `.modal label` 网格规则覆盖项目搜索栏 flex 布局的问题。 |

## 3. 验收证据

- Electron：`apps/desktop/e2e/m6-multi-track.electron.spec.ts`，1 项通过，约 33 秒；使用上表中的实拍素材。
- Desktop TypeScript：`pnpm --filter @aivideo/desktop typecheck`，通过。
- 定向 Desktop 单元测试：timeline geometry、viewport index、dialog graphite style，110 项通过。
- Electron 测试构建：`pnpm --filter @aivideo/desktop build:e2e`，通过。
- 状态文档守卫：`uv run --locked --extra dev pytest services/core/tests/unit/test_status_doc_consistency.py`，10 项通过（`UV_CACHE_DIR` 指向仓库 `.tmp/uv-status-cache`）。
- 格式检查：`git diff --check`，通过。
- 整窗实拍验收截图：[`multi-track-real-media.png`](../../../test-results/m6-multi-track-22488-1795361484987/multi-track-real-media.png)。
- 项目库验收截图：[`project-manager.png`](../../../test-results/m6-multi-track-22488-1795361484987/project-manager.png)。
