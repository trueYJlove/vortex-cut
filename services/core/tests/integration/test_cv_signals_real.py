from __future__ import annotations  # noqa: I001

import asyncio
import hashlib
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.media.cv_signals import (
    CV_SAMPLE_GAP_FALLBACK_US,
    CvAnalysisError,
    CvSignalService,
    analyze_video,
    cv_video_args,
)

FFMPEG = (Path(__file__).resolve().parents[4] / "resources/ffmpeg/win-x64/ffmpeg.exe")
FFPROBE = (Path(__file__).resolve().parents[4] / "resources/ffmpeg/win-x64/ffprobe.exe")


def _require_ffmpeg() -> None:
    if not FFMPEG.is_file() or not FFPROBE.is_file():
        pytest.skip("bundled ffmpeg/ffprobe unavailable")


def _synthetic_two_scene_video(path: Path) -> None:
    """3 秒 30fps 合成视频：前 1.5s 灰场、后 1.5s 亮场（强制 I 帧）。"""
    args = [
        str(FFMPEG), "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi",
        "-i", "color=c=0x202020:s=320x180:r=30:d=1.5",
        "-f", "lavfi",
        "-i", "color=c=0xd0d0d0:s=320x180:r=30:d=1.5",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map", "[v]",
        "-g", "15",  # GOP 15（0.5s）：保证两场内各有 I 帧
        "-c:v", "mpeg4",  # 打包 ffmpeg 无 libx264；mpeg4 同样支持 GOP/关键帧
        "-pix_fmt", "yuv420p",
        str(path),
    ]
    subprocess.run(args, check=True, capture_output=True)


def _synthetic_long_gop_video(path: Path, *, duration_s: int = 12, gop_s: int = 6) -> None:
    """长 GOP 合成视频：单色场（无场景切换 → 无额外关键帧），强制 I 帧间隔 = gop_s。

    默认 12s / GOP 6s：I 帧落在 t=0 与 t=6，最大采样间隔 6s > 回退阈值（4s）。
    """
    args = [
        str(FFMPEG), "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi",
        "-i", f"color=c=0x303030:s=320x180:r=30:d={duration_s}",
        "-g", str(gop_s * 30),
        "-c:v", "mpeg4",
        "-pix_fmt", "yuv420p",
        str(path),
    ]
    subprocess.run(args, check=True, capture_output=True)


def _sample_output_bytes(media: Path, *, skip_frame: bool) -> bytes:
    """按生产参数跑一遍采样遍历，返回 rawvideo stdout 原始字节。"""
    args = [str(FFMPEG), *cv_video_args(str(media), skip_frame=skip_frame)]
    proc = subprocess.run(args, capture_output=True, check=True)
    return proc.stdout


def _max_gap_us(samples: list[dict[str, Any]]) -> int:
    return max(
        (b["timestamp_us"] - a["timestamp_us"]
         for a, b in zip(samples, samples[1:])),
        default=0,
    )


def _ffprobe_stub(
    *, video_stream: dict[str, Any] | None = None, duration_us: int = 0
) -> Any:
    """探测替身。

    **`video_stream` 必须可注入**：ADR-0005 阶段 1 的预算准入依赖
    分辨率/帧率/编码，空 stream 会让成本估算恒为 0、准入恒通过——
    那样就测不到准入逻辑本身（本测试初版即栽在此处）。
    """

    class _Probe:
        async def probe(self, path: Path) -> dict[str, Any]:
            return {
                "duration_us": duration_us,
                "video_streams": [video_stream or {}],
                "audio_streams": [],
            }

    return _Probe()


def _service(
    tmp_path: Path, *, probe: Any | None = None
) -> tuple[CvSignalService, Database]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) "
            "VALUES ('p1','P','active','{}','root','root','now','now','now')"
        )
        conn.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES ('a1','p1','video','external','A','fp1',1,'available',"
            "'{}','now','now')"
        )
    return CvSignalService(db, FFMPEG, probe or _ffprobe_stub()), db


