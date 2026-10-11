# W2.2 说话人分离 —— Design Gate（**立项门**）

> 依据：`W2_2_SPEAKER_LAYER_SPIKE_PLANNING_GATE_2026-10-10.md`——
> **§2.7 精度轴（AMI 英文）、§2.9 阈值策略（+中文跨语料复核）、§2.10 中文语料**为取证；
> §4 R1–R6 为风险；§5 D1–D5 为待裁决。
> **共同冻结项不在本文件复述**（Rule 5）：模型体积/资源/精度数字、VAD 失效证据、策略对比一律以 spike 门为准。
> 本文件只写**实施计划**：裁决、模块划分、签名、数据模型、流水线参数、精度门、切片、测试清单。
> 实施：ZhangSan（Core）+ YeJing（契约/Desktop）；验收：LiuKeAi。

## 0. 本门对 D1–D5 的裁决（**这是"立项"二字的落点**）

| ID | 问题 | 本门裁决 | 依据 |
|---|---|---|---|
| **D1** | 是否立项 | **立项**。资源可行、模型已选、VAD 有现成解、瓶颈已定位 | spike §3 / §2.7–2.10 |
| **D2** | 选型 | **CAM++（192 维）+ 随包 Silero VAD**；ResNet34 仅保留为评测对照，**不进产品路径** | spike §2.7（30.1% vs 54.7%）、§2.10 |
| **D3** | 素材来源 | **公开带标注语料作为验收语料**（AMI test 16 场 + AISHELL-4 test 20 场），**不再阻塞于用户素材** | spike §2.7/§2.10（含下载路径与许可） |
| **D4** | VAD / 分割归属 | **本包内解决**，用随包 Silero；**能量 VAD 在任何路径都不使用** | spike P90/R2 + §2.10（远场漏检 75.9–96.1%） |
| **D5** | 阈值策略 | **本包第一切片**：silhouette 选 τ + 说话人数上限安全界；**并设精度门与升级路径**（§5） | spike §2.9/§2.10（廉价启发式只填回一半差距） |

> **与 spike 门的一处口径修正（必须写在这里，避免下游误读）**：spike §2.10 曾据 3 场中文数据写
> "中文训练⇒中文更好不成立"；4 场后**已更正**为"**embedding 层面成立、被 VAD 掩盖**"
> （oracle VAD 中文 23.2% 优于英文 34.9%，energy VAD 中文 91.0% 远差于英文 52.8%）。
> 本门按**更正后**口径执行：**语言不改变选型，但强化"必须先修 VAD"的次序**。

## 1. 模块划分（冻结）

| 层 | 文件 | 内容 |
|---|---|---|
| Core VAD（新） | `services/core/src/aivs_core/media/speaker_vad.py` | `voiced_mask_10ms`：**包装随包 Silero**（经 `faster_whisper.utils.get_assets_path()` 定位），不自己实现 VAD。**⚠️ 这两个符号都不在 `faster_whisper.__all__`**（复核实测：`get_assets_path` 在 `utils.py`、`get_vad_model` 在 `vad.py`，均**非导出面**）；生产代码此前只用 `WhisperModel` 这一公开面 ⇒ **耦合风险比初版判断更高**，见 §10 O1 |
| Core 算法（纯函数，无 DB/无 ONNX） | `services/core/src/aivs_core/media/speaker.py` | 窗栅格与选取 / 层次聚类 / **τ 选择策略** / 窗标签→轮次 |
| Core 模型（ONNX） | 同上（`SpeakerEmbedder`） | CAM++ 会话加载 + Kaldi 80 维 fbank 前端（**纯 numpy，已与 `kaldi-native-fbank` 逐值等价**，spike §2.5） |
| Core 服务 | 同上（`SpeakerDiarizationService`） | 建作业 / 执行 / 摘要 / **重聚类（复用已存 embedding 换 τ，不重跑推理）** |
| Core 存储 | `database_v37.py` + `database.py:MIGRATIONS` | 一张表 + 部分唯一索引（§3） |
| Core 作业 | `jobs.py` | `kind=speaker_diarization` 分派（与 `beat_analysis` 同型） |
| Core 路由 | `app.py` | `POST …/assets/{id}/diarization`（登记）/ `GET …/diarization`（摘要）/ `POST …/diarization/recluster`（换 τ） |
| 模型注册 | `model_registry.py` | 新增 provider `onnx-speaker`（**三表一处维护**：白名单 / 目录 / 运行时探测模块） |
| 契约 | `packages/contracts/src/index.ts` | `JobKind += speaker_diarization`；`SpeakerTurn` / `SpeakerDiarization` + parse |
| Desktop IPC | `electron/main/`（新 `w22-ipc.ts`）+ preload | `speaker:*` 三件套；**冻结通道白名单同步扩张** |
| Desktop UI | `src/app/`（`SpeakerPanel`） | 触发分析 + 说话人/轮次时间轴 + τ 重聚类入口 |
| 评测工具（**从 spike 提升为常设**） | `tools/quality_eval/diarization.py` + `diarization_eval.py` | DER 评分器（spike 的 `der.py`，9 项自检一并迁移）+ 语料驱动评测；**这是本包的验收仪器** |

