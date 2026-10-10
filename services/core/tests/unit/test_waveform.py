"""B14 素材级持久化波形单测（聚合器/文件格式/服务作业链/参数白名单）。

覆盖（计划第 6 节 B14 测试要求——纯函数与假 FFmpeg 部分）：
- 聚合：脉冲在已知采样位置、静音、min/max 对保留、2 倍金字塔逐级汇总
  与全量重算 reference 一致；不同时长裁切。
- 文件格式：magic/header 解析、损坏数据 ValueError、层数/偏移换算。
- 服务：缓存键稳定（fingerprint+params+toolchain）、作业登记载荷、
  作业执行全链（假 ffmpeg 可执行文件产 PCM）→ commit ready、
  无音轨 MEDIA_NO_AUDIO、失败 mark_failed、already-ready 短路。
- 帧窗口换算（Renderer 侧用）：sample_index ↔ us。
"""
from __future__ import annotations

import asyncio
import json
import os
import stat
import struct
import sys
from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.media.derived_cache import DerivedMediaCache
from aivs_core.media.waveform import (
    BUCKET,
    CHANNELS,
    SAMPLE_RATE,
    MinMaxAggregator,
    WaveformBuildError,
    WaveformService,
    expected_bytes_for,
    parse_waveform_header,
    read_level_min_max,
    waveform_args,
)


def _db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "b14.db")
    db.initialize()
    return db


def _seed_asset(db: Database, *, with_audio: bool = True) -> dict[str, Any]:
    now = "2026-09-09T00:00:00"
    media_info = {
        "duration_us": 12_000_000,
        "video_streams": [{
            "index": 0, "codec": "h264", "width": 1920, "height": 1080,
            "sample_aspect_ratio_num": 1, "sample_aspect_ratio_den": 1,
            "avg_frame_rate_num": 30, "avg_frame_rate_den": 1, "rotation": 0,
        }],
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
            ("p1", "B14", "active", "{}", None, "/tmp/p1", "p1", now, now, now),
        )
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("asset_b14", "p1", "video", "external", "源.mp4", "sha256:" + "a" * 64,
             1024, "12345", "available", json_dumps(media_info), now, now),
        )
        row = conn.execute("SELECT * FROM assets WHERE id='asset_b14'").fetchone()
    return dict(row)


class _FakeProbe:
    """镜像 FFprobe.probe 语义：require_video=True 且无视频流 → MEDIA_HAS_NO_VIDEO。

    记录每次调用的 require_video 实参，让「波形作业按音轨而不是按视频探测」可断言
    （假探针若只接受 path，就恰好掩盖了纯音频素材必失败的这一类缺陷）。
    """

    def __init__(self, has_audio: bool = True, has_video: bool = True) -> None:
        self.has_audio = has_audio
        self.has_video = has_video
        self.calls: list[bool] = []

    async def probe(self, path: Path, require_video: bool = True) -> dict[str, Any]:
        self.calls.append(require_video)
        if require_video and not self.has_video:
            raise RuntimeError("MEDIA_HAS_NO_VIDEO")
        return {
            "duration_us": 12_000_000,
            "video_streams": (
                [{"index": 0, "codec": "h264", "width": 640, "height": 360,
                  "fps_num": 30, "fps_den": 1}] if self.has_video else []
            ),
            "audio_streams": (
                [{"index": 1, "codec": "aac", "sample_rate": 48000, "channels": 2}]
                if self.has_audio else []
            ),
        }


def _fake_ffmpeg(tmp_path: Path, samples: list[int]) -> Path:
    """可执行假 FFmpeg：按 waveform_args 约定把 s16 PCM 写 stdout。

    参数样式无关（忽略 -i 之外的输入细节）：stdin/stdout 均为管道。
    """
    script = tmp_path / "ffmpeg_waveform.py"
    payload = struct.pack(f"<{len(samples)}h", *samples)
    script.write_text(
        "import sys\n"
        f"sys.stdout.buffer.write({payload!r})\n",
        encoding="utf-8",
    )
    wrapper = tmp_path / ("ffmpeg_waveform" + (".bat" if os.name == "nt" else ".sh"))
    if os.name == "nt":
        wrapper.write_text(f'@"{sys.executable}" "{script}" %*\n', encoding="ascii")
    else:
        sh_line = f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n'
        wrapper.write_text(sh_line, encoding="ascii")
        wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
    return wrapper


