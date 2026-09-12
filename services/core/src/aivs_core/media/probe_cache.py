"""A07：媒体探测结果缓存（ffprobe 调用的去重层）。

设计约束（docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md 第 5 节 A07）：
- cache key = asset fingerprint + stat(size, mtime_ns) + ffprobe build——
  文件变化立即失效（key 不同即未命中），不含绝对路径等短期信息。
- 成功缓存条目 ≤256（近似 LRU：命中重插队尾）；失败缓存短暂（默认 5 秒），
  避免坏媒体风暴反复拉起 ffprobe，又不长期掩盖修复后的重试。
- 并发同键 single-flight：并发等待者共享同一次真实探测。
- 超出 TTL/容量后的下次调用重新探测；本缓存只做进程内会话缓存，
  持久化与字节预算纳入 B10（不在本单扩契约）。
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# 失败缓存的默认 TTL（秒）：计划初值 5 秒。
FAILURE_TTL_SECONDS = 5.0
# 成功缓存条目上限：计划初值 256。
MAX_ENTRIES = 256


@dataclass(frozen=True)
class ProbeCacheKey:
    """探测缓存键：fingerprint + stat(size, mtime_ns) + ffprobe build。

    不含绝对路径——同内容素材挪动位置后仍命中（stat 三元与内容指纹
    共同保证身份一致）。
    """

    fingerprint: str
    size: int
    mtime_ns: int
    ffprobe_build: str


@dataclass
class _Entry:
    value: Any | None = None
    error: BaseException | None = None
    expires_at: float | None = None  # None = 成功（无 TTL）；数值 = 失败短 TTL


class ProbeCache:
    """键语义：fingerprint+stat+build；命中不重跑 ffprobe。

    线程模型：单事件循环内使用（与 FFprobe.probe 一致）；同键并发在途
    请求共享同一 Task（single-flight）。
    """

    def __init__(
        self,
        max_entries: int = MAX_ENTRIES,
        failure_ttl: float = FAILURE_TTL_SECONDS,
        clock: Any = time.monotonic,
    ) -> None:
        self._max_entries = max_entries
        self._failure_ttl = failure_ttl
        self._clock = clock
        self._entries: OrderedDict[ProbeCacheKey, _Entry] = OrderedDict()
        self._inflight: dict[ProbeCacheKey, asyncio.Task[dict[str, Any]]] = {}
        # 统计口径（测试与诊断）：命中/未命中/驱逐/在途合并次数。
        self.hits = 0
        self.misses = 0
        self.evictions = 0
        self.merged = 0

    def stats(self) -> dict[str, int]:
        return {
            "hits": self.hits,
            "misses": self.misses,
            "evictions": self.evictions,
            "merged": self.merged,
            "entries": len(self._entries),
            "inflight": len(self._inflight),
        }

    def _lookup(self, key: ProbeCacheKey) -> _Entry | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        if entry.expires_at is not None and entry.expires_at <= self._clock():
            # 失败 TTL 到期：移除，按未命中处理（修复后的文件可重新探测）。
            self._entries.pop(key, None)
            return None
        # 命中：LRU 重插队尾。
        self._entries.move_to_end(key)
        return entry

    async def get_or_probe(self, key: ProbeCacheKey, probe: Any) -> dict[str, Any]:
        """probe: 可调用 (path, require_video) -> dict（FFprobe.probe 语义）。"""
        entry = self._lookup(key)
        if entry is not None:
            self.hits += 1
            if entry.error is not None:
                raise entry.error
            return entry.value
        self.misses += 1
        in_flight = self._inflight.get(key)
        if in_flight is not None and not in_flight.done():
            # single-flight：并发同键等待者共享同一次探测。
            self.merged += 1
            return await asyncio.shield(in_flight)
        task = asyncio.ensure_future(probe())
        self._inflight[key] = task
        # 完成兜底：清在途表 + 写缓存。所有等待者都被取消时无人走到
        # 正常分支——探测结果由这里入缓存（不丢失，也不重复探测）。
        task.add_done_callback(lambda _t: self._settle(key, task))
        try:
            value = await asyncio.shield(task)
        except asyncio.CancelledError:
            # 等待方被取消：真实探测继续供其他等待者使用（shield）；
            # 在途表不动——探测未完成，后续同键请求仍应共享本任务。
            raise
        except BaseException as exc:
            self._store(key, _Entry(error=exc, expires_at=self._clock() + self._failure_ttl))
            raise
        else:
            return value

    def _settle(self, key: ProbeCacheKey, task: asyncio.Task[dict[str, Any]]) -> None:
        """真实探测已终止：清在途表并确保结果已入缓存（幂等——_store
        同键重写为同值）。"""
        if self._inflight.get(key) is task:
            self._inflight.pop(key, None)
        if task.cancelled():
            return  # 探测本身被取消：无结果可缓存。
        exc = task.exception()
        if exc is not None:
            if self._entries.get(key) is None:
                self._store(
                    key,
                    _Entry(error=exc, expires_at=self._clock() + self._failure_ttl),
                )
            return
        if self._entries.get(key) is None:
            self._store(key, _Entry(value=task.result()))

    def _store(self, key: ProbeCacheKey, entry: _Entry) -> None:
        self._entries[key] = entry
        self._entries.move_to_end(key)
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)
            self.evictions += 1

    def invalidate(self, key: ProbeCacheKey) -> None:
        """显式失效（素材变化检测路径调用；正常依赖 stat 键自动失效）。"""
        self._entries.pop(key, None)


def probe_cache_key(
    path: Path, fingerprint: str | None, ffprobe_build: str
) -> ProbeCacheKey | None:
    """从路径与素材指纹构造缓存键。

    fingerprint 为空（调用方未提供——jobs 的临时产物等）时退化为
    stat+build 键（不含内容指纹，仍由 stat 三元保证变化即失效）。
    stat 读取失败（文件消失）返回 None：调用方直接走真实探测。
    """
    try:
        stat = path.stat()
    except OSError:
        return None
    return ProbeCacheKey(
        fingerprint=fingerprint or "",
        size=stat.st_size,
        mtime_ns=stat.st_mtime_ns,
        ffprobe_build=ffprobe_build,
    )
