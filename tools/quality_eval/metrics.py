"""W0.4 质量评测指标（纯函数，零 egress，无第三方依赖）。

口径冻结于 `docs/specs/local-intelligence.md` §4.2：
改容差 / k / 公式必须改快照元数据并走门禁，禁止静默改口径救指标。
"""

from __future__ import annotations

import math
from typing import Any

SCHEMA_VERSION = 1
DEFAULT_CUT_TOLERANCE_US = 200_000
DEFAULT_NDCG_K = 10
DEFAULT_REGRESSION_TOLERANCE = 0.0

BUCKETS = (
    "spoken_single",
    "spoken_multi",
    "life_no_voice",
    "music",
    "long_gop",
)

# §11.1 最小样本；骨架只强制条数，时长/机位/BPM 等附加约束由 manifest 元数据声明。
MIN_SAMPLES = {
    "spoken_single": 5,
    "spoken_multi": 3,
    "life_no_voice": 5,
    "music": 3,
    "long_gop": 2,
}

# W0.4 可测 + Wave 1 落地后新增 beat_hit_rate / lj_offset_accuracy。
MEASURABLE_TASKS = ("cut_pr", "recall_ndcg", "beat_hit_rate", "lj_offset_accuracy")
UNAVAILABLE_TASKS = (
    "multicam_consistency",
    "narrative_coherence",
    "structure_usable_rate",
    "av_defect_rate",
)
DEFAULT_BEAT_TOLERANCE_US = 50_000
DEFAULT_LJ_AT_TOLERANCE_US = 200_000
DEFAULT_LJ_DELTA_TOLERANCE_US = 100_000


