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


# ── A07：session 缓存语义 ────────────────────────────────────────────────────


class _CallRecorder:
    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, executable, args, timeout):
        self.calls += 1

        class Result:
            returncode = 0
            stdout = ""
            stderr = ""

        result = Result()
        if "-version" in args:
            result.stdout = "ffmpeg version 8.0-test\n"
        elif "-encoders" in args:
            result.stdout = " V..... h264_nvenc\n V..... libopenh264\n"
        elif "-c:v" in args:
            encoder = args[args.index("-c:v") + 1]
            output = args[-1]
            if encoder == "h264_nvenc":
                # 每次真实 smoke 都可观测（断言缓存命中次数用）。
                result.stderr = "[nvenc] broken\nError encoding a frame"
            _touch(output)
        return result


@pytest.mark.asyncio
async def test_available_and_smoke_results_are_cached(monkeypatch, tmp_path):
    """同 session 内：available 只跑一次 -encoders；smoke 结果缓存复用。"""
    recorder = _CallRecorder()
    monkeypatch.setattr(encoders, "run_process", recorder)
    detector = encoders.EncoderDetector(Path("ffmpeg"))

    first = await detector.available()
    second = await detector.available()
    assert first == second == ["h264_nvenc", "libopenh264"]
    assert recorder.calls == 1  # 只跑一次 -encoders

    # 同 encoder 两次 smoke：第一次真实跑（错误标记短路——只跑编码 1 个
    # 子进程，不进解码验证）；第二次命中失败缓存不重跑。
    # 总调用 = -encoders(1) + 编码(1) = 2。
    assert not await detector.smoke_test("h264_nvenc")
    assert recorder.calls == 2
    assert not await detector.smoke_test("h264_nvenc")  # 命中缓存：不重跑
    assert recorder.calls == 2


@pytest.mark.asyncio
async def test_invalidate_smoke_forces_real_retest(monkeypatch, tmp_path):
    """渲染失败路径 invalidate_smoke：成功缓存被清除后重新真实 smoke。"""
    recorder = _CallRecorder()
    # nvenc 本次健康（无错误标记）。
    async def healthy(executable, args, timeout):
        recorder.calls += 1

        class Result:
            returncode = 0
            stdout = ""
            stderr = ""

        result = Result()
        if "-version" in args:
            result.stdout = "ffmpeg version 8.0-test\n"
        elif "-encoders" in args:
            result.stdout = " V..... h264_nvenc\n"
        elif "-c:v" in args:
            _touch(args[-1])
        return result

    monkeypatch.setattr(encoders, "run_process", healthy)
    detector = encoders.EncoderDetector(Path("ffmpeg"))
    assert await detector.smoke_test("h264_nvenc")
    baseline = recorder.calls
    # 命中缓存：不重跑。
    assert await detector.smoke_test("h264_nvenc")
    assert recorder.calls == baseline
    # 渲染失败 → 清除成功缓存 → 重新真实 smoke。
    detector.invalidate_smoke("h264_nvenc")
    assert await detector.smoke_test("h264_nvenc")
    assert recorder.calls > baseline


@pytest.mark.asyncio
async def test_concurrent_choose_single_flights_smoke(monkeypatch, tmp_path):
    """并发 choose 同 key：available/smoke 只真实执行一次（A07 验收）。"""
    import asyncio

    started = {"encoders": 0, "smokes": 0}
    gate = asyncio.Event()

    async def slow(executable, args, timeout):
        class Result:
            returncode = 0
            stdout = ""
            stderr = ""

        result = Result()
        if "-version" in args:
            result.stdout = "ffmpeg version 8.0-test\n"
        elif "-encoders" in args:
            started["encoders"] += 1
            result.stdout = " V..... h264_nvenc\n V..... libopenh264\n"
            await gate.wait()
        elif "-c:v" in args:
            started["smokes"] += 1
            _touch(args[-1])
            await gate.wait()
        return result

    monkeypatch.setattr(encoders, "run_process", slow)
    detector = encoders.EncoderDetector(Path("ffmpeg"))

    async def one_choose():
        return await detector.choose("auto")

    tasks = [asyncio.ensure_future(one_choose()) for _ in range(6)]
    await asyncio.sleep(0)
    gate.set()
    results = await asyncio.gather(*tasks)
    assert started["encoders"] == 1
    # auto：nvenc smoke 一次（各 choose 共享），成功即选它——libopenh264 不 smoke。
    assert started["smokes"] == 1
    assert all(encoder == "h264_nvenc" for encoder, _ in results)


@pytest.mark.asyncio
async def test_build_id_reads_version_once(monkeypatch, tmp_path):
    """ffmpeg -version 同 build 只读一次（EncoderDetector.build_id）。"""
    recorder = _CallRecorder()
    monkeypatch.setattr(encoders, "run_process", recorder)
    detector = encoders.EncoderDetector(Path("ffmpeg"))
    first = await detector.build_id()
    second = await detector.build_id()
    assert first == second == "ffmpeg version 8.0-test"
    assert recorder.calls == 1  # 两次 build_id 只跑一次 -version


@pytest.mark.asyncio
async def test_reset_clears_session_cache(monkeypatch, tmp_path):
    """reset 显式重测入口：清空 available/smoke 缓存（版本缓存保留）。"""
    recorder = _CallRecorder()
    monkeypatch.setattr(encoders, "run_process", recorder)
    detector = encoders.EncoderDetector(Path("ffmpeg"))
    await detector.build_id()
    await detector.available()
    assert await detector.smoke_test("libopenh264")
    calls_before = recorder.calls
    detector.reset()
    # reset 后：available/smoke 重新真实执行；version 不重读。
    await detector.available()
    assert await detector.smoke_test("libopenh264")
    assert recorder.calls > calls_before
    # -version 未重跑：总增量 = -encoders(1) + smoke 两子进程(2) = 3。
    assert recorder.calls - calls_before == 3
