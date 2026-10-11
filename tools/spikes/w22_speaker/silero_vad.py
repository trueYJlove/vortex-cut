"""Silero VAD v6（spike 用）——**复用项目已随包分发的模型，零新增下载**。

模型来源：`faster_whisper/assets/silero_vad_v6.onnx`（faster-whisper 自带，
且已在打包产物 `resources/core/aivs-core/_internal/faster_whisper/assets/` 内）
⇒ 若 W2.2 立项，**不需要新的模型分发通道**，这是"折中方案"相对 pyannote 分割模型的实质优势。

接口（实测）：输入 `input [seq_len, 576]`（36 ms @16k）、`h [1,1,128]`、`c [1,1,128]`；
输出 `speech_probs`、`hn`、`cn`。块间**不重叠**，状态递推。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import onnxruntime as ort

CHUNK = 576  # 36 ms @ 16 kHz（v6 口径；v5 是 512，别混）


class SileroVad:
    def __init__(self, model_path: str | Path, *, num_threads: int = 1):
        so = ort.SessionOptions()
        so.log_severity_level = 3
        so.intra_op_num_threads = num_threads
        self.session = ort.InferenceSession(
            str(model_path), so, providers=["CPUExecutionProvider"]
        )

    def chunk_probs(self, samples: np.ndarray) -> np.ndarray:
        """返回每 36 ms 块的语音概率。"""
        x = np.asarray(samples, dtype=np.float32).reshape(-1)
        h = np.zeros((1, 1, 128), dtype=np.float32)
        c = np.zeros((1, 1, 128), dtype=np.float32)
        out: list[float] = []
        for i in range(0, x.shape[0] - CHUNK + 1, CHUNK):
            res = self.session.run(
                None, {"input": x[i : i + CHUNK][None, :], "h": h, "c": c}
            )
            out.append(float(np.asarray(res[0]).ravel()[0]))
            h, c = res[1], res[2]
        return np.asarray(out, dtype=np.float64)

    def voiced_10ms(
        self, samples: np.ndarray, *, hop_ms: float = 10.0, threshold: float = 0.5
    ) -> np.ndarray:
        """展平成 10 ms 帧的 voiced 布尔（与本 spike 其余部分同一时间栅格）。"""
        probs = self.chunk_probs(samples)
        n_frames = int(np.ceil(samples.shape[0] / 16000.0 / (hop_ms / 1000.0)))
        voiced = np.zeros(n_frames, dtype=bool)
        chunk_frames = CHUNK / (16000.0 * hop_ms / 1000.0)  # 3.6 帧/块
        for k, p in enumerate(probs):
            a = int(round(k * chunk_frames))
            b = int(round((k + 1) * chunk_frames))
            if p >= threshold:
                voiced[a:min(b, n_frames)] = True
        return voiced
