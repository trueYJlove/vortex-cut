"""W0.4 质量评测——指标与 harness 单测（规划门 §3.2）。"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
QE = ROOT / "tools" / "quality_eval"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


metrics = _load("quality_eval_metrics", QE / "metrics.py")
run_mod = _load("quality_eval_run", QE / "run_quality_eval.py")
cmp_mod = _load("quality_eval_compare", QE / "compare_baselines.py")


class TestCutPR:
    def test_perfect_match(self):
        r = metrics.cut_precision_recall([2_000_000, 5_000_000], [2_000_000, 5_000_000], 200_000)
        assert r["precision"] == 1.0 and r["recall"] == 1.0

    def test_miss_outside_tolerance(self):
        r = metrics.cut_precision_recall([2_200_001], [2_000_000], 200_000)
        assert r["precision"] == 0.0 and r["recall"] == 0.0

    def test_hit_inside_tolerance(self):
        r = metrics.cut_precision_recall([2_100_000], [2_000_000], 200_000)
        assert r["precision"] == 1.0 and r["recall"] == 1.0

    def test_one_to_one_not_double_count(self):
        r = metrics.cut_precision_recall([1_000_000], [1_000_000, 1_050_000], 200_000)
        assert r["matched"] == 1 and r["recall"] == 0.5

    def test_empty_both(self):
        r = metrics.cut_precision_recall([], [], 200_000)
        assert r["precision"] == 1.0 and r["recall"] == 1.0


class TestBeatHitRate:
    def test_perfect(self):
        r = metrics.beat_hit_rate([0, 500_000, 1_000_000], [0, 500_000, 1_000_000], 50_000)
        assert r["hit_rate"] == 1.0 and r["hit"] == 3

    def test_partial(self):
        r = metrics.beat_hit_rate([0, 510_000], [0, 500_000, 1_000_000], 50_000)
        assert r["hit"] == 2 and r["hit_rate"] == pytest.approx(2 / 3)

    def test_empty_labels(self):
        r = metrics.beat_hit_rate([0], [], 50_000)
        assert r["hit_rate"] == 0.0 and r["label_count"] == 0

    def test_measurable_task_registered(self):
        assert "beat_hit_rate" in metrics.MEASURABLE_TASKS
        assert "beat_hit_rate" not in metrics.UNAVAILABLE_TASKS


class TestNDCG:
    def test_perfect_ranking(self):
        r = metrics.ndcg_at_k(["a", "b", "c"], {"a": 3, "b": 2, "c": 1, "d": 0}, 10)
        assert r["ndcg"] == pytest.approx(1.0)

    def test_reversed_hand_calc(self):
        import math

        r = metrics.ndcg_at_k(["c", "b", "a"], {"a": 3, "b": 2, "c": 1, "d": 0}, 10)
        dcg = 1 / math.log2(2) + 2 / math.log2(3) + 3 / math.log2(4)
        idcg = 3 / math.log2(2) + 2 / math.log2(3) + 1 / math.log2(4)
        assert r["ndcg"] == pytest.approx(dcg / idcg)

    def test_k_limits_length(self):
        r = metrics.ndcg_at_k(["a", "x"], {"a": 3, "b": 2}, 1)
        assert r["ndcg"] == pytest.approx(1.0)


class TestValidate:
    def test_valid_annotation(self):
        errors = metrics.validate_annotation(
            {
                "schema_version": 1,
                "asset_id": "x",
                "bucket": "music",
                "annotator": "a",
                "annotated_at": "2026-09-24T00:00:00Z",
                "scene_cuts_us": [1, 2],
            }
        )
        assert errors == []

    def test_bad_bucket(self):
        errors = metrics.validate_annotation(
            {
                "schema_version": 1,
                "asset_id": "x",
                "bucket": "nope",
                "annotator": "a",
                "annotated_at": "t",
            }
        )
        assert errors


class TestSelfcheck:
    def test_selfcheck_all_pass(self):
        report = run_mod.run_selfcheck(metrics.DEFAULT_CUT_TOLERANCE_US, metrics.DEFAULT_NDCG_K)
        assert report["ok"], report


class TestHarnessEval:
    def test_repo_eval_set_runs(self):
        report = run_mod.run_eval(eval_set=ROOT / "eval_set")
        assert report["kind"] == "baseline"
        assert "gaps" in report and "buckets" in report
        assert "cut_pr" in report["buckets"]["life_no_voice"]["metrics"]

    def test_insufficient_not_fake_score(self, tmp_path):
        eval_set = tmp_path / "eval_set"
        (eval_set / "annotations").mkdir(parents=True)
        (eval_set / "predictions" / "a1").mkdir(parents=True)
        (eval_set / "manifest.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "buckets": {"music": {"min_samples": 3}},
                    "assets": [
                        {
                            "asset_id": "a1",
                            "bucket": "music",
                            "kind": "synthetic_metric_fixture",
                            "media": None,
                            "source_fingerprint": "sha256:a1",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        (eval_set / "annotations" / "a1.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "asset_id": "a1",
                    "bucket": "music",
                    "annotator": "t",
                    "annotated_at": "t",
                    "scene_cuts_us": [1000],
                }
            ),
            encoding="utf-8",
        )
        (eval_set / "predictions" / "a1" / "scene_cut.json").write_text(
            json.dumps({"task": "scene_cut", "cuts_us": [1000], "density_status": "full"}),
            encoding="utf-8",
        )
        report = run_mod.run_eval(eval_set=eval_set)
        cut = report["buckets"]["music"]["metrics"]["cut_pr"]
        assert cut["status"] == "insufficient"
        assert cut["value"] is not None  # 有分数但状态诚实
        assert report["gaps"]["music"]["shortfall"] == 2


class TestCompare:
    def test_regression_detected(self):
        base = {
            "params": {"regression_tolerance": 0.0},
            "buckets": {
                "music": {
                    "metrics": {
                        "cut_pr": {"status": "ok", "value": {"f1": 0.8}},
                        "recall_ndcg": {"status": "unavailable", "value": None},
                    }
                }
            },
        }
        cand = {
            "params": {"regression_tolerance": 0.0},
            "buckets": {
                "music": {
                    "metrics": {
                        "cut_pr": {"status": "ok", "value": {"f1": 0.6}},
                        "recall_ndcg": {"status": "unavailable", "value": None},
                    }
                }
            },
        }
        result = cmp_mod.compare(base, cand)
        assert not result["ok"]
        assert result["regressions"] and result["regressions"][0]["metric"] == "music.cut_pr.f1"

    def test_no_regression_ok(self):
        base = {
            "params": {"regression_tolerance": 0.0},
            "buckets": {"music": {"metrics": {"cut_pr": {"status": "ok", "value": {"f1": 0.8}}}}},
        }
        cand = {
            "params": {"regression_tolerance": 0.0},
            "buckets": {"music": {"metrics": {"cut_pr": {"status": "ok", "value": {"f1": 0.9}}}}},
        }
        assert cmp_mod.compare(base, cand)["ok"]
