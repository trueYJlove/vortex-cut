# W2.2 降级交付（D3）——实施记录与验收核对（G1 切片）

- 实施：LiuWei（架构师，本轮以执行者身份落地 G1 收口）；实现提交 **`dd3dffd`**（2026-10-16）
- 承接：`docs/design/W2_2_DEGRADATION_DESIGN_GATE_2026-10-14.md`（设计门，**已批准**）
- 对应登记：`docs/STATUS.md` §4 **P130**（本切片）、**P131**（B 线，另行）
- 复现：`services/core/tests/unit/test_speaker_quality_annotation.py`（5 项）

> **本文的用途**：AGENTS.md「文档同步纪律」Rule 3 要求**关门行必须附验收交叉核对表**，
> 否则门是「以断言关闭」。`dd3dffd` 交付了实现与测试，但**未留下实施记录** ⇒
> P130 的 ✅ 当时不满足 Rule 3。本文补上，并把复核中发现的一处**真实缺陷**一并记录。

---

## 1. 交付内容（与实现逐条对齐）

| 面 | 落地 | 位置 |
|---|---|---|
| 迁移 v38 | 3 列 + `CHECK` + 历史行回填 | `services/core/src/aivs_core/database_v38.py` |
| 列语义 | `quality_status` / `quality_basis` / `usable_for` | 同上（含取值约束） |
| 写入路径 | **两处** INSERT 均**显式写**三字段 | `speaker_service.py:301-303`（`analyze_pcm`）、`:369-370`（`_write_row`） |
| 投影 | `SUMMARY_COLUMNS` 扩三列 | `speaker_service.py:61-66` |
| DTO | 摘要透出三字段（`usable_for` 反序列化为数组） | `speaker_service.py:422-425` |
| STATUS §1 | `latest_migration` 37 → **38** | 一致性测试强制，见 §4 |

**设计意图（照门 §1 冻结）**：输出不变、零算法改动；用**字段**而非文案，因为下游要在
**代码里**拒绝。下游按**取值**判断而非版本号 ⇒ 将来升级为 `validated` 无需改下游。

---

## 2. 验收交叉核对表（门 §3 验收项逐项）

| # | 门 §3 验收项 | 落实 | 证据（可复现命令） |
|---|---|---|---|
| **A1** | 三字段随每次落库写出 | ✅ **成立** | `test_annotation_is_written_on_every_insert`；负向对照 NC1 见 §3（⚠️ **口径**：NC1 的 2 红中 1 红属 A3 的用例，**A1 的净对照只有 1 红**） |
| **A2** | 标注**不可静默缺省**（历史行回填安全侧） | ✅ **成立** | `test_annotation_default_is_safe_side_for_existing_rows`（**绕过服务的裸 INSERT**，断言列默认值 = `unvalidated`） |
| **A3** | 摘要/DTO **必须带出**（不得只存在于表里） | ✅ **成立** | `test_annotation_is_surfaced_in_summary`；负向对照 NC2 见 §3 |
| **A4** | **下游拒绝有测试** | ❌ **未落地（本门只登记约束）** | **已独立登记为 `STATUS.md` §4 P132**——门 §2/§7 明确该项随 **W2.3 立项门**落地；⚠️ 在 P132 关闭前，**W2.3 不得开工消费 turn** |
| **A5** | **不得**出现「部分可用」语义 | ✅ **成立** | `test_summary_never_claims_multicam_switch`；负向对照 NC3 见 §3 |

**结论**：A1/A2/A3/A5 **成立**；**A4 未落地且不由本切片负责**，已改为独立登记项（这正是
Rule 3「验收项必须可追踪」的落点——埋在已完成行里的未完成项会静默腐烂）。

---

## 3. 负向对照（**本轮独立复现**，非转述实现时的自我陈述）

方法：临时改写 `speaker_service.py` / `database_v38.py` → 跑测试 → 回滚 → 确认复绿。
脚本与读数见 `evidence/2026-10-16-w22-g1-degradation-annotation/`。

| 对照 | 改动 | 实测结果 | 判定 |
|---|---|---|---|
| **NC1** | 去掉两处 INSERT 的三列 | **2 failed** 3 passed | ✅ 有区分力 |
| **NC2** | 去掉摘要 DTO 三字段 | **2 failed** 29 passed | ✅ 有区分力 |
| **NC3** | `USABLE_FOR_REFERENCE_ONLY` 加回 `multicam_switch` | **3 failed** 28 passed | ✅ 有区分力 |
| **NC4** | 移除 v38 的 `CHECK` 约束 | **修正前：仍绿（恒真）→ 修正后：1 failed** | ✅ 见 §4 |

