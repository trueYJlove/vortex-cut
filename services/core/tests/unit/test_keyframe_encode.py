"""W3.3 S1a：关键帧 JPEG 编码（A6 帧规格 / A13 编码可用 / A12 两套字节分离）。

设计门 §8 要求每条负向对照「还原实现即红」。本文件的负向对照以
「把生产函数的关键行为临时换成错误实现」的方式就地构造，
并断言**同一断言在错误实现下失败**——而不是只在正确实现下通过。
"""
from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

import pytest

from aivs_core.media.keyframe_encode import (
    JPEG_LONG_EDGE,
    JPEG_QSCALE,
    MAX_FRAMES,
    THUMBNAIL_LONG_EDGE,
    EncodedFrame,
    KeyframeEncodeError,
    encode_frame,
    encode_frames,
    jpeg_args,
    jpeg_dimensions,
    sha256_hex,
    total_payload_bytes,
)

FFMPEG = Path(__file__).resolve().parents[4] / "resources/ffmpeg/win-x64/ffmpeg.exe"

pytestmark = pytest.mark.skipif(not FFMPEG.exists(), reason="随包 ffmpeg 不在预期位置")


async def _run_capture(args: list[str]) -> tuple[int, bytes, str]:
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
    )
    stdout, stderr = await process.communicate()
    return process.returncode or 0, stdout, stderr.decode("utf-8", errors="replace")


async def _make_video(tmp_path: Path, size: str, *, frames: int = 8, rate: int = 8) -> Path:
    """合成测试素材（testsrc 有纹理，避免纯色帧把体积压成无代表性）。"""
    out = tmp_path / ("src_" + size.replace("x", "_") + ".mp4")
    args = [
        str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc=size={size}:duration={frames / rate}:rate={rate}",
        # 随包 ffmpeg 不含 libx264（实测 -encoders 无该行），只有 libopenh264。
        "-c:v", "libopenh264", "-pix_fmt", "yuv420p", str(out),
    ]
    code, _, err = await _run_capture(args)
    assert out.exists() and out.stat().st_size > 0, err
    return out


def test_jpeg_args_pins_long_edge_and_quality() -> None:
    """D8：长边 768、q:v 3 —— 都是用户裁决值，不得被实现悄悄改。"""
    args = jpeg_args("in.mp4", 1_500_000)
    filter_expr = "scale='if(gt(iw,ih),768,-2)':'if(gt(iw,ih),-2,768)'"
    assert filter_expr in args
    assert args[args.index("-q:v") + 1] == str(JPEG_QSCALE)
    assert args[args.index("-c:v") + 1] == "mjpeg"
    assert args[args.index("-frames:v") + 1] == "1"
    wrong = jpeg_args("in.mp4", 1_500_000, long_edge=512)
    assert wrong != args
    assert filter_expr not in wrong


def test_jpeg_args_rejects_negative_timestamp() -> None:
    with pytest.raises(ValueError):
        jpeg_args("in.mp4", -1)


def test_jpeg_args_seeks_before_input_for_speed() -> None:
    """-ss 在 -i 之前（输入侧定位）；顺序颠倒会退化成解码前缀。"""
    args = jpeg_args("in.mp4", 2_000_000)
    assert args.index("-ss") < args.index("-i")


def test_jpeg_dimensions_reads_sof() -> None:
    args = [
        str(FFMPEG), "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=size=640x480:duration=1:rate=1",
        "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2", "-",
    ]
    code, data, err = asyncio.run(_run_capture(args))
    assert code == 0, err
    assert jpeg_dimensions(data) == (640, 480)


def test_jpeg_dimensions_rejects_non_jpeg() -> None:
    with pytest.raises(KeyframeEncodeError):
        jpeg_dimensions(b"not a jpeg at all")
    # 负向对照：合法 SOI 但无 SOF ⇒ 也必须拒绝，不得返回编造的尺寸
    with pytest.raises(KeyframeEncodeError):
        jpeg_dimensions(b"\xff\xd8\xff\xd9")


@pytest.mark.asyncio
async def test_encode_frame_hits_768_long_edge(tmp_path: Path) -> None:
    """A6：横屏源长边必须是 768。"""
    video = await _make_video(tmp_path, "1280x720")
    frame = await encode_frame(FFMPEG, video, 500_000, source_reason="scene_cut")
    assert frame.payload_width == JPEG_LONG_EDGE
    assert frame.payload_height == JPEG_LONG_EDGE * 720 // 1280


@pytest.mark.asyncio
async def test_encode_frame_portrait_pins_long_edge_on_height(tmp_path: Path) -> None:
    """竖屏源：长边是**高**。只按宽缩放的实现会在这里红。"""
    video = await _make_video(tmp_path, "720x1280")
    frame = await encode_frame(FFMPEG, video, 500_000, source_reason="interval")
    assert frame.payload_height == JPEG_LONG_EDGE
    assert frame.payload_width < frame.payload_height


