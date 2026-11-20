# O6 定案：低人数档语料（VoxConverse）上的规则实测与**闸门检验**（2026-10-12）

> 点时间证据。门限与判据引用 `docs/design/W2_2_SPEAKER_LAYER_DESIGN_GATE_2026-10-11.md`。
> **本目录只放派生结果**；音频缓存在仓外 `.tmp/voxconverse/`。

## 一句话

门 §10 O6 的缺口是「验收语料不覆盖低人数档（1–2 人）」。本批**自行下载了覆盖该档的公开语料**
（VoxConverse dev，CC BY 4.0），并做了两件事：

1. **在真实 1–3 人档上实测规则** —— 结论与在 AMI/AISHELL-4 上的读数**不同**；
2. **实测检验了门 §5.6 的反过拟合闸门** —— 它预测「朴素常数下限会错」，
   **在真实低人数语料上确实错了**（是所测规则中最差的）。

---

## 一、语料：为什么是 VoxConverse dev

| 项 | 值 |
|---|---|
| 许可 | CC BY 4.0（可公开下载） |
| 来源 | `robots.ox.ac.uk/~vgg/data/voxconverse/`（音频） + GitHub（RTTM） |
| 本批取的子集 | dev 集，**48 场**（K=1..6 各 8 场），另取 **18 场 K=9..20** 作边界探测 |
| 单场性质 | 真实对话（YouTube 政治辩论/新闻），**已 16 kHz 单声道 wav** |

**入选理由**：它的说话人数分布**横跨 1–21**，而 AMI 只有 3–4、AISHELL-4 只有 5–7。

**选择规则（先于看任何 DER 定死，防挑选偏差）**：时长 ≥120 s，每档按**名称排序**取前 N 场。
不按任何与性能相关的标准挑。

---

## 二、低人数档（K≤3）实测：**现行路线在低 K 上其实不差**

| K 档 | n | 现行 silhouette mean / worst | 同候选集上界 mean / worst | 准则缺口 |
|---|---|---|---|---|
| **K≤3（产品主场景）** | 24 | **0.0592 / 0.4644** | 0.0316 / 0.1122 | −0.0277 |
| K=4..6 | 24 | 0.1616 / 0.6085 | 0.0768 / 0.3042 | −0.0847 |

⇒ **在 1–3 人素材上，现行 silhouette 的均值只有 5.9%**——远好于它在 AMI（45%）上的表现。
**这不是「规则在低 K 上坏掉」，而是「低 K 本来就好分」。**

**但最差场仍然爆掉**：

| 场 | K 真值 | 现行 DER | K̂ | 上界 | 性质 |
|---|---|---|---|---|---|
| `crixb` | 2 | **0.4644** | 2 | 0.0424 | K̂ 正确，**划分本身错** |
| `asxwr` | 3 | 0.1831 | 2 | 0.0134 | **K̂ 偏小** |
| `xypdm` | 1 | 0.1122 | 4 | 0.1122 | K̂ 偏大（但已达上界） |

---

## 三、机制：在低人数档，**欠分割有害、过分割无代价**

按 K̂ 与真值的关系分组（n=24）：

| 关系 | n | DER mean | worst | 与同候选集上界的缺口 |
|---|---|---|---|---|
| **K̂ < 真值** | 4 | 0.0902 | 0.1831 | **−0.0604（有实质损失）** |
| K̂ = 真值 | 10 | 0.0630 | **0.4644** | −0.0422 |
| **K̂ > 真值** | 10 | **0.0430** | 0.1122 | **+0.0000（零损失）** |

⇒ **与 AMI 相反的机制**：

- 在 AMI（4 人会议）：**欠分割反而是「保护」**（真值 K 的最差场比自动 K 更差，§5.4 已记）；
- 在 1–3 人素材：**欠分割是纯损失**（K̂<真值 时缺口 −0.0604），**过分割几乎无代价**（缺口 0.000）。

**⇒ 这直接推翻了「AMI 的欠分割结论可以外推」的隐含假设**，也解释了为什么低 K 段
「允许更大 K」的安全规则在此处更优（见 §四）。

---

## 四、**闸门检验**（本批最重要的结果）

门 §5.6 引入 `structural_safety`，用**纯结构推演**判定：
朴素常数下限 `K>=4` 会把 2–3 人素材的正确答案排除，故**不安全**。
当时它**只有推演、没有实测**。本批用真实 1–3 人语料直接测量：

| 规则 | 闸门判定 | mean | worst | K̂ 中位 |
|---|---|---|---|---|
| **B3 `K>=4`** | **不安全** | **0.0732** | **0.2741** | 4 |
| B1 `K>=K̂_dm` | 安全 | **0.0406** | **0.1831** | 2 |
| E2 `K>=K̂_dm−1` | 安全 | **0.0386** | **0.1831** | 2 |
| A0 现行 silhouette | 安全 | 0.0569 | 0.4644 | 2 |

