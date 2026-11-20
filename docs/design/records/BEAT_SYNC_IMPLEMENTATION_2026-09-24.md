# W1.3 卡点规划器 —— 实施记录

> 实施：ZhangSan（Core），2026-09-24。验收：LiuKeAi。
> 承接：`BEAT_SYNC_PLANNING_GATE_2026-09-24`。核销：STATUS **P16**。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 规划器 | `editing_grammar/beat_sync.py`：`beat_sync` |
| 规则 | 镜头时长 = beat 跨度 × `beats_per_shot`；切点吸附 beat；score=3·face+2·motion+1·sharpness（冻结）；强拍槽优先高分段 |
| 输出 | `insert_asset_clip` 序列 + rationale（槽/beat/权重/复用） |
| 产品前置 | `params.bgm_asset_id` + `target_duration_us`（不改 LLM prepare 契约） |
| 测试 | `test_beat_sync.py` 6 项 |

## 2. 验收核对表

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 3.1 | 切点 100% 落 beat | ✅ | `test_cuts_snap_to_beats` |
| 3.2 | 强拍放重镜头 | ✅ | `test_strong_beat_gets_heavy_segment` |
| 3.3 | 段不足循环复用 | ✅ | `test_reuse_when_short_on_segments` |
| 3.4 | 确定性 | ✅ | `test_deterministic` |
| 3.5 | e2e 采纳与网格一致 | ✅ | `test_e2e_apply_on_beat_grid` |
| 3.6 | 真实素材 e2e | ⏸ | W0.4 素材缺口（规划门 §1.2 明确延后） |

## 3. 剩余范围

- 真实音乐/成片 e2e（依赖 W0.4 补样）；
- Desktop 卡点入口；
- W1.4 L-J cut（`split_edit`）。