## 2. 关键函数签名（冻结）

```python
# --- 纯函数（无 I/O、无 DB、无 ONNX）---
def window_grid(total_s: float, window_s: float, hop_s: float) -> list[tuple[float, float]]: ...
def select_windows(grid, voiced: np.ndarray, *, min_speech_fraction: float) -> list[int]: ...
def build_dendrogram(vectors: np.ndarray) -> Dendrogram: ...          # 余弦 + 平均连接（UPGMA）
def labels_at(dendro: Dendrogram, threshold: float) -> np.ndarray: ...
def choose_threshold(dendro, vectors, *, k_max: int) -> tuple[float, str]:
    # (τ, 策略名)；策略名入摘要，便于事后归因（"这条 τ 是谁选的"）
def windows_to_turns(windows, labels, total_s, *, min_turn_s: float) -> list[dict]:
    # -> [{"start_us": int, "end_us": int, "speaker": int}]

# --- 模型 ---
class SpeakerEmbedder:
    def __init__(self, model_path: str | Path, *, num_threads: int = 1) -> None: ...
    @property
    def dim(self) -> int: ...                       # 192
    def embed(self, samples: np.ndarray) -> np.ndarray: ...   # L2 归一化后的 (dim,)

# --- 服务 ---
class SpeakerDiarizationService:
    def create_job(self, project_id: str, asset_id: str) -> str | None      # None = 幂等短路
    async def run_job(self, row, cancel_event, progress=None, stage=None) -> dict
    def summary(self, project_id: str, asset_id: str) -> dict
        # 行选择 + stale 读时计算。**列投影约束（复核 F6）**：
        # 摘要**不得** SELECT *——`embeddings_blob` 单行可达 1.3 MB，整行读会把它拉进内存。
        # 摘要只取标量列；BLOB 仅由 `recluster` 显式读取
    def recluster(self, project_id: str, asset_id: str, *, k_max: int | None = None) -> dict
```

## 3. 数据模型（v37，冻结）

照抄 `beat_grids` 范式（`algorithm_version` 行化 + 部分唯一索引 + 指纹入键）：

