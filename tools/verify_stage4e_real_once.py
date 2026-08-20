from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))

from fastapi.testclient import TestClient  # noqa: E402

from aivs_core.app import create_app  # noqa: E402
from aivs_core.config import Settings  # noqa: E402
from aivs_core.provider_images import (  # noqa: E402
    ApiKeyFunImagesProvider,
    FailOnCallImageProvider,
)

SCHEMA_VERSION = 1
PRIOR_ESTIMATED_USD = 1.90
NEW_DISPATCH_ESTIMATED_USD = 0.15
HARD_STOP_USD = 4.0
TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}
SAFE_CODES = {
    "STAGE4E_ACCEPTANCE_PASSED",
    "STAGE4E_ACCEPTANCE_ENVIRONMENT_INVALID",
    "STAGE4E_ACCEPTANCE_BUDGET_BLOCKED",
    "STAGE4E_ACCEPTANCE_ISOLATION_INVALID",
    "STAGE4E_ACCEPTANCE_PREPARE_FAILED",
    "STAGE4E_ACCEPTANCE_PREPARE_SIDE_EFFECT",
    "STAGE4E_ACCEPTANCE_CREATE_FAILED",
    "STAGE4E_ACCEPTANCE_CARDINALITY_INVALID",
    "STAGE4E_ACCEPTANCE_PROVIDER_FAILED",
    "STAGE4E_ACCEPTANCE_PROVIDER_TIMEOUT",
    "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID",
    "STAGE4E_ACCEPTANCE_ADOPTION_FAILED",
    "STAGE4E_ACCEPTANCE_RESTART_FAILED",
    "STAGE4E_ACCEPTANCE_PRIVACY_FAILED",
    "STAGE4E_ACCEPTANCE_INTERNAL_FAILED",
}
SENSITIVE_REPORT_KEYS = {
    "path",
    "uri",
    "absolute_path",
    "prompt",
    "visual_direction",
    "narration_text",
    "transcript",
    "caption",
    "authorization",
    "api_key",
    "secret",
    "payload",
    "raw_exception",
    "raw_response",
    "sse",
    "base64",
    "stderr",
    "command",
    "traceback",
}


class AcceptanceFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code if code in SAFE_CODES else "STAGE4E_ACCEPTANCE_INTERNAL_FAILED"


def require(condition: bool, code: str) -> None:
    if not condition:
        raise AcceptanceFailure(code)


def settings(data_dir: Path, network: bool) -> Settings:
    return Settings(
        data_dir=data_dir,
        ffmpeg=Path("missing"),
        ffprobe=Path("missing"),
        manifest_dir=ROOT / "resources" / "model-manifests",
        font_dir=ROOT / "resources" / "fonts",
        recipe_dir=ROOT / "resources" / "recipes",
        image_provider_network_enabled=network,
    )


def counts(database: Path) -> dict[str, int]:
    with sqlite3.connect(database) as sql:
        return {
            "request": int(
                sql.execute("SELECT COUNT(*) FROM media_generation_requests").fetchone()[0]
            ),
            "task": int(sql.execute("SELECT COUNT(*) FROM media_generation_tasks").fetchone()[0]),
            "job": int(
                sql.execute("SELECT COUNT(*) FROM jobs WHERE kind='media_generation'").fetchone()[0]
            ),
            "invocation": int(
                sql.execute("SELECT COUNT(*) FROM provider_image_invocations").fetchone()[0]
            ),
            "link": int(
                sql.execute(
                    "SELECT COUNT(*) FROM shot_requirement_image_generation_links"
                ).fetchone()[0]
            ),
            "adoption": int(
                sql.execute("SELECT COUNT(*) FROM shot_requirement_image_adoptions").fetchone()[0]
            ),
            "provenance": int(
                sql.execute("SELECT COUNT(*) FROM generated_asset_provenance").fetchone()[0]
            ),
            "timeline_revision": int(
                sql.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0]
            ),
            "provider_call": int(
                sql.execute(
                    "SELECT COALESCE(SUM(provider_call_count),0) FROM provider_image_invocations"
                ).fetchone()[0]
            ),
        }


def file_uri_path(value: str) -> Path:
    parsed = urlparse(value)
    require(
        parsed.scheme == "file" and not parsed.query and not parsed.fragment,
        "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID",
    )
    decoded = unquote(parsed.path)
    if re.match(r"^/[A-Za-z]:/", decoded):
        decoded = decoded[1:]
    return Path(decoded)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def no_sensitive_keys(value: Any) -> bool:
    if isinstance(value, list):
        return all(no_sensitive_keys(item) for item in value)
    if not isinstance(value, dict):
        return True
    return all(
        str(key).lower() not in SENSITIVE_REPORT_KEYS and no_sensitive_keys(item)
        for key, item in value.items()
    )


