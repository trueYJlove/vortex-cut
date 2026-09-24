# W1.2 节拍网格分析（U6）—— Planning Gate

> 起草：LiuWei（架构师），2026-09-24。承接总纲 W1.2；依赖 W0.2（已解除）+ W1.1（可并行）。
> 实施：ZhangSan（Core）；验收：LiuKeAi。分支建议：`ai/w12-beat-grid`。

## 0. 现状走读结论

1. **无 beat/downbeat 实现**（总纲 U6 全缺）。
2. 音频通路已有：`cv_audio_args` / `analyze_audio_energy`（astats RMS）、
   `waveform`（pcm_s16le 解码）。节拍应走 **PCM + 谱通量 onset**，而非 RMS 窗口。
3. **scipy 不可用**（venv 仅 numpy 2.x）——总纲写「numpy/scipy」但环境无 scipy，
   **裁决：纯 numpy**（谱通量 + 自相关估速 + 峰值拾取），不引入 scipy/librosa。
4. 存储范式：照抄 `cv_analyses` 行化 `algorithm_version`（总纲 §8）。
   v23–v25 已占用，节拍表为 **迁移 v26**。

## 1. 范围

### 1.1 必须实现

1. **纯 numpy 节拍检测** `media/beat_grid.py`：
   - PCM → STFT 幅度 → 谱通量 onset envelope；
   - envelope 自相关估 tempo（BPM 60–200，允许 octave 错误的 v1 限制）；
   - 相位对齐 + 峰值拾取 → `beats_us`；
   - v1 **downbeat = 每 4 拍**（4/4 假设，相位取首拍），入 `downbeats_us`。
2. **存储**：迁移 **v26** `beat_grids`（`algorithm_version` 行化 + fingerprint 判 stale）。
3. **服务**：`BeatGridService`——解码 mono PCM（ffmpeg，对齐 waveform）→ 检测 → 落库；
   无音轨/过短 → `status='unavailable'`（**不报错**，规划门验收原文）。
4. **查询面**：`latest_beat_grid(asset_id)` 供 W1.3 卡点规划器使用。
5. **合成 fixture**：已知 BPM/相位 click → BPM 误差门 + beat 命中容差。

### 1.2 明确不做

- 不引入 librosa/scipy。
- 不做复杂拍号（6/8 等）与真实 downbeat 识别（神经/启发式超出 v1）。
- 不做 W1.3 卡点规划器（仅提供网格）。
- 不强制并入 `cv_analysis` job（独立 job kind，降低与 ADR-0005 路径纠缠）。
- 不做 Desktop UI。

## 2. 设计要点

### 2.1 检测口径（冻结）

| 参数 | 默认 | 说明 |
|---|---|---|
| `sr` | 22050 | 解码重采样 |
| `hop` | 512 | STFT hop |
| `n_fft` | 1024 | |
| BPM 范围 | 60–200 | 自相关 lag 窗 |
| beat 命中容差（测） | ±40ms | 合成 fixture |
| BPM 相对误差门（测） | ≤2% | 合成 fixture |

### 2.2 downbeat（v1）

`downbeats_us = beats_us[phase::4]`，`phase∈[0,3]` 取与首强 onset 对齐者。
**文档须写明 4/4 假设**，供 W1.3 使用时知情。

### 2.3 性能门

纯音频解码 + numpy，目标 **< 2s/分钟源**（总纲 §10）。evidence 入库。

## 3. 验收（LiuKeAi）

1. 合成 120 BPM click：BPM 误差 ≤2%；beats 与真值偏差中位 ≤40ms；
2. 无音轨 → `unavailable` 不抛异常；
3. 确定性：同 PCM 两次 beats 逐点相同；
4. 迁移 v26 + stale（fingerprint 变化）；
5. 性能：60s 合成音乐 < 2s（本机）；
6. Core 全量不红。

## 4. 风险

| 风险 | 对策 |
|---|---|
| 无 scipy 精度不足 | 合成 fixture 门 + 后续真实素材误差门（W0.4） |
| octave/tempo 二义 | v1 允许；rationale 记录候选 BPM |
| 与 cv_analysis 路径纠缠 | 独立 job kind |

## 5. 开放问题（已裁决）

1. **依赖 scipy？→ 否**（环境无 scipy，纯 numpy）。
2. **job 独立 vs 并入 cv_analysis → 独立**（降低耦合；W1.3 再汇合）。
3. **downbeat v1 → 4/4 启发式**，不做真实结构分析。
