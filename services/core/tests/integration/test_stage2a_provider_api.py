from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.database import json_dumps
from aivs_core.providers import ProviderError, StructuredTextResult


class LocalProvider:
    def __init__(self, outcome: str) -> None:
        self.outcome = outcome
        self.requests: list[object] = []

    async def generate(self, request, cancel_event: asyncio.Event) -> StructuredTextResult:
        self.requests.append(request)
        assert "SENTINEL_KEY" == request.api_key
        if self.outcome == "cancel":
            await cancel_event.wait()
            raise ProviderError("PROVIDER_CANCELLED", "cancelled")
        if self.outcome == "timeout":
            raise ProviderError("PROVIDER_TIMEOUT", "timeout")
        if self.outcome == "offline":
            raise ProviderError("PROVIDER_NETWORK_ERROR", "offline")
        if self.outcome == "invalid_json":
            raise ProviderError("PROVIDER_INVALID_RESPONSE", "invalid")
        if self.outcome == "schema":
            return StructuredTextResult({"candidates": []}, None, None)
        clips = [
            {"segment_ids": ["s1"], "reason": "relevant segment", "model_score": 0.5},
            {"segment_ids": ["s2"], "reason": "second segment", "model_score": None},
        ]
        return StructuredTextResult(
            {
                "candidates": [
                    {
                        "variant": variant,
                        "title_suggestion": variant,
                        "summary": "local mock candidate",
                        "clips": clips,
                    }
                    for variant in ("balanced", "compact", "bold")
                ]
            },
            {"total_tokens": 3},
            "local-request",
        )


def _setup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, outcome: str
) -> tuple[TestClient, dict[str, str], str, str]:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-stage2a")
    app = create_app(Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing")))
    app.state.core.planning.provider_factory = lambda: LocalProvider(outcome)
    client = TestClient(app)
    client.__enter__()
    admin = {"Authorization": "Bearer admin-stage2a"}
    ui = {
        "Authorization": f"Bearer {client.post('/api/v1/internal/sessions', headers=admin).json()['token']}"  # noqa: E501
    }
    project_id = client.post("/api/v1/projects", headers=ui, json={"name": "Stage2A"}).json()[
        "project_id"
    ]
    db = app.state.core.db
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,availability,media_info_json,created_at,updated_at) VALUES ('a1',?,'video','external','private.mp4','fp',1,'available',?,'now','now')",  # noqa: E501
            (project_id, json_dumps({"duration_us": 30_000_000, "video_streams": [{}]})),
        )  # noqa: E501
        conn.execute(
            "INSERT INTO transcripts VALUES ('t1','a1','ready','zh','local','m','r','fp',30000000,'now','now')"  # noqa: E501
        )
        conn.execute(
            "INSERT INTO transcript_segments VALUES ('s1','t1',0,0,15000000,'first local segment',0.9)"  # noqa: E501
        )
        conn.execute(
            "INSERT INTO transcript_segments VALUES ('s2','t1',1,15000000,30000000,'second local segment',0.9)"  # noqa: E501
        )
    provider = client.post(
        "/api/v1/providers",
        headers=ui,
        json={
            "kind": "openai_compatible_text",
            "display_name": "local",
            "base_url": "http://127.0.0.1:9999/v1",
            "model": "mock",
        },
    ).json()  # noqa: E501
    provider_id = provider["provider_config_id"]
    assert (
        client.put(
            f"/api/v1/internal/provider-secrets/{provider_id}",
            headers=admin,
            json={"secret": "SENTINEL_KEY"},
        ).status_code
        == 200
    )  # noqa: E501
    with db.connection() as conn:
        conn.execute(
            "UPDATE provider_configs SET candidate_capability_status='supported',"
            "candidate_response_adapter_id='openai_chat_completions_json_schema_v1',"
            "candidate_probe_protocol_version='2',candidate_capability_tested_at='now',"
            "candidate_capability_failure_code=NULL,"
            "candidate_capability_probe_sha256='sha256:probe' "
            "WHERE id=?",
            (provider_id,),
        )
    brief = {
        "schema_version": 1,
        "topic": "topic",
        "audience": "audience",
        "target_platform": "generic_vertical",
        "target_duration_us": 30_000_000,
        "narrative_goal": "goal",
        "style_notes": "",
        "must_keep": [],
        "forbidden": [],
        "original_audio_policy": "preserve",
        "caption_policy": "auto_from_transcript",
        "caption_preset_id": "default-bottom",
        "default_layout": "fit",
    }  # noqa: E501
    assert (
        client.put(f"/api/v1/projects/{project_id}/brief", headers=ui, json=brief).status_code
        == 200
    )
    return client, ui, project_id, provider_id


