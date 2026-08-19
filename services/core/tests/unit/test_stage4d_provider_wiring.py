from pathlib import Path

from aivs_core.app import CoreState
from aivs_core.config import Settings
from aivs_core.provider_images import ApiKeyFunImagesProvider, FailOnCallImageProvider


def _settings(tmp_path: Path, enabled: bool) -> Settings:
    return Settings(
        data_dir=tmp_path,
        ffmpeg=Path("missing"),
        ffprobe=Path("missing"),
        image_provider_network_enabled=enabled,
    )


def test_stage4d_provider_wiring_is_fail_closed_by_default(tmp_path: Path) -> None:
    state = CoreState(_settings(tmp_path, False))
    assert isinstance(state.provider_image_generation.provider, FailOnCallImageProvider)


def test_stage4d_provider_wiring_requires_explicit_network_flag(tmp_path: Path) -> None:
    state = CoreState(_settings(tmp_path, True))
    assert isinstance(state.provider_image_generation.provider, ApiKeyFunImagesProvider)
