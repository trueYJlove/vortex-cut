from __future__ import annotations

import asyncio
import tempfile
import time
from pathlib import Path

from .process import run_process

# 编码器初始化失败但进程仍以 0 退出的错误标记（如 Intel QSV 在无可用设备/驱动
# 不匹配时打印这些信息却仍返回成功）。smoke test 捕获它们以拒用坏编码器。
_ENCODER_ERROR_MARKERS = (
    "Error submitting video frame",
    "Error encoding a frame",
    "Invalid FrameType",
    "Task finished with error code",
    "failed to initialise",
    "failed to initialize",
    "not supported on this system",
    "no device found",
    "Cannot load libmfx",
    "Error creating",
)

# A07：编码器可用性 / smoke 结果的进程内 session 缓存。
# - key = FFmpeg build（-version 首行）+ encoder + 测试规格常量；
#   工具/驱动替换后 build 变化 → 全部自动失效。
# - 成功 TTL 30 分钟（探测真实编码，同一会话内环境不应漂移）；
#   失败 TTL 30 秒（硬件编码器可能间歇失败，短暂失败快速重试）。
# - single-flight：并发 choose 同 key 只 smoke 一次。
# - 渲染中编码失败 → RenderCoordinator 调 invalidate_smoke 清除该 encoder
#   的成功结果，保留下一次真实重测（不因缓存跳过实际渲染错误判断）。
SUCCESS_TTL_SECONDS = 30 * 60.0
FAILURE_TTL_SECONDS = 30.0


