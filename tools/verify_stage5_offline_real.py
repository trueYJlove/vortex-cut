# ruff: noqa: E501
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))

from fastapi.testclient import TestClient  # noqa: E402

import aivs_core.database as database_module  # noqa: E402
from aivs_core.app import create_app  # noqa: E402
from aivs_core.config import Settings  # noqa: E402
from aivs_core.database import V16_SQL, Database, json_dumps, utc_now  # noqa: E402
from aivs_core.projects import modified_iso  # noqa: E402
from aivs_core.provider_images import FailOnCallImageProvider  # noqa: E402

SCHEMA_VERSION = 1
FFMPEG = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
FFPROBE = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffprobe.exe"
TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}
PRIVATE_REQUIREMENT = "STAGE5_OFFLINE_PRIVATE_REQUIREMENT_BODY"
SAFE_CODES = {
    "STAGE5_ACCEPTANCE_PASSED",
    "STAGE5_ACCEPTANCE_ENVIRONMENT_INVALID",
    "STAGE5_ACCEPTANCE_ISOLATION_INVALID",
    "STAGE5_ACCEPTANCE_FIXTURE_FAILED",
    "STAGE5_ACCEPTANCE_MIGRATION_FAILED",
    "STAGE5_ACCEPTANCE_SEED_FAILED",
    "STAGE5_ACCEPTANCE_PREPARE_FAILED",
    "STAGE5_ACCEPTANCE_PREPARE_SIDE_EFFECT",
    "STAGE5_ACCEPTANCE_PREVIEW_RESTART_FAILED",
    "STAGE5_ACCEPTANCE_APPLY_FAILED",
    "STAGE5_ACCEPTANCE_ATOMICITY_FAILED",
    "STAGE5_ACCEPTANCE_REPLAY_FAILED",
    "STAGE5_ACCEPTANCE_TIMELINE_FAILED",
    "STAGE5_ACCEPTANCE_NAVIGATION_FAILED",
    "STAGE5_ACCEPTANCE_RENDER_FAILED",
    "STAGE5_ACCEPTANCE_RESTART_FAILED",
    "STAGE5_ACCEPTANCE_PROVIDER_BOUNDARY_FAILED",
    "STAGE5_ACCEPTANCE_PRIVACY_FAILED",
    "STAGE5_ACCEPTANCE_INTERNAL_FAILED",
}
SENSITIVE_KEYS = {
    "path", "uri", "absolute_path", "prompt", "requirement", "visual_direction",
    "narration_text", "transcript", "caption", "authorization", "api_key", "secret",
    "payload", "raw_exception", "raw_response", "sse", "base64", "stderr", "command",
    "traceback", "document", "root_dir",
}
GENERATION_KEYS = (
    "request", "task", "job", "invocation", "provenance", "link", "adoption", "asset",
)


class AcceptanceFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code if code in SAFE_CODES else "STAGE5_ACCEPTANCE_INTERNAL_FAILED"


def require(condition: bool, code: str) -> None:
    if not condition:
        raise AcceptanceFailure(code)


def settings(data_dir: Path) -> Settings:
    return Settings(
        data_dir=data_dir,
        ffmpeg=FFMPEG,
        ffprobe=FFPROBE,
        manifest_dir=ROOT / "resources" / "model-manifests",
        font_dir=ROOT / "resources" / "fonts",
        recipe_dir=ROOT / "resources" / "recipes",
        image_provider_network_enabled=False,
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def no_sensitive_keys(value: Any) -> bool:
    if isinstance(value, list):
        return all(no_sensitive_keys(item) for item in value)
    if not isinstance(value, dict):
        return True
    return all(
        str(key).lower() not in SENSITIVE_KEYS and no_sensitive_keys(item)
        for key, item in value.items()
    )


def counts(database: Path) -> dict[str, int]:
    with sqlite3.connect(database) as sql:
        return {
            "request": int(sql.execute("SELECT COUNT(*) FROM media_generation_requests").fetchone()[0]),
            "task": int(sql.execute("SELECT COUNT(*) FROM media_generation_tasks").fetchone()[0]),
            "job": int(sql.execute("SELECT COUNT(*) FROM jobs WHERE kind='media_generation'").fetchone()[0]),
            "invocation": int(sql.execute("SELECT COUNT(*) FROM provider_image_invocations").fetchone()[0]),
            "provenance": int(sql.execute("SELECT COUNT(*) FROM generated_asset_provenance").fetchone()[0]),
            "link": int(sql.execute("SELECT COUNT(*) FROM shot_requirement_image_generation_links").fetchone()[0]),
            "adoption": int(sql.execute("SELECT COUNT(*) FROM shot_requirement_image_adoptions").fetchone()[0]),
            "asset": int(sql.execute("SELECT COUNT(*) FROM assets").fetchone()[0]),
            "provider_call": int(sql.execute("SELECT COALESCE(SUM(provider_call_count),0) FROM provider_image_invocations").fetchone()[0]),
            "timeline_revision": int(sql.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0]),
            "assembly_preview": int(sql.execute("SELECT COUNT(*) FROM shot_requirement_timeline_assembly_previews").fetchone()[0]),
            "assembly": int(sql.execute("SELECT COUNT(*) FROM shot_requirement_timeline_assemblies").fetchone()[0]),
        }


