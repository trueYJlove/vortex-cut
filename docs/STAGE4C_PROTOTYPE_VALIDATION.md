# Stage 4C Gate 4C-2 隔离原型验证记录

> 负责人：LiuWei（架构师）
> Core / SQLite 评估：ZhangSan
> Contracts / Desktop 边界评估：YeJing
> 独立范围复核：LiuKeAi
> 日期：2026-08-18
> 基线：`master` / `27e5ab5` / SQLite v11
> 结论：通过；未授权 Gate 4C-3 生产实现

## 1. 验证目的与隔离边界

本 Gate 只验证 Stage 4C Shot List 领域模型、SQLite v12 候选 DDL、规范化/hash、Revision 幂等与确认语义。原型只写 pytest 临时目录中的合成数据库，未修改生产 `database.py`、Core API、Contracts、Desktop、Electron、打包或用户数据库。

固定零副作用：

- Provider 调用数：`0`；
- `provider_invocations` 增量：`0`；
- MediaGeneration Request/Task 增量：`0`；
- Job 增量：`0`；
- TimelineRevision 增量：`0`；
- Asset 只包含原型主动插入的两个合成归属样例，无生成或注册增量。

## 2. 验证对象

```text
tools/prototypes/stage4c_shot_list_model.py
services/core/tests/prototype/test_stage4c_shot_list_model.py
```

原型不被生产源码导入，不包含网络客户端、Provider SDK、凭据读取、媒体文件操作或 Renderer 接口。

## 3. 指针归属方案比较

验证了两种候选：

1. 复合外键：`(revision_id, shot_list_id)`；
2. 指针更新触发器：更新 current/confirmed 时查询 Revision 所属清单。

两种方案均通过：

- 合法同清单指针可写入；
- current 指向其他清单 Revision 被拒绝；
- `PRAGMA foreign_key_check` 无错误；
- `PRAGMA integrity_check` 返回 `ok`。

最终建议采用复合外键：

```text
shot_lists(current_revision_id, id)
  -> shot_list_revisions(id, shot_list_id)
shot_lists(confirmed_revision_id, id)
  -> shot_list_revisions(id, shot_list_id)
shot_list_revisions(shot_list_id, project_id)
  -> shot_lists(id, project_id)
shot_list_revisions(parent_revision_id, shot_list_id)
  -> shot_list_revisions(id, shot_list_id)
```

理由：归属约束可由 SQLite 外键机制直接审计，减少自定义触发器数量。触发器仍用于 Revision/Requirement 不可变性和 existing_media 的跨项目 Asset 拒绝。

## 4. 数据约束与状态语义

以下全部通过：

- `1` 个和最多 `24` 个 Shot 可接受，`0` 与 `25` 被拒绝；
- ordinal 由数组位置权威生成，数据库限制为 `0–23` 且 Revision 内唯一；
- visual 只能为 `existing_media | image`；
- existing_media 必须带 Asset ID，image 必须不带 Asset ID；
- 可选 narration 只能是 `tts`，正文不能为空；
- target duration 只接受空或 `100_000–600_000_000` 微秒；
- 跨项目 existing_media Asset 被数据库触发器拒绝；
- Revision UPDATE 和 Requirement DELETE 被不可变触发器拒绝；
- 相同 canonical document 幂等复用当前 Revision；
- 错误 base 被拒绝，不静默覆盖；
- 首次确认成功，重复确认幂等；
- 确认非当前 Revision 被拒绝。

## 5. 规范化与 hash

验证通过：

- Unicode NFC；
- inline 文本首尾裁剪、内部空白压缩；
- CRLF/CR 归一为 LF；
- block 文本去除行尾空白；
- 控制字符拒绝；
- exact keys 与递归敏感 key 拒绝；
- 等价规范化文档得到相同 `sha256:` hash。

测试只使用合成英文/Unicode sentinel，不读取用户字幕、转写、媒体路径或 Provider 请求载荷。

## 6. v11→v12 迁移安全

验证通过：

- v1–v11 共 11 个迁移文本的现有 checksum 与已应用记录一致；
- v12 候选只追加三张表、索引和触发器；
- 故意构造的失败迁移在同一事务内完整回滚；
- 失败后无部分表、无 v12 migration 记录；
- 迁移前数据库 backup 文件已创建；
- `foreign_key_check` 与 `integrity_check` 均通过。

原型没有把 v12 写入生产 `MIGRATIONS`；最终 V12_SQL 只允许在 Gate 4C-3 实现。

## 7. 性能

30 次本机隔离运行（每 5 次含一个 24-Shot 文档）：

| 操作 | p50 | p95 | 原型门槛 |
|---|---:|---:|---:|
| create Revision | 11.461 ms | 16.085 ms | ≤ 300 ms |

该数据只表示本机 Python/SQLite 原型事务开销，不是生产 SLA，不包含 Electron、IPC、安装态 I/O、网络、Provider 或媒体处理。

## 8. 执行结果

定向原型：

```text
1 passed
```

迁移基线 + Stage 4A 原型 + Stage 4C 原型：

```text
5 passed
```

静态检查：

```text
Ruff: All checks passed
```

Windows pytest 进程退出时仍可能出现既有临时目录符号链接 `PermissionError` 清理提示；本次改用仓库内显式 `--basetemp` 后，断言和退出均通过，该提示不构成业务失败。

## 9. 角色结论

### ZhangSan

复合外键覆盖 Shot List、Revision、parent 的同聚合归属；触发器覆盖不可变性与跨项目 Asset。完整 Revision 原子写、幂等、并发和确认语义可落地，不需要 Job runner。

### YeJing

原型未改变 DTO/IPC。五个窄 API 足够支持后续工作台；生产 Contracts 必须保持 Summary/Detail 分离、exact keys，并禁止路径、Provider 字段和原始异常。

### LiuKeAi

原型范围未扩展到 Provider、媒体、Asset 注册、Timeline 或打包；零副作用计数成立。原型结果不能替代 Gate 4C-4 的真实 Electron/Windows 独立验收。

## 10. Gate 结论

Gate 4C-2 判定为：**通过**。

允许的下一步仅为：收到用户明确授权后进入 Gate 4C-3，按冻结 DDL 实现正式 SQLite v12、Core API、Contracts、IPC/Preload 和 Desktop 工作台，并完成开发侧验证。

本结论不授权：

- 真实 Provider 或网络请求；
- 媒体生成、下载或注册；
- 自动创建 Stage 4A/4B Request/Task；
- Timeline、Preview、Render、Export 或 Batch；
- Gate 4C-4 Windows 独立真实验收；
- 提交、推送、PR 或合并。
