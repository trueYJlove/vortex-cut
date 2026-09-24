"""参考规划器：删除过短片段（骨架 e2e 用，非 W1.5 跳切）。"""

from __future__ import annotations

from typing import Any

from ..projects import DomainError
from ..timeline import MIN_VIDEO_US
from .protocol import PlanResult, ToolDescription


class DropShortClipsPlanner:
    @property
    def tool(self) -> ToolDescription:
        return ToolDescription(
            name="drop_short_clips",
            title="删除过短片段（参考实现）",
            description=(
                "确定性参考规划器：删除时间线时长小于 min_duration_us 的片段。"
                "用于打通剪辑语法层 e2e 与确定性断言；真实手法见 W1.3–W1.5。"
            ),
            parameters_schema={
                "type": "object",
                "additionalProperties": False,
                "required": ["min_duration_us"],
                "properties": {
                    "min_duration_us": {
                        "type": "integer",
                        "minimum": MIN_VIDEO_US,
                        "maximum": 30_000_000,
                    },
                    "track_id": {"type": "string"},
                },
            },
            preconditions=(
                "base_revision 存在且为当前时间线",
                "params.min_duration_us >= 100000",
            ),
        )

    def plan(
        self,
        document: dict[str, Any],
        params: dict[str, Any],
        signals: dict[str, Any] | None = None,
    ) -> PlanResult:
        if set(params) - {"min_duration_us", "track_id"}:
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "规划器参数不合法")
        min_duration = params.get("min_duration_us")
        if (
            isinstance(min_duration, bool)
            or not isinstance(min_duration, int)
            or not MIN_VIDEO_US <= min_duration <= 30_000_000
        ):
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "min_duration_us 不合法")
        track_id = params.get("track_id")
        if track_id is not None and (not isinstance(track_id, str) or not track_id):
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "track_id 不合法")

        rules: list[dict[str, Any]] = []
        to_remove: list[dict[str, Any]] = []
        for clip in document.get("clips") or []:
            duration = clip["timeline_end_us"] - clip["timeline_start_us"]
            in_scope = track_id is None or clip.get("track_id") == track_id
            dropped = in_scope and duration < min_duration
            rules.append(
                {
                    "clip_id": clip["clip_id"],
                    "duration_us": duration,
                    "min_duration_us": min_duration,
                    "track_id": clip.get("track_id"),
                    "in_scope": in_scope,
                    "action": "remove_clip" if dropped else "keep",
                }
            )
            if dropped:
                to_remove.append(clip)

        to_remove.sort(key=lambda clip: clip["clip_id"])
        operations = tuple(
            {"op": "remove_clip", "clip_id": clip["clip_id"]} for clip in to_remove
        )
        return PlanResult(
            summary=(
                f"删除 {len(operations)} 个过短片段（<{min_duration}us）"
                if operations
                else f"无需删除（最短阈值 {min_duration}us）"
            ),
            operations=operations,
            rationale={
                "planner": "drop_short_clips",
                "params": {
                    "min_duration_us": min_duration,
                    "track_id": track_id,
                },
                "rules": rules,
                "signals": [
                    {
                        "clip_id": clip["clip_id"],
                        "duration_us": clip["timeline_end_us"]
                        - clip["timeline_start_us"],
                    }
                    for clip in sorted(
                        document.get("clips") or [], key=lambda c: c["clip_id"]
                    )
                ],
            },
            noop=not operations,
        )
