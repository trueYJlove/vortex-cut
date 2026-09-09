"""A07：媒体探测缓存（ProbeCache）与 ffprobe build 键语义测试。

验收映射（计划第 5 节 A07）：
- 900 同源切段仅 probe 一次（映射为：同键 N 次调用只跑 1 次真实探测）。
- 并发 choose 同 key 只 smoke 一次（映射为：并发同键 single-flight）。
- 替换工具（ffprobe build 变化）后失效；文件变化（stat 变化）立即失效。
- 失败缓存短暂（默认 5s），期间不重跑，过期后重新探测。
- 缓存命中不触发多次编码探测（RenderCoordinator 集成，test_render_service 扩展）。
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from aivs_core.media.probe_cache import ProbeCache, probe_cache_key


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def _key(fingerprint: str = "sha256:aa", size: int = 1, mtime_ns: int = 2,
         build: str = "ffprobe version 8.0") -> object:
    from aivs_core.media.probe_cache import ProbeCacheKey

    return ProbeCacheKey(fingerprint, size, mtime_ns, build)


@pytest.mark.asyncio
async def test_same_key_probes_once_across_many_calls():
    """同键多次（模拟 900 segment 循环）只真实探测 1 次。"""
    cache = ProbeCache(clock=FakeClock())
    calls = 0

    async def probe():
        nonlocal calls
        calls += 1
        return {"video_streams": [{"codec": "h264"}]}

    for _ in range(900):
        await cache.get_or_probe(_key(), probe)
    assert calls == 1
    stats = cache.stats()
    assert stats["hits"] == 899
    assert stats["misses"] == 1


@pytest.mark.asyncio
async def test_concurrent_same_key_single_flight():
    """并发同键：所有等待者共享同一次探测（merged 计数）。"""
    cache = ProbeCache(clock=FakeClock())
    calls = 0
    release = asyncio.Event()

    async def probe():
        nonlocal calls
        calls += 1
        await release.wait()
        return {"ok": True}

    async def start_one():
        return await cache.get_or_probe(_key(), probe)

    tasks = [asyncio.ensure_future(start_one()) for _ in range(20)]
    await asyncio.sleep(0)  # 让首个任务真正进入探测并挂起
    release.set()
    results = await asyncio.gather(*tasks)
    assert calls == 1
    assert all(result == {"ok": True} for result in results)
    assert cache.stats()["merged"] == 19


@pytest.mark.asyncio
async def test_file_change_invalidates_by_key():
    """stat(size/mtime_ns) 变化 → 新键 → 重新探测（文件变化立即失效）。"""
    cache = ProbeCache(clock=FakeClock())
    calls = 0

    async def probe():
        nonlocal calls
        calls += 1
        return {"n": calls}

    first = await cache.get_or_probe(_key(), probe)
    second = await cache.get_or_probe(_key(size=2), probe)  # size 变化
    third = await cache.get_or_probe(_key(mtime_ns=3), probe)  # mtime 变化
    assert (first, second, third) == ({"n": 1}, {"n": 2}, {"n": 3})
    assert calls == 3


@pytest.mark.asyncio
async def test_ffprobe_build_change_invalidates():
    """ffprobe build 变化（工具替换）→ 全部缓存失效。"""
    cache = ProbeCache(clock=FakeClock())
    calls = 0

    async def probe():
        nonlocal calls
        calls += 1
        return {"n": calls}

    await cache.get_or_probe(_key(build="ffprobe version 8.0"), probe)
    await cache.get_or_probe(_key(build="ffprobe version 8.0"), probe)
    await cache.get_or_probe(_key(build="ffprobe version 9.0"), probe)
    assert calls == 2


@pytest.mark.asyncio
async def test_failure_cached_briefly_then_retried():
    """失败缓存短暂：TTL 内同键直接复抛（不重跑）；过期后重新探测。"""
    clock = FakeClock()
    cache = ProbeCache(clock=clock)
    calls = 0

    async def probe():
        nonlocal calls
        calls += 1
        raise RuntimeError("MEDIA_UNSUPPORTED")

    with pytest.raises(RuntimeError, match="MEDIA_UNSUPPORTED"):
        await cache.get_or_probe(_key(), probe)
    # TTL 内：复抛，不重跑。
    with pytest.raises(RuntimeError, match="MEDIA_UNSUPPORTED"):
        await cache.get_or_probe(_key(), probe)
    assert calls == 1
    # TTL 过期（默认 5s）：重新探测。
    clock.now += 5.1
    with pytest.raises(RuntimeError, match="MEDIA_UNSUPPORTED"):
        await cache.get_or_probe(_key(), probe)
    assert calls == 2


@pytest.mark.asyncio
async def test_lru_eviction_respects_max_entries():
    """成功缓存 ≤ max_entries：超出按插入序驱逐最旧。"""
    cache = ProbeCache(max_entries=3, clock=FakeClock())
    calls = 0

    async def probe():
        nonlocal calls
        calls += 1
        return {"n": calls}

    keys = [_key(fingerprint=f"sha256:{i}") for i in range(4)]
    for key in keys[:3]:
        await cache.get_or_probe(key, probe)
    await cache.get_or_probe(keys[3], probe)  # 触发驱逐最旧（keys[0]）
    assert cache.stats()["evictions"] == 1
    assert cache.stats()["entries"] == 3
    await cache.get_or_probe(keys[0], probe)  # 已被驱逐 → 重新探测
    assert calls == 5
    assert cache.stats()["misses"] == 5  # 4 次首次插入 + 1 次驱逐后重探
    assert cache.stats()["hits"] == 0


@pytest.mark.asyncio
async def test_hit_refreshes_lru_position():
    """命中重插队尾：被再次访问的条目不会被当作最旧驱逐。"""
    cache = ProbeCache(max_entries=2, clock=FakeClock())

    async def probe():
        return {}

    k0, k1 = _key(fingerprint="sha256:0"), _key(fingerprint="sha256:1")
    await cache.get_or_probe(k0, probe)
    await cache.get_or_probe(k1, probe)
    await cache.get_or_probe(k0, probe)  # k0 重插队尾
    await cache.get_or_probe(_key(fingerprint="sha256:2"), probe)  # 驱逐 k1
    stats = cache.stats()
    assert stats["entries"] == 2
    assert stats["hits"] == 1


@pytest.mark.asyncio
async def test_waiter_cancellation_keeps_probe_for_others():
    """等待方取消不取消真实探测（shield 语义）：结果仍入缓存。"""
    cache = ProbeCache(clock=FakeClock())
    release = asyncio.Event()

    async def probe():
        await release.wait()
        return {"kept": True}

    waiter = asyncio.ensure_future(cache.get_or_probe(_key(), probe))
    await asyncio.sleep(0)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    release.set()
    await asyncio.sleep(0.01)  # 让真实探测走完完成回调（清表 + 入缓存）
    # 后续调用命中（探测完成并已缓存）。
    async def must_not_run():
        pytest.fail("不应重跑")

    result = await cache.get_or_probe(_key(), must_not_run)
    assert result == {"kept": True}


def test_probe_cache_key_from_path_and_fingerprint(tmp_path: Path):
    """probe_cache_key：fingerprint+stat+build；文件消失返回 None。"""
    media = tmp_path / "media.mp4"
    media.write_bytes(b"x" * 16)
    key = probe_cache_key(media, "sha256:aa", "ffprobe version 8.0")
    assert key is not None
    assert key.fingerprint == "sha256:aa"
    assert key.size == 16
    assert key.ffprobe_build == "ffprobe version 8.0"
    # stat 变化 → 不同键。
    media.write_bytes(b"y" * 32)
    key2 = probe_cache_key(media, "sha256:aa", "ffprobe version 8.0")
    assert key2 is not None and key2 != key
    # 文件不存在 → None（调用方走直探）。
    assert probe_cache_key(tmp_path / "missing.mp4", None, "b") is None


@pytest.mark.asyncio
async def test_invalidate_explicit():
    """显式失效入口（素材变化检测路径）。"""
    cache = ProbeCache(clock=FakeClock())
    key = _key()

    async def probe():
        return {}

    await cache.get_or_probe(key, probe)
    cache.invalidate(key)
    assert cache.stats()["entries"] == 0


# ── RenderCoordinator 集成：segment 去重 + 缓存命中不重复探测 ────────────────


class _StubProjects:
    """最小 ProjectAssetService 桩：resolve_asset_path + asset_cache_identity。"""

    def __init__(self, paths: dict[str, Path], fingerprints: dict[str, str]) -> None:
        self.paths = paths
        self.fingerprints = fingerprints

    def resolve_asset_path(self, asset_id: str) -> dict[str, str]:
        return {"asset_id": asset_id, "path": str(self.paths[asset_id])}

    def asset_cache_identity(self, asset_id: str):
        path = self.paths[asset_id]
        stat = path.stat()
        return (self.fingerprints[asset_id], str(path), stat.st_size, stat.st_mtime_ns)


@pytest.mark.asyncio
async def test_render_coordinator_segment_probes_deduped_by_input(tmp_path, monkeypatch):
    """900 同源切段 = 1 个 input → 1 次 ffprobe；多 input 各一次。

    RenderCoordinator.run 的 preparing 段成本在这里直接用 _probe + 桩
    projects 断言（run() 全链路走真实 ffmpeg 属集成测试范围）。
    """
    from aivs_core.rendering.service import RenderCoordinator

    media = tmp_path / "media.mp4"
    media.write_bytes(b"m" * 32)
    projects = _StubProjects(
        {"a1": media, "a2": media},
        {"a1": "sha256:aaa", "a2": "sha256:bbb"},
    )

    coordinator = RenderCoordinator.__new__(RenderCoordinator)
    coordinator.projects = projects
    # app.py 注入的语义 = cached_probe(path, fingerprint)：这里用真 ProbeCache
    # + 桩 ffprobe 复现（ffprobe 版本读取也在桩内）。
    cache = ProbeCache(clock=FakeClock())
    real_calls: list[str] = []

    class StubFFprobe:
        executable = Path("ffprobe")

        async def probe(self, path, require_video=True):
            real_calls.append(str(path))
            return {"video_streams": [{"codec": "h264"}]}

    async def probe_fn(path, fingerprint=None):
        key = probe_cache_key(path, fingerprint, "ffprobe version 8.0-test")
        assert key is not None

        async def run_probe():
            return await StubFFprobe().probe(path, require_video=True)

        return await cache.get_or_probe(key, run_probe)

    coordinator.probe_fn = probe_fn
    coordinator.ffprobe = None  # 不使用（probe_fn 已注入）

    # 模拟 plan["inputs"] 循环（preview_ir 与 run() 共用该语义）：
    plan_inputs = [
        {"input_id": "I0", "asset_id": "a1", "fingerprint": "sha256:aaa"},
        {"input_id": "I1", "asset_id": "a2", "fingerprint": "sha256:bbb"},
    ]
    for _round in range(3):  # 多轮（多任务/多 revision）共享会话缓存
        for item in plan_inputs:
            path = Path(coordinator.projects.resolve_asset_path(item["asset_id"])["path"])
            await coordinator._probe(path, coordinator._asset_probe_fingerprint(item["asset_id"]))
    # 两个素材、三轮：第一轮各探测 1 次（真实身份键），后两轮全部命中缓存。
    # 注意 a1/a2 是同一文件但指纹不同 → 两个不同键（内容身份语义）。
    assert len(real_calls) == 2
    # segment 映射：同 input 的多段共享同一次探测结果。
    probe_by_input: dict[str, dict] = {}
    for item in plan_inputs:
        probe_by_input[item["input_id"]] = await coordinator._probe(
            Path(projects.resolve_asset_path(item["asset_id"])["path"]),
            coordinator._asset_probe_fingerprint(item["asset_id"]),
        )
    segments = [{"input_id": "I0"}] * 900 + [{"input_id": "I1"}]
    mapped = [probe_by_input[item["input_id"]] for item in segments]
    assert len(mapped) == 901
    assert all(entry is probe_by_input["I0"] for entry in mapped[:900])
    assert len(real_calls) == 2  # 901 段 + 映射读取未新增真实探测
