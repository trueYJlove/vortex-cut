# W0.4 recall_ndcg 真实预测 —— 实施记录

> 实施：ZhangSan（Core），2026-09-25。验收：LiuKeAi。
> 承接：`W0_4_PREDICTIONS_2026-09-25.md` §5 L2；W0.4 可测指标收口。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 标注 | spoken_single×5 / spoken_multi×3 增 `recall.queries`（query `speech`，窗 id `t{start_us}`） |
| 预测 | `predictions/<id>/recall.json`：按窗口音频能量降序（对齐 `_cv_scenes` 特征排序精神） |
| 指标 | 既有 `mean_recall_ndcg`（口径未改） |
| 结果 | 基线 `20260925T051523Z`：spoken_single / spoken_multi **nDCG=1.0** |

## 2. 验收核对表

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 排序来自媒体能量而非标注拷贝 | ✅ | `make_predictions` 读 wav 算 RMS 后排序 |
| 2 | 窗 id 双侧一致 | ✅ | `t{start_us}` 标注与预测同一约定 |
| 3 | spoken 分档出数 | ✅ | nDCG=1.0（有声窗排前、静音窗排后） |
| 4 | 无标注分档仍 unavailable | ✅ | music / long_gop |
| 5 | 口径冻结 | ✅ | 未改 `DEFAULT_NDCG_K` / 公式 |

## 3. W0.4 可测矩阵（收口）

| 指标 | 状态 | 首基线 |
|---|---|---|
| cut_pr | ok | spoken_single F1≈0.67 等真实切点分 |
| recall_ndcg | ok | spoken nDCG=1.0 |
| beat_hit_rate | ok | music ≈0.91 |
| lj_offset_accuracy | ok | spoken acc=1.0（规则分） |
| multicam / narrative / structure / av_defect | unavailable | 仍待对应能力 |

## 4. 剩余（产品向，非评测骨架债）

真人素材库、ASR 词戳、multicam/叙事/结构指标。
