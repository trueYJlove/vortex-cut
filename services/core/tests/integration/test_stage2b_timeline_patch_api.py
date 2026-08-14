from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.database import json_dumps, json_loads
from aivs_core.planning import ProviderRepository
from aivs_core.providers import ProviderSecretVault, StructuredTextResult
from aivs_core.timeline import TimelineService
from aivs_core.timeline_planning import TimelinePatchPlanningService


class PatchProvider:
    def __init__(self) -> None:
        self.requests: list[object] = []
        self.forbidden = False

    async def generate(self, request, cancel_event: asyncio.Event) -> StructuredTextResult:
        self.requests.append(request)
        assert request.output_schema == "timeline-patch-output-v1"
        if request.capability == "timeline_patch_capability_probe":
            return StructuredTextResult(
                {
                    "summary": "synthetic probe",
                    "operations": [
                        {"op": "set_layout", "clip_id": "probe_clip_001", "layout": "fit"}
                    ],
                },
                None,
                "probe",
                "sha256:" + "a" * 64,
            )
        assert request.capability == "timeline_patch_planning"
        if self.forbidden:
            return StructuredTextResult(
                {
                    "summary": "非法解锁",
                    "operations": [
                        {
                            "op": "set_clip_locked",
                            "clip_id": request.payload["timeline"]["clips"][0]["clip_id"],
                            "locked": False,
                        }
                    ],
                },
                None,
                "request-forbidden",
            )
        return StructuredTextResult(
            {
                "summary": "调整布局",
                "operations": [
                    {
                        "op": "set_layout",
                        "clip_id": request.payload["timeline"]["clips"][0]["clip_id"],
                        "layout": "fit",
                    }
                ],
            },
            {"prompt_tokens": 5, "completion_tokens": 3},
            "request-2b",
        )


class CancelProvider:
    async def generate(self, request, cancel_event: asyncio.Event) -> StructuredTextResult:
        raise asyncio.CancelledError


class CapabilityProvider:
    def __init__(self, value: dict | None = None) -> None:
        self.requests: list[object] = []
        self.value = value or {
            "summary": "synthetic probe",
            "operations": [
                {"op": "set_layout", "clip_id": "probe_clip_001", "layout": "fit"}
            ],
        }

    async def generate(self, request, cancel_event: asyncio.Event) -> StructuredTextResult:
        self.requests.append(request)
        assert request.capability == "timeline_patch_capability_probe"
        assert "instruction" not in request.payload
        assert "timeline" not in request.payload
        return StructuredTextResult(
            self.value,
            {"prompt_tokens": 1},
            "probe-request",
            "sha256:" + "b" * 64,
        )


class OrderedCapabilityProvider:
    def __init__(self, succeed_at: str | None) -> None:
        self.requests: list[object] = []
        self.succeed_at = succeed_at

    async def generate(self, request, cancel_event: asyncio.Event) -> StructuredTextResult:
        self.requests.append(request)
        if request.response_adapter_id != self.succeed_at:
            from aivs_core.providers import ProviderError

            raise ProviderError("PROVIDER_INVALID_RESPONSE", "probe rejected")
        return StructuredTextResult(
            {
                "summary": "synthetic probe",
                "operations": [
                    {"op": "set_layout", "clip_id": "probe_clip_001", "layout": "fit"}
                ],
            },
            None,
            "probe-request",
            "sha256:probe-success",
        )


class CapturingJobs:
    def __init__(self) -> None:
        self.args: tuple[str, str, str, str] | None = None

    def create_timeline_patch_generation(
        self, project_id: str, generation_id: str, invocation_id: str, payload_sha256: str
    ) -> dict[str, str]:
        self.args = (project_id, generation_id, invocation_id, payload_sha256)
        return {"job_id": "not-queued", "status": "queued"}


