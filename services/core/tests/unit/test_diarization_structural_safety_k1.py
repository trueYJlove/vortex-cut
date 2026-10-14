r"""W2.2 (a) spike —— **K=1 扩展闸门**的 pytest 形态。

钉死两件事：

1. **新闸门有区分力**：`T` 太低（K=1 档不可达）或太高（多人档被压）必须被判不安全；
2. **两个已知不安全的对照必须被判不安全**——否则闸门恒真。
3. **旧闸门对 K=1 规则类的盲区**被如实钉住（防止有人以为旧闸门已经覆盖）。

负向对照（还原后必须变红）：
  · NC-A：把 `SAFE_K_RANGE_V2` 的 1 去掉 ⇒ K=1 档永不可达 ⇒ T=1.5 被判不安全；
  · NC-B：让 `rule_single_branch` 忽略 T 恒走单分支 ⇒ 多人档全灭、被判不安全；
  · NC-C：让 `structural_safety_single_branch` 恒返回 safe=True ⇒ 两个不安全对照变绿。
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


k1 = _load("quality_eval_safety_k1", QE / "diarization_structural_safety_k1.py")
ps = _load("quality_eval_param_sweep", QE / "diarization_param_sweep.py")


class TestGateHasTeeth:
    def test_conditional_branch_is_safe(self) -> None:
        """条件性分支（T 取可用区间内）必须判安全。"""
        assert k1.structural_safety_single_branch(
            k1.rule_single_branch(1.5))["safe"] is True

    def test_threshold_too_low_excludes_single_speaker(self) -> None:
        """T 太小 ⇒ K=1 档不可达 ⇒ 不安全（NC-A 即还原成这个方向）。"""
        res = k1.structural_safety_single_branch(k1.rule_single_branch(0.05))
        assert res["safe"] is False
        assert res["per_k"]["1"]["selectable"] is False
        # 多人档不受影响——证明判否的**正是** K=1 档
        assert res["per_k"]["4"]["selectable"] is True

    def test_threshold_too_high_is_not_structurally_unsafe(self) -> None:
        """T 过大时**在本合成集上仍可选到多人档**（sep_hint 可取小值）。

        ⚠️ 这是**合成集的性质**，不是对真机的保证：
        真实数据里 sep 的分布决定了 T 过高的代价，**那由实测覆盖**（本 spike 的假阳性表）。
        """
        res = k1.structural_safety_single_branch(k1.rule_single_branch(5.0))
        assert res["safe"] is True

    def test_known_unsafe_always_k1_rejected(self) -> None:
        res = k1.structural_safety_single_branch(k1.rule_always_k1)
        assert res["safe"] is False
        assert res["per_k"]["2"]["selectable"] is False

    def test_known_unsafe_never_k1_rejected(self) -> None:
        """= 现状：K_true=1 档结构性不可达。"""
        res = k1.structural_safety_single_branch(k1.rule_never_k1)
        assert res["safe"] is False
        assert res["per_k"]["1"]["selectable"] is False

    def test_gate_is_not_vacuous(self) -> None:
        """防恒真：安全与不安全两类必须都出现。"""
        res = k1.run_selftest(verbose=False)
        assert res["S1_single_branch_T1.5"]["safe"] is True
        assert res["UNSAFE_always_k1"]["safe"] is False
        assert res["UNSAFE_never_k1"]["safe"] is False


class TestOldGateBlindSpot:
    def test_old_gate_cannot_certify_k1(self) -> None:
        """门 §5.6③ 的原闸门**枚举不含 K=1** ⇒ 任何输出 K=1 的规则必判否。

        这是闸门**表达力的边界**，不是规则的结构性质；
        如实钉住，防止后人把"旧闸门判否"误读成"该规则真的不安全"。
        """
        old = ps.structural_safety(k1.rule_never_k1 if False else (lambda g, h: [{"k": 1, "sil": 0.5}]))
        assert old["safe"] is False
        assert all(v is False for v in old["per_k"].values())

    def test_old_gate_accepts_current_rule(self) -> None:
        """原闸门对**现行规则**仍判安全 ⇒ 未被本次扩展削弱。"""
        assert ps.structural_safety(ps.rule_silhouette_max)["safe"] is True
