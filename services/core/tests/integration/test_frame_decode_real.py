"""H3 真实 ffmpeg 窗口帧解码（NV12）+ 与后端 A 的帧号映射对拍。"""
from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.media.frame_decode import (
    FrameDecodeError,
    decode_frames,
    list_frame_pts,
    map_frame_numbers_to_pts,
    pack_nv12_response,
)

REPO = Path(__file__).resolve().parents[4]
FFMPEG = REPO / "resources/ffmpeg/win-x64/ffmpeg.exe"
FFPROBE = REPO / "resources/ffmpeg/win-x64/ffprobe.exe"
FIXTURE = REPO / "test-assets/generated/eval/life-no-voice-01.mp4"

pytestmark = pytest.mark.skipif(
    not (FFMPEG.is_file() and FFPROBE.is_file() and FIXTURE.is_file()),
    reason="ffmpeg/ffprobe/fixture 缺失",
)


@pytest.mark.asyncio
async def test_decode_frames_nv12_geometry_and_pts_alignment() -> None:
    pts = await list_frame_pts(FFPROBE, FIXTURE)
    assert len(pts) >= 3
    frames = await decode_frames(
        FFMPEG, FFPROBE, FIXTURE, width=320, height=180,
        frame_numbers=[0, 1, 2], fps=30.0,
    )
    assert [f.frame_n for f in frames] == [0, 1, 2]
    for frame in frames:
        assert frame.width == 320 and frame.height == 180
        assert frame.stride_y == 320 and frame.stride_uv == 320
        assert len(frame.y) == 320 * 180
        assert len(frame.uv) == 320 * 180 // 2
        assert frame.color_space == "bt709"
        # PTS 必须落在最近邻容差内（与 map_frame_numbers_to_pts 同一判据）
        target = int(round(frame.frame_n / 30.0 * 1_000_000))
        assert abs(frame.pts_us - target) <= 33_334


@pytest.mark.asyncio
async def test_a_b_same_frame_number_same_pts() -> None:
    """A/B 对拍：同素材同帧号，B 的 PTS 必须等于 A 的最近邻选择。"""
    pts = await list_frame_pts(FFPROBE, FIXTURE)
    mapped = map_frame_numbers_to_pts([0, 5, 10], 30.0, pts)
    frames = await decode_frames(
        FFMPEG, FFPROBE, FIXTURE, width=320, height=180,
        frame_numbers=[0, 5, 10], fps=30.0,
    )
    for (_n, a_choice), b_frame in zip(mapped, frames, strict=True):
        assert b_frame.pts_us == a_choice.pts_us


@pytest.mark.asyncio
async def test_pack_response_and_window_limit() -> None:
    frames = await decode_frames(
        FFMPEG, FFPROBE, FIXTURE, width=320, height=180,
        frame_numbers=[0], fps=30.0,
    )
    blob = pack_nv12_response(frames, notes=[])
    assert blob[:4] == b"AIV1"
    with pytest.raises(FrameDecodeError) as exc:
        await decode_frames(
            FFMPEG, FFPROBE, FIXTURE, width=320, height=180,
            frame_numbers=list(range(33)), fps=30.0,
        )
    assert exc.value.code == "DECODE_WINDOW_TOO_LARGE"
