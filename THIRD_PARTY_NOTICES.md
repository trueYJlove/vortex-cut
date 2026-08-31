# Third-Party Notices

本仓库在实现过程中参考或移植了以下开源项目的代码与设计。各条目注明来源、许可证与使用方式。

## OpenCut classic (OpenCut-app/opencut-classic)

- **来源**：https://github.com/OpenCut-app/opencut-classic
- **许可证**：MIT License，Copyright 2025-2026 OpenCut
- **使用方式**：代码级移植（MIT 允许闭源合入）。2026-08-29 Timeline Round 4 从其 `apps/web/src/timeline/` 模块移植了以下纯逻辑设计：
  - **缩放锚定光标**：`apps/desktop/src/app/timeline/geometry.ts` 的 `zoomAtAnchor()` 移植自其 `zoom-utils.ts` / `scale.ts` 的锚点数学（缩放时保持光标下的时间点在屏幕上不动）。
  - **拖拽边缘自动滚动**：`TimelineCanvas.tsx` 的 rAF 自动滚动循环与 `geometry.ts` 的 `dragEdgeAutoScrollStep()`（边缘区内速度随距离递增、拖动目标随滚动量同步平移）移植自其 `use-edge-auto-scroll` 的模式。
  - **网格吸附分档**：`geometry.ts` 的 `gridSnapCandidates()` 参考其 `snapping/threshold.ts` 的"像素阈值 → 时间步长"换算思路（帧级 → 0.5s → 1s → … 随缩放分档）。

以上移植均为对设计逻辑的重新实现或直接合入，未复制其与 Next.js/EditorCore 耦合的组件层。

---

*其它开源依赖的许可证见各 `package.json` / `pyproject.toml` 及其上游仓库。*
