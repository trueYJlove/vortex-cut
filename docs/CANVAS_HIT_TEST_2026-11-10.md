# 画布交互命中缺陷修复（2026-11-10 · Round 4）

## 结论
画中画的 9 个交互手柄（8 个缩放手柄 + 1 个旋转手柄）此前**大量不可用**。
系统性探测结果：**BLOCKED 2/9 → 修复后 0/9**。

## 三处独立的层级/几何缺陷

### 1. 进度条压住舞台底部手柄（Round 3 已修）
- .progress 的 z-index:8 > .sp-handle 的 z-index:3
- 进度条以 bottom:0; height:16px 横跨舞台底部
- 落在底部 16px 内的手柄指针被吞
- 修复：.progress 降为 z-index:2
- 验证：elementFromPoint 由 progress 变为 sp-handle sp-se；
  拖动盒子 433 -> 583，落库 scale 1.345

### 2. preview-canvas 裁剪掉越界手柄
- 旋转手柄画在盒子顶边上方 26px，盒子贴上边时落出画布范围
- .preview-canvas 的 overflow:hidden 直接把它裁掉
- **判定依据**：把手柄 z-index 提到 9999 仍然点不到
  （裁剪先于层叠生效，层级调整无效——这是区分裁剪与遮挡的关键实验）
- 实测：旋转手柄中心 y=103，画布 top=121，完全在可视区外
- 修复：.preview-canvas 改为 overflow:visible（画面裁剪由媒体元素的
  object-fit 保证，背景与圆角不变）
- 验证：旋转手柄 elementFromPoint 返回 sp-rotate

### 3. 旋转手柄压住北向缩放手柄
- .sp-rotate 在 top:-26px（覆盖 -26..-12）
- .sp-handle.sp-n 在 top:-6px（覆盖 -11..0）
- 两者都水平居中于盒子上边，实测 sp-rotate 压在 sp-n 之上
- 修复：.sp-rotate 上移到 top:-34px，连接线 ::after 延长到 20px
- 验证：BLOCKED 1/9 -> 0/9

## 最终验证
| 项 | 结果 |
|---|---|
| 9 个手柄命中测试 | **0 blocked** |
| 缩放拖动 | 433 -> 448 -> ... -> 583，落库 scale 1.345 |
| 桌面测试 | 143 文件 / 1327 通过 |
| typecheck | 通过 |

## 方法论教训
本轮先后两次误判：以为是 React state 陈旧（改了守卫）、以为是 prop 展开顺序
覆盖 onPointerDown（改了顺序）。两处都是真问题，但都不是主因。
真正一击命中靠的是 **elementFromPoint 探测实际命中元素** +
**把 z-index 提到 9999 以区分裁剪与遮挡**。
此后遇到交互失效，应先做命中探测，再改代码。

## 未处理
1. 首遍拖动约 60ms GPU 预热（仅一次）
2. 素材池形态差异（OpenFilm 文件夹式 vs 平铺列表）