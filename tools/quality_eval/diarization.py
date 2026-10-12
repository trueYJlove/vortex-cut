"""帧级 DER（Diarization Error Rate）评分器 —— **W2.2 的验收仪器（常设）**。

原址 `tools/spikes/w22_speaker/der.py`；按 Design Gate §6 S0 ① 迁入 `tools/quality_eval/`，
并以 pytest 用例形态落进 `services/core/tests`（`pyproject` 的 `testpaths` 只收 core，
迁到 `tools/` 的自检**不会进任何门** —— 复核 F2 实测）。spike 侧保留薄转发防两份实现漂移。

为什么自己写：AMI 官方配方推荐的参考评分器 `BUTSpeechFIT/dscore` **仓库已不存在**（实测 404），
PyPI 上的 `dscore` 是同名无关包（GPL3 的日语工具）。因此本文件自实现，并把**口径显式写死**，
再用已知答案 + 负向对照把评分器本身钉死（否则"DER=xx%"只是个数）。

## 口径声明（与 md-eval 的差异必须明说）

- 帧步长 10 ms。
- **collar**：参考轮次边界 ±0.25 s 内的帧**不计分**（容忍边界抖动，md-eval 默认同为 0.25 s）。
- **重叠语音**：参考中 ≥2 人同时说话的帧**不计分**（"忽略重叠"口径；md-eval 默认可配置）。
  ⇒ 本分数**不是**重叠场景的完整 DER，**会高估质量**（忽略重叠让数字偏好），必须与结论同读。
- **最优说话人映射**：穷举 参考×假设 的说话人排列取最优（说话人数少，排列可枚举）。
- 计分帧 = 参考语音帧 − collar − 重叠帧。MISS/SPKERR 在计分帧上统计；
  FA（假设在参考静音处说话）按**同一分母**归一。
- DER = (MISS + SPKERR + FA) / 计分帧数。

⚠️ 低 τ 处 DER 可 **>100%**：FA 与说话人错误按"计分帧"归一，而过分割使这两项远超分母。
这是口径的量纲后果，不是实现错误。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

FRAME_S = 0.01
COLLAR_S = 0.25


def load_rttm(path: str | Path) -> list[tuple[float, float, str]]:
    turns: list[tuple[float, float, str]] = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        f = line.split()
        if len(f) >= 8 and f[0] == "SPEAKER":
            start, dur = float(f[3]), float(f[4])
            turns.append((start, start + dur, f[7]))
    return sorted(turns)


def _max_weight_matching(weights: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    r"""最大权**二分匹配**（Hungarian / Jonker-Volgenant，O(n³)），纯 numpy 无外部依赖。

    为什么必须精确解：这就是 DER 里"最优说话人映射"的定义本身。
    映射错一对，SPKERR 就整体偏大，且**偏差是方向性的**
    （只在 n_hyp > n_ref 时触发，即只惩罚过分割）。

    语义：`weights` 为 (n_rows, n_cols) 的非负命中数矩阵；要求 `n_rows ≤ n_cols`
    （行侧**全部**要被分配，列侧允许多余）。返回 `(row_ind, col_ind)`，二者等长且
    `col_ind` 无重复，使 `sum(weights[r, col[r]])` 最大。

    实现在 `(8, 200)` 上实测 1 ms；**正确性由与穷举逐值对照钉死**
    （300 组随机 + 关键形态，见 `test_diarization_scorer.py`）。
    """
    w = np.asarray(weights, dtype=np.float64)
    n, m = w.shape
    if n == 0 or m == 0:
        return np.empty(0, dtype=np.int64), np.empty(0, dtype=np.int64)
    if n > m:
        raise ValueError("_max_weight_matching 要求 n_rows <= n_cols（调用方负责转置）")
    cost = -w
    u = np.zeros(n + 1)
    v = np.zeros(m + 1)
    p = np.zeros(m + 1, dtype=np.int64)
    way = np.zeros(m + 1, dtype=np.int64)
    inf = np.inf
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = np.full(m + 1, inf)
        used = np.zeros(m + 1, dtype=bool)
        while True:
            used[j0] = True
            i0 = int(p[j0])
            row = cost[i0 - 1]
            delta, j1 = inf, -1
            for j in range(1, m + 1):
                if used[j]:
                    continue
                cur = row[j - 1] - u[i0] - v[j]
                if cur < minv[j]:
                    minv[j] = cur
                    way[j] = j0
                if minv[j] < delta:
                    delta, j1 = minv[j], j
            for j in range(m + 1):
                if used[j]:
                    u[int(p[j])] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = int(way[j0])
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break
    col = np.full(n, -1, dtype=np.int64)
    for j in range(1, m + 1):
        if p[j] != 0:
            col[int(p[j]) - 1] = j - 1
    return np.arange(n, dtype=np.int64), col


def _frame_index(times: list[float]) -> np.ndarray:
    return np.round(np.asarray(times, dtype=np.float64) / FRAME_S).astype(np.int64)


def _ref_frames(turns, n_frames: int) -> tuple[np.ndarray, np.ndarray]:
    """返回 (每帧参考说话人数, 每帧参考说话人 id 或 -1)。"""
    speakers = {s: i for i, s in enumerate(sorted({t[2] for t in turns}))}
    counts = np.zeros(n_frames, dtype=np.int64)
    owner = np.full(n_frames, -1, dtype=np.int64)
    for start, end, spk in turns:
        a = max(0, int(round(start / FRAME_S)))
        b = min(n_frames, int(round(end / FRAME_S)))
        if b <= a:
            continue
        counts[a:b] += 1
        idx = speakers[spk]
        owner[a:b] = np.where(owner[a:b] == -1, idx, owner[a:b])
    owner[counts != 1] = -1
    return counts, owner


def _hyp_frames(turns, n_frames: int) -> np.ndarray:
    speakers = {s: i for i, s in enumerate(sorted({t[2] for t in turns}))}
    owner = np.full(n_frames, -1, dtype=np.int64)
    for start, end, spk in turns:
        a = max(0, int(round(start / FRAME_S)))
        b = min(n_frames, int(round(end / FRAME_S)))
        if b > a:
            owner[a:b] = speakers[spk]
    return owner


def _collar_mask(turns, n_frames: int, collar_s: float = COLLAR_S) -> np.ndarray:
    mask = np.zeros(n_frames, dtype=bool)
    half = int(round(collar_s / FRAME_S))
    for start, end, _ in turns:
        for boundary in (start, end):
            c = int(round(boundary / FRAME_S))
            a, b = max(0, c - half), min(n_frames, c + half + 1)
            mask[a:b] = True
    return mask


@dataclass(frozen=True)
class DerResult:
    der: float
    miss: float
    false_alarm: float
    speaker_error: float
    scored_frames: int
    ref_speakers: int
    hyp_speakers: int
    mapping: dict[int, int]

    def as_dict(self) -> dict:
        return {
            "der": round(self.der, 4),
            "miss": round(self.miss, 4),
            "false_alarm": round(self.false_alarm, 4),
            "speaker_error": round(self.speaker_error, 4),
            "scored_frames": self.scored_frames,
            "scored_seconds": round(self.scored_frames * FRAME_S, 2),
            "ref_speakers": self.ref_speakers,
            "hyp_speakers": self.hyp_speakers,
            "mapping": {str(k): v for k, v in self.mapping.items()},
        }


def score(
    ref_turns,
    hyp_turns,
    *,
    total_s: float,
    collar_s: float = COLLAR_S,
    ignore_overlap: bool = True,
) -> DerResult:
    n_frames = int(round(total_s / FRAME_S))
    ref_count, ref_owner = _ref_frames(ref_turns, n_frames)
    hyp_owner = _hyp_frames(hyp_turns, n_frames)
    collar = _collar_mask(ref_turns, n_frames, collar_s)

    scored = ref_count > 0
    if ignore_overlap:
        scored &= ref_count == 1
    scored &= ~collar
    n_scored = int(scored.sum())
    if n_scored == 0:
        raise ValueError("no scored reference frames")

    best_hit = 0
    n_ref = int(ref_owner.max()) + 1 if ref_owner.max() >= 0 else 0
    n_hyp = int(hyp_owner.max()) + 1 if hyp_owner.max() >= 0 else 0

    # 最优映射：穷举 假设→参考 的单射，命中数从**列联表**读，不逐排列重建帧标签。
    # （首版按映射重建 mapped 数组 ⇒ O(排列数 × 假设数 × 帧数)；低阈值下假设数可达数百，
    #   4 会议实测跑到超时。列联表把这一步降到 O(排列数 × 假设数)。）
    hit_frames = int(scored.sum()) - int(((hyp_owner == -1) & scored).sum())
    contingency = np.zeros((max(n_ref, 1), max(n_hyp, 1)), dtype=np.int64)
    both = scored & (hyp_owner >= 0) & (ref_owner >= 0)
    if both.any():
        np.add.at(contingency, (ref_owner[both], hyp_owner[both]), 1)

    # **最优映射 = 最大权二分匹配**（匈牙利/JV，O(n³)），不是"只排列前 m 个假设"。
    #
    # 缺陷（2026-10-12 由 md-eval 交叉校验发现）：旧实现是
    #     for target in permutations(range(n_ref), min(n_hyp, n_ref))
    # 永远用**序号最小的** min(n_hyp,n_ref) 个假设说话人，从不搜索"该挑哪几个"。
    #   · n_hyp ≤ n_ref 时它与全排列等价 ⇒ 无影响（故既有 14 项自检全绿）；
    #   · n_hyp > n_ref（过分割）时它可能跳过真正的匹配对 ⇒ **DER 被高估**。
    # EN2002c 实测：旧 0.4659 / 新 0.1801，NIST md-eval-22.pl 独立给出 0.1806。
    #
    # 该缺陷**只惩罚过分割**，因而系统性掩盖"欠分割的代价"——正是 §5.3 要判的问题；
    # 且它会让"初值换一下就翻车"看起来像初值敏感（实测中文 2/8 初值"越线"即由此而来）。
    #
    # 为什么用匈牙利而不是继续穷举：穷举的正确形式是 P(n_hyp,m)×P(n_ref,m)，
    # 门内最坏形态（K̂ = k_max 且过分割，n_hyp 到数百）实测把中文阶梯从 ~20 min
    # 拖到 500 s/场。匈牙利在 (8, 200) 上实测 1 ms 且**与穷举逐值一致**
    # （300 组随机 + 关键形态，见 test_diarization_scorer.py::TestOptimalMappingSubsetSearch）。
    best: dict[int, int] = {}
    if n_hyp and n_ref:
        # 行=参考（全部要分配）、列=假设（可有多余）。n_ref ≤ n_hyp 时行数更少，直接解；
        # 否则转置（"每个假设都分到一个参考"与"每个参考都分到一个假设"在
        # n_ref ≥ n_hyp 时要的是**后者**，故转置后取反解即可保持语义）。
        if n_ref <= n_hyp:
            rows, cols = _max_weight_matching(contingency.astype(np.float64))
            best = {int(c): int(r) for r, c in zip(rows, cols)}
        else:
            rows, cols = _max_weight_matching(contingency.T.astype(np.float64))
            best = {int(r): int(c) for r, c in zip(rows, cols)}
        best_hit = int(sum(contingency[r, h] for h, r in best.items()))

    miss = int(((hyp_owner == -1) & scored).sum())
    spk_err = hit_frames - (best_hit if best else 0)
    fa = int(((hyp_owner != -1) & (ref_count == 0) & ~collar).sum())

    return DerResult(
        der=(miss + spk_err + fa) / n_scored,
        miss=miss / n_scored,
        false_alarm=fa / n_scored,
        speaker_error=spk_err / n_scored,
        scored_frames=n_scored,
        ref_speakers=n_ref,
        hyp_speakers=n_hyp,
        mapping=best,
    )


# --- 自检（9 项；pytest 用例是它的**可进门**形态，见 test_diarization_scorer.py） ---

SELFTEST_REF = [
    (0.0, 10.0, "A"),
    (10.0, 20.0, "B"),
    (20.0, 30.0, "A"),
    (30.0, 40.0, "C"),
]
SELFTEST_TOTAL_S = 60.0


def run_selftest(*, verbose: bool = True) -> list[str]:
    """已知答案 + 负向对照：证明评分器不是恒真/恒假。返回失败项名列表（空 = 全过）。"""
    total = SELFTEST_TOTAL_S
    ref = list(SELFTEST_REF)
    cases: list[tuple[str, list, float | None, float | None]] = [
        ("identical", list(ref), 0.0, 0.02),
        (
            "permuted labels",
            [(a, b, {"A": "X", "B": "Y", "C": "Z"}[s]) for a, b, s in ref],
            0.0,
            0.02,
        ),
        ("empty hypothesis", [], 1.0, 1.0),
        ("single speaker everywhere", [(0.0, 40.0, "S")], None, None),
        ("shifted +1s", [(a + 1.0, b + 1.0, s) for a, b, s in ref], None, None),
        ("half missing", ref[:2], None, None),
        ("extra speech in silence", ref + [(45.0, 55.0, "D")], None, None),
    ]
    fails: list[str] = []
    if verbose:
        print(f"{'case':28s} {'DER':>8s}  判定")
    for name, hyp, expect, tol in cases:
        r = score(ref, hyp, total_s=total)
        if expect is None:
            ok = True
            verdict = "（无期望值，仅取值）"
        else:
            ok = abs(r.der - expect) <= (tol or 0.0)
            verdict = "✅" if ok else f"❌ 期望 {expect}"
        if not ok:
            fails.append(name)
        if verbose:
            print(f"{name:28s} {r.der:8.4f}  {verdict}")

    r_single = score(ref, [(0.0, 40.0, "S")], total_s=total)
    share_max = 20.0 / 40.0
    exp = 1 - share_max
    ok = abs(r_single.der - exp) < 0.05
    if not ok:
        fails.append("single-speaker identity")
    if verbose:
        print(
            f"{'single-speaker == 1-max_share':28s} {r_single.der:8.4f}  期望≈{exp:.4f} "
            f"{'✅' if ok else '❌'}"
        )

    # 平移对照：DER 必须随平移量单调上升，且大平移要显著变差。
    # **注意**（本自检第一版就在此翻车）：10 s 轮次上平移 2 s 只错"边界带"，
    # DER≈0.23 是**正确**结果——所以判据不能拍一个"2s 就该 >0.5"，必须看单调性 + 大平移。
    shifts = [0.0, 1.0, 2.0, 5.0]
    ders = [score(ref, [(a + s, b + s, sp) for a, b, sp in ref], total_s=total).der for s in shifts]
    mono = all(ders[i] <= ders[i + 1] + 1e-9 for i in range(len(ders) - 1))
    big = ders[-1] > 0.4
    if not (mono and big):
        fails.append("shift monotonicity")
    if verbose:
        series = " ".join(f"{d:.4f}" for d in ders)
        print(
            f"{'shift monotonic 0/1/2/5s':28s} {series}  "
            f"单调={'✅' if mono else '❌'} 5s>0.4={'✅' if big else '❌'}"
        )

    if verbose:
        r_empty = score(ref, [], total_s=total)
        r_all = score(ref, [(0.0, 40.0, "S")], total_s=total)
        print(
            f"  （empty: miss={r_empty.miss:.3f} fa={r_empty.false_alarm:.3f}"
            f" spk={r_empty.speaker_error:.3f}）"
        )
        print(
            f"  （single: miss={r_all.miss:.3f} fa={r_all.false_alarm:.3f}"
            f" spk={r_all.speaker_error:.3f}）"
        )
        print("\n自检:", "全部通过 ✅" if not fails else f"失败 {fails} ❌")
    return fails


def _selftest() -> int:
    return 0 if not run_selftest() else 1


if __name__ == "__main__":
    raise SystemExit(_selftest())
