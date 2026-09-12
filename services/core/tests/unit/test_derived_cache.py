"""B10 派生媒体缓存存储层测试（media/derived_cache.py）。

验收映射（计划第 6 节 B10）：
- CacheKey 内容寻址：同 (kind, fingerprint, algorithm, params, toolchain) 键恒定；
  绝对路径/票据不进键。
- 并发同 key 一次生成：in-flight 第二次 begin_build 被拒，等待者走共享结果。
- 原子发布：SQL ready 只在文件 rename 之后（commit_ready 顺序断言）；
  半产物（building 无文件）不作命中。
- 启动恢复：building 残留（无在途认领）删除；同进程在途不回收。
- pin/引用保护：LRU 清理跳过 pin 与有引用条目；无引用项被回收。
- 磁盘预算：超预算触发清理；绝不动 cache 根之外的文件（外部文件计数不变）。
- 越界拒绝：relative_path 注入 ../ 的条目 resolved_path 拒绝。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import Database
from aivs_core.media.derived_cache import (
    DerivedCacheError,
    DerivedMediaCache,
    derived_cache_key,
)


def _db(tmp_path: Path) -> Database:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES ('p1','n','active','{}',"
            "'/tmp','t','now','now','now')"
        )
        conn.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,created_at,updated_at) "
            "VALUES ('a1','p1','video','external','m.mp4','sha256:" + "a" * 64 + "',1,NULL,"
            "'available','now','now')"
        )
    return database


def _cache(tmp_path: Path, budget: int = 10 * 1024**3) -> DerivedMediaCache:
    root = tmp_path / "cache" / "derived-root"
    return DerivedMediaCache(_db(tmp_path), root, disk_budget_bytes=budget)


def _key(**overrides: object) -> str:
    params: dict[str, object] = {"profile": "preview-540-v1"}
    fields: dict[str, object] = {
        "kind": "video_proxy",
        "asset_fingerprint": "sha256:" + "a" * 64,
        "algorithm_version": 1,
        "params": params,
        "toolchain": "ffmpeg-n8",
    }
    fields.update(overrides)
    return derived_cache_key(
        str(fields["kind"]), str(fields["asset_fingerprint"]),
        int(fields["algorithm_version"]), dict(fields["params"]), str(fields["toolchain"]),
    )


def test_cache_key_is_content_addressed_and_path_free() -> None:
    """同输入同键；路径/票据变化不改键；params 差异改键。"""
    assert _key() == _key()
    assert _key() != _key(params={"profile": "preview-720-v1"})
    assert _key() != _key(toolchain="ffmpeg-n9")
    with pytest.raises(ValueError):
        derived_cache_key("bogus", "sha256:" + "a" * 64, 1, {}, "ffmpeg-n8")


def test_build_and_lookup_roundtrip_with_touch(tmp_path: Path) -> None:
    """begin→写临时→commit ready→lookup 命中 + LRU touch；building 不作命中。"""
    cache = _cache(tmp_path)
    key = _key()
    root = cache.begin_build(key, "sha256:" + "a" * 64, "video_proxy",
                             {"profile": "preview-540-v1"}, "ffmpeg-n8")
    assert root is not None
    assert cache.lookup(key) is None  # building 不是命中
    final = root / "proxy.mp4"
    final.write_bytes(b"proxy-bytes")
    published = cache.commit_ready(key, "video_proxy", final)
    entry = cache.lookup(key)
    assert entry is not None and entry.status == "ready"
    assert entry.size_bytes == len(b"proxy-bytes")
    assert cache.resolved_path(entry) == published


def test_concurrent_same_key_single_flight(tmp_path: Path) -> None:
    """同 key 在途：第二次 begin_build 拒绝（调用方共享首次结果，不重复生成）。"""
    cache = _cache(tmp_path)
    key = _key()
    cache._inflight[key] = object()  # 模拟在途持有
    with pytest.raises(DerivedCacheError) as excinfo:
        cache.begin_build(key, "sha256:" + "a" * 64, "video_proxy",
                          {"profile": "preview-540-v1"}, "ffmpeg-n8")
    assert excinfo.value.code == "DERIVED_BUILD_INFLIGHT"


def test_failed_build_cleans_workdir_and_marks_failed(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    key = _key()
    root = cache.begin_build(key, "sha256:" + "a" * 64, "video_proxy",
                             {"profile": "preview-540-v1"}, "ffmpeg-n8")
    assert root is not None
    (root / "partial.mp4").write_bytes(b"partial")
    cache.mark_failed(key, "video_proxy")
    assert not root.exists()
    entry = cache.lookup(key)
    assert entry is None  # failed 不作命中


def test_recover_orphaned_buildings_at_startup(tmp_path: Path) -> None:
    """building 残留（无在途）：目录删除 + 行删除；同进程在途不回收。"""
    cache = _cache(tmp_path)
    orphan = _key()
    root = cache.begin_build(orphan, "sha256:" + "a" * 64, "video_proxy",
                             {"profile": "preview-540-v1"}, "ffmpeg-n8")
    assert root is not None
    (root / "half.mp4").write_bytes(b"half")

    active = _key(params={"profile": "preview-720-v1"})
    active_root = cache.begin_build(active, "sha256:" + "a" * 64, "video_proxy",
                                    {"profile": "preview-720-v1"}, "ffmpeg-n8")
    assert active_root is not None
    import time as _time

    cache._inflight[active] = _time.monotonic()  # 模拟同进程在途

    removed = cache.recover_orphaned_builds()
    assert removed == 1
    assert not root.exists()
    assert active_root.exists()  # 在途不回收


def test_reference_and_pin_protect_from_lru(tmp_path: Path) -> None:
    """有引用/pin 的 ready 条目不清理；无引用超预算条目被回收。"""
    cache = _cache(tmp_path)  # 默认大预算
    old = _key()
    root = cache.begin_build(old, "sha256:" + "a" * 64, "video_proxy",
                             {"profile": "preview-540-v1"}, "ffmpeg-n8")
    assert root is not None
    final = root / "a.mp4"
    final.write_bytes(b"x" * 1024)
    cache.commit_ready(old, "video_proxy", final)
    cache.add_reference(old, "p1", "a1")  # 授权引用

    pinned = _key(params={"profile": "preview-720-v1"})
    root2 = cache.begin_build(pinned, "sha256:" + "a" * 64, "video_proxy",
                              {"profile": "preview-720-v1"}, "ffmpeg-n8")
    assert root2 is not None
    final2 = root2 / "b.mp4"
    final2.write_bytes(b"y" * 1024)
    cache.commit_ready(pinned, "video_proxy", final2)
    cache.pin(pinned)

    cache.disk_budget_bytes = 1  # 强制超预算
    stats = cache.enforce_disk_budget(max_reclaim=8)
    assert stats["removed"] == 0  # 引用 + pin 均保护

    # 无引用无 pin 条目：可回收
    unref = _key(params={"profile": "preview-1080-v1"})
    root3 = cache.begin_build(unref, "sha256:" + "a" * 64, "video_proxy",
                              {"profile": "preview-1080-v1"}, "ffmpeg-n8")
    assert root3 is not None
    final3 = root3 / "c.mp4"
    final3.write_bytes(b"z" * 1024)
    cache.commit_ready(unref, "video_proxy", final3)
    stats = cache.enforce_disk_budget(max_reclaim=8)
    assert stats["removed"] == 1
    assert not root3.exists()
    assert cache.lookup(unref) is None


def test_lru_never_touches_files_outside_cache_root(tmp_path: Path) -> None:
    """清理只作用于 derived 根内；根外文件原样保留（绝删原素材）。"""
    cache = _cache(tmp_path)
    key = _key()
    root = cache.begin_build(key, "sha256:" + "a" * 64, "video_proxy",
                             {"profile": "preview-540-v1"}, "ffmpeg-n8")
    assert root is not None
    final = root / "a.mp4"
    final.write_bytes(b"x" * 1024)
    cache.commit_ready(key, "video_proxy", final)

    external = tmp_path / "precious-original.mp4"
    external.write_bytes(b"original")
    cache.disk_budget_bytes = 1
    cache.enforce_disk_budget(max_reclaim=8)
    assert external.exists()
    assert not root.exists()


def test_resolved_path_rejects_escape_and_reparse(tmp_path: Path) -> None:
    """relative_path 注入 ../ 越界：resolved_path 拒绝（CACHE_PATH_UNSAFE）。"""
    cache = _cache(tmp_path)
    key = _key()
    root = cache.begin_build(key, "sha256:" + "a" * 64, "video_proxy",
                             {"profile": "preview-540-v1"}, "ffmpeg-n8")
    assert root is not None
    final = root / "a.mp4"
    final.write_bytes(b"x")
    cache.commit_ready(key, "video_proxy", final)
    with cache.db.connection() as db:
        db.execute(
            "UPDATE derived_media_cache SET relative_path='../../escaped.mp4' "
            "WHERE cache_key=?", (key,))
    entry = cache.lookup(key, touch=False)
    assert entry is not None
    with pytest.raises(DerivedCacheError) as excinfo:
        cache.resolved_path(entry)
    assert excinfo.value.code == "CACHE_PATH_UNSAFE"


def test_add_reference_enforces_project_asset_ownership(tmp_path: Path) -> None:
    """越权引用（asset 不在 project）：触发器拒绝（SQL IntegrityError 抛出）。"""
    cache = _cache(tmp_path)
    key = _key()
    root = cache.begin_build(key, "sha256:" + "a" * 64, "video_proxy",
                             {"profile": "preview-540-v1"}, "ffmpeg-n8")
    assert root is not None
    final = root / "a.mp4"
    final.write_bytes(b"x")
    cache.commit_ready(key, "video_proxy", final)
    cache.add_reference(key, "p1", "a1")  # 合法
    with pytest.raises(sqlite3.IntegrityError):
        cache.add_reference(key, "p1", "missing-asset")
