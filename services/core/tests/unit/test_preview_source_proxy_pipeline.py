"""B11 全源代理生成链路端到端回归锁：登记 → 真转码 → 产物 ready → describe。

为什么放在 unit/：pnpm test:python 的目标清单只含 services/core/tests/unit 与
integration/test_*_routes.py（tools/ci/run_pytest_gate.py）。放进 integration/ 就
不进 CI，而这次要钉住的缺陷恰恰是「代理从未被真正生成」——它在只替换
render_media 的用例（tests/unit/test_preview_source.py 的 _FakeRenderMedia）下
可以长期潜伏：编排分支全绿，真实 FFmpeg 一步都没跑过。

分工：test_preview_source.py 验编排分支/缓存键/FFmpeg 参数（转码替身）；本文件用
**真实 FFmpeg** 跑通整链，钉住四件事：
1. create_proxy_job 登记 queued 作业，且此时不写派生缓存行（queued 状态由 jobs
   表承载——proxy_entry 只查 derived_media_cache，见 preview_source.py 的两段）；
2. run_proxy_job 真转码后 proxy_entry 变 ready，产物文件存在且大小 > 0；
3. describe(asset, "auto", proxy=ready_entry) 返回 mode="proxy" 且带 cache_key；
4. 同素材重复登记 → begin_build 命中（already-ready），不重复转码。

环境约束（本仓实测）：
- 随包 FFmpeg 无 libx264/libx265；编码器显式 pin libopenh264（软件编码，CI 无 GPU，
  不能落到 h264_nvenc/qsv/amf）。
- 素材用仓库已跟踪的 test-assets/test-faststart.mp4（640x360/30fps/2s），先裁出前
  30 帧（1 秒）当输入，把真实转码压在秒级。
- 离线：整链只读本地文件 + 本机 FFmpeg，无网络、无 GPU。
"""
from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.media.derived_cache import DerivedMediaCache
from aivs_core.media.encoders import EncoderDetector
from aivs_core.media.ffprobe import FFprobe
from aivs_core.media.preview_source import PreviewSourceService

REPO_ROOT = Path(__file__).resolve().parents[4]
FFMPEG = REPO_ROOT / "resources/ffmpeg/win-x64/ffmpeg.exe"
FFPROBE = REPO_ROOT / "resources/ffmpeg/win-x64/ffprobe.exe"
TRACKED_SOURCE = REPO_ROOT / "test-assets/test-faststart.mp4"

# 随包 ffmpeg 不入库（见 ci.yml：工作流跑 pytest 前先按 manifest 取回）。缺失即跳过，
# 与 tests/unit/test_keyframe_encode.py 同一惯例；CI 上该跳过会被 skip 守卫判红。
pytestmark = pytest.mark.skipif(
    not (FFMPEG.is_file() and FFPROBE.is_file() and TRACKED_SOURCE.is_file()),
    reason="随包 ffmpeg 或 test-assets 素材不在预期位置",
)

# 软件编码器：本仓 ffmpeg 无 libx264/libx265，且不能走 GPU 编码器。
ENCODER = "libopenh264"
# 输入时长上限：只取前 30 帧（30fps 源 = 1 秒）。
SOURCE_FRAMES = 30
# 固定工具链指纹：缓存键含 FFmpeg build（preview_source.toolchain_fingerprint）；
# 这里不读真实 build，避免为一行字符串多跑一次子进程。
FFMPEG_BUILD = "ffmpeg version pipeline-lock"


def _short_source(tmp_path: Path) -> Path:
    """从仓库已跟踪素材裁出前 30 帧，作为真实转码的输入（CI 不做整段转码）。"""
    output = tmp_path / "asset-30f.mp4"
    result = subprocess.run(
        [
            str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(TRACKED_SOURCE),
            "-frames:v", str(SOURCE_FRAMES),
            "-an",
            "-c:v", ENCODER, "-b:v", "1M", "-pix_fmt", "yuv420p",
            str(output),
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=60, check=False,
    )
    assert result.returncode == 0 and output.is_file() and output.stat().st_size > 0, (
        result.stderr[-2000:]
    )
    return output


def _db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "b11-pipeline.db")
    db.initialize()
    return db


