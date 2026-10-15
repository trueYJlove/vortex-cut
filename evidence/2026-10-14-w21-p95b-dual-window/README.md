# W2.1 P95b：双窗一致门限的**独立标定**（2026-10-14）

> 回答 `docs/STATUS.md` §4 **P95b**（`DUAL_WINDOW_TOLERANCE_US = 5000` 待独立证据）。
> 口径与常量见 `services/core/src/aivs_core/media/angle_sync.py`。

## 为什么此前标不出来

P95b 原文写「**无法单独标定**该门」——复核该判断后确认**原因是证据缺口**：
归档的 `fix-verification.json` 只记录了被拒窗的 `status/reason/confidence/offset`，
**没有记录 `dual_delta_us`**（本目录首个脚本第一版也没记全，见下「harness 缺陷」）⇒
那 2 个被拒窗的 Δ 值**从未落盘**，因此当时无法判断 5 ms 是松是紧。

## 本次做法（真实素材，非合成）

- 下载 **4 场新会议**的 Array1-01 / Array2-01 通道（EN2002a / ES2004b / IS1009a / TS3003a），
  与既有 ES2004a 合计 **5 场 × 2 阵列**。
- **利用一个硬事实做误差标签**：AMI 阵列是**硬件同步**的（归档 NLCC 实测滞后 +0.15 ms，
  `evidence/2026-10-11-ami-angle-sync/nlcc-diagnostic.txt`）⇒ 远距阵列对的**真实偏移≈0**，
  于是 `|coarse_us + res1|` **就是该窗的估计误差**，无需人造真值。
- 绕过门限直接复算 `_fine_residual`，得到每窗的 `(dual, conf, error)`。

## 结果（`dual-window-error-calibration.json`，58 个窗）

| | n | dual p50 | p90 / min |
|---|---|---|---|
| 误差 ≤5 ms（好窗） | 41 | **188 µs** | p90 **6354 µs** |
| 误差 >5 ms（坏窗） | 17 | **2833 µs** | min **42 µs** |

**成对分离度 AUC(`dual`: 好窗 < 坏窗) = 0.712**（0.5 = 无区分力）。

容差扫描（以 5 ms 误差为「好窗」口径）：

| `t_dual` | 接受 | 接受且好 | **接受但坏** | 拒绝且好 |
|---|---|---|---|---|
| 500 µs | 34 | 27 | 7 | 14 |
| 2 ms | 41 | 34 | 7 | 7 |
| **5 ms（现值）** | 46 | 36 | **10** | 5 |
| 12 ms | 54 | 39 | 15 | 2 |
| 不设门（∞） | 58 | 41 | 17 | 0 |

## 判定：**维持 5 ms，不放宽**（并给出量化依据）

1. **放宽在任何档位都不改善「接受但坏」**：2 ms→5 ms 只多收 1 个好窗、却多放 3 个坏窗；
   5 ms→12 ms 又多放 5 个坏窗。⇒ **放宽的净收益为负**。
2. **门限不是主要瓶颈**：即便完全不设门，坏窗仍有 **17/58**；
   换言之**「误差」与「双窗不一致」不是同一个量**——该门筛掉的是自相矛盾的测量，
   不是不准确的测量。**这一点修正了 P95b 的原始表述**：它当初被当作「过严」看待，
   实际它**既不严也不松**，而是**测的不是那件事**。
3. **同时暴露一个更该看的量**：坏窗的 `dual` 最小值 **42 µs**、p10 **100 µs** ⇒
   **存在 Δ 极小但误差很大的窗**（与任何容差都无关，5 ms 门放行它们）。
   ⇒ 若将来要更严，正确的方向**不是收紧 Δ**，而是给「误差」找一个**独立**指标
   （例如远窗残差一致性或置信度），这属**新工作**，不在 P95b 范围。

## ⚠️ harness 缺陷（如实登记，按「先怀疑输入」惯例）

本目录 `calibrate_dual_window.py` 的**第一版**在 `window_pcm_args()` 之后**又追加了一组输出参数**，
而该函数**已以 `-f f32le pipe:1` 收尾** ⇒ ffmpeg 产出**两路输出**、stdout 被混合，
使首批读数出现 `dual` 高达 108 ms 的**虚假大值**（与归档 146/208 µs 对不上）。
发现后**用归档用例逐位复现**（ES2004a far@300 ⇒ conf 0.4623 / offset 146 / dual 208.33333333333334，
与 `fix-verification.json` 完全一致）确认解码修正，再重跑全部读数。
⇒ 本目录 JSON **全部来自修正后的解码路径**。

## 复现

```bash
# 需要 .tmp/ami/audio/{meeting}.Array1-01.wav 与 Array2-01.wav（仓外，CC BY 4.0）
PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe evidence/2026-10-14-w21-p95b-dual-window/calibrate_dual_window.py
PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe evidence/2026-10-14-w21-p95b-dual-window/calibrate_against_error.py
```
