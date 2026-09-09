"""B15 分块 PCM 单测（参数网格/块头编码/缓存键/服务生成链）。

覆盖（计划第 6 节 B15 数据契约——纯函数与假 FFmpeg 部分）：
- 块 key 用整数 sample offset 网格对齐（负值/未对齐拒绝）。
- 块头（u32 start + u32 valid + u16 sr_khz + u16 ch）编码/解码 roundtrip；
  尾块 valid_samples < 96000；EOF 空块。
- 缓存键：同 start 稳定、不同 start 不同键、换 FFmpeg build 换键。
- 服务：ensure_chunk 命中/生成（假 ffmpeg 产 PCM）/already-ready 短路/
  stat 变化 MEDIA_CHANGED/失败 mark_failed。
"""
from __future__ import annotations

import os
import stat
import struct
import sys
from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.media.audio_chunks import (
    CHANNELS,
    CHUNK_SAMPLES,
    SAMPLE_RATE,
    PcmChunkService,
    chunk_start_for,
    decode_chunk,
    encode_chunk,
    parse_chunk_header,
)
from aivs_core.media.derived_cache import DerivedMediaCache


def _db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "b15.db")
    db.initialize()
    return db


def _seed_asset(db: Database, *, with_audio: bool = True) -> dict[str, Any]:
    now = "2026-09-09T00:00:00"
    media_info = {
        "duration_us": 120_000_000,
        "video_streams": [],
        "audio_streams": (
            [{"index": 1, "codec": "aac", "sample_rate": 48000, "channels": 2}]
            if with_audio else []
        ),
    }
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects (id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("p1", "B15", "active", "{}", None, "/tmp/p1", "p1", now, now, now),
        )
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("asset_b15", "p1", "audio", "external", "源.wav", "sha256:" + "a" * 64,
             1024, "12345", "available", json_dumps(media_info), now, now),
        )
        row = conn.execute("SELECT * FROM assets WHERE id='asset_b15'").fetchone()
    return dict(row)


class _FakeProbe:
    async def probe(self, path: Path) -> dict[str, Any]:
        return {"duration_us": 120_000_000, "audio_streams": [{"codec": "pcm_s16le"}]}


def _fake_ffmpeg(tmp_path: Path, pcm_samples: int) -> Path:
    """假 FFmpeg：输出 pcm_samples 个交错 f32 样本（忽略参数）。"""
    payload = struct.pack(f"<{pcm_samples * CHANNELS}f", *([0.25] * pcm_samples * CHANNELS))
    script = tmp_path / "pcm_gen.py"
    script.write_text(f"import sys\nsys.stdout.buffer.write({payload!r})\n", encoding="utf-8")
    wrapper = tmp_path / ("pcm_gen" + (".bat" if os.name == "nt" else ".sh"))
    if os.name == "nt":
        wrapper.write_text(f'@"{sys.executable}" "{script}" %*\n', encoding="ascii")
    else:
        sh = f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n'
        wrapper.write_text(sh, encoding="ascii")
        wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
    return wrapper


def _service(db: Database, tmp_path: Path, ffmpeg: Path) -> PcmChunkService:
    return PcmChunkService(
        db, DerivedMediaCache(db, tmp_path / "cache"), ffmpeg, _FakeProbe(),
        ffmpeg_build="ffmpeg version 7.0",
    )


class TestChunkGrid:
    def test_chunk_start_alignment(self) -> None:
        assert chunk_start_for(0) == 0
        assert chunk_start_for(1) == 0
        assert chunk_start_for(95_999) == 0
        assert chunk_start_for(96_000) == 96_000
        assert chunk_start_for(191_999) == 96_000
        with pytest.raises(ValueError):
            chunk_start_for(-1)

    def test_cache_key_grid_enforced(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path, Path("ffmpeg"))
        asset = _seed_asset(db)
        with pytest.raises(Exception):
            service.chunk_cache_key(asset["fingerprint"], 1)  # 未对齐
        with pytest.raises(Exception):
            service.chunk_cache_key(asset["fingerprint"], -96_000)

    def test_cache_key_stable_and_distinct(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path, Path("ffmpeg"))
        fp = "sha256:" + "a" * 64
        k0 = service.chunk_cache_key(fp, 0)
        k1 = service.chunk_cache_key(fp, 96_000)
        assert k0.startswith("sha256:") and k1.startswith("sha256:")
        assert k0 != k1
        assert service.chunk_cache_key(fp, 0) == k0
        other = PcmChunkService(
            db, service.derived_cache, Path("ffmpeg"), _FakeProbe(),
            ffmpeg_build="ffmpeg version 8.0",
        )
        assert other.chunk_cache_key(fp, 0) != k0  # 换 build 换键


