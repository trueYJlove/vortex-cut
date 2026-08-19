from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
SPEC = importlib.util.spec_from_file_location(
    "stage4d_provider_image_model",
    ROOT / "tools" / "prototypes" / "stage4d_provider_image_model.py",
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def test_prompt_vault_lifecycle() -> None:
    clock = [10.0]
    vault = MODULE.PromptVault(ttl_seconds=2, capacity=1, clock=lambda: clock[0])
    token = vault.put("private prompt")
    with pytest.raises(MODULE.PrototypeError) as capacity_error:
        vault.put("over capacity")
    assert capacity_error.value.code == "PROMPT_VAULT_REJECTED"
    assert "private prompt" not in repr(vault)
    assert vault.reserve(token) == "private prompt"
    with pytest.raises(MODULE.PrototypeError, match="请求未完成"):
        vault.reserve(token)
    vault.release(token)
    assert vault.reserve(token) == "private prompt"
    vault.commit(token)
    assert vault.count() == 0
    token = vault.put("expires")
    clock[0] += 3
    with pytest.raises(MODULE.PrototypeError) as error:
        vault.reserve(token)
    assert error.value.code == "PROMPT_NOT_AVAILABLE"


def test_image_validation_rejects_malformed_and_wrong_dimensions() -> None:
    valid = MODULE.synthetic_png(1024, 1024)
    assert MODULE.validate_image(valid, (1024, 1024))["frames"] == 1
    jpeg = MODULE.synthetic_jpeg(64, 64)
    assert MODULE.validate_image(jpeg, (64, 64))["media_type"] == "image/jpeg"
    cases = [
        (b"<html>bad</html>", (1024, 1024), "PROVIDER_IMAGE_INVALID"),
        (
            MODULE.synthetic_png(1024, 1024, truncate=True),
            (1024, 1024),
            "PROVIDER_IMAGE_INVALID",
        ),
        (
            MODULE.synthetic_png(1024, 1536),
            (1024, 1024),
            "PROVIDER_IMAGE_DIMENSION_MISMATCH",
        ),
        (jpeg[:-1], (64, 64), "PROVIDER_IMAGE_INVALID"),
        (
            b"\x89PNG\r\n\x1a\n" + bytes(MODULE.MAX_RESPONSE_BYTES),
            (1024, 1024),
            "PROVIDER_IMAGE_TOO_LARGE",
        ),
    ]
    for value, expected_size, code in cases:
        with pytest.raises(MODULE.PrototypeError) as error:
            MODULE.validate_image(value, expected_size)
        assert error.value.code == code


def test_stage4d_provider_image_prototype(tmp_path: Path) -> None:
    report = asyncio.run(MODULE.run_prototype(tmp_path, iterations=3))
    assert report["real_provider_call_count"] == 0
    assert report["controlled_fake_call_count"] == 10
    assert all(report["prompt_vault"].values())
    assert all(report["protocol"].values())
    assert report["protocol_observation"] == {
        "method": "POST",
        "url": "https://api.openai.com/v1/images/generations",
        "fields": ["model", "n", "output_format", "prompt", "size"],
        "size": "1024x1024",
        "has_authorization": True,
    }
    assert all(report["image_validation"]["formats"].values())
    assert all(report["image_validation"]["dimensions"].values())
    assert report["migration"]["frozen_versions_verified"] == 12
    assert all(report["migration"]["r1"].values())
    assert all(report["migration"]["r2"].values())
    assert report["migration"]["recommended"] == "r1_rebuild_existing_request"
    assert all(report["asset_registration"].values())
    assert all(report["privacy"].values())
    assert report["performance_ms"]["decode_p95"] <= 1000
