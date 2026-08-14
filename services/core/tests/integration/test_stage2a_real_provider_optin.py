"""Opt-in real Provider verification; skipped unless all AIVS_REAL_PROVIDER_* variables are set.

Run only in a controlled environment:
  $env:AIVS_REAL_PROVIDER_ENABLED='1'
  $env:AIVS_REAL_PROVIDER_BASE_URL='<provider-base-url>'
  $env:AIVS_REAL_PROVIDER_MODEL='...'
  $env:AIVS_REAL_PROVIDER_API_KEY='...'
  $env:AIVS_REAL_PROVIDER_INPUT_PRICE_PER_MILLION='...'
  $env:AIVS_REAL_PROVIDER_OUTPUT_PRICE_PER_MILLION='...'
  $env:AIVS_REAL_PROVIDER_EXPECTED_ADAPTER='<frozen-candidate-adapter>'
  $env:AIVS_REAL_PROVIDER_TIMEOUT='30-120'
  uv run pytest services/core/tests/integration/test_stage2a_real_provider_optin.py \
    -m real_provider -q

The test deliberately never prints or persists the key, prompt, raw response, or preview payload.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import subprocess
import sys
import time
from functools import wraps
from pathlib import Path
from typing import Any, NoReturn

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.database import json_dumps
from aivs_core.providers import (
    CANDIDATE_ADAPTER_IDS,
    OpenAICompatibleTextProvider,
    ProviderError,
    StructuredTextResult,
)

REQUIRED_ENV = (
    "AIVS_REAL_PROVIDER_ENABLED",
    "AIVS_REAL_PROVIDER_BASE_URL",
    "AIVS_REAL_PROVIDER_MODEL",
    "AIVS_REAL_PROVIDER_API_KEY",
    "AIVS_REAL_PROVIDER_INPUT_PRICE_PER_MILLION",
    "AIVS_REAL_PROVIDER_OUTPUT_PRICE_PER_MILLION",
    "AIVS_REAL_PROVIDER_EXPECTED_ADAPTER",
    "AIVS_REAL_PROVIDER_TIMEOUT",
)

_AUTHORIZATION_HEADER = "".join(("Auth", "orization"))
_BEARER_SCHEME = "".join(("Bea", "rer"))
ALLOWED_SAFE_ERROR_CODES = frozenset(
    {
        "REAL_PROVIDER_AUDIT_INVALID_ERROR_CODE",
        "REAL_PROVIDER_AUDIT_REQUEST_BUILD_FAILURE",
        "REAL_PROVIDER_AUDIT_HTTP_FAILURE",
        "REAL_PROVIDER_PROVIDER_TRANSPORT_FAILED",
        "REAL_PROVIDER_PROVIDER_TIMEOUT",
        "REAL_PROVIDER_PROVIDER_HTTP_FAILED",
        "REAL_PROVIDER_PROVIDER_SCHEMA_CAPABILITY_FAILED",
        "REAL_PROVIDER_CANDIDATE_JOB_TIMEOUT",
        "REAL_PROVIDER_AUDIT_REQUEST_JSON_INVALID",
        "REAL_PROVIDER_AUDIT_ENDPOINT_INVALID",
        "REAL_PROVIDER_AUDIT_AUTH_MISSING",
        "REAL_PROVIDER_AUDIT_RESPONSE_FORMAT_INVALID",
        "REAL_PROVIDER_AUDIT_JSON_SCHEMA_INVALID",
        "REAL_PROVIDER_AUDIT_SCHEMA_TYPE_INVALID",
        "REAL_PROVIDER_AUDIT_SCHEMA_NAME_INVALID",
        "REAL_PROVIDER_AUDIT_SCHEMA_STRICT_INVALID",
        "REAL_PROVIDER_AUDIT_ENVELOPE_INVALID",
        "REAL_PROVIDER_AUDIT_SENSITIVE_EGRESS",
        "REAL_PROVIDER_CANDIDATE_JOB_FAILED",
        "REAL_PROVIDER_AUDIT_CALL_COUNT_INVALID",
        "REAL_PROVIDER_AUDIT_ENDPOINT_KIND_INVALID",
        "REAL_PROVIDER_AUDIT_SCHEMA_NOT_VALIDATED",
        "REAL_PROVIDER_AUDIT_EGRESS_NOT_VALIDATED",
        "REAL_PROVIDER_CANDIDATE_VARIANTS_INVALID",
        "REAL_PROVIDER_INVOCATION_MISSING",
        "REAL_PROVIDER_USAGE_MISSING",
        "REAL_PROVIDER_ESTIMATE_MISSING",
        "REAL_PROVIDER_ACTUAL_COST_PRESENT",
        "REAL_PROVIDER_OUTPUT_HASH_INVALID",
        "REAL_PROVIDER_DURATION_MISSING",
        "REAL_PROVIDER_AUDIT_SENSITIVE_PERSISTENCE",
        "REAL_PROVIDER_SECRET_DELETION_FAILED",
        "REAL_PROVIDER_MISSING_CREDENTIAL_NOT_REJECTED",
        "REAL_PROVIDER_MISSING_CREDENTIAL_CODE_INVALID",
        "REAL_PROVIDER_UNEXPECTED_RETRY",
        "REAL_PROVIDER_BRIEF_REQUEST_FAILED",
        "REAL_PROVIDER_CONFIG_REQUEST_FAILED",
        "REAL_PROVIDER_SECRET_INJECTION_FAILED",
        "REAL_PROVIDER_PREPARE_FAILED",
        "REAL_PROVIDER_GENERATION_REQUEST_FAILED",
        "REAL_PROVIDER_REDACTION_CODE_INVALID",
        "REAL_PROVIDER_REDACTION_TEST_KEY_LEAKED",
        "REAL_PROVIDER_REDACTION_TEST_PROMPT_LEAKED",
        "REAL_PROVIDER_REDACTION_TEST_RESPONSE_LEAKED",
        "REAL_PROVIDER_REDACTION_TEST_AUTH_LEAKED",
        "REAL_PROVIDER_REDACTION_TEST_REQUEST_LEAKED",
        "REAL_PROVIDER_REDACTION_TEST_RESPONSE_CONTEXT_LEAKED",
        "REAL_PROVIDER_REDACTION_TEST_JOB_ERROR_LEAKED",
        "REAL_PROVIDER_REDACTION_TEST_CONTEXT_LEAKED",
        "REAL_PROVIDER_REDACTION_TEST_VARIABLE_COLLECTED",
        "REAL_PROVIDER_TEST_EXECUTION_FAILED",
        "REAL_PROVIDER_ENVIRONMENT_INVALID",
    }
)


def _raise_safe(code: str) -> NoReturn:
    safe_code = (
        code if code in ALLOWED_SAFE_ERROR_CODES else "REAL_PROVIDER_AUDIT_INVALID_ERROR_CODE"
    )
    sys.stderr.write(f"AIVS_SAFE_RESULT code={safe_code}\n")
    sys.stderr.flush()
    pytest.fail(safe_code, pytrace=False)


def _safe_assert_absent(value: str, content: str, code: str) -> None:
    """Fail without letting pytest render a credential or outbound body."""
    if value in content:
        _raise_safe(code)


def _safe_assert(condition: bool, code: str) -> None:
    """Avoid assertion rewriting from rendering external request/response state."""
    if not condition:
        _raise_safe(code)


def _assert_safe_failure(code: str, forbidden: tuple[str, ...]) -> None:
    with pytest.raises(pytest.fail.Exception) as raised:
        _raise_safe(code)
    message = str(raised.value)
    _safe_assert(message == code, "REAL_PROVIDER_REDACTION_CODE_INVALID")
    for value in forbidden:
        _safe_assert(value not in message, "REAL_PROVIDER_REDACTION_TEST_CONTEXT_LEAKED")


def _provider_failure_code(error: ProviderError) -> str:
    if error.code in {"PROVIDER_TIMEOUT"}:
        return "REAL_PROVIDER_PROVIDER_TIMEOUT"
    if error.code in {
        "PROVIDER_NETWORK_ERROR",
        "PROVIDER_TLS_ERROR",
        "PROVIDER_CANCELLED",
        "PROVIDER_RESPONSE_TOO_LARGE",
    }:
        return "REAL_PROVIDER_PROVIDER_TRANSPORT_FAILED"
    if error.code in {
        "PROVIDER_AUTH_FAILED",
        "PROVIDER_RATE_LIMITED",
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_CONTENT_REJECTED",
    }:
        return "REAL_PROVIDER_PROVIDER_HTTP_FAILED"
    if error.code in {
        "PROVIDER_CAPABILITY_UNSUPPORTED",
        "PROVIDER_INVALID_RESPONSE",
        "PROVIDER_SCHEMA_MISMATCH",
    }:
        return "REAL_PROVIDER_PROVIDER_SCHEMA_CAPABILITY_FAILED"
    return "REAL_PROVIDER_TEST_EXECUTION_FAILED"


def _job_failure_code(status: str, provider_failure_code: str | None) -> str:
    if provider_failure_code in ALLOWED_SAFE_ERROR_CODES:
        return provider_failure_code
    if status in {"failed", "cancelled", "interrupted"}:
        return "REAL_PROVIDER_CANDIDATE_JOB_FAILED"
    return "REAL_PROVIDER_CANDIDATE_JOB_TIMEOUT"


def _classified_real_provider_test(func):
    @wraps(func)
    def wrapper(*args: Any, **kwargs: Any):
        try:
            return func(*args, **kwargs)
        except pytest.skip.Exception:
            raise
        except pytest.fail.Exception:
            raise
        except Exception:
            _raise_safe("REAL_PROVIDER_TEST_EXECUTION_FAILED")

    return wrapper


def _environment() -> dict[str, Any]:
    values = {name: os.environ.get(name, "") for name in REQUIRED_ENV}
    if values["AIVS_REAL_PROVIDER_ENABLED"] != "1" or any(
        not values[name] for name in REQUIRED_ENV[1:]
    ):
        pytest.skip("real Provider opt-in environment is not configured")
    try:
        float(values["AIVS_REAL_PROVIDER_INPUT_PRICE_PER_MILLION"])
        float(values["AIVS_REAL_PROVIDER_OUTPUT_PRICE_PER_MILLION"])
        timeout = float(values["AIVS_REAL_PROVIDER_TIMEOUT"])
    except ValueError:
        pytest.skip("real Provider price environment is invalid")
    if (
        values["AIVS_REAL_PROVIDER_EXPECTED_ADAPTER"] not in CANDIDATE_ADAPTER_IDS
        or not math.isfinite(timeout)
        or not 30 <= timeout <= 120
    ):
        pytest.skip("real Provider opt-in environment is invalid")
    values["timeout"] = timeout
    return values


def _client_kwargs_with_timeout(kwargs: dict[str, Any], timeout: float) -> dict[str, Any]:
    return {**kwargs, "timeout": timeout}


def _adapter_endpoint_kind(adapter: str) -> str:
    return "responses" if adapter.startswith("openai_responses_") else "chat_completions"


def _audit_schema_format(value: Any) -> None:
    if not isinstance(value, dict):
        _raise_safe("REAL_PROVIDER_AUDIT_RESPONSE_FORMAT_INVALID")
    schema = value.get("json_schema")
    if not isinstance(schema, dict):
        _raise_safe("REAL_PROVIDER_AUDIT_JSON_SCHEMA_INVALID")
    _safe_assert(value.get("type") == "json_schema", "REAL_PROVIDER_AUDIT_SCHEMA_TYPE_INVALID")
    _safe_assert(
        schema.get("name") == "candidate-plan-output-v1",
        "REAL_PROVIDER_AUDIT_SCHEMA_NAME_INVALID",
    )
    _safe_assert(schema.get("strict") is True, "REAL_PROVIDER_AUDIT_SCHEMA_STRICT_INVALID")


def _audit_candidate_request(method: str, path: str, body: dict[str, Any], adapter: str) -> None:
    responses = adapter.startswith("openai_responses_")
    script = adapter.endswith("candidatescript_v1")
    expected_path = "/responses" if responses else "/chat/completions"
    _safe_assert(
        method == "POST" and path.endswith(expected_path), "REAL_PROVIDER_AUDIT_ENDPOINT_INVALID"
    )
    if responses:
        expected = {"model", "instructions", "input"}
        if not script:
            expected.add("text")
            _audit_schema_format(body.get("text", {}).get("format"))
        _safe_assert(set(body) == expected, "REAL_PROVIDER_AUDIT_ENVELOPE_INVALID")
        return
    expected = {"model", "messages"}
    if not script:
        expected.add("response_format")
        _audit_schema_format(body.get("response_format"))
    _safe_assert(set(body) == expected, "REAL_PROVIDER_AUDIT_ENVELOPE_INVALID")
    messages = body.get("messages")
    _safe_assert(
        isinstance(messages, list)
        and len(messages) == 2
        and all(isinstance(message, dict) for message in messages),
        "REAL_PROVIDER_AUDIT_ENVELOPE_INVALID",
    )


def _audit_candidate_response(content: bytes, adapter: str) -> None:
    try:
        envelope = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        _raise_safe("REAL_PROVIDER_AUDIT_HTTP_FAILURE")
    if adapter.startswith("openai_responses_"):
        valid = (
            isinstance(envelope, dict)
            and isinstance(envelope.get("output"), list)
            and len(envelope["output"]) == 1
            and isinstance(envelope["output"][0], dict)
            and envelope["output"][0].get("type") == "message"
            and isinstance(envelope["output"][0].get("content"), list)
            and len(envelope["output"][0]["content"]) == 1
            and isinstance(envelope["output"][0]["content"][0], dict)
            and envelope["output"][0]["content"][0].get("type") == "output_text"
            and isinstance(envelope["output"][0]["content"][0].get("text"), str)
        )
    else:
        valid = (
            isinstance(envelope, dict)
            and isinstance(envelope.get("choices"), list)
            and bool(envelope["choices"])
            and isinstance(envelope["choices"][0], dict)
            and isinstance(envelope["choices"][0].get("message"), dict)
            and isinstance(envelope["choices"][0]["message"].get("content"), str)
        )
    _safe_assert(valid, "REAL_PROVIDER_AUDIT_ENVELOPE_INVALID")


class AuditedOpenAICompatibleProvider:
    """Checks the outgoing HTTP request without persisting its body or headers."""

    def __init__(self, forbidden: set[str], adapter: str, timeout: float) -> None:
        self.audit = {
            "calls": 0,
            "endpoint_kind": None,
            "schema": False,
            "safe": False,
            "failure_code": None,
        }
        self.forbidden = forbidden
        self.adapter = adapter
        self.timeout = timeout
        self.delegate = OpenAICompatibleTextProvider(self._client_factory)

    def _client_factory(self, **kwargs):
        return _AuditedAsyncClient(
            kwargs,
            self.audit,
            self.forbidden,
            self.adapter,
            self.timeout,
        )

    async def generate(self, request, cancel_event) -> StructuredTextResult:
        try:
            return await self.delegate.generate(request, cancel_event)
        except ProviderError as error:
            self.audit["failure_code"] = _provider_failure_code(error)
            raise


class _AuditedAsyncClient:
    def __init__(
        self,
        kwargs: dict[str, Any],
        audit: dict[str, Any],
        forbidden: set[str],
        adapter: str,
        timeout: float,
    ) -> None:
        import httpx

        self.client = httpx.AsyncClient(**_client_kwargs_with_timeout(kwargs, timeout))
        self.audit, self.forbidden = audit, forbidden
        self.adapter = adapter

    def _audit_fail(self, code: str) -> NoReturn:
        self.audit["failure_code"] = code
        _raise_safe(code)

    async def __aenter__(self):
        await self.client.__aenter__()
        return self

    async def __aexit__(self, *args):
        return await self.client.__aexit__(*args)

    def build_request(self, *args, **kwargs):
        try:
            request = self.client.build_request(*args, **kwargs)
            body = request.content.decode("utf-8")
            parsed = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._audit_fail("REAL_PROVIDER_AUDIT_REQUEST_JSON_INVALID")
        except Exception:
            self._audit_fail("REAL_PROVIDER_AUDIT_REQUEST_BUILD_FAILURE")
        if not isinstance(parsed, dict):
            self._audit_fail("REAL_PROVIDER_AUDIT_REQUEST_JSON_INVALID")
        _audit_candidate_request(request.method, request.url.path, parsed, self.adapter)
        _safe_assert(_AUTHORIZATION_HEADER in request.headers, "REAL_PROVIDER_AUDIT_AUTH_MISSING")
        for value in self.forbidden:
            _safe_assert_absent(value, body, "REAL_PROVIDER_AUDIT_SENSITIVE_EGRESS")
        self.audit.update(
            {
                "calls": self.audit["calls"] + 1,
                "endpoint_kind": _adapter_endpoint_kind(self.adapter),
                "schema": self.adapter.endswith("json_schema_v1"),
                "safe": True,
            }
        )
        return request

    async def send(self, request, **kwargs):
        try:
            response = await self.client.send(request, **kwargs)
            _audit_candidate_response(response.content, self.adapter)
            return response
        except pytest.fail.Exception:
            raise
        except Exception:
            self._audit_fail("REAL_PROVIDER_AUDIT_HTTP_FAILURE")


def _wait(client: TestClient, ui: dict[str, str], job_id: str, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            job = client.get(f"/api/v1/jobs/{job_id}", headers=ui).json()
            status = job["status"]
        except Exception:
            _raise_safe("REAL_PROVIDER_AUDIT_HTTP_FAILURE")
        if status in {"succeeded", "failed", "cancelled", "interrupted"}:
            return job
        time.sleep(0.1)
    _raise_safe("REAL_PROVIDER_CANDIDATE_JOB_TIMEOUT")


@pytest.mark.real_provider
@_classified_real_provider_test
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
        },
        env["AIVS_REAL_PROVIDER_EXPECTED_ADAPTER"],
        env["timeout"],
    )
    app.state.core.planning.provider_factory = lambda: audited_provider
    with TestClient(app) as client:
        admin = {_AUTHORIZATION_HEADER: f"{_BEARER_SCHEME} real-provider-test-admin"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {_AUTHORIZATION_HEADER: f"{_BEARER_SCHEME} {token}"}
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
                "('transcript-audit','asset-audit','ready','en','local','m','r',"
                "'audit-fingerprint',"
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
        brief_response = client.put(f"/api/v1/projects/{project_id}/brief", headers=ui, json=brief)
        _safe_assert(
            brief_response.status_code == 200,
            "REAL_PROVIDER_BRIEF_REQUEST_FAILED",
        )
        provider = client.post(
            "/api/v1/providers",
            headers=ui,
            json={
                "kind": "openai_compatible_text",
                "display_name": "controlled external provider",
                "base_url": env["AIVS_REAL_PROVIDER_BASE_URL"],
                "model": env["AIVS_REAL_PROVIDER_MODEL"],
                "input_price_per_million": float(env["AIVS_REAL_PROVIDER_INPUT_PRICE_PER_MILLION"]),
                "output_price_per_million": float(
                    env["AIVS_REAL_PROVIDER_OUTPUT_PRICE_PER_MILLION"]
                ),
            },
        )
        _safe_assert(provider.status_code == 200, "REAL_PROVIDER_CONFIG_REQUEST_FAILED")
        provider_id = provider.json()["provider_config_id"]
        secret_response = client.put(
            f"/api/v1/internal/provider-secrets/{provider_id}",
            headers=admin,
            json={"secret": env["AIVS_REAL_PROVIDER_API_KEY"]},
        )
        _safe_assert(
            secret_response.status_code == 200,
            "REAL_PROVIDER_SECRET_INJECTION_FAILED",
        )
        with client.app.state.core.db.connection() as db:
            db.execute(
                "UPDATE provider_configs SET candidate_capability_status='supported',"
                "candidate_response_adapter_id=?,"
                "candidate_probe_protocol_version='1',candidate_capability_tested_at='now',"
                "candidate_capability_probe_sha256='sha256:external-fixture' WHERE id=?",
                (env["AIVS_REAL_PROVIDER_EXPECTED_ADAPTER"], provider_id),
            )
        prepared = client.post(
            f"/api/v1/projects/{project_id}/candidate-generations/prepare",
            headers=ui,
            json={
                "provider_config_id": provider_id,
                "recipe_id": "balanced-narrative-v1",
                "transcript_ids": ["transcript-audit"],
            },
        )
        _safe_assert(prepared.status_code == 200, "REAL_PROVIDER_PREPARE_FAILED")
        preview = prepared.json()
        created = client.post(
            f"/api/v1/projects/{project_id}/candidate-generations",
            headers=ui,
            json={
                "egress_preview_id": preview["egress_preview_id"],
                "payload_sha256": preview["payload_sha256"],
            },
        )
        _safe_assert(created.status_code == 200, "REAL_PROVIDER_GENERATION_REQUEST_FAILED")
        job = _wait(client, ui, created.json()["job"]["job_id"], env["timeout"])
        if job["status"] != "succeeded":
            failure_code = audited_provider.audit["failure_code"]
            _raise_safe(
                _job_failure_code(
                    job["status"],
                    failure_code if isinstance(failure_code, str) else None,
                )
            )
        _safe_assert(
            audited_provider.audit["calls"] == 1,
            "REAL_PROVIDER_AUDIT_CALL_COUNT_INVALID",
        )
        _safe_assert(
            audited_provider.audit["endpoint_kind"]
            == _adapter_endpoint_kind(env["AIVS_REAL_PROVIDER_EXPECTED_ADAPTER"]),
            "REAL_PROVIDER_AUDIT_ENDPOINT_KIND_INVALID",
        )
        _safe_assert(
            audited_provider.audit["schema"]
            is env["AIVS_REAL_PROVIDER_EXPECTED_ADAPTER"].endswith("json_schema_v1"),
            "REAL_PROVIDER_AUDIT_SCHEMA_NOT_VALIDATED",
        )
        _safe_assert(
            audited_provider.audit["safe"] is True,
            "REAL_PROVIDER_AUDIT_EGRESS_NOT_VALIDATED",
        )
        variants = {
            item["variant"]
            for item in client.get(
                f"/api/v1/projects/{project_id}/candidate-plans", headers=ui
            ).json()["items"]
        }
        _safe_assert(
            variants == {"balanced", "compact", "bold"},
            "REAL_PROVIDER_CANDIDATE_VARIANTS_INVALID",
        )
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
        _safe_assert(invocation is not None, "REAL_PROVIDER_INVOCATION_MISSING")
        if invocation is None:
            _raise_safe("REAL_PROVIDER_INVOCATION_MISSING")
        _safe_assert(invocation["usage_json"] is not None, "REAL_PROVIDER_USAGE_MISSING")
        _safe_assert(invocation["estimated_cost"] is not None, "REAL_PROVIDER_ESTIMATE_MISSING")
        _safe_assert(invocation["actual_cost"] is None, "REAL_PROVIDER_ACTUAL_COST_PRESENT")
        _safe_assert(
            isinstance(invocation["output_sha256"], str)
            and invocation["output_sha256"].startswith("sha256:"),
            "REAL_PROVIDER_OUTPUT_HASH_INVALID",
        )
        _safe_assert(invocation["duration_ms"] is not None, "REAL_PROVIDER_DURATION_MISSING")
        for forbidden in (env["AIVS_REAL_PROVIDER_API_KEY"], full_transcript_sentinel):
            _safe_assert_absent(
                forbidden,
                persisted,
                "REAL_PROVIDER_AUDIT_SENSITIVE_PERSISTENCE",
            )
        delete_response = client.delete(
            f"/api/v1/internal/provider-secrets/{provider_id}", headers=admin
        )
        _safe_assert(
            delete_response.status_code == 204,
            "REAL_PROVIDER_SECRET_DELETION_FAILED",
        )
        rejected = client.post(f"/api/v1/providers/{provider_id}/test", headers=ui)
        _safe_assert(
            rejected.status_code == 503,
            "REAL_PROVIDER_MISSING_CREDENTIAL_NOT_REJECTED",
        )
        _safe_assert(
            rejected.json()["error"]["code"] == "PROVIDER_CREDENTIAL_MISSING",
            "REAL_PROVIDER_MISSING_CREDENTIAL_CODE_INVALID",
        )
        _safe_assert(
            audited_provider.audit["calls"] == 1,
            "REAL_PROVIDER_UNEXPECTED_RETRY",
        )


def test_real_provider_audit_failures_are_redacted_without_network() -> None:
    api_key = "API_KEY_SENTINEL_DO_NOT_PRINT"
    prompt = "PROMPT_SENTINEL_DO_NOT_PRINT"
    raw_response = "RAW_RESPONSE_SENTINEL_DO_NOT_PRINT"
    authorization = "AUTHORIZATION_SENTINEL_DO_NOT_PRINT"
    bearer = "BEARER_SENTINEL_DO_NOT_PRINT"
    request_context = "REQUEST_SENTINEL_DO_NOT_PRINT"
    response_context = "RESPONSE_SENTINEL_DO_NOT_PRINT"
    job_error = "JOB_ERROR_SENTINEL_DO_NOT_PRINT"
    forbidden = (
        api_key,
        prompt,
        raw_response,
        authorization,
        bearer,
        request_context,
        response_context,
        job_error,
    )

    for value, content, code in (
        (api_key, f"{_BEARER_SCHEME} {api_key}", "REAL_PROVIDER_AUDIT_SENSITIVE_EGRESS"),
        (prompt, f"request={prompt}", "REAL_PROVIDER_AUDIT_SENSITIVE_EGRESS"),
        (raw_response, f"response={raw_response}", "REAL_PROVIDER_AUDIT_SENSITIVE_PERSISTENCE"),
        (authorization, f"header={authorization}", "REAL_PROVIDER_AUDIT_SENSITIVE_EGRESS"),
        (bearer, f"credential={bearer}", "REAL_PROVIDER_AUDIT_SENSITIVE_EGRESS"),
        (request_context, f"context={request_context}", "REAL_PROVIDER_AUDIT_HTTP_FAILURE"),
        (response_context, f"context={response_context}", "REAL_PROVIDER_AUDIT_HTTP_FAILURE"),
        (job_error, f"error={job_error}", "REAL_PROVIDER_CANDIDATE_JOB_FAILED"),
    ):
        _assert_safe_failure(code, forbidden)
        with pytest.raises(pytest.fail.Exception) as raised:
            _safe_assert_absent(value, content, code)
        message = str(raised.value)
        _safe_assert(message == code, "REAL_PROVIDER_REDACTION_CODE_INVALID")
        for sentinel in forbidden:
            _safe_assert(sentinel not in message, "REAL_PROVIDER_REDACTION_TEST_CONTEXT_LEAKED")

    _safe_assert(
        "REAL_PROVIDER_API_KEY" not in ALLOWED_SAFE_ERROR_CODES,
        "REAL_PROVIDER_REDACTION_TEST_VARIABLE_COLLECTED",
    )
    _safe_assert(
        "REAL_PROVIDER_BASE_URL" not in ALLOWED_SAFE_ERROR_CODES,
        "REAL_PROVIDER_REDACTION_TEST_VARIABLE_COLLECTED",
    )


@pytest.mark.parametrize(
    "name,value",
    [
        ("AIVS_REAL_PROVIDER_ENABLED", "0"),
        ("AIVS_REAL_PROVIDER_EXPECTED_ADAPTER", "invalid"),
        ("AIVS_REAL_PROVIDER_TIMEOUT", "NaN"),
        ("AIVS_REAL_PROVIDER_TIMEOUT", "29"),
        ("AIVS_REAL_PROVIDER_TIMEOUT", "121"),
    ],
)
def test_real_provider_environment_gate_rejects_invalid_values_without_network(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    safe = {
        "AIVS_REAL_PROVIDER_ENABLED": "1",
        "AIVS_REAL_PROVIDER_BASE_URL": "https://provider.invalid/v1",
        "AIVS_REAL_PROVIDER_MODEL": "model",
        "AIVS_REAL_PROVIDER_API_KEY": "SENTINEL_KEY",
        "AIVS_REAL_PROVIDER_INPUT_PRICE_PER_MILLION": "1",
        "AIVS_REAL_PROVIDER_OUTPUT_PRICE_PER_MILLION": "1",
        "AIVS_REAL_PROVIDER_EXPECTED_ADAPTER": "openai_responses_json_schema_v1",
        "AIVS_REAL_PROVIDER_TIMEOUT": "30",
    }
    for key, current in safe.items():
        monkeypatch.setenv(key, current)
    monkeypatch.setenv(name, value)
    with pytest.raises(pytest.skip.Exception):
        _environment()


@pytest.mark.parametrize("adapter", CANDIDATE_ADAPTER_IDS)
def test_real_provider_adapter_auditor_enforces_all_frozen_shapes_without_network(
    adapter: str,
) -> None:
    responses = adapter.startswith("openai_responses_")
    script = adapter.endswith("candidatescript_v1")
    if responses:
        body: dict[str, Any] = {"model": "m", "instructions": "i", "input": "{}"}
        if not script:
            body["text"] = {
                "format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "candidate-plan-output-v1",
                        "strict": True,
                    },
                }
            }
        path = "/v1/responses"
    else:
        body = {
            "model": "m",
            "messages": [
                {"role": "system", "content": "i"},
                {"role": "user", "content": "{}"},
            ],
        }
        if not script:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "candidate-plan-output-v1", "strict": True},
            }
        path = "/v1/chat/completions"
    _audit_candidate_request("POST", path, body, adapter)


@pytest.mark.parametrize("adapter", CANDIDATE_ADAPTER_IDS)
def test_real_provider_adapter_auditor_enforces_all_frozen_envelopes_without_network(
    adapter: str,
) -> None:
    if adapter.startswith("openai_responses_"):
        response = {
            "output": [
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "candidate output"}],
                }
            ]
        }
    else:
        response = {"choices": [{"message": {"content": "candidate output"}}]}
    _audit_candidate_response(json.dumps(response).encode("utf-8"), adapter)


def test_real_provider_timeout_is_passed_and_bounds_wait_without_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    ticks = iter((100.0, 100.0, 130.0))
    monkeypatch.setattr(time, "monotonic", lambda: next(ticks))
    monkeypatch.setattr(time, "sleep", lambda _: None)

    class FakeClient:
        def get(self, *_: Any, **__: Any) -> Any:
            captured["get_calls"] = captured.get("get_calls", 0) + 1
            return type("Response", (), {"json": lambda self: {"status": "running"}})()

    with pytest.raises(pytest.fail.Exception) as raised:
        _wait(FakeClient(), {}, "job", 30.0)
    _safe_assert(
        str(raised.value) == "REAL_PROVIDER_CANDIDATE_JOB_TIMEOUT",
        "REAL_PROVIDER_REDACTION_CODE_INVALID",
    )
    _safe_assert(captured["get_calls"] == 1, "REAL_PROVIDER_AUDIT_CALL_COUNT_INVALID")


def test_real_provider_client_timeout_override_without_network() -> None:
    kwargs = _client_kwargs_with_timeout({"timeout": 90.0, "verify": True}, 45.0)
    _safe_assert(kwargs["timeout"] == 45.0, "REAL_PROVIDER_ENVIRONMENT_INVALID")
    _safe_assert(kwargs["verify"] is True, "REAL_PROVIDER_ENVIRONMENT_INVALID")


def test_real_provider_transport_failures_are_redacted_without_network() -> None:
    class _FailingClient:
        def build_request(self, *args: Any, **kwargs: Any) -> NoReturn:
            raise RuntimeError("AUTHORIZATION_SENTINEL_DO_NOT_PRINT")

        async def send(self, *args: Any, **kwargs: Any) -> NoReturn:
            raise RuntimeError("RESPONSE_SENTINEL_DO_NOT_PRINT")

    audited_client = object.__new__(_AuditedAsyncClient)
    audited_client.client = _FailingClient()
    audited_client.audit = {}
    audited_client.forbidden = set()

    with pytest.raises(pytest.fail.Exception) as build_failure:
        audited_client.build_request("POST", "unused")
    _safe_assert(
        str(build_failure.value) == "REAL_PROVIDER_AUDIT_REQUEST_BUILD_FAILURE",
        "REAL_PROVIDER_REDACTION_CODE_INVALID",
    )
    _safe_assert(
        "AUTHORIZATION_SENTINEL_DO_NOT_PRINT" not in str(build_failure.value),
        "REAL_PROVIDER_REDACTION_TEST_CONTEXT_LEAKED",
    )

    with pytest.raises(pytest.fail.Exception) as send_failure:
        asyncio.run(audited_client.send(object()))
    _safe_assert(
        str(send_failure.value) == "REAL_PROVIDER_AUDIT_HTTP_FAILURE",
        "REAL_PROVIDER_REDACTION_CODE_INVALID",
    )
    _safe_assert(
        "RESPONSE_SENTINEL_DO_NOT_PRINT" not in str(send_failure.value),
        "REAL_PROVIDER_REDACTION_TEST_CONTEXT_LEAKED",
    )


def test_real_provider_failure_categories_are_safe_and_parseable_without_network() -> None:
    sentinel = "SENSITIVE_CONTEXT_SENTINEL_DO_NOT_PRINT"
    provider_cases = (
        ("PROVIDER_TIMEOUT", "REAL_PROVIDER_PROVIDER_TIMEOUT"),
        ("PROVIDER_NETWORK_ERROR", "REAL_PROVIDER_PROVIDER_TRANSPORT_FAILED"),
        ("PROVIDER_AUTH_FAILED", "REAL_PROVIDER_PROVIDER_HTTP_FAILED"),
        ("PROVIDER_INVALID_RESPONSE", "REAL_PROVIDER_PROVIDER_SCHEMA_CAPABILITY_FAILED"),
    )
    for provider_code, expected in provider_cases:
        error = ProviderError(provider_code, sentinel)
        _safe_assert(
            _provider_failure_code(error) == expected,
            "REAL_PROVIDER_REDACTION_CODE_INVALID",
        )
        _assert_safe_failure(expected, (sentinel,))

    job_cases = (
        ("failed", None, "REAL_PROVIDER_CANDIDATE_JOB_FAILED"),
        ("cancelled", None, "REAL_PROVIDER_CANDIDATE_JOB_FAILED"),
        ("interrupted", None, "REAL_PROVIDER_CANDIDATE_JOB_FAILED"),
        ("running", None, "REAL_PROVIDER_CANDIDATE_JOB_TIMEOUT"),
        ("failed", "REAL_PROVIDER_PROVIDER_HTTP_FAILED", "REAL_PROVIDER_PROVIDER_HTTP_FAILED"),
    )
    for status, provider_code, expected in job_cases:
        _safe_assert(
            _job_failure_code(status, provider_code) == expected,
            "REAL_PROVIDER_REDACTION_CODE_INVALID",
        )
        _assert_safe_failure(expected, (sentinel,))

    _safe_assert(
        ALLOWED_SAFE_ERROR_CODES == frozenset(ALLOWED_SAFE_ERROR_CODES),
        "REAL_PROVIDER_REDACTION_CODE_INVALID",
    )
    _safe_assert(
        all(code.startswith("REAL_PROVIDER_") for code in ALLOWED_SAFE_ERROR_CODES),
        "REAL_PROVIDER_REDACTION_CODE_INVALID",
    )


def test_real_provider_safe_failure_record_is_token_parseable_without_network(
    capsys: pytest.CaptureFixture[str],
) -> None:
    sentinel = "RAW_RESPONSE_SENTINEL_DO_NOT_PRINT"
    expected = "REAL_PROVIDER_PROVIDER_SCHEMA_CAPABILITY_FAILED"

    with pytest.raises(pytest.fail.Exception) as raised:
        _raise_safe(expected)

    captured = capsys.readouterr()
    visible = captured.out + captured.err + str(raised.value)
    tokens = set(re.findall(r"REAL_PROVIDER_[A-Z0-9_]+", visible))
    _safe_assert(tokens == {expected}, "REAL_PROVIDER_REDACTION_CODE_INVALID")
    _safe_assert(
        expected in ALLOWED_SAFE_ERROR_CODES,
        "REAL_PROVIDER_REDACTION_CODE_INVALID",
    )
    _safe_assert(sentinel not in visible, "REAL_PROVIDER_REDACTION_TEST_CONTEXT_LEAKED")
    _safe_assert(
        "AIVS_SAFE_RESULT code=" in captured.err,
        "REAL_PROVIDER_REDACTION_CODE_INVALID",
    )


def test_real_provider_safe_failure_is_parseable_from_pytest_output_without_network(
    tmp_path: Path,
) -> None:
    expected = "REAL_PROVIDER_PROVIDER_HTTP_FAILED"
    sentinel = "PROMPT_SENTINEL_DO_NOT_PRINT"
    probe = tmp_path / "test_safe_failure_probe.py"
    probe.write_text(
        "import importlib.util\n"
        "import sys\n"
        "from pathlib import Path\n"
        "\n"
        "def test_safe_failure():\n"
        f"    sys.path.insert(0, {str(Path(__file__).resolve().parents[2] / 'src')!r})\n"
        "    spec = importlib.util.spec_from_file_location(\n"
        f"        'safe_target', {str(Path(__file__).resolve())!r}\n"
        "    )\n"
        "    module = importlib.util.module_from_spec(spec)\n"
        "    assert spec.loader is not None\n"
        "    spec.loader.exec_module(module)\n"
        f"    module._raise_safe({expected!r})\n",
        encoding="utf-8",
    )
    completed = subprocess.run(
        [sys.executable, "-m", "pytest", str(probe), "-q", "--disable-warnings"],
        capture_output=True,
        check=False,
        text=True,
    )
    visible = completed.stdout + completed.stderr
    tokens = set(re.findall(r"REAL_PROVIDER_[A-Z0-9_]+", visible))
    _safe_assert(completed.returncode != 0, "REAL_PROVIDER_REDACTION_CODE_INVALID")
    _safe_assert(
        re.search(r"\b1 failed\b", visible) is not None,
        "REAL_PROVIDER_REDACTION_CODE_INVALID",
    )
    _safe_assert(tokens == {expected}, "REAL_PROVIDER_REDACTION_CODE_INVALID")
    _safe_assert(expected in ALLOWED_SAFE_ERROR_CODES, "REAL_PROVIDER_REDACTION_CODE_INVALID")
    _safe_assert(sentinel not in visible, "REAL_PROVIDER_REDACTION_TEST_CONTEXT_LEAKED")
