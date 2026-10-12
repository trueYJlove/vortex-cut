r"""W2.2 §5.3 后续 —— 「把自动 K 做稳」工具（纯函数部分）pytest 形态。

本工具承载的是**方向裁决**（「把自动 K 做稳」是否值得投入），所以这里钉死的不是"数字"，
而是三条**会让裁决失效的性质**：

1. **可产品化规则不得偷看真值/DER**——若某个"自动 K"规则读了 \`k_true\` 或 \`der_ignore\`，
   它就不是产品能用的规则，结论会系统性乐观。这里用**只改 DER 与真值、其余列不动**的
   机械检验钉死：可产品化规则必须给出**完全相同**的 K，而 oracle 规则**必须**改变
   （后者即前者的负向对照——否则该检验可能只是"恒真"）。
2. **解耦检验必须存在**——「K 更接近真值 ≈ DER 更低」是 §5.3 建议的前提；
   若该前提不成立，方向本身不成立。故 \`oracle_best_der\` 与 \`oracle_k_true\` 必须都在册。
3. **规则只做选择**——evaluate 阶段**不得**再做任何聚类（否则反复试规则的代价与结论漂移
   都不可控）。用源码扫描钉死。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import numpy as np

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


ks = _load("quality_eval_k_stability", QE / "diarization_k_stability.py")
routes = _load("quality_eval_cluster_routes_for_ks", QE / "diarization_cluster_routes.py")

BASE_SIL = {2: 0.50, 3: 0.55, 4: 0.60}
BASE_DER = {2: 0.40, 3: 0.35, 4: 0.30}


def _ladder(
    k_true: int = 4, *, sil_by_k=None, der_by_k=None, n: int = 100, seed: str = "0"
) -> dict:
    """构一场会议的 ladder。sil_by_k / der_by_k 可指定，便于检验规则到底看了哪一列。"""
    sil_by_k = BASE_SIL if sil_by_k is None else sil_by_k
    der_by_k = BASE_DER if der_by_k is None else der_by_k
    per_k = {
        str(k): {
            "der_ignore": der_by_k[k],
            "der_count": der_by_k[k] + 0.05,
            "silhouette": sil_by_k[k],
            "inertia": 10.0 / k,
        }
        for k in sorted(sil_by_k)
    }
    return {"k_true": k_true, "n_windows": n, "total_scatter": 40.0, "seeds": {seed: per_k}}


def _as_ladder(meeting: dict, name: str = "M1") -> dict:
    """把单场 ladder 包成 evaluate() 需要的报告形状。"""
    return {
        "corpus": "fixture",
        "condition": "synthetic",
        "seeds": sorted({int(s) for s in meeting["seeds"]}),
        "meetings": {name: meeting},
    }


def _meta(lad: dict) -> dict:
    return {
        "k_true": lad["k_true"],
        "n_windows": lad["n_windows"],
        "total_scatter": lad["total_scatter"],
    }


class TestNoTruthLeakage:
    """**最重要的一组**：可产品化规则不得读真值或 DER。"""

    def _scramble(self, lad: dict) -> dict:
        """只改 DER 列与 k_true，**候选集 / silhouette / inertia / n 全部保持不动**。

        这样"K 变了"只可能来自读了 DER 或真值，不可能是候选集变化导致的。
        """
        return _ladder(
            k_true=3,
            sil_by_k={2: BASE_SIL[2], 3: BASE_SIL[3], 4: BASE_SIL[4]},
            der_by_k={2: 0.99, 3: 0.01, 4: 0.77},
            n=lad["n_windows"],
        )

    def test_productizable_rules_ignore_der_and_truth(self):
        base, scr = _ladder(), self._scramble(_ladder())
        for name in ("silhouette", "silhouette_maxk", "calinski_harabasz", "kmax_strawman"):
            k_b = ks.RULES[name](base["seeds"]["0"], _meta(base))
            k_s = ks.RULES[name](scr["seeds"]["0"], _meta(scr))
            assert k_b == k_s, f"{name} 读了 DER 或真值：{k_b} != {k_s}"

    def test_oracle_rules_do_use_der_and_truth(self):
        """**负向对照**：证明上面的检验有区分力（oracle 规则应当随 DER/真值改变）。"""
        base, scr = _ladder(), self._scramble(_ladder())
        assert ks.RULES["oracle_k_true"](base["seeds"]["0"], _meta(base)) == 4
        assert ks.RULES["oracle_k_true"](scr["seeds"]["0"], _meta(scr)) == 3
        assert ks.RULES["oracle_best_der"](base["seeds"]["0"], _meta(base)) == 4
        assert ks.RULES["oracle_best_der"](scr["seeds"]["0"], _meta(scr)) == 3

    def test_candidate_set_unchanged_by_scramble(self):
        """钉死上面两条检验的前提：打乱只动 DER 与真值。"""
        base, scr = _ladder(), self._scramble(_ladder())
        assert sorted(base["seeds"]["0"]) == sorted(scr["seeds"]["0"])
        for k in base["seeds"]["0"]:
            assert base["seeds"]["0"][k]["silhouette"] == scr["seeds"]["0"][k]["silhouette"]
            assert base["seeds"]["0"][k]["inertia"] == scr["seeds"]["0"][k]["inertia"]
            assert base["seeds"]["0"][k]["der_ignore"] != scr["seeds"]["0"][k]["der_ignore"]

    def test_oracle_rules_are_flagged_non_productizable(self):
        for name in ("oracle_k_true", "oracle_best_der"):
            assert name in ks.NON_PRODUCTIZABLE
        for name in ("silhouette", "silhouette_maxk", "calinski_harabasz", "kmax_strawman"):
            assert name not in ks.NON_PRODUCTIZABLE


class TestRules:
    def test_silhouette_picks_max(self):
        pk = _ladder(sil_by_k={2: 0.5, 3: 0.9, 4: 0.6})["seeds"]["0"]
        assert ks.rule_silhouette(pk, {}) == 3

    def test_silhouette_maxk_takes_largest_within_delta(self):
        """delta 内并列时取**最大** K —— 这正是它对抗欠分割的机制。"""
        pk = _ladder(sil_by_k={2: 0.60, 3: 0.60, 4: 0.60})["seeds"]["0"]
        assert ks.rule_silhouette_maxk(pk, {}) == 4

    def test_silhouette_maxk_falls_back_to_plain_silhouette_when_separated(self):
        """silhouette 差距远超 delta 时，它必须与现行规则一致（不是无条件取大）。"""
        pk = _ladder(sil_by_k={2: 0.9, 3: 0.2, 4: 0.1})["seeds"]["0"]
        assert ks.rule_silhouette(pk, {}) == 2
        assert ks.rule_silhouette_maxk(pk, {}) == 2

    def test_kmax_strawman_is_max_k(self):
        assert ks.rule_kmax(_ladder()["seeds"]["0"], {}) == 4

    def test_all_rules_return_a_candidate(self):
        pk = _ladder()["seeds"]["0"]
        for name, fn in ks.RULES.items():
            k = fn(pk, _meta(_ladder()))
            assert str(k) in pk, f"{name} 返回了不在候选里的 K={k}"


class TestCalinskiHarabasz:
    def _fixture(self):
        rng = np.random.default_rng(0)
        return np.vstack(
            [
                rng.normal(0, 0.05, (30, 16)) + np.r_[1.0, np.zeros(15)],
                rng.normal(0, 0.05, (30, 16)) - np.r_[1.0, np.zeros(15)],
                rng.normal(0, 0.05, (30, 16)) + np.r_[0, 1.0, np.zeros(14)],
            ]
        )

    def test_matches_closed_form_definition(self):
        """CH 必须严格等于 ((T−W)/(K−1)) / (W/(n−K))——错一个括号就是另一条规则。"""
        for t, w, k, n in ((40.0, 10.0, 3, 100), (12.5, 3.25, 2, 60), (7.0, 6.9, 8, 90)):
            expect = ((t - w) / (k - 1)) / (w / (n - k))
            assert abs(ks.calinski_harabasz(t, w, k, n) - expect) < 1e-12

    def test_inertia_never_exceeds_total_scatter(self):
        """B = T − W 必须 ≥ 0——用真实聚类验证（T 由 total_scatter 独立算出）。"""
        v = self._fixture()
        t = ks.total_scatter(v)
        for k in (2, 3, 4):
            _, inertia = routes.kmeans_cosine(v, k)
            assert t - inertia >= -1e-9, (k, t, inertia)
            assert ks.calinski_harabasz(t, inertia, k, v.shape[0]) > 0

    def test_total_scatter_is_deterministic_and_data_dependent(self):
        """T 只依赖数据 ⇒ 保证「规则不重算聚类」成立。"""
        v = self._fixture()
        assert ks.total_scatter(v) == ks.total_scatter(v.copy())
        assert ks.total_scatter(v[:30]) < ks.total_scatter(v)

    def test_degenerate_returns_neg_inf(self):
        assert ks.calinski_harabasz(10.0, 1.0, 1, 100) == float("-inf")
        assert ks.calinski_harabasz(10.0, 1.0, 100, 100) == float("-inf")


class TestEvaluateIsSelectionOnly:
    def test_evaluate_does_not_recluster(self):
        """规则只做选择：evaluate 路径**不得**出现 k-means 调用。"""
        src = (QE / "diarization_k_stability.py").read_text(encoding="utf-8")
        body = src.split("def run_evaluate")[1].split("def main")[0]
        assert "kmeans_cosine(" not in body
        assert "sweep_meeting" not in body

    def test_evaluate_reports_gate_per_seed(self):
        res = ks.evaluate(
            _as_ladder(_ladder()),
            {"silhouette": ks.rule_silhouette, "oracle_best_der": ks.rule_best_der},
        )
        sil = res["per_rule"]["silhouette"]
        assert sil["productizable"] is True
        assert sil["all_seeds_pass"] is True
        assert sil["seeds"]["0"]["mean"] == 0.30
        assert sil["seeds"]["0"]["worst"] == 0.30
        assert res["per_rule"]["oracle_best_der"]["productizable"] is False
        assert set(res["decouple_summary"]) >= {
            "true_k_mean",
            "best_k_mean",
            "silhouette_k_mean",
            "true_k_worst",
            "best_k_worst",
            "silhouette_k_worst",
        }
        # 解耦检验：本夹具里 silhouette(K=4 → DER .30) 已是最低 ⇒ K 的余量为 0
        dec = res["decouple"]["per_meeting"]["M1"]
        assert dec["der_best_k"] == 0.30
        assert dec["der_silhouette_k"] == 0.30
        assert dec["k_best"] == 4
        assert res["decouple_summary"]["silhouette_k_mean"] == 0.30

    def test_evaluate_flags_a_failing_seed(self):
        """最差场越线必须被如实标出（否则「过门」是假的）。"""
        # silhouette 选中 K=2（DER 0.70 越线），而真值 K=4 其实是好的（0.30）
        lad = _ladder(der_by_k={2: 0.70, 3: 0.35, 4: 0.30}, sil_by_k={2: 0.9, 3: 0.5, 4: 0.4})
        res = ks.evaluate(_as_ladder(lad), {"silhouette": ks.rule_silhouette})
        sil = res["per_rule"]["silhouette"]
        assert sil["seeds"]["0"]["worst"] == 0.70
        assert sil["seeds"]["0"]["worst_pass"] is False
        assert sil["all_seeds_pass"] is False
        assert sil["failing_seeds"] == ["0"]
        # **负向对照**：oracle 取到 K=4 ⇒ 该夹具确实存在可被利用的余量，
        # 所以上面"不过门"是规则的问题，不是夹具本身没有出路。
        orc = ks.evaluate(_as_ladder(lad), {"oracle_best_der": ks.rule_best_der})
        assert orc["per_rule"]["oracle_best_der"]["seeds"]["0"]["worst"] == 0.30
        assert orc["per_rule"]["oracle_best_der"]["all_seeds_pass"] is True

    def test_k_bias_counts_under_and_over_segmentation(self):
        """K̂ 偏小/偏大的计数必须分开报（欠分割是 §5.3 的指控之一）。"""
        res = ks.evaluate(_as_ladder(_ladder(k_true=6)), {"kmax_strawman": ks.rule_kmax})
        v = res["per_rule"]["kmax_strawman"]
        assert v["k_bias_mean"] == -2.0  # K=4 vs 真值 6
        assert v["k_under"] == "1/1"
        assert v["k_over"] == "0/1"

    def test_k_over_counted_separately_from_under(self):
        """过分割必须计到 k_over，不得混进 k_under（否则"欠分割是机制"无从判定）。"""
        res = ks.evaluate(_as_ladder(_ladder(k_true=2)), {"kmax_strawman": ks.rule_kmax})
        v = res["per_rule"]["kmax_strawman"]
        assert v["k_bias_mean"] == 2.0
        assert v["k_under"] == "0/1"
        assert v["k_over"] == "1/1"

    def test_k_max_filter_truncates_candidates(self):
        """k_max 截断必须真的生效（否则"降 k_max 能否救"这类问题无法回答）。"""
        full = ks.evaluate(_as_ladder(_ladder()), {"kmax_strawman": ks.rule_kmax})
        cut = ks.evaluate(_as_ladder(_ladder()), {"kmax_strawman": ks.rule_kmax}, k_max_filter=3)
        assert full["per_rule"]["kmax_strawman"]["k_bias_mean"] == 0.0  # K=4 vs 真值 4
        assert cut["per_rule"]["kmax_strawman"]["k_bias_mean"] == -1.0  # 截断后 K=3
        # 截断必须**传导到解耦检验**：真值 K=4 已被裁掉，不得假装它存在
        assert full["decouple"]["per_meeting"]["M1"]["der_true_k"] == 0.30
        assert cut["decouple"]["per_meeting"]["M1"]["der_true_k"] is None
        assert cut["decouple"]["per_meeting"]["M1"]["k_best"] == 3

    def test_decouple_reports_headroom_when_silhouette_is_suboptimal(self):
        """有真实余量时必须报出（这是"方向是否成立"的关键读数）。"""
        lad = _ladder(sil_by_k={2: 0.9, 3: 0.2, 4: 0.1}, der_by_k={2: 0.60, 3: 0.35, 4: 0.30})
        res = ks.evaluate(_as_ladder(lad), {"silhouette": ks.rule_silhouette})
        dec = res["decouple"]["per_meeting"]["M1"]
        assert dec["k_silhouette"] == 2 and dec["der_silhouette_k"] == 0.60
        assert dec["k_best"] == 4 and dec["der_best_k"] == 0.30
        assert (
            res["decouple_summary"]["silhouette_k_worst"] > res["decouple_summary"]["best_k_worst"]
        )
