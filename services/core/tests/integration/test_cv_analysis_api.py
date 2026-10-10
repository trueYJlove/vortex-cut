"""CV 信号分析 Core API 端点层回归（含 Desktop 契约形状锁）。

背景（2026-10-10 Wave1 L3 真机手测自动化现场）：桌面端 parseCvAnalysisSummary
（packages/contracts）要求 algorithm_version 为 **string**，而本路由曾直出 int
常量 CV_ALGORITHM_VERSION ⇒ cv-analysis:get 每次抛
ContractValidationError: CvAnalysisSummary: Invalid contract payload，
UI 永远读不到分析结果（「AI 信号分析」点了像没反应）。
Core 侧单元测试只断言服务层（int），Desktop 侧 IPC 测试把响应 mock 成 string
——两侧各自绿，真实接线必红。本文件把**端点层**的出参类型钉死。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.media.cv_signals import CV_ALGORITHM_VERSION

# Desktop 契约 CvAnalysisSummary 的必填键（缺键在 JS 侧是 undefined ⇒ 校验失败，
# 故这里连键集合一起钉）。
DESKTOP_REQUIRED_KEYS = {
    "analysis_id", "status", "job_id", "algorithm_version",
    "sample_count", "scene_cut_count", "signals",
}


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-cv")
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
        "/api/v1/internal/sessions", headers={"Authorization": "Bearer admin-cv"}
    )
    return {"Authorization": "Bearer " + response.json()["token"]}


ADMIN = {"Authorization": "Bearer admin-cv"}


def _seed_asset(client: TestClient, tmp_path: Path, kind: str = "video") -> tuple[str, str]:
    media = tmp_path / ("material-" + kind + ".bin")
    media.write_bytes(b"cv-media-bytes")
    project = client.post("/api/v1/projects", json={"name": "CV-API"}, headers=_ui(client)).json()
    project_id = project["project_id"]
    grant = client.post(
        "/api/v1/internal/file-grants", json={"path": str(media)}, headers=ADMIN
    ).json()
    asset = client.post(
        "/api/v1/projects/" + project_id + "/assets",
        json={"grant_id": grant["grant_id"], "kind": kind},
        headers=_ui(client),
    ).json()
    state = client.app.state.core
    with state.db.connection() as db:
        db.execute(
            "UPDATE assets SET availability='available', media_info_json=? WHERE id=?",
            (
                '{"duration_us": 12000000, "video_streams": [{"index": 0, "codec": "h264",'
                ' "width": 1280, "height": 720, "fps_num": 30, "fps_den": 1}],'
                ' "audio_streams": [{"index": 1, "codec": "aac", "sample_rate": 48000,'
                ' "channels": 2}]}',
                asset["asset_id"],
            ),
        )
    return project_id, asset["asset_id"]


class TestCvAnalysisEndpoint:
    def test_requires_session(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            "/api/v1/projects/" + project_id + "/assets/" + asset_id + "/cv-analysis", json={}
        )
        assert response.status_code == 401

    def test_summary_matches_desktop_contract(self, client: TestClient, tmp_path: Path) -> None:
        """无分析时摘要仍须满足 Desktop 契约形状（键齐全 + 版本号是字符串）。"""
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            "/api/v1/projects/" + project_id + "/assets/" + asset_id + "/cv-analysis",
            json={"generate": False}, headers=_ui(client),
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert DESKTOP_REQUIRED_KEYS <= set(body)
        assert body["status"] is None and body["analysis_id"] is None
        # 回归锁：Desktop 侧要求 typeof value.algorithm_version === "string"。
        # 负向对照：把 str(...) 还原成裸 int 常量即本断言失败。
        assert isinstance(body["algorithm_version"], str), (
            "algorithm_version 必须是 string（Desktop CvAnalysisSummary 契约）"
        )
        assert body["algorithm_version"] == str(CV_ALGORITHM_VERSION)
        assert isinstance(body["signals"], list) and body["signals"]

    def test_generate_registers_queued_job(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path)
        response = client.post(
            "/api/v1/projects/" + project_id + "/assets/" + asset_id + "/cv-analysis",
            json={"generate": True}, headers=_ui(client),
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "queued" and body["job_id"]
        assert isinstance(body["algorithm_version"], str)
        assert DESKTOP_REQUIRED_KEYS <= set(body)
        # Renderer 可见面不得出现路径字段。
        assert "path" not in response.text
        state = client.app.state.core
        with state.db.connection() as db:
            row = db.execute(
                "SELECT kind,status FROM jobs WHERE id=?", (body["job_id"],)
            ).fetchone()
        assert row["kind"] == "cv_analysis" and row["status"] == "queued"

    def test_non_video_asset_rejected(self, client: TestClient, tmp_path: Path) -> None:
        project_id, asset_id = _seed_asset(client, tmp_path, kind="audio")
        response = client.post(
            "/api/v1/projects/" + project_id + "/assets/" + asset_id + "/cv-analysis",
            json={"generate": True}, headers=_ui(client),
        )
        assert response.status_code >= 400
        assert "CV_ANALYSIS_UNSUPPORTED" in response.text

    def test_cross_project_asset_is_not_found(self, client: TestClient, tmp_path: Path) -> None:
        project_id, _ = _seed_asset(client, tmp_path)
        other, other_asset = _seed_asset(client, tmp_path)
        assert other != project_id
        response = client.post(
            "/api/v1/projects/" + project_id + "/assets/" + other_asset + "/cv-analysis",
            json={"generate": False}, headers=_ui(client),
        )
        assert response.status_code == 404
