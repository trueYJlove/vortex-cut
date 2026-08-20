# ruff: noqa: E501
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database
from aivs_core.projects import DomainError, ProjectAssetService
from aivs_core.provider_image_generation import (
    ImageProviderConfigService,
    ProviderImageGenerationService,
)
from aivs_core.provider_images import FailOnCallImageProvider
from aivs_core.providers import ProviderSecretVault
from aivs_core.shot_requirement_image_fulfillment import ShotRequirementImageFulfillmentService

PROMPT = "STAGE4E_PRIVATE_PROMPT"
SECRET = "STAGE4E_PRIVATE_SECRET"


def _service(tmp_path: Path) -> tuple[Database, ShotRequirementImageFulfillmentService, str, str]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    root = tmp_path / "project"
    root.mkdir()
    with db.connection() as sql:
        sql.execute(
            "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,root_dir,"
            "root_dir_name,created_at,updated_at,last_opened_at) VALUES "
            "('p','P','active','{}',NULL,?,'P','now','now','now')",
            (str(root),),
        )
        sql.execute("INSERT INTO shot_lists VALUES ('sl','p',NULL,NULL,'now','now')")
        sql.execute(
            "INSERT INTO shot_list_revisions VALUES "
            "('rev','sl','p',NULL,1,'Shots','','sha256:document','now')"
        )
        sql.execute(
            "INSERT INTO shot_requirements VALUES "
            "('req','rev',0,'Shot','Visual direction',NULL,'image',NULL,NULL,NULL)"
        )
        sql.execute(
            "UPDATE shot_lists SET current_revision_id='rev',confirmed_revision_id='rev' WHERE id='sl'"
        )
    secrets = ProviderSecretVault()
    configs = ImageProviderConfigService(db, secrets)
    config = configs.create("p", {"display_name": "APIKEY.FUN", "enabled": True})
    configs.set_secret(config["provider_config_id"], SECRET)

    async def no_probe(*args: Any, **kwargs: Any) -> dict[str, Any]:
        del args, kwargs
        return {}

    projects = ProjectAssetService(db, tmp_path, no_probe)
    generations = ProviderImageGenerationService(
        db, configs, secrets, projects, provider=FailOnCallImageProvider()
    )
    return (
        db,
        ShotRequirementImageFulfillmentService(db, generations),
        config["provider_config_id"],
        "rev",
    )


def _prepare(service: ShotRequirementImageFulfillmentService, config_id: str) -> dict[str, Any]:
    return service.prepare("p", "req", "rev", config_id, PROMPT)


def _create(
    service: ShotRequirementImageFulfillmentService, prepared: dict[str, Any]
) -> dict[str, Any]:
    return service.create(
        "p", "req", prepared["preview_id"], prepared["fulfillment_payload_sha256"], "rev", True
    )


def test_prepare_is_zero_database_delta_and_redacts_prompt(tmp_path: Path) -> None:
    db, service, config_id, _ = _service(tmp_path)
    with db.connection() as sql:
        before = {
            table: sql.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in (
                "media_generation_requests",
                "media_generation_tasks",
                "jobs",
                "provider_image_invocations",
                "shot_requirement_image_generation_links",
            )
        }
    prepared = _prepare(service, config_id)
    assert PROMPT not in repr(prepared)
    assert set(prepared) == {
        "preview_id",
        "project_id",
        "shot_list_revision_id",
        "shot_requirement_id",
        "requirement_sha256",
        "fulfillment_payload_sha256",
        "execution_mode",
        "prompt_sha256",
        "size",
        "output_format",
        "image_count",
        "provider",
        "estimated_cost",
        "estimated_cost_currency",
        "price_tier",
        "expires_at",
    }
    with db.connection() as sql:
        after = {
            table: sql.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in before
        }
        dump = "\n".join(sql.iterdump())
    assert after == before
    assert PROMPT not in dump and SECRET not in dump


def test_create_is_atomic_and_reuses_generation_and_link(tmp_path: Path) -> None:
    db, service, config_id, _ = _service(tmp_path)
    first = _create(service, _prepare(service, config_id))
    second = _create(service, _prepare(service, config_id))
    assert first["generation_reused"] is False and first["link_reused"] is False
    assert second["generation_reused"] is True and second["link_reused"] is True
    assert second["link"]["link_id"] == first["link"]["link_id"]
    with db.connection() as sql:
        assert sql.execute("SELECT COUNT(*) FROM media_generation_requests").fetchone()[0] == 1
        assert sql.execute("SELECT COUNT(*) FROM media_generation_tasks").fetchone()[0] == 1
        assert sql.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
        assert sql.execute("SELECT COUNT(*) FROM provider_image_invocations").fetchone()[0] == 1
        assert (
            sql.execute("SELECT COUNT(*) FROM shot_requirement_image_generation_links").fetchone()[
                0
            ]
            == 1
        )
        assert (
            sql.execute(
                "SELECT SUM(provider_call_count) FROM provider_image_invocations"
            ).fetchone()[0]
            == 0
        )


