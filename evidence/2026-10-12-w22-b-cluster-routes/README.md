# W2.2 后续步骤 ①+② —— 中文侧诊断 + 「不偷看真值 K」的聚类族替换（2026-10-12）

> 点时间证据。门限与升级判据引用 `docs/W2_2_SPEAKER_LAYER_DESIGN_GATE_2026-10-11.md`。
> **本目录只放派生结果**；音频与 embedding 缓存在仓外 `.tmp/`。

## 背景与要回答的问题

用户 2026-10-12 裁决：**先做 A（诊断 τ 之前的瓶颈），再考虑 B（VBx）**。
方案 A 只覆盖 AMI，结论是"瓶颈在 embedding + 聚类，VAD 不是解药"。
本批补两步：

1. **中文侧（AISHELL-4）同套四层剥离诊断** —— 产品是中文的，却不知道中文病根。
2. **「不偷看真值 K」的聚类族替换试验**（双语料）—— 方案 A 的"12.9 点余量"用的是
   **真值 K**，而**产品拿不到 K**。只有自动 K 版本拿到余量，升级路径才成立。

## ① 中文侧诊断：**与 AMI 的关键差异**

| 语料 | 条件 | DER 均值 | miss | spkerr |
|---|---|---|---|---|
| AMI（英，16） | silero_vad | 0.341 | 0.133 | 0.197 |
| AMI（英，16） | oracle_vad | **0.341（不变）** | 0.003 | 0.313 |
| AISHELL-4（中，20） | silero_vad | 0.204 | 0.103 | 0.097 |
| AISHELL-4（中，20） | oracle_vad | **0.179（改善 2.5 点）** | 0.001 | 0.165 |

- **AMI：VAD 修好等于没用**（miss 改善 12.95 点被 spkerr 恶化 11.58 点抵消）。
- **中文：VAD 修好有正收益**（改善 2.51 点），但**同样大部分被 spkerr 抵消**
  （miss −10.21、spkerr +6.86）。
- 中文 `spkerr` 基线远低于 AMI（0.097 vs 0.197）⇒ **中文的聚类本来就比 AMI 容易**。

**结论**：中文侧"τ 之前"**同样以聚类为主**，但比 AMI 轻；VAD 在中文上**有**正收益
（与 AMI 相反），不过仍不足以独自解决问题。

## ② 「不偷看真值 K」的聚类族替换（**本批最重要的结果**）

四条路线都在**同一批 embedding** 上，只换聚类：

| 路线 | K 的来源 | 可产品化？ |
|---|---|---|
| `ahc_silhouette_capk` | 隐式（τ 网格 + silhouette + capK） | ✅（**S1 的现行对照**） |
| `kmeans_silhouette` | **自动**：K∈[2,8] 取 silhouette 最大 | ✅ |
| `kmeans_elbow` | **自动**：簇内平方和的拐点 | ✅ |
| `kmeans_oracle_k` | **真值 K** | ❌ 仅上界参照 |

### silero 条件（端到端，可产品化）

| 语料 | 路线 | 均值 | 最差 | 均值≤40% | 最差≤55% |
|---|---|---|---|---|---|
| AMI (16) | AHC（S1 对照） | 0.4887 | 0.7016 | ❌ | ❌ |
| AMI (16) | **kmeans_silhouette** | **0.2949** | **0.5179** | ✅ | ✅ |
| AMI (16) | kmeans_elbow | 0.2887 | 0.7490 | ✅ | ❌ |
| AMI (16) | kmeans_oracle_k | 0.2376 | 0.6150 | ✅ | ❌ |
| A4 (20) | AHC（S1 对照） | 0.2726 | 0.7636 | ✅ | ❌ |
| A4 (20) | **kmeans_silhouette** | **0.2407** | **0.4716** | ✅ | ✅ |
| A4 (20) | kmeans_elbow | 0.2834 | 0.5456 | ✅ | ✅ |
| A4 (20) | kmeans_oracle_k | 0.2665 | 0.4941 | ✅ | ✅ |

**表面结论**：换聚类族后**两语料都过双门**——这与方案 A 的"需要 B"方向**相反**，
说明**可能不需要 VBx**。

## ⚠️ 但必须同时报告三条**反证**（不掩饰）

### 反证 1：AMI 的"过门"**依赖评分口径**

本门限按**忽略重叠**口径设定。若改为**含重叠**计分（更严格、更接近真实使用）：

| 口径 | 均值 | 最差 | 最差≤55% |
|---|---|---|---|
| 忽略重叠（现行门限口径） | 0.2949 | 0.5179 | ✅ |
| **含重叠** | 0.3514 | **0.5716** | ❌ |