def run_ffmpeg_png(output: Path) -> dict[str, int]:
    output.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         "color=c=0x336699:size=427x319:duration=0.1", "-frames:v", "1", str(output)],
        capture_output=True, timeout=60, check=False,
    )
    require(result.returncode == 0 and output.is_file(), "STAGE5_ACCEPTANCE_FIXTURE_FAILED")
    probe = subprocess.run(
        [str(FFPROBE), "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name,width,height", "-of", "json", str(output)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, check=False,
    )
    require(probe.returncode == 0, "STAGE5_ACCEPTANCE_FIXTURE_FAILED")
    value = json.loads(probe.stdout)
    stream = value["streams"][0]
    require(stream["codec_name"] == "png", "STAGE5_ACCEPTANCE_FIXTURE_FAILED")
    return {"width": int(stream["width"]), "height": int(stream["height"])}


def auth(client: TestClient, admin_token: str) -> tuple[dict[str, str], dict[str, str]]:
    admin = {"Authorization": f"Bearer {admin_token}"}
    response = client.post("/api/v1/internal/sessions", headers=admin)
    require(response.status_code == 200, "STAGE5_ACCEPTANCE_SEED_FAILED")
    return admin, {"Authorization": f"Bearer {response.json()['token']}"}


def shot_document() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "base_revision_id": None,
        "title": "Stage 5 offline acceptance",
        "summary": "",
        "requirements": [{
            "title": "Adopted image",
            "visual_direction": PRIVATE_REQUIREMENT,
            "target_duration_us": 2_000_000,
            "visual": {"requirement_kind": "image", "source_asset_id": None},
            "narration": None,
        }],
    }


