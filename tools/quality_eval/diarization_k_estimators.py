"""W2.2 K 估计器候选（阶段二，按 PRE_REGISTRATION.md §2 冻结）。

全部只使用**同一素材自己的**窗嵌入，不偷看真值。四个候选：

  E0  现役 round(1/w_same)                       —— 基线
  E1  PCA 有效秩（解释 >=90% 方差的主成分数）    —— "数据里有几个独立方向"
  E2  合并距离最大间隙处的簇数                    —— elbow 的间隙比值版
  E3  双半一致性投票（两半各算 E0，取中位数）     —— 针对 E0 的不稳定

**只出估计值，不做选择/聚类/评分**（那属 S3）。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
_HERE = Path(__file__).resolve().parent
for _p in (ROOT / "services" / "core" / "src", _HERE):
    sys.path.insert(0, str(_p))

from aivs_core.media import speaker as sp  # noqa: E402

K_FLOOR = 1
K_CEIL = 8


def _clip(k: float) -> int:
    return int(max(K_FLOOR, min(int(round(k)), K_CEIL)))


def e0_distance_mixture(vecs: np.ndarray) -> int:
    """现役：由两成分混合的低距离成分权重反推 K。"""
    fit = sp.fit_distance_mixture(sp.pairwise_distances(vecs))
    if not fit.get("ok"):
        return 2
    w_same = max(float(fit["weight"][0]), 1e-6)
    return _clip(1.0 / w_same)


def e1_pca_effective_rank(vecs: np.ndarray, *, var_target: float = 0.90) -> int:
    """PCA 有效秩：解释 var_target 方差所需的主成分数。

    先中心化（去均值），否则第一个成分会被"所有窗的共同方向"吃掉。
    """
    x = np.asarray(vecs, dtype=np.float64)
    if x.shape[0] < 2:
        return K_FLOOR
    x = x - x.mean(axis=0, keepdims=True)
    # 奇异值 -> 方差（除以 n-1）
    s = np.linalg.svd(x, compute_uv=False)
    var = (s**2) / max(x.shape[0] - 1, 1)
    total = float(var.sum())
    if total <= 0:
        return K_FLOOR
    cum = np.cumsum(var) / total
    rank = int(np.searchsorted(cum, var_target) + 1)
    return _clip(rank)


def e2_merge_gap(vecs: np.ndarray, *, tau_lo: float = 0.2, tau_hi: float = 0.8) -> int:
    """合并距离最大间隙处的簇数（只看 tau 窗口内的合并事件）。"""
    den = sp.build_dendrogram(vecs)
    if not den.merges:
        return K_FLOOR
    # 合并距离升序；K = n - (已合并数)
    ds = np.array([d for _, _, d in den.merges], dtype=np.float64)
    order = np.argsort(ds)
    ds = ds[order]
    n = den.n
    best_gap, best_k = -1.0, None
    for i in range(len(ds) - 1):
        # 在第 i 与 i+1 次合并之间切：此时簇数 = n - (i+1)
        gap = ds[i + 1] - ds[i]
        k = n - (i + 1)
        if not (K_FLOOR <= k <= K_CEIL):
            continue
        # 只考虑位于 tau 窗口内的切点（窗口外属已知边界，见门 §10 O2）
        if not (tau_lo <= ds[i] <= tau_hi):
            continue
        if gap > best_gap:
            best_gap, best_k = gap, k
    return _clip(best_k) if best_k is not None else K_FLOOR


def e3_split_consistency(vecs: np.ndarray) -> int:
    """双半一致性投票：两半各自 E0，取二者中位数（并要求落在同一侧）。"""
    x = np.asarray(vecs, dtype=np.float64)
    n = x.shape[0]
    if n < 4:
        return e0_distance_mixture(x)
    half = n // 2
    first = e0_distance_mixture(x[:half])
    second = e0_distance_mixture(x[half:])
    # 中位数语义：两半都给出相同值时最可信；差异大时回退到全集 E0
    if abs(first - second) <= 1:
        return _clip(round((first + second) / 2.0))
    return e0_distance_mixture(x)


ESTIMATORS = {
    "E0_distance_mixture": e0_distance_mixture,
    "E1_pca_rank": e1_pca_effective_rank,
    "E2_merge_gap": e2_merge_gap,
    "E3_split_consistency": e3_split_consistency,
}


def estimate_all(vecs: np.ndarray) -> dict[str, int]:
    x = np.asarray(vecs, dtype=np.float64)
    out: dict[str, int] = {}
    for name, fn in ESTIMATORS.items():
        try:
            out[name] = int(fn(x))
        except Exception as exc:  # 估计器失败必须是**可诊断的分支**，不静默
            out[name] = -1
            out[name + "_error"] = str(exc)[:80]  # type: ignore[assignment]
    return out
