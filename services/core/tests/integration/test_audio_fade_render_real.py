"""音频淡入/淡出真渲染：实测首/尾包络证明真的淡了（不是只写进文档）。

为什么必须真跑 FFmpeg：afade 写没写进文档、滤链里有没有字符串，都证明不了
听众听到的包络变了。这里用 lavfi 合成 2s 440Hz 正弦，导出后按时间窗取
astats RMS，比较"段首 50ms"与"段中段"的能量比。

预期数字（未夹住、段长 2s 时）：
- 无 fade：首/中比值 ≈ 1（正弦恒幅，±0.1 内）；
- 淡入 1s：正弦 afade 曲线为线性增益，前 50ms 平均幅度 ≈ 1/40 →
  RMS 比 ≈ 0.025（实测见断言下界）。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from aivs_core.rendering.ffmpeg import build_timeline_args

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()
FFPROBE = Path("resources/ffmpeg/win-x64/ffprobe.exe").resolve()

SEGMENT_US = 2_000_000


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
    """V1 静音视频底板（2s testsrc，无音轨）+ 2s 440Hz 正弦音频。"""
    video = root / "base.mp4"
    _run("-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2",
         "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-an", str(video))
    audio = root / "sine.wav"
    _run("-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-c:a", "pcm_s16le", str(audio))
    return video, audio


def _render(root: Path, fixtures: tuple[Path, Path], name: str, **fade: int) -> Path:
    video, audio = fixtures
    out = root / name
    segment = {
        "clip_id": "a1", "track_id": "A1", "input_id": "I1", "asset_kind": "audio",
        "source_start_us": 0, "source_end_us": SEGMENT_US,
        "timeline_start_us": 0, "timeline_end_us": SEGMENT_US,
        "layout": "fit", "audio_enabled": True, "gain_db": 0.0,
        "speed_milli": 1000, "reverse_playback": False, "transition_in": None,
        **fade,
    }
    segments = [
        {
            "clip_id": "v1", "track_id": "V1", "asset_kind": "video",
            "source_start_us": 0, "source_end_us": SEGMENT_US,
            "timeline_start_us": 0, "timeline_end_us": SEGMENT_US,
            "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
        },
        segment,
    ]
    plan = {"segments": segments, "captions": {"items": []},
            "output": {"width": 320, "height": 180}}
    args = build_timeline_args(
        plan, [video, audio],
        [{"audio_streams": []}, {"audio_streams": [{}]}],
        "libopenh264", str(out), captions=False,
    )
    _run(*args, cwd=root)
    assert out.exists() and out.stat().st_size > 0
    return out


def _rms_db(path: Path, start_sec: str, duration_sec: str) -> float:
    """指定时间窗的 RMS（astats，dB）。"""
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-ss", start_sec, "-t", duration_sec,
         "-i", str(path), "-map", "0:a:0", "-af", "astats=metadata=1:reset=0",
         "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=120, check=False,
    )
    for line in result.stderr.splitlines():
        if "RMS level dB" in line:
            return float(line.split(":")[-1].strip().rstrip("dB").strip())
    raise AssertionError(f"astats RMS not found: {result.stderr[-800:]}")


def _ratio(path: Path, start_sec: str) -> float:
    """段首窗口 RMS / 段中窗口 RMS（线性比）。"""
    head = _rms_db(path, start_sec, "0.05")
    middle = _rms_db(path, "1.000", "0.05")
    return 10 ** ((head - middle) / 20)


def test_real_export_fade_in_lowers_head_envelope(tmp_path: Path) -> None:
    """负向对照 1：去掉 afade 生成 ⇒ 首/中比值回到 ≈1 ⇒ 本条红。"""
    fixtures = _fixtures(tmp_path)
    plain = _ratio(_render(tmp_path, fixtures, "plain.mp4"), "0.000")
    faded = _ratio(_render(tmp_path, fixtures, "fadein.mp4", fade_in_us=1_000_000), "0.000")
    print(f"\n[envelope] no-fade head/mid = {plain:.4f}")
    print(f"[envelope] fade-in-1s head/mid = {faded:.4f}")
    # 无淡变：正弦恒幅，段首与段中能量几乎相同。
    assert plain > 0.7, f"无 fade 的段首/中比值应 ≈1，实测 {plain:.4f}"
    # 淡入 1s：段首窗口落在 0-50ms，线性淡入使幅度 ~1/40。
    assert faded < 0.1, f"淡入 1s 的段首/中比值应远小于 1，实测 {faded:.4f}"
    assert faded < plain / 5, "淡入必须让段首显著低于无 fade 基线"


def test_real_export_fade_out_lowers_tail_envelope(tmp_path: Path) -> None:
    """淡出对称验证：尾窗（1.95-2.00s）RMS 显著低于段中。"""
    fixtures = _fixtures(tmp_path)
    plain_path = _render(tmp_path, fixtures, "plain_tail.mp4")
    faded_path = _render(tmp_path, fixtures, "fadeout.mp4", fade_out_us=1_000_000)

    plain_tail = 10 ** ((_rms_db(plain_path, "1.950", "0.05")
                         - _rms_db(plain_path, "1.000", "0.05")) / 20)
    faded_tail = 10 ** ((_rms_db(faded_path, "1.950", "0.05")
                         - _rms_db(faded_path, "1.000", "0.05")) / 20)
    print(f"[envelope] no-fade tail/mid = {plain_tail:.4f}")
    print(f"[envelope] fade-out-1s tail/mid = {faded_tail:.4f}")
    assert plain_tail > 0.7, f"无 fade 的尾/中比值应 ≈1，实测 {plain_tail:.4f}"
    assert faded_tail < 0.1, f"淡出 1s 的尾/中比值应远小于 1，实测 {faded_tail:.4f}"


def test_real_export_overflow_fade_still_renders(tmp_path: Path) -> None:
    """负向对照 3：去掉上限保护 ⇒ 负 st 让导出失败（或整段被静音）⇒ 本条红。

    2s 段设 5s 淡入 + 5s 淡出：按比例收缩到 1s+1s，导出照样成功，
    且首/尾都低、中段不低——证明收缩后是"淡满整段"而不是"整段静音"。
    """
    fixtures = _fixtures(tmp_path)
    out = _render(
        tmp_path, fixtures, "overflow.mp4",
        fade_in_us=5_000_000, fade_out_us=5_000_000,
    )
    head = _ratio(out, "0.000")
    tail = 10 ** ((_rms_db(out, "1.950", "0.05") - _rms_db(out, "1.000", "0.05")) / 20)
    middle_abs = _rms_db(out, "1.000", "0.05")
    print(f"[envelope] overflow head/mid = {head:.4f}, tail/mid = {tail:.4f}, "
          f"mid = {middle_abs:.2f} dB")
    assert head < 0.1 and tail < 0.1
    # 中段有能量：夹住不等于把整段变成静音。
    assert middle_abs > -40.0, f"中段不应被静音，实测 {middle_abs:.2f} dB"
