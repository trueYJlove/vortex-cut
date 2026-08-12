from __future__ import annotations

from pathlib import Path

import pytest

import aivs_core.rendering.validation as validation_module
from aivs_core.projects import DomainError
from aivs_core.rendering.validation import validate_rendered_media


class FakeProbe:
    def __init__(self, payload):
        self.payload = payload

    async def probe(self, path):
        return self.payload


def _probe() -> dict:
    return {
        "duration_us": 1_000_000,
        "format_name": "mp4",
        "video_streams": [
            {
                "codec": "h264",
                "width": 540,
                "height": 960,
                "pixel_format": "yuv420p",
                "avg_frame_rate_num": 30,
                "avg_frame_rate_den": 1,
            }
        ],
        "audio_streams": [{"codec": "aac", "sample_rate": 48000, "channels": 2}],
    }


@pytest.mark.asyncio
async def test_validator_returns_normalized_media_and_hash(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "out.mp4"
    output.write_bytes(b"valid")

    async def decoded(ffmpeg, path):
        assert path == output

    monkeypatch.setattr(validation_module, "decode_validate", decoded)
    media, size, digest = await validate_rendered_media(
        Path("ffmpeg"),
        FakeProbe(_probe()),
        output,
        {"width": 540, "height": 960},
        1_000_000,
    )
    assert size == 5
    assert digest.startswith("sha256:")
    assert media["video"]["fps_num"] == 30
    assert media["audio"]["sample_rate"] == 48000


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["streams", "codec", "duration"])
async def test_validator_rejects_invalid_outputs(
    tmp_path: Path, monkeypatch, mutation: str
) -> None:
    output = tmp_path / "out.mp4"
    output.write_bytes(b"invalid")
    probe = _probe()
    if mutation == "streams":
        probe["audio_streams"] = []
    elif mutation == "codec":
        probe["video_streams"][0]["codec"] = "hevc"
    else:
        probe["duration_us"] = 2_000_000

    async def decoded(ffmpeg, path):
        return None

    monkeypatch.setattr(validation_module, "decode_validate", decoded)
    with pytest.raises(DomainError) as exc:
        await validate_rendered_media(
            Path("ffmpeg"),
            FakeProbe(probe),
            output,
            {"width": 540, "height": 960},
            1_000_000,
        )
    assert exc.value.code == "RENDER_VALIDATION_FAILED"
