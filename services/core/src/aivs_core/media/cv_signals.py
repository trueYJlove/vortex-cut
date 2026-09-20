"""AI-2 Layer 0：本地 CV 信号分析（ADR-0003 D3——全程本地零 egress）。

规划门（AI_2_CV_SIGNALS_PLANNING_GATE_2026-09-20）阶段一：模型无关信号集，
纯 numpy 计算。管线形态对齐 B14 waveform（FFmpeg 解码流式 stdout + Python
O(状态) 聚合；不整段缓冲）：

- 一次视频遍历：`-vf select=关键帧(带时间下限兜底),scale=64x36,format=gray`
  rawvideo stdout → 逐帧 [0,1] 归一 → 信号计算；
- 信号集 v1：镜头边界（相邻采样帧直方图距离）、运动能量（相邻采样帧
  差分均值）、清晰度（拉普拉斯方差，模糊检测）、亮度；采样帧带 pts 时间戳；
- 一次音频遍历：astats 窗口 RMS → audio_energy（无音轨跳过，恒 0）；
- 关键帧采样的取舍（规划门 §2）：运动能量退化为采样帧间差分（粒度 =
  GOP 长度），对"跑动 vs 静止"级召回区分足够；换来 4K60 只解 I 帧。

face_count/face_score 列由阶段二（YuNet ONNX）回填，本阶段恒 NULL。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import numpy as np

from ..database import Database, json_dumps, json_loads, utc_now
from ..ids import new_id

# 算法常量（改值 = algorithm_version 递增，新行不与旧条目互撞）
CV_ALGORITHM_VERSION = 1
THUMB_WIDTH = 64
THUMB_HEIGHT = 36
# 采样密度下限：GOP 超长素材的关键帧间隔兜底（秒）——select 表达式在
# "关键帧 或 距上个输出帧 ≥ MIN_SAMPLE_INTERVAL" 任一满足时输出。
MIN_SAMPLE_INTERVAL = 1.0
# 镜头边界阈值：相邻采样帧直方图卡方距离（归一 [0,1] 域；标定值，
# 调整须递增 algorithm_version）。
SCENE_CUT_DISTANCE = 0.45
# 拉普拉斯核（清晰度 = 卷积方差；纯 numpy，无 scipy 依赖）
_LAPLACIAN = np.array(
    [[0.0, 1.0, 0.0], [1.0, -4.0, 1.0], [0.0, 1.0, 0.0]], dtype=np.float32
)


class CvAnalysisError(RuntimeError):
    """CV 信号分析失败。code 进 jobs error_code。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ---- 纯函数：信号计算（单测主对象） ----


def frame_signals(
    current: np.ndarray,
    previous: np.ndarray | None,
) -> dict[str, Any]:
    """单采样帧信号（输入为 [0,1] 归一灰度帧，float32）。

    - brightness：像素均值；
    - sharpness：拉普拉斯方差（模糊帧方差趋 0）；
    - motion_energy：与前帧差分均值（首帧为 0.0）；
    - scene_cut：与前帧直方图卡方距离 > 阈值（首帧 False）。
    """
    brightness = float(current.mean())
    lap = _convolve2d(current, _LAPLACIAN)
    sharpness = float(lap.var())
    if previous is None:
        return {
            "brightness": brightness,
            "sharpness": sharpness,
            "motion_energy": 0.0,
            "scene_cut": False,
        }
    diff = np.abs(current - previous)
    motion_energy = float(diff.mean())
    scene_cut = _histogram_distance(current, previous) > SCENE_CUT_DISTANCE
    return {
        "brightness": brightness,
        "sharpness": sharpness,
        "motion_energy": motion_energy,
        "scene_cut": bool(scene_cut),
    }


