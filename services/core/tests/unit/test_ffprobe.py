from pathlib import Path

import pytest

from aivs_core.media import ffprobe
from aivs_core.media.ffprobe import duration_us, normalize_probe, parse_fraction


def test_fraction_and_duration_are_exact_enough() -> None:
    assert parse_fraction("60000/1001") == (60000, 1001)
    assert parse_fraction("N/A") == (0, 1)
    assert duration_us("10.123456") == 10_123_456


def test_probe_normalizes_video_audio_and_rotation(tmp_path: Path) -> None:
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"x")
    payload = {
        "format": {"format_name": "mp4", "duration": "2.5"},
        "streams": [
            {
                "index": 0,
                "codec_type": "video",
                "codec_name": "h264",
                "width": 1920,
                "height": 1080,
                "avg_frame_rate": "60000/1001",
                "sample_aspect_ratio": "4:3",
                "pix_fmt": "yuv420p",
                "tags": {"rotate": "90"},
            },
            {
                "index": 1,
                "codec_type": "audio",
                "codec_name": "aac",
                "sample_rate": "48000",
                "channels": 2,
            },
        ],
    }
    result = normalize_probe(payload, path)
    assert result["duration_us"] == 2_500_000
    assert result["video_streams"][0]["rotation"] == 90
    assert result["video_streams"][0]["sample_aspect_ratio_num"] == 4
    assert result["video_streams"][0]["sample_aspect_ratio_den"] == 3
    assert result["audio_streams"][0]["sample_rate"] == 48000


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("result", "error"),
    [
        (TimeoutError(), "MEDIA_PROBE_TIMEOUT"),
        (FileNotFoundError(), "FFMPEG_NOT_FOUND"),
    ],
)
async def test_probe_maps_process_errors(monkeypatch, tmp_path: Path, result, error) -> None:
    async def fake_run(*_args, **_kwargs):
        raise result

    monkeypatch.setattr(ffprobe, "run_process", fake_run)
    with pytest.raises(RuntimeError, match=error):
        await ffprobe.FFprobe(Path("ffprobe")).probe(tmp_path / "input.mp4")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("returncode", "stdout", "error"),
    [
        (1, "{}", "MEDIA_UNSUPPORTED"),
        (0, "not-json", "MEDIA_UNSUPPORTED"),
        (0, '{"format": {"duration": "1"}, "streams": []}', "MEDIA_HAS_NO_VIDEO"),
    ],
)
async def test_probe_maps_invalid_ffprobe_results(
    monkeypatch, tmp_path: Path, returncode: int, stdout: str, error: str
) -> None:
    async def fake_run(*_args, **_kwargs):
        return type("Result", (), {"returncode": returncode, "stdout": stdout})()

    path = tmp_path / "input.mp4"
    path.write_bytes(b"input")
    monkeypatch.setattr(ffprobe, "run_process", fake_run)
    with pytest.raises(RuntimeError, match=error):
        await ffprobe.FFprobe(Path("ffprobe")).probe(path)


def test_probe_helpers_handle_missing_values(tmp_path: Path) -> None:
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"x")
    assert parse_fraction(None) == (0, 1)
    assert parse_fraction("bad") == (0, 1)
    assert duration_us(None) == 0
    result = normalize_probe(
        {
            "format": {},
            "streams": [
                {
                    "codec_type": "video",
                    "avg_frame_rate": "bad",
                    "side_data_list": [{"rotation": "bad"}],
                },
                {"codec_type": "audio"},
            ],
        },
        path,
    )
    assert result["video_streams"][0]["rotation"] == 0
    assert result["audio_streams"][0]["sample_rate"] == 0