def seed_lineage(app: Any, project_id: str, revision_id: str, requirement_id: str) -> dict[str, str]:
    asset_id = "stage5-real-image"
    with app.state.core.db.connection() as sql:
        project_root = Path(sql.execute("SELECT root_dir FROM projects WHERE id=?", (project_id,)).fetchone()[0])
    image = project_root / "generated" / "image" / f"{asset_id}.png"
    media = run_ffmpeg_png(image)
    fingerprint = sha256_file(image)
    now = utc_now()
    prompt_fingerprint = sha256_text("historical-prompt")
    request_fingerprint = sha256_text("historical-request")
    profile_fingerprint = sha256_text("historical-profile")
    payload_fingerprint = sha256_text("historical-payload")
    response_fingerprint = sha256_text("historical-response")
    requirement_fingerprint = sha256_text("historical-requirement")
    result_summary = {
        "execution_mode": "provider_image_v1",
        "provider_call_count": 1,
        "asset": {
            "asset_id": asset_id,
            "display_name": "Generated",
            "kind": "image",
            "storage_mode": "managed",
            "availability": "available",
        },
        "output": {
            "format": "png",
            "width": media["width"],
            "height": media["height"],
            "size_bytes": image.stat().st_size,
            "sha256": fingerprint,
        },
        "provider": {
            "kind": "apikey_fun_images",
            "adapter_id": "apikey_fun_images_sse_v1",
            "model": "gpt-image-2",
        },
        "estimated_cost": 0.1,
        "estimated_cost_currency": "CNY",
        "price_tier": "1K",
        "provenance_id": "stage5-real-provenance",
    }
    with app.state.core.db.connection() as sql:
        sql.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,"
            "modified_at,availability,media_info_json,created_at,updated_at) VALUES "
            "(?,?,'image','managed','Generated',?,?,?,'available',?,?,?)",
            (asset_id, project_id, fingerprint, image.stat().st_size, modified_iso(image), json_dumps(media), now, now),
        )
        sql.execute("INSERT INTO asset_locations(asset_id,uri,last_verified_at) VALUES (?,?,?)", (asset_id, image.as_uri(), now))
        sql.execute(
            "INSERT INTO image_provider_configs VALUES "
            "('stage5-real-config',?,'apikey_fun_images','apikey_fun_images_sse_v1','image_text_to_image',"
            "'1','Historical fixture','gpt-image-2',1,0.1,0.15,'CNY',?,?)",
            (project_id, now, now),
        )
        sql.execute(
            "INSERT INTO media_generation_requests(id,project_id,generation_kind,execution_mode,prompt_sha256,"
            "input_refs_json,parameters_json,request_sha256,created_at) VALUES "
            "('stage5-real-request',?,'image','provider_image_v1',?,'[]',?,?,?)",
            (project_id, prompt_fingerprint, json_dumps({"size": "1024x1024"}), request_fingerprint, now),
        )
        sql.execute(
            "INSERT INTO provider_image_request_profiles VALUES "
            "('stage5-real-request','stage5-real-config','apikey_fun_images','apikey_fun_images_sse_v1',"
            "'image_text_to_image','1','gpt-image-2','apikey_fun_images_generations','1024x1024','png',"
            "?,?,?,?)", (profile_fingerprint, payload_fingerprint, now, now),
        )
        sql.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,created_at,updated_at) "
            "VALUES ('stage5-real-job',?,'media_generation','media_generation','succeeded','completed',1,'{}',1,?,?)",
            (project_id, now, now),
        )
        sql.execute(
            "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,output_asset_id,"
            "output_sha256,result_summary_json,created_at,updated_at,finished_at) VALUES "
            "('stage5-real-task','stage5-real-request','stage5-real-job',1,'succeeded','completed',?,?,?,?,?,?)",
            (asset_id, fingerprint, json_dumps(result_summary), now, now, now),
        )
        sql.execute(
            "INSERT INTO provider_image_invocations(id,task_id,provider_config_id,status,provider_call_count,"
            "provider_may_have_processed,estimated_cost,estimated_cost_currency,price_tier,validated_format,"
            "validated_width,validated_height,validated_size_bytes,output_sha256,cleanup_required,created_at,"
            "finished_at,updated_at) VALUES ('stage5-real-invocation','stage5-real-task','stage5-real-config',"
            "'succeeded',1,1,0.1,'CNY','1K','png',?,?,?,?,0,?,?,?)",
            (media["width"], media["height"], image.stat().st_size, fingerprint, now, now, now),
        )
        sql.execute(
            "INSERT INTO generated_asset_provenance VALUES "
            "('stage5-real-provenance',?,'stage5-real-request','stage5-real-task','stage5-real-invocation',"
            "?,'apikey_fun_images','apikey_fun_images_sse_v1','1','gpt-image-2',?,?,?,?)",
            (asset_id, prompt_fingerprint, profile_fingerprint, response_fingerprint, fingerprint, now),
        )
        sql.execute(
            "INSERT INTO shot_requirement_image_generation_links VALUES "
            "('stage5-real-link',?,?,?,'stage5-real-request',?,?)",
            (project_id, revision_id, requirement_id, requirement_fingerprint, now),
        )
        sql.execute(
            "INSERT INTO shot_requirement_image_adoptions VALUES "
            "('stage5-real-adoption',?,?,?,'stage5-real-link','stage5-real-task',?,1,NULL,?)",
            (project_id, revision_id, requirement_id, asset_id, now),
        )
    return {"asset_id": asset_id, "adoption_id": "stage5-real-adoption", "fingerprint": fingerprint}


