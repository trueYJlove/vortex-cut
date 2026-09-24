# W1.1 剪辑语法层骨架 —— Planning Gate

> 起草：LiuWei（架构师），2026-09-24。承接总纲 §5.2/§5.3、W1.1；ADR-0004 D5/D7/D8。
> 实施：ZhangSan（Core）；验收：LiuKeAi。分支建议：`ai/w11-editing-grammar`。
> **前置已满足**：W0.4 评测骨架（质量调参尺子）、W0.3 链接模型（W1.4 地基）。

## 0. 现状走读结论

1. **无 `editing_grammar` 模块**。现有提案链为 LLM 路径：
   `timeline_planning.TimelinePatchPlanningService` 三段式
   （prepare 含 **egress preview** → create_generation 走 provider → apply），
   强依赖 provider 与 consent——**P-A 不可复用其 prepare**。
2. 采纳链可复用：`TimelineService.apply_in_memory` + `create_revision_from_document`
   （`timeline_planning.apply` 已示范哈希对账 + 一次性 application）。
3. 工具描述无统一形状；`providers._PATCH_FIELDS` 是 **AI 字段清单**，不是规划器工具目录。
4. 零 egress 路径不需要 `timeline_patch_egress_*` 表——若硬塞会制造假 consent 语义。

## 1. 范围

### 1.1 必须实现（骨架 + 一条可 e2e 的参考规划器）

1. **`editing_grammar` 模块**（`services/core/src/aivs_core/editing_grammar/`）：
   - `protocol.py`：`Planner` 协议（纯函数 `plan(document, params, context) -> PlanResult`）、
     `PlanResult`（`operations` + `summary` + `rationale`）、工具描述形状；
   - `registry.py`：规划器注册表（名称唯一、可列举）；
   - `service.py`：三段式 **无 egress**——`prepare`（干跑校验）/ `propose`（落盘提案）/
     `apply`（走既有采纳链，**不旁路写时间线**）。
2. **参考规划器 `drop_short_clips`**：删除时长 < `min_duration_us` 的片段
   （输出 `remove_clip` 序列，按 `clip_id` 稳定排序）。用于打通 e2e 与确定性断言；
   真实手法（卡点/跳切/L-J）留 W1.3–W1.5。
3. **工具化（§5.3-6）**：`GET .../editing-grammar/planners` 返回
   `{name, title, description, parameters_schema, preconditions}`——P-C/MCP 复用同一份。
4. **rationale 落盘**：每条提案存 `rationale_json`（规则命中、参数、依据的 clip 度量）。
5. **迁移 v24**：`editing_grammar_proposals` + `editing_grammar_applications`
   （不可变触发器，对齐 `timeline_patch_proposals` 先例）。
6. **REST**（对齐 prepare 形态，但**跳过 egress/consent**——P-A 差异化）：
   - `POST …/editing-grammar/prepare`
   - `POST …/editing-grammar/proposals`
   - `GET  …/editing-grammar/proposals` / `GET …/editing-grammar/proposals/{id}`
   - `POST …/editing-grammar/proposals/{id}/apply`
   - `GET  …/editing-grammar/planners`

### 1.2 明确不做

- 不实现卡点 / 跳切 / L-J / 多机位规划器（W1.3–W1.5）。
- 不做 egress preview / consent（P-A 零 egress；勿伪造）。
- 不扩 AI 白名单；不引入旁路 `patch()` 写时间线。
- 不做 Desktop UI（提案列表/采纳按钮可后接）。
- 不做 MCP 暴露（W4.3）；只保证工具描述可复用。

## 2. 设计要点（§5.3 六条如何落地）

| 约束 | 落地 |
|---|---|
| 纯函数 | `plan()` 不读全局、不写库；同输入两次 `patch_json` 逐字节相同（测试） |
| 零网络 | 模块无 http/socket；测试 monkeypatch 断言 |
| rationale 落盘 | 提案行 `rationale_json`；prepare 干跑也返回同一结构 |
| 统一输出 | `operations` 为 `TimelinePatch.operations`；`apply` 复用 `apply_in_memory` |
| 不写时间线 | `propose` 只 INSERT 提案表；写 revision 仅在 `apply` |
| 工具化 | registry 即工具目录 |

**与 LLM 三段式的差异（刻意）**：prepare **不**生成 egress preview；
create **不**调用 provider；apply 的 `ai=False`（用户采纳语义，允许结构 op）。

**确定性细节**：操作列表排序键显式（如 `clip_id`）；禁止依赖 set/dict 迭代序。

## 3. 验收（LiuKeAi）

1. **确定性**：同 document+params 两次 `plan()` → `json_dumps(operations)` 相同；
   两次 `propose` 的 `patch_sha256` 相同（proposal id/created_at 除外）。
2. **零 egress**：monkeypatch `socket.socket` / `urllib` 后 plan+propose+apply 全通。
3. **rationale 可读**：含 planner 名、params、逐条 rule（为何删/不删某 clip）。
4. **e2e 采纳链**：propose → apply → 新 revision 文档与 `proposed_document_sha256` 一致；
   二次 apply 拒绝。
5. **无旁路**：apply 前时间线 revision 不变；仅 application 表 + revision 链。
6. **迁移 v24** 逐版本测试 + 不可变触发器。
7. Core 全量不红；STATUS §1 `latest_migration` → 24。

## 4. 风险

| 风险 | 对策 |
|---|---|
| 骨架被当成完整语法层 | 参考规划器命名 `drop_short_clips` 并在工具 description 标明「参考实现」 |
| 误走 LLM consent 形态 | API 面无 provider 字段；测试断言请求多余字段即拒 |
| 操作顺序不确定导致 patch 抖动 | 排序键写死 + 确定性测试 |
| apply 与 AI 沙盒混淆 | `ai=False`；文档写明用户采纳 |

## 5. 开放问题（实施时定）

1. `drop_short_clips` 空删除集 → 仍产出空 operations 的提案 vs 拒绝？
   **倾向：prepare/propose 允许空操作并标记 `noop`，apply 拒绝空操作**（避免空 revision）。
2. 提案是否允许跨 base_revision apply？**倾向：否**（哈希对账，对齐既有 patch apply）。
3. `MIN` 参数下限对齐 `MIN_VIDEO_US`？**倾向：是**（100ms）。
