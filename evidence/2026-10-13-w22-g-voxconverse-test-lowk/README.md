# O6 定案（第二批）：VoxConverse **test 集**低人数档实测（2026-10-13）

> 点时间证据。判据与门限引用 `docs/design/W2_2_SPEAKER_LAYER_DESIGN_GATE_2026-10-11.md`。
> **本目录只放派生结果**；音频缓存在仓外 `.tmp/voxconverse/test_lowk/`。
> 前一批（dev 集）见 `evidence/2026-10-12-w22-f-voxconverse-lowk/`。

## 一句话

门 §10 O6 的处置是「**先补足低 K 样本量**」。本批把 **VoxConverse test 集**下下来
（4.3 GB，5.02 GB 解压），取出**全部 K≤3 的 64 场**做成新子集。样本量比 dev 批
**翻倍以上**（K≤3：dev 24 场 → 本批 **63 场有效**）。

**结论（与 dev 批不同，必须同读）**：样本量上来以后，
**现行 `silhouette+capK` 的最差场问题不是"单场主导"了，而是结构性失败**——
worst 由 dev 批的 0.4644 升到 **0.8111**，且**最差三场全是 K_true=1 的单人素材被切成 7–8 个簇**。
⇒ 这**加强了**门 §5.6 的判定（"选择准则"是病根），**同时**给出一个 dev 批看不清的方向：
**失败集中在"该给 1 个簇"的素材上**（裁剪的 `k_max=8` 上限对这些场不构成约束）。

## 一、语料与子集（规则先于看任何 DER 定死）

| 项 | 值 |
|---|---|
| 许可 | CC BY 4.0（牛津 VGG 音频 + GitHub RTTM） |
| 体积 | 下载 **4.3 GB**（经本机代理；sha256 `472ebf1e…`）；解压 5.02 GB / 464 wav |
| 子集规则 | **说话人数 K ≤ 3**（由官方 RTTM 直接统计，**先于跑数**） |
| 结果 | **64 场**（K=1:15 / K=2:31 / K=3:18），提取音频 **873 MB** |
| 有效场次 | **63**（1 场因候选集为空被排除） |
| 缓存 | `conditions.json`（逐场 cond 摘要，不含逐窗向量） |

**磁盘处置**：解压出子集后即删除 4.3 GB zip 与分块目录（当时只剩 18 GB）。

## 二、主读数（门限：mean ≤40% / worst ≤55%）

| 读数 | 现行 `silhouette+capK` | oracle（同候选集上界） |
|---|---|---|
| **mean** | **0.1739** ✅ 过 40% | 0.0869 |
| **worst** | **0.8111** ❌ **严重越线** | 0.4504 ✅ |

⇒ **均值线很宽裕、最差场线差得离谱**——两种失败模式完全分离。

## 三、最差场是什么（本批最重要的读数）

| 场 | K 真值 | 现行 DER | 现行选中的 K̂ | oracle | oracle 的 K̂ |
|---|---|---|---|---|---|
| `euqef` | **1** | **0.811** | **7** | 0.148 | 2 |
| `zztbo` | **1** | **0.805** | **7** | 0.162 | 2 |
| `neiye` | **1** | **0.687** | **8** | 0.027 | 2 |
| `fxnwf` | 3 | 0.556 | 2 | 0.190 | 4 |
| `bjruf` | 2 | 0.527 | 2 | 0.094 | 3 |
| `lpola` | 3 | 0.522 | 2 | 0.159 | 7 |

**两个截然不同的失败模式，本批首次把它们分开**：

1. **单人素材被过分割**（`euqef`/`zztbo`/`neiye`）：K_true=1，`silhouette`
   选了 **7–8 个簇**、DER 0.69–0.81——**这是最差场的主因**（worst 0.8111 就来自这里）。
   ⚠️ 注意：**不是 `k_max=8` 的上限造成的**——上限是 8、它选的就是 7~8，
   即**上限没有拦它，准则本身把它推上去**。
2. **多人素材被欠分割**（`fxnwf`/`lpola`，K=3 却选 K̂=2）：与 dev 批一致的方向
   （低人数档"欠分割有害"），但量级远小于模式 1。

