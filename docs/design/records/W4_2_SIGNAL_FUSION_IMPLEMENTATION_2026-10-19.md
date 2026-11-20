# W4.2 信号融合 —— 实施记录与收口（2026-10-19）

> 承接 `W4_2_SIGNAL_FUSION_PLANNING_GATE_2026-10-19.md`（门已批准：D1=A / D2 排除说话人 / D3 等权）。
> **本文件是门的关门依据**（AGENTS.md Rule 3：需验收交叉核对表，不得以断言关闭）。

---

## 1. 交付清单

| 提交 | 内容 |
|---|---|
| `beb4377` | Planning Gate + 发现 DEC-9 自相冲突（D1） |
| `e5d7b49` | Slice 1：`signal_fusion.py` 纯算法层 + `planning.py` 独立 fused 分支 + 契约/preload `fused` 枚举 |
| 本次 | Desktop 召回来源选择 UI + 本实施记录 |

## 2. 验收交叉核对表（门 §4 F1–F6）

| # | 验收项 | 判据 | 证据 | 结论 |
|---|---|---|---|---|
| **F1** | `fused` 可用 | 三源齐全时产出候选 | `test_F1_three_sources_produce_ranked_output`；`_fused_candidates` 三源齐全路径 | ✅ **通过** |
| **F2** | 缺失源降级 | 缺源可运行且 `contributions` 反映实际参与源 | `test_F2_missing_source_still_works_and_recorded`、`test_missing_source_reweights_not_zero_fills` | ✅ **通过** |
| **F3** | 三源全缺 | 报 `PLANNING_NO_SEGMENTS` | `_fused_candidates` 末尾 `if not candidates: raise` | ✅ **通过** |
| **F4** | **旧值行为不变** | `auto`/`transcript`/`cv` 输出不变 | `test_planning_cv_recall.py` **6 项全绿**（改动前后同）；fused 走**独立分支**，不触碰旧推导路径 | ✅ **通过** |
| **F5** | 归一化在候选集内 | 同值在不同集合 → 不同归一化结果 | `test_F5_normalization_is_within_candidate_set` | ✅ **通过** |
| **F6** | 权重是显式常量 | 权重可读且带版本号 | `test_F6_weights_readable_and_versioned`、`test_D3_equal_weights_unoptimized` | ✅ **通过** |

## 3. 测试与负向对照

| 套件 | 数量 |
|---|---|
| `test_signal_fusion.py` | **20 项** |
| `test_planning_cv_recall.py`（F4 回归锁） | **6 项** |
| `test_ai-source-select.test.tsx` | **2 项** |
| Desktop 全量 | **874 passed**（104 文件）+ typecheck + lint 绿 |

**负向对照 4 组全部变红**（证明判据有区分力）：

| 对照 | 注入的缺陷 | 变红 |
|---|---|---|
| NC1 | 缺源补 0 而非重新归一 | 3 项 |
| NC2 | 单元素归一化压成 0.5 | 2 项 |
| NC3 | 权重改成不等（违反 D3） | 3 项 |
| NC4 | 节拍容差恒真（永远落拍） | 1 项 |

## 4. 实现中修复的真实缺陷

**`minmax_normalize` 对单元素返回 0.5**，把「唯一的满分候选」压成半分。

- 暴露方式：由我自己写的负向对照 `test_negative_control_zero_fill_would_lower_single_source` 抓出；
- 根因：单元素走 `hi - lo <= 1e-12` 分支返回 0.5，而 min-max 对单元素本无意义；
- 修法：单元素保持原值（`[1.0]`），并加 `test_single_element_preserved` 上锁。

## 5. 边界（如实）

### 5.1 R1（P147）仍然开放 —— 这是本门最重要的限制

**融合排序没有客观真值。** 什么算「更好的粗剪」需要人判断。

总纲 W4.2 的验收项原文要求「融合排序相对单源的**可断言提升**」，
本门与本文档均**明确不承诺**该断言 —— 因为它无法被机器证明。

**已交付的是结构正确性（F1–F6），不是质量优越性。**
任何「融合比单源好」的表述都是未经证明的。

### 5.2 其他

- **权重等权且未调优**（D3），不得声称最优；
- **说话人源按 D2 排除**（`quality_status` 恒 `unvalidated`，ADR-0009 与 P132 同源纪律）；
- 节拍分项对**所有**候选打分（节拍是时间属性，不独立产候选），空网格时该源整体缺席；
- 融合候选上限沿用旧路径的 160 段；
- Desktop UI 仅提供选择与说明，**不展示**融合分项明细（独立切片可做）。

### 5.3 一个设计取舍的记录

`fused` 采用**独立分支**而非改造旧 `use_transcript`/`use_cv` 推导。
代价是 `_fused_candidates` 与既有召回逻辑有部分重复（转录排序口径、CV 场景调用）。

**为什么接受该重复**：F4（旧值逐字节不变）是硬约束。
若改造旧路径，任何细微差异都会静默改变既有用户的行为，且难以用测试穷举。
**独立分支把「不改变旧行为」从「靠测试保证」变成「靠代码结构保证」。**

## 6. 收口结论

- 门 §4 **F1–F6 全部通过**；
- 门 §5 **R1（P147）仍开放**，不得当作已解决；R2（P148）由 F6 部分覆盖（权重显式化+版本化），但「权重是否最优」仍未验证；
- **P146 可核销**（门的交付已完成），但须同读 §5.1 的限制；
- **后续未做**：融合质量的人工盲评协议（需人参与）、融合分项明细 UI、权重调优。