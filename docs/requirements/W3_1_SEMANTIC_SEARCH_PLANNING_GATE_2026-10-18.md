# W3.1 素材池语义检索——Planning Gate

> 起草：2026-10-18。承接 `AI_CAPABILITY_MASTER_PLAN_2026-09-24.md` §4 U7 / §6 W3.1 / §14 DEC-5。
> **状态口径一律引用 [`../STATUS.md`](../STATUS.md)**（AGENTS.md Rule 1/5）；本文件只声明**本门冻结什么**。
> 前置裁决：ADR-0009（W2.2 收口）——W3.1 明确**不受其阻塞**（ADR-0009 §7 原文点名）。

---

## 0. 现状走读结论（代码级，2026-10-18）

**本门起草前逐项实测，不引用任何文档的现状陈述。**

| 项 | 实测结果 | 取证方式 |
|---|---|---|
| 语义检索代码 | **零** —— `services/` + `packages/` + `apps/` 对 `semantic_search`/`image_index`/`clip_embed` **0 命中** | grep 三处根目录 |
| `JobKind` | **无**检索/embedding 类目（现有 18 种，最接近者 `cv_analysis`） | `packages/contracts/src/index.ts:65` |
| 契约 search 面 | **零** —— `Search`/`search` 在 `packages/contracts/src/index.ts` **0 命中** | grep |
| 迁移版本 | 当前 **v38**；v39 **未被占用** | `aivs_core.database.MIGRATIONS` |
| 模型注册表 | `MODEL_PROVIDERS = ("faster-whisper","onnx-cv","onnx-speaker")`，**无 CLIP 类** | `model_registry.py:34` |
| 受信清单范式 | `resources/model-manifests/*.json`，逐文件 `sha256` + `trusted_source_id` + `license` | `campplus-speaker-embedding.json` |
| job 范式 | `KIND_POLICIES` → `_run` → runner；`cv_analysis`/`beat_analysis` 均为 `("light",), 2` 档 | `job_scheduler.py:61` |
| 迁移范式 | 单表 + `algorithm_version` 行化 + **指纹入部分唯一索引** + 读时 stale + `ON DELETE CASCADE` | `database_v37.py` 头注释（P102 教训） |
| 评测指标 | `MEASURABLE_TASKS = ("cut_pr","recall_ndcg","beat_hit_rate","lj_offset_accuracy")` —— **无 image/text retrieval 类** | `tools/quality_eval/metrics.py:35` |

### 0.1 网络可达性（本轮实测，决定了模型来源）

| 目标 | 结果 |
|---|---|
| `hf-mirror.com` | **200 可达** |
| `huggingface.co` 直连 | **超时** |
| `huggingface.co` 经 `socks5h://127.0.0.1:10808` | **SSL_ERROR_SYSCALL** |
| `github.com` | 200 可达 |

### 0.2 模型可用性（本轮实测）

| 候选 | ONNX 可取 | 体积 |
|---|---|---|
| `Xenova/clip-vit-base-patch32` `vision_model.onnx` | ✅ 206 | **351,685,709 B（≈335 MiB）** |
| 同上 `text_model.onnx` | ✅ 206 | 待测（同量级） |
| 同上 `tokenizer.json` | ✅ 200 | 1,433,600 B |
| `OFA-Sys/chinese-clip-vit-base-patch16` | ❌ **404，无现成 ONNX** | — |

---

## 1. 范围

### 1.1 本门批准的范围（Slice 1 = ① + ②）

**① 索引管线**：CLIP 双塔（vision/text）接入 + 关键帧抽样 + 场景级聚合 + `v39` 存储 + job 分派 + 素材指纹联动。
**② 检索端点**：自然语言 → 文本塔编码 → 余弦检索 → 结果 DTO。

### 1.2 明确**不**在本门范围

- **③ Desktop 检索 UI** —— 下一切片，避免界面先于能力被冻结（本轮用户已裁决）；
- **Layer 2 云端关键帧理解（W3.3）** —— DEC-5 明定 (a) 先行；
- 蒙太奇/匹配剪辑（W3.4）；
- 中文语义检索 —— 见 §4 R2，作为**已声明限制**，不在本切片解决。

---

## 2. 设计要点（冻结项）

### 2.1 模型选型（用户 2026-10-18 裁决）

- **选用 `Xenova/clip-vit-base-patch32`**（CLIP ViT-B/32，英文预训练），vision + text 双塔分离 ONNX；
- **provider 新增 `onnx-clip`**（第 4 个 provider，须同时登记目录表与运行时模块表——三表一处维护，`model_registry.py:34-45`）；
- 新增受信清单 `resources/model-manifests/clip-vit-base-patch32.json`：**逐文件 sha256 + trusted_source_id + license**，下载域**必须为 `hf-mirror.com`**（HF 直连实测不通）；
- **算法版本 `INDEX_ALGORITHM_VERSION = 1`**，与 `CV_ALGORITHM_VERSION` 独立。

