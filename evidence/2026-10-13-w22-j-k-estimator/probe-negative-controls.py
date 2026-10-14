"""K 估计器 spike 的负向对照：验证候选实现**有区分力**。

用合成向量集（已知"真值"结构）直接测纯函数，快且确定。
"""
import json
import sys

sys.path.insert(0, "tools/quality_eval")
sys.path.insert(0, "services/core/src")

import numpy as np

from diarization_k_estimators import (  # noqa: E402
    e0_distance_mixture,
    e1_pca_effective_rank,
    e2_merge_gap,
    e3_split_consistency,
)

rng = np.random.default_rng(11)


def blobs(k: int, per: int = 12, dim: int = 192, spread: float = 0.02) -> np.ndarray:
    """k 个说话人簇：每簇一个随机中心 + 小扰动。"""
    centers = rng.normal(size=(k, dim))
    centers /= np.linalg.norm(centers, axis=1, keepdims=True)
    out = []
    for c in centers:
        out.append(c + rng.normal(scale=spread, size=(per, dim)))
    v = np.vstack(out)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


res = {}
for k in (2, 3, 5):
    v = blobs(k)
    res["k%d" % k] = {
        "e0": e0_distance_mixture(v),
        "e1": e1_pca_effective_rank(v),
        "e2": e2_merge_gap(v),
        "e3": e3_split_consistency(v),
    }
print(json.dumps(res, ensure_ascii=False))
