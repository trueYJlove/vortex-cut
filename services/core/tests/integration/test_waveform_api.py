"""B14 波形 Core API 集成测试（端点层）。

覆盖（计划第 6.1 节四层测试——本文件是 Core 层）：
- 描述端点：UI 会话可用；无音轨 MEDIA_NO_AUDIO；generate=True 登记作业
  （queued）；ready 幂等短路（不重复登记）；无路径字段泄漏。
- 媒体解析端点：仅 admin；UI token 401；返回路径（Main 换票据用）；
  引用记录（refs 表）；未就绪 404 DERIVED_NOT_FOUND。
- 越权：跨项目素材 ASSET_NOT_FOUND。
"""
from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-b14")
    settings = Settings(
        data_dir=tmp_path,
        manifest_dir=tmp_path / "manifests",
        ffmpeg=Path("missing"),
        ffprobe=Path("missing"),
    )
    application = TestClient(create_app(settings))
    with application:  # lifespan 触发 db.initialize
        yield application


def _ui(client: TestClient) -> dict[str, str]:
    response = client.post(
        "/api/v1/internal/sessions", headers={"Authorization": "Bearer admin-b14"}
    )
    return {"Authorization": f"Bearer {response.json()['token']}"}


ADMIN = {"Authorization": "Bearer admin-b14"}


def _seed_asset(
    client: TestClient, tmp_path: Path, *, with_audio: bool = True
) -> tuple[str, str]:
    """建项目 + 真实文件素材（导入后直改 media_info_json 模拟已探测）。"""
    media = tmp_path / "素材.mp4"
    media.write_bytes(b"b14-media-bytes")
    project = client.post(
        "/api/v1/projects", json={"name": "B14"}, headers=_ui(client)
    ).json()
    project_id = project["project_id"]
    grant = client.post(
        "/api/v1/internal/file-grants", json={"path": str(media)}, headers=ADMIN
    ).json()
    asset = client.post(
        f"/api/v1/projects/{project_id}/assets",
        json={"grant_id": grant["grant_id"], "kind": "video"},
        headers=_ui(client),
    ).json()
    state = client.app.state.core
    audio = (
        '[{"index": 1, "codec": "aac", "sample_rate": 48000, "channels": 2}]'
        if with_audio else "[]"
    )
    with state.db.connection() as db:
        db.execute(
            "UPDATE assets SET availability='available', media_info_json=? WHERE id=?",
            (
                '{"duration_us": 12000000, "video_streams": [{"index": 0, "codec": "h264",'
                ' "width": 1920, "height": 1080, "sample_aspect_ratio_num": 1,'
                ' "sample_aspect_ratio_den": 1, "avg_frame_rate_num": 30,'
                f' "avg_frame_rate_den": 1, "rotation": 0}}], "audio_streams": {audio}}}',
                asset["asset_id"],
            ),
        )
    return project_id, asset["asset_id"]


def _ready_waveform(client: TestClient, project_id: str, asset_id: str) -> str:
    """经服务层生成 ready 波形条目（FFmpeg 生成作业不在本测范围）。"""
    state = client.app.state.core
    with state.db.connection() as db:
        row = db.execute("SELECT fingerprint FROM assets WHERE id=?", (asset_id,)).fetchone()
    fingerprint = str(row["fingerprint"])
    key = state.waveform.waveform_cache_key(fingerprint)
    root = state.derived_cache.begin_build(
        key, fingerprint, "waveform",
        state.waveform.params(), state.waveform.toolchain_fingerprint(),
    )
    assert root is not None
    (root / "waveform.bin").write_bytes(b"wf-bytes")
    state.derived_cache.commit_ready(key, "waveform", root / "waveform.bin")
    return key


