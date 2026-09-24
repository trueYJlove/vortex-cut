"""W1.5 跳切/去停顿：静音检测 + remove_pauses 规划器（规划门 §2）。"""

from __future__ import annotations

from typing import Any

from ..projects import DomainError
from ..timeline import MIN_VIDEO_US
from .protocol import PlanResult, ToolDescription

DEFAULT_ENERGY_THRESHOLD = 0.05
DEFAULT_MIN_SILENCE_US = 400_000
DEFAULT_PAD_US = 50_000
MAX_PAD_US = 300_000


def detect_silence_intervals(
    samples: list[dict[str, Any]],
    *,
    energy_threshold: float = DEFAULT_ENERGY_THRESHOLD,
    min_silence_us: int = DEFAULT_MIN_SILENCE_US,
) -> list[tuple[int, int]]:
    """源时间静音区间 [start_us, end_us)。连续低能量为静音，右端取下一有声样本。"""
    ordered = sorted(
        (
            (int(s["timestamp_us"]), float(s["audio_energy"]))
            for s in samples
            if "timestamp_us" in s and "audio_energy" in s
        ),
        key=lambda item: item[0],
    )
    if not ordered:
        return []
    intervals: list[tuple[int, int]] = []
    run_start: int | None = None
    last_silent_ts = 0
    for ts, energy in ordered:
        silent = energy <= energy_threshold
        if silent:
            if run_start is None:
                run_start = ts
            last_silent_ts = ts
        elif run_start is not None:
            if ts - run_start >= min_silence_us:
                intervals.append((run_start, ts))
            run_start = None
    if run_start is not None:
        end = last_silent_ts + 1
        if end - run_start >= min_silence_us:
            intervals.append((run_start, end))
    return intervals


def compute_keep_intervals(
    silence: list[tuple[int, int]],
    *,
    start_us: int,
    end_us: int,
    pad_us: int,
) -> list[tuple[int, int]]:
    """静音补集 + pad 收缩 + 过短保留段合并。"""
    if start_us >= end_us:
        return []
    cuts = [
        (max(start_us, s + pad_us), min(end_us, e - pad_us))
        for s, e in sorted(silence)
        if e > s
    ]
    cuts = [(s, e) for s, e in cuts if e > s]
    keeps: list[tuple[int, int]] = []
    cursor = start_us
    for s, e in cuts:
        if s > cursor:
            keeps.append((cursor, s))
        cursor = max(cursor, e)
    if cursor < end_us:
        keeps.append((cursor, end_us))
    if not keeps:
        return []
    # 与邻段合并掉 < MIN_VIDEO_US 的碎片（吞掉中间已 pad 的静音）
    merged: list[tuple[int, int]] = [keeps[0]]
    for keep in keeps[1:]:
        prev = merged[-1]
        if (keep[1] - keep[0]) < MIN_VIDEO_US or (prev[1] - prev[0]) < MIN_VIDEO_US:
            merged[-1] = (prev[0], keep[1])
        else:
            merged.append(keep)
    if merged[-1][1] - merged[-1][0] < MIN_VIDEO_US and len(merged) > 1:
        merged[-2] = (merged[-2][0], merged[-1][1])
        merged.pop()
    return [(s, e) for s, e in merged if e - s >= MIN_VIDEO_US]


