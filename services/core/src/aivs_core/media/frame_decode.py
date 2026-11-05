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

# PTS 表缓存：ffprobe -show_frames 对长片可达数秒～数十秒，逐帧请求不可重复付
_pts_cache: dict[tuple[str, int, int], list["FramePts"]] = {}
_pts_inflight: dict[tuple[str, int, int], asyncio.Task[list["FramePts"]]] = {}
_PTS_CACHE_MAX = 8
# 条目数之外再限制总帧数，避免 8 个长片的完整 FramePts 表常驻占满 Core 内存。
_PTS_CACHE_MAX_FRAMES = 500_000


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
    key_frame: bool = False


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
        key = str(row.get("key_frame") or "") in {"1", "true", "True"}
        out.append(FramePts(index=i, pts_us=pts_us, key_frame=key))
    return out


def parse_packet_pts_csv(text: str) -> list[FramePts]:
    """-show_entries packet=pts_time,dts_time,flags -of csv 的输出 → FramePts 表。

    P69 快速通道：-show_frames 必须逐帧**解码**才吐帧条目（8400 帧实测
    79.2s），-show_packets 只解封装（同素材 0.4s，~200x）；三材料实证 PTS
    集合与关键帧集合逐项一致。

    语义保持：包序是解码序（B 帧 PTS 乱序），而 FramePts.index 是**展示序
    序号**（decode_nv12_frames 的 select=eq(n,…）对齐用；-show_frames 通道
    输出即 PTS 单调，实测 B 帧材料亦然）——故按 PTS 稳定排序后编 index，
    与 frames 通道逐项等价。pts 缺失（N/A）回退 dts；非数值行（表头等）跳过。
    """
    rows: list[tuple[int, int]] = []
    for line in text.splitlines():
        parts = line.split(",")
        if len(parts) < 3:
            continue
        pts_raw = parts[0].strip()
        dts_raw = parts[1].strip()
        best = pts_raw if pts_raw not in ("", "N/A") else dts_raw
        if best in ("", "N/A"):
            continue
        try:
            pts_us = int(round(float(best) * 1_000_000))
        except ValueError:
            continue  # 表头/杂行
        rows.append((pts_us, 1 if "K" in parts[2] else 0))
    rows.sort(key=lambda item: item[0])
    return [
        FramePts(index=i, pts_us=pts_us, key_frame=bool(key))
        for i, (pts_us, key) in enumerate(rows)
    ]


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


