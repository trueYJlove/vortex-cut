"""asr_words：L/J 词戳来源（ASR 优先，能量代理回退）。"""

from __future__ import annotations

import sys
import wave
from pathlib import Path

import numpy as np
import pytest

QE = Path(__file__).resolve().parents[4] / "tools" / "quality_eval"
sys.path.insert(0, str(QE))

from asr_words import (  # noqa: E402
    asr_words_from_media,
    energy_words_from_pcm,
    resolve_lj_words,
)


def _write_tone_wav(path: Path, *, duration_s: float = 2.0, sr: int = 8000) -> None:
    t = np.arange(int(duration_s * sr)) / sr
    pcm = (0.4 * np.sin(2 * np.pi * 220 * t) * 32767).astype("<i2")
    with wave.open(str(path), "w") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sr)
        wav.writeframes(pcm.tobytes())


def test_energy_words_splits_speech_runs(tmp_path: Path) -> None:
    sr = 8000
    # 1s tone + 0.5s silence + 1s tone
    speech = (0.4 * np.sin(2 * np.pi * 220 * np.arange(sr) / sr))
    silence = np.zeros(sr // 2)
    pcm = np.concatenate([speech, silence, speech])
    words = energy_words_from_pcm(pcm, sr)
    assert words
    assert all(w["end_us"] > w["start_us"] for w in words)
    # 两段有声
    starts = {w["start_us"] // 1_000_000 for w in words}
    assert 0 in starts and 1 in starts


def test_resolve_falls_back_to_energy_proxy(tmp_path: Path) -> None:
    wav = tmp_path / "tone.wav"
    _write_tone_wav(wav)
    # 无 model_dir → 不走 ASR
    words, source = resolve_lj_words(wav, model_dir=None)
    assert source == "energy_proxy"
    assert words


def test_asr_empty_when_model_missing(tmp_path: Path) -> None:
    wav = tmp_path / "tone.wav"
    _write_tone_wav(wav)
    assert asr_words_from_media(wav, model_dir=tmp_path / "no-such-model") == []


def test_asr_words_from_fake_whisper(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    wav = tmp_path / "tone.wav"
    _write_tone_wav(wav)
    model_dir = tmp_path / "whisper"
    model_dir.mkdir()

    class FakeWord:
        def __init__(self, start: float, end: float, word: str) -> None:
            self.start = start
            self.end = end
            self.word = word

    class FakeSegment:
        words = [FakeWord(0.1, 0.4, " hello "), FakeWord(0.5, 0.9, "world")]

    class FakeModel:
        def __init__(self, *_a, **_k) -> None:
            pass

        def transcribe(self, *_a, **_k):
            return [FakeSegment()], object()

    class FakeModule:
        WhisperModel = FakeModel

    monkeypatch.setitem(sys.modules, "faster_whisper", FakeModule())
    words = asr_words_from_media(wav, model_dir=model_dir)
    assert words == [
        {"start_us": 100_000, "end_us": 400_000, "text": "hello"},
        {"start_us": 500_000, "end_us": 900_000, "text": "world"},
    ]
    resolved, source = resolve_lj_words(wav, model_dir=model_dir)
    assert source == "asr" and resolved == words
