from __future__ import annotations

from pathlib import Path

from .process import run_process


class EncoderDetector:
    candidates = ("h264_nvenc", "h264_qsv", "h264_amf", "libx264")

    def __init__(self, ffmpeg: Path) -> None:
        self.ffmpeg = ffmpeg

    async def available(self) -> list[str]:
        result = await run_process(self.ffmpeg, ["-hide_banner", "-encoders"], 10)
        if result.returncode != 0:
            return []
        return [name for name in self.candidates if name in result.stdout]

    async def smoke_test(self, encoder: str) -> bool:
        args = [
            "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            "testsrc2=size=128x128:rate=30", "-t", "1", "-an", "-c:v", encoder,
            "-f", "null", "-",
        ]
        try:
            result = await run_process(self.ffmpeg, args, 10)
        except (FileNotFoundError, TimeoutError):
            return False
        return result.returncode == 0

    async def choose(self, mode: str) -> tuple[str, str | None]:
        if mode == "software":
            mode = "libx264"
        if mode not in {"auto", "libx264", "h264_nvenc", "h264_qsv", "h264_amf"}:
            raise RuntimeError("ENCODER_UNAVAILABLE")
        available = await self.available() if mode == "auto" else [mode]
        hardware = [encoder for encoder in available if encoder != "libx264"]
        options = hardware if mode == "auto" else [mode]
        for encoder in options:
            if await self.smoke_test(encoder):
                return encoder, None
        if mode == "auto" and await self.smoke_test("libx264"):
            reason = "hardware encoder smoke test failed; fell back to software" if hardware else None
            return "libx264", reason
        raise RuntimeError("ENCODER_UNAVAILABLE")

    async def capabilities(self) -> dict[str, object]:
        available = await self.available()
        selected, fallback = await self.choose("auto")
        return {
            "available_encoders": available,
            "default_encoder": selected,
            "fallback_reason": fallback,
        }
