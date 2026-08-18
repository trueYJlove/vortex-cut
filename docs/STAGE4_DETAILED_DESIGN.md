# 阶段 4A 详细设计：生成式素材预研与素材化闭环

> 角色：LiuWei（架构师）
> 状态：待确认、草案冻结稿
> 日期：2026-08-18
> 基线：`91d4f94 docs: add Stage 4 requirements skeleton`
> 上位契约：`docs/STAGE4_CONTRACT_FREEZE.md`

## 1. 目标与阶段定位

### 1.1 为什么要做 Stage 4A

在 ARCHITECTURE 的“18. 分阶段实施计划”中，路线图 **Stage 4 = 生成式素材（TTS/图片/视频）**。
当前仓库实现到 `master` 上的 `91d4f94` 阶段，已完成到 `STAGE3B` 侧重于重构图与稳定批量导出。

因此本阶段文档把当前工程阶段命名为：

- **Stage 4A（工程内名）**：在不改动 Stage 1–3B 冻结行为的前提下，完成“生成式素材”能力的统一数据模型与预研验证闭环。
- 对应 ARCHITECTURE 语义：**Stage 4 落地前的预研与边界验证**。

Stage 4A 的目标不是一次性上线“完整生成式创作链”，而是为下一阶段（Stage 4B/4C）提供可直接落地的契约和数据基础。

### 1.2 Stage 4A 交付目标（本次冻结范围）

1. 建立 `media generation request / task` 的统一领域模型与接口。
2. 在不调用真实 Provider 的前提下，建立可回放、可验收的模拟/预演流程。
3. 增加 **SQLite v11**（仅追加）与最小可验证迁移。
4. 增加独立 Snapshot/API/Batch 思想的映射到生成任务生命周期（不混入现有 Batch/Preview 行为）。
5. 明确隐私边界、失败归档、重试与任务恢复规则。

### 1.3 非目标（继续沿用 3x3 阶段边界）

- 不修改 Stage 3B 的 3×3 锚点、RenditionSnapshot、ReframeBatch、DirectoryGrant 等既有逻辑。
- 不修改 TimelineDocument v1、Clip schema 与既有 Patch 行为。
- 不改 Provider 数量、Provider 调用计费逻辑和 Provider 账单流水。
- 不做视频生成生产闭环，不做自动发布，不做自动素材替换。

## 2. 现状盘点与可复用能力

当前基线（`91d4f94`）可复用能力如下：

### 2.1 Core 能力

- 已有 **Jobs / JobEvent / 恢复机制**（重启后 interrupted）可复用于生成任务。
- 已有 **Provider 能力测试路由**（文本、候选、TimelinePatch）和 Provider 配置体系。
- 已有 `provider_invocations` 审计结构，可用于后续生成调用审计（Stage4B 预留）。
- 已有 `contracts + guard` 风格：`extra='forbid'` + 严格类型 + `removeSensitiveFields`。
- Stage 3B 已完成 SQLite v10，只读迁移机制可继续追加 v11。

### 2.2 Desktop/Electron 能力

- 主进程 IPC 已有 `stage2a-ipc / stage2b-ipc / stage3b-ipc` 的分片写法。
- `core-client` 有统一 fetch/auth 及错误映射基础。
- `rendererSafe` 已有敏感字段剥离机制。

### 2.3 限制与空白

- 当前无 `media_generation` 相关实体、表、路由。
- 合同版本仍为 `stage3b-v1`，不应在 Stage4A 内改写现网主版本。
- 无真实生成模型回路；如要扩展需新建服务与 adapter（冻结后再接）。

## 3. 推荐实现方案（唯一推荐）

在三个方案中，采用「**模型化生成请求 + 独立生成任务 + 仅 hash/摘要持久化**」作为唯一落地方案。

### 方案对比（简要）

- 方案A（推荐）：建立独立生成 Domain（建议）
  - 价值：与现有候选/视频编辑解耦；适合后续独立扩展 TTS/图片/视频。
  - 风险：新增 2-3 张表 + 路由 + UI 页面。
  - 验收成本：中等，主表+任务状态+隐私校验可覆盖。