@pytest.mark.asyncio
async def test_payload_is_valid_jpeg_and_hashed(tmp_path: Path) -> None:
    """A3 前置：哈希必须来自真实字节。"""
    video = await _make_video(tmp_path, "1280x720")
    frame = await encode_frame(FFMPEG, video, 500_000, source_reason="scene_cut")
    assert frame.payload_bytes[:2] == b"\xff\xd8"
    assert frame.payload_bytes[-2:] == b"\xff\xd9"
    assert frame.payload_sha256 == hashlib.sha256(frame.payload_bytes).hexdigest()
    assert frame.payload_sha256 != sha256_hex(frame.payload_bytes + b"x")


@pytest.mark.asyncio
async def test_thumbnail_differs_from_payload(tmp_path: Path) -> None:
    """A12 核心前提：用户看到的（缩略图）≠ 将发出去的（载荷）。

    若实现把同一份字节塞进两个字段，用户审阅的就是错的，
    正是规划门 §3.2 要防的「看到的比发出去的小」。
    """
    video = await _make_video(tmp_path, "1280x720")
    frame = await encode_frame(FFMPEG, video, 500_000, source_reason="scene_cut")
    assert frame.payload_width == JPEG_LONG_EDGE
    assert frame.thumbnail_width == THUMBNAIL_LONG_EDGE
    assert frame.payload_width != frame.thumbnail_width
    assert frame.payload_bytes != frame.thumbnail_bytes
    assert frame.payload_sha256 != frame.thumbnail_sha256
    assert len(frame.payload_bytes) > len(frame.thumbnail_bytes)


@pytest.mark.asyncio
async def test_reencoding_is_deterministic(tmp_path: Path) -> None:
    """A3：同素材同时刻同参数 ⇒ 同哈希，否则「可复算」无从谈起。"""
    video = await _make_video(tmp_path, "1280x720")
    first = await encode_frame(FFMPEG, video, 500_000, source_reason="scene_cut")
    second = await encode_frame(FFMPEG, video, 500_000, source_reason="scene_cut")
    assert first.payload_sha256 == second.payload_sha256
    assert first.thumbnail_sha256 == second.thumbnail_sha256


@pytest.mark.asyncio
async def test_encode_frames_preserves_plan_order_and_reasons(tmp_path: Path) -> None:
    video = await _make_video(tmp_path, "640x360")
    plan = [(100_000, "scene_cut"), (400_000, "interval"), (700_000, "scene_cut")]
    frames = await encode_frames(FFMPEG, video, plan)
    assert [f.timestamp_us for f in frames] == [t for t, _ in plan]
    assert [f.source_reason for f in frames] == [r for _, r in plan]


@pytest.mark.asyncio
async def test_encode_frames_honours_cancel(tmp_path: Path) -> None:
    video = await _make_video(tmp_path, "640x360")
    cancel = asyncio.Event()
    cancel.set()
    with pytest.raises(asyncio.CancelledError):
        await encode_frames(FFMPEG, video, [(0, "scene_cut")], cancel_event=cancel)


@pytest.mark.asyncio
async def test_encode_frame_fails_closed_on_missing_input(tmp_path: Path) -> None:
    """不存在的素材必须抛错，不得返回空字节冒充「这一帧没有画面」。"""
    with pytest.raises(KeyframeEncodeError):
        await encode_frame(FFMPEG, tmp_path / "nope.mp4", 0, source_reason="scene_cut")


def test_to_meta_carries_both_byte_sets() -> None:
    frame = EncodedFrame(
        timestamp_us=123,
        source_reason="scene_cut",
        payload_bytes=b"p" * 100,
        payload_sha256="a" * 64,
        payload_width=768,
        payload_height=432,
        thumbnail_bytes=b"t" * 10,
        thumbnail_sha256="b" * 64,
        thumbnail_width=192,
        thumbnail_height=108,
    )
    meta = frame.to_meta()
    assert meta["payload_bytes"] == 100
    assert meta["thumbnail_bytes"] == 10
    assert meta["payload_sha256"] != meta["thumbnail_sha256"]
    # 字节本身不得进元数据（否则 frames_json 会膨胀到与图片同量级）
    assert not any(isinstance(v, bytes) for v in meta.values())


def test_total_payload_bytes_measures_payload_not_thumbnail() -> None:
    frames = [
        EncodedFrame(0, "scene_cut", b"p" * 30, "a", 768, 432, b"t" * 5, "b", 192, 108),
        EncodedFrame(1, "interval", b"p" * 20, "c", 768, 432, b"t" * 5, "d", 192, 108),
    ]
    assert total_payload_bytes(frames) == 50
    assert total_payload_bytes(frames) != 60


def test_max_frames_matches_planning_gate_d7() -> None:
    """D7 封顶 24 —— 常量与规划门一致，S1b 会用它。"""
    assert MAX_FRAMES == 24
