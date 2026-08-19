from __future__ import annotations

import asyncio
import struct
import zlib
from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database
from aivs_core.jobs import JobService
from aivs_core.projects import DomainError, ProjectAssetService
from aivs_core.provider_image_generation import (
    ImageProviderConfigService,
    ProviderImageGenerationService,
)
from aivs_core.provider_images import (
    FailOnCallImageProvider,
    ProviderImageError,
    ProviderImageResult,
    sha256_bytes,
    validate_generated_image,
)
from aivs_core.providers import ProviderSecretVault

PROMPT_SENTINEL = "PROMPT_SENTINEL_STAGE4D_PRIVATE"
SECRET_SENTINEL = "SECRET_SENTINEL_STAGE4D_PRIVATE"


def _chunk(kind: bytes, payload: bytes) -> bytes:
    checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)


def _png(width: int = 1024, height: int = 1024) -> bytes:
    row = b"\x00" + b"\x20\x40\x60" * width
    raw = row * height
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(raw, 9))
        + _chunk(b"IEND", b"")
    )


class LocalFakeImageProvider:
    def __init__(self, content: bytes, failure: str | None = None) -> None:
        self.content = content
        self.failure = failure
        self.calls = 0

    async def generate(
        self, request: Any, cancel_event: asyncio.Event, on_dispatch: Any
    ) -> ProviderImageResult:
        del cancel_event
        if self.failure == "before":
            raise ProviderImageError("PROVIDER_NETWORK_ERROR", "Provider 网络不可用", False)
        on_dispatch()
        self.calls += 1
        if self.failure == "after":
            raise ProviderImageError("PROVIDER_TIMEOUT", "Provider 请求超时", True)
        assert request.api_key == SECRET_SENTINEL
        return ProviderImageResult(
            content=self.content,
            provider_request_id="fake_request_id",
            usage={"images": 1},
            response_sha256=sha256_bytes(b"safe fake response envelope"),
        )


def _service(
    tmp_path: Path, provider: Any | None = None
) -> tuple[Database, ImageProviderConfigService, ProviderImageGenerationService, str]:
    database = Database(tmp_path / "app.db")
    database.initialize()
    project_root = tmp_path / "projects" / "project_1"
    project_root.mkdir(parents=True)
    with database.connection() as sql:
        sql.execute(
            "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                "project_1",
                "P",
                "active",
                "{}",
                None,
                str(project_root),
                "P",
                "now",
                "now",
                "now",
            ),
        )
    secrets = ProviderSecretVault()
    configs = ImageProviderConfigService(database, secrets)
    config = configs.create(
        "project_1",
        {"display_name": "APIKEY.FUN Images", "enabled": True},
    )
    configs.set_secret(config["provider_config_id"], SECRET_SENTINEL)

    async def no_probe(*args: Any, **kwargs: Any) -> dict[str, Any]:
        del args, kwargs
        return {}

    projects = ProjectAssetService(database, tmp_path, no_probe)
    service = ProviderImageGenerationService(
        database, configs, secrets, projects, provider=provider
    )
    return database, configs, service, config["provider_config_id"]


def _create(
    service: ProviderImageGenerationService, config_id: str, prompt: str = PROMPT_SENTINEL
) -> dict[str, Any]:
    prepared = service.prepare("project_1", config_id, prompt, "1024x1024")
    assert prompt not in repr(prepared)
    return service.create("project_1", prepared["preview_id"], prepared["payload_sha256"], True)


def _job_row(database: Database, job_id: str) -> Any:
    with database.connection() as sql:
        return sql.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()


def _run(
    service: ProviderImageGenerationService, database: Database, task: dict[str, Any]
) -> dict[str, Any]:
    service.start_job(task["job_id"])
    return asyncio.run(
        service.run(
            _job_row(database, task["job_id"]),
            asyncio.Event(),
            lambda _: None,
            lambda _: None,
        )
    )


def _project_root(database: Database) -> Path:
    with database.connection() as sql:
        row = sql.execute("SELECT root_dir FROM projects WHERE id='project_1'").fetchone()
    return Path(row["root_dir"])


