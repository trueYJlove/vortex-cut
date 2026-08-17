from __future__ import annotations

import json
from pathlib import Path

import pytest

from aivs_core.projects import DomainError
from aivs_core.renditions.presets import RenditionPresetRegistry


def _copy_resources(target: Path) -> Path:
    source = Path.cwd() / "resources"
    for relative in (
        "platform-presets/manifest.json",
        "platform-presets/generic.json",
        "platform-presets/douyin.json",
        "platform-presets/wechat-channels.json",
        "platform-presets/xiaohongshu.json",
        "renditions/manifest.json",
        "renditions/portrait-9x16-v1.json",
        "renditions/landscape-16x9-v1.json",
        "fonts/caption-styles-v2.json",
    ):
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((source / relative).read_bytes())
    return target


def test_stage3a_presets_are_strict_and_renderer_dtos_are_safe(tmp_path: Path) -> None:
    registry = RenditionPresetRegistry(_copy_resources(tmp_path / "resources"))
    registry.load()

    platforms = registry.platform_dto()
    renditions = registry.rendition_dto()
    assert {item["platform_preset_id"] for item in platforms} == {
        "generic",
        "douyin",
        "wechat-channels",
        "xiaohongshu",
    }
    assert {(item["preview"]["width"], item["preview"]["height"]) for item in renditions} == {
        (540, 960),
        (960, 540),
    }
    assert all("path" not in item and "caption" not in item for item in platforms + renditions)

    broken = tmp_path / "resources" / "renditions" / "portrait-9x16-v1.json"
    value = json.loads(broken.read_text(encoding="utf-8"))
    value["unknown"] = True
    broken.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(DomainError):
        RenditionPresetRegistry(tmp_path / "resources").load()
