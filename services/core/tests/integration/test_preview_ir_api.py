from __future__ import annotations

import subprocess
from pathlib import Path

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.database import sha256_file
from aivs_core.projects import modified_iso

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()
FFPROBE = Path("resources/ffmpeg/win-x64/ffprobe.exe").resolve()

DOCUMENT = {
    "schema_version": 1,
    "project_id": "proj-ir",
    "canvas": {"width": 1080, "height": 1920, "fps_num": 30, "fps_den": 1, "background_color": "#000000"},
    "tracks": [
        {"id": "V1", "kind": "video", "locked": False, "hidden": False, "muted": False, "solo": False},
        {"id": "A1", "kind": "audio", "locked": False, "hidden": False, "muted": False, "solo": False},
    ],
    "clips": [
        {"clip_id": "clipA", "track_id": "V1", "order_index": 0, "asset_id": "video-api",
         "asset_kind": "video", "source_start_us": 0, "source_end_us": 2_000_000,
         "timeline_start_us": 0, "timeline_end_us": 2_000_000, "layout": "fit",
         "audio": {"enabled": False, "gain_db": 0.0}},
        {"clip_id": "clipB", "track_id": "V1", "order_index": 1, "asset_id": "video-api",
         "asset_kind": "video", "source_start_us": 0, "source_end_us": 1_000_000,
         "timeline_start_us": 2_000_000, "timeline_end_us": 3_000_000, "layout": "fit",
         "audio": {"enabled": False, "gain_db": 0.0},
         "keyframes": {"position": {"frames": [
             {"t_us": 0, "x": -0.5, "y": 0.0}, {"t_us": 1_000_000, "x": 0.5, "y": 0.0}]}}},
    ],
    "captions": [],
    "provenance": {"created_by": "user", "source_transcript_ids": []},
}


def _app(tmp_path: Path, monkeypatch) -> tuple[TestClient, Settings]:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-m3p1")
    settings = Settings(
        data_dir=tmp_path,
        manifest_dir=tmp_path / "manifests",
        ffmpeg=FFMPEG,
        ffprobe=FFPROBE,
    )
    return TestClient(create_app(settings)), settings


def _ui(client: TestClient) -> dict[str, str]:
    response = client.post(
        "/api/v1/internal/sessions",
        headers={"Authorization": "Bearer admin-m3p1"},
    )
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _fixture_video(root: Path) -> Path:
    video = root / "video.mp4"
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-y", "-f", "lavfi", "-i",
         "color=c=blue:size=200x400:rate=30:duration=3",
         "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-an", str(video)],
        capture_output=True, timeout=120,
    )
    assert result.returncode == 0, result.stderr[-800:]
    return video


def _seed(client: TestClient, video: Path, *, mask: bool = False) -> str:
    database = client.app.state.core.db
    document = dict(DOCUMENT)
    if mask:
        document["clips"] = [dict(document["clips"][0], mask={"kind": "rect"})]
    with database.connection() as db:
        db.execute(
            "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
            "VALUES ('proj-ir','IR 项目','active','{}','rev-ir',?,?,'now','now','now')",
            (str(tmp_root(video)), str(tmp_root(video))),
        )
        stat = video.stat()
        fingerprint = sha256_file(video)
        db.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
            "VALUES ('video-api','proj-ir','video','external','video.mp4',?,"
            "?,?,'available',?,'now','now')",
            (fingerprint, stat.st_size, modified_iso(video),
             '{"duration_us": 3000000, "audio_streams": [], "video_streams": ['
             '{"width": 1920, "height": 1080, "sample_aspect_ratio": "1:1"}]}'),
        )
        db.execute(
            "INSERT INTO asset_locations(asset_id,uri,last_verified_at) VALUES ('video-api',?,?)",
            (video.as_uri(), modified_iso(video)),
        )
        import json as _json

        db.execute(
            "INSERT INTO timeline_revisions(id,project_id,parent_revision_id,schema_version,"
            "document_json,document_sha256,summary,created_by,created_at) "
            "VALUES ('rev-ir','proj-ir',NULL,1,?,'sha','ir test','user','now')",
            (_json.dumps(document, ensure_ascii=False),),
        )
    return "rev-ir"


def tmp_root(video: Path) -> str:
    return str(video.parent)


def test_preview_ir_endpoint(tmp_path: Path, monkeypatch) -> None:
    client, _settings = _app(tmp_path, monkeypatch)
    with client:
        ui = _ui(client)
        video = _fixture_video(tmp_path)
        _seed(client, video)

        response = client.get("/api/v1/projects/proj-ir/preview-ir", headers=ui)
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["schema_version"] == 1
        assert payload["timeline_revision_id"] == "rev-ir"
        ir = payload["ir"]
        assert ir["schema"] == "preview-ir-v1"
        assert ir["canvas"] == {"width": 960, "height": 540, "fps": 30,
                                "duration_frames": 90, "duration_us": 3_000_000,
                                "background": "#000000"}
        # 90 帧（3s），clipB 段落含位置关键帧数值表
        assert len(ir["frames"]) == 90
        assert ir["frames"][0]["main"]["kind"] == "segment"
        assert ir["frames"][45]["main"]["clip_id"] == "clipA"
        assert ir["frames"][75]["main"]["clip_id"] == "clipB"
        # 缓存命中：再次请求同一 fingerprint 内容一致
        again = client.get("/api/v1/projects/proj-ir/preview-ir", headers=ui).json()
        assert again["ir"]["frames"] == ir["frames"]

        # output_ratio 白名单：增量一仅 16:9
        bad = client.get("/api/v1/projects/proj-ir/preview-ir", params={"output_ratio": "916"}, headers=ui)
        assert bad.status_code == 400


def test_preview_ir_unsupported_feature_degrades(tmp_path: Path, monkeypatch) -> None:
    client, _settings = _app(tmp_path, monkeypatch)
    with client:
        ui = _ui(client)
        video = _fixture_video(tmp_path)
        _seed(client, video, mask=True)
        response = client.get("/api/v1/projects/proj-ir/preview-ir", headers=ui)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "PREVIEW_IR_UNSUPPORTED"
    assert "mask" in response.json()["error"]["message"]


def test_preview_ir_unknown_revision(tmp_path: Path, monkeypatch) -> None:
    client, _settings = _app(tmp_path, monkeypatch)
    with client:
        ui = _ui(client)
        video = _fixture_video(tmp_path)
        _seed(client, video)
        response = client.get("/api/v1/projects/proj-ir/preview-ir",
                              params={"timeline_revision_id": "rev-missing"}, headers=ui)
    assert response.status_code == 404
