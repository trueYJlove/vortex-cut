from __future__ import annotations

import json
from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.transcription import (
    TranscriptRepository,
    TranscriptionError,
)


def _db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("p1", "p", "active", "{}", "r", "r", "n", "n", "n"),
        )
        conn.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ("a1", "p1", "video", "external", "x", "sha256:" + "a" * 64, 1, "available", "{}", "n", "n"),
        )
    return db


def _seed_transcript(db: Database, transcript_id: str, segment_id: str) -> None:
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO transcripts VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (transcript_id, "a1", "ready", "zh", "local", "m", "r", "sha256:" + "a" * 64, 1_000_000, "n", "n"),
        )
        conn.execute(
            "INSERT INTO transcript_segments VALUES (?,?,?,?,?,?,?)",
            (segment_id, transcript_id, 0, 0, 1_000_000, "hi", 0.9),
        )
        conn.execute(
            "INSERT INTO transcript_words VALUES (?,?,?,?,?,?,?)",
            (f"w_{segment_id}", segment_id, 0, 0, 500_000, "hi", 0.9),
        )


def _seed_revision_referencing(db: Database, revision_id: str, segment_ids: list[str]) -> None:
    """建一条引用给定片段的 transcript 字幕 Revision（不可变，只能新建）。"""
    document = {
        "captions": [
            {
                "caption_id": f"c_{revision_id}",
                "track_id": "C1",
                "source_clip_id": None,
                "start_us": 0,
                "end_us": 1000,
                "text": "t",
                "preset_id": "default-bottom",
                "origin": "transcript",
                "edited": False,
                "source_segment_ids": segment_ids,
            }
        ]
    }
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO timeline_revisions(id,project_id,schema_version,document_json,"
            "document_sha256,summary,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (revision_id, "p1", 1, json_dumps(document), "sha256:" + "b" * 64, "", "test", "n"),
        )


def test_delete_removes_transcript_segments_and_words(tmp_path: Path) -> None:
    db = _db(tmp_path)
    _seed_transcript(db, "t1", "s1")
    repo = TranscriptRepository(db)
    repo.delete("t1")
    with db.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM transcripts").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM transcript_segments").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM transcript_words").fetchone()[0] == 0


def test_delete_refuses_when_segments_referenced_by_timeline(tmp_path: Path) -> None:
    """仍被时间线字幕引用时 fail-closed，避免字幕永久失去来源片段。"""
    db = _db(tmp_path)
    _seed_transcript(db, "t1", "s1")
    _seed_revision_referencing(db, "r1", ["s1"])
    repo = TranscriptRepository(db)
    with pytest.raises(TranscriptionError) as exc:
        repo.delete("t1")
    assert exc.value.code == "TRANSCRIPTION_IN_USE"
    with db.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM transcripts").fetchone()[0] == 1


def test_delete_allows_unrelated_segment_reference(tmp_path: Path) -> None:
    """引用的是**别的**转录片段时不得误拒（只有交集的片段才拦）。"""
    db = _db(tmp_path)
    _seed_transcript(db, "t1", "s1")
    _seed_transcript(db, "t2", "s2")
    _seed_revision_referencing(db, "r1", ["s2"])
    repo = TranscriptRepository(db)
    repo.delete("t1")  # t1 的 s1 未被引用
    with db.connection() as conn:
        assert [row[0] for row in conn.execute("SELECT id FROM transcripts")] == ["t2"]
    with pytest.raises(TranscriptionError) as exc:
        repo.delete("t2")
    assert exc.value.code == "TRANSCRIPTION_IN_USE"


def test_delete_unknown_transcript_reports_not_found(tmp_path: Path) -> None:
    repo = TranscriptRepository(_db(tmp_path))
    with pytest.raises(TranscriptionError) as exc:
        repo.delete("missing")
    assert exc.value.code == "TRANSCRIPTION_NOT_FOUND"


def test_delete_also_honours_timeline_drafts(tmp_path: Path) -> None:
    """草稿同样算引用（草稿提交后会成为 Revision）。"""
    db = _db(tmp_path)
    _seed_transcript(db, "t1", "s1")
    document = {
        "captions": [
            {
                "caption_id": "c1",
                "track_id": "C1",
                "source_clip_id": None,
                "start_us": 0,
                "end_us": 1000,
                "text": "t",
                "preset_id": "default-bottom",
                "origin": "transcript",
                "edited": False,
                "source_segment_ids": ["s1"],
            }
        ]
    }
    # drafts.base_revision_id 是外键，先建基线 Revision（其 captions 为空）。
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO timeline_revisions(id,project_id,schema_version,document_json,"
            "document_sha256,summary,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)",
            ("r_base", "p1", 1, json_dumps({"captions": []}), "sha256:" + "c" * 64, "", "test", "n"),
        )
        conn.execute(
            "INSERT INTO timeline_drafts(project_id,base_revision_id,document_json,"
            "updated_at) VALUES (?,?,?,?)",
            ("p1", "r_base", json_dumps(document), "n"),
        )
    repo = TranscriptRepository(db)
    with pytest.raises(TranscriptionError) as exc:
        repo.delete("t1")
    assert exc.value.code == "TRANSCRIPTION_IN_USE"
