# W4.1 captions Provider 文本生成——Planning Gate

> 本规划只覆盖“Provider 生成/改写字幕文本”，不改变已验收的本地 transcript 装配语义；项目当前状态以 [`STATUS.md`](STATUS.md) 为准。

## 1. 目标

在 Worklist 的显式 proposal → Diff → Apply 链路中，新增一个可审计的 `captions_provider` 规划器：Provider 只负责返回结构化字幕文本候选，Core 负责把候选绑定到已有 transcript segments 的时间范围并生成 TimelinePatch。任何 Provider 输出都必须经过 Core 校验，用户显式 Apply 后才创建 Revision。

## 2. 非目标

- 不把字幕文本创作加入现有 `AI_PATCH_OPERATIONS` 白名单；
- 不允许 Provider 返回任意时间码、clip/asset ID 或 TimelinePatch 操作；
- 不发送整份 Timeline、媒体文件、绝对路径、API key 或其他项目数据；
- 不默认启用云端；不绕过 egress preview、consent、provider 能力探测和代理策略；
- 不改变本地 `captions` step（已有 transcript segment 装配）。

## 3. 输入与输出边界

Core 仅向 egress preview 暴露：

- 当前项目显式选中的 transcript segment ID；
- 每个 segment 的脱敏文本、相对顺序和时长桶（不含路径、asset 原文元数据）；
- 语言、目标字幕最大字符数、风格 preset ID；
- 固定 recipe/schema 版本和 provider model。

Provider 输出固定为 `caption-text-output-v1`：每个输入 segment 一个文本，允许合并相邻 segment 但不得新增 segment 引用；只允许文本、segment_refs、confidence（可空）和 warnings。Core 将输出映射为 `update_caption` 或确定性字幕装配 patch，不接受 Provider 直接提交 patch。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| transcript prompt injection | system 明确把 transcript 当不可信数据；Provider 输出只做数据，不执行指令 |
| 越权读取其他项目 | egress 由 project + transcript/segment 所属关系校验；只发送显式选择 |
| Provider 伪造时间码/ID | schema 禁止时间码；Core 只接受输入 segment ID 集合并自行绑定时间 |
| 云端静默发送字幕 | 复用现有 egress preview + 显式 Create；默认无 provider 不执行 |
| 输出过长或不完整 | 字符数、segment 覆盖、数量、UTF-8 和空文本在 Core fail-closed 校验 |
| 基线漂移 | prepare/create/apply/下一 step 均校验 revision/hash |
| Provider 响应泄露到 UI/日志 | 仅保存脱敏 proposal 摘要、payload/response hash 和计量，不保存 raw response |

## 5. Gate 条件

1. Design Gate 冻结 payload、schema、provider capability 名称和错误码；
2. Provider adapter 单测覆盖零 egress mock、schema 拒绝、取消、超限、segment 覆盖和 prompt injection 数据；
3. Core Worklist 串联测试覆盖 Provider proposal → waiting_for_apply → apply、重复 apply、基线漂移和跨项目拒绝；
4. Desktop 只显示 egress 摘要与 Diff，不显示 secret/raw response；
5. 真实 Provider 两步会话和代理路径在取得凭据后单独验收，不能用本地测试代替。

## 6. Implementation Slice 1

先实现“固定 schema + Core 纯校验/适配器 + Worklist planner 注册”的无网络切片；Provider 调用复用既有 `StructuredTextRequest` 和 egress 机制，不在本切片新增网络旁路。随后再实现真实 egress prepare/create 和 Desktop consent UI。

## 7. 承诺登记

本规划对应 `STATUS.md` §4 的 P37；Design Gate 通过后另行登记 P38。未完成真实 Provider/代理验收前，不宣称 Provider 文本生成完整交付。

## 8. Open questions

- 是否允许一个输出项覆盖多个相邻 segment；
- Provider 输出是否保留 confidence 仅用于 Diff 提示，还是进入持久化审计；
- 首个 provider recipe 使用“压缩口语字幕”还是“保留原意改写”。

这些问题必须在 Design Gate 裁决后才能进入实现。

