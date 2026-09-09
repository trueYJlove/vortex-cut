"""B15 分块 PCM 服务：素材 → 2 秒粒度 f32le PCM 块（派生缓存）。

约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B15 数据契约）：
- 采样率 48000、双声道、f32le；每块有效区 2 秒（96000 样本/声道）；
  块 key 用整数 sample offset（start_sample），不用浮点秒累加。
- FFmpeg 以输入粗定位（-ss）+ 精确采样裁切（atrim）+ 统一 resample
  （aresample）输出；块尾长精确，EOF 显式标记（valid_samples <
  96000 = 尾块/EOF）。开发验证用整段同参数参考 PCM 比较相邻块拼接
  （单测 reference 对拍）；未能证明无缝时先不上线（验收门）。
- AAC priming/非零 PTS/边界预滚：块起算偏移 PREROLL_SAMPLES=1152
  编码器帧对齐由 aresample 的 soft-priming 消化——参考对拍单测保证
  相邻块拼接 sample 对齐与误差（≤1e-6 每样本，解码器引入的 priming
  差异属于工具链行为，对拍容忍 ±64 样本边界窗）。
- 产物 = 12 字节小头（u32 start_sample、u32 valid_samples_per_channel、
  u16 sample_rate_khz、u16 channels）+ f32 交错 PCM；进 B10 派生缓存
  kind=audio_pcm_chunk 原子发布；params = {sr, ch, samples} 定长字典
  （= 算法指纹成分）。
- 块文件很小（≤768000B），不走磁盘 LRU 单独预算——计入 B10 全局
  10GiB 磁盘预算即可；Renderer 侧按字节限制驻留（B15-C）。
- 一次一个块的独立请求（不做批量）；服务端校验请求 sample offset
  为非负 64 位安全整数。
"""
from __future__ import annotations

import asyncio
import struct
from pathlib import Path
from typing import Any

from ..database import Database, json_dumps, utc_now
from .derived_cache import derived_cache_key

# 契约常量（进 params → 缓存键成分；改值即键换代）
SAMPLE_RATE = 48000
CHANNELS = 2
CHUNK_SAMPLES = 96_000  # 每声道 2 秒
# 块头：u32 start_sample + u32 valid_samples + u16 sample_rate_khz + u16 channels
_HEADER = struct.Struct("<IIHH")
HEADER_BYTES = _HEADER.size
PCM_BYTES_PER_SAMPLE = 4

PCM_ALGORITHM_VERSION = 1
PCM_PARAMS = {
    "sr": str(SAMPLE_RATE),
    "ch": str(CHANNELS),
    "samples": str(CHUNK_SAMPLES),
}


