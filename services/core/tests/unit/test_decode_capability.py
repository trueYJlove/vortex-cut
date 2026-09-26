"""H3 能力表数据源：ffmpeg -decoders → 规范化 codec 可解性。"""
from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.media.encoders import EncoderDetector

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()


@pytest.mark.asyncio
async def test_decode_capability_maps_decoder_names() -> None:
    if not FFMPEG.is_file():
        pytest.skip("ffmpeg 缺失")
    detector = EncoderDetector(FFMPEG)
    caps = await detector.decode_capability()
    assert set(caps) == {"avc", "hevc", "av1"}
    # 捆绑 LGPL ffmpeg 含 h264/hevc/av1 解码
    assert caps["avc"] is True
    assert caps["hevc"] is True
    assert caps["av1"] is True
    # capabilities() 带 decode_capability（能力表 IPC 数据源）
    full = await detector.capabilities()
    assert full["decode_capability"] == caps


@pytest.mark.asyncio
async def test_decode_capability_missing_ffmpeg() -> None:
    detector = EncoderDetector(Path("missing-ffmpeg-for-test"))
    caps = await detector.decode_capability()
    assert caps == {"avc": False, "hevc": False, "av1": False}