def _prepare_create(client: TestClient, ui: dict[str, str], project_id: str) -> dict:
    preview = client.post(
        f"/api/v1/projects/{project_id}/candidate-generations/prepare",
        headers=ui,
        json={
            "provider_config_id": client.get("/api/v1/providers", headers=ui).json()["items"][0][
                "provider_config_id"
            ],
            "recipe_id": "balanced-narrative-v1",
            "transcript_ids": ["t1"],
        },
    ).json()  # noqa: E501
    created = client.post(
        f"/api/v1/projects/{project_id}/candidate-generations",
        headers=ui,
        json={
            "egress_preview_id": preview["egress_preview_id"],
            "payload_sha256": preview["payload_sha256"],
        },
    )  # noqa: E501
    assert created.status_code == 200
    return created.json()


def _wait(client: TestClient, ui: dict[str, str], job_id: str) -> dict:
    for _ in range(100):
        job = client.get(f"/api/v1/jobs/{job_id}", headers=ui).json()
        if job["status"] in {"succeeded", "failed", "cancelled", "interrupted"}:
            return job
        import time

        time.sleep(0.03)
    raise AssertionError("job did not finish")


def test_provider_delete_api_removes_unreferenced_and_refuses_referenced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """P67：DELETE /api/v1/providers/{id}——未引用 204 且列表消失；
    被调用历史引用 409 PROVIDER_IN_USE（行保持原样）；未知 404。"""
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-del")
    app = create_app(Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing")))
    client = TestClient(app)
    client.__enter__()
    try:
        admin = {"Authorization": "Bearer admin-del"}
        ui = {
            "Authorization": f"Bearer {client.post('/api/v1/internal/sessions', headers=admin).json()['token']}"  # noqa: E501
        }

        def _create(name: str) -> str:
            return client.post(
                "/api/v1/providers",
                headers=ui,
                json={
                    "kind": "openai_compatible_text",
                    "display_name": name,
                    "base_url": "http://127.0.0.1:9999/v1",
                    "model": "mock",
                },
            ).json()["provider_config_id"]

        unreferenced, referenced = _create("drop"), _create("keep-history")
        with app.state.core.db.connection() as conn:
            conn.execute(
                "INSERT INTO provider_invocations"
                "(id,provider_config_id,capability,provider_name,model,"
                "prompt_template_version,output_schema_version,input_sha256,status,created_at)"
                " VALUES ('inv_del',?,'cap','p','m','1','1',?,'succeeded','now')",
                (referenced, "sha256:" + "a" * 64),
            )

        assert client.delete(f"/api/v1/providers/{unreferenced}", headers=ui).status_code == 204
        remaining = [
            item["provider_config_id"]
            for item in client.get("/api/v1/providers", headers=ui).json()["items"]
        ]
        assert unreferenced not in remaining and referenced in remaining

        conflict = client.delete(f"/api/v1/providers/{referenced}", headers=ui)
        assert conflict.status_code == 409
        assert conflict.json()["error"]["code"] == "PROVIDER_IN_USE"

        missing = client.delete("/api/v1/providers/provider_none", headers=ui)
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "PROVIDER_NOT_FOUND"
    finally:
        client.__exit__(None, None, None)


@pytest.mark.parametrize(
    "outcome,code",
    [
        ("timeout", "PROVIDER_TIMEOUT"),
        ("offline", "PROVIDER_NETWORK_ERROR"),
        ("invalid_json", "PROVIDER_INVALID_RESPONSE"),
        ("schema", "PROVIDER_SCHEMA_MISMATCH"),
    ],
)
def test_candidate_generation_api_provider_failures_archive_safely(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, outcome: str, code: str
) -> None:
    client, ui, project_id, _ = _setup(tmp_path, monkeypatch, outcome)
    try:
        created = _prepare_create(client, ui, project_id)
        job = _wait(client, ui, created["job"]["job_id"])
        assert job["status"] == "failed" and job["error"]["code"] == code
        assert (
            client.post(f"/api/v1/jobs/{job['job_id']}/retry", headers=ui).json()["error"]["code"]
            == "CANDIDATE_GENERATION_RECONFIRM_REQUIRED"
        )
        with client.app.state.core.db.connection() as db:
            assert db.execute("SELECT COUNT(*) FROM candidate_plans").fetchone()[0] == 0
    finally:
        client.__exit__(None, None, None)


@pytest.mark.parametrize("recover_status", ["running", "cancelling"])
def test_candidate_generation_api_success_clip_lookup_and_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, recover_status: str
) -> None:
    client, ui, project_id, _ = _setup(tmp_path, monkeypatch, "success")
    try:
        created = _prepare_create(client, ui, project_id)
        assert _wait(client, ui, created["job"]["job_id"])["status"] == "succeeded"
        plan = client.get(f"/api/v1/projects/{project_id}/candidate-plans", headers=ui).json()[
            "items"
        ][0]
        clip = plan["clips"][0]
        lookup = client.get(
            f"/api/v1/projects/{project_id}/candidate-plans/"
            f"{plan['candidate_plan_id']}/clips/{clip['clip_id']}",
            headers=ui,
        )
        assert lookup.status_code == 200
        assert set(lookup.json()) == {
            "candidate_plan_id",
            "project_id",
            "candidate_clip_id",
            "asset_id",
            "transcript_id",
            "segment_ids",
            "source_start_us",
            "source_end_us",
            "caption_text",
        }  # noqa: E501
        assert "private.mp4" not in lookup.text and "fp" not in lookup.text
        other_project = client.post(
            "/api/v1/projects", headers=ui, json={"name": "unrelated"}
        ).json()["project_id"]
        denied = client.get(
            f"/api/v1/projects/{other_project}/candidate-plans/"
            f"{plan['candidate_plan_id']}/clips/{clip['clip_id']}",
            headers=ui,
        )
        assert denied.status_code == 404
        assert denied.json()["error"]["code"] == "CANDIDATE_PLAN_NOT_FOUND"
        with client.app.state.core.db.connection() as db:
            db.execute(
                "UPDATE jobs SET status=? WHERE id=?",
                (recover_status, created["job"]["job_id"]),
            )
        settings = client.app.state.core.settings
    finally:
        client.__exit__(None, None, None)
    restarted = TestClient(create_app(settings))
    with restarted:
        admin = {"Authorization": "Bearer admin-stage2a"}
        restart_ui = {
            "Authorization": (
                "Bearer "
                + restarted.post("/api/v1/internal/sessions", headers=admin).json()["token"]
            )
        }
        with restarted.app.state.core.db.connection() as db:
            assert (
                db.execute(
                    "SELECT status FROM jobs WHERE id=?", (created["job"]["job_id"],)
                ).fetchone()[0]
                == "interrupted"
            )
            assert (
                db.execute(
                    "SELECT status FROM candidate_generations WHERE id=?",
                    (created["candidate_generation_id"],),
                ).fetchone()[0]
                == "succeeded"
            )
        retry = restarted.post(
            f"/api/v1/jobs/{created['job']['job_id']}/retry",
            headers=restart_ui,
        )
        assert retry.status_code == 409
        assert retry.json()["error"]["code"] == "CANDIDATE_GENERATION_RECONFIRM_REQUIRED"


