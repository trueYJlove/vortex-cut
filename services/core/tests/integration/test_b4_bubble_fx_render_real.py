"""气泡/花字真渲染集成测试（M2-B4 收官，设计 §5.2）。

真实 FFmpeg + libass 渲染，验证：
- 基础 override 标签（B4 既有，包 {} 后）真渲染生效——字号/颜色像素级验证
  （历史缺陷回归锁：裸标签不带 {} 时 libass 不解析，标签当正文丢弃）；
- 气泡 border_style=3：底衬块颜色（back_color）出现在文字周围；
- 花字 fx_preset：模板色真渲染生效（gold-gradient 金橙主体）。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

from aivs_core.rendering.ass import build_ass, CaptionResources

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()
FONTS_DIR = Path("resources/fonts")


def _render_ass(captions: list[dict], out_png: Path) -> np.ndarray:
    resources = CaptionResources(FONTS_DIR)
    bundle, presets, _ = resources.load()
    ass_text = build_ass(captions, bundle, presets)
    ass_path = FONTS_DIR / "_itest.ass"
    ass_path.write_text(ass_text, encoding="utf-8-sig")
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-y",
         "-f", "lavfi", "-i", "color=c=blue:size=540x960:rate=30:duration=1",
         "-vf", f"ass={ass_path.as_posix()}:fontsdir={Path('resources/fonts/noto-sans-sc').as_posix()}",
         "-frames:v", "1", "-update", "1", str(out_png)],
        capture_output=True, text=True, timeout=120, check=False)
    assert result.returncode == 0, result.stderr[-1500:]
    return np.asarray(Image.open(out_png).convert("RGB")).astype(int)


def _caption(override: dict) -> dict:
    return {"start_us": 0, "end_us": 1_000_000, "text": "测试字幕",
            "preset_id": "default-bottom", "style_override": override}


def _nonblue(img: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mask = ~(np.abs(img - np.array([0, 0, 255])).sum(axis=2) < 30)
    ys, xs = np.nonzero(mask)
    return ys, xs


def _color_count(img: np.ndarray, rgb: tuple[int, int, int], tol: int = 90) -> int:
    return int((np.abs(img - np.array(rgb)).sum(axis=2) < tol).sum())


def test_override_tags_actually_render(tmp_path: Path) -> None:
    """回归锁（历史缺陷）：override 标签必须包 {} 才被 libass 解析。
    font_size 96 的字面高度显著大于预设 64；primary_color BGR 30FFFF=黄。"""
    img = _render_ass([_caption({"font_size": 96, "primary_color": "&H0030FFFF"})],
                      tmp_path / "override.png")
    ys, _xs = _nonblue(img)
    height = ys.max() - ys.min()
    # 64px 预设基线：单独渲染一次取高度对照。
    base = _render_ass([_caption({})], tmp_path / "base.png")
    ys_b, _xs_b = _nonblue(base)
    height_base = ys_b.max() - ys_b.min()
    assert height > height_base * 1.2, (height, height_base)  # 96/64 显著更大
    # BGR 30FFFF → RGB (255,255,48) 黄色主体存在。
    assert _color_count(img, (255, 255, 48)) > 50, "primary_color 未生效"


def test_bubble_back_renders(tmp_path: Path) -> None:
    """气泡 border_style=3 + back_color=暗红：底衬块色出现在文字区域。"""
    img = _render_ass([_caption({"border_style": 3, "back_color": "&H002020A0"})],
                      tmp_path / "bubble.png")
    # ASS BGR A02020 → RGB (32,32,160) 暗红底衬块。
    assert _color_count(img, (32, 32, 160)) > 120, "气泡底衬色未渲染"


def test_fx_preset_renders(tmp_path: Path) -> None:
    """花字 gold-gradient：金橙主体（BGR 20C0FF → RGB 255,192,32）生效。"""
    img = _render_ass([_caption({"fx_preset": "gold-gradient"})], tmp_path / "fx.png")
    assert _color_count(img, (255, 192, 32), tol=120) > 30, "花字模板主体色未渲染"
