"""W2.2 说话人分离 —— 前端 + embedding 模型（**ONNX**）。

Design Gate §1 把这两件事与纯函数算法同列（原文「同上（`SpeakerEmbedder`）」）。
S2 实施时**把它们落到独立模块**，以免污染 `speaker.py` 的纯函数契约
（其单测不引入 ONNX/DB 依赖）。**签名与 §2 冻结一致**，该偏离已回写门文档。

## 前端为什么是"自己写"的

模型要 **Kaldi 80 维 log-fbank**，前端写错则全部数字无意义。两条路线：
① `kaldi-native-fbank`（sherpa-onnx 同款，但是 C++ 扩展，进 PyInstaller 打包面）；
② 纯 numpy。spike §2.5 已实测两者**逐值等价**（max |Δ| 1.7e-3、均值 5.3e-6，log 域
量级 6.07），且**负向对照 5/5 全部被抓出**（注入 mel 标度/预加重/窗函数/分帧口径/
去直流五组缺陷，Δ=4.9–13.7 vs 绝对门 0.1）⇒ 本模块采用 ②，**零新增依赖、不引入
C++ 扩展**。

口径取 Kaldi 缺省：povey 窗、remove_dc_offset、preemph 0.97、low_freq=20、
high_freq=0(=Nyquist)、HTK mel 标度、log 前钳到 float epsilon、`snip_edges=False`。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

_FLOAT_EPS = float(np.finfo(np.float32).eps)


# ---------------------------------------------------------------- Kaldi fbank


def mel_scale(freq: np.ndarray | float) -> np.ndarray:
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
    samples: np.ndarray,
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


# ---------------------------------------------------------------- ONNX embedding

EMBEDDING_DIM_FALLBACK = 192
EMBEDDING_MODEL_FILE = "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"
EMBEDDING_MODEL_ID = "campplus-speaker-embedding"


class SpeakerEmbedder:
    """CAM++ 会话包装：fbank → ONNX → L2 归一化 embedding。"""

    def __init__(self, model_path: str | Path, *, num_threads: int = 1) -> None:
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.log_severity_level = 3
        options.intra_op_num_threads = num_threads
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(model_path), options, providers=["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        shape = self.session.get_outputs()[0].shape
        dim = shape[1] if len(shape) > 1 and isinstance(shape[1], int) else None
        self.dim = int(dim or EMBEDDING_DIM_FALLBACK)
        self.model_path = str(model_path)

    @property
    def model_file(self) -> str:
        return Path(self.model_path).name

    def fbank_of(self, samples: np.ndarray) -> np.ndarray:
        return compute_fbank(samples, snip_edges=False)

    def embed_fbank(self, fbank: np.ndarray) -> np.ndarray:
        batch = np.asarray(fbank, dtype=np.float32)[None, :, :]
        out = self.session.run([self.output_name], {self.input_name: batch})[0]
        vec = np.asarray(out, dtype=np.float64).reshape(-1)
        norm = float(np.linalg.norm(vec))
        return vec / norm if norm > 0 else vec

    def embed(self, samples: np.ndarray) -> np.ndarray:
        """冻结签名：L2 归一化后的 (dim,) 向量。"""
        return self.embed_fbank(self.fbank_of(samples))
