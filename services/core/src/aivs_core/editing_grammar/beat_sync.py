"""W1.3 卡点规划器 beat_sync：镜头吸附 beat 网格，强拍放重镜头。"""

from __future__ import annotations

from typing import Any

from ..projects import DomainError
from ..timeline import MIN_VIDEO_US
from .protocol import PlanResult, ToolDescription

# 冻结权重（规划门 §2.1 / §5.1）：face > motion > sharpness
W_FACE = 3.0
W_MOTION = 2.0
W_SHARPNESS = 1.0
DEFAULT_BEATS_PER_SHOT = 2


def segment_score(features: dict[str, Any]) -> float:
    face = float(features.get("face") or 0)
    motion = float(features.get("motion") or 0)
    sharpness = float(features.get("sharpness") or 0)
    return (
        W_FACE * min(face, 3.0)
        + W_MOTION * min(max(motion, 0.0), 1.0)
        + W_SHARPNESS * min(max(sharpness, 0.0), 1.0)
    )


def _require_beats(beats: list[int]) -> list[int]:
    cleaned = sorted({int(b) for b in beats if int(b) >= 0})
    if len(cleaned) < 2:
        raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "beat 网格点不足")
    return cleaned


class BeatSyncPlanner:
    @property
    def tool(self) -> ToolDescription:
        return ToolDescription(
            name="beat_sync",
            title="卡点剪辑（E4）",
            description=(
                "音乐驱动确定性规划器：镜头时长 = beat 间隔 × N，切点吸附 beat 网格，"
                "强拍（downbeat）优先放置高运动/人脸/清晰度镜头。"
            ),
            parameters_schema={
                "type": "object",
                "additionalProperties": False,
                "required": ["target_duration_us", "segments"],
                "properties": {
                    "target_duration_us": {
                        "type": "integer",
                        "minimum": MIN_VIDEO_US,
                        "maximum": 600_000_000,
                    },
                    "beats_per_shot": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 16,
                    },
                    "bgm_asset_id": {"type": "string"},
                    "beats_us": {"type": "array", "items": {"type": "integer"}},
                    "downbeats_us": {"type": "array", "items": {"type": "integer"}},
                    "segments": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": [
                                "asset_id",
                                "source_start_us",
                                "source_end_us",
                            ],
                            "properties": {
                                "asset_id": {"type": "string"},
                                "source_start_us": {"type": "integer"},
                                "source_end_us": {"type": "integer"},
                                "face": {"type": "number"},
                                "motion": {"type": "number"},
                                "sharpness": {"type": "number"},
                                "layout": {"type": "string"},
                                "track_id": {"type": "string"},
                            },
                        },
                    },
                },
            },
            preconditions=(
                "beats_us ≥ 2（signals 或 params）",
                "segments 非空",
                "target_duration_us ≥ MIN_VIDEO_US",
            ),
        )

    def plan(
        self,
        document: dict[str, Any],
        params: dict[str, Any],
        signals: dict[str, Any] | None = None,
    ) -> PlanResult:
        allowed = {
            "target_duration_us",
            "beats_per_shot",
            "bgm_asset_id",
            "beats_us",
            "downbeats_us",
            "segments",
        }
        if set(params) - allowed:
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "规划器参数不合法")
        target_us = params.get("target_duration_us")
        if (
            isinstance(target_us, bool)
            or not isinstance(target_us, int)
            or not MIN_VIDEO_US <= target_us <= 600_000_000
        ):
            raise DomainError(
                "EDITING_GRAMMAR_PARAMS_INVALID", "target_duration_us 不合法"
            )
        n_beats = params.get("beats_per_shot", DEFAULT_BEATS_PER_SHOT)
        if (
            isinstance(n_beats, bool)
            or not isinstance(n_beats, int)
            or not 1 <= n_beats <= 16
        ):
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "beats_per_shot 不合法")
        raw_segments = params.get("segments")
        if not isinstance(raw_segments, list) or not raw_segments:
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "segments 不合法")

        beats_raw = params.get("beats_us") or (signals or {}).get("beats_us") or []
        down_raw = params.get("downbeats_us") or (signals or {}).get("downbeats_us") or []
        try:
            beats = _require_beats(list(beats_raw))
        except DomainError:
            raise
        downbeats = {int(x) for x in down_raw}

        segments: list[dict[str, Any]] = []
        for item in raw_segments:
            if not isinstance(item, dict):
                raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "segments 不合法")
            asset_id = item.get("asset_id")
            ss, se = item.get("source_start_us"), item.get("source_end_us")
            if (
                not isinstance(asset_id, str)
                or not asset_id
                or isinstance(ss, bool)
                or not isinstance(ss, int)
                or isinstance(se, bool)
                or not isinstance(se, int)
                or se <= ss
            ):
                raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "segments 不合法")
            features = {
                "face": item.get("face") or 0,
                "motion": item.get("motion") or 0,
                "sharpness": item.get("sharpness") or 0,
            }
            segments.append(
                {
                    "asset_id": asset_id,
                    "source_start_us": ss,
                    "source_end_us": se,
                    "layout": item.get("layout", "blurred_background"),
                    "track_id": item.get("track_id", "V1"),
                    "features": features,
                    "score": segment_score(features),
                }
            )

        # 时间轴 0 对齐首个用于成片的 beat；按 target 截取所需拍数
        periods = [beats[i + 1] - beats[i] for i in range(len(beats) - 1)]
        med_period = sorted(periods)[len(periods) // 2]
        max_beats_needed = 0
        span = 0
        while max_beats_needed < len(beats) - 1 and span < target_us:
            span = beats[min(max_beats_needed + n_beats, len(beats) - 1)] - beats[0]
            max_beats_needed += n_beats
        slot_count = max(1, max_beats_needed // n_beats)
        # 截到 target 时长
        while (
            slot_count > 1
            and beats[min(slot_count * n_beats, len(beats) - 1)] - beats[0] > target_us
        ):
            slot_count -= 1

        slots: list[dict[str, Any]] = []
        for j in range(slot_count):
            b0 = j * n_beats
            b1 = min(b0 + n_beats, len(beats) - 1)
            if b1 <= b0:
                break
            t0 = beats[b0] - beats[0]
            t1 = beats[b1] - beats[0]
            if t1 - t0 < MIN_VIDEO_US:
                continue
            slots.append(
                {
                    "slot_index": j,
                    "beat_index_start": b0,
                    "beat_index_end": b1,
                    "timeline_start_us": t0,
                    "timeline_end_us": t1,
                    "duration_us": t1 - t0,
                    "strong": beats[b0] in downbeats or b0 in downbeats or (beats[b0] in downbeats),
                    "beat_start_us": beats[b0],
                }
            )
        # strong：downbeat 时间戳命中槽起点 beat
        for slot in slots:
            slot["strong"] = beats[slot["beat_index_start"]] in downbeats

        if not slots:
            return PlanResult(
                summary="卡点：网格不足以形成镜头槽",
                operations=(),
                rationale={
                    "planner": "beat_sync",
                    "params": {
                        "target_duration_us": target_us,
                        "beats_per_shot": n_beats,
                        "bgm_asset_id": params.get("bgm_asset_id"),
                    },
                    "rules": [],
                    "slots": [],
                },
                noop=True,
            )

        # 分配：强拍槽优先放高分段
        ranked = sorted(
            segments,
            key=lambda s: (-s["score"], s["asset_id"], s["source_start_us"]),
        )
        strong_slots = sorted(
            [s for s in slots if s["strong"]], key=lambda s: s["slot_index"]
        )
        weak_slots = sorted(
            [s for s in slots if not s["strong"]], key=lambda s: s["slot_index"]
        )
        assignments: list[dict[str, Any]] = []
        queue = list(ranked)
        for slot in strong_slots + weak_slots:
            if not queue:
                queue = list(ranked)  # 循环复用
                reused = True
            else:
                reused = False
            seg = queue.pop(0)
            # 源区间裁到镜头时长（不足则用满源并标记）
            src_len = seg["source_end_us"] - seg["source_start_us"]
            use_len = min(src_len, slot["duration_us"])
            use_end = seg["source_start_us"] + use_len
            item_short = use_len < slot["duration_us"]
            assignments.append(
                {
                    "slot": slot,
                    "segment": seg,
                    "source_start_us": seg["source_start_us"],
                    "source_end_us": use_end,
                    "reused": reused,
                    "short_source": item_short,
                }
            )

        # 按时间序 insert
        operations: list[dict[str, Any]] = []
        rules: list[dict[str, Any]] = []
        for index, item in enumerate(assignments):
            slot, seg = item["slot"], item["segment"]
            op = {
                "op": "insert_asset_clip",
                "asset_id": seg["asset_id"],
                "at_index": index,
                "source_start_us": item["source_start_us"],
                "source_end_us": item["source_end_us"],
                "layout": seg["layout"],
                "track_id": seg["track_id"],
            }
            operations.append(op)
            rules.append(
                {
                    "rule": "assign_segment_to_slot",
                    "slot_index": slot["slot_index"],
                    "strong": slot["strong"],
                    "beat_start_us": slot["beat_start_us"],
                    "timeline_start_us": slot["timeline_start_us"],
                    "timeline_end_us": slot["timeline_end_us"],
                    "score": seg["score"],
                    "features": seg["features"],
                    "asset_id": seg["asset_id"],
                    "source_start_us": item["source_start_us"],
                    "source_end_us": item["source_end_us"],
                    "reused": item["reused"],
                    "short_source": item.get("short_source", False),
                }
            )

        # 时间线期望：insert 连续铺放时 timeline_start = 前槽时长累加，
        # 与 beat 相对网格一致（槽 duration 定义为 beats 差）。
        expected_timeline = [
            {
                "slot_index": a["slot"]["slot_index"],
                "timeline_start_us": a["slot"]["timeline_start_us"],
                "timeline_end_us": a["slot"]["timeline_end_us"],
            }
            for a in assignments
        ]

        return PlanResult(
            summary=(
                f"卡点：{len(assignments)} 镜头 × {n_beats} 拍"
                f"（强拍 {sum(1 for a in assignments if a['slot']['strong'])}）"
            ),
            operations=tuple(operations),
            rationale={
                "planner": "beat_sync",
                "params": {
                    "target_duration_us": target_us,
                    "beats_per_shot": n_beats,
                    "bgm_asset_id": params.get("bgm_asset_id"),
                    "weights": {
                        "face": W_FACE,
                        "motion": W_MOTION,
                        "sharpness": W_SHARPNESS,
                    },
                    "median_period_us": med_period,
                },
                "rules": rules,
                "slots": expected_timeline,
                "beats_us": beats[: slots[-1]["beat_index_end"] + 1],
                "downbeats_us": sorted(downbeats),
            },
            noop=False,
        )
