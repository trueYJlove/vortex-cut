"""W2.2 S2：VAD 层单测（**真实随包 Silero 资产**，O1 交付件的回归锁）。

对应门 §7 的 `speaker_vad_test.py`：纯静音/低电平噪声上 0 误报 +
**能量 VAD 不得出现在任何调用路径**（import 锁）。

O1 的分支必须**可测**（不是静默降级）：资产缺失 ⇒ `silero_asset_path()` 返回 None
且 `require_silero_asset_path()` 抛 `SileroAssetMissing`，服务层据此落
`unavailable(silero_asset_missing)`。负向对照：让探测恒返回路径 ⇒ 缺失用例红。
"""
from __future__ import annotations

import ast
from pathlib import Path

import numpy as np
import pytest

from aivs_core.media import speaker_vad as vad

SR = 16000


def _session() -> vad.SileroVoiceActivity:
    path = vad.silero_asset_path()
    if path is None:
        pytest.skip("随包 Silero 资产不可用")
    return vad.SileroVoiceActivity(path)


class TestAssetProbe:
    def test_probe_finds_shipped_asset(self) -> None:
        """当前环境（faster-whisper 1.2.1）资产在位——O1 的版本上限约束即为它。"""
        path = vad.silero_asset_path()
        assert path is not None and path.is_file()
        assert path.name == "silero_vad_v6.onnx"
        assert vad.faster_whisper_version()

    def test_missing_asset_is_a_testable_branch(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """资产缺失必须走**可测分支**，不是抛 import 错或静默降级。"""
        monkeypatch.setattr(vad, "silero_asset_path", lambda: None)
        with pytest.raises(vad.SileroAssetMissing):
            vad.require_silero_asset_path()

    def test_probe_returns_none_when_asset_file_absent(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """**上游移除资产**（faster-whisper 仍在、assets 目录里没有 v6）：
        探测必须返回 None 并让 require_ 抛可测异常。

        这是 NC-4 当场抓出的缺口——原用例 monkeypatch 了 \`silero_asset_path\` 本身，
        所以"探测函数对文件缺失的处理"从未被覆盖（把 \`return candidate if ... else None\`
        改成恒返回仍然全绿）。本用例走**真实 import 路径**，只把 assets 目录换空。
        """
        import importlib as il
        import types

        fake_utils = types.SimpleNamespace(get_assets_path=lambda: tmp_path)
        real_import = il.import_module

        def fake_import(name: str, *args: object, **kwargs: object) -> object:
            if name == "faster_whisper.utils":
                return fake_utils
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(il, "import_module", fake_import)
        assert vad.silero_asset_path() is None
        with pytest.raises(vad.SileroAssetMissing):
            vad.require_silero_asset_path()

    def test_probe_returns_none_when_module_absent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """faster-whisper 被移除（O1 的上游风险）⇒ 返回 None，不抛。"""
        import importlib.util

        def fake_find_spec(name: str) -> object:
            if name == "faster_whisper":
                return None
            return real_find_spec(name)

        real_find_spec = importlib.util.find_spec
        monkeypatch.setattr(importlib.util, "find_spec", fake_find_spec)
        assert vad.silero_asset_path() is None
        assert vad.faster_whisper_version() is None


class TestSileroDetection:
    def test_silence_reports_no_speech(self) -> None:
        """纯数字静音：**零误报**（Silero 是随包资产，不是自适应阈值启发式）。"""
        session = _session()
        silence = np.zeros(SR * 3, dtype=np.float64)
        voiced = session.voiced_10ms(silence)
        assert voiced.size > 0
        assert float(voiced.mean()) == 0.0

    def test_low_level_noise_reports_no_speech(self) -> None:
        """低电平噪声（−60 dBFS，远低于语音）同样零误报。"""
        session = _session()
        rng = np.random.default_rng(7)  # 固定种子：确定性
        noise = rng.normal(0.0, 1e-3, SR * 3)
        voiced = session.voiced_10ms(noise)
        assert float(voiced.mean()) <= 0.02, float(voiced.mean())

    def test_tonal_speech_band_signal_is_detected(self) -> None:
        """语音带内的**调幅**信号应被判有声（阳性对照——防"恒 False"的假阳性通过）。"""
        session = _session()
        t = np.arange(SR * 3) / SR
        carrier = np.sin(2 * np.pi * 220.0 * t)
        envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 4.0 * t)
        signal = 0.3 * carrier * envelope
        assert float(session.voiced_10ms(signal).mean()) > 0.3

    def test_grid_is_10ms_and_deterministic(self) -> None:
        session = _session()
        t = np.arange(SR * 2) / SR
        signal = 0.3 * np.sin(2 * np.pi * 180.0 * t)
        first = session.voiced_10ms(signal)
        second = session.voiced_10ms(signal)
        assert first.shape[0] == 200
        assert np.array_equal(first, second)


class TestEnergyVadImportLock:
    """D4/R2：**能量 VAD 不得出现在任何调用路径**——做成机器锁而非文档纪律。"""

    def test_energy_vad_symbols_absent_from_core(self) -> None:
        root = Path(__file__).resolve().parents[2] / "src" / "aivs_core"
        forbidden = {"energy_vad", "voiced_mask_energy", "rms_vad", "noise_floor_vad"}
        offenders: list[str] = []
        for path in root.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            for symbol in forbidden:
                if symbol in text:
                    offenders.append(f"{path.name}:{symbol}")
        assert offenders == [], offenders

    def test_speaker_modules_import_silero_only(self) -> None:
        """说话人链路只能经 `speaker_vad` 取 VAD（不得自带实现）。"""
        root = Path(__file__).resolve().parents[2] / "src" / "aivs_core" / "media"
        for name in ("speaker_service.py", "speaker.py"):
            tree = ast.parse((root / name).read_text(encoding="utf-8"))
            imported = {
                node.module or ""
                for node in ast.walk(tree)
                if isinstance(node, ast.ImportFrom)
            }
            assert not any("vad" in module and "speaker_vad" not in module
                           for module in imported), (name, imported)
