# W1.4 L-cut / J-cut —— 实施记录

> 实施：ZhangSan（Core），2026-09-24。验收：LiuKeAi。
> 承接：`SPLIT_EDIT_PLANNING_GATE_2026-09-24`（ADR-0004 D7）。核销：STATUS **P17**。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 语义 op | `split_edit`：`{clip_id, source_time_us, audio_delta_us}`；音频切点 = 画面 + delta（J 负 / L 正） |
| 双声防护 | 内嵌音频 → 派生 A1 两段 + V1 两段 `audio.enabled=false`；已有链接 A1 → 按音频切点拆 |
| 白名单 | DEC-7 准入：`AI_PATCH_OPERATIONS` + schema oneOf + `_PATCH_FIELDS` + 契约 |
| 规划器 | `lj_cut`：J 下句首词提前 / L 上句末词延后（窗 300–500ms，默认 400ms） |
| 测试 | `test_split_edit.py` 9 项 |

## 2. 验收核对表

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 3.1 | 三处同步 | ✅ | `test_ai_whitelist_consistency` |
| 3.2 | J 负 / L 正 | ✅ | `test_jcut_*` / `test_lcut_*` |
| 3.3 | 边界拒 | ✅ | 越界/过短用例 |
| 3.4 | 双声结构防护 | ✅ | V1 静音 + A1 有声断言 |
| 3.5 | lj_cut 词表窗 | ✅ | `test_j_direction_and_window` |
| 3.6 | 渲染 A1 无重复音频 e2e | ⏸ | 剩余（真实口播导出链路） |

## 3. 剩余范围

渲染级双声 e2e；Desktop L/J 交互；真实口播端到端（W0.4 补样后）。
