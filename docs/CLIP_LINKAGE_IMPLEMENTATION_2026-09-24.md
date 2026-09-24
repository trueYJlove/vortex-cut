# W0.3 声画链接模型 —— 实施记录

> 实施：ZhangSan（Core），2026-09-24。验收：LiuKeAi。
> 承接：`CLIP_LINKAGE_PLANNING_GATE_2026-09-24`（ADR-0004 D1/D8）。
> 核销：`docs/STATUS.md` §4 承诺 **P12**；§1 `patch_operations` 33→**36**。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 文档 schema | clip 可选字段 `link_group_id`（无值不写键；单成员组自动剥离） |
| A/V 对 | `detach_audio`：同源派生 A1、默认同组、`video.audio.enabled=false`、时间对齐画面（不强制轨尾） |
| 入组 | `insert_asset_clip.link_to_clip_id?` |
| 建/散组 | `set_clip_link` / `clear_clip_link`（散整组） |
| 联动 | `remove_clip` 删整组；`position_clip` 同 delta；`trim_clip` 同 `source_*`；`move_clip` 整块保序 |
| 单次忽略 | trim/move/position/remove 可选 `ignore_link: true`（Desktop 联动开关的 API 面） |
| 契约 | `TimelineClip.link_group_id?`；三新 op；相关 op 增 `ignore_link?`；**PROTOCOL_VERSION 不动** |
| AI 准入 | 三新 op **不进** AI 白名单（结构域，规划门 §2.5） |
| 测试 | `test_clip_linkage.py` 10 项 |

## 2. 验收核对表（规划门 §3）

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 3.1.1 | detach 对齐/同组/静音/二次拒绝 | ✅ | `test_detach_audio_creates_aligned_linked_pair` |
| 3.1.2 | insert link_to 入组 | ✅ | `test_insert_with_link_to_joins_group` |
| 3.1.3 | set/clear 链接 | ✅ | `test_set_and_clear_clip_link` |
| 3.1.4 | 联动 remove/position/trim + ignore_link | ✅ | `test_remove_propagates_unless_ignore_link` / `test_position_and_trim_propagate` / `test_trim_ignore_link_only_target` |
| 3.1.5 | trim 联动异素材拒绝 | ✅ | `test_trim_link_rejects_mismatched_asset` |
| 3.1.6 | 旧文档零行为 | ✅ | `test_unlinked_document_ops_match_legacy_shape`（无 `link_group_id` 键 + 裁剪/定位/移动/删除语义） |
| 3.1.7 | 单成员组不落键 | ✅ | `test_singleton_group_is_dropped` |
| 3.2 | 契约接受新字段/新 op | ✅ | `pnpm typecheck` 绿（contracts build + desktop tsc） |
| 3.3 | Core 回归 | ✅ | 全量 **938 passed + 1 skipped + 1 deselected, 0 failed**（含本单 9 项 + 状态 §1 同步后转绿）；其后补 L1 用例，`test_clip_linkage` **10 passed**，全量未再复跑 |

## 3. 开放问题落实（规划门 §5）

1. 二次 `detach_audio` → **拒绝**（已实现 + 测试）。
2. `move_clip` 联动 → 组内保相对序、整块落入目标邻域。
3. Desktop 开关默认开 = 不传 `ignore_link`；UI 接线见 §4 L2。

## 4. 剩余范围

| # | 项 | 说明 |
|---|---|---|
| L2 | Desktop「联动开关」UI | API 面（`ignore_link`）已就绪；接线属 YeJing 域小单 |
| L3 | W1.4 `split_edit` | 声画偏移刻意不做（避免与链接语义混装） |
