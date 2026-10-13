"""W2.2 S2：说话人分离 Core API 集成测试（端点层）。

覆盖门 §7 的 `speaker_api_test.py`：401 / 跨项目 404 / 登记作业 / 摘要形状
（**无路径字段**）/ **零 egress + 无新模型面**。

执行体（真实 ffmpeg + ONNX）在 unit/test_speaker_storage.py 与真实素材套件里覆盖；
端点层只钉「登记 / 摘要 / 轮次 / 重聚类」语义。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.database import json_dumps, utc_now
from aivs_core.media.speaker_service import SPEAKER_ALGORITHM_VERSION


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-speaker")
    settings = Settings(
        data_dir=tmp_path,
        manifest_dir=Path(__file__).resolve().parents[3] / "resources" / "model-manifests",
        ffmpeg=Path("missing"),
        ffprobe=Path("missing"),
    )
    application = TestClient(create_app(settings))
    with application:
        yield application


ADMIN = {"Authorization": "Bearer admin-speaker"}


def _ui(client: TestClient) -> dict[str, str]:
    response = client.post(
        "/api/v1/internal/sessions", headers=ADMIN
    )
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _seed_asset(client: TestClient, tmp_path: Path, kind: str = "video") -> tuple[str, str]:
    media = tmp_path / "talk.mp4"
    media.write_bytes(b"speaker-media-bytes")
    project = client.post("/api/v1/projects", json={"name": "W2.2"},
                          headers=_ui(client)).json()
    project_id = project["project_id"]
    grant = client.post("/api/v1/internal/file-grants",
                        json={"path": str(media)}, headers=ADMIN).json()
    asset = client.post(
        f"/api/v1/projects/{project_id}/assets",
        json={"grant_id": grant["grant_id"], "kind": kind},
        headers=_ui(client),
    ).json()
    state = client.app.state.core
    with state.db.connection() as db:
        db.execute(
            "UPDATE assets SET availability='available', media_info_json=? WHERE id=?",
            (json_dumps({"duration_us": 12_000_000,
                         "audio_streams": [{"index": 1, "codec": "aac"}],
                         "video_streams": [{"index": 0, "codec": "h264"}]}),
             asset["asset_id"]),
        )
    return project_id, asset["asset_id"]


def _insert_ready(
    state, asset_id: str, fingerprint: str, *, strategy: str = "silhouette+capK"
) -> None:
    now = utc_now()
    with state.db.connection() as db:
        db.execute(
            "INSERT INTO speaker_diarizations(id,asset_id,source_fingerprint,"
            "algorithm_version,status,reason,speaker_count,turns_json,windows_json,"
            "embedding_model,model_revision,vad_model,threshold,threshold_strategy,"
            "sample_rate,created_at,updated_at,finished_at) "
            "VALUES ('sd1',?,?,?,'ready',NULL,2,?,?,?,?,?,0.5,?,16000,?,?,?)",
            (asset_id, fingerprint, SPEAKER_ALGORITHM_VERSION,
             json_dumps([{"start_us": 0, "end_us": 1_000_000, "speaker": 0},
                         {"start_us": 1_000_000, "end_us": 2_000_000, "speaker": 1}]),
             json_dumps([[0.0, 2.0], [1.0, 3.0]]),
             "campplus-speaker-embedding", "campplus-zh-cn-16k-common", "silero_vad_v6",
             strategy, now, now, now),
        )


class TestDiarizationEndpoint:
    def test_requires_session(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/diarization", json={})
        assert response.status_code == 401

    def test_generate_registers_queued_job(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/diarization",
            json={"generate": True}, headers=_ui(client))
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "queued" and body["job_id"]
        state = client.app.state.core
        with state.db.connection() as db:
            row = db.execute("SELECT kind,status FROM jobs WHERE id=?",
                             (body["job_id"],)).fetchone()
        assert (row["kind"], row["status"]) == ("speaker_diarization", "queued")
        # 摘要形状：**必须无路径字段**
        assert "path" not in json.dumps(body)
        assert body["algorithm_version"] == str(SPEAKER_ALGORITHM_VERSION)
        assert isinstance(body["model_ready"], bool)

    def test_ready_shortcircuits_and_reports_summary(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        state = client.app.state.core
        with state.db.connection() as db:
            fingerprint = db.execute("SELECT fingerprint FROM assets WHERE id=?",
                                     (asset_id,)).fetchone()["fingerprint"]
        _insert_ready(state, asset_id, str(fingerprint))
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/diarization",
            json={"generate": True}, headers=_ui(client))
        body = response.json()
        assert body["status"] == "ready" and body["job_id"] is None
        assert body["speaker_count"] == 2 and body["turn_count"] == 2
        assert body["window_count"] == 2
        assert body["threshold_strategy"] == "silhouette+capK"

    def test_stale_is_reported(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        state = client.app.state.core
        _insert_ready(state, asset_id, "sha256:stale")
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/diarization",
            json={}, headers=_ui(client))
        assert response.json()["status"] == "stale"

    def test_cross_project_asset_404(self, client: TestClient, tmp_path: Path) -> None:
        _project_id, _asset_id = _seed_asset(client, tmp_path)
        other = client.post("/api/v1/projects", json={"name": "other"},
                            headers=_ui(client)).json()
        response = client.post(
            f"/api/v1/projects/{other['project_id']}/assets/none/diarization",
            json={"generate": True}, headers=_ui(client))
        assert response.status_code == 404

    def test_turns_endpoint_returns_timeline(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        state = client.app.state.core
        with state.db.connection() as db:
            fingerprint = db.execute("SELECT fingerprint FROM assets WHERE id=?",
                                     (asset_id,)).fetchone()["fingerprint"]
        _insert_ready(state, asset_id, str(fingerprint))
        response = client.get(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/diarization/turns",
            headers=_ui(client))
        body = response.json()
        assert body["status"] == "ready" and len(body["turns"]) == 2
        assert body["turns"][0]["speaker"] == 0

    def test_turns_endpoint_without_row_404(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.get(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/diarization/turns",
            headers=_ui(client))
        assert response.status_code == 404

    def test_recluster_without_row_404(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/diarization/recluster",
            json={"strategy": "silhouette_capk"}, headers=_ui(client))
        assert response.status_code == 404


class TestNoEgressSurface:
    def test_speaker_modules_do_not_reference_network(self) -> None:
        """门 §7：**零 egress + 无新模型面**——说话人链路不得出现网络调用面。"""
        root = Path(__file__).resolve().parents[2] / "src" / "aivs_core"
        # "provider" 会误伤 ort.InferenceSession(providers=[...])（纯执行提供者名，
        # 非模型 provider）；锁的是真正的出网面与云端 provider 域引用。
        forbidden = ("httpx", "requests", "urllib.request", "socket", "aiohttp",
                     "providers.py", "egress", "ProviderRepository")
        offenders: list[str] = []
        for name in ("media/speaker.py", "media/speaker_service.py",
                     "media/speaker_vad.py", "media/speaker_embedding.py"):
            text = (root / name).read_text(encoding="utf-8")
            for token in forbidden:
                if token in text:
                    offenders.append(f"{name}:{token}")
        assert offenders == [], offenders

    def test_no_new_model_surface_outside_registry(self) -> None:
        """模型只能经 model_registry（受信直链 + sha256），不得自建下载面。"""
        root = Path(__file__).resolve().parents[2] / "src" / "aivs_core" / "media"
        for name in ("speaker_service.py", "speaker_embedding.py"):
            text = (root / name).read_text(encoding="utf-8")
            assert "https://" not in text, name
            assert "download" not in text.lower() or "模型尚未" in text
