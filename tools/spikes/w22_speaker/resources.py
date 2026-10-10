"""进程峰值内存与计时（spike 用，Windows 无 psutil 依赖）。

坑（已修）：ctypes 未声明 argtypes 时 HANDLE 按 C int 传参 → 64 位句柄被截断，
GetProcessMemoryInfo 静默失败、峰值内存恒为 NaN。必须显式声明。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import time
from contextlib import contextmanager


class _PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", wt.DWORD),
        ("PageFaultCount", wt.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def _get_process_memory_info() -> _PROCESS_MEMORY_COUNTERS:
    counters = _PROCESS_MEMORY_COUNTERS()
    counters.cb = ctypes.sizeof(counters)
    psapi = ctypes.WinDLL("psapi")
    fn = psapi.GetProcessMemoryInfo
    fn.argtypes = [wt.HANDLE, ctypes.POINTER(_PROCESS_MEMORY_COUNTERS), wt.DWORD]
    fn.restype = wt.BOOL
    kernel32 = ctypes.WinDLL("kernel32")
    kernel32.GetCurrentProcess.restype = wt.HANDLE
    if not fn(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        raise OSError("GetProcessMemoryInfo failed")
    return counters


def peak_rss_mb() -> float:
    return _get_process_memory_info().PeakWorkingSetSize / 1048576.0


def current_rss_mb() -> float:
    return _get_process_memory_info().WorkingSetSize / 1048576.0


@contextmanager
def timed(bucket: dict, key: str):
    t0 = time.perf_counter()
    try:
        yield
    finally:
        bucket[key] = bucket.get(key, 0.0) + (time.perf_counter() - t0)
