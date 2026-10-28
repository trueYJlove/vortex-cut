# P200 归因测量 —— 窗口取数延迟的层归属（2026-10-28）

> 状态源一律引用 `docs/STATUS.md`；本文只记录**一次测量的事实**，不声明工程状态。
> 复现：`uv run --locked --extra dev python tools/probe_p200_window_attribution.py`

## 0. 结论先说

**P196/P200 记录的「`window_fetch` 延迟随时间线长度退化」这一归因，本次实测不支持。**

在等量级时间线（868.9s / 26068 帧，与 P196 的 14.49 分钟同档）上，从 Core 逻辑
到真实 HTTP 路由的**全链路热路径是 6.5–9.8ms**，冷路径 168–202ms。P196 记录的
`p50 2512ms / p95 8733ms` 与之差**两个数量级**（P196 数字的千分之一量级）。

## 1. 为什么需要重新归因

P196（`P196_CROSSWINDOW_30MIN_MEASUREMENT_2026-10-27.md`）测到：

| 指标 | 对照组（41.4s） | 长跑组（869s） |
|---|---|---|
| `window_fetch` p50 | 24 ms | 2394 ms |
| `window_fetch` p95 | 24 ms | 6592 ms |
| 丢帧 | 0 / 1241 | 6086 / 26083 |

当时推断「退化由时间线长度驱动」。该推断**未经验证**（原文自己标注「未证」）。
本次直接测同一量级时间线的每一层。

## 2. 测量设置

- **隔离副本**：真实库只读拷贝到 `.tmp/probe-db/`，探针只写副本。
  必须如此——`timeline_revisions` 有 `BEFORE DELETE/UPDATE` 触发器
  （`timeline revisions are immutable`），探针造出的 revision **无法删除**；
  写真实库会永久留下一条测试时间线。
- **时间线构造**：把现有 41.4s 真实素材片段重复 21 次 ⇒ **868.9s / 26068 帧**。
  用真实素材原码流，不合成、不重编码。
- **素材**：`project_50fafd9cf28140138d99bc7dd75c9464` 的既有可用素材。

## 3. 结果

### 第 1 层：Core 逻辑（直接调 `RenderCoordinator.preview_ir_window`，绕过 HTTP）

| 条件 | 4 次耗时 |
|---|---|
| 冷（清空 `preview_ir_v2_cache`） | 168.0 / 173.8 / 178.7 / 201.6 ms |
| **热（缓存命中）** | **6.7 / 9.3 / 8.2 / 7.8 ms** |

### 第 2 层：HTTP/ASGI（真实 FastAPI 路由 + JSONResponse 编码）

| 条件 | 耗时 |
|---|---|
| 冷（缓存空） | 175.2 ms，status=200 |
| **热（缓存命中）** | **9.0 / 9.3 / 9.8 / 6.5 / 9.8 ms** |

单窗载荷：**300 帧 / 87,310 bytes**（每帧均值 **291 bytes**）。

## 4. 这推翻了什么

1. **Core 没有随线长退化的窗口取数问题。** 868.9s 时间线的热路径 6.7–9.8ms，
   与 41.4s 时间线的同量级（此前实测 5–7ms）。**两者没有数量级差异。**
2. **冷路径 168–202ms 是真成本，但也不是 2.5 秒。** 来源是
   `_ir_v2_bundle` 未命中时的**全量投影**（26069 帧 → 8.48 MB IR）。
3. **载荷只有 87KB。** 一个 87KB 的 IPC 消息不可能花 2.5 秒。

## 5. 最可能的解释（尚未验证，不得当作结论）

`frame-source.ts:267` 的 `window_fetch` (`session=2`) 记的是
**`fetchStart` → 响应入缓存**的**墙钟**时间，不是一个 IPC 往返的耗时：

```ts
attempt.promise = options.fetchWindow(...).then(response => {
  ...
  cache.set(startFrame, ...);
  editorPerf.record("window_fetch", performance.now() - fetchStart, 2, ...);
})
```

**Promise 的 `.then` 回调要排进 renderer 主线程的事件循环。** 主线程被
decode/compose 压满时，回调排队会把这段墙钟撑大——**此时 IPC 可能早已返回**。

⇒ 若成立，`window_fetch` 测的是「**主线程有多忙**」，不是「Core 有多慢」。
这能同时解释对照组 24ms 与长跑组 2394ms：**不是取窗变慢，是主线程变忙**。

**未证**：该解释需要 renderer 侧在 `fetchWindow` 前后、以及 `.then` 入口
分别打点才能确认回调排队量。本次未做（需改诊断构建）。

## 6. 对修法方向的影响

- **不要**去优化 Core 窗口取数或 IPC 序列化——实测它们不是瓶颈。
- 真正的方向是**降低 renderer 主线程负载**，或把取窗完成后的处理移出主线程竞争。
- 冷路径的 168–202ms（全量投影 8.48MB）在长时线上是**真实但次要**的成本，
  只有在缓存被挤掉时才会命中。

## 7. 明确未证

- 回调排队假说（§5）**完全未验证**。
- 未测 renderer 侧任何分段（本次只测了 Core 与 HTTP）。
- 未复现 P196 的 2.5 秒本身——本次测的是同量级时间线的 Core/HTTP 层，
  而不是 Electron 内的完整链路。
- 单机、单次、单素材；无多次运行方差。
