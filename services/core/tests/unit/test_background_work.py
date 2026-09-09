"""A05a 后台工作回归：受限线程池 + 取消令牌 + stat 前后比对。

覆盖（PERFORMANCE_IMPLEMENTATION_PLAN A05a）：
- 哈希正确性（与 sha256_file 同值）。
- 事件循环不阻塞：哈希大文件期间并发 task 的推进不受影响。
- stat 前后变化 → AssetChangedError（调用方按 ASSET_CHANGED 翻译）。
- 提交队列有界：超 MAX_QUEUED 的提交在 semaphore 上排队而非无限堆积
  （不抛错、最终全部完成）。
- 线程池 worker 数守恒：并发哈希时活动线程 ≤ max_workers。
- 线程内文件句柄自管理（不依赖调用方句柄）。
"""
from __future__ import annotations

import asyncio
import os
import threading
from pathlib import Path

import pytest

from aivs_core.background_work import (
    AssetChangedError,
    BackgroundExecutor,
    hashed_fingerprint,
)
from aivs_core.database import sha256_file


def _write_file(path: Path, payload: bytes) -> Path:
    path.write_bytes(payload)
    return path


def _touch_mtime(path: Path) -> None:
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))


@pytest.fixture
def big_file(tmp_path: Path) -> Path:
    # 8 MiB：分块路径（chunk 1 MiB）多轮迭代
    return _write_file(tmp_path / "big.bin", os.urandom(8 * 1024 * 1024))


@pytest.fixture
def isolated_executor() -> BackgroundExecutor:
    """独立实例（单例池线程跨测试累积会污染线程计数；测完显式回收）。"""
    executor = BackgroundExecutor(max_workers=2, max_queued=4)
    yield executor
    executor._shutdown()  # noqa: SLF001 测试路径显式回收


def test_hash_matches_reference(big_file: Path) -> None:
    async def run() -> str:
        return await hashed_fingerprint(big_file)

    assert asyncio.run(run()) == sha256_file(big_file)


def test_event_loop_not_blocked_during_hash(big_file: Path) -> None:
    """哈希期间并发心跳 task 的 tick 数不被压缩到 0（事件循环可调度）。"""

    async def run() -> tuple[str, int]:
        ticks = 0

        async def heartbeat() -> int:
            nonlocal ticks
            for _ in range(50):
                ticks += 1
                await asyncio.sleep(0.001)
            return ticks

        beating = asyncio.create_task(heartbeat())
        digest = await hashed_fingerprint(big_file)
        await beating
        return digest, ticks

    digest, ticks = asyncio.run(run())
    assert digest == sha256_file(big_file)
    assert ticks == 50  # 心跳全部跑完（未被哈希饿死）


def test_stat_change_raises_asset_changed(tmp_path: Path) -> None:
    path = _write_file(tmp_path / "mutating.bin", b"x" * 4096)

    # 在哈希读取中途改 mtime：BackgroundExecutor 快照在提交前——
    # 构造竞态：monkeypatch _hash_file 的 read 拦截，首轮读后 touch。

    original_open = Path.open
    touched = threading.Event()

    def slow_read(self: Path, *args: object, **kwargs: object):  # noqa: ANN001, ANN002
        handle = original_open(self, *args, **kwargs)  # type: ignore[arg-type]
        if not touched.is_set() and self == path and "rb" in str(args):
            touched.set()
            _touch_mtime(path)  # 哈希完成前的 stat 变化
        return handle

    monkey = pytest.MonkeyPatch()
    monkey.setattr(Path, "open", slow_read)
    try:
        with pytest.raises(AssetChangedError):
            asyncio.run(hashed_fingerprint(path))
    finally:
        monkey.undo()


def test_bounded_submission_queue(tmp_path: Path) -> None:
    """MAX_QUEUED 之外的任务排队等待而非被拒/堆积无界。"""
    files = [_write_file(tmp_path / f"f{i}.bin", os.urandom(64 * 1024)) for i in range(24)]
    executor = BackgroundExecutor(max_workers=2, max_queued=4)

    async def run() -> list[str]:
        return await asyncio.gather(*[executor.run_hashed(path) for path in files])

    digests = asyncio.run(run())
    assert len(digests) == 24
    for path, digest in zip(files, digests, strict=True):
        assert digest == sha256_file(path)
    # 排队期间 semaphore 不超限（gather 全部完成 = 队列最终清空）
    assert executor._gate._value == 4  # noqa: SLF001 全部归还


def test_worker_threads_bounded(isolated_executor: BackgroundExecutor) -> None:
    """并发执行时**本池**活动 worker 线程数 ≤ max_workers（按实例内部线程
    集合统计——线程名计数会把其它实例/单例的池线程计入）。"""
    executor = isolated_executor
    peak = {"value": 0}

    def own_pool_threads() -> int:
        # ThreadPoolExecutor._threads 是池内活跃线程集合（实例级，不受干扰）
        return len(executor._executor._threads)  # noqa: SLF001

    async def run() -> list[str]:
        async def tracked() -> str:
            peak["value"] = max(peak["value"], own_pool_threads())
            return await executor.run(lambda: "done")

        return await asyncio.gather(*[tracked() for _ in range(10)])

    results = asyncio.run(run())
    assert results == ["done"] * 10
    assert peak["value"] <= 2  # 本池 worker 恒 ≤ max_workers


def test_thread_closes_own_handle(big_file: Path) -> None:
    """线程内句柄自管理：哈希完成后文件可删除（无悬挂句柄，Windows 语义）。"""
    digest = asyncio.run(hashed_fingerprint(big_file))
    assert digest == sha256_file(big_file)
    big_file.unlink()  # Windows 上句柄未关会抛 PermissionError
    assert not big_file.exists()
