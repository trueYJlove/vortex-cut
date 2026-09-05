from __future__ import annotations

import subprocess
from pathlib import Path

from aivs_core.rendering.ffmpeg import build_timeline_args

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()
FFPROBE = Path("resources/ffmpeg/win-x64/ffprobe.exe").resolve()


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


def _frame_count(video: Path) -> int:
    result = subprocess.run(
        [str(FFPROBE), "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "default=noprint_wrappers=1:nokey=1",
         str(video)],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr[-800:]
    return int(result.stdout.strip())


def _is_magenta(pixel: tuple[float, float, float]) -> bool:
    r, g, b = pixel
    return r > 150 and b > 150 and g < 110


def _fixtures(root: Path) -> tuple[Path, Path]:
    main = root / "main.mp4"
    pip = root / "pip.mp4"
    _run("-f", "lavfi", "-i", "color=c=blue:size=200x400:rate=30:duration=3",
         "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-an", str(main))
    _run("-f", "lavfi", "-i", "color=c=magenta:size=200x400:rate=30:duration=3",
         "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-an", str(pip))
    return main, pip


def _args(main: Path, pip: Path | None, out: Path, *, rotate: float | None = None) -> list[str]:
    segments = [
        {"clip_id": "mainA", "track_id": "V1", "asset_kind": "video",
         "source_start_us": 0, "source_end_us": 1_000_000,
         "timeline_start_us": 0, "timeline_end_us": 1_000_000,
         "layout": "fit", "audio_enabled": False, "gain_db": 0.0},
        {"clip_id": "mainB", "track_id": "V1", "asset_kind": "video",
         "source_start_us": 0, "source_end_us": 1_000_000,
         "timeline_start_us": 1_000_000, "timeline_end_us": 2_000_000,
         "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
         "keyframes": {"position": {"frames": [
             {"t_us": 0, "x": -0.5, "y": 0.0}, {"t_us": 1_000_000, "x": 0.5, "y": 0.0}]}}},
    ]
    inputs = [main, main]
    probes = [{"audio_streams": []}, {"audio_streams": []}]
    if pip is not None:
        transform: dict[str, float] = {"x": 0.5, "y": 0.5, "scale": 0.6}
        if rotate is not None:
            transform["rotate"] = rotate
        segments.append(
            {"clip_id": "pip", "track_id": "V2", "asset_kind": "video",
             "source_start_us": 0, "source_end_us": 1_000_000,
             "timeline_start_us": 1_000_000, "timeline_end_us": 2_000_000,
             "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
             "transform": transform})
        inputs.append(pip)
        probes.append({"audio_streams": []})
    plan = {"segments": segments, "captions": {"items": []},
            "output": {"width": 540, "height": 960}}
    return build_timeline_args(plan, inputs, probes, "libopenh264", str(out), captions=False)


def _render(tmp_path: Path, name: str, **kwargs) -> Path:
    out = tmp_path / name
    _run(*_args(tmp_path / "main.mp4", tmp_path / "pip.mp4", out, **kwargs), cwd=tmp_path)
    assert out.exists() and out.stat().st_size > 0
    return out


def test_position_keyframes_do_not_extend_rendered_duration(tmp_path: Path) -> None:
    """缺陷回归（M3-0 实证）：position overlay 的黑底主输入 d=timeline_total，
    未终止输出时段链被撑到时间线总长（2s 时间线渲染 3s）——必须止于内容长度。"""
    main, _ = _fixtures(tmp_path)
    out = _render(tmp_path, "position.mp4")
    assert _frame_count(out) == 60, "2s 时间线应渲染 60 帧（30fps）"


def test_pip_rotate_uses_degree_semantics(tmp_path: Path) -> None:
    """缺陷回归（M3-0 实证）：transform.rotate 为度数（contracts -180..180），
    权威端须按度→弧度换算——360° 必须等价无旋转（弧度直传时为 ≈106.6°）。"""
    main, pip = _fixtures(tmp_path)
    # PiP 内容盒（scale 0.6）：pip_w = round(480*0.6/2)*2 = 288, pip_h = round(960*0.6/2)*2 = 576
    # 盒左上角 = (270-144, 480-288) = (126, 192)；探针取盒内 1px 处
    corner = (127, 193)

    r0 = _render(tmp_path, "rot0.mp4", rotate=0.0)
    assert _is_magenta(_pixel(r0, 1.5, *corner)), "无旋转时盒角应为内容色"

    r15 = _render(tmp_path, "rot15.mp4", rotate=15.0)
    assert not _is_magenta(_pixel(r15, 1.5, *corner)), "15° 旋转后盒角应露出底层（内容转出）"

    r360 = _render(tmp_path, "rot360.mp4", rotate=360.0)
    assert _is_magenta(_pixel(r360, 1.5, *corner)), "360° 旋转应等价无旋转（度数语义钉死）"