class TestWaveformEndpoint:
    def test_requires_session(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/waveform", json={}
        )
        assert response.status_code == 401

    def test_no_audio_rejected(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path, with_audio=False)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/waveform",
            json={"generate": True}, headers=_ui(client),
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "MEDIA_NO_AUDIO"

    def test_generate_registers_job_then_idempotent(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        # 无条目：generate=True 登记作业
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/waveform",
            json={"generate": True}, headers=_ui(client),
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["job_id"] is not None
        assert payload["status"] == "queued"
        assert payload["sample_rate"] == 8000 and payload["bucket"] == 256
        assert "path" not in payload and "media_url" not in payload
        # 纯查询（generate=False）：已有条目状态回显，不再登记（测试环境
        # ffmpeg 缺失，后台 job loop 真跑会落 failed——同为"已有条目短路"）。
        # 竞态窗口：create_waveform_job 的 jobs 行已提交，但 loop 抢跑把
        # derived_media_cache 落到 failed 之前 / begin_build 之前，查询可能
        # 短暂读到 status=None（条目行尚未写）——合法瞬态，poll 等待收敛
        # 到四态之一（回归锁：None 不得成为终态）。
        deadline = time.monotonic() + 5.0
        status: str | None = None
        while time.monotonic() < deadline:
            response = client.post(
                f"/api/v1/projects/{project_id}/assets/{asset_id}/waveform",
                json={}, headers=_ui(client),
            )
            payload = response.json()
            status = payload["status"]
            if status in {"building", "queued", "running", "failed"}:
                break
            time.sleep(0.05)
        assert payload["job_id"] is None
        assert status in {"building", "queued", "running", "failed"}
        # ready 后：幂等短路（job_id=None, status=ready）
        key = _ready_waveform(client, project_id, asset_id)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/waveform",
            json={"generate": True}, headers=_ui(client),
        )
        payload = response.json()
        assert payload["status"] == "ready"
        assert payload["job_id"] is None
        assert payload["cache_key"] == key

    def test_failed_allows_regenerate(self, client: TestClient, tmp_path: Path) -> None:
        """failed 不是终态：generate=True 可重新登记（retry/重进视口）。"""
        project_id, asset_id = _seed_asset(client, tmp_path)
        state = client.app.state.core
        with state.db.connection() as db:
            row = db.execute(
                "SELECT fingerprint FROM assets WHERE id=?", (asset_id,)
            ).fetchone()
        key = state.waveform.waveform_cache_key(str(row["fingerprint"]))
        # 直接落 failed 占位行（模拟上次作业失败）
        state.derived_cache.begin_build(
            key, str(row["fingerprint"]), "waveform",
            state.waveform.params(), state.waveform.toolchain_fingerprint(),
        )
        state.derived_cache.mark_failed(key, "waveform")
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/waveform",
            json={"generate": True}, headers=_ui(client),
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "queued"
        assert payload["job_id"] is not None

    def test_cross_project_denied(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        other = client.post(
            "/api/v1/projects", json={"name": "B14-other"}, headers=_ui(client)
        ).json()
        response = client.post(
            f"/api/v1/projects/{other['project_id']}/assets/{asset_id}/waveform",
            json={}, headers=_ui(client),
        )
        assert response.status_code in (404, 409)
        assert response.json()["error"]["code"] == "ASSET_NOT_FOUND"

    def test_missing_asset_404(self, client: TestClient, tmp_path: Path) -> None:
        project = client.post(
            "/api/v1/projects", json={"name": "B14-miss"}, headers=_ui(client)
        ).json()
        response = client.post(
            f"/api/v1/projects/{project['project_id']}/assets/none/waveform",
            json={}, headers=_ui(client),
        )
        assert response.status_code in (404, 409)


class TestWaveformMediaEndpoint:
    def test_admin_only_resolve_and_reference_recorded(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        key = _ready_waveform(client, project_id, asset_id)
        # UI token 拒绝（Renderer 不能直接拿路径）
        response = client.post(
            f"/api/v1/internal/projects/{project_id}/assets/{asset_id}/waveform/media",
            headers=_ui(client),
        )
        assert response.status_code == 401
        # admin 通道返回路径
        response = client.post(
            f"/api/v1/internal/projects/{project_id}/assets/{asset_id}/waveform/media",
            headers=ADMIN,
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ready"
        assert Path(payload["path"]).is_file()
        assert payload["cache_key"] == key
        # 引用已记录（授权证明：refs 表行）
        state = client.app.state.core
        with state.db.connection() as db:
            count = db.execute(
                "SELECT COUNT(*) FROM derived_media_cache_refs WHERE cache_key=?",
                (key,),
            ).fetchone()[0]
        assert count == 1

    def test_not_ready_404(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/internal/projects/{project_id}/assets/{asset_id}/waveform/media",
            headers=ADMIN,
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "DERIVED_NOT_FOUND"
