"""W3.3 S1b：关键帧抽样决策（A5）。

规划门 §3.3 冻结的判据（评审 M2 收敛后）是单值可判定的：
  k <= 24 ⇒ preview 含全部 k 个切点帧，covered_scene_cuts == k
  k >  24 ⇒ 覆盖前 24 个切点、无间隔补齐，covered_scene_cuts == 24
  无 CV 分析 ⇒ sampling_mode == "interval_only"

本文件的核心不是「正向能跑」，而是**边界与降级不撒谎**：
采样模式只由「是否分析过」决定，k=0 不等于没分析过。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.media.keyframe_sampling import (
    DEFAULT_INTERVAL_US,
    MAX_FRAMES,
    MODE_INTERVAL_ONLY,
    MODE_SCENE_CUT,
    REASON_INTERVAL,
    REASON_SCENE_CUT,
    SamplingPlan,
    sampling_mode_of,
    select_frames,
    truncate_to_limit,
)

DURATION = 60_000_000  # 60s


def test_no_analysis_degrades_to_interval_only() -> None:
    """规划门 §3.3 第 2 条：没分析过就必须如实报 interval_only。"""
    plan = select_frames(None, DURATION)
    assert plan.sampling_mode == MODE_INTERVAL_ONLY
    assert plan.had_cv_analysis is False
    assert plan.covered_scene_cuts == 0
    assert plan.frame_count > 0
    assert all(reason == REASON_INTERVAL for _, reason in plan.frames)


def test_analysed_but_no_cut_is_still_scene_cut_mode() -> None:
    """**关键区分**：分析过但 k=0 ≠ 没分析过。

    若把两者合并，「无分析」会被静默伪装成「分析过、没切点」，
    用户与排查都看不出真实原因。
    """
    plan = select_frames([], DURATION)
    assert plan.sampling_mode == MODE_SCENE_CUT
    assert plan.had_cv_analysis is True
    assert plan.scene_cut_count == 0
    assert plan.covered_scene_cuts == 0
    # 仍然要产出帧，只是全部来自间隔
    assert all(reason == REASON_INTERVAL for _, reason in plan.frames)


def test_sampling_mode_depends_only_on_analysis_presence() -> None:
    assert sampling_mode_of(had_cv_analysis=True) == MODE_SCENE_CUT
    assert sampling_mode_of(had_cv_analysis=False) == MODE_INTERVAL_ONLY


@pytest.mark.parametrize("k", [0, 1, 5, 23, 24])
def test_covered_equals_k_below_limit(k: int) -> None:
    """A5 上半：k <= 24 ⇒ covered_scene_cuts == k（恒等，不是约等于）。"""
    cuts = [i * (DURATION // max(k, 1)) for i in range(k)]
    plan = select_frames(cuts, DURATION)
    assert plan.covered_scene_cuts == k
    assert plan.scene_cut_count == k
    cut_frames = [f for f in plan.frames if f[1] == REASON_SCENE_CUT]
    assert len(cut_frames) == k
    # 每个切点都必须在计划里（不允许「差不多覆盖」）
    assert {t for t, _ in cut_frames} == set(cuts)


@pytest.mark.parametrize("k", [25, 40, 100])
def test_covered_caps_at_limit_above_limit(k: int) -> None:
    """A5 下半：k > 24 ⇒ covered == 24，且**不做间隔补齐**。"""
    cuts = [i * 500_000 for i in range(k)]
    plan = select_frames(cuts, DURATION)
    assert plan.covered_scene_cuts == MAX_FRAMES
    assert plan.scene_cut_count == k
    assert plan.frame_count == MAX_FRAMES
    # 超限时不补齐 ⇒ 计划中不应出现任何 interval 帧
    assert all(reason == REASON_SCENE_CUT for _, reason in plan.frames)


def test_above_limit_takes_earliest_cuts() -> None:
    """超限时取**时间升序前 24 个**，不是随机也不是最后 24 个。"""
    cuts = [i * 1_000_000 for i in range(30)]
    plan = select_frames(cuts, DURATION)
    assert [t for t, _ in plan.frames] == cuts[:MAX_FRAMES]


def test_fill_does_not_duplicate_cut_timestamps() -> None:
    """间隔补齐不得与切点帧落在同一时刻（否则同一画面被发两遍）。"""
    cuts = [0, 2_000_000]  # 与默认 2s 间隔正好对齐，最容易撞
    plan = select_frames(cuts, DURATION, interval_us=DEFAULT_INTERVAL_US)
    timestamps = [t for t, _ in plan.frames]
    assert len(timestamps) == len(set(timestamps))


def test_above_limit_never_adds_interval_frames_even_when_room_exists() -> None:
    """A5「k > 24 不做间隔补齐」的**区分性**用例。

    为什么需要它：切点被选中数恒为 min(k,24)，当 k>24 时 `remaining` 恒为 0，
    于是「补齐分支是否被执行」在**帧数上无法观测**——只断言 frame_count/covered
    的用例在这条规则被破坏时**仍是绿的**（实测：把 `if cut_count <= limit`
    改成 `if True` 后原 27 项全绿）。

    可观测的差别只在 `source_reason`：若错误地进入补齐分支，虽然补不出帧，
    但语义上仍属「走过了补齐路径」。因此这里直接检查**没有任何 interval 帧**，
    并用一个「若不封顶本会补出很多帧」的稀疏切点集把该差异放大。
    """
    # 24 帧切点散布在 10 分钟里；间隔 5s ⇒ 若不封顶会补出上百个点。
    cuts = [i * 25_000_000 for i in range(30)]
    plan = select_frames(cuts, 900_000_000, interval_us=5_000_000)
    assert plan.covered_scene_cuts == MAX_FRAMES
    assert plan.frame_count == MAX_FRAMES, "超限时不应补出任何额外帧"
    assert all(reason == REASON_SCENE_CUT for _, reason in plan.frames), \
        "超限时必须只有切点帧（出现了 interval 帧就说明补齐分支被执行了）"


def test_below_limit_does_fill_intervals() -> None:
    """对照组：k < 24 时必须补齐，否则上面的用例可能因「从不补齐」而恒真。"""
    cuts = [i * 50_000_000 for i in range(3)]
    plan = select_frames(cuts, 900_000_000, interval_us=50_000_000)
    assert plan.frame_count > 3
    assert any(reason == REASON_INTERVAL for _, reason in plan.frames)


def test_frames_are_sorted_and_within_duration() -> None:
    cuts = [5_000_000, 1_000_000, 30_000_000]
    plan = select_frames(cuts, DURATION)
    timestamps = [t for t, _ in plan.frames]
    assert timestamps == sorted(timestamps)
    assert all(0 <= t < DURATION for t in timestamps)


def test_out_of_range_cuts_are_discarded() -> None:
    """上游分析可能带越界值（-ss 定位到边界）；不得让它们进计划。"""
    plan = select_frames([-1, 0, DURATION, DURATION + 5], DURATION)
    timestamps = [t for t, _ in plan.frames]
    assert all(0 <= t < DURATION for t in timestamps)
    assert plan.covered_scene_cuts == 1  # 只有 0 合法


def test_duplicate_cuts_are_deduplicated() -> None:
    plan = select_frames([1_000_000, 1_000_000, 1_000_000], DURATION)
    assert plan.scene_cut_count == 1
    assert plan.covered_scene_cuts == 1


def test_zero_duration_yields_empty_plan() -> None:
    """空素材不得产出帧，也不得抛错。"""
    assert select_frames([], 0).frame_count == 0
    assert select_frames(None, 0).frame_count == 0
    assert select_frames([], -1).frame_count == 0


def test_zero_limit_yields_empty_plan() -> None:
    assert select_frames([1, 2], DURATION, limit=0).frame_count == 0
    assert select_frames(None, DURATION, limit=0).frame_count == 0


def test_frame_count_never_exceeds_limit() -> None:
    """D7 封顶必须对**所有**输入成立，含无切点与恰好边界。"""
    for k in (0, 1, 23, 24, 25, 200):
        cuts = None if k == 0 else [i * 250_000 for i in range(k)]
        plan = select_frames(cuts, DURATION, interval_us=10_000)
        assert plan.frame_count <= MAX_FRAMES, f"k={k}"


def test_interval_only_also_respects_limit() -> None:
    """无分析 + 极密间隔 ⇒ 也必须被封顶拦住（不能无限取点）。"""
    plan = select_frames(None, DURATION, interval_us=1_000)
    assert plan.frame_count == MAX_FRAMES


def test_coarser_interval_yields_fewer_frames() -> None:
    fine = select_frames(None, DURATION, interval_us=1_000_000)
    coarse = select_frames(None, DURATION, interval_us=10_000_000)
    assert fine.frame_count > coarse.frame_count


# ── truncate_to_limit ──


def test_truncate_keeps_cuts_first() -> None:
    """裁剪时切点优先于间隔帧——与 select_frames 的优先级保持一致。"""
    plan = select_frames([1_000_000, 5_000_000, 9_000_000], DURATION)
    trimmed = truncate_to_limit(plan, 3)
    assert trimmed.frame_count == 3
    assert all(reason == REASON_SCENE_CUT for _, reason in trimmed.frames)
    assert trimmed.covered_scene_cuts == 3


def test_truncate_noop_when_under_limit() -> None:
    plan = select_frames([1_000_000], DURATION)
    assert truncate_to_limit(plan, 24) is plan


def test_truncate_to_zero_is_empty_but_keeps_mode() -> None:
    """裁到 0 帧仍要保留采样模式，否则「为什么没帧」的原因就丢了。"""
    plan = select_frames([1_000_000], DURATION)
    trimmed = truncate_to_limit(plan, 0)
    assert trimmed.frame_count == 0
    assert trimmed.sampling_mode == MODE_SCENE_CUT
    assert trimmed.covered_scene_cuts == 0


# ── 常量一致性（跨模块，防两处漂移）──


def test_sampling_limit_matches_encode_max_frames() -> None:
    """抽样模块与编码模块各自的 MAX_FRAMES 必须一致。

    两者刻意不互相 import（纯算法 vs I/O），因此用测试钉住一致性，
    而不是靠注释约定。
    """
    from aivs_core.media.keyframe_encode import MAX_FRAMES as ENCODE_MAX  # noqa: PLC0415

    assert MAX_FRAMES == ENCODE_MAX == 24


def test_sampling_plan_is_frozen() -> None:
    plan = SamplingPlan((), MODE_SCENE_CUT, 0, 0, True)
    with pytest.raises(Exception):
        plan.sampling_mode = "x"  # type: ignore[misc]


def test_module_has_no_io_imports() -> None:
    """纯函数模块不得引入 I/O 依赖，否则 A5 的边界测试将无法脱离真实媒体。"""
    # 用 __file__ 推导而非 cwd 相对路径：pytest 可能从仓库根或 services/core 启动
    # （本仓已有同类坑，见 P66「必须从仓库根运行」的隐藏 cwd 假设）。
    module = (
        Path(__file__).resolve().parents[4]
        / "services/core/src/aivs_core/media/keyframe_sampling.py"
    )
    source = module.read_text(encoding="utf-8")
    for forbidden in ("import asyncio", "import sqlite3", "import subprocess", "httpx"):
        assert forbidden not in source, forbidden
