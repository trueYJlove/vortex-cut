# 播放时钟直线语义（2026-11-10 · Round 11）

## 参照
OpenFilm `editor/player.ts`：
```js
export function anchorTime(a, now) {
  return a.t + (Math.max(0, now - a.at) / 1000) * a.rate;
}
```
播放时只广播一条直线 `(t, at, rate)`，消费方各自外推——**整段播放零通知**，
只有 seek/暂停才换线。

我们的原实现：`playheadStore` 只有离散值 `timeUs`，播放期间必须每帧 `set()`，
每次都要走「微任务合并 + 通知全部订阅者」。

## 实现

### `playhead-store.ts`
- 新增 `PlayheadLine { tUs, atMs, rate }` 与 `lineTimeUs(line, nowMs)`
- 新增 `getLine()` / `startLine()` / `stopLine()`
- `get()` 在有直线时按直线外推，无直线时退回离散值（**旧行为完全不变**）
- `startLine` 只触发一次通知；之后消费方自行外推

### `TimelinePlayheadLayer.tsx`
订阅回调之外**额外挂一个 rAF 循环**：检测到直线启动就按它逐帧外推绘制，
结束后自动停。这样播放期间的 DOM 更新不依赖 store 通知。

### `App.tsx`
合成预览（`previewMode === "synthetic"`）播放时 `startLine`、停止时 `stopLine`。
交互预览不启用——那条路径由 HTMLMediaElement 自身时钟驱动，语义不同。

## 验证（真实软件）
| 项 | 结果 |
|---|---|
| 预览模式 | 合成预览 |
| 播放头采样（12 次 / 约 2 秒） | 238 → 249 → 258 → 269 → 279 → 290 |
| 不同位置数 | 12 / 12 |
| 位移增量 | 约 11px/160ms，与 60px/s × 1.0× 一致，**线性均匀** |
| 拖动期间 rAF | p50 17ms / max 17ms，零掉帧 |

## 回归
桌面 143 文件 / 1327 测试通过，typecheck 通过。

## 说明
`line()` 目前只在合成预览路径启用。交互预览仍走它自己的 100ms interval
（那条路径的时间由媒体元素决定，不能外推）。若将来交互预览也要并入，
需要先确认媒体元素的 currentTime 与时间线时间的换算关系。

## 未完成
1. 区间选取（range band）——真实缺失，需先定用途
2. 标记行（markers）——真实缺失