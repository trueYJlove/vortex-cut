"""B10 派生媒体 Core API 测试（lookup/stats/resolve 端点）。

覆盖（计划第 6.1 节：每个新增 IPC 至少四层测试——本文件是 Core 层）：
- lookup：UI 会话可用；无路径字段泄漏（Renderer 可见响应剥离 path）。
- resolve：仅 admin 通道；UI token 拒绝 401（Renderer 不能直接拿路径）。
- 错误码：素材不存在/跨项目越权（ASSET_NOT_FOUND）、kind 非法
  （DERIVED_KIND_INVALID）、params 非法（DERIVED_PARAMS_INVALID）、
  未生成条目（DERIVED_NOT_FOUND）。
- stats：UI 可用且无敏感字段。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-b10")
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
        "/api/v1/internal/sessions", headers={"Authorization": "Bearer admin-b10"}
    )
    return {"Authorization": f"Bearer {response.json()['token']}"}


ADMIN = {"Authorization": "Bearer admin-b10"}


def _seed_asset(client: TestClient, tmp_path: Path) -> tuple[str, str]:
    """建项目 + 真实文件素材（经 file-grant 走 import_asset 哈希路径）。"""
    media = tmp_path / "素材.mp4"
    media.write_bytes(b"b10-media-bytes")
    project = client.post(
        "/api/v1/projects", json={"name": "B10"}, headers=_ui(client)
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
    # import_asset 返回素材 DTO（顶层即 asset 字段结构）
    return project_id, asset["asset_id"]


def test_lookup_requires_session_and_validates_input(
    client: TestClient, tmp_path: Path
) -> None:
    project_id, asset_id = _seed_asset(client, tmp_path)
    body = {"asset_id": asset_id, "kind": "waveform", "params": {"sample_rate": "8000"}}
    # 未授权拒绝
    assert client.post(
        f"/api/v1/projects/{project_id}/derived-media/lookup", json=body
    ).status_code == 401
    # kind 非法
    response = client.post(
        f"/api/v1/projects/{project_id}/derived-media/lookup",
        json={"asset_id": asset_id, "kind": "bogus", "params": {}}, headers=_ui(client),
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "DERIVED_KIND_INVALID"
    # params 键非法
    response = client.post(
        f"/api/v1/projects/{project_id}/derived-media/lookup",
        json={"asset_id": asset_id, "kind": "waveform", "params": {"bad-key!": "x"}},
        headers=_ui(client),
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "DERIVED_PARAMS_INVALID"
    # 合法请求但条目未生成
    response = client.post(
        f"/api/v1/projects/{project_id}/derived-media/lookup", json=body,
        headers=_ui(client),
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "DERIVED_NOT_FOUND"


def test_lookup_denies_cross_project_asset(
    client: TestClient, tmp_path: Path
) -> None:
    project_id, asset_id = _seed_asset(client, tmp_path)
    other = client.post(
        "/api/v1/projects", json={"name": "B10-other"}, headers=_ui(client)
    ).json()
    response = client.post(
        f"/api/v1/projects/{other['project_id']}/derived-media/lookup",
        json={"asset_id": asset_id, "kind": "waveform", "params": {}},
        headers=_ui(client),
    )
    assert response.status_code in (404, 409)
    assert response.json()["error"]["code"] == "ASSET_NOT_FOUND"


def test_resolve_is_admin_only_and_returns_path(
    client: TestClient, tmp_path: Path
) -> None:
    project_id, asset_id = _seed_asset(client, tmp_path)
    state = client.app.state.core
    # 直接经服务层生成一条 ready 条目（FFmpeg 生成作业属 B11+，不在本测）
    key, _ = state.derived_media.cache_key_for(
        project_id, asset_id, "waveform", {"sample_rate": "8000"})
    root = state.derived_cache.begin_build(
        key, "sha256:" + "f" * 64, "waveform", {"sample_rate": "8000"},
        state.derived_media.toolchain_fingerprint,
    )
    assert root is not None
    final = root / "waveform.bin"
    final.write_bytes(b"peaks")
    state.derived_cache.commit_ready(key, "waveform", final)

    body = {"asset_id": asset_id, "kind": "waveform", "params": {"sample_rate": "8000"}}
    # UI token 不能直接 resolve（Renderer 拿不到路径）
    response = client.post(
        f"/api/v1/internal/projects/{project_id}/derived-media/resolve",
        json=body, headers=_ui(client),
    )
    assert response.status_code == 401
    # admin 通道返回路径（Main 内部换票据用）
    response = client.post(
        f"/api/v1/internal/projects/{project_id}/derived-media/resolve",
        json=body, headers=ADMIN,
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ready"
    assert Path(payload["path"]).is_file()
    assert payload["cache_key"].startswith("sha256:")

    # lookup 现在 ready 且不含路径字段
    response = client.post(
        f"/api/v1/projects/{project_id}/derived-media/lookup", json=body,
        headers=_ui(client),
    )
    assert response.status_code == 200
    entry = response.json()
    assert entry["status"] == "ready"
    assert "path" not in entry
    assert str(tmp_path) not in str(entry)


def test_stats_endpoint_reports_usage_without_sensitive_fields(
    client: TestClient, tmp_path: Path
) -> None:
    project_id, _asset_id = _seed_asset(client, tmp_path)
    response = client.get(
        f"/api/v1/projects/{project_id}/derived-media/stats", headers=_ui(client)
    )
    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {"total_ready_bytes", "ready_count", "disk_budget_bytes"}
    assert payload["ready_count"] >= 0
    assert client.get(
        f"/api/v1/projects/{project_id}/derived-media/stats"
    ).status_code == 401
