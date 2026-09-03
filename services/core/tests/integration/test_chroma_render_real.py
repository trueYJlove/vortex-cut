from __future__ import annotations

import math
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
    # 绿幕地面 + 中心品红圆形。背景为蓝色。两部均 540x960（无加黑边）。
    main = root / "main.mp4"
    gg = root / "green_magenta.mp4"
    # 背景：蓝色
    _run("-f", "lavfi", "-i", "color=c=blue:size=540x960:rate=30:duration=3",
         "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-an", str(main))
    # 绿幕上叠品红圆（中心），圆外纯绿。
    gfilter = ("color=green:size=540x960:rate=30:duration=1,"
               "drawbox=x=170:y=330:w=200:h=300:color=magenta:t=fill")
    _run("-f", "lavfi", "-i", gfilter, "-c:v", "libopenh264", "-b:v", "1M",
         "-pix_fmt", "yuv420p", "-an", str(gg))
    return main, gg


def _render(tmp_path: Path, main: Path, src: Path, keying: dict | None, name: str) -> Path:
    out = tmp_path / name
    seg = {"clip_id": "pip", "track_id": "V2", "asset_kind": "video",
           "source_start_us": 0, "source_end_us": 1_000_000,
           "timeline_start_us": 0, "timeline_end_us": 1_000_000,
           "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
           "transform": {"x": 0.5, "y": 0.5, "scale": 1.0}}
    if keying:
        seg["keying"] = keying
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
    args = build_timeline_args(plan, [main, src],
                               [{"audio_streams": []}, {"audio_streams": []}],
                               "libopenh264", str(out), captions=False)
    _run(*args, cwd=tmp_path)
    assert out.exists() and out.stat().st_size > 0
    return out


def test_keying_makes_green_transparent(tmp_path: Path) -> None:
    """真渲染：绿幕抠像使绿色区域透出蓝色主画面，品红区域保留。"""
    main, gg = _fixtures(tmp_path)
    keyed = _render(tmp_path, main, gg, {"color": "00FF00", "similarity": 0.35, "blend": 0.1}, "keyed.mp4")

    # 绿区（原绿色区域，如左上角 (60,60)）：应显示主画面的蓝色。
    r_g, g_g, b_g = _pixel(keyed, 0.5, 60, 60)
    # 品红区（中心）：应保留品红（R,B 高、G 低）。
    r_m, g_m, b_m = _pixel(keyed, 0.5, 270, 420)
    # 绿区应无绿（绿色被抠除 → 显示主画面蓝色，blue 通道高）。
    assert b_g > 150 and g_g < 120, (r_g, g_g, b_g)
    assert r_m > 150 and b_m > 150 and g_m < 100, (r_m, g_m, b_m)


def test_chroma_keying_diff_uns_keyed(tmp_path: Path) -> None:
    """真渲染：启用抠像显著改变绿区合成（vs 无抠像全品红+绿）。"""
    main, gg = _fixtures(tmp_path)
    text = _render(tmp_path, main, gg, None, "no_key.mp4")
    keyed = _render(tmp_path, main, gg, {"color": "00FF00", "similarity": 0.35, "blend": 0.1}, "keyed2.mp4")
    a = _pixel(text, 0.5, 60, 60)
    b = _pixel(keyed, 0.5, 60, 60)
    delta = sum(abs(x - y) for x, y in zip(a, b))
    assert delta > 60, (a, b)


def test_mask_and_keying_combine(tmp_path: Path) -> None:
    """真渲染：蒙版与抠像并存。绿幕由 keying 抠除（透主画面），且仅蒙版窗口内可见。

    用矩形蒙版窗口只框住 PIP 图左半（绿幕），因此：
    - 蒙版窗口内 + 绿色部分 --> 抠掉 --> 显示主画面蓝色；
    - 蒙版窗口外（PIP 自身） --> 不可见 --> 显示主画面；
    - 中心品红在蒙版窗口内? 本测试把蒙版窗口集中在含品红的区域来证明两者并存不影响。
    """
    main, gg = _fixtures(tmp_path)
    out = tmp_path / "mask_key.mp4"
    # 窄矩形蒙版窗：中心 x=0.2，宽 0.3，高满；覆盖 x∈[54,189]，不含中央品红(x170-370)。
    seg = {"clip_id": "pip", "track_id": "V2", "asset_kind": "video",
           "source_start_us": 0, "source_end_us": 1_000_000,
           "timeline_start_us": 0, "timeline_end_us": 1_000_000,
           "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
           "transform": {"x": 0.5, "y": 0.5, "scale": 1.0},
           "mask": {"kind": "rect", "x": 0.2, "y": 0.5, "width": 0.3, "height": 1.0, "feather": 0.02},
           "keying": {"color": "00FF00", "similarity": 0.35, "blend": 0.1}}
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
    args = build_timeline_args(plan, [main, gg],
                               [{"audio_streams": []}, {"audio_streams": []}],
                               "libopenh264", str(out), captions=False)
    _run(*args, cwd=tmp_path)
    assert out.exists() and out.stat().st_size > 0

    # 仅在抠像（无蒙版）时，中央品红(270,430) 保留为品红；加蒙版后该点(PIP外)被裁掉 → 显著不同。
    key_only = _render(tmp_path, main, gg, {"color": "00FF00", "similarity": 0.35, "blend": 0.1}, "key_only.mp4")
    a = _pixel(key_only, 0.5, 270, 430)
    b = _pixel(out, 0.5, 270, 430)
    assert (a[0] > 120 and a[2] > 120), a
    assert sum(abs(x - y) for x, y in zip(a, b)) > 40, (a, b)
    # 蒙版窗口内（左绿 x≈80）仍吃到 keying：绿色被抠，接近主画面而非纯绿。
    r_g, g_g, b_g = _pixel(out, 0.5, 80, 480)
    assert g_g < 220 and b_g > 90, (r_g, g_g, b_g)