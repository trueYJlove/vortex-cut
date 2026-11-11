# 标记行实施记录（2026-11-10 · Round 12）

## 交付
时间线标记行，规格对齐 OpenFilm 的 MARKER_ROW_H = 16。

### 新增文件
- src/app/timeline/markers.ts：标记类型、预置色、localStorage 读写、排序
- src/app/timeline/MarkerLane.tsx：标记行组件

### 关键设计
1. 浮在轨道区顶部、不占布局高度（OpenFilm 同款）：绝对定位在标尺下方
   16px，因此加一个标记或删掉最后一个，轨道不会上下跳动。只在有标记时渲染。
2. 16px 行高、8x12 图钉、ew-resize 光标：拖动改时间，悬停放大 1.15 倍。
3. 拖动语义与片段一致：pointermove 只更新预览位置，松手才落库。
4. 贯穿引导线：悬停/拖动时在整条时间线上画该标记颜色的虚线
   （held 时 100% 不透明，悬停 55%）。
5. 编辑面板：双击图钉打开，可改备注与颜色、可删除；右键直接删除。

## 存储范围（必须说明的限制）
标记只存 localStorage，不进 TimelineDocument / Revision。
因此换机器或重装会丢失、不随 Revision 回滚、不能撤销。

这是刻意取舍：进数据模型要新增 add_marker 等 patch 操作，并连带改 Core 的
PATCH_OPERATIONS、契约 schema 三处同步、迁移与 STATUS.md 第 1 节的
patch_operations 字段——超出本次「不改 Python Core 架构」的硬约束。

升级路径已留好：markers.ts 的 loadMarkers/saveMarkers 是唯一存储出入口，
将来改成调 Core 时 MarkerLane 与 TimelineCanvas 无需改动。

## 验证（真实软件）
| 项 | 结果 |
|---|---|
| 标记行高度 | 16px |
| 渲染标记数 | 1（写入 localStorage 的一条） |
| 图钉颜色 | rgb(255,215,110) = #ffd76e，与存储值一致 |
| localStorage 读写 | 正常 |
| 位置 | 1.5s 处，落在 00:00 与 00:02 刻度之间 |

## 回归
桌面 143 文件 / 1327 测试通过，typecheck、build 通过。

## 未做
区间选取（range band）——需要先定用途（导出范围/删除静音/循环播放），
未定用途做出来是空壳。