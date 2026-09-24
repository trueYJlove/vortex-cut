# W0.3 声画链接模型（clip linkage）—— Planning Gate

> 起草：LiuWei（架构师），2026-09-24。承接 ADR-0004 **D1**（默认链接 + 联动 + 显式解除）
> 与 **D8**（可选字段缺省即旧语义 + 旧文档零行为强断言）。
> 实施：ZhangSan（Core）；验收：LiuKeAi。分支建议：`ai/w03-clip-linkage`。
> **DEC-1 无需再裁决**——已冻结于 ADR-0004 D1。本门只定落地形状。

## 0. 现状走读结论（2026-09-24）

1. **全仓库无声画链接字段**（`linked` / `link_group` / `group_id` 零命中）。
2. clip 文档形状封闭：`timeline.py` `_asset_clip` 构造字段；契约
   `isTimelineClip` `onlyKeys` 硬列表——**可选字段增量必须进契约 onlyKeys**，
   否则合法文档被拒。
3. A/V 成对路径：`insert_asset_clip` + `as_audio=true` 把视频素材音轨铺到 **A1 轨尾**，
   **不与画面 clip 对齐、不建关系**。`set_audio` 只开关视频 clip 内嵌音频。
4. **联动对象就绪**：`trim_clip` / `move_clip` / `remove_clip` / `position_clip`
   均以单 `clip_id` 为操作单元，级联面（字幕/转场）已存在——在成员解析处扩展即可。
5. 三处同步（AI 白名单 / schema / `_PATCH_FIELDS`）**只约束 AI 可用 op**。
   本单新 op 属**结构域**（对齐 `insert_asset_clip`），**不进 AI 白名单**（见 §2.5）。

## 1. 范围

### 1.1 必须实现

1. **文档 schema 增量**：clip 可选字段 `link_group_id: string | null`（**缺省 = 旧语义**，
   不写 `null`——旧文档字节不变）。同一 `link_group_id` 的 clips 为一个链接组。
2. **A/V 对默认链接（D1）**：
   - 新 op **`detach_audio`**：自视频 clip 派生 A1 音频 clip（同源同 `source_*`），
     **默认进入同一链接组**；同时 `video.audio.enabled=false`（防双声，衔接 W1.4）；
   - `insert_asset_clip` 可选 `link_to_clip_id`：新 clip 与目标同组（目标必须已有组或与新 clip 共建组）。
3. **联动语义**（`ignore_link` 缺省 false 时）：
   - `remove_clip` → 删除组内**全部**成员（含各自字幕/转场级联）；
   - `position_clip` → 全组**同 delta** 平移（保持相对错位，便于日后 L/J）；
   - `trim_clip` → 全组同 `source_*` 收缩（成员须同 `asset_id` 且可修剪）；
   - `move_clip` → 全组在 clips 数组中保持相对次序一并挪到目标邻域。
4. **显式解除**：`clear_clip_link` 解散**整个链接组**（全体去 `link_group_id`）。
   **`set_clip_link`**：≥2 个 clip 建/并入同一新组。
5. **单次忽略联动（Desktop 开关的 API 面）**：`trim/move/position/remove` 可选
   `ignore_link: true`——只作用于目标 clip。Desktop「联动开关」= 决定是否带该标记
   （本单先落契约/核心；Desktop 接线可同单或紧随小单）。
6. **旧文档零行为（D8 强断言）**：无 `link_group_id` 的文档上，
   `trim/move/remove/position` 结果与改前**逐字段一致**（含顺序）。
7. **契约**：`TimelineClip.link_group_id?`；`TimelinePatchOperation` 增
   `detach_audio` / `set_clip_link` / `clear_clip_link`；相关 op 增 `ignore_link?`
   与 `insert_asset_clip.link_to_clip_id?`。**`PROTOCOL_VERSION` 不动。**

### 1.2 明确不做

- **不进 AI 白名单**（不改 `AI_PATCH_OPERATIONS` / 三处同步集合）——结构 op，
  与 `insert_asset_clip` 同级；W1.4 的 `split_edit` 另行走 DEC-7 准入。
- 不做 SQL 迁移（时间线 JSON 存 revision）。
- 不做多机位链接组、不做跨素材任意片段自由成组的产品化 UI（仅 API 可用）。
- 不改渲染语义（A1 混音/`as_audio` 渲染路径不变）。
- 不实现 `split_edit`（W1.4）。

## 2. 设计要点

### 2.1 字段与缺省（D8）

```
clip.link_group_id?: string   # 可选；缺省或不出现 = 不参与链接
```

