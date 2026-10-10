"""说话人 embedding 抽取（ONNX，spike 用）。

候选模型输入口径一致：Kaldi 80 维 log-fbank [N, T, 80] → 句级 embedding。
  - 3dspeaker CAM++（zh-cn 16k common）→ 192 维
  - wespeaker ResNet34（zh cn-celeb）→ 256 维
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

from .fbank import compute_fbank


class OnnxSpeakerEmbedder:
    def __init__(self, model_path: str | Path, *, num_threads: int = 1, snip_edges: bool = False):
        so = ort.SessionOptions()
        so.log_severity_level = 3
        so.intra_op_num_threads = num_threads
        so.inter_op_num_threads = 1
        t0 = time.perf_counter()
        self.session = ort.InferenceSession(
            str(model_path), so, providers=["CPUExecutionProvider"]
        )
        self.load_s = time.perf_counter() - t0
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        self.dim = int(self.session.get_outputs()[0].shape[1])
        self.model_path = str(model_path)
        self.snip_edges = snip_edges
        self.infer_s = 0.0
        self.fbank_s = 0.0

    def fbank_of(self, samples: np.ndarray) -> np.ndarray:
        t0 = time.perf_counter()
        fb = compute_fbank(samples, snip_edges=self.snip_edges)
        self.fbank_s += time.perf_counter() - t0
        return fb

    def embed_fbank(self, fbank: np.ndarray) -> np.ndarray:
        batch = fbank[None, :, :].astype(np.float32)
        t0 = time.perf_counter()
        out = self.session.run([self.output_name], {self.input_name: batch})[0]
        self.infer_s += time.perf_counter() - t0
        vec = np.asarray(out, dtype=np.float64).reshape(-1)
        norm = np.linalg.norm(vec)
        return vec / norm if norm > 0 else vec

    def embed_samples(self, samples: np.ndarray) -> np.ndarray:
        return self.embed_fbank(self.fbank_of(samples))


def l2_normalize(mat: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return mat / norms
