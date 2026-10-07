from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from aivs_core.database import Database
from aivs_core.transcription import (
    FasterWhisperProvider,
    TranscriptionError,
    TranscriptRepository,
    TranscriptResult,
    TranscriptSegmentResult,
    TranscriptWordResult,
    _clamp_word_us,
)


class FakeSegment:
    def __init__(self, start: float, end: float, text: str, words: list | None = None):
        self.start = start
        self.end = end
        self.text = text
        self.avg_logprob = -0.2
        self.words = words or []


class FakeInfo:
    duration = 2.0
    language = "zh"


class FakeWhisperModel:
    def __init__(self, *args, **kwargs):
        pass

    def transcribe(self, path: str, language: str | None = None, word_timestamps: bool = False):
        segments = [
            FakeSegment(0.0, 1.0, "你好", [FakeWord(0.0, 0.5, "你好"), FakeWord(0.5, 1.0, "世界")]),
            FakeSegment(1.0, 2.0, "世界", []),
        ]
        return iter(segments), FakeInfo()


class FakeWord:
    def __init__(self, start: float, end: float, word: str):
        self.start = start
        self.end = end
        self.word = word
        self.probability = 0.95


def _fake_whisper_module():
    module = type("faster_whisper", (), {})()
    module.WhisperModel = FakeWhisperModel
    return module


def _provider_with_fake_runtime(monkeypatch, *, installed: bool = True):
    monkeypatch.setattr(
        "aivs_core.transcription.importlib.util.find_spec",
        lambda _name: object() if installed else None,
    )
    if installed:
        monkeypatch.setattr(
            "aivs_core.transcription.importlib.import_module",
            lambda _name: _fake_whisper_module(),
        )
    return FasterWhisperProvider()


class TestFasterWhisperProvider:
    @pytest.mark.asyncio
    async def test_runtime_unavailable(self, tmp_path: Path, monkeypatch):
        provider = _provider_with_fake_runtime(monkeypatch, installed=False)
        audio = tmp_path / "a.wav"
        audio.write_bytes(b"data")
        with pytest.raises(TranscriptionError) as exc:
            await provider.transcribe(
                audio.as_uri(), "auto", "m", tmp_path, False, asyncio.Event(), lambda _p: None
            )
        assert exc.value.code == "MODEL_RUNTIME_UNAVAILABLE"

    @pytest.mark.asyncio
    async def test_missing_audio_file(self, tmp_path: Path, monkeypatch):
        provider = _provider_with_fake_runtime(monkeypatch)
        missing = tmp_path / "missing.wav"
        with pytest.raises(TranscriptionError) as exc:
            await provider.transcribe(
                missing.as_uri(), "auto", "m", tmp_path, False, asyncio.Event(), lambda _p: None
            )
        assert exc.value.code == "TRANSCRIPTION_INPUT_CHANGED"

    @pytest.mark.asyncio
    async def test_successful_transcribe(self, tmp_path: Path, monkeypatch):
        provider = _provider_with_fake_runtime(monkeypatch)
        audio = tmp_path / "a.wav"
        audio.write_bytes(b"data")
        result = await provider.transcribe(
            audio.as_uri(),
            "auto",
            "test-model",
            tmp_path,
            True,
            asyncio.Event(),
            lambda _p: None,
        )
        assert result.duration_us == 2_000_000
        assert result.language == "zh"
        assert len(result.segments) == 2
        assert result.segments[0].start_us == 0
        assert result.segments[0].end_us == 1_000_000
        assert result.segments[0].text == "你好"
        assert len(result.segments[0].words) == 2
        assert result.segments[0].words[0].text == "你好"
        assert result.segments[0].words[0].start_us == 0
        assert result.segments[0].words[1].end_us == 1_000_000

    @pytest.mark.asyncio
    async def test_cancel_during_transcribe(self, tmp_path: Path, monkeypatch):
        provider = _provider_with_fake_runtime(monkeypatch)
        audio = tmp_path / "a.wav"
        audio.write_bytes(b"data")

        class CancellingModel(FakeWhisperModel):
            def transcribe(self, *args, **kwargs):
                raise TranscriptionError("TRANSCRIPTION_CANCELLED", "转录已取消")

        monkeypatch.setattr("aivs_core.transcription.importlib.import_module", lambda _n: type(
            "m", (), {"WhisperModel": CancellingModel}
        )())
        with pytest.raises(TranscriptionError) as exc:
            await provider.transcribe(
                audio.as_uri(), "auto", "m", tmp_path, False, asyncio.Event(), lambda _p: None
            )
        assert exc.value.code == "TRANSCRIPTION_CANCELLED"


