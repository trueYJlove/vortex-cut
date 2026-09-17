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
    """真渲染：椭圆蒙版改变覆盖区合成；invert 反转（角部扩为品红）。

    v0.4 feather 语义：过渡带收进边界内侧（d∈[1−feather,1] 线性），feather=0
    硬边。采样点选蒙版边缘过渡带内（d≈0.75）——新语义下该点半透明（混入主
    画面），与无蒙版全品红显著不同。（旧实现 feather 不消费时中心附近即有
    渐变；新语义中心 d<1−feather 全不透明，边缘采样才有区分度。）
    """
    main, pip = _fixtures(tmp_path)
    minus = _render(tmp_path, main, pip, None, "no_mask.mp4")
    # pip 内容盒：200x400 fit 540x960 → 480x960 × scale 0.6 → 288x576，中心 (270,480)
    # 椭圆半轴 ay = 576×0.25 = 144。采样 (270,372)：uy=−108 → d=0.75（过渡带 [0.5,1] 内）
    with_mask = _render(tmp_path, main, pip,
                        {"kind": "ellipse", "x": 0.5, "y": 0.5, "width": 0.5, "height": 0.5, "feather": 0.5},
                        "with_mask.mp4")
    a = _pixel(minus, 1.0, 270, 372)
    b = _pixel(with_mask, 1.0, 270, 372)
    delta = abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])
    assert delta > 40, (a, b)

    # invert 蒙版：角部（mask 外）转为品红，证明反选生效。
    inv = _render(tmp_path, main, pip,
                  {"kind": "ellipse", "x": 0.5, "y": 0.5, "width": 0.5, "height": 0.5, "feather": 0.5, "invert": True},
                  "invert.mp4")
    ri, gi, bi = _pixel(inv, 1.0, 420, 300)
    # invert 蒙版在 PIP 框内、椭圆外（mask 外区）：普通蒙版透主画面，invert 则品红出现。
    c_r, c_g, c_b = _pixel(with_mask, 1.0, 420, 300)
    delta_inv = abs(ri - c_r) + abs(gi - c_g) + abs(bi - c_b)
    assert delta_inv > 40, ((ri, gi, bi), (c_r, c_g, c_b))


def test_mask_feather_hard_vs_soft(tmp_path: Path) -> None:
    """真渲染：feather 语义（v0.4 增补）——0=硬边（边界内侧仍不透明），
    大羽化=边界内侧过渡为透明；羽化不外溢（边界外两档均透主画面）。"""
    main, pip = _fixtures(tmp_path)
    # 形状：width/height=0.6 → 椭圆覆盖 pip 内容盒中心大半。
    # 边界内侧采样点：d≈0.85（椭圆内、过渡带 [1−feather,1] 内）
    # PIP 内容盒 540 高 fit 后 pip 帧约 324x540？——pip 200x400 fit 540x960 画布
    # × scale 0.6 → 内容盒 ≈ 162x324，pip 帧 324 高。半轴 ay≈162、ax≈81。
    # 画布坐标：中心 (270,480)。取 (270, 480−0.85·ay·?) 用 d 的几何换算。
    # 简化：取蒙版中心正上/正下沿 y 轴（ux=0）——d = |uy|/ay。
    inner_y = 480 - int(0.85 * 162)   # d≈0.85
    outer_y = 480 - int(1.15 * 162)   # d≈1.15（边界外）
    hard = _render(tmp_path, main, pip,
                   {"kind": "ellipse", "x": 0.5, "y": 0.5, "width": 0.6, "height": 0.6, "feather": 0.0},
                   "hard.mp4")
    soft = _render(tmp_path, main, pip,
                   {"kind": "ellipse", "x": 0.5, "y": 0.5, "width": 0.6, "height": 0.6, "feather": 0.4},
                   "soft.mp4")
    # 边界内侧（d=0.85）：硬边（feather=0）内部全不透明（品红），
    # 软边（feather=0.4）d=0.85 在过渡带 [0.6,1] 内 → alpha≈0.375（半混蓝）。
    inner_y = 480 - int(0.85 * 162)   # d≈0.85
    # 中心 d=0.5：两档都全实——不可用；改用 d=0.8：硬边全实 vs 软边 alpha=0.5。
    mid_y = 480 - int(0.8 * 162)      # d=0.8
    a_mid_hard = _pixel(hard, 1.0, 270, mid_y)
    a_mid_soft = _pixel(soft, 1.0, 270, mid_y)
    # 软边 d=0.8 半透明（混入主轨蓝）vs 硬边全品红 → 差异显著
    delta_mid = sum(abs(s - h) for s, h in zip(a_mid_soft, a_mid_hard))
    assert delta_mid > 40, (a_mid_soft, a_mid_hard)
    # 边界内侧 d=0.85：软边 alpha≈0.375 vs 硬边 1.0 → 差异可测
    a_in_hard = _pixel(hard, 1.0, 270, inner_y)
    a_in_soft = _pixel(soft, 1.0, 270, inner_y)
    delta_in = sum(abs(s - h) for s, h in zip(a_in_soft, a_in_hard))
    assert delta_in > 25, (a_in_soft, a_in_hard)
    # 边界外 d=1.15：两档均应透主画面（羽化不外溢）——两帧该点像素接近
    a_out_hard = _pixel(hard, 1.0, 270, outer_y)
    a_out_soft = _pixel(soft, 1.0, 270, outer_y)
    delta_out = sum(abs(s - h) for s, h in zip(a_out_soft, a_out_hard))
    assert delta_out < 20, (a_out_hard, a_out_soft)