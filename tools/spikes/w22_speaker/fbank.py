"""Kaldi 兼容 80 维 log-fbank（纯 numpy 实现）。

为什么自己写：生产端有两个选项——①引入 `kaldi-native-fbank`（Apache-2.0，301KB 轮子，
但是 C++ 扩展，进 PyInstaller 打包面）；②纯 numpy（零新依赖，但必须证明与 Kaldi 逐值等价）。
本文件是 ② 的实现，由 `validate_fbank.py` 对拍 ①（knf 即 sherpa-onnx 使用的同一实现）。

对应 Kaldi 源码：feature-window.cc（分帧/反射/预加重/窗）、feature-functions.cc
（功率谱）、mel-computations.cc（MelBanks）。默认口径取 Kaldi 缺省：
povey 窗、remove_dc_offset、preemph 0.97、low_freq=20、high_freq=0(=Nyquist)、
HTK mel 标度、log 前钳到 float epsilon。
"""

from __future__ import annotations

import numpy as np

_FLOAT_EPS = float(np.finfo(np.float32).eps)


def mel_scale(freq):
    """HTK mel 标度（Kaldi MelScale 默认 htk_mode=false 即 HTK 公式）。"""
    return 1127.0 * np.log(1.0 + np.asarray(freq, dtype=np.float64) / 700.0)


def mel_filterbank(
    num_bins: int = 80,
    sample_freq: float = 16000.0,
    padded_window_size: int = 512,
    low_freq: float = 20.0,
    high_freq: float = 0.0,
) -> np.ndarray:
    """Kaldi MelBanks 等价权重矩阵，形状 (num_fft_bins, num_bins)。"""
    nyquist = 0.5 * sample_freq
    high = high_freq if high_freq > 0.0 else nyquist + high_freq
    num_fft_bins = padded_window_size // 2
    fft_bin_width = sample_freq / padded_window_size

    mel_low = float(mel_scale(low_freq))
    mel_high = float(mel_scale(high))
    delta = (mel_high - mel_low) / (num_bins + 1)

    bin_freqs = fft_bin_width * np.arange(num_fft_bins, dtype=np.float64)
    bin_mels = mel_scale(bin_freqs)

    weights = np.zeros((num_fft_bins, num_bins), dtype=np.float64)
    for b in range(num_bins):
        left = mel_low + b * delta
        center = mel_low + (b + 1) * delta
        right = mel_low + (b + 2) * delta
        inside = (bin_mels > left) & (bin_mels < right)
        if not inside.any():
            continue
        m = bin_mels[inside]
        up = (m - left) / (center - left)
        down = (right - m) / (right - center)
        weights[inside, b] = np.where(m <= center, up, down)
    return weights


def _frame_starts(
    num_samples: int, frame_length: int, frame_shift: int, snip_edges: bool
) -> np.ndarray:
    if snip_edges:
        if num_samples < frame_length:
            return np.zeros(0, dtype=np.int64)
        num_frames = 1 + (num_samples - frame_length) // frame_shift
    else:
        num_frames = (num_samples + frame_shift // 2) // frame_shift
    idx = np.arange(num_frames, dtype=np.int64) * frame_shift
    if not snip_edges:
        idx = idx + (frame_shift // 2) - (frame_length // 2)
    return idx


def _reflect(idx: np.ndarray, num_samples: int) -> np.ndarray:
    """Kaldi ExtractWindow 的 while-反射（处理比窗还短的波形）。"""
    idx = idx.copy()
    for _ in range(16):
        neg = idx < 0
        over = idx >= num_samples
        if not neg.any() and not over.any():
            return idx
        idx = np.where(neg, -idx - 1, idx)
        idx = np.where(idx >= num_samples, 2 * num_samples - 1 - idx, idx)
    raise ValueError("reflection did not converge")


def compute_fbank(
    samples,
    sample_rate: float = 16000.0,
    num_bins: int = 80,
    frame_length_ms: float = 25.0,
    frame_shift_ms: float = 10.0,
    snip_edges: bool = False,
    remove_dc_offset: bool = True,
    preemph_coeff: float = 0.97,
    window_type: str = "povey",
    low_freq: float = 20.0,
    high_freq: float = 0.0,
    round_to_power_of_two: bool = True,
) -> np.ndarray:
    """返回 (num_frames, num_bins) 的 log-fbank。"""
    x = np.asarray(samples, dtype=np.float64).reshape(-1)
    n = x.shape[0]
    frame_length = int(round(sample_rate * frame_length_ms / 1000.0))
    frame_shift = int(round(sample_rate * frame_shift_ms / 1000.0))
    padded = 1
    if round_to_power_of_two:
        while padded < frame_length:
            padded *= 2
    else:
        padded = frame_length
    if n == 0:
        return np.zeros((0, num_bins), dtype=np.float64)

    starts = _frame_starts(n, frame_length, frame_shift, snip_edges)
    if starts.size == 0:
        return np.zeros((0, num_bins), dtype=np.float64)

    idx = _reflect(starts[:, None] + np.arange(frame_length, dtype=np.int64)[None, :], n)
    frames = x[idx]

    if remove_dc_offset:
        frames = frames - frames.mean(axis=1, keepdims=True)

    if preemph_coeff != 0.0:
        out = np.empty_like(frames)
        out[:, 0] = frames[:, 0] * (1.0 - preemph_coeff)
        out[:, 1:] = frames[:, 1:] - preemph_coeff * frames[:, :-1]
        frames = out

    i = np.arange(frame_length, dtype=np.float64)
    if window_type == "povey":
        w = np.power(0.5 - 0.5 * np.cos(i * 2.0 * np.pi / (frame_length - 1)), 0.85)
    elif window_type == "hamming":
        w = 0.54 - 0.46 * np.cos(i * 2.0 * np.pi / (frame_length - 1))
    elif window_type == "hanning":
        w = 0.5 - 0.5 * np.cos(i * 2.0 * np.pi / (frame_length - 1))
    else:
        raise ValueError(f"unsupported window_type: {window_type}")
    frames = frames * w

    if padded > frame_length:
        frames = np.pad(frames, ((0, 0), (0, padded - frame_length)))

    spec = np.fft.rfft(frames, n=padded, axis=1)
    power = spec.real**2 + spec.imag**2
    power = power[:, : padded // 2]  # Kaldi num_fft_bins = padded/2（不含 Nyquist）

    mel = power @ mel_filterbank(num_bins, sample_rate, padded, low_freq, high_freq)
    mel = np.maximum(mel, _FLOAT_EPS)
    return np.log(mel)
