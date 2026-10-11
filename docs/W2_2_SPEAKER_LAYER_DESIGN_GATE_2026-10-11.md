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
| Core VAD（新） | `services/core/src/aivs_core/media/speaker_vad.py` | `voiced_mask_10ms`：**包装随包 Silero**（经 `faster_whisper.utils.get_assets_path()` 定位），不自己实现 VAD |
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
    def summary(self, project_id: str, asset_id: str) -> dict               # 行选择 + stale 读时计算
    def recluster(self, project_id: str, asset_id: str, *, k_max: int | None = None) -> dict
```

## 3. 数据模型（v37，冻结）

照抄 `beat_grids` 范式（`algorithm_version` 行化 + 部分唯一索引 + 指纹入键）：

```sql
CREATE TABLE speaker_diarizations (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
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

**为什么存 embedding**：本包已确定瓶颈在**τ 选择**（spike §2.9/§2.10）。存下窗 embedding 后，
换策略/换 τ 只需重跑聚类（毫秒级）而不必重跑 ONNX（spike 实测每场 2–4 分钟）——
**这让"阈值策略"的迭代成本从分钟级降到秒级**，是本包最重要的一处工程杠杆。
体量：约 1500 窗 × 192 维 × 4 B ≈ **1.2 MB/场**，桌面端可接受。

## 4. 流水线与参数（冻结；每个值都带取证出处）

| 参数 | 冻结值 | 出处 |
|---|---|---|
| 解码 | 16 kHz 单声道；**多通道阵列取单通道**（不下混，避免梳状干涉） | spike §2.10 |
| VAD | **随包 Silero v6**，块间不重叠；`min_speech_fraction = 0.60` | spike P90/§2.10（能量 VAD 排除） |
| 窗 | `window_s = 2.0`、`hop_s = 1.0` | spike §2.4（两尺度稳健性已验） |
| 前端 | Kaldi 80 维 log-fbank，**纯 numpy**（与 `kaldi-native-fbank` 逐值等价） | spike §2.5（不引入 C++ 扩展） |
| embedding | CAM++，L2 归一化，192 维 | spike §2.7 |
| 聚类 | 余弦距离 + **平均连接（UPGMA）** | spike §2.9（与单/全连接有区分力的对照） |
| τ 选择 | **silhouette 在簇数 ∈ [2, k_max] 上取最大**；`k_max = 8` 作为**上限安全界** | spike §2.9/§2.10（silhouette 是跨语料唯一稳住第一档者；capK 的上限**低于真值也有效** ⇒ 价值在抑制过分割） |
| 轮次化 | 窗标签 → 帧标签（最近中心裁决）→ 合并 < 0.4 s 的碎段 | spike §2.7 的实现口径 |

## 5. 精度门（**本门最重要的裁决**）

**验收语料（D3 冻结）**：**AMI test 全 16 场**（英文，CC BY 4.0）+ **AISHELL-4 test 全 20 场**（中文，Apache-2.0）。
两者都可公开下载（AMI 单场 ~40 MB / AISHELL-4 单场 ~250 MB，下载路径与镜像已在 spike 的 `sources.txt` 记录）。
**语料不入库**（仓外），仓库内只放派生结果与哈希。

**评分口径**：`tools/quality_eval/diarization.py`（10 ms 帧 / 0.25 s collar / **忽略重叠** / 穷举最优映射）。
**该口径会高估质量**，故门限按此口径设，且**不得与含重叠的公开 DER 直接比大小**（spike §2.7 已声明）。

**门限（切片 1 必须达到）**：

| 指标 | 门限 | 现状（4+4 样本，spike §2.9/§2.10） |
|---|---|---|
| **自动 τ** 下 DER 均值 | **≤ 40%**（**两个语料都要满足**） | silhouette：AMI 50.2% / 中文 47.9% |
| **自动 τ** 下 DER 最差场 | **≤ 55%** | AMI 62.9% / 中文 64.2% |
| 上界参照（**非门限**，仅供定位） | oracle τ：AMI 30.1% / 中文 33.4% | — |
| 资源 | ≤ 10 s/分钟源；峰值 RSS ≤ 600 MB | 实测 1.7–4.7 s/分钟、347–373 MB |

**为什么是 40%**：它**严格优于**现状（48–50%）、又**高于** oracle 上界（30–33%），
落在一个"必须真的改进 τ 策略、但不必换掉整条技术路线"的位置。
**若切片 1 达不到** ⇒ **触发 D5 升级路径裁决**（概率化聚类 VBx / 引入更强分段先验），
**不得**以"再调调参数"续期——这是 spike §2.9 已经否掉的方向。

## 6. 实施切片

| 切片 | 内容 | 完成判据 |
|---|---|---|
| **S0** | 评测仪器常设化 + 语料扩到全场 | `der.py` 迁入 `tools/quality_eval/`（9 项自检随迁）；AMI 16 + AISHELL-4 20 全部下载并校验；**跑出自动 τ 的基线**（两个语料） |
| **S1** | 纯函数（VAD 包装 / 窗 / 聚类 / **τ 策略** / 轮次化）+ 单测 | 纯函数测试全绿；**τ 策略的负向对照**（把 silhouette 换成固定 τ ⇒ 精度门用例红） |
| **S2** | `SpeakerEmbedder` + v37 迁移 + 服务（幂等 / stale / 重聚类） + STATUS §1 同改 | 迁移测试 + 服务单测；**重聚类不重跑推理**由测试钉死（推理调用计数为 0） |
| **S3** | 路由 + jobs 分派 + 集成（真实素材、零 egress 断言、**精度门**） | 集成全绿；**精度门在两语料上都过**；性能归档 |
| **S4** | 契约 + IPC + preload + Desktop 面板（含 τ 重聚类入口） | 契约/IPC/组件测试；冻结通道白名单同步扩张 |
| **S5** | 真机 e2e | 真实 Electron 全链路 |

## 7. 测试清单（映射验收）

| 测试 | 覆盖 |
|---|---|
| `tools/quality_eval/diarization.py` 自检（9 项，含平移单调性） | 验收仪器的**区分力**（spike 已证） |
| `speaker_algorithm_test.py`：τ 策略在合成双说话人上选对；固定 τ 负向对照；窗/轮次化边界；确定性 | 1 / 5 |
| `speaker_vad_test.py`：Silero 包装在纯静音/低电平噪声上 0 误报；**能量 VAD 不得出现在任何调用路径**（import 锁） | D4 / R2 |
| `speaker_storage_test.py`：v37 形状 + 部分唯一索引 + 指纹变化新行 + stale + 幂等短路 + **重聚类不重跑推理** | 2 / 3 |
| `speaker_api_test.py`：401 / 跨项目 404 / 登记作业 / 摘要形状（无路径字段）/ **零 egress + 无新模型面** | 4 |
| `speaker_real_test.py`（真实素材）：**精度门**（两语料）；性能门；确定性 | 6 / 7 |
| 契约/IPC/面板测试 | 8 |

## 8. 实施中必须回写的文档（纪律）

- v37 落地 → **同改 `docs/STATUS.md` §1 `latest_migration` 36 → 37**（否则一致性测试红）；
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
| O1 | Silero 资产耦合：经 `faster_whisper.utils.get_assets_path()` 定位 | 若 faster-whisper 移除该资产 ⇒ 改为在 `model_registry` 自注册（S2 预留 provider `onnx-speaker` 即可容纳） |
| O2 | `k_max = 8` 的依据来自"上限低于真值也有效"，但**人数分布只覆盖 4–6** | 全场语料（S0）里 AISHELL-4 有 4–8 人档 ⇒ S0 基线时**顺便复核 k_max**，结论回写本文件 |
| O3 | 重叠语音**未纳入评分**（口径忽略重叠） | 生产上是已知高估；若 S3 精度门在含重叠素材上失效，触发口径扩展（需与 W0.4 评测体系一起改） |
| O4 | 分段（谁在说）与聚类的**联合**建模（VBx 路线） | 仅作为 D5 升级路径，本门不实施 |
