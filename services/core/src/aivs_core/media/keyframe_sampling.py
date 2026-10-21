"""W3.3 Layer 2：关键帧抽样决策（S1b，**纯函数、零 I/O、零 egress**）。

设计门 §3.1 / 规划门 §3.3（D7 用户裁决 + 评审 M2 冻结判据）。

为什么单独成模块并做成纯函数：
- 规划门 A5 的判据是 `covered_scene_cuts == min(k, 24)`，纯函数才能直接构造
  边界（k=0/1/24/25/100）而不必依赖真实媒体；这是负向对照能真变红的前提。
- 与 `semantic.py` / `cv_signals.frame_signals` 的分层纪律一致：算法在纯模块，
  I/O 与解码在服务层。

有一处必须诚实区分、不能合并的语义（规划门 §3.3 第 2 条）：
「**做过 CV 分析但一个切点都没有**」与「**根本没做 CV 分析**」是两件事。
前者采样模式仍是 scene_cut（只是 k=0，退化为纯间隔），后者必须落
`interval_only` 并如实上报。若把两者合并，「无分析」会被静默伪装成
「分析过、没切点」，用户与后续排查都看不出真实原因。
"""
from __future__ import annotations

from dataclasses import dataclass

# 规划门 D7（用户裁决）：每素材封顶 24 帧。此处重复声明而非从
# keyframe_encode 导入：抽样是纯算法、编码是 I/O，两者不应互相依赖；
# 一致性由测试 test_sampling_limit_matches_encode_max_frames 钉住。
MAX_FRAMES = 24

# 规划门 §3.3 未规定间隔取值；沿用仓库既有的 2.0s（semantic_service
# 的 DEFAULT_SAMPLE_INTERVAL_S）作为默认，可被调用方覆盖。
DEFAULT_INTERVAL_US = 2_000_000

MODE_SCENE_CUT = "scene_cut"
MODE_INTERVAL_ONLY = "interval_only"

REASON_SCENE_CUT = "scene_cut"
REASON_INTERVAL = "interval"


@dataclass(frozen=True)
class SamplingPlan:
    """抽样结果。`frames` 为 [(timestamp_us, source_reason)]。"""

    frames: tuple[tuple[int, str], ...]
    sampling_mode: str
    covered_scene_cuts: int
    scene_cut_count: int
    had_cv_analysis: bool

    @property
    def frame_count(self) -> int:
        return len(self.frames)


def sampling_mode_of(*, had_cv_analysis: bool) -> str:
    """采样模式**只**由「是否做过 CV 分析」决定，与切点数量无关。

    k=0 但分析过 ⇒ scene_cut（真实情况是这段素材没有镜头切换）；
    没分析过 ⇒ interval_only（如实上报降级）。
    """
    return MODE_SCENE_CUT if had_cv_analysis else MODE_INTERVAL_ONLY


def _interval_fill(
    *, start_us: int, end_us: int, interval_us: int, taken: list[int], limit: int,
) -> list[int]:
    """在 [start_us, end_us) 上按间隔取点，跳过已在 `taken` 中的（含邻域）。"""
    if limit <= 0 or end_us <= start_us:
        return []
    step = max(interval_us, 1)
    chosen: list[int] = []
    # 已占用的时间点不重复选：切点帧本身就是该时刻的画面
    occupied = set(taken)
    cursor = start_us
    while cursor < end_us and len(chosen) < limit:
        if cursor not in occupied:
            chosen.append(cursor)
            occupied.add(cursor)
        cursor += step
    return chosen


