# 云端关键帧理解规格与模块设计（Layer 2）

> 本文整合 W3.3 云端关键帧理解的需求规格、模块设计与已交付切片概要（D1–D9 已冻结）；当前交付边界与盲评现状见 [`../STATUS.md`](../STATUS.md) §3 与 [`../BACKLOG.md`](../BACKLOG.md#p165)。
> 关联裁决：[`ADR-0003`](../adr/0003-ai-direction-and-privacy-hard-commitment.md) D4（云端永不默认、永不静默）。

---

## 1. 需求边界与核心裁决（D1–D9 已冻结）

### 1.1 范围边界

- **包含**：帧级 egress preview（逐帧元数据 + 缩略图 + 逐张移除 + 审计保真）、vision 适配器阶梯与能力探测（fail-closed）、受控词表 + 自由备注双列打标、`asset_frame_tags` 存储（迁移 v40/v41）、`SemanticSearchPanel` 按标签过滤与展示、离线盲评包工具、未开启 Layer 2 时默认路径零变化。
- **不包含**：视频原片外传、默认开启/静默上云、本地 VLM（Layer 1）、帧标签接入粗剪召回排序（见 `local-intelligence.md` §3）、质量断言（见 §2 A9）。

### 1.2 核心裁决 D1–D9

| # | 事项 | 冻结裁决 | 要点 |
|---|---|---|---|
| **D1** | 消费入口 | 内置最小可见面 | `SemanticSearchPanel` 按标签过滤/展示命中帧标签 |
| **D2** | Provider 适配 | 完整探测 + 打标端到端 | `openai_chat_completions_image_url_v1` |
| **D3** | 质量口径 | 结构正确性 + 小样本盲评 | 显式声明「质量未证」，不设定无真值指标门限 |
| **D4** | 逐张审计形态 | 逐张可见 + 可单张移除 | 同意后整批外发，由 A12 锁定审计保真 |
| **D5** | 标签体系 | 受控词表（12 类）+ `notes` 双列 | 词表外标签改道 `notes`，`vocabulary_version` 入行 |
| **D6** | 盲评归属 | 离线盲评包工具已交付 | 评分口径先预登记后看数 |
| **D7** | 抽帧策略 | 场景切点先选 + 间隔兜底，封顶 24 | 复用 `cv_analyses.scene_cut`；无分析走 `interval_only` |
| **D8** | 帧分辨率 | 长边 768px，JPEG q85 | 显著减体积，但**明示「这不是匿名化」** |
| **D9** | 编码路径 | ffmpeg 子进程（`-c:v mjpeg`） | 不实现 PyAV 编码路径 |

---

## 2. 验收标准与负向对照（A1–A14）

| # | 验收项 | 判据 | 负向对照 |
|---|---|---|---|
| **A1** | 逐张可见 + 可移除 | preview 返回逐帧清单；移除第 k 帧后载荷不含该帧且 `excluded_frames` 留记录 | 移除只改 UI ⇒ 红 |
| **A2** | 未同意不发（I-1） | 无 consent / 未 `claim` 时零网络调用 | 去 `claim` 前置 ⇒ 红 |
| **A3** | payload 可复算（I-2） | 同帧集合两次 prepare 得同一 `payload_sha256` | 哈希不含帧字节 ⇒ 红 |
| **A4** | 能力探测 fail-closed | 不支持图片内容块落库 `unsupported`；create 被拒且零外传 | 探测失败放行 ⇒ 红 |
| **A5** | 抽帧策略 | `k≤24` 覆盖全部切点且间隔补齐；`k>24` 取前 24 切点；无分析 `interval_only` | 忽略封顶或静默降级 ⇒ 红 |
| **A6** | 帧规格与成本可见 | 实测长边 768、JPEG q85；呈现**实测** `jpeg_bytes` | 报推算值 ⇒ 红 |
| **A7** | 词表 + 备注 | 词表外改道 `notes`、计 `vocabulary_violations`、`>0` 落 `VISION_VOCABULARY_VIOLATION` | 丢弃违规标签 ⇒ 红 |
| **A8** | 默认路径零变化 | 未开启 Layer 2 时既有路径逐字节不变 | 改动默认分派 ⇒ 红 |
| **A9** | 质量口径诚实（**M4 修订**） | ① 盲评包的判据与统计口径**先于看数预登记入库**（照 `evidence/2026-10-20-w31-zh-fp32-eval/PRE_REGISTRATION.md` 范式）；② 对实施记录与门文档做**正则负向检查**：出现"更好/优于/优于单源/质量提升"等优越性表述即失败（白名单语境豁免，照 STATUS.md 一致性测试的修正语境豁免做法） | 预登记缺失 / 优越性表述存在 ⇒ 红 |
| **A10** | 打标端到端 | 真实素材 + 真实 Provider 打标落库且检索面板按标签过滤命中 | 面板读硬编码 ⇒ 红 |
| **A11** | 素材生命周期 | 删素材 CASCADE 清 `asset_frame_tags`；指纹变更判 stale 且与 `asset_semantic_index` 同源 | 用 NO ACTION 阻塞删除 ⇒ 红 |
| **A12** | 审计保真 | preview 每帧 `frame_sha256` / `jpeg_bytes` / 宽高逐帧等于实际外传字节 | 缩略图与外传混淆 ⇒ 红 |
| **A13** | 打包后编码可用 | 打包产物（PyInstaller）内实跑 ffmpeg mjpeg 编码成功 | 仅开发环境通过 ⇒ 红 |
| **A14** | 载荷到期清理 | `expires_at` 到期后独立缓存目录字节为 0，元数据与哈希仍保留 | 只置标记或依赖 LRU ⇒ 红 |

**A9 的边界如实**：本门**不承诺**打标质量优于任何基线，也无基线可言。机器只证结构；完整生产级质量结论在充足盲评完成前**不存在**。

---

## 3. 模块设计与数据/接口契约

### 3.1 四条外传不变量与审计分离

- **I-1**：任何外传网络调用（含 `vision-capability` 探测）必须先通过 `prepare → create → claim_for_runner` 原子消费 consent。
- **I-2 / I-3**：`exclude_frames` 写入不可变 `excluded_frames_json` 并重算 `payload_sha256`；`create` 依据排除列表生成最终载荷。
- **I-4（审计分离）**：192px 展示缩略图（`thumbnail_*`）与 768px 外传载荷（`payload_*`）严格分离并各自记录字节数与 SHA-256。

### 3.2 数据模型（迁移 v40/v41）与独立缓存目录

- **`keyframe_egress_previews`**：不设 `ON DELETE CASCADE` 以免删除素材丢失审计记录，删除素材时调用 `detach_asset` 将 `asset_id` 置空并写 `detached_at`；帧字节落独立目录 `data/keyframe-cache/<preview_id>/`（不复用 `derived_media_cache`，避免 LRU 干扰 A14），由 `purge_expired`（及 `run_tagging_job` 结束清理）删除字节并置 `payloads_purged_at`。
- **`asset_frame_tags`**：`asset_id ON DELETE CASCADE` 随素材删除；部分唯一索引 `(asset_id, source_fingerprint, algorithm_version, vocabulary_version, frame_index) WHERE status='ready'`；`source_fingerprint` 与 `asset_semantic_index` 共用同一函数。
- **`provider_invocations`**：新增 `keyframe_generation_id` 用于断言调用次数。

### 3.3 核心模块、契约与路由

- **Core**：`media/keyframe_encode.py`、`media/keyframe_sampling.py`（严格区分 `None` 未分析 → `interval_only`、`[]` 已分析无切点 → `scene_cut`、`[t...]`）、`keyframe_egress.py`、`vision_adapter.py`、`keyframe_tagging.py`、`frame_tags.py`；`job_scheduler.py` 登记 `JobPolicy("keyframe_tagging", ("light",), 2)`；受控词表 `resources/keyframe-vocab/v1.json`。
- **失败码**：`VISION_PROVIDER_UNSUPPORTED`、`VISION_FRAMES_UNMAPPED`、`KEYFRAME_PREVIEW_EXPIRED`、`KEYFRAME_EGRESS_CONSENT_REQUIRED`、`VISION_VOCABULARY_VIOLATION`。
- **Contracts & IPC**：`JobKind` 与 `JOB_KINDS` 同步增 `"keyframe_tagging"`；Core 路由 `/keyframe-preview`（prepare/exclude/create）、`/frame-tags`、`/providers/{id}/vision-capability`；Desktop IPC `keyframe:preview|exclude|create|tags|filter` 与 `provider:vision-capability`；UI 集成于 `SemanticSearchPanel.tsx`。

---

## 4. 已交付切片概要（S1a–S5a）

| 切片 | 模块与迁移 | 关键交付与验证 |
|---|---|---|
| **S1a / S1b** | `keyframe_encode.py`、`keyframe_sampling.py` | 768px 载荷 + 192px 缩略图双字节；切点三态抽样与 24 帧封顶；`test_keyframe_encode.py` / `test_keyframe_sampling.py` |
| **S2 / S2b** | `database_v40.py`、`keyframe_egress.py`、`keyframe_orchestration.py`、`contracts` | 4 张表 + 不可变触发器；三段式生命周期与 purge/detach；契约同步锁 |
| **S3 / S4 / S5a** | `vision_adapter.py`、`keyframe_tagging.py`、`frame_tags.py`、`SemanticSearchPanel.tsx` | 图片内容块 + strict `json_schema` 探测、fail-closed create 门禁、v1 12 词表改道 `notes`、面板标签过滤 |
