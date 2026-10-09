"""气泡/花字真渲染集成测试（M2-B4 收官，设计 §5.2）。

真实 FFmpeg + libass 渲染，验证：
- 基础 override 标签（B4 既有，包 {} 后）真渲染生效——字号/颜色像素级验证
  （历史缺陷回归锁：裸标签不带 {} 时 libass 不解析，标签当正文丢弃）；
- 气泡 border_style=3：底衬块颜色（back_color）出现在文字周围；
- 花字 fx_preset：模板色真渲染生效（gold-gradient 金橙主体）。

落盘卫生（2026-10-09 修复）：真渲染的全部产物（.ass/.png/字体副本）只落
pytest 临时树，不再写进仓库树。旧实现把 _itest.ass 写入 resources/fonts/
且不清理，每轮全量回归后 git status 都多一个未跟踪脏文件。
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from aivs_core.rendering.ass import build_ass, CaptionResources

# 由 __file__ 推导（而非依赖 pytest 的 cwd）：本测试的 subprocess 用独立
# render_cwd，仓库路径必须与进程 cwd 解耦（与 test_cv_signals_real 同款做法）。
REPO_ROOT = Path(__file__).resolve().parents[4]
FFMPEG = REPO_ROOT / "resources/ffmpeg/win-x64/ffmpeg.exe"
FONTS_DIR = REPO_ROOT / "resources/fonts"
NOTO_FONTS = FONTS_DIR / "noto-sans-sc"


@pytest.fixture(scope="session")
def render_cwd(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """真渲染工作目录（会话级：字体只拷一次，落在 pytest 临时树）。

    镜像生产端（rendering/service.py）：注册字体拷入渲染 cwd，滤镜参数用
    纯相对路径 ass=...:fontsdir=fonts。不能改用绝对路径——lavfi 滤镜参数按
    ":" 分隔，盘符冒号会把路径切碎（实测盘符冒号转义在滤镜图解析层不存活：
    盘符被当作 filename、剩余段被塞给 original_size），只能 cwd + 相对路径。
    """
    workdir = tmp_path_factory.mktemp("b4-render")
    shutil.copytree(NOTO_FONTS, workdir / "fonts")
    return workdir


def _render_ass(captions: list[dict], out_png: Path, cwd: Path) -> np.ndarray:
    resources = CaptionResources(FONTS_DIR)
    bundle, presets, _ = resources.load()
    ass_text = build_ass(captions, bundle, presets)
    # .ass 与 .png 同落该测试专属 tmp_path；滤镜参数取相对 cwd 的 POSIX 路径
    # （同一 pytest 临时树内，relpath 不含盘符冒号与空格）。
    ass_path = out_png.parent / "_itest.ass"
    ass_path.write_text(ass_text, encoding="utf-8-sig")
    ass_arg = Path(os.path.relpath(ass_path, cwd)).as_posix()
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-y",
         "-f", "lavfi", "-i", "color=c=blue:size=540x960:rate=30:duration=1",
         "-vf", f"ass={ass_arg}:fontsdir=fonts",
         "-frames:v", "1", "-update", "1", str(out_png)],
        capture_output=True, text=True, timeout=120, check=False, cwd=cwd)
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


def test_override_tags_actually_render(tmp_path: Path, render_cwd: Path) -> None:
    """回归锁（历史缺陷）：override 标签必须包 {} 才被 libass 解析。
    font_size 96 的字面高度显著大于预设 64；primary_color BGR 30FFFF=黄。"""
    img = _render_ass([_caption({"font_size": 96, "primary_color": "&H0030FFFF"})],
                      tmp_path / "override.png", render_cwd)
    ys, _xs = _nonblue(img)
    height = ys.max() - ys.min()
    # 64px 预设基线：单独渲染一次取高度对照。
    base = _render_ass([_caption({})], tmp_path / "base.png", render_cwd)
    ys_b, _xs_b = _nonblue(base)
    height_base = ys_b.max() - ys_b.min()
    assert height > height_base * 1.2, (height, height_base)  # 96/64 显著更大
    # BGR 30FFFF → RGB (255,255,48) 黄色主体存在。
    assert _color_count(img, (255, 255, 48)) > 50, "primary_color 未生效"


def test_bubble_back_renders(tmp_path: Path, render_cwd: Path) -> None:
    """气泡 border_style=3 + back_color=暗红：底衬块色出现在文字区域。"""
    img = _render_ass([_caption({"border_style": 3, "back_color": "&H002020A0"})],
                      tmp_path / "bubble.png", render_cwd)
    # ASS BGR A02020 → RGB (32,32,160) 暗红底衬块。
    assert _color_count(img, (32, 32, 160)) > 120, "气泡底衬色未渲染"


def test_fx_preset_renders(tmp_path: Path, render_cwd: Path) -> None:
    """花字 gold-gradient：金橙主体（BGR 20C0FF → RGB 255,192,32）生效。"""
    img = _render_ass([_caption({"fx_preset": "gold-gradient"})],
                      tmp_path / "fx.png", render_cwd)
    assert _color_count(img, (255, 192, 32), tol=120) > 30, "花字模板主体色未渲染"


def test_render_writes_nothing_into_repo_tree(tmp_path: Path, render_cwd: Path) -> None:
    """回归锁（2026-10-09 遗留观察）：真渲染不得在仓库树内落任何文件。

    旧实现把 _itest.ass 写进 resources/fonts/ 且不清理，每轮全量回归后
    git status 都多一个未跟踪脏文件。先清历史遗留再渲染，使断言只针对本次。
    """
    stale = FONTS_DIR / "_itest.ass"
    if stale.exists():
        stale.unlink()
    _render_ass([_caption({})], tmp_path / "hygiene.png", render_cwd)
    assert not stale.exists(), "真渲染在 resources/fonts/ 落盘了 _itest.ass——落盘卫生回归"
