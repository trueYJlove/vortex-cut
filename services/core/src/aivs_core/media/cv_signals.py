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

face_count/face_score 列由阶段二（YuNet ONNX）回填：模型就绪时同 select
表达式二次遍历（RGB 小帧）+ onnxruntime 推理；模型未就绪/运行时缺失时
人脸通道跳过（其余信号正常产出，face 列保持 NULL——partial 语义）。
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

import numpy as np

from ..database import Database, json_dumps, json_loads, utc_now
from ..ids import new_id

# 算法常量（改值 = algorithm_version 递增，新行不与旧条目互撞）
CV_ALGORITHM_VERSION = 2
THUMB_WIDTH = 64
THUMB_HEIGHT = 36
# 采样密度下限：GOP 超长素材的关键帧间隔兜底（秒）——select 表达式在
# "关键帧 或 距上个输出帧 ≥ MIN_SAMPLE_INTERVAL" 任一满足时输出。
MIN_SAMPLE_INTERVAL = 1.0
# CV_SKIP_FRAME 混合自适应（裁决 2026-09-20）：快路径采样点最大间隔超过
# 该值判定长 GOP 素材 → 全量解码回退。4s = 采样密度与重跑成本的折中
#（实测 lichun 最大 GOP 8.3s；dance 全 1s GOP 不触发回退）。
CV_SAMPLE_GAP_FALLBACK_US = 4_000_000

# ---- ADR-0005 阶段 1：采样预算与诚实降级 ----
# 作业墙钟预算 = 源时长(分) × CV_PER_MINUTE_BUDGET_S，钳制在 [下限, 上限]。
# 下限的理由：极短素材（如 10s）按比例只有 1.7s，连快路径都不够，会把正常素材
# 误判为超预算。上限的理由：防止超长素材（1 小时→600s）长时间占用 light 令牌
# （cv_analysis 优先级 3 与 waveform 2 共享）。
CV_PER_MINUTE_BUDGET_S = 10.0
CV_BUDGET_FLOOR_S = 15.0
CV_BUDGET_CAP_S = 300.0
# 全量解码吞吐（像素/秒）——保守静态估算，标定见
# CV_SAMPLING_BUDGET_PLANNING_GATE_2026-09-24 §2.2。
# 误差方向偏保守（高估成本 → 更倾向不回退）；合成 4K60 素材上实测高估约 2.4 倍。
# 未知编码取保守值（等于 hevc），宁可高估。
CV_THROUGHPUT_PX_PER_S = {"h264": 894_000_000.0, "hevc": 331_000_000.0}
CV_DEFAULT_THROUGHPUT_PX_PER_S = 331_000_000.0
# 读循环内每处理 N 帧检查一次取消事件并上报进度（粒度与开销的折中）。
CV_CANCEL_CHECK_FRAMES = 16
# 镜头边界阈值：相邻采样帧直方图卡方距离（归一 [0,1] 域；标定值，
# 调整须递增 algorithm_version）。
SCENE_CUT_DISTANCE = 0.45
# 拉普拉斯核（清晰度 = 卷积方差；纯 numpy，无 scipy 依赖）
_LAPLACIAN = np.array(
    [[0.0, 1.0, 0.0], [1.0, -4.0, 1.0], [0.0, 1.0, 0.0]], dtype=np.float32
)

# 阶段二：YuNet 人脸通道。模型 ID 对应 resources/model-manifests/
# yunet-face-detection.json（OpenCV Zoo face_detection_yunet_2023mar）。
# 模型规格（实测）：固定输入 1x3x640x640（float，RGB），12 输出 = 三尺度
# （8/16/32 stride）×（cls 置信 / obj 目标性 / bbox 回归 / kps 关键点）。
# 解码复刻 OpenCV Zoo 官方 Python demo 语义：cls×obj 分数过阈 + bbox
# 回归（640 域）+ 贪心 NMS。小帧 letterbox 居中填充到 640（实测单帧
# CPU 推理 ~7ms——每素材只跑关键帧采样，成本可忽略）。
FACE_MODEL_ID = "yunet-face-detection"
FACE_MODEL_REVISION = "2023mar"
FACE_INPUT_SIZE = 640
FACE_STRIDES = (8, 16, 32)
FACE_SCORE_THRESHOLD = 0.6
FACE_NMS_THRESHOLD = 0.45
FACE_TOP_K = 5000
# 最小框尺寸（640 域像素）：剔除退化回归框（角点 1x1 之类的假阳性）。
FACE_MIN_BOX = 16.0