class EncoderDetector:
    candidates = ("h264_nvenc", "h264_qsv", "h264_amf", "libopenh264", "libx264")

    def __init__(self, ffmpeg: Path) -> None:
        self.ffmpeg = ffmpeg
        self._version: str | None = None
        self._version_lock = asyncio.Lock()
        # (kind, encoder) -> (ok, expires_at)；kind ∈ {"available", "smoke"}。
        self._session_cache: dict[tuple[str, str], tuple[bool, float]] = {}
        self._inflight: dict[tuple[str, str], asyncio.Task[bool]] = {}

    async def build_id(self) -> str:
        """FFmpeg build 标识（-version 首行，同 build 只读一次）。"""
        if self._version is not None:
            return self._version
        async with self._version_lock:
            if self._version is not None:
                return self._version
            result = await run_process(self.ffmpeg, ["-hide_banner", "-version"], 10)
            if result.returncode != 0 or not result.stdout:
                raise RuntimeError("FFMPEG_VERSION_UNAVAILABLE")
            self._version = result.stdout.splitlines()[0]
            return self._version

    def invalidate_smoke(self, encoder: str) -> None:
        """渲染失败路径：清除该 encoder 的 smoke 成功结果（失败 TTL 不动——
        本来就短）。下次 choose/渲染重试会重新真实 smoke。"""
        self._session_cache.pop(("smoke", encoder), None)

    def reset(self) -> None:
        """显式重测入口（诊断/测试）：清空全部 session 缓存（版本缓存保留）。"""
        self._session_cache.clear()

    def _cached_ok(self, kind: str, encoder: str) -> bool | None:
        entry = self._session_cache.get((kind, encoder))
        if entry is None:
            return None
        ok, expires_at = entry
        if expires_at <= time.monotonic():
            self._session_cache.pop((kind, encoder), None)
            return None
        return ok

    def _store(self, kind: str, encoder: str, ok: bool) -> None:
        self._session_cache[(kind, encoder)] = (
            ok,
            time.monotonic() + (SUCCESS_TTL_SECONDS if ok else FAILURE_TTL_SECONDS),
        )

    async def _run_single_flight(self, kind: str, encoder: str, action) -> bool:
        key = (kind, encoder)
        cached = self._cached_ok(kind, encoder)
        if cached is not None:
            return cached
        in_flight = self._inflight.get(key)
        if in_flight is not None and not in_flight.done():
            return await asyncio.shield(in_flight)
        task = asyncio.ensure_future(action())
        self._inflight[key] = task
        try:
            ok = await asyncio.shield(task)
        except BaseException:
            # 探测异常不缓存异常本身：按失败短 TTL 缓存（避免风暴），异常上抛。
            self._store(kind, encoder, False)
            raise
        else:
            self._store(kind, encoder, ok)
            return ok
        finally:
            if self._inflight.get(key) is task:
                self._inflight.pop(key, None)

    async def available(self) -> list[str]:
        """可用编码器候选列表（session 缓存 + single-flight，A07）。"""
        cached = self._cached_ok("available", "__list__")
        if cached is None:
            in_flight = self._inflight.get(("available", "__list__"))
            if in_flight is not None and not in_flight.done():
                await asyncio.shield(in_flight)
            else:
                task = asyncio.ensure_future(self._probe_available())
                self._inflight[("available", "__list__")] = task
                try:
                    await asyncio.shield(task)
                finally:
                    if self._inflight.get(("available", "__list__")) is task:
                        self._inflight.pop(("available", "__list__"), None)
        return self._available_names

    _available_names: list[str] = []

    async def _probe_available(self) -> bool:
        result = await run_process(self.ffmpeg, ["-hide_banner", "-encoders"], 10)
        if result.returncode != 0:
            self._available_names = []
            self._store("available", "__list__", False)
            return False
        self._available_names = [name for name in self.candidates if name in result.stdout]
        self._store("available", "__list__", True)
        return True

    async def smoke_test(self, encoder: str) -> bool:
        async def action() -> bool:
            # 真实编码一小段与渲染同规格的测试源到临时 mp4，而非仅 `-f null`：
            # 某些硬件编码器（QSV/AMF）初始化失败时 ffmpeg 仍以 0 退出，只有
            # 真实产出 + stderr 错误标记 + 产物可解码性才能暴露问题。
            with tempfile.TemporaryDirectory(prefix="aivs-encoder-") as tmp:
                output = Path(tmp) / "smoke.mp4"
                args = [
                    "-hide_banner",
                    "-loglevel",
                    "warning",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=540x960:rate=30",
                    "-t",
                    "2",
                    "-an",
                    "-c:v",
                    encoder,
                    "-b:v",
                    "4M",
                    "-pix_fmt",
                    "yuv420p",
                    "-y",
                    str(output),
                ]
                try:
                    result = await run_process(self.ffmpeg, args, 60)
                except (FileNotFoundError, TimeoutError):
                    return False
                if result.returncode != 0:
                    return False
                if not output.exists() or output.stat().st_size == 0:
                    return False
                if any(marker in result.stderr for marker in _ENCODER_ERROR_MARKERS):
                    return False
                # 产物必须能完整解码，否则视为坏编码器。
                try:
                    verify = await run_process(
                        self.ffmpeg,
                        [
                            "-hide_banner",
                            "-loglevel",
                            "error",
                            "-i",
                            str(output),
                            "-f",
                            "null",
                            "-",
                        ],
                        30,
                    )
                except (FileNotFoundError, TimeoutError):
                    return False
                return verify.returncode == 0

        return await self._run_single_flight("smoke", encoder, action)

    async def choose(self, mode: str) -> tuple[str, str | None]:
        if mode == "software":
            mode = "libopenh264"
        if mode not in {"auto", "libopenh264", "libx264", "h264_nvenc", "h264_qsv", "h264_amf"}:
            raise RuntimeError("ENCODER_UNAVAILABLE")
        available = await self.available() if mode == "auto" else [mode]
        hardware = [encoder for encoder in available if encoder not in {"libopenh264", "libx264"}]
        options = hardware if mode == "auto" else [mode]
        for encoder in options:
            if await self.smoke_test(encoder):
                return encoder, None
        if mode == "auto":
            for software in ("libopenh264", "libx264"):
                if await self.smoke_test(software):
                    reason = (
                        "hardware encoder smoke test failed; fell back to software"
                        if hardware
                        else None
                    )
                    return software, reason
        raise RuntimeError("ENCODER_UNAVAILABLE")

    async def capabilities(self) -> dict[str, object]:
        available = await self.available()
        selected, fallback = await self.choose("auto")
        return {
            "available_encoders": available,
            "default_encoder": selected,
            "fallback_reason": fallback,
        }