def create_domain(app: Any, client: TestClient, ui: dict[str, str]) -> dict[str, str]:
    project = client.post("/api/v1/projects", headers=ui, json={"name": "Stage 5 offline acceptance"})
    require(project.status_code == 201, "STAGE5_ACCEPTANCE_SEED_FAILED")
    project_id = project.json()["project_id"]
    revision_response = client.post(f"/api/v1/projects/{project_id}/shot-list/revisions", headers=ui, json=shot_document())
    require(revision_response.status_code == 200, "STAGE5_ACCEPTANCE_SEED_FAILED")
    revision = revision_response.json()["revision"]
    revision_id = revision["shot_list_revision_id"]
    requirement_id = revision["requirements"][0]["shot_requirement_id"]
    confirm = client.post(
        f"/api/v1/projects/{project_id}/shot-list/confirm", headers=ui,
        json={"revision_id": revision_id, "expected_current_revision_id": revision_id},
    )
    require(confirm.status_code == 200, "STAGE5_ACCEPTANCE_SEED_FAILED")
    timeline = client.post(
        f"/api/v1/projects/{project_id}/timelines", headers=ui,
        json={"schema_version": 1, "source": {"kind": "empty"}, "default_layout": "fit", "caption_preset_id": "default-bottom"},
    )
    require(timeline.status_code == 201, "STAGE5_ACCEPTANCE_SEED_FAILED")
    timeline_id = timeline.json()["current_revision"]["timeline_revision_id"]
    lineage = seed_lineage(app, project_id, revision_id, requirement_id)
    return {
        "project_id": project_id, "revision_id": revision_id, "requirement_id": requirement_id,
        "timeline_revision_id": timeline_id, **lineage,
    }


