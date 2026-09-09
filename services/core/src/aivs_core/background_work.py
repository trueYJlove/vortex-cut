"""A05 后台工作执行：受限线程池 + 取消令牌 + stat 前后比对。

约束（PERFORMANCE_IMPLEMENTATION_PLAN A05a）：
- 哈希与大文件 I/O 使用专用 ThreadPoolExecutor（初始 max_workers=2），
  前置 semaphore 限制提交队列深度——不能只靠 executor 限线程而无限排队。
- 哈希分块检查取消令牌；计算前后比对 stat（size/mtime_ns），变化时沿
  现有 ASSET_CHANGED 域错误路径返回（域错误由调用方翻译）。
- 线程内打开/关闭自己的文件，不向线程传活动 SQLite connection；主逻辑
  完成结果校验后才写数据库。
- 取消 Future 并不终止已开始的系统调用——合作式令牌在分块边界生效。

设计：
- BackgroundExecutor 进程内单例（atexit 有界回收；Windows 强杀照旧可能
  跳过，与 performance.py 的 flush 同类已知限制）。
- run_hashed 捕获调用时的 stat 快照，线程内完成后再取一次：不一致 →
  AssetChangedError（调用方按现有 ASSET_CHANGED 语义处理）。
- 取消语义：await 方取消时置令牌（线程在下一分块边界/启动前观察到即止）；
  线程已进入的系统调用不可中断，future 结果被丢弃——与"decodeAudioData
  无法中止"同一诚实口径，不假装强杀。
"""

from __future__ import annotations

import asyncio
import atexit
import hashlib
import threading
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

HASH_CHUNK_BYTES = 1024 * 1024
MAX_WORKERS = 2
MAX_QUEUED = 8  # 提交队列深度护栏（semaphore：超限等待而非无限排队）


class AssetChangedError(RuntimeError):
    """哈希期间文件 stat 变化（size/mtime_ns 不一致）。调用方沿既有
    ASSET_CHANGED 域错误路径处理。"""


@dataclass(frozen=True)
class _StatSnapshot:
    size: int
    mtime_ns: int


def _snapshot(path: Path) -> _StatSnapshot:
    stat = path.stat()
    return _StatSnapshot(size=stat.st_size, mtime_ns=stat.st_mtime_ns)


def _hash_file(path: Path, before: _StatSnapshot, cancelled: threading.Event) -> str:
    """线程内执行：打开自己的文件句柄、分块喂入、分块边界检查令牌。"""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            if cancelled.is_set():
                raise asyncio.CancelledError()
            chunk = source.read(HASH_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
    after = _snapshot(path)
    if after != before:
        raise AssetChangedError(f"file changed during hash: {path}")
    return f"sha256:{digest.hexdigest()}"


class BackgroundExecutor:
    """受限线程池 + 有界提交队列 + 可取消哈希。

    executor 线程数 = max_workers；提交侧 semaphore（max_queued）防无限
    排队：拿不到令牌时 await 有限重试，仍拿不到则排队等待（不抛错——
    调用方是事件循环，宁可慢不可假失败）。
    """

    _instance: BackgroundExecutor | None = None
    _instance_lock = threading.Lock()

    @classmethod
    def instance(cls) -> BackgroundExecutor:
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def __init__(self, max_workers: int = MAX_WORKERS, max_queued: int = MAX_QUEUED) -> None:
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="aivs-background")
        self._gate = asyncio.Semaphore(max_queued)
        atexit.register(self._shutdown)

    def _shutdown(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)

    async def run_hashed(self, path: Path) -> str:
        """后台哈希：stat 前后比对 + 分块取消令牌。

        调用方 task 取消 → done callback 置令牌；线程在分块边界观察到即止。
        线程结果不因等待方取消而安装（shield 之外抛 CancelledError）。
        """
        before = _snapshot(path)  # 事件循环内先取快照（stat 非阻塞）
        cancelled = threading.Event()
        task = asyncio.current_task()
        if task is not None:
            def _on_done(done: asyncio.Task[Any]) -> None:
                if done.cancelled() or done.cancelling():
                    cancelled.set()

            task.add_done_callback(_on_done)
        async with self._gate:
            future: Future[str] = self._executor.submit(_hash_file, path, before, cancelled)
            return await asyncio.shield(asyncio.wrap_future(future))

    async def run(self, fn: Callable[[], Any]) -> Any:
        """通用后台执行（大文件复制等）：同样过提交门。"""
        async with self._gate:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(self._executor, fn)


async def hashed_fingerprint(path: Path) -> str:
    """便捷入口：后台哈希（模块级单例）。"""
    return await BackgroundExecutor.instance().run_hashed(path)
