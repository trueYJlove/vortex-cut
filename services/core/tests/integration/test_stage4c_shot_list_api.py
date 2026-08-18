from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.database import utc_now

RESOURCES = Path(__file__).resolve().parents[4] / "resources"
TEXT_SENTINEL = "SHOT_LIST_PRIVATE_SENTINEL_4C"


def _app(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "stage4c-admin")
    return create_app(
        Settings(
            data_dir=tmp_path,
            ffmpeg=Path("missing"),
            ffprobe=Path("missing"),
            manifest_dir=RESOURCES / "model-manifests",
            font_dir=RESOURCES / "fonts",
            recipe_dir=RESOURCES / "recipes",
        )
    )


def _auth(client: TestClient) -> dict[str, str]:
    token = client.post(
        "/api/v1/internal/sessions", headers={"Authorization": "Bearer stage4c-admin"}
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def _document(base_revision_id=None, source_asset_id=None, *, count=2):
    return {
        "schema_version": 1,
        "base_revision_id": base_revision_id,
        "title": "  镜头   需求  ",
        "summary": f"摘要\r\n{TEXT_SENTINEL}  ",
        "requirements": [
            {
                "title": f"镜头 {index + 1}",
                "visual_direction": "主体居中  \r\n背景简洁",
                "target_duration_us": 2_000_000,
                "visual": {
                    "requirement_kind": "existing_media"
                    if index == 0 and source_asset_id
                    else "image",
                    "source_asset_id": source_asset_id if index == 0 else None,
                },
                "narration": {"requirement_kind": "tts", "text": "人工旁白"}
                if index == 0
                else None,
            }
            for index in range(count)
        ],
    }


def _seed_asset(app, project_id: str, asset_id: str) -> None:
    now = utc_now()
    with app.state.core.db.connection() as sql:
        sql.execute(
            "INSERT INTO assets("
            "id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,"
            "modified_at,availability,media_info_json,created_at,updated_at"
            ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                asset_id,
                project_id,
                "image",
                "managed",
                "合成图片",
                "sha256:test",
                1,
                now,
                "available",
                "{}",
                now,
                now,
            ),
        )


def test_shot_list_api_revision_confirmation_and_zero_side_effects(
    tmp_path: Path, monkeypatch
) -> None:
    app = _app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        ui = _auth(client)
        project_id = client.post("/api/v1/projects", headers=ui, json={"name": "Stage 4C"}).json()[
            "project_id"
        ]
        asset_id = "asset_stage4c_same_project"
        _seed_asset(app, project_id, asset_id)
        base = f"/api/v1/projects/{project_id}/shot-list"
        empty = client.get(base, headers=ui)
        assert empty.status_code == 200
        assert empty.json() == {
            "shot_list_id": None,
            "project_id": project_id,
            "lifecycle": "empty",
            "current_revision": None,
            "confirmed_revision": None,
        }
        before = {}
        with app.state.core.db.connection() as sql:
            for table in (
                "provider_invocations",
                "media_generation_requests",
                "media_generation_tasks",
                "jobs",
                "timeline_revisions",
                "assets",
            ):
                before[table] = sql.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        created_response = client.post(
            f"{base}/revisions", headers=ui, json=_document(source_asset_id=asset_id)
        )
        assert created_response.status_code == 200
        created = created_response.json()
        revision = created["revision"]
        revision_id = revision["shot_list_revision_id"]
        assert created["reused"] is False
        assert revision["title"] == "镜头 需求"
        assert revision["summary"] == f"摘要\n{TEXT_SENTINEL}"
        assert revision["requirements"][0]["ordinal"] == 0
        assert created["state"]["lifecycle"] == "drafted"
        reused = client.post(
            f"{base}/revisions", headers=ui, json=_document(revision_id, asset_id)
        ).json()
        assert reused["reused"] is True
        assert reused["revision"]["shot_list_revision_id"] == revision_id
        page_text = client.get(f"{base}/revisions", headers=ui).text
        assert TEXT_SENTINEL not in page_text
        detail = client.get(f"/api/v1/shot-list-revisions/{revision_id}", headers=ui).json()
        assert detail["summary"].endswith(TEXT_SENTINEL)
        confirmed = client.post(
            f"{base}/confirm",
            headers=ui,
            json={"revision_id": revision_id, "expected_current_revision_id": revision_id},
        ).json()
        assert confirmed["state"]["lifecycle"] == "confirmed"
        assert confirmed["reused"] is False
        assert (
            client.post(
                f"{base}/confirm",
                headers=ui,
                json={"revision_id": revision_id, "expected_current_revision_id": revision_id},
            ).json()["reused"]
            is True
        )
        next_document = _document(revision_id, asset_id)
        next_document["title"] = "确认后的下一版"
        evolved_response = client.post(f"{base}/revisions", headers=ui, json=next_document)
        assert evolved_response.status_code == 200
        evolved = evolved_response.json()
        assert evolved["state"]["lifecycle"] == "drafted"
        assert evolved["state"]["confirmed_revision"]["shot_list_revision_id"] == revision_id
        assert evolved["revision"]["parent_revision_id"] == revision_id
        conflict = client.post(f"{base}/revisions", headers=ui, json=_document(None, asset_id))
        assert conflict.status_code == 409
        assert conflict.json()["error"]["code"] == "SHOT_LIST_CONFLICT"
        assert TEXT_SENTINEL not in conflict.text
        with app.state.core.db.connection() as sql:
            after = {
                table: sql.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in before
            }
            assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
            assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert {key: after[key] - before[key] for key in before} == {
            "provider_invocations": 0,
            "media_generation_requests": 0,
            "media_generation_tasks": 0,
            "jobs": 0,
            "timeline_revisions": 0,
            "assets": 0,
        }


def test_shot_list_api_rejects_invalid_cross_project_and_immutable_writes(
    tmp_path: Path, monkeypatch
) -> None:
    app = _app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        ui = _auth(client)
        first = client.post("/api/v1/projects", headers=ui, json={"name": "First"}).json()[
            "project_id"
        ]
        second = client.post("/api/v1/projects", headers=ui, json={"name": "Second"}).json()[
            "project_id"
        ]
        _seed_asset(app, second, "asset_other_project")
        response = client.post(
            f"/api/v1/projects/{first}/shot-list/revisions",
            headers=ui,
            json=_document(source_asset_id="asset_other_project"),
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "SHOT_REQUIREMENT_ASSET_PROJECT_MISMATCH"
        unknown = _document()
        unknown["payload"] = "forbidden"
        assert (
            client.post(
                f"/api/v1/projects/{first}/shot-list/revisions", headers=ui, json=unknown
            ).status_code
            == 400
        )
        assert (
            client.post(
                f"/api/v1/projects/{first}/shot-list/revisions",
                headers=ui,
                json=_document(count=25),
            ).status_code
            == 400
        )
        created = client.post(
            f"/api/v1/projects/{first}/shot-list/revisions", headers=ui, json=_document()
        ).json()["revision"]
        with app.state.core.db.connection() as sql:
            try:
                sql.execute(
                    "UPDATE shot_list_revisions SET title='x' WHERE id=?",
                    (created["shot_list_revision_id"],),
                )
            except Exception:
                pass
            else:
                raise AssertionError("revision update should be rejected")
            try:
                sql.execute(
                    "DELETE FROM shot_requirements WHERE shot_list_revision_id=?",
                    (created["shot_list_revision_id"],),
                )
            except Exception:
                pass
            else:
                raise AssertionError("requirement delete should be rejected")
