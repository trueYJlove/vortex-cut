"""H3 真实 ffmpeg 窗口帧解码（NV12）+ 与后端 A 的帧号映射对拍。"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from aivs_core.media.frame_decode import (
    FrameDecodeError,
    decode_frames,
    list_frame_pts,
    map_frame_numbers_to_pts,
    pack_nv12_response,
    parse_frame_pts_json,
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
async def test_packet_pts_table_matches_frames_channel() -> None:
    """P69 等价锁：packets 快速通道与 -show_frames 通道逐项等价（含展示序 index）。

    -show_frames 逐帧解码（8400 帧实测 79.2s），-show_packets 只解封装
    （0.4s）；两者必须产出相同的 (index, pts_us, key_frame) 表，否则 B 帧
    素材的 select=eq(n,…）取帧语义会漂移。
    """
    process = await asyncio.create_subprocess_exec(
        str(FFPROBE),
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "frame=pts_time,best_effort_timestamp_time,key_frame",
        "-print_format", "json",
        str(FIXTURE),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await process.communicate()
    legacy = parse_frame_pts_json(json.loads(stdout.decode("utf-8", errors="replace")))
    fast = await list_frame_pts(FFPROBE, FIXTURE)
    assert [(p.index, p.pts_us, p.key_frame) for p in fast] == [
        (p.index, p.pts_us, p.key_frame) for p in legacy
    ]


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


@pytest.mark.asyncio
async def test_p95_latency_gate_small_fixture() -> None:
    """p95 门限（P29）：短命 ffmpeg 单帧窗。小夹具宽限 2s。

    真机定档（2026-10-09）：**1080p/HEVC scrub 2 帧窗 p95 ≤ 1200ms**——
    三轴实测（720p HEVC 250ms / 1080p H.264 313ms / 3440x1440 698ms）按
    像素/编码保守外推 560ms 的约 2 倍；推导与协议见
    `MEDIA_DECODER_HEVC_P29_REALMACHINE_2026-10-09.md`。"""
    import time

    samples: list[float] = []
    for _ in range(5):
        t0 = time.perf_counter()
        await decode_frames(
            FFMPEG, FFPROBE, FIXTURE, width=320, height=180,
            frame_numbers=[0, 1], fps=30.0,
        )
        samples.append((time.perf_counter() - t0) * 1000)
    samples.sort()
    p95 = samples[int(len(samples) * 0.95) - 1] if len(samples) > 1 else samples[0]
    assert p95 < 2000, f"p95={p95:.0f}ms 超门限 2000ms（samples={samples}）"