def lj_offset_accuracy(
    predicted: list[dict[str, Any]],
    labeled: list[dict[str, Any]],
    *,
    at_tol_us: int = DEFAULT_LJ_AT_TOLERANCE_US,
    delta_tol_us: int = DEFAULT_LJ_DELTA_TOLERANCE_US,
) -> dict[str, Any]:
    """L/J 偏移正确率：按 at_us 配对，方向一致且 |Δ| 在容差内记 hit。

    预测/标注项形状：`{at_us, direction: "L"|"J", delta_us}`。
    """

    def _norm(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            at = item.get("at_us")
            direction = item.get("direction")
            delta = item.get("delta_us")
            if not isinstance(at, int) or direction not in ("L", "J"):
                continue
            out.append(
                {
                    "at_us": int(at),
                    "direction": direction,
                    "delta_us": int(delta) if isinstance(delta, int) else 0,
                }
            )
        return sorted(out, key=lambda x: x["at_us"])

    preds = _norm(predicted)
    labels = _norm(labeled)
    if not labels:
        return {
            "accuracy": 0.0,
            "hit": 0,
            "label_count": 0,
            "pred_count": len(preds),
            "at_tol_us": at_tol_us,
            "delta_tol_us": delta_tol_us,
        }
    used: set[int] = set()
    hit = 0
    details: list[dict[str, Any]] = []
    for lab in labels:
        best_i = None
        best_d = at_tol_us + 1
        for i, pred in enumerate(preds):
            if i in used:
                continue
            d = abs(pred["at_us"] - lab["at_us"])
            if d <= at_tol_us and d < best_d:
                best_i = i
                best_d = d
        if best_i is None:
            details.append({"at_us": lab["at_us"], "matched": False, "reason": "no_pred"})
            continue
        used.add(best_i)
        pred = preds[best_i]
        ok = (
            pred["direction"] == lab["direction"]
            and abs(pred["delta_us"] - lab["delta_us"]) <= delta_tol_us
        )
        if ok:
            hit += 1
        details.append(
            {
                "at_us": lab["at_us"],
                "matched": True,
                "hit": ok,
                "direction_ok": pred["direction"] == lab["direction"],
                "delta_us": pred["delta_us"],
                "label_delta_us": lab["delta_us"],
            }
        )
    return {
        "accuracy": hit / len(labels),
        "hit": hit,
        "label_count": len(labels),
        "pred_count": len(preds),
        "at_tol_us": at_tol_us,
        "delta_tol_us": delta_tol_us,
        "details": details,
    }


def beat_hit_rate(
    predicted_us: list[int],
    labeled_us: list[int],
    tol_us: int = DEFAULT_BEAT_TOLERANCE_US,
) -> dict[str, Any]:
    """标注 beat 被预测命中的比例（W1.2 误差门口径）。"""
    preds = sorted(int(x) for x in predicted_us)
    labels = sorted(int(x) for x in labeled_us)
    if not labels:
        return {
            "hit_rate": 0.0,
            "hit": 0,
            "label_count": 0,
            "pred_count": len(preds),
            "tol_us": tol_us,
        }
    hit = sum(
        1 for lab in labels if any(abs(p - lab) <= tol_us for p in preds)
    )
    return {
        "hit_rate": hit / len(labels),
        "hit": hit,
        "label_count": len(labels),
        "pred_count": len(preds),
        "tol_us": tol_us,
    }


def cut_precision_recall(
    predicted_us: list[int],
    labeled_us: list[int],
    tol_us: int = DEFAULT_CUT_TOLERANCE_US,
) -> dict[str, Any]:
    """一对一贪心匹配（时间序，最近未匹配标注），窗口 tol_us。"""
    preds = sorted(int(x) for x in predicted_us)
    labels = sorted(int(x) for x in labeled_us)
    used: set[int] = set()
    matched = 0
    for p in preds:
        best_i = None
        best_d = tol_us + 1
        for i, lab in enumerate(labels):
            if i in used:
                continue
            d = abs(p - lab)
            if d <= tol_us and d < best_d:
                best_i = i
                best_d = d
        if best_i is not None:
            matched += 1
            used.add(best_i)
    # 空集口径（冻结）：双空=完美；仅预测空=查全 0；仅标注空=查准 0。
    if not preds and not labels:
        precision = 1.0
        recall = 1.0
    elif not preds:
        precision = 0.0
        recall = 0.0
    elif not labels:
        precision = 0.0
        recall = 0.0
    else:
        precision = matched / len(preds)
        recall = matched / len(labels)
    f1 = (
        0.0
        if precision + recall == 0
        else 2 * precision * recall / (precision + recall)
    )
    return {
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "matched": matched,
        "pred_count": len(preds),
        "label_count": len(labels),
        "tol_us": tol_us,
    }


def ndcg_at_k(
    ranking: list[str],
    relevance: dict[str, int],
    k: int = DEFAULT_NDCG_K,
) -> dict[str, Any]:
    """线性折扣 DCG；rel 为 0–3。未列 ID 视为 0。"""
    if k <= 0:
        raise ValueError("k must be positive")
    ranked_rels = [int(relevance.get(item, 0)) for item in ranking[:k]]
    ideal = sorted((int(v) for v in relevance.values()), reverse=True)[:k]

    def dcg(rels: list[int]) -> float:
        return sum(rel / math.log2(i + 2) for i, rel in enumerate(rels))

    idcg = dcg(ideal)
    score = dcg(ranked_rels)
    if idcg == 0:
        value = 1.0 if score == 0 else 0.0
    else:
        value = score / idcg
    return {
        "ndcg": value,
        "dcg": score,
        "idcg": idcg,
        "k": k,
        "ranked_len": len(ranking),
    }


def mean_recall_ndcg(
    query_pairs: list[tuple[list[str], dict[str, int]]],
    k: int = DEFAULT_NDCG_K,
) -> dict[str, Any] | None:
    if not query_pairs:
        return None
    scores = [ndcg_at_k(ranking, rel, k)["ndcg"] for ranking, rel in query_pairs]
    return {
        "ndcg": sum(scores) / len(scores),
        "query_count": len(scores),
        "per_query": scores,
        "k": k,
    }


def validate_annotation(doc: dict[str, Any]) -> list[str]:
    """轻量结构校验（无 jsonschema 依赖）。返回错误列表，空 = 通过。"""
    errors: list[str] = []
    required = ("schema_version", "asset_id", "bucket", "annotator", "annotated_at")
    for key in required:
        if key not in doc:
            errors.append(f"missing required field: {key}")
    if "schema_version" in doc and (
        not isinstance(doc["schema_version"], int) or doc["schema_version"] < 1
    ):
        errors.append("schema_version must be int >= 1")
    if "bucket" in doc and doc["bucket"] not in BUCKETS:
        errors.append(f"bucket must be one of {BUCKETS}")
    cuts = doc.get("scene_cuts_us")
    if cuts is not None:
        if not isinstance(cuts, list) or any(
            not isinstance(x, int) or x < 0 for x in cuts
        ):
            errors.append("scene_cuts_us must be list of non-negative int")
    recall = doc.get("recall")
    if recall is not None:
        queries = recall.get("queries") if isinstance(recall, dict) else None
        if not isinstance(queries, list):
            errors.append("recall.queries must be a list")
        else:
            for q in queries:
                if not isinstance(q, dict) or "query_id" not in q or "relevance" not in q:
                    errors.append("recall query needs query_id + relevance")
                    continue
                rel = q["relevance"]
                if not isinstance(rel, dict) or any(
                    not isinstance(v, int) or v < 0 or v > 3 for v in rel.values()
                ):
                    errors.append("relevance values must be int in [0, 3]")
    return errors


def metric_status(
    *,
    available: bool,
    sample_count: int,
    min_samples: int,
    reason: str | None = None,
) -> str:
    if not available:
        return "unavailable"
    if sample_count < min_samples:
        return "insufficient"
    return "ok"
