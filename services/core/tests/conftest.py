from pathlib import Path

import pytest


@pytest.fixture
def tmp_media(tmp_path: Path) -> Path:
    media = tmp_path / "sample 中文 file.mp4"
    media.write_bytes(b"test media")
    return media