```sql
CREATE TABLE speaker_diarizations (
  id TEXT PRIMARY KEY,
  -- **删除语义（F1，阻断级，必须冻结）**：派生分析数据**随素材自动清**。
  -- 反例警示：beat_grids / cv_analyses 用的是 NO ACTION，实测「插一行分析 ⇒
  -- DELETE FROM assets 直接被 FK 拒绝」（2026-10-11 复现，且 delete_asset 把该拒绝
  -- 报成"被镜头需求或生成记录引用"，原因错、无出路）。本表**不重蹈**：
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK(algorithm_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','unavailable')),
  reason TEXT NULL,
  speaker_count INTEGER NULL,
  turns_json TEXT NOT NULL DEFAULT '[]',
  windows_json TEXT NOT NULL DEFAULT '[]',     -- 窗时间栅格（重聚类的输入之一）
  embeddings_blob BLOB NULL,                   -- float32 (n_windows, dim)：**换 τ 不重跑推理**
  embedding_model TEXT NULL,                   -- 例 "campplus_sv_zh-cn_16k-common"
  model_revision TEXT NULL,
  vad_model TEXT NULL,                         -- 例 "silero_vad_v6"
  threshold REAL NULL,                         -- 本行结论用的 τ
  threshold_strategy TEXT NULL,                -- 哪个策略选的（归因用）
  sample_rate INTEGER NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT NULL
);
CREATE INDEX idx_speaker_diarizations_asset
  ON speaker_diarizations(asset_id, algorithm_version, created_at DESC);
CREATE UNIQUE INDEX idx_speaker_diarizations_ready
  ON speaker_diarizations(asset_id, algorithm_version, source_fingerprint)
  WHERE status IN ('ready','unavailable');
```

**为什么存 embedding**：本包已确定瓶颈在 **τ 选择**（见 §5）。存下窗 embedding 后，
换策略/换 τ **只重跑聚类、不重跑 ONNX**。

**量级（2026-10-11 第一手实测，非估计）**：
- **重聚类耗时**：n=527–547 窗 **0.30–0.40 s**；n=1366 窗 **5.1–5.5 s**；n=1639–1697 窗 **7.8–9.4 s**
  （建树是主导项，随窗数**平方**增长）。对照重跑 embedding 的 **71–79 s/场**（AISHELL-4，spike 记录）
  ⇒ 收益是 **约 8–15×**，**是"分钟级→秒级"而非"毫秒级"**（初版口径写错，已改）。
- **体量**：`n_windows × dim × 4 B`。CAM++（192 维）实测 **0.40 MB**（547 窗）–**1.25 MB**（1639 窗）；
  取会话上限约 **1.3 MB/场**。36 场合计约 **15–45 MB**。**备份/迁移影响未实测**（§10 O5）。

> **实现注记**：上表的建树是 spike 级实现（Python 循环的 Lance-Williams，O(n²)）。
> 生产实现应对 1600 窗级会议做优化（优先队列 UPGMA 或向量化更新）；S2 的性能门以实测为准。

## 4. 流水线与参数（冻结；每个值都带取证出处）

| 参数 | 冻结值 | 出处 |
|---|---|---|
| 解码 | 16 kHz 单声道；**多通道阵列取单通道**（不下混，避免梳状干涉） | spike §2.10 |
| VAD | **随包 Silero v6**，块间不重叠；`min_speech_fraction = 0.60` | spike P90/§2.10（能量 VAD 排除） |
| 窗 | `window_s = 2.0`、`hop_s = 1.0` | spike §2.4（两尺度稳健性已验） |
| 前端 | Kaldi 80 维 log-fbank，**纯 numpy**（与 `kaldi-native-fbank` 逐值等价） | spike §2.5（不引入 C++ 扩展） |
| embedding | CAM++，L2 归一化，192 维 | spike §2.7 |
| 聚类 | 余弦距离 + **平均连接（UPGMA）** | spike §2.9（与单/全连接有区分力的对照） |
| τ 选择（**对照**） | `silhouette` —— **spike 已实测的定义**：整条 τ 网格上取 silhouette 最大，簇数仅受 40 封顶 | spike §2.9/§2.10（跨语料唯一稳住第一档：50.2% / 47.9%） |
| τ 选择（**本门候选**） | `silhouette + k_max` —— **本门新组合（silhouette 限定在簇数 ∈ [2, k_max]、k_max = 8）、spike 从未实测** | 依据：capK 的上限**低于真值也有效**（中文 6 人场上 capK4 仍居第一档）⇒ 价值在抑制过分割。**⚠️ 无实测值：S1 必须首先测它**，且在测出之前**不得**用旧 silhouette 的数字替它背书 |
| VAD 判决阈值 | `vad_threshold = 0.5`（Silero 逐块语音概率）；**不使用** `get_speech_timestamps` 的 neg_threshold / min_silence / min_speech 口径 | 本门冻结；**注意与 `min_speech_fraction` 是两个不同的东西**（后者是窗级语音占比筛选，见上一行）。**改这个阈值必须重测 §5 精度门**（spike §2.9 边界：最优 τ 随 VAD 条件变，0.45→0.50） |
| 轮次化 | 窗标签 → 帧标签（最近中心裁决）→ 合并 < 0.4 s 的碎段 | spike §2.7 的实现口径 |

