"""H3 帧号→PTS 最近邻映射（与后端 A 语义对齐；纯函数，不依赖 ffmpeg）。"""
from __future__ import annotations

import pytest

from aivs_core.media.frame_decode import (
    MAX_DECODE_FRAMES_PER_REQUEST,
    PTS_NEAREST_MAX_DIFF_US,
    DecodedPlaneFrame,
    FrameDecodeError,
    FramePts,
    locate_nearest_pts,
    map_frame_numbers_to_pts,
    pack_nv12_response,
    parse_frame_pts_json,
    target_us_for_frame,
)


def test_target_us_matches_backend_a_formula() -> None:
    # decode-worker: targetUs = (frameN / fps) * 1e6
    assert target_us_for_frame(30, 30.0) == 1_000_000
    assert target_us_for_frame(1, 29.97) == int(round(1 / 29.97 * 1_000_000))


def test_locate_nearest_pts_prefers_closer_and_respects_tolerance() -> None:
    pts = [FramePts(0, 0), FramePts(1, 33_333), FramePts(2, 66_666)]
    assert locate_nearest_pts(30_000, pts).index == 1
    assert locate_nearest_pts(0, pts).index == 0
    # 边界：恰好 33_334 可命中；33_335 拒绝（与后端 A 同阈值）
    near = [FramePts(0, 100_000), FramePts(1, 133_334)]
    assert locate_nearest_pts(100_000, near).index == 0
    with pytest.raises(FrameDecodeError) as exc:
        locate_nearest_pts(100_000, [FramePts(0, 100_000 + PTS_NEAREST_MAX_DIFF_US + 1)])
    assert exc.value.code == "DECODE_FRAME_NOT_FOUND"


def test_map_frame_numbers_vfr_nearest_neighbor() -> None:
    # 25fps 真实帧距 40ms；用 30fps 合成帧号应落到最近 PTS，而不是线性插值/序号
    pts = [FramePts(i, i * 40_000) for i in range(5)]
    mapped = map_frame_numbers_to_pts([0, 1, 2, 3], 30.0, pts)
    assert [m[0] for m in mapped] == [0, 1, 2, 3]
    # frame0 → 0μs → pts0；frame1 → 33333 → pts1(40000)；frame2 → 66667 → pts2(80000)
    assert mapped[0][1].index == 0
    assert mapped[1][1].index == 1
    assert mapped[2][1].index == 2
    # 同一物理帧可服务多个请求帧号（重复命中）
    again = map_frame_numbers_to_pts([0, 1], 30.0, [FramePts(0, 0), FramePts(1, 20_000)])
    assert again[0][1].index == 0
    assert again[1][1].index == 1


def test_map_rejects_window_overflow_and_empty() -> None:
    pts = [FramePts(0, 0)]
    with pytest.raises(FrameDecodeError) as exc:
        map_frame_numbers_to_pts([], 30.0, pts)
    assert exc.value.code == "DECODE_WINDOW_EMPTY"
    with pytest.raises(FrameDecodeError) as exc:
        map_frame_numbers_to_pts(list(range(MAX_DECODE_FRAMES_PER_REQUEST + 1)), 30.0, pts)
    assert exc.value.code == "DECODE_WINDOW_TOO_LARGE"


def test_parse_frame_pts_json_prefers_best_effort() -> None:
    payload = {
        "frames": [
            {"pts_time": "0.000", "best_effort_timestamp_time": "0.010"},
            {"pts_time": "0.040"},
            {"best_effort_timestamp_time": "N/A"},
        ]
    }
    pts = parse_frame_pts_json(payload)
    assert pts[0].pts_us == 10_000
    assert pts[1].pts_us == 40_000
    assert len(pts) == 2  # N/A 跳过


def test_pack_nv12_response_roundtrip_header() -> None:
    frame = DecodedPlaneFrame(
        frame_n=7,
        width=2,
        height=2,
        stride_y=2,
        stride_uv=2,
        y=b"YYYY",
        uv=b"UV",
        pts_us=1,
    )
    blob = pack_nv12_response([frame], notes=["ok"])
    assert blob[:4] == b"AIV1"
    count, note_count = int.from_bytes(blob[4:8], "little"), int.from_bytes(blob[8:12], "little")
    assert (count, note_count) == (1, 1)
