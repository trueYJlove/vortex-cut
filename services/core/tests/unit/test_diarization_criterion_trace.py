"""W2.2 溯源工具的回归锁：`diarization_criterion_trace`。

这些断言保护的是**方法的正确性**（Spearman 实现、方向判定、cap 归因），
不是数据集的数值——数值随语料变，方法不该变。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tools" / "quality_eval"))

from diarization_criterion_trace import (  # noqa: E402
    spearman,
    trace_meeting,
)


def _entry(k_true: int, curve: dict[int, float], der_by_k: dict[int, float],
           sil_field: float = 0.5, pick_k: int = 2) -> dict:
    """构造一个 per_meeting 形状的 entry（grid 由 (K, sil) 与 (K, der) 交叉生成）。"""
    grid = []
    for k, sil in curve.items():
        grid.append({
            "tau": round(0.2 + 0.02 * list(curve).index(k), 2),
            "k": k, "sil": sil, "der": der_by_k[k],
        })
    return {
        "k_true": k_true, "grid": grid,
        "silhouette": sil_field, "silhouette_k": pick_k,
        "oracle": min(der_by_k.values()), "oracle_k": min(der_by_k, key=lambda k: der_by_k[k]),
    }


class TestSpearman:
    def test_perfect_positive_and_negative(self) -> None:
        assert spearman([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1.0)
        assert spearman([1, 2, 3, 4], [40, 30, 20, 10]) == pytest.approx(-1.0)

    def test_ties_use_average_ranks(self) -> None:
        """并列必须走**平均秩**：这与"序号秩"给出的数值**不同**，故断言到具体值。

        原版只断言 `-1 <= rho <= 1`——那条恒真，负向对照 NC-C 当场证明它抓不住
        "改用序号秩"这个改动（改用序号秩后仍是合法 ρ）。现钉死精确值。
        """
        rho = spearman([1.0, 1.0, 2.0, 3.0], [1.0, 2.0, 3.0, 4.0])
        assert rho is not None
        # 平均秩：x 秩 = [1.5, 1.5, 3, 4] → ρ = 0.948683…
        # 序号秩（错误实现）会给 0.8 ⇒ 精确断言即可区分两者
        assert rho == pytest.approx(0.9486832980505138, abs=1e-9)

    def test_degenerate_input_returns_none(self) -> None:
        assert spearman([1, 2, 3], [5, 5, 5]) is None  # 分母为 0
        assert spearman([1, 2], [1, 2]) is None  # n < 3

    def test_monotone_transform_is_invariant(self) -> None:
        base = [0.1, 0.4, 0.35, 0.9, 0.2]
        other = [3.0, 7.0, 6.5, 20.0, 4.0]  # 同一序
        assert spearman(base, other) == pytest.approx(1.0)


class TestDirectionDetection:
    def test_reversed_direction_is_flagged(self) -> None:
        """silhouette 随 K 升、DER 也随 K 升 ⇒ 方向反了，必须标记。"""
        curve = {2: 0.10, 3: 0.20, 4: 0.30, 5: 0.40}
        der = {2: 0.05, 3: 0.15, 4: 0.45, 5: 0.80}
        row = trace_meeting("x", _entry(1, curve, der))
        assert row is not None
        assert row["direction_reversed"] is True
        assert row["rho_sil_vs_der"] == pytest.approx(-1.0)
        assert row["sil_monotone_up"] and row["der_monotone_up"]

    def test_normal_direction_is_not_flagged(self) -> None:
        curve = {2: 0.40, 3: 0.30, 4: 0.20, 5: 0.10}
        der = {2: 0.05, 3: 0.15, 4: 0.45, 5: 0.80}
        row = trace_meeting("x", _entry(2, curve, der))
        assert row is not None
        assert row["direction_reversed"] is False
        assert row["k_pick"] == 2  # 选到最好的

    def test_negative_control_single_inversion_is_not_reversed(self) -> None:
        """**负向对照**：**单处**相邻换位不得把整体判成"方向反了"。

        若实现把"有任意一处非单调"当反向（而不是按 ρ 的整体排序），本用例会红。

        ⚠️ 这条用例的**前两版数据都是错的**，被实现当场证伪（记下来防重犯）：
        第一版只给 4 个点，一次换位 ρ 就到 −0.8；第二版点数够了，但 DER
        **严格单调上升**——单靠 DER 就把 ρ 拉到 −0.94，sil 的局部回落不起作用。
        ⇒ 构造"局部反转、整体正向"必须让**两列都整体同向**，
        只在其中一列放一次相邻换位（本版：sil 在 K=4 处上跳，两列整体均随 K 反向）。
        """
        curve = {2: 0.55, 3: 0.45, 4: 0.50, 5: 0.30, 6: 0.20, 7: 0.10}  # K=4 处相邻上跳
        der = {2: 0.05, 3: 0.10, 4: 0.20, 5: 0.35, 6: 0.55, 7: 0.80}
        row = trace_meeting("x", _entry(2, curve, der))
        assert row is not None
        assert row["direction_reversed"] is False
        assert row["rho_sil_vs_der"] > 0.5
        assert row["sil_monotone_up"] is False  # 这处上跳仍须被如实记录

class TestCapAttribution:
    def test_pinned_detected_when_argmax_at_ceiling(self) -> None:
        curve = {2: 0.10, 3: 0.20, 4: 0.60}
        der = {2: 0.05, 3: 0.10, 4: 0.90}
        row = trace_meeting("x", _entry(1, curve, der))
        assert row is not None
        assert row["pinned"] is True
        assert row["k_pick"] == row["k_ceiling"] == 4

    def test_wide_pick_exposes_what_cap_was_blocking(self) -> None:
        """cap=8 内 argmax 在 8；放开到 40 后出现更高 silhouette 的 K ⇒ wide_pick 必须更大。"""
        curve = {2: 0.10, 4: 0.20, 8: 0.30, 12: 0.55}
        der = {2: 0.05, 4: 0.10, 8: 0.60, 12: 0.95}
        row = trace_meeting("x", _entry(1, curve, der, pick_k=8))
        assert row is not None
        assert row["k_pick"] == 8 and row["pinned"] is True
        assert row["wide_pick"] == 12
        assert row["wide_der"] == pytest.approx(0.95)

    def test_insufficient_candidates_returns_none(self) -> None:
        curve = {2: 0.10}
        der = {2: 0.05}
        assert trace_meeting("x", _entry(1, curve, der)) is None