def _repo(tmp_path: Path) -> tuple[TranscriptRepository, Database]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects "
            "(id,name,status,canvas_json,root_dir,root_dir_name,created_at,updated_at,"
            "last_opened_at) "
            "VALUES ('proj_1','P','active','{}','root','root','now','now','now')"
        )
        conn.execute(
            "INSERT INTO assets "
            "(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,"
            "availability,created_at,updated_at) "
            "VALUES ('asset_1','proj_1','video','external','a.mp4','fp_1',10,"
            "'available','now','now')"
        )
        conn.execute(
            "INSERT INTO asset_locations (asset_id,uri,last_verified_at) "
            "VALUES ('asset_1','file:///a.mp4','now')"
        )
    return TranscriptRepository(db), db


def _sample_result() -> TranscriptResult:
    return TranscriptResult(
        language="zh",
        duration_us=2_000_000,
        segments=(
            TranscriptSegmentResult(
                start_us=0,
                end_us=1_000_000,
                text="你好",
                confidence=0.9,
                words=(
                    TranscriptWordResult(0, 500_000, "你好", 0.95),
                    TranscriptWordResult(500_000, 1_000_000, "世界", 0.9),
                ),
            ),
            TranscriptSegmentResult(
                start_us=1_000_000,
                end_us=2_000_000,
                text="世界",
                confidence=0.8,
                words=(),
            ),
        ),
    )