class RemovePausesPlanner:
    @property
    def tool(self) -> ToolDescription:
        return ToolDescription(
            name="remove_pauses",
            title="跳切 / 去停顿（E2）",
            description=(
                "确定性规划器：按音频能量检测静音，裁掉停顿并把同素材保留段"
                "连续拼接。无有效语音拒绝；不产生过短碎片。"
            ),
            parameters_schema={
                "type": "object",
                "additionalProperties": False,
                "required": ["clip_id"],
                "properties": {
                    "clip_id": {"type": "string"},
                    "min_silence_us": {
                        "type": "integer",
                        "minimum": MIN_VIDEO_US,
                        "maximum": 10_000_000,
                    },
                    "energy_threshold": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1,
                    },
                    "pad_us": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": MAX_PAD_US,
                    },
                    "silence_intervals_us": {
                        "type": "array",
                        "items": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "minItems": 2,
                            "maxItems": 2,
                        },
                    },
                },
            },
            preconditions=(
                "clip 为 video 且源区间有效",
                "signals.samples 或 params.silence_intervals_us 至少其一",
                "存在可检测语音（非全静音）",
            ),
        )

    def plan(
        self,
        document: dict[str, Any],
        params: dict[str, Any],
        signals: dict[str, Any] | None = None,
    ) -> PlanResult:
        allowed = {
            "clip_id",
            "min_silence_us",
            "energy_threshold",
            "pad_us",
            "silence_intervals_us",
        }
        if set(params) - allowed:
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "规划器参数不合法")
        clip_id = params.get("clip_id")
        if not isinstance(clip_id, str) or not clip_id:
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "clip_id 不合法")
        min_silence = params.get("min_silence_us", DEFAULT_MIN_SILENCE_US)
        threshold = params.get("energy_threshold", DEFAULT_ENERGY_THRESHOLD)
        pad_us = params.get("pad_us", DEFAULT_PAD_US)
        if (
            isinstance(min_silence, bool)
            or not isinstance(min_silence, int)
            or not MIN_VIDEO_US <= min_silence <= 10_000_000
        ):
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "min_silence_us 不合法")
        if (
            isinstance(threshold, bool)
            or not isinstance(threshold, (int, float))
            or not 0 <= float(threshold) <= 1
        ):
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "energy_threshold 不合法")
        if (
            isinstance(pad_us, bool)
            or not isinstance(pad_us, int)
            or not 0 <= pad_us <= MAX_PAD_US
        ):
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "pad_us 不合法")

        clip = next(
            (c for c in document.get("clips") or [] if c.get("clip_id") == clip_id),
            None,
        )
        if clip is None:
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "目标片段不存在")
        if clip.get("asset_kind") != "video":
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "只有视频片段可以去停顿")
        src_start = int(clip["source_start_us"])
        src_end = int(clip["source_end_us"])

        explicit = params.get("silence_intervals_us")
        if explicit is not None:
            silence = []
            for item in explicit:
                if (
                    not isinstance(item, (list, tuple))
                    or len(item) != 2
                    or int(item[1]) <= int(item[0])
                ):
                    raise DomainError(
                        "EDITING_GRAMMAR_PARAMS_INVALID", "silence_intervals_us 不合法"
                    )
                s, e = int(item[0]), int(item[1])
                if e - s >= min_silence:
                    silence.append((max(src_start, s), min(src_end, e)))
            silence = [(s, e) for s, e in silence if e > s]
        else:
            samples = (signals or {}).get("samples") or []
            energy_max = max(
                (float(s.get("audio_energy") or 0) for s in samples), default=0.0
            )
            if not samples or energy_max <= float(threshold):
                raise DomainError(
                    "EDITING_GRAMMAR_NO_SPEECH", "无有效语音信号，拒绝去停顿"
                )
            silence = detect_silence_intervals(
                samples,
                energy_threshold=float(threshold),
                min_silence_us=min_silence,
            )
            silence = [
                (max(src_start, s), min(src_end, e))
                for s, e in silence
                if min(src_end, e) > max(src_start, s)
            ]

        keeps = compute_keep_intervals(
            silence, start_us=src_start, end_us=src_end, pad_us=pad_us
        )
        if not keeps:
            raise DomainError("EDITING_GRAMMAR_NO_SPEECH", "无有效语音信号，拒绝去停顿")

        rules: list[dict[str, Any]] = []
        for s, e in silence:
            absorbed = any(ks <= s and e <= ke for ks, ke in keeps)
            rules.append(
                {
                    "rule": "silence_interval",
                    "start_us": s,
                    "end_us": e,
                    "duration_us": e - s,
                    "min_silence_us": min_silence,
                    "action": "absorbed_by_keep" if absorbed else "remove",
                }
            )

        full = len(keeps) == 1 and keeps[0][0] == src_start and keeps[0][1] == src_end
        params_rationale = {
            "clip_id": clip_id,
            "min_silence_us": min_silence,
            "energy_threshold": float(threshold),
            "pad_us": pad_us,
        }
        if full:
            return PlanResult(
                summary="无需去停顿（未检出有效静音区间）",
                operations=(),
                rationale={
                    "planner": "remove_pauses",
                    "params": params_rationale,
                    "rules": rules,
                    "keep_intervals_us": [list(k) for k in keeps],
                    "strategy": "noop",
                },
                noop=True,
            )

        # 策略：首保留段 trim 进原 clip 并钉回原 timeline_start；其余保留段
        # insert_asset_clip 同素材多段拼接（静音段不再插入 = 删除）。
        head = keeps[0]
        operations: list[dict[str, Any]] = [
            {
                "op": "trim_clip",
                "clip_id": clip_id,
                "source_start_us": head[0],
                "source_end_us": head[1],
            },
            {
                "op": "position_clip",
                "clip_id": clip_id,
                "timeline_start_us": int(clip["timeline_start_us"]),
            },
        ]
        for index, (ks, ke) in enumerate(keeps[1:], start=1):
            insert: dict[str, Any] = {
                "op": "insert_asset_clip",
                "asset_id": clip["asset_id"],
                "at_index": index,
                "source_start_us": ks,
                "source_end_us": ke,
                "layout": clip.get("layout", "blurred_background"),
                "track_id": clip.get("track_id", "V1"),
            }
            if clip.get("speed_milli") not in (None, 1000):
                insert["speed_milli"] = clip["speed_milli"]
            if clip.get("reverse_playback"):
                insert["reverse_playback"] = True
            operations.append(insert)

        return PlanResult(
            summary=f"去停顿：保留 {len(keeps)} 段，删除 {len([r for r in rules if r['action']=='remove'])} 段静音",
            operations=tuple(operations),
            rationale={
                "planner": "remove_pauses",
                "params": params_rationale,
                "rules": rules,
                "keep_intervals_us": [list(k) for k in keeps],
                "silence_intervals_us": [list(s) for s in silence],
                "strategy": "trim_head_keep_and_insert_rest",
            },
            noop=False,
        )
