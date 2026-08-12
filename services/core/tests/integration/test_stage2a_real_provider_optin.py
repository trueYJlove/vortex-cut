"""Opt-in real Provider verification; skipped unless all AIVS_REAL_PROVIDER_* variables are set.

Run only in a controlled environment:
  $env:AIVS_RUN_REAL_PROVIDER_TESTS='1'
  $env:AIVS_REAL_PROVIDER_BASE_URL='https://.../v1'
  $env:AIVS_REAL_PROVIDER_MODEL='...'
  $env:AIVS_REAL_PROVIDER_API_KEY='...'
  $env:AIVS_REAL_PROVIDER_INPUT_PRICE_PER_MILLION='...'
  $env:AIVS_REAL_PROVIDER_OUTPUT_PRICE_PER_MILLION='...'
  uv run pytest services/core/tests/integration/test_stage2a_real_provider_optin.py \
    -m real_provider -q

The test deliberately never prints or persists the key, prompt, raw response, or preview payload.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.database import json_dumps
from aivs_core.providers import (
    OpenAICompatibleTextProvider,
    StructuredTextResult,
    normalized_base_url,
)

REQUIRED_ENV = (
    "AIVS_RUN_REAL_PROVIDER_TESTS",
    "AIVS_REAL_PROVIDER_BASE_URL",
    "AIVS_REAL_PROVIDER_MODEL",
    "AIVS_REAL_PROVIDER_API_KEY",
    "AIVS_REAL_PROVIDER_INPUT_PRICE_PER_MILLION",
    "AIVS_REAL_PROVIDER_OUTPUT_PRICE_PER_MILLION",
)


def _environment() -> dict[str, str]:
    values = {name: os.environ.get(name, "") for name in REQUIRED_ENV}
    if values["AIVS_RUN_REAL_PROVIDER_TESTS"] != "1" or any(
        not values[name] for name in REQUIRED_ENV[1:]
    ):
        pytest.skip("real Provider opt-in environment is not configured")
    try:
        float(values["AIVS_REAL_PROVIDER_INPUT_PRICE_PER_MILLION"])
        float(values["AIVS_REAL_PROVIDER_OUTPUT_PRICE_PER_MILLION"])
    except ValueError:
        pytest.skip("real Provider price environment is invalid")
    return values


class AuditedOpenAICompatibleProvider:
    """Checks the outgoing HTTP request without persisting its body or headers."""

    def __init__(self, forbidden: set[str]) -> None:
        self.audit = {"calls": 0, "endpoint": None, "schema": False, "safe": False}
        self.forbidden = forbidden
        self.delegate = OpenAICompatibleTextProvider(self._client_factory)

    def _client_factory(self, **kwargs):
        return _AuditedAsyncClient(kwargs, self.audit, self.forbidden)

    async def generate(self, request, cancel_event) -> StructuredTextResult:
        return await self.delegate.generate(request, cancel_event)


class _AuditedAsyncClient:
    def __init__(self, kwargs: dict[str, Any], audit: dict[str, Any], forbidden: set[str]) -> None:
        import httpx

        self.client = httpx.AsyncClient(**kwargs)
        self.audit, self.forbidden = audit, forbidden

    async def __aenter__(self):
        await self.client.__aenter__()
        return self

    async def __aexit__(self, *args):
        return await self.client.__aexit__(*args)

    def build_request(self, *args, **kwargs):
        request = self.client.build_request(*args, **kwargs)
        body = request.content.decode("utf-8")
        parsed = __import__("json").loads(body)
        assert request.method == "POST" and request.url.path.endswith("/chat/completions")
        assert "Authorization" in request.headers
        response_format = parsed["response_format"]
        assert response_format["type"] == "json_schema"
        assert response_format["json_schema"]["name"] == "candidate-plan-output-v1"
        assert response_format["json_schema"]["strict"] is True
        assert set(parsed) == {"model", "messages", "response_format"}
        for value in self.forbidden:
            assert value not in body
        self.audit.update(
            {
                "calls": self.audit["calls"] + 1,
                "endpoint": str(request.url),
                "schema": True,
                "safe": True,
            }
        )
        return request

    async def send(self, request, **kwargs):
        return await self.client.send(request, **kwargs)


def _wait(client: TestClient, ui: dict[str, str], job_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 105
    while time.monotonic() < deadline:
        job = client.get(f"/api/v1/jobs/{job_id}", headers=ui).json()
        if job["status"] in {"succeeded", "failed", "cancelled", "interrupted"}:
            return job
        time.sleep(0.1)
    raise AssertionError("real Provider candidate job did not finish")


@pytest.mark.real_provider
def test_real_openai_compatible_candidate_generation_is_bounded_and_safe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = _environment()
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "real-provider-test-admin")
    app = create_app(Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing")))
    full_transcript_sentinel = "DO_NOT_EGRESS_FULL_TRANSCRIPT_SENTINEL"
    audited_provider = AuditedOpenAICompatibleProvider(
        {
            "private-source.mp4",
            "audit-fingerprint",
            full_transcript_sentinel,
            env["AIVS_REAL_PROVIDER_API_KEY"],
        }
    )
    app.state.core.planning.provider_factory = lambda: audited_provider
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer real-provider-test-admin"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        project_id = client.post(
            "/api/v1/projects", headers=ui, json={"name": "real provider audit"}
        ).json()["project_id"]
        with app.state.core.db.connection() as db:
            db.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,availability,media_info_json,created_at,updated_at) "
                "VALUES ('asset-audit',?,'video','external','private-source.mp4',"
                "'audit-fingerprint',"
                "1,'available',?,'now','now')",
                (project_id, json_dumps({"duration_us": 1_230_000_000, "video_streams": [{}]})),
            )
            db.execute(
                "INSERT INTO transcripts VALUES "
                "('transcript-audit','asset-audit','ready','en','local','m','r','audit-fingerprint',"
                "1230000000,'now','now')"
            )
            db.execute(
                "INSERT INTO transcript_segments VALUES "
                "('seg-a','transcript-audit',0,0,10000000,'selected opening point',0.99),"
                "('seg-b','transcript-audit',1,10000000,20000000,'selected middle point',0.99),"
                "('seg-c','transcript-audit',2,20000000,30000000,'selected closing point',0.99),"
                "('seg-hidden','transcript-audit',3,30000000,1230000000,?,0.01)",
                (full_transcript_sentinel,),
            )
        brief = {
            "schema_version": 1,
            "topic": "selected",
            "audience": "controlled verification",
            "target_platform": "generic_vertical",
            "target_duration_us": 30_000_000,
            "narrative_goal": "opening middle closing",
            "style_notes": "",
            "must_keep": [],
            "forbidden": [],
            "original_audio_policy": "preserve",
            "caption_policy": "auto_from_transcript",
            "caption_preset_id": "default-bottom",
            "default_layout": "fit",
        }
        brief_response = client.put(
            f"/api/v1/projects/{project_id}/brief", headers=ui, json=brief
        )
        assert brief_response.status_code == 200
        provider = client.post(
            "/api/v1/providers",
            headers=ui,
            json={
                "kind": "openai_compatible_text",
                "display_name": "controlled external provider",
                "base_url": env["AIVS_REAL_PROVIDER_BASE_URL"],
                "model": env["AIVS_REAL_PROVIDER_MODEL"],
                "input_price_per_million": float(
                    env["AIVS_REAL_PROVIDER_INPUT_PRICE_PER_MILLION"]
                ),
                "output_price_per_million": float(
                    env["AIVS_REAL_PROVIDER_OUTPUT_PRICE_PER_MILLION"]
                ),
            },
        )
        assert provider.status_code == 200
        provider_id = provider.json()["provider_config_id"]
        assert client.put(
            f"/api/v1/internal/provider-secrets/{provider_id}",
            headers=admin,
            json={"secret": env["AIVS_REAL_PROVIDER_API_KEY"]},
        ).status_code == 200
        prepared = client.post(
            f"/api/v1/projects/{project_id}/candidate-generations/prepare",
            headers=ui,
            json={
                "provider_config_id": provider_id,
                "recipe_id": "balanced-narrative-v1",
                "transcript_ids": ["transcript-audit"],
            },
        )
        assert prepared.status_code == 200
        preview = prepared.json()
        created = client.post(
            f"/api/v1/projects/{project_id}/candidate-generations",
            headers=ui,
            json={
                "egress_preview_id": preview["egress_preview_id"],
                "payload_sha256": preview["payload_sha256"],
            },
        )
        assert created.status_code == 200
        job = _wait(client, ui, created.json()["job"]["job_id"])
        assert job["status"] == "succeeded", job["error"]
        endpoint = normalized_base_url(env["AIVS_REAL_PROVIDER_BASE_URL"])
        assert audited_provider.audit == {
            "calls": 1,
            "endpoint": f"{endpoint}/chat/completions",
            "schema": True,
            "safe": True,
        }
        assert {item["variant"] for item in client.get(
            f"/api/v1/projects/{project_id}/candidate-plans", headers=ui
        ).json()["items"]} == {"balanced", "compact", "bold"}
        with app.state.core.db.connection() as db:
            invocation = db.execute(
                "SELECT usage_json,estimated_cost,actual_cost,output_sha256,duration_ms "
                "FROM provider_invocations WHERE candidate_generation_id=?",
                (created.json()["candidate_generation_id"],),
            ).fetchone()
            persisted = " ".join(
                str(value)
                for table in ("provider_configs", "provider_invocations", "jobs")
                for row in db.execute(f"SELECT * FROM {table}")
                for value in row
            )
        assert invocation is not None
        assert invocation["usage_json"] is not None
        assert invocation["estimated_cost"] is not None
        assert invocation["actual_cost"] is None
        assert invocation["output_sha256"].startswith("sha256:")
        assert invocation["duration_ms"] is not None
        for forbidden in (env["AIVS_REAL_PROVIDER_API_KEY"], full_transcript_sentinel):
            assert forbidden not in persisted
        assert client.delete(
            f"/api/v1/internal/provider-secrets/{provider_id}", headers=admin
        ).status_code == 204
        rejected = client.post(f"/api/v1/providers/{provider_id}/test", headers=ui)
        assert rejected.status_code == 503
        assert rejected.json()["error"]["code"] == "PROVIDER_CREDENTIAL_MISSING"
        assert audited_provider.audit["calls"] == 1