def test_config_prepare_create_are_safe_idempotent_and_default_fail_closed(
    tmp_path: Path,
) -> None:
    database, configs, service, config_id = _service(tmp_path)
    assert isinstance(service.provider, FailOnCallImageProvider)
    public = configs.get(config_id)
    assert public["credential_status"] == "configured"
    assert SECRET_SENTINEL not in repr(public)
    prepared = service.prepare("project_1", config_id, PROMPT_SENTINEL, "1024x1024")
    with pytest.raises(DomainError) as mismatch:
        service.create("project_1", prepared["preview_id"], "sha256:" + "0" * 64, True)
    assert mismatch.value.code == "IMAGE_GENERATION_CONFIRMATION_INVALID"
    created = service.create("project_1", prepared["preview_id"], prepared["payload_sha256"], True)
    assert created["reused"] is False
    prepared_again = service.prepare("project_1", config_id, PROMPT_SENTINEL, "1024x1024")
    reused = service.create(
        "project_1",
        prepared_again["preview_id"],
        prepared_again["payload_sha256"],
        True,
    )
    assert reused["reused"] is True
    with database.connection() as sql:
        dump = "\n".join(sql.iterdump())
    assert PROMPT_SENTINEL not in dump
    assert SECRET_SENTINEL not in dump
    assert str(tmp_path.resolve()) not in repr(created)


def test_queued_cancel_projects_safe_error_and_retry_requires_same_prompt(
    tmp_path: Path,
) -> None:
    database, _, service, config_id = _service(tmp_path)
    task = _create(service, config_id)["task"]
    cancelled = service.cancel(task["task_id"])
    assert cancelled["status"] == "cancelled"
    assert cancelled["error"] == {"code": "JOB_CANCELLED", "message": "任务已取消"}
    with pytest.raises(DomainError) as wrong_prompt:
        service.prepare_retry(task["task_id"], "different private prompt")
    assert wrong_prompt.value.code == "GENERATION_PROMPT_HASH_MISMATCH"
    prepared = service.prepare_retry(task["task_id"], PROMPT_SENTINEL)
    retry = service.retry(task["task_id"], prepared["preview_id"], prepared["payload_sha256"], True)
    assert retry["retry_of_task_id"] == task["task_id"]
    with pytest.raises(DomainError) as duplicate:
        service.prepare_retry(task["task_id"], PROMPT_SENTINEL)
    assert duplicate.value.code == "GENERATION_RETRY_NOT_ALLOWED"
    with database.connection() as sql:
        assert sql.execute("SELECT COUNT(*) FROM jobs WHERE status='queued'").fetchone()[0] == 1


def test_native_provider_dimensions_are_preserved_without_normalization(tmp_path: Path) -> None:
    native_png = _png(1024, 1536)
    fake = LocalFakeImageProvider(native_png)
    database, _, service, config_id = _service(tmp_path, fake)
    task = _create(service, config_id)["task"]

    result = _run(service, database, task)
    service.finish_job(task["job_id"], "succeeded", result)

    assert result["output"]["width"] == 1024
    assert result["output"]["height"] == 1536
    assert result["output"]["sha256"] == sha256_bytes(native_png)
    completed = service.list_tasks(task["request_id"])[0]
    assert completed["result_summary"]["output"] == result["output"]
    with database.connection() as sql:
        invocation = sql.execute(
            "SELECT validated_width,validated_height,validated_size_bytes,output_sha256 "
            "FROM provider_image_invocations WHERE task_id=?",
            (task["task_id"],),
        ).fetchone()
        asset = sql.execute(
            "SELECT fingerprint,media_info_json FROM assets WHERE id=?",
            (completed["output_asset_id"],),
        ).fetchone()
    assert tuple(invocation[:2]) == (1024, 1536)
    assert invocation["validated_size_bytes"] == len(native_png)
    assert invocation["output_sha256"] == sha256_bytes(native_png)
    assert asset["fingerprint"] == sha256_bytes(native_png)
    assert '"width":1024' in asset["media_info_json"]
    assert '"height":1536' in asset["media_info_json"]
    managed_file = (
        _project_root(database)
        / "generated"
        / "image"
        / f"{completed['output_asset_id']}.png"
    )
    assert managed_file.read_bytes() == native_png


