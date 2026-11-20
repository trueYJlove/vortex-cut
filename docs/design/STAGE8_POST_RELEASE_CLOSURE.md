# Stage 8：发布后收口与下一版规划

> 状态：Stage 8 发布后收口已完成，Gate 8-R1–R4 全部通过
> 架构与 Gate 判定：LiuWei
> 独立验收：LiuKeAi
> 主线基线：`0194c44`；Stage 8 规划提交：`6cebde5`
> 当前版本：`0.0.1`
> 下一版建议版本：`0.0.2`
> 目标：完成发布后收口、遗留项处置和下一版范围规划

## 1. 阶段边界

Stage 8 不新增业务功能，只做发布后收口与下一版规划。

仅覆盖：

- Stage 7 发布状态文档一致性修复；
- 遗留项分类与处置策略冻结；
- 本地证据保留策略；
- 分支与版本策略；
- 下一版范围冻结；
- 独立验收与阶段收口。

不覆盖：

- 新 Timeline / Assembly 能力；
- 新 Provider 或网络能力；
- README 重写；
- 自动更新；
- 云服务；
- 跨平台发布；
- 新的数据库 schema；
- 新的契约版本。

## 2. Gate 8-R1：发布后收口审计与文档一致性修复

- [x] 核对当前 Git 基线；
- [x] 核对 `master` 与 `origin/master` 一致性；
- [x] 核对工作区 clean；
- [x] 审计 Stage 7 文档与实际发布状态一致性；
- [x] 盘点 Stage 7 证据链；
- [x] 更新 `docs/design/STAGE7_RELEASE_HARDENING.md` 最终状态；
- [x] 更新 `docs/design/records/PROJECT_RELEASE_STATUS.md` 当前阶段；
- [x] 提交并推送文档收口修改；
- [x] 保持 `stash@{0}` 未应用、未弹出、未删除。

> Gate 8-R1 收口提交：`7a034f9`。当前 `master` 与 `origin/master` 均为 `7a034f9`，工作区 clean。Stage 7 发布判定通过，`38bdcfd` 作为 Windows 桌面应用 `0.0.1` 的发布基线，`7a034f9` 作为发布后文档收口基线。

## 3. Gate 8-R2：遗留项处置计划

### 3.1 `stash@{0}` 处置策略

当前 stash：

```text
stash@{0}: backup untracked stage5/stage6 drafts before master sync
```

只读清单显示其包含 17 个 Stage 5 未跟踪草稿文件，覆盖 Core、Contracts、Desktop、Electron、测试、工具与文档。当前主线已包含 Stage 5 / Stage 6-R 正式实现，该 stash 主要作为历史恢复过程证据。

处置决策：

- 分类：历史草稿备份；
- 风险：低；
- 操作：保留；
- 禁止操作：应用、弹出、删除；
- 复核周期：Stage 9 或下一版冻结前。

### 3.2 本地证据保留策略

Stage 7 证据继续保留：

- `build/reports/stage7-*.json`
- `test-results/stage7-r3-package-r9/`

原因：

- 支撑 Gate 7-R2 至 Gate 7-R5 证据链；
- 支撑 Windows r9 安装包、组件完整性、静默安装 / 卸载与用户数据保留验证；
- 短期内可能用于发布后复核。

### 3.3 本地构建与测试产物处置策略

当前本地忽略目录占用较大：

| 目录 | 文件数 | 占用 |
|---|---:|---:|
| `build/` | 约 5,756 | 约 5.09 GB |
| `test-results/` | 约 45,431 | 约 26.43 GB |
| `.tmp/` | 约 15,278 | 约 716 MB |
| `apps/desktop/.cache/` | 6 | 小于 0.01 MB |

处置原则：

1. 保留 Stage 7 发布证据；
2. 历史调试、重试、临时用户数据与旧安装包可在后续独立授权后清理；
3. 清理必须使用明确限定路径；
4. 清理前必须再次列出目标清单；
5. 未获用户明确授权前，不执行任何递归删除。

### 3.4 分支策略

- `master`：发布主线，当前为 `7a034f9`；
- `liuwei-dev`：冻结为 Stage 7 发布分支，保留 `8b0b3b4`，不继续开发；
- Stage 8 开发分支：建议从 `master` 新建 `codex/stage8-post-release-planning`；
- 历史 `codex/*` 分支：暂不删除，作为阶段历史保留。

### 3.5 版本策略

当前版本为 `0.0.1`。

下一版建议：

```text
0.0.2
```

定位：

- 发布后维护版；
- 不新增业务功能；
- 仅处理文档、发布后遗留项与低风险修复。

进入 `0.1.0` 的前置条件：

