"""W1.1 剪辑语法层：确定性规划器协议与结果形状（总纲 §5.3）。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass(frozen=True)
class ToolDescription:
    name: str
    title: str
    description: str
    parameters_schema: dict[str, Any]
    preconditions: tuple[str, ...]

    def to_public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "parameters_schema": self.parameters_schema,
            "preconditions": list(self.preconditions),
        }


@dataclass(frozen=True)
class PlanResult:
    summary: str
    operations: tuple[dict[str, Any], ...]
    rationale: dict[str, Any] = field(default_factory=dict)
    noop: bool = False

    def patch_document(self) -> dict[str, Any]:
        return {
            "summary": self.summary,
            "operations": [dict(op) for op in self.operations],
        }


@runtime_checkable
class Planner(Protocol):
    @property
    def tool(self) -> ToolDescription: ...

    def plan(
        self,
        document: dict[str, Any],
        params: dict[str, Any],
        signals: dict[str, Any] | None = None,
    ) -> PlanResult: ...