### 2.2 数据模型（v39，照抄 v37 范式）

- 单表 `asset_semantic_index`，**`ON DELETE CASCADE`**（P102 教训：派生分析数据必须随素材自动清）；
- 列含 `asset_id`、`source_fingerprint`、`algorithm_version`、`status`、`frames_json`、`embeddings_blob`、`model_revision`、时间戳；
- **部分唯一索引 `(asset_id, source_fingerprint, algorithm_version)`** —— 素材变更 ⇒ 新指纹 ⇒ 新行可写，旧行保留；**读时 stale**；
- **存 embedding BLOB 而不是只存向量化结果之索引**：换检索策略/换 K 时只重排不重跑 ONNX（沿用 v37 已证实的 8–15× 收益理由）。

### 2.3 抽样与聚合（冻结）

- 复用既有 CV 关键帧采样思路（`select=关键帧(带时间下限兜底)`）——**不新建解码路径**；
- **场景级聚合**：同场景内多帧 embedding 取**归一化均值**后重新 L2 归一；
- 帧数上限与采样间隔作为**显式常量**并写入 `INDEX_ALGORITHM_VERSION` 语义。

### 2.4 检索语义（冻结）

- 文本塔编码查询 → 与所有 asset 的（聚合后）向量做**余弦相似度**；
- 返回 `[{asset_id, score, matched_frame_us}]`，按 score 降序，**k 由调用方指定且有硬上限**；
- 严格限制：检索**不跨项目**（项目隔离，照抄既有项目代次纪律）。

### 2.5 隐私（ADR-0003 D4 硬承诺，不可协商）

- **全链路零 egress**：模型经受信清单下载（一次性、可审）、推理纯本地、检索纯本地；
- 须有一条**机器可断言的零 egress 测试**（对照既有 AI-2 做法）。

---

## 3. 验收（可断言，逐项给证据）

> 按 AGENTS.md Rule 3：本门作为**一行工作包**登记到 STATUS §4；风险对策 R1–R4 **逐条独立登记**。

| # | 验收项 | 判据 | 证据形式 |
|---|---|---|---|
| A1 | 索引管线可用 | 真实视频 → `ready` + 向量非空 + 帧数符合上限 | pytest（真实 ffmpeg） |
| A2 | 素材变更联动 | 改指纹 ⇒ 旧行 stale、重算写新行（**不撞唯一键**） | pytest（照抄 `test_rerun_after_fingerprint_change_writes_new_row`） |
| A3 | 删除联动 | `DELETE FROM assets` 不被 FK 拒绝、索引行随之清除 | pytest（**P102 失败模式的反向锁**） |
| A4 | 检索端到端 | 文本查询 → 命中预期素材，且**跨项目不透传** | pytest + API 集成 |
| A5 | 项目隔离 | A 项目查询不返回 B 项目素材 | pytest（负向对照：去掉隔离即红） |
| A6 | 零 egress | 全链路无外发 | pytest（网络层断言） |
| A7 | 性能门 | 见 §5 D2（**已裁决**）：检索 p95 ≤500 ms / 索引 ≤30 s·min⁻¹（1080p）、≤60（4K60）/ 存储 ≤2 MiB·素材⁻¹ | `W3_1_D2_PERF_MEASUREMENT_2026-10-18.md` |
| A8 | 检索命中率（C2） | **本门不设数字** —— 见 §4 R1，**须先有语义语料** | 待 R1 处置 |

### 3.1 负向对照要求（本仓纪律）

每个验收项须配**能证伪的负向对照**（还原修复即红），否则判为恒真测试。
W2.2 期间共出现 **3 次恒真测试**（P130/P133/P134），本门将其列为**显式禁忌**。

---

## 4. 风险与对策（逐条登记到 STATUS §4）

### R1｜**评测语料无语义** —— 本门最大的风险，且**已确证**

`eval_set/` 的 18 项标注所对媒体**全部由 `tools/quality_eval/make_eval_materials.py` 合成**，
视频内容为 `color=c=<纯色>` 纯色块（红/绿/蓝/橙/青/黄/洋红/白/黑），音频为 click 音。

⇒ **C2「自然语言检索画面语义」在该语料上不可验证**：对纯色块问"一个人在说话"，
任何模型都只能给噪声分；**若据此宣布命中率达标或不达标，都是错误结论**。