## 5. 精度门（**本门最重要的裁决**）

**验收语料（D3 冻结）**：**AMI test 全 16 场**（英文，CC BY 4.0）+ **AISHELL-4 test 全 20 场**（中文，Apache-2.0）。
两者都可公开下载（AMI 单场 ~40 MB / AISHELL-4 单场 ~250 MB，下载路径与镜像已在 spike 的 `sources.txt` 记录）。
**语料不入库**（仓外），仓库内只放派生结果与哈希。

**评分口径**：`tools/quality_eval/diarization.py`（10 ms 帧 / 0.25 s collar / **忽略重叠** / 穷举最优映射）。
**该口径会高估质量**，故门限按此口径设，且**不得与含重叠的公开 DER 直接比大小**（spike §2.7 已声明）。

**门限（切片 1 必须达到）**：

| 指标 | 门限 |
|---|---|
| **自动 τ** 下 DER 均值 | **≤ 40%**（**两个语料都要满足**） |
| **自动 τ** 下 DER 最差场 | **≤ 55%** |
| 资源 | ≤ 10 s/分钟源；峰值 RSS ≤ 600 MB |

> **口径限定（复核 F10，必须写明）**：与此对照的三个参照**不是同一口径**，不得混读——
> ① **每场用真值调 τ**（乐观上界，不可产品化）；② **自动选 τ 家族的每场真值调参上界**；
> ③ 现状的**自动 τ** 实现。三者数值见 spike §2.9/§2.10 与
> `evidence/2026-10-11-ami-diarization/threshold-strategies-summary.txt`、
> `evidence/2026-10-11-aishell4-chinese/threshold-strategies-summary.txt`（**本文件不复述数字**，Rule 5）。
>
> **由此得出的一条硬结论**：40% 这个门限**严于中文语料的"自动选 τ 家族真值调参上界"（44.2%）**。
> 换言之，**它不可能靠继续微调 AHC 阈值启发式达到**——这直接决定下面 §6 的切片结构。

**与 spike D5 书面结论的关系（复核 F4，必须承认这处翻转）**：spike §2.9 明确写过
"**不要再试 AHC 阈值启发式**"，D5 也要求走"专门设计"路线。本门**不假装**第一切片能靠启发式达标，
因此把切片结构改成**对照 + 专门设计并行**（§6 S1），并给出**可判定的升级判据**：

> **升级判据（机器可读）**：S1 结束时报出两条路线的 DER。
> **若「专门设计」路线相对「对照」路线无显著改善，或两者都未过 40%**，则裁定为
> **需要 VBx 级方案**，本包**停在 S1**并回到架构裁决——**不得**以"再调参数"续期。

### §5.1 S1 判定（**2026-10-11 已执行：触发升级判据，停在 S1**）

证据：`evidence/2026-10-11-w22-s1-routes/`；实施记录：
`W2_2_SPEAKER_LAYER_IMPLEMENTATION_2026-10-11.md`。**本文件不复述现役数字**（Rule 5），
只记**判定**：