def wait_job(client: TestClient, ui: dict[str, str], job_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 180
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/jobs/{job_id}", headers=ui)
        require(response.status_code == 200, "STAGE5_ACCEPTANCE_RENDER_FAILED")
        last = response.json()
        if last["status"] in TERMINAL:
            return last
        time.sleep(0.1)
    raise AcceptanceFailure("STAGE5_ACCEPTANCE_RENDER_FAILED")


def migration_checks(database: Path, prior: dict[str, str] | None, data_dir: Path) -> dict[str, Any]:
    with sqlite3.connect(database) as sql:
        history = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
        objects = {row[0] for row in sql.execute("SELECT name FROM sqlite_master")}
        foreign_key_ok = not sql.execute("PRAGMA foreign_key_check").fetchall()
        integrity_ok = sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    expected = hashlib.sha256(V16_SQL.encode()).hexdigest()
    required_objects = {
        "shot_requirement_timeline_assembly_previews", "shot_requirement_timeline_assemblies",
        "stage5_previews_no_update", "stage5_previews_no_delete",
        "stage5_assemblies_no_update", "stage5_assemblies_no_delete",
    }
    require(len(history) == 16 and history.get("v16") == expected, "STAGE5_ACCEPTANCE_MIGRATION_FAILED")
    require(required_objects <= objects and foreign_key_ok and integrity_ok, "STAGE5_ACCEPTANCE_MIGRATION_FAILED")
    if prior is not None:
        require({k: v for k, v in history.items() if k != "v16"} == prior, "STAGE5_ACCEPTANCE_MIGRATION_FAILED")
    return {
        "schema_count": len(history), "v16_checksum_matches": True,
        "prior_checksums_preserved": prior is not None,
        "backup_count": len(list((data_dir / "backups").glob("*.db"))),
        "foreign_key_ok": foreign_key_ok, "integrity_ok": integrity_ok,
    }


def execute_stage5(data_dir: Path, admin_token: str, ids: dict[str, str]) -> dict[str, Any]:
    database = data_dir / "app.db"
    cfg = settings(data_dir)
    responses: list[Any] = []
    base = f"/api/v1/projects/{ids['project_id']}/shot-requirements/{ids['requirement_id']}/timeline-assemblies"
    app = create_app(cfg)
    with TestClient(app) as client:
        _, ui = auth(client, admin_token)
        require(isinstance(app.state.core.provider_image_generation.provider, FailOnCallImageProvider), "STAGE5_ACCEPTANCE_PROVIDER_BOUNDARY_FAILED")
        before = counts(database)
        prepared_response = client.post(
            f"{base}/prepare", headers=ui,
            json={"expected_adoption_id": ids["adoption_id"], "base_timeline_revision_id": ids["timeline_revision_id"],
                  "at_index": 0, "duration_us": 2_000_000, "layout": "fit"},
        )
        require(prepared_response.status_code == 200, "STAGE5_ACCEPTANCE_PREPARE_FAILED")
        prepared = prepared_response.json()
        responses.append(prepared)
        require(prepared["asset"]["fingerprint"] == ids["fingerprint"], "STAGE5_ACCEPTANCE_PREPARE_FAILED")
        after_prepare = counts(database)
        require(all(after_prepare[key] == before[key] for key in GENERATION_KEYS), "STAGE5_ACCEPTANCE_PREPARE_SIDE_EFFECT")
        require(after_prepare["provider_call"] == before["provider_call"], "STAGE5_ACCEPTANCE_PROVIDER_BOUNDARY_FAILED")
        require(after_prepare["timeline_revision"] == before["timeline_revision"] and after_prepare["assembly"] == before["assembly"], "STAGE5_ACCEPTANCE_PREPARE_SIDE_EFFECT")
        require(after_prepare["assembly_preview"] == before["assembly_preview"] + 1, "STAGE5_ACCEPTANCE_PREPARE_FAILED")

    app = create_app(cfg)
    with TestClient(app) as client:
        _, ui = auth(client, admin_token)
        restored_preview = client.get(f"/api/v1/shot-requirement-timeline-assembly-previews/{prepared['preview_id']}", headers=ui)
        require(restored_preview.status_code == 200 and restored_preview.json() == prepared, "STAGE5_ACCEPTANCE_PREVIEW_RESTART_FAILED")
        before_apply = counts(database)
        payload = {"assembly_preview_id": prepared["preview_id"], "proposed_document_sha256": prepared["proposed_document_sha256"], "confirmed": True}
        applied_response = client.post(base, headers=ui, json=payload)
        require(applied_response.status_code == 200, "STAGE5_ACCEPTANCE_APPLY_FAILED")
        applied = applied_response.json()
        responses.append(applied)
        require(applied["reused"] is False, "STAGE5_ACCEPTANCE_APPLY_FAILED")
        after_apply = counts(database)
        require(all(after_apply[key] == before_apply[key] for key in GENERATION_KEYS), "STAGE5_ACCEPTANCE_ATOMICITY_FAILED")
        require(after_apply["provider_call"] == before_apply["provider_call"], "STAGE5_ACCEPTANCE_PROVIDER_BOUNDARY_FAILED")
        require(after_apply["timeline_revision"] == before_apply["timeline_revision"] + 1 and after_apply["assembly"] == before_apply["assembly"] + 1, "STAGE5_ACCEPTANCE_ATOMICITY_FAILED")
        replay = client.post(base, headers=ui, json=payload)
        require(replay.status_code == 200 and replay.json()["reused"] is True, "STAGE5_ACCEPTANCE_REPLAY_FAILED")
        after_replay = counts(database)
        require(after_replay == after_apply, "STAGE5_ACCEPTANCE_REPLAY_FAILED")
        assembly = applied["assembly"]
        output_revision = assembly["output_timeline_revision_id"]
        state = client.get(f"/api/v1/projects/{ids['project_id']}/timeline", headers=ui)
        require(state.status_code == 200, "STAGE5_ACCEPTANCE_TIMELINE_FAILED")
        document = state.json()["current_revision"]["document"]
        require(len(document["clips"]) == 1, "STAGE5_ACCEPTANCE_TIMELINE_FAILED")
        clip = document["clips"][0]
        require(clip["clip_id"] == prepared["proposed_clip_id"] and clip["asset_id"] == ids["asset_id"], "STAGE5_ACCEPTANCE_TIMELINE_FAILED")
        require(clip["timeline_end_us"] - clip["timeline_start_us"] == 2_000_000 and clip["layout"] == "fit", "STAGE5_ACCEPTANCE_TIMELINE_FAILED")
        undo = client.post(f"/api/v1/projects/{ids['project_id']}/timeline/undo", headers=ui, json={"base_revision_id": output_revision})
        require(undo.status_code == 200 and len(undo.json()["current_revision"]["document"]["clips"]) == 0, "STAGE5_ACCEPTANCE_NAVIGATION_FAILED")
        assembly_get = client.get(f"/api/v1/shot-requirement-timeline-assemblies/{assembly['assembly_id']}", headers=ui)
        require(assembly_get.status_code == 200 and assembly_get.json() == assembly, "STAGE5_ACCEPTANCE_NAVIGATION_FAILED")
        undo_revision = undo.json()["current_revision"]["timeline_revision_id"]
        redo = client.post(f"/api/v1/projects/{ids['project_id']}/timeline/redo", headers=ui, json={"base_revision_id": undo_revision})
        require(redo.status_code == 200 and redo.json()["current_revision"]["timeline_revision_id"] == output_revision, "STAGE5_ACCEPTANCE_NAVIGATION_FAILED")
        preview_start = client.post(f"/api/v1/projects/{ids['project_id']}/previews", headers=ui, json={"timeline_revision_id": output_revision, "encoder_mode": "software"})
        require(preview_start.status_code == 200, "STAGE5_ACCEPTANCE_RENDER_FAILED")
        preview_payload = preview_start.json()
        if preview_payload["job"] is not None:
            job = wait_job(client, ui, preview_payload["job"]["job_id"])
            require(job["status"] == "succeeded", "STAGE5_ACCEPTANCE_RENDER_FAILED")
            artifact_id = job["result"]["render_artifact_id"]
        else:
            require(preview_payload["reused"] is True and preview_payload["preview"] is not None, "STAGE5_ACCEPTANCE_RENDER_FAILED")
            artifact_id = preview_payload["preview"]["render_artifact_id"]
        artifact_response = client.get(f"/api/v1/render-artifacts/{artifact_id}", headers=ui)
        require(artifact_response.status_code == 200, "STAGE5_ACCEPTANCE_RENDER_FAILED")
        artifact = artifact_response.json()
        responses.append(artifact)
        video = artifact["media_info"]["video"]
        audio = artifact["media_info"]["audio"]
        require(video == {"codec": "h264", "width": 540, "height": 960, "pixel_format": "yuv420p", "fps_num": 30, "fps_den": 1}, "STAGE5_ACCEPTANCE_RENDER_FAILED")
        require(audio["codec"] == "aac" and audio["sample_rate"] == 48000, "STAGE5_ACCEPTANCE_RENDER_FAILED")
        with app.state.core.db.connection() as sql:
            artifact_path = Path(sql.execute("SELECT path FROM artifacts WHERE id=?", (artifact_id,)).fetchone()[0])
        require(artifact_path.is_file() and sha256_file(artifact_path) == artifact["sha256"], "STAGE5_ACCEPTANCE_RENDER_FAILED")
        probe = subprocess.run([str(FFPROBE), "-v", "error", "-show_streams", "-of", "json", str(artifact_path)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, check=False)
        require(probe.returncode == 0 and len(json.loads(probe.stdout)["streams"]) >= 2, "STAGE5_ACCEPTANCE_RENDER_FAILED")
        final_before_restart = counts(database)

    app = create_app(cfg)
    with TestClient(app) as client:
        _, ui = auth(client, admin_token)
        restored = client.get(f"/api/v1/shot-requirement-timeline-assemblies/{assembly['assembly_id']}", headers=ui)
        state = client.get(f"/api/v1/projects/{ids['project_id']}/timeline", headers=ui)
        require(restored.status_code == 200 and restored.json() == assembly, "STAGE5_ACCEPTANCE_RESTART_FAILED")
        require(state.status_code == 200 and state.json()["current_revision"]["timeline_revision_id"] == output_revision, "STAGE5_ACCEPTANCE_RESTART_FAILED")
        require(counts(database) == final_before_restart, "STAGE5_ACCEPTANCE_RESTART_FAILED")
        require(isinstance(app.state.core.provider_image_generation.provider, FailOnCallImageProvider), "STAGE5_ACCEPTANCE_PROVIDER_BOUNDARY_FAILED")

    require(PRIVATE_REQUIREMENT not in repr(responses), "STAGE5_ACCEPTANCE_PRIVACY_FAILED")
    require(all(no_sensitive_keys(value) for value in responses), "STAGE5_ACCEPTANCE_PRIVACY_FAILED")
    with sqlite3.connect(database) as sql:
        stage5_rows = repr(sql.execute("SELECT * FROM shot_requirement_timeline_assembly_previews").fetchall() + sql.execute("SELECT * FROM shot_requirement_timeline_assemblies").fetchall())
    require(PRIVATE_REQUIREMENT not in stage5_rows and str(data_dir) not in stage5_rows, "STAGE5_ACCEPTANCE_PRIVACY_FAILED")
    return {
        "provider_call_delta": final_before_restart["provider_call"] - before["provider_call"],
        "generation_fact_delta": {key: final_before_restart[key] - before[key] for key in GENERATION_KEYS},
        "timeline_revision_apply_delta": after_apply["timeline_revision"] - before_apply["timeline_revision"],
        "assembly_apply_delta": after_apply["assembly"] - before_apply["assembly"],
        "replay_delta_zero": after_replay == after_apply,
        "timeline_clip_count": 1,
        "duration_us": 2_000_000,
        "layout": "fit",
        "undo_redo_preserved_assembly": True,
        "restart_restored": True,
        "render": {"codec": "h264", "audio_codec": "aac", "width": 540, "height": 960, "pixel_format": "yuv420p", "sample_rate": 48000, "sha256_verified": True, "ffprobe_decodable": True},
    }


def prepare_fresh(data_dir: Path, admin_token: str) -> tuple[dict[str, str], dict[str, Any]]:
    app = create_app(settings(data_dir))
    with TestClient(app) as client:
        _, ui = auth(client, admin_token)
        ids = create_domain(app, client, ui)
    return ids, migration_checks(data_dir / "app.db", None, data_dir)


def prepare_upgrade(data_dir: Path, admin_token: str) -> tuple[dict[str, str], dict[str, Any]]:
    original = database_module.MIGRATIONS
    try:
        database_module.MIGRATIONS = {key: value for key, value in original.items() if int(key[1:]) <= 15}
        app = create_app(settings(data_dir))
        with TestClient(app) as client:
            _, ui = auth(client, admin_token)
            ids = create_domain(app, client, ui)
        with sqlite3.connect(data_dir / "app.db") as sql:
            prior = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
            require(len(prior) == 15, "STAGE5_ACCEPTANCE_MIGRATION_FAILED")
            historical = {
                "project": int(sql.execute("SELECT COUNT(*) FROM projects").fetchone()[0]),
                "adoption": int(sql.execute("SELECT COUNT(*) FROM shot_requirement_image_adoptions").fetchone()[0]),
                "timeline": int(sql.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0]),
            }
    finally:
        database_module.MIGRATIONS = original
    Database(data_dir / "app.db").initialize()
    migration = migration_checks(data_dir / "app.db", prior, data_dir)
    with sqlite3.connect(data_dir / "app.db") as sql:
        require(int(sql.execute("SELECT COUNT(*) FROM projects").fetchone()[0]) == historical["project"], "STAGE5_ACCEPTANCE_MIGRATION_FAILED")
        require(int(sql.execute("SELECT COUNT(*) FROM shot_requirement_image_adoptions").fetchone()[0]) == historical["adoption"], "STAGE5_ACCEPTANCE_MIGRATION_FAILED")
        require(int(sql.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0]) == historical["timeline"], "STAGE5_ACCEPTANCE_MIGRATION_FAILED")
    require(migration["backup_count"] >= 1, "STAGE5_ACCEPTANCE_MIGRATION_FAILED")
    migration["historical_facts_preserved"] = True
    return ids, migration