PROTOCOL_DIAGNOSTIC_KEYS = {
    "schema_version",
    "outcome",
    "failure_stage",
    "http_status_class",
    "content_type_class",
    "stream_started",
    "stream_ended",
    "chunk_count",
    "envelope_byte_count",
    "frame_count",
    "data_event_count",
    "completed_event_count",
    "other_event_count",
    "partial_image_event_count",
    "direct_image_shape_count",
    "nested_data_image_shape_count",
    "chat_delta_shape_count",
    "responses_image_shape_count",
    "url_only_shape_count",
    "unclassified_shape_count",
    "candidate_encoding_class",
    "candidate_size_class",
    "done_marker_count",
    "image_field_location",
    "base64_state",
}
PROTOCOL_DIAGNOSTIC_ENUMS = {
    "outcome": {"pending", "failed", "succeeded"},
    "failure_stage": {
        "none",
        "http_status",
        "unexpected_content_type",
        "cancelled",
        "envelope_too_large",
        "event_decode",
        "completed_image_field",
        "usage_shape",
        "timeout",
        "connect",
        "transport",
        "completed_event_missing",
        "completed_event_duplicate",
        "base64_decode",
        "image_too_large",
    },
    "http_status_class": {"not_observed", "2xx", "4xx", "5xx", "other"},
    "content_type_class": {"not_observed", "event_stream", "json", "missing", "other"},
    "image_field_location": {"not_observed", "missing", "direct", "nested_data"},
    "base64_state": {"not_checked", "invalid", "valid"},
    "candidate_encoding_class": {
        "not_observed", "base64_like", "data_image_uri", "remote_url", "other", "mixed"
    },
    "candidate_size_class": {
        "not_observed", "under_4k", "4k_to_256k", "256k_to_1m", "1m_to_36m",
        "over_36m", "mixed"
    },
}


def safe_protocol_diagnostic(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) != PROTOCOL_DIAGNOSTIC_KEYS:
        return False
    if value.get("schema_version") != 2:
        return False
    if any(value.get(key) not in allowed for key, allowed in PROTOCOL_DIAGNOSTIC_ENUMS.items()):
        return False
    for key in ("stream_started", "stream_ended"):
        if not isinstance(value.get(key), bool):
            return False
    for key in (
        "chunk_count",
        "envelope_byte_count",
        "frame_count",
        "data_event_count",
        "completed_event_count",
        "other_event_count",
        "partial_image_event_count",
        "direct_image_shape_count",
        "nested_data_image_shape_count",
        "chat_delta_shape_count",
        "responses_image_shape_count",
        "url_only_shape_count",
        "unclassified_shape_count",
        "done_marker_count",
    ):
        item = value.get(key)
        if isinstance(item, bool) or not isinstance(item, int) or not 0 <= item <= 40_000_000:
            return False
    return no_sensitive_keys(value)

def session(client: TestClient, admin_token: str) -> tuple[dict[str, str], dict[str, str]]:
    admin = {"Authorization": f"Bearer {admin_token}"}
    response = client.post("/api/v1/internal/sessions", headers=admin)
    require(response.status_code == 200, "STAGE4E_ACCEPTANCE_INTERNAL_FAILED")
    return admin, {"Authorization": f"Bearer {response.json()['token']}"}