def _seed_asset(db: Database, fingerprint: str) -> dict[str, Any]:
    """插入属主项目 + 素材行（与 tests/unit/test_preview_source.py 同一搭建方式）。"""
    now = "2026-11-01T00:00:00"
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects (id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("p1", "B11", "active", "{}", None, "/tmp/p1", "p1", now, now, now),
        )
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("asset_proxy", "p1", "video", "external", "源.mp4", fingerprint,
             1024, "12345", "available", json_dumps({"video_streams": []}), now, now),
        )
        return dict(conn.execute("SELECT * FROM assets WHERE id='asset_proxy'").fetchone())


def _service(db: Database, tmp_path: Path) -> PreviewSourceService:
    return PreviewSourceService(
        db,
        DerivedMediaCache(db, tmp_path / "cache"),
        FFMPEG,
        FFprobe(FFPROBE),
        EncoderDetector(FFMPEG),
        ffmpeg_build=FFMPEG_BUILD,
    )


async def _register(service: PreviewSourceService, asset: dict[str, Any],
                    profile: str, source: Path) -> tuple[str, str, Any]:
    """登记作业 → 取回 jobs 行（run_proxy_job 的入参形状）。"""
    job_id = service.create_proxy_job("p1", asset, profile, str(source), ENCODER)
    with service.db.connection() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    assert row is not None
    return job_id, service.proxy_cache_key(asset["fingerprint"], profile), row


@pytest.fixture()
async def env(tmp_path: Path) -> dict[str, Any]:
    """真实素材 + 真实 FFmpeg 的服务实例；素材媒体信息来自真实 ffprobe。"""
    source = _short_source(tmp_path)
    db = _db(tmp_path)
    service = _service(db, tmp_path)
    probe = await service.ffprobe.probe(source)
    asset = _seed_asset(db, "sha256:" + "c" * 64)
    with db.connection() as conn:
        conn.execute(
            "UPDATE assets SET media_info_json=? WHERE id='asset_proxy'",
            (json_dumps(probe),),
        )
        asset = dict(conn.execute("SELECT * FROM assets WHERE id='asset_proxy'").fetchone())
    profile = service.describe(asset, "auto")["profile_id"]
    return {
        "service": service, "asset": asset, "source": source,
        "profile": profile, "probe": probe,
    }


async def test_registration_records_queued_job_before_any_derived_row(
    env: dict[str, Any],
) -> None:
    """登记只写 jobs 行（queued）；派生缓存行此刻还不存在——queued 由 jobs 承载。

    这条前半截是 run_proxy_job 的前置条件，后半截钉住「登记 ≠ 生成」：
    proxy_entry 查的是 derived_media_cache，登记后仍然没有条目，auto 仍回退原源。
    """
    service, asset = env["service"], env["asset"]
    assert service.proxy_entry(asset, env["profile"]) is None  # 尚无派生条目
    job_id, key, row = await _register(service, asset, env["profile"], env["source"])

    assert row["id"] == job_id
    assert row["kind"] == "proxy" and row["type"] == "proxy"
    assert row["status"] == "queued"
    assert row["encoder_requested"] == ENCODER
    payload = json.loads(row["input_json"])
    assert payload["cache_key"] == key
    assert payload["profile_id"] == env["profile"]
    assert payload["asset_id"] == "asset_proxy"
    assert payload["asset_fingerprint"] == asset["fingerprint"]
    assert payload["path"] == str(env["source"])
    # 登记不生成派生缓存行（proxy_entry 查的是 derived_media_cache）
    assert service.proxy_entry(asset, env["profile"]) is None
    # 未 ready 时 auto 回退原源（pending 期间不阻塞 UI）
    assert service.describe(asset, "auto")["mode"] == "original"


