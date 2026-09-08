from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import pytest

from aivs_core import performance


def test_disabled_decorator_preserves_function(monkeypatch):
    monkeypatch.setattr(performance, "ENABLED", False)

    def work():
        return 42

    assert performance.measured("test")(work) is work


@pytest.mark.asyncio
async def test_records_sync_async_failure_and_bounds(monkeypatch):
    monkeypatch.setattr(performance, "ENABLED", True)
    performance._events.clear()
    performance._counts.clear()

    @performance.measured("test")
    async def work():
        await asyncio.sleep(0)
        raise ValueError("not logged")

    with pytest.raises(ValueError):
        await work()
    for _ in range(5000):
        performance.record("test", 1)
    assert len(performance._events) == 4096
    assert performance._counts["test"] == 5001
    assert set(performance._events[0]) == {"stage", "duration_ms"}
    performance._events.clear()
    performance._counts.clear()


def test_comparison_rejects_incompatible_evidence():
    path = Path(__file__).resolve().parents[4] / "tools/performance/compare_results.py"
    spec = importlib.util.spec_from_file_location("compare_results", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sample = {
        "run": 0,
        "enabled": True,
        "scenario": "F01",
        "environment": {},
        "viewport": {},
        "fixture_sha256": "x",
        "playback_seconds": 5,
        "seek": {"events": [], "enabled": True},
        "playback": {"events": [], "enabled": True},
    }
    assert "unavailable" in module.compare([sample], [sample])
    with pytest.raises(ValueError, match="Invalid evidence"):
        module.compare([sample], [dict(sample, playback={"enabled": False, "events": []})])
    with pytest.raises(ValueError, match="Incompatible"):
        module.compare([sample], [dict(sample, setup_recovery_count=1)])
    with pytest.raises(ValueError, match="Incompatible"):
        module.compare([sample], [dict(sample, fixture_sha256="other")])


def test_atomic_flush_and_io_failure(monkeypatch, tmp_path):
    import json

    monkeypatch.setattr(performance, "ENABLED", True)
    target = tmp_path / "core.json"
    monkeypatch.setenv("AIVS_PERF_OUTPUT", str(target))
    performance.flush()
    assert json.loads(target.read_text())["capacity"] == 4096
    assert not target.with_suffix(".json.tmp").exists()
    monkeypatch.setenv("AIVS_PERF_OUTPUT", str(tmp_path / "missing" / "core.json"))
    performance.flush()