- 序列化时**无值不写键**（禁止显式 null），保证旧文档 sha/字节稳定；
- 组 ID 由 `new_id()` 生成，仅文档内唯一。

### 2.2 联动传播规则

| op | 默认（linked） | `ignore_link: true` |
|---|---|---|
| `remove_clip` | 删全体成员 | 只删目标 |
| `position_clip` | 全体 `+= delta`（目标定格后按相对偏移平移） | 只动目标 |
| `trim_clip` | 全体同 `source_*` | 只动目标 |
| `move_clip` | 全体保持相对次序 | 只动目标 |

**成员约束**：`trim_clip` 联动时，成员必须同 `asset_id` 且 `asset_kind in (video,audio)`；
不满足则该 op **整体拒绝**（避免静默半联动）。

### 2.3 `detach_audio`（A/V 对构造器）

- 入参：`clip_id`（video，且 `audio.enabled` 曾有音轨）；
- 产出：A1 clip，`asset_kind=audio`，同 `asset_id`/`source_*`，`timeline_start=end` 对齐画面；
- 默认 `link_group_id` 相同；视频 `audio.enabled=false`；
- 音频落位**不再强制 A1 轨尾**——按画面 `timeline_start_us` 对齐（与 `as_audio` BGM 语义区分）。

### 2.4 `set_clip_link` / `clear_clip_link`

- `set_clip_link`：`clip_ids` 长度 ≥2、去重后全部存在 → 全体置**同一新组**（并组，丢旧组号）；
- `clear_clip_link`：目标所在组**全体**清除 `link_group_id`（解除联动 = 散组，对齐剪映）。

### 2.5 AI 准入

新 op **排除**在 `AI_PATCH_OPERATIONS` 外（结构域）。理由：建立/解散链接是工程编辑
操作，不是叙事意图；误操作面大于收益。W1.4 若要 AI 造 L/J，走 `split_edit` 语义 op
（DEC-7），而不是让模型直接 `detach_audio` + 乱链。

### 2.6 契约变更清单（增量可选，PROTOCOL_VERSION 不动）

| 面 | 变更 |
|---|---|
| `TimelineClip` | `link_group_id?: string` |
| `TimelinePatchOperation` | `+ detach_audio / set_clip_link / clear_clip_link`；`insert_asset_clip + link_to_clip_id?`；trim/move/position/remove `+ ignore_link?` |
| Python `PATCH_OPERATIONS` | 三 op 集合扩容（**非** AI 白名单） |

## 3. 验收（LiuKeAi）

### 3.1 单测矩阵

1. `detach_audio`：派生对齐、同组、视频静音、A1 不轨尾强制；
2. `insert_asset_clip(link_to_clip_id)` 入组；
3. `set_clip_link` 建组/并组；`clear_clip_link` 散组；
4. 联动 `remove/position/trim/move` × 默认 / `ignore_link`；
5. `trim` 联动遇到异 `asset_id` 成员 → 整体拒绝；
6. **旧文档零行为**：固定旧形状 document（无 `link_group_id`）跑 op 序列，
   与「改动前实现」期望 JSON **逐字段相等**（至少覆盖 trim/move/remove/position 各 1 条黄金用例）；
7. 序列化：无链接 clip **不得**出现 `link_group_id` 键（字节稳定）。

### 3.2 契约

1. 含 `link_group_id` 的 clip 通过 `isTimelineClip`；
2. 新 op 通过 `isTimelinePatchOperation`；多余字段拒；
3. `PROTOCOL_VERSION === 1` 不变。

### 3.3 回归

- Core 全量不红；
- 既有 `as_audio` / 转场级联 / 字幕 trim 钳制用例保持绿。

## 4. 风险

| 风险 | 对策 |
|---|---|
| 联动误伤（只想过剪画面） | `ignore_link` + `clear_clip_link`；默认联动对齐剪映（D1 已裁） |
| 契约 onlyKeys 漏字段 → 文档被拒 | §3.2.1 专项；与 clip 字段表同步 |
| 序列化写出 null 破坏旧文档 sha | 只在有值时写键；§3.1.7 |
| 与 W1.4 `split_edit` 语义冲突 | 本单不做声画偏移；偏移留给 `split_edit` |
| AI 误用链接 op | 不进白名单（§2.5） |

## 5. 开放问题（实施时定，ZhangSan）

1. `detach_audio` 二次调用（已有 A1 派生）→ 拒绝或幂等？**倾向拒绝**（明确状态）。
2. `move_clip` 联动在 to_index 夹在组中间时的相对次序——**倾向**组内保持原相对序，
   整块落到目标邻域。
3. Desktop 开关默认开（D1）——UI 线框不在本门，只约定 API 语义。
