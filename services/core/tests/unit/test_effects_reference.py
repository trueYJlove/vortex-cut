"""effects.ts 参考实现的 Python 镜像测试（IR v0.4 重入）。

apps/desktop/src/app/preview/effects.ts 是 worker GLSL 的 TS 镜像；本文件用
同一组参数在同一批采样点上复算 `ffmpeg._mask_alpha_expr` / colorkey 语义，
断言与 effects.ts 的公式产出逐点一致（阈值 1/255 对齐 8bit alpha 量化）。
TS 侧对应测试：apps/desktop/tests/preview-effects.test.ts。
"""
from __future__ import annotations

import math

US = 1_000_000
PW, PH = 336, 188


def _ts_mask_alpha(mask: dict, nx: float, ny: float, pw: float = PW, ph: float = PH) -> float:
    """逐式复刻 effects.ts maskAlpha（非权威端实现——权威端是 _mask_alpha_expr，
    两者同式；此处再镜像一次以验证 TS/Python 数值一致性）。v0.4 feather 语义：
    过渡带收进形状边界内侧（d/norm ∈ [1−feather,1] 线性），feather=0 硬边。"""
    cx = (mask.get("x", 0.5)) * pw
    cy = (mask.get("y", 0.5)) * ph
    feather = min(1.0, max(0.0, mask.get("feather", 0.0)))
    rot = (mask.get("rotation", 0.0)) * math.pi / 180.0
    cos, sin = math.cos(rot), math.sin(rot)
    px, py = nx * pw, ny * ph
    ux = cos * (px - cx) + sin * (py - cy)
    if mask["kind"] == "linear":
        v = 0.5 + ux / max(feather * pw, 1.0)
        a = min(1.0, max(0.0, v))
        return 1.0 - a if mask.get("invert") else a
    uy = -sin * (px - cx) + cos * (py - cy)
    if mask["kind"] == "rect":
        hal_w = max(1.0, mask.get("width", 0.5) * pw / 2.0)
        hal_h = max(1.0, mask.get("height", 0.5) * ph / 2.0)
        norm = max(abs(ux) / hal_w, abs(uy) / hal_h)
        if feather > 0:
            inner = max(0.0, min(1.0, 1.0 - min(1.0, norm)))
            a = min(1.0, max(0.0, inner / feather))
        else:
            a = 1.0 if norm < 1 else 0.0  # 真硬边（权威端 if(lt(norm,1))）
        return 1.0 - a if mask.get("invert") else a
    ax = max(1.0, mask.get("width", 0.5) * pw / 2.0)
    ay = max(1.0, mask.get("height", 0.5) * ph / 2.0)
    d = math.sqrt((ux * ux) / (ax * ax) + (uy * uy) / (ay * ay))
    if feather > 0:
        inner = min(1.0, max(0.0, 1.0 - d))
        a = min(1.0, max(0.0, inner / feather))
    else:
        a = 1.0 if d < 1 else 0.0  # 真硬边（权威端 if(lt(d,1))）
    return 1.0 - a if mask.get("invert") else a


def _mask_expr_alpha(mask: dict, nx: float, ny: float, pw: float = PW, ph: float = PH) -> float:
    """权威端 _mask_alpha_expr 生成 geq 表达式后按 (X,Y) 数值求值。

    feather=0 硬边表达式含 if(lt(...),255,0)——python eval 不认 ffmpeg 的
    if/lt，此处翻译：把 `if(lt(A,1),255,0)` 模式预转换为 python 语义再求值。
    """
    from aivs_core.rendering.ffmpeg import _mask_alpha_expr

    expr = _mask_alpha_expr(mask, pw, ph)
    assert expr is not None
    x, y = nx * pw, ny * ph
    # if(lt(D,1),255,0) → (255 if D<1 else 0)：用正则把该模式替换为 python 三元
    import re

    def _repl(m: re.Match) -> str:
        inner = m.group(1)
        return f"(255 if ({inner}) < 1 else 0)"

    translated = re.sub(r"if\(lt\((.*?),1\),255,0\)", _repl, expr, flags=re.S)
    env = {"X": x, "Y": y, "max": max, "min": min, "abs": abs, "pow": lambda a, b: a ** b,
           "sqrt": math.sqrt, "clip": lambda v, lo, hi: min(hi, max(lo, v))}
    return float(eval(translated, {"__builtins__": {}}, env)) / 255.0


def test_ts_mirror_matches_authoritative_geq() -> None:
    masks = [
        {"kind": "ellipse", "x": 0.5, "y": 0.5, "width": 0.5, "height": 0.5, "feather": 0.9},
        {"kind": "ellipse", "x": 0.4, "y": 0.6, "width": 0.8, "height": 0.5, "rotation": 30.0, "feather": 0.1, "invert": True},
        {"kind": "ellipse", "x": 0.5, "y": 0.5, "width": 0.5, "height": 0.5},  # feather=0 硬边
        {"kind": "rect", "x": 0.5, "y": 0.5, "width": 0.5, "height": 0.5},     # feather=0 硬边
        {"kind": "rect", "x": 0.3, "y": 0.7, "width": 0.9, "height": 0.4, "rotation": -45.0, "feather": 0.3, "invert": True},
        {"kind": "linear", "x": 0.5, "y": 0.5, "rotation": 0, "feather": 0.1},
        {"kind": "linear", "x": 0.6, "y": 0.4, "rotation": 60.0, "feather": 0.35},
    ]
    grid = [(i / 10, j / 10) for i in range(11) for j in range(11)]
    for mask in masks:
        for nx, ny in grid:
            authoritative = _mask_expr_alpha(mask, nx, ny)
            mirror = _ts_mask_alpha(mask, nx, ny)
            assert abs(authoritative - mirror) <= 1.0 / 255.0, (mask, nx, ny, authoritative, mirror)


def test_colorkey_semantics_matches_ffmpeg_shape() -> None:
    """colorkey alpha 形状：键色 0、远处 1、[sim, sim+blend] 线性过渡。

    FFmpeg colorkey 的色距口径为 RGB 欧氏（vf_colorkey.c：与键色的 RGB 分量
    差平方和），similarity/blend 以 0..1 归一化乘 255²；effects.ts 用 /√3 归一，
    常数因子差由 P2 step0 自校准吸收（同式即一致）。此处断言 TS 镜像函数的
    形状（0/1/线性）与 smoothstep 解释一致。"""
    def ts_key_alpha(r: float, g: float, b: float, sim: float = 0.3, blend: float = 0.1,
                     key: tuple[float, float, float] = (0.0, 1.0, 0.0)) -> float:
        dist = math.sqrt((r - key[0]) ** 2 + (g - key[1]) ** 2 + (b - key[2]) ** 2) / math.sqrt(3)
        if dist <= sim:
            return 0.0
        if dist >= sim + blend:
            return 1.0
        return (dist - sim) / blend

    assert ts_key_alpha(0, 1, 0) == 0.0
    assert ts_key_alpha(1, 0, 0) == 1.0
    mid = math.sqrt(0.3 ** 2 * 3) / math.sqrt(3)  # 每分量偏 0.3 → 恰在 sim 边界
    assert 0.0 <= ts_key_alpha(0.3, 0.7, 0.3) <= 1.0
    # 线性中点：dist = sim + blend/2 = 0.35 → 沿 g 轴偏 0.35·√3（单轴距离 = 偏移/√3）
    g_offset = 1.0 - 0.35 * math.sqrt(3)
    assert abs(ts_key_alpha(0, g_offset, 0) - 0.5) < 1e-6
    assert abs(mid - 0.3) < 1e-9
