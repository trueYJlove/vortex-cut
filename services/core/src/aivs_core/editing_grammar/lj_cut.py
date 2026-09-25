"""W1.4 L/J cut 规划器：依据 ASR 词戳生成 split_edit 序列。"""

from __future__ import annotations

from typing import Any

from ..projects import DomainError
from ..timeline import MIN_VIDEO_US
from .protocol import PlanResult, ToolDescription

MIN_JL_OFFSET_US = 300_000
MAX_JL_OFFSET_US = 500_000
DEFAULT_JL_OFFSET_US = 400_000


def choose_audio_delta(
    *,
    mode: str,
    picture_cut_us: int,
    words: list[dict[str, Any]],
    clip_start_us: int,
    clip_end_us: int,
    offset_us: int,
) -> dict[str, Any]:
    """J：delta 负（下段声先入）；L：delta 正（上段声延后）。返回 delta 与依据。"""
    if mode not in ("j", "l"):
        raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "mode 必须为 j 或 l")
    if not MIN_JL_OFFSET_US <= offset_us <= MAX_JL_OFFSET_US:
        raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "offset_us 超出 300–500ms")
    ordered = sorted(
        (w for w in words if "start_us" in w and "end_us" in w),
        key=lambda w: int(w["start_us"]),
    )
    if not ordered:
        raise DomainError("EDITING_GRAMMAR_NO_WORDS", "缺少词级时间戳")

    if mode == "j":
        # 切点后首词：希望其声提前 offset → 音频切点 = 画面切点 - offset
        next_word = next((w for w in ordered if int(w["start_us"]) >= picture_cut_us), None)
        if next_word is None:
            raise DomainError("EDITING_GRAMMAR_NO_WORDS", "切点后无词，无法 J-cut")
        # 优先用词距；若词距不在窗内则用默认 offset（仍钳在窗内）
        gap = int(next_word["start_us"]) - picture_cut_us
        use = min(max(gap if 0 < gap <= MAX_JL_OFFSET_US else offset_us, MIN_JL_OFFSET_US), MAX_JL_OFFSET_US)
        delta = -use
        evidence = {
            "rule": "j_cut_lead_next_word",
            "word_start_us": int(next_word["start_us"]),
            "word_end_us": int(next_word["end_us"]),
            "gap_us": gap,
            "offset_applied_us": use,
        }
    else:
        prev_word = None
        for w in ordered:
            if int(w["end_us"]) <= picture_cut_us:
                prev_word = w
            else:
                break
        if prev_word is None:
            raise DomainError("EDITING_GRAMMAR_NO_WORDS", "切点前无词，无法 L-cut")
        use = offset_us
        delta = use
        evidence = {
            "rule": "l_cut_trail_prev_word",
            "word_start_us": int(prev_word["start_us"]),
            "word_end_us": int(prev_word["end_us"]),
            "offset_applied_us": use,
        }

    audio_cut = picture_cut_us + delta
    if not clip_start_us <= audio_cut <= clip_end_us:
        raise DomainError("TIMELINE_INVALID", "声音切点越出素材范围")
    return {
        "audio_delta_us": delta,
        "audio_cut_us": audio_cut,
        "evidence": evidence,
    }


def auto_lj_mode(words: list[dict[str, Any]], picture_cut_us: int) -> str:
    """无显式 mode 时的方向启发：优先 J（下句声先入），否则 L（上句声延后）。

    评测与「一键 L/J」共用；显式 mode 仍走 `choose_audio_delta` 原路径。
    """
    ordered = sorted(
        (w for w in words if "start_us" in w and "end_us" in w),
        key=lambda w: int(w["start_us"]),
    )
    if not ordered:
        raise DomainError("EDITING_GRAMMAR_NO_WORDS", "缺少词级时间戳")
    if any(int(w["start_us"]) >= picture_cut_us for w in ordered):
        return "j"
    if any(int(w["end_us"]) <= picture_cut_us for w in ordered):
        return "l"
    raise DomainError("EDITING_GRAMMAR_NO_WORDS", "切点附近无可对齐词")


