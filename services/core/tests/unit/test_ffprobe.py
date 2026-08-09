from pathlib import Path

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
    assert result["audio_streams"][0]["sample_rate"] == 48000
