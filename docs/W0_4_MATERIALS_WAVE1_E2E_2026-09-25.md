# W0.4 补素材 + Wave 1 真实验收 —— 实施记录

> 实施：ZhangSan（Core），2026-09-25。验收：LiuKeAi。
> 承接：`QUALITY_EVAL_IMPLEMENTATION_2026-09-24.md` §4 剩余范围 1–2；
> 各 Wave 1 实施记录「真实素材 e2e」延后项。
> 排序：ADR-0005 阶段 2 之后、Desktop 语法层 UI 之前。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 素材生成 | `tools/quality_eval/make_eval_materials.py`（打包 ffmpeg + mpeg4；零 egress） |
| 媒体 | `test-assets/generated/eval/`：spoken_single×5、music×3、life_no_voice×3、long_gop×2、spoken_multi×3 |
| 标注 | `eval_set/annotations/*.json` 合成真值（切点/静音/beat_grid/说话人轮换） |
| manifest | `eval_set/manifest.json` 同步 16 条新资产 + 既有自检 fixture |
| Wave 1 e2e | `services/core/tests/integration/test_wave1_real_media.py`（10 项） |
| 评测快照 | `evidence/quality_eval/20260925T025418Z-baseline.json` |

## 2. 验收核对表

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 五档 `min_samples` 全达标（缺口表 shortfall=0） | ✅ | 快照 `gaps` 五档 shortfall 均为 0；`TestEvalMaterialsCoverage` |
| 2 | spoken_single 总时长 ≥600s | ✅ | 5×~119s；`test_spoken_single_total_duration` |
| 3 | W1.5 去停顿：静音检测对齐真值 ±300ms | ✅ | `test_spoken_silence_intervals_match_ground_truth` |
| 4 | W1.5 keep 区间闭合、碎片 ≥ MIN_VIDEO_US | ✅ | `test_keep_intervals_drop_silence_and_close_timeline` |
| 5 | W1.2 节拍：90/110/140 BPM 误差 ≤5%、beat 命中 ≥85% | ✅ | `test_click_track_bpm_within_tolerance[*]` |
| 6 | W1.3 卡点：镜头时长 = 2×beat、高运动优先 | ✅ | `test_cuts_snap_to_ground_truth_beats` |
| 7 | W1.4 L/J：J 领先 / L 拖尾 delta 符号与依据 | ✅ | `test_j_cut_leads_next_word` / `test_l_cut_trails_prev_word` |
| 8 | 零 egress / 媒体不入 git 指纹以外的秘密 | ✅ | 本地 ffmpeg；无网络 |

## 3. 评测快照要点

- **缺口表清零**：spoken_single 5/5、spoken_multi 3/3、music 3/3、life_no_voice 5/5、long_gop 2/2。
- `life_no_voice.cut_pr` / `recall_ndcg` = `ok`（自检 fixture 预测仍在）。
- 其余分档 `cut_pr=unavailable`：**尚未写入系统预测文件**（`predictions/<id>/scene_cut.json`）——
  与骨架诚实语义一致，禁止用真值冒充预测。后续接 CV 导出预测后再出可比分。
- `beat_hit_rate` / `lj_offset_accuracy` 仍 `unavailable`：指标层切换属独立小单
  （能力已在 e2e 钉住，评测口径切换不混进本单）。

## 4. 边界与诚实声明

1. **素材为合成真值**（tone/click/color hard-cut），不是真人实拍口播。
   覆盖的是**功能与标注链路**；真人素材的听感/口误/复杂静音仍待真实库。
2. long_gop 素材 GOP=5s（mpeg4 `-g 150`@30fps），满足 `min_gop_s: 5`。
3. 本单**不**把评测指标从 `unavailable` 强行改 `ok`——那需要系统预测，不是标注。

## 5. 剩余范围

| # | 项 |
|---|---|
| L1 | CV/beat 预测写入 `predictions/`，使 cut_pr / beat_hit_rate 出数 |
| L2 | 真人实拍口播/音乐库替换合成样（产品级调参用） |
| L3 | Desktop 语法层 UI（下一单，YeJing） |
