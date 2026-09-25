"""W0.4 质量评测 harness 入口。零 egress；输出 evidence/quality_eval/ 快照。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from metrics import (  # noqa: E402
    DEFAULT_BEAT_TOLERANCE_US,
    DEFAULT_CUT_TOLERANCE_US,
    DEFAULT_LJ_AT_TOLERANCE_US,
    DEFAULT_LJ_DELTA_TOLERANCE_US,
    DEFAULT_NDCG_K,
    DEFAULT_REGRESSION_TOLERANCE,
    MIN_SAMPLES,
    SCHEMA_VERSION,
    UNAVAILABLE_TASKS,
    beat_hit_rate,
    cut_precision_recall,
    lj_offset_accuracy,
    mean_recall_ndcg,
    validate_annotation,
)


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _git_commit() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        return out.stdout.strip() or "unknown"
    except OSError:
        return "unknown"


def _empty_metric(status: str, reason: str) -> dict[str, Any]:
    return {"status": status, "reason": reason, "value": None}


def _ok_metric(value: float | dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {"status": "ok", "reason": None, "value": value, **extra}





def load_asset_annotations(eval_set: Path, manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    ann_dir = eval_set / "annotations"
    out: dict[str, dict[str, Any]] = {}
    for asset in manifest.get("assets", []):
        asset_id = asset["asset_id"]
        path = ann_dir / f"{asset_id}.json"
        if not path.exists():
            continue
        doc = _load_json(path)
        errors = validate_annotation(doc)
        if errors:
            out[asset_id] = {"__invalid__": errors}
            continue
        out[asset_id] = doc
    return out


def load_predictions(eval_set: Path, asset_id: str, task: str) -> Any:
    path = eval_set / "predictions" / asset_id / f"{task}.json"
    if not path.exists():
        return None
    return _load_json(path)


def run_selfcheck(tol_us: int, k: int) -> dict[str, Any]:
    """尺子自检：合成真值断言指标公式（规划门 §3.2）。"""
    checks: list[dict[str, Any]] = []

    def check(name: str, cond: bool, detail: Any) -> None:
        checks.append({"name": name, "ok": bool(cond), "detail": detail})

    perfect = cut_precision_recall([2_000_000, 5_000_000, 8_000_000], [2_000_000, 5_000_000, 8_000_000], tol_us)
    check("cut_perfect", perfect["precision"] == 1.0 and perfect["recall"] == 1.0, perfect)

    shifted = cut_precision_recall([2_000_000 + tol_us + 1], [2_000_000], tol_us)
    check(
        "cut_miss_beyond_tol",
        shifted["precision"] == 0.0 and shifted["recall"] == 0.0,
        shifted,
    )

    near = cut_precision_recall([2_000_000 + tol_us // 2], [2_000_000], tol_us)
    check("cut_hit_within_tol", near["precision"] == 1.0 and near["recall"] == 1.0, near)

    empty = cut_precision_recall([], [], tol_us)
    check("cut_empty_both", empty["precision"] == 1.0 and empty["recall"] == 1.0, empty)

    # 手算：rel a=3,b=2,c=1；排序 a,b,c → nDCG=1
    ideal = mean_recall_ndcg([(["a", "b", "c"], {"a": 3, "b": 2, "c": 1, "d": 0})], 10)
    check("ndcg_perfect", ideal is not None and abs(ideal["ndcg"] - 1.0) < 1e-12, ideal)

    # 反序 c,b,a → DCG = 1/log2(2)+2/log2(3)+3/log2(4)；IDCG = 3/log2(2)+2/log2(3)+1/log2(4)
    import math

    dcg = 1 / math.log2(2) + 2 / math.log2(3) + 3 / math.log2(4)
    idcg = 3 / math.log2(2) + 2 / math.log2(3) + 1 / math.log2(4)
    expected = dcg / idcg
    worst = mean_recall_ndcg([(["c", "b", "a"], {"a": 3, "b": 2, "c": 1, "d": 0})], 10)
    check(
        "ndcg_reversed_matches_hand_calc",
        worst is not None and abs(worst["ndcg"] - expected) < 1e-12,
        {"got": worst, "expected": expected},
    )

    return {
        "generated_at": _utc_now(),
        "kind": "selfcheck",
        "params": {"cut_tolerance_us": tol_us, "ndcg_k": k},
        "checks": checks,
        "ok": all(c["ok"] for c in checks),
    }


def run_eval(
    *,
    eval_set: Path,
    tol_us: int = DEFAULT_CUT_TOLERANCE_US,
    k: int = DEFAULT_NDCG_K,
    min_overrides: dict[str, int] | None = None,
) -> dict[str, Any]:
    manifest = _load_json(eval_set / "manifest.json")
    annotations = load_asset_annotations(eval_set, manifest)
    min_samples = dict(MIN_SAMPLES)
    if min_overrides:
        min_samples.update(min_overrides)
    # manifest buckets 可覆盖默认 min_samples
    for name, meta in (manifest.get("buckets") or {}).items():
        if isinstance(meta, dict) and "min_samples" in meta:
            min_samples[name] = int(meta["min_samples"])

    assets_out: list[dict[str, Any]] = []
    per_bucket_cut: dict[str, list[dict[str, Any]]] = {b: [] for b in min_samples}
    per_bucket_recall: dict[str, list[tuple[list[str], dict[str, int]]]] = {
        b: [] for b in min_samples
    }
    per_bucket_beat: dict[str, list[dict[str, Any]]] = {b: [] for b in min_samples}
    per_bucket_lj: dict[str, list[dict[str, Any]]] = {b: [] for b in min_samples}
    per_bucket_annotated: dict[str, int] = {b: 0 for b in min_samples}

    for asset in manifest.get("assets", []):
        asset_id = asset["asset_id"]
        bucket = asset.get("bucket", "life_no_voice")
        entry: dict[str, Any] = {
            "asset_id": asset_id,
            "bucket": bucket,
            "kind": asset.get("kind"),
            "density_status": None,
        }
        ann = annotations.get(asset_id)
        if ann is None:
            entry["annotation"] = "missing"
            assets_out.append(entry)
            continue
        if "__invalid__" in ann:
            entry["annotation"] = "invalid"
            entry["errors"] = ann["__invalid__"]
            assets_out.append(entry)
            continue
        entry["annotation"] = "ok"
        per_bucket_annotated[bucket] = per_bucket_annotated.get(bucket, 0) + 1

        cut_pred_doc = load_predictions(eval_set, asset_id, "scene_cut")
        if cut_pred_doc is not None and "scene_cuts_us" in ann:
            cuts = cut_pred_doc.get("cuts_us")
            density = cut_pred_doc.get("density_status")
            entry["density_status"] = density
            score = cut_precision_recall(
                cuts or [], list(ann.get("scene_cuts_us") or []), tol_us
            )
            score["density_status"] = density
            score["asset_id"] = asset_id
            per_bucket_cut.setdefault(bucket, []).append(score)
            entry["cut"] = score

        recall_pred = load_predictions(eval_set, asset_id, "recall")
        if recall_pred is not None and isinstance(ann.get("recall"), dict):
            pred_by_q = {
                q.get("query_id"): q.get("ranking") or []
                for q in (recall_pred.get("queries") or [])
            }
            for q in ann["recall"].get("queries") or []:
                ranking = pred_by_q.get(q.get("query_id"))
                if ranking is None:
                    continue
                per_bucket_recall.setdefault(bucket, []).append(
                    (ranking, q.get("relevance") or {})
                )

        beat_pred = load_predictions(eval_set, asset_id, "beat_grid")
        if beat_pred is not None and "beat_grid_us" in ann:
            score = beat_hit_rate(
                beat_pred.get("beats_us") or [],
                list(ann.get("beat_grid_us") or []),
                DEFAULT_BEAT_TOLERANCE_US,
            )
            score["asset_id"] = asset_id
            score["bpm"] = beat_pred.get("bpm")
            per_bucket_beat.setdefault(bucket, []).append(score)
            entry["beat"] = score

        lj_pred = load_predictions(eval_set, asset_id, "lj_cut")
        if lj_pred is not None and "lj_offsets" in ann:
            score = lj_offset_accuracy(
                lj_pred.get("items") or [],
                list(ann.get("lj_offsets") or []),
                at_tol_us=DEFAULT_LJ_AT_TOLERANCE_US,
                delta_tol_us=DEFAULT_LJ_DELTA_TOLERANCE_US,
            )
            score["asset_id"] = asset_id
            per_bucket_lj.setdefault(bucket, []).append(score)
            entry["lj"] = score

        assets_out.append(entry)

    buckets_out: dict[str, Any] = {}
    for bucket, min_n in sorted(min_samples.items()):
        cut_scores = per_bucket_cut.get(bucket) or []
        ann_n = per_bucket_annotated.get(bucket, 0)
        bucket_metrics: dict[str, Any] = {}

        if not any(a.get("annotation") == "ok" for a in assets_out if a.get("bucket") == bucket):
            # 分档无任何有效标注
            has_cut_label = False
        else:
            has_cut_label = any(
                "scene_cuts_us" in (annotations.get(a["asset_id"]) or {})
                and "__invalid__" not in (annotations.get(a["asset_id"]) or {})
                for a in assets_out
                if a.get("bucket") == bucket and a.get("annotation") == "ok"
            )
        has_cut_pred = any(
            load_predictions(eval_set, a["asset_id"], "scene_cut") is not None
            for a in assets_out
            if a.get("bucket") == bucket
        )
        if not has_cut_label:
            bucket_metrics["cut_pr"] = _empty_metric(
                "unavailable", "no scene_cuts_us labels in bucket"
            )
        elif not has_cut_pred or not cut_scores:
            bucket_metrics["cut_pr"] = _empty_metric(
                "unavailable", "no scene_cut predictions in bucket"
            )
        else:
            # 分档聚合：微平均
            tp = sum(s["matched"] for s in cut_scores)
            pred_n = sum(s["pred_count"] for s in cut_scores)
            lab_n = sum(s["label_count"] for s in cut_scores)
            precision = tp / pred_n if pred_n else 0.0
            recall = tp / lab_n if lab_n else 0.0
            f1 = (
                0.0
                if precision + recall == 0
                else 2 * precision * recall / (precision + recall)
            )
            value = {
                "precision": precision,
                "recall": recall,
                "f1": f1,
                "matched": tp,
                "pred_count": pred_n,
                "label_count": lab_n,
                "tol_us": tol_us,
                "assets": cut_scores,
            }
            if ann_n < min_n:
                bucket_metrics["cut_pr"] = {
                    "status": "insufficient",
                    "reason": f"annotated_assets {ann_n} < min_samples {min_n}",
                    "value": value,
                    "pool_size": ann_n,
                }
            else:
                bucket_metrics["cut_pr"] = _ok_metric(value, pool_size=ann_n)

        pairs = per_bucket_recall.get(bucket) or []
        has_recall_label = any(
            isinstance((annotations.get(a["asset_id"]) or {}).get("recall"), dict)
            for a in assets_out
            if a.get("bucket") == bucket and a.get("annotation") == "ok"
        )
        if not has_recall_label:
            bucket_metrics["recall_ndcg"] = _empty_metric(
                "unavailable", "no recall labels in bucket"
            )
        elif not pairs:
            bucket_metrics["recall_ndcg"] = _empty_metric(
                "unavailable", "no recall predictions in bucket"
            )
        else:
            agg = mean_recall_ndcg(pairs, k)
            if ann_n < min_n:
                bucket_metrics["recall_ndcg"] = {
                    "status": "insufficient",
                    "reason": f"annotated_assets {ann_n} < min_samples {min_n}",
                    "value": agg,
                    "pool_size": ann_n,
                }
            else:
                bucket_metrics["recall_ndcg"] = _ok_metric(agg, pool_size=ann_n)

        beat_scores = per_bucket_beat.get(bucket) or []
        has_beat_label = any(
            "beat_grid_us" in (annotations.get(a["asset_id"]) or {})
            and "__invalid__" not in (annotations.get(a["asset_id"]) or {})
            for a in assets_out
            if a.get("bucket") == bucket and a.get("annotation") == "ok"
        )
        has_beat_pred = any(
            load_predictions(eval_set, a["asset_id"], "beat_grid") is not None
            for a in assets_out
            if a.get("bucket") == bucket
        )
        if not has_beat_label:
            bucket_metrics["beat_hit_rate"] = _empty_metric(
                "unavailable", "no beat_grid_us labels in bucket"
            )
        elif not has_beat_pred or not beat_scores:
            bucket_metrics["beat_hit_rate"] = _empty_metric(
                "unavailable", "no beat_grid predictions in bucket"
            )
        else:
            hit = sum(s["hit"] for s in beat_scores)
            lab_n = sum(s["label_count"] for s in beat_scores)
            value = {
                "hit_rate": (hit / lab_n) if lab_n else 0.0,
                "hit": hit,
                "label_count": lab_n,
                "tol_us": DEFAULT_BEAT_TOLERANCE_US,
                "assets": beat_scores,
            }
            if ann_n < min_n:
                bucket_metrics["beat_hit_rate"] = {
                    "status": "insufficient",
                    "reason": f"annotated_assets {ann_n} < min_samples {min_n}",
                    "value": value,
                    "pool_size": ann_n,
                }
            else:
                bucket_metrics["beat_hit_rate"] = _ok_metric(value, pool_size=ann_n)

        lj_scores = per_bucket_lj.get(bucket) or []
        has_lj_label = any(
            "lj_offsets" in (annotations.get(a["asset_id"]) or {})
            and "__invalid__" not in (annotations.get(a["asset_id"]) or {})
            for a in assets_out
            if a.get("bucket") == bucket and a.get("annotation") == "ok"
        )
        has_lj_pred = any(
            load_predictions(eval_set, a["asset_id"], "lj_cut") is not None
            for a in assets_out
            if a.get("bucket") == bucket
        )
        if not has_lj_label:
            bucket_metrics["lj_offset_accuracy"] = _empty_metric(
                "unavailable", "no lj_offsets labels in bucket"
            )
        elif not has_lj_pred or not lj_scores:
            bucket_metrics["lj_offset_accuracy"] = _empty_metric(
                "unavailable", "no lj_cut predictions in bucket"
            )
        else:
            hit = sum(s["hit"] for s in lj_scores)
            lab_n = sum(s["label_count"] for s in lj_scores)
            value = {
                "accuracy": (hit / lab_n) if lab_n else 0.0,
                "hit": hit,
                "label_count": lab_n,
                "at_tol_us": DEFAULT_LJ_AT_TOLERANCE_US,
                "delta_tol_us": DEFAULT_LJ_DELTA_TOLERANCE_US,
                "assets": lj_scores,
            }
            if ann_n < min_n:
                bucket_metrics["lj_offset_accuracy"] = {
                    "status": "insufficient",
                    "reason": f"annotated_assets {ann_n} < min_samples {min_n}",
                    "value": value,
                    "pool_size": ann_n,
                }
            else:
                bucket_metrics["lj_offset_accuracy"] = _ok_metric(value, pool_size=ann_n)

        for task in UNAVAILABLE_TASKS:
            bucket_metrics[task] = _empty_metric(
                "unavailable", "capability not delivered yet (W0.4 skeleton)"
            )

        buckets_out[bucket] = {
            "min_samples": min_n,
            "annotated_count": ann_n,
            "asset_count": sum(1 for a in assets_out if a.get("bucket") == bucket),
            "metrics": bucket_metrics,
        }

    # 缺口表：W0.4 交付物之一
    gaps = {
        b: {
            "min_samples": buckets_out[b]["min_samples"],
            "annotated_count": buckets_out[b]["annotated_count"],
            "shortfall": max(
                0, buckets_out[b]["min_samples"] - buckets_out[b]["annotated_count"]
            ),
        }
        for b in buckets_out
    }

    return {
        "generated_at": _utc_now(),
        "kind": "baseline",
        "schema_version": SCHEMA_VERSION,
        "git_commit": _git_commit(),
        "algorithm_version": 3,
        "params": {
            "cut_tolerance_us": tol_us,
            "ndcg_k": k,
            "regression_tolerance": DEFAULT_REGRESSION_TOLERANCE,
        },
        "buckets": buckets_out,
        "gaps": gaps,
        "assets": assets_out,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="W0.4 质量评测 harness")
    parser.add_argument(
        "--eval-set",
        type=Path,
        default=ROOT / "eval_set",
    )
    parser.add_argument("--selfcheck", action="store_true")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--cut-tolerance-us", type=int, default=DEFAULT_CUT_TOLERANCE_US)
    parser.add_argument("--ndcg-k", type=int, default=DEFAULT_NDCG_K)
    args = parser.parse_args(argv)

    if args.selfcheck:
        report = run_selfcheck(args.cut_tolerance_us, args.ndcg_k)
    else:
        report = run_eval(
            eval_set=args.eval_set,
            tol_us=args.cut_tolerance_us,
            k=args.ndcg_k,
        )

    out = args.out
    if out is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        kind = report.get("kind", "report")
        out_dir = ROOT / "evidence" / "quality_eval"
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / f"{stamp}-{kind}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": report.get("ok", True), "out": str(out), "kind": report.get("kind")}, ensure_ascii=False))
    if args.selfcheck and not report.get("ok"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
