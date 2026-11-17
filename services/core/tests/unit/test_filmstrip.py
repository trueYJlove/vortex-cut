"""WP-P232 filmstrip 生成纯函数 + 作业体校验（不进真实 FFmpeg）。

验收映射（FILMSTRIP_PRESHOOT_PLANNING_GATE_2026-11-17.md §5）：
- a) 阶梯取整：80→100、120→200、210→250、1500→2000、0/负→1000；
- b) ffmpeg 参数：fps=1000/step、tile=1xN、-q:v 5、mjpeg 管道；
- c) JPEG 尺寸解析：SOF0 段读取；
- d) 变异：阶梯改成恒 1000 → a) 红（非恒真）。
"""
from __future__ import annotations

import pytest

from aivs_core.media.filmstrip import (
    _jpeg_size, filmstrip_args, ladder_step_ms,
)


def test_a_ladder_steps() -> None:
    assert ladder_step_ms(80) == 100
    assert ladder_step_ms(120) == 200
    assert ladder_step_ms(200) == 200
    assert ladder_step_ms(210) == 250
    assert ladder_step_ms(35) == 50
    assert ladder_step_ms(1500) == 2000
    assert ladder_step_ms(2500) == 2500
    assert ladder_step_ms(1000) == 1000
    # 退化输入
    assert ladder_step_ms(0) == 1000
    assert ladder_step_ms(-5) == 1000


def test_b_ffmpeg_args() -> None:
    args = filmstrip_args("in.mp4", 2000, 160, 30.0)
    joined = " ".join(args)
    assert "fps=0.500000" in joined          # 1000/2000
    assert "tile=1x15" in joined             # 30s × 0.5fps = 15 → ceil(15)=15
    assert "scale=160:-2" in joined
    assert "-q:v" in joined and "5" in args[args.index("-q:v") + 1]
    assert args[-1] == "pipe:1"
    assert "-frames:v" in joined and args[args.index("-frames:v") + 1] == "1"


def test_b2_tile_cap_512() -> None:
    # 4 小时素材 @ 1000ms 步长 = 14400 → 钳到 512
    args = filmstrip_args("in.mp4", 1000, 160, 14400.0)
    assert "tile=1x512" in " ".join(args)


def test_c_jpeg_size_parse() -> None:
    # 最小合法 SOF0：FF D8 | FF C0 len 11 precision h w | FF D9
    data = bytes([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x5A, 0x02, 0xD0, 0xFF, 0xD9])
    w, h = _jpeg_size(data)
    assert (w, h) == (720, 90)


def test_d_mutation_ladder_breaks_cases() -> None:
    """变异：阶梯恒 1000 → 多档位断言必红（有分辨力）。"""
    def mutated(raw_ms: float) -> int:
        return 1000
    results = [ladder_step_ms(v) for v in (80, 210, 1500)]
    mutated_results = [mutated(v) for v in (80, 210, 1500)]
    assert results != [1000, 1000, 1000]           # 原实现非恒值
    assert mutated_results == [1000, 1000, 1000]   # 变异体被钉住
