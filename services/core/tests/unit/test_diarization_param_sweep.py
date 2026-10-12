r"""W2.2 门 §5.5 后续 —— 参数化选择工具（纯函数 + **反过拟合闸门**）pytest 形态。

本文件最重的不是"规则算得对不对"，而是**闸门有没有牙**：

本包的验收语料真值 K 只覆盖 **3–7**（AMI 15/16 场是 K=4，AISHELL-4 是 5–7）。
在这个语料上，一个朴素的 B7k >= 4` 下限**两个语料都比更讲究的规则更好**——
但它对 **2 人素材**（口播/对谈，产品主场景）会把**正确答案直接排除**。
⇒ 若只按本批性能选规则，就会把一个**在真机主场景上必错**的规则写进产品。

故这里钉死：**任何候选规则都必须先过 structural_safety**，
并用一个**已知不安全的规则**做负向对照，证明闸门不是恒真。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
QE = ROOT / "tools" / "quality_eval"
sys.path.insert(0, str(QE))
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


ps = _load("quality_eval_param_sweep", QE / "diarization_param_sweep.py")


def _grid(k_true: int) -> list[dict]:
    """理想候选集：正确答案 k_true 的 silhouette 最高。"""
    return [
        {
            "tau": round(0.10 + 0.05 * i, 2),
            "k": k,
            "der": 0.20,
            "sil": 0.50 if k == k_true else 0.30,
            "min_cluster_share": 0.5 if k == k_true else 0.01,
            "max_cluster_share": 0.5,
            "n_small_clusters": 0,
        }
        for i, k in enumerate(range(2, 9))
    ]


class TestStructuralSafetyGate:
    """**本套件最重要的一组**：闸门必须能挡下"在本批语料上更优但在真机上必错"的规则。"""

    def test_blanket_k_floor_4_is_rejected(self):
        """B7k>=4` 在 2/3 人素材上排除正确答案 ⇒ 必须判为**不安全**。

        这个规则在本批 36 场上**两个语料的均值都更好**——正是它必须被挡下的原因。
        """
        name, pred = ps.UNSAFE_REGRESSION_RULE
        res = ps.structural_safety(pred)
        assert res["safe"] is False, f"{name} 竟被判为安全——闸门失效"
        assert res["per_k"]["2"] is False
        assert res["per_k"]["3"] is False
        assert res["per_k"]["7"] is True  # 高 K 档不受影响，闸门不是"一律否决"

    def test_current_route_is_structurally_safe(self):
        """现行路线（无约束的 silhouette 最大）**结构安全**——它没有盲区。

        ⇒ 本批**不得**把"现行路线有结构性缺陷"当作论据；
        它的缺陷是**选择质量**，不是**候选集缺口**。
        """
        assert ps.structural_safety(ps.rule_silhouette_max)["safe"] is True

    def test_hint_based_rules_are_safe_when_the_hint_is_right(self):
        """以"同素材的其他估计"为依据的规则，在估计正确时结构安全。"""
        for name in ("B1_k_ge_hint", "E1_k_neighbourhood", "E2_k_ge_hint_minus_1"):
            res = ps.structural_safety(ps.RULES[name])
            assert res["safe"] is True, f"{name} 有盲区: {res['per_k']}"

    def test_gate_covers_the_whole_product_range(self):
        """闸门必须覆盖产品需要的 1–7 人档（这里用 2–7；1 人档由 K>=2 的下界处理）。"""
        res = ps.structural_safety(ps.rule_silhouette_max)
        assert set(res["per_k"]) == {"2", "3", "4", "5", "6", "7"}

    def test_gate_is_not_vacuous(self):
        """**负向对照的方向**：闸门不能对任何规则都返回 False。

        若一个明显安全的规则也被否决，说明闸门写错了（例如恒返回 False）。
        """
        assert ps.structural_safety(ps.rule_silhouette_max)["safe"] is True
        assert ps.structural_safety(ps.RULES["E1_k_neighbourhood"])["safe"] is True

    def test_all_registered_rules_are_structurally_safe(self):
        """**登记在 RULES 里的规则一律必须过闸门**——登记即承诺无盲区。"""
        for name, pred in ps.RULES.items():
            res = ps.structural_safety(pred)
            assert res["safe"] is True, f"{name} 有盲区: {res['per_k']}"


class TestRules:
    def test_silhouette_max_returns_all_defined(self):
        g = _grid(4)
        assert len(ps.rule_silhouette_max(g, 4)) == len(g)

    def test_k_floor_removes_small_k(self):
        g = _grid(4)
        got = {x["k"] for x in ps.rule_k_floor_from_hint(g, 4)}
        assert min(got) == 4 and max(got) == 8

    def test_neighbourhood_is_symmetric(self):
        g = _grid(5)
        got = sorted(x["k"] for x in ps.rule_k_neighbourhood(g, 5))
        assert got == [4, 5, 6]

    def test_rules_never_drop_undefined_silhouette_into_output(self):
        """silhouette 无定义（None）的 τ **不得**进入候选——否则 None 会污染排序。"""
        g = _grid(4)
        g[0]["sil"] = None
        for name, pred in ps.RULES.items():
            for x in pred(g, 4):
                assert x["sil"] is not None, f"{name} 放进了无定义的 τ"


class TestSilhouetteUndefinedIsExplicit:
    """Core 对 >40 簇返回 -1 哨兵；本工具必须把它翻成 None（**显式**），不是 -1。"""

    def test_out_of_range_returns_none(self):
        import numpy as np

        dmat = np.zeros((5, 5))
        labels = np.arange(5)  # 5 簇，在范围内
        assert ps.silhouette_at(dmat, labels) is not None
        many = np.arange(60)  # 60 簇 > MAX_SILHOUETTE_CLUSTERS
        d60 = np.zeros((60, 60))
        assert ps.silhouette_at(d60, many) is None

    def test_single_cluster_returns_none(self):
        import numpy as np

        assert ps.silhouette_at(np.zeros((5, 5)), np.zeros(5, dtype=int)) is None


class TestSweepToolShape:
    def test_caps_are_monotone_and_include_current_and_unlimited(self):
        caps = [c for c in ps.CAPS if c != ps.UNLIMITED]
        assert caps == sorted(caps)
        assert 8 in caps, "现行上限 8 必须在档位里（否则无法与现状对照）"
        assert ps.UNLIMITED in ps.CAPS