def wait_task(client: TestClient, ui: dict[str, str], request_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 930
    while time.monotonic() < deadline:
        response = client.get(
            f"/api/v1/provider-image-generations/{request_id}/tasks?limit=20", headers=ui
        )
        require(response.status_code == 200, "STAGE4E_ACCEPTANCE_PROVIDER_FAILED")
        items = response.json()["items"]
        require(len(items) == 1, "STAGE4E_ACCEPTANCE_CARDINALITY_INVALID")
        if items[0]["status"] in TERMINAL:
            return items[0]
        time.sleep(0.25)
    raise AcceptanceFailure("STAGE4E_ACCEPTANCE_PROVIDER_TIMEOUT")


def inspect_chain(database: Path, expected: dict[str, str]) -> dict[str, Any]:
    with sqlite3.connect(database) as sql:
        sql.row_factory = sqlite3.Row
        row = sql.execute(
            "SELECT req.id request_id,task.id task_id,task.status task_status,"
            "task.output_asset_id,task.output_sha256 task_sha,inv.id invocation_id,"
            "inv.provider_call_count,inv.provider_may_have_processed,inv.validated_format,"
            "inv.validated_width,inv.validated_height,inv.validated_size_bytes,"
            "inv.output_sha256 invocation_sha,asset.id asset_id,asset.kind,asset.storage_mode,"
            "asset.availability,asset.fingerprint,asset.size_bytes,loc.uri,"
            "prov.id provenance_id,prov.output_sha256 provenance_sha,link.id link_id,"
            "link.shot_requirement_id,link.request_id link_request_id,adopt.id adoption_id,"
            "adopt.adoption_ordinal,adopt.task_id adoption_task_id,"
            "adopt.asset_id adoption_asset_id "
            "FROM media_generation_requests req "
            "JOIN media_generation_tasks task ON task.request_id=req.id "
            "JOIN provider_image_invocations inv ON inv.task_id=task.id "
            "JOIN assets asset ON asset.id=task.output_asset_id "
            "JOIN asset_locations loc ON loc.asset_id=asset.id "
            "JOIN generated_asset_provenance prov ON prov.asset_id=asset.id "
            "JOIN shot_requirement_image_generation_links link ON link.request_id=req.id "
            "LEFT JOIN shot_requirement_image_adoptions adopt ON adopt.generation_link_id=link.id "
            "WHERE req.id=?",
            (expected["request_id"],),
        ).fetchone()
        require(row is not None, "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID")
        require(
            row["request_id"] == expected["request_id"]
            and row["task_id"] == expected["task_id"]
            and row["link_id"] == expected["link_id"]
            and row["shot_requirement_id"] == expected["requirement_id"]
            and row["link_request_id"] == expected["request_id"],
            "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID",
        )
        require(
            row["task_status"] == "succeeded"
            and row["provider_call_count"] == 1
            and row["provider_may_have_processed"] == 1
            and row["validated_format"] == "png"
            and row["kind"] == "image"
            and row["storage_mode"] == "managed"
            and row["availability"] == "available",
            "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID",
        )
        require(
            row["adoption_id"] == expected["adoption_id"]
            and row["adoption_ordinal"] == 1
            and row["adoption_task_id"] == row["task_id"]
            and row["adoption_asset_id"] == row["asset_id"],
            "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID",
        )
        hashes = {row["task_sha"], row["invocation_sha"], row["fingerprint"], row["provenance_sha"]}
        require(len(hashes) == 1 and None not in hashes, "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID")
        asset_path = file_uri_path(row["uri"])
        require(asset_path.is_file(), "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID")
        raw = asset_path.read_bytes()
        require(raw.startswith(b"\x89PNG\r\n\x1a\n"), "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID")
        require(
            len(raw) == row["size_bytes"] == row["validated_size_bytes"]
            and sha256_file(asset_path) == row["task_sha"],
            "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID",
        )
        require(
            0 < row["validated_width"] <= 4096
            and 0 < row["validated_height"] <= 4096
            and row["validated_width"] * row["validated_height"] <= 16_777_216,
            "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID",
        )
        require(
            sql.execute("PRAGMA foreign_key_check").fetchall() == [],
            "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID",
        )
        require(
            sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok",
            "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID",
        )
        require(
            sql.execute("SELECT COUNT(*) FROM schema_migrations WHERE version='v15'").fetchone()[0]
            == 1,
            "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID",
        )
        for statement, values in (
            (
                "UPDATE shot_requirement_image_generation_links "
                "SET created_at=created_at WHERE id=?",
                (row["link_id"],),
            ),
            (
                "UPDATE generated_asset_provenance SET created_at=created_at WHERE id=?",
                (row["provenance_id"],),
            ),
            (
                "UPDATE shot_requirement_image_adoptions SET created_at=created_at WHERE id=?",
                (row["adoption_id"],),
            ),
        ):
            try:
                sql.execute(statement, values)
            except sqlite3.IntegrityError:
                pass
            else:
                raise AcceptanceFailure("STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID")
        return {
            "format": "png",
            "width": int(row["validated_width"]),
            "height": int(row["validated_height"]),
            "size_bytes": int(row["validated_size_bytes"]),
            "sha256": row["task_sha"],
            "asset_id": row["asset_id"],
            "provenance_id": row["provenance_id"],
        }


def write_report(report_file: Path, report: dict[str, Any]) -> None:
    require(no_sensitive_keys(report), "STAGE4E_ACCEPTANCE_PRIVACY_FAILED")
    serialized = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    require(
        not re.search(r"(?:[A-Za-z]:\\|file://|https?://)", serialized),
        "STAGE4E_ACCEPTANCE_PRIVACY_FAILED",
    )
    report_file.parent.mkdir(parents=True, exist_ok=True)
    report_file.write_text(serialized, encoding="utf-8")


def run(run_root: Path, report_file: Path) -> dict[str, Any]:
    api_key = os.environ.get("AIVS_REAL_PROVIDER_API_KEY", "")
    require(
        os.environ.get("AIVS_STAGE4E_REAL_ACCEPTANCE_ENABLED") == "1" and bool(api_key.strip()),
        "STAGE4E_ACCEPTANCE_ENVIRONMENT_INVALID",
    )
    require(
        PRIOR_ESTIMATED_USD + NEW_DISPATCH_ESTIMATED_USD <= HARD_STOP_USD,
        "STAGE4E_ACCEPTANCE_BUDGET_BLOCKED",
    )
    require(not run_root.exists(), "STAGE4E_ACCEPTANCE_ISOLATION_INVALID")
    data_dir = run_root / "data"
    run_root.mkdir(parents=True)
    admin_token = "stage4e-gate4e4-local-admin"
    previous_admin = os.environ.get("AIVS_ADMIN_TOKEN")
    os.environ["AIVS_ADMIN_TOKEN"] = admin_token
    database = data_dir / "app.db"
    prompt = "Create a clean cinematic still life with a blue ceramic cup on a wooden table."
    requirement_body = {
        "schema_version": 1,
        "base_revision_id": None,
        "title": "Gate 4E-4",
        "summary": "",
        "requirements": [
            {
                "title": "Generated still",
                "visual_direction": "A blue ceramic cup on a wooden table, cinematic daylight.",
                "target_duration_us": 2_000_000,
                "visual": {"requirement_kind": "image", "source_asset_id": None},
                "narration": None,
            }
        ],
    }
    expected: dict[str, str] = {}
    try:
        app = create_app(settings(data_dir, True))
        with TestClient(app) as client:
            admin, ui = session(client, admin_token)
            project_response = client.post(
                "/api/v1/projects", headers=ui, json={"name": "Gate 4E-4 isolated"}
            )
            require(project_response.status_code == 201, "STAGE4E_ACCEPTANCE_INTERNAL_FAILED")
            project_id = project_response.json()["project_id"]
            revision_response = client.post(
                f"/api/v1/projects/{project_id}/shot-list/revisions",
                headers=ui,
                json=requirement_body,
            )
            require(revision_response.status_code == 200, "STAGE4E_ACCEPTANCE_INTERNAL_FAILED")
            revision = revision_response.json()["revision"]
            revision_id = revision["shot_list_revision_id"]
            requirement_id = revision["requirements"][0]["shot_requirement_id"]
            confirm = client.post(
                f"/api/v1/projects/{project_id}/shot-list/confirm",
                headers=ui,
                json={"revision_id": revision_id, "expected_current_revision_id": revision_id},
            )
            require(confirm.status_code == 200, "STAGE4E_ACCEPTANCE_INTERNAL_FAILED")
            config_response = client.post(
                f"/api/v1/projects/{project_id}/image-provider-configs",
                headers=ui,
                json={"display_name": "Gate 4E-4", "enabled": True},
            )
            require(config_response.status_code == 200, "STAGE4E_ACCEPTANCE_INTERNAL_FAILED")
            config_id = config_response.json()["provider_config_id"]
            secret_response = client.put(
                f"/api/v1/internal/image-provider-configs/{config_id}/secret",
                headers=admin,
                json={"secret": api_key},
            )
            require(secret_response.status_code == 200, "STAGE4E_ACCEPTANCE_INTERNAL_FAILED")
            base = (
                f"/api/v1/projects/{project_id}/shot-requirements/"
                f"{requirement_id}/image-fulfillment"
            )
            before_prepare = counts(database)
            prepared_response = client.post(
                f"{base}/prepare",
                headers=ui,
                json={
                    "expected_confirmed_revision_id": revision_id,
                    "provider_config_id": config_id,
                    "prompt": prompt,
                },
            )
            require(prepared_response.status_code == 200, "STAGE4E_ACCEPTANCE_PREPARE_FAILED")
            prepared = prepared_response.json()
            after_prepare = counts(database)
            require(
                before_prepare == after_prepare and after_prepare["provider_call"] == 0,
                "STAGE4E_ACCEPTANCE_PREPARE_SIDE_EFFECT",
            )
            created_response = client.post(
                f"{base}/create",
                headers=ui,
                json={
                    "preview_id": prepared["preview_id"],
                    "fulfillment_payload_sha256": prepared["fulfillment_payload_sha256"],
                    "expected_confirmed_revision_id": revision_id,
                    "confirmed": True,
                },
            )
            require(created_response.status_code == 200, "STAGE4E_ACCEPTANCE_CREATE_FAILED")
            created = created_response.json()
            expected = {
                "project_id": project_id,
                "revision_id": revision_id,
                "requirement_id": requirement_id,
                "request_id": created["request"]["request_id"],
                "task_id": created["task"]["task_id"],
                "link_id": created["link"]["link_id"],
            }
            task = wait_task(client, ui, expected["request_id"])
            if task["status"] != "succeeded":
                provider = app.state.core.provider_image_generation.provider
                diagnostic = (
                    provider.take_protocol_diagnostic(expected["task_id"])
                    if isinstance(provider, ApiKeyFunImagesProvider)
                    else None
                )
                require(
                    diagnostic is not None and safe_protocol_diagnostic(diagnostic),
                    "STAGE4E_ACCEPTANCE_PRIVACY_FAILED",
                )
                failure_report = {
                    "schema_version": SCHEMA_VERSION,
                    "status": "provider_failed",
                    "safe_code": "STAGE4E_ACCEPTANCE_PROVIDER_FAILED",
                    "provider_error_code": task.get("error", {}).get("code"),
                    "protocol_diagnostic": diagnostic,
                    "budget": {
                        "prior_estimated_usd": PRIOR_ESTIMATED_USD,
                        "new_dispatches": 1,
                        "new_dispatch_estimated_usd": NEW_DISPATCH_ESTIMATED_USD,
                        "estimated_total_usd": (
                            PRIOR_ESTIMATED_USD + NEW_DISPATCH_ESTIMATED_USD
                        ),
                        "hard_stop_usd": HARD_STOP_USD,
                    },
                }
                write_report(report_file, failure_report)
                raise AcceptanceFailure("STAGE4E_ACCEPTANCE_PROVIDER_FAILED")
            require(
                task["provider_call_count"] == 1 and task["output_asset_id"],
                "STAGE4E_ACCEPTANCE_FACT_CHAIN_INVALID",
            )
            adoption_response = client.post(
                f"{base}/adopt",
                headers=ui,
                json={
                    "generation_link_id": expected["link_id"],
                    "task_id": expected["task_id"],
                    "asset_id": task["output_asset_id"],
                    "expected_current_adoption_id": None,
                    "confirmed": True,
                },
            )
            require(adoption_response.status_code == 200, "STAGE4E_ACCEPTANCE_ADOPTION_FAILED")
            expected["adoption_id"] = adoption_response.json()["adoption"]["adoption_id"]
            state_response = client.get(base, headers=ui)
            require(
                state_response.status_code == 200
                and state_response.json()["lifecycle"] == "adopted"
                and state_response.json()["current_adoption"]["adoption_id"]
                == expected["adoption_id"],
                "STAGE4E_ACCEPTANCE_ADOPTION_FAILED",
            )
        final_counts = counts(database)
        require(
            final_counts
            == {
                "request": 1,
                "task": 1,
                "job": 1,
                "invocation": 1,
                "link": 1,
                "adoption": 1,
                "provenance": 1,
                "timeline_revision": 0,
                "provider_call": 1,
            },
            "STAGE4E_ACCEPTANCE_CARDINALITY_INVALID",
        )
        chain = inspect_chain(database, expected)
        sqlite_bytes = database.read_bytes()
        require(
            api_key.encode("utf-8") not in sqlite_bytes
            and prompt.encode("utf-8") not in sqlite_bytes,
            "STAGE4E_ACCEPTANCE_PRIVACY_FAILED",
        )
        restart_app = create_app(settings(data_dir, False))
        require(
            isinstance(
                restart_app.state.core.provider_image_generation.provider, FailOnCallImageProvider
            ),
            "STAGE4E_ACCEPTANCE_RESTART_FAILED",
        )
        before_restart = counts(database)
        with TestClient(restart_app) as client:
            _, ui = session(client, admin_token)
            base = (
                f"/api/v1/projects/{expected['project_id']}/shot-requirements/"
                f"{expected['requirement_id']}/image-fulfillment"
            )
            recovered = client.get(base, headers=ui)
            require(
                recovered.status_code == 200
                and recovered.json()["lifecycle"] == "adopted"
                and recovered.json()["current_adoption"]["adoption_id"] == expected["adoption_id"],
                "STAGE4E_ACCEPTANCE_RESTART_FAILED",
            )
            links = client.get(f"{base}/links?limit=20", headers=ui)
            adoptions = client.get(f"{base}/adoptions?limit=20", headers=ui)
            require(
                links.status_code == 200 and len(links.json()["items"]) == 1,
                "STAGE4E_ACCEPTANCE_RESTART_FAILED",
            )
            require(
                adoptions.status_code == 200 and len(adoptions.json()["items"]) == 1,
                "STAGE4E_ACCEPTANCE_RESTART_FAILED",
            )
        after_restart = counts(database)
        require(
            after_restart == before_restart and after_restart["provider_call"] == 1,
            "STAGE4E_ACCEPTANCE_RESTART_FAILED",
        )
        report = {
            "schema_version": SCHEMA_VERSION,
            "status": "passed",
            "safe_code": "STAGE4E_ACCEPTANCE_PASSED",
            "provider": {
                "kind": "apikey_fun_images",
                "adapter_id": "apikey_fun_images_sse_v1",
                "model": "gpt-image-2",
                "requested_size": "1024x1024",
            },
            "budget": {
                "prior_estimated_usd": PRIOR_ESTIMATED_USD,
                "new_dispatches": 1,
                "new_dispatch_estimated_usd": NEW_DISPATCH_ESTIMATED_USD,
                "estimated_total_usd": PRIOR_ESTIMATED_USD + NEW_DISPATCH_ESTIMATED_USD,
                "hard_stop_usd": HARD_STOP_USD,
            },
            "cardinality": final_counts,
            "output": chain,
            "checks": {
                "fresh_isolated_data": True,
                "confirmed_image_requirement": True,
                "prepare_database_delta_zero": True,
                "prepare_provider_call_delta_zero": True,
                "single_fresh_task": True,
                "single_provider_dispatch": True,
                "managed_asset_available": True,
                "asset_invocation_provenance_hash_match": True,
                "immutable_link": True,
                "append_only_adoption_ordinal_one": True,
                "timeline_revision_delta_zero": True,
                "sqlite_v15": True,
                "foreign_key_check": True,
                "integrity_check": True,
                "restart_network_disabled": True,
                "restart_provider_call_delta_zero": True,
                "prompt_and_secret_absent_from_sqlite": True,
                "report_redacted": True,
            },
        }
        write_report(report_file, report)
        return report
    finally:
        if previous_admin is None:
            os.environ.pop("AIVS_ADMIN_TOKEN", None)
        else:
            os.environ["AIVS_ADMIN_TOKEN"] = previous_admin


def self_test() -> dict[str, Any]:
    require(
        PRIOR_ESTIMATED_USD + NEW_DISPATCH_ESTIMATED_USD <= HARD_STOP_USD,
        "STAGE4E_ACCEPTANCE_BUDGET_BLOCKED",
    )
    probe = {
        "schema_version": 1,
        "status": "self_test_passed",
        "safe_code": "STAGE4E_ACCEPTANCE_PASSED",
        "network_dispatches": 0,
    }
    require(no_sensitive_keys(probe), "STAGE4E_ACCEPTANCE_PRIVACY_FAILED")
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
            require(
                args.run_root is not None and args.report_file is not None,
                "STAGE4E_ACCEPTANCE_ENVIRONMENT_INVALID",
            )
            result = run(args.run_root.resolve(), args.report_file.resolve())
        print(
            json.dumps(
                {
                    "schema_version": 1,
                    "status": result["status"],
                    "safe_code": result["safe_code"],
                    "provider_dispatches": result.get("budget", {}).get("new_dispatches", 0),
                },
                separators=(",", ":"),
            )
        )
        return 0
    except AcceptanceFailure as exc:
        print(
            json.dumps(
                {"schema_version": 1, "status": "failed", "safe_code": exc.code},
                separators=(",", ":"),
            )
        )
        return 1
    except BaseException:
        print(
            json.dumps(
                {
                    "schema_version": 1,
                    "status": "failed",
                    "safe_code": "STAGE4E_ACCEPTANCE_INTERNAL_FAILED",
                },
                separators=(",", ":"),
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