class PcmChunkError(RuntimeError):
    """PCM 块生成/请求失败。code 进 jobs error_code / 端点错误码。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def pcm_chunk_bytes(start_sample: int, samples: int) -> int:
    """块产物总字节估算（头 + 交错 f32）。"""
    return HEADER_BYTES + samples * CHANNELS * PCM_BYTES_PER_SAMPLE


def parse_chunk_header(data: bytes) -> dict[str, int]:
    """解析块头。损坏（尺寸不足）→ ValueError。"""
    if len(data) < HEADER_BYTES:
        raise ValueError("pcm chunk too short")
    start_sample, valid_samples, sr_khz, channels = _HEADER.unpack_from(data, 0)
    return {
        "start_sample": start_sample,
        "valid_samples": valid_samples,
        "sample_rate": sr_khz * 1000,
        "channels": channels,
    }


def chunk_start_for(source_sample: int) -> int:
    """源采样位置 → 所在块 start_sample（对齐 CHUNK_SAMPLES 网格）。"""
    if source_sample < 0:
        raise ValueError("negative sample offset")
    return (source_sample // CHUNK_SAMPLES) * CHUNK_SAMPLES


def encode_chunk(start_sample: int, pcm: bytes, samples: int) -> bytes:
    """块编码（测试/工具用；生产由 ffmpeg 输出直接拼头）。"""
    header = _HEADER.pack(start_sample, samples, SAMPLE_RATE // 1000, CHANNELS)
    return header + pcm


def decode_chunk(data: bytes) -> dict[str, Any]:
    """块解码：头 + 交错 Float32（Main/测试校验用；Renderer fetch 后同算法）。"""
    header = parse_chunk_header(data)
    pcm_bytes = len(data) - HEADER_BYTES
    if pcm_bytes % (CHANNELS * PCM_BYTES_PER_SAMPLE) != 0:
        raise ValueError("pcm chunk payload misaligned")
    samples = pcm_bytes // (CHANNELS * PCM_BYTES_PER_SAMPLE)
    if header["valid_samples"] != samples and header["valid_samples"] != CHUNK_SAMPLES:
        raise ValueError("pcm chunk header/payload mismatch")
    values = struct.unpack_from(f"<{samples * CHANNELS}f", data, HEADER_BYTES)
    return {**header, "samples": samples, "pcm": values}


def chunk_args(input_path: str, start_sample: int) -> list[str]:
    """FFmpeg 参数：粗定位 -ss + 精确裁切 atrim + 统一 resample → f32le stdout。

    - 粗定位秒（-ss）取块起点减半块预滚（防 AAC priming/seek 不精确引入
      块头缺损；atrim 再精确裁掉预滚）。负值钳 0。
    - aresample=48000:async=1（统一时间基；first_pts 归零块内时间）；
      atrim=start_sample:end_sample 按重采样后样域精裁（输入粗定位误差
      由 atrim 修齐——块拼接一致性以参考对拍单测保证）。
    """
    preroll = CHUNK_SAMPLES // 2
    seek_sample = max(0, start_sample - preroll)
    seek_sec = seek_sample / SAMPLE_RATE
    trim_start = (start_sample - seek_sample) / SAMPLE_RATE
    trim_end = trim_start + CHUNK_SAMPLES / SAMPLE_RATE
    return [
        "-hide_banner", "-nostdin", "-y",
        "-ss", f"{seek_sec:.6f}",
        "-i", str(input_path),
        "-vn",
        "-map", "0:a:0",
        "-af", (
            f"aresample={SAMPLE_RATE}:async=1:first_pts=0,"
            f"atrim=start={trim_start:.6f}:end={trim_end:.6f},"
            f"asetnsamples=n={CHUNK_SAMPLES * CHANNELS}:pad=0"
        ),
        "-ac", str(CHANNELS),
        "-ar", str(SAMPLE_RATE),
        "-c:a", "pcm_f32le",
        "-f", "f32le",
        "pipe:1",
    ]


async def generate_pcm_chunk(
    ffmpeg: Path,
    input_path: Path,
    start_sample: int,
    output: Path,
    cancel_event: asyncio.Event,
) -> dict[str, Any]:
    """执行 FFmpeg 生成一个 PCM 块 → 写产物。返回统计。

    输出样本数 ≤ CHUNK_SAMPLES（EOF 尾块短）；exact 布尔 = 是否整块。
    输出为 0 样本（起点超出素材末尾）→ 空块（valid_samples=0，调用方
    按 EOF 处理）。
    """
    args = chunk_args(str(input_path), start_sample)
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
    try:
        assert process.stdout is not None
        data = bytearray()
        while True:
            chunk = await process.stdout.read(1024 * 1024)
            if not chunk:
                break
            data += chunk
        await process.wait()
        stderr = (await stderr_task).decode("utf-8", errors="replace")[-8192:]
    finally:
        if not stderr_task.done():
            stderr_task.cancel()
    if cancel_event.is_set():
        raise PcmChunkError("JOB_CANCELLED", "任务已取消")
    if process.returncode != 0:
        raise PcmChunkError(
            "PCM_CHUNK_FFMPEG_FAILED", "FFmpeg PCM 分块失败: " + stderr[-300:])
    samples = len(data) // (CHANNELS * PCM_BYTES_PER_SAMPLE)
    if samples > CHUNK_SAMPLES:
        raise PcmChunkError("PCM_CHUNK_TOO_LARGE", "块超出 2 秒有效区上限")
    header = _HEADER.pack(start_sample, samples, SAMPLE_RATE // 1000, CHANNELS)
    output.write_bytes(header + bytes(data))
    return {
        "start_sample": start_sample,
        "samples": samples,
        "exact": samples == CHUNK_SAMPLES,
        "size_bytes": HEADER_BYTES + len(data),
    }


class PcmChunkService:
    """B15 分块 PCM 服务：缓存键/查询/生成（同步执行——块级小任务）。

    生成不走 jobs 队列（计划：低延迟 PCM 任务不能排在长导出后——B16 前
    以同步内联执行 + begin_build single-flight 保证并发同 key 一次生成；
    磁盘预算 enforce 前置）。
    """

    def __init__(
        self,
        db: Database,
        derived_cache: Any,
        ffmpeg: Path,
        ffprobe: Any,
        *,
        ffmpeg_build: str | None,
    ) -> None:
        self.db = db
        self.derived_cache = derived_cache
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.ffmpeg_build = ffmpeg_build

    # ---- 缓存键（params 定长——键成分即算法指纹） ----

    def params(self) -> dict[str, str]:
        return dict(PCM_PARAMS)

    def toolchain_fingerprint(self) -> str:
        build = self.ffmpeg_build or "no-ffmpeg-build"
        return f"aivs-core-pcm-v{PCM_ALGORITHM_VERSION}|{build}"

    def chunk_cache_key(self, asset_fingerprint: str, start_sample: int) -> str:
        if start_sample < 0 or start_sample % CHUNK_SAMPLES != 0:
            raise PcmChunkError("PCM_CHUNK_OFFSET_INVALID", "块起点未对齐 96000 样本网格")
        # 网格对齐已保证唯一性；start_sample 进 params 使每块独立键
        return derived_cache_key(
            "audio_pcm_chunk", str(asset_fingerprint), PCM_ALGORITHM_VERSION,
            {**self.params(), "start": str(start_sample)},
            self.toolchain_fingerprint(),
        )

    def chunk_entry(self, asset_row: dict[str, Any], start_sample: int) -> dict[str, Any] | None:
        """查询块条目（不触发生成；无行返回 None）。"""
        key = self.chunk_cache_key(asset_row["fingerprint"], start_sample)
        return self._entry_by_key(key)

    def _entry_by_key(self, key: str) -> dict[str, Any] | None:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT status,size_bytes,created_at,last_accessed_at FROM "
                "derived_media_cache WHERE cache_key=?", (key,),
            ).fetchone()
        if row is None:
            return None
        return {
            "cache_key": key,
            "status": row["status"],
            "size_bytes": row["size_bytes"],
            "created_at": row["created_at"],
            "last_accessed_at": row["last_accessed_at"],
        }

    # ---- 生成（同步内联；single-flight 由 begin_build 保证） ----

    async def ensure_chunk(
        self,
        asset_row: dict[str, Any],
        start_sample: int,
        path: str,
    ) -> dict[str, Any]:
        """确保块 ready（命中即返回；未命中生成）。返回条目 + 解析头。

        源内容失效由缓存键承载（fingerprint 内容寻址——文件变化即键
        换代，旧块按 LRU 回收，不误命中）；文件缺失/不可读在入口即
        MEDIA_MISSING 拒绝（不生成空块冒充成功）。
        """
        key = self.chunk_cache_key(asset_row["fingerprint"], start_sample)
        entry = self.derived_cache.lookup(key)
        if entry is not None:
            return {"cache_key": key, "status": "ready", "size_bytes": entry.size_bytes,
                    "start_sample": start_sample, "valid_samples": None}
        source = Path(path)
        if not source.is_file():
            raise PcmChunkError("MEDIA_MISSING", "素材文件不存在")
        fingerprint = str(asset_row["fingerprint"])
        self.derived_cache.enforce_disk_budget()
        work_root = self.derived_cache.begin_build(
            key, fingerprint, "audio_pcm_chunk",
            {**self.params(), "start": str(start_sample)},
            self.toolchain_fingerprint(),
        )
        if work_root is None:
            return {"cache_key": key, "status": "already-ready", "size_bytes": 0,
                    "start_sample": start_sample, "valid_samples": None}
        try:
            if not source.is_file():
                raise PcmChunkError("MEDIA_MISSING", "素材文件已消失")
            output = work_root / "chunk.pcm"
            result = await generate_pcm_chunk(
                self.ffmpeg, source, start_sample, output, asyncio.Event())
            self.derived_cache.commit_ready(key, "audio_pcm_chunk", output)
            return {
                "cache_key": key, "status": "ready",
                "size_bytes": result["size_bytes"],
                "start_sample": result["start_sample"],
                "valid_samples": result["samples"],
                "exact": result["exact"],
            }
        except BaseException:
            try:
                self.derived_cache.mark_failed(key, "audio_pcm_chunk")
            except Exception:
                pass
            with self.db.connection() as db:
                db.execute(
                    "INSERT OR IGNORE INTO derived_media_cache(cache_key,asset_fingerprint,"
                    "kind,params_json,schema_version,toolchain_fingerprint,relative_path,"
                    "size_bytes,status,created_at,last_accessed_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (key, fingerprint, "audio_pcm_chunk",
                     json_dumps({**self.params(), "start": str(start_sample)}), 1,
                     self.toolchain_fingerprint(), "", 0, "failed", utc_now(), utc_now()),
                )
            raise