def test_native_dimension_safety_limits_are_checked_before_decode() -> None:
    oversized_edge = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", 4097, 1, 8, 2, 0, 0, 0))
        + _chunk(b"IEND", b"")
    )
    with pytest.raises(ProviderImageError) as caught:
        validate_generated_image(oversized_edge, "1024x1024")
    assert caught.value.code == "GENERATED_IMAGE_TOO_LARGE"


def test_requested_size_remains_a_fixed_profile_not_an_output_equality_check() -> None:
    native_png = _png(1536, 1024)
    validated = validate_generated_image(native_png, "1024x1024")
    assert (validated["width"], validated["height"]) == (1536, 1024)
    assert validated["sha256"] == sha256_bytes(native_png)
    with pytest.raises(ProviderImageError) as caught:
        validate_generated_image(native_png, "2048x2048")
    assert caught.value.code == "IMAGE_PROVIDER_UNSUPPORTED"

def test_local_fake_success_registers_managed_asset_and_provenance(tmp_path: Path) -> None:
    fake = LocalFakeImageProvider(_png())
    database, _, service, config_id = _service(tmp_path, fake)
    task = _create(service, config_id)["task"]
    result = _run(service, database, task)
    service.finish_job(task["job_id"], "succeeded", result)
    assert fake.calls == 1
    completed = service.list_tasks(task["request_id"])[0]
    assert completed["status"] == "succeeded"
    assert completed["provider_call_count"] == 1
    assert completed["provider_may_have_processed"] is True
    with database.connection() as sql:
        asset = sql.execute(
            "SELECT kind,storage_mode,availability,fingerprint FROM assets"
        ).fetchone()
        provenance = sql.execute(
            "SELECT prompt_sha256,output_sha256 FROM generated_asset_provenance"
        ).fetchone()
        invocation = sql.execute(
            "SELECT status,provider_call_count,validated_format,validated_width,"
            "validated_height FROM provider_image_invocations"
        ).fetchone()
        dump = "\n".join(sql.iterdump())
    assert tuple(asset[:3]) == ("image", "managed", "available")
    assert asset["fingerprint"] == result["output"]["sha256"]
    assert provenance["prompt_sha256"].startswith("sha256:")
    assert provenance["output_sha256"] == result["output"]["sha256"]
    assert tuple(invocation) == ("succeeded", 1, "png", 1024, 1024)
    assert PROMPT_SENTINEL not in dump and SECRET_SENTINEL not in dump


@pytest.mark.parametrize(
    ("failure", "call_count", "may_have_processed", "code"),
    [
        ("before", 0, 0, "PROVIDER_NETWORK_ERROR"),
        ("after", 1, 1, "PROVIDER_TIMEOUT"),
    ],
)
def test_provider_failure_preserves_dispatch_boundary_and_safe_error(
    tmp_path: Path,
    failure: str,
    call_count: int,
    may_have_processed: int,
    code: str,
) -> None:
    fake = LocalFakeImageProvider(_png(), failure=failure)
    database, _, service, config_id = _service(tmp_path, fake)
    task = _create(service, config_id)["task"]
    service.start_job(task["job_id"])
    with pytest.raises(ProviderImageError) as caught:
        asyncio.run(
            service.run(
                _job_row(database, task["job_id"]),
                asyncio.Event(),
                lambda _: None,
                lambda _: None,
            )
        )
    service.finish_job(task["job_id"], "failed", None, caught.value.code, caught.value.message)
    failed = service.list_tasks(task["request_id"])[0]
    assert failed["error"] == {"code": code, "message": caught.value.message}
    with database.connection() as sql:
        invocation = sql.execute(
            "SELECT status,provider_call_count,provider_may_have_processed,error_code,"
            "error_message FROM provider_image_invocations"
        ).fetchone()
    assert tuple(invocation) == (
        "failed",
        call_count,
        may_have_processed,
        code,
        caught.value.message,
    )
    assert PROMPT_SENTINEL not in repr(failed)


