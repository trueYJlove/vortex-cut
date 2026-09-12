"""B11 代理档位/归一化/时间映射单测（计划第 6 节 B11 验收口径）。

覆盖：
- 档位选择与尺寸：短边封顶（禁止上采样）、旋转/SAR 显示比例、偶数宽高。
- FFmpeg 参数白名单：编码器专属参数（硬编无 veryfast）、CFR30、GOP≤15、
  无 B 帧、pts 归零、无 -t 时长限制。
- 时间映射：proxyTimeUs = sourceTimeUs - origin（含非零起始 PTS 源）；
  帧号映射只构造请求，不猜原片索引。
"""
from __future__ import annotations

import pytest

from aivs_core.media.proxy_profiles import (
    OUTPUT_FPS,
    PROFILE_IDS,
    choose_profile,
    coded_size,
    display_size,
    frame_n_to_source_us,
    normalize_source,
    normalized_codec,
    proxy_args,
    proxy_time_us,
    short_edge,
    source_time_us,
)


class TestCodedSize:
    def test_short_edge_capped_no_upscale(self) -> None:
        # 1080p 横屏 → 720 档：短边 720（降采样），比例保持
        assert coded_size("preview-720-v1", 1920, 1080) == (1280, 720)
        # 540 竖屏源 → 720 档：原短边 540 < 720 → 原尺寸（禁止上采样）
        assert coded_size("preview-720-v1", 960, 540) == (960, 540)
        # 4K → 1080 档
        assert coded_size("preview-1080-v1", 3840, 2160) == (1920, 1080)

    def test_display_ratio_preserved_with_sar(self) -> None:
        # SAR 2:1 的 1920×1080 → 显示 3840×1080（8:3）；540 档 → 1920×540
        w, h = coded_size("preview-540-v1", 1920, 1080, sar=2.0)
        assert (w, h) == (1920, 540)

    def test_rotation_swaps_axes(self) -> None:
        # 竖拍源 1920×1080 + rotate=90 → 显示 1080×1920；540 档 → 540 短边
        assert display_size(1920, 1080, 1.0, 90) == (1080, 1920)
        w, h = coded_size("preview-540-v1", 1920, 1080, rotation=90)
        assert (w, h) == (540, 960)

    def test_even_dimensions(self) -> None:
        # 1085 高 → 奇数短边收 1 像素（内收不上采样）
        for profile in PROFILE_IDS:
            w, h = coded_size(profile, 1085, 1085)
            assert w % 2 == 0 and h % 2 == 0
            assert w <= 1085 and h <= 1085

    def test_invalid_geometry_raises(self) -> None:
        with pytest.raises(ValueError):
            coded_size("preview-720-v1", 0, 1080)

    def test_unknown_profile_raises(self) -> None:
        with pytest.raises(ValueError):
            short_edge("preview-999-v1")


class TestChooseProfile:
    def test_by_source_short_edge(self) -> None:
        assert choose_profile(540, 960) == "preview-540-v1"
        assert choose_profile(1280, 720) == "preview-720-v1"
        # 默认预算 720：1080p 源也降到 720 档（高分辨率长源防代理过大）
        assert choose_profile(3840, 2160) == "preview-720-v1"
        # 预算 1080（B13 接入负载预算后可放开）
        assert choose_profile(3840, 2160, budget_short_edge=1080) == "preview-1080-v1"

    def test_budget_downgrades(self) -> None:
        # 预算 540：1080p 源也降 540 档
        assert choose_profile(3840, 2160, budget_short_edge=540) == "preview-540-v1"
        # 预算 720：1080p 源降到 720 档（默认行为）
        assert choose_profile(3840, 2160, budget_short_edge=720) == "preview-720-v1"
        # 预算 1080：1080p 源保持 1080 档
        assert choose_profile(3840, 2160, budget_short_edge=1080) == "preview-1080-v1"

    def test_square_source_540(self) -> None:
        # 方形 540×540 源：短边 540 → 540 档
        assert choose_profile(540, 540) == "preview-540-v1"