⇒ **模式 1 是 dev 批完全没暴露的**：dev 批 K=1 档只有 9 场可选，最深的一个只到 K̂=4；
本批有 15 场 K=1，**最差的几场全在这里**。

## 四、与 dev 批的关系（**不得选择性引用**）

| | dev 批（2026-10-12） | 本批（test 集） |
|---|---|---|
| 有效场次 | 23–24 | **63** |
| K≤3 均值 | 0.0569–0.0592 | **0.1739** |
| K≤3 最差 | 0.4644 | **0.8111** |
| 最差场归因 | 单场（`crixb`，K̂ 正确但划分错） | **三场 K=1 被过分割** |
| 样本量声明 | 明确写"不足以声明统计显著" | **样本量翻倍，最差场的归因不再是单场主导** |

**⚠️ 仍然不得越界**：两批**都不是产品素材**（VoxConverse 是 YouTube 真实对话，远场、
含音乐/噪声），**DER 绝对值不可与 AMI/AISHELL-4 比大小**，只可比**同语料内的规则排序**。
本批**未做四层剥离**（VAD / 窗栅格 / embedding 天花板），故只回答"失败在哪类素材上"，
不回答"瓶颈在哪一环"。**均值差异的显著性仍未做检验**。

## 五、对门的影响（本批只报读数，**不代裁**）

1. **门 §10 O6 的处置条件已满足**（"先补足低 K 样本量"——样本量已翻倍）；
2. **候选规则（B1/E2）仍不批准落 Core**：本批**没有跑候选规则**，
   故它相对现行的优劣**仍未被本批检验**——门 §5.6④ 的三条理由未变；
3. **new**：本批给出一个**dev 批没有的、可检验的假设**——
   「现行准则在"应给 1 个簇"时系统性给高分给退化多簇解」。
   门 §5.6② 已记录该机制（"最优解卡在候选下界 K=2"），**但本批的 K̂=7–8 不是 K=2**，
   故**该机制不足以解释本批**。**下一步若要修准则，须先解释这三场为什么选到 7–8**。

## 本目录文件

| 文件 | 内容 |
|---|---|
| `lowk-test-report.json` | 63 场逐场：τ 网格、K_true、现行 DER/K̂、oracle DER/K̂ |
| `subset-lowk.json` | 子集选择记录（**先于跑数**定下的规则 + 64 场名单与 K） |
| `conditions.json` | 诊断条件摘要（`silero_vad` / `oracle_vad` 的窗数与缓存键；**不含逐窗向量**） |
| `README.md` | 本文件 |

## 复现

```bash
# 1) test 音频（4.3 GB；本机经代理）
PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe - <<'PY'
import sys; from pathlib import Path
sys.path.insert(0, 'tools/quality_eval'); import fetch_diarization_corpora as F
F.fetch_file(F.VC_ARCHIVES['test'], Path('.tmp/voxconverse/voxconverse_test_wav.zip'),
             proxy='http://127.0.0.1:10809', streams=8, chunk_mb=8)
PY
# 2) 取 K<=3 子集（规则先定死：由 RTTM 统计，不看 DER）
# 3) 诊断 + 低 K 评测（corpus=voxconverse 已接入仓库工具）
PYTHONIOENCODING=utf-8 PYTHONPATH=tools/quality_eval .venv/Scripts/python.exe \
  tools/quality_eval/diarization_diagnose.py --corpus voxconverse \
  --audio-dir .tmp/voxconverse/test_lowk --rttm-dir .tmp/voxconverse/rttm --audio-ext .wav \
  --meetings <64 场> --out .tmp/w22-diag-vc-test-lowk.json
PYTHONIOENCODING=utf-8 PYTHONPATH=tools/quality_eval .venv/Scripts/python.exe \
  tools/quality_eval/diarization_lowk_eval.py --diag-json .tmp/w22-diag-vc-test-lowk.json \
  --rttm-dir .tmp/voxconverse/rttm --audio-dir .tmp/voxconverse/test_lowk --audio-ext .wav \
  --condition silero_vad --k-low-max 3 --out .tmp/w22-lowk-vc-test.json
```

**harness 指纹**（本目录结果由这两版代码产出）：
`diarization_lowk_eval.py` `1c4807077c4fb25c…`、`diarization_diagnose.py` `a5bca4ac175f1f18…`。
