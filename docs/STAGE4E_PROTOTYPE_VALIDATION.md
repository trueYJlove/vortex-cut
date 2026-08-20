# Stage 4E Gate 4E-2 隔离原型验证

> 负责人：LiuWei（架构师）  
> 基线：`master` / `30dcb4e`  
> 日期：2026-08-19  
> 状态：Gate 4E-2 通过；Gate 4E-3 已于 2026-08-20 通过，生产结果见 `STAGE4E_GATE4E3_VALIDATION.md`  
> Provider 调用：0  
> 提交/推送：未执行

## 1. 验证目标

本 Gate 只验证 Stage 4E 冻结方案的关键技术假设，不修改生产 Core、Contracts、Desktop、Electron 或正式迁移：

1. SQLite v15 仅追加 link/adoption 两张事实表可落地；
2. Stage 4D fresh/reused 创建路径可在 COMMIT 前调用内部 transaction hook；
3. Requirement hash 可形成稳定固定向量；
4. adoption ledger 可通过 `BEGIN IMMEDIATE`、最大 ordinal 与 CAS 防止覆盖；
5. lifecycle 可由 Task/Adoption/Asset 事实纯派生；
6. Renderer 可在不接生产 UI 的情况下落实显式 Prepare/Create/Adopt、权威回读与迟到响应隔离；
7. Provider、Timeline、Preview、Render、Export、Batch 副作用均为 0。

## 2. 隔离边界

新增原型与测试：

```text
tools/prototypes/stage4e_requirement_fulfillment_model.py
services/core/tests/prototype/test_stage4e_requirement_fulfillment_model.py
tools/prototypes/stage4e_requirement_fulfillment_workbench_model.ts
apps/desktop/tests/stage4e-fulfillment-workbench-prototype.test.ts
```

未修改任何受版本控制的生产文件，未写入用户数据库，未接 Renderer 生产入口，未创建 Provider HTTP client，未读取凭据，也未提交或推送。

## 3. ZhangSan：Core / SQLite / 任务系统结论

### 3.1 SQLite v15 候选

原型在临时数据库上先加载正式 v1–v14，再追加候选 v15 DDL。验证结果：

- v1–v14 migration SQL 的 SHA-256 在原型前后保持不变；
- 候选 v15 只新增：
  - `shot_requirement_image_generation_links`；
  - `shot_requirement_image_adoptions`；
  - 三个查询索引；
  - link/adoption 资格与 immutable triggers；
- `foreign_key_check` 无错误；
- `integrity_check` 为 `ok`；
- 非当前 confirmed Revision、`existing_media`、历史 OpenAI Profile 均被拒绝；
- link/adoption 的 UPDATE、DELETE 均被拒绝；
- 同一 Stage 4D Request 可经独立确认关联两条 Requirement。

原型未把 v15 加入正式 `MIGRATIONS`，因此未迁移任何生产或用户数据库。

### 3.2 Requirement hash 固定向量

规范化规则使用 UTF-8、键排序、无多余空白 JSON 和 `sha256:` 前缀。原型固定输入的验证向量为：

```text
sha256:9b5b48e0e5a2076dca47a0756b675a287e6ecd5c9c6dcc101a0cfacec7e2c243
```

测试同时证明任一冻结字段变化都会改变 hash。

### 3.3 fresh/reused transaction hook

隔离服务将两条路径统一为：

```text
BEGIN IMMEDIATE
  解析或创建 RequestTaskFacts
  transaction_hook(sql, facts)
COMMIT
```

结论：

- fresh hook 失败时，Request、Task、Job、Invocation 和 link 全部回滚；
- reused hook 失败时，不新增 link，也不修改既有 Request、Task、Job；
- hook 为 `None` 时仍可走普通创建路径；
- hook 不需要联网、文件 IO 或 worker 启动；
- 生产实现可以据此消除 Stage 4D reused 分支当前的提前 COMMIT，同时保持公开 DTO/Provider 行为不变。

### 3.4 adoption CAS 与 lifecycle

验证覆盖：

- 第一条 adoption 为 ordinal 1 且 previous 为 null；
- 切换采用只追加 ordinal 2，并引用上一事件；
- 相同目标在 CAS 匹配后幂等复用；
- stale expected ID 先返回冲突，不自动当作幂等成功；
- 两个独立 SQLite connection 读取同一旧快照时，仅第一窗口可写入，第二窗口稳定冲突；
- Task、Asset、Request、Provenance 任一交叉不一致均拒绝；
- Asset 后续变为 missing 时，adoption 历史仍保留。

六态优先级验证为：

```text
adopted_unavailable
adopted
review_required
in_progress
no_usable_output
unstarted
```

Task 正式状态仅使用 `queued/running` 派生 `in_progress`，未把 Job 独有的 `cancelling` 错当作 Task 状态。

## 4. YeJing：Contracts / Desktop / Electron 结论

Renderer 静态状态模型验证：