def test_real_cv_analysis_detects_scene_cut_and_timestamps(tmp_path: Path) -> None:
    _require_ffmpeg()
    service, db = _service(tmp_path)
    media = tmp_path / "two-scene.mp4"
    _synthetic_two_scene_video(media)
    asset_row = {"id": "a1", "fingerprint": "fp1", "kind": "video"}
    job_id, analysis_id = service.create_analysis_job("p1", asset_row, str(media))
    with db.connection() as conn:
        row = conn.execute("SELECT input_json FROM jobs WHERE id=?", (job_id,)).fetchone()
    result = asyncio.run(service.run_analysis_job(
        {"input_json": row["input_json"]}, asyncio.Event()
    ))
    assert result["status"] == "ready"
    assert result["sample_count"] >= 3  # 3s + GOP 0.5s：至少 3-4 个 I 帧采样
    # 两场交界（~1.5s）必有一个 scene_cut 采样；亮度序列前暗后亮。
    with db.connection() as conn:
        samples = conn.execute(
            "SELECT timestamp_us,scene_cut,motion_energy,sharpness,brightness "
            "FROM cv_samples WHERE analysis_id=? ORDER BY timestamp_us",
            (analysis_id,),
        ).fetchall()
    brightness = [s["brightness"] for s in samples]
    assert any(s["scene_cut"] for s in samples)
    first_half = brightness[: len(brightness) // 2]
    second_half = brightness[len(brightness) // 2:]
    assert sum(second_half) / len(second_half) > sum(first_half) / len(first_half) + 0.2
    # 时间戳单调且落在源时长内。
    timestamps = [s["timestamp_us"] for s in samples]
    assert timestamps == sorted(timestamps)
    assert 0 <= timestamps[0] and timestamps[-1] <= 3_100_000


def test_real_cv_analysis_failure_marks_row_failed(tmp_path: Path) -> None:
    _require_ffmpeg()
    service, db = _service(tmp_path)
    # 非视频文件：ffmpeg 解码失败 → 行落 failed（不冒充 ready）。
    media = tmp_path / "fake.mp4"
    media.write_bytes(b"not-a-video")
    asset_row = {"id": "a1", "fingerprint": "fp1", "kind": "video"}
    job_id, analysis_id = service.create_analysis_job("p1", asset_row, str(media))
    with db.connection() as conn:
        row = conn.execute("SELECT input_json FROM jobs WHERE id=?", (job_id,)).fetchone()
    with pytest.raises(Exception):
        asyncio.run(service.run_analysis_job(
            {"input_json": row["input_json"]}, asyncio.Event()
        ))
    with db.connection() as conn:
        status = conn.execute(
            "SELECT status FROM cv_analyses WHERE id=?", (analysis_id,)
        ).fetchone()[0]
    assert status == "failed"
    _ = json_dumps


# ---- 规划门验收 §3.1 / §3.2 的回归锁（STATUS.md §4 承诺 P1 / P2）----
# 背景：`CV_SKIP_FRAME_PLANNING_GATE_2026-09-20` §3.1 要求"sha256 对拍锁"、
# §3.2 要求"合成长 GOP fixture 的回退触发测试"，交付时只做了人工实测、无自动化
# 用例。ADR-0005 阶段 2 将改动 `run_analysis_job` 的采样决策，故先补护栏。


def test_short_gop_fast_and_full_paths_are_byte_identical(tmp_path: Path) -> None:
    """**P1**：GOP < 采样间隔下限时，快路径与全量路径输出逐字节一致。

    成立条件：I 帧间隔（本 fixture 为 0.5s）< `MIN_SAMPLE_INTERVAL`（1.0s）——
    此时全量路径的"≥1s 兜底"子句永不额外选中帧，两条路径选出的帧集合相同。

    该锁保护的是"非回退素材上双路径等价"这一性质：任何改动若让快路径多选/少选帧
    （例如改 `select` 表达式、误让 skip_frame 影响 `scale`/像素格式），本测试红。
    """
    _require_ffmpeg()
    media = tmp_path / "short-gop.mp4"
    _synthetic_two_scene_video(media)

    fast = _sample_output_bytes(media, skip_frame=True)
    full = _sample_output_bytes(media, skip_frame=False)

    assert fast, "快路径未产出任何采样帧"
    assert hashlib.sha256(fast).hexdigest() == hashlib.sha256(full).hexdigest(), (
        "短 GOP 素材上快路径与全量路径输出不一致——双路径等价性被破坏"
    )

    # 反向对照：长 GOP 素材上两条路径**必然不同**（I 帧稀疏 vs 兜底加密）。
    # 这一条证明上面的相等断言具有区分力，而不是恒真。
    control = tmp_path / "long-gop-control.mp4"
    _synthetic_long_gop_video(control)
    control_fast = _sample_output_bytes(control, skip_frame=True)
    control_full = _sample_output_bytes(control, skip_frame=False)
    assert len(control_fast) < len(control_full), "对照素材上快路径未比全量路径稀疏"
    assert hashlib.sha256(control_fast).hexdigest() != hashlib.sha256(
        control_full
    ).hexdigest(), "长 GOP 素材上双路径输出相同——相等断言缺乏区分力"


def test_long_gop_triggers_full_decode_fallback(tmp_path: Path) -> None:
    """**P2**：长 GOP 素材触发全量解码回退，且兜底采样恢复密度。

    断言链（三者缺一即说明回退机制被破坏）：
    ① 快路径确实稀疏（最大采样间隔 > `CV_SAMPLE_GAP_FALLBACK_US`）——触发条件成立；
    ② 作业编排确实进入 `cv:video-full` 阶段——回退真的发生了；
    ③ 落库样本的最大间隔回落到达标量级——兜底采样确实恢复了密度。
    """
    _require_ffmpeg()
    media = tmp_path / "long-gop.mp4"
    _synthetic_long_gop_video(media)

    # ① 快路径（仅 I 帧）确实稀疏。
    fast_samples = asyncio.run(
        analyze_video(FFMPEG, media, asyncio.Event(), skip_frame=True)
    )
    assert len(fast_samples) >= 2, "长 GOP 素材应至少有 2 个 I 帧采样点"
    assert _max_gap_us(fast_samples) > CV_SAMPLE_GAP_FALLBACK_US, (
        "fixture 未构成长 GOP 条件（最大间隔未超阈值）——需调整生成参数"
    )

    # ② 作业编排进入回退阶段。
    service, db = _service(tmp_path)
    stages: list[str] = []
    asset_row = {"id": "a1", "fingerprint": "fp1", "kind": "video"}
    job_id, analysis_id = service.create_analysis_job("p1", asset_row, str(media))
    with db.connection() as conn:
        row = conn.execute("SELECT input_json FROM jobs WHERE id=?", (job_id,)).fetchone()
    result = asyncio.run(service.run_analysis_job(
        {"input_json": row["input_json"]}, asyncio.Event(), None, stages.append
    ))
    assert result["status"] == "ready"
    assert "cv:video-full" in stages, "长 GOP 素材未触发全量解码回退"
    # ADR-0005 阶段 1：准入通过时密度应达 full（未留下"本该填而没填"的盲区）。
    assert result["density_status"] == "full"
    assert result["fallback_aborted"] is False

    # ③ 兜底采样恢复密度：最大间隔回落到采样下限量级（1s + 一帧容差）。
    with db.connection() as conn:
        samples = conn.execute(
            "SELECT timestamp_us FROM cv_samples WHERE analysis_id=? ORDER BY timestamp_us",
            (analysis_id,),
        ).fetchall()
    gaps = [b["timestamp_us"] - a["timestamp_us"] for a, b in zip(samples, samples[1:])]
    assert gaps, "回退后应产出多个采样点"
    assert max(gaps) <= 1_500_000, (
        f"回退后采样密度未恢复：最大间隔 {max(gaps) / 1e6:.2f}s"
    )


# ---- ADR-0005 阶段 1：预算准入与中止语义 ----


def _run_job(service: CvSignalService, media: Path, stages: list[str]) -> dict[str, Any]:
    asset_row = {"id": "a1", "fingerprint": "fp1", "kind": "video"}
    job_id, _analysis_id = service.create_analysis_job("p1", asset_row, str(media))
    with service.db.connection() as conn:
        row = conn.execute("SELECT input_json FROM jobs WHERE id=?", (job_id,)).fetchone()
    return asyncio.run(service.run_analysis_job(
        {"input_json": row["input_json"]}, asyncio.Event(), None, stages.append
    ))


def test_budget_blocks_unaffordable_fallback_and_marks_sparse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**预算准入**阻止付不起的回退，并以 sparse 如实标记。

    把预算压到 0 来模拟"4K60 长 GOP 素材"的实际处境（真实基线：完整作业
    40.5 s/分钟源，超门 4.1 倍）——该场景下保守估算远超预算，回退**根本不该启动**。
    断言：不进入 cv:video-full、density_status='sparse'、样本数回落为 I 帧数。
    """
    import aivs_core.media.cv_signals as cv_module

    _require_ffmpeg()
    monkeypatch.setattr(cv_module, "CV_PER_MINUTE_BUDGET_S", 0.0)
    monkeypatch.setattr(cv_module, "CV_BUDGET_FLOOR_S", 0.0)

    # 探测替身必须给真实元数据，否则成本估算恒为 0、准入恒通过。
    probe = _ffprobe_stub(
        video_stream={
            "codec": "mpeg4", "width": 320, "height": 180,
            "avg_frame_rate_num": 30, "avg_frame_rate_den": 1,
        },
        duration_us=12_000_000,
    )
    service, _db = _service(tmp_path, probe=probe)
    media = tmp_path / "long-gop.mp4"
    _synthetic_long_gop_video(media)
    stages: list[str] = []
    result = _run_job(service, media, stages)

    assert "cv:video" in stages
    assert "cv:video-full" not in stages, "预算不足时不应启动全量回退"
    assert result["density_status"] == "sparse", "未回退必须如实标记 sparse"
    assert result["fallback_aborted"] is False
    assert result["sample_count"] == 2, "应为纯 I 帧采样（12s / GOP 6s）"
    assert result["achieved_max_gap_us"] > CV_SAMPLE_GAP_FALLBACK_US


def test_run_fallback_aborts_on_deadline_and_merges_partial(tmp_path: Path) -> None:
    """**deadline 兜底 + 阶段 2 合并**：回退超时即中止，保留全片覆盖。

    估算模型已知可高估约 2.4 倍，不足以单独作保证，故该兜底必须独立可用。
    用极小 deadline 确定性触发中止路径。阶段 2：中止后与快路径 I 帧合并
    （密集前缀 + I 帧尾部），不再 `samples is fast` 整段丢弃。
    """
    _require_ffmpeg()
    service, _db = _service(tmp_path)
    media = tmp_path / "long-gop.mp4"
    _synthetic_long_gop_video(media)
    fast = asyncio.run(analyze_video(FFMPEG, media, asyncio.Event(), skip_frame=True))
    assert len(fast) == 2

    samples, aborted = asyncio.run(
        service._run_fallback(media, fast, asyncio.Event(), deadline_s=0.001)
    )
    assert aborted is True, "极小 deadline 下回退应被中止"
    # 合并结果必须覆盖全片（含快路径尾部），不得丢段。
    assert len(samples) >= len(fast)
    assert samples[-1]["timestamp_us"] == fast[-1]["timestamp_us"]
    assert samples[0]["timestamp_us"] == min(fast[0]["timestamp_us"], samples[0]["timestamp_us"])


def test_run_fallback_prioritises_job_cancel_over_deadline(tmp_path: Path) -> None:
    """**中止语义区分**：作业取消优先于回退中止。

    若顺序写反，用户取消会被误判为"回退中止"，从而错误地产出一份 sparse 结果
    （规划门 §2.4 明确要求避免）。
    """
    _require_ffmpeg()
    service, _db = _service(tmp_path)
    media = tmp_path / "long-gop.mp4"
    _synthetic_long_gop_video(media)
    fast = asyncio.run(analyze_video(FFMPEG, media, asyncio.Event(), skip_frame=True))

    cancelled = asyncio.Event()
    cancelled.set()
    with pytest.raises(CvAnalysisError) as excinfo:
        asyncio.run(
            service._run_fallback(media, fast, cancelled, deadline_s=30.0)
        )
    assert excinfo.value.code == "JOB_CANCELLED"


def test_run_fallback_returns_fast_samples_when_budget_already_spent(tmp_path: Path) -> None:
    """预算已耗尽（deadline<=0）时不启动子进程，直接按中止处理。"""
    _require_ffmpeg()
    service, _db = _service(tmp_path)
    media = tmp_path / "long-gop.mp4"
    _synthetic_long_gop_video(media)
    fast = asyncio.run(analyze_video(FFMPEG, media, asyncio.Event(), skip_frame=True))

    samples, aborted = asyncio.run(
        service._run_fallback(media, fast, asyncio.Event(), deadline_s=0.0)
    )
    assert aborted is True
    assert samples is fast

def test_analyze_video_cancel_interrupts_in_flight_decode(tmp_path: Path) -> None:
    """**中途取消**：解码进行中置位取消应迅速中止，而非等解码跑完。

    该能力是 ADR-0005 阶段 1「回退超预算即中止」的前提——此前 `cancel_event`
    只在读循环**结束后**检查，一次 4K60 全量解码必须白等到底。

    **本测试证明**：取消路径抛 `JOB_CANCELLED` 且**及时返回**（不阻塞于解码）。
    **本测试不证明**：OS 层面无残留进程——该保证由 `process.kill()` 后紧跟
    `await process.wait()`（收尸）在实现上成立，本测试未做 OS 级断言。
    """
    _require_ffmpeg()
    media = tmp_path / "long-gop.mp4"
    # 30s / GOP 15s：全量解码耗时显著长于取消延迟，使"未及时返回"可辨识。
    _synthetic_long_gop_video(media, duration_s=30, gop_s=15)
    cancel = asyncio.Event()

    async def _run() -> None:
        task = asyncio.create_task(
            analyze_video(FFMPEG, media, cancel, skip_frame=False)
        )
        await asyncio.sleep(0.05)  # 让解码真正启动
        cancel.set()
        await task

    started = time.perf_counter()
    with pytest.raises(CvAnalysisError) as excinfo:
        asyncio.run(_run())
    elapsed = time.perf_counter() - started
    assert excinfo.value.code == "JOB_CANCELLED"
    # 及时返回：若取消未生效，需等完 30s 源的全量解码。
    assert elapsed < 5.0, f"取消未及时生效（{elapsed:.1f}s）"


# ---- 细粒度进度（2026-10-10 独立小单；STATUS §5「细粒度进度仍缺失」核销）----


class TestFineGrainedProgress:
    def test_analyze_video_streams_by_sample_count(self, tmp_path: Path) -> None:
        """等间隔采样路径：进度按实际样本数/期望样本数流式上报（真实 ffmpeg）。

        3s 素材 + 0.2s 间隔 ≈ 15 帧；回调序列必须：非空、单调递增、≤0.99、
        无重复值（整百分点节流——每次回调一条 DB UPDATE，写放大必须受控）。
        """
        _require_ffmpeg()
        media = tmp_path / "prog.mp4"
        _synthetic_two_scene_video(media)
        calls: list[float] = []
        samples = asyncio.run(analyze_video(
            FFMPEG, media, asyncio.Event(),
            skip_frame=False, sample_interval_s=0.2,
            progress=calls.append, expected_samples=15,
        ))
        assert len(samples) >= 10
        assert calls, "progress 回调从未触发"
        assert calls == sorted(calls), f"进度非单调: {calls}"
        assert all(call <= 0.99 for call in calls)
        assert len(calls) == len(set(calls)), f"整百分点节流失效（重复桶）: {calls}"

    def test_analyze_video_no_progress_without_expected(self, tmp_path: Path) -> None:
        """I 帧快路径语义：无期望样本数（GOP 未知）→ 不流式（阶段级 stage 承担）。"""
        _require_ffmpeg()
        media = tmp_path / "prog-fast.mp4"
        _synthetic_two_scene_video(media)
        calls: list[float] = []
        asyncio.run(analyze_video(
            FFMPEG, media, asyncio.Event(),
            skip_frame=True, progress=calls.append,
        ))
        assert calls == []

    def test_run_analysis_job_reports_monotonic_progress(self, tmp_path: Path) -> None:
        """作业级：进度序列阶段递进（0.05 起步 … 1.0 收尾）、单调、含中途值。

        该锁同时钉住「中途进度」这一验收点：还原旧实现（全程 progress=0、
        仅末尾 1.0）时本测试红（calls 尾部才有 1.0，缺 <0.5 的中途值）。
        """
        _require_ffmpeg()
        service, db = _service(tmp_path)
        media = tmp_path / "job-prog.mp4"
        _synthetic_two_scene_video(media)
        asset_row = {"id": "a1", "fingerprint": "fp1", "kind": "video"}
        job_id, _analysis_id = service.create_analysis_job("p1", asset_row, str(media))
        with db.connection() as conn:
            row = conn.execute("SELECT input_json FROM jobs WHERE id=?", (job_id,)).fetchone()
        calls: list[float] = []
        result = asyncio.run(service.run_analysis_job(
            {"input_json": row["input_json"]}, asyncio.Event(),
            progress=calls.append,
        ))
        assert result["status"] == "ready"
        assert calls and calls[-1] == 1.0
        assert calls == sorted(calls)
        mid = [call for call in calls[:-1] if call < 0.5]
        assert mid, f"缺中途进度（长分析仍全程 0 直到 1.0）: {calls}"
