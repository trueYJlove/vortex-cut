# W1.5 跳切 / 去停顿 —— 实施记录

> 实施：ZhangSan（Core），2026-09-24。验收：LiuKeAi。
> 承接：`REMOVE_PAUSES_PLANNING_GATE_2026-09-24`。核销：STATUS **P14**；`latest_migration` → **25**。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 静音检测 | `detect_silence_intervals`（能量阈值 + 最短静音；右端取下一有声样本） |
| 保留区间 | `compute_keep_intervals`（pad 收缩 + `< MIN_VIDEO_US` 碎片合并） |
| 规划器 | `remove_pauses`：trim 首保留段 + insert 其余保留段（同素材多段拼接） |
| 信号 | service 注入 `cv_samples.audio_energy`；测试可显式 `silence_intervals_us` |
| 拒绝 | 全零/无样本 → `EDITING_GRAMMAR_NO_SPEECH` |
| 迁移 | **v25**：`editing_grammar_proposals.proposed_document_json`（新 clip_id 不可重放，采纳以提案文档为准并哈希自校验） |
| 测试 | `test_remove_pauses.py` 9 项 |

## 2. 验收核对表（规划门 §3）

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 3.1 | 合成静音 → 保留精确、时间轴闭合 | ✅ | `test_remove_pauses_e2e_closes_gaps` |
| 3.2 | 过短静音不切 | ✅ | `test_short_silence_ignored` |
| 3.3 | 碎片合并 | ✅ | `test_tiny_fragments_merged` |
| 3.4 | 全零拒绝 / 无静音 noop | ✅ | `test_all_zero_energy_rejected` / `test_no_silence_is_noop` |
| 3.5 | 确定性 | ✅ | `test_remove_pauses_ops_deterministic` |
| 3.6 | 无过短产物 | ✅ | e2e 断言 `>= MIN_VIDEO_US` |
| 3.7 | 去口癖 v1 不做 | ✅ | 规划门 §5.1 裁决 |

## 3. 裁决与偏离

- **去口癖不进 v1**（规划门 §5）。
- **实施偏离**：拆分/插入会 mint 新 `clip_id`，重放 `apply_in_memory` 无法稳定哈希
  → **v25 落盘 `proposed_document_json`**，apply 以提案文档为准（`proposed_document_sha256` 自校验）。
  这比「预测新 id」诚实，且不破坏不可变提案语义。

## 4. 剩余范围

| # | 项 |
|---|---|
| L1 | 真实口播素材 e2e（待 W0.4 缺口补齐） |
| L2 | Desktop 去停顿入口 |
| L3 | W1.2 节拍 / W1.3 卡点 / W1.4 L-J |
