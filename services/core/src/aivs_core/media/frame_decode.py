"""H3 后端 B：窗口帧解码（FFmpeg → NV12 平面）。

取帧语义与后端 A 对齐（MEDIA_DECODER_HEVC_PLANNING_GATE §2.5）：
- 合成帧号 → target_us = frameN / fps * 1e6
- PTS 最近邻选样，diff > 33_334μs（一帧@30fps）报错
- 输出按目标帧号回填；VFR/含 B 帧素材禁止用「第 N 个解码帧」冒充「第 N 个合成帧」

本门按 request 起短命 ffmpeg 进程（正确性优先）；长驻进程属 H4。
"""
from __future__ import annotations

import asyncio
import re
import struct
from dataclasses import dataclass
from pathlib import Path

# 与 decode-worker.worker.ts locateByPts 报错阈值一致（一帧@30fps）
PTS_NEAREST_MAX_DIFF_US = 33_334
# 单请求帧窗上限（1s@30fps + 余量）；PREVIEW_IR_V2_MAX_WINDOW_FRAMES=300 是
# IR 调度窗，不是解码载荷窗——NV12 整帧不可一次下 300 张
MAX_DECODE_FRAMES_PER_REQUEST = 32
NV12_MAGIC = b"AIV1"


@dataclass(frozen=True)
class DecodedPlaneFrame:
    frame_n: int
    width: int
    height: int
    stride_y: int
    stride_uv: int
    y: bytes
    uv: bytes
    pts_us: int
    color_space: str = "bt709"


@dataclass(frozen=True)
class FramePts:
    """ffprobe 单帧时间戳（best_effort 优先）。"""
    index: int
    pts_us: int


class FrameDecodeError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def target_us_for_frame(frame_n: int, fps: float) -> int:
    if fps <= 0:
        raise FrameDecodeError("DECODE_FPS_INVALID", f"fps 必须为正：{fps}")
    return int(round(frame_n / fps * 1_000_000))


def locate_nearest_pts(target_us: int, pts_list: list[FramePts]) -> FramePts:
    """PTS 最近邻（与后端 A locateByPts 同语义；超过容差报错，不静默取边缘）。"""
    if not pts_list:
        raise FrameDecodeError("DECODE_NO_FRAMES", "无可用视频帧时间戳")
    best = min(pts_list, key=lambda item: abs(item.pts_us - target_us))
    diff = abs(best.pts_us - target_us)
    if diff > PTS_NEAREST_MAX_DIFF_US:
        raise FrameDecodeError(
            "DECODE_FRAME_NOT_FOUND",
            f"目标 {target_us}μs 无帧（最近 {best.pts_us}μs，diff {diff}μs > {PTS_NEAREST_MAX_DIFF_US}）",
        )
    return best


def map_frame_numbers_to_pts(
    frame_numbers: list[int], fps: float, pts_list: list[FramePts]
) -> list[tuple[int, FramePts]]:
    """合成帧号 → 最近邻 PTS。同一物理帧可服务多个请求帧号（重复命中合法）。"""
    if len(frame_numbers) > MAX_DECODE_FRAMES_PER_REQUEST:
        raise FrameDecodeError(
            "DECODE_WINDOW_TOO_LARGE",
            f"帧窗 {len(frame_numbers)} 超过上限 {MAX_DECODE_FRAMES_PER_REQUEST}",
        )
    if not frame_numbers:
        raise FrameDecodeError("DECODE_WINDOW_EMPTY", "frame_numbers 不能为空")
    out: list[tuple[int, FramePts]] = []
    for frame_n in frame_numbers:
        if frame_n < 0:
            raise FrameDecodeError("DECODE_FRAME_INVALID", f"frame_n 非法：{frame_n}")
        target = target_us_for_frame(frame_n, fps)
        out.append((frame_n, locate_nearest_pts(target, pts_list)))
    return out


_SHOW_PTS_RE = re.compile(
    r"pts_time:\s*([0-9.]+)|best_effort_timestamp_time:\s*([0-9.]+)"
)


def parse_frame_pts_json(payload: dict) -> list[FramePts]:
    """ffprobe -show_frames 的 JSON（frames[]）→ FramePts 列表（按 index 序）。"""
    rows = payload.get("frames") or []
    out: list[FramePts] = []
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        raw = (
            row.get("best_effort_timestamp_time")
            or row.get("pts_time")
            or row.get("pkt_pts_time")
        )
        if raw is None:
            continue
        try:
            pts_us = int(round(float(raw) * 1_000_000))
        except (TypeError, ValueError):
            continue
        out.append(FramePts(index=i, pts_us=pts_us))
    return out


def pack_nv12_response(
    frames: list[DecodedPlaneFrame], notes: list[str] | None = None
) -> bytes:
    """紧凑二进制响应（IPC/HTTP 共用）。

    布局：magic(4) | u32 count | u32 note_count | notes(UTF-8, 每条 u16 长度前缀)
    然后每帧：u32 frame_n,width,height,stride_y,stride_uv,y_len,uv_len | y | uv
    """
    notes = notes or []
    parts: list[bytes] = [NV12_MAGIC, struct.pack("<II", len(frames), len(notes))]
    for note in notes:
        raw = note.encode("utf-8")
        parts.append(struct.pack("<H", len(raw)))
        parts.append(raw)
    for frame in frames:
        parts.append(
            struct.pack(
                "<IIIIII",
                frame.frame_n,
                frame.width,
                frame.height,
                frame.stride_y,
                frame.stride_uv,
                len(frame.y),
            )
        )
        parts.append(struct.pack("<I", len(frame.uv)))
        parts.append(frame.y)
        parts.append(frame.uv)
    return b"".join(parts)