def write_report(report_file: Path, report: dict[str, Any]) -> None:
    require(no_sensitive_keys(report), "STAGE5_ACCEPTANCE_PRIVACY_FAILED")
    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    require(PRIVATE_REQUIREMENT not in encoded, "STAGE5_ACCEPTANCE_PRIVACY_FAILED")
    report_file.parent.mkdir(parents=True, exist_ok=True)
    report_file.write_text(encoded + "\n", encoding="utf-8")


def run(run_root: Path, report_file: Path) -> dict[str, Any]:
    require(FFMPEG.is_file() and FFPROBE.is_file(), "STAGE5_ACCEPTANCE_ENVIRONMENT_INVALID")
    require(not run_root.exists(), "STAGE5_ACCEPTANCE_ISOLATION_INVALID")
    run_root.mkdir(parents=True)
    previous_admin = os.environ.get("AIVS_ADMIN_TOKEN")
    admin_token = "stage5-offline-acceptance-admin"
    os.environ["AIVS_ADMIN_TOKEN"] = admin_token
    try:
        fresh_dir = run_root / "fresh-v16"
        upgrade_dir = run_root / "upgrade-v15-v16"
        fresh_ids, fresh_migration = prepare_fresh(fresh_dir, admin_token)
        fresh = execute_stage5(fresh_dir, admin_token, fresh_ids)
        upgrade_ids, upgrade_migration = prepare_upgrade(upgrade_dir, admin_token)
        upgrade = execute_stage5(upgrade_dir, admin_token, upgrade_ids)
        report = {
            "schema_version": SCHEMA_VERSION,
            "status": "passed",
            "safe_code": "STAGE5_ACCEPTANCE_PASSED",
            "targets": {
                "fresh_v16": {"migration": fresh_migration, "stage5": fresh},
                "upgrade_v15_v16": {"migration": upgrade_migration, "stage5": upgrade},
            },
            "checks": {
                "provider_network_disabled": True,
                "provider_call_delta_zero": fresh["provider_call_delta"] == 0 and upgrade["provider_call_delta"] == 0,
                "generation_fact_delta_zero": all(value == 0 for value in fresh["generation_fact_delta"].values()) and all(value == 0 for value in upgrade["generation_fact_delta"].values()),
                "prepare_persisted_across_restart": True,
                "apply_atomic": True,
                "replay_idempotent": True,
                "undo_redo_preserves_history": True,
                "real_png_rendered": True,
                "sqlite_foreign_key_ok": True,
                "sqlite_integrity_ok": True,
                "privacy_scan_passed": True,
            },
        }
        require(report["checks"]["provider_call_delta_zero"] and report["checks"]["generation_fact_delta_zero"], "STAGE5_ACCEPTANCE_PROVIDER_BOUNDARY_FAILED")
        write_report(report_file, report)
        return report
    finally:
        if previous_admin is None:
            os.environ.pop("AIVS_ADMIN_TOKEN", None)
        else:
            os.environ["AIVS_ADMIN_TOKEN"] = previous_admin


