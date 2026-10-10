"""能量 VAD + 滑动栅格取窗（spike 用，零依赖）。

口径：帧 RMS(dB) → 噪声底取 10 分位 → 阈值 = 噪声底 + margin，再过绝对静音门。

取窗策略（2026-10-10 修正）：**不在语音段内部取窗**——口播的段间停顿会把语音切得很碎
（实测单素材 25.75s 语音被切成 21 段，段均 1.2s），窗内样本不足使 embedding 噪声化。
改为在整条时间线上按固定栅格滑窗，按**窗内语音帧占比**筛选。这是 diarization 的常规做法。

已知限制（如实记录，不在本 spike 修）：

1. **能量 VAD 分不清"音乐"与"语音"**。它对纯音乐素材之所以"恰好"能拒（173.3s 音乐
   → 0 窗），靠的是**自适应噪声底**（p10 + 12dB 恰好高于音乐中位电平），而不是真的
   识别出非语音。
2. 因此噪声底一旦被**数字静音污染就会崩**——但**触发面比初判窄**（2026-10-10 评审修正）：
   实测需要**数字静音帧占比 ≳10%**（9.1% 已崩）。例：把 173.3s 音乐首尾各 8s 拼上 0.5s 数字静音
   （约 3.1% 且该素材自带静音段）后 p10 由 −30.4 → −120 dB，阈值被绝对门钳到 −55 dB，
   音乐 85.6% 的帧被判"有声"（14 个语音窗）；但同一 0.5s 静音拼到完整 173.3s 音乐上
   p10 只掉 0.15 dB，而 `lecture` 素材本身含 5.5% 数字静音、p10 仍是 −59 dB。
   ⇒ 根因是**"用分位数估噪声底"不稳**，
   而非某个特定静音时长。**真正稳的判定需要分割模型**——这本身是选型成本的一部分。

用它的理由：本 spike 要测的是"embedding + 聚类"这段链路，不是 VAD 质量；
把 VAD 做成产品级会把选型问题（DEC-3）和分割模型问题混在一起。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

_EPS = 1e-12


@dataclass(frozen=True)
class Region:
    start_s: float
    end_s: float

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s


@dataclass(frozen=True)
class Window:
    start_s: float
    end_s: float
    speech_fraction: float


def frame_db(
    samples: np.ndarray, sr: int = 16000, frame_ms: float = 25.0, hop_ms: float = 10.0
) -> np.ndarray:
    frame = int(sr * frame_ms / 1000.0)
    hop = int(sr * hop_ms / 1000.0)
    if samples.shape[0] < frame:
        return np.zeros(0, dtype=np.float64)
    n = 1 + (samples.shape[0] - frame) // hop
    idx = np.arange(n)[:, None] * hop + np.arange(frame)[None, :]
    rms = np.sqrt(np.mean(samples[idx] ** 2, axis=1) + _EPS)
    return 20.0 * np.log10(rms + _EPS)


def voiced_mask(
    samples: np.ndarray,
    sr: int = 16000,
    *,
    hop_ms: float = 10.0,
    margin_db: float = 12.0,
    absolute_floor_db: float = -55.0,
) -> tuple[np.ndarray, np.ndarray]:
    """返回 (帧 dB, 帧 voiced 布尔)。"""
    db = frame_db(samples, sr, hop_ms=hop_ms)
    if db.size == 0:
        return db, np.zeros(0, dtype=bool)
    noise = float(np.percentile(db, 10))
    thr = max(noise + margin_db, absolute_floor_db)
    return db, db > thr


def speech_regions(
    samples: np.ndarray,
    sr: int = 16000,
    *,
    hop_ms: float = 10.0,
    margin_db: float = 12.0,
    absolute_floor_db: float = -55.0,
    min_speech_s: float = 0.30,
    min_gap_s: float = 0.25,
    pad_s: float = 0.10,
) -> list[Region]:
    """仅用于"该素材有多少语音"的统计描述，不用于取窗。"""
    db, voiced = voiced_mask(
        samples, sr, hop_ms=hop_ms, margin_db=margin_db, absolute_floor_db=absolute_floor_db
    )
    if db.size == 0 or not voiced.any():
        return []
    hop_s = hop_ms / 1000.0
    raw: list[Region] = []
    start = None
    for i, flag in enumerate(voiced):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            raw.append(Region(start * hop_s, i * hop_s))
            start = None
    if start is not None:
        raw.append(Region(start * hop_s, db.size * hop_s))

    merged: list[Region] = []
    for r in raw:
        if merged and r.start_s - merged[-1].end_s < min_gap_s:
            merged[-1] = Region(merged[-1].start_s, r.end_s)
        else:
            merged.append(r)

    total_s = samples.shape[0] / sr
    kept = []
    for r in merged:
        if r.duration_s < min_speech_s:
            continue
        kept.append(Region(max(0.0, r.start_s - pad_s), min(total_s, r.end_s + pad_s)))
    return kept


def sliding_windows(
    samples: np.ndarray,
    sr: int = 16000,
    *,
    window_s: float = 2.0,
    hop_s: float = 1.0,
    min_speech_fraction: float = 0.60,
    hop_ms: float = 10.0,
    margin_db: float = 12.0,
    absolute_floor_db: float = -55.0,
) -> list[Window]:
    """整条时间线上固定栅格滑窗，按窗内语音帧占比筛选。"""
    db, voiced = voiced_mask(
        samples, sr, hop_ms=hop_ms, margin_db=margin_db, absolute_floor_db=absolute_floor_db
    )
    total_s = samples.shape[0] / sr
    if db.size == 0 or total_s < window_s:
        return []
    frame_hop_s = hop_ms / 1000.0
    win_frames = max(1, int(round(window_s / frame_hop_s)))
    hop_frames = max(1, int(round(hop_s / frame_hop_s)))

    out: list[Window] = []
    i = 0
    while i + win_frames <= voiced.size:
        frac = float(voiced[i : i + win_frames].mean())
        if frac >= min_speech_fraction:
            start_s = i * frame_hop_s
            out.append(Window(start_s, start_s + window_s, frac))
        i += hop_frames
    return out
