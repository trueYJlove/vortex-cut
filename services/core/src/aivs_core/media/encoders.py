from __future__ import annotations

import tempfile
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


class EncoderDetector:
    candidates = ("h264_nvenc", "h264_qsv", "h264_amf", "libopenh264", "libx264")

    def __init__(self, ffmpeg: Path) -> None:
        self.ffmpeg = ffmpeg

    async def available(self) -> list[str]:
        result = await run_process(self.ffmpeg, ["-hide_banner", "-encoders"], 10)
        if result.returncode != 0:
            return []
        return [name for name in self.candidates if name in result.stdout]

    async def smoke_test(self, encoder: str) -> bool:
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
                    ["-hide_banner", "-loglevel", "error", "-i", str(output), "-f", "null", "-"],
                    30,
                )
            except (FileNotFoundError, TimeoutError):
                return False
            return verify.returncode == 0

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
