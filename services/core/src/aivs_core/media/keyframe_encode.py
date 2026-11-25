"""W3.3 Layer 2：关键帧 JPEG 编码（S1a，**纯本地、零 egress**）。

设计门：`docs/design/KEYFRAME_UNDERSTANDING_DESIGN.md` §3.1。
规划门：`docs/requirements/KEYFRAME_UNDERSTANDING_SPEC.md` D7/D8。

分层纪律（与 semantic_service / cv_signals 同款）：
- 本模块只管「解码一帧 → JPEG 字节」，不做抽样决策（S1b）、不碰数据库、不发网络；
- 解码走 ffmpeg 子进程（与 `semantic_service.rgb_frames_args` 同范式）；
- 缩略图与将被外传的载荷**必须是两套不同的字节**（规划门 §3.2 / A12）——
  若二者相同，用户看到的就不是将被发出去的东西，审计形同虚设。

为什么用 ffmpeg 子进程而不是 PyAV 进程内编码（规划门 §10 D9）：
随包 ffmpeg 的 `-encoders` 实测含 `mjpeg`（第 77 行 `VFS..D mjpeg`）且已由
`electron-builder.yml:15-19` 打包；与既有抽帧链路同构，证据链最短。
"""
from __future__ import annotations

import asyncio
import hashlib
import struct
from dataclasses import dataclass
from pathlib import Path

# 规划门 D8（用户裁决）：长边 768、JPEG q85。
JPEG_LONG_EDGE = 768
# ffmpeg 的 -q:v 是 2..31（小者质量高），3 约合 JPEG q85。
JPEG_QSCALE = 3
# 规划门 D7（用户裁决）：每素材封顶 24 帧。
MAX_FRAMES = 24
# 缩略图：仅供界面呈现，必须显著小于载荷（A12 的区分前提）。
THUMBNAIL_LONG_EDGE = 192
THUMBNAIL_QSCALE = 6

_SCALE_LONG_EDGE = "scale='if(gt(iw,ih),{0},-2)':'if(gt(iw,ih),-2,{0})'"

# 单帧解码+编码的超时。冷启 ffmpeg 通常 < 1s；超过 30s 视为素材异常而非慢。
_FRAME_TIMEOUT_S = 30.0


class KeyframeEncodeError(RuntimeError):
    """编码失败。调用方按 fail-closed 处理，不得静默跳过该帧。"""


@dataclass(frozen=True)
class EncodedFrame:
    """一帧的两套字节：`payload_*` 将外传，`thumbnail_*` 仅展示。

    **两者必须不同**（规划门 §3.2）。若素材本身极小导致缩略图与载荷
    恰好等长，也仍然分别计算哈希——判定看的是 `payload_sha256 !=`
    `thumbnail_sha256` 或尺寸不同，测试以「尺寸不同」为硬判据。
    """

    timestamp_us: int
    source_reason: str
    payload_bytes: bytes
    payload_sha256: str
    payload_width: int
    payload_height: int
    thumbnail_bytes: bytes
    thumbnail_sha256: str
    thumbnail_width: int
    thumbnail_height: int

    def to_meta(self) -> dict[str, object]:
        """逐帧元数据（不含字节）。落 `frames_json` 用。"""
        return {
            "timestamp_us": self.timestamp_us,
            "source_reason": self.source_reason,
            "payload_width": self.payload_width,
            "payload_height": self.payload_height,
            "payload_bytes": len(self.payload_bytes),
            "payload_sha256": self.payload_sha256,
            "thumbnail_width": self.thumbnail_width,
            "thumbnail_height": self.thumbnail_height,
            "thumbnail_bytes": len(self.thumbnail_bytes),
            "thumbnail_sha256": self.thumbnail_sha256,
        }


def _scale_filter(long_edge: int) -> str:
    """长边钉死、短边按比例（-2 保证偶数且不拉伸）。"""
    return _SCALE_LONG_EDGE.format(long_edge)


def jpeg_args(input_path: str, timestamp_us: int, *, long_edge: int = JPEG_LONG_EDGE,
              qscale: int = JPEG_QSCALE) -> list[str]:
    """单帧 → JPEG 到 stdout 的 ffmpeg argv。

    用 `-ss` 在 `-i` **之前**（输入侧定位）：快，且对长素材不必解码前缀。
    代价是定位精度受关键帧影响——对本功能无关紧要：要的是「这一时刻附近的
    画面」，不是帧精确。真正要帧精确时应换成输出侧 `-ss` 并接受更慢。
    """
    if timestamp_us < 0:
        raise ValueError("timestamp_us must be >= 0")
    return [
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-ss", f"{timestamp_us / 1_000_000:.6f}",
        "-i", input_path,
        "-frames:v", "1",
        "-vf", _scale_filter(long_edge),
        "-c:v", "mjpeg",
        "-q:v", str(qscale),
        "-f", "image2",
        "-",
    ]