def test_dispatch_is_single_use_and_recovery_clears_prompt_vault(tmp_path: Path) -> None:
    fake = LocalFakeImageProvider(_png())
    database, _, service, config_id = _service(tmp_path, fake)
    task = _create(service, config_id)["task"]
    service.start_job(task["job_id"])
    service._mark_dispatched(task["task_id"])
    with pytest.raises(ProviderImageError) as duplicate:
        service._mark_dispatched(task["task_id"])
    assert duplicate.value.code == "IMAGE_PROVIDER_CALL_ALREADY_DISPATCHED"
    assert service.vault.count() == 1
    assert service.recover_interrupted_tasks() == 1
    assert service.vault.count() == 0
    recovered = service.list_tasks(task["request_id"])[0]
    assert recovered["status"] == "interrupted"
    assert recovered["provider_call_count"] == 1


def test_publish_database_failure_removes_final_file(tmp_path: Path, monkeypatch) -> None:
    fake = LocalFakeImageProvider(_png())
    database, _, service, config_id = _service(tmp_path, fake)
    task = _create(service, config_id)["task"]

    def fail_registration(*args: Any, **kwargs: Any) -> None:
        del args, kwargs
        raise RuntimeError("database registration failed")

    monkeypatch.setattr(
        service.projects, "insert_generated_image_in_transaction", fail_registration
    )
    service.start_job(task["job_id"])
    with pytest.raises(ProviderImageError) as caught:
        asyncio.run(
            service.run(
                _job_row(database, task["job_id"]),
                asyncio.Event(),
                lambda _: None,
                lambda _: None,
            )
        )
    assert caught.value.code == "GENERATED_ASSET_REGISTER_FAILED"
    output_dir = _project_root(database) / "generated" / "image"
    assert list(output_dir.glob("*.png")) == []
    with database.connection() as sql:
        row = sql.execute(
            "SELECT cleanup_required,output_relative_path FROM provider_image_invocations "
            "WHERE task_id=?",
            (task["task_id"],),
        ).fetchone()
    assert tuple(row) == (0, None)


def test_publish_delete_failure_records_cleanup_and_recovery_deletes_only_owned_file(
    tmp_path: Path, monkeypatch
) -> None:
    fake = LocalFakeImageProvider(_png())
    database, _, service, config_id = _service(tmp_path, fake)
    task = _create(service, config_id)["task"]

    def fail_registration(*args: Any, **kwargs: Any) -> None:
        del args, kwargs
        raise RuntimeError("database registration failed")

    monkeypatch.setattr(
        service.projects, "insert_generated_image_in_transaction", fail_registration
    )
    original_unlink = Path.unlink

    def fail_final_unlink(path: Path, *args: Any, **kwargs: Any) -> None:
        if path.suffix == ".png" and path.parent.name == "image":
            raise PermissionError("locked")
        original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_final_unlink)
    service.start_job(task["job_id"])
    with pytest.raises(ProviderImageError):
        asyncio.run(
            service.run(
                _job_row(database, task["job_id"]),
                asyncio.Event(),
                lambda _: None,
                lambda _: None,
            )
        )
    with database.connection() as sql:
        row = sql.execute(
            "SELECT cleanup_required,output_relative_path FROM provider_image_invocations "
            "WHERE task_id=?",
            (task["task_id"],),
        ).fetchone()
    assert row["cleanup_required"] == 1
    assert row["output_relative_path"].startswith("generated/image/")
    owned_file = _project_root(database) / Path(row["output_relative_path"])
    assert owned_file.is_file()
    monkeypatch.setattr(Path, "unlink", original_unlink)
    assert service.cleanup_orphans() == 1
    assert not owned_file.exists()