class TestTranscriptRepository:
    def test_save_get_roundtrip(self, tmp_path: Path):
        repo, _ = _repo(tmp_path)
        saved = repo.save_ready(
            "asset_1", "fp_1", "faster-whisper", "model_1", "rev1", _sample_result()
        )
        assert saved["transcript_id"].startswith("transcript_")
        assert saved["status"] == "ready"
        assert saved["source_media_fingerprint"] == "fp_1"
        assert saved["duration_us"] == 2_000_000
        assert len(saved["segments"]) == 2
        assert saved["segments"][0]["words"] is not None
        assert saved["words"] is not None and len(saved["words"]) == 2

        fetched = repo.get(saved["transcript_id"])
        assert fetched is not None
        assert fetched["segments"][0]["text"] == "你好"
        assert fetched["segments"][1]["words"] is None

    def test_save_invalid_timestamps_rejected(self, tmp_path: Path):
        repo, _ = _repo(tmp_path)
        bad = TranscriptResult(
            language="zh",
            duration_us=1_000_000,
            segments=(
                TranscriptSegmentResult(
                    start_us=0,
                    end_us=2_000_000,
                    text="x",
                    confidence=None,
                    words=(),
                ),
            ),
        )
        with pytest.raises(TranscriptionError):
            repo.save_ready("asset_1", "fp", "provider", "model", "rev", bad)

    @pytest.mark.parametrize(
        "field,value",
        [
            ("duration_us", 1.5),
            ("duration_us", True),
            ("segment_start_us", 0.5),
            ("segment_start_us", True),
            ("segment_end_us", 1_000_000.0),
            ("segment_end_us", False),
            ("word_start_us", 0.5),
            ("word_start_us", True),
            ("word_end_us", 500_000.0),
            ("word_end_us", False),
        ],
    )
    def test_save_rejects_non_integer_microsecond_values(
        self, tmp_path: Path, field: str, value: object
    ):
        repo, _ = _repo(tmp_path)
        duration_us: object = value if field == "duration_us" else 1_000_000
        segment_start_us: object = value if field == "segment_start_us" else 0
        segment_end_us: object = value if field == "segment_end_us" else 1_000_000
        word_start_us: object = value if field == "word_start_us" else 0
        word_end_us: object = value if field == "word_end_us" else 500_000
        bad = TranscriptResult(
            language="zh",
            duration_us=duration_us,  # type: ignore[arg-type]
            segments=(
                TranscriptSegmentResult(
                    start_us=segment_start_us,  # type: ignore[arg-type]
                    end_us=segment_end_us,  # type: ignore[arg-type]
                    text="x",
                    confidence=None,
                    words=(
                        TranscriptWordResult(
                            word_start_us, word_end_us, "x", None  # type: ignore[arg-type]
                        ),
                    ),
                ),
            ),
        )
        with pytest.raises(TranscriptionError) as exc:
            repo.save_ready("asset_1", "fp_1", "provider", "model", "rev", bad)
        assert exc.value.code == "TRANSCRIPTION_FAILED"

    @pytest.mark.parametrize(
        "start_us,end_us,word_start_us,word_end_us",
        [
            (-1, 1_000_000, 0, 500_000),
            (0, 0, 0, 1),
            (0, 1_000_001, 0, 1),
            (0, 1_000_000, -1, 1),
            (0, 1_000_000, 0, 1_000_001),
            (0, 1_000_000, 500_000, 500_000),
        ],
    )
    def test_save_rejects_timestamp_boundary_violations(
        self,
        tmp_path: Path,
        start_us: int,
        end_us: int,
        word_start_us: int,
        word_end_us: int,
    ):
        repo, _ = _repo(tmp_path)
        bad = TranscriptResult(
            language="zh",
            duration_us=1_000_000,
            segments=(
                TranscriptSegmentResult(
                    start_us=start_us,
                    end_us=end_us,
                    text="x",
                    confidence=None,
                    words=(TranscriptWordResult(word_start_us, word_end_us, "x", None),),
                ),
            ),
        )
        with pytest.raises(TranscriptionError) as exc:
            repo.save_ready("asset_1", "fp_1", "provider", "model", "rev", bad)
        assert exc.value.code == "TRANSCRIPTION_FAILED"

    @pytest.mark.parametrize(
        "word_start_us,word_end_us,expected",
        [
            # 词完全在 segment 内：原样保留
            (1_100_000, 1_400_000, (1_100_000, 1_400_000)),
            # 真实失败现场：词起点越过 segment 终点（Whisper 句尾越界）。
            # 修复前 word_start=2.4M > word_end=2.0M → validator 必拒。
            (2_400_000, 2_500_000, (1_999_999, 2_000_000)),
            # 词起点在 segment 之前：钳到 segment 起点
            (900_000, 1_200_000, (1_000_000, 1_200_000)),
            # 词终点越过 segment 终点：钳回终点
            (1_500_000, 2_600_000, (1_500_000, 2_000_000)),
            # 零宽词：强制至少 1µs
            (1_500_000, 1_500_000, (1_500_000, 1_500_001)),
        ],
    )
    def test_clamp_word_us_keeps_words_inside_segment(
        self, word_start_us: int, word_end_us: int, expected: tuple[int, int]
    ) -> None:
        clamped = _clamp_word_us(1_000_000, 2_000_000, word_start_us, word_end_us)
        assert clamped == expected
        assert clamped is not None
        # 不变量：validator 的四条要求恒成立
        assert 1_000_000 <= clamped[0] < clamped[1] <= 2_000_000

    def test_clamp_word_us_drops_unfittable_word(self) -> None:
        # segment 只剩 1µs：任何词都放不下，必须丢弃而不是产出非法区间
        assert _clamp_word_us(1_000_000, 1_000_001, 1_000_000, 1_000_000) == (
            1_000_000,
            1_000_001,
        )
        # 退化区间（end <= start）无解 → None
        assert _clamp_word_us(1_000_000, 1_000_000, 1_000_000, 1_000_000) is None

    def test_out_of_range_whisper_word_does_not_fail_save(self, tmp_path: Path) -> None:
        """回归：越界词时间码不得让整次转录失败（真实 app 段 23 现场）。"""
        repo, _ = _repo(tmp_path)
        result = TranscriptResult(
            language="zh",
            duration_us=3_000_000,
            segments=(
                TranscriptSegmentResult(
                    start_us=1_000_000,
                    end_us=2_000_000,
                    text="越界词",
                    confidence=None,
                    words=(TranscriptWordResult(1_100_000, 1_300_000, "好", 0.9),),
                ),
            ),
        )
        saved = repo.save_ready("asset_1", "fp_1", "provider", "model", "rev", result)
        assert saved["status"] == "ready"
        # 模拟 adapter 的钳制路径产出合法词
        clamped = _clamp_word_us(1_000_000, 2_000_000, 2_400_000, 2_500_000)
        assert clamped is not None and clamped[0] < clamped[1]

    def test_list_for_asset_marks_stale(self, tmp_path: Path):
        repo, _ = _repo(tmp_path)
        saved = repo.save_ready("asset_1", "fp_old", "provider", "model", "rev", _sample_result())
        items, next_cursor = repo.list_for_asset("asset_1", "fp_new")
        assert len(items) == 1
        assert items[0]["transcript_id"] == saved["transcript_id"]
        assert items[0]["status"] == "stale"
        assert next_cursor is None

    def test_find_ready_reuses_matching(self, tmp_path: Path):
        repo, _ = _repo(tmp_path)
        repo.save_ready("asset_1", "fp_1", "provider", "model", "rev", _sample_result())
        match = repo.find_ready("asset_1", "fp_1", "model", "rev", require_words=True)
        assert match is not None
        assert match["source_media_fingerprint"] == "fp_1"
        # different fingerprint -> no match
        assert repo.find_ready("asset_1", "fp_2", "model", "rev", require_words=True) is None

    def test_mark_asset_stale_updates_rows(self, tmp_path: Path):
        repo, _ = _repo(tmp_path)
        repo.save_ready("asset_1", "fp_1", "provider", "model", "rev", _sample_result())
        repo.mark_asset_stale("asset_1", "fp_2")
        items, _ = repo.list_for_asset("asset_1", "fp_2")
        assert items[0]["status"] == "stale"

    def test_mark_asset_stale_all_when_no_fingerprint(self, tmp_path: Path):
        repo, _ = _repo(tmp_path)
        repo.save_ready("asset_1", "fp_1", "provider", "model", "rev", _sample_result())
        repo.mark_asset_stale("asset_1", None)
        items, _ = repo.list_for_asset("asset_1", "fp_1")
        assert items[0]["status"] == "stale"
