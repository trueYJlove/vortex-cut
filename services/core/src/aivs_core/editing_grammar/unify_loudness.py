"""E8 响度归一（unify_loudness）：每片段 set_audio 增益，实测驱动、可复算。

与 remove_pauses 同型：**纯函数**——实测由 signals 注入（`_signals_for` 用
LoudnessProbe 现测），本模块只做判定，不碰 ffmpeg、不落库。

增益语义（关键，决定幂等性）。测量跑在**源**上、不带 `volume`，所以
`integrated_lufs` 是 0dB 时的响度；渲染链对片段应用 `volume=gain_db dB`
（rendering/ffmpeg.py），两者相加才是听众听到的响度：

- 生效响度  effective = measured + current_gain_db
- 已达标    |target - effective| <= tolerance 时，不产 op
- 所需增益  new_gain = target - measured（**绝对值**，与 current_gain 无关）

因为 new_gain 只依赖 (target, measured)，重复规划得到同一个值——幂等。
若改成 `current_gain + (target - measured)`，每次重跑就会再叠加一次
(target - measured)，那是 bug。

cap 命中（new_gain 超出契约 -60..12dB）时**不产 op**，只在 rationale 里点名：
产一个被钳到 12dB 的 op 会让文档「看起来改过了」，实际离目标差着几十 dB，
正是本任务禁止的「写死钳到 +12 后假装成功」。
"""
from __future__ import annotations

from typing import Any

from ..projects import DomainError
from .protocol import PlanResult, ToolDescription

DEFAULT_TARGET_LUFS = -16.0
DEFAULT_TOLERANCE_LUFS = 0.5
# 契约硬边界（contracts/index.ts:2168 与 timeline.py set_audio 双重校验）。
MIN_GAIN_DB = -60.0
MAX_GAIN_DB = 12.0
AUDIO_CAPABLE_KINDS = ("video", "audio")

_ALGORITHM_VERSION_FALLBACK = "ebu-r128-ebur128-v1"


def scope_clips(
    document: dict[str, Any], params: dict[str, Any]
) -> list[dict[str, Any]]:
    """参与片段：显式 clip_ids 优先，缺省 = 全部有音轨潜力的片段（视频/音频）。

    图片片段恒无音轨，直接不进入范围（不产 op、不占测量时间）。
    """
    clips = list(document.get("clips") or [])
    explicit = params.get("clip_ids")
    if explicit is not None:
        if not isinstance(explicit, list) or not explicit:
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "clip_ids 不合法")
        by_id = {str(c.get("clip_id")): c for c in clips}
        picked: list[dict[str, Any]] = []
        for clip_id in explicit:
            if not isinstance(clip_id, str) or not clip_id:
                raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "clip_ids 不合法")
            clip = by_id.get(clip_id)
            if clip is None:
                raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "目标片段不存在")
            picked.append(clip)
        return picked
    return [c for c in clips if c.get("asset_kind") in AUDIO_CAPABLE_KINDS]


def _read_target(params: dict[str, Any]) -> float:
    value = params.get("target_lufs", DEFAULT_TARGET_LUFS)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "target_lufs 不合法")
    if not -40.0 <= float(value) <= 0.0:
        raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "target_lufs 不合法")
    return float(value)


def _read_tolerance(params: dict[str, Any]) -> float:
    value = params.get("tolerance_lufs", DEFAULT_TOLERANCE_LUFS)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "tolerance_lufs 不合法")
    if not 0.05 <= float(value) <= 6.0:
        raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "tolerance_lufs 不合法")
    return float(value)