def select_frames(
    scene_cuts_us: list[int] | None,
    duration_us: int,
    *,
    interval_us: int = DEFAULT_INTERVAL_US,
    limit: int = MAX_FRAMES,
) -> SamplingPlan:
    """按规划门 §3.3 选择抽帧时间点。

    `scene_cuts_us is None` 表示**没做过 CV 分析**（降级 interval_only）；
    传入 `[]` 表示**分析过、无切点**（仍是 scene_cut 模式）。

    边界语义（A5 判据）：
      - k <= limit：全部 k 个切点 + 间隔补齐至 limit；covered = k
      - k >  limit：按时间升序取前 limit 个切点，**不做补齐**；covered = limit
      - 无切点：纯间隔；covered = 0
    """
    if duration_us <= 0:
        return SamplingPlan((), sampling_mode_of(had_cv_analysis=scene_cuts_us is not None),
                            0, 0, scene_cuts_us is not None)
    if limit <= 0:
        return SamplingPlan((), sampling_mode_of(had_cv_analysis=scene_cuts_us is not None),
                            0, len(scene_cuts_us or ()), scene_cuts_us is not None)

    had_analysis = scene_cuts_us is not None
    mode = sampling_mode_of(had_cv_analysis=had_analysis)

    # 切点清洗：去重、排序、限制在 [0, duration) 内。
    # 不信任上游：分析结果可能带越界值（cv_signals 用 -ss 定位，边界帧可能超尾）。
    cuts = sorted({t for t in (scene_cuts_us or ()) if 0 <= t < duration_us})
    cut_count = len(cuts)

    if not cuts:
        # 变量名与下面的补齐分支区分：这里 fills 是 int 列表，下面 points 是
        # (timestamp, reason) 元组列表。混用会让类型检查与读者都出错。
        fills = _interval_fill(
            start_us=0, end_us=duration_us, interval_us=interval_us,
            taken=[], limit=limit,
        )
        frames = tuple((t, REASON_INTERVAL) for t in fills)
        return SamplingPlan(frames, mode, 0, cut_count, had_analysis)

    covered = min(cut_count, limit)
    chosen_cuts = cuts[:covered]

    # 帧号顺序即播放顺序：切点内部已排序，补齐点也升序，最终统一排序。
    points: list[tuple[int, str]] = [(t, REASON_SCENE_CUT) for t in chosen_cuts]

    # ⚠️ 本分支在**可观测行为上是冗余的**：k > limit 时 covered = limit，points 已含
    # limit 项 ⇒ remaining = 0，而 _interval_fill 对 limit=0 直接返回 []。
    # 实测把本行改成 `if True:` 后 **29 项测试全绿**——不存在能让它变红的用例。
    # 保留它只为让代码字面复述规划门 §3.3 的规则、便于评审对照；
    # 不谎称它是一条独立守卫（同 P149 对冗余防御的处置）。
    if cut_count <= limit:
        remaining = limit - len(points)
        fills = _interval_fill(
            start_us=0, end_us=duration_us, interval_us=interval_us,
            taken=list(chosen_cuts), limit=remaining,
        )
        points.extend((t, REASON_INTERVAL) for t in fills)
    # cut_count > limit ⇒ 只留切点，不做间隔补齐（规划门 §3.3 明文）

    points.sort(key=lambda item: item[0])
    return SamplingPlan(tuple(points), mode, covered, cut_count, had_analysis)


def truncate_to_limit(plan: SamplingPlan, limit: int) -> SamplingPlan:
    """把计划裁到 `limit` 帧（保留切点优先，其次按时间）。

    单独成函数而不是内联：S2 允许调用方传入比默认更小的 limit，
    裁剪规则必须与 select_frames 的优先级一致，否则两条路径会漂移。
    """
    if limit >= plan.frame_count:
        return plan
    if limit <= 0:
        return SamplingPlan((), plan.sampling_mode, 0, plan.scene_cut_count, plan.had_cv_analysis)
    cuts = [f for f in plan.frames if f[1] == REASON_SCENE_CUT][:limit]
    kept = list(cuts)
    if len(kept) < limit:
        for frame in plan.frames:
            if len(kept) >= limit:
                break
            if frame[1] != REASON_SCENE_CUT:
                kept.append(frame)
    kept.sort(key=lambda item: item[0])
    covered = min(plan.covered_scene_cuts, len(cuts))
    return SamplingPlan(tuple(kept), plan.sampling_mode, covered,
                        plan.scene_cut_count, plan.had_cv_analysis)
