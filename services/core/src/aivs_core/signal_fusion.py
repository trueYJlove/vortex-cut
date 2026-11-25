"""W4.2 信号融合 —— 纯算法层（零 I/O、零数据库，可单测）。

规划门：`docs/requirements/SIGNAL_FUSION_SPEC.md`。
裁决：D1=A（新增 `fused`，旧值不变）、D2=排除说话人、D3=等权起步且**未调优**。

分层纪律（照抄 `media/semantic.py` / `editing_grammar/beat_grid`）：
本模块只做可单测的纯函数；数据库读取与 provider 载荷组装在 `planning.py`。

**为什么权重必须显式且版本化**：门 §5 R2 已登记「权重无客观依据」。
把权重做成模块级常量 + 版本号，是为了让将来的调整**可追溯**，
而不是让魔数散落在排序 lambda 里。**当前权重未经调优，不得声称最优。**
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

# 权重版本：改权重必须改此版本号（供审计与回溯）。
FUSION_WEIGHTS_VERSION = 1

# D3 裁决：等权起步，显式登记为「未调优」。
# 三源等权 = 1/3；缺失源的权重在运行期按剩余源重新归一（见 normalize_weights）。
FUSION_WEIGHTS: dict[str, float] = {
    "transcript": 1.0 / 3.0,
    "cv": 1.0 / 3.0,
    "beat": 1.0 / 3.0,
}

# 节拍落拍判定容差：切点距最近 beat 在 ±该值内算「落拍」。
BEAT_HIT_TOLERANCE_US = 120_000


def normalize_weights(present: Iterable[str]) -> dict[str, float]:
    """按**实际在场的源**重新归一权重。

    为什么不是缺失源补 0：补 0 会让「只有 1 源」的候选被系统性压低，
    与「3 源都有但都一般」的候选不可比（门 §3.2）。
    """
    keys = [k for k in present if k in FUSION_WEIGHTS]
    total = sum(FUSION_WEIGHTS[k] for k in keys)
    if total <= 0:
        return {}
    return {k: FUSION_WEIGHTS[k] / total for k in keys}


def minmax_normalize(values: Sequence[float]) -> list[float]:
    """在**本次候选集内**做 min-max 归一。

    必须集内归一：跨项目/跨批次归一化会产出不可比分数
    （与 W3.1 `cosine_rank` 的跨素材不可比教训同源，门 §3.1）。
    全相等时统一返回 0.5（避免除零，且不虚构区分度）。
    """
    if not values:
        return []
    # 单元素：min-max 无区分度可言，返回 0.5 会把「唯一的满分候选」
    # 压成半分（实测暴露：单候选满分被缩成 0.5）。单元素保持原值。
    if len(values) == 1:
        return [1.0]
    lo = min(values)
    hi = max(values)
    if hi - lo <= 1e-12:
        return [0.5 for _ in values]
    return [(v - lo) / (hi - lo) for v in values]


def beat_hit_score(start_us: int, beats_us: Sequence[int], tolerance_us: int = BEAT_HIT_TOLERANCE_US) -> float:
    """切点是否落在拍上：1.0 = 落拍，0.0 = 不落拍。

    beats 为空（无节拍网格）时返回 0.0——但调用方**不应把它当成源存在**，
    源是否存在由调用方按 `beats_us` 非空判定，二者不可混淆。
    """
    if not beats_us:
        return 0.0
    nearest = min(abs(int(start_us) - int(b)) for b in beats_us)
    return 1.0 if nearest <= tolerance_us else 0.0


def fuse_scores(
    candidates: Sequence[Mapping[str, Any]],
    sources: Sequence[str],
) -> list[dict[str, Any]]:
    """多源融合排序。

    `candidates` 每项须含：
      - `key`: 唯一标识
      - `parts`: {源名: 原始分项分 dict}，缺该源则不出现该键
    返回按融合分降序的列表，每项附加 `score` 与 `contributions`（可追溯）。
    """
    if not candidates:
        return []
    present = [s for s in sources if any(s in c.get("parts", {}) for c in candidates)]
    weights = normalize_weights(present)
    if not weights:
        return []

    # 逐源在集内归一（CV 的 face/motion/sharpness 各自归一后平均）
    normalized: list[dict[str, dict[str, float]]] = [dict() for _ in candidates]

    if "transcript" in weights:
        raw = [float((c.get("parts", {}).get("transcript") or {}).get("match", 0.0)) for c in candidates]
        conf = [float((c.get("parts", {}).get("transcript") or {}).get("confidence", 0.0)) for c in candidates]
        nm, nc = minmax_normalize(raw), minmax_normalize(conf)
        for i in range(len(candidates)):
            if "transcript" in candidates[i].get("parts", {}):
                normalized[i]["transcript"] = {"score": 0.5 * nm[i] + 0.5 * nc[i]}

    if "cv" in weights:
        for field in ("face", "motion", "sharpness"):
            raw = [float(((c.get("parts", {}).get("cv") or {}).get("features") or {}).get(field, 0.0)) for c in candidates]
            nm = minmax_normalize(raw)
            for i in range(len(candidates)):
                if "cv" in candidates[i].get("parts", {}):
                    normalized[i].setdefault("cv", {}).setdefault(field, nm[i])
        for i in range(len(candidates)):
            if "cv" in normalized[i]:
                parts = normalized[i]["cv"]
                parts["score"] = sum(parts.get(f, 0.0) for f in ("face", "motion", "sharpness")) / 3.0

    if "beat" in weights:
        raw = [float((c.get("parts", {}).get("beat") or {}).get("hit", 0.0)) for c in candidates]
        for i in range(len(candidates)):
            if "beat" in candidates[i].get("parts", {}):
                normalized[i]["beat"] = {"score": raw[i]}

    out: list[dict[str, Any]] = []
    for i, c in enumerate(candidates):
        contrib = {}
        total = 0.0
        for src, w in weights.items():
            if src in normalized[i]:
                s = float(normalized[i][src].get("score", 0.0))
                contrib[src] = {"weight": w, "score": s, "weighted": w * s}
                total += w * s
        item = dict(c)
        item["score"] = total
        item["contributions"] = contrib
        out.append(item)

    out.sort(key=lambda x: (-x["score"], x.get("start_us", 0), str(x.get("key", ""))))
    return out