class TestProxyArgs:
    def test_software_x264_profile_params(self) -> None:
        args = proxy_args("in.mp4", "out.mp4", "preview-720-v1", 1920, 1080, "libx264")
        assert "-preset" in args and args[args.index("-preset") + 1] == "medium"
        assert "-crf" in args
        # 严禁给硬件编码器无条件传 veryfast（这里验证软件档位不是 veryfast）
        assert "veryfast" not in args
        # 尺寸进入 scale filter 且为偶数
        scale = args[args.index("-vf") + 1]
        assert "scale=1280:720" in scale
        assert "force_divisible_by=2" in scale

    def test_openh264_bitrate(self) -> None:
        args = proxy_args("in.mp4", "out.mp4", "preview-540-v1", 960, 540, "libopenh264")
        assert "-b:v" in args and args[args.index("-b:v") + 1] == "2M"

    def test_hardware_encoder_no_veryfast(self) -> None:
        for encoder in ("h264_nvenc", "h264_qsv", "h264_amf"):
            args = proxy_args("in.mp4", "out.mp4", "preview-1080-v1", 3840, 2160, encoder)
            assert "veryfast" not in args
            assert args[args.index("-b:v") + 1] == "9M"

    def test_unknown_encoder_rejected(self) -> None:
        with pytest.raises(ValueError):
            proxy_args("in.mp4", "out.mp4", "preview-720-v1", 1920, 1080, "mpeg4")

    def test_cfr30_closed_gop_no_bframes(self) -> None:
        args = proxy_args("in.mp4", "out.mp4", "preview-720-v1", 1920, 1080, "libx264")
        assert args[args.index("-r") + 1] == str(OUTPUT_FPS)
        gop = int(args[args.index("-g") + 1])
        assert 0 < gop <= 15
        assert int(args[args.index("-keyint_min") + 1]) == gop
        assert args[args.index("-bf") + 1] == "0"
        assert args[args.index("-sc_threshold") + 1] == "0"
        assert args[args.index("-pix_fmt") + 1] == "yuv420p"
        assert "+faststart" in args

    def test_full_source_no_duration_limit_and_pts_zeroing(self) -> None:
        """全源代理（B11 核心差异）：不是 build_render_args 的 10 秒 sample。"""
        args = proxy_args("in.mp4", "out.mp4", "preview-720-v1", 1920, 1080, "libx264")
        assert "-t" not in args  # 不限制时长（旧 sample 路径默认 10s）
        assert args[args.index("-ss") + 1] == "0"  # rewrite 首帧偏移（非 -copyts）
        assert "-copyts" not in args
        assert "-an" in args  # 代理不含音频（音频走原素材 B15）
        assert "-map" in args and args[args.index("-map") + 1] == "0:v:0"
        assert args[-1] == "out.mp4" and args[args.index("-i") + 1] == "in.mp4"
        assert "-progress" in args and "pipe:1" in args

    def test_no_arbitrary_filter_injection(self) -> None:
        """参数由模块白名单组装：filter 固定 scale+fps，无 drawbox 等注入面。"""
        args = proxy_args("in.mp4", "out.mp4", "preview-720-v1", 1920, 1080, "libx264")
        scale = args[args.index("-vf") + 1]
        assert scale.count(",") == 1  # scale=... 0帧fps=...（仅两节）


class TestTimeMapping:
    def test_proxy_time_offsets_origin(self) -> None:
        # 非零起始 PTS 源（首显示帧 1.5s 起）
        assert proxy_time_us(1_500_000, 1_500_000) == 0
        assert proxy_time_us(2_000_000, 1_500_000) == 500_000

    def test_roundtrip(self) -> None:
        assert source_time_us(proxy_time_us(123_456, 7_000), 7_000) == 123_456

    def test_frame_n_midpoint_sampling(self) -> None:
        # 帧中点：f=0 → 16_667us（CFR30 第 0 帧 PTS=0 的最近邻请求域）
        assert frame_n_to_source_us(0) == 16_667
        assert frame_n_to_source_us(30) == 1_016_667
        # 与 decode-worker ±33ms 容差匹配：帧中点距帧边界 ≤ 半帧（16.7ms）
        for n in (0, 1, 29, 450):
            pts = round(n * 1_000_000 / OUTPUT_FPS)
            assert abs(frame_n_to_source_us(n) - pts) <= 500_000 / OUTPUT_FPS + 1


class TestNormalizeSource:
    def test_full_stream(self) -> None:
        stream = normalize_source({
            "codec": "h264", "width": 1920, "height": 1080, "rotation": 90,
            "sample_aspect_ratio_num": 1, "sample_aspect_ratio_den": 1,
            "avg_frame_rate_num": 30000, "avg_frame_rate_den": 1001,
        })
        assert stream is not None
        assert stream["width"] == 1920 and stream["rotation"] == 90
        assert stream["fps_num"] == 30000

    def test_missing_geometry_returns_none(self) -> None:
        assert normalize_source({"codec": "h264"}) is None
        assert normalize_source({"width": 0, "height": 0}) is None
        assert normalize_source(None) is None

    def test_missing_fields_defaults(self) -> None:
        stream = normalize_source({"width": 640, "height": 480})
        assert stream is not None
        assert stream["rotation"] == 0
        assert stream["sar_num"] == 0 and stream["sar_den"] == 0
        assert stream["fps_num"] == 0

    def test_normalized_codec(self) -> None:
        assert normalized_codec("H264") == "h264"
        assert normalized_codec(None) is None
        assert normalized_codec("") is None


class TestProfileRegistry:
    def test_profiles_are_short_edge_ladder(self) -> None:
        edges = [short_edge(profile) for profile in PROFILE_IDS]
        assert edges == sorted(edges) == [540, 720, 1080]
