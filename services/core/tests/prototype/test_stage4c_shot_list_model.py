from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
SPEC = importlib.util.spec_from_file_location(
    "stage4c_shot_list_model", ROOT / "tools" / "prototypes" / "stage4c_shot_list_model.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_stage4c_shot_list_model_prototype(tmp_path: Path) -> None:
    report = MODULE.run_prototype(tmp_path, iterations=20)
    assert report["provider_call_count"] == 0
    assert report["recommended_pointer_mode"] == "composite_fk"
    assert report["migration"] == {
        "frozen_versions_verified": 11,
        "composite_fk_passed": True,
        "trigger_pointer_passed": True,
        "rollback_and_backup": True,
    }
    assert all(report["pointer_modes"]["composite_fk"].values())
    assert all(report["pointer_modes"]["trigger"].values())
    assert all(report["constraints"].values())
    assert all(report["rollback"].values())
    assert report["performance_ms"]["create_revision_p95"] <= 300