def test_capability_probe_uses_fixed_order_stops_on_first_success_and_aggregates_failures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-probe-order")
    app = create_app(Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing")))
    provider = OrderedCapabilityProvider("openai_chat_completions_json_schema_v1")
    app.state.core.timeline_patch_planning.provider_factory = lambda: provider
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer admin-probe-order"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        provider_id = client.post(
            "/api/v1/providers",
            headers=ui,
            json={
                "kind": "openai_compatible_text",
                "display_name": "local",
                "base_url": "http://127.0.0.1:9999/v1",
                "model": "mock",
            },
        ).json()["provider_config_id"]
        client.put(
            f"/api/v1/internal/provider-secrets/{provider_id}",
            headers=admin,
            json={"secret": "key"},
        )
        result = client.post(
            f"/api/v1/providers/{provider_id}/timeline-patch-capability-test",
            headers=ui,
        ).json()
    assert [request.response_adapter_id for request in provider.requests] == [
        "openai_responses_json_schema_v1",
        "openai_responses_patchscript_v1",
        "openai_chat_completions_json_schema_v1",
    ]
    assert result["timeline_patch_response_adapter_id"] == "openai_chat_completions_json_schema_v1"
    assert result["timeline_patch_probe_protocol_version"] == "1"


def test_capability_probe_all_failures_clear_adapter_and_protocol(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-probe-failure")
    app = create_app(Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing")))
    provider = OrderedCapabilityProvider(None)
    app.state.core.timeline_patch_planning.provider_factory = lambda: provider
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer admin-probe-failure"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        provider_id = client.post(
            "/api/v1/providers",
            headers=ui,
            json={
                "kind": "openai_compatible_text",
                "display_name": "local",
                "base_url": "http://127.0.0.1:9999/v1",
                "model": "mock",
            },
        ).json()["provider_config_id"]
        client.put(
            f"/api/v1/internal/provider-secrets/{provider_id}",
            headers=admin,
            json={"secret": "key"},
        )
        result = client.post(
            f"/api/v1/providers/{provider_id}/timeline-patch-capability-test",
            headers=ui,
        ).json()
    assert len(provider.requests) == 4
    assert result["timeline_patch_capability_status"] == "unsupported"
    assert result["timeline_patch_response_adapter_id"] is None
    assert result["timeline_patch_probe_protocol_version"] is None
    assert result["timeline_patch_capability_probe_sha256"].startswith("sha256:")


def test_capability_probe_aggregate_hash_is_deterministic_and_does_not_expose_probe_body(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-probe-digest")
    app = create_app(Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing")))
    provider = OrderedCapabilityProvider(None)
    app.state.core.timeline_patch_planning.provider_factory = lambda: provider
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer admin-probe-digest"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        provider_id = client.post(
            "/api/v1/providers",
            headers=ui,
            json={
                "kind": "openai_compatible_text",
                "display_name": "local",
                "base_url": "http://127.0.0.1:9999/v1",
                "model": "mock",
            },
        ).json()["provider_config_id"]
        client.put(
            f"/api/v1/internal/provider-secrets/{provider_id}",
            headers=admin,
            json={"secret": "key"},
        )
        first = client.post(
            f"/api/v1/providers/{provider_id}/timeline-patch-capability-test",
            headers=ui,
        ).json()
        second = client.post(
            f"/api/v1/providers/{provider_id}/timeline-patch-capability-test",
            headers=ui,
        ).json()
    assert first["timeline_patch_capability_probe_sha256"] == second[
        "timeline_patch_capability_probe_sha256"
    ]
    serialized = json_dumps(first)
    assert "probe rejected" not in serialized and "nonce" not in serialized


def _wait(client: TestClient, headers: dict[str, str], job_id: str) -> dict:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        job = client.get(f"/api/v1/jobs/{job_id}", headers=headers).json()
        if job["status"] in {"succeeded", "failed", "cancelled"}:
            return job
        time.sleep(0.05)
    raise AssertionError("job timeout")


def test_capability_probe_is_explicit_data_free_and_gates_prepare(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-capability")
    app = create_app(Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing")))
    provider = CapabilityProvider()
    app.state.core.timeline_patch_planning.provider_factory = lambda: provider
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer admin-capability"}
        ui_token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {ui_token}"}
        project_id = client.post("/api/v1/projects", headers=ui, json={"name": "P"}).json()[
            "project_id"
        ]
        with app.state.core.db.connection() as db:
            db.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,"
                "fingerprint,size_bytes,availability,media_info_json,created_at,updated_at) "
                "VALUES ('a1',?,'video','external','private.mp4','private-fp',1,"
                "'available',?,'now','now')",
                (project_id, json_dumps({"duration_us": 5_000_000, "video_streams": [{}]})),
            )
        base = client.post(
            f"/api/v1/projects/{project_id}/timelines",
            headers=ui,
            json={
                "schema_version": 1,
                "source": {"kind": "full_asset", "asset_id": "a1"},
                "default_layout": "crop_fill",
                "caption_preset_id": "default-bottom",
            },
        ).json()["current_revision"]
        provider_id = client.post(
            "/api/v1/providers",
            headers=ui,
            json={
                "kind": "openai_compatible_text",
                "display_name": "local",
                "base_url": "http://127.0.0.1:9999/v1",
                "model": "mock",
            },
        ).json()["provider_config_id"]
        assert client.put(
            f"/api/v1/internal/provider-secrets/{provider_id}",
            headers=admin,
            json={"secret": "SENTINEL_CAPABILITY_KEY"},
        ).status_code == 200
        blocked = client.post(
            f"/api/v1/projects/{project_id}/timeline-patch-generations/prepare",
            headers=ui,
            json={
                "base_revision_id": base["timeline_revision_id"],
                "provider_config_id": provider_id,
                "instruction": "private instruction",
            },
        )
        assert blocked.status_code == 409
        assert blocked.json()["error"]["code"] == "TIMELINE_PATCH_PROVIDER_UNTESTED"
        tested = client.post(
            f"/api/v1/providers/{provider_id}/timeline-patch-capability-test", headers=ui
        )
        assert tested.status_code == 200
        assert tested.json() == {
            "timeline_patch_capability_status": "supported",
            "timeline_patch_response_adapter_id": "openai_responses_json_schema_v1",
            "timeline_patch_probe_protocol_version": "1",
            "timeline_patch_capability_tested_at": tested.json()[
                "timeline_patch_capability_tested_at"
            ],
            "timeline_patch_capability_failure_code": None,
            "timeline_patch_capability_probe_sha256": tested.json()[
                "timeline_patch_capability_probe_sha256"
            ],
        }
        listed = client.get("/api/v1/providers", headers=ui).json()["items"][0]
        assert listed["timeline_patch_capability_status"] == "supported"
        probe_hash = listed["timeline_patch_capability_probe_sha256"]
        assert probe_hash.startswith("sha256:") and len(probe_hash) == 71
        assert "SENTINEL_CAPABILITY_KEY" not in client.get("/api/v1/providers", headers=ui).text
        with app.state.core.db.connection() as db:
            dump = "\n".join(
                repr(tuple(row)) for row in db.execute("SELECT * FROM provider_configs")
            )
        assert "SENTINEL_CAPABILITY_KEY" not in dump
        assert "private instruction" not in dump
        assert not any("private" in str(request.payload) for request in provider.requests)
        assert client.patch(
            f"/api/v1/providers/{provider_id}", headers=ui, json={"model": "changed"}
        ).status_code == 200
        assert client.get("/api/v1/providers", headers=ui).json()["items"][0][
            "timeline_patch_capability_status"
        ] == "untested"


def test_capability_probe_invalid_output_records_unsupported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-unsupported")
    app = create_app(Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing")))
    app.state.core.timeline_patch_planning.provider_factory = lambda: CapabilityProvider(
        {"summary": "bad", "operations": []}
    )
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer admin-unsupported"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        provider_id = client.post(
            "/api/v1/providers",
            headers=ui,
            json={
                "kind": "openai_compatible_text",
                "display_name": "local",
                "base_url": "http://127.0.0.1:9999",
                "model": "mock",
            },
        ).json()["provider_config_id"]
        client.put(
            f"/api/v1/internal/provider-secrets/{provider_id}",
            headers=admin,
            json={"secret": "key"},
        )
        result = client.post(
            f"/api/v1/providers/{provider_id}/timeline-patch-capability-test",
            headers=ui,
        )
        assert result.status_code == 200
        assert result.json()["timeline_patch_capability_status"] == "unsupported"
        assert (
            result.json()["timeline_patch_capability_failure_code"]
            == "PROVIDER_CAPABILITY_UNSUPPORTED"
        )


def test_prepare_generate_propose_apply_and_sensitive_boundaries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-2b")
    app = create_app(Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing")))
    provider = PatchProvider()
    app.state.core.timeline_patch_planning.provider_factory = lambda: provider
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer admin-2b"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        project_id = client.post("/api/v1/projects", headers=ui, json={"name": "Stage2B"}).json()[
            "project_id"
        ]
        with app.state.core.db.connection() as db:
            db.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,availability,media_info_json,created_at,updated_at) VALUES ('a1',?,'video','external','SENSITIVE_NAME.mp4','SENSITIVE_FP',1,'available',?,'now','now')",  # noqa: E501
                (project_id, json_dumps({"duration_us": 5_000_000, "video_streams": [{}]})),
            )
        timeline = client.post(
            f"/api/v1/projects/{project_id}/timelines",
            headers=ui,
            json={
                "schema_version": 1,
                "source": {"kind": "full_asset", "asset_id": "a1"},
                "default_layout": "crop_fill",
                "caption_preset_id": "default-bottom",
            },
        ).json()
        first_revision = timeline["current_revision"]
        timeline = client.post(
            f"/api/v1/projects/{project_id}/timeline/patches",
            headers=ui,
            json={
                "schema_version": 1,
                "base_revision_id": first_revision["timeline_revision_id"],
                "operations": [
                    {
                        "op": "add_caption",
                        "start_us": 0,
                        "end_us": 1_000_000,
                        "text": "CAPTION_SENTINEL_2B",
                        "preset_id": "default-bottom",
                        "source_clip_id": None,
                    }
                ],
                "summary": "测试字幕",
            },
        ).json()
        base = timeline["current_revision"]
        provider_id = client.post(
            "/api/v1/providers",
            headers=ui,
            json={
                "kind": "openai_compatible_text",
                "display_name": "local",
                "base_url": "http://127.0.0.1:9999/v1",
                "model": "mock",
            },
        ).json()["provider_config_id"]
        assert (
            client.put(
                f"/api/v1/internal/provider-secrets/{provider_id}",
                headers=admin,
                json={"secret": "SENTINEL_KEY_2B"},
            ).status_code
            == 200
        )
        assert client.post(
            f"/api/v1/providers/{provider_id}/timeline-patch-capability-test", headers=ui
        ).status_code == 200
        service = app.state.core.timeline_patch_planning
        with pytest.raises(Exception):
            service.prepare(project_id, {"instruction": "missing fields"})
        with pytest.raises(Exception):
            service.prepare(
                project_id,
                {
                    "base_revision_id": base["timeline_revision_id"],
                    "provider_config_id": provider_id,
                    "instruction": "",
                },
            )
        with pytest.raises(Exception):
            service.prepare(
                project_id,
                {
                    "base_revision_id": "revision_missing",
                    "provider_config_id": provider_id,
                    "instruction": "调整布局",
                },
            )
        with app.state.core.db.connection() as db:
            db.execute("UPDATE provider_configs SET enabled=0 WHERE id=?", (provider_id,))
        with pytest.raises(Exception):
            service.prepare(
                project_id,
                {
                    "base_revision_id": base["timeline_revision_id"],
                    "provider_config_id": provider_id,
                    "instruction": "调整布局",
                },
            )
        with app.state.core.db.connection() as db:
            db.execute("UPDATE provider_configs SET enabled=1 WHERE id=?", (provider_id,))
        untested = client.post(
            f"/api/v1/projects/{project_id}/timeline-patch-generations/prepare",
            headers=ui,
            json={
                "base_revision_id": base["timeline_revision_id"],
                "provider_config_id": provider_id,
                "instruction": "恢复后仍需探针",
            },
        )
        assert untested.status_code == 409
        assert untested.json()["error"]["code"] == "TIMELINE_PATCH_PROVIDER_UNTESTED"
        assert client.post(
            f"/api/v1/providers/{provider_id}/timeline-patch-capability-test", headers=ui
        ).status_code == 200
        prepared = client.post(
            f"/api/v1/projects/{project_id}/timeline-patch-generations/prepare",
            headers=ui,
            json={
                "base_revision_id": base["timeline_revision_id"],
                "provider_config_id": provider_id,
                "instruction": "INSTRUCTION_SENTINEL_2B 把首个镜头设为适应画布",
            },
        )
        assert prepared.status_code == 200
        preview = prepared.json()
        assert not any(
            request.capability == "timeline_patch_planning" for request in provider.requests
        )
        serialized = json_dumps(preview)
        assert "SENSITIVE_NAME" not in serialized and "SENSITIVE_FP" not in serialized
        assert "SENTINEL_KEY_2B" not in serialized
        assert "INSTRUCTION_SENTINEL_2B" not in serialized
        assert "CAPTION_SENTINEL_2B" not in serialized
        assert "payload" not in preview
        assert "response_adapter_id" not in preview
        assert "probe_protocol_version" not in preview
        with app.state.core.db.connection() as db:
            snapshot = json_loads(
                db.execute(
                    "SELECT provider_snapshot_json FROM timeline_patch_egress_previews WHERE id=?",
                    (preview["timeline_patch_egress_preview_id"],),
                ).fetchone()[0]
            )
        assert snapshot["timeline_patch_response_adapter_id"] == "openai_responses_json_schema_v1"
        assert snapshot["timeline_patch_probe_protocol_version"] == "1"
        assert preview["clip_count"] == 1
        assert preview["caption_count"] == 1
        with pytest.raises(Exception):
            service.create_generation(
                project_id, "preview_missing", preview["payload_sha256"], app.state.core.jobs
            )
        with pytest.raises(Exception):
            service.create_generation(
                project_id,
                preview["timeline_patch_egress_preview_id"],
                "sha256:wrong",
                app.state.core.jobs,
            )
        with pytest.raises(Exception):
            service.create_generation(
                project_id,
                preview["timeline_patch_egress_preview_id"],
                preview["payload_sha256"],
                app.state.core.jobs,
            )
        preview = service.prepare(
            project_id,
            {
                "base_revision_id": base["timeline_revision_id"],
                "provider_config_id": provider_id,
                "instruction": "INSTRUCTION_SENTINEL_2B",
            },
        )
        app.state.core.provider_secrets.delete(provider_id)
        with pytest.raises(Exception):
            service.create_generation(
                project_id,
                preview["timeline_patch_egress_preview_id"],
                preview["payload_sha256"],
                app.state.core.jobs,
            )
        app.state.core.provider_secrets.set(provider_id, "SENTINEL_KEY_2B")
        preview = service.prepare(
            project_id,
            {
                "base_revision_id": base["timeline_revision_id"],
                "provider_config_id": provider_id,
                "instruction": "INSTRUCTION_SENTINEL_2B",
            },
        )
        with pytest.raises(Exception):
            service.get_generation("timeline_patch_generation_missing")
        with pytest.raises(Exception):
            service.get_proposal("timeline_patch_proposal_missing")
        with pytest.raises(Exception):
            service.apply(project_id, "missing", {})

        forbidden_preview = service.prepare(
            project_id,
            {
                "base_revision_id": base["timeline_revision_id"],
                "provider_config_id": provider_id,
                "instruction": "尝试解锁",
            },
        )
        provider.forbidden = True
        forbidden = service.create_generation(
            project_id,
            forbidden_preview["timeline_patch_egress_preview_id"],
            forbidden_preview["payload_sha256"],
            app.state.core.jobs,
        )
        failed_job = _wait(client, ui, forbidden["job"]["job_id"])
        assert failed_job["status"] == "failed"
        assert failed_job["error"]["code"] == "TIMELINE_PATCH_PROPOSAL_INVALID"
        assert service.generation_store.get(forbidden["timeline_patch_generation_id"]) is None
        provider.forbidden = False
        preview = service.prepare(
            project_id,
            {
                "base_revision_id": base["timeline_revision_id"],
                "provider_config_id": provider_id,
                "instruction": "INSTRUCTION_SENTINEL_2B 把首个镜头设为适应画布",
            },
        )
        created = client.post(
            f"/api/v1/projects/{project_id}/timeline-patch-generations",
            headers=ui,
            json={
                "timeline_patch_egress_preview_id": preview["timeline_patch_egress_preview_id"],
                "payload_sha256": preview["payload_sha256"],
            },
        )
        assert created.status_code == 200
        job = _wait(client, ui, created.json()["job"]["job_id"])
        assert job["status"] == "succeeded"
        assert service.generation_store.get(created.json()["timeline_patch_generation_id"]) is None
        assert len(
            [
                request
                for request in provider.requests
                if request.capability == "timeline_patch_planning"
            ]
        ) == 2
        unchanged = client.get(f"/api/v1/projects/{project_id}/timeline", headers=ui).json()
        assert unchanged["current_revision"]["timeline_revision_id"] == base["timeline_revision_id"]
        proposals = client.get(
            f"/api/v1/projects/{project_id}/timeline-patch-proposals", headers=ui
        ).json()["items"]
        assert len(proposals) == 1
        proposal = proposals[0]
        conflict = client.post(
            f"/api/v1/projects/{project_id}/timeline-patch-proposals/"
            f"{proposal['timeline_patch_proposal_id']}/apply",
            headers=ui,
            json={
                "base_revision_id": base["timeline_revision_id"],
                "proposed_document_sha256": "sha256:wrong",
            },
        )
        assert conflict.status_code == 409
        assert conflict.json()["error"]["code"] == "TIMELINE_PATCH_PROPOSAL_CONFLICT"
        applied = client.post(
            f"/api/v1/projects/{project_id}/timeline-patch-proposals/"
            f"{proposal['timeline_patch_proposal_id']}/apply",
            headers=ui,
            json={
                "base_revision_id": base["timeline_revision_id"],
                "proposed_document_sha256": proposal["proposed_document_sha256"],
            },
        )
        assert applied.status_code == 200
        assert applied.json()["current_revision"]["document"]["clips"][0]["layout"] == "fit"
        duplicate = client.post(
            f"/api/v1/projects/{project_id}/timeline-patch-proposals/"
            f"{proposal['timeline_patch_proposal_id']}/apply",
            headers=ui,
            json={
                "base_revision_id": base["timeline_revision_id"],
                "proposed_document_sha256": proposal["proposed_document_sha256"],
            },
        )
        assert duplicate.status_code == 409
        assert duplicate.json()["error"]["code"] == "TIMELINE_PATCH_PROPOSAL_APPLIED"
        with app.state.core.db.connection() as db:
            dump = "\n".join(
                repr(tuple(row))
                for table in (
                    "timeline_patch_egress_previews",
                    "timeline_patch_egress_consents",
                    "jobs",
                    "provider_invocations",
                    "timeline_patch_generations",
                    "timeline_patch_proposals",
                    "timeline_patch_applications",
                )
                for row in db.execute(f"SELECT * FROM {table}")
            )
        public_dtos = json_dumps(
            {
                "preview": preview,
                "created": created.json(),
                "job": job,
                "generation": client.get(
                    f"/api/v1/timeline-patch-generations/"
                    f"{created.json()['timeline_patch_generation_id']}",
                    headers=ui,
                    ).json(),
                    "proposals": proposals,
                }
            )
        for sentinel in (
            "SENTINEL_KEY_2B",
            "INSTRUCTION_SENTINEL_2B",
            "CAPTION_SENTINEL_2B",
        ):
            assert sentinel not in dump
            assert sentinel not in public_dtos

        current = applied.json()["current_revision"]
        cancel_preview = service.prepare(
            project_id,
            {
                "base_revision_id": current["timeline_revision_id"],
                "provider_config_id": provider_id,
                "instruction": "测试取消",
            },
        )
        capturing = CapturingJobs()
        service.create_generation(
            project_id,
            cancel_preview["timeline_patch_egress_preview_id"],
            cancel_preview["payload_sha256"],
            capturing,
        )
        assert capturing.args is not None
        _, generation_id, invocation_id, _ = capturing.args
        service.provider_factory = CancelProvider
        row = {
            "timeline_patch_generation_id": generation_id,
            "provider_invocation_id": invocation_id,
        }
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(
                service.run_generation(row, asyncio.Event(), lambda _: None, lambda _: None)
            )
        with app.state.core.db.connection() as db:
            invocation = db.execute(
                "SELECT status,provider_may_have_processed FROM provider_invocations WHERE id=?",
                (invocation_id,),
            ).fetchone()
            generation = db.execute(
                "SELECT status FROM timeline_patch_generations WHERE id=?", (generation_id,)
            ).fetchone()
        assert tuple(invocation) == ("cancelled", 1)
        assert generation[0] == "cancelled"
        assert service.generation_store.get(generation_id) is None


def test_pending_preview_is_process_local_and_run_revalidates_before_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-revalidate")
    app = create_app(Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing")))
    provider = PatchProvider()
    app.state.core.timeline_patch_planning.provider_factory = lambda: provider
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer admin-revalidate"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        project_id = client.post("/api/v1/projects", headers=ui, json={"name": "P"}).json()[
            "project_id"
        ]
        with app.state.core.db.connection() as db:
            db.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,availability,media_info_json,created_at,updated_at) VALUES ('a1',?,'video','external','hidden','fp',1,'available',?,'now','now')",  # noqa: E501
                (project_id, json_dumps({"duration_us": 5_000_000, "video_streams": [{}]})),
            )
        base = client.post(
            f"/api/v1/projects/{project_id}/timelines",
            headers=ui,
            json={
                "schema_version": 1,
                "source": {"kind": "full_asset", "asset_id": "a1"},
                "default_layout": "crop_fill",
                "caption_preset_id": "default-bottom",
            },
        ).json()["current_revision"]
        provider_id = client.post(
            "/api/v1/providers",
            headers=ui,
            json={
                "kind": "openai_compatible_text",
                "display_name": "local",
                "base_url": "http://127.0.0.1:9999/v1",
                "model": "mock",
            },
        ).json()["provider_config_id"]
        app.state.core.provider_secrets.set(provider_id, "key")
        assert client.post(
            f"/api/v1/providers/{provider_id}/timeline-patch-capability-test", headers=ui
        ).status_code == 200
        service = app.state.core.timeline_patch_planning
        request = {
            "base_revision_id": base["timeline_revision_id"],
            "provider_config_id": provider_id,
            "instruction": "PROCESS_LOCAL_SENTINEL",
        }
        restart_preview = service.prepare(project_id, request)
        restarted_vault = ProviderSecretVault()
        restarted_vault.set(provider_id, "key")
        restarted = TimelinePatchPlanningService(
            app.state.core.db,
            ProviderRepository(app.state.core.db, restarted_vault),
            restarted_vault,
            TimelineService(app.state.core.db),
        )
        with pytest.raises(Exception):
            restarted.create_generation(
                project_id,
                restart_preview["timeline_patch_egress_preview_id"],
                restart_preview["payload_sha256"],
                CapturingJobs(),
            )
        service.pending_store.discard(restart_preview["timeline_patch_egress_preview_id"])

        provider_preview = service.prepare(project_id, request)
        capturing = CapturingJobs()
        service.create_generation(
            project_id,
            provider_preview["timeline_patch_egress_preview_id"],
            provider_preview["payload_sha256"],
            capturing,
        )
        assert capturing.args is not None
        _, generation_id, invocation_id, _ = capturing.args
        with app.state.core.db.connection() as db:
            db.execute("UPDATE provider_configs SET model='changed' WHERE id=?", (provider_id,))
        with pytest.raises(Exception):
            asyncio.run(
                service.run_generation(
                    {
                        "timeline_patch_generation_id": generation_id,
                        "provider_invocation_id": invocation_id,
                    },
                    asyncio.Event(),
                    lambda _: None,
                    lambda _: None,
                )
            )
        assert not any(
            request.capability == "timeline_patch_planning" for request in provider.requests
        )
        assert service.generation_store.get(generation_id) is None
        with app.state.core.db.connection() as db:
            invocation = db.execute(
                "SELECT provider_may_have_processed FROM provider_invocations WHERE id=?",
                (invocation_id,),
            ).fetchone()
            db.execute("UPDATE provider_configs SET model='mock' WHERE id=?", (provider_id,))
        assert invocation[0] == 0

        untested = client.post(
            f"/api/v1/projects/{project_id}/timeline-patch-generations/prepare",
            headers=ui,
            json=request,
        )
        assert untested.status_code == 409
        assert untested.json()["error"]["code"] == "TIMELINE_PATCH_PROVIDER_UNTESTED"
        assert client.post(
            f"/api/v1/providers/{provider_id}/timeline-patch-capability-test", headers=ui
        ).status_code == 200

        timeline_preview = service.prepare(project_id, request)
        capturing = CapturingJobs()
        service.create_generation(
            project_id,
            timeline_preview["timeline_patch_egress_preview_id"],
            timeline_preview["payload_sha256"],
            capturing,
        )
        assert capturing.args is not None
        _, generation_id, invocation_id, _ = capturing.args
        clip_id = base["document"]["clips"][0]["clip_id"]
        changed = client.post(
            f"/api/v1/projects/{project_id}/timeline/patches",
            headers=ui,
            json={
                "schema_version": 1,
                "base_revision_id": base["timeline_revision_id"],
                "operations": [{"op": "set_layout", "clip_id": clip_id, "layout": "fit"}],
                "summary": "change",
            },
        )
        assert changed.status_code == 200
        with pytest.raises(Exception):
            asyncio.run(
                service.run_generation(
                    {
                        "timeline_patch_generation_id": generation_id,
                        "provider_invocation_id": invocation_id,
                    },
                    asyncio.Event(),
                    lambda _: None,
                    lambda _: None,
                )
            )
        assert not any(
            request.capability == "timeline_patch_planning" for request in provider.requests
        )
        assert service.generation_store.get(generation_id) is None
