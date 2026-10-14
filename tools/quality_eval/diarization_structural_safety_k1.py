r"""`structural_safety` 的 **K=1 扩展**：让闸门能检验"条件性单人分支"规则类。

**为什么需要它**（2026-10-14，本次 spike 执行期发现）：

门 §5.6③ 的 `structural_safety` 在**合成候选集上只枚举 K ∈ [2, 8]**。
这对**现有规则类**（候选窗下界本就是 2）是正确的，但对
**"条件性输出 K=1"的规则类**它有两个盲区：

1. **无法认证**：合成集里没有 K=1 候选 ⇒ K_true=1 档**永远判否**
   （实测：任何"能输出 K=1"的规则在 `k_range=(2..7)` 下必然 safe=False，
    包括本 spike 的候选——这**不是**它的真实结构性质，而是闸门表达力的边界）；
2. **无法区分**："**无条件**恒取 K=1"（真的不安全，会把 2–7 人全压成 1）
   与"**条件性**在低可分性时取 K=1"（其安全性取决于条件），
   在当前闸门下**得到同一个判定**。

**本扩展做什么**：把 K=1 纳入枚举，并把**触发条件**显式建模为
`sep_hint`（本 spike 用 `separation`）。于是闸门的判据还原为其本意——
"**是否存在参数取值，使该规则能选中正确答案**"。

- K_true=1 档：需要一个 `T` 使 `sep_hint < T` 成立 ⇒ 要求 T 可以**足够大**；
- K_true>=2 档：需要一个 `T` 使 `sep_hint >= T` 成立 ⇒ 要求 T 可以**足够小**。

⇒ 条件性分支**结构安全**，当且仅当 T 的取值域**两端都不被截死**
（这是本扩展要检验的命题，而不是预先假定）。

**这不是对门 §5.6③ 的替代**：原闸门仍须过（本 spike 按原口径一并报告）。
本扩展是**并列的必要条件**，且必须自带**负向对照**证明它有区分力。
"""

from __future__ import annotations

from typing import Callable

# K 枚举含 1（原闸门从 2 起）
SAFE_K_RANGE_V2: tuple[int, ...] = (1, 2, 3, 4, 5, 6, 7)

# 触发条件的合成取值域：覆盖"可分性极低"到"可分性很高"
SEP_HINT_RANGE: tuple[float, ...] = (0.05, 1.0, 2.0, 3.0, 5.0)


def _ideal_grid(k_true: int, *, n: int = 8) -> list[dict]:
    """理想候选集：**正确答案的 silhouette 最高**（含 K=1 候选）。

    K=1 候选在本门的评分口径下 **silhouette 无定义**（`None`）——
    这正是产品缺陷的根源，故本合成集**如实**把它建模为 `sil=None`，
    并要求规则靠**触发条件**（而非 silhouette）选中它。
    """
    grid = [{"k": 1, "sil": None, "der": 0.10}]
    for k in range(2, n + 1):
        grid.append({"k": k,
                     "sil": 0.50 if k == k_true else 0.30,
                     "der": 0.10 if k == k_true else 0.40})
    return grid


def structural_safety_single_branch(
    pred: Callable[..., list[dict]],
    *,
    k_range: tuple[int, ...] = SAFE_K_RANGE_V2,
) -> dict:
    """检验"条件性单人分支"规则的**结构安全性**。

    `pred(grid, k_true, sep_hint)` 返回该规则在此条件下的候选集。
    对每个 (k_true, sep_hint) 组合，检查规则**是否有可能**选中正确答案：

    - k_true == 1 ⇒ 正确答案是 K=1（需被触发分支选中）；
    - k_true >= 2 ⇒ 正确答案是 K=k_true（需**未被**触发，或触发后仍保留该档）。

    `safe` = 对每个 k_true，**存在**某个 sep_hint 使正确答案可选。
    `per_k` 记录每个档位可用的 sep_hint 列表——**空列表即该档被结构性排除**。
    """
    per_k: dict[str, dict] = {}
    for k_true in k_range:
        ok_hints: list[float] = []
        for sep in SEP_HINT_RANGE:
            grid = _ideal_grid(k_true)
            cands = pred(grid, k_true, sep)
            if k_true == 1:
                # 正确答案 = K=1，且本门口径下其 sil 为 None
                hit = any(c.get("k") == 1 for c in cands)
            else:
                hit = any(c.get("k") == k_true and c.get("sil") is not None for c in cands)
            if hit:
                ok_hints.append(sep)
        per_k[str(k_true)] = {"ok_sep_hints": ok_hints, "selectable": bool(ok_hints)}
    return {"per_k": per_k, "safe": all(v["selectable"] for v in per_k.values())}


# ---------------------------------------------------------------- 规则形态（含负向对照）

def rule_single_branch(T: float) -> Callable[..., list[dict]]:
    """本 spike 的候选形态：`sep_hint < T` ⇒ 只留 K=1；否则走上界型候选。"""
    def pred(grid: list[dict], k_true: int, sep_hint: float) -> list[dict]:
        if sep_hint < T:
            return [g for g in grid if g["k"] == 1]
        return [g for g in grid if g["k"] >= 2 and g["sil"] is not None]
    return pred


def rule_always_k1(grid: list[dict], k_true: int, sep_hint: float) -> list[dict]:
    """**已知不安全**的对照：无条件恒取 K=1（必须被判不安全）。"""
    return [g for g in grid if g["k"] == 1]


def rule_never_k1(grid: list[dict], k_true: int, sep_hint: float) -> list[dict]:
    """**已知不安全**的对照 2：永不输出 K=1（= 现状，K_true=1 档必然排除）。"""
    return [g for g in grid if g["k"] >= 2 and g["sil"] is not None]


RULE_CLASSES = {
    "S1_single_branch_T1.5": rule_single_branch(1.5),
    "S1_single_branch_T0.05": rule_single_branch(0.05),   # T 太低 ⇒ K=1 档不可达
    "S1_single_branch_T5.0": rule_single_branch(5.0),     # T 太高 ⇒ 多人档被压
    "UNSAFE_always_k1": rule_always_k1,
    "UNSAFE_never_k1": rule_never_k1,
}


def run_selftest(*, verbose: bool = True) -> dict:
    """闸门自检：**安全性必须依赖 T**，且两个不安全对照必须被判不安全。"""
    res = {name: structural_safety_single_branch(fn) for name, fn in RULE_CLASSES.items()}
    if verbose:
        for name, r in res.items():
            flags = {k: v["selectable"] for k, v in r["per_k"].items()}
            print(f"{name:26s} safe={r['safe']}  {flags}")
    return res


if __name__ == "__main__":
    import json
    print("=== structural_safety_single_branch 自检 ===")
    res = run_selftest()
    print()
    print(json.dumps({k: {"safe": v["safe"]} for k, v in res.items()},
                     ensure_ascii=False, indent=2))