class LjCutPlanner:
    @property
    def tool(self) -> ToolDescription:
        return ToolDescription(
            name="lj_cut",
            title="L-cut / J-cut（E3）",
            description=(
                "确定性规划器：按 ASR 词级时间戳生成 split_edit。"
                "J-cut：下句首词提前 300–500ms；L-cut：上句末词延后。"
            ),
            parameters_schema={
                "type": "object",
                "additionalProperties": False,
                "required": ["clip_id", "mode", "source_time_us", "words"],
                "properties": {
                    "clip_id": {"type": "string"},
                    "mode": {"type": "string", "enum": ["j", "l", "auto"]},
                    "source_time_us": {"type": "integer", "minimum": MIN_VIDEO_US},
                    "offset_us": {
                        "type": "integer",
                        "minimum": MIN_JL_OFFSET_US,
                        "maximum": MAX_JL_OFFSET_US,
                    },
                    "words": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["start_us", "end_us"],
                            "properties": {
                                "start_us": {"type": "integer"},
                                "end_us": {"type": "integer"},
                                "text": {"type": "string"},
                            },
                        },
                    },
                },
            },
            preconditions=(
                "clip 为 video 且源区间可拆",
                "words 非空（词级时间戳）",
                "offset_us ∈ [300000, 500000]",
            ),
        )

    def plan(
        self,
        document: dict[str, Any],
        params: dict[str, Any],
        signals: dict[str, Any] | None = None,
    ) -> PlanResult:
        allowed = {"clip_id", "mode", "source_time_us", "offset_us", "words"}
        if set(params) - allowed:
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "规划器参数不合法")
        clip_id = params.get("clip_id")
        mode = params.get("mode")
        cut = params.get("source_time_us")
        offset = params.get("offset_us", DEFAULT_JL_OFFSET_US)
        words = params.get("words")
        if not isinstance(clip_id, str) or not clip_id:
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "clip_id 不合法")
        if mode not in ("j", "l", "auto"):
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "mode 必须为 j / l / auto")
        if (
            isinstance(cut, bool)
            or not isinstance(cut, int)
            or cut < MIN_VIDEO_US
        ):
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "source_time_us 不合法")
        if (
            isinstance(offset, bool)
            or not isinstance(offset, int)
            or not MIN_JL_OFFSET_US <= offset <= MAX_JL_OFFSET_US
        ):
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "offset_us 不合法")
        if words is None:
            words = []
        if not isinstance(words, list):
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "words 不合法")
        if not words:
            words = list((signals or {}).get("words") or [])

        clip = next(
            (c for c in document.get("clips") or [] if c.get("clip_id") == clip_id),
            None,
        )
        if clip is None:
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "目标片段不存在")
        if clip.get("asset_kind") != "video":
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "只有视频片段可以 L/J cut")
        src_start, src_end = clip["source_start_us"], clip["source_end_us"]
        if not src_start < cut < src_end:
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "切点必须在片段内部")
        if cut - src_start < MIN_VIDEO_US or src_end - cut < MIN_VIDEO_US:
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "切点两侧过短")

        decision_mode = auto_lj_mode(words, cut) if mode == "auto" else mode
        decision = choose_audio_delta(
            mode=decision_mode,
            picture_cut_us=cut,
            words=words,
            clip_start_us=src_start,
            clip_end_us=src_end,
            offset_us=offset,
        )
        operations = (
            {
                "op": "split_edit",
                "clip_id": clip_id,
                "source_time_us": cut,
                "audio_delta_us": decision["audio_delta_us"],
            },
        )
        return PlanResult(
            summary=(
                f"{'J' if decision_mode == 'j' else 'L'}-cut @ {cut}us"
                f"（Δ={decision['audio_delta_us']}us）"
            ),
            operations=operations,
            rationale={
                "planner": "lj_cut",
                "params": {
                    "clip_id": clip_id,
                    "mode": decision_mode,
                    "requested_mode": mode,
                    "source_time_us": cut,
                    "offset_us": offset,
                },
                "rules": [decision["evidence"]],
                "audio_delta_us": decision["audio_delta_us"],
                "audio_cut_us": decision["audio_cut_us"],
            },
            noop=False,
        )
