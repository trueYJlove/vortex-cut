# ADR-0002：架构结构债评审与 Stage 3 前整改方向

- 状态：已批准
- 日期：2026-09-05
- 记录人：AI 评审（DeepSeek Harness 会话，基于 ARCHITECTURE.md 基线 v1.0 与定点代码抽查）
- 决策人：用户（产品负责人）于 2026-09-05 批准；LiuWei（架构师）负责整改方案评审；R3、R6 列入 LiuKeAi（独立评审）验证清单

## 背景

Stage 2C 处于实现与验收阶段。本次评审以 `ARCHITECTURE.md`（基线 v1.0）与 `README.md` 为基准，对当前代码做定点抽查取证，检查"架构基线承诺"与"代码现实"的偏差。证据来源：

- `apps/desktop/electron/main/index.ts`（795 行）、`apps/desktop/electron/main/sidecar-supervisor.ts`、`apps/desktop/electron/preload/index.ts`
- `apps/desktop/src/lib/core-client.ts`（700 行）
- `services/core/src/aivs_core/` 模块行数清单与 `from fastapi/pydantic` 导入扫描
- `services/core/src/aivs_core/database_v13..v17.py`、`migrations/0017_sqlite_v17.py`
- `pnpm-workspace.yaml`、`services/web/`、`docs/design/adr/`

评审结论：架构方向与安全基线执行良好（进程隔离、契约单一来源、领域层纯净、微秒时间约束均有代码证据），主要债务为结构性膨胀，集中体现为以下六项。

## 发现（按严重度）

### R1 · Electron Main 正在成为"第二个 API 网关"（最高优先）

`main/index.ts` 注册 9 个按交付阶段命名的 IPC 模块（`stage2a/2b/3b/4/4c/4d/4e/5/6r-ipc`），并引入约 40 个 `@aivideo/contracts` 解析器在 Main 侧做响应校验；`candidate-media.ts`、`export-destination.ts` 等文件业务职责渐重。§5.1 约定"Electron 不包含创作或时间线业务逻辑"，现状为"OS 集成 + 业务代理"。业务数据本可经 Renderer → Core 直连（`core-client.ts` 证明通道存在），同一契约的解析校验在 `core-client.ts` 与 `main/*-ipc.ts` 两处重复，契约漂移点翻倍。

### R2 · 核心服务从"模块化单体"滑向"平铺大文件"

`aivs_core` 顶层 30 个 py 模块：`timeline.py` 2803 行、`app.py` 2373 行、`planning.py` 1374 行；`shot_requirement_*` 一族 6 个文件平铺顶层。§17 规划的 `domain/application/infrastructure/media/jobs` 分层未执行。

### R3 · Schema 演进双轨制

迁移 SQL 存在两个位置：`migrations/0017_sqlite_v17.py` 与顶层 `database_v13..v16.py`；§5.3 承诺的 Alembic 未采用。桌面发布的关键路径"旧用户库升级"缺少"任意旧版本 → 最新"的自动化升级测试与迁移前自动备份演练（§11 仅有文字要求）。

### R4 · `services/web` 为孤儿工作区

`pnpm-workspace.yaml` 仅含 `apps/*`、`packages/*`；`services/web/src/components/ShotRequirementTimelineAssemblyPanel.tsx` 未接线。易造成"Web 版已启动"的错误认知。

### R5 · ADR 纪律滞后

期间发生 ≥17 次 Schema 演进、9 个 Stage IPC 模块、品牌切换（`aivs_core`/`aivideo`/Vortex Cut 三套标识并存），`docs/design/adr/` 仅有 1 篇记录。

### R6 · 跨目录依赖破坏目录语义

`main/index.ts` 从 `"../../src/lib/core-client.js"` 导入，Main 复用 renderer 目录代码，`src = renderer` 的边界约定被打破。

## 建议决策

1. **R1**：Main 职责立白名单（文件授权、凭据、受限媒体、导出目的地、Sidecar 生命周期）；业务数据通道统一走 Renderer → Core 直连；`stage-*-ipc` 按能力域（media/export/secrets/grants）重组，删除按时间编号的永久结构。Stage 3 开工前完成方案评审。
2. **R2**：采用增量分层规则——新模块必须进 §17 子包；超过 800 行的文件拆分时按分层落位；`shot_requirement_*` 收进子域包；`app.py` 按路由域拆分 router。不进行一次性大搬家。
3. **R3**：迁移 SQL 统一收纳至 `migrations/`（0013..0017）；补"任意旧版本 → 最新"升级集成测试；补迁移前自动备份演练。是否引入 Alembic 留待 Stage 4 前再评估。
4. **R4**：删除 `services/web` 或移入 `apps/` 并在 README 注明。
5. **R5**：每个 Stage 收尾补一篇 ADR；优先补：迁移机制、IPC 通道划分、品牌兼容层收敛计划。
6. **R6**：共享 client 上移为 `packages/` 内的包（如 `@aivideo/core-client`），Main 与 Renderer 同源引用。

目标形态参考图：原 `docs/design/diagrams/vortex-cut-architecture-compare.html`（base = 当前形态，head = 目标形态；该批 Stage 2C 生成图产物已于 2026-11-25 清理，如需查阅可从 Git 历史恢复）。
- compare 页 Delta 清单（17 处规格变更）作为 Stage 3 准入核对表蓝本，随整改推进逐项核销。

## 影响

- 不改变对外 API 行为、SQLite 数据语义与用户可见功能；R3 仅调整迁移 SQL 的收纳位置，不新增 Schema 版本。
- 涉及文件面：`apps/desktop/electron/main/*`、`apps/desktop/src/lib/core-client.ts`、`services/core/src/aivs_core/*`、`pnpm-workspace.yaml`。
- R1/R2/R3 建议 Stage 3 开工前关闭方案评审；R4/R6 可立即执行；R5 持续执行。

## 否决方案

- **一次性把 `aivs_core` 重写为 §17 完整分层**：否决，大搬家风险大于收益，采用增量规则渐进落位。
- **立即引入 Alembic 替换手写迁移**：否决，单写者 SQLite 场景收益有限；先统一收纳并补升级测试，Stage 4 前再评估。
- **冻结新功能、安排专项重构迭代**：否决，采用随 Stage 3 切片渐进偿还，避免阻塞产品闭环。
