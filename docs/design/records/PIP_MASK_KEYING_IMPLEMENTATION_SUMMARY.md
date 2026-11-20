# 画中画、蒙版与抠像实现摘要（历史，2026-09）

> **点时间实现记录。** 原实施计划已由本摘要取代；其中的后续限制清单不是当前状态。现行边界查 [`STATUS.md`](../../STATUS.md) §2–§4，并参考 P231 预览画布规划门。

## 实现结论

PIP 变换、clip 蒙版与色键作为可选字段沿 TimelinePatch、IR 和 FFmpeg 渲染链传递；旧 Revision 缺省时保持既有语义，未新增数据库迁移。PIP 使用覆盖轨合成；蒙版提供 linear/rect/ellipse 几何 alpha；色键用 FFmpeg `colorkey`，与蒙版组合时合并 alpha。Desktop 提供位置/缩放/旋转/不透明度、蒙版和抠像控制。

## 原验收证据

- Core 测试覆盖 set/clear、diff 和范围校验；真渲染验证椭圆蒙版、反选和绿幕去除；Desktop 几何测试覆盖 8 向缩放。
- 该轮记录的 Core 测试数为 523 passed（历史数字，不代表当前测试规模）。
- 验收复核修正了 PIP 位置从边缘坐标统一为中心点归一化坐标，并修复覆盖轨重构图分支引用错误；这些历史实现细节见 `apps/desktop` 与 Core 测试记录。

原计划 §8 的限制清单含后来被 P231 重新设计的预览语义和旧实现边界；为避免把旧结论当成现状，本摘要不继续复制该清单。需要追溯当时的规格时，可看[多轨时间线设计](../M2_MULTI_TRACK_TIMELINE_DESIGN.md)、[自由定位设计](../M2_V1_FREE_POSITIONING_DESIGN.md)和[预览画布规划门](../../requirements/P231_PREVIEW_CANVAS_PLANNING_GATE_2026-11-17.md)。
