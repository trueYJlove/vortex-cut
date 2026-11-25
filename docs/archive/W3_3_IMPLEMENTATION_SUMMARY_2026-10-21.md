# W3.3 关键帧理解实施摘要（S1a–S5a，2026-10-21）

> **只读历史归档**：本文件汇总原 `W3_3_S1A`、`S1B`、`S2`、`S2B`、`S3`、`S4`、`S5A` 七份切片实施记录的核心交付与边界结论。当前项目状态与能力边界统一见 [`../STATUS.md`](../STATUS.md)。

## 各切片核心交付汇总

| 切片 | 模块与迁移 | 核心实现与关键裁决 | 单元测试（含负向对照） |
|---|---|---|---|
| **S1a** 帧编码 | `media/keyframe_encode.py` | 单帧输出 768px 长边 JPEG 载荷（17.6–21.7 KB，24 帧约 0.56 MiB）与 192px 缩略图两套独立字节；JPEG SOF 自解析尺寸；零 egress | `test_keyframe_encode.py`（16 项，3 组负向对照） |
| **S1b** 抽样决策 | `media/keyframe_sampling.py` | 切点优先、间隔补齐、封顶 24 帧；严格区分 `None`（未分析 → `interval_only`）/ `[]`（已分析无切点 → `scene_cut`）/ `[t...]`（防静默降级） | `test_keyframe_sampling.py`（29 项，5 组负向对照） |
| **S2** 外传服务与持久化 | `database_v40.py`、`keyframe_egress.py` | 迁移 v40（补齐 `keyframe_egress_previews` / `keyframe_egress_consents` / `keyframe_generations` / `asset_frame_tags` 4 张表及不可变触发器）；三段式 prepare/exclude/create/claim + purge + detach | `test_keyframe_egress.py`（24 项，5 组负向对照） |
| **S2b** 契约与编排 | `packages/contracts`、`keyframe_orchestration.py`、`app.py`、`stage2b-ipc.ts` | 增量类型与 `JobKind` 三处同步锁、3 个 Core 路由与 3 个 IPC 通道、切点三态贯穿编排层 | `test_keyframe_contracts.py`（6 项）、`test_keyframe_orchestration.py`（13 项，4 组负向对照） |
| **S3** 真实网关探测 | `vision_adapter.py` | 实测图片内容块 + strict `json_schema` 可并用（HTTP 200 合规 JSON），受控 12 词表生效、词表外改道 `notes`；记录 `reasoning_content` 挤占 `max_tokens` 的空输出风险 | 真实网关探测取证 |
| **S4** 打标执行与链路接通 | `keyframe_tagging.py`、`jobs.py`、`job_scheduler.py`、`projects.py`、`app.py` | 同事务原子创建 consent/generation/invocation/job、`KIND_POLICIES` 登记 `keyframe_tagging`、每帧写入 `provider_invocations`、`delete_asset` 同事务调用 `detach_keyframe_previews`、fail-closed vision 门禁 | `test_keyframe_tagging.py`（29 项）、`test_keyframe_detach.py`（4 项） |
| **S5a** 画面标签过滤 | `frame_tags.py`、`SemanticSearchPanel.tsx` | 读侧 `summary`/`by_label` 服务与 2 个 GET 路由；stale 在读侧按 `assets.fingerprint` 判定、按项目精确过滤且排除 stale 行、`vocabulary_violations` 由 `notes` 计数推导 | `test_frame_tags.py`（14 项）、`semantic-frame-tags.test.tsx`（5 项） |
