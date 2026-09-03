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


def _pixel_rgb(video: Path, time_sec: float, x: int, y: int) -> tuple[float, float, float]:
    """抽取 video 在 time_sec 处 (x,y) 单像素 RGB（0..255），用 ffmpeg rawvideo 输出。"""
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
    _run("-f", "lavfi", "-i", "testsrc2=size=200x400:rate=30:duration=3",
         "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-an", str(main))
    _run("-f", "lavfi", "-i", "color=c=magenta:size=200x400:rate=30:duration=1",
         "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-an", str(pip))
    return main, pip


def _plan(scale: float = 0.25) -> dict:
    return {
        "segments": [
            {"clip_id": "main", "track_id": "V1", "asset_kind": "video",
             "source_start_us": 0, "source_end_us": 3_000_000,
             "timeline_start_us": 0, "timeline_end_us": 3_000_000,
             "layout": "fit", "audio_enabled": False, "gain_db": 0.0},
            {"clip_id": "pip", "track_id": "V2", "asset_kind": "video",
             "source_start_us": 0, "source_end_us": 1_000_000,
             "timeline_start_us": 500_000, "timeline_end_us": 1_500_000,
             "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
             "transform": {"x": 0.85, "y": 0.85, "scale": scale}},
        ],
        "captions": {"items": []},
        "output": {"width": 540, "height": 960},
    }


def test_pip_overlay_renders_magenta_corner(tmp_path: Path) -> None:
    """真渲染验证：V2 覆盖段在对应时间窗内、对应位置真实合成输出。

    坐标为中心点语义（与交互预览 translate(-50%,-50%) 一致）：
    x/y=0.85、scale=0.25 → PIP 尺寸 135×240，中心 (459, 816)，块体完整在画布内。
    """
    main, pip = _fixtures(tmp_path)
    out = tmp_path / "out.mp4"
    scale = 0.25  # pip 尺寸 = 540*0.25=135, 960*0.25=240；中心 (0.85*540, 0.85*960)=(459,816)。
    args = build_timeline_args(_plan(scale), [main, pip],
                               [{"audio_streams": []}, {"audio_streams": []}],
                               "libopenh264", str(out), captions=False)
    with open(tmp_path / "args.json", "w", encoding="utf-8") as f:
        import json
        json.dump(args, f, ensure_ascii=False)
    _run(*args, cwd=tmp_path)
    assert out.exists() and out.stat().st_size > 0

    pip_cx, pip_cy = 459, 816  # PIP 块中心样本（右下区域）
    out_cx, out_cy = 150, 300  # 主画面区（非 PIP）
    # 窗口内 t=1.0：PIP 区显品红 (~192,16,192)。
    ri, gi, bi = _pixel_rgb(out, 1.0, pip_cx, pip_cy)
    assert ri > 150 and bi > 150 and gi < 90, (ri, gi, bi)
    # 窗口内：主区（testsrc2）明显非满品红。
    ro, go, bo = _pixel_rgb(out, 1.0, out_cx, out_cy)
    assert not (ro > 150 and bo > 150 and go < 90), (ro, go, bo)
    # 窗口外 t=2.5（已过 1.5s）：PIP 中心不再品红。
    rl, gl, bl = _pixel_rgb(out, 2.5, pip_cx, pip_cy)
    assert not (rl > 150 and bl > 150 and gl < 90), (rl, gl, bl)