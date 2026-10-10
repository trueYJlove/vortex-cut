"""W2.1 机位同步算法回归（纯函数，无 ffmpeg / 无 DB）。

覆盖 Planning Gate §3 验收 1/2/5，并落实评审 B1/B2 的区分力要求：
- 两级精度：粗 ≤10ms、精 ≤1ms（真值含非整数样本与非 10ms 整数倍）；
- **负向对照**：把精对齐短路（只取粗）⇒ 过不了精门（test_negative_control_*）；
- 无关音频 ⇒ unavailable(low_confidence)（置信度硬编码 1.0 时必红）；
- 同源通道退化（混响 + -30dB 噪声底）⇒ 仍 ready 且在门内；
- 双窗不一致 ⇒ unavailable；确定性 ⇒ 两次运行逐位相同。
"""
from __future__ import annotations

import numpy as np
import pytest

from aivs_core.media import angle_sync
from aivs_core.media.angle_sync import (
    SAMPLE_RATE,
    envelope,
    measure_offset,
    window_pcm_args,
)

COARSE_TOLERANCE_MS = 10.0
FINE_TOLERANCE_MS = 1.0


def _reference(seconds: float = 30.0, seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(SAMPLE_RATE * seconds)
    signal = np.convolve(rng.standard_normal(n), np.ones(32) / 32, mode="same")
    envelope_mask = np.ones(n)
    position = 0
    while position < n:
        segment = int(rng.uniform(0.4, 1.6) * SAMPLE_RATE)
        gap = int(rng.uniform(0.05, 0.4) * SAMPLE_RATE)
        envelope_mask[position:position + segment] = 1.0
        envelope_mask[position + segment:position + segment + gap] = 0.05
        position += segment + gap
    return signal * envelope_mask


def _shift(signal: np.ndarray, offset_ms: float, *, snr_db: float = 20.0,
           gain: float = 0.7, seed: int = 11, reverb: bool = False) -> np.ndarray:
    rng = np.random.default_rng(seed)
    shift = int(round(offset_ms / 1000 * SAMPLE_RATE))
    out = np.zeros_like(signal)
    if shift >= 0:
        out[shift:] = signal[: len(signal) - shift]
    else:
        out[:shift] = signal[-shift:]
    if reverb:
        tail = np.exp(-np.arange(2048) / 256.0) * rng.standard_normal(2048)
        out = np.convolve(out, tail / np.abs(tail).sum(), mode="same") + out
    power = float(np.mean(out ** 2))
    noise = rng.standard_normal(out.shape) * np.sqrt(power / (10 ** (snr_db / 10)))
    return out * gain + noise


def _measure(ref: np.ndarray, mem: np.ndarray) -> dict:
    return measure_offset(ref, mem)


def test_sign_convention_is_pinned() -> None:
    """坑 1：符号约定必须由 sign check 钉死（正 = 成员更晚）。"""
    ref = _reference(10.0)
    assert _measure(ref, _shift(ref, 200.0, snr_db=60.0))["offset_us"] > 0
    assert _measure(ref, _shift(ref, -200.0, snr_db=60.0))["offset_us"] < 0


@pytest.mark.parametrize("offset_ms", [1234.0, 137.4, 41.7, 0.0, -253.0, -1500.0])
def test_two_level_tolerance(offset_ms: float) -> None:
    """验收 1：粗 ≤10ms 且精 ≤1ms（真值含负值与非 10ms 整数倍）。"""
    ref = _reference()
    result = _measure(ref, _shift(ref, offset_ms))
    assert result["status"] == "ready", result
    assert abs(result["coarse_us"] / 1000 - offset_ms) <= COARSE_TOLERANCE_MS
    assert abs(result["offset_us"] / 1000 - offset_ms) <= FINE_TOLERANCE_MS
    assert result["dual_delta_us"] <= angle_sync.DUAL_WINDOW_TOLERANCE_US


def test_negative_control_coarse_only_fails_fine_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    """**负向对照**：关掉精对齐 ⇒ 只靠 10ms 包络，必须过不了 ≤1ms 精门。"""
    monkeypatch.setattr(angle_sync, "_fine_residual",
                        lambda ref, mem, coarse_us, offset_s: (0.0, 1.0))
    ref = _reference()
    result = _measure(ref, _shift(ref, 137.4))
    assert result["status"] == "ready"
    assert abs(result["offset_us"] / 1000 - 137.4) > FINE_TOLERANCE_MS


def test_unrelated_audio_is_unavailable() -> None:
    """验收 2-①：无关音频必须 unavailable（置信度硬编码 1.0 时本用例红）。"""
    ref = _reference(seed=7)
    unrelated = _shift(_reference(seed=99), 0.0)
    result = _measure(ref, unrelated)
    assert result["status"] == "unavailable"
    assert result["reason"] == "low_confidence"
    assert result["offset_us"] is None


def test_degraded_same_source_still_ready() -> None:
    """验收 2-②：同源但混响 + -30dB 噪声底 ⇒ 仍 ready 且在门内（阈值不是宁滥勿缺）。"""
    ref = _reference()
    # snr_db=30 ⇒ 噪声底比信号低 30dB（评审要求的口径；写 -30 会变成噪声淹没信号）
    degraded = _shift(ref, 640.0, snr_db=30.0, gain=0.4, reverb=True, seed=23)
    result = _measure(ref, degraded)
    assert result["status"] == "ready", result
    assert abs(result["offset_us"] / 1000 - 640.0) <= FINE_TOLERANCE_MS * 5


def test_silence_is_unavailable() -> None:
    """验收 2-③：纯静音必须 unavailable（不得输出看似合理的偏移）。"""
    ref = _reference()
    result = _measure(ref, np.zeros_like(ref))
    assert result["status"] == "unavailable"
    assert result["offset_us"] is None


def test_dual_window_disagreement_is_unavailable() -> None:
    """验收 2b：只有单窗可信（第二窗内容被换掉）⇒ 必须 unavailable。"""
    ref = _reference()
    mem = _shift(ref, 300.0)
    start = int(round(300.0 / 1000 * SAMPLE_RATE)) + int(1.0 * SAMPLE_RATE)
    end = start + int(2.0 * SAMPLE_RATE)
    mem[start:end] = _shift(_reference(seed=5), 0.0)[: end - start]
    result = _measure(ref, mem)
    assert result["status"] == "unavailable"
    assert result["reason"] in {"low_confidence", "window_out_of_range"}


def test_determinism() -> None:
    """验收 5：同输入两次运行结果逐位相同。"""
    ref = _reference()
    mem = _shift(ref, -417.0)
    first, second = _measure(ref, mem), _measure(ref, mem)
    assert first == second


def test_window_pcm_contract() -> None:
    """PCM 口径锁：48k / 单声道 / f32le / 预滚 + atrim 精裁（评审 D-1）。"""
    args = window_pcm_args("C:/media/a.mp4", 10.0, 30.0)
    joined = " ".join(args)
    assert "-ac 1" in joined and f"-ar {SAMPLE_RATE}" in joined
    assert "pcm_f32le" in joined and "f32le" in joined
    assert "aresample=48000" in joined and "atrim=start=" in joined


def test_envelope_hop_is_10ms() -> None:
    assert envelope(np.ones(SAMPLE_RATE)).shape[0] == pytest.approx(100, abs=1)
