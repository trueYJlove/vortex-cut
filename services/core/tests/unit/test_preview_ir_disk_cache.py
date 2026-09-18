"""合成预览 IR 磁盘持久缓存（manifest 投影缓存立项 2026-09-18）单元测试。

验收映射（Planning Gate §3）：
- 首次投影写盘；新 coordinator 实例（模拟 app 重启）磁盘命中，ffprobe/投影零调用；
- projector_version 不符 → 不命中且陈旧文件被删除；
- 素材指纹集变化 → 不命中（读时自愈）；
- 损坏文件 → 静默删除回未命中，不抛；
- 超 max_entries 按 mtime LRU 淘汰；
- v1 与 v2 共享同一磁盘条目（先 v1 写、后 v2 命中同一 ir）。
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

import pytest

from aivs_core.rendering.ir_disk_cache import (
    MAX_DISK_ENTRIES,
    PreviewIrDiskCache,
    _safe_name,
    asset_fingerprint_list,
)


def _plan(fingerprint: str = "sha256:plan", fps: tuple = ("fp0", "fp1")) -> dict:
    return {
        "content_fingerprint": fingerprint,
        "mode": "authoritative_preview",
        "timeline_revision_id": "rev1",
        "output": {"profile_id": "preview-169-v1", "width": 960, "height": 540},
        "inputs": [
            {"input_id": "I0", "asset_id": "asset0", "asset_kind": "video",
             "fingerprint": fps[0], "duration_us": 0, "has_audio": False},
            {"input_id": "I1", "asset_id": "asset1", "asset_kind": "video",
             "fingerprint": fps[1], "duration_us": 0, "has_audio": False},
        ],
    }


def _ir() -> dict:
    # 字段齐备的极小 IR(build_manifest 派生 manifest 需要 inputs/segments/
    # captions/caption_styles/transition_windows/known_approximations)。
    return {
        "canvas": {"duration_frames": 30, "duration_us": 1_000_000},
        "frames": [{"n": 0, "overlays": []}],
        "inputs": [],
        "segments": [],
        "captions": [],
        "caption_styles": {},
        "transition_windows": [],
        "known_approximations": [],
    }


def test_store_then_load_roundtrip(tmp_path: Path) -> None:
    cache = PreviewIrDiskCache(tmp_path)
    plan = _plan()
    key = "sha256:abc@authoritative_preview@preview-169-v1"
    cache.store(key, asset_fingerprint_list(plan), {"ir": _ir()})
    loaded = cache.load(key, asset_fingerprint_list(plan))
    assert loaded is not None and loaded["ir"]["canvas"]["duration_frames"] == 30


def test_load_missing_returns_none(tmp_path: Path) -> None:
    cache = PreviewIrDiskCache(tmp_path)
    assert cache.load("sha256:none@mode@profile", ["fp"]) is None


def test_version_mismatch_invalidates(tmp_path: Path) -> None:
    cache = PreviewIrDiskCache(tmp_path)
    key = "sha256:abc@mode@profile"
    cache.store(key, ["fp"], {"ir": _ir()})
    # 人为把条目版本改成旧值（模拟投影器升级前写入的条目）
    path = next((tmp_path / "cache" / "preview-ir").rglob("*.json"))
    entry = json.loads(path.read_text(encoding="utf-8"))
    entry["meta"]["projector_version"] = 999
    path.write_text(json.dumps(entry), encoding="utf-8")
    assert cache.load(key, ["fp"]) is None
    assert not path.exists()  # 陈旧文件被删除（读时自愈）


def test_fingerprint_set_change_invalidates(tmp_path: Path) -> None:
    cache = PreviewIrDiskCache(tmp_path)
    key = "sha256:abc@mode@profile"
    cache.store(key, ["fp0", "fp1"], {"ir": _ir()})
    # 同 fingerprint 复用但素材内容变了 → 指纹集不同 → 不命中
    assert cache.load(key, ["fp0", "fpOTHER"]) is None
    assert cache.load(key, ["fp0"]) is None  # 集合大小不同同样不命中


def test_corrupt_file_silently_discarded(tmp_path: Path) -> None:
    cache = PreviewIrDiskCache(tmp_path)
    key = "sha256:abc@mode@profile"
    cache.store(key, ["fp"], {"ir": _ir()})
    path = next((tmp_path / "cache" / "preview-ir").rglob("*.json"))
    path.write_text("{not valid json", encoding="utf-8")
    assert cache.load(key, ["fp"]) is None  # 不抛，回未命中
    assert not path.exists()


def test_lru_eviction_by_mtime(tmp_path: Path) -> None:
    cache = PreviewIrDiskCache(tmp_path)
    for i in range(MAX_DISK_ENTRIES + 2):
        cache.store(f"sha256:k{i}@mode@profile", ["fp"], {"ir": {"i": i}})
        time.sleep(0.05)  # 真实 mtime 单调递增,驱动 LRU 次序
    files = list((tmp_path / "cache" / "preview-ir").rglob("*.json"))
    assert len(files) == MAX_DISK_ENTRIES
    # 最早写入的 k0/k1 被淘汰,最新的保留(文件名 = _safe_name 哈希,冒号不落盘)
    remaining = {p.name for p in files}
    assert _safe_name("sha256:k0@mode@profile") + ".json" not in remaining
    assert _safe_name("sha256:k1@mode@profile") + ".json" not in remaining
    assert _safe_name(f"sha256:k{MAX_DISK_ENTRIES + 1}@mode@profile") + ".json" in remaining


def test_write_failure_silent(tmp_path: Path) -> None:
    # root 是文件 → mkdir 失败 → 静默不抛
    (tmp_path / "cache").write_text("blocker", encoding="utf-8")
    cache = PreviewIrDiskCache(tmp_path)
    cache.store("sha256:x@mode@profile", ["fp"], {"ir": _ir()})  # 不抛
    assert cache.load("sha256:x@mode@profile", ["fp"]) is None


class _FakeExecutor:
    """投影计数器：磁盘命中时必须零调用。"""

    def __init__(self) -> None:
        self.calls = 0

    async def project(self, plan, probes, styles):
        self.calls += 1
        return _ir()


def _make_coordinator(tmp_path: Path, executor: _FakeExecutor) -> object:
    """绕过 __init__ 的最小 coordinator（单测模式,同 test_render_ir_window 先例）。"""
    from aivs_core.rendering.service import RenderCoordinator

    coordinator = RenderCoordinator.__new__(RenderCoordinator)
    coordinator.compiler = None
    coordinator.data_dir = tmp_path
    coordinator.preview_ir_cache = {}
    coordinator.preview_probe_cache = {}
    coordinator.preview_ir_v2_cache = {}
    coordinator.preview_ir_disk_cache = PreviewIrDiskCache(tmp_path)
    coordinator._project_plan = _project_plan_stub(executor)  # type: ignore[method-assign]
    return coordinator


def _project_plan_stub(executor: _FakeExecutor):
    async def _stub(plan: dict) -> dict:
        return await executor.project(plan, {}, None)
    return _stub


def _compile_stub(plan: dict):
    async def _stub(*args, **kwargs):
        return plan
    return _stub


def test_v2_cold_start_disk_hit_skips_projection(tmp_path: Path) -> None:
    """app 重启模拟:新 coordinator 实例 + 同 plan → 磁盘命中,投影零调用。"""
    plan = _plan()
    executor = _FakeExecutor()
    first = _make_coordinator(tmp_path, executor)
    first._compile_off_loop = _compile_stub(plan)  # type: ignore[method-assign]
    asyncio.run(first.preview_ir_manifest("p", None, "169"))
    assert executor.calls == 1

    second = _make_coordinator(tmp_path, executor)  # 新实例 = 进程缓存空
    second._compile_off_loop = _compile_stub(plan)  # type: ignore[method-assign]
    manifest = asyncio.run(second.preview_ir_manifest("p", None, "169"))
    assert executor.calls == 1  # 磁盘命中:投影未再执行
    assert manifest["total_frames"] == 30


def test_v1_and_v2_share_disk_entry(tmp_path: Path) -> None:
    """先 v2 写盘,后 v1(新实例)命中同一 ir;反向亦然。"""
    plan = _plan()
    executor = _FakeExecutor()
    first = _make_coordinator(tmp_path, executor)
    first._compile_off_loop = _compile_stub(plan)  # type: ignore[method-assign]
    asyncio.run(first.preview_ir_manifest("p", None, "169"))
    assert executor.calls == 1

    second = _make_coordinator(tmp_path, executor)
    second._compile_off_loop = _compile_stub(plan)  # type: ignore[method-assign]
    v1_payload = asyncio.run(second.preview_ir("p", None, "169"))
    assert executor.calls == 1  # 共享条目命中,无第二次投影
    assert v1_payload["ir"]["canvas"]["duration_frames"] == 30
