# Stage 6-R 独立验收：多条已采用图片的显式 Timeline 批量装配

> 状态：Gate 6-R5 总回归与收口通过；PR #12 已合并
> 审查角色：LiuKeAi
> 依据：`docs/STAGE6R_CONTRACT_FREEZE.md` 与 `docs/STAGE6R_DETAILED_DESIGN.md`

## 1. 独立验收范围

仅验收：

- 多条 image Requirement 的当前 Adoption；
- 用户显式排序；
- 一个批量 Preview；
- 一次显式 Apply；
- 一个新 Timeline Revision；
- 一个批量 Assembly 批次；
- N 条 item Assembly；
- all-or-nothing 事务；
- 幂等重放；
- SQLite v17 fresh/upgrade；
- Stage 5 兼容；
- Provider/网络/费用零增量；
- 隐私安全。

不验收旧 Stage 6 草稿中的智能建议、历史比较、版本回滚或跨项目分享。

## 2. Gate 6-R0：范围与文档审查

- [ ] 三份 Stage 6-R 文档存在且相互一致；
- [ ] 旧 Stage 6 文档不再作为实施依据；
- [ ] 唯一范围为多条当前已采用图片的显式批量装配；
- [ ] 不改变 Stage 4E 单当前 Adoption；
- [ ] 不修改 Stage 5 单图装配行为；
- [ ] 批量上限明确为 2–24；
- [ ] 同批 Requirement 唯一；
- [ ] all-or-nothing 语义明确；
- [ ] 成功 Apply 仅创建一个 Timeline Revision；
- [ ] Provider/网络/费用增量为 0；
- [ ] 隐私边界不弱于 Stage 5；
- [ ] v17 只追加新表；
- [ ] 不引入 Alembic/SQLAlchemy/services/web。

## 3. Gate 6-R1：隔离原型验收

> 当前结论：已通过。原型 CLI 自检、语法编译、核心数据库完整性检查、定向 pytest（7 passed）与 Ruff（All checks passed）均完成；v16 数据保留验证按边界留待 Gate 6-R2。

- [x] 原型文件不接入生产 Core/API/UI；
- [x] 批量大小 1、2、24、25 边界正确（1/25 拒绝，2/24 通过测试用例定义与 CLI 24 item 路径）；
- [x] Requirement 重复被拒绝；
- [x] 顺序构建与用户数组顺序一致；
- [x] 起始位置与连续插入位置正确；
- [x] 锁定 Clip 冲突整批拒绝；
- [x] 单 item 失败整批回滚（定向 pytest 已执行）；
- [x] 成功只产生一个 proposed Document；
- [x] Preview hash 覆盖全部 item；
- [x] SQLite v17 原型只追加表；
- [ ] v16 数据保留可读（Gate 6-R1 隔离原型使用独立 schema，该项留待 Gate 6-R2 生产迁移验证）；
- [x] Provider 调用、网络调用、费用增量为 0；
- [x] SQLite integrity_check / foreign_key_check 通过；
- [x] 隐私敏感标记扫描为 0；
- [x] 定向 pytest 通过（7 passed）；
- [x] Ruff 静态检查通过（All checks passed）。

## 4. Gate 6-R2：Core 生产实现验收

- [x] `database_v17.py` 接入 `MIGRATIONS`；
- [x] fresh 初始化到 v17；
- [x] v16 数据库可升级到 v17；
- [x] v16 既有 Stage 5 Preview/Assembly 保留；
- [x] v17 新表均不可 UPDATE/DELETE；
- [x] `(batch_id, requirement_id)` 唯一；
- [x] `(batch_id, item_index)` 唯一；
- [x] `(batch_id, proposed_clip_id)` 唯一；
- [x] Prepare 零 Timeline Revision 副作用；
- [x] Prepare 只创建一个 Preview 和 N 条 item；
- [x] Apply 显式确认；
- [x] Apply 单事务；
- [x] Apply 只创建一个 Timeline Revision；
- [x] Apply 只创建一个 Assembly 批次；
- [x] Apply 创建 N 条 Assembly item；
- [x] 任一失败全回滚；
- [x] 同 Preview 重放返回 reused=true；
- [x] Preview 过期拒绝；
- [x] Adoption/Timeline/Draft/Asset 冲突 fail closed；
- [x] Core 单元与集成测试通过。

> Gate 6-R2 独立验收记录：v17 迁移测试 4 passed；Stage 6-R Core 定向测试 14 passed；Stage 5 回归 4 passed；Ruff All checks passed。测试使用 `FailOnCallImageProvider`，Provider 调用增量、网络外传、费用增量均为 0；隐私敏感键扫描与 Stage 6-R 表数据扫描通过。

## 5. Gate 6-R3：Contracts / Electron / Desktop 验收

- [x] `stage6r-v1` contracts 定义完整；
- [x] 输入 DTO 拒绝敏感键；
- [x] 输出 DTO 严格白名单；
- [x] IPC 通道白名单；
- [x] Renderer 不提交 Timeline Document/Patch；
- [x] 批量 UI 只列出可用当前 Adoption；
- [x] 用户显式选择与排序；
- [x] 用户显式设置起始位置、时长、布局；
- [x] UI 明示 all-or-nothing；
- [x] Prepare 只显示安全摘要；
- [x] Apply 显式确认；
- [x] 成功后通过既有 Timeline API 刷新；
- [x] Stage 5 单图 UI 不回归；
- [x] Desktop 测试通过。