async def _probe_frame_pts(ffprobe: Path, input_path: Path, timeout: float = 120.0) -> list[FramePts]:
    """ffprobe -show_packets（解封装）取视频帧 PTS（P69 快速通道）。

    结果按 (path, size, mtime) 缓存——逐帧 decode-frames 不可每次重付全表探测。
    通道选型（P69，2026-10-09 真机实证）：-show_frames 逐帧解码，8400 帧素材
    79.2s；-show_packets 只解封装 0.4s。PTS/关键帧集合三材料逐项一致；index
    按展示序编（见 parse_packet_pts_csv）。
    """
    try:
        stat = input_path.stat()
        cache_key = (str(input_path.resolve()), stat.st_size, int(stat.st_mtime))
    except OSError:
        cache_key = (str(input_path), 0, 0)
    cached = _pts_cache.get(cache_key)
    if cached is not None:
        return cached
    process = await asyncio.create_subprocess_exec(
        str(ffprobe),
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "packet=pts_time,dts_time,flags",
        "-of", "csv=p=0",
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
    pts = parse_packet_pts_csv(stdout.decode("utf-8", errors="replace"))
    if not pts:
        raise FrameDecodeError("DECODE_NO_FRAMES", "ffprobe 未给出视频帧时间戳")
    _pts_cache[cache_key] = pts
    while len(_pts_cache) > _PTS_CACHE_MAX or sum(len(item) for item in _pts_cache.values()) > _PTS_CACHE_MAX_FRAMES:
        _pts_cache.pop(next(iter(_pts_cache)))
    return pts


async def list_frame_pts(ffprobe: Path, input_path: Path, timeout: float = 120.0) -> list[FramePts]:
    """并发请求共享同一份 ffprobe 帧表探测。"""
    try:
        stat = input_path.stat()
        cache_key = (str(input_path.resolve()), stat.st_size, int(stat.st_mtime))
    except OSError:
        cache_key = (str(input_path), 0, 0)
    cached = _pts_cache.get(cache_key)
    if cached is not None:
        return cached
    task = _pts_inflight.get(cache_key)
    if task is None:
        task = asyncio.create_task(_probe_frame_pts(ffprobe, input_path, timeout))
        _pts_inflight[cache_key] = task
    try:
        return await asyncio.shield(task)
    finally:
        if _pts_inflight.get(cache_key) is task:
            _pts_inflight.pop(cache_key, None)


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
    # 关键帧 seek：-ss 到目标前最近 sync，n 从该关键帧起算（0=seek 落点关键帧）。
    # 避免每次从文件头线性解到目标（GOP≈88 时 frame 368 单次 >10s）。
    pts_by_index = {item.index: item for item in pts_list}
    earliest = unique_indices[0]
    kf_index = 0
    kf_pts: FramePts | None = None
    for i in range(earliest, -1, -1):
        candidate = pts_by_index.get(i)
        if candidate is not None and candidate.key_frame:
            kf_index = i
            kf_pts = candidate
            break
    if kf_pts is None:
        kf_pts = pts_by_index.get(kf_index)
    if kf_pts is None:
        raise FrameDecodeError("DECODE_FRAME_NOT_FOUND", f"缺少目标帧 {earliest} 的 PTS")
    seek_us = kf_pts.pts_us
    select = "+".join(f"eq(n\\,{i - kf_index})" for i in unique_indices if i >= kf_index)
    if not select:
        raise FrameDecodeError("DECODE_FRAME_NOT_FOUND", "目标帧不在关键帧之后")
    args = [
        "-hide_banner", "-nostdin", "-y",
        # **必须禁用自动旋转**：素材若带 display matrix 旋转（iPhone 竖拍常见
        # `rotation=-90`），ffmpeg 默认按旋转后方向输出像素，而调用方的
        # `width/height` 来自 `media_info_json` 的**旋转前**尺寸 ⇒ NV12 平面行宽
        # 错位 ⇒ 画面横向条纹花屏（2026-11-01 真机复现：3840x2160 声明 vs
        # 2160x3840 实际输出，条纹与用户截图一致）。解码层只负责把码流原样解成
        # 平面，旋转由前端按 IR 处理。
        # 注意：NV12 的 `w*h*1.5` 对宽高互换**恒等**，故长度断言抓不到该缺陷，
        # 回归锁必须用**内容相关度**判据（见 tests/unit/test_frame_decode_rotation.py）。
        "-noautorotate",
        "-ss", f"{seek_us / 1e6:.6f}",
        "-i", str(input_path),
        "-an", "-sn",
        "-vf", f"select='{select}'",
        "-fps_mode", "passthrough",
        # select 只筛输出不停输入：不加输出上限，ffmpeg 会为评估 select 把
        # 窗口之后的帧全部解完（真机 59s 素材窗口在后半段时实测 2s+/窗，
        # 70ms/帧——桌面端 FFmpeg 降级路径"丢帧不多但持续卡"的根因）。选中
        # 帧数即输出帧数，-frames:v 到点即停，实测同窗口 2033ms → 320ms。
        "-frames:v", str(len(unique_indices)),
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
        pts = pts_by_index.get(index)
        if pts is None:
            raise FrameDecodeError("DECODE_FRAME_NOT_FOUND", f"缺少目标帧 {index} 的 PTS")
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
