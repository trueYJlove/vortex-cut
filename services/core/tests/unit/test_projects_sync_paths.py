"""素材同步校验路径（resolve_asset_path/current_source）真实文件回归。

背景：A05a 将 async 入口的哈希搬后台后，误删 `from .database import sha256_file`，
resolve_asset_path/current_source 两处同步调用点 NameError。Core 单测原先
只测域错误分支（ASSET_MISSING/ASSET_CHANGED 早抛，不打到哈希行），完整 App
冒烟（preview-ir:get → resolve_asset_path）才暴露。此文件以真实文件 +
正确指纹走完整路径，防同类 import 剥离再漏网。
"""
from __future__ import annotations

import json
from pathlib import Path

from aivs_core.database import Database, json_dumps, sha256_file
from aivs_core.projects import ProjectAssetService, modified_iso

NOW = "2026-01-01T00:00:00Z"


def _service(tmp_path: Path) -> tuple[ProjectAssetService, Path, Path]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    media = tmp_path / "素材.mp4"
    media.write_bytes(b"stable-media-bytes")
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("p1", "n", "active", json.dumps({"width": 1080, "height": 1920, "fps": 30}),
             str(tmp_path), "t", NOW, NOW, NOW),
        )
        conn.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("a1", "p1", "video", "external", media.name, sha256_file(media),
             media.stat().st_size, modified_iso(media), "available",
             json_dumps({"duration_us": 1_000_000, "video_streams": [{}], "audio_streams": []}),
             NOW, NOW),
        )
        conn.execute(
            "INSERT INTO asset_locations(asset_id,uri,last_verified_at) VALUES (?,?,?)",
            ("a1", media.as_uri(), NOW),
        )

    async def stub_probe(path: Path, **kwargs: object) -> dict[str, object]:
        return {}

    return ProjectAssetService(db, tmp_path, stub_probe), media, tmp_path / "app.db"


def test_resolve_asset_path_success_on_real_file(tmp_path: Path) -> None:
    """正确指纹/真实文件：resolve 不 NameError，返回解析路径（原 A05a 回归点）。"""
    service, media, _ = _service(tmp_path)
    resolved = service.resolve_asset_path("a1")
    assert resolved == {"asset_id": "a1", "path": str(media.resolve())}


def test_current_source_success_on_real_file(tmp_path: Path) -> None:
    """current_source 同一同步哈希路径：可用素材回指纹并标 available（原 A05a 回归点）。"""
    service, media, _ = _service(tmp_path)
    dto, uri, fingerprint = service.current_source("a1")
    assert dto["availability"] == "available"
    assert uri == media.as_uri()
    assert fingerprint == sha256_file(media)


def test_resolve_asset_path_detects_file_change(tmp_path: Path) -> None:
    """文件字节变化：指纹不匹配 → ASSET_CHANGED（同步哈希行真实执行后比较）。"""
    service, media, _ = _service(tmp_path)
    media.write_bytes(b"changed-media-bytes")
    # size/mtime 同步更新，避开 stat 早退分支，强制走到指纹比较
    from aivs_core.database import Database as _Database

    db = _Database(tmp_path / "app.db")
    with db.connection() as conn:
        conn.execute(
            "UPDATE assets SET size_bytes=?, modified_at=? WHERE id='a1'",
            (media.stat().st_size, modified_iso(media)),
        )
    try:
        service.resolve_asset_path("a1")
        raise AssertionError("expected ASSET_CHANGED")
    except Exception as exc:  # DomainError
        assert getattr(exc, "code", None) == "ASSET_CHANGED"
