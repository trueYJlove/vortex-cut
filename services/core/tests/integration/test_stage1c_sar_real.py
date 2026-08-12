from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

from aivs_core.rendering.ffmpeg import build_timeline_args

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()


def _run(*args: str, cwd: Path | None = None) -> bytes:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-y", *args],
        cwd=cwd,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr[-2000:].decode("utf-8", errors="replace"))
    return result.stdout


def _source(path: Path, sar: str) -> None:
    _run(
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x240:rate=30:duration=1",
        "-vf",
        f"setsar={sar}",
        "-an",
        "-c:v",
        "libopenh264",
        "-b:v",
        "1M",
        "-pix_fmt",
        "yuv420p",
        str(path),
    )


def _square_source(source: Path, output: Path, display_width: int) -> None:
    _run(
        "-i",
        str(source),
        "-vf",
        f"scale={display_width}:240,setsar=1",
        "-an",
        "-c:v",
        "libopenh264",
        "-b:v",
        "1M",
        "-pix_fmt",
        "yuv420p",
        str(output),
    )


def _render(source: Path, output: Path, layout: str) -> bytes:
    plan = {
        "segments": [
            {
                "asset_kind": "video",
                "source_start_us": 0,
                "source_end_us": 1_000_000,
                "timeline_start_us": 0,
                "timeline_end_us": 1_000_000,
                "layout": layout,
                "audio_enabled": False,
                "gain_db": 0.0,
            }
        ],
        "output": {"width": 540, "height": 960},
    }
    args = build_timeline_args(
        plan,
        [source],
        [{"audio_streams": []}],
        "libopenh264",
        str(output),
        captions=False,
    )
    _run(*args, cwd=output.parent)
    return _run(
        "-v",
        "error",
        "-ss",
        "0.5",
        "-i",
        str(output),
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "-",
    )


def _non_black_bounds(frame: bytes) -> tuple[int, int, int, int]:
    width, height = 540, 960
    points = []
    for y in range(height):
        for x in range(width):
            offset = (y * width + x) * 3
            if max(frame[offset : offset + 3]) > 32:
                points.append((x, y))
    assert points
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return min(xs), min(ys), max(xs) - min(xs) + 1, max(ys) - min(ys) + 1


def _ssim(actual: Path, reference: Path) -> float:
    result = subprocess.run(
        [
            str(FFMPEG),
            "-hide_banner",
            "-i",
            str(actual),
            "-i",
            str(reference),
            "-lavfi",
            "ssim",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        check=False,
    )
    match = re.search(r"All:([0-9.]+)", result.stderr)
    assert result.returncode == 0 and match, result.stderr[-2000:]
    return float(match.group(1))


@pytest.mark.parametrize(
    ("sar", "display_aspect"),
    [("2/1", 8 / 3), ("3/4", 1.0)],
)
@pytest.mark.parametrize("layout", ["fit", "crop_fill", "blurred_background"])
def test_non_square_sar_preserves_display_geometry(
    tmp_path: Path, sar: str, display_aspect: float, layout: str
) -> None:
    source = tmp_path / f"source-{sar.replace('/', '-')}.mp4"
    square_source = tmp_path / f"square-{sar.replace('/', '-')}.mp4"
    output = tmp_path / f"{layout}.mp4"
    reference = tmp_path / f"{layout}-reference.mp4"
    _source(source, sar)
    display_width = round(240 * display_aspect)
    _square_source(source, square_source, display_width)
    frame = _render(source, output, layout)
    _render(square_source, reference, layout)
    similarity = _ssim(output, reference)
    x, y, active_width, active_height = _non_black_bounds(frame)
    assert similarity >= 0.99

    if layout == "fit":
        expected_height = round(540 / display_aspect)
        assert abs(active_width - 540) <= 2
        assert abs(active_height - expected_height) <= 4
        assert abs(y - (960 - expected_height) // 2) <= 3
    else:
        assert (x, y, active_width, active_height) == (0, 0, 540, 960)

    evidence_value = os.environ.get("AIVS_STAGE1C_SAR_EVIDENCE")
    if evidence_value:
        evidence_path = Path(evidence_value)
        existing = (
            json.loads(evidence_path.read_text(encoding="utf-8"))
            if evidence_path.is_file()
            else []
        )
        existing.append(
            {
                "sar": sar,
                "display_aspect": display_aspect,
                "layout": layout,
                "observed_bounds": {
                    "x": x,
                    "y": y,
                    "width": active_width,
                    "height": active_height,
                },
                "expected_fit_height": round(540 / display_aspect),
                "reference_ssim": similarity,
            }
        )
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text(
            json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8"
        )