def test_revision_race_rolls_back_generation_and_link(tmp_path: Path) -> None:
    db, service, config_id, _ = _service(tmp_path)
    prepared = _prepare(service, config_id)
    with db.connection() as sql:
        sql.execute("UPDATE shot_lists SET confirmed_revision_id=NULL WHERE id='sl'")
    with pytest.raises(DomainError) as error:
        _create(service, prepared)
    assert error.value.code == "SHOT_REQUIREMENT_REVISION_CONFLICT"
    with db.connection() as sql:
        for table in (
            "media_generation_requests",
            "media_generation_tasks",
            "jobs",
            "provider_image_invocations",
            "shot_requirement_image_generation_links",
        ):
            assert sql.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


def _succeed(db: Database, created: dict[str, Any]) -> tuple[str, str]:
    task = created["task"]
    asset_id = "asset-output"
    with db.connection() as sql:
        sql.execute(
            "INSERT INTO assets VALUES "
            "(?, 'p','image','managed','Generated','sha256:output',4,NULL,'available','{}','now','now')",
            (asset_id,),
        )
        sql.execute(
            "UPDATE jobs SET status='succeeded',stage='completed',progress=1,finished_at='now' WHERE id=?",
            (task["job_id"],),
        )
        sql.execute(
            "UPDATE media_generation_tasks SET status='succeeded',stage='completed',output_asset_id=?,"
            "output_sha256='sha256:output',result_summary_json='{}',finished_at='now' WHERE id=?",
            (asset_id, task["task_id"]),
        )
        sql.execute(
            "UPDATE provider_image_invocations SET status='succeeded',provider_call_count=1,"
            "provider_may_have_processed=1,provider_response_sha256='sha256:response',"
            "validated_format='png',validated_width=1024,validated_height=1024,validated_size_bytes=4,"
            "output_sha256='sha256:output',finished_at='now' WHERE task_id=?",
            (task["task_id"],),
        )
        invocation_id = sql.execute(
            "SELECT id FROM provider_image_invocations WHERE task_id=?", (task["task_id"],)
        ).fetchone()[0]
        sql.execute(
            "INSERT INTO generated_asset_provenance VALUES "
            "('provenance',?,?,?,?,'sha256:prompt','apikey_fun_images','apikey_fun_images_sse_v1',"
            "'1','gpt-image-2','sha256:profile','sha256:response','sha256:output','now')",
            (asset_id, task["request_id"], task["task_id"], invocation_id),
        )
    return task["task_id"], asset_id


def test_adoption_cas_lifecycle_and_no_timeline_side_effect(tmp_path: Path) -> None:
    db, service, config_id, _ = _service(tmp_path)
    created = _create(service, _prepare(service, config_id))
    assert service.get("p", "req")["lifecycle"] == "in_progress"
    task_id, asset_id = _succeed(db, created)
    assert service.get("p", "req")["lifecycle"] == "review_required"
    command = {
        "generation_link_id": created["link"]["link_id"],
        "task_id": task_id,
        "asset_id": asset_id,
        "expected_current_adoption_id": None,
        "confirmed": True,
    }
    adopted = service.adopt("p", "req", command)
    assert adopted["reused"] is False
    command["expected_current_adoption_id"] = adopted["adoption"]["adoption_id"]
    assert service.adopt("p", "req", command)["reused"] is True
    stale = dict(command, expected_current_adoption_id=None)
    with pytest.raises(DomainError) as error:
        service.adopt("p", "req", stale)
    assert error.value.code == "SHOT_REQUIREMENT_IMAGE_ADOPTION_CONFLICT"
    assert service.get("p", "req")["lifecycle"] == "adopted"
    with db.connection() as sql:
        sql.execute("UPDATE assets SET availability='missing' WHERE id=?", (asset_id,))
        assert sql.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0] == 0
    assert service.get("p", "req")["lifecycle"] == "adopted_unavailable"
    links, _ = service.list_links("p", "req")
    adoptions, _ = service.list_adoptions("p", "req")
    assert len(links) == 1 and len(adoptions) == 1
