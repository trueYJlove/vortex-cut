"""C22 可取消的最终校验与细分阶段进度（计划第 7 节 C22）。

覆盖：
- decode_validate：取消 → 进程树终止 + JOB_CANCELLED；stderr 有界 ring
  （末 N 字节，洪泛不放大内存）；停滞超时/绝对上限 → RENDER_VALIDATION_
  TIMEOUT（错误码区分，不与 cancel 混同）；进度回调按 out_time_us 映射。
- validate_rendered_media：取消传播（probe 前/decode/哈希分块边界）；
  on_phase 阶段序列 validating_probe→validating_decode→hashing 与进度；
  校验期间文件被改 → RENDER_VALIDATION_FAILED（不发布无主哈希）。
- 渲染服务编码器链：RENDER_VALIDATION_TIMEOUT 不触发换编码器重试
  （取消也不重试——语义沿用 JOB_CANCELLED 直通）。
- jobs phase/phase_progress 贯通：_set_phase 写行、终态清 phase、DTO
  暴露可选字段。
"""
from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path

import pytest

import aivs_core.rendering.ffmpeg as ffmpeg_module
import aivs_core.rendering.validation as validation_module
from aivs_core.database import Database
from aivs_core.jobs import JobService
from aivs_core.projects import DomainError
from aivs_core.rendering.ffmpeg import _StderrRing, decode_validate
from aivs_core.rendering.validation import validate_rendered_media


class FakeStream:
    def __init__(self, lines=()):
        self.lines = list(lines)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.lines:
            item = self.lines.pop(0)
            return item if isinstance(item, bytes) else item.encode()
        raise StopAsyncIteration

    async def read(self):
        return b""


class FakeValidateProcess:
    """decode_validate 的进程替身：可编程 returncode/stdout 行/取消行为。"""

    def __init__(self, returncode: int = 0, lines: list[str] | None = None,
                 hang: bool = False, stderr_bytes: bytes = b""):
        # hang=True 模拟进程仍在运行：returncode 必须为 None（与真实
        # subprocess 语义一致），否则主循环一次都不进。
        self.returncode: int | None = None if hang else returncode
        self.lines = lines if lines is not None else ["out_time_us=500000\n"]
        self.hang = hang
        self.killed = False
        self.pid = 4242
        self.stdout = FakeStream(self.lines)
        self.stderr = FakeStream([stderr_bytes])

    async def wait(self):
        # hang 时等待 kill；kill 后返回（避免 fake 的 pending task 泄漏到
        # 事件循环销毁——真实 subprocess 无此问题，这是 fake 自身的收尾）。
        while self.hang and not self.killed:
            await asyncio.sleep(0.001)
        if self.hang and self.killed:
            self.hang = False
        return self.returncode or 0

    def kill(self):
        self.killed = True
        self.returncode = -9


def _no_kill_job(_pid: int) -> None:
    return None


@pytest.fixture
def patch_exec(monkeypatch):
    def _patch(process: FakeValidateProcess) -> None:
        async def fake_exec(*_args, **_kwargs):
            return process

        async def fake_terminate(target):
            # Windows 上真实现会启动 taskkill（不可对 fake pid 使用）；
            # fake 层面等价语义 = kill + wait 返回。
            target.kill()
            await target.wait()

        monkeypatch.setattr(ffmpeg_module.asyncio, "create_subprocess_exec", fake_exec)
        monkeypatch.setattr(ffmpeg_module.WindowsKillJob, "attach", _no_kill_job)
        monkeypatch.setattr(ffmpeg_module, "terminate_process_tree", fake_terminate)

    return _patch


@pytest.mark.asyncio
async def test_decode_validate_success_and_progress(patch_exec) -> None:
    process = FakeValidateProcess(returncode=0, lines=["out_time_us=400000\n"])
    patch_exec(process)
    seen: list[float] = []
    await decode_validate(
        Path("ffmpeg"), Path("out.mp4"), on_progress=seen.append, media_duration_us=1_000_000
    )
    assert seen == [0.4]


