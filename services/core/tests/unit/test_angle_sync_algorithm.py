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
    # P94 重标定（0.5→0.20）后，"无关"必须仍被拒——**显式上界，不靠注释背书**
    # （2026-10-11 复核：原实现只在注释里宣称"旧合成证据不被破坏"，无断言防它再变）
    assert result["confidence"] < 0.10, (
        f"合成无关音频的相关峰 {result['confidence']:.3f} 超出 0.10——"
        "R3 的区分力基线（无关 ≈0.05）被破坏，须复查重标定"
    )


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
    assert result["reason"] in {
        "low_confidence",
        "dual_window_inconsistent",
        "window_out_of_range",
    }
    # ⚠️ 区分力边界（2026-10-11 复核 NC-5）：本构造把第二窗内容整体换掉，实测是
    # **置信度门**先拦下（conf≈0.055），双窗门根本没机会触发 ⇒ 本用例**不能**当作
    # 双窗门的证据。双窗门的证据见 test_dual_window_inconsistency_has_its_own_reason。



def _resample(signal: np.ndarray, rate: float) -> np.ndarray:
    """频域重采样（带限）：模拟设备采样时钟差；rate>1 = 成员走得更快（内容逐秒提前）。

    不用线性插值——那等于给信号加低通，噪声类素材的相关性会被插值误差打掉，
   用例就会先撞 low_confidence 而测不到漂移分支（本用例首版即如此，已修正）。
    """
    n = len(signal)
    spectrum = np.fft.rfft(signal)
    m = max(1, int(round(n / rate)))
    keep = min(len(spectrum), m // 2 + 1)
    out = np.fft.irfft(spectrum[:keep], m)
    if len(out) < n:
        out = np.concatenate([out, np.zeros(n - len(out))])
    return out[:n]


def test_dual_window_inconsistency_has_its_own_reason() -> None:
    """P95a：双窗门必须与"置信度低"**分开报**。

    构造：低频主导素材 + **1% 重采样**（成员走快 1%）⇒ 两个精细窗（off 0 / +1s）
    各自都相关得很好（置信度过门），但残差相差 ≈10 ms > 5 ms 容差 ⇒ **只有双窗门能拦**。
    （既有 test_dual_window_disagreement_is_unavailable 的构造会让置信度先崩，
      对双窗门没有区分力——本条补上那个缺口。）

    区分力：若把双窗门的 reason 改回 `low_confidence`（与置信度门合并），本用例红。
    """
    rng = np.random.default_rng(11)
    smooth = np.convolve(rng.standard_normal(SAMPLE_RATE * 30), np.ones(1024) / 1024, mode="same")
    result = measure_offset(smooth, _resample(smooth, 1.01))
    assert result["status"] == "unavailable", result
    assert result["reason"] == "dual_window_inconsistent", (
        f"双窗不一致应单独报案（reason={result['reason']}）——"
        "与置信度门合并报 low_confidence 会把用户指向错误的原因"
    )
    assert result["confidence"] >= angle_sync.CONFIDENCE_THRESHOLD, (
        f"本构造的置信度 {result['confidence']:.3f} 必须过门，否则测的是置信度门而不是双窗门"
    )


def test_clock_drift_is_rejected_not_silently_averaged() -> None:
    """R1：0.1% 采样时钟差 ⇒ 必须 unavailable(clock_drift)，**不得**返回看似可用的单值。

    单偏移在漂移下两端各错一半（30s 素材、0.1% ⇒ 跨度内 ~30ms），剪出来的切点整体偏，
    而这是"看起来成功"的失败——宁可拒答。

    信号用**低频主导**的素材（重低通）：宽带噪声在 0.1% 拉伸下 2s 窗内就相位走完，
    会先撞 low_confidence（那也是如实拒答，但测不到漂移分支）。
    """
    rng = np.random.default_rng(7)
    smooth = np.convolve(rng.standard_normal(SAMPLE_RATE * 30), np.ones(1024) / 1024, mode="same")
    ref = smooth * np.interp(np.arange(len(smooth)),
                             [0, len(smooth) * 0.5, len(smooth)],
                             [1.0, 1.0, 1.0])
    drifted = _resample(ref, 1.001)
    result = measure_offset(ref, drifted)
    assert result["status"] == "unavailable", result
    assert result["reason"] == "clock_drift", result
    assert result["offset_us"] is None
    assert abs(result["drift_us"]) > angle_sync.DRIFT_TOLERANCE_US


def test_drift_branch_is_locked(monkeypatch: pytest.MonkeyPatch) -> None:
    """分支锁：近窗一致、远窗偏 50ms ⇒ 必须走 clock_drift 分支（不依赖夹具形态）。"""
    original = angle_sync._fine_residual

    def fake(ref, mem, coarse_us, window_offset_s):
        residual, confidence = original(ref, mem, coarse_us, window_offset_s)
        if residual == residual and abs(window_offset_s - angle_sync.DRIFT_WINDOW_SPACING_S) < 1e-6:
            return residual + 50_000.0, confidence      # 远窗偏 50ms ⇒ 漂移
        return residual, confidence

    monkeypatch.setattr(angle_sync, "_fine_residual", fake)
    ref = _reference()
    result = measure_offset(ref, _shift(ref, 300.0))
    assert result["status"] == "unavailable" and result["reason"] == "clock_drift", result
    assert result["drift_us"] == 50_000


def test_no_drift_reports_near_zero_drift() -> None:
    """对照：无漂移素材照常 ready，且漂移读数接近 0（防"恒判漂移"的实现蒙过）。"""
    ref = _reference()
    result = measure_offset(ref, _shift(ref, 300.0))
    assert result["status"] == "ready", result
    assert abs(result["drift_us"]) <= angle_sync.DRIFT_TOLERANCE_US



def test_short_material_reports_window_too_short() -> None:
    """复核 M-b：素材短到双窗取不齐 ⇒ reason 必须是可读的 window_too_short
    （不是令人费解的 window_out_of_range）。"""
    ref = _reference(2.0)
    result = measure_offset(ref, _shift(ref, 100.0))
    assert result["status"] == "unavailable"
    assert result["reason"] == "window_too_short", result
    # 成员侧更短（复核 nit a）：同样必须是 window_too_short，而不是越界异常
    longer = _reference(10.0)
    shorter_member = _shift(longer, 100.0)[: int(SAMPLE_RATE * 2)]
    assert measure_offset(longer, shorter_member)["reason"] == "window_too_short"


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

def _partial_correlation(ref: np.ndarray, alpha: float, seed: int = 23) -> np.ndarray:
    """构造与参考"半相关"的信号：归一化相关峰约为 alpha。

    动机（P94）：真实**不同麦克风位置**的两路录音，相关峰落在 0.24–0.77 的"中等相关"区间，
    而既有 fixture 只有"同源 0.79"与"无关 0.05"两端。没有中间档位，阈值就无从标定。
    """
    rng = np.random.default_rng(seed)
    raw = np.convolve(rng.standard_normal(len(ref)), np.ones(32) / 32, mode="same")
    # 关键：噪声要**用参考的包络调制**。否则两者包络结构不同，粗对齐（包络互相关）
    # 找不到峰，整个测量退化为"无关"（实测 conf 0.05），fixture 就失去意义。
    env = np.abs(ref)
    shaped = raw * (env / (env.max() + 1e-12))
    shaped = shaped / (np.linalg.norm(shaped) + 1e-12) * np.linalg.norm(ref)
    return alpha * ref + np.sqrt(max(0.0, 1.0 - alpha * alpha)) * shaped


def test_confidence_threshold_is_calibrated_for_real_multidevice_material() -> None:
    """阈值标定回归（P94）：**双向**锁死"中等相关"区间。

    背景：`CONFIDENCE_THRESHOLD` 原为 0.5，由**合成同源 fixture** 标定
    （R3：同源 0.788 / 无关 0.052），**从未在真实多设备素材上验证**。
    2026-10-11 用 AMI 真实多阵列同场景录音实测：物理远距设备（≈ 两个机位）
    落在 **0.236–0.771**（12 窗），被 0.5 挡下 7 个；而估计器本身正确
    （已知真值 0 / −83 / −400 ms ⇒ 粗估 0 / −80 / −400 ms）。
    负样本：跨会议 ≤0.122，同房间不同时段 ≤0.080 ⇒ 取 **0.20**。

    本用例的区分力（**实际夹持区间 `(0.123, 0.273]`，不是 0.20 这个值本身**——
    2026-10-11 复核指出初版注释把它说宽了）：
    - `alpha=0.30`（实测 conf≈0.273）必须 `ready` ⇒ 阈值 > 0.273 即红（含回退到 0.5）；
    - `alpha=0.15`（实测 conf≈0.123）必须 `unavailable(low_confidence)` ⇒ 阈值 ≤ 0.123 即红。
    即：本用例锁"量级落在 0.12–0.27"，**锁不住 0.20 这个具体标定值**（取 0.15 或 0.26 同样绿）。
    这是有意为之——标定值本身来自 AMI 实测分布，不该由合成 fixture 钉死。
    """
    ref = _reference(seconds=30.0)

    mid = measure_offset(ref, _partial_correlation(ref, 0.30))
    assert 0.24 < mid["confidence"] < 0.32, (
        f"合成信号的相关峰 {mid['confidence']:.3f} 应落在 (0.24, 0.32)（实测 0.273）——"
        "它偏了就说明夹持区间变了，先修 fixture 再谈断言"
    )
    assert mid["status"] == "ready", (
        f"真实多设备量级的相关系数（{mid['confidence']:.3f}）必须被接受——"
        "此处失败多半是 CONFIDENCE_THRESHOLD 被调回了 0.5 以上"
    )

    # 低档 fixture 必须落在 (0.10, 0.20)：低于 0.10 就守不住"阈值下调过头"这一侧。
    # （首版用 seed=31，实测 conf 过低，负向对照 NC-B 当场证明它守不住。）
    low = measure_offset(ref, _partial_correlation(ref, 0.15))
    assert 0.10 < low["confidence"] < 0.16, (
        f"低档 fixture 的相关峰 {low['confidence']:.3f} 应落在 (0.10, 0.16)（实测 0.123）——"
        "低于 0.10 就守不住'阈值下调过头'这一侧"
    )
    assert low["status"] == "unavailable"
    assert low["reason"] == "low_confidence", (
        f"低于阈值的相关（{low['confidence']:.3f}）必须被拒——"
        "此处通过多半是阈值被下调过头，真实无关音频会被误收"
    )