async def test_run_publishes_ready_artifact_into_derived_cache(env: dict[str, Any]) -> None:
    """run_proxy_job 真转码 → commit_ready → proxy_entry ready 且产物文件在。"""
    service, asset = env["service"], env["asset"]
    _, key, row = await _register(service, asset, env["profile"], env["source"])
    result = await service.run_proxy_job(row, asyncio.Event())

    assert result["status"] == "ready"
    assert result["cache_key"] == key
    assert result["encoder"] == ENCODER

    entry = service.proxy_entry(asset, env["profile"])
    assert entry is not None
    assert entry["status"] == "ready"
    assert entry["cache_key"] == key
    assert entry["size_bytes"] > 0

    cached = service.derived_cache.lookup(key)
    assert cached is not None and cached.status == "ready" and cached.kind == "video_proxy"
    published = service.derived_cache.resolved_path(cached)
    assert published.is_file()
    assert published.stat().st_size == entry["size_bytes"] > 0
    assert Path(result["path"]).resolve() == published
    # 产物落在缓存布局 <root>/derived/video_proxy/<前2位>/<摘要>/proxy.mp4
    assert published.name == "proxy.mp4"
    assert published.parent.parent.parent.name == "video_proxy"
    assert published.parent.parent.name == key.removeprefix("sha256:")[:2]
    # 产物是真 H.264 代理：几何 = 档位编码尺寸，CFR30（proxy_profiles 契约）
    stream = (await service.ffprobe.probe(published))["video_streams"][0]
    assert stream["codec"] == "h264"
    assert (stream["width"], stream["height"]) == (640, 360)  # 短边 360 ≤ 540 档：不缩放
    assert (stream["avg_frame_rate_num"], stream["avg_frame_rate_den"]) == (30, 1)


async def test_describe_returns_proxy_mode_with_cache_key(env: dict[str, Any]) -> None:
    """代理 ready 后 describe("auto", proxy=...) 生效模式为 proxy 且带 cache_key。"""
    service, asset = env["service"], env["asset"]
    _, key, row = await _register(service, asset, env["profile"], env["source"])
    await service.run_proxy_job(row, asyncio.Event())
    entry = service.proxy_entry(asset, env["profile"])
    assert entry is not None and entry["status"] == "ready"

    description = service.describe(asset, "auto", proxy=entry)
    assert description["mode"] == "proxy"
    assert description["status"] == "ready"
    assert description["cache_key"] == key
    assert description["codec"] == "avc"
    assert (description["coded_width"], description["coded_height"]) == (640, 360)
    assert (description["display_width"], description["display_height"]) == (640, 360)
    assert description["rotation"] == 0  # 旋转已烘焙进编码帧
    assert (description["fps_num"], description["fps_den"]) == (30, 1)
    assert description["profile_id"] == env["profile"]
    assert description["source_id"].endswith("_proxy")
    assert "path" not in description  # Renderer 永不拿路径


async def test_second_registration_hits_cache_without_reencoding(
    env: dict[str, Any], monkeypatch: pytest.MonkeyPatch,
) -> None:
    """同素材同档位再登记 → begin_build 命中（already-ready），不再转码。"""
    service, asset = env["service"], env["asset"]
    _, key, row = await _register(service, asset, env["profile"], env["source"])
    await service.run_proxy_job(row, asyncio.Event())
    cached = service.derived_cache.lookup(key)
    assert cached is not None and cached.status == "ready"
    published = service.derived_cache.resolved_path(cached)
    before = (published.stat().st_size, published.stat().st_mtime_ns)

    async def _no_reencode(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("缓存命中路径不应重复转码")

    monkeypatch.setattr("aivs_core.media.preview_source.render_media", _no_reencode)
    _, key_again, row_again = await _register(service, asset, env["profile"], env["source"])
    assert key_again == key  # 内容寻址：同素材同档位同键
    result = await service.run_proxy_job(row_again, asyncio.Event())
    assert result["status"] == "already-ready"
    assert (published.stat().st_size, published.stat().st_mtime_ns) == before
    entry = service.proxy_entry(asset, env["profile"])
    assert entry is not None and entry["status"] == "ready"
    assert entry["size_bytes"] == before[0] > 0