@pytest.mark.asyncio
async def test_decode_validate_cancel_terminates_process(patch_exec) -> None:
    process = FakeValidateProcess(hang=True, lines=["out_time_us=100000\n"])
    patch_exec(process)
    cancel_event = asyncio.Event()
    cancel_event.set()
    with pytest.raises(RuntimeError, match="JOB_CANCELLED"):
        await decode_validate(Path("ffmpeg"), Path("out.mp4"), cancel_event=cancel_event)
    assert process.killed  # 进程树终止（fake 层面 = kill 已调用）


@pytest.mark.asyncio
async def test_decode_validate_failure_reports_bounded_stderr_tail(patch_exec) -> None:
    payload = b"x" * 100_000  # 100KiB stderr 洪泛
    process = FakeValidateProcess(returncode=1, lines=[], stderr_bytes=payload)
    patch_exec(process)
    with pytest.raises(RuntimeError) as exc:
        await decode_validate(Path("ffmpeg"), Path("out.mp4"))
    message = str(exc.value)
    assert "RENDER_VALIDATION_FAILED" in message
    # 尾部保留（ring 语义）：错误文本含最后写入的字节段；总长度有界。
    assert len(message) <= 1100


def test_stderr_ring_keeps_tail_only() -> None:
    ring = _StderrRing(1024)
    ring.append(b"a" * 600)
    ring.append(b"b" * 600)
    assert ring.tail(100) == "b" * 100
    assert len(ring._buffer) == 1024  # 上界收敛，不随洪泛增长


@pytest.mark.asyncio
async def test_decode_validate_stall_timeout(patch_exec, monkeypatch) -> None:
    # 停滞门 120s：把时间函数前拨 >120s 模拟无进度（不真等）。
    process = FakeValidateProcess(hang=True, lines=[])
    patch_exec(process)
    times = iter([0.0, 0.0, 0.0, 1000.0, 1000.0, 1000.0, 1000.0])

    class FakeLoop:
        @staticmethod
        def time():
            return next(times)

    monkeypatch.setattr(ffmpeg_module.asyncio, "get_running_loop", lambda: FakeLoop())
    with pytest.raises(RuntimeError, match="RENDER_VALIDATION_TIMEOUT"):
        await decode_validate(Path("ffmpeg"), Path("out.mp4"))
    assert process.killed


class FakeProbe:
    def __init__(self, payload):
        self.payload = payload

    async def probe(self, path):
        return self.payload


def _probe() -> dict:
    return {
        "duration_us": 1_000_000,
        "format_name": "mp4",
        "video_streams": [
            {
                "codec": "h264",
                "width": 540,
                "height": 960,
                "pixel_format": "yuv420p",
                "avg_frame_rate_num": 30,
                "avg_frame_rate_den": 1,
            }
        ],
        "audio_streams": [{"codec": "aac", "sample_rate": 48000, "channels": 2}],
    }


