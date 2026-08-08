from pathlib import Path

import pytest

from aivs_core.media import encoders


@pytest.mark.asyncio
async def test_encoder_selection_falls_back_to_libx264(monkeypatch):
    async def fake_run(executable, args, timeout):
        class Result:
            returncode = 0
            stdout = ""
            stderr = ""
        if "-encoders" in args:
            Result.stdout = " V..... h264_nvenc\n V..... libx264"
        else:
            Result.returncode = 0 if args[args.index("-c:v") + 1] == "libx264" else 1
        return Result()

    monkeypatch.setattr(encoders, "run_process", fake_run)
    detector = encoders.EncoderDetector(Path("ffmpeg"))
    selected, reason = await detector.choose("auto")
    assert selected == "libx264"
    assert reason is not None
    assert await detector.smoke_test("libx264")


@pytest.mark.asyncio
async def test_encoder_rejects_unknown_mode():
    with pytest.raises(RuntimeError, match="ENCODER_UNAVAILABLE"):
        await encoders.EncoderDetector(Path("ffmpeg")).choose("invalid")