def _convolve2d(frame: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    """same-size 2D 卷积（3x3 核专用；边界零填充）。"""
    padded = np.pad(frame, 1, mode="constant")
    rows, cols = frame.shape
    out = np.zeros((rows, cols), dtype=np.float32)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            out += kernel[dy + 1, dx + 1] * padded[1 + dy:1 + dy + rows, 1 + dx:1 + dx + cols]
    return out


def _histogram_distance(a: np.ndarray, b: np.ndarray, bins: int = 32) -> float:
    """归一 [0,1] 域直方图卡方距离（镜头边界检测）。"""
    hist_a, _ = np.histogram(a, bins=bins, range=(0.0, 1.0))
    hist_b, _ = np.histogram(b, bins=bins, range=(0.0, 1.0))
    total_a, total_b = hist_a.sum(), hist_b.sum()
    if total_a == 0 or total_b == 0:
        return 0.0
    pa = hist_a / total_a
    pb = hist_b / total_b
    return float(((pa - pb) ** 2 / (pa + pb + 1e-9)).sum() / 2.0)


# ---- FFmpeg 参数（白名单式组装） ----


def cv_video_args(input_path: str) -> list[str]:
    """关键帧采样灰度缩略帧 → rawvideo stdout。

    select 表达式：I 帧，或距上个输出帧 ≥ MIN_SAMPLE_INTERVAL（长 GOP
    素材的采样密度下限兜底）。采样帧 pts 时间戳经 showinfo 打进 stderr，
    由 _parse_showinfo 解析——rawvideo 流本身无帧元数据。
    """
    return [
        "-hide_banner", "-nostdin", "-y",
        "-i", str(input_path),
        "-an",
        "-vf",
        (
            f"select='eq(pict_type\\,I)+gte(t-prev_selected_t\\,{MIN_SAMPLE_INTERVAL})',"
            f"scale={THUMB_WIDTH}:{THUMB_HEIGHT},format=gray,showinfo"
        ),
        "-fps_mode", "vfr",
        "-f", "rawvideo",
        "-pix_fmt", "gray",
        "-progress", "pipe:2", "-nostats",
        "pipe:1",
    ]


def cv_audio_args(input_path: str, window: float = 1.0) -> list[str]:
    """窗口 RMS → ffmpeg ametadata 打印进 stderr（astats 每 1s 窗口）。"""
    return [
        "-hide_banner", "-nostdin", "-y",
        "-i", str(input_path),
        "-vn",
        "-map", "0:a:0",
        "-af", f"astats=metadata=1:reset={int(window * 48000)}",
        "-f", "null",
        "-progress", "pipe:2", "-nostats",
        "-",
    ]


def _parse_showinfo(stderr: str) -> list[int]:
    """showinfo 的 n: 行 → 采样帧 pts 序列（微秒）。"""
    timestamps: list[int] = []
    for line in stderr.splitlines():
        if "showinfo" in line and "pts_time:" in line:
            try:
                pts_text = line.split("pts_time:", 1)[1].split(" ", 1)[0].strip()
                timestamps.append(int(float(pts_text) * 1_000_000))
            except (ValueError, IndexError):
                continue
    return timestamps


def _parse_astats_rms(stderr: str) -> list[float]:
    """astats 的 RMS level dB 行（窗口序）→ 线性能量 [0,1] 近似。"""
    values: list[float] = []
    for line in stderr.splitlines():
        if "RMS level dB:" in line:
            try:
                db_text = line.split("RMS level dB:", 1)[1].strip().split(" ", 1)[0]
                db = float(db_text)
            except (ValueError, IndexError):
                continue
            if db <= -60.0:  # 静音窗口钳 0
                values.append(0.0)
            else:
                values.append(min(1.0, 10.0 ** (db / 20.0)))
    return values


# ---- 采集执行体 ----


async def analyze_video(
    ffmpeg: Path,
    input_path: Path,
    cancel_event: asyncio.Event,
    progress: Any = None,
) -> list[dict[str, Any]]:
    """一次遍历：采样帧流 + 逐帧信号。返回按 timestamp_us 升序的样本列表。"""
    process = await asyncio.create_subprocess_exec(
        str(ffmpeg),
        *cv_video_args(str(input_path)),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert process.stderr is not None
    stderr_task = asyncio.create_task(process.stderr.read())
    frame_bytes = THUMB_WIDTH * THUMB_HEIGHT
    samples: list[dict[str, Any]] = []
    previous: np.ndarray | None = None
    try:
        assert process.stdout is not None
        while True:
            chunk = await process.stdout.read(frame_bytes * 16)
            if not chunk:
                break
            # 帧对齐切块（read 可能跨帧边界返回任意长度）
            offset = 0
            while offset + frame_bytes <= len(chunk):
                frame = (
                    np.frombuffer(
                        chunk, dtype=np.uint8, count=frame_bytes, offset=offset
                    )
                    .reshape(THUMB_HEIGHT, THUMB_WIDTH)
                    .astype(np.float32)
                    / 255.0
                )
                signals = frame_signals(frame, previous)
                samples.append(signals)
                previous = frame
                offset += frame_bytes
        await process.wait()
        stderr = (await stderr_task).decode("utf-8", errors="replace")[-262144:]
    finally:
        if not stderr_task.done():
            stderr_task.cancel()
    if cancel_event.is_set():
        raise CvAnalysisError("JOB_CANCELLED", "任务已取消")
    if process.returncode != 0:
        raise CvAnalysisError("CV_FFMPEG_FAILED", "CV 信号解码失败: " + stderr[-300:])
    timestamps = _parse_showinfo(stderr)
    if len(timestamps) != len(samples):
        raise CvAnalysisError(
            "CV_TIMESTAMP_MISMATCH",
            f"采样帧时间戳数不匹配（{len(timestamps)} vs {len(samples)}）",
        )
    for sample, timestamp in zip(samples, timestamps, strict=True):
        sample["timestamp_us"] = timestamp
    samples.sort(key=lambda item: item["timestamp_us"])
    return samples


async def analyze_audio_energy(
    ffmpeg: Path,
    input_path: Path,
    cancel_event: asyncio.Event,
) -> list[float]:
    """音频窗口 RMS 能量序列（无音轨返回空）。"""
    process = await asyncio.create_subprocess_exec(
        str(ffmpeg),
        *cv_audio_args(str(input_path)),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert process.stderr is not None
    stderr_task = asyncio.create_task(process.stderr.read())
    await process.wait()
    stderr = (await stderr_task).decode("utf-8", errors="replace")[-262144:]
    if cancel_event.is_set():
        raise CvAnalysisError("JOB_CANCELLED", "任务已取消")
    if process.returncode != 0:
        raise CvAnalysisError("CV_FFMPEG_FAILED", "CV 音频能量分析失败: " + stderr[-300:])
    return _parse_astats_rms(stderr)


# ---- 服务层：登记/执行/查询（waveform 模式） ----


class CvSignalService:
    def __init__(self, db: Database, ffmpeg: Path, ffprobe: Any) -> None:
        self.db = db
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe

    def analysis_row(self, asset_row: dict[str, Any]) -> dict[str, Any] | None:
        """素材最新非 stale 分析行（召回层入口）。"""
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM cv_analyses WHERE asset_id=? AND status='ready' "
                "AND algorithm_version=? AND source_fingerprint=?",
                (
                    asset_row["id"],
                    CV_ALGORITHM_VERSION,
                    asset_row["fingerprint"],
                ),
            ).fetchone()
        return dict(row) if row else None

    def create_analysis_job(
        self,
        project_id: str,
        asset_row: dict[str, Any],
        path: str,
    ) -> tuple[str, str]:
        """登记分析作业（返回 job_id, analysis_id；幂等——已有 running/ready 短路）。"""
        if self.analysis_row(asset_row) is not None:
            raise CvAnalysisError("CV_ANALYSIS_READY", "素材已有最新信号分析")
        with self.db.connection() as db:
            existing = db.execute(
                "SELECT id FROM cv_analyses WHERE asset_id=? AND algorithm_version=? "
                "AND status IN ('queued','running')",
                (asset_row["id"], CV_ALGORITHM_VERSION),
            ).fetchone()
            if existing:
                raise CvAnalysisError("CV_ANALYSIS_IN_PROGRESS", "素材信号分析已在进行")
            # 旧 ready/failed 行（指纹不匹配的 stale 或历史失败）让位：
            # UNIQUE(asset_id, algorithm_version) 要求单版本单行。
            db.execute(
                "UPDATE cv_analyses SET status='stale',updated_at=? "
                "WHERE asset_id=? AND algorithm_version=? AND status IN ('ready','failed')",
                (utc_now(), asset_row["id"], CV_ALGORITHM_VERSION),
            )
        stat = Path(path).stat()
        job_id, analysis_id, now = new_id(), f"cv_analysis_{new_id()}", utc_now()
        payload = {
            "asset_id": asset_row["id"],
            "analysis_id": analysis_id,
            "path": str(path),
            "size_bytes": stat.st_size,
            "modified_at": stat.st_mtime_ns,
        }
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
                db.execute(
                    "INSERT INTO jobs (id,project_id,asset_id,kind,type,status,stage,"
                    "progress,input_json,encoder_requested,resource_class,attempt,"
                    "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        job_id, project_id, asset_row["id"], "cv_analysis", "cv_analysis",
                        "queued", "queued", 0, json_dumps(payload),
                        None, "light", 1, now, now,
                    ),
                )
                # 单版本单行（UNIQUE(asset_id, algorithm_version)）：重分析 =
                # 旧 ready/failed/stale 行原地重置（清明细，复用行 id）。
                db.execute(
                    "DELETE FROM cv_samples WHERE analysis_id IN ("
                    "SELECT id FROM cv_analyses WHERE asset_id=? AND algorithm_version=?)",
                    (asset_row["id"], CV_ALGORITHM_VERSION),
                )
                db.execute(
                    "INSERT INTO cv_analyses(id,asset_id,source_fingerprint,"
                    "algorithm_version,status,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?) "
                    "ON CONFLICT(asset_id, algorithm_version) DO UPDATE SET "
                    "id=excluded.id,"
                    "source_fingerprint=excluded.source_fingerprint,"
                    "status='queued',sample_count=NULL,scene_cut_count=NULL,"
                    "updated_at=excluded.updated_at,finished_at=NULL",
                    (
                        analysis_id,
                        asset_row["id"],
                        asset_row["fingerprint"],
                        CV_ALGORITHM_VERSION,
                        "queued",
                        now,
                        now,
                    ),
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return job_id, analysis_id

    async def run_analysis_job(
        self,
        row: Any,
        cancel_event: asyncio.Event,
        progress: Any = None,
        stage: Any = None,
    ) -> dict[str, Any]:
        """分析作业执行体：stat 校验 → 视频遍历 → 音频遍历 → 落库。"""
        payload = json_loads(row["input_json"])
        if "analysis_id" not in payload or "path" not in payload:
            raise CvAnalysisError("CV_JOB_INVALID", "非 CV 分析作业载荷")
        analysis_id = payload["analysis_id"]
        input_path = Path(payload["path"])
        if not input_path.is_file():
            raise CvAnalysisError("MEDIA_CHANGED", "素材文件不存在")
        stat = input_path.stat()
        if stat.st_size != payload["size_bytes"] or stat.st_mtime_ns != payload["modified_at"]:
            raise CvAnalysisError("MEDIA_CHANGED", "素材文件已变化")
        now = utc_now()
        with self.db.connection() as db:
            updated = db.execute(
                "UPDATE cv_analyses SET status='running',updated_at=? "
                "WHERE id=? AND status='queued'",
                (now, analysis_id),
            ).rowcount
        if updated != 1:
            raise CvAnalysisError("CV_JOB_INVALID", "分析行状态不允许执行")
        try:
            if stage:
                stage("cv:video")
            samples = await analyze_video(
                self.ffmpeg, input_path, cancel_event,
                progress or (lambda _value: None),
            )
            if cancel_event.is_set():
                raise CvAnalysisError("JOB_CANCELLED", "任务已取消")
            if stage:
                stage("cv:audio")
            audio_windows: list[float] = []
            probe = await self.ffprobe.probe(input_path)
            if probe.get("audio_streams"):
                audio_windows = await analyze_audio_energy(
                    self.ffmpeg, input_path, cancel_event
                )
            # 音频窗口能量按时间就近映射到采样帧（窗口 1s）。
            for sample in samples:
                window_index = min(
                    int(sample["timestamp_us"] / 1_000_000), max(len(audio_windows) - 1, 0)
                )
                sample["audio_energy"] = (
                    audio_windows[window_index] if audio_windows else 0.0
                )
            finished = utc_now()
            with self.db.connection() as db:
                db.execute("BEGIN")
                try:
                    db.executemany(
                        "INSERT INTO cv_samples(id,analysis_id,sample_index,timestamp_us,"
                        "scene_cut,motion_energy,sharpness,brightness,audio_energy,face_count,face_score) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        [
                            (
                                f"cv_sample_{new_id()}",
                                analysis_id,
                                index,
                                int(sample["timestamp_us"]),
                                int(bool(sample["scene_cut"])),
                                float(sample["motion_energy"]),
                                float(sample["sharpness"]),
                                float(sample["brightness"]),
                                float(sample["audio_energy"]),
                                None,
                                None,
                            )
                            for index, sample in enumerate(samples)
                        ],
                    )
                    db.execute(
                        "UPDATE cv_analyses SET status='ready',sample_count=?,"
                        "scene_cut_count=?,updated_at=?,finished_at=? WHERE id=?",
                        (
                            len(samples),
                            sum(1 for s in samples if s["scene_cut"]),
                            finished,
                            finished,
                            analysis_id,
                        ),
                    )
                    db.execute("COMMIT")
                except Exception:
                    db.execute("ROLLBACK")
                    raise
            if progress:
                progress(1.0)
            return {
                "analysis_id": analysis_id,
                "status": "ready",
                "sample_count": len(samples),
                "scene_cut_count": sum(1 for s in samples if s["scene_cut"]),
            }
        except BaseException:
            with self.db.connection() as db:
                db.execute(
                    "UPDATE cv_analyses SET status='failed',updated_at=?,finished_at=? WHERE id=?",
                    (utc_now(), utc_now(), analysis_id),
                )
            raise

    def samples_for_range(
        self, asset_id: str, start_us: int, end_us: int
    ) -> list[dict[str, Any]]:
        """召回层查询：素材最新 ready 分析在 [start, end) 的样本聚合。"""
        with self.db.connection() as db:
            analysis = db.execute(
                "SELECT id FROM cv_analyses WHERE asset_id=? AND status='ready' "
                "AND algorithm_version=? ORDER BY created_at DESC LIMIT 1",
                (asset_id, CV_ALGORITHM_VERSION),
            ).fetchone()
            if not analysis:
                return []
            rows = db.execute(
                "SELECT timestamp_us,scene_cut,motion_energy,sharpness,brightness,"
                "audio_energy,face_count,face_score FROM cv_samples "
                "WHERE analysis_id=? AND timestamp_us>=? AND timestamp_us<? "
                "ORDER BY timestamp_us",
                (analysis["id"], start_us, end_us),
            ).fetchall()
        return [dict(row) for row in rows]

    def analysis_summary(self, asset_row: dict[str, Any]) -> dict[str, Any] | None:
        """端点摘要（status 优先 running/queued，其次 ready/failed/stale）。"""
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM cv_analyses WHERE asset_id=? AND algorithm_version=? "
                "ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 "
                "WHEN 'ready' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END, "
                "created_at DESC LIMIT 1",
                (asset_row["id"], CV_ALGORITHM_VERSION),
            ).fetchone()
            if not row:
                return None
            stale = row["source_fingerprint"] != asset_row["fingerprint"]
            return {
                "analysis_id": row["id"],
                "status": "stale" if stale and row["status"] == "ready" else row["status"],
                "algorithm_version": row["algorithm_version"],
                "sample_count": row["sample_count"],
                "scene_cut_count": row["scene_cut_count"],
                "created_at": row["created_at"],
                "finished_at": row["finished_at"],
            }

    def mark_stale(self, asset_id: str, fingerprint: str) -> None:
        """素材指纹变化时调用（transcripts mark_asset_stale 先例）。"""
        with self.db.connection() as db:
            db.execute(
                "UPDATE cv_analyses SET status='stale',updated_at=? "
                "WHERE asset_id=? AND source_fingerprint!=? AND status IN ('ready')",
                (utc_now(), asset_id, fingerprint),
            )