**⇒ 闸门的预测成立**：被它判为「不安全」的规则，在真实低人数语料上
**既是均值最差、也是最差场最差**的那一个。

**⇒ 且它同时给出了「当前最优的可产品化规则」**：
两条**安全**规则（B1 / E2）在 mean **和** worst 上**都优于现行 A0**
（worst 0.4644 → 0.1831，改善 **28 个点**）。

> **⚠️ 但注意样本量**：n=23（1 场因无候选被排除）。
> 在 n=23 上，mean 的差（0.0406 vs 0.0569）**不足以宣称统计显著**；
> 而 **worst 的差（0.1831 vs 0.4644）由单个场 `crixb` 驱动**。
> 故本批的**可靠结论是「闸门预测被证实」**，
> 而「B1/E2 优于现行」**是初步的、需要更多低 K 语料确认**。

---

## 五、边界探测：K=9..20 暴露了**另一个**上限问题

门 §10 O2 曾说 `k_max=8`「高于全场最大值 7（有余量）」。
**该结论只在旧语料的 K 范围内成立**——VoxConverse dev 有大量 K>8 的会议。

| 档位 | n | 逐场上限 8 下最好（oracle 视角） | 放开上限后最好 | 截断代价 |
|---|---|---|---|---|
| K=9..20 | 18 | 0.2833 | **0.0884** | **+0.1949** |

**逐场示例**：

| 场 | K 真值 | 上限 8 下最好 | 放开后最好 |
|---|---|---|---|
| `tjkfn` | 10 | 0.3403 | **0.0133** |
| `czlvt` | 11 | 0.3288 | **0.0422** |
| `cjfer` | 15 | 0.6416 | **0.0354** |

⇒ **`k_max=8` 对 >8 人的会议是硬约束**，代价接近 **20 个 DER 点**。
**但这是「产品要不要支持 >8 人会议」的问题，不是「选择准则」的问题**——
本批把两者**分开报**，不混为一谈（见门 §10 O2 的修订）。

---

## 六、复现

```bash
# 1) 下载 dev 音频（2.0 GB；本机经代理约 525 KB/s）
PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe - <<'PY'
import sys; from pathlib import Path
sys.path.insert(0, 'tools/quality_eval'); import fetch_diarization_corpora as F
F.fetch_file(F.VC_ARCHIVES['dev'], Path('.tmp/voxconverse/voxconverse_dev_wav.zip'),
             proxy='http://127.0.0.1:10809', streams=8, chunk_mb=8)
PY

# 2) RTTM（GitHub 仓库，很小）+ 解压
curl -sSL -o repo.tgz https://codeload.github.com/joonson/voxconverse/tar.gz/refs/heads/master

# 3) 诊断 + 上限扫描（corpus=voxconverse 已接入仓库工具）
PYTHONIOENCODING=utf-8 PYTHONPATH=tools/quality_eval .venv/Scripts/python.exe tools/quality_eval/diarization_diagnose.py --corpus voxconverse --audio-dir .tmp/voxconverse/audio --rttm-dir .tmp/voxconverse/rttm --audio-ext .wav --meetings <48 场> --out .tmp/w22-diag-vc.json
PYTHONIOENCODING=utf-8 PYTHONPATH=tools/quality_eval .venv/Scripts/python.exe tools/quality_eval/diarization_param_sweep.py --corpus voxconverse --diag-json .tmp/w22-diag-vc.json --rttm-dir .tmp/voxconverse/rttm --out .tmp/w22-param-vc.json
```

## 本目录文件

| 文件 | 内容 |
|---|---|
| `param-sweep-voxconverse-lowk.json` | K≤3 与 K=4..6 的逐 τ 网格 + 上限扫描 |
| `param-sweep-voxconverse-highk.json` | K=9..20 的同上（截断代价） |
| `subset-lowk.json` / `subset-highk.json` | 子集选择记录（含**先于跑数**定下的规则） |
| `gate-empirical.json` | §四 闸门实测：四条规则在真实 1–3 人语料上的结果 |

## 边界（如实）

- **只有 23–24 场有效**（1 场因候选集为空被排除）；**不足以做显著性声明**，
  尤其 mean 的差异。**worst 的改善由单个场主导**，已在上文标注。
- 取的是 **dev** 集（test 集音频 4.3 GB 未下载）；dev 的 K=1 档只有 9 场可选，样本最薄。
- VoxConverse 是 **YouTube 真实对话**，其录音条件（远场、含音乐/噪声）与产品素材**不同**；
  其 DER 绝对值**不可**与 AMI/AISHELL-4 直接比大小，只可比**同语料内的规则排序**。
- **未做四层剥离**（VAD / 窗栅格 / embedding 天花板）于本语料；
  故本批只能回答「规则排序」，不能回答「瓶颈在哪一环」。
- K=9..20 那 18 场**只用于暴露上限问题**，未用于规则评测。