class CvAnalysisError(RuntimeError):
    """CV 信号分析失败。code 进 jobs error_code。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _CombinedCancel:
    """组合取消源：任一置位即视为置位。

    供 `analyze_video` 的单事件接口使用——回退路径需同时响应"作业被用户取消"
    与"回退自身超预算中止"两个来源（ADR-0005 阶段 1 §2.4）。
    """

    __slots__ = ("_events",)

    def __init__(self, *events: asyncio.Event) -> None:
        self._events = events

    def is_set(self) -> bool:
        return any(event.is_set() for event in self._events)


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


# ---- 纯函数：采样预算与密度（ADR-0005 阶段 1，单测主对象） ----


def analysis_budget_s(duration_us: int) -> float:
    """作业墙钟预算：源时长(分) × 每分钟预算，钳制在 [下限, 上限]。"""
    minutes = max(duration_us, 0) / 60_000_000.0
    raw = minutes * CV_PER_MINUTE_BUDGET_S
    return min(max(raw, CV_BUDGET_FLOOR_S), CV_BUDGET_CAP_S)


def project_full_decode_s(duration_us: int, video_stream: dict[str, Any]) -> float:
    """保守估算全量解码耗时（秒）。

    模型：`时长 × 像素率 / 吞吐`。吞吐按编码族查表，未知编码取保守值。
    **已知误差方向：偏保守（高估）。** 见常量区注释与规划门 §2.2。
    无有效分辨率/帧率信息时返回 0.0（表示"无法估算"→ 调用方按可承受处理，
    由 deadline 兜底）。
    """
    width = int(video_stream.get("width") or 0)
    height = int(video_stream.get("height") or 0)
    num = int(video_stream.get("avg_frame_rate_num") or 0)
    den = int(video_stream.get("avg_frame_rate_den") or 0)
    if width <= 0 or height <= 0 or num <= 0 or den <= 0:
        return 0.0
    fps = num / den
    codec = str(video_stream.get("codec") or "").lower()
    throughput = CV_THROUGHPUT_PX_PER_S.get(codec, CV_DEFAULT_THROUGHPUT_PX_PER_S)
    pixels_per_s = width * height * fps
    return (duration_us / 1_000_000.0) * pixels_per_s / throughput


def density_status_of(achieved_max_gap_us: int, gap_threshold_us: int) -> str:
    """采样密度判定（规划门 §2.5）。

    判据是**回退阈值**而非目标间隔：`full` = 没有留下"本该填而没填"的盲区；
    `sparse` = 明知有盲区但未填（预算不足或回退被中止）。
    """
    return "sparse" if achieved_max_gap_us > gap_threshold_us else "full"


def max_gap_us(samples: list[dict[str, Any]]) -> int:
    """相邻采样点最大时间间隔（样本需按时间升序）。单点或空集返回 0。"""
    return max(
        (b["timestamp_us"] - a["timestamp_us"]
         for a, b in zip(samples, samples[1:])),
        default=0,
    )


# ---- FFmpeg 参数（白名单式组装） ----


def cv_video_args(
    input_path: str, *, skip_frame: bool = False, fallback_interval: bool = True
) -> list[str]:
    """关键帧采样灰度缩略帧 → rawvideo stdout。

    skip_frame=True（CV_SKIP_FRAME 裁决 2026-09-20）：解码器只解 I 帧
    （实测 6.4x 加速、输出与全量解码逐字节一致）——select 退化为纯
    `eq(pict_type,I)`（≥1s 兜底在 skip_frame 下无意义：非 I 帧时间戳
    不可见）。长 GOP 素材的采样空洞由 runner 层稀疏检测 + 全量回退处理。
    skip_frame=False（全量路径/回退路径）：I 帧或距上个输出帧
    ≥ MIN_SAMPLE_INTERVAL。采样帧 pts 时间戳经 showinfo 打进 stderr。
    """
    if skip_frame:
        select_expr = "eq(pict_type\\,I)"
    elif fallback_interval:
        select_expr = (
            f"eq(pict_type\\,I)+gte(t-prev_selected_t\\,{MIN_SAMPLE_INTERVAL})"
        )
    else:
        select_expr = "eq(pict_type\\,I)"
    args = [
        "-hide_banner", "-nostdin", "-y",
    ]
    if skip_frame:
        args.append("-skip_frame")
        args.append("nokey")
    args += [
        "-i", str(input_path),
        "-an",
        "-vf",
        f"select='{select_expr}',scale={THUMB_WIDTH}:{THUMB_HEIGHT},format=gray,showinfo",
        "-fps_mode", "vfr",
        "-f", "rawvideo",
        "-pix_fmt", "gray",
        "-progress", "pipe:2", "-nostats",
        "pipe:1",
    ]
    return args


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


# ---- 阶段二：YuNet 人脸检测（onnxruntime 懒加载；OpenCV Zoo 官方前后处理） ----


class FaceDetector:
    """YuNet ONNX 推理（会话只读线程安全；推理经 run_in_executor 隔离）。

    模型（实测规格）：固定输入 1x3x640x640 float RGB；12 输出 = 三尺度
    （stride 8/16/32）×（cls / obj / bbox / kps）。解码复刻 OpenCV Zoo
    face_detection_yunet 官方 demo 语义：score = cls × obj 过阈 → bbox
    回归 → 贪心 NMS。小帧 letterbox 居中填充到 640（填充区不产生检出）。
    """

    def __init__(self, model_path: Path) -> None:
        import importlib.util

        if importlib.util.find_spec("onnxruntime") is None:
            raise CvAnalysisError(
                "CV_RUNTIME_UNAVAILABLE", "onnxruntime 运行时不可用"
            )
        import onnxruntime

        self._session = onnxruntime.InferenceSession(
            str(model_path), providers=["CPUExecutionProvider"]
        )
        self._input_name = self._session.get_inputs()[0].name

    def detect(self, frame_rgb: np.ndarray) -> list[float]:
        """一帧人脸检测（输入任意尺寸 HxWx3 RGB；返回过阈分数列表）。"""
        blob = _letterbox_640(frame_rgb)
        outputs = self._session.run(None, {self._input_name: blob})
        return _decode_yunet_detections(outputs)


def _letterbox_640(frame_rgb: np.ndarray) -> np.ndarray:
    """任意尺寸 RGB 帧 → 1x3x640x640 float（居中等比缩放 + 零填充）。"""
    canvas = np.zeros((FACE_INPUT_SIZE, FACE_INPUT_SIZE, 3), dtype=np.float32)
    height, width = frame_rgb.shape[:2]
    scale = min(FACE_INPUT_SIZE / height, FACE_INPUT_SIZE / width)
    target_h = max(1, int(round(height * scale)))
    target_w = max(1, int(round(width * scale)))
    rows = np.floor(np.linspace(0, height - 1, target_h)).astype(np.intp)
    cols = np.floor(np.linspace(0, width - 1, target_w)).astype(np.intp)
    source = np.asarray(frame_rgb, dtype=np.float32)
    if source.ndim == 2:
        source = np.stack([source] * 3, axis=-1)
    canvas[:target_h, :target_w] = source[np.ix_(rows, cols)]
    return canvas.transpose(2, 0, 1)[None, ...].astype(np.float32)


def _decode_yunet_detections(outputs: list[np.ndarray]) -> list[float]:
    """12 输出（三尺度 cls/obj/bbox/kps）→ 过阈分数（含 NMS）。

    bbox 回编码式（实测标定 2026-09-20：astronaut 图五强激活 anchor 的
    (dx,dy,w,h)×stride 解码中心全部收敛于真实人脸位置）：每网格 anchor
    的回归值 = (中心 x 偏移, 中心 y 偏移, 宽, 高) × stride。kps 不消费
    （召回层只要 count/score）。最小框尺寸剔除退化回归。
    """
    boxes: list[tuple[float, float, float, float]] = []
    scores: list[float] = []
    grid = FACE_INPUT_SIZE
    for index, stride in enumerate(FACE_STRIDES):
        cells = grid // stride
        cls = np.asarray(outputs[index]).reshape(cells, cells)
        obj = np.asarray(outputs[len(FACE_STRIDES) + index]).reshape(cells, cells)
        bbox = np.asarray(outputs[2 * len(FACE_STRIDES) + index]).reshape(cells, cells, 4)
        combined = cls * obj
        for row, col in np.argwhere(combined > FACE_SCORE_THRESHOLD):
            score = float(combined[row, col])
            dx, dy, width, height = (float(v) * stride for v in bbox[row, col])
            cx = (col + 0.5) * stride + dx
            cy = (row + 0.5) * stride + dy
            x1, y1 = cx - width / 2, cy - height / 2
            x2, y2 = cx + width / 2, cy + height / 2
            if x2 - x1 < FACE_MIN_BOX or y2 - y1 < FACE_MIN_BOX:
                continue
            boxes.append((x1, y1, x2, y2))
            scores.append(score)
            if len(boxes) >= FACE_TOP_K:
                break
    if not boxes:
        return []
    keep = _nms(boxes, scores, FACE_NMS_THRESHOLD)
    return [scores[i] for i in keep]


def _nms(
    boxes: list[tuple[float, float, float, float]],
    scores: list[float],
    threshold: float,
) -> list[int]:
    """贪心 NMS（IoU 阈值；按分数降序保留）。"""
    order = sorted(range(len(scores)), key=lambda i: -scores[i])
    keep: list[int] = []
    suppressed = [False] * len(boxes)
    for index in order:
        if suppressed[index]:
            continue
        keep.append(index)
        x1, y1, x2, y2 = boxes[index]
        area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
        for other in order:
            if other == index or suppressed[other]:
                continue
            ox1, oy1, ox2, oy2 = boxes[other]
            ix1, iy1 = max(x1, ox1), max(y1, oy1)
            ix2, iy2 = min(x2, ox2), min(y2, oy2)
            inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
            union = area + max(0.0, ox2 - ox1) * max(0.0, oy2 - oy1) - inter
            if union > 0 and inter / union > threshold:
                suppressed[other] = True
    return keep


async def analyze_faces(
    ffmpeg: Path,
    input_path: Path,
    cancel_event: asyncio.Event,
    detector: FaceDetector,
    *, skip_frame: bool = False,
) -> dict[int, tuple[int, float]]:
    """人脸通道：同 select 表达式的 RGB 采样遍历 + 逐帧推理。

    返回 {帧序号: (face_count, max_score)}——与阶段一灰度遍历的采样
    帧序号天然对齐（同 select 表达式 = 同采样点序列）。采样帧缩到
    160x120 传输（letterbox 推理时内部上采样——小脸检出率让位于传输
    与解码成本，召回层只做加权不硬过滤）。
    """
    transport_width, transport_height = 160, 120
    select_expr = (
        f"eq(pict_type\\,I)+gte(t-prev_selected_t\\,{MIN_SAMPLE_INTERVAL})"
        if not skip_frame
        else "eq(pict_type\\,I)"
    )
    args = [
        "-hide_banner", "-nostdin", "-y",
    ]
    if skip_frame:
        args.extend(["-skip_frame", "nokey"])
    args += [
        "-i", str(input_path),
        "-an",
        "-vf",
        f"select='{select_expr}',scale={transport_width}:{transport_height},format=rgb24,showinfo",
        "-fps_mode", "vfr",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "-progress", "pipe:2", "-nostats",
        "pipe:1",
    ]
    process = await asyncio.create_subprocess_exec(
        str(ffmpeg),
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert process.stderr is not None
    stderr_task = asyncio.create_task(process.stderr.read())
    frame_bytes = transport_width * transport_height * 3
    faces: dict[int, tuple[int, float]] = {}
    index = 0
    try:
        assert process.stdout is not None
        loop = asyncio.get_running_loop()
        while True:
            chunk = await process.stdout.read(frame_bytes * 16)
            if not chunk:
                break
            offset = 0
            while offset + frame_bytes <= len(chunk):
                frame = (
                    np.frombuffer(
                        chunk, dtype=np.uint8, count=frame_bytes, offset=offset
                    )
                    .reshape(transport_height, transport_width, 3)
                )
                scores = await loop.run_in_executor(None, detector.detect, frame)
                if scores:
                    faces[index] = (len(scores), max(scores))
                offset += frame_bytes
                index += 1
        await process.wait()
        stderr = (await stderr_task).decode("utf-8", errors="replace")[-262144:]
    finally:
        if not stderr_task.done():
            stderr_task.cancel()
    if cancel_event.is_set():
        raise CvAnalysisError("JOB_CANCELLED", "任务已取消")
    if process.returncode != 0:
        raise CvAnalysisError("CV_FFMPEG_FAILED", "人脸采样解码失败: " + stderr[-300:])
    return faces


# ---- 采集执行体 ----


async def analyze_video(
    ffmpeg: Path,
    input_path: Path,
    cancel_event: asyncio.Event,
    *,
    skip_frame: bool = False,
) -> list[dict[str, Any]]:
    """一次遍历：采样帧流 + 逐帧信号。返回按 timestamp_us 升序的样本列表。

    **ADR-0005 阶段 1**：读循环内每 `CV_CANCEL_CHECK_FRAMES` 帧检查一次取消事件
    并终止子进程——支撑"回退超预算即中止"（此前只在循环**结束后**检查，
    无法中途中断，死等一次 4K60 全量解码要多花 30s+）。

    注：原 `progress` 参数被接受但**从未使用**（视频遍历的细粒度进度实际未上报），
    本单**显式删除**而非留作死参数——阶段级进度由调用方的 `stage()` 承担。
    """
    process = await asyncio.create_subprocess_exec(
        str(ffmpeg),
        *cv_video_args(str(input_path), skip_frame=skip_frame),
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
    frames_since_check = 0
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
                frames_since_check += 1
            if frames_since_check >= CV_CANCEL_CHECK_FRAMES:
                frames_since_check = 0
                if cancel_event.is_set():
                    process.kill()
                    await process.wait()
                    raise CvAnalysisError("JOB_CANCELLED", "任务已取消")
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
    def __init__(
        self,
        db: Database,
        ffmpeg: Path,
        ffprobe: Any,
        model_manager: Any = None,
    ) -> None:
        self.db = db
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        # AI-2 阶段二：模型管理器（可空——无模型链路时人脸通道整体跳过）。
        self.model_manager = model_manager

    def face_model_ready(self) -> bool:
        """YuNet 就绪判定（清单存在 + 安装 ready + onnxruntime 可用）。"""
        if self.model_manager is None:
            return False
        try:
            manifest = self.model_manager.registry.get(FACE_MODEL_ID)
            detail = self.model_manager.detail(FACE_MODEL_ID)
        except Exception:
            return False
        return detail.get("status") == "ready" and manifest.provider == "onnx-cv"

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

    async def _run_fallback(
        self,
        input_path: Path,
        fast_samples: list[dict[str, Any]],
        cancel_event: asyncio.Event,
        *,
        deadline_s: float,
    ) -> tuple[list[dict[str, Any]], bool]:
        """全量解码回退，带 deadline 兜底（ADR-0005 阶段 1 §2.3）。

        估算模型已知可高估约 2.4 倍，**不足以单独作保证**，故回退本身仍受墙钟约束：
        超时即中止并**保留快路径采样**（诚实降级）。返回 `(samples, aborted)`。

        中止语义（§2.4）：**作业取消优先于回退中止**——先判用户取消并向上抛，
        避免把用户取消误判为"回退中止"而错误产出一份 sparse 结果。
        """
        if deadline_s <= 0.0:
            # 预算已耗尽：不启动回退（避免起一个立刻被取消的子进程）。
            return fast_samples, True
        fallback_cancel = asyncio.Event()

        async def _arm_deadline() -> None:
            await asyncio.sleep(deadline_s)
            fallback_cancel.set()

        deadline_task = asyncio.create_task(_arm_deadline())
        try:
            samples = await analyze_video(
                self.ffmpeg,
                input_path,
                _CombinedCancel(cancel_event, fallback_cancel),
                skip_frame=False,
            )
        except CvAnalysisError as exc:
            if cancel_event.is_set():
                raise
            if exc.code == "JOB_CANCELLED" and fallback_cancel.is_set():
                return fast_samples, True
            raise
        finally:
            deadline_task.cancel()
            try:
                await deadline_task
            except asyncio.CancelledError:
                pass
        if cancel_event.is_set():
            raise CvAnalysisError("JOB_CANCELLED", "任务已取消")
        return samples, False

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
            started = time.perf_counter()
            # 提前探测：成本估算需要分辨率/帧率/编码，音频分支也要用（下方复用）。
            probe = await self.ffprobe.probe(input_path)
            video_stream = (probe.get("video_streams") or [{}])[0]
            duration_us = int(probe.get("duration_us") or 0)
            budget_s = analysis_budget_s(duration_us)

            # CV_SKIP_FRAME 混合自适应（裁决 2026-09-20）：默认快路径（只解 I 帧）。
            samples = await analyze_video(
                self.ffmpeg, input_path, cancel_event, skip_frame=True,
            )
            fallback_aborted = False
            if samples and max_gap_us(samples) > CV_SAMPLE_GAP_FALLBACK_US:
                # ADR-0005 阶段 1：回退须过预算准入——估算可能超预算则直接不回退，
                # 免为一次明知付不起的全量解码白等（4K60 HEVC 可达 37s/分钟源）。
                elapsed_s = time.perf_counter() - started
                projected_s = project_full_decode_s(duration_us, video_stream)
                if projected_s <= 0.0 or elapsed_s + projected_s <= budget_s:
                    if stage:
                        stage("cv:video-full")
                    samples, fallback_aborted = await self._run_fallback(
                        input_path, samples, cancel_event,
                        deadline_s=max(budget_s - elapsed_s, 0.0),
                    )
            if cancel_event.is_set():
                raise CvAnalysisError("JOB_CANCELLED", "任务已取消")
            if stage:
                stage("cv:audio")
            audio_windows: list[float] = []
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
            # 人脸通道（阶段二）：模型就绪才跑；未就绪 partial（face 列 NULL）。
            faces: dict[int, tuple[int, float]] = {}
            face_partial = not self.face_model_ready()
            if not face_partial:
                if stage:
                    stage("cv:faces")
                try:
                    detector = FaceDetector(
                        self.model_manager.ready_path(FACE_MODEL_ID)
                        / "face_detection_yunet_2023mar.onnx"
                    )
                    faces = await analyze_faces(
                        self.ffmpeg, input_path, cancel_event, detector,
                        skip_frame=True,
                    )
                except CvAnalysisError:
                    raise
                except Exception:
                    # 推理失败降级为 partial（其余信号不受累）——登记进结果。
                    face_partial = True
            face_merged = 0
            for index, sample in enumerate(samples):
                if index in faces:
                    sample["face_count"], sample["face_score"] = faces[index]
                    face_merged += 1
            finished = utc_now()
            # ADR-0005 阶段 1：记录实际达成的采样密度（诚实降级）。
            achieved_gap_us = max_gap_us(samples)
            density = density_status_of(achieved_gap_us, CV_SAMPLE_GAP_FALLBACK_US)
            wall_clock_ms = int((time.perf_counter() - started) * 1000)
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
                                sample.get("face_count"),
                                sample.get("face_score"),
                            )
                            for index, sample in enumerate(samples)
                        ],
                    )
                    db.execute(
                        "UPDATE cv_analyses SET status='ready',sample_count=?,"
                        "scene_cut_count=?,model_revision=?,updated_at=?,finished_at=?,"
                        "density_status=?,gap_threshold_us=?,achieved_max_gap_us=?,"
                        "wall_clock_ms=? "
                        "WHERE id=?",
                        (
                            len(samples),
                            sum(1 for s in samples if s["scene_cut"]),
                            FACE_MODEL_REVISION if not face_partial else None,
                            finished,
                            finished,
                            density,
                            CV_SAMPLE_GAP_FALLBACK_US,
                            achieved_gap_us,
                            wall_clock_ms,
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
                "faces": "merged" if not face_partial else "partial",
                "face_sample_count": face_merged,
                "density_status": density,
                "achieved_max_gap_us": achieved_gap_us,
                "fallback_aborted": fallback_aborted,
                "wall_clock_ms": wall_clock_ms,
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
        """端点摘要（当前算法版本优先；无当前版本行时报告历史行——stale）。"""
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM cv_analyses WHERE asset_id=? "
                "ORDER BY (algorithm_version=?) DESC, "
                "CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 "
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
                "density_status": row["density_status"],
                "achieved_max_gap_us": row["achieved_max_gap_us"],
                "gap_threshold_us": row["gap_threshold_us"],
                "wall_clock_ms": row["wall_clock_ms"],
                "created_at": row["created_at"],
                "finished_at": row["finished_at"],
            }

    def latest_density(self, asset_id: str) -> dict[str, Any] | None:
        """召回层查询：素材最新 ready 分析的密度元数据（无 ready 分析返回 None）。

        ADR-0005 阶段 1：召回层据此对 `sparse` 分析降权——**只降权不排除**，
        与既有"误检代价是排序偏移而非丢段"的裁决一致。
        """
        with self.db.connection() as db:
            row = db.execute(
                "SELECT density_status,achieved_max_gap_us,gap_threshold_us "
                "FROM cv_analyses WHERE asset_id=? AND status='ready' "
                "AND algorithm_version=? ORDER BY created_at DESC LIMIT 1",
                (asset_id, CV_ALGORITHM_VERSION),
            ).fetchone()
        return dict(row) if row else None

    def mark_stale(self, asset_id: str, fingerprint: str) -> None:
        """素材指纹变化时调用（transcripts mark_asset_stale 先例）。"""
        with self.db.connection() as db:
            db.execute(
                "UPDATE cv_analyses SET status='stale',updated_at=? "
                "WHERE asset_id=? AND source_fingerprint!=? AND status IN ('ready')",
                (utc_now(), asset_id, fingerprint),
            )