def _measurements(signals: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    items = ((signals or {}).get("loudness") or {}).get("items") or []
    return {
        str(item.get("clip_id")): item
        for item in items
        if isinstance(item, dict) and item.get("clip_id")
    }


def _measured_or_none(record: dict[str, Any] | None) -> float | None:
    """只有 status='measured' 的才有资格当数字用（其余一律 None，绝不当 0）。"""
    if not record or record.get("status") != "measured":
        return None
    value = record.get("integrated_lufs")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


class UnifyLoudnessPlanner:
    @property
    def tool(self) -> ToolDescription:
        return ToolDescription(
            name="unify_loudness",
            title="响度归一 / 一键统一音量（E8）",
            description=(
                "确定性规划器：按 EBU R128 实测每片段 integrated loudness，"
                "算出各自的 set_audio 增益使响度对齐目标值。已达标片段不产 op；"
                "增益超出契约 -60..12dB 的片段如实标注为无法达标且不产误导性 op。"
            ),
            parameters_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "target_lufs": {
                        "type": "number",
                        "minimum": -40,
                        "maximum": 0,
                    },
                    "tolerance_lufs": {
                        "type": "number",
                        "minimum": 0.05,
                        "maximum": 6,
                    },
                    "clip_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                    },
                },
            },
            preconditions=(
                "参与片段至少其一有可测音轨",
                "signals.loudness 为随包 ffmpeg 的 EBU R128 实测结果",
            ),
        )

    def plan(
        self,
        document: dict[str, Any],
        params: dict[str, Any],
        signals: dict[str, Any] | None = None,
    ) -> PlanResult:
        allowed = {"target_lufs", "tolerance_lufs", "clip_ids"}
        if set(params) - allowed:
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "规划器参数不合法")
        target = _read_target(params)
        tolerance = _read_tolerance(params)
        clips = scope_clips(document, params)
        measured = _measurements(signals)
        algorithm_version = str(
            ((signals or {}).get("loudness") or {}).get("algorithm_version")
            or _ALGORITHM_VERSION_FALLBACK
        )

        operations: list[dict[str, Any]] = []
        decisions: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        unchanged: list[dict[str, Any]] = []
        unreachable: list[dict[str, Any]] = []

        for clip in clips:
            clip_id = str(clip.get("clip_id"))
            record = measured.get(clip_id)
            loudness = _measured_or_none(record)
            if loudness is None:
                reason = (
                    record.get("reason") if record else "LOUDNESS_NOT_MEASURED"
                ) or "LOUDNESS_NOT_MEASURED"
                status = (record or {}).get("status") or "unmeasured"
                entry = {
                    "clip_id": clip_id,
                    "status": status,
                    "reason": reason,
                    "measured_lufs": None,
                }
                skipped.append(entry)
                decisions.append({**entry, "decision": "skip"})
                continue

            audio = clip.get("audio") or {}
            if audio.get("enabled") is False:
                # 用户已明确关掉该片段音频：改它的 gain 不会改变任何听感，
                # 只会让 Diff 里多一条看不见效果的改动 ⇒ 跳过并点名。
                entry = {
                    "clip_id": clip_id,
                    "status": "skipped",
                    "reason": "AUDIO_DISABLED",
                    "measured_lufs": round(loudness, 3),
                }
                skipped.append(entry)
                decisions.append({**entry, "decision": "skip"})
                continue
            current_gain = audio.get("gain_db", 0.0)
            if isinstance(current_gain, bool) or not isinstance(current_gain, (int, float)):
                current_gain = 0.0
            current_gain = float(current_gain)
            # 生效响度 = 源实测 + 已在文档里的增益（渲染链的 volume 叠加）。
            effective = loudness + current_gain
            delta = target - loudness
            base = {
                "clip_id": clip_id,
                "measured_lufs": round(loudness, 3),
                "current_gain_db": round(current_gain, 3),
                "effective_lufs": round(effective, 3),
                "delta_db": round(delta, 3),
            }
            if abs(target - effective) <= tolerance:
                entry = {**base, "decision": "noop_within_tolerance"}
                unchanged.append(entry)
                decisions.append(entry)
                continue

            new_gain = round(delta, 2)
            # 契约边界：留 0.01 余量给四舍五入，避免刚压线的值被下游判非法。
            if new_gain > MAX_GAIN_DB + 0.01 or new_gain < MIN_GAIN_DB - 0.01:
                entry = {
                    **base,
                    "needed_gain_db": round(delta, 2),
                    "decision": "unreachable_cap",
                    "cap_min_db": MIN_GAIN_DB,
                    "cap_max_db": MAX_GAIN_DB,
                    "shortfall_db": round(
                        max(0.0, new_gain - MAX_GAIN_DB) + max(0.0, MIN_GAIN_DB - new_gain),
                        2,
                    ),
                }
                unreachable.append(entry)
                decisions.append(entry)
                continue

            operations.append(
                {
                    "op": "set_audio",
                    "clip_id": clip_id,
                    "enabled": bool(audio.get("enabled", True)),
                    "gain_db": new_gain,
                }
            )
            entry = {**base, "new_gain_db": new_gain, "decision": "adjust"}
            decisions.append(entry)

        noop = not operations
        params_rationale = {
            "target_lufs": target,
            "tolerance_lufs": tolerance,
            "gain_bounds_db": [MIN_GAIN_DB, MAX_GAIN_DB],
        }
        rationale = {
            "planner": "unify_loudness",
            "params": params_rationale,
            "algorithm_version": algorithm_version,
            "measurement": "ebur128 integrated loudness (EBU R128 / ITU-R BS.1770-4)",
            "clips": decisions,
            "unreachable": [item["clip_id"] for item in unreachable],
            "skipped": [item["clip_id"] for item in skipped],
            "unchanged": [item["clip_id"] for item in unchanged],
            "strategy": "per_clip_set_audio_gain",
        }
        return PlanResult(
            summary=_summary(target, operations, unreachable, skipped, unchanged),
            operations=tuple(operations),
            rationale=rationale,
            noop=noop,
        )


def _summary(
    target: float,
    operations: list[dict[str, Any]],
    unreachable: list[dict[str, Any]],
    skipped: list[dict[str, Any]],
    unchanged: list[dict[str, Any]],
) -> str:
    parts: list[str] = []
    if operations:
        parts.append(f"{len(operations)} 段调整到 {target:g} LUFS")
    if unchanged:
        parts.append(f"{len(unchanged)} 段已达标")
    if skipped:
        parts.append(f"{len(skipped)} 段无法测量已跳过")
    if unreachable:
        names = "、".join(item["clip_id"] for item in unreachable)
        parts.append(
            f"{len(unreachable)} 段所需增益超出 -60..12dB 上限、无法达标：{names}"
        )
    if not parts:
        return "无可参与片段（没有视频/音频片段）"
    return "响度归一：" + "；".join(parts)