1. Stage 8 收口完成；
2. 下一版需求边界冻结；
3. 明确至少一个用户可见能力目标；
4. 回归与发布流程复用 Stage 7 标准。

## 4. Gate 8-R3：下一版范围冻结

- [x] 确认 `0.0.2` 维护版定位；
- [x] 冻结 `0.0.2` 变更清单；
- [x] 明确不改业务功能边界；
- [x] 明确回归范围；
- [x] 明确发布验证范围；
- [x] 记录版本号升级方案；
- [x] 记录不修改 README 的约束是否继续适用。

### 4.1 `0.0.2` 维护版定位

`0.0.2` 定位为发布后维护版，不新增用户可见业务能力，不改变阶段 0–4、Stage 5、Stage 6-R 的功能边界。

### 4.2 变更清单

仅允许以下范围：

1. 将根 `package.json` 与 `apps/desktop/package.json` 的版本号从 `0.0.1` 升级到 `0.0.2`；
2. 同步更新 Stage 8 / 发布状态文档；
3. 如发现文档中明显的发布后状态错误，仅限文档修正；
4. 如发现打包配置中的版本引用错误，仅限配置修正。

不允许：

- 修改 Core 业务逻辑；
- 修改 Renderer / Electron 业务流程；
- 修改数据库 schema；
- 修改 Contracts API；
- 修改 Timeline / Assembly 行为；
- 新增 Provider 或网络能力；
- 修改 README。

### 4.3 回归范围

`0.0.2` 必须至少复跑：

- Core 全量测试；
- Contracts build / typecheck；
- Desktop typecheck / tests / build；
- Stage 5 E2E；
- Stage 6-R E2E；
- Ruff 受管源码范围；
- `git diff --check`。

### 4.4 发布验证范围

`0.0.2` 必须至少执行：

- Windows package verify；
- bootstrap verify-only；
- development fresh / upgrade E2E；
- installed fresh / upgrade E2E；
- 静默安装验证；
- 静默卸载验证；
- 关键组件完整性校验；
- 用户数据保留验证；
- 隐私与安全专项测试；
- 日志与公开证据隐私扫描。

### 4.5 版本号升级方案

版本号只允许升级：

```text
0.0.1 -> 0.0.2
```

同步位置：

- `package.json`
- `apps/desktop/package.json`

不新增版本号配置文件，不引入自动版本生成流程。

### 4.6 README 约束

README 在 `0.0.2` 中继续保持不修改。若未来需要面向用户改写 README，必须在独立 Stage 中单独冻结范围并获得授权。

> Gate 8-R3 记录：Stage 8 规划分支为 `codex/stage8-post-release-planning`，基于 `master` / `0194c44` 创建。`0.0.2` 维护版范围已冻结，只允许版本号、发布文档和必要的打包配置版本引用修正，不修改业务功能。

## 5. Gate 8-R4：独立验收与阶段收口

- [x] 核对文档与实际状态一致；
- [x] 核对 Git 工作区 clean；
- [x] 核对 `master` 与 `origin/master` 一致；
- [x] 核对 `stash@{0}` 状态未变；
- [x] 核对无未授权 Provider 调用；
- [x] 核对无网络外传与费用增量；
- [x] 核对下一版范围无业务功能扩张；
- [x] 形成 Stage 8 独立验收结论。

> Gate 8-R4 独立验收记录：Stage 8 规划分支 `codex/stage8-post-release-planning` 基于主线 `master` / `0194c44` 创建，当前提交为 `6cebde5`。相对 `master` 仅包含 `docs/design/STAGE8_POST_RELEASE_CLOSURE.md` 的范围冻结文档，无业务代码变更。工作区 clean，`stash@{0}` 保留且未应用、未弹出、未删除。Provider 调用、网络外传与费用增量均为 0。`0.0.2` 范围无业务功能扩张，Gate 8-R4 独立验收通过。

## 6. 发布后硬约束

- 不调用真实 AI Provider；
- 不启用 Provider 网络；
- 不产生费用增量；
- 不新增业务功能；
- 不修改 README；
- 不引入新的数据库 schema 或契约版本；
- 不应用、不弹出、不删除 `stash@{0}`；
- 不执行 `git clean`、`git reset`、`git checkout --` 或丢弃用户改动；
- 不执行未授权清理或版本控制操作；
- 不读取、不输出敏感数据或原始异常对象。

## 7. 当前结论

Stage 7 已完成发布收口。Stage 8 已完成发布后收口、遗留项处置计划冻结和 `0.0.2` 维护版范围冻结。下一阶段工作是在独立授权下实施 `0.0.2` 版本号升级，并按 Gate 8-R3 冻结的回归与发布验证范围执行验证。