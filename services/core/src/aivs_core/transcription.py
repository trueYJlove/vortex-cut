from __future__ import annotations

import asyncio
import importlib
import importlib.util
import math
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import unquote, urlparse

from .database import Database, utc_now
from .ids import new_id


class TranscriptionError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class TranscriptWordResult:
    start_us: int
    end_us: int
    text: str
    confidence: float | None


@dataclass(frozen=True)
class TranscriptSegmentResult:
    start_us: int
    end_us: int
    text: str
    confidence: float | None
    words: tuple[TranscriptWordResult, ...]


@dataclass(frozen=True)
class TranscriptResult:
    language: str
    duration_us: int
    segments: tuple[TranscriptSegmentResult, ...]


class SpeechToTextProvider(Protocol):
    async def transcribe(
        self,
        audio_uri: str,
        language: str,
        model_id: str,
        model_dir: Path,
        word_timestamps: bool,
        cancel_token: asyncio.Event,
        progress_callback: Callable[[float], None],
    ) -> TranscriptResult: ...


class FasterWhisperProvider:
    async def transcribe(
        self,
        audio_uri: str,
        language: str,
        model_id: str,
        model_dir: Path,
        word_timestamps: bool,
        cancel_token: asyncio.Event,
        progress_callback: Callable[[float], None],
    ) -> TranscriptResult:
        if importlib.util.find_spec("faster_whisper") is None:
            raise TranscriptionError("MODEL_RUNTIME_UNAVAILABLE", "本地 ASR 运行时不可用")
        path = _path_from_uri(audio_uri)
        if not path.is_file():
            raise TranscriptionError("TRANSCRIPTION_INPUT_CHANGED", "音频文件不存在")
        try:
            return await asyncio.to_thread(
                self._transcribe_sync,
                path,
                language,
                model_id,
                model_dir,
                word_timestamps,
                cancel_token,
                progress_callback,
            )
        except TranscriptionError:
            raise
        except Exception as exc:
            raise TranscriptionError("MODEL_RUNTIME_UNAVAILABLE", "本地 ASR 运行时不可用") from exc

    @staticmethod
    def _transcribe_sync(
        path: Path,
        language: str,
        model_id: str,
        model_dir: Path,
        word_timestamps: bool,
        cancel_token: asyncio.Event,
        progress_callback: Callable[[float], None],
    ) -> TranscriptResult:
        module = importlib.import_module("faster_whisper")
        whisper_model = module.WhisperModel(
            str(model_dir), device="auto", compute_type="default"
        )
        requested_language = None if language == "auto" else language
        # vad_filter：先用内置 Silero VAD（随 faster-whisper 离线打包，无需联网）
        # 切掉非语音段。没有它时，纯音乐/环境声素材会让 Whisper 反复"幻听"出
        # 同一句（实测 `刘可艾 小花猫舞蹈视频.mp4`：VAD 判定语音仅占 14.4%，
        # 关掉 VAD 会产出 8 连「丫谱」+ 5 连「丫语」这类重复垃圾段；开启后
        # 重复段归零、平均 logprob 从 -0.97 升到 -0.45，保留的是真实人声）。
        # condition_on_previous_text 保持默认 True：实测关闭它反而把平均
        # logprob 拉低到 -2.87（上下文丢失，质量下降）。
        segments, info = whisper_model.transcribe(
            str(path),
            language=requested_language,
            word_timestamps=word_timestamps,
            vad_filter=True,
        )
        duration_us = max(1, int(float(getattr(info, "duration", 0.0)) * 1_000_000))
        result_segments: list[TranscriptSegmentResult] = []
        for segment in segments:
            if cancel_token.is_set():
                raise TranscriptionError("TRANSCRIPTION_CANCELLED", "转录已取消")
            start_us = max(0, int(float(segment.start) * 1_000_000))
            end_us = max(start_us + 1, int(float(segment.end) * 1_000_000))
            words: list[TranscriptWordResult] = []
            if word_timestamps:
                for word in getattr(segment, "words", None) or []:
                    clamped = _clamp_word_us(
                        start_us,
                        end_us,
                        int(float(word.start) * 1_000_000),
                        int(float(word.end) * 1_000_000),
                    )
                    if clamped is None:
                        continue
                    words.append(
                        TranscriptWordResult(
                            start_us=clamped[0],
                            end_us=clamped[1],
                            text=str(word.word),
                            confidence=_confidence(getattr(word, "probability", None)),
                        )
                    )
            result_segments.append(
                TranscriptSegmentResult(
                    start_us=start_us,
                    end_us=end_us,
                    text=str(segment.text),
                    confidence=_logprob_confidence(getattr(segment, "avg_logprob", None)),
                    words=tuple(words),
                )
            )
            progress_callback(min(1.0, end_us / duration_us))
        detected_language = str(getattr(info, "language", language or "auto"))
        return TranscriptResult(
            language=detected_language,
            duration_us=duration_us,
            segments=tuple(result_segments),
        )


class TranscriptRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def save_ready(
        self,
        asset_id: str,
        source_fingerprint: str,
        provider: str,
        model_id: str,
        model_revision: str,
        result: TranscriptResult,
    ) -> dict[str, Any]:
        result = _normalize_result(result)
        _validate_result(result)
        transcript_id = f"transcript_{new_id()}"
        now = utc_now()
        try:
            with self.db.connection() as db:
                db.execute("BEGIN")
                db.execute(
                    "INSERT INTO transcripts (id,asset_id,status,language,provider,model_id,"
                    "model_revision,source_fingerprint,duration_us,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        transcript_id,
                        asset_id,
                        "ready",
                        result.language,
                        provider,
                        model_id,
                        model_revision,
                        source_fingerprint,
                        result.duration_us,
                        now,
                        now,
                    ),
                )
                for segment_ordinal, segment in enumerate(result.segments):
                    segment_id = f"segment_{new_id()}"
                    db.execute(
                        "INSERT INTO transcript_segments "
                        "(id,transcript_id,ordinal,start_us,end_us,text,confidence) "
                        "VALUES (?,?,?,?,?,?,?)",
                        (
                            segment_id,
                            transcript_id,
                            segment_ordinal,
                            segment.start_us,
                            segment.end_us,
                            segment.text,
                            segment.confidence,
                        ),
                    )
                    for word_ordinal, word in enumerate(segment.words):
                        db.execute(
                            "INSERT INTO transcript_words "
                            "(id,segment_id,ordinal,start_us,end_us,text,confidence) "
                            "VALUES (?,?,?,?,?,?,?)",
                            (
                                f"word_{new_id()}",
                                segment_id,
                                word_ordinal,
                                word.start_us,
                                word.end_us,
                                word.text,
                                word.confidence,
                            ),
                        )
                db.execute("COMMIT")
        except Exception:
            with self.db.connection() as db:
                db.execute("ROLLBACK")
            raise
        return self.get(transcript_id)  # type: ignore[return-value]

    def delete(self, transcript_id: str) -> None:
        """删除一条转录（含 segments/words），但拒绝破坏时间线引用。

        时间线的 transcript 字幕通过 `source_segment_ids` 记录来源片段；若该
        转录仍被任一 Revision 或草稿引用，删除会让这些字幕永久失去来源
        （无法再据此生成 Provider 字幕提案），故 fail-closed 拒绝。
        """
        with self.db.connection() as db:
            transcript = db.execute(
                "SELECT id, asset_id FROM transcripts WHERE id=?", (transcript_id,)
            ).fetchone()
            if not transcript:
                raise TranscriptionError("TRANSCRIPTION_NOT_FOUND", "转录不存在")
            segment_ids = [
                row[0]
                for row in db.execute(
                    "SELECT id FROM transcript_segments WHERE transcript_id=?",
                    (transcript_id,),
                )
            ]
            if segment_ids and self._segments_referenced(db, segment_ids):
                raise TranscriptionError(
                    "TRANSCRIPTION_IN_USE",
                    "该转录已被时间线字幕引用，请先移除相关字幕或片段后再删除",
                )
            db.execute("BEGIN")
            try:
                # transcript_words/segments 有 ON DELETE CASCADE，但历史库可能
                # 由兼容路径建成无级联，故显式逐层清理（与 delete_asset 同法）。
                db.execute(
                    "DELETE FROM transcript_words WHERE segment_id IN ("
                    "SELECT id FROM transcript_segments WHERE transcript_id=?)",
                    (transcript_id,),
                )
                db.execute(
                    "DELETE FROM transcript_segments WHERE transcript_id=?", (transcript_id,)
                )
                db.execute("DELETE FROM transcripts WHERE id=?", (transcript_id,))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    @staticmethod
    def _segments_referenced(db: Any, segment_ids: list[str]) -> bool:
        """任一 Revision / 草稿的 transcript 字幕是否引用这些片段。

        用两层 json_each 展开：先展开 captions 数组取每条字幕，再对字幕的
        source_segment_ids 展开。注意 json_each 的两参形式在部分 SQLite 版本
        对「路径取出的文本」会报 malformed JSON，故内层改用
        `json_each(json_extract(c.value,'$.source_segment_ids'))` 单参形式。
        """
        placeholders = ",".join("?" for _ in segment_ids)
        for table in ("timeline_revisions", "timeline_drafts"):
            exists = db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone()
            if not exists:
                continue
            hit = db.execute(
                f"""
                SELECT 1
                FROM {table} t,
                     json_each(t.document_json, '$.captions') c,
                     json_each(json_extract(c.value, '$.source_segment_ids')) s
                WHERE s.value IN ({placeholders})
                LIMIT 1
                """,
                segment_ids,
            ).fetchone()
            if hit:
                return True
        return False

    def get(self, transcript_id: str) -> dict[str, Any] | None:
        with self.db.connection() as db:
            transcript = db.execute(
                "SELECT * FROM transcripts WHERE id=?", (transcript_id,)
            ).fetchone()
            if not transcript:
                return None
            segments = db.execute(
                "SELECT * FROM transcript_segments WHERE transcript_id=? ORDER BY ordinal",
                (transcript_id,),
            ).fetchall()
            words_by_segment: dict[str, list[dict[str, Any]]] = {}
            for segment in segments:
                segment_words = db.execute(
                    "SELECT * FROM transcript_words WHERE segment_id=? ORDER BY start_us, ordinal",
                    (segment["id"],),
                ).fetchall()
                words_by_segment[segment["id"]] = [_word_dto(word) for word in segment_words]
        return {
            "transcript_id": transcript["id"],
            "asset_id": transcript["asset_id"],
            "status": transcript["status"],
            "language": transcript["language"],
            "segments": [
                {
                    "segment_id": segment["id"],
                    "ordinal": segment["ordinal"],
                    "start_us": segment["start_us"],
                    "end_us": segment["end_us"],
                    "text": segment["text"],
                    "confidence": segment["confidence"],
                    "words": words_by_segment[segment["id"]] or None,
                }
                for segment in segments
            ],
            "words": [
                word
                for segment in segments
                for word in words_by_segment[segment["id"]]
            ]
            or None,
            "provider": transcript["provider"],
            "model_id": transcript["model_id"],
            "model_revision": transcript["model_revision"],
            "source_media_fingerprint": transcript["source_fingerprint"],
            "duration_us": transcript["duration_us"],
            "created_at": transcript["created_at"],
            "updated_at": transcript["updated_at"],
        }

    def list_for_asset(
        self,
        asset_id: str,
        source_fingerprint: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        offset = _cursor_offset(cursor)
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT * FROM transcripts WHERE asset_id=? ORDER BY updated_at DESC, id DESC "
                "LIMIT ? OFFSET ?",
                (
                    asset_id,
                    limit,
                    offset,
                ),
            ).fetchall()
        items = []
        for row in rows:
            status = row["status"]
            if (
                source_fingerprint
                and row["source_fingerprint"] != source_fingerprint
                and status == "ready"
            ):
                status = "stale"
            items.append(
                {
                    "transcript_id": row["id"],
                    "asset_id": row["asset_id"],
                    "status": status,
                    "language": row["language"],
                    "provider": row["provider"],
                    "model_id": row["model_id"],
                    "model_revision": row["model_revision"],
                    "source_media_fingerprint": row["source_fingerprint"],
                    "duration_us": row["duration_us"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
            )
        next_cursor = str(offset + len(items)) if len(items) == limit else None
        return items, next_cursor

    def find_ready(
        self,
        asset_id: str,
        source_fingerprint: str,
        model_id: str,
        model_revision: str,
        require_words: bool,
    ) -> dict[str, Any] | None:
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT id FROM transcripts WHERE asset_id=? AND status='ready' "
                "AND source_fingerprint=? AND model_id=? "
                "AND model_revision=? ORDER BY updated_at DESC",
                (asset_id, source_fingerprint, model_id, model_revision),
            ).fetchall()
        for row in rows:
            transcript = self.get(row[0])
            if transcript and (not require_words or transcript["words"] is not None):
                return transcript
        return None

    def revalidate_for_fingerprint(self, asset_id: str, source_fingerprint: str) -> None:
        """素材内容回退到曾被转录的版本：把对应转录从 stale 恢复为 ready。

        只恢复 source_fingerprint 完全相符的行——指纹不同的转录描述的确实是另一版
        内容，保持 stale。与 mark_asset_stale 互为逆操作，供 projects.refresh_asset
        的「回退」分支调用（2026-10-10：此前只有单向 stale，外部改动再改回来素材
        永久不可用）。
        """
        with self.db.connection() as db:
            db.execute(
                "UPDATE transcripts SET status='ready',updated_at=? WHERE asset_id=? "
                "AND source_fingerprint=? AND status='stale'",
                (utc_now(), asset_id, source_fingerprint),
            )

    def mark_asset_stale(
        self, asset_id: str, source_fingerprint: str | None
    ) -> None:
        with self.db.connection() as db:
            if source_fingerprint is None:
                db.execute(
                    "UPDATE transcripts SET status='stale',updated_at=? "
                    "WHERE asset_id=? AND status='ready'",
                    (utc_now(), asset_id),
                )
            else:
                db.execute(
                    "UPDATE transcripts SET status='stale',updated_at=? WHERE asset_id=? "
                    "AND source_fingerprint<>? AND status='ready'",
                    (utc_now(), asset_id, source_fingerprint),
                )


def _clamp_word_us(
    segment_start_us: int, segment_end_us: int, word_start_us: int, word_end_us: int
) -> tuple[int, int] | None:
    """Clamp a Whisper word into its segment, or drop it when it cannot fit.

    The validator requires `segment.start <= word.start < word.end <= segment.end`.
    Whisper emits out-of-range word times at sentence/silence boundaries. Clamping
    only the lower bound (the previous behaviour) let `word.start` exceed
    `segment.end`; clamping `word.end` back then produced `end < start` and the
    whole transcription failed with "word timing invalid in segment N"
    (observed in the real app on segment 23). Both bounds must be clamped, and a
    word that still cannot fit (degenerate 1µs segment) is dropped rather than
    persisted as an illegal range.
    """
    if segment_end_us <= segment_start_us:
        return None
    start = min(max(segment_start_us, word_start_us), segment_end_us - 1)
    end = min(segment_end_us, max(start + 1, word_end_us))
    if end <= start:
        return None
    return start, end


def _normalize_result(result: TranscriptResult) -> TranscriptResult:
    segments = tuple(
        TranscriptSegmentResult(
            start_us=segment.start_us,
            end_us=segment.end_us,
            text=segment.text,
            confidence=segment.confidence,
            words=tuple(sorted(segment.words, key=lambda word: (word.start_us, word.end_us))),
        )
        for _, segment in sorted(
            enumerate(result.segments), key=lambda pair: (pair[1].start_us, pair[0])
        )
    )
    return TranscriptResult(
        language=result.language,
        duration_us=result.duration_us,
        segments=segments,
    )


def _validate_result(result: TranscriptResult) -> None:
    if not result.language or not _is_int(result.duration_us) or result.duration_us <= 0:
        raise TranscriptionError("TRANSCRIPTION_FAILED", "本地转录失败")
    previous_start = -1
    for ordinal, segment in enumerate(result.segments):
        if (
            not _is_int(segment.start_us)
            or not _is_int(segment.end_us)
            or segment.start_us < 0
            or segment.end_us <= segment.start_us
        ):
            raise TranscriptionError("TRANSCRIPTION_FAILED", "本地转录失败")
        if segment.end_us > result.duration_us or segment.start_us < previous_start:
            raise TranscriptionError("TRANSCRIPTION_FAILED", "本地转录失败")
        previous_start = segment.start_us
        previous_word_start = -1
        for word in segment.words:
            if (
                not _is_int(word.start_us)
                or not _is_int(word.end_us)
                or word.start_us < segment.start_us
                or word.end_us <= word.start_us
                or word.end_us > segment.end_us
                or word.start_us < previous_word_start
            ):
                raise TranscriptionError(
                    "TRANSCRIPTION_FAILED",
                    f"transcription word timing invalid in segment {ordinal}",
                )
            previous_word_start = word.start_us
            if word.confidence is not None and not 0 <= word.confidence <= 1:
                raise TranscriptionError("TRANSCRIPTION_FAILED", "本地转录失败")
        if segment.confidence is not None and not 0 <= segment.confidence <= 1:
            raise TranscriptionError("TRANSCRIPTION_FAILED", "本地转录失败")


def _confidence(value: Any) -> float | None:
    """词级置信度：faster-whisper 的 `Word.probability` 本就是 [0,1] 概率。"""
    if value is None:
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return min(1.0, max(0.0, float(value)))
    return None


def _logprob_confidence(value: Any) -> float | None:
    """段级置信度：faster-whisper 的 `Segment.avg_logprob` 是**对数**概率，
    取值恒 ≤ 0（实测 -0.2 ~ -3.4）。旧实现直接拿它当概率、再用 max(0, ·) 钳制，
    结果每条段的 confidence 都被压成 0.0（2026-10-08 用真实库核对：57/57 段
    全为 0），而 AI 粗剪的 `planning._select` 正是按 confidence 排序，等于该
    权重长期失效。此处按 exp() 还原为 [0,1] 概率（-0.2 → 0.82）。"""
    if value is None:
        return None
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        return None
    # 幂等：若上游已给概率（> 0），不要重复取指数。
    if float(value) > 0:
        return min(1.0, float(value))
    return min(1.0, max(0.0, math.exp(float(value))))


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _word_dto(row: Any) -> dict[str, Any]:
    return {
        "word_id": row["id"],
        "segment_id": row["segment_id"],
        "ordinal": row["ordinal"],
        "start_us": row["start_us"],
        "end_us": row["end_us"],
        "text": row["text"],
        "confidence": row["confidence"],
    }


def _path_from_uri(uri: str) -> Path:
    if not uri.startswith("file:"):
        return Path(uri)
    parsed = urlparse(uri)
    value = unquote(parsed.path)
    if parsed.netloc:
        value = f"//{parsed.netloc}{value}"
    elif len(value) >= 3 and value[0] == "/" and value[2] == ":":
        value = value[1:]
    return Path(value)


def _cursor_offset(value: str | None) -> int:
    if value is None:
        return 0
    try:
        result = int(value)
    except ValueError as exc:
        raise TranscriptionError("VALIDATION_ERROR", "请求参数不合法") from exc
    if result < 0:
        raise TranscriptionError("VALIDATION_ERROR", "请求参数不合法")
    return result
