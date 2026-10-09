"""P30：`ffmpeg -decoders` 能力数据源 + FFmpeg build 指纹失效重探（规划门 §2.5/§5）。

- 探测结果带 probed_at + ffmpeg_fingerprint；
- 指纹变化（换 FFmpeg）即重探，同指纹走进程内缓存（Core 重启即重探）；
- DecodeFramesRequest 契约（§2.5）：ticket_ref 必填 + 格式 + 窗口上限。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from aivs_core.app import DecodeFramesRequest
from aivs_core.media.decode_capability import DecodeCapabilityProbe

GOOD_TICKET = "aivideo://media/" + "A" * 32

DECODERS_OUTPUT = """Decoders:
 V....D h264                 H.264 / AVC / MPEG-4 AVC (decoders: h264 h264_cuvid)
 V....D hevc                 H.265 / HEVC (decoders: hevc hevc_cuvid)
 V....D av1                  Alliance for Open Media AV1 (decoders: av1 libdav1d)
 VFS..D wrapped_avframe      AVFrame to AVPacket passthrough
 A....D mp3                  MP3 (MPEG audio layer 3)
"""


def _runner_factory(version: str = "ffmpeg version 6.1-test"):
    calls: list[str] = []

    def runner(args: list[str]) -> str:
        calls.append(args[1])
        return version if args[1] == "-version" else DECODERS_OUTPUT

    return runner, calls


def test_probe_returns_decoders_with_fingerprint_and_probed_at() -> None:
    runner, calls = _runner_factory()
    probe = DecodeCapabilityProbe("ffmpeg-x", runner)
    result = probe.get()
    assert result["decoders"] == {"avc": True, "hevc": True, "av1": True}
    assert result["probed_at"].endswith("Z")
    assert result["ffmpeg_fingerprint"].startswith("sha256:")
    assert calls == ["-version", "-decoders"]


def test_same_fingerprint_reuses_cache() -> None:
    runner, calls = _runner_factory()
    probe = DecodeCapabilityProbe("ffmpeg-x", runner)
    probe.get()
    probe.get()
    # 每次 get 都验指纹（-version）；同指纹只在首探测一次 -decoders。
    assert calls == ["-version", "-decoders", "-version"]


def test_fingerprint_change_triggers_reprobe() -> None:
    versions = ["ffmpeg version 6.1", "ffmpeg version 7.0"]
    calls: list[str] = []

    def runner(args: list[str]) -> str:
        calls.append(args[1])
        return versions[0] if args[1] == "-version" else DECODERS_OUTPUT

    probe = DecodeCapabilityProbe("ffmpeg-x", runner)
    probe.get()
    versions[0] = "ffmpeg version 7.0"
    result = probe.get()
    assert calls == ["-version", "-decoders", "-version", "-decoders"], "换 FFmpeg 必须重探"
    assert result["ffmpeg_fingerprint"].startswith("sha256:")


def test_decoder_parsing_ignores_header_and_non_video_lines() -> None:
    runner, _calls = _runner_factory()
    result = DecodeCapabilityProbe("ffmpeg-x", runner).get()
    # 别名并集计入；表头/音频/包装行不误计（av1 由 libdav1d 别名兜住）
    assert result["decoders"]["av1"] is True


def test_decode_frames_request_requires_ticket_ref() -> None:
    with pytest.raises(ValidationError):
        DecodeFramesRequest(frame_numbers=[0], fps=30.0)


def test_decode_frames_request_rejects_malformed_ticket() -> None:
    with pytest.raises(ValidationError):
        DecodeFramesRequest(frame_numbers=[0], fps=30.0, ticket_ref="aivideo://media/short")
    with pytest.raises(ValidationError):
        DecodeFramesRequest(frame_numbers=[0], fps=30.0, ticket_ref="file:///etc/passwd")


def test_decode_frames_request_enforces_window_cap() -> None:
    with pytest.raises(ValidationError):
        DecodeFramesRequest(frame_numbers=list(range(33)), fps=30.0, ticket_ref=GOOD_TICKET)
    ok = DecodeFramesRequest(frame_numbers=list(range(32)), fps=23.976, ticket_ref=GOOD_TICKET)
    assert ok.frame_numbers[-1] == 31
    assert ok.fps == 23.976


def test_decode_capability_endpoint_serves_probe_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from aivs_core.app import create_app
    from aivs_core.config import Settings

    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-cap")
    app = create_app(Settings(data_dir=tmp_path, ffmpeg=Path("ffmpeg-x"), ffprobe=Path("ffprobe-x")))
    client = TestClient(app)
    client.__enter__()
    try:
        admin = {"Authorization": "Bearer admin-cap"}
        ui = {"Authorization": f"Bearer {client.post('/api/v1/internal/sessions', headers=admin).json()['token']}"}
        runner, calls = _runner_factory()
        app.state.core.decode_capability_probe = DecodeCapabilityProbe("ffmpeg-x", runner)
        page = client.get("/api/v1/decode-capability", headers=ui)
        assert page.status_code == 200
        body = page.json()
        assert body["decoders"] == {"avc": True, "hevc": True, "av1": True}
        assert body["ffmpeg_fingerprint"].startswith("sha256:")
        assert calls == ["-version", "-decoders"]
    finally:
        client.__exit__(None, None, None)
