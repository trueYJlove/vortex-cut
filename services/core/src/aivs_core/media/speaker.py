"""W2.2 说话人分离 —— Core 算法层（**纯函数：无 I/O、无 DB、无 ONNX**）。

Design Gate `W2_2_SPEAKER_LAYER_DESIGN_GATE_2026-10-11.md` §1/§2 冻结的签名与口径。
本模块只做数学；解码/VAD/ONNX 在别处（`speaker_vad.py` / `speaker.py:SpeakerEmbedder`）。

## 阈值策略：两条路线（§5/§6 S1）

本包已确定瓶颈在 **τ 选择**（spike §2.9：固定 τ 57.0%/最差 94.5%）。S1 要求
**对照 + 专门设计并行**，两条路线都报 DER：

1. **对照** `silhouette + k_max`：在 τ 网格上取 silhouette 最大，但簇数限定在
   `[2, k_max]`。**这是本门新组合，spike 从未实测**（Design Gate §4 明确标注）——
   故本模块把它作为**候选之一**提供，其数字必须由 S1 实测产生，**不得用旧 silhouette
   数字替它背书**。
2. **专门设计** `distance_mixture`：**逐录音**对两两窗距离做 **1 维两成分高斯混合 EM**，
   取两成分后验相等处为 τ（对对称代价是 Bayes 最优）。关键区别在于它**拟合每段录音
   自己的距离分布**，而不是套用全局/分位数阈值——这正是 spike §2.9 建议的①。

两条路线都返回 `(τ, 策略名)`，策略名入摘要以便事后归因（"这条 τ 是谁选的"）。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

# --- 冻结常量（Design Gate §4；改这些值必须重测精度门） ---
WINDOW_S = 2.0
HOP_S = 1.0
MIN_SPEECH_FRACTION = 0.60
MIN_TURN_S = 0.40
DEFAULT_K_MAX = 8
FRAME_S = 0.01
MAX_SILHOUETTE_CLUSTERS = 40

# τ 网格：spike §2.9 的 31 点口径（0.20–0.80 步长 0.02）
TAU_GRID: tuple[float, ...] = tuple(round(0.20 + 0.02 * i, 2) for i in range(31))


@dataclass
class Dendrogram:
    n: int
    # (代表窗 i, j, 平均余弦距离)
    merges: list[tuple[int, int, float]] = field(default_factory=list)


# ---------------------------------------------------------------- 窗栅格与选取


def window_grid(
    total_s: float, window_s: float = WINDOW_S, hop_s: float = HOP_S
) -> list[tuple[float, float]]:
    """整条时间线上的固定栅格滑窗（**不在语音段内部取窗**，见 spike §2.4 修正）。"""
    out: list[tuple[float, float]] = []
    t = 0.0
    while t + window_s <= total_s:
        out.append((t, t + window_s))
        t += hop_s
    return out


def speech_fraction(voiced: np.ndarray, start_s: float, end_s: float, hop_s: float = 0.01) -> float:
    """窗内语音帧占比（voiced 为 10 ms 栅格布尔）。"""
    i, j = int(start_s / hop_s), int(end_s / hop_s)
    if j <= i:
        return 0.0
    seg = voiced[i:j]
    return float(seg.mean()) if seg.size else 0.0


def select_windows(
    grid: list[tuple[float, float]],
    voiced: np.ndarray,
    *,
    min_speech_fraction: float = MIN_SPEECH_FRACTION,
    hop_s: float = 0.01,
) -> list[int]:
    """按窗内语音占比筛选栅格索引。"""
    return [
        i
        for i, (a, b) in enumerate(grid)
        if speech_fraction(voiced, a, b, hop_s) >= min_speech_fraction
    ]


# ---------------------------------------------------------------- 聚类（UPGMA）


def build_dendrogram(vectors: np.ndarray) -> Dendrogram:
    """余弦距离 + 平均连接（UPGMA），一次构树、任意阈值切。

    为什么构树而不是逐阈值重跑：**阈值敏感度本身就是结论**——报告 n_speakers(τ)
    曲线才能看出"单说话人不过分割"与"双说话人能分开"两个区间是否重叠。
    """
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
    """在给定 τ 处切树，返回每窗标签（并查集）。"""
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


# ---------------------------------------------------------------- silhouette


def silhouette(dmat: np.ndarray, labels: np.ndarray) -> float:
    """按**簇块**算轮廓系数（块内/块间均值各一次矩阵运算）。

    首版逐样本循环、内层还对每个簇做布尔索引 ⇒ 低 τ 下簇数上百时退化为
    O(簇数 × 样本数) 次 numpy 调用，4 场会议直接跑不完。块矩阵版把每个 τ 降到
    O(簇数²) 次运算。
    """
    uniq = np.unique(labels)
    if uniq.size < 2 or uniq.size > MAX_SILHOUETTE_CLUSTERS:
        return -1.0
    masks = [labels == u for u in uniq]
    mean_to = np.empty((uniq.size, labels.size))
    for ci, mi in enumerate(masks):
        block = dmat[mi]
        for cj, mj in enumerate(masks):
            mean_to[cj, mi] = block[:, mj].mean(axis=1)
    own = np.empty(labels.size)
    other = np.full(labels.size, np.inf)
    for ci, mi in enumerate(masks):
        sub = mean_to[:, mi]
        own[mi] = sub[ci]
        for cj in range(uniq.size):
            if cj != ci:
                other[mi] = np.minimum(other[mi], sub[cj])
    denom = np.maximum(own, other)
    scores = np.where(denom > 0, (other - own) / np.maximum(denom, 1e-12), 0.0)
    return float(scores.mean())


def pairwise_distances(vectors: np.ndarray) -> np.ndarray:
    """上三角两两余弦距离（展平）。"""
    v = np.asarray(vectors, dtype=np.float64)
    norms = np.linalg.norm(v, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    v = v / norms
    d = 1.0 - v @ v.T
    return d[np.triu_indices(d.shape[0], k=1)]


# ---------------------------------------------------------------- 路线①：silhouette + k_max


def choose_threshold_silhouette_capk(
    dendro: Dendrogram,
    vectors: np.ndarray,
    *,
    k_max: int = DEFAULT_K_MAX,
    tau_grid: tuple[float, ...] = TAU_GRID,
) -> tuple[float, str]:
    """对照路线：silhouette 最大，且簇数 ∈ [2, k_max]。

    **本门新组合（spike 从未实测）**。若没有任何 τ 落在 [2, k_max]，退回
    "不超过 k_max 的最大 τ"（安全界语义），并把策略名标注为 fallback，
    使"这条 τ 是退路选的"在摘要里可见。
    """
    v = np.asarray(vectors, dtype=np.float64)
    norms = np.linalg.norm(v, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    dmat = 1.0 - (v / norms) @ (v / norms).T

    best_sil, best_tau = -2.0, None
    for tau in tau_grid:
        labels = labels_at(dendro, tau)
        k = int(np.unique(labels).size)
        if k < 2 or k > k_max:
            continue
        s = silhouette(dmat, labels)
        if s > best_sil:
            best_sil, best_tau = s, tau
    if best_tau is not None:
        return float(best_tau), "silhouette+capK"
    # 安全界：取"簇数首次降到 ≤k_max"的交叉 τ（找不到则网格上界）
    for tau in tau_grid:
        if count_at(dendro, tau) <= k_max:
            return float(tau), "silhouette+capK(fallback:no-valid-k)"
    return float(tau_grid[-1]), "silhouette+capK(fallback:grid-max)"


# ---------------------------------------------------------------- 路线②：逐录音距离分布建模


def _em_two_component(
    d: np.ndarray, *, q_lo: float, q_hi: float, iters: int, tol: float
) -> dict:
    """单次两成分 EM（给定分位点初值）。返回含对数似然的字典（**内部用**）。"""
    mu = np.array(
        [float(np.quantile(d, q_lo)), float(np.quantile(d, q_hi))], dtype=np.float64
    )
    if mu[0] > mu[1]:
        mu = mu[::-1]
    var = np.full(2, max(float(np.var(d)), 1e-6))
    w = np.array([0.5, 0.5], dtype=np.float64)

    prev_ll = -np.inf
    ll = prev_ll
    for _ in range(iters):
        logp = np.empty((2, d.size))
        for k in range(2):
            logp[k] = (
                math.log(max(w[k], 1e-12))
                - 0.5 * math.log(2 * math.pi * var[k])
                - 0.5 * (d - mu[k]) ** 2 / var[k]
            )
        m = logp.max(axis=0)
        ll = float(m.sum() + np.log(np.exp(logp - m).sum(axis=0)).sum())
        r = np.exp(logp - m)
        r /= r.sum(axis=0, keepdims=True)

        nk = r.sum(axis=1)
        w = nk / d.size
        mu = (r * d).sum(axis=1) / np.maximum(nk, 1e-12)
        var = (r * (d - mu[:, None]) ** 2).sum(axis=1) / np.maximum(nk, 1e-12)
        var = np.maximum(var, 1e-9)
        if abs(ll - prev_ll) < tol * max(1.0, abs(prev_ll)):
            break
        prev_ll = ll

    if mu[0] > mu[1]:
        mu, var, w = mu[::-1], var[::-1], w[::-1]
    return {
        "mu_raw": [float(mu[0]), float(mu[1])],
        "var_raw": [float(var[0]), float(var[1])],
        "weight_raw": [float(w[0]), float(w[1])],
        "log_likelihood": float(ll),
    }


def fit_distance_mixture(
    distances: np.ndarray,
    *,
    iters: int = 200,
    tol: float = 1e-8,
    seed: int = 0,
) -> dict:
    """1 维两成分高斯混合的 EM 拟合（**纯 numpy**；本仓无 scipy/sklearn）。

    成分语义：**低均值 = 同一说话人**（窗间距离小），**高均值 = 不同说话人**。
    返回 {mu, sigma, weight, crossing, separation, ok}；`crossing` 为两成分
    后验相等处（等先验 + 等方差时即两者中点）——对对称代价是 Bayes 最优阈值。
    """
    d = np.asarray(distances, dtype=np.float64).reshape(-1)
    if d.size < 4:
        return {"ok": False, "reason": "too_few_distances", "crossing": None}

    lo, hi = float(np.min(d)), float(np.max(d))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi - lo < 1e-9:
        return {"ok": False, "reason": "degenerate_distances", "crossing": None}

    # **多起点 EM**（确定性网格，非随机）：两成分高斯混合对初值敏感，
    # 单次"中位数劈半"初始化在多模态距离分布上会收敛到局部最优
    # （实测：4 簇夹具的距离呈三模态 0.01/0.9–1.0/1.9，劈半初始化把低+中两模态
    #   并成一个成分、只估出 1 个说话人）。故在分位点上跑多次、取对数似然最大者。
    # **不用随机数**：起点是固定的分位点序列 ⇒ 同输入必同输出（可复现）。
    starts = [
        (q, 1.0 - q) for q in (0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90)
    ]
    _ = seed  # 保留 seed 接口（当前实现确定性，不需要它）
    best: dict | None = None
    for q_lo, q_hi in starts:
        fit = _em_two_component(d, q_lo=q_lo, q_hi=q_hi, iters=iters, tol=tol)
        if best is None or fit["log_likelihood"] > best["log_likelihood"]:
            best = fit
    assert best is not None
    mu = np.asarray(best["mu_raw"], dtype=np.float64)
    var = np.asarray(best["var_raw"], dtype=np.float64)
    w = np.asarray(best["weight_raw"], dtype=np.float64)
    ll = best["log_likelihood"]

    if mu[0] > mu[1]:  # 规范化：0 = 同说话人（低距离）
        mu, var, w = mu[::-1], var[::-1], w[::-1]

    # 两成分后验相等处：等方差时是中点；一般情形解二次方程
    # w0*N(x;mu0,s0) = w1*N(x;mu1,s1)
    a = 1.0 / (2 * var[1]) - 1.0 / (2 * var[0])
    b = mu[0] / var[0] - mu[1] / var[1]
    c = (
        mu[1] ** 2 / (2 * var[1])
        - mu[0] ** 2 / (2 * var[0])
        + math.log(max(w[1], 1e-12) * math.sqrt(var[0]))
        - math.log(max(w[0], 1e-12) * math.sqrt(var[1]))
    )
    crossing = None
    if abs(a) < 1e-12:
        if abs(b) > 1e-12:
            crossing = -c / b
    else:
        disc = b * b - 4 * a * c
        if disc >= 0:
            roots = [(-b + math.sqrt(disc)) / (2 * a), (-b - math.sqrt(disc)) / (2 * a)]
            # 取落在两均值之间、且离"中点"最近的根（另一个根是远端伪解）
            mid = 0.5 * (mu[0] + mu[1])
            inband = [x for x in roots if mu[0] <= x <= mu[1]]
            crossing = min(inband, key=lambda x: abs(x - mid)) if inband else min(
                roots, key=lambda x: abs(x - mid)
            )
    if crossing is None or not math.isfinite(crossing):
        crossing = 0.5 * (mu[0] + mu[1])

    # 两成分分得开不开（用于摘要与"该录音是否可信"）
    pooled = math.sqrt(max(0.5 * (var[0] + var[1]), 1e-12))
    separation = float((mu[1] - mu[0]) / pooled) if pooled > 0 else 0.0
    return {
        "ok": True,
        "mu": [float(mu[0]), float(mu[1])],
        "sigma": [float(math.sqrt(var[0])), float(math.sqrt(var[1]))],
        "weight": [float(w[0]), float(w[1])],
        "crossing": float(crossing),
        "separation": separation,
        "log_likelihood": float(ll),
    }


def choose_threshold_distance_mixture(
    dendro: Dendrogram,
    vectors: np.ndarray,
    *,
    k_max: int = DEFAULT_K_MAX,
    tau_grid: tuple[float, ...] = TAU_GRID,
) -> tuple[float, str]:
    """专门设计路线：**逐录音**拟合两两距离的两成分混合，取后验相等处为 τ。

    `k_max` 作为**安全界**仍生效（超过 k_max 的 τ 不用）——但主判据来自
    该录音自己的距离分布，而非全局/分位数。拟合失败时显式退回对照路线并在
    策略名里标注，**不静默给一个假结论**。
    """
    d = pairwise_distances(vectors)
    fit = fit_distance_mixture(d)
    if not fit.get("ok"):
        tau, name = choose_threshold_silhouette_capk(
            dendro, vectors, k_max=k_max, tau_grid=tau_grid
        )
        return tau, f"distance_mixture(fallback:{fit.get('reason')})"

    # **由距离分布反推本录音的说话人数**：均衡分簇下，"同说话人窗对"占全部窗对的
    # 比例 ≈ 1/K ⇒ K̂ ≈ 1 / w_same。这是**逐录音**的量，不套用全局阈值，
    # 正是 spike §2.9 建议①的核心。ES2004a 实测 w_same=0.258 ⇒ K̂≈3.9 → 4（真值 4）。
    w_same = max(float(fit["weight"][0]), 1e-6)
    k_hat = int(round(1.0 / w_same))
    k_hat = max(1, min(k_hat, k_max))

    # τ = 簇数首次降到 ≤ K̂ 的交叉点（= 满足约束的**最小** τ）。
    # **不能取最大 τ**：那会一路滑到网格上界、把所有窗并成 1 簇
    # （本实现首版就踩了这个坑，与 spike 首版 capK 的错误同类）。
    capped = [t for t in tau_grid if count_at(dendro, t) <= k_hat]
    if capped:
        tau = float(min(capped))
        return tau, f"distance_mixture(k_hat={k_hat})"
    # 整条网格都 > K̂：显式退回（不假装已满足）
    tau = float(tau_grid[-1])
    return tau, f"distance_mixture(k_hat={k_hat},fallback:no-valid-tau)"


# ---------------------------------------------------------------- 统一入口（冻结签名）


def choose_threshold(
    dendro: Dendrogram,
    vectors: np.ndarray,
    *,
    k_max: int = DEFAULT_K_MAX,
    strategy: str = "distance_mixture",
    tau_grid: tuple[float, ...] = TAU_GRID,
) -> tuple[float, str]:
    """返回 `(τ, 策略名)`；策略名入摘要，便于事后归因（"这条 τ 是谁选的"）。

    `strategy`：`"silhouette_capk"`（对照）或 `"distance_mixture"`（专门设计）。
    """
    if strategy == "silhouette_capk":
        return choose_threshold_silhouette_capk(
            dendro, vectors, k_max=k_max, tau_grid=tau_grid
        )
    if strategy == "distance_mixture":
        return choose_threshold_distance_mixture(
            dendro, vectors, k_max=k_max, tau_grid=tau_grid
        )
    raise ValueError(f"unknown strategy: {strategy}")


# ---------------------------------------------------------------- 窗标签 → 轮次


def windows_to_turns(
    windows: list[tuple[float, float]],
    labels: np.ndarray,
    total_s: float,
    *,
    min_turn_s: float = MIN_TURN_S,
    frame_s: float = FRAME_S,
) -> list[dict]:
    """窗标签 → 帧标签（重叠窗按**最近中心**裁决）→ 合并过短碎段 → 轮次。

    返回 `[{"start_us": int, "end_us": int, "speaker": int}]`。
    """
    n = int(round(total_s / frame_s))
    owner = np.full(n, -1, dtype=np.int64)
    best = np.full(n, np.inf)
    for (a, b), lab in zip(windows, labels):
        ia, ib = max(0, int(a / frame_s)), min(n, int(b / frame_s))
        if ib <= ia:
            continue
        t = (np.arange(ia, ib) + 0.5) * frame_s
        dist = np.abs(t - (a + b) / 2.0)
        sel = dist < best[ia:ib]
        idx = np.arange(ia, ib)[sel]
        best[idx] = dist[sel]
        owner[idx] = lab

    runs: list[list[int]] = []
    start = 0
    for i in range(1, n + 1):
        if i == n or owner[i] != owner[start]:
            runs.append([start, i, int(owner[start])])
            start = i
    min_frames = int(min_turn_s / frame_s)
    for k, run in enumerate(runs):
        if run[1] - run[0] >= min_frames or run[2] == -1:
            continue
        donor = runs[k - 1][2] if k > 0 else (runs[k + 1][2] if k + 1 < len(runs) else -1)
        run[2] = donor
    merged: list[list[int]] = []
    for run in runs:
        if merged and merged[-1][2] == run[2]:
            merged[-1][1] = run[1]
        else:
            merged.append(list(run))
    return [
        {"start_us": int(a * frame_s * 1_000_000), "end_us": int(b * frame_s * 1_000_000),
         "speaker": int(lab)}
        for a, b, lab in merged
        if lab != -1
    ]