- 方案B：复用 candidate_generation（不推荐）
  - 价值：改动小，但语义会与剪辑候选耦合。
  - 风险：后续 Stage4B 需要重构；难以保证隐私策略和生命周期清晰。

- 方案C：直接走 job + assets（不推荐）
  - 价值：实现快。
  - 风险：失去请求/任务语义分层，无法支撑模拟验收和 retry lineage。

### 3.1 方案 A 的核心原则

1. **独立域**：`media_generation_request`（需求）+ `media_generation_task`（执行）
2. **任务可恢复**：复用 `jobs` 表的 running/queued/succeeded/failed/cancelled/interrupted。
3. **隐私最小化**：只存 prompt 的 hash + 白名单参数摘要，不存明文敏感内容。
4. **无真实 Provider 依赖**：Stage4A 首版不发起外部模型调用。
5. **回放友好**：任务通过 request/task hash 做幂等，支持重放与可回退。

## 4. 数据模型与接口设计（冻结清单）

### 4.1 数据库（v11）

#### 4.1.1 新增常量与迁移

- 新建 `V11_VERSION = "v11"`
- 在 `MIGRATIONS` 中追加 `V11_SQL`
- 保留 `v1~v10` 不改（checksum 与内容不可改）

#### 4.1.2 表结构（建议）

1. `media_generation_requests`

- `id TEXT PRIMARY KEY`
- `project_id TEXT NOT NULL REFERENCES projects(id)`
- `generation_kind TEXT NOT NULL CHECK(kind IN ('image','tts'))`
- `provider_config_id TEXT NULL REFERENCES provider_configs(id)`
- `status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','interrupted'))`
- `input_hash TEXT NOT NULL`（包含 kind/输入摘要）
- `prompt_hash TEXT NOT NULL`（仅摘要）
- `parameter_json TEXT NOT NULL`（去敏版本）
- `input_refs_json TEXT NOT NULL`（timeline_segment_id / asset_id 白名单索引）
- `provider_capability_snapshot_json TEXT NOT NULL`
- `error_code TEXT NULL`
- `error_message TEXT NULL`
- `created_at/updated_at/finished_at`

2. `media_generation_tasks`

- `id TEXT PRIMARY KEY`
- `request_id TEXT NOT NULL REFERENCES media_generation_requests(id) ON DELETE CASCADE`
- `job_id TEXT NULL REFERENCES jobs(id)`
- `attempt INTEGER NOT NULL DEFAULT 1`
- `status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','interrupted'))`
- `stage TEXT NULL`
- `output_asset_id TEXT NULL REFERENCES assets(id)`
- `output_sha256 TEXT NULL`
- `output_media_info_json TEXT NULL`
- `error_code TEXT NULL`
- `error_message TEXT NULL`
- `retry_of_task_id TEXT NULL REFERENCES media_generation_tasks(id)`
- `created_at/updated_at/finished_at`

3. 索引

- `idx_media_generation_requests_project`
- `idx_media_generation_tasks_request`
- `idx_media_generation_tasks_job`

4. 约束/不变式

- `media_generation_task` 为请求派生历史，不得存储绝对路径。
- 任务可有 `retry_of_task_id`，支持 lineage。

### 4.2 Contracts（建议新增 DTO）

> 只做可新增，不在旧接口中改 optional 字段。

- ID 类型：
  - `MediaGenerationRequestId`
  - `MediaGenerationTaskId`
- 枚举：
  - `GenerationKind = "image" | "tts"`
  - `GenerationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted"`
- 对象：
  - `MediaGenerationRequest`
  - `MediaGenerationRequestSummary`
  - `MediaGenerationTask`
  - `MediaGenerationInput`
  - `MediaGenerationResultSummary`
  - `MediaGenerationRetryInput`
