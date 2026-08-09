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
