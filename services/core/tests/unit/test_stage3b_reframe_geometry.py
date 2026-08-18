from __future__ import annotations

from fractions import Fraction

import pytest

from aivs_core.projects import DomainError
from aivs_core.renditions.reframe import (
    DisplayGeometry,
    crop_window,
    display_geometry,
    normalize_adjustment,
)


def test_display_geometry_normalizes_sar_and_rotation_exactly() -> None:
    normal = display_geometry(
        {
            "width": 720,
            "height": 576,
            "sample_aspect_ratio_num": 16,
            "sample_aspect_ratio_den": 15,
            "rotation": 0,
        }
    )
    assert normal == DisplayGeometry(Fraction(768), Fraction(576))
    rotated = display_geometry(
        {
            "width": 720,
            "height": 576,
            "sample_aspect_ratio_num": 16,
            "sample_aspect_ratio_den": 15,
            "rotation": 90,
        }
    )
    assert rotated == DisplayGeometry(Fraction(576), Fraction(768))


def test_crop_window_is_deterministic_even_and_clamped() -> None:
    geometry = DisplayGeometry(Fraction(1920), Fraction(1080))
    left = crop_window(geometry, 1080, 1920, "left", "center")
    right = crop_window(geometry, 1080, 1920, "right", "center")
    assert (left.scaled_width, left.scaled_height) == (3414, 1920)
    assert (left.x, right.x) == (0, 2334)
    assert all(value % 2 == 0 for value in (left.x, right.x))
    assert right.x + right.width <= right.scaled_width


def test_axis_without_overflow_normalizes_and_no_effect_is_rejected() -> None:
    geometry = DisplayGeometry(Fraction(1920), Fraction(1080))
    assert normalize_adjustment(geometry, 1080, 1920, "left", "top") == ("left", "center", True)
    with pytest.raises(DomainError) as error:
        normalize_adjustment(geometry, 1080, 1920, "center", "top")
    assert error.value.code == "REFRAME_NOT_APPLICABLE"


@pytest.mark.parametrize(
    "stream",
    [
        {},
        {"width": 0, "height": 1},
        {"width": 1, "height": 1, "sample_aspect_ratio_num": 0},
        {"width": 1, "height": 1, "rotation": 45},
    ],
)
def test_invalid_display_geometry_fails_closed(stream: dict[str, int]) -> None:
    with pytest.raises(DomainError) as error:
        display_geometry(stream)
    assert error.value.code == "REFRAME_NOT_APPLICABLE"
