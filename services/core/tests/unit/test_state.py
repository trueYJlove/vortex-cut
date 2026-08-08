import pytest

from aivs_core.state import ensure_transition


def test_valid_and_invalid_job_transitions() -> None:
    ensure_transition("queued", "running")
    ensure_transition("running", "cancelling")
    with pytest.raises(ValueError):
        ensure_transition("succeeded", "running")
    with pytest.raises(ValueError):
        ensure_transition("queued", "succeeded")
