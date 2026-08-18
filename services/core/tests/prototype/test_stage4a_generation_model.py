from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
PROTOTYPE = ROOT / "tools" / "prototypes" / "stage4a_generation_model.py"
SPEC = importlib.util.spec_from_file_location("stage4a_generation_model", PROTOTYPE)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
run_prototype = MODULE.run_prototype


def test_stage4a_generation_model_prototype(tmp_path: Path) -> None:
    report = run_prototype(tmp_path, iterations=50)

    assert report["provider_call_count"] == 0
    assert report["validation"]["accuracy_percent"] == 100.0
    assert report["migration"] == {
        "frozen_versions_verified": 10,
        "production_v11_present": True,
        "required_tables_present": True,
        "required_indexes_present": True,
        "immutable_request_update": True,
        "immutable_request_delete": True,
    }
    assert all(report["lifecycle"].values())
    assert all(report["security"].values())
    assert report["performance_ms"]["prepare_p95"] <= 300
    assert report["performance_ms"]["create_p95"] <= 300