- 错误码（拟）：
  - `GENERATION_REQUEST_INVALID`
  - `GENERATION_KIND_UNSUPPORTED`
  - `GENERATION_PROVIDER_UNSUPPORTED`
  - `GENERATION_INPUT_CHANGED`
  - `GENERATION_OUTPUT_INVALID`
  - `GENERATION_RETRY_NOT_ALLOWED`
  - `GENERATION_HASH_MISMATCH`

### 4.3 API（建议）

以独立 REST 组替代复用 `candidate-generations`：

- `POST /api/v1/projects/{project_id}/media-generation-requests/prepare`
  - 输入：`kind` + `input_refs` + `params`（去敏字段）
  - 输出：request hash 与字段校验结果

- `POST /api/v1/projects/{project_id}/media-generation-requests`
  - 输入：与 prepare 一致 + 用户确认
  - 输出：`MediaGenerationRequest` + `media_generation_task`

- `GET /api/v1/projects/{project_id}/media-generation-requests`

- `GET /api/v1/media-generation-requests/{request_id}`

- `GET /api/v1/media-generation-requests/{request_id}/tasks`

- `POST /api/v1/media-generation-requests/{request_id}/retry`

- `POST /api/v1/media-generation-requests/{request_id}/cancel`

- `POST /api/v1/providers/{provider_config_id}/media-generation-capability-test`

说明：阶段4A 内默认不实现真实模型调用，`create/prepare` 可返回 `UNSUPPORTED` 或 `SIMULATION_OK` 标记。

## 5. 核心服务流（数据流）

```text
用户输入/Clip引用
   -> create/prepare
      -> Core 计算 hash 与参数摘要
         -> 写入 media_generation_requests
            -> 创建/关联 media_generation_tasks + jobs(可选)
               ->（本阶段）直接进入模拟执行分支
                   -> 产出 mock/draft 资源元数据
                      -> 更新 task/request 状态、error/task lineage
```

### 5.1 幂等与重放

- `request_hash` 变更 = 新建请求。
- 同 `project_id + generation_kind + input_hash + prompt_hash + provider_config_id` + 参数快照可复用/提示相同请求。
- Retry 只允许在任务失败/中断/取消后创建新 task。

### 5.2 失败/恢复

- 失败码不可泄露原始异常对象。
- job/ task status 更新必须遵循统一错误码。
- 重启恢复时，running/cancelling 的 task 转 interrupted。

## 6. 阶段划分与文件所有权（不定义顺序）

### 6.1 Core / 数据库（ZhangSan）

- `services/core/src/aivs_core/database.py`
  - 增加 `V11_SQL` + `v11_statements` + migration compatibility 处理。
- `services/core/src/aivs_core/media_generation.py`（新增）
  - 生成请求、任务领域服务。
- `services/core/src/aivs_core/jobs.py`
  - 新增 `job.kind = media_generation`（若不改旧枚举，先用 input 标记；不建议与现有行为冲突）。
- `services/core/src/aivs_core/app.py`
  - 注册 routes，返回 error_code 和分页。

### 6.2 Contracts / IPC（YeJing）

- `packages/contracts/src/index.ts`
  - 新增 `GenerationKind/Status/Id/DTO/错误码`。
- `packages/contracts/src/index.test.ts`
  - 新增 guard/parse/cross-safety 测试。
- `apps/desktop/src/lib/core-client.ts`
  - 新增 Generation API 方法与 parse/normalize。
- `apps/desktop/electron/main/stage4-ipc.ts`（新增）
  - 以独立通道处理 generation request 相关交互。

### 6.3 Desktop 产品交互（YeJing）

- 现有页面新增 `MediaGenerationPanel`：
  - request 创建（仅配置参数，不存 prompt 明文）
  - 请求列表与任务列表
  - retry/cancel 操作
- Renderer 不显示路径、payload、raw_response、api_key。

### 6.4 LiuKeAi 验收（独立）

- 对照 `STAGE4_CONTRACT_FREEZE.md` 的隐私边界和 `docs/ARCHITECTURE.md` 里 Stage 4 语义
  做独立可验收清单。

