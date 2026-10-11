# W2.2 S1 —— 阈值策略两路线对照（2026-10-11）

> 点时间证据。**本目录只放派生结果**（`baseline-*.json`），音频与 embedding 缓存均在仓外。
> 门限与升级判据引用 `docs/W2_2_SPEAKER_LAYER_DESIGN_GATE_2026-10-11.md` §5/§6。

## 配置（全部为冻结值，见门 §4）

- 语料：**AMI test 16 场**（英文，Mix-Headset）+ **AISHELL-4 test 20 场**（中文，阵列第 0 通道）。
- 模型：CAM++（192 维）；VAD：随包 Silero v6，`vad_threshold = 0.5`。
- 窗 2.0 s / 跳 1.0 s / `min_speech_fraction = 0.60` / `min_turn_s = 0.40`。
- τ 网格 0.20–0.80 步长 0.02（31 点）。
- 评分：自实现 DER，10 ms 帧 / 0.25 s collar / **忽略重叠** / 穷举最优映射。
- 实现：**生产 Core 模块** `aivs_core.media.speaker`（S2 将落地的同一份），非 spike 脚本。

## 两条路线

| 路线 | 策略名 | 机制 |
|---|---|---|
| **对照** | `silhouette+capK` | silhouette 最大，簇数限定 `[2, k_max=8]` |
| **专门设计** | `distance_mixture(k_hat=K)` | **逐录音**两两窗距离的 1 维两成分高斯混合 EM，由 `w_same` 反推 K̂≈1/w_same，再取"簇数首次降到 ≤K̂"的 τ |

## 结果

| 语料 | 路线 | 均值 DER | 最差 DER | 均值 ≤40% | 最差 ≤55% |
|---|---|---|---|---|---|
| AMI (16) | 对照 silhouette+capK | 0.4887 | 0.7016 | ❌ | ❌ |
| AMI (16) | 专门设计 distance_mixture | 0.5165 | 0.6977 | ❌ | ❌ |
| AMI (16) | 固定 τ=0.45（旧基线） | 0.5686 | 1.0025 | ❌ | ❌ |
| AMI (16) | **oracle（用真值，上界）** | **0.3414** | **0.6110** | ✅ | **❌** |
| AISHELL-4 (20) | 对照 silhouette+capK | 0.2726 | 0.7636 | ✅ | ❌ |
| AISHELL-4 (20) | 专门设计 distance_mixture | 0.3911 | 0.7636 | ✅ | ❌ |
| AISHELL-4 (20) | 固定 τ=0.45 | 0.6834 | 0.9308 | ❌ | ❌ |
| AISHELL-4 (20) | **oracle** | **0.2042** | **0.3921** | ✅ | ✅ |

### 配对检验（专门设计 vs 对照，同一场次配对）

| 语料 | Δ均值 | 更差 / 更好 / 平 | 符号检验 p | 配对 t |
|---|---|---|---|---|
| AMI (16) | **+0.0279** | 5 / 3 / 8 | 0.727 | 1.01 |
| AISHELL-4 (20) | **+0.1185** | 12 / 2 / 6 | **0.013** | **4.12** |

（Δ = 专门设计 − 对照，**正值 = 专门设计更差**。）

## 判定：**触发升级判据，停在 S1**

Design Gate §5 的升级判据（机器可读）原文：

> **若「专门设计」路线相对「对照」路线无显著改善，或两者都未过 40%**，则裁定为
> **需要 VBx 级方案**，本包**停在 S1**并回到架构裁决——**不得**以"再调参数"续期。

两条**都成立**：

1. **无显著改善**：AMI 上 p=0.727（无差异）；AISHELL-4 上专门设计**显著更差**（p=0.013、t=4.12）。
   ⇒ 专门设计路线**没有兑现**"逐录音建模"的预期收益。
2. **两者都未过 40%**：AMI 上两条路线均值 0.4887 / 0.5165，**都远高于 40%**。

### 更强的一条证据：**AMI 上连 oracle 都过不了最差场门限**

oracle 是"每场用真值调 τ"的**乐观上界**（不可产品化）。本批实测：

- **AMI：oracle 最差场 0.6110 > 55%**（EN2002a 0.611、EN2002d 0.554）。
- AISHELL-4：oracle 最差 0.3921，过门。

