from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()
FFPROBE = Path("resources/ffmpeg/win-x64/ffprobe.exe").resolve()
FONT_DIR = Path("resources/fonts").resolve()


def _run(*args: str) -> str:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-y", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr[-2000:])
    return result.stderr


def _probe_fixture(path: Path) -> dict:
    result = subprocess.run(
        [str(FFPROBE), "-v", "error", "-show_streams", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=True,
    )
    return json.loads(result.stdout)


def _fixtures(root: Path) -> tuple[Path, Path, Path, Path]:
    media = root / "中文 媒体"
    media.mkdir()
    rotation_base = media / "rotation-base.mp4"
    rotated = media / "rotated-90.mp4"
    video = media / "横屏 有声.mp4"
    no_audio = media / "奇数尺寸 无声.mkv"
    image = media / "静态图片.png"
    _run(
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30:duration=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:sample_rate=48000:duration=2",
        "-c:v",
        "libopenh264",
        "-b:v",
        "1M",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        str(video),
    )
    _run(
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=321x241:rate=24:duration=1",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=321x241:rate=15:duration=1",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-fps_mode",
        "vfr",
        "-an",
        "-c:v",
        "ffv1",
        "-pix_fmt",
        "yuv444p",
        str(no_audio),
    )
    _run(
        "-f",
        "lavfi",
        "-i",
        "color=c=0x336699:size=427x319:duration=0.1",
        "-frames:v",
        "1",
        str(image),
    )
    _run(
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30:duration=1",
        "-an",
        "-c:v",
        "libopenh264",
        "-b:v",
        "1M",
        "-pix_fmt",
        "yuv420p",
        str(rotation_base),
    )
    _run(
        "-display_rotation",
        "90",
        "-i",
        str(rotation_base),
        "-c",
        "copy",
        str(rotated),
    )
    vfr_stream = _probe_fixture(no_audio)["streams"][0]
    assert vfr_stream["r_frame_rate"] != vfr_stream["avg_frame_rate"]
    rotated_stream = _probe_fixture(rotated)["streams"][0]
    assert any(
        abs(int(item.get("rotation", 0))) == 90
        for item in rotated_stream.get("side_data_list", [])
    )
    return video, no_audio, image, rotated


def _wait_job(client: TestClient, ui: dict[str, str], job_id: str) -> dict:
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        job = client.get(f"/api/v1/jobs/{job_id}", headers=ui).json()
        if job["status"] in {"succeeded", "failed", "cancelled", "interrupted"}:
            return job
        time.sleep(0.1)
    raise TimeoutError(job_id)


def test_real_preview_export_reuse_stale_fingerprint_and_ssim(
    tmp_path: Path, monkeypatch
) -> None:
    video, no_audio, image, rotated = _fixtures(tmp_path)
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-render")
    settings = Settings(
        data_dir=tmp_path / "data",
        ffmpeg=FFMPEG,
        ffprobe=FFPROBE,
        font_dir=FONT_DIR,
        manifest_dir=tmp_path / "manifests",
    )
    settings.manifest_dir.mkdir()
    app = create_app(settings)
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer admin-render"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        project_id = client.post(
            "/api/v1/projects", headers=ui, json={"name": "真实渲染"}
        ).json()["project_id"]
        asset_ids = []
        for kind, path in (
            ("video", video),
            ("video", no_audio),
            ("image", image),
            ("video", rotated),
        ):
            grant = client.post(
                "/api/v1/internal/file-grants", headers=admin, json={"path": str(path)}
            ).json()
            response = client.post(
                f"/api/v1/projects/{project_id}/assets",
                headers=ui,
                json={"grant_id": grant["grant_id"], "kind": kind},
            )
            assert response.status_code == 201, response.text
            asset_ids.append(response.json()["asset_id"])
        state = client.post(
            f"/api/v1/projects/{project_id}/timelines",
            headers=ui,
            json={
                "schema_version": 1,
                "source": {"kind": "empty"},
                "default_layout": "blurred_background",
                "caption_preset_id": "default-bottom",
            },
        ).json()
        state = client.post(
            f"/api/v1/projects/{project_id}/timeline/patches",
            headers=ui,
            json={
                "schema_version": 1,
                "base_revision_id": state["current_revision"]["timeline_revision_id"],
                "operations": [
                    {
                        "op": "insert_asset_clip",
                        "asset_id": asset_ids[0],
                        "at_index": 0,
                        "source_start_us": 0,
                        "source_end_us": 1_000_000,
                        "layout": "blurred_background",
                    },
                    {
                        "op": "insert_asset_clip",
                        "asset_id": asset_ids[1],
                        "at_index": 1,
                        "source_start_us": 0,
                        "source_end_us": 1_000_000,
                        "layout": "crop_fill",
                    },
                    {
                        "op": "insert_asset_clip",
                        "asset_id": asset_ids[2],
                        "at_index": 2,
                        "duration_us": 1_000_000,
                        "layout": "fit",
                    },
                    {
                        "op": "insert_asset_clip",
                        "asset_id": asset_ids[3],
                        "at_index": 3,
                        "source_start_us": 0,
                        "source_end_us": 1_000_000,
                        "layout": "fit",
                    },
                    {
                        "op": "add_caption",
                        "start_us": 200_000,
                        "end_us": 900_000,
                        "text": "真实中文 Caption {安全}",
                        "preset_id": "high-contrast",
                        "source_clip_id": None,
                    },
                ],
                "summary": "构建真实渲染时间线",
            },
        ).json()
        revision1 = state["current_revision"]["timeline_revision_id"]
        preview_response = client.post(
            f"/api/v1/projects/{project_id}/previews",
            headers=ui,
            json={"timeline_revision_id": revision1, "encoder_mode": "software"},
        )
        assert preview_response.status_code == 200, preview_response.text
        assert set(preview_response.json()) == {"job", "preview", "reused"}
        assert preview_response.json()["preview"] is None
        assert preview_response.json()["reused"] is False
        assert "destination_path" not in preview_response.json()["job"]["input"]
        preview_job = _wait_job(client, ui, preview_response.json()["job"]["job_id"])
        assert preview_job["status"] == "succeeded", preview_job
        preview_id = preview_job["result"]["render_artifact_id"]
        preview = client.get(f"/api/v1/render-artifacts/{preview_id}", headers=ui).json()
        assert set(preview) == {
            "render_artifact_id",
            "project_id",
            "timeline_revision_id",
            "kind",
            "status",
            "content_fingerprint",
            "profile_id",
            "display_name",
            "size_bytes",
            "sha256",
            "media_info",
            "encoder",
            "fallback_reason",
            "created_at",
        }
        assert preview["media_info"]["video"] == {
            "codec": "h264",
            "width": 540,
            "height": 960,
            "pixel_format": "yuv420p",
            "fps_num": 30,
            "fps_den": 1,
        }
        assert preview["media_info"]["audio"]["sample_rate"] == 48000
        current_state = client.get(
            f"/api/v1/projects/{project_id}/timeline", headers=ui
        ).json()
        assert current_state["current_preview"] == preview
        reused = client.post(
            f"/api/v1/projects/{project_id}/previews",
            headers=ui,
            json={"timeline_revision_id": revision1, "encoder_mode": "software"},
        ).json()
        assert reused == {"job": None, "preview": preview, "reused": True}
        first_clip = state["current_revision"]["document"]["clips"][0]
        state = client.post(
            f"/api/v1/projects/{project_id}/timeline/patches",
            headers=ui,
            json={
                "schema_version": 1,
                "base_revision_id": revision1,
                "operations": [
                    {
                        "op": "set_layout",
                        "clip_id": first_clip["clip_id"],
                        "layout": first_clip["layout"],
                    }
                ],
                "summary": "创建相同内容的新 Revision",
            },
        ).json()
        revision2 = state["current_revision"]["timeline_revision_id"]
        assert state["current_preview"] is None
        assert client.get(
            f"/api/v1/projects/{project_id}/timeline", headers=ui
        ).json()["current_preview"] is None
        previews = client.get(f"/api/v1/projects/{project_id}/previews", headers=ui).json()
        assert previews["items"][0]["status"] == "stale"
        destination = tmp_path / "导出 结果.mp4"
        destination_grant = client.post(
            "/api/v1/internal/destination-grants",
            headers=admin,
            json={"path": str(destination.resolve()), "overwrite_authorized": False},
        ).json()
        assert set(destination_grant) == {
            "destination_grant_id",
            "display_name",
            # 导出弹窗"保存位置"行需要回显用户自选目录（见 rendering/service.py
            # 的目录展示串注释：用户经原生对话框自选的回显路径，非内部路径泄露）。
            # 该键由导出弹窗功能引入，本断言此前未跟随更新——2026-09-24 补。
            "directory_display",
            "extension",
            "overwrite_authorized",
            "expires_at",
        }
        # 隐私守卫：完整目标路径不得出现在 DTO（`directory_display` 仅为父目录）。
        assert str(destination.resolve()) not in str(destination_grant)
        export_response = client.post(
            f"/api/v1/projects/{project_id}/exports",
            headers=ui,
            json={
                "timeline_revision_id": revision2,
                "destination_grant_id": destination_grant["destination_grant_id"],
                "encoder_mode": "software",
            },
        )
        assert export_response.status_code == 200, export_response.text
        assert set(export_response.json()) == {"job", "export_record"}
        assert export_response.json()["export_record"] is None
        assert "destination_path" not in export_response.json()["job"]["input"]
        export_job = _wait_job(client, ui, export_response.json()["job"]["job_id"])
        assert export_job["status"] == "succeeded", export_job
        export_record_id = export_job["result"]["export_record_id"]
        exports = client.get(f"/api/v1/projects/{project_id}/exports", headers=ui).json()
        export_record = next(
            item for item in exports["items"] if item["export_record_id"] == export_record_id
        )
        assert set(export_record) == {
            "export_record_id",
            "project_id",
            "timeline_revision_id",
            "render_artifact_id",
            "status",
            "profile_id",
            "destination_display_name",
            "size_bytes",
            "sha256",
            "media_info",
            "encoder",
            "fallback_reason",
            "created_at",
        }
        assert export_record["media_info"]["video"]["width"] == 1080
        export_artifact = client.get(
            f"/api/v1/render-artifacts/{export_record['render_artifact_id']}", headers=ui
        ).json()
        # c9875e2 起输出规格参与 content_fingerprint（preview 540 vs export 1080
        # 是不同渲染产物，防跨比例误复用）：同一时间线内容跨 profile 指纹
        # 必然不同。内容等价性由下方 duration 容差与 SSIM 校验承担。
        assert re.fullmatch(r"sha256:[a-f0-9]{64}", export_artifact["content_fingerprint"])
        assert export_artifact["content_fingerprint"] != preview["content_fingerprint"]
        preview_path = Path(
            client.get(
                f"/api/v1/internal/artifacts/{preview_id}/resolve", headers=admin
            ).json()["path"]
        )
        ssim_log = _run(
            "-i",
            str(preview_path),
            "-i",
            str(destination),
            "-lavfi",
            "[1:v]scale=540:960[export];[0:v][export]ssim",
            "-f",
            "null",
            "-",
        )
        match = re.search(r"All:([0-9.]+)", ssim_log)
        assert match and float(match.group(1)) >= 0.95, ssim_log[-1000:]
        evidence_value = os.environ.get("AIVS_STAGE1C_EVIDENCE_DIR")
        if evidence_value:
            evidence_dir = Path(evidence_value).resolve()
            evidence_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(preview_path, evidence_dir / "preview.mp4")
            shutil.copy2(destination, evidence_dir / "export.mp4")
            (evidence_dir / "api-dtos.json").write_text(
                json.dumps(
                    {
                        "preview_create": preview_response.json(),
                        "preview": preview,
                        "timeline_state": current_state,
                        "destination_grant": destination_grant,
                        "export_create": export_response.json(),
                        "export_record": export_record,
                        "export_artifact": export_artifact,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            (evidence_dir / "validation.json").write_text(
                json.dumps(
                    {
                        "ssim": float(match.group(1)),
                        "content_fingerprint": preview["content_fingerprint"],
                        "preview_sha256": preview["sha256"],
                        "export_sha256": export_record["sha256"],
                        "preview_media_info": preview["media_info"],
                        "export_media_info": export_record["media_info"],
                        "vfr_source": _probe_fixture(no_audio)["streams"][0],
                        "rotated_source": _probe_fixture(rotated)["streams"][0],
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
        assert abs(
            preview["media_info"]["duration_us"]
            - export_record["media_info"]["duration_us"]
        ) <= 83_334
        image_clip = state["current_revision"]["document"]["clips"][2]
        long_state = client.post(
            f"/api/v1/projects/{project_id}/timeline/patches",
            headers=ui,
            json={
                "schema_version": 1,
                "base_revision_id": revision2,
                "operations": [
                    {
                        "op": "set_image_duration",
                        "clip_id": image_clip["clip_id"],
                        "duration_us": 30_000_000,
                    }
                ],
                "summary": "取消测试长片段",
            },
        ).json()
        cancel_response = client.post(
            f"/api/v1/projects/{project_id}/previews",
            headers=ui,
            json={
                "timeline_revision_id": long_state["current_revision"][
                    "timeline_revision_id"
                ],
                "encoder_mode": "software",
            },
        ).json()
        cancel_job_id = cancel_response["job"]["job_id"]
        worker_pid = None
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and worker_pid is None:
            with client.app.state.core.db.connection() as db:
                row = db.execute(
                    "SELECT status,worker_pid FROM jobs WHERE id=?", (cancel_job_id,)
                ).fetchone()
            if row["status"] == "running" and row["worker_pid"]:
                worker_pid = int(row["worker_pid"])
                break
            time.sleep(0.02)
        assert worker_pid is not None
        cancelled = client.post(f"/api/v1/jobs/{cancel_job_id}/cancel", headers=ui)
        assert cancelled.status_code == 200
        cancelled_job = _wait_job(client, ui, cancel_job_id)
        assert cancelled_job["status"] == "cancelled"
        with client.app.state.core.db.connection() as db:
            assert db.execute(
                "SELECT COUNT(*) FROM artifacts WHERE job_id=?", (cancel_job_id,)
            ).fetchone()[0] == 0
        # 字节级比较：tasklist 输出为系统本地编码（中文 Windows = GBK），
        # text=True 按平台默认 UTF-8 解码会抛错使 stdout 为 None。
        tasklist = subprocess.run(
            ["tasklist", "/FI", f"PID eq {worker_pid}"],
            capture_output=True,
            timeout=10,
            check=False,
        ).stdout
        assert str(worker_pid).encode("ascii") not in (tasklist or b"")
        if evidence_value:
            (Path(evidence_value).resolve() / "cancel.json").write_text(
                json.dumps(
                    {
                        "job_id": cancel_job_id,
                        "worker_pid": worker_pid,
                        "job_status": cancelled_job["status"],
                        "tasklist": tasklist,
                        "artifact_count": 0,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
        destination.write_bytes(b"old-target")
        overwrite = client.post(
            "/api/v1/internal/destination-grants",
            headers=admin,
            json={"path": str(destination.resolve()), "overwrite_authorized": True},
        ).json()
        video.write_bytes(video.read_bytes() + b"changed")
        failed = client.post(
            f"/api/v1/projects/{project_id}/exports",
            headers=ui,
            json={
                "timeline_revision_id": revision2,
                "destination_grant_id": overwrite["destination_grant_id"],
                "encoder_mode": "software",
            },
        )
        assert failed.status_code == 200
        failed_job = _wait_job(client, ui, failed.json()["job"]["job_id"])
        assert failed_job["status"] == "failed"
        assert failed_job["error"]["code"] == "ASSET_CHANGED"
        assert destination.read_bytes() == b"old-target"
