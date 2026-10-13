"""W2.2 说话人分离 —— VAD 层（**随包 Silero VAD**，O1 交付件）。

Design Gate §1/§4 冻结：VAD 用**随包 Silero v6**（`faster_whisper` 自带资产），
**不自研、不用能量 VAD**（能量 VAD 在任何调用路径上都被排除：P90 证明它在
数字静音占比 ≳10% 时噪声底崩塌、把音乐判成语音；P98 证明它在远场阵列上
漏检 75.9–96.1%）。

## 为什么需要这个模块（O1，复核提出的「风险高于初判」）

`get_assets_path` / `get_vad_model` **都不在 `faster_whisper.__all__`**，属私有面。
当前版本 1.2.1 可用，但上游一旦移除，导入期就会炸。故本模块把该耦合**收在一个
可测的入口**里，并把它变成**可测的失败分支**：

- 资产探测（`silero_asset_path()`）不抛异常，只返回 `None`；
- 服务层据此落 `unavailable(silero_asset_missing)`，**不是静默降级**（D4：任何
  未取证的能量 VAD 兜底都不允许）；
- 走「延迟 import」，使"faster_whisper 不存在/已移除"只影响 VAD 而**不影响
  Core 其余部分导入**。

## 与冻结参数的关系（不要混用两个"阈值"）

- `DEFAULT_VAD_THRESHOLD = 0.5`：**Silero 逐块语音概率**的判决阈值（§4 冻结；
  改它必须重测精度门——spike §2.9 已证最优 τ 随 VAD 条件变）。
- `min_speech_fraction = 0.60`：**窗级语音占比**筛选（在 `speaker.select_windows`），
  与上面那个完全是两件事。
"""

from __future__ import annotations

import importlib
import importlib.util
from pathlib import Path

import numpy as np

# Silero v6 口径：36 ms @16 kHz。v5 是 512，**不要混**。
CHUNK = 576
SAMPLE_RATE = 16000
HOP_MS = 10.0
DEFAULT_VAD_THRESHOLD = 0.5
SILERO_ASSET_NAME = "silero_vad_v6.onnx"
VAD_MODEL_ID = "silero_vad_v6"
FASTER_WHISPER_MIN = (1, 2, 1)


class SileroAssetMissing(RuntimeError):
    """随包 Silero 资产缺失/上游移除（→ 服务层落 unavailable(silero_asset_missing)）。"""


def faster_whisper_version() -> str | None:
    """已安装的 faster-whisper 版本（未安装返回 None，不抛）。"""
    if importlib.util.find_spec("faster_whisper") is None:
        return None
    try:
        module = importlib.import_module("faster_whisper")
    except Exception:
        return None
    return str(getattr(module, "__version__", "") or "") or None


def silero_asset_path() -> Path | None:
    """定位随包 Silero v6 资产；**缺失返回 None，不抛**（O1 的可测探测分支）。"""
    if importlib.util.find_spec("faster_whisper") is None:
        return None
    try:
        utils = importlib.import_module("faster_whisper.utils")
        assets = Path(utils.get_assets_path())
    except Exception:
        return None
    candidate = assets / SILERO_ASSET_NAME
    return candidate if candidate.is_file() else None


def require_silero_asset_path() -> Path:
    path = silero_asset_path()
    if path is None:
        raise SileroAssetMissing("随包 Silero 资产缺失")
    return path


class SileroVoiceActivity:
    """Silero v6 会话包装（进程内复用；块间**不重叠**、状态递推）。"""

    def __init__(self, model_path: str | Path, *, num_threads: int = 1) -> None:
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.log_severity_level = 3
        options.intra_op_num_threads = num_threads
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(model_path), options, providers=["CPUExecutionProvider"]
        )
        self.model_path = str(model_path)

    def chunk_probs(self, samples: np.ndarray) -> np.ndarray:
        """每 36 ms 块的语音概率。"""
        x = np.asarray(samples, dtype=np.float32).reshape(-1)
        h = np.zeros((1, 1, 128), dtype=np.float32)
        c = np.zeros((1, 1, 128), dtype=np.float32)
        out: list[float] = []
        for i in range(0, x.shape[0] - CHUNK + 1, CHUNK):
            result = self.session.run(
                None, {"input": x[i : i + CHUNK][None, :], "h": h, "c": c}
            )
            out.append(float(np.asarray(result[0]).ravel()[0]))
            h, c = result[1], result[2]
        return np.asarray(out, dtype=np.float64)

    def voiced_10ms(
        self,
        samples: np.ndarray,
        *,
        threshold: float = DEFAULT_VAD_THRESHOLD,
        hop_ms: float = HOP_MS,
    ) -> np.ndarray:
        """展平成 10 ms 栅格的 voiced 布尔（与 `speaker.window_grid` 同一时间栅格）。"""
        x = np.asarray(samples, dtype=np.float32).reshape(-1)
        n_frames = int(np.ceil(x.shape[0] / SAMPLE_RATE / (hop_ms / 1000.0)))
        voiced = np.zeros(max(n_frames, 0), dtype=bool)
        probs = self.chunk_probs(x)
        frames_per_chunk = CHUNK / (SAMPLE_RATE * hop_ms / 1000.0)  # 3.6 帧/块
        for k, prob in enumerate(probs):
            if prob < threshold:
                continue
            a = int(round(k * frames_per_chunk))
            b = min(int(round((k + 1) * frames_per_chunk)), n_frames)
            if b > a:
                voiced[a:b] = True
        return voiced


def voiced_mask_10ms(
    samples: np.ndarray,
    *,
    session: SileroVoiceActivity,
    threshold: float = DEFAULT_VAD_THRESHOLD,
    hop_ms: float = HOP_MS,
) -> np.ndarray:
    """Design Gate §1 冻结的入口名：`voiced_mask_10ms`。"""
    return session.voiced_10ms(samples, threshold=threshold, hop_ms=hop_ms)