### ⚠️ 两语料的失败**原因不同**（读结论前必读，否则会开错药方）

| 语料 | oracle 过 55%？ | 策略 − oracle 最大 gap | 失败性质 |
|---|---|---|---|
| AMI | ❌ **否**（0.6110） | +0.344（ES2004c） | **τ 之前**的问题（VAD/embedding/分段）——**换 τ 策略修不了** |
| AISHELL-4 | ✅ 是（0.3921） | +0.375（M_R003S05C01） | **τ 选择**的问题——oracle 证明链路有余量 |

**含义**：

- **AMI 的失败不能归因于阈值策略**：即使每场用真值调 τ，最差场仍越线。
  按 oracle 最差 0.6110 反推，**AMI 侧的瓶颈在 τ 之前的环节**（与本批策略实验无关）。
- **AISHELL-4 的失败可以归因于阈值策略**：oracle 最差 0.3921 稳过 55%，
  说明链路本身够好，是**自动选 τ 没选对**（gap 最大 0.375）。

⇒ 后续架构裁决应**分开处理**：AMI 侧要查 VAD/embedding/分段；AISHELL-4 侧才是 τ 策略的战场。
把两者混成一句"阈值策略不行"，会**掩盖 AMI 侧更根本的缺口**。

> **旁证**：spike §2.10 已测得 oracle VAD 条件下中文小房间 DER 可低到 3.6%，
> 与本处 AISHELL-4 oracle 最差 0.3921 的方向一致——**中文侧链路余量更大**。

⇒ **AMI 的失败不是"τ 选得不好"**：即使把 τ 选到最优，最差场仍越线。
**误差在 τ 之前**（VAD / embedding / 分段），**不是阈值策略能修的**。
这与 spike §2.10 的结论方向一致（"VAD 与聚类各占一半"），且**把"阈值策略是本包第一切片"
这一 D5 裁决的收益边界钉死了**：τ 策略能改善均值（0.5686 → 0.4887），**但修不了最差场**。

**已核**：oracle 确为上界——两语料 36 场中，**没有任何单 τ 策略的 DER 低于该场 oracle**（违反数 = 0）。

## 建模边界（如实记录，不掩饰）

专门设计路线用的是**两成分**高斯混合，只能表示**双峰**距离分布：

- 4 说话人合成夹具的两两距离呈**三峰**（同人 ≈0.01 / 相邻 ≈0.9–1.0 / 对角 ≈1.9），
  两成分拟合会把低+中两峰并进一个宽成分。**这不是 EM 收敛失败**：
  该解的对数似然（−66.2）**优于**按真值劈分的解（−135.3），
  是**两成分假设本身不够**。已落成回归用例
  `test_two_component_limit_is_documented_not_hidden`。
- ⇒ 若将来要走"分布建模"，**必须用 K 成分 / 按合并序列建模**，两成分不够。

## 复现

```bash
PYTHONIOENCODING=utf-8 PYTHONPATH=tools .venv/Scripts/python.exe tools/quality_eval/diarization_eval.py \
  --corpus ami --audio-dir .tmp/ami/audio --rttm-dir .tmp/ami/AMI-diarization-setup-main \
  --meetings EN2002a ... TS3003d --model-id campplus --out .tmp/w22-baseline-ami.json
# 中文（注意 --channel 0，阵列取单通道不下混）
PYTHONIOENCODING=utf-8 PYTHONPATH=tools .venv/Scripts/python.exe tools/quality_eval/diarization_eval.py \
  --corpus aishell4 --audio-dir .tmp/aishell4/audio --rttm-dir .tmp/aishell4/rttm --channel 0 \
  --meetings L_R003S01C02 ... S_R004S04C01 --model-id campplus --out .tmp/w22-baseline-aishell4.json
```

## 与 spike 证据的一致性（迁移正确性）

S0 的 harness 在 spike 用过的 4 场（ES2004a / IS1009a / IS1009c / EN2002b）上
**逐值复现**了 spike `threshold-strategies.json` 的 silhouette 与 fixed 两列
（DER 与 τ **完全相同**，如 ES2004a silhouette τ=0.54 / 0.4172、fixed τ=0.45 / 0.3689）。
⇒ 迁入生产模块**未改变行为**。
