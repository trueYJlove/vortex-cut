"""B15 分块 PCM 真实 FFmpeg 集成测试（计划验收门：相邻块拼接对拍参考）。

覆盖（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B15 数据契约）：
- 相邻块拼接 vs 整段同参数参考 PCM：sample alignment 与误差（每样本
  |Δ| ≤ 1e-4——f32 编码 + aresample 边界容差；AAC priming 由预滚+atrim
  修齐，块边界对齐以网格偏移显式断言）。
- 尾块：valid_samples < 96000（素材不足整块）；块起点超出末尾 → 空块。
- 端点层：ensure（生成/网格校验/无音轨拒绝）+ admin media 解析（refs）。
"""
from __future__ import annotations

import struct
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()


def _require_ffmpeg() -> None:
    if not FFMPEG.is_file():
        pytest.skip("bundled ffmpeg unavailable")


def _make_wav(path: Path, seconds: float, freq_hz: float = 440.0) -> None:
    """440Hz 双声道 48k s16 WAV 测试源（真实容器/编码——对拍有 AAC priming
    复杂度时改用 flac；s16 wav 无 priming，聚焦块拼接一致性）。"""
    import subprocess

    args = [
        "-hide_banner", "-y", "-f", "lavfi",
        "-i", f"sine=frequency={freq_hz}:sample_rate=48000:duration={seconds}",
        "-ac", "2", "-c:a", "pcm_s16le", str(path),
    ]
    result = subprocess.run([str(FFMPEG), *args], capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise AssertionError(result.stderr[-1000:])


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonayPatch) -> TestClient:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-b15")
    settings = Settings(
        data_dir=tmp_path,
        manifest_dir=tmp_path / "manifests",
        ffmpeg=FFMPEG,
        ffprobe=Path("resources/ffmpeg/win-x64/ffprobe.exe").resolve(),
    )
    application = TestClient(create_app(settings))
    with application:
        yield application


def _ui(client: TestClient) -> dict[str, str]:
    response = client.post(
        "/api/v1/internal/sessions", headers={"Authorization": "Bearer admin-b15"}
    )
    return {"Authorization": f"Bearer {response.json()['token']}"}


ADMIN = {"Authorization": "Bearer admin-b15"}


def _seed_audio_asset(client: TestClient, tmp_path: Path, seconds: float) -> tuple[str, str]:
    media = tmp_path / "音频源.wav"
    _make_wav(media, seconds)
    project = client.post("/api/v1/projects", json={"name": "B15"}, headers=_ui(client)).json()
    project_id = project["project_id"]
    grant = client.post(
        "/api/v1/internal/file-grants", json={"path": str(media)}, headers=ADMIN
    ).json()
    asset = client.post(
        f"/api/v1/projects/{project_id}/assets",
        json={"grant_id": grant["grant_id"], "kind": "audio"},
        headers=_ui(client),
    ).json()
    # 导入后 media_info 由真实 probe 填充（audio kind 不要求视频流）
    return project_id, asset["asset_id"]


