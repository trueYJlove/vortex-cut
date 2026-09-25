"""L/J 词戳来源：优先 faster-whisper 词级时间戳，否则能量伪词代理。

与生产转录同运行时（`faster_whisper.WhisperModel`）。模型未安装/无词/失败时
回退能量代理——**预测文件必须记录 `word_source`**，禁止静默混用。
"""

from __future__ import annotations

import importlib
import importlib.util
import wave
from pathlib import Path
from typing import Any

import numpy as np

WORD_CHUNK_US = 400_000

# 产品模型根（Desktop data-v2）；仓库本地 .aivideo 作备用。
_DEFAULT_MODEL_ROOTS = (
    Path.home() / "AppData" / "Roaming" / "@aivideo" / "desktop" / "data-v2" / "models" / "asr",
    Path.home() / "AppData" / "Roaming" / "aivideo" / "desktop" / "data-v2" / "models" / "asr",
)


def discover_asr_model_dir(model_id: str = "faster-whisper-tiny") -> Path | None:
    """定位已就绪的 ASR 模型目录（含 config.json / model.bin 的 revision 子目录）。"""
    roots = list(_DEFAULT_MODEL_ROOTS)
    cwd_root = Path.cwd() / ".aivideo" / "models" / "asr"
    roots.append(cwd_root)
    roots.append(Path(__file__).resolve().parents[2] / ".aivideo" / "models" / "asr")
    for root in roots:
        base = root / model_id
        if not base.is_dir():
            continue
        for child in sorted(base.iterdir()):
            if child.is_dir() and (child / "model.bin").is_file() and (child / "config.json").is_file():
                return child
        # 兼容直接平铺
        if (base / "model.bin").is_file() and (base / "config.json").is_file():
            return base
    return None


def _wav_pcm(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "r") as wav:
        raw = wav.readframes(wav.getnframes())
        ints = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
        if wav.getnchannels() > 1:
            ints = ints.reshape(-1, wav.getnchannels()).mean(axis=1)
        return ints, wav.getframerate()


def energy_words_from_pcm(pcm: np.ndarray, sr: int) -> list[dict[str, Any]]:
    """能量有声段切分为伪词（ASR 不可用时的代理）。"""
    if sr <= 0 or pcm.size == 0:
        return []
    win = max(int(sr * 0.05), 1)
    hop = win
    energies: list[tuple[int, float]] = []
    for i in range(0, max(len(pcm) - win + 1, 0), hop):
        chunk = pcm[i : i + win]
        energies.append((int(i / sr * 1_000_000), float(np.sqrt(np.mean(chunk**2)))))
    if not energies:
        return []
    threshold = 0.05
    runs: list[tuple[int, int]] = []
    run_start: int | None = None
    last = 0
    for ts, e in energies:
        if e > threshold:
            if run_start is None:
                run_start = ts
            last = ts
        elif run_start is not None:
            runs.append((run_start, last + 50_000))
            run_start = None
    if run_start is not None:
        runs.append((run_start, last + 50_000))
    words: list[dict[str, Any]] = []
    for start, end in runs:
        t = start
        while t < end:
            t_end = min(t + WORD_CHUNK_US, end)
            words.append({"start_us": t, "end_us": t_end, "text": ""})
            t = t_end
    return words


def asr_words_from_media(
    media: Path,
    *,
    model_dir: Path | None = None,
    language: str = "auto",
) -> list[dict[str, Any]]:
    """faster-whisper 词级时间戳。运行时/模型/结果任一不可用 → 空列表。"""
    audio = media if media.suffix.lower() == ".wav" else media.with_suffix(".wav")
    if not audio.is_file():
        return []
    try:
        spec_ok = importlib.util.find_spec("faster_whisper") is not None
    except (ValueError, ModuleNotFoundError):
        # 测试替身可能只注入 sys.modules 而无 __spec__；仍允许 import。
        spec_ok = True
    if not spec_ok:
        return []
    if model_dir is None or not model_dir.is_dir():
        return []
    try:
        module = importlib.import_module("faster_whisper")
        whisper_model = module.WhisperModel(
            str(model_dir), device="auto", compute_type="default"
        )
        requested = None if language == "auto" else language
        segments, _info = whisper_model.transcribe(
            str(audio), language=requested, word_timestamps=True
        )
        words: list[dict[str, Any]] = []
        for segment in segments:
            for word in getattr(segment, "words", None) or []:
                start_us = max(0, int(float(word.start) * 1_000_000))
                end_us = max(start_us + 1, int(float(word.end) * 1_000_000))
                words.append(
                    {
                        "start_us": start_us,
                        "end_us": end_us,
                        "text": str(getattr(word, "word", "")).strip(),
                    }
                )
        words.sort(key=lambda w: w["start_us"])
        return words
    except Exception:  # noqa: BLE001 — ASR 失败不得阻断评测导出
        return []


def resolve_lj_words(
    media: Path,
    *,
    model_dir: Path | None = None,
    language: str = "auto",
) -> tuple[list[dict[str, Any]], str]:
    """返回 (words, word_source)。word_source ∈ {asr, energy_proxy}。

    `model_dir` 为空时自动发现产品安装的 faster-whisper-tiny。
    """
    if model_dir is None:
        model_dir = discover_asr_model_dir()
    words = asr_words_from_media(media, model_dir=model_dir, language=language)
    if words:
        return words, "asr"
    wav_path = media if media.suffix.lower() == ".wav" else media.with_suffix(".wav")
    if not wav_path.is_file():
        return [], "energy_proxy"
    pcm, sr = _wav_pcm(wav_path)
    return energy_words_from_pcm(pcm, sr), "energy_proxy"
