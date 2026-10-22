"""W3.3 关键帧外传：**真实 HTTP 路由**层回归（装配层缺陷的回归锁）。

为什么这个文件必须存在（2026-10-21 实测）：
Electron e2e 第一次真实点「关键帧外传审阅 → 准备预览」就 500，而当时
26 项关键帧单元测试全绿——grep -rn 'keyframe-preview' services/core/tests/
是 **0 命中**。全部关键帧单测都直接调 state.keyframe_egress.prepare(...) /
state.keyframe.prepare_preview(...)，**没有任何一条走过 HTTP 路由**，
于是路由函数体里的装配级错误（调用了不存在的方法、漏 await）单元测试
天生测不到：服务层绿，接线层红。

本文件只走 TestClient 的真实路由。断言都钉在**响应**上（状态码 + 领域错误码），
不复述服务层实现。
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.database import utc_now
from aivs_core.jobs import JobService
from aivs_core.media.cv_signals import CV_ALGORITHM_VERSION

ROOT = Path(__file__).resolve().parents[4]
FFMPEG = ROOT / "resources/ffmpeg/win-x64/ffmpeg.exe"
FFPROBE = ROOT / "resources/ffmpeg/win-x64/ffprobe.exe"

pytestmark = pytest.mark.skipif(
    not (FFMPEG.exists() and FFPROBE.exists()), reason="随包 ffmpeg/ffprobe 不在预期位置"
)

ADMIN_TOKEN = "admin-w33-routes"
ADMIN = {"Authorization": "Bearer " + ADMIN_TOKEN}


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """真实路由客户端。

    两处刻意的设置：
    - raise_server_exceptions=False：本文件的核心断言之一是「不再 500」。
      默认行为会把 500 变成**抛异常**，那就永远看不到状态码，回归锁形同虚设。
    - JobService.start 打空：create 会登记 keyframe_tagging 作业行，
      调度循环会立刻真发 HTTP 到 Provider。这里要测的是**路由装配**，
      不是 runner，所以不让循环启动（作业行本身仍照常落库并被断言）。
    """
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", ADMIN_TOKEN)

    async def _never_start(_self: JobService) -> None:
        return None

    monkeypatch.setattr(JobService, "start", _never_start)
    settings = Settings(
        data_dir=tmp_path,
        manifest_dir=tmp_path / "manifests",
        ffmpeg=FFMPEG,
        ffprobe=FFPROBE,
    )
    application = TestClient(create_app(settings), raise_server_exceptions=False)
    with application:  # lifespan 触发 db.initialize（含 v41 迁移）
        yield application


def _ui(client: TestClient) -> dict[str, str]:
    response = client.post("/api/v1/internal/sessions", headers=ADMIN)
    return {"Authorization": "Bearer " + response.json()["token"]}


def _make_video(tmp_path: Path, name: str = "src.mp4") -> Path:
    """合成一段可被真实 ffprobe/ffmpeg 认的视频。"""
    out = tmp_path / name
    command = [
        str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=320x180:duration=3:rate=6",
        "-c:v", "libopenh264", "-pix_fmt", "yuv420p", str(out),
    ]
    asyncio.run(_run(command))
    assert out.is_file() and out.stat().st_size > 0
    return out


def _make_audio(tmp_path: Path, name: str = "src.wav") -> Path:
    out = tmp_path / name
    command = [
        str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1", str(out),
    ]
    asyncio.run(_run(command))
    assert out.is_file() and out.stat().st_size > 0
    return out


async def _run(command: list[str]) -> None:
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    assert process.returncode == 0, stderr.decode("utf-8", errors="replace")


def _new_project(client: TestClient, name: str = "W33-Routes") -> str:
    headers = _ui(client)
    response = client.post("/api/v1/projects", json={"name": name}, headers=headers)
    return response.json()["project_id"]


def _import_asset(client: TestClient, project_id: str, path: Path, kind: str) -> str:
    grant = client.post(
        "/api/v1/internal/file-grants", json={"path": str(path)}, headers=ADMIN
    ).json()
    response = client.post(
        f"/api/v1/projects/{project_id}/assets",
        json={"grant_id": grant["grant_id"], "kind": kind},
        headers=_ui(client),
    )
    assert response.status_code == 201, response.text
    return response.json()["asset_id"]


def _create_provider(client: TestClient, name: str = "审阅用 Provider") -> str:
    response = client.post(
        "/api/v1/providers",
        json={
            "kind": "openai_compatible_text",
            "display_name": name,
            "base_url": "http://127.0.0.1:9",
            "model": "vision-model",
        },
        headers=_ui(client),
    )
    assert response.status_code == 200, response.text
    return response.json()["provider_config_id"]


def _grant_vision_capability(client: TestClient, provider_id: str) -> None:
    """把 Provider 置为已通过 vision 探测（v41 触发器要求六列自洽）。

    只能直改库：六列不在 create/patch 的字段白名单里（绕开「先探测、后放行」
    正是 A4 要防的旁路），所以测试用库夹具补这一状态。
    """
    state = client.app.state.core
    now = utc_now()
    with state.db.connection() as db:
        db.execute(
            "UPDATE provider_configs SET vision_capability_status='supported',"
            "vision_capability_tested_at=?, vision_response_adapter_id=?,"
            "vision_probe_protocol_version='1', vision_capability_failure_code=NULL,"
            "vision_capability_probe_sha256=? WHERE id=?",
            (
                now,
                "openai_chat_completions_image_url_v1",
                "sha256:" + "0" * 64,
                provider_id,
            ),
        )


def _seed_cv_analysis(client: TestClient, asset_id: str, cut_times: list[int]) -> None:
    """登记一份 ready 的 CV 分析（决定 sampling_mode 走 scene_cut）。"""
    state = client.app.state.core
    with state.db.connection() as db:
        asset = db.execute(
            "SELECT fingerprint FROM assets WHERE id=?", (asset_id,)
        ).fetchone()
        now = utc_now()
        db.execute(
            "INSERT INTO cv_analyses (id,asset_id,source_fingerprint,algorithm_version,"
            "status,model_revision,sample_count,scene_cut_count,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                "cva_routes", asset_id, asset["fingerprint"], CV_ALGORITHM_VERSION,
                "ready", None, len(cut_times), len(cut_times), now, now,
            ),
        )
        for index, timestamp in enumerate(cut_times):
            db.execute(
                "INSERT INTO cv_samples (id,analysis_id,sample_index,timestamp_us,"
                "scene_cut,motion_energy,sharpness,brightness) VALUES (?,?,?,?,?,?,?,?)",
                (f"cvs_routes_{index}", "cva_routes", index, timestamp, 1, 0.5, 0.5, 0.5),
            )


def _set_availability(client: TestClient, asset_id: str, value: str) -> None:
    state = client.app.state.core
    with state.db.connection() as db:
        db.execute("UPDATE assets SET availability=? WHERE id=?", (value, asset_id))


@pytest.fixture()
def graded(client: TestClient, tmp_path: Path) -> dict[str, str]:
    """项目 + 真实视频素材 + Provider（三者互相独立地失败时更易定位）。"""
    project_id = _new_project(client)
    asset_id = _import_asset(client, project_id, _make_video(tmp_path), "video")
    provider_id = _create_provider(client)
    return {"project_id": project_id, "asset_id": asset_id, "provider_id": provider_id}


def _preview(client: TestClient, graded: dict[str, str], **overrides: object):
    payload: dict[str, object] = {"provider_config_id": graded["provider_id"]}
    payload.update(overrides)
    return client.post(
        f"/api/v1/projects/{graded['project_id']}/assets/{graded['asset_id']}"
        "/keyframe-preview",
        json=payload,
        headers=_ui(client),
    )


# ── prepare（POST .../keyframe-preview）──


class TestKeyframePreviewRoute:
    def test_preview_route_no_longer_500s_and_returns_frame_list(
        self, client: TestClient, graded: dict[str, str]
    ) -> None:
        """**本次缺陷的直接回归锁**。

        修好之前这条路由有两个装配缺陷，任一个都会让真实 HTTP 请求 500：
          1. state.providers.require(...) —— ProviderRepository 没有该方法；
          2. state.ffprobe.probe(...) 缺 await（且入参是 str、读的是属性）。
        单测不经过路由 ⇒ 两者都测不到。这里断言的是**响应**，不是服务层对象。
        """
        response = _preview(client, graded)
        assert response.status_code != 500, response.text
        assert response.status_code == 200, response.text
        body = response.json()
        # 逐帧清单（不是「共 N 张」的汇总）
        assert isinstance(body["frames"], list) and body["frames"]
        for frame in body["frames"]:
            assert isinstance(frame["frame_index"], int)
            assert isinstance(frame["timestamp_us"], int)
            assert frame["payload_bytes"] > 0
        # 实测外传字节合计必须 > 0（A6：实测，不是推算）
        assert body["total_frame_bytes"] > 0
        assert body["total_frame_bytes"] == sum(f["payload_bytes"] for f in body["frames"])
        assert body["excluded_frames"] == []
        assert isinstance(body["keyframe_egress_preview_id"], str)
        assert len(body["payload_sha256"]) == 64

    def test_preview_defaults_to_interval_only_without_cv_analysis(
        self, client: TestClient, graded: dict[str, str]
    ) -> None:
        """没做过 CV 分析 ⇒ interval_only（如实上报降级，不伪装成 scene_cut）。"""
        response = _preview(client, graded)
        assert response.status_code == 200, response.text
        assert response.json()["sampling_mode"] == "interval_only"

    def test_preview_uses_scene_cut_when_analysis_present(
        self, client: TestClient, graded: dict[str, str]
    ) -> None:
        _seed_cv_analysis(client, graded["asset_id"], [1_000_000, 2_000_000])
        response = _preview(client, graded)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["sampling_mode"] == "scene_cut"
        assert body["covered_scene_cuts"] == 2
        assert "scene_cut" in {frame["source_reason"] for frame in body["frames"]}

    def test_preview_rejects_non_video_asset_with_domain_code(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """不是视频 ⇒ 领域错误码，不是 500。"""
        project_id = _new_project(client, "W33-Routes-Audio")
        asset_id = _import_asset(client, project_id, _make_audio(tmp_path), "audio")
        provider_id = _create_provider(client)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/keyframe-preview",
            json={"provider_config_id": provider_id},
            headers=_ui(client),
        )
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "VISION_FRAMES_UNMAPPED"

    def test_preview_rejects_unavailable_asset_with_domain_code(
        self, client: TestClient, graded: dict[str, str]
    ) -> None:
        _set_availability(client, graded["asset_id"], "missing")
        response = _preview(client, graded)
        assert response.status_code == 409, response.text
        assert response.json()["error"]["code"] == "ASSET_MISSING"

    def test_preview_rejects_unknown_provider_with_domain_code(
        self, client: TestClient, graded: dict[str, str]
    ) -> None:
        """Provider 不存在 ⇒ PROVIDER_NOT_FOUND(404)，不是 500。

        这条同时是缺陷 1 的负向对照：providers.require 不存在时，
        连「Provider 不存在」都走不到，直接 AttributeError ⇒ 500。
        """
        response = _preview(client, graded, provider_config_id="provider_does_not_exist")
        assert response.status_code != 500, response.text
        assert response.status_code == 404, response.text
        assert response.json()["error"]["code"] == "PROVIDER_NOT_FOUND"

    def test_preview_requires_ui_session(
        self, client: TestClient, graded: dict[str, str]
    ) -> None:
        response = client.post(
            f"/api/v1/projects/{graded['project_id']}/assets/{graded['asset_id']}"
            "/keyframe-preview",
            json={"provider_config_id": graded["provider_id"]},
        )
        assert response.status_code == 401


# ── exclude（POST .../keyframe-preview/{id}/exclude）──


class TestKeyframeExcludeRoute:
    def test_exclude_persists_and_recomputes_hash(
        self, client: TestClient, graded: dict[str, str]
    ) -> None:
        """逐张移除走真实路由：排除集合落库、哈希随真实字节重算。"""
        prepared = _preview(client, graded)
        assert prepared.status_code == 200, prepared.text
        preview = prepared.json()

        response = client.post(
            f"/api/v1/projects/{graded['project_id']}/keyframe-preview/"
            f"{preview['keyframe_egress_preview_id']}/exclude",
            json={"frame_indices": [0]},
            headers=_ui(client),
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["excluded_frames"] == [0]
        assert body["payload_sha256"] != preview["payload_sha256"]
        # 仍是同一份预览，不是新造的
        assert body["keyframe_egress_preview_id"] == preview["keyframe_egress_preview_id"]
        # 只增不改：再排除一帧是累加
        again = client.post(
            f"/api/v1/projects/{graded['project_id']}/keyframe-preview/"
            f"{preview['keyframe_egress_preview_id']}/exclude",
            json={"frame_indices": [0, 1]},
            headers=_ui(client),
        )
        assert again.status_code == 200, again.text
        assert again.json()["excluded_frames"] == [0, 1]

    def test_exclude_rejects_unknown_frame_with_domain_code(
        self, client: TestClient, graded: dict[str, str]
    ) -> None:
        preview = _preview(client, graded).json()
        response = client.post(
            f"/api/v1/projects/{graded['project_id']}/keyframe-preview/"
            f"{preview['keyframe_egress_preview_id']}/exclude",
            json={"frame_indices": [999]},
            headers=_ui(client),
        )
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "VISION_FRAMES_UNMAPPED"


# ── create（POST .../keyframe-preview/{id}/create）──


class TestKeyframeCreateRoute:
    def test_create_queues_consent_generation_and_job(
        self, client: TestClient, graded: dict[str, str]
    ) -> None:
        """同意即外传：create 建 consent + generation + 作业行，仍不发网络。"""
        _grant_vision_capability(client, graded["provider_id"])
        preview = _preview(client, graded).json()

        response = client.post(
            f"/api/v1/projects/{graded['project_id']}/keyframe-preview/"
            f"{preview['keyframe_egress_preview_id']}/create",
            json={"payload_sha256": preview["payload_sha256"]},
            headers=_ui(client),
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "queued"
        assert body["consent_id"].startswith("keyframe_consent_")
        assert body["keyframe_generation_id"].startswith("keyframe_gen_")

        state = client.app.state.core
        with state.db.connection() as db:
            generation = db.execute(
                "SELECT status, project_id FROM keyframe_generations WHERE id=?",
                (body["keyframe_generation_id"],),
            ).fetchone()
            assert generation is not None
            assert generation["status"] == "queued"
            assert generation["project_id"] == graded["project_id"]
            # 没有作业行 ⇒ 生成永远停在 queued（W3.3 收口前的生产断点）
            job = db.execute(
                "SELECT status FROM jobs WHERE kind='keyframe_tagging'"
                " AND input_json LIKE ? ORDER BY created_at DESC LIMIT 1",
                (f"%{body['keyframe_generation_id']}%",),
            ).fetchone()
            assert job is not None
            assert job["status"] == "queued"

    def test_create_rejects_unprobed_provider_with_domain_code(
        self, client: TestClient, graded: dict[str, str]
    ) -> None:
        """fail-closed：Provider 未通过 vision 探测 ⇒ 领域错误码，不是 500。"""
        preview = _preview(client, graded).json()
        response = client.post(
            f"/api/v1/projects/{graded['project_id']}/keyframe-preview/"
            f"{preview['keyframe_egress_preview_id']}/create",
            json={"payload_sha256": preview["payload_sha256"]},
            headers=_ui(client),
        )
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "VISION_PROVIDER_UNSUPPORTED"

    def test_create_rejects_stale_payload_hash_with_domain_code(
        self, client: TestClient, graded: dict[str, str]
    ) -> None:
        """移除一帧后旧哈希失效 ⇒ 必须重新审阅（同意不能跨载荷继承）。"""
        _grant_vision_capability(client, graded["provider_id"])
        preview = _preview(client, graded).json()
        client.post(
            f"/api/v1/projects/{graded['project_id']}/keyframe-preview/"
            f"{preview['keyframe_egress_preview_id']}/exclude",
            json={"frame_indices": [0]},
            headers=_ui(client),
        )
        response = client.post(
            f"/api/v1/projects/{graded['project_id']}/keyframe-preview/"
            f"{preview['keyframe_egress_preview_id']}/create",
            json={"payload_sha256": preview["payload_sha256"]},
            headers=_ui(client),
        )
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "KEYFRAME_PREVIEW_EXPIRED"
