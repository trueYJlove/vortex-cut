"""Wave1 L2：BGM 节拍分析作业化触发（route 前半段 Core 面）。

此前 BeatGridService 在全仓零调用方——beat_grids 在生产环境永远为空，
beat_sync 的 _signals_for 注入永远拿不到 beats（卡点干跑必失败）。本套
锁住「登记 → 执行 → 落库 → 注入」整链（真实 ffmpeg + 真实 click 素材）。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database, json_dumps, json_loads
from aivs_core.editing_grammar import EditingGrammarService
from aivs_core.jobs import JobService
from aivs_core.media.beat_grid import BEAT_ALGORITHM_VERSION
from aivs_core.media.beat_service import BeatGridService, parse_grid_payload
from aivs_core.projects import DomainError
from test_timeline import _create, _service

ROOT = Path(__file__).resolve().parents[4]
FFMPEG = ROOT / "resources/ffmpeg/win-x64/ffmpeg.exe"
EVAL_WAV = ROOT / "test-assets/generated/eval/music-110bpm.wav"


def _require_real_media() -> None:
    if not FFMPEG.is_file() or not EVAL_WAV.is_file():
        pytest.skip("bundled ffmpeg / eval click material unavailable")


def _seed_beat_asset(db: Database, fingerprint: str = "fp_bgm") -> dict[str, Any]:
    with db.connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) "
            "VALUES ('p1','P','active','{}','root','root','now','now','now')"
        )
        conn.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES ('v1','p1','audio','external','BGM',?,1,'available',"
            "'{}','now','now')",
            (fingerprint,),
        )
    return {"id": "v1", "fingerprint": fingerprint, "kind": "audio"}


class TestBeatJob:
    def test_create_registers_queued_job(self, tmp_path: Path) -> None:
        db = Database(tmp_path / "app.db")
        db.initialize()
        asset = _seed_beat_asset(db)
        media = tmp_path / "bgm.wav"
        media.write_bytes(b"fake-bytes")
        service = BeatGridService(db, FFMPEG)
        job_id = service.create_beat_job("p1", asset, str(media))
        with db.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        assert row["kind"] == "beat_analysis" and row["status"] == "queued"
        assert row["resource_class"] == "light"
        payload = json_loads(row["input_json"])
        assert payload["asset_id"] == "v1"
        assert payload["asset_fingerprint"] == "fp_bgm"
        assert payload["size_bytes"] == len(b"fake-bytes")

    def test_run_job_stat_guard(self, tmp_path: Path) -> None:
        db = Database(tmp_path / "app.db")
        db.initialize()
        asset = _seed_beat_asset(db)
        media = tmp_path / "bgm.wav"
        media.write_bytes(b"fake-bytes")
        service = BeatGridService(db, FFMPEG)
        service.create_beat_job("p1", asset, str(media))
        media.write_bytes(b"different-bytes-now")
        with db.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE kind='beat_analysis'").fetchone()
        with pytest.raises(DomainError) as exc:
            asyncio.run(service.run_beat_job(row, asyncio.Event()))
        assert exc.value.code == "MEDIA_CHANGED"

    def test_run_job_invalid_payload(self, tmp_path: Path) -> None:
        db = Database(tmp_path / "app.db")
        db.initialize()
        service = BeatGridService(db, FFMPEG)
        row = {"input_json": json_dumps({"unexpected": True})}
        with pytest.raises(DomainError) as exc:
            asyncio.run(service.run_beat_job(row, asyncio.Event()))
        assert exc.value.code == "BEAT_JOB_INVALID"

    def test_real_click_track_full_chain_into_prepare(self, tmp_path: Path) -> None:
        """L2 验收链：登记 → 执行（真实 ffmpeg PCM）→ beat_grids → prepare 注入。

        110 BPM click 素材（W0.4 评测样）：检测 BPM 误差 ≤5%、beat ≥2；
        随后 EditingGrammarService.prepare（bgm_asset_id=v1、params 不带
        beats_us）必须拿到注入的 beats 并产出非空操作。
        """
        _require_real_media()
        timeline, db = _service(tmp_path)
        state = _create(timeline)
        # 评测素材按真实指纹登记（_create 已落 asset v1，UPDATE 指纹即可）。
        import hashlib

        fingerprint = "sha256:" + hashlib.sha256(EVAL_WAV.read_bytes()).hexdigest()
        with db.connection() as conn:
            conn.execute("UPDATE assets SET fingerprint=? WHERE id='v1'", (fingerprint,))
        asset = {"id": "v1", "fingerprint": fingerprint, "kind": "audio"}
        service = BeatGridService(db, FFMPEG)
        job_id = service.create_beat_job("p1", asset, str(EVAL_WAV))
        with db.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        result = asyncio.run(service.run_beat_job(row, asyncio.Event()))
        assert result["status"] == "ready"
        assert result["bpm"] == pytest.approx(110.0, rel=0.05)
        assert result["beat_count"] >= 2

        # 注入半边（此前只有单测直插 beat_grids 行；这里用作业真实产物）。
        grammar = EditingGrammarService(db, timeline)
        params = {
            "target_duration_us": 4_000_000,
            "beats_per_shot": 2,
            "bgm_asset_id": "v1",
            "segments": [
                {"asset_id": "v1", "source_start_us": 0, "source_end_us": 2_000_000},
                {"asset_id": "v1", "source_start_us": 2_000_000, "source_end_us": 4_000_000},
            ],
        }
        signals = grammar._signals_for(state["current_revision"]["document"], params, "beat_sync")
        assert len(signals["beats_us"]) >= 2
        assert signals["beats_us"] == sorted(signals["beats_us"])
        preview = grammar.prepare(
            "p1",
            {"base_revision_id": state["current_revision"]["timeline_revision_id"],
             "planner": "beat_sync", "params": params},
        )
        assert preview["operations_count"] >= 1

    def test_signals_prefer_current_algorithm_version(self, tmp_path: Path) -> None:
        """版本过滤：旧版本网格不进注入（latest_beat_grid 同口径）。"""
        timeline, db = _service(tmp_path)
        grammar = EditingGrammarService(db, timeline)
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO beat_grids(id,asset_id,source_fingerprint,algorithm_version,"
                "status,bpm,lag_s,confidence,beats_json,downbeats_json,candidates_json,"
                "reason,model_revision,sample_rate,created_at,updated_at,finished_at) "
                "VALUES ('bg_old','v1','fp','999','ready',120,0.5,0.9,?,?,'[]',NULL,NULL,22050,'t0','t0','t0')",
                (json_dumps([0, 500_000]), json_dumps([0])),
            )
        signals = grammar._signals_for({}, {"bgm_asset_id": "v1"}, "beat_sync")
        assert signals == {}

    def test_beat_summary_stale(self, tmp_path: Path) -> None:
        db = Database(tmp_path / "app.db")
        db.initialize()
        _seed_beat_asset(db)
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO beat_grids(id,asset_id,source_fingerprint,algorithm_version,"
                "status,bpm,lag_s,confidence,beats_json,downbeats_json,candidates_json,"
                "reason,model_revision,sample_rate,created_at,updated_at,finished_at) "
                "VALUES ('bg1','v1','fp_other',?,'ready',120,0.5,0.9,?,?,'[]',NULL,NULL,22050,'t0','t0','t0')",
                (BEAT_ALGORITHM_VERSION, json_dumps([0, 500_000]), json_dumps([0])),
            )
        service = BeatGridService(db, FFMPEG)
        summary = service.beat_summary({"id": "v1", "fingerprint": "fp_bgm", "kind": "audio"})
        assert summary is not None and summary["status"] == "stale"
        assert summary["beat_count"] == 2

    def test_parse_grid_payload_roundtrip(self, tmp_path: Path) -> None:
        db = Database(tmp_path / "app.db")
        db.initialize()
        _seed_beat_asset(db)
        service = BeatGridService(db, FFMPEG)
        result = service.analyze_samples("v1", "fp_bgm", _click_pcm())
        with db.connection() as conn:
            row = conn.execute("SELECT * FROM beat_grids WHERE id=?", (result["beat_grid_id"],)).fetchone()
        parsed = parse_grid_payload(dict(row))
        assert parsed["beats_us"] == result["beats_us"]
        assert parsed["downbeats_us"] == result["downbeats_us"]


def _click_pcm(sr: int = 22050, bpm: float = 110.0, seconds: float = 8.0) -> Any:
    import numpy as np

    total = int(sr * seconds)
    pcm = np.zeros(total, dtype=np.float64)
    period = int(sr * 60.0 / bpm)
    for beat in range(total // period + 1):
        start = beat * period
        for k in range(min(400, total - start)):
            pcm[start + k] = (1.0 - k / 400) * 0.8
    return pcm


class TestJobsDispatch:
    def test_run_media_dispatches_beat_kind(self, tmp_path: Path) -> None:
        """jobs._run_media 按 kind=beat_analysis 分派（result_json 落库）。"""
        from aivs_core.media.ffprobe import FFprobe
        from aivs_core.media.encoders import EncoderDetector

        db = Database(tmp_path / "app.db")
        db.initialize()
        _seed_beat_asset(db)
        state: dict[str, Any] = {}

        async def emit(_event: dict[str, Any]) -> None:
            return None

        async def fake_beat_runner(row, cancel_event, progress, stage) -> dict[str, Any]:
            state["called"] = json.loads(row["input_json"])
            return {"beat_grid_id": "bg_x", "status": "ready", "bpm": 110.0, "beat_count": 30}

        class FakeProbe:
            async def probe(self, path: Path) -> dict[str, Any]:
                return {"audio_streams": [], "duration_us": 1}

        class FakeEncoders:
            async def choose(self, mode: str) -> tuple[str, None]:
                return "libx264", None

        service = JobService(
            db, tmp_path, FFMPEG, FakeProbe(), FakeEncoders(), emit,
            beat_runner=fake_beat_runner,
        )
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO jobs (id,project_id,kind,type,status,stage,progress,input_json,"
                "encoder_requested,attempt,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                ("job_beat", "p1", "beat_analysis", "beat_analysis", "running", "running", 0,
                 json_dumps({"asset_id": "v1", "path": "x"}), None, 1,
                 "2026-10-10T00:00:00", "2026-10-10T00:00:00"),
            )
            row = conn.execute("SELECT * FROM jobs WHERE id='job_beat'").fetchone()
        asyncio.run(service._run_media(row, "job_beat", asyncio.Event()))
        assert state["called"]["asset_id"] == "v1"
        with db.connection() as conn:
            saved = conn.execute("SELECT result_json FROM jobs WHERE id='job_beat'").fetchone()
        assert json_loads(saved["result_json"])["status"] == "ready"