## 7. 原型验证章节（必须在本阶段执行）

### 7.1 目标

- 验证“无 Provider 调用前提”下的模型结构是否稳定。
- 验证 hash + id + lineage 是否支持重试与恢复。
- 验证 contracts 在旧客户端兼容时不会破坏。

### 7.2 测试矩阵

1. **纯 API 验证**
   - valid prepare/create/list/retry/cancel
   - invalid: 无效 hash、非法输入 refs、重复 request、非法 retry
2. **数据库验证**
   - v10 -> v11 升级
   - 未知旧库拒绝
   - 表级约束与索引存在性
3. **安全验证**
   - DTO 不含路径/路径片段/完整 transcript/prompt/plaintext/secret
   - 任务日志不含原始异常
4. **任务恢复验证**
   - running -> interrupted -> retry lineage
5. **性能验证（模拟）**
   - 100次 prepare/create/retry 的 p50/p95 <= 目标阈值
   - 可接受：p95 <= 300ms（仅仿真），无数据库死锁

### 7.3 质量输出

- 原型验收报告（含失败样例 + 重试轨迹 + hash 校验）
- 结论：
  - 可否进入下一阶段（Stage4B）
  - 是否开放真实 Provider 真实调用

## 8. 风险与退路

### 8.1 已识别风险

1. **数据库兼容性风险**：新增外键/列与旧 DB 的兼容；
   - 退路：严格按 v10 compatibility 模式过滤新增列。
2. **字段脱敏误差风险**：参数摘要与 hash 输入一致性变化。
   - 退路：固定 canonical JSON + key 归一化策略。
3. **界面隐私泄露风险**：Renderer 显示未剔除 prompt 原文。
   - 退路：`rendererSafe` 白名单 + 单元 + E2E 断言。
4. **范围漂移风险**：Stage 4A 把真实视频生成提前合并。
   - 退路：先固定 `image + tts`，video 标记 `UNSUPPORTED`

### 8.2 不推荐替代（防止过度扩展）

- 不直接将 `media_generation` 并入现有 `candidate_generations`。
- 不引入 `asset_draft` 第二套状态机（可选保留），避免和现有 asset 生命周期重叠。

## 9. 迁移与兼容计划

1. 实施顺序（建议）
   1) Contracts 冻结 → 2) Database v11 → 3) Core service → 4) API 路由 → 5) Desktop/IPC → 6) 验收。
2. 兼容要点
   - 不改 v1~v10 SQL/checksum。
   - 未启用生成能力时，返回 `GENERATION_KIND_UNSUPPORTED`，不影响既有流程。
3. 回滚策略
   - v11 可通过版本回退到上一个数据库文件；不回退数据库时需停止新 feature 创建。

## 10. 阶段门禁

### Gate 4A-1（文档冻结）

- `docs/STAGE4_CONTRACT_FREEZE.md` 与 `docs/STAGE4_DETAILED_DESIGN.md` 均包含
  “范围、边界、风险、SQLite v11、隐私红线、验证清单”。
- 与 `ARCHITECTURE.md` 的 Stage4 语义映射清晰。

### Gate 4A-2（原型实施）

- v10→v11 升级通过。
- 生成请求 API 与 task 生命周期有可执行测试。
- 任何数据库/日志/DTO/Renderer 输出不含受控红线字段。

### Gate 4A-3（验收）

- Provider 调用计数保持 0。
- 输出包含清晰未验证项：`video`/真实 Provider。
- 未完成真实验证的部分须标注 `UNVERIFIED`。

## 11. 与用户确认的待确认项（可继续按默认值）

- 暂定范围：`image + tts`。
- `video` 标记：后续阶段再纳入。
- 结果入库：`output` 仅保留 `output_hash + output_asset_id` 或模拟 token，不入成品素材库。
- 受控运行模式：默认 `simulation_only=true`。

---

**说明**：以上为 Stage4A 文档冻结稿。当前仅产出文档，不提交运行时代码。