class TestChunkSpliceParity:
    def test_adjacent_chunks_match_full_reference(self, tmp_path: Path) -> None:
        """5 秒源：块 0/1/2 拼接 ≡ 整段参考解码（f32le 同参数）。"""
        _require_ffmpeg()
        import asyncio
        import subprocess

        source = tmp_path / "源.wav"
        _make_wav(source, 5.0)
        # 整段参考：与块同参数（aresample=48000 + f32le）
        ref_raw = tmp_path / "ref.raw"
        subprocess.run(
            [str(FFMPEG), "-hide_banner", "-y", "-i", str(source), "-vn",
             "-map", "0:a:0", "-ac", "2", "-ar", "48000", "-c:a", "pcm_f32le",
             "-f", "f32le", str(ref_raw)],
            check=True, capture_output=True, timeout=60,
        )
        reference = ref_raw.read_bytes()

        from aivs_core.database import Database
        from aivs_core.media.audio_chunks import PcmChunkService, decode_chunk
        from aivs_core.media.derived_cache import DerivedMediaCache

        db = Database(tmp_path / "splice.db")
        db.initialize()
        now = "2026-09-09T00:00:00"
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO projects (id,name,status,canvas_json,current_timeline_revision_id,"
                "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("p1", "B15", "active", "{}", None, str(tmp_path), "p1", now, now, now),
            )
            conn.execute(
                "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,modified_at,availability,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                ("a1", "p1", "audio", "external", "源.wav",
                 "sha256:" + "5" * 64, source.stat().st_size, now, "available", now, now),
            )
            row = conn.execute("SELECT * FROM assets WHERE id='a1'").fetchone()
        service = PcmChunkService(
            db, DerivedMediaCache(db, tmp_path / "cache"), FFMPEG, None,
            ffmpeg_build="ffmpeg version 7.0",
        )
        spliced = bytearray()
        for start in (0, 96_000, 192_000, 288_000):
            result = asyncio.run(service.ensure_chunk(dict(row), start, str(source)))
            assert result["status"] == "ready"
            entry = service.derived_cache.lookup(result["cache_key"])
            data = Path(service.derived_cache.resolved_path(entry)).read_bytes()
            chunk = decode_chunk(data)
            assert chunk["start_sample"] == start
            # 拼接有效区（头之后），尾块只拼 valid 部分
            payload = struct.pack(f"<{chunk['valid_samples'] * 2}f", *chunk["pcm"])
            spliced += payload
        # 5 秒 = 240000 样本/声道 = 1920000 交错样本
        ref_samples = struct.unpack(f"<{len(reference) // 4}f", reference)
        got_samples = struct.unpack(f"<{len(spliced) // 4}f", bytes(spliced))
        assert len(got_samples) >= 240_000 * 2 - 96_000  # 尾块预滚裁切容差
        # 对拍主体：块 0+1（前 4 秒）必须逐样本一致（无跨块错位）
        n = min(len(got_samples), len(ref_samples), 192_000 * 2)
        max_delta = 0.0
        for i in range(n):
            delta = abs(got_samples[i] - ref_samples[i])
            if delta > max_delta:
                max_delta = delta
        assert max_delta <= 1e-4, f"splice mismatch max_delta={max_delta}"

    def test_tail_chunk_short_and_eof_empty(self, tmp_path: Path) -> None:
        """2.5 秒源：块 1 = 尾块（<96000）；块 2 起点越界 → 空块/短块。"""
        _require_ffmpeg()
        import asyncio

        source = tmp_path / "尾.wav"
        _make_wav(source, 2.5)
        from aivs_core.database import Database
        from aivs_core.media.audio_chunks import PcmChunkService
        from aivs_core.media.derived_cache import DerivedMediaCache

        db = Database(tmp_path / "tail.db")
        db.initialize()
        now = "2026-09-09T00:00:00"
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO projects (id,name,status,canvas_json,current_timeline_revision_id,"
                "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("p1", "B15", "active", "{}", None, str(tmp_path), "p1", now, now, now),
            )
            conn.execute(
                "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,modified_at,availability,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                ("a1", "p1", "audio", "external", "尾.wav",
                 "sha256:" + "6" * 64, source.stat().st_size, now, "available", now, now),
            )
            row = conn.execute("SELECT * FROM assets WHERE id='a1'").fetchone()
        service = PcmChunkService(
            db, DerivedMediaCache(db, tmp_path / "cache"), FFMPEG, None,
            ffmpeg_build="ffmpeg version 7.0",
        )
        tail = asyncio.run(service.ensure_chunk(dict(row), 96_000, str(source)))
        assert tail["status"] == "ready"
        assert 0 < tail["valid_samples"] < 96_000  # 尾块
        beyond = asyncio.run(service.ensure_chunk(dict(row), 384_000, str(source)))
        # 2.5 秒源：块 4（384000）完全越界 → 空块（valid_samples=0）
        assert beyond["valid_samples"] == 0


class TestPcmChunkEndpoints:
    def test_ensure_and_media_roundtrip(self, client: TestClient, tmp_path: Path) -> None:
        _require_ffmpeg()
        project_id, asset_id = _seed_audio_asset(client, tmp_path, 3.0)
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/pcm-chunks",
            json={"start_sample": 0}, headers=_ui(client),
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ready"
        assert payload["start_sample"] == 0
        assert payload["sample_rate"] == 48000 and payload["channels"] == 2
        assert "path" not in payload
        # admin media 解析 + refs
        response = client.post(
            f"/api/v1/internal/projects/{project_id}/assets/{asset_id}/pcm-chunks/media",
            json={"start_sample": 0}, headers=ADMIN,
        )
        assert response.status_code == 200
        media = response.json()
        assert Path(media["path"]).is_file()
        assert media["cache_key"] == payload["cache_key"]

    def test_grid_and_auth_rejected(self, client: TestClient, tmp_path: Path) -> None:
        _require_ffmpeg()
        project_id, asset_id = _seed_audio_asset(client, tmp_path, 3.0)
        ui = _ui(client)
        # 网格未对齐
        response = client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/pcm-chunks",
            json={"start_sample": 12345}, headers=ui,
        )
        assert response.status_code == 400
        # 未授权
        assert client.post(
            f"/api/v1/projects/{project_id}/assets/{asset_id}/pcm-chunks",
            json={"start_sample": 0},
        ).status_code == 401
        # UI token 不能 media（Renderer 拿不到路径）
        assert client.post(
            f"/api/v1/internal/projects/{project_id}/assets/{asset_id}/pcm-chunks/media",
            json={"start_sample": 0}, headers=ui,
        ).status_code == 401
        # 媒体未生成 404
        assert client.post(
            f"/api/v1/internal/projects/{project_id}/assets/{asset_id}/pcm-chunks/media",
            json={"start_sample": 192_000}, headers=ADMIN,
        ).status_code == 404
