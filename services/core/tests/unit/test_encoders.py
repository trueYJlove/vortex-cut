from pathlib import Path

import pytest

from aivs_core.media import encoders


def _touch(path: str) -> None:
    Path(path).write_bytes(b"x" * 1024)


@pytest.mark.asyncio
async def test_encoder_selection_falls_back_to_libopenh264(monkeypatch, tmp_path):
    async def fake_run(executable, args, timeout):
        class Result:
            returncode = 0
            stdout = ""
            stderr = ""

        if "-encoders" in args:
            Result.stdout = " V..... h264_nvenc\n V..... libopenh264"
            return Result()
        if "-c:v" in args:
            encoder = args[args.index("-c:v") + 1]
            output = args[-1]
            if encoder == "libopenh264":
                _touch(output)
                return Result()
            Result.returncode = 0
            Result.stderr = "[h264_qsv @ 0x0] Invalid FrameType:0\nError encoding a frame"
            _touch(output)
            return Result()
        # 解码验证（-i <file> -f null -）
        return Result()

    monkeypatch.setattr(encoders, "run_process", fake_run)
    detector = encoders.EncoderDetector(Path("ffmpeg"))
    selected, reason = await detector.choose("auto")
    assert selected == "libopenh264"
    assert reason is not None
    assert await detector.smoke_test("libopenh264")
    assert not await detector.smoke_test("h264_qsv")


@pytest.mark.asyncio
async def test_smoke_test_rejects_missing_output(monkeypatch, tmp_path):
    async def fake_run(executable, args, timeout):
        class Result:
            returncode = 0
            stdout = ""
            stderr = ""

        return Result()

    monkeypatch.setattr(encoders, "run_process", fake_run)
    detector = encoders.EncoderDetector(Path("ffmpeg"))
    # 返回码 0 但没有任何输出文件：视为坏编码器
    assert not await detector.smoke_test("h264_qsv")


@pytest.mark.asyncio
async def test_encoder_rejects_unknown_mode():
    with pytest.raises(RuntimeError, match="ENCODER_UNAVAILABLE"):
        await encoders.EncoderDetector(Path("ffmpeg")).choose("invalid")