def test_candidate_generation_api_cancel_archives_invocation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, ui, project_id, _ = _setup(tmp_path, monkeypatch, "cancel")
    try:
        created = _prepare_create(client, ui, project_id)
        for _ in range(100):
            running = client.get(f"/api/v1/jobs/{created['job']['job_id']}", headers=ui).json()
            if running["status"] == "running":
                break
            import time

            time.sleep(0.02)
        else:
            raise AssertionError("candidate generation did not start")
        assert (
            client.post(f"/api/v1/jobs/{created['job']['job_id']}/cancel", headers=ui).status_code
            == 200
        )
        job = _wait(client, ui, created["job"]["job_id"])
        assert job["status"] == "cancelled"
        with client.app.state.core.db.connection() as db:
            generation_status = db.execute(
                "SELECT status FROM candidate_generations WHERE id=?",
                (created["candidate_generation_id"],),
            ).fetchone()[0]
            invocation_status, may_process = db.execute(
                "SELECT status,provider_may_have_processed FROM provider_invocations WHERE candidate_generation_id=?",  # noqa: E501
                (created["candidate_generation_id"],),
            ).fetchone()  # noqa: E501
        assert generation_status == "cancelled"
        assert (invocation_status, may_process) == ("cancelled", 1)
    finally:
        client.__exit__(None, None, None)


def test_provider_connection_test_and_public_dtos_do_not_leak_secret(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, ui, _, provider_id = _setup(tmp_path, monkeypatch, "success")
    local = LocalProvider("success")
    client.app.state.core.planning.provider_factory = lambda: local
    try:
        response = client.post(f"/api/v1/providers/{provider_id}/test", headers=ui)
        assert response.status_code == 200, response.text
        invocation_id = response.json()["provider_invocation_id"]
        assert len(local.requests) == 1
        request = local.requests[0]
        instruction = "Return exactly three empty candidate variants for capability verification."
        assert request.payload == {
            "capability": "connection_test",
            "instruction": instruction,
        }
        assert "SENTINEL_KEY" not in response.text
        providers = client.get("/api/v1/providers", headers=ui)
        assert "SENTINEL_KEY" not in providers.text
        preview = client.post(
            "/api/v1/projects/missing/candidate-generations/prepare",
            headers=ui,
            json={
                "provider_config_id": provider_id,
                "recipe_id": "balanced-narrative-v1",
                "transcript_ids": ["t1"],
            },
        )
        assert "SENTINEL_KEY" not in preview.text
        with client.app.state.core.db.connection() as db:
            invocation = db.execute(
                "SELECT * FROM provider_invocations WHERE id=?", (invocation_id,)
            ).fetchone()
            assert invocation is not None
            stored = " ".join(str(value) for value in invocation)
            jobs = " ".join(str(value) for value in db.execute("SELECT * FROM jobs"))
        assert "SENTINEL_KEY" not in stored + jobs
    finally:
        client.__exit__(None, None, None)