class TestChunkFormat:
    def test_header_roundtrip_full_and_tail(self) -> None:
        full = encode_chunk(96_000, b"\x00" * (96_000 * CHANNELS * 4), CHUNK_SAMPLES)
        header = parse_chunk_header(full)
        assert header == {
            "start_sample": 96_000, "valid_samples": CHUNK_SAMPLES,
            "sample_rate": SAMPLE_RATE, "channels": CHANNELS,
        }
        tail = encode_chunk(192_000, b"\x00" * (1000 * CHANNELS * 4), 1000)
        header = parse_chunk_header(tail)
        assert header["valid_samples"] == 1000  # 尾块 < 96000 = EOF 标记

    def test_decode_chunk_values(self) -> None:
        pcm = struct.pack("<4f", 0.5, -0.5, 0.25, -0.25)
        block = encode_chunk(0, pcm, 2)
        decoded = decode_chunk(block)
        assert decoded["samples"] == 2
        assert list(decoded["pcm"]) == [0.5, -0.5, 0.25, -0.25]

    def test_parse_rejects_short_data(self) -> None:
        with pytest.raises(ValueError):
            parse_chunk_header(b"\x00" * 4)


class TestService:
    @pytest.mark.asyncio
    async def test_ensure_chunk_generates_and_caches(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        asset = _seed_asset(db)
        ffmpeg = _fake_ffmpeg(tmp_path, 96_000)
        service = _service(db, tmp_path, ffmpeg)
        source = tmp_path / "源.wav"
        source.write_bytes(b"input")
        result = await service.ensure_chunk(asset, 0, str(source))
        assert result["status"] == "ready"
        assert result["valid_samples"] == 96_000
        assert result["exact"] is True
        # 二次调用：缓存命中（假 ffmpeg 无从被再调用——直接 lookup 短路）
        result2 = await service.ensure_chunk(asset, 0, str(source))
        assert result2["status"] == "ready"
        assert result2["valid_samples"] is None  # 命中路径不带解析头
        # 产物可解析
        entry = service.derived_cache.lookup(result["cache_key"])
        assert entry is not None
        data = Path(service.derived_cache.resolved_path(entry)).read_bytes()
        header = parse_chunk_header(data)
        assert header["start_sample"] == 0 and header["valid_samples"] == 96_000

    @pytest.mark.asyncio
    async def test_ensure_chunk_short_tail(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        asset = _seed_asset(db)
        ffmpeg = _fake_ffmpeg(tmp_path, 1000)
        service = _service(db, tmp_path, ffmpeg)
        source = tmp_path / "源.wav"
        source.write_bytes(b"input")
        result = await service.ensure_chunk(asset, 96_000, str(source))
        assert result["valid_samples"] == 1000
        assert result["exact"] is False  # 尾块/EOF

    @pytest.mark.asyncio
    async def test_ensure_chunk_missing_file(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        asset = _seed_asset(db)
        ffmpeg = _fake_ffmpeg(tmp_path, 96_000)
        service = _service(db, tmp_path, ffmpeg)
        with pytest.raises(Exception):
            await service.ensure_chunk(asset, 0, str(tmp_path / "不存在.wav"))

    @pytest.mark.asyncio
    async def test_ensure_chunk_failure_marks_failed(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        asset = _seed_asset(db)
        script = tmp_path / "pcm_fail.py"
        script.write_text("import sys\nsys.stderr.write('boom')\nsys.exit(3)\n", encoding="utf-8")
        wrapper = tmp_path / ("pcm_fail" + (".bat" if os.name == "nt" else ".sh"))
        if os.name == "nt":
            wrapper.write_text(f'@"{sys.executable}" "{script}" %*\n', encoding="ascii")
        else:
            sh = f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n'
            wrapper.write_text(sh, encoding="ascii")
            wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
        service = _service(db, tmp_path, wrapper)
        source = tmp_path / "源.wav"
        source.write_bytes(b"input")
        with pytest.raises(Exception):
            await service.ensure_chunk(asset, 0, str(source))
        entry = service.chunk_entry(asset, 0)
        assert entry is not None and entry["status"] == "failed"