**对策**：
1. 本切片的 A8 **显式留空**，不得以合成素材顶替（**与 W2.1 P84「禁止合成素材顶替」同一纪律**）；
2. 须新建**语义评测集**（真实画面 + 自然语言 query + 相关性标注），或先取得真实素材；
3. 在 A8 有据之前，**只能声称"检索链路可用"，不得声称"检索命中率达标（C2）"**。

### R2｜中文查询命中率下降

CLIP ViT-B/32 为英文预训练；产品主场景为中文用户。⇒ 中文 query 的检索质量**很可能显著低于英文**。
**对策**：作为**已知限制**登记；本切片所有命中率断言**只对英文 query 成立**；
中文适配须另立门（候选：换多语模型 / 翻译层），**不得**在本切片内临时打补丁。

### R3｜模型体积与首用成本

vision **335 MiB** + text 同量级 ⇒ 合计数百 MB，须下载（受信清单 + sha256 + 进度）。
**对策**：按需下载、不随包分发（沿用 faster-whisper/CAM++ 既有模式）；下载失败须**显式降级**（检索不可用 ≠ 应用崩溃），且 UI 可感知。

### R4｜索引成本与存储放大

长素材关键帧多、embedding 为 `float32 × 512 维 = 2 KiB/帧`，万帧即 ~20 MiB/素材。
**对策**：帧数上限 + `float16` 存储评估 + 性能门（§5 D2）；**须实测**，不得估算后当结论
（沿用 W2.2 P105 的做法：实测后才核销）。

---

## 5. 待裁决（实施前需用户/架构师确认）

| # | 事项 | 现状 |
|---|---|---|
| **D1** | 首个切片范围 = ①+② | ✅ **2026-10-18 用户已裁决**（UI 后置） |
| **D2** | **检索性能门数值**（索引 p95 s/分钟源；检索延迟 p95 ms） | ✅ **2026-10-18 已裁决（用户批准）** —— 门限取自实测基线（`W3_1_D2_PERF_MEASUREMENT_2026-10-18.md`）：**检索 p95 ≤ 500 ms**（实测 ≈70 ms，7×）；**索引 ≤30 s/源分钟（1080p）/ ≤60（4K60）**（实测 8.53–9.71 / 17.42）；**存储 ≤2 MiB/素材**（实测 ≤1 MiB）。**依据实测给数、非拍门槛**；余量按最差合法环境留 |
| **D3** | 语义评测集的建法与来源（真实素材从何而来） | ⏳ **待裁决** —— R1 的解除条件 |
| **D4** | 存储精度 `float32` vs `float16` | ✅ **2026-10-18 实测后裁定：维持 `float32`（不采用 float16）** —— 量化误差 max 2.44e-04、mean 4.52e-06，**存储可省 50%**，但**排序不稳定**：随机色块 embedding 上「排序完全一致 **11/20**、集合一致 16/20」；用**真实视频帧**（33 帧、1080p/4K）复核为「集合一致 **20/20**、顺序一致 **17/20**」⇒ 仍有 **3/20 次顺序翻转**。检索只消费顺序 ⇒ **收益（省一半盘）不足以交换不可预测的排名抖动**，且当前实测存储 ≤1 MiB/素材远低于 2 MiB 门限，**没有省的计划压力**。若将来素材池规模上到千级再评估 |
| **D5** | `k_max`（单次检索返回上限） | ✅ **2026-10-18 裁定：维持 `MAX_SEARCH_K = 100`、默认 20** —— 依据：检索 p95 ≈70 ms（1000 候选）⇒ 100 条返回的排序成本可忽略（4.34 ms 实测）；上限存在的意义是**防止把整个素材池倒给 Renderer**（已由单测 `test_k_is_clamped_to_hard_cap` 钉住），不是性能约束 |

---

## 6. 门禁状态

- **Planning Gate：已批准**（用户 2026-10-18「同意」）；
- **D1–D5 全部裁决**，无阻塞项；
- **本门已收口（2026-10-19）**，实施记录见
  [`../archive/W3_1_SEMANTIC_SEARCH_IMPLEMENTATION_2026-10-19.md`](../archive/W3_1_SEMANTIC_SEARCH_IMPLEMENTATION_2026-10-19.md)
  ——**含门 §3 A1–A8 的验收交叉核对表**（AGENTS.md Rule 3 关门要求）；
- **A1–A7 全部通过**；**A8 见实施记录 §4**：语义有效性已由 v2（品类词，S5 = 1.000）
  与 v3（句子级，T5 打乱 0/58）两轮真实素材评测证明，但 **C2 数值门限在总纲中从未定义**，
  故**不标「达标」**——这不是缺证据，是缺尺子；
- **R1（P142）已解除**；**R2（P143，中文）仍开放**；R3（P144）/ R4（P145）由 D2 实测核销；
- **后续切片（未做，已登记）**：视频抽帧链路语义评测、口语化查询评测、中文适配。