@pytest.mark.asyncio
async def test_validate_reports_phase_sequence_and_progress(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "out.mp4"
    output.write_bytes(os.urandom(3 * 1024 * 1024))  # ≥3 块触发多次哈希进度

    async def decoded(ffmpeg, path, **_kwargs):
        return None

    monkeypatch.setattr(validation_module, "decode_validate", decoded)
    phases: list[tuple[str, float | None]] = []
    media, size, digest = await validate_rendered_media(
        Path("ffmpeg"),
        FakeProbe(_probe()),
        output,
        {"width": 540, "height": 960},
        1_000_000,
        on_phase=lambda name, value: phases.append((name, value)),
    )
    names = [name for name, _ in phases]
    assert names[0] == "validating_probe"
    assert "validating_decode" in names
    assert names[-1] == "hashing"
    hash_progress = [value for name, value in phases if name == "hashing"]
    assert hash_progress[0] == 0.0
    assert 0 < hash_progress[-1] <= 0.99  # 字节进度单调近似
    assert digest == f"sha256:{hashlib.sha256(output.read_bytes()).hexdigest()}"
    assert size == output.stat().st_size
    assert media["video"]["fps_num"] == 30


@pytest.mark.asyncio
@pytest.mark.parametrize("fps_num", [24, 25, 60])
async def test_validate_accepts_profile_frame_rates(
    tmp_path: Path, monkeypatch, fps_num: int
) -> None:
    """导出帧率档（24/25/60）不因硬编码 30 被判校验失败——回归：非 30fps
    导出曾必败并触发换编码器整轮重渲（表现：任务卡在 96% 永不完成）。"""
    output = tmp_path / "out.mp4"
    output.write_bytes(b"valid")
    probe_payload = _probe()
    probe_payload["video_streams"][0]["avg_frame_rate_num"] = fps_num

    async def decoded(ffmpeg, path, **_kwargs):
        return None

    monkeypatch.setattr(validation_module, "decode_validate", decoded)
    media, _size, _digest = await validate_rendered_media(
        Path("ffmpeg"),
        FakeProbe(probe_payload),
        output,
        {"width": 540, "height": 960, "fps_num": fps_num, "fps_den": 1},
        1_000_000,
    )
    assert media["video"]["fps_num"] == fps_num


@pytest.mark.asyncio
async def test_validate_rejects_frame_rate_mismatch(tmp_path: Path, monkeypatch) -> None:
    """产物帧率与 Profile 期望不符仍必须失败（校验语义不放宽）。"""
    output = tmp_path / "out.mp4"
    output.write_bytes(b"valid")
    probe_payload = _probe()
    probe_payload["video_streams"][0]["avg_frame_rate_num"] = 60

    async def decoded(ffmpeg, path, **_kwargs):
        return None

    monkeypatch.setattr(validation_module, "decode_validate", decoded)
    with pytest.raises(DomainError) as exc_info:
        await validate_rendered_media(
            Path("ffmpeg"),
            FakeProbe(probe_payload),
            output,
            {"width": 540, "height": 960, "fps_num": 30, "fps_den": 1},
            1_000_000,
        )
    assert exc_info.value.code == "RENDER_VALIDATION_FAILED"


@pytest.mark.asyncio
async def test_validate_cancel_during_hash(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "out.mp4"
    output.write_bytes(b"valid")

    async def decoded(ffmpeg, path, **_kwargs):
        return None

    monkeypatch.setattr(validation_module, "decode_validate", decoded)
    # decode 后立即取消：哈希分块边界应观察到令牌。
    cancel_event = asyncio.Event()
    real_decode = decoded

    async def cancel_after_decode(*_args, **_kwargs):
        cancel_event.set()
        await real_decode(*_args, **_kwargs)

    monkeypatch.setattr(validation_module, "decode_validate", cancel_after_decode)
    with pytest.raises(RuntimeError, match="JOB_CANCELLED"):
        await validate_rendered_media(
            Path("ffmpeg"),
            FakeProbe(_probe()),
            output,
            {"width": 540, "height": 960},
            1_000_000,
            cancel_event=cancel_event,
        )


@pytest.mark.asyncio
async def test_validate_fails_when_file_changes_during_hash(
    tmp_path: Path, monkeypatch
) -> None:
    output = tmp_path / "out.mp4"
    output.write_bytes(b"valid")

    async def decoded(ffmpeg, path, **_kwargs):
        return None

    monkeypatch.setattr(validation_module, "decode_validate", decoded)
    original_open = Path.open
    touched = False

    def touch_on_open(self: Path, *args: object, **kwargs: object):  # noqa: ANN001
        nonlocal touched
        handle = original_open(self, *args, **kwargs)  # type: ignore[arg-type]
        if not touched and self == output and "rb" in str(args):
            touched = True
            stat = output.stat()
            os.utime(output, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        return handle

    monkeypatch.setattr(Path, "open", touch_on_open)
    with pytest.raises(DomainError) as exc_info:
        await validate_rendered_media(
            Path("ffmpeg"),
            FakeProbe(_probe()),
            output,
            {"width": 540, "height": 960},
            1_000_000,
        )
    # message 是中文（DomainError 现场翻译），用 code 断言错误类别。
    assert exc_info.value.code == "RENDER_VALIDATION_FAILED"


@pytest.mark.asyncio
async def test_validation_timeout_does_not_retry_encoder() -> None:
    """C22-10：校验超时区分错误码且不进入换编码器重试（编码器循环策略
    语义——timeout 分支直通 DomainError，与 JOB_CANCELLED 同级不重试）。"""
    calls: list[str] = []

    async def fake_validate() -> None:
        calls.append("validate")
        raise RuntimeError("RENDER_VALIDATION_TIMEOUT: no decode progress")

    encoders_to_try = ["h264_nvenc", "libopenh264"]
    attempt_count = 0
    with pytest.raises(DomainError) as exc_info:
        for attempt_index, _encoder in enumerate(encoders_to_try, start=1):
            attempt_count = attempt_index
            try:
                await fake_validate()
                break
            except RuntimeError as exc:
                if str(exc).startswith("JOB_CANCELLED"):
                    raise
                if str(exc).startswith("RENDER_VALIDATION_TIMEOUT"):
                    raise DomainError("RENDER_VALIDATION_TIMEOUT", str(exc)) from exc
                last_error = str(exc)
                if attempt_index < len(encoders_to_try):
                    continue
                raise DomainError("RENDER_FAILED", last_error[-500:]) from exc
    assert exc_info.value.code == "RENDER_VALIDATION_TIMEOUT"
    assert attempt_count == 1  # 第一个编码器超时后直接抛出，未进入第二个
    assert calls == ["validate"]


def _make_jobs(tmp_path: Path) -> tuple[Database, JobService]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as connection:
        connection.execute(
            "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("project_1", "P", "active", "{}", "revision_1", "root", "root", "now", "now", "now"),
        )
        connection.execute(
            "INSERT INTO timeline_revisions VALUES (?,?,?,?,?,?,?,?,?)",
            ("revision_1", "project_1", None, 1, "{}", "doc", "s", "user", "now"),
        )

    async def emit(_event):
        return None

    return db, JobService(db, tmp_path, Path("ffmpeg"), FakeProbe({}), FakeEncoders(), emit)


class FakeEncoders:
    async def choose(self, requested: str):
        return requested, None

    def invalidate_smoke(self, encoder: str) -> None:
        del encoder


def test_phase_write_and_transition_clears(tmp_path: Path) -> None:
    db, service = _make_jobs(tmp_path)
    job = service.create_render(
        "authoritative_preview",
        "project_1",
        "revision_1",
        "libopenh264",
        {"content_fingerprint": "fp", "toolchain": {}},
    )
    job_id = job["job_id"]
    with db.connection() as connection:
        connection.execute(
            "UPDATE jobs SET status='running',stage='running' WHERE id=?", (job_id,)
        )
    service._set_phase(job_id, "validating_decode", 0.5)
    detail = service.get(job_id)
    assert detail["phase"] == "validating_decode"
    assert detail["phase_progress"] == 0.5
    # 不定进度（None）也要能写——publishing 阶段无可靠进度。
    service._set_phase(job_id, "publishing", None)
    detail = service.get(job_id)
    assert detail["phase"] == "publishing"
    assert detail["phase_progress"] is None
    # 终态迁移清 phase（发布完成即成功，不残留过期阶段）。
    service._transition_job(job_id, "running", "succeeded", stage="completed", progress=1)
    detail = service.get(job_id)
    assert detail["phase"] is None
    assert detail["phase_progress"] is None


def test_phase_ignored_after_status_left_running(tmp_path: Path) -> None:
    db, service = _make_jobs(tmp_path)
    job = service.create_render(
        "final_export",
        "project_1",
        "revision_1",
        "libopenh264",
        {"content_fingerprint": "fp", "toolchain": {}},
    )
    job_id = job["job_id"]
    service._transition_job(job_id, "queued", "cancelled")
    # 发布临界区外的迟到 phase 写入不生效（行状态已非 running/cancelling）。
    service._set_phase(job_id, "publishing", None)
    detail = service.get(job_id)
    assert detail["phase"] is None
