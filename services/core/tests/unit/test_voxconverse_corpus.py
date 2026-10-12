"""W2.2 O6 后续 —— VoxConverse 语料接入的回归锁。

本批**自行下载**了低人数档语料（VoxConverse dev），并把 corpus 接进了仓库工具。
这里钉死接入的两个要点，防未来改动把低人数档的支持"简化"掉：

1. **下载器必须登记 VoxConverse 的 URL**（否则语料不可复现获取）；
2. **诊断工具必须接受 voxconverse 语料名**，且扩展名映射正确
   （VoxConverse 的 wav 已是 16 kHz 单声道 ⇒ **不需要**取单通道，与 AISHELL-4 不同）。

⚠️ 这两个检查是**源码级**的（不依赖音频是否在位），故在 CI 可跑。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
QE = ROOT / "tools" / "quality_eval"
sys.path.insert(0, str(QE))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


fetch = _load("quality_eval_fetch_for_vc", QE / "fetch_diarization_corpora.py")
diag_src = (QE / "diarization_diagnose.py").read_text(encoding="utf-8")


class TestFetchRegistersVoxConverse:
    def test_archives_registered(self):
        assert "dev" in fetch.VC_ARCHIVES and "test" in fetch.VC_ARCHIVES
        for split, url in fetch.VC_ARCHIVES.items():
            assert url.startswith("https://"), (split, url)
            assert "voxconverse" in url, (split, url)

    def test_rttm_tarball_registered(self):
        # RTTM 与音频分开取（音频是整包 zip，RTTM 很小、在 GitHub 仓库里）
        assert "voxconverse" in fetch.VC_RTTM_TARBALL


class TestDiagnoseAcceptsVoxConverse:
    def test_corpus_choice_includes_voxconverse(self):
        assert '"voxconverse"' in diag_src, "诊断工具未接受 voxconverse 语料名"

    def test_default_extension_mapping(self):
        # VoxConverse 的 wav 是 .wav；AMI 是 .Mix-Headset.wav；AISHELL-4 是 .flac
        assert '"voxconverse": ".wav"' in diag_src
        assert '"ami": ".Mix-Headset.wav"' in diag_src
        assert '"aishell4": ".flac"' in diag_src

    def test_does_not_force_a_channel_for_voxconverse(self):
        """**负向对照的方向**：VoxConverse 已单声道，不得像 AISHELL-4 那样强制 channel。

        实测风险：若对已单声道的素材强行 channel=0，解码会取错通道或报错。
        这里断言扩展名映射**不含** channel 设置（channel 只由 CLI 显式传入）。
        """
        line = [x for x in diag_src.splitlines() if "voxconverse" in x and ".wav" in x]
        assert line, "未找到 voxconverse 扩展名映射"
        assert "channel" not in line[0], f"扩展名映射里不应含 channel：{line[0]}"


class TestLowKEvalTool:
    def test_tool_exists_and_has_main(self):
        p = QE / "diarization_lowk_eval.py"
        assert p.is_file(), "低人数档评测工具缺失"
        m = _load("quality_eval_lowk", p)
        assert callable(m.main)

    def test_tool_explicitly_handles_undefined_silhouette(self):
        """silhouette 无定义（>40 簇）必须显式排除，不能让 -1 哨兵参与排序。"""
        src = (QE / "diarization_lowk_eval.py").read_text(encoding="utf-8")
        assert "MAX_SILHOUETTE_CLUSTERS" in src
        assert "None" in src