def _service(db: Database, tmp_path: Path, ffmpeg: Path,
             has_audio: bool = True, has_video: bool = True) -> WaveformService:
    return WaveformService(
        db, DerivedMediaCache(db, tmp_path / "cache"), ffmpeg, _FakeProbe(has_audio, has_video),
        ffmpeg_build="ffmpeg version 7.0",
    )


# ---- 聚合器 ----


class TestAggregator:
    def test_impulse_at_known_sample(self) -> None:
        agg = MinMaxAggregator()
        impulse_pos = 700  # 第 3 桶内（700 // 256 = 2）
        for i in range(BUCKET * 3):
            agg.feed(1.0 if i == impulse_pos else 0.0)
        info = agg.finish()
        assert info["base_buckets"] == 3
        # 每桶 min/max：静音桶 (0,0)；脉冲桶 (0,1)
        assert agg.base[2] == (0.0, 1.0)
        assert agg.base[0] == (0.0, 0.0)

    def test_silence(self) -> None:
        agg = MinMaxAggregator()
        for _ in range(BUCKET * 2):
            agg.feed(0.0)
        assert agg.finish()["base_buckets"] == 2
        assert agg.base[0] == (0.0, 0.0)

    def test_min_max_pair_retained(self) -> None:
        agg = MinMaxAggregator()
        for i in range(BUCKET):
            # 双极性：min=-0.5, max=0.25（只取正向 peak 会丢 -0.5）
            agg.feed(-0.5 if i % 2 == 0 else 0.25)
        assert agg.base[0] == (-0.5, 0.25)

    def test_pyramid_upsampling_matches_reference(self) -> None:
        """逐级 2 倍汇总 vs 全量重算 reference（逐层一致）。"""
        import random

        rng = random.Random(20260909)
        raw = [rng.uniform(-1, 1) for _ in range(BUCKET * 10)]
        agg = MinMaxAggregator()
        for v in raw:
            agg.feed(v)
        agg.finish()
        levels = agg._levels()  # noqa: SLF001 测试直读金字塔
        # reference：对每层直接从原始样本重算
        for level in range(4):
            factor = BUCKET * (2 ** level)
            buckets_ref: list[tuple[float, float]] = []
            for b in range((len(raw) + factor - 1) // factor):
                window = raw[b * factor:(b + 1) * factor]
                if window:
                    buckets_ref.append((min(window), max(window)))
            got = levels[level]
            assert len(got) == len(buckets_ref)
            for (gmin, gmax), (rmin, rmax) in zip(got, buckets_ref):
                assert gmin == pytest.approx(rmin, abs=1e-7)
                assert gmax == pytest.approx(rmax, abs=1e-7)

    def test_partial_bucket_finished(self) -> None:
        agg = MinMaxAggregator()
        for i in range(BUCKET + 10):
            agg.feed(0.5 if i % 3 == 0 else -0.25)
        info = agg.finish()
        assert info["base_buckets"] == 2  # 1 整桶 + 10 样本尾桶

    def test_write_and_parse_roundtrip(self, tmp_path: Path) -> None:
        agg = MinMaxAggregator()
        for i in range(BUCKET * 5):
            agg.feed((i % 100) / 100.0 - 0.5)
        out = tmp_path / "wf.bin"
        size = agg.write(out)
        data = out.read_bytes()
        assert size == len(data)
        info = parse_waveform_header(data)
        assert info["sample_rate"] == SAMPLE_RATE
        assert info["bucket"] == BUCKET
        assert info["base_buckets"] == 5
        level0 = read_level_min_max(data, info, 0)
        assert len(level0) == 5
        level1 = read_level_min_max(data, info, 1)
        assert len(level1) == 3
        # level1 = base 相邻合并
        for i in range(2):
            merged = level1[i]
            pair_min = min(level0[i * 2][0], level0[i * 2 + 1][0])
            pair_max = max(level0[i * 2][1], level0[i * 2 + 1][1])
            assert merged[0] == pytest.approx(pair_min, abs=1e-7)
            assert merged[1] == pytest.approx(pair_max, abs=1e-7)

    def test_parse_rejects_corrupt_data(self) -> None:
        with pytest.raises(ValueError):
            parse_waveform_header(b"short")
        with pytest.raises(ValueError):
            parse_waveform_header(b"XXXXWF01" + b"\x00" * 16)

    def test_expected_bytes_scales_with_duration(self) -> None:
        one_min = expected_bytes_for(60_000_000)
        one_hour = expected_bytes_for(3_600_000_000)
        assert one_min < one_hour < 16 * 1024 * 1024  # 1 小时全金字塔 < 16MiB


# ---- 服务层 ----


class TestWaveformService:
    def test_cache_key_stable_and_toolchain(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        asset = _seed_asset(db)
        service = _service(db, tmp_path, Path("ffmpeg"))
        key1 = service.waveform_cache_key(asset["fingerprint"])
        key2 = service.waveform_cache_key(asset["fingerprint"])
        assert key1 == key2 and key1.startswith("sha256:")
        # 换 build → 换键
        other = WaveformService(
            db, service.derived_cache, Path("ffmpeg"), _FakeProbe(),
            ffmpeg_build="ffmpeg version 8.0",
        )
        assert other.waveform_cache_key(asset["fingerprint"]) != key1

    def test_params_are_algorithm_constants(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        service = _service(db, tmp_path, Path("ffmpeg"))
        assert service.params() == {
            "sample_rate": str(SAMPLE_RATE), "channels": str(CHANNELS),
            "bucket": str(BUCKET),
        }

    def test_create_job_payload(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        asset = _seed_asset(db)
        service = _service(db, tmp_path, Path("ffmpeg"))
        source = tmp_path / "源.mp4"
        source.write_bytes(b"input")
        job_id = service.create_waveform_job("p1", asset, str(source))
        with db.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        assert row["kind"] == "waveform"
        assert row["resource_class"] == "light"
        payload = json.loads(row["input_json"])
        assert payload["cache_key"] == service.waveform_cache_key(asset["fingerprint"])
        assert payload["size_bytes"] == source.stat().st_size
        assert payload["modified_at"] == source.stat().st_mtime_ns

    @pytest.mark.asyncio
    async def test_run_job_full_pipeline_ready(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        asset = _seed_asset(db)
        # 3 桶 + 尾巴的 PCM（样本值 -32768..32767）
        samples = [0] * BUCKET + [16384, -16384] + [8192] * (BUCKET - 2) + [1000] * 10
        ffmpeg = _fake_ffmpeg(tmp_path, samples)
        service = _service(db, tmp_path, ffmpeg)
        source = tmp_path / "源.mp4"
        source.write_bytes(b"input")
        key = service.waveform_cache_key(asset["fingerprint"])
        payload = {
            "asset_id": "asset_b14", "asset_fingerprint": asset["fingerprint"],
            "cache_key": key, "path": str(source),
            "size_bytes": source.stat().st_size,
            "modified_at": source.stat().st_mtime_ns,
        }
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO jobs (id,project_id,asset_id,kind,type,status,stage,progress,"
                "input_json,encoder_requested,resource_class,attempt,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("job_wf", "p1", "asset_b14", "waveform", "waveform", "running", "running",
                 0, json_dumps(payload), None, "light", 1,
                 "2026-09-09T00:00:00", "2026-09-09T00:00:00"),
            )
        with db.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id='job_wf'").fetchone()
        result = await service.run_waveform_job(row, asyncio.Event())
        assert result["status"] == "ready"
        assert result["sample_rate"] == SAMPLE_RATE
        assert result["base_buckets"] == 3
        entry = service.derived_cache.lookup(key)
        assert entry is not None and entry.status == "ready"
        # 产物可解析：金字塔与输入样本一致
        data = Path(result["path"]).read_bytes()
        info = parse_waveform_header(data)
        level0 = read_level_min_max(data, info, 0)
        assert len(level0) == 3
        assert level0[0] == (0.0, 0.0)
        assert level0[1][1] == pytest.approx(16384 / 32768, abs=1e-6)
        assert level0[1][0] == pytest.approx(-0.5, abs=1e-6)

    @pytest.mark.asyncio
    async def test_run_job_no_audio_rejected(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        asset = _seed_asset(db, with_audio=False)
        ffmpeg = _fake_ffmpeg(tmp_path, [0] * 10)
        service = _service(db, tmp_path, ffmpeg, has_audio=False)
        source = tmp_path / "源.mp4"
        source.write_bytes(b"input")
        key = service.waveform_cache_key(asset["fingerprint"])
        payload = {
            "asset_id": "asset_b14", "asset_fingerprint": asset["fingerprint"],
            "cache_key": key, "path": str(source),
            "size_bytes": source.stat().st_size,
            "modified_at": source.stat().st_mtime_ns,
        }
        row = {"input_json": json_dumps(payload)}
        with pytest.raises(WaveformBuildError) as excinfo:
            await service.run_waveform_job(row, asyncio.Event())
        assert excinfo.value.code == "MEDIA_NO_AUDIO"

    @pytest.mark.asyncio
    async def test_run_job_audio_only_asset_succeeds(self, tmp_path: Path) -> None:
        """纯音频素材（BGM mp3）波形作业必须成功：探测不得要求视频流。

        2026-10-10 真机现场：默认 require_video=True ⇒ 音频素材在探测阶段即
        MEDIA_HAS_NO_VIDEO（路由只按「有音轨」放行）⇒ BGM 波形永远画不出，
        且 UI 每次重进视口都重登记一个必然失败的作业。
        负向对照：还原 probe(input_path)（require_video 默认 True）即本用例红。
        """
        db = _db(tmp_path)
        asset = _seed_asset(db)
        ffmpeg = _fake_ffmpeg(tmp_path, [0] * (BUCKET * 2))
        service = _service(db, tmp_path, ffmpeg, has_video=False)
        source = tmp_path / "bgm.mp3"
        source.write_bytes(b"audio-only-bytes")
        key = service.waveform_cache_key(asset["fingerprint"])
        payload = {
            "asset_id": "asset_b14", "asset_fingerprint": asset["fingerprint"],
            "cache_key": key, "path": str(source),
            "size_bytes": source.stat().st_size,
            "modified_at": source.stat().st_mtime_ns,
        }
        row = {"input_json": json_dumps(payload)}
        result = await service.run_waveform_job(row, asyncio.Event())
        assert result["status"] == "ready"
        assert service.ffprobe.calls == [False], "波形探测必须显式 require_video=False"

    @pytest.mark.asyncio
    async def test_run_job_media_changed(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        asset = _seed_asset(db)
        ffmpeg = _fake_ffmpeg(tmp_path, [0] * 10)
        service = _service(db, tmp_path, ffmpeg)
        source = tmp_path / "源.mp4"
        source.write_bytes(b"input")
        payload = {
            "cache_key": service.waveform_cache_key(asset["fingerprint"]),
            "path": str(source), "size_bytes": 999, "modified_at": 1,
        }
        row = {"input_json": json_dumps(payload)}
        with pytest.raises(WaveformBuildError) as excinfo:
            await service.run_waveform_job(row, asyncio.Event())
        assert excinfo.value.code == "MEDIA_CHANGED"

    @pytest.mark.asyncio
    async def test_run_job_failure_marks_failed(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        asset = _seed_asset(db)
        # 假 ffmpeg 输出为空且非零退出
        script = tmp_path / "wf_fail.py"
        script.write_text("import sys\nsys.stderr.write('boom')\nsys.exit(3)\n", encoding="utf-8")
        wrapper = tmp_path / ("wf_fail" + (".bat" if os.name == "nt" else ".sh"))
        if os.name == "nt":
            wrapper.write_text(f'@"{sys.executable}" "{script}" %*\n', encoding="ascii")
        else:
            sh_line = f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n'
            wrapper.write_text(sh_line, encoding="ascii")
            wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
        service = _service(db, tmp_path, wrapper)
        source = tmp_path / "源.mp4"
        source.write_bytes(b"input")
        key = service.waveform_cache_key(asset["fingerprint"])
        payload = {
            "asset_id": "asset_b14", "asset_fingerprint": asset["fingerprint"],
            "cache_key": key, "path": str(source),
            "size_bytes": source.stat().st_size,
            "modified_at": source.stat().st_mtime_ns,
        }
        row = {"input_json": json_dumps(payload)}
        with pytest.raises(WaveformBuildError) as excinfo:
            await service.run_waveform_job(row, asyncio.Event())
        assert excinfo.value.code == "WAVEFORM_FFMPEG_FAILED"
        entry = service.waveform_entry(asset)
        assert entry is not None and entry["status"] == "failed"

    @pytest.mark.asyncio
    async def test_run_job_already_ready_short_circuits(self, tmp_path: Path) -> None:
        db = _db(tmp_path)
        asset = _seed_asset(db)
        ffmpeg = _fake_ffmpeg(tmp_path, [0] * 10)
        service = _service(db, tmp_path, ffmpeg)
        key = service.waveform_cache_key(asset["fingerprint"])
        root = service.derived_cache.begin_build(
            key, str(asset["fingerprint"]), "waveform",
            service.params(), service.toolchain_fingerprint(),
        )
        assert root is not None
        (root / "waveform.bin").write_bytes(b"ready")
        service.derived_cache.commit_ready(key, "waveform", root / "waveform.bin")
        # 磁盘压力下 enforce_disk_budget() 会 LRU 清掉这条 ready 条目（本机 C 盘
        # 可用 < MIN_FREE_BYTES=2GB 时必然发生）——pin 住它，让用例只测「already-ready
        # 短路 + 载荷缺指纹时回查 DB」这条语义，而不是依赖机器剩余空间。
        service.derived_cache.add_reference(key, "p1", "asset_b14")
        source = tmp_path / "源.mp4"
        source.write_bytes(b"src")
        payload = {"cache_key": key, "path": str(source)}
        row = {"input_json": json_dumps(payload)}
        result = await service.run_waveform_job(row, asyncio.Event())
        assert result["status"] == "already-ready"

    def test_waveform_args_whitelist(self) -> None:
        args = waveform_args("some/input.mp4")
        assert args[0:3] == ["-hide_banner", "-nostdin", "-y"]
        assert "-vn" in args and "-map" in args
        assert args[args.index("-ac") + 1] == "1"
        assert args[args.index("-ar") + 1] == "8000"
        assert args[args.index("-c:a") + 1] == "pcm_s16le"
        assert args[args.index("-f") + 1] == "s16le"
        assert args[-1] == "pipe:1"


class TestJobsDispatch:
    def test_run_media_dispatches_waveform_kind(self, tmp_path: Path) -> None:
        """jobs._run_media 按 kind=waveform 分派 B14（不走 B11 代理/旧 sample）。"""
        from aivs_core.jobs import JobService

        db = _db(tmp_path)
        state: dict[str, Any] = {}
        _seed_asset(db)

        class FakeEncoders:
            async def choose(self, mode: str) -> tuple[str, None]:
                return "libx264", None

        class FakeProbe:
            async def probe(self, path: Path) -> dict[str, Any]:
                return {"audio_streams": [], "duration_us": 1}

        async def emit(_event: dict[str, Any]) -> None:
            return None

        async def fake_waveform_runner(row, cancel_event, progress, stage) -> dict[str, Any]:
            state["called"] = json.loads(row["input_json"])
            return {"cache_key": "sha256:" + "c" * 64, "status": "ready"}

        service = JobService(
            db, tmp_path, Path("ffmpeg"), FakeProbe(), FakeEncoders(), emit,
            waveform_runner=fake_waveform_runner,
        )
        # 载荷带 cache_key（会先命中 B11 分支的形状）——kind=waveform 必须优先
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO jobs (id,project_id,kind,type,status,stage,progress,input_json,"
                "encoder_requested,attempt,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                ("job_b14", "p1", "waveform", "waveform", "running", "running", 0,
                 json_dumps({"cache_key": "sha256:" + "c" * 64, "asset_id": "asset_b14"}),
                 None, 1, "2026-09-09T00:00:00", "2026-09-09T00:00:00"),
            )
        with db.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id='job_b14'").fetchone()

        async def fake_render_media(*_a: Any, **_k: Any) -> dict[str, Any]:
            raise AssertionError("旧 sample 路径不应被触达")

        import aivs_core.jobs as jobs_module

        original = jobs_module.render_media
        jobs_module.render_media = fake_render_media
        try:
            asyncio.run(service._run_media(row, "job_b14", asyncio.Event()))
        finally:
            jobs_module.render_media = original
        assert state["called"]["cache_key"].startswith("sha256:")
        with db.connection() as conn:
            saved = conn.execute(
                "SELECT result_json FROM jobs WHERE id='job_b14'").fetchone()
        assert json.loads(saved["result_json"])["status"] == "ready"
