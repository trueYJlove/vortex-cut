# W0.4 评测预测接入 —— 实施记录

> 实施：ZhangSan（Core），2026-09-25。验收：LiuKeAi。
> 承接：`W0_4_MATERIALS_WAVE1_E2E_2026-09-25.md` §5 L1；
> `QUALITY_EVAL_IMPLEMENTATION_2026-09-24.md` §4 剩余范围 2。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 预测导出 | `tools/quality_eval/make_predictions.py`：对 eval 媒体跑**生产算法**写 `predictions/` |
| scene_cut | `analyze_video` 全量路径 + `frame_signals.scene_cut` → `cuts_us` + `density_status` |
| beat_grid | `beat_grid.analyze_pcm` → `beats_us` / `bpm` |
| 指标 | `metrics.beat_hit_rate`；`MEASURABLE_TASKS` 含 `beat_hit_rate` |
| harness | 读 `beat_grid.json` 聚合微平均；`algorithm_version` 快照改为 **3** |
| 测试 | `TestBeatHitRate` 4 项 |

**禁止真值冒充预测**：导出脚本只调用生产路径；真值仍在 `annotations/`。

## 2. 验收核对表

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | scene_cut 预测来自系统而非标注 | ✅ | `make_predictions.py` 调 `analyze_video` |
| 2 | beat 预测来自 `analyze_pcm` | ✅ | 同上；`predictions/*/beat_grid.json` |
| 3 | `beat_hit_rate` 可测（非 unavailable） | ✅ | `TestBeatHitRate` + 快照 music 档 `status=ok` |
| 4 | 切点分出真实数 | ✅ | 快照：life/long_gop/multi F1=1.0，spoken_single F1≈0.67 |
| 5 | 无标签分档仍诚实 unavailable | ✅ | 非 music 档 `beat_hit_rate=unavailable` |
| 6 | 口径冻结 | ✅ | `DEFAULT_BEAT_TOLERANCE_US=50ms` 写入快照 `value.tol_us` |

## 3. 首个有预测基线（`20260925T040102Z-baseline.json`）

| 分档 | cut_pr | beat_hit_rate |
|---|---|---|
| life_no_voice | ok · F1=1.0 | unavailable |
| long_gop | ok · F1=1.0 | unavailable |
| spoken_multi | ok · F1=1.0 | unavailable |
| spoken_single | ok · F1≈0.67 | unavailable |
| music | unavailable（无切点标注） | ok · hit_rate≈0.91 |

`algorithm_version=3`。spoken_single F1<1 是**真实系统输出**（合成 tone 画面切点部分未触发阈值），不是假分。

## 4. 剩余范围

| # | 项 |
|---|---|
| L1 | `lj_offset_accuracy`（需词级 ASR 预测格式） |
| L2 | `recall_ndcg` 真实查询预测（当前仅自检 fixture） |
| L3 | 真人素材替换合成后的基线复测 |