> Gate 6-R3 独立验收记录：Contracts build/typecheck 通过；Desktop typecheck 通过；Contracts/IPC/UI 定向测试 23 passed；Desktop 附加回归 28 passed；Core Stage 6-R 定向测试 18 passed；Core Stage 5 回归 4 passed；Gate 6-R3 相关 Core 文件 Ruff All checks passed；`git diff --check` 通过。UI 使用安全 ID 缩写，不展示 Requirement 标题、正文、Prompt、字幕或媒体路径；Renderer 只提交白名单 Prepare/Apply DTO，不提交 Timeline Document/Patch。

## 6. Gate 6-R4：独立真实验收

- [x] development fresh；
- [x] development upgrade v16→v17；
- [x] installed fresh；
- [x] installed upgrade v16→v17；
- [x] 批量装配 2 条成功；
- [x] 批量装配 24 条成功；
- [x] 单条冲突整批失败；
- [x] 重启后批次、item、Timeline Revision 恢复；
- [x] Undo/Redo 行为正确；
- [x] Stage 5 单图装配仍可用；
- [x] Provider 调用增量 0；
- [x] 网络外传增量 0；
- [x] 费用增量 0；
- [x] 隐私扫描通过；
- [x] Windows 安装态验证通过。

> Gate 6-R4 独立验收记录：development fresh / development upgrade v16→v17 / installed fresh / installed upgrade v16→v17 四条真实离线 Electron E2E 均通过。每条路径均验证 24 条批量装配、重启恢复、Undo/Redo 与 Stage 5 单图装配；Provider 调用、生成事实、自动渲染与自动产物增量均为 0，SQLite v17、foreign_key_check、integrity_check 与隐私扫描通过。2 条批量装配与单条冲突整批失败由 Core 定向验收覆盖（11 passed）；Windows 真实打包、包内组件 verify、bootstrap verify-only 与安装态 E2E 通过。全程未调用真实 AI Provider，网络与真实 Provider 保持禁用。

## 7. Gate 6-R5：总回归与收口

- [x] Core 全量回归通过；
- [x] Contracts build/typecheck 通过（包未定义 test 脚本，不声称 tests 通过）；
- [x] Desktop typecheck/tests/build 通过；
- [x] Stage 5 E2E 回归通过（development fresh）；
- [x] Stage 6-R E2E 通过（development fresh；四条矩阵与安装态证据见 Gate 6-R4）；
- [x] Ruff 全仓通过（仅机械格式化，无业务逻辑变更）；
- [x] Windows package verify 通过（复用 Gate 6-R4 已验证的 R1 包内组件与 bootstrap verify-only 证据）；
- [x] 文档状态更新一致；
- [x] README 未修改；
- [x] 工作区 clean；
- [x] 无未授权 Provider 调用；
- [x] 无敏感数据输出；
- [x] Git 提交、推送、PR 均获得用户明确授权后执行。

> Gate 6-R5 独立验收记录：Core 全量回归 478 passed / 1 deselected；Contracts build/typecheck 通过且当前包无 test 脚本；Desktop typecheck、219 tests、build 通过；Stage 5 development fresh E2E 与 Stage 6-R development fresh E2E 通过；v17 迁移与 Stage 6-R Core 定向回归 11 passed；Ruff 全仓通过；`git diff --check` 通过；Windows package verify 复用 R1 通过证据。全程真实 Provider 与网络保持禁用，Provider 调用、网络外传、费用增量均为 0。版本控制操作已获用户授权并完成本地提交、远端推送与 PR #12；PR #12 已合并到 `master`。

## 8. 证据要求

建议证据路径：

```text
build/reports/stage6r-gate*-core-*.json
build/reports/stage6r-gate*-electron-*.json
build/reports/stage6r-gate*-desktop-*.json
build/reports/stage6r-privacy-scan.json
build/reports/stage6r-migration-*.json
build/reports/stage6r-windows-*.json
```

证据必须记录：

- 目标环境；
- 数据库 schema version；
- item 数量；
- Timeline Revision 数量；
- Assembly 批次数量；
- Assembly item 数量；
- Provider delta；
- 网络 delta；
- 隐私扫描结果；
- 失败用例的安全错误码。

## 9. 隐私与安全硬约束

- 不读取、不输出、不持久化 token、API key、Authorization；
- 不读取、不输出、不持久化原始请求/响应；
- 不读取、不输出媒体绝对路径；
- 不持久化 Prompt/Requirement 正文；
- 不持久化字幕/转写正文；
- 不输出原始异常对象；
- 不调用真实 AI Provider；
- 不引入网络外传；
- 不产生费用增量。

## 10. 通过标准

Stage 6-R 只有在以下条件全部满足时才可判定完成：

1. Gate 6-R0–R5 全部通过；
2. Stage 5 行为无回归；
3. 数据库升级与回滚证据完整；
4. Electron/Desktop 真实链路验证完整；
5. Provider、网络、费用增量均为 0；
6. 隐私扫描通过；
7. 文档、测试与实现一致；
8. 用户明确授权版本控制操作。