⇒ **AMI 的"过门"是口径边界上的过门**，不是稳健的达标。
（中文在两种口径下都过：0.2407/0.4716 → 0.2592/0.4895。）

### 反证 2：中文的"过门"**对 k-means 初值敏感**

8 个确定性初值（同数据、同算法，只换初始化）：

| 语料 | mean 区间 | worst 区间 | 全部过双门？ |
|---|---|---|---|
| AMI | 0.2932–0.3042 | 0.5179–0.5365 | ✅ 是 |
| AISHELL-4 | 0.2371–0.2520 | **0.4716–0.5711** | ❌ **否**（2/8 个初值最差场 >0.55） |

⇒ 中文的"过门"**不是稳定性质**，换初值就可能翻车。

### 反证 3：自动 K **系统性欠分割**，"过最差门"带运气成分

| 语料 | 自动 K < 真值 K 的场数 |
|---|---|
| AMI | **9/16** |
| AISHELL-4 | 8/20 |

AMI 上对比"自动 K"与"真值 K"：

- **自动 K**：mean 0.2949、worst **0.5179**（过最差门）
- **真值 K**：mean **0.2376**、worst 0.6150（**不过**最差门）

⇒ 自动 K **平均更差、但最差更好**——它在**牺牲均值换取"避免最坏"**。
换句话说，**"过最差门"部分来自欠分割的保守偏置，而不是来自"分得更对"**。
（中文侧同现象：K̂ 撞 `k_max=8` 的 3 场正是种子敏感场。）

## 对"是否上 B（VBx）"的结论

| 问题 | 回答 |
|---|---|
| 中文最差场能否救？ | **有希望但未坐实**——自动 K 的 k-means 在多数初值下过门，但 **2/8 初值翻车** |
| 换聚类族是否有效？ | **是**——两语料都从"不过最差门"变为"多数情形过门"，AHC 确为限制 |
| **是否必须上 B？** | **不再必然**。本批显示**便宜的聚类族替换**已接近达标，B 的边际价值下降 |
| 但能否现在就宣布达标？ | **不能**。三条反证说明当前"过门"**口径依赖 + 初值敏感 + 带欠分割运气** |

**建议**：把方向从"上 VBx"改为**"先把自动 K 做稳"**——
具体是让 K 的估计**不再系统性偏小**（当前 9/16 场偏小），并**跨初值稳定**。
这是**比 VBx 小得多**的投入，且直接针对已识别的机制。
若"做稳自动 K"之后仍不过门，**再**上 B，那时 B 才有明确依据。

## 复现

```bash
# ① 中文诊断（注意 --channel 0，阵列取单通道不下混）
PYTHONIOENCODING=utf-8 PYTHONPATH=tools .venv/Scripts/python.exe tools/quality_eval/diarization_diagnose.py \
  --corpus aishell4 --audio-dir .tmp/aishell4/audio --rttm-dir .tmp/aishell4/rttm --channel 0 \
  --meetings <20 场> --model-id campplus --out .tmp/w22-diag-cn.json

# ② 聚类族替换（双语料；需先有 ① 的 diag 报告）
PYTHONIOENCODING=utf-8 PYTHONPATH=tools .venv/Scripts/python.exe tools/quality_eval/diarization_cluster_routes.py \
  --diag-json .tmp/w22-diag-ami.json --rttm-dir .tmp/ami/AMI-diarization-setup-main/only_words/rttms/test \
  --audio-dir .tmp/ami/audio --audio-ext .Mix-Headset.wav --out .tmp/w22-routes-ami.json
PYTHONIOENCODING=utf-8 PYTHONPATH=tools .venv/Scripts/python.exe tools/quality_eval/diarization_cluster_routes.py \
  --diag-json .tmp/w22-diag-cn.json --rttm-dir .tmp/aishell4/rttm \
  --audio-dir .tmp/aishell4/audio --audio-ext .flac --channel 0 --out .tmp/w22-routes-cn.json
```

## 边界（如实）

- `kmeans_silhouette` 与 `kmeans_elbow` 均为**对照实现**（余弦空间、k-means++、确定性多起点）。
  它们证明"换聚类族有效"，**不等于**"生产化后就能拿到这些数字"。
- 本批的 k-means **没有做任何调优**（如 BIC / gap statistic / 层次化 K 选择）；
  "自动 K 偏小"是**已识别的可改进点**，不是终点。
- 中文侧只诊断了 silero 与 oracle_vad 两个条件，未复跑 energy_vad（该条件 P90 已证远场必失效）。
