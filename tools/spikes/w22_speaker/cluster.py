"""余弦距离 + 平均连接层次聚类（UPGMA），一次构树、任意阈值切。

为什么构树而不是逐阈值重跑：**阈值敏感度本身就是结论**——报告 n_speakers(τ) 曲线，
才能看出"单说话人不过分割"与"双说话人能分开"两个区间是否重叠（有无可用 τ）。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Dendrogram:
    n: int
    merges: list[tuple[int, int, float]]  # (代表窗口 i, 代表窗口 j, 平均余弦距离)


def build_dendrogram(vectors: np.ndarray) -> Dendrogram:
    v = np.asarray(vectors, dtype=np.float64)
    if v.shape[0] == 0:
        return Dendrogram(0, [])
    norms = np.linalg.norm(v, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    v = v / norms
    n = v.shape[0]
    if n == 1:
        return Dendrogram(1, [])

    dist = 1.0 - v @ v.T
    np.fill_diagonal(dist, np.inf)
    sizes = np.ones(n, dtype=np.int64)
    active = np.ones(n, dtype=bool)
    merges: list[tuple[int, int, float]] = []

    for _ in range(n - 1):
        flat = int(np.argmin(dist))
        i, j = divmod(flat, n)
        d = float(dist[i, j])
        if not np.isfinite(d):
            break
        merges.append((i, j, d))
        si, sj = int(sizes[i]), int(sizes[j])
        for k in range(n):
            if not active[k] or k == i or k == j:
                continue
            new = (dist[i, k] * si + dist[j, k] * sj) / (si + sj)
            dist[i, k] = new
            dist[k, i] = new
        sizes[i] = si + sj
        sizes[j] = 0
        active[j] = False
        dist[j, :] = np.inf
        dist[:, j] = np.inf
        dist[i, i] = np.inf
    return Dendrogram(n, merges)


def labels_at(dendro: Dendrogram, threshold: float) -> np.ndarray:
    parent = list(range(dendro.n))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for i, j, d in dendro.merges:
        if d <= threshold:
            ri, rj = find(i), find(j)
            if ri != rj:
                parent[rj] = ri
    roots: dict[int, int] = {}
    out = np.empty(dendro.n, dtype=np.int64)
    for k in range(dendro.n):
        r = find(k)
        if r not in roots:
            roots[r] = len(roots)
        out[k] = roots[r]
    return out


def count_at(dendro: Dendrogram, threshold: float) -> int:
    merged = sum(1 for _, _, d in dendro.merges if d <= threshold)
    return max(1, dendro.n - merged) if dendro.n else 0


def count_curve(dendro: Dendrogram, thresholds) -> dict[str, int]:
    return {f"{t:.2f}": count_at(dendro, t) for t in thresholds}