def test_cleanup_rejects_traversal_and_cleans_only_known_task_parts(tmp_path: Path) -> None:
    database, _, service, config_id = _service(tmp_path)
    task = _create(service, config_id)["task"]
    root = _project_root(database)
    outside = root / "do-not-delete.png"
    outside.write_bytes(b"outside")
    with database.connection() as sql:
        sql.execute(
            "UPDATE provider_image_invocations SET cleanup_required=1,"
            "output_relative_path='generated/image/../do-not-delete.png' WHERE task_id=?",
            (task["task_id"],),
        )
    temporary = root / "generated" / "image" / ".tmp"
    temporary.mkdir(parents=True)
    known_part = temporary / f"{task['task_id']}.part"
    unknown_part = temporary / "unknown_task.part"
    unrelated = temporary / "notes.txt"
    known_part.write_bytes(b"known")
    unknown_part.write_bytes(b"unknown")
    unrelated.write_bytes(b"keep")
    assert service.cleanup_orphans() == 1
    assert outside.is_file()
    assert not known_part.exists()
    assert unknown_part.is_file() and unrelated.is_file()
    with database.connection() as sql:
        row = sql.execute(
            "SELECT cleanup_required FROM provider_image_invocations WHERE task_id=?",
            (task["task_id"],),
        ).fetchone()
    assert row["cleanup_required"] == 1


def test_duplicate_asset_fingerprint_is_rejected_and_duplicate_file_removed(
    tmp_path: Path,
) -> None:
    fake = LocalFakeImageProvider(_png())
    database, _, service, config_id = _service(tmp_path, fake)
    first = _create(service, config_id, "first prompt")["task"]
    first_result = _run(service, database, first)
    service.finish_job(first["job_id"], "succeeded", first_result)
    second = _create(service, config_id, "second prompt")["task"]
    service.start_job(second["job_id"])
    with pytest.raises(ProviderImageError) as duplicate:
        asyncio.run(
            service.run(
                _job_row(database, second["job_id"]),
                asyncio.Event(),
                lambda _: None,
                lambda _: None,
            )
        )
    assert duplicate.value.code == "GENERATED_ASSET_DUPLICATE"
    assert len(list((_project_root(database) / "generated" / "image").glob("*.png"))) == 1
    with database.connection() as sql:
        assert sql.execute("SELECT COUNT(*) FROM assets").fetchone()[0] == 1
        assert sql.execute("SELECT COUNT(*) FROM generated_asset_provenance").fetchone()[0] == 1


def test_finish_job_rejects_success_before_dispatch_or_publish(tmp_path: Path) -> None:
    database, _, service, config_id = _service(tmp_path)
    task = _create(service, config_id)["task"]
    service.start_job(task["job_id"])
    fake_result = {
        "asset": {"asset_id": "asset_missing"},
        "output": {"sha256": "sha256:" + "0" * 64},
    }
    with pytest.raises(RuntimeError, match="GENERATION_OUTPUT_INVALID"):
        service.finish_job(task["job_id"], "succeeded", fake_result)
    with database.connection() as sql:
        assert (
            sql.execute("SELECT status FROM jobs WHERE id=?", (task["job_id"],)).fetchone()[0]
            == "running"
        )


def test_get_contract_and_pagination_are_strict(tmp_path: Path) -> None:
    _, _, service, config_id = _service(tmp_path)
    created = _create(service, config_id)
    request_id = created["request"]["request_id"]

    assert set(service.get(request_id)) == {
        "request_id",
        "project_id",
        "generation_kind",
        "execution_mode",
        "prompt_sha256",
        "parameters",
        "request_sha256",
        "created_at",
    }
    assert service.list("project_1", 1, "0")[0]["request_id"] == request_id
    assert service.list_tasks(request_id, 1, "0")[0]["request_id"] == request_id

    for limit, cursor in ((0, None), (101, None), (1, "-1"), (1, "+1"), (1, "1.0")):
        with pytest.raises(DomainError) as requests_error:
            service.list("project_1", limit, cursor)
        assert requests_error.value.code == "GENERATION_REQUEST_INVALID"
        with pytest.raises(DomainError) as tasks_error:
            service.list_tasks(request_id, limit, cursor)
        assert tasks_error.value.code == "GENERATION_REQUEST_INVALID"


