"""A1 音频混音真渲染集成测试（M3-3 第一段，Planning Gate §3.2）。

验收映射：
- A1 配乐 + V1 视频导出：成片含音轨、时长 = 视觉轨总长（±83ms 硬门口径）、
  配乐区间内可测到音频能量（非静音）；
- A1 段 adelay 时基：音频从 timeline_start_us 起才有能量，之前为静音；
- 无 A1 段：产物与旧版语义一致（音轨来自 V1 视频段自身，非回归）；
- 倒放 A1 段：静音占位（该区间无能量）。

真渲染（真实 FFmpeg 进程），fixtures 用 lavfi 合成（无外部素材依赖）。
"""
from __future__ import annotations

import json
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


def _fixtures(root: Path) -> tuple[Path, Path]:
    """V1 主轨视频（3s 蓝底，自带 440Hz 正弦音轨）+ A1 配乐（2s，800Hz 正弦）。"""
    main = root / "main.mp4"
    music = root / "music.mp3"
    _run("-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=3",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
         "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "128k", "-shortest", str(main))
    _run("-f", "lavfi", "-i", "sine=frequency=800:duration=2",
         "-c:a", "libmp3lame", "-b:a", "128k", str(music))
    return main, music


def _audio_segment(clip_id: str, input_id: str, tl0: int, tl1: int, *,
                   reverse: bool = False, gain_db: float = 0.0) -> dict:
    return {
        "clip_id": clip_id, "input_id": input_id, "asset_kind": "audio",
        "source_start_us": 0, "source_end_us": tl1 - tl0,
        "timeline_start_us": tl0, "timeline_end_us": tl1,
        "layout": "fit", "audio_enabled": True, "gain_db": gain_db,
        "speed_milli": 1000, "reverse_playback": reverse, "transition_in": None,
    }


def _render(tmp_path: Path, main: Path, music: Path, *,
            a1: dict | None, name: str) -> Path:
    out = tmp_path / name
    segments: list[dict] = [
        {"clip_id": "main", "track_id": "V1", "asset_kind": "video",
         "source_start_us": 0, "source_end_us": 3_000_000,
         "timeline_start_us": 0, "timeline_end_us": 3_000_000,
         "layout": "fit", "audio_enabled": False, "gain_db": 0.0},
    ]
    paths = [main]
    probes = [{"audio_streams": []}]
    if a1 is not None:
        segments.append(a1)
        paths.append(music)
        probes.append({"audio_streams": [{}]})
    plan = {"segments": segments, "captions": {"items": []},
            "output": {"width": 320, "height": 180}}
    args = build_timeline_args(plan, paths, probes, "libopenh264", str(out), captions=False)
    _run(*args, cwd=tmp_path)
    assert out.exists() and out.stat().st_size > 0
    return out


def _probe_audio(path: Path) -> dict:
    result = subprocess.run(
        [str(FFPROBE), "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name,duration",
         "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=60, check=True)
    return json.loads(result.stdout)


def _rms_window(path: Path, start_sec: float, duration_sec: float) -> float:
    """音频指定时间窗的 RMS 均值（astats）：静音 ≈0，有声显著 >0。"""
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-ss", f"{start_sec:.3f}", "-t", f"{duration_sec:.3f}",
         "-i", str(path), "-map", "0:a:0", "-af", "astats=metadata=1:reset=0",
         "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=60, check=False)
    stderr = result.stderr
    for line in stderr.splitlines():
        if "RMS level dB" in line:
            value = line.split(":")[-1].strip().rstrip("dB").strip()
            try:
                return float(value)
            except ValueError:
                continue
    raise AssertionError(f"astats RMS not found: {stderr[-800:]}")


def test_a1_mix_renders_audio_track(tmp_path: Path) -> None:
    """A1 配乐 + V1 视频：成片含音轨、时长钉视觉轨、配乐区间有声。"""
    main, music = _fixtures(tmp_path)
    # A1 段 [0,2s)：与 V1 [0,3s) 部分重叠；成片时长 = 视觉轨 3s。
    out = _render(tmp_path, main, music,
                  a1=_audio_segment("a1", "I1", 0, 2_000_000), name="a1mix.mp4")
    info = _probe_audio(out)
    stream = info["streams"][0]
    assert stream["codec_name"] == "aac"
    duration = float(info["format"]["duration"])
    assert abs(duration - 3.0) <= 0.084, duration  # 视觉轨总长口径
    # 音频能量：A1+视频有声段 [0,2s) 非静音。
    rms_with_music = _rms_window(out, 0.5, 1.0)
    assert rms_with_music > -60.0, rms_with_music


def test_a1_delay_starts_silent(tmp_path: Path) -> None:
    """adelay 时基：A1 段 [1s,3s) 时，首 0.5s 仅 V1 静音占位（audio_enabled=False
    的 V1 段无音）→ 窗口静音；[1.5s,2.5s) 窗口有声。"""
    main, music = _fixtures(tmp_path)
    out = _render(tmp_path, main, music,
                  a1=_audio_segment("a1", "I1", 1_000_000, 3_000_000), name="delay.mp4")
    rms_head = _rms_window(out, 0.1, 0.8)    # A1 未入场，V1 关声 → 静音
    rms_music = _rms_window(out, 1.5, 1.0)   # A1 配乐区间 → 有声
    assert rms_head < -60.0, rms_head
    assert rms_music > -60.0, rms_music


def test_no_a1_output_matches_legacy(tmp_path: Path) -> None:
    """无 A1 段：成片时长与音轨仍正常（V1 关声 → 音轨为静音占位），无回归。"""
    main, music = _fixtures(tmp_path)
    out = _render(tmp_path, main, music, a1=None, name="noa1.mp4")
    info = _probe_audio(out)
    duration = float(info["format"]["duration"])
    assert abs(duration - 3.0) <= 0.084, duration


def test_a1_reverse_silent_placeholder(tmp_path: Path) -> None:
    """倒放 A1 段：静音占位进 amix（区间无声），成片时长仍钉视觉轨。"""
    main, music = _fixtures(tmp_path)
    out = _render(tmp_path, main, music,
                  a1=_audio_segment("a1rev", "I1", 0, 2_000_000, reverse=True),
                  name="rev.mp4")
    rms = _rms_window(out, 0.5, 1.0)
    assert rms < -60.0, rms
    info = _probe_audio(out)
    assert abs(float(info["format"]["duration"]) - 3.0) <= 0.084
