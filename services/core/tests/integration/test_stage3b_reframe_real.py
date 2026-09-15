from __future__ import annotations

import hashlib
import json
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.database import Database

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()
FFPROBE = Path("resources/ffmpeg/win-x64/ffprobe.exe").resolve()
FONT_DIR = Path("resources/fonts").resolve()


def _ffmpeg(*args: str, timeout: int = 180) -> bytes:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", *args],
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError("STAGE3B_REAL_FFMPEG_FAILED")
    return result.stdout


def _probe(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        [str(FFPROBE), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError("STAGE3B_REAL_FFPROBE_FAILED")
    return json.loads(result.stdout)


def _fixture(path: Path, *, portrait: bool) -> None:
    if portrait:
        filters = (
            "color=c=red:s=540x320:d=1[top];"
            "color=c=green:s=540x320:d=1[mid];"
            "color=c=blue:s=540x320:d=1[bottom];"
            "[top][mid][bottom]vstack=inputs=3,format=yuv420p[v]"
        )
    else:
        filters = (
            "color=c=red:s=320x540:d=1[left];"
            "color=c=green:s=320x540:d=1[mid];"
            "color=c=blue:s=320x540:d=1[right];"
            "[left][mid][right]hstack=inputs=3,format=yuv420p[v]"
        )
    _ffmpeg(
        "-filter_complex",
        filters,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:sample_rate=48000:duration=1",
        "-map",
        "[v]",
        "-map",
        "0:a",
        "-r",
        "30",
        "-c:v",
        "libopenh264",
        "-b:v",
        "2M",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-shortest",
        str(path),
    )
    stream = next(item for item in _probe(path)["streams"] if item["codec_type"] == "video")
    expected = (540, 960) if portrait else (960, 540)
    assert (int(stream["width"]), int(stream["height"])) == expected


def _wait_job(client: TestClient, ui: dict[str, str], job_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/jobs/{job_id}", headers=ui)
        assert response.status_code == 200
        job = response.json()
        if job["status"] in {"succeeded", "failed", "cancelled", "interrupted"}:
            return job
        time.sleep(0.1)
    raise AssertionError("STAGE3B_REAL_JOB_TIMEOUT")


def _wait_batch(
    client: TestClient, ui: dict[str, str], batch_id: str, terminal: set[str]
) -> dict[str, Any]:
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/reframe-export-batches/{batch_id}", headers=ui)
        assert response.status_code == 200
        batch = response.json()
        if batch["status"] in terminal:
            return batch
        time.sleep(0.1)
    raise AssertionError("STAGE3B_REAL_BATCH_TIMEOUT")


def _mean_rgb(path: Path, second: float) -> tuple[float, float, float]:
    frame = _ffmpeg(
        "-ss",
        f"{second:.3f}",
        "-i",
        str(path),
        "-frames:v",
        "1",
        "-vf",
        "scale=24:24",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "-",
    )
    assert len(frame) == 24 * 24 * 3
    return tuple(sum(frame[index::3]) / (24 * 24) for index in range(3))  # type: ignore[return-value]


def _dominant(path: Path, second: float) -> str:
    values = _mean_rgb(path, second)
    return ("red", "green", "blue")[max(range(3), key=values.__getitem__)]


def _assert_output(path: Path, width: int, height: int) -> dict[str, Any]:
    probe = _probe(path)
    video = next(item for item in probe["streams"] if item["codec_type"] == "video")
    audio = next(item for item in probe["streams"] if item["codec_type"] == "audio")
    assert video["codec_name"] == "h264"
    assert (int(video["width"]), int(video["height"])) == (width, height)
    assert video["pix_fmt"] == "yuv420p"
    assert video["avg_frame_rate"] == "30/1"
    assert video.get("sample_aspect_ratio", "1:1") == "1:1"
    assert audio["codec_name"] == "aac"
    assert int(audio["sample_rate"]) == 48000
    assert int(audio["channels"]) == 2
    _ffmpeg("-v", "error", "-i", str(path), "-f", "null", "-")
    return probe


def _auth(client: TestClient, admin_token: str) -> tuple[dict[str, str], dict[str, str]]:
    admin = {"Authorization": f"Bearer {admin_token}"}
    response = client.post("/api/v1/internal/sessions", headers=admin)
    assert response.status_code == 200
    return admin, {"Authorization": f"Bearer {response.json()['token']}"}


def _create_asset(
    client: TestClient,
    admin: dict[str, str],
    ui: dict[str, str],
    project_id: str,
    path: Path,
) -> str:
    grant = client.post(
        "/api/v1/internal/file-grants", headers=admin, json={"path": str(path.resolve())}
    )
    assert grant.status_code == 200
    imported = client.post(
        f"/api/v1/projects/{project_id}/assets",
        headers=ui,
        json={"grant_id": grant.json()["grant_id"], "kind": "video"},
    )
    assert imported.status_code == 201
    return imported.json()["asset_id"]


def _create_base_preview(
    client: TestClient,
    ui: dict[str, str],
    project_id: str,
    revision_id: str,
    rendition_id: str,
) -> dict[str, Any]:
    response = client.post(
        f"/api/v1/projects/{project_id}/rendition-previews",
        headers=ui,
        json={
            "timeline_revision_id": revision_id,
            "platform_preset_id": "generic",
            "rendition_preset_id": rendition_id,
            "layout_policy": "crop_fill_all",
            "encoder_mode": "software",
        },
    )
    assert response.status_code == 200
    job = _wait_job(client, ui, response.json()["job"]["job_id"])
    assert job["status"] == "succeeded"
    previews = client.get(
        f"/api/v1/projects/{project_id}/rendition-previews?limit=100", headers=ui
    ).json()["items"]
    return next(item for item in previews if item["rendition_preset_id"] == rendition_id)


def _create_reframe_preview(
    client: TestClient,
    ui: dict[str, str],
    project_id: str,
    base_snapshot_id: str,
    adjustment: dict[str, str],
) -> dict[str, Any]:
    response = client.post(
        f"/api/v1/projects/{project_id}/rendition-reframe-previews",
        headers=ui,
        json={
            "base_rendition_snapshot_id": base_snapshot_id,
            "adjustments": [adjustment],
            "encoder_mode": "software",
        },
    )
    assert response.status_code == 200
    result = response.json()
    if result["job"]:
        job = _wait_job(client, ui, result["job"]["job_id"])
        assert job["status"] == "succeeded"
    items = client.get(
        f"/api/v1/projects/{project_id}/rendition-reframe-previews?limit=100", headers=ui
    ).json()["items"]
    snapshot_id = (
        result["preview"]["rendition_reframe_snapshot_id"]
        if result["preview"]
        else next(
            item["rendition_reframe_snapshot_id"]
            for item in items
            if item["render_artifact_id"] == job["result"]["render_artifact_id"]
        )
    )
    return next(item for item in items if item["rendition_reframe_snapshot_id"] == snapshot_id)


def _artifact_path(client: TestClient, admin: dict[str, str], artifact_id: str) -> Path:
    response = client.get(f"/api/v1/internal/artifacts/{artifact_id}/resolve", headers=admin)
    assert response.status_code == 200
    return Path(response.json()["path"])


def test_stage3b_real_reframe_preview_batch_partial_retry_and_restart(
    tmp_path: Path, monkeypatch
) -> None:
    landscape = tmp_path / "landscape.mp4"
    portrait = tmp_path / "portrait.mp4"
    _fixture(landscape, portrait=False)
    _fixture(portrait, portrait=True)
    data_dir = tmp_path / "data"
    manifests = tmp_path / "manifests"
    manifests.mkdir()
    admin_token = "stage3b-real-admin"
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", admin_token)
    settings = Settings(
        data_dir=data_dir,
        ffmpeg=FFMPEG,
        ffprobe=FFPROBE,
        font_dir=FONT_DIR,
        manifest_dir=manifests,
    )
    project_id = ""
    revision_id = ""
    original_batch_id = ""
    preview_ids: set[str] = set()
    with TestClient(create_app(settings)) as client:
        admin, ui = _auth(client, admin_token)
        with client.app.state.core.db.connection() as db:
            provider_before = db.execute("SELECT COUNT(*) FROM provider_invocations").fetchone()[0]
        project = client.post(
            "/api/v1/projects", headers=ui, json={"name": "Stage 3B real acceptance"}
        )
        assert project.status_code == 201
        project_id = project.json()["project_id"]
        landscape_id = _create_asset(client, admin, ui, project_id, landscape)
        portrait_id = _create_asset(client, admin, ui, project_id, portrait)
        timeline = client.post(
            f"/api/v1/projects/{project_id}/timelines",
            headers=ui,
            json={
                "schema_version": 1,
                "source": {"kind": "full_asset", "asset_id": landscape_id},
                "default_layout": "crop_fill",
                "caption_preset_id": "default-bottom",
            },
        )
        assert timeline.status_code == 201
        state = timeline.json()
        first_clip_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
        patched = client.post(
            f"/api/v1/projects/{project_id}/timeline/patches",
            headers=ui,
            json={
                "schema_version": 1,
                "base_revision_id": state["current_revision"]["timeline_revision_id"],
                "operations": [
                    {
                        "op": "insert_asset_clip",
                        "asset_id": portrait_id,
                        "at_index": 1,
                        "source_start_us": 0,
                        "source_end_us": 1_000_000,
                        "layout": "crop_fill",
                    }
                ],
                "summary": "stage3b-real-two-axis-fixture",
            },
        )
        assert patched.status_code == 200
        state = patched.json()
        revision_id = state["current_revision"]["timeline_revision_id"]
        second_clip_id = state["current_revision"]["document"]["clips"][1]["clip_id"]

        portrait_base = _create_base_preview(
            client, ui, project_id, revision_id, "portrait-9x16-v1"
        )
        landscape_base = _create_base_preview(
            client, ui, project_id, revision_id, "landscape-16x9-v1"
        )
        portrait_left = _create_reframe_preview(
            client,
            ui,
            project_id,
            portrait_base["rendition_snapshot_id"],
            {"clip_id": first_clip_id, "horizontal_anchor": "left", "vertical_anchor": "center"},
        )
        portrait_right = _create_reframe_preview(
            client,
            ui,
            project_id,
            portrait_base["rendition_snapshot_id"],
            {"clip_id": first_clip_id, "horizontal_anchor": "right", "vertical_anchor": "center"},
        )
        landscape_top = _create_reframe_preview(
            client,
            ui,
            project_id,
            landscape_base["rendition_snapshot_id"],
            {"clip_id": second_clip_id, "horizontal_anchor": "center", "vertical_anchor": "top"},
        )
        landscape_bottom = _create_reframe_preview(
            client,
            ui,
            project_id,
            landscape_base["rendition_snapshot_id"],
            {"clip_id": second_clip_id, "horizontal_anchor": "center", "vertical_anchor": "bottom"},
        )
        for item in (portrait_left, portrait_right, landscape_top, landscape_bottom):
            preview_ids.add(item["render_artifact_id"])

        paths = {
            "portrait_left": _artifact_path(client, admin, portrait_left["render_artifact_id"]),
            "portrait_center": _artifact_path(client, admin, portrait_base["render_artifact_id"]),
            "portrait_right": _artifact_path(client, admin, portrait_right["render_artifact_id"]),
            "landscape_top": _artifact_path(client, admin, landscape_top["render_artifact_id"]),
            "landscape_center": _artifact_path(client, admin, landscape_base["render_artifact_id"]),
            "landscape_bottom": _artifact_path(
                client, admin, landscape_bottom["render_artifact_id"]
            ),
        }
        assert [
            _dominant(paths[name], 0.45)
            for name in ("portrait_left", "portrait_center", "portrait_right")
        ] == ["red", "green", "blue"]
        assert [
            _dominant(paths[name], 1.45)
            for name in ("landscape_top", "landscape_center", "landscape_bottom")
        ] == ["red", "green", "blue"]
        for name in ("portrait_left", "portrait_center", "portrait_right"):
            _assert_output(paths[name], 540, 960)
        for name in ("landscape_top", "landscape_center", "landscape_bottom"):
            _assert_output(paths[name], 960, 540)

        exports = tmp_path / "exports"
        exports.mkdir()
        grant_response = client.post(
            "/api/v1/internal/directory-grants",
            headers=admin,
            json={"path": str(exports.resolve())},
        )
        assert grant_response.status_code == 200
        client.portal.call(client.app.state.core.jobs.stop)
        batch_response = client.post(
            f"/api/v1/projects/{project_id}/reframe-export-batches",
            headers=ui,
            json={
                "directory_grant_id": grant_response.json()["directory_grant_id"],
                "items": [
                    {
                        "rendition_reframe_snapshot_id": portrait_left[
                            "rendition_reframe_snapshot_id"
                        ],
                        "preview_artifact_id": portrait_left["render_artifact_id"],
                        "encoder_mode": "software",
                    },
                    {
                        "rendition_reframe_snapshot_id": landscape_top[
                            "rendition_reframe_snapshot_id"
                        ],
                        "preview_artifact_id": landscape_top["render_artifact_id"],
                        "encoder_mode": "software",
                    },
                ],
            },
        )
        assert batch_response.status_code == 200
        batch = batch_response.json()["batch"]
        original_batch_id = batch["reframe_export_batch_id"]
        conflict_item = batch["items"][1]
        (exports / conflict_item["destination_display_name"]).write_bytes(b"conflict")
        client.portal.call(client.app.state.core.jobs.start)
        partial = _wait_batch(client, ui, original_batch_id, {"partial"})
        succeeded = next(item for item in partial["items"] if item["status"] == "succeeded")
        failed = next(item for item in partial["items"] if item["status"] == "failed")
        assert (exports / succeeded["destination_display_name"]).is_file()
        assert (exports / failed["destination_display_name"]).read_bytes() == b"conflict"

        retry_dir = tmp_path / "retry"
        retry_dir.mkdir()
        retry_grant = client.post(
            "/api/v1/internal/directory-grants",
            headers=admin,
            json={"path": str(retry_dir.resolve())},
        )
        assert retry_grant.status_code == 200
        retry_response = client.post(
            f"/api/v1/reframe-export-batches/{original_batch_id}/retry",
            headers=ui,
            json={
                "directory_grant_id": retry_grant.json()["directory_grant_id"],
                "reframe_export_batch_item_ids": [failed["reframe_export_batch_item_id"]],
            },
        )
        assert retry_response.status_code == 200
        retried = _wait_batch(
            client,
            ui,
            retry_response.json()["batch"]["reframe_export_batch_id"],
            {"succeeded"},
        )
        assert retried["retry_of_batch_id"] == original_batch_id
        assert retried["reframe_export_batch_id"] != original_batch_id
        assert retried["items"][0]["retry_of_item_id"] == failed["reframe_export_batch_item_id"]
        assert retried["items"][0]["job_id"] != failed["job_id"]

        all_exports = client.get(
            f"/api/v1/projects/{project_id}/exports?limit=100", headers=ui
        ).json()["items"]
        records = {
            item["export_record_id"]: item
            for item in all_exports
            if item["export_record_id"]
            in {succeeded["export_record_id"], retried["items"][0]["export_record_id"]}
        }
        assert len(records) == 2
        for item, expected_size, second, expected_color in (
            (succeeded, (1080, 1920), 0.45, "red"),
            (retried["items"][0], (1920, 1080), 1.45, "red"),
        ):
            output = (exports if item is succeeded else retry_dir) / item[
                "destination_display_name"
            ]
            _assert_output(output, *expected_size)
            assert _dominant(output, second) == expected_color
            record = records[item["export_record_id"]]
            assert record["sha256"] == "sha256:" + hashlib.sha256(output.read_bytes()).hexdigest()

        with client.app.state.core.db.connection() as db:
            count = db.execute("SELECT COUNT(*) FROM provider_invocations").fetchone()[0]
            assert count == provider_before

    with TestClient(create_app(settings)) as restarted:
        _, ui = _auth(restarted, admin_token)
        previews = restarted.get(
            f"/api/v1/projects/{project_id}/rendition-reframe-previews?limit=100", headers=ui
        )
        batches = restarted.get(
            f"/api/v1/projects/{project_id}/reframe-export-batches?limit=100", headers=ui
        )
        assert previews.status_code == 200 and preview_ids <= {
            item["render_artifact_id"] for item in previews.json()["items"]
        }
        assert batches.status_code == 200 and original_batch_id in {
            item["reframe_export_batch_id"] for item in batches.json()["items"]
        }
        assert (
            restarted.get(f"/api/v1/projects/{project_id}/timeline", headers=ui).json()[
                "current_revision"
            ]["timeline_revision_id"]
            == revision_id
        )
        with restarted.app.state.core.db.connection() as db:
            assert db.execute("SELECT COUNT(*) FROM provider_invocations").fetchone()[0] == 0


def _table_digest(connection: sqlite3.Connection, table: str) -> str:
    rows = connection.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
    return hashlib.sha256(repr(rows).encode("utf-8")).hexdigest()


def test_stage3b_real_v9_copy_upgrades_to_current_without_history_backfill(
    tmp_path: Path, monkeypatch
) -> None:
    import aivs_core.database as database_module

    source = tmp_path / "source-v9.db"
    full_migrations = database_module.MIGRATIONS
    v1_v9 = {
        version: sql
        for version, sql in full_migrations.items()
        if int(version.removeprefix("v")) <= 9
    }
    monkeypatch.setattr(database_module, "MIGRATIONS", v1_v9)
    Database(source).initialize()
    monkeypatch.setattr(database_module, "MIGRATIONS", full_migrations)
    with sqlite3.connect(source) as db:
        db.execute(
            "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("project_1", "Existing", "active", "{}", None, "root", "root", "now", "now", "now"),
        )
        db.execute(
            "INSERT INTO provider_configs("
            "id,kind,display_name,base_url,model,enabled,created_at,updated_at) "
            "VALUES ('provider_1','openai_compatible_text','Provider',"
            "'https://provider.invalid','none',1,'now','now')"
        )
        db.execute(
            "INSERT INTO provider_invocations(id,provider_config_id,capability,provider_name,model,"
            "prompt_template_version,output_schema_version,input_sha256,status,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                "invocation_1",
                "provider_1",
                "candidate_generation",
                "local-fixture",
                "none",
                1,
                1,
                "hash",
                "failed",
                "now",
            ),
        )
        db.commit()
        before = {
            table: _table_digest(db, table)
            for table in (
                "projects",
                "provider_configs",
                "provider_invocations",
                "schema_migrations",
            )
            if table != "schema_migrations"
        }
    upgraded = tmp_path / "upgraded.db"
    with sqlite3.connect(source) as source_db, sqlite3.connect(upgraded) as destination_db:
        source_db.backup(destination_db)
    Database(upgraded).initialize()
    with sqlite3.connect(upgraded) as db:
        maximum = db.execute(
            "SELECT MAX(CAST(SUBSTR(version,2) AS INTEGER)) FROM schema_migrations"
        ).fetchone()[0]
        assert maximum == 19
        assert {table: _table_digest(db, table) for table in before} == before
        assert db.execute("SELECT COUNT(*) FROM rendition_reframe_snapshots").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM reframe_export_batches").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM reframe_export_batch_items").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM provider_invocations").fetchone()[0] == 1
