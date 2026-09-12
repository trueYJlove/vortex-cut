"""B16 调度器 Core API 集成测试（lease 端点 + 调度观测）。

覆盖（计划第 6.1 节四层测试——本文件是 Core 层）：
- lease 端点：admin 通道（UI token 401）；合法 mode 心跳生效（lease
  快照反映 playing/scrubbing）；非法 mode 400；窗口 owner 透传。
- 调度观测端点：admin 通道返回容量/持有/lease 快照。
- lease 语义联动：playing 心跳后 scheduler admit 重任务被暂缓（单测
  已覆盖——本层以端点写入 + snapshot 验证贯通）。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-b16")
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
        "/api/v1/internal/sessions", headers={"Authorization": "Bearer admin-b16"}
    )
    return {"Authorization": f"Bearer {response.json()['token']}"}


ADMIN = {"Authorization": "Bearer admin-b16"}


class TestEditorLoadLeaseEndpoint:
    def test_heartbeat_sets_mode_and_window(self, client: TestClient) -> None:
        response = client.post(
            "/api/v1/internal/editor-load-lease",
            json={"window_id": "win-1-abcd", "mode": "playing"}, headers=ADMIN,
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok" and payload["mode"] == "playing"
        state = client.app.state.core
        snapshot = state.job_scheduler.snapshot()
        assert snapshot["lease"]["mode"] == "playing"
        assert snapshot["lease"]["window_id"] == "win-1-abcd"

    def test_ui_token_rejected(self, client: TestClient) -> None:
        response = client.post(
            "/api/v1/internal/editor-load-lease",
            json={"window_id": "win-1", "mode": "idle"}, headers=_ui(client),
        )
        assert response.status_code == 401

    def test_invalid_mode_rejected(self, client: TestClient) -> None:
        response = client.post(
            "/api/v1/internal/editor-load-lease",
            json={"window_id": "win-1", "mode": "bogus"}, headers=ADMIN,
        )
        assert response.status_code == 400

    def test_unknown_fields_rejected(self, client: TestClient) -> None:
        response = client.post(
            "/api/v1/internal/editor-load-lease",
            json={"window_id": "win-1", "mode": "idle", "extra": 1}, headers=ADMIN,
        )
        assert response.status_code in (400, 422)  # extra=forbid（422 映射 400）


class TestSchedulerStatsEndpoint:
    def test_admin_snapshot_shape(self, client: TestClient) -> None:
        response = client.get(
            "/api/v1/internal/job-scheduler/stats", headers=ADMIN,
        )
        assert response.status_code == 200
        payload = response.json()
        assert set(payload) == {"capacity", "held", "admissions", "lease"}
        assert payload["capacity"]["network"] == 2
        assert payload["capacity"]["light"] == 2
        assert payload["capacity"]["cpu_heavy"] == 1
        assert payload["lease"]["mode"] == "idle"  # 无心跳 = idle
        # UI token 拒绝
        assert client.get(
            "/api/v1/internal/job-scheduler/stats", headers=_ui(client)
        ).status_code == 401
