"""C-轻候选：**无模型**的说话人特征（spike 用）。

对应 DEC-3 选项 (b)「声纹聚类 + 能量主导」的无模型下限版本：
MFCC（对数梅尔经 DCT）+ Δ + ΔΔ → 逐窗取均值与标准差 → L2 归一化 → 与 C-折中同一套聚类。

**实现边界（如实）**：
- 这是**朴素基线**，不是 (b) 的完整形态。真正的 (b) 还需要 i-vector/x-vector 训练或声纹库校准，
  而"训练"本身又是一笔成本（数据 + 训练链）。本文件给的是"零成本下限"。
- 若连这个下限都明显更差，说明**要么投入训练成本、要么走预训练 embedding**——
  这正是 spike 要回答的问题；反过来若下限够用，(b) 的吸引力才成立。
"""

from __future__ import annotations

import time

import numpy as np

from .fbank import compute_fbank

N_MFCC = 24
N_DELTA = 2


def _dct_matrix(n_out: int, n_in: int) -> np.ndarray:
    k = np.arange(n_out)[:, None]
    n = np.arange(n_in)[None, :]
    mat = np.cos(np.pi * k * (2 * n + 1) / (2 * n_in)) * np.sqrt(2.0 / n_in)
    mat[0] *= np.sqrt(0.5)
    return mat


def _deltas(x: np.ndarray, n: int = N_DELTA) -> np.ndarray:
    denom = 2 * sum(i * i for i in range(1, n + 1))
    padded = np.pad(x, ((n, n), (0, 0)), mode="edge")
    out = np.zeros_like(x)
    for i in range(1, n + 1):
        out += i * (padded[n + i : n + i + x.shape[0]] - padded[n - i : n - i + x.shape[0]])
    return out / denom


class LightStatsEmbedder:
    """与 OnnxSpeakerEmbedder 同接口，便于直接替换。"""

    def __init__(self, *, snip_edges: bool = False, num_bins: int = 80):
        self.dim = N_MFCC * 3 * 2  # 静态 + Δ + ΔΔ，各取均值与标准差
        self.snip_edges = snip_edges
        self.num_bins = num_bins
        self.load_s = 0.0
        self.infer_s = 0.0
        self.fbank_s = 0.0
        self._dct = _dct_matrix(N_MFCC, num_bins)

    def _features(self, samples: np.ndarray) -> np.ndarray:
        fb = compute_fbank(samples, num_bins=self.num_bins, snip_edges=self.snip_edges)
        if fb.shape[0] == 0:
            return np.zeros(self.dim, dtype=np.float64)
        mfcc = (self._dct @ fb.T).T  # (T, N_MFCC)
        d1 = _deltas(mfcc)
        d2 = _deltas(d1)
        stacked = np.concatenate([mfcc, d1, d2], axis=1)  # (T, 3*N_MFCC)
        vec = np.concatenate([stacked.mean(axis=0), stacked.std(axis=0)])
        return vec

    def embed_samples(self, samples: np.ndarray) -> np.ndarray:
        t0 = time.perf_counter()
        vec = self._features(samples)
        self.infer_s += time.perf_counter() - t0
        norm = float(np.linalg.norm(vec))
        return vec / norm if norm > 0 else vec
