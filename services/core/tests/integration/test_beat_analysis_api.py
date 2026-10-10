"""Wave1 L2：节拍分析 Core API 集成测试（端点层）。

覆盖：无网格时 generate=True 登记作业（queued + job_id）；ready 幂等短路；
stale 让位重登记；无会话 401；跨项目素材 404。执行体（真实 ffmpeg）由
unit/test_beat_analysis_job.py 覆盖——端点层只钉「登记与摘要」语义。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.media.beat_grid import BEAT_ALGORITHM_VERSION


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-beat")
    settings = Settings(
        data_dir=tmp_path,
        manifest_dir=tmp_path / "manifests",
        ffmpeg=Path("missing"),
        ffprobe=Path("missing"),
    )
    application = TestClient(create_app(settings))
    with application:
        yield application


def _ui(client: TestClient) -> dict[str, str]:
    response = client.post(
        "/api/v1/internal/sessions", headers={"Authorization": "Bearer admin-beat"}
    )
    return {"Authorization": f"Bearer {response.json()['token']}"}


ADMIN = {"Authorization": "Bearer admin-beat"}


def _seed_asset(client: TestClient, tmp_path: Path) -> tuple[str, str]:
    media = tmp_path / "bgm.wav"
    media.write_bytes(b"beat-media-bytes")
    project = client.post("/api/v1/projects", json={"name": "W1L2"}, headers=_ui(client)).json()
    project_id = project["project_id"]
    grant = client.post(
        "/api/v1/internal/file-grants", json={"path": str(media)}, headers=ADMIN
    ).json()
    asset = client.post(
        f"/api/v1/projects/{project_id}/assets",
        json={"grant_id": grant["grant_id"], "kind": "audio"},
        headers=_ui(client),
    ).json()
    state = client.app.state.core
    with state.db.connection() as db:
        db.execute(
            "UPDATE assets SET availability='available', media_info_json=? WHERE id=?",
            (
                '{"duration_us": 12000000, "audio_streams": [{"index": 1, "codec": "aac",'
                ' "sample_rate": 48000, "channels": 2}]}',
                asset["asset_id"],
            ),
        )
    return project_id, asset["asset_id"]


class TestBeatAnalysisEndpoint:
    def test_requires_session(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/beat-analysis", json={}
        )
        assert response.status_code == 401

    def test_generate_registers_queued_job(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/beat-analysis",
            json={"generate": True}, headers=_ui(client),
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "queued"
        assert body["job_id"]
        state = client.app.state.core
        with state.db.connection() as db:
            row = db.execute(
                "SELECT kind,status FROM jobs WHERE id=?", (body["job_id"],)
            ).fetchone()
        assert row["kind"] == "beat_analysis" and row["status"] == "queued"
        # 响应不含路径字段（Renderer 可见面）。
        assert "path" not in json.dumps(body)

    def test_ready_shortcircuits(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        state = client.app.state.core
        with state.db.connection() as db:
            row = db.execute(
                "SELECT fingerprint FROM assets WHERE id=?", (asset_id,)
            ).fetchone()
            db.execute(
                "INSERT INTO beat_grids(id,asset_id,source_fingerprint,algorithm_version,"
                "status,bpm,lag_s,confidence,beats_json,downbeats_json,candidates_json,"
                "reason,model_revision,sample_rate,created_at,updated_at,finished_at) "
                "VALUES ('bg1',?,?,?,'ready',120,0.5,0.9,?,?,'[]',NULL,NULL,22050,"
                "'t0','t0','t0')",
                (
                    asset_id, str(row["fingerprint"]), BEAT_ALGORITHM_VERSION,
                    "[0,500000]", "[0]",
                ),
            )
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/beat-analysis",
            json={"generate": True}, headers=_ui(client),
        )
        body = response.json()
        assert body["status"] == "ready" and body["job_id"] is None
        assert body["beat_count"] == 2 and body["bpm"] == 120

    def test_stale_yields_new_job(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        state = client.app.state.core
        with state.db.connection() as db:
            db.execute(
                "INSERT INTO beat_grids(id,asset_id,source_fingerprint,algorithm_version,"
                "status,bpm,lag_s,confidence,beats_json,downbeats_json,candidates_json,"
                "reason,model_revision,sample_rate,created_at,updated_at,finished_at) "
                "VALUES ('bg_old',?,'fp_stale',?,'ready',120,0.5,0.9,?,?,'[]',NULL,NULL,"
                "22050,'t0','t0','t0')",
                (asset_id, BEAT_ALGORITHM_VERSION, "[0,500000]", "[0]"),
            )
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/beat-analysis",
            json={"generate": True}, headers=_ui(client),
        )
        body = response.json()
        assert body["status"] == "queued" and body["job_id"]

    def test_cross_project_asset_404(self, client: TestClient, tmp_path: Path) -> None:
        project_id, _asset_id = _seed_asset(client, tmp_path)
        other = client.post(
            "/api/v1/projects", json={"name": "W1L2-2"}, headers=_ui(client)
        ).json()
        response = client.post(
            f"/api/v1/projects/{other['project_id']}/assets/none/beat-analysis",
            json={"generate": True}, headers=_ui(client),
        )
        assert response.status_code == 404
