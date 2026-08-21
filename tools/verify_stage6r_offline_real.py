# ruff: noqa: E501
"""Offline real-acceptance fixture helper for Stage 6-R.

This module intentionally contains no network provider calls and never prints
sensitive fixture content. It is imported by the Electron E2E test.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FFMPEG = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
FFPROBE = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffprobe.exe"
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))

from fastapi.testclient import TestClient  # noqa: E402

import aivs_core.database as database_module  # noqa: E402
from aivs_core.app import create_app  # noqa: E402
from aivs_core.config import Settings  # noqa: E402
from aivs_core.database import json_dumps, utc_now  # noqa: E402
from aivs_core.database_v17 import V17_SQL  # noqa: E402
from aivs_core.projects import modified_iso  # noqa: E402

PRIVATE_REQUIREMENT = "STAGE6R_OFFLINE_PRIVATE_REQUIREMENT_BODY"
CANDIDATE_COUNT = 24
SENSITIVE_KEYS = {
    "path", "uri", "absolute_path", "prompt", "requirement", "visual_direction",
    "narration_text", "transcript", "caption", "authorization", "api_key", "secret",
    "payload", "raw_exception", "raw_response", "sse", "base64", "stderr", "command",
    "traceback", "document", "root_dir",
}


def no_sensitive_keys(value: Any) -> bool:
    if isinstance(value, list):
        return all(no_sensitive_keys(item) for item in value)
    if not isinstance(value, dict):
        return True
    return all(
        str(key).lower() not in SENSITIVE_KEYS and no_sensitive_keys(item)
        for key, item in value.items()
        )


def settings(data_dir: Path) -> Settings:
    return Settings(
        data_dir=data_dir,
        ffmpeg=ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe",
        ffprobe=ROOT / "resources" / "ffmpeg" / "win-x64" / "ffprobe.exe",
        manifest_dir=ROOT / "resources" / "model-manifests",
        font_dir=ROOT / "resources" / "fonts",
        recipe_dir=ROOT / "resources" / "recipes",
        image_provider_network_enabled=False,
        )


def auth(client: TestClient, admin_token: str) -> dict[str, str]:
    admin = {"Authorization": f"Bearer {admin_token}"}
    response = client.post("/api/v1/internal/sessions", headers=admin)
    if response.status_code != 200:
        raise RuntimeError("STAGE6R_SEED_FAILED")
    return {"Authorization": f"Bearer {response.json()['token']}"}


def shot_document() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "base_revision_id": None,
        "title": "Stage 6-R offline acceptance",
        "summary": "",
        "requirements": [
            {
                "title": f"Adopted image {index}",
                "visual_direction": f"{PRIVATE_REQUIREMENT}-{index}",
                "target_duration_us": 1_000_000,
                "visual": {"requirement_kind": "image", "source_asset_id": None},
                "narration": None,
            }
            for index in range(CANDIDATE_COUNT)
        ],
    }


def run_ffmpeg_png(output: Path, index: int) -> dict[str, int]:
    output.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         f"color=c=0x{(index * 0x040404) % 0x1000000:06x}:size=427x319:duration=0.1", "-frames:v", "1", str(output)],
        capture_output=True, timeout=60, check=False,
        )
    if result.returncode != 0 or not output.is_file():
        raise RuntimeError("STAGE6R_FIXTURE_FAILED")
    probe = subprocess.run(
        [str(FFPROBE), "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name,width,height", "-of", "json", str(output)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, check=False,
        )
    if probe.returncode != 0:
        raise RuntimeError("STAGE6R_FIXTURE_FAILED")
    stream = json.loads(probe.stdout)["streams"][0]
    if stream["codec_name"] != "png":
        raise RuntimeError("STAGE6R_FIXTURE_FAILED")
    return {"width": int(stream["width"]), "height": int(stream["height"])}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _seed_lineage(
    app: Any, project_id: str, revision_id: str, index: int, requirement_id: str
) -> None:
    asset_id = f"stage6r-real-image-{index}"

    with app.state.core.db.connection() as sql:
        project_root = Path(sql.execute(
            "SELECT root_dir FROM projects WHERE id=?", (project_id,)
        ).fetchone()[0])

        image = project_root / "generated" / "image" / f"{asset_id}.png"
        media = run_ffmpeg_png(image, index)
        fingerprint = sha256_file(image)
        size = image.stat().st_size
        now = utc_now()

        sql.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,"
            "modified_at,availability,media_info_json,created_at,updated_at) VALUES "
            "(?,?,'image','managed','Generated',?,?,?,'available',?,?,?)",
            (asset_id, project_id, fingerprint, size, modified_iso(image), json_dumps(media), now, now),
        )
        sql.execute(
            "INSERT INTO asset_locations(asset_id,uri,last_verified_at) VALUES (?,?,?)",
            (asset_id, image.as_uri(), now),
        )
        sql.execute(
            "INSERT OR IGNORE INTO image_provider_configs VALUES "
            "(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "stage6r-real-config", project_id, "apikey_fun_images",
                "apikey_fun_images_sse_v1", "image_text_to_image", "1", "Fixture",
                "gpt-image-2", 1, 0.1, 0.15, "CNY", now, now,
            ),
        )
        sql.execute(
            "INSERT INTO media_generation_requests(id,project_id,generation_kind,execution_mode,"
            "prompt_sha256,input_refs_json,parameters_json,request_sha256,created_at) VALUES "
            "(?,?,'image','provider_image_v1','sha256:prompt','[]','{}',?,?)",
            (f"stage6r-real-request-{index}", project_id, f"sha256:stage6r-real-request-{index}", now),
        )
        sql.execute(
            "INSERT INTO provider_image_request_profiles(request_id,provider_config_id,"
            "provider_kind,adapter_id,capability,protocol_version,model,endpoint_identity,size,"
            "output_format,provider_profile_sha256,payload_sha256,confirmed_at,created_at) VALUES "
            "(?,?,'apikey_fun_images','apikey_fun_images_sse_v1','image_text_to_image','1',"
            "'gpt-image-2','apikey_fun_images_generations','1024x1024','png','sha256:profile',"
            "'sha256:payload',?,?)",
            (f"stage6r-real-request-{index}", "stage6r-real-config", now, now),
        )
        sql.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,"
            "created_at,updated_at) VALUES (?,?,'media_generation','media_generation','succeeded',"
            "'completed',1,'{}',1,?,?)",
            (f"stage6r-real-job-{index}", project_id, now, now),
        )
        sql.execute(
            "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
            "output_asset_id,output_sha256,result_summary_json,created_at,updated_at,finished_at) "
            "VALUES (?,?,?,1,'succeeded','completed',?,?,'{}',?,?,?)",
            (
                f"stage6r-real-task-{index}", f"stage6r-real-request-{index}",
                f"stage6r-real-job-{index}", asset_id, fingerprint, now, now, now,
            ),
        )
        sql.execute(
            "INSERT INTO provider_image_invocations(id,task_id,provider_config_id,status,"
            "provider_call_count,provider_may_have_processed,estimated_cost,"
            "estimated_cost_currency,price_tier,validated_format,validated_width,validated_height,"
            "validated_size_bytes,output_sha256,cleanup_required,created_at,finished_at,updated_at) "
            "VALUES (?,?,?,'succeeded',1,1,0.1,'CNY','1K','png',?,?,?, ?,0,?,?,?)",
            (
                f"stage6r-real-invocation-{index}", f"stage6r-real-task-{index}",
                "stage6r-real-config", media["width"], media["height"], size,
                fingerprint, now, now, now,
            ),
        )
        sql.execute(
            "INSERT INTO generated_asset_provenance VALUES (?,?,?,?,?,'sha256:prompt',"
            "'apikey_fun_images','apikey_fun_images_sse_v1','1','gpt-image-2','sha256:profile',"
            "'sha256:response',?,?)",
            (
                f"stage6r-real-provenance-{index}", asset_id,
                f"stage6r-real-request-{index}", f"stage6r-real-task-{index}",
                f"stage6r-real-invocation-{index}", fingerprint, now,
            ),
        )
        sql.execute(
            "INSERT INTO shot_requirement_image_generation_links VALUES "
            "(?,?,?,?,?,'sha256:requirement',?)",
            (
                f"stage6r-real-link-{index}", project_id, revision_id, requirement_id,
                f"stage6r-real-request-{index}", now,
            ),
        )
        sql.execute(
            "INSERT INTO shot_requirement_image_adoptions VALUES "
            "(?,?,?,?,?,?,?,1,NULL,?)",
            (
                f"stage6r-real-adoption-{index}", project_id, revision_id, requirement_id,
                f"stage6r-real-link-{index}", f"stage6r-real-task-{index}", asset_id, now,
            ),
        )


def _seed_adoptions(app: Any, project_id: str, revision_id: str, requirement_ids: list[str]) -> None:
    for index, requirement_id in enumerate(requirement_ids):
        _seed_lineage(app, project_id, revision_id, index, requirement_id)


def create_domain(app: Any, client: TestClient, ui: dict[str, str]) -> dict[str, Any]:
    project = client.post("/api/v1/projects", headers=ui, json={"name": "Stage 6-R offline acceptance"})
    if project.status_code != 201:
        raise RuntimeError("STAGE6R_SEED_FAILED")
    project_id = project.json()["project_id"]
    revision_response = client.post(
        f"/api/v1/projects/{project_id}/shot-list/revisions", headers=ui, json=shot_document()
        )
    if revision_response.status_code != 200:
        raise RuntimeError("STAGE6R_SEED_FAILED")
    revision = revision_response.json()["revision"]
    revision_id = revision["shot_list_revision_id"]
    requirement_ids = [item["shot_requirement_id"] for item in revision["requirements"]]
    confirm = client.post(
        f"/api/v1/projects/{project_id}/shot-list/confirm",
        headers=ui,
        json={"revision_id": revision_id, "expected_current_revision_id": revision_id},
        )
    if confirm.status_code != 200:
        raise RuntimeError("STAGE6R_SEED_FAILED")
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
    if timeline.status_code != 201:
        raise RuntimeError("STAGE6R_SEED_FAILED")
    timeline_revision_id = timeline.json()["current_revision"]["timeline_revision_id"]
    _seed_adoptions(app, project_id, revision_id, requirement_ids)
    return {
        "project_id": project_id,
        "revision_id": revision_id,
        "requirement_ids": requirement_ids,
        "timeline_revision_id": timeline_revision_id,
    }


def seed(data_dir: Path, admin_token: str, upgrade: bool) -> dict[str, Any]:
    os.environ["AIVS_ADMIN_TOKEN"] = admin_token
    original = database_module.MIGRATIONS
    try:
        if upgrade:
            database_module.MIGRATIONS = {
                key: value for key, value in original.items() if int(key[1:]) <= 16
            }
        app = create_app(settings(data_dir))
        with TestClient(app) as client:
            ui = auth(client, admin_token)
            ids = create_domain(app, client, ui)
        with sqlite3.connect(data_dir / "app.db") as sql:
            prior = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
        database_module.MIGRATIONS = original
        if not upgrade:
            if len(prior) != 17:
                raise RuntimeError("STAGE6R_MIGRATION_FAILED")
        else:
            if len(prior) != 16:
                raise RuntimeError("STAGE6R_MIGRATION_FAILED")
            from aivs_core.database import Database

            Database(data_dir / "app.db").initialize()
            with sqlite3.connect(data_dir / "app.db") as sql:
                final = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
                if len(final) != 17 or final.get("v17") != hashlib.sha256(V17_SQL.encode()).hexdigest():
                    raise RuntimeError("STAGE6R_MIGRATION_FAILED")
                if any(final.get(key) != value for key, value in prior.items()):
                    raise RuntimeError("STAGE6R_MIGRATION_FAILED")
        return {
            **ids,
            "schema_count": 17 if not upgrade else 16,
            "seed_schema_count": 17 if not upgrade else 16,
            "prior_checksums": prior,
        }
    finally:
        database_module.MIGRATIONS = original


def inspect(database: Path) -> dict[str, Any]:
    with sqlite3.connect(database) as sql:
        tables = {row[0] for row in sql.execute("SELECT name FROM sqlite_master WHERE type='table'")}

        def count(name: str) -> int:
            return int(sql.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]) if name in tables else 0

        return {
            "schema_count": count("schema_migrations"),
            "migration_checksums": dict(sql.execute("SELECT version,checksum FROM schema_migrations")),
            "provider_call_count": int(
                sql.execute("SELECT COALESCE(SUM(provider_call_count),0) FROM provider_image_invocations").fetchone()[0]
            ),
            "invocation_count": count("provider_image_invocations"),
            "request_count": count("media_generation_requests"),
            "task_count": count("media_generation_tasks"),
            "provenance_count": count("generated_asset_provenance"),
            "link_count": count("shot_requirement_image_generation_links"),
            "adoption_count": count("shot_requirement_image_adoptions"),
            "asset_count": count("assets"),
            "timeline_revision_count": count("timeline_revisions"),
            "batch_preview_count": count("shot_requirement_timeline_batch_assembly_previews"),
            "batch_preview_item_count": count("shot_requirement_timeline_batch_assembly_preview_items"),
            "batch_count": count("shot_requirement_timeline_batch_assemblies"),
            "batch_item_count": count("shot_requirement_timeline_batch_assembly_items"),
            "render_job_count": int(sql.execute("SELECT COUNT(*) FROM jobs WHERE kind!='media_generation'").fetchone()[0]),
            "artifact_count": count("artifacts"),
            "foreign_key_ok": sql.execute("PRAGMA foreign_key_check").fetchall() == [],
            "integrity_ok": sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok",
        }
