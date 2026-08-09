from __future__ import annotations

STATUS = {"queued", "running", "succeeded", "failed", "cancelling", "cancelled", "interrupted"}
TRANSITIONS: dict[str, set[str]] = {
    "queued": {"running", "cancelled"},
    "running": {"succeeded", "failed", "cancelling", "interrupted"},
    "cancelling": {"cancelled", "interrupted"},
    "succeeded": set(),
    "failed": set(),
    "cancelled": set(),
    "interrupted": set(),
}


def ensure_transition(current: str, target: str) -> None:
    if current not in STATUS or target not in STATUS or target not in TRANSITIONS[current]:
        raise ValueError(f"非法任务状态转换: {current}->{target}")


def transition_sql(current: str, target: str) -> str:
    ensure_transition(current, target)
    return target
