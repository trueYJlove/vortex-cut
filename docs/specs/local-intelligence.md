# 本地智能感知与质量评测规格

> 本文整合本地 CV 采样策略与预算控制（ADR-0005）、本地语义检索（W3.1）、多信号融合粗剪（W4.2）与质量评测体系（W0.4）。
> 当前交付边界、算法版本与待解决事项见 [`../STATUS.md`](../STATUS.md) 与 [`../BACKLOG.md`](../BACKLOG.md)。

---

## 1. CV 信号采样策略与预算控制（ADR-0005）

### 1.1 三阶段自适应采样架构

`select` 滤镜位于全量解码之后，长 GOP 高分素材顺序解码代价高，而定点 seek 补洞因帧间依赖更慢（已由 [`ADR-0005`](../adr/0005-cv-sampling-density-policy.md) D4 实测否决，**禁止重新引入**）：

1. **快路径 + 稀疏检测**：默认 `-skip_frame nokey` 纯 I 帧采样；计算相邻采样点最大间隔 `achieved_max_gap_us`，未超阈值 `CV_SAMPLE_GAP_FALLBACK_US`（4s）即完成。
2. **成本预算 + 硬 Deadline（阶段 1）**：`budget_s = clamp(duration_min × PER_MINUTE_BUDGET_S, FLOOR_S=15, CAP_S=300)`（默认 10s/分钟）。用静态吞吐估算（`h264: 894e6 px/s`，`hevc/未知: 331e6 px/s`）预测回退成本，独立 `fallback_cancel` 事件隔离回退中止与用户取消。
3. **预算内连续密度与旋钮（阶段 2）**：`select_sampling_plan` 在 `iframe_only` / `budget_capped_full` / `full` 间决策；`budget_capped_full` 超时保留已采密集前缀并与尾部 I 帧按时间轴合并。

### 1.2 密度诚实性与回归守卫

- **`cv_analyses` 密度字段（迁移 v23）**：`density_status`（`full` | `sparse`）、`gap_threshold_us`、`achieved_max_gap_us`、`wall_clock_ms`。缝合样本集不跨缝合点重算 `motion_energy`，并按合并后集合诚实计算 `achieved_max_gap_us`。
- **可选请求旋钮（`CvAnalysisRequest`，`extra="forbid"`）**：`target_gap_us`（默认 4s，钳制 `[100_000, 60_000_000]`）、`budget_per_minute_s`（默认 10，钳制 `[1.0, 120.0]`）。
- **召回消费与同步**：`_cv_scenes` 对 `sparse` 降权不排除；修改采样常量或 `CV_ALGORITHM_VERSION` 必须同步 [`../STATUS.md`](../STATUS.md) §1。
- **回归守卫**：短 GOP 双路径 sha256 一致；默认预算 4K60 长 GOP ≤ 10s/分且诚实标 `sparse`；取消立即终止 `ffmpeg` 无孤儿进程；全链路零 egress。

---

## 2. 本地语义检索（W3.1）

### 2.1 模型与存储契约（迁移 v39）

- **检索路径**：支持英文 CLIP ViT-B/32（`onnx-clip` provider，受信清单 `resources/model-manifests/clip-vit-base-patch32.json`）及中文优先模型 Chinese CLIP ViT-B/16（`chinese-clip-vit-base-patch16.json`，分发与许可边界见 [`../BACKLOG.md`](../BACKLOG.md#p161)）。
- **表 `asset_semantic_index`**：`ON DELETE CASCADE` 随素材级联清理（避免 P102 外键阻塞）；部分唯一索引 `(asset_id, source_fingerprint, algorithm_version)` 支持素材变更写新行、读时判 `stale`；存 `embeddings_blob`（`float32`，经实测否决 `float16` 排序抖动），`INDEX_ALGORITHM_VERSION` 独立于 `CV_ALGORITHM_VERSION`。

### 2.2 抽样、检索语义与隐私边界

- **抽样与聚合**：复用关键帧采样思路，同场景内多帧 embedding 取归一化均值后 L2 归一；帧数上限与间隔写入算法版本常量。
- **检索语义**：文本塔编码查询 → 项目内（严格项目隔离，禁止跨项目透传）余弦相似度降序返回 `[{ asset_id, score, matched_frame_us }]`，`MAX_SEARCH_K = 100`（默认 20）。
- **性能门与隐私**：检索 p95 ≤ 500ms、索引 ≤ 30s/源分钟（1080p）/ ≤ 60s（4K60）、存储 ≤ 2 MiB/素材；推理与检索全链路零 egress。
- **质量边界（R1）**：`eval_set/` 早期合成素材为纯色块，不具备自然语言画面语义；在建立真实语义评测集前，不以合成色块声明 C2 命中率达标。

---

## 3. 多信号融合粗剪（W4.2）

### 3.1 语义裁决与纯函数融合

- **DEC-9 裁决（方案 A）**：保留旧值 `auto` / `transcript` / `cv` **行为逐字节不变**，新增 `candidate_source = 'fused'` 触发多源融合（转录 + CV + 节拍）。说话人源因 `quality_status` 恒 `unvalidated` 已显式排除。
- **候选集内归一化**：
  - 转录：关键词命中率 + `confidence`；
  - CV：人脸/运动能量/清晰度各自在**本次候选集内** min-max 归一（禁止跨项目全局归一）；
  - 节拍：切点落拍二元分（按最近 beat 距离阈值）。
- **缺失源与权重**：任一源缺失时权重重新归一（不按 0 计），`stats` 记录缺失源；三源全缺报 `PLANNING_NO_SEGMENTS`。融合权重表显式版本化（`FUSION_WEIGHTS_VERSION`），初始等权起步并标明「未调优」，不声称比单源更优（参见 [`../BACKLOG.md`](../BACKLOG.md#p147)）。

---

## 4. 质量评测体系（W0.4）

### 4.1 评测集与诚实基线

- **五档槽位**：`spoken_single` / `spoken_multi` / `life_no_voice` / `music` / `long_gop`；`eval_set/manifest.json` 与 `eval_set/schema/annotation.schema.json`（含 `schema_version`）入仓，媒体文件支持仓外 pointer + `source_fingerprint`（内容摘要）。
- **CLI 工具（`tools/quality_eval/`）**：`run_quality_eval.py` 输出自描述基线快照至 `evidence/quality_eval/<UTC时间戳>.json`；`compare_baselines.py` 对比回退即非零退出。
- **诚实基线语义**：分档样本不足标记 `insufficient`、任务未标注标记 `unavailable`（带机器可读 `reason`），禁止输出假数值分；`sparse` 与 `full` 素材分组统计，不混池平均。

### 4.2 指标定义与回归纪律

| 指标 | 公式要点 | 固定参数 |
|---|---|---|
| 切点 Precision / Recall | 匹配预测 / 预测总数；匹配标注 / 标注总数 | 匹配窗 `tol_us = 200_000`，一对一贪心匹配 |
| nDCG@k | DCG / IDCG，线性折扣 | `k = 10`，分级相关度 `0–3` |

- **回归触发**：改动信号算法、融合权重、规划器规则或提示词需本地跑 harness 与 `compare_baselines`；全链路零 egress，仅本地运行，不入生产运行时包。