async def list_frame_pts(ffprobe: Path, input_path: Path, timeout: float = 30.0) -> list[FramePts]:
    """ffprobe -show_frames 取视频帧 PTS（best_effort 优先）。"""
    process = await asyncio.create_subprocess_exec(
        str(ffprobe),
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "frame=pts_time,best_effort_timestamp_time",
        "-print_format", "json",
        str(input_path),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError as exc:
        process.kill()
        await process.wait()
        raise FrameDecodeError("DECODE_TIMEOUT", "ffprobe 帧时间戳超时") from exc
    if process.returncode not in (0, None):
        detail = (stderr or b"")[-200:].decode("utf-8", errors="replace")
        raise FrameDecodeError("DECODE_PROBE_FAILED", f"ffprobe 帧表失败：{detail}")
    import json

    try:
        payload = json.loads(stdout.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as exc:
        raise FrameDecodeError("DECODE_PROBE_FAILED", "ffprobe 帧表 JSON 非法") from exc
    pts = parse_frame_pts_json(payload)
    if not pts:
        raise FrameDecodeError("DECODE_NO_FRAMES", "ffprobe 未给出视频帧时间戳")
    return pts


async def decode_nv12_frames(
    ffmpeg: Path,
    input_path: Path,
    width: int,
    height: int,
    pts_list: list[FramePts],
    selected: list[tuple[int, FramePts]],
    timeout: float = 60.0,
) -> list[DecodedPlaneFrame]:
    """按选中 index 集合一次 ffmpeg 抽 NV12，再按请求帧号回填。

    select=eq(n\\,i1)+… 使用解码序 n；对 progressive MP4（本门主流容器）n 与
    pts_list 的 index 对齐。异常容器（B 帧重排错位）由调用方经 A/B 对拍发现。
    """
    if width <= 0 or height <= 0 or width % 2 or height % 2:
        raise FrameDecodeError("DECODE_GEOMETRY_INVALID", f"几何非法：{width}x{height}")
    unique_indices = sorted({item.index for _, item in selected})
    if not unique_indices:
        return []
    select = "+".join(f"eq(n\\,{i})" for i in unique_indices)
    args = [
        "-hide_banner", "-nostdin", "-y",
        "-i", str(input_path),
        "-an", "-sn",
        "-vf", f"select='{select}'",
        "-fps_mode", "passthrough",
        "-f", "rawvideo",
        "-pix_fmt", "nv12",
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
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError as exc:
        process.kill()
        await process.wait()
        raise FrameDecodeError("DECODE_TIMEOUT", "ffmpeg 帧解码超时") from exc
    if process.returncode not in (0, None):
        detail = (stderr or b"")[-300:].decode("utf-8", errors="replace")
        raise FrameDecodeError("DECODE_FAILED", f"ffmpeg 解码失败：{detail}")

    frame_size = width * height * 3 // 2
    if frame_size <= 0 or len(stdout) % frame_size != 0:
        raise FrameDecodeError(
            "DECODE_SIZE_MISMATCH",
            f"NV12 输出长度 {len(stdout)} 不是整帧 {frame_size} 的倍数",
        )
    produced = len(stdout) // frame_size
    if produced != len(unique_indices):
        raise FrameDecodeError(
            "DECODE_COUNT_MISMATCH",
            f"期望 {len(unique_indices)} 帧，得到 {produced}",
        )
    y_size = width * height
    uv_size = y_size // 2
    by_index: dict[int, DecodedPlaneFrame] = {}
    for slot, index in enumerate(unique_indices):
        base = slot * frame_size
        y = stdout[base : base + y_size]
        uv = stdout[base + y_size : base + frame_size]
        pts = next(p for p in pts_list if p.index == index)
        by_index[index] = DecodedPlaneFrame(
            frame_n=-1,
            width=width,
            height=height,
            stride_y=width,
            stride_uv=width,
            y=y,
            uv=uv,
            pts_us=pts.pts_us,
        )
    out: list[DecodedPlaneFrame] = []
    for frame_n, pts in selected:
        src = by_index[pts.index]
        out.append(
            DecodedPlaneFrame(
                frame_n=frame_n,
                width=src.width,
                height=src.height,
                stride_y=src.stride_y,
                stride_uv=src.stride_uv,
                y=src.y,
                uv=src.uv,
                pts_us=src.pts_us,
            )
        )
    return out


async def decode_frames(
    ffmpeg: Path,
    ffprobe: Path,
    input_path: Path,
    width: int,
    height: int,
    frame_numbers: list[int],
    fps: float,
) -> list[DecodedPlaneFrame]:
    """入口：帧号窗 → PTS 最近邻 → NV12 平面。"""
    pts_list = await list_frame_pts(ffprobe, input_path)
    selected = map_frame_numbers_to_pts(frame_numbers, fps, pts_list)
    return await decode_nv12_frames(
        ffmpeg, input_path, width, height, pts_list, selected
    )
