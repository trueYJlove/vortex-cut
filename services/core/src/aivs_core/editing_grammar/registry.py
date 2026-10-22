"""规划器注册表 = 工具目录（总纲 §5.3-6，P-C/MCP 复用）。"""

from __future__ import annotations

from ..projects import DomainError
from .beat_sync import BeatSyncPlanner
from .lj_cut import LjCutPlanner
from .planners import DropShortClipsPlanner
from .protocol import Planner
from .silence import RemovePausesPlanner
from .unify_loudness import UnifyLoudnessPlanner


class PlannerRegistry:
    def __init__(self) -> None:
        self._planners: dict[str, Planner] = {}

    def register(self, planner: Planner) -> None:
        name = planner.tool.name
        if name in self._planners:
            raise ValueError(f"duplicate planner: {name}")
        self._planners[name] = planner

    def get(self, name: str) -> Planner:
        planner = self._planners.get(name)
        if planner is None:
            raise DomainError("EDITING_GRAMMAR_PLANNER_NOT_FOUND", "规划器不存在")
        return planner

    def list_tools(self) -> list[dict]:
        return [
            self._planners[name].tool.to_public() for name in sorted(self._planners)
        ]


def default_registry() -> PlannerRegistry:
    registry = PlannerRegistry()
    registry.register(DropShortClipsPlanner())
    registry.register(RemovePausesPlanner())
    registry.register(BeatSyncPlanner())
    registry.register(LjCutPlanner())
    registry.register(UnifyLoudnessPlanner())
    return registry
