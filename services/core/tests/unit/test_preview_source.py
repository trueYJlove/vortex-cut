"""B11 preview-source 服务层单测（描述/缓存查询/作业登记/作业执行）。

覆盖（计划第 6 节 B11）：
- describe：auto/proxy/original 三模式几何与时间映射字段；代理 ready 时
  coded 几何 = 档位尺寸、rotation 烘焙、fps=30；无视频流域错误。
- 缓存键：profile → params 白名单；FFmpeg build 入工具链指纹（B10 报告
  已知限制清偿）；无 build 时占位不静默复用。
- 作业登记：kind=proxy 载荷带 cache_key（旧 sample 载荷不带——分派安全）。
- 作业执行：probe → begin_build → 转码 → commit_ready 全链（FFmpeg 假件）；
  失败 mark_failed；single-flight already-ready 短路。
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.media.derived_cache import DerivedMediaCache
from aivs_core.media.preview_source import (
    PreviewSourceService,
    ProxyBuildError,
)


def _db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "b11.db")
    db.initialize()
    return db


def _seed_asset(db: Database) -> dict[str, Any]:
    """插入一条 1920x1080 h264 素材行（含 media_info_json；先建属主项目）。"""
    now = "2026-09-09T00:00:00"
    media_info = {
        "duration_us": 12_000_000,
        "video_streams": [{
            "index": 0, "codec": "h264", "width": 1920, "height": 1080,
            "sample_aspect_ratio_num": 1, "sample_aspect_ratio_den": 1,
            "avg_frame_rate_num": 30, "avg_frame_rate_den": 1,
            "rotation": 0,
        }],
        "audio_streams": [],
    }
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects (id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("p1", "B11", "active", "{}", None, "/tmp/p1", "p1", now, now, now),
        )
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("asset_b11", "p1", "video", "external", "源.mp4", "sha256:" + "a" * 64,
             1024, "12345", "available", json_dumps(media_info), now, now),
        )
        row = conn.execute("SELECT * FROM assets WHERE id='asset_b11'").fetchone()
    return dict(row)


def _service(db: Database, tmp_path: Path, ffmpeg_build: str = "ffmpeg version 7.0") -> PreviewSourceService:
    return PreviewSourceService(
        db,
        DerivedMediaCache(db, tmp_path / "cache"),
        Path("ffmpeg"),
        _FakeProbe(),
        _FakeEncoders(),
        ffmpeg_build=ffmpeg_build,
    )


class _FakeProbe:
    async def probe(self, path: Path) -> dict[str, Any]:
        return {
            "duration_us": 12_000_000,
            "video_streams": [{
                "index": 0, "codec": "h264", "width": 1920, "height": 1080,
                "sample_aspect_ratio_num": 1, "sample_aspect_ratio_den": 1,
                "avg_frame_rate_num": 30, "avg_frame_rate_den": 1, "rotation": 0,
            }],
            "audio_streams": [],
        }


class _FakeEncoders:
    async def choose(self, mode: str) -> tuple[str, None]:
        return "libx264", None


class _FakeRenderMedia:
    """render_media 替身：记录参数并生成产物文件。"""

    calls: list[list[str]] = []

    async def __call__(self, ffmpeg, ffprobe, args, output, expected_us, cancel_event, progress):
        type(self).calls.append(list(args))
        output.write_bytes(b"proxy-output-bytes")
        return {"media_info": {}, "sha256": "x" * 64, "size_bytes": output.stat().st_size}


@pytest.fixture()
def fake_render(monkeypatch: pytest.MonkeyPatch) -> type[_FakeRenderMedia]:
    _FakeRenderMedia.calls = []
    monkeypatch.setattr("aivs_core.media.preview_source.render_media", _FakeRenderMedia())
    return _FakeRenderMedia


class TestDescribe:
    def test_original_mode_geometry_and_authority(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        asset = _seed_asset(db)
        entry = service.describe(asset, "original")
        assert entry["mode"] == "original"
        assert entry["status"] == "ready"
        assert entry["coded_width"] == 1920 and entry["coded_height"] == 1080
        assert entry["source_origin_us"] == 0
        assert entry["duration_us"] == 12_000_000
        assert entry["profile_id"] == "preview-720-v1"  # 1080p 源默认 720 档（预算）
        assert entry["fps_num"] == 30 and entry["fps_den"] == 1

    def test_proxy_mode_pending_without_entry(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        asset = _seed_asset(db)
        entry = service.describe(asset, "proxy")
        assert entry["status"] == "pending"
        assert entry["source_id"].endswith("_proxy")
        assert entry["cache_key"] is None  # 无条目

    def test_proxy_mode_ready_uses_profile_geometry(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        asset = _seed_asset(db)
        # 造 ready 条目
        key = service.proxy_cache_key(asset["fingerprint"], "preview-720-v1")
        root = service.derived_cache.begin_build(
            key, str(asset["fingerprint"]), "video_proxy",
            service.proxy_params("preview-720-v1"), service.toolchain_fingerprint(),
        )
        assert root is not None
        (root / "proxy.mp4").write_bytes(b"ready")
        service.derived_cache.commit_ready(key, "video_proxy", root / "proxy.mp4")
        entry = service.describe(
            asset, "proxy",
            proxy=service.proxy_entry(asset, "preview-720-v1"),
        )
        assert entry["status"] == "ready"
        assert (entry["coded_width"], entry["coded_height"]) == (1280, 720)
        assert entry["rotation"] == 0
        assert entry["fps_num"] == 30 and entry["fps_den"] == 1
        assert entry["codec"] == "avc"
        assert entry["cache_key"] == key

    def test_auto_mode_falls_back_to_original_until_ready(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        asset = _seed_asset(db)
        # auto + 无代理 → 原源 ready（不等待代理）；mode 回显生效模式 original
        entry = service.describe(asset, "auto")
        assert entry["mode"] == "original" and entry["status"] == "ready"
        # auto + 代理 ready → 代理
        key = service.proxy_cache_key(asset["fingerprint"], "preview-720-v1")
        root = service.derived_cache.begin_build(
            key, str(asset["fingerprint"]), "video_proxy",
            service.proxy_params("preview-720-v1"), service.toolchain_fingerprint(),
        )
        assert root is not None
        (root / "proxy.mp4").write_bytes(b"r")
        service.derived_cache.commit_ready(key, "video_proxy", root / "proxy.mp4")
        entry = service.describe(asset, "auto", proxy=service.proxy_entry(asset, "preview-720-v1"))
        assert entry["mode"] == "proxy" and entry["status"] == "ready"

    def test_no_video_stream_raises(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        asset = _seed_asset(db)
        asset["media_info_json"] = json_dumps({"video_streams": [], "audio_streams": []})
        from aivs_core.projects import DomainError

        with pytest.raises(DomainError):
            service.describe(asset, "auto")

    def test_invalid_mode_raises(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        asset = _seed_asset(db)
        from aivs_core.projects import DomainError

        with pytest.raises(DomainError):
            service.describe(asset, "bogus")


class TestCacheKey:
    def test_profile_whitelisted(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        from aivs_core.projects import DomainError

        with pytest.raises(DomainError):
            service.proxy_params("preview-999-v1")

    def test_ffmpeg_build_in_toolchain_fingerprint(self, tmp_path: None | Any) -> None:
        tmp = tmp_path if isinstance(tmp_path, Path) else Path(str(tmp_path))
        db = _db(tmp)
        a = _service(db, tmp, ffmpeg_build="ffmpeg version 7.0")
        b = _service(db, tmp, ffmpeg_build="ffmpeg version 8.0")
        asset = _seed_asset(db)
        key_a = a.proxy_cache_key(asset["fingerprint"], "preview-720-v1")
        key_b = b.proxy_cache_key(asset["fingerprint"], "preview-720-v1")
        assert key_a != key_b  # FFmpeg 更换即键换代（B10 报告已知限制清偿）

    def test_profile_changes_key(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        asset = _seed_asset(db)
        k540 = service.proxy_cache_key(asset["fingerprint"], "preview-540-v1")
        k720 = service.proxy_cache_key(asset["fingerprint"], "preview-720-v1")
        assert k540 != k720


class TestProxyEntry:
    def test_no_entry_returns_none(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        asset = _seed_asset(db)
        assert service.proxy_entry(asset, "preview-720-v1") is None

    def test_entry_status_roundtrip(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        asset = _seed_asset(db)
        key = service.proxy_cache_key(asset["fingerprint"], "preview-720-v1")
        root = service.derived_cache.begin_build(
            key, str(asset["fingerprint"]), "video_proxy",
            service.proxy_params("preview-720-v1"), service.toolchain_fingerprint(),
        )
        assert root is not None
        entry = service.proxy_entry(asset, "preview-720-v1")
        assert entry is not None and entry["status"] == "building"


class TestCreateProxyJob:
    def test_job_payload_carries_cache_key(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        asset = _seed_asset(db)
        source = tmp_path / "源.mp4"
        source.write_bytes(b"input")
        payload_mod = int(asset["modified_at"] or 0)
        job_id = service.create_proxy_job(
            "p1", {**asset, "modified_at": payload_mod}, "preview-720-v1", str(source),
        )
        with db.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        assert row is not None
        assert row["kind"] == "proxy" and row["status"] == "queued"
        assert row["asset_id"] == "asset_b11"
        payload = json.loads(row["input_json"])
        assert payload["cache_key"].startswith("sha256:")
        assert payload["profile_id"] == "preview-720-v1"
        assert payload["path"] == str(source)


class TestRunProxyJob:
    def _job_row(self, db: Database, tmp_path: Path, asset: dict[str, Any],
                 service: PreviewSourceService) -> Any:
        source = tmp_path / "源.mp4"
        source.write_bytes(b"input")
        job_id = service.create_proxy_job(
            "p1", asset, "preview-720-v1", str(source),
        )
        with db.connection() as conn:
            return conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()

    @pytest.mark.asyncio
    async def test_full_pipeline_commits_ready(
        self, tmp_path: Path, fake_render: type[_FakeRenderMedia],
    ) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        asset = _seed_asset(db)
        source = tmp_path / "源.mp4"
        source.write_bytes(b"input")
        # modified_at 对齐真实 stat（run 校验 size/mtime）
        import os

        asset = {**asset, "modified_at": 0}
        job_id = service.create_proxy_job("p1", asset, "preview-720-v1", str(source))
        with db.connection() as conn:
            conn.execute(
                "UPDATE jobs SET input_json=? WHERE id=?",
                (json_dumps({
                    "asset_id": "asset_b11", "profile_id": "preview-720-v1",
                    "cache_key": service.proxy_cache_key(
                        asset["fingerprint"], "preview-720-v1"),
                    "asset_fingerprint": asset["fingerprint"],
                    "path": str(source),
                    "size_bytes": source.stat().st_size,
                    "modified_at": source.stat().st_mtime_ns,
                }), job_id),
            )
        with db.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        result = await service.run_proxy_job(row, asyncio.Event())
        assert result["status"] == "ready"
        # 产物落缓存：lookup 命中 ready
        entry = service.derived_cache.lookup(result["cache_key"])
        assert entry is not None and entry.status == "ready"
        assert entry.size_bytes > 0
        # FFmpeg 参数：全源（无 -t）+ 720 档尺寸
        args = fake_render.calls[0]
        assert "-t" not in args
        assert "scale=1280:720" in args[args.index("-vf") + 1]
        assert os.sep not in result["cache_key"]

    @pytest.mark.asyncio
    async def test_failure_marks_failed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        asset = _seed_asset(db)
        source = tmp_path / "源.mp4"
        source.write_bytes(b"input")
        key = service.proxy_cache_key(asset["fingerprint"], "preview-720-v1")
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO jobs (id,project_id,asset_id,kind,type,status,stage,progress,"
                "input_json,encoder_requested,resource_class,attempt,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("job_fail", "p1", "asset_b11", "proxy", "proxy", "running", "running", 0,
                 json_dumps({
                     "asset_id": "asset_b11", "profile_id": "preview-720-v1",
                     "cache_key": key, "asset_fingerprint": asset["fingerprint"],
                     "path": str(source),
                     "size_bytes": source.stat().st_size,
                     "modified_at": source.stat().st_mtime_ns,
                 }), "auto", "render", 1, "2026-09-09T00:00:00", "2026-09-09T00:00:00"),
            )
        with db.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id='job_fail'").fetchone()

        async def broken_render(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
            raise RuntimeError("FFMPEG_FAILED: boom")

        monkeypatch.setattr("aivs_core.media.preview_source.render_media", broken_render)
        with pytest.raises(RuntimeError):
            await service.run_proxy_job(row, asyncio.Event())
        entry = service.proxy_entry(asset, "preview-720-v1")
        assert entry is not None and entry["status"] == "failed"

    @pytest.mark.asyncio
    async def test_non_proxy_payload_rejected(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        row = {"input_json": json_dumps({"media_id": "m1", "path": "x"})}
        with pytest.raises(ProxyBuildError):
            await service.run_proxy_job(row, asyncio.Event())

    @pytest.mark.asyncio
    async def test_already_ready_short_circuits(
        self, tmp_path: Path, fake_render: type[_FakeRenderMedia],
    ) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path)
        asset = _seed_asset(db)
        # 先造 ready 条目
        key = service.proxy_cache_key(asset["fingerprint"], "preview-720-v1")
        root = service.derived_cache.begin_build(
            key, str(asset["fingerprint"]), "video_proxy",
            service.proxy_params("preview-720-v1"), service.toolchain_fingerprint(),
        )
        assert root is not None
        (root / "proxy.mp4").write_bytes(b"ready")
        service.derived_cache.commit_ready(key, "video_proxy", root / "proxy.mp4")
        row = {"input_json": json_dumps({
            "asset_id": "asset_b11", "profile_id": "preview-720-v1", "cache_key": key,
            "path": str(tmp_path / "源.mp4"),  # already-ready 短路前仍校验路径存在
        })}
        (tmp_path / "源.mp4").write_bytes(b"src")
        result = await service.run_proxy_job(row, asyncio.Event())
        assert result["status"] == "already-ready"
        assert fake_render.calls == []  # 不重复转码


class TestJobsDispatch:
    def test_run_media_branches_on_cache_key(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """jobs._run_media 按 input_json.cache_key 分派 B11 代理（载荷分界）。"""
        from aivs_core.jobs import JobService

        db = _db(tmp_path)
        state: dict[str, Any] = {}
        _seed_asset(db)  # jobs.project_id 外键需要属主项目行

        class FakeEncoders:
            async def choose(self, mode: str) -> tuple[str, None]:
                return "libx264", None

        class FakeProbe:
            async def probe(self, path: Path) -> dict[str, Any]:
                return {"audio_streams": [], "duration_us": 1}

        async def emit(_event: dict[str, Any]) -> None:
            return None

        async def fake_proxy_runner(row, cancel_event, progress, stage) -> dict[str, Any]:
            state["called"] = json.loads(row["input_json"])
            return {"cache_key": "sha256:" + "b" * 64, "status": "ready"}

        service = JobService(
            db, tmp_path, Path("ffmpeg"), FakeProbe(), FakeEncoders(), emit,
            preview_source_runner=fake_proxy_runner,
        )
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO jobs (id,project_id,kind,type,status,stage,progress,input_json,"
                "encoder_requested,attempt,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                ("job_b11", "p1", "proxy", "proxy", "running", "running", 0,
                 json_dumps({"cache_key": "sha256:" + "b" * 64, "profile_id": "preview-720-v1"}),
                 "auto", 1, "2026-09-09T00:00:00", "2026-09-09T00:00:00"),
            )
        with db.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id='job_b11'").fetchone()

        async def fake_render_media(*_a: Any, **_k: Any) -> dict[str, Any]:
            raise AssertionError("旧 sample 路径不应被触达")

        monkeypatch.setattr("aivs_core.jobs.render_media", fake_render_media)
        asyncio.run(service._run_media(row, "job_b11", asyncio.Event()))
        assert state["called"]["cache_key"].startswith("sha256:")
        with db.connection() as conn:
            saved = conn.execute(
                "SELECT result_json FROM jobs WHERE id='job_b11'").fetchone()
        assert json.loads(saved["result_json"])["status"] == "ready"