- **条件一「无显著改善」成立**：专门设计相对对照，AMI 无差异、**AISHELL-4 上显著更差**。
- **条件二「两者都未过 40%」成立**：AMI 上两条路线**都**远高于 40%（门要求两语料都过）。

⇒ 按本判据，**裁定需要 VBx 级方案，本包停在 S1**，回到架构裁决。

**同时钉死一条更根本的边界（应主导后续裁决）**：**AMI 上连 oracle（每场用真值调 τ 的乐观上界）
都过不了最差场门限**。⇒ 该语料的失败**不在 τ 选择**，而在 τ 之前的 VAD / embedding / 分段。
即"阈值策略"作为第一切片，**能改善均值、但修不了最差场**——这一收益边界已由全场实测封闭。

**⚠️ 两语料失败原因不同，后续裁决必须分开处理**（否则会开错药方）：

| 语料 | oracle 过最差门？ | 失败应归因于 |
|---|---|---|
| **AMI** | ❌ 否 | **τ 之前**（VAD / embedding / 分段）——换任何 τ 策略都修不了 |
| **AISHELL-4** | ✅ 是 | **τ 选择**——oracle 证明链路有余量，是自动选 τ 没选对 |

⇒ 把两者并成一句"阈值策略不行"，会**掩盖 AMI 侧更根本的缺口**。

## 6. 实施切片

| 切片 | 内容 | 完成判据 |
|---|---|---|
| **S0** | 评测仪器常设化（**含进 CI**）+ 语料扩到全场 + embedding 缓存 | ① `der.py` 迁入 `tools/quality_eval/`，**且 9 项自检以 pytest 用例形态纳入 `services/core/tests`**（`pyproject` 的 `testpaths` 只收 core，迁到 tools 的自检**不会进任何门**——复核 F2 实测）；spike 侧保留**薄转发**以免两份实现漂移，`der.py` 原件去向在此定稿；② AMI 16 + AISHELL-4 20 下载并逐场校验（`audio.sha256` 同步扩写）；③ **派生 embedding 缓存**：目录 + 以（素材指纹，模型 id，算法版本）为键 + 缓存文件 sha256 + 复算清单（**生产侧此前无此设施**，复核 F6）；④ 跑出**自动 τ 的基线**（两语料） |
| **S1** | **对照 + 专门设计并行**（见 §5 的升级判据）：① 对照 = `silhouette + k_max`（**无实测值，先测**）；② 专门设计 = **逐录音距离分布建模**（spike §2.9 的①） | 两条路线都跑出 DER；**升级判据**按 §5 判定并回写；纯函数单测全绿（含"把 silhouette 换成固定 τ ⇒ 精度门用例红"的负向对照） |
| **S2** | `SpeakerEmbedder` + v37 迁移 + 服务（幂等 / stale / 重聚类） + STATUS §1 同改 | 迁移测试 + 服务单测；**重聚类不重跑推理**由测试钉死（推理调用计数为 0） |
| **S3** | 路由 + jobs 分派 + 集成（真实素材、零 egress 断言、**精度门**） | 集成全绿；**精度门在两语料上都过**；性能归档 |
| **S4** | 契约 + IPC + preload + Desktop 面板（含 τ 重聚类入口） | 契约/IPC/组件测试；冻结通道白名单同步扩张 |
| **S5** | 真机 e2e | 真实 Electron 全链路 |

## 7. 测试清单（映射验收）

