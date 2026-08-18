from __future__ import annotations

from pathlib import Path

import pytest
from test_stage3b_reframe import _item, _setup

from aivs_core.projects import DomainError
from aivs_core.rendering.ffmpeg import _reframe_crop_filter, _visual_filter
from aivs_core.rendering.plan import RenderPlanCompiler
from aivs_core.renditions.reframe import RenditionReframeSnapshotService


def test_reframe_plan_v2_freezes_profile_specific_even_crop(tmp_path: Path) -> None:
    database, presets = _setup(tmp_path)
    snapshot = RenditionReframeSnapshotService(database, presets).create_or_reuse(
        "project_1", "rendition_snapshot_1", [_item()]
    )
    compiler = RenderPlanCompiler(database)
    preview = compiler.compile_reframe(
        "project_1",
        "revision_1",
        snapshot["rendition_reframe_snapshot_id"],
        "authoritative_preview",
        reject_draft=True,
    )
    export = compiler.compile_reframe(
        "project_1", "revision_1", snapshot["rendition_reframe_snapshot_id"], "final_export"
    )
    assert preview["schema_version"] == 2
    assert preview["compiler_version"] == "render-plan-reframe-v1"
    assert preview["content_fingerprint"] != export["content_fingerprint"]
    assert preview["segments"][0]["reframe"]["crop_x"] == 1166
    assert export["segments"][0]["reframe"]["crop_x"] == 2334
    assert "reframe" not in preview["segments"][1]
    assert preview["rendition_reframe_snapshot_sha256"] == snapshot["reframe_snapshot_sha256"]


def test_reframe_filter_is_integer_only_and_stage3a_center_filter_is_unchanged() -> None:
    assert _visual_filter("crop_fill", 540, 960, 0) == (
        "scale=540:960:force_original_aspect_ratio=increase,crop=540:960"
    )
    assert _reframe_crop_filter(540, 960, 1166, 0) == (
        "scale=540:960:force_original_aspect_ratio=increase:force_divisible_by=2,"
        "crop=540:960:1166:0"
    )
    with pytest.raises(DomainError) as error:
        _reframe_crop_filter(540, 960, -2, 0)
    assert error.value.code == "RENDER_PLAN_INVALID"