def jpeg_dimensions(data: bytes) -> tuple[int, int]:
    """从 JPEG 字节读 (width, height)。

    自己解析 SOFn 而不是调 ffprobe：多起一个进程只为读两个整数不划算，
    且这里必须**从实际字节**得出尺寸——A12 要求「呈现的尺寸 == 外传的尺寸」，
    任何经由旁路元数据（如 ffprobe 重新探测）得来的值都不满足该语义。
    """
    if len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        raise KeyframeEncodeError("不是合法 JPEG：缺少 SOI")
    i = 2
    end = len(data)
    while i < end - 1:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        # 填充字节：0xFF 后面可以跟任意个 0xFF
        if marker == 0xFF:
            i += 1
            continue
        # 无长度字段的标记
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7 or marker == 0x01:
            i += 2
            continue
        if i + 4 > end:
            break
        segment_length = struct.unpack(">H", data[i + 2:i + 4])[0]
        # SOF0/1/2/3/5/6/7/9/10/11/13/14/15 都带帧尺寸
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                     0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            if i + 9 > end:
                break
            height, width = struct.unpack(">HH", data[i + 5:i + 9])
            return width, height
        if segment_length < 2:
            break
        i += 2 + segment_length
    raise KeyframeEncodeError("JPEG 中找不到 SOF 段，无法确定尺寸")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def _encode_one(ffmpeg: Path, input_path: Path, timestamp_us: int, *,
                      long_edge: int, qscale: int, timeout_s: float) -> bytes:
    process = await asyncio.create_subprocess_exec(
        str(ffmpeg),
        *jpeg_args(str(input_path), timestamp_us, long_edge=long_edge, qscale=qscale),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_s)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise KeyframeEncodeError(f"编码超时（{timestamp_us}us）") from None
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    if process.returncode != 0:
        detail = stderr[-512:].decode("utf-8", errors="replace").strip()
        raise KeyframeEncodeError(f"ffmpeg 编码失败（{timestamp_us}us）：{detail}")
    if not stdout:
        raise KeyframeEncodeError(f"ffmpeg 未输出任何字节（{timestamp_us}us）")
    return stdout


async def encode_frame(ffmpeg: Path, input_path: Path, timestamp_us: int, *,
                       source_reason: str, timeout_s: float = _FRAME_TIMEOUT_S) -> EncodedFrame:
    """编一帧载荷 + 一张缩略图（两套字节，规划门 §3.2）。"""
    payload = await _encode_one(
        ffmpeg, input_path, timestamp_us,
        long_edge=JPEG_LONG_EDGE, qscale=JPEG_QSCALE, timeout_s=timeout_s,
    )
    thumbnail = await _encode_one(
        ffmpeg, input_path, timestamp_us,
        long_edge=THUMBNAIL_LONG_EDGE, qscale=THUMBNAIL_QSCALE, timeout_s=timeout_s,
    )
    payload_w, payload_h = jpeg_dimensions(payload)
    thumb_w, thumb_h = jpeg_dimensions(thumbnail)
    return EncodedFrame(
        timestamp_us=timestamp_us,
        source_reason=source_reason,
        payload_bytes=payload,
        payload_sha256=sha256_hex(payload),
        payload_width=payload_w,
        payload_height=payload_h,
        thumbnail_bytes=thumbnail,
        thumbnail_sha256=sha256_hex(thumbnail),
        thumbnail_width=thumb_w,
        thumbnail_height=thumb_h,
    )


async def encode_frames(
    ffmpeg: Path,
    input_path: Path,
    plan: list[tuple[int, str]],
    *,
    cancel_event: asyncio.Event | None = None,
) -> list[EncodedFrame]:
    """依 plan（[(timestamp_us, source_reason)]）逐帧编码。

    串行执行：单个素材封顶 24 帧、单帧约百毫秒量级，并发起多个 ffmpeg
    进程只会抢 CPU 而不缩短总时长（且更易触发机器上的解码抖动）。
    取消按帧粒度检查——已编码的帧不回收（调用方本就要么全用要么丢弃）。
    """
    frames: list[EncodedFrame] = []
    for timestamp_us, reason in plan:
        if cancel_event is not None and cancel_event.is_set():
            raise asyncio.CancelledError()
        frames.append(await encode_frame(
            ffmpeg, input_path, timestamp_us, source_reason=reason,
        ))
    return frames


def total_payload_bytes(frames: list[EncodedFrame]) -> int:
    """实测外传字节合计（A6 要求实测值，不是推算 token）。"""
    return sum(len(frame.payload_bytes) for frame in frames)
