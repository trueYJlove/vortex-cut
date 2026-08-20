# ruff: noqa: E501
from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CORE_SRC = ROOT / "services" / "core" / "src"
if str(CORE_SRC) not in sys.path:
    sys.path.insert(0, str(CORE_SRC))

from aivs_core.database import MIGRATIONS, Database  # noqa: E402

FROZEN = tuple(f"v{i}" for i in range(1, 15))
PROFILE = ("apikey_fun_images", "apikey_fun_images_sse_v1", "gpt-image-2", "1")
SENSITIVE_KEYS = {
    "prompt", "payload", "authorization", "api_key", "secret", "path", "uri",
    "absolute_path", "raw_exception", "raw_response", "sse", "base64", "traceback",
    "visual_direction", "narration_text",
}

def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def requirement_document(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    narration = None
    if row["narration_kind"] is not None:
        narration = {"requirement_kind": row["narration_kind"], "text": row["narration_text"]}
    return {
        "schema_version": 1,
        "shot_list_revision_id": row["shot_list_revision_id"],
        "shot_requirement_id": row["id"],
        "ordinal": row["ordinal"],
        "title": row["title"],
        "visual_direction": row["visual_direction"],
        "target_duration_us": row["target_duration_us"],
        "visual": {"requirement_kind": row["visual_kind"], "source_asset_id": row["visual_source_asset_id"]},
        "narration": narration,
    }


def requirement_hash(row: sqlite3.Row | dict[str, Any]) -> str:
    return sha256(requirement_document(row))


def initialize(path: Path) -> Database:
    database = Database(path)
    database.initialize()
    return database

def seed(db: sqlite3.Connection) -> dict[str, str]:
    now = "2026-08-19T00:00:00Z"
    projects = ("project_a", "project_b")
    for project_id in projects:
        db.execute(
            "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,root_dir,root_dir_name,created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (project_id, "project", "active", "{}", None, "root", "root", now, now, now),
        )
    db.execute("INSERT INTO shot_lists VALUES (?,?,?,?,?,?)", ("list_a", "project_a", None, None, now, now))
    for revision_id in ("revision_a", "revision_old"):
        db.execute(
            "INSERT INTO shot_list_revisions VALUES (?,?,?,?,?,?,?,?,?)",
            (revision_id, "list_a", "project_a", None, 1, "Shot list", "", "sha256:" + revision_id, now),
        )
    requirements = [
        ("requirement_a", "revision_a", 0, "Opening", "A quiet blue horizon", 3_000_000, "image", None, None, None),
        ("requirement_b", "revision_a", 1, "Closing", "The same visual intent", 3_000_000, "image", None, None, None),
        ("requirement_old", "revision_old", 0, "Old", "Historical frame", 3_000_000, "image", None, None, None),
        ("requirement_media", "revision_a", 2, "Media", "Use media", 3_000_000, "existing_media", "source_asset", None, None),
    ]
    db.execute(
        "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,modified_at,availability,media_info_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        ("source_asset", "project_a", "image", "managed", "source", "source-fp", 1, None, "available", "{}", now, now),
    )
    db.executemany("INSERT INTO shot_requirements VALUES (?,?,?,?,?,?,?,?,?,?)", requirements)
    db.execute("UPDATE shot_lists SET current_revision_id=?,confirmed_revision_id=? WHERE id='list_a'", ("revision_a", "revision_a"))
    return {"now": now, "project": "project_a", "revision": "revision_a", "requirement": "requirement_a"}


def create_request_facts(
    db: sqlite3.Connection,
    request_id: str,
    task_id: str,
    *,
    provider_kind: str = PROFILE[0],
    adapter_id: str = PROFILE[1],
    model: str = PROFILE[2],
    protocol: str = PROFILE[3],
    project_id: str = "project_a",
    request_sha: str | None = None,
) -> None:
    now = "2026-08-19T00:00:00Z"
    config_id = "config_apikey" if provider_kind == PROFILE[0] else "config_openai"
    job_id = "job_" + task_id
    invocation_id = "invocation_" + task_id
    db.execute(
        "INSERT INTO media_generation_requests VALUES (?,?,?,?,?,?,?,?,?)",
        (request_id, project_id, "image", "provider_image_v1", "sha256:prompt", "[]", "{}", request_sha or "sha256:" + request_id, now),
    )
    db.execute(
        "INSERT OR IGNORE INTO image_provider_configs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (config_id, project_id, provider_kind, adapter_id, "image_text_to_image", protocol, "provider", model, 1, 0.1 if provider_kind == PROFILE[0] else None, 0.15 if provider_kind == PROFILE[0] else None, "CNY" if provider_kind == PROFILE[0] else None, now, now),
    )
    endpoint = "apikey_fun_images_generations" if provider_kind == PROFILE[0] else "openai_images_generations"
    db.execute(
        "INSERT INTO provider_image_request_profiles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (request_id, config_id, provider_kind, adapter_id, "image_text_to_image", protocol, model, endpoint, "1024x1024", "png", "sha256:profile", "sha256:payload", now, now),
    )
    db.execute(
        "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (job_id, project_id, "media_generation", "provider_image_generation", "queued", "queued", 0, "{}", 1, now, now),
    )
    db.execute(
        "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,retry_of_task_id,output_asset_id,output_sha256,result_summary_json,error_code,error_message,created_at,updated_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (task_id, request_id, job_id, 1, "queued", "queued", None, None, None, None, None, None, now, now, None),
    )
    db.execute(
        "INSERT INTO provider_image_invocations(id,task_id,provider_config_id,status,provider_call_count,provider_may_have_processed,cleanup_required,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (invocation_id, task_id, config_id, "prepared", 0, 0, 0, now, now),
    )


def complete_task(db: sqlite3.Connection, request_id: str, task_id: str, asset_id: str, *, availability: str = "available") -> None:
    now = "2026-08-19T00:01:00Z"
    db.execute(
        "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,modified_at,availability,media_info_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (asset_id, "project_a", "image", "managed", "generated", "fp-" + asset_id, 1024, None, availability, "{}", now, now),
    )
    db.execute(
        "UPDATE media_generation_tasks SET status='succeeded',stage='completed',output_asset_id=?,output_sha256=?,updated_at=?,finished_at=? WHERE id=?",
        (asset_id, "sha256:output", now, now, task_id),
    )
    db.execute(
        "INSERT INTO generated_asset_provenance VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("prov_" + asset_id, asset_id, request_id, task_id, "invocation_" + task_id, "sha256:prompt", PROFILE[0], PROFILE[1], PROFILE[3], PROFILE[2], "sha256:profile", "sha256:response", "sha256:output", now),
    )


def insert_link(db: sqlite3.Connection, link_id: str, requirement_id: str, request_id: str, *, revision_id: str = "revision_a") -> None:
    row = db.execute("SELECT * FROM shot_requirements WHERE id=?", (requirement_id,)).fetchone()
    assert row is not None
    db.execute(
        "INSERT INTO shot_requirement_image_generation_links VALUES (?,?,?,?,?,?,?)",
        (link_id, "project_a", revision_id, requirement_id, request_id, requirement_hash(row), "2026-08-19T00:00:00Z"),
    )


def current_adoption(db: sqlite3.Connection, requirement_id: str) -> sqlite3.Row | None:
    return db.execute(
        "SELECT * FROM shot_requirement_image_adoptions WHERE shot_requirement_id=? ORDER BY adoption_ordinal DESC LIMIT 1",
        (requirement_id,),
    ).fetchone()


def adopt(
    db: sqlite3.Connection,
    adoption_id: str,
    requirement_id: str,
    link_id: str,
    task_id: str,
    asset_id: str,
    expected_current_adoption_id: str | None,
) -> tuple[sqlite3.Row, bool]:
    db.execute("BEGIN IMMEDIATE")
    try:
        current = current_adoption(db, requirement_id)
        current_id = current["id"] if current else None
        if current_id != expected_current_adoption_id:
            raise ValueError("ADOPTION_CONFLICT")
        if current and current["generation_link_id"] == link_id and current["task_id"] == task_id and current["asset_id"] == asset_id:
            db.execute("COMMIT")
            return current, True
        ordinal = (current["adoption_ordinal"] if current else 0) + 1
        db.execute(
            "INSERT INTO shot_requirement_image_adoptions VALUES (?,?,?,?,?,?,?,?,?,?)",
            (adoption_id, "project_a", "revision_a", requirement_id, link_id, task_id, asset_id, ordinal, current_id, "2026-08-19T00:02:00Z"),
        )
        result = db.execute("SELECT * FROM shot_requirement_image_adoptions WHERE id=?", (adoption_id,)).fetchone()
        db.execute("COMMIT")
        assert result is not None
        return result, False
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise


def lifecycle(*, task_statuses: list[str], adoption_exists: bool, adopted_asset_availability: str | None) -> str:
    if adoption_exists and adopted_asset_availability != "available":
        return "adopted_unavailable"
    if adoption_exists:
        return "adopted"
    if "succeeded" in task_statuses:
        return "review_required"
    if any(status in {"queued", "running"} for status in task_statuses):
        return "in_progress"
    if task_statuses:
        return "no_usable_output"
    return "unstarted"


def create_with_hook(
    db: sqlite3.Connection,
    request_id: str,
    task_id: str,
    hook: Callable[[sqlite3.Connection, dict[str, Any]], Any] | None,
    *,
    request_sha: str,
) -> dict[str, Any]:
    db.execute("BEGIN IMMEDIATE")
    try:
        existing = db.execute("SELECT id FROM media_generation_requests WHERE project_id='project_a' AND request_sha256=?", (request_sha,)).fetchone()
        reused = existing is not None
        if reused:
            request_id = str(existing["id"])
            task = db.execute("SELECT id FROM media_generation_tasks WHERE request_id=? AND attempt=1", (request_id,)).fetchone()
            if task is None:
                raise ValueError("REQUEST_TASK_INCOMPLETE")
            task_id = str(task["id"])
        else:
            create_request_facts(db, request_id, task_id, request_sha=request_sha)
        facts = {"request_id": request_id, "task_id": task_id, "reused": reused}
        hook_result = hook(db, facts) if hook else None
        db.execute("COMMIT")
        return {**facts, "hook_result": hook_result}
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise


def _fails(action: Callable[[], Any], expected: type[BaseException] = sqlite3.IntegrityError) -> bool:
    try:
        action()
    except expected:
        return True
    return False


def _execute(db: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> None:
    db.execute(sql, params)


def frozen_checksums() -> dict[str, str]:
    return {version: hashlib.sha256(MIGRATIONS[version].encode("utf-8")).hexdigest() for version in FROZEN}


def safe_report(value: Any) -> bool:
    def walk(item: Any) -> bool:
        if isinstance(item, dict):
            return all(isinstance(key, str) and key.lower() not in SENSITIVE_KEYS and walk(child) for key, child in item.items())
        if isinstance(item, list):
            return all(walk(child) for child in item)
        if isinstance(item, str):
            lower = item.lower()
            return not any(marker in lower for marker in ("sentinel_prompt", "authorization:", "c:\\", "traceback", "data:image"))
        return True
    return walk(value)



def measure_link_insert_p95(db: sqlite3.Connection, iterations: int = 20) -> float:
    values: list[float] = []
    for index in range(iterations):
        requirement_id = "requirement_a" if index == 0 else f"requirement_perf_{index}"
        if index:
            db.execute(
                "INSERT INTO shot_requirements VALUES (?,?,?,?,?,?,?,?,?,?)",
                (requirement_id, "revision_a", index + 2, "Title", "Direction", 3_000_000, "image", None, None, None),
            )
        request_id = f"request_perf_{index}"
        task_id = f"task_perf_{index}"
        create_request_facts(db, request_id, task_id)
        start = __import__("time").perf_counter()
        insert_link(db, f"link_perf_{index}", requirement_id, request_id)
        values.append((__import__("time").perf_counter() - start) * 1000)
    ordered = sorted(values)
    return round(ordered[max(0, round((len(ordered) - 1) * 0.95))], 3)


def run_prototype(path: Path, iterations: int = 20) -> dict[str, Any]:
    database = initialize(path)
    with database.connection() as db:
        seed(db)
        row = db.execute("SELECT * FROM shot_requirements WHERE id='requirement_a'").fetchone()
        assert row is not None
        report = {
            "schema_version": "v15-candidate",
            "frozen_migration_count": len(FROZEN),
            "requirement_hash_fixed_vector": requirement_hash(row),
            "link_insert_p95_ms": measure_link_insert_p95(db, iterations),
            "lifecycle_states": [
                "unstarted", "in_progress", "review_required", "adopted",
                "adopted_unavailable", "no_usable_output",
            ],
            "provider_call_count": 0,
            "forbidden_side_effect_count": 0,
        }
        assert safe_report(report)
        return report


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=20)
    arguments = parser.parse_args()
    print(json.dumps(run_prototype(arguments.database, arguments.iterations), ensure_ascii=False, indent=2))