---

## Acceptance cross-check（Implementation Gate 前冻结）

| 项 | 结果 |
|---|---|
| 本地装配与 Provider 文本创作边界 | 已明确分离 |
| Provider 不返回时间码/TimelinePatch | 已冻结 |
| egress/consent/代理复用 | 已冻结为既有机制，不新增旁路 |
| 白名单范围 | 不扩大，待 Design Gate 复核 |
| 真实 Provider/代理验证 | 未完成，单独登记 |
| Desktop raw response/secret 脱敏 | 必须在实现切片验收 |
| 跨项目与基线漂移 | 必须在 Core 测试验收 |

当前 Gate 结论：**Planning Gate 可进入 Design Gate；不得进入真实 Provider 实施。**

---

## 变更记录

- 2026-10-03：首次建立，承接 `WORKLIST_ORCHESTRATION_CAPTIONS_DECISION_2026-10-02.md` 的 Provider 文本生成分支。

## Evidence

本规划不声明实现完成；实现状态以 [`STATUS.md`](STATUS.md) 和后续验收记录为准。

## 评审角色

- Architect：LiuWei——范围、边界、Gate 决策
- Core/Data：ZhangSan——schema、校验、Worklist planner
- Contracts/Desktop：YeJing——DTO、egress/IPC、Diff/consent UI
- Independent Reviewer：LiuKeAi——隐私、跨项目、真实 Provider/代理验收

## 结论

**批准进入 Design Gate。**

Provider 文本生成只有在 Design Gate 冻结并完成独立验证后，才能改变当前 `WORKLIST_STEP_UNAVAILABLE` 以外的能力边界。

## 参考

- [`WORKLIST_ORCHESTRATION_CAPTIONS_DECISION_2026-10-02.md`](WORKLIST_ORCHESTRATION_CAPTIONS_DECISION_2026-10-02.md)
- [`WORKLIST_CAPTIONS_DESIGN_GATE_2026-10-02.md`](WORKLIST_CAPTIONS_DESIGN_GATE_2026-10-02.md)
- [`STATUS.md`](STATUS.md)

## 当前状态

Planning Gate 已完成；Design Gate 待执行。

## 备注

本文件是点时间规划记录，不替代 `STATUS.md` 的当前状态声明。

## 版本

W4.1 captions Provider Planning Gate v1

## 签字条件

签字仅表示规划边界冻结，不表示 Provider 能力已交付。

## 签字

- LiuWei：规划批准
- ZhangSan：待 Design Gate
- YeJing：待 Design Gate
- LiuKeAi：待独立验收

## 退出条件

- Design Gate 文档完成；
- P37/P38 承诺在 `STATUS.md` 注册；
- 实现记录逐项 cross-check；
- 真实 Provider/代理证据单独归档。

## 约束

任何后续代码若扩大白名单、改变协议或迁移，必须同步更新 `STATUS.md` §1。

## 禁止事项

不得把 Provider raw response、完整 transcript 或 secret 写入 Worklist/Revision/UI 日志。

## Final note

先冻结契约，再实现；不以“Provider 可调用”替代“Provider 可安全采纳”。

## 文档同步

本文件引用 `STATUS.md`，不重复声明项目当前阶段或版本。

## Gate owner

LiuWei

## Review date

2026-10-03

## Next artifact

`WORKLIST_CAPTIONS_PROVIDER_DESIGN_GATE_2026-10-03.md`

## Scope lock

本规划只覆盖字幕文本 Provider 方向，不回滚或修改已核销的 P35。

## End

Planning Gate complete.

## Approval

Approved for Design Gate.

## Audit

审计重点：egress、跨项目、raw response、时间码伪造、基线漂移。

## No release claim

本规划不构成发布声明。

## Machine consistency

未改变协议、迁移、patch operation 或 CV 算法字段。

## Handoff

交给 Design Gate 继续。

## Signature policy

真实 Provider 验收必须由独立 Reviewer 复核。

## Close

Planning Gate closed.

## End of record

---

> 本记录的详细状态只以 [`STATUS.md`](STATUS.md) 为准。
