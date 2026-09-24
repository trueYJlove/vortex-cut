"""W1.2 节拍网格：纯 numpy onset → tempo → beat tracking（无 scipy/librosa）。"""

from __future__ import annotations

from typing import Any

import numpy as np

BEAT_ALGORITHM_VERSION = 1
DEFAULT_SR = 22050
DEFAULT_HOP = 512
DEFAULT_N_FFT = 1024
MIN_BPM = 60.0
MAX_BPM = 200.0


def spectral_flux_onset_envelope(
    pcm: np.ndarray,
    *,
    sr: int = DEFAULT_SR,
    hop: int = DEFAULT_HOP,
    n_fft: int = DEFAULT_N_FFT,
) -> tuple[np.ndarray, float]:
    """返回 (onset_envelope, envelope_frame_rate)。pcm 为 float mono [-1,1]。"""
    if pcm.size < n_fft:
        return np.zeros(0, dtype=np.float64), sr / hop
    # 帧数
    n_frames = 1 + (pcm.size - n_fft) // hop
    window = np.hanning(n_fft)
    spec = np.empty((n_frames, n_fft // 2 + 1), dtype=np.float64)
    for i in range(n_frames):
        frame = pcm[i * hop : i * hop + n_fft] * window
        mag = np.abs(np.fft.rfft(frame))
        spec[i] = mag
    flux = np.diff(spec, axis=0, prepend=spec[:1])
    onset = np.maximum(flux, 0.0).sum(axis=1)
    if onset.max() > 0:
        onset = onset / onset.max()
    return onset, sr / hop


def estimate_tempo_bpm(
    onset: np.ndarray,
    frame_rate: float,
    *,
    min_bpm: float = MIN_BPM,
    max_bpm: float = MAX_BPM,
) -> dict[str, Any]:
    """onset 自相关估速。返回 bpm、lag_s、confidence、candidates。"""
    if onset.size < 8:
        return {
            "bpm": None,
            "lag_s": None,
            "confidence": 0.0,
            "candidates": [],
        }
    env = onset - onset.mean()
    n = env.size
    ac = np.correlate(env, env, mode="full")[n - 1 :]
    ac = ac / (ac[0] + 1e-12)
    min_lag = max(1, int(round(60.0 / max_bpm * frame_rate)))
    max_lag = min(n - 1, int(round(60.0 / min_bpm * frame_rate)))
    if max_lag <= min_lag:
        return {
            "bpm": None,
            "lag_s": None,
            "confidence": 0.0,
            "candidates": [],
        }
    segment = ac[min_lag : max_lag + 1]
    # 拍速先验：偏好 90–160 BPM，抑制半倍速（octave）误锁。
    lags = np.arange(min_lag, max_lag + 1)
    bpms = 60.0 * frame_rate / np.maximum(lags, 1)
    prior = np.exp(-0.5 * ((bpms - 120.0) / 35.0) ** 2)
    score = segment * (0.35 + 0.65 * prior)
    peak_idx = int(np.argmax(score))
    lag = int(min_lag + peak_idx)
    # 倍速校正：若 lag 过长（bpm 偏低）且半 lag 能量仍强，改半 lag（更高 BPM）
    for half in (lag // 2, lag // 3):
        if half >= min_lag and ac[half] >= 0.75 * ac[lag]:
            lag = int(half)
            break
    # 抛物线插值细化 lag（帧率 ~43Hz，整数 lag 会带来 >2% BPM 误差）
    lag_f = float(lag)
    if min_lag < lag < max_lag:
        a, b, c = float(ac[lag - 1]), float(ac[lag]), float(ac[lag + 1])
        denom = a - 2 * b + c
        if abs(denom) > 1e-12:
            lag_f = lag + 0.5 * (a - c) / denom
    candidates: list[dict[str, Any]] = []
    for i in range(1, len(segment) - 1):
        if segment[i] >= segment[i - 1] and segment[i] >= segment[i + 1] and segment[i] > 0:
            cand_lag = min_lag + i
            candidates.append(
                {
                    "bpm": 60.0 * frame_rate / cand_lag,
                    "lag_s": cand_lag / frame_rate,
                    "strength": float(segment[i]),
                }
            )
    candidates.sort(key=lambda c: -c["strength"])
    bpm = 60.0 * frame_rate / max(lag_f, 1e-6)
    return {
        "bpm": float(bpm),
        "lag_s": float(lag_f) / frame_rate,
        "confidence": float(ac[lag]),
        "candidates": candidates[:5],
    }


def track_beats(
    onset: np.ndarray,
    frame_rate: float,
    lag_s: float,
    *,
    phase_search_s: float = 0.5,
) -> list[int]:
    """给定 tempo lag，网格相位搜索最小 onset 代价，返回 beat 时间戳（微秒）。"""
    if onset.size == 0 or lag_s <= 0:
        return []
    lag_frames = lag_s * frame_rate
    best_phase = 0.0
    best_score = -1.0
    steps = max(1, int(phase_search_s * frame_rate))
    for phase in np.linspace(0.0, lag_frames, num=min(steps, 64), endpoint=False):
        score = 0.0
        t = phase
        while t < onset.size:
            idx = int(round(t))
            if 0 <= idx < onset.size:
                score += float(onset[idx])
            t += lag_frames
        if score > best_score:
            best_score = score
            best_phase = float(phase)
    beats_us: list[int] = []
    t = best_phase
    while t < onset.size:
        idx = int(round(t))
        if 0 <= idx < onset.size:
            beats_us.append(int(round(idx / frame_rate * 1_000_000)))
        t += lag_frames
    return beats_us


def downbeats_from_beats(beats_us: list[int], phase: int = 0) -> list[int]:
    """v1：4/4，每 4 拍一个 downbeat（规划门 §2.2）。"""
    phase = int(phase) % 4
    return list(beats_us[phase::4])


def analyze_pcm(
    pcm: np.ndarray,
    *,
    sr: int = DEFAULT_SR,
    hop: int = DEFAULT_HOP,
    n_fft: int = DEFAULT_N_FFT,
) -> dict[str, Any]:
    """端到端纯函数：PCM → beat grid 文档。"""
    pcm = np.asarray(pcm, dtype=np.float64).reshape(-1)
    if pcm.size == 0 or float(np.max(np.abs(pcm))) <= 1e-8:
        return {
            "algorithm_version": BEAT_ALGORITHM_VERSION,
            "status": "unavailable",
            "reason": "no_audio_or_silent",
            "bpm": None,
            "beats_us": [],
            "downbeats_us": [],
            "duration_us": 0,
        }
    duration_us = int(round(pcm.size / sr * 1_000_000))
    onset, frame_rate = spectral_flux_onset_envelope(
        pcm, sr=sr, hop=hop, n_fft=n_fft
    )
    tempo = estimate_tempo_bpm(onset, frame_rate)
    if not tempo["bpm"] or not tempo["lag_s"]:
        return {
            "algorithm_version": BEAT_ALGORITHM_VERSION,
            "status": "unavailable",
            "reason": "tempo_unresolved",
            "bpm": None,
            "beats_us": [],
            "downbeats_us": [],
            "duration_us": duration_us,
        }
    beats_us = track_beats(onset, frame_rate, tempo["lag_s"])
    return {
        "algorithm_version": BEAT_ALGORITHM_VERSION,
        "status": "ready",
        "reason": None,
        "bpm": tempo["bpm"],
        "lag_s": tempo["lag_s"],
        "confidence": tempo["confidence"],
        "candidates": tempo["candidates"],
        "beats_us": beats_us,
        "downbeats_us": downbeats_from_beats(beats_us),
        "duration_us": duration_us,
        "params": {
            "sr": sr,
            "hop": hop,
            "n_fft": n_fft,
            "min_bpm": MIN_BPM,
            "max_bpm": MAX_BPM,
        },
    }


def synthesize_click_pcm(
    *,
    bpm: float,
    duration_s: float,
    sr: int = DEFAULT_SR,
    phase_s: float = 0.0,
    click_s: float = 0.01,
) -> tuple[np.ndarray, list[int]]:
    """测试用 click track：返回 (pcm, 真值 beats_us)。"""
    n = int(duration_s * sr)
    pcm = np.zeros(n, dtype=np.float64)
    interval_s = 60.0 / bpm
    beats_us: list[int] = []
    t = phase_s
    while t < duration_s:
        start = int(t * sr)
        length = int(click_s * sr)
        end = min(n, start + length)
        if start < n:
            # 短正弦 click
            click_t = np.arange(end - start) / sr
            pcm[start:end] += 0.8 * np.sin(2 * np.pi * 1000.0 * click_t)
            beats_us.append(int(round(t * 1_000_000)))
        t += interval_s
    return pcm, beats_us