async def _emit_nothing(_: dict[str, Any]) -> None:
    return None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "expected_calls", "may_have_processed", "error_code"),
    [
        ("before", 0, False, "PROVIDER_NETWORK_ERROR"),
        ("after", 1, True, "PROVIDER_TIMEOUT"),
    ],
)
async def test_job_service_projects_provider_failure_dispatch_boundary(
    tmp_path: Path,
    failure: str,
    expected_calls: int,
    may_have_processed: bool,
    error_code: str,
) -> None:
    fake = LocalFakeImageProvider(_png(), failure=failure)
    database, _, generation, config_id = _service(tmp_path, fake)
    task = _create(generation, config_id)["task"]
    jobs = JobService(
        database,
        tmp_path,
        Path("missing-ffmpeg"),
        object(),
        object(),
        _emit_nothing,
        provider_image_generation_runner=generation.run,
        provider_image_generation_start=generation.start_job,
        provider_image_generation_finish=generation.finish_job,
        provider_image_generation_recover=generation.recover_interrupted_tasks,
    )

    await jobs._run(task["job_id"])

    completed = generation.list_tasks(task["request_id"])[0]
    assert completed["status"] == "failed"
    assert completed["provider_call_count"] == expected_calls
    assert completed["provider_may_have_processed"] is may_have_processed
    assert completed["error"]["code"] == error_code
    assert fake.calls == expected_calls
    with database.connection() as sql:
        job = sql.execute(
            "SELECT status,error_code,result_json FROM jobs WHERE id=?", (task["job_id"],)
        ).fetchone()
        invocation = sql.execute(
            "SELECT status,provider_call_count,provider_may_have_processed,error_code "
            "FROM provider_image_invocations WHERE task_id=?",
            (task["task_id"],),
        ).fetchone()
    assert tuple(job) == ("failed", error_code, None)
    assert tuple(invocation) == (
        "failed",
        expected_calls,
        int(may_have_processed),
        error_code,
    )


@pytest.mark.asyncio
async def test_job_service_projects_provider_success_once_to_all_aggregates(
    tmp_path: Path,
) -> None:
    fake = LocalFakeImageProvider(_png())
    database, _, generation, config_id = _service(tmp_path, fake)
    task = _create(generation, config_id)["task"]
    jobs = JobService(
        database,
        tmp_path,
        Path("missing-ffmpeg"),
        object(),
        object(),
        _emit_nothing,
        provider_image_generation_runner=generation.run,
        provider_image_generation_start=generation.start_job,
        provider_image_generation_finish=generation.finish_job,
        provider_image_generation_recover=generation.recover_interrupted_tasks,
    )

    await jobs._run(task["job_id"])
    await jobs._run(task["job_id"])

    completed = generation.list_tasks(task["request_id"])[0]
    assert completed["status"] == "succeeded"
    assert completed["provider_call_count"] == 1
    assert completed["provider_may_have_processed"] is True
    assert completed["result_summary"]["asset"]["asset_id"] == completed["output_asset_id"]
    assert fake.calls == 1
    with database.connection() as sql:
        job = sql.execute(
            "SELECT status,progress,result_json,error_code FROM jobs WHERE id=?",
            (task["job_id"],),
        ).fetchone()
        invocation = sql.execute(
            "SELECT status,provider_call_count,provider_may_have_processed,output_sha256 "
            "FROM provider_image_invocations WHERE task_id=?",
            (task["task_id"],),
        ).fetchone()
        provenance = sql.execute(
            "SELECT asset_id FROM generated_asset_provenance WHERE task_id=?",
            (task["task_id"],),
        ).fetchone()
    assert job["status"] == "succeeded" and job["progress"] == 1
    assert job["result_json"] is not None and job["error_code"] is None
    assert tuple(invocation[:3]) == ("succeeded", 1, 1)
    assert invocation["output_sha256"] == completed["output_sha256"]
    assert provenance["asset_id"] == completed["output_asset_id"]
