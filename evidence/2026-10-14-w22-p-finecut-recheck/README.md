# W2.2 O2 再裁决复核（2026-10-14）

> 裁决：`docs/design/adr/0008-w22-o2-rerecheck.md`（**D1–D3 待用户拍板**）。
> 门记录：`W2_2_SPEAKER_LAYER_DESIGN_GATE_2026-10-11.md` §5.18（新）/ §5.17（**已加更正块**）/ §10 O2。

## ⚠️ 证据地位（必须与任何引用同读）

- 本目录是**探索性探针**的产物，**没有 `PRE_REGISTRATION.md`** ⇒
  **不得**引为「某规则更优」的证据，**不得**替代 S3 精度门，**不得**作为降级交付依据。
- **污染声明**：为判断值不值得复核，**复核时已读过 AMI 与 VoxConverse 的读数** ⇒
  这两个语料（含 `vc_lowk`）**在本文里都不是盲测**；AISHELL-4 是本轮**首次**读取。
  因此 `probe-*.json` 里的三语料**只能用于定位**，**不能充当判定集**。
- **零迁移 / 零契约 / 零 egress / 未改任何生产代码。**

## 一句话

P125 的「好解**不是任何 dendrogram 割**」**不成立**：它是**同一棵树上的一个割**，
只是**不在 `[2,8]` 窗口里**；而**全局最优割比它更好**。
⇒ 定位回到「**从一棵树上选哪个割**」——**既不用动 `k_max`，也不用换特征**。

## 目录内容

| 文件 | 内容 |
|---|---|
| `recheck.json` | AMI 逐场：基线 / 固定规则 / `[2,8]` 内最优割 / **全局最优割（任意 K）** 四条并列 + 摘要 |
| `probe-ami.json` | AMI：`base` / `abs40` / `rel1n` 三规则 × 两种重叠口径 |
| `probe-aishell4.json` | AISHELL-4 同上（**本轮首次读取**） |
| `probe-vc_lowk.json` | VoxConverse test K≤3 同上（**已非盲测**） |

## 关键读数（摘要；完整在 JSON 内）

| 同一 AMI 16 场 | mean | worst |
|---|---|---|
| 现行 `silhouette+capK=8` | 0.4540 | 0.7016 |
| `[2,8]` 内最优割（**P125 的原基准**） | 0.3407 | 0.6882 |
| **全局最优割（任意 K）** | **0.2196** | **0.3905** |
| 固定规则「细切 Kf≤40 + 份额合并 s=0.10」 | 0.2577 | 0.4345 |

- 固定规则**四语料两种口径**：AMI 0.2577/0.4345、AISHELL-4 0.3242/0.5641（**两口径都过门**）、
  VoxConverse 0.2514/0.6990（**退化**，基线 0.1739/0.8111）；输出 **K 仅 2–4**。
- **K=1 分支**（VoxConverse）：35 场输出 K=1，真值 K=1 只有 12 场 ⇒ **精确率 0.34**；
  改对 mean 0.0277、改错 mean 0.3001 / worst 0.6990。
- **过门区间是峰不是高原**：细切仅 **40–48**、份额仅 **0.05–0.10**；去掉合并 guard 时 VoxConverse DER **0.9833**。

## 复现

```bash
PYTHONIOENCODING=utf-8 PYTHONPATH=tools/quality_eval .venv/Scripts/python.exe \
  tools/quality_eval/diarization_finecut_merge_probe.py --corpus ami --s 0.10 --json -
PYTHONIOENCODING=utf-8 PYTHONPATH=tools/quality_eval .venv/Scripts/python.exe .tmp/p_recheck.py
```

`recheck.json` 另有一条**独立交叉验证**：用生产模块取标签 + 从零自写的 DER 重算，
16 场 **4 位小数逐场相同**（mean 0.2577 / worst 0.4345）⇒ 不是 harness bug。

