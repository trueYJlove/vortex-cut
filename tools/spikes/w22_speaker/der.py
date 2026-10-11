"""帧级 DER（Diarization Error Rate）评分器（spike 用）。

为什么自己写：AMI 官方配方推荐的参考评分器 `BUTSpeechFIT/dscore` **仓库已不存在**（实测 404），
PyPI 上的 `dscore` 是同名无关包（GPL3 的日语工具）。因此本文件自实现，并把**口径显式写死**，
再用已知答案 + 负向对照把评分器本身钉死（否则"DER=xx%" 只是个数）。

## 口径声明（与 md-eval 的差异必须明说）

- 帧步长 10 ms。
- **collar**：参考轮次边界 ±0.25 s 内的帧**不计分**（容忍边界抖动，md-eval 默认同为 0.25 s）。
- **重叠语音**：参考中 ≥2 人同时说话的帧**不计分**（"忽略重叠"口径；md-eval 默认可配置）。
  ⇒ 本分数**不是**重叠场景的完整 DER，**不低估也高估**：忽略重叠会让数字偏好，必须与结论同读。
- **最优说话人映射**：穷举 参考×假设 的说话人排列取最优（说话人数少，排列可枚举）。
- 计分帧 = 参考语音帧 − collar − 重叠帧。MISS/SPKERR 在计分帧上统计；
  FA（假设在参考静音处说话）按**同一分母**归一。
- DER = (MISS + SPKERR + FA) / 计分帧数。
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import permutations
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
    refs = list(range(n_ref))
    hit_frames = int(scored.sum()) - int(((hyp_owner == -1) & scored).sum())
    contingency = np.zeros((max(n_ref, 1), max(n_hyp, 1)), dtype=np.int64)
    both = scored & (hyp_owner >= 0) & (ref_owner >= 0)
    if both.any():
        np.add.at(contingency, (ref_owner[both], hyp_owner[both]), 1)

    best: dict[int, int] = {}
    if n_hyp and n_ref:
        best_hit = -1
        for target in permutations(refs, min(n_hyp, n_ref)):
            hit = sum(int(contingency[r, h]) for h, r in enumerate(target))
            if hit > best_hit:
                best_hit, best = hit, dict(enumerate(target))

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


def _selftest() -> int:
    """已知答案 + 负向对照：证明评分器不是恒真/恒假。"""
    total = 60.0
    ref = [(0.0, 10.0, "A"), (10.0, 20.0, "B"), (20.0, 30.0, "A"), (30.0, 40.0, "C")]
    cases: list[tuple[str, list, float, float]] = [
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
    fails = []
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
        print(f"{name:28s} {r.der:8.4f}  {verdict}")

    r_single = score(ref, [(0.0, 40.0, "S")], total_s=total)
    share_max = 20.0 / 40.0
    ok = abs(r_single.der - (1 - share_max)) < 0.05
    exp = 1 - share_max
    mark = "✅" if ok else "❌"
    print(f"{'single-speaker == 1-max_share':28s} {r_single.der:8.4f}  期望≈{exp:.4f} {mark}")
    if not ok:
        fails.append("single-speaker identity")

    # 平移对照：DER 必须随平移量单调上升，且大平移要显著变差。
    # **注意**（本自检第一版就在此翻车）：10 s 轮次上平移 2 s 只错"边界带"，
    # DER≈0.23 是**正确**结果——所以判据不能拍一个"2s 就该 >0.5"，必须看单调性 + 大平移。
    shifts = [0.0, 1.0, 2.0, 5.0]
    ders = [
        score(ref, [(a + s, b + s, sp) for a, b, sp in ref], total_s=total).der for s in shifts
    ]
    mono = all(ders[i] <= ders[i + 1] + 1e-9 for i in range(len(ders) - 1))
    big = ders[-1] > 0.4
    series = " ".join(f"{d:.4f}" for d in ders)
    flags = f"单调={'✅' if mono else '❌'} 5s>0.4={'✅' if big else '❌'}"
    print(f"{'shift monotonic 0/1/2/5s':28s} {series}  {flags}")
    if not (mono and big):
        fails.append("shift monotonicity")

    r_empty = score(ref, [], total_s=total)
    print(
        f"  （empty: miss={r_empty.miss:.3f} fa={r_empty.false_alarm:.3f}"
        f" spk={r_empty.speaker_error:.3f}）"
    )
    r_all = score(ref, [(0.0, 40.0, "S")], total_s=total)
    print(
        f"  （single: miss={r_all.miss:.3f} fa={r_all.false_alarm:.3f}"
        f" spk={r_all.speaker_error:.3f}）"
    )

    print("\n自检:", "全部通过 ✅" if not fails else f"失败 {fails} ❌")
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(_selftest())
