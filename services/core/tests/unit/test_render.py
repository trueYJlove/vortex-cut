from pathlib import Path

from aivs_core.media.render import build_render_args, vertical_filter


def test_vertical_filter_and_args_are_structured() -> None:
    args = build_render_args(
        Path("input 中文.mp4"), Path("out.mp4"), "vertical_sample", "libopenh264", has_audio=True
    )
    assert "1080:1920" in vertical_filter()
    assert "gblur" in vertical_filter()
    assert "-c:v" in args and args[args.index("-c:v") + 1] == "libopenh264"
    assert "-c:a" in args and args[args.index("-c:a") + 1] == "aac"
    assert "shell=True" not in args
    assert all("|" not in item and ";" not in item for item in args if item != vertical_filter())


def test_render_args_cover_start_encoder_and_no_audio() -> None:
    x264 = build_render_args(
        Path("input.mp4"), Path("out.mp4"), "proxy", "libx264", 500_000, 2_000_000, False
    )
    openh264 = build_render_args(Path("input.mp4"), Path("out.mp4"), "proxy", "libopenh264")
    assert x264[x264.index("-ss") + 1] == "0.500000"
    assert x264[x264.index("-crf") + 1] == "28"
    assert x264[-2:] == ["-nostats", "out.mp4"]
    assert "-an" in x264
    assert openh264[openh264.index("-b:v") + 1] == "4M"
