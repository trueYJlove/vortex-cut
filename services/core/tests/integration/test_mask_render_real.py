from __future__ import annotations

import subprocess
from pathlib import Path

from aivs_core.rendering.ffmpeg import build_timeline_args

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()


def _run(*args: str, cwd: Path | None = None) -> str:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-y", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=180, check=False, cwd=cwd,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr[-2500:])
    return result.stderr


def _pixel(video: Path, time_sec: float, x: int, y: int) -> tuple[float, float, float]:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-y", "-ss", f"{time_sec:.4f}", "-i",
         str(video), "-frames:v", "1", "-vf", f"crop=1:1:{x}:{y},format=rgb24",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, timeout=60,
    )
    if result.returncode != 0 or len(result.stdout) < 3:
        raise AssertionError(result.stderr[-800:])
    return float(result.stdout[0]), float(result.stdout[1]), float(result.stdout[2])


def _fixtures(root: Path) -> tuple[Path, Path]:
    main = root / "main.mp4"
    pip = root / "pip.mp4"
    _run("-f", "lavfi", "-i", "color=c=blue:size=200x400:rate=30:duration=3",
         "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-an", str(main))
    _run("-f", "lavfi", "-i", "color=c=magenta:size=200x400:rate=30:duration=1",
         "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-an", str(pip))
    return main, pip


def _render(tmp_path: Path, main: Path, pip: Path, mask: dict | None, name: str) -> Path:
    out = tmp_path / name
    seg = {"clip_id": "pip", "track_id": "V2", "asset_kind": "video",
           "source_start_us": 0, "source_end_us": 1_000_000,
           "timeline_start_us": 500_000, "timeline_end_us": 1_500_000,
           "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
           "transform": {"x": 0.5, "y": 0.5, "scale": 0.6}}
    if mask:
        seg["mask"] = mask
    plan = {
        "segments": [
            {"clip_id": "main", "track_id": "V1", "asset_kind": "video",
             "source_start_us": 0, "source_end_us": 3_000_000,
             "timeline_start_us": 0, "timeline_end_us": 3_000_000,
             "layout": "fit", "audio_enabled": False, "gain_db": 0.0},
            seg,
        ],
        "captions": {"items": []},
        "output": {"width": 540, "height": 960},
    }
    args = build_timeline_args(plan, [main, pip],
                               [{"audio_streams": []}, {"audio_streams": []}],
                               "libopenh264", str(out), captions=False)
    _run(*args, cwd=tmp_path)
    assert out.exists() and out.stat().st_size > 0
    return out


def test_mask_changes_rendered_composition(tmp_path: Path) -> None:
    """真渲染：椭圆蒙版改变覆盖区合成；invert 反转（角部扩为品红）。"""
    main, pip = _fixtures(tmp_path)
    minus = _render(tmp_path, main, pip, None, "no_mask.mp4")
    with_mask = _render(tmp_path, main, pip,
                        {"kind": "ellipse", "x": 0.5, "y": 0.5, "width": 0.5, "height": 0.5, "feather": 0.05},
                        "with_mask.mp4")
    # 蒙版显著改变中心附近合成（mask 内 PIP 的保留/抑制 vs 无蒙版全品红）。
    a = _pixel(minus, 1.0, 270, 400)
    b = _pixel(with_mask, 1.0, 270, 400)
    delta = abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])
    assert delta > 40, (a, b)

    # invert 蒙版：角部（mask 外）转为品红，证明反选生效。
    inv = _render(tmp_path, main, pip,
                  {"kind": "ellipse", "x": 0.5, "y": 0.5, "width": 0.5, "height": 0.5, "feather": 0.05, "invert": True},
                  "invert.mp4")
    ri, gi, bi = _pixel(inv, 1.0, 420, 300)
    # invert 蒙版在 PIP 框内、椭圆外（mask 外区）：普通蒙版透主画面，invert 则品红出现。
    c_r, c_g, c_b = _pixel(with_mask, 1.0, 420, 300)
    delta_inv = abs(ri - c_r) + abs(gi - c_g) + abs(bi - c_b)
    assert delta_inv > 40, ((ri, gi, bi), (c_r, c_g, c_b))