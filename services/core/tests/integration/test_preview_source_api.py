"""B11 preview-source Core API 集成测试（端点层）。

覆盖（计划第 6.1 节四层测试——本文件是 Core 层）：
- GET 描述端点：UI 会话可用；auto/proxy 模式；几何/时间映射字段；
  无路径字段泄漏。
- 生成作业端点：显式登记（queued）；ready/building 幂等短路。
- 代理票据端点：仅 admin；UI token 401；返回路径（Main 换票据用）。
- 错误码：越权（ASSET_NOT_FOUND）、档位非法（PREVIEW_PROFILE_INVALID）、
  模式非法（PREVIEW_SOURCE_MODE_INVALID）、无视频流。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-b11")
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
        "/api/v1/internal/sessions", headers={"Authorization": "Bearer admin-b11"}
    )
    return {"Authorization": f"Bearer {response.json()['token']}"}


ADMIN = {"Authorization": "Bearer admin-b11"}


def _seed_asset(client: TestClient, tmp_path: Path) -> tuple[str, str]:
    """建项目 + 真实文件素材（经 file-grant 走 import 哈希路径）。

    media_info 用真实 import 探测不可行（测试环境 ffprobe 缺失 →
    availability=unsupported），故导入后直改 media_info_json 模拟已探测素材
    （集成层只测端点编排，探测语义在单测/真实环境覆盖）。
    """
    media = tmp_path / "素材.mp4"
    media.write_bytes(b"b11-media-bytes")
    project = client.post(
        "/api/v1/projects", json={"name": "B11"}, headers=_ui(client)
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
    # 模拟探测结果（1920x1080 30fps）+ available
    state = client.app.state.core
    with state.db.connection() as db:
        db.execute(
            "UPDATE assets SET availability='available', media_info_json=? WHERE id=?",
            (
                '{"duration_us": 12000000, "video_streams": [{"index": 0, "codec": "h264",'
                ' "width": 1920, "height": 1080, "sample_aspect_ratio_num": 1,'
                ' "sample_aspect_ratio_den": 1, "avg_frame_rate_num": 30,'
                ' "avg_frame_rate_den": 1, "rotation": 0}], "audio_streams": []}',
                asset["asset_id"],
            ),
        )
    return project_id, asset["asset_id"]


def _ready_proxy(client: TestClient, project_id: str, asset_id: str,
                 profile: str = "preview-720-v1") -> str:
    """直插 ready 代理条目（绕过 FFmpeg；生成作业语义在单测覆盖）。"""
    state = client.app.state.core
    asset = state.derived_media._asset_row(asset_id)  # noqa: SLF001 测试直访
    key = state.preview_source.proxy_cache_key(asset["fingerprint"], profile)
    root = state.derived_cache.begin_build(
        key, str(asset["fingerprint"]), "video_proxy",
        state.preview_source.proxy_params(profile),
        state.preview_source.toolchain_fingerprint(),
    )
    assert root is not None
    (root / "proxy.mp4").write_bytes(b"proxy-bytes")
    state.derived_cache.commit_ready(key, "video_proxy", root / "proxy.mp4")
    return key


class TestPreviewSourceEndpoint:
    def test_requires_session(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/preview-source",
            json={"mode": "auto"},
        )
        assert response.status_code == 401

    def test_auto_returns_original_until_proxy_ready(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/preview-source",
            json={"mode": "auto"}, headers=_ui(client),
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["mode"] == "original"
        assert payload["status"] == "ready"
        assert payload["coded_width"] == 1920 and payload["coded_height"] == 1080
        assert payload["source_origin_us"] == 0
        assert payload["profile_id"] == "preview-720-v1"  # 1080p 源默认 720 档
        assert "path" not in payload and "media_url" not in payload
        # auto 不触发生成（generate 默认 False；且非 proxy 模式也不登记）
        assert payload["job_id"] is None

        _ready_proxy(client, project_id, asset_id)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/preview-source",
            json={"mode": "auto"}, headers=_ui(client),
        )
        payload = response.json()
        assert payload["mode"] == "proxy" and payload["status"] == "ready"
        assert (payload["coded_width"], payload["coded_height"]) == (1280, 720)

    def test_proxy_mode_pending_then_ready(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/preview-source",
            json={"mode": "proxy"}, headers=_ui(client),
        )
        payload = response.json()
        assert payload["status"] == "pending"  # 无条目：pending（非报错）

        _ready_proxy(client, project_id, asset_id)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/preview-source",
            json={"mode": "proxy"}, headers=_ui(client),
        )
        payload = response.json()
        assert payload["status"] == "ready"
        assert payload["codec"] == "avc" and payload["fps_num"] == 30

    def test_generate_registers_job_only_for_proxy_mode(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        # original 模式 + generate：不登记（禁止原源模式下触发转码）
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/preview-source",
            json={"mode": "original", "generate": True}, headers=_ui(client),
        )
        assert response.json()["job_id"] is None
        # proxy 模式 + generate：登记 queued 作业
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/preview-source",
            json={"mode": "proxy", "generate": True}, headers=_ui(client),
        )
        payload = response.json()
        assert payload["job_id"] is not None
        assert payload["status"] == "pending"
        # 作业经既有 jobs 查询流可见（测试环境无 FFmpeg：probe 失败即
        # failed——载荷分派已触达 B11 runner；端点语义只关心登记成功）
        job = client.get(
            f"/api/v1/jobs/{payload['job_id']}", headers=_ui(client)
        ).json()
        assert job["kind"] == "proxy"
        assert job["status"] in {"queued", "running", "failed"}
        if job["status"] == "failed":
            assert job["error"]["code"] in {"FFMPEG_NOT_FOUND", "MEDIA_UNSUPPORTED"}
        # 幂等：building/failed 状态下再请求不重复登记（同 cache_key 短路）
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/preview-source",
            json={"mode": "proxy", "generate": True}, headers=_ui(client),
        )
        assert response.json()["job_id"] is None  # 已有条目行短路

    def test_invalid_profile_and_mode(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/preview-source",
            json={"mode": "auto", "profile_id": "preview-999-v1"}, headers=_ui(client),
        )
        assert response.status_code == 400
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/preview-source",
            json={"mode": "bogus"}, headers=_ui(client),
        )
        assert response.status_code == 400

    def test_cross_project_denied(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        other = client.post(
            "/api/v1/projects", json={"name": "B11-other"}, headers=_ui(client)
        ).json()
        response = client.post(
            f"/api/v1/projects/{other['project_id']}/assets/{asset_id}/preview-source",
            json={"mode": "auto"}, headers=_ui(client),
        )
        assert response.status_code in (404, 403)
        detail = response.json()["error"]
        assert detail["code"] == "ASSET_NOT_FOUND"

    def test_missing_asset_404(self, client: TestClient, tmp_path: Path) -> None:
        project_id, _ = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/asset_missing/preview-source",
            json={"mode": "auto"}, headers=_ui(client),
        )
        assert response.status_code == 404


class TestPreviewSourceJobsEndpoint:
    def test_explicit_job_creation_and_ready_short_circuit(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/preview-source/jobs",
            json={}, headers=_ui(client),
        )
        payload = response.json()
        assert payload["job_id"] is not None
        assert payload["status"] == "queued"
        assert payload["cache_key"].startswith("sha256:")
        # ready 后幂等短路
        _ready_proxy(client, project_id, asset_id)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/preview-source/jobs",
            json={}, headers=_ui(client),
        )
        payload = response.json()
        assert payload["job_id"] is None and payload["status"] == "ready"

    def test_requires_session(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/preview-source/jobs",
            json={},
        )
        assert response.status_code == 401


class TestPreviewSourceMediaEndpoint:
    def test_admin_only_resolve_and_reference_recorded(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        key = _ready_proxy(client, project_id, asset_id)
        body = {"asset_id": asset_id, "profile_id": "preview-720-v1"}
        # UI token 拒绝（Renderer 不能直接拿路径）
        response = client.post(
            f"/api/v1/internal/projects/{project_id}/assets/{asset_id}"
            "/preview-source/media",
            json=body, headers=_ui(client),
        )
        assert response.status_code == 401
        # admin 通道返回路径
        response = client.post(
            f"/api/v1/internal/projects/{project_id}/assets/{asset_id}"
            "/preview-source/media",
            json=body, headers=ADMIN,
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
            f"/api/v1/internal/projects/{project_id}/assets/{asset_id}"
            "/preview-source/media",
            json={"asset_id": asset_id, "profile_id": "preview-540-v1"},
            headers=ADMIN,
        )
        assert response.status_code == 404
