"""W2.2 后续步骤② —— 「不偷看真值 K」的聚类族替换工具（纯函数部分）pytest 形态。

Design Gate §5.2/§5.3 的升级路径评估依赖本工具。这里钉死三件事：
1. **k-means 确定性**：同输入同输出（多起点取最优，无随机漂移）——否则"过门"不可复现；
2. **自动 K 有界**：`pick_k_silhouette`/`pick_k_elbow` 结果必须落在 k_range 内；
3. **欠分割是已知性质**：在"两个紧致簇"上自动 K 不应过度分裂（回归锁，防未来改动反转性质）。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
QE = ROOT / "tools" / "quality_eval"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# 依赖：diarization_cache / diarization 在同目录
sys.path.insert(0, str(QE))
routes = _load("quality_eval_cluster_routes", QE / "diarization_cluster_routes.py")


def _two_clusters(n_per: int = 30, dim: int = 16, gap: float = 1.0, seed: int = 0):
    rng = np.random.default_rng(seed)
    a = rng.normal(0, 0.05, (n_per, dim)) + np.r_[gap, np.zeros(dim - 1)]
    b = rng.normal(0, 0.05, (n_per, dim)) - np.r_[gap, np.zeros(dim - 1)]
    return np.vstack([a, b])


class TestKmeansDeterminism:
    def test_same_input_same_output(self):
        v = _two_clusters()
        l1, i1 = routes.kmeans_cosine(v, 2)
        l2, i2 = routes.kmeans_cosine(v, 2)
        assert np.array_equal(l1, l2) and i1 == i2

    def test_finds_two_clusters(self):
        v = _two_clusters(gap=1.0)
        lab, _ = routes.kmeans_cosine(v, 2)
        assert np.unique(lab).size == 2
        # 两簇必须与真实分组一致（允许标签互换）
        a, b = lab[:30], lab[30:]
        assert len(set(a)) == 1 and len(set(b)) == 1 and a[0] != b[0]

    def test_k_clamped_to_n(self):
        v = _two_clusters(n_per=2)
        lab, _ = routes.kmeans_cosine(v, 99)
        assert np.unique(lab).size <= v.shape[0]


class TestAutoKBounds:
    def test_silhouette_k_in_range(self):
        v = _two_clusters()
        k, s = routes.pick_k_silhouette(v, k_range=(2, 3, 4, 5))
        assert k in (2, 3, 4, 5)
        assert np.isfinite(s)

    def test_elbow_k_in_range(self):
        v = _two_clusters()
        k = routes.pick_k_elbow(v, k_range=(2, 3, 4, 5))
        assert k in (2, 3, 4, 5)

    def test_silhouette_prefers_clean_two_clusters(self):
        # 干净两簇：silhouette 应选中 K=2（回归锁：防 K 选择逻辑反转）
        v = _two_clusters(gap=1.2)
        k, _ = routes.pick_k_silhouette(v, k_range=(2, 3, 4, 5, 6))
        assert k == 2, k


class TestSilhouetteWrapper:
    def test_single_cluster_is_undefined(self):
        # 单簇无定义 ⇒ Core 的 silhouette 显式返回 -1（不是 0）
        v = _two_clusters()
        assert routes.silhouette_of(v, np.zeros(v.shape[0], dtype=int)) == -1.0

    def test_matches_core_implementation(self):
        # 必须复用 Core 的块矩阵实现（防两份实现漂移）
        from aivs_core.media import speaker as sp

        v = _two_clusters()
        lab, _ = routes.kmeans_cosine(v, 2)
        x = routes._l2(v)
        dmat = 1.0 - x @ x.T
        assert routes.silhouette_of(v, lab) == sp.silhouette(dmat, lab)