> **与实现时自我陈述的差异（如实记录）**：实现时称 NC1「3 红」，本轮精确复现为
> **2 红**。差异源于补丁窗口口径不同（把 `SUMMARY_COLUMNS` 一并改掉时会连带打红更多用例，
> 但那是另一个失败模式，不是 A1 的对照）。**以本轮 2 红为准**——结论方向不变，
> 但数字必须可复现，故更正。

---

## 4. 复核中发现并修复的真实缺陷：`CHECK` 用例恒真

**缺陷**：`test_quality_status_check_constraint_rejects_unknown_value` 初版用
`raise AssertionError("CHECK 未拦住…")` 表达「INSERT 不该成功」，却把该断言交给同一个
`except Exception` 捕获。**直接观察**（`sqlite3` 内存库重放列定义，非推断）：

| 条件 | 观察结果 |
|---|---|
| `CHECK` 在位 | INSERT 被拒：`IntegrityError: CHECK constraint failed: quality_status IN (...)` |
| `CHECK` 移除 | **INSERT 成功，`'bogus'` 入库** |
| 测试控制流（约束移除场景） | `AssertionError` 被 `except Exception` 捕获 → 断言条件为真 → **用例通过** |

⇒ **该用例在约束缺失时仍绿，不提供任何保护**。已改为
`pytest.raises(sqlite3.IntegrityError)` 并断言约束名；复验：**移除 CHECK ⇒ 1 failed**
（`evidence/.../verify_check_fix.txt`）。

**同类模式扫描**（严格 AST 扫描，非 grep）：全仓排除 `.venv/.tmp/node_modules` 后，
满足「`try` 块内 `raise AssertionError` **且**被宽泛 `except Exception/BaseException` 捕获」
的共 **2 处**——本处（**已修**）与 `test_projects_sync_paths.py:81`。

> ⚠️ **口径说明（2026-10-16 复核修正）**：曾有一版复核报告称"全仓共 3 处"，并把
> `test_stage4c_shot_list_api.py:232,241` 列为漏报。**经核实该判定不成立**——
> 那两处的 `raise AssertionError` 位于 `try/except/else` 的 **`else:` 分支**（即"未抛异常时
> 才断言"），这恰是**正确写法**，异常不会被吞。该假阳性源于用 grep 匹配而非 AST 解析。
> 本文件以**严格 AST 扫描**（独立复现，输出 1 处残留）为准。

`test_projects_sync_paths.py:81` 属**不同型**：其断言是「应抛 DomainError」，
而后续 `assert exc.code == ...` 才是真判据，异常类型错时属性缺失会失败 ⇒ 未判定为缺陷，
本轮不改，仅记录以便后续复核。

**影响面**：仅测试，零生产代码行为变化。

---

## 5. 回归与边界

| 项 | 读数（口径已注明） |
|---|---|
| **说话人四套件**（quality_annotation + storage + algorithm + vad） | **67 passed**（25.7 s） |
| **一致性 + 上述四套件** | **77 passed**（26.3 s） |
| **一致性 + 说话人前两套件**（与实现时口径同） | **41 passed**（22.3 s） |
| NC 复现脚本回滚后 | **31 passed**（工作树逐字节等于 HEAD） |
| 集成套件 `test_speaker_api.py` | **2 passed + 8 errors** ⇒ ⚠️ **既有环境缺字体资产**（`.venv/.../_internal/fonts/bundle.json` 缺失 → `RENDER_FONT_MISSING`），**与本次改动无关**（未打补丁时同样 8 errors）；**如实记录，未修**（属环境/打包面，不属本切片） |

> ⚠️ **口径更正（2026-10-16）**：本表初版把 `41` 写成"说话人四套件 + 一致性"，**该表述错误**——
> `41` 实为"一致性 + 说话人**前两**套件"；四套件是 `67`、四套件 + 一致性是 `77`。
> 三个数字均已由独立复核逐项复跑确认，现按各自口径分别列出。

**边界（如实）**：
- 本切片**零算法改动、零契约破坏性变更、零 egress**；`usable_for` 为新增字段，向后兼容；
- **A4 未落地**（见 §2），W2.3 开工前必须先关闭 P132；
- 本切片**不判**精度门（那需 B 线出结果后按门 §6 S3 重跑）；
- 门文档 `W2_2_DEGRADATION_DESIGN_GATE_2026-10-14.md` 状态行已同步为「已批准」，
  消除「同一门两个相反状态」的自我矛盾。