def self_test() -> dict[str, Any]:
    require(FFMPEG.is_file() and FFPROBE.is_file(), "STAGE5_ACCEPTANCE_ENVIRONMENT_INVALID")
    probe = {"schema_version": 1, "status": "self_test_passed", "safe_code": "STAGE5_ACCEPTANCE_PASSED", "provider_dispatches": 0}
    require(no_sensitive_keys(probe), "STAGE5_ACCEPTANCE_PRIVACY_FAILED")
    return probe


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--self-test", action="store_true")
    mode.add_argument("--run", action="store_true")
    parser.add_argument("--run-root", type=Path)
    parser.add_argument("--report-file", type=Path)
    args = parser.parse_args()
    try:
        if args.self_test:
            result = self_test()
        else:
            require(args.run_root is not None and args.report_file is not None, "STAGE5_ACCEPTANCE_ENVIRONMENT_INVALID")
            result = run(args.run_root.resolve(), args.report_file.resolve())
        print(json.dumps({"schema_version": 1, "status": result["status"], "safe_code": result["safe_code"], "provider_dispatches": 0}, separators=(",", ":")))
        return 0
    except AcceptanceFailure as exc:
        print(json.dumps({"schema_version": 1, "status": "failed", "safe_code": exc.code}, separators=(",", ":")))
        return 1
    except BaseException:
        print(json.dumps({"schema_version": 1, "status": "failed", "safe_code": "STAGE5_ACCEPTANCE_INTERNAL_FAILED"}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())