- 当前 confirmed image Requirement 可编辑 Prompt；
- 历史 Revision 和 `existing_media` 只读且没有生成入口；
- Prepare 返回的确认摘要不含 Prompt；
- Prompt 修改后 prepared confirmation 立即失效；
- Create 必须显式确认，并分别呈现 generation/link reused；
- Job 事件只触发权威 state 回读，不触发重复 Create；
- succeeded 映射 `review_required`，不会自动 Adopt；
- Adopt 必须再次显式确认；
- stale CAS 后刷新权威 state，不自动重发 Adopt；
- `adopted_unavailable` 保留 adoption 摘要；
- Project/Revision 切换后丢弃迟到响应；
- Renderer 安全证据不含 Prompt、绝对路径、secret 或原始异常；
- Timeline/Preview/Render/Export/Batch 操作计数均为 0。

原型未修改生产 Contracts、IPC、preload、Core client、App 或样式。

## 5. 自动验证结果

### 5.1 Core 原型

```text
11 passed
```

命令：

```powershell
.\.venv\Scripts\python.exe -m pytest services/core/tests/prototype/test_stage4e_requirement_fulfillment_model.py -q
```

### 5.2 Renderer 原型

```text
1 file passed
9 tests passed
```

命令：

```powershell
apps\desktop\node_modules\.bin\vitest.CMD run tests/stage4e-fulfillment-workbench-prototype.test.ts
```

### 5.3 静态检查

- Ruff：`All checks passed!`
- Desktop TypeScript：全量 `tsc --noEmit` 通过；
- `git diff --check`：通过。

### 5.4 结构化原型摘要

```json
{
  "schema_version": "v15-candidate",
  "frozen_migration_count": 14,
  "requirement_hash_fixed_vector": "sha256:9b5b48e0e5a2076dca47a0756b675a287e6ecd5c9c6dcc101a0cfacec7e2c243",
  "link_insert_p95_ms": 2.649,
  "lifecycle_states": [
    "unstarted",
    "in_progress",
    "review_required",
    "adopted",
    "adopted_unavailable",
    "no_usable_output"
  ],
  "provider_call_count": 0,
  "forbidden_side_effect_count": 0
}
```

性能数值来自本机隔离 SQLite 临时数据库，只用于证明远低于 Gate 4E-2 的 300ms 原型停止线，不作为生产 SLA。

## 6. 隐私与 Provider 证明

- 原型没有网络调用库和 Provider endpoint；
- fake API 与结构化报告的 `provider_call_count` 均固定并断言为 0；
- 未读取 safeStorage、环境变量 token、API key 或 Provider 配置秘密；
- 敏感值扫描未发现 key、Bearer、Authorization 值、data URI/base64 或私钥材料；
- link/adoption 表只含 IDs、hash、ordinal 和时间，不复制 Requirement 正文或 Prompt；
- 安全证据测试明确注入 Prompt、Windows 绝对路径和原始异常 sentinel，并证明均未外泄。

## 7. LiuKeAi 独立审查结论

### 7.1 已通过

1. Stage 4C Requirement 与 Stage 4D Request/Task/Provider 公开契约均未改动；
2. v15 候选是纯追加迁移，不回填历史；
3. fresh/reused 原子 hook 技术可行；
4. 同 Request 多 Requirement 与唯一 link 约束可共存；
5. adoption append-only、CAS 和历史不可变可落地；
6. confirmed Revision 切换后旧记录保留但新写入 fail-closed；
7. Renderer 明确区分生成成功、审阅、采用与 Asset 不可用；
8. 禁止的 Timeline/Render/Export/Batch 副作用为 0；
9. Provider 调用为 0；
10. 原型未越界修改生产实现。

### 7.2 留给生产 Gate 的风险

- 生产 Stage 4D reused 分支必须重构提前 COMMIT，且需回归 Prompt vault reservation/transfer/discard 与 worker 可见性；
- v15 trigger 与应用层必须双重校验，不能只依赖其中一层；
- 生产 API 必须在 Prepare、Create、Adopt 三个写点重新验证 confirmed Revision；
- Electron IPC 和 Contracts parser 必须继续使用 Stage 4E 独立安全白名单，不能把 Stage 4C 正文字段复制进 fulfillment DTO；
- 本 Gate 未做生产数据库迁移、Electron UI、Windows/NSIS 或真实 Provider 验收，这些分别属于 Gate 4E-3 至 4E-5。

## 8. Gate 结论与下一门禁

**Gate 4E-2 通过。** 原型未发现需要退回 Gate 4E-1 修改冻结契约的阻塞问题。

后续已获授权并完成 **Gate 4E-3 生产实现与离线验证**，结果见 `STAGE4E_GATE4E3_VALIDATION.md`。Gate 4E-3 实际保持：

- Provider 调用为 0；
- 不使用真实用户数据库；
- 不执行真实 Provider 验收；
- 不提交、不推送，除非另获明确授权；
- 生产改动严格按 ZhangSan / YeJing 互斥写入边界执行，角色定义不约束顺序、并行方式或是否使用 subagent。
