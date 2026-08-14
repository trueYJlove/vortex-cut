from __future__ import annotations

import asyncio
import json
import subprocess
import time
from pathlib import Path

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.providers import StructuredTextResult

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()
FFPROBE = Path("resources/ffmpeg/win-x64/ffprobe.exe").resolve()
FONT_DIR = Path("resources/fonts").resolve()


class FixedProvider:
    async def generate(self, request, cancel_event: asyncio.Event) -> StructuredTextResult:
        del request
        if cancel_event.is_set():
            raise RuntimeError("cancelled")
        clips = [
            {"segment_ids": ["s1"], "reason": "first selected segment", "model_score": 0.8},
            {"segment_ids": ["s2"], "reason": "second selected segment", "model_score": 0.8},
        ]
        return StructuredTextResult(
            {
                "candidates": [
                    {
                        "variant": variant,
                        "title_suggestion": f"{variant} local plan",
                        "summary": "fixed local provider plan",
                        "clips": clips,
                    }
                    for variant in ("balanced", "compact", "bold")
                ]
            },
            {"total_tokens": 12},
            "fixed-local-request",
        )


def _make_media(path: Path) -> None:
    result = subprocess.run(
        [
            str(FFMPEG),
            "-hide_banner",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=30:duration=15",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=15",
            "-c:v",
            "libopenh264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            str(path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stderr[-2000:]


def _wait(client: TestClient, ui: dict[str, str], job_id: str) -> dict:
    for _ in range(1200):
        job = client.get(f"/api/v1/jobs/{job_id}", headers=ui).json()
        if job["status"] in {"succeeded", "failed", "cancelled", "interrupted"}:
            return job
        time.sleep(0.1)
    raise AssertionError(f"job did not finish: {job_id}")


def test_candidate_adopt_undo_redo_authoritative_preview_and_export(tmp_path, monkeypatch) -> None:
    media = tmp_path / "source.mp4"
    destination = tmp_path / "candidate-export.mp4"
    _make_media(media)
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-stage2a-real")
    settings = Settings(
        data_dir=tmp_path / "data",
        ffmpeg=FFMPEG,
        ffprobe=FFPROBE,
        font_dir=FONT_DIR,
        manifest_dir=tmp_path / "manifests",
    )
    settings.manifest_dir.mkdir()
    with TestClient(create_app(settings)) as client:
        admin = {"Authorization": "Bearer admin-stage2a-real"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        project_id = client.post(
            "/api/v1/projects", headers=ui, json={"name": "candidate render fixture"}
        ).json()["project_id"]
        grant = client.post(
            "/api/v1/internal/file-grants", headers=admin, json={"path": str(media)}
        ).json()
        imported = client.post(
            f"/api/v1/projects/{project_id}/assets",
            headers=ui,
            json={"grant_id": grant["grant_id"], "kind": "video"},
        )
        assert imported.status_code == 201, imported.text
        asset_id = imported.json()["asset_id"]
        with client.app.state.core.db.connection() as db:
            asset = db.execute(
                "SELECT fingerprint,media_info_json FROM assets WHERE id=?", (asset_id,)
            ).fetchone()
            assert asset is not None
            media_info = json.loads(asset["media_info_json"])
            duration_us = int(media_info["duration_us"])
            fingerprint = asset["fingerprint"]
            db.execute(
                "INSERT INTO transcripts(id,asset_id,status,language,provider,model_id,"
                "model_revision,source_fingerprint,duration_us,created_at,updated_at) "
                "VALUES ('real-t1',?,'ready','en','fixture','m','r',?,?,?,?)",
                (asset_id, fingerprint, duration_us, "now", "now"),
            )
            db.execute(
                "INSERT INTO transcript_segments("
                "id,transcript_id,ordinal,start_us,end_us,text,confidence) "
                "VALUES ('s1','real-t1',0,0,7500000,'opening segment',0.95),"
                "('s2','real-t1',1,7500000,15000000,'closing segment',0.95)"
            )
        timeline = client.post(
            f"/api/v1/projects/{project_id}/timelines",
            headers=ui,
            json={
                "schema_version": 1,
                "source": {"kind": "empty"},
                "default_layout": "fit",
                "caption_preset_id": "default-bottom",
            },
        )
        assert timeline.status_code == 201, timeline.text
        baseline = timeline.json()["current_revision"]["timeline_revision_id"]
        brief = {
            "schema_version": 1,
            "topic": "local video",
            "audience": "test audience",
            "target_platform": "generic_vertical",
            "target_duration_us": 15_000_000,
            "narrative_goal": "opening closing",
            "style_notes": "",
            "must_keep": [],
            "forbidden": [],
            "original_audio_policy": "preserve",
            "caption_policy": "auto_from_transcript",
            "caption_preset_id": "default-bottom",
            "default_layout": "fit",
        }
        brief_response = client.put(f"/api/v1/projects/{project_id}/brief", headers=ui, json=brief)
        assert brief_response.status_code == 200
        provider = client.post(
            "/api/v1/providers",
            headers=ui,
            json={
                "kind": "openai_compatible_text",
                "display_name": "fixture provider",
                "base_url": "http://127.0.0.1:9999/v1",
                "model": "fixture",
            },
        ).json()
        provider_id = provider["provider_config_id"]
        assert (
            client.put(
                f"/api/v1/internal/provider-secrets/{provider_id}",
                headers=admin,
                json={"secret": "fixture-secret"},
            ).status_code
            == 200
        )
        with client.app.state.core.db.connection() as db:
            db.execute(
                "UPDATE provider_configs SET candidate_capability_status='supported',"
                "candidate_response_adapter_id='openai_chat_completions_json_schema_v1',"
                "candidate_probe_protocol_version='1',candidate_capability_tested_at='now',"
                "candidate_capability_probe_sha256='sha256:fixture' WHERE id=?",
                (provider_id,),
            )
        client.app.state.core.planning.provider_factory = FixedProvider
        preview = client.post(
            f"/api/v1/projects/{project_id}/candidate-generations/prepare",
            headers=ui,
            json={
                "provider_config_id": provider_id,
                "recipe_id": "balanced-narrative-v1",
                "transcript_ids": ["real-t1"],
            },
        )
        assert preview.status_code == 200, preview.text
        preview_body = preview.json()
        created = client.post(
            f"/api/v1/projects/{project_id}/candidate-generations",
            headers=ui,
            json={
                "egress_preview_id": preview_body["egress_preview_id"],
                "payload_sha256": preview_body["payload_sha256"],
            },
        )
        assert created.status_code == 200, created.text
        generation_job = _wait(client, ui, created.json()["job"]["job_id"])
        assert generation_job["status"] == "succeeded", generation_job
        plans_response = client.get(f"/api/v1/projects/{project_id}/candidate-plans", headers=ui)
        plans = plans_response.json()["items"]
        candidate = next(item for item in plans if item["variant"] == "balanced")
        adopted = client.post(
            f"/api/v1/projects/{project_id}/candidate-plans/{candidate['candidate_plan_id']}/adopt",
            headers=ui,
            json={
                "schema_version": 1,
                "candidate_document_sha256": candidate["document_sha256"],
                "base_revision_id": baseline,
            },
        )
        assert adopted.status_code == 200, adopted.text
        adopted_revision = adopted.json()["timeline_revision"]["timeline_revision_id"]
        undo = client.post(
            f"/api/v1/projects/{project_id}/timeline/undo",
            headers=ui,
            json={"base_revision_id": adopted_revision},
        )
        assert undo.status_code == 200, undo.text
        assert undo.json()["current_revision"]["timeline_revision_id"] == baseline
        redo = client.post(
            f"/api/v1/projects/{project_id}/timeline/redo",
            headers=ui,
            json={"base_revision_id": baseline},
        )
        assert redo.status_code == 200, redo.text
        assert redo.json()["current_revision"]["timeline_revision_id"] == adopted_revision
        render_preview = client.post(
            f"/api/v1/projects/{project_id}/previews",
            headers=ui,
            json={"timeline_revision_id": adopted_revision, "encoder_mode": "software"},
        )
        assert render_preview.status_code == 200, render_preview.text
        preview_job = _wait(client, ui, render_preview.json()["job"]["job_id"])
        assert preview_job["status"] == "succeeded", preview_job
        destination_grant = client.post(
            "/api/v1/internal/destination-grants",
            headers=admin,
            json={"path": str(destination), "overwrite_authorized": False},
        ).json()
        export = client.post(
            f"/api/v1/projects/{project_id}/exports",
            headers=ui,
            json={
                "timeline_revision_id": adopted_revision,
                "destination_grant_id": destination_grant["destination_grant_id"],
                "encoder_mode": "software",
            },
        )
        assert export.status_code == 200, export.text
        export_job = _wait(client, ui, export.json()["job"]["job_id"])
        assert export_job["status"] == "succeeded", export_job
        assert destination.exists() and destination.stat().st_size > 0
        assert str(destination) not in export.text