| 测试 | 覆盖 |
|---|---|
| `services/core/tests/unit/test_diarization_scorer.py`（**pytest 形态**，9 项含平移单调性；仪器实现在 `tools/quality_eval/diarization.py`） | 验收仪器的**区分力**（spike 已证）。**必须落在 core 的 testpaths 内**，否则等于没有门（复核 F2） |
| `speaker_algorithm_test.py`：τ 策略在合成双说话人上选对；固定 τ 负向对照；窗/轮次化边界；确定性 | 1 / 5 |
| `speaker_vad_test.py`：Silero 包装在纯静音/低电平噪声上 0 误报；**能量 VAD 不得出现在任何调用路径**（import 锁） | D4 / R2 |
| `speaker_storage_test.py`：v37 形状 + 部分唯一索引 + 指纹变化新行 + stale + 幂等短路 + **重聚类不重跑推理** | 2 / 3 |
| `speaker_api_test.py`：401 / 跨项目 404 / 登记作业 / 摘要形状（无路径字段）/ **零 egress + 无新模型面** | 4 |
| `speaker_real_test.py`（真实素材）：**精度门**（两语料）；性能门；确定性 | 6 / 7 |
| 契约/IPC/面板测试 | 8 |

## 8. 实施中必须回写的文档（纪律）

- v37 落地 → **同改 `docs/STATUS.md` §1 `latest_migration`**（写成新值；一致性测试会拦住漏改，**本文件不预写数字**，Rule 5）；
- 新增 provider / 模型（若最终自注册 Silero）→ 同改 `STATUS` §1 与 `model_registry` 三表；
- 每个切片完成 → 在 `W2_2_SPEAKER_LAYER_IMPLEMENTATION_2026-10-11.md` 记**验收逐项对照表**
  （AGENTS.md Rule 3：无对照表不算闭环）；
- P89（精度轴取证）随 S0 归档**全场基线**后核销；P91（阈值策略）随 S1 的精度门结果核销或触发升级裁决。

## 9. 不做什么（边界）

- **不做 W2.3 机位切换规划器**（依赖本包 + W2.1，另行立项）；
- **不做说话人身份识别/命名**（本包只产**匿名说话人编号** + 轮次）；
- **不做实时**（离线作业，与 `beat_analysis` 同型）；
- **不引入新的 egress 面**（全本地；模型经受信直链 + sha256）；
- **不引入 C++ 扩展**（fbank 走纯 numpy，已证逐值等价）。

## 10. 开放项

| # | 项 | 处置 |
|---|---|---|
| O1 | **Silero 资产耦合（风险高于初判）**：`get_assets_path` / `get_vad_model` **均非导出面**（不在 `__all__`），当前 faster-whisper 版本 1.2.1 | **S0 必须交付**：① 启动/首次使用时的**资产存在性探测**；② 缺失 ⇒ `unavailable(silero_asset_missing)`（**可测分支**，不是静默降级）；③ 记录版本上限约束。若上游移除 ⇒ 改为在 `model_registry` 自注册（S2 的 provider `onnx-speaker` 即可容纳） |
| O5 | `speaker_diarizations` 含 BLOB 后的备份/恢复体积与耗时**未实测** | S2 实测一次（36 场派生行的备份/恢复），结论回写 §3 |
| O2 | `k_max = 8` 的依据来自"上限低于真值也有效"，但**人数分布只覆盖 4–6** | **S0 已复核（2026-10-11）**：由 RTTM 直接统计全场人数（不依赖音频，见 `evidence/2026-10-11-w22-s0-instrument/speaker-counts.json`）——**AMI test = 4 人 ×15 + 3 人 ×1；AISHELL-4 test = 6 人 ×8 + 5 人 ×8 + 7 人 ×4**。⇒ **修正本行的依据表述**：AISHELL-4 test **不是"4–8 人"，实际最大 7 人**。结论：`k_max = 8` **仍高于全场最大值 7（有余量）**，故本门**保留 `k_max = 8`**；但"覆盖 4–8 档"的说法不准确，已改。**仍未覆盖**：>7 人的会议（该档无语料，属已知边界） |
| O3 | 重叠语音**未纳入评分**（口径忽略重叠） | 生产上是已知高估；若 S3 精度门在含重叠素材上失效，触发口径扩展（需与 W0.4 评测体系一起改） |
| O4 | 分段（谁在说）与聚类的**联合**建模（VBx 路线） | 仅作为 D5 升级路径，本门不实施 |
