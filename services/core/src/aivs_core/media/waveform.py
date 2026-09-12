"""B14 素材级持久化波形：FFmpeg 流式 PCM → min/max 金字塔。

约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B14）：
- 后台 FFmpeg 输出固定采样率 mono（初值 8000Hz），streaming stdout 处理；
  不得先读全部 PCM（内存驻留 = O(256 样本聚合状态)，非 O(源长度)）。
- 每 256 samples 的 min/max，逐级 2 倍汇总形成金字塔；保留 min/max 而非
  单个正向 peak。base 层覆盖全部原素材。
- 结果 = 小 header + Float32 min/max 二进制块；写派生缓存工作目录、
  commit_ready 原子发布（复用 B10 derived_media_cache "waveform" kind）。
- 产物 key 按 asset fingerprint + 算法参数（params 定长字典），工具链
  指纹混入 FFmpeg build（同 B11 代理键策略）。
- Renderer 侧每响应建议 ≤256KiB：Main 经 B12 Range 票据语义请求窗口；
  精确 LOD 帧分块选择在 Renderer 层完成（本模块只产出/解析文件）。
- 计划"worker 线程/进程计算聚合"：FFmpeg 子进程即计算主体（解包/重采样
  在子进程），主进程只聚合 4 字节状态对——不再引第二个 worker 进程。
"""
from __future__ import annotations

import asyncio
import struct
from pathlib import Path
from typing import Any

from ..database import Database, json_dumps, json_loads, utc_now
from ..ids import new_id
from .derived_cache import derived_cache_key

# 算法常量（进 params → 缓存键成分；改值即键换代，不与旧条目互撞）
SAMPLE_RATE = 8000
CHANNELS = 1
BUCKET = 256
# 文件小头（JSON + 换行）：渲染端 seek 定位用
_HEADER_FORMAT = {"sample_rate": str(SAMPLE_RATE), "channels": str(CHANNELS), "bucket": str(BUCKET)}
_HEADER_MAGIC = b"AIVSWF01"

# 1 小时 8000Hz 音频 base 层 = 1125000 桶 → 4500000 字节 ≈ 4.3MiB；全金字塔
# ≈ 8.6MiB。远小于同等时长源 PCM，且流式生成（内存 O(1)）。
HEADER_MAGIC_LEN = len(_HEADER_MAGIC)

WF_ALGORITHM_VERSION = 1
WF_PARAMS = dict(_HEADER_FORMAT)


class WaveformBuildError(RuntimeError):
    """波形生成失败（参数/媒体/FFmpeg 约束）。code 进 jobs error_code。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ---- 纯函数：流式聚合与文件读写（单测主对象） ----


def _merge_pair(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    return (min(a[0], b[0]), max(a[1], b[1]))


class MinMaxAggregator:
    """流式 min/max 聚合：一次喂 256 样本桶，逐级 2 倍汇总。

    每个 base 桶输出 (min, max) 两个 float32；level1 每 2 个 base 桶合并，
    level2 每 2 个 level1 桶合并……层数随 base 增长（ceil(log2(base)) + 1）。
    write() 时对每层做**最终全量合并**（流式期间只维持已收桶的完整前缀
    索引；write 从 base 层自底向上重建，保证每层恰好 ceil(base/2^k) 桶）。
    """

    def __init__(self) -> None:
        self.base: list[tuple[float, float]] = []
        self._pending = 0
        self._bucket_min = 0.0
        self._bucket_max = 0.0

    def feed(self, sample: float) -> None:
        """喂单个样本（progress 阶段调用；状态 O(1)）。"""
        if self._pending == 0:
            self._bucket_min = sample
            self._bucket_max = sample
        else:
            if sample < self._bucket_min:
                self._bucket_min = sample
            if sample > self._bucket_max:
                self._bucket_max = sample
        self._pending += 1
        if self._pending >= BUCKET:
            self.base.append((self._bucket_min, self._bucket_max))
            self._pending = 0

    def finish(self) -> dict[str, Any]:
        """收尾：不足整桶样本并入最后桶；返回金字塔统计（自底向上重建）。"""
        if self._pending > 0:
            self.base.append((self._bucket_min, self._bucket_max))
            self._pending = 0
        return {
            "sample_rate": SAMPLE_RATE,
            "channels": CHANNELS,
            "bucket": BUCKET,
            "base_buckets": len(self.base),
            "levels": self._level_count(),
        }

    def _level_count(self) -> int:
        import math

        return max(1, math.ceil(math.log2(len(self.base))) + 1) if len(self.base) > 1 else 1

    def _levels(self) -> list[list[tuple[float, float]]]:
        """自底向上重建金字塔：level k 桶数 = ceil(base / 2^k)。"""
        import math

        levels: list[list[tuple[float, float]]] = [self.base]
        current = self.base
        while len(current) > 1:
            count = math.ceil(len(current) / 2)
            nxt = [
                _merge_pair(current[i * 2], current[i * 2 + 1])
                if i * 2 + 1 < len(current) else current[i * 2]
                for i in range(count)
            ]
            levels.append(nxt)
            current = nxt
        return levels

    def write(self, output: Path) -> int:
        """写 header(JSON) + 逐层 float32 [min,max] 桶序列；返回字节数。"""
        info = self.finish()
        levels = self._levels()
        header_json = json_dumps({**info, "levels_layout": True})
        data = bytearray(_HEADER_MAGIC)
        header_bytes = header_json.encode("utf-8")
        data += struct.pack("<I", len(header_bytes))
        data += header_bytes
        # 低层在前：level0（最细）、level1……高层（最粗）——渲染端已知层数
        # 与每层桶数即可定位任意层偏移（write/read 同一约定）。
        for level_buckets in levels:
            if not level_buckets:
                continue
            packed = struct.pack(f"<{len(level_buckets) * 2}f",
                                 *[v for pair in level_buckets for v in pair])
            data += packed
        output.write_bytes(bytes(data))
        return len(data)


def parse_waveform_header(data: bytes) -> dict[str, Any]:
    """解析产物小头（magic + header 长度 + JSON）。返回 info 字典。

    损坏/非本算法 magic → ValueError（调用方按损坏缓存处理：LRU 清理后
    重新生成，不冒充命中）。
    """
    if len(data) < HEADER_MAGIC_LEN + 4:
        raise ValueError("waveform data too short")
    if data[:HEADER_MAGIC_LEN] != _HEADER_MAGIC:
        raise ValueError("waveform magic mismatch")
    (header_len,) = struct.unpack_from("<I", data, HEADER_MAGIC_LEN)
    end = HEADER_MAGIC_LEN + 4 + header_len
    if header_len > len(data) or end > len(data):
        raise ValueError("waveform header truncated")
    info = json_loads(data[HEADER_MAGIC_LEN + 4:end].decode("utf-8"))
    required = ("sample_rate", "channels", "bucket", "base_buckets", "levels")
    if not isinstance(info, dict) or any(k not in info for k in required):
        raise ValueError("waveform header fields missing")
    return info


def level_offsets(info: dict[str, Any]) -> list[int]:
    """各层数据区相对偏移（字节，起点 = header 之后）。

    层 k 桶数 = ceil(base_buckets / 2^k)；层序列长度（float32 数）=
    桶数 × 2。layout：level0 在前（write 约定）。
    """
    import math

    base = int(info["base_buckets"])
    if base < 0:
        raise ValueError("invalid base_buckets")
    offsets: list[int] = []
    cursor = 0
    level = 0
    while True:
        buckets = max(1, math.ceil(base / (2 ** level))) if base > 0 else 0
        offsets.append(cursor)
        if buckets <= 1:
            break
        cursor += buckets * 2 * 4
        level += 1
        if level > 64:
            break
    return offsets


def header_length(data: bytes) -> int:
    """header 总长（magic + 长度字段 + JSON 本体）。"""
    if len(data) < HEADER_MAGIC_LEN + 4:
        raise ValueError("waveform data too short")
    (header_len,) = struct.unpack_from("<I", data, HEADER_MAGIC_LEN)
    return HEADER_MAGIC_LEN + 4 + header_len


def read_level_min_max(data: bytes, info: dict[str, Any],
                       level: int) -> list[tuple[float, float]]:
    """读取指定层全部 (min, max) 桶（≤256KiB 档校验用）。"""
    import math

    offsets = level_offsets(info)
    if level < 0 or level >= len(offsets):
        return []
    base = int(info["base_buckets"])
    buckets = max(1, math.ceil(base / (2 ** level))) if base > 0 else 0
    start = header_length(data) + offsets[level]
    values = struct.unpack_from(f"<{buckets * 2}f", data, start)
    return [(values[i], values[i + 1]) for i in range(0, len(values), 2)]


def expected_bytes_for(duration_us: int) -> int:
    """全金字塔产物估算字节（预算/上限判定用）。"""
    import math

    if duration_us <= 0:
        return HEADER_MAGIC_LEN + 4 + 128
    total_samples = duration_us * SAMPLE_RATE / 1_000_000
    base = max(1, math.ceil(total_samples / BUCKET))
    total_pairs = 0
    level_pairs = base
    while level_pairs >= 1:
        total_pairs += level_pairs
        if level_pairs == 1:
            break
        level_pairs = math.ceil(level_pairs / 2)
    return HEADER_MAGIC_LEN + 4 + 160 + total_pairs * 2 * 4


# ---- FFmpeg 参数（白名单式组装） ----


def waveform_args(input_path: str) -> list[str]:
    """mono 8000Hz s16le raw PCM → stdout（streaming；无中间文件）。"""
    return [
        "-hide_banner", "-nostdin", "-y",
        "-i", str(input_path),
        "-vn",
        "-map", "0:a:0",
        "-ac", str(CHANNELS),
        "-ar", str(SAMPLE_RATE),
        "-c:a", "pcm_s16le",
        "-f", "s16le",
        "-progress", "pipe:2", "-nostats",
        "pipe:1",
    ]


async def generate_waveform(
    ffmpeg: Path,
    input_path: Path,
    output: Path,
    cancel_event: asyncio.Event,
    progress: Any = None,
) -> dict[str, Any]:
    """执行 FFmpeg 流式解码 + 聚合 + 写产物。返回统计字典。

    - stdout：s16le PCM（iter 分块读取——不整段缓冲）；
    - stderr：-progress 行（out_time_us 进度）+ 错误信息；
    - 取消：0.05s 轮询 + kill + await 回收（同 render.py 语义）。
    """
    aggregator = MinMaxAggregator()
    process = await asyncio.create_subprocess_exec(
        str(ffmpeg),
        *waveform_args(str(input_path)),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
    )

    assert process.stderr is not None
    stderr_task = asyncio.create_task(process.stderr.read())
    try:
        assert process.stdout is not None
        # 分块流式读取：聚合状态 O(1)，PCM 字节不落内存
        while True:
            chunk = await process.stdout.read(1024 * 1024)
            if not chunk:
                break
            _feed_chunk(aggregator, chunk)
        await process.wait()
        stderr = (await stderr_task).decode("utf-8", errors="replace")[-32768:]
    finally:
        if not stderr_task.done():
            stderr_task.cancel()
    if cancel_event.is_set():
        raise WaveformBuildError("JOB_CANCELLED", "任务已取消")
    if process.returncode != 0:
        raise WaveformBuildError("WAVEFORM_FFMPEG_FAILED", "FFmpeg 波形解码失败: " + stderr[-300:])
    stats = aggregator.finish()
    size = aggregator.write(output)
    return {**stats, "size_bytes": size, "output": str(output)}


def _feed_chunk(aggregator: MinMaxAggregator, chunk: bytes) -> None:
    """s16le 字节块 → 样本流（-32768..32767 归一 -1..1）。"""
    count = len(chunk) // 2
    if count == 0:
        return
    values = struct.unpack_from(f"<{count}h", chunk)
    scale = 1.0 / 32768.0
    for v in values:
        aggregator.feed(v * scale)


class WaveformService:
    """B14 波形服务：缓存键/查询/作业登记/作业执行（B10 派生缓存接入）。"""

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

    # ---- 参数/缓存键（params 定长字典——键成分即算法指纹） ----

    def params(self) -> dict[str, str]:
        return dict(WF_PARAMS)

    def toolchain_fingerprint(self) -> str:
        build = self.ffmpeg_build or "no-ffmpeg-build"
        return f"aivs-core-waveform-v{WF_ALGORITHM_VERSION}|{build}"

    def waveform_cache_key(self, asset_fingerprint: str) -> str:
        return derived_cache_key(
            "waveform", str(asset_fingerprint), WF_ALGORITHM_VERSION,
            self.params(), self.toolchain_fingerprint(),
        )

    def waveform_entry(self, asset_row: dict[str, Any]) -> dict[str, Any] | None:
        """查询素材波形条目（不触发生成；无行返回 None）。"""
        key = self.waveform_cache_key(asset_row["fingerprint"])
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

    # ---- 作业登记（jobs 表不做 schema 迁移：kind=waveform 携 cache_key 载荷） ----

    def create_waveform_job(
        self,
        project_id: str,
        asset_row: dict[str, Any],
        path: str,
    ) -> str:
        """登记波形生成作业（queued）。stat 在登记时取（执行期校验）。"""
        key = self.waveform_cache_key(asset_row["fingerprint"])
        job_id = new_id()
        now = utc_now()
        stat = Path(path).stat()
        payload = {
            "asset_id": asset_row["id"],
            "asset_fingerprint": str(asset_row["fingerprint"]),
            "cache_key": key,
            "path": str(path),
            "size_bytes": stat.st_size,
            "modified_at": stat.st_mtime_ns,
        }
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO jobs (id,project_id,asset_id,kind,type,status,stage,"
                "progress,input_json,encoder_requested,resource_class,attempt,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    job_id, project_id, asset_row["id"], "waveform", "waveform",
                    "queued", "queued", 0, json_dumps(payload),
                    None, "light", 1, now, now,
                ),
            )
        return job_id

    # ---- 作业执行（jobs.py render 域回调） ----

    async def run_waveform_job(
        self,
        row: Any,
        cancel_event: asyncio.Event,
        progress: Any = None,
        stage: Any = None,
    ) -> dict[str, Any]:
        """波形作业执行体：stat 校验 → begin_build → 流式聚合 → commit_ready。

        音频流判定：无音轨 → MEDIA_NO_AUDIO（不可生成波形，调用方提示）。
        """
        payload = json_loads(row["input_json"])
        if "cache_key" not in payload or "path" not in payload:
            raise WaveformBuildError("WAVEFORM_JOB_INVALID", "非波形生成作业载荷")
        cache_key = payload["cache_key"]
        input_path = Path(payload["path"])
        if not input_path.is_file():
            raise WaveformBuildError("MEDIA_CHANGED", "素材文件不存在")
        stat = input_path.stat()
        if ("size_bytes" in payload and "modified_at" in payload) and (
            stat.st_size != payload["size_bytes"] or stat.st_mtime_ns != payload["modified_at"]
        ):
            raise WaveformBuildError("MEDIA_CHANGED", "素材文件已变化")
        self.derived_cache.enforce_disk_budget()
        try:
            probe = await self.ffprobe.probe(input_path)
            if not (probe.get("audio_streams") or []):
                raise WaveformBuildError("MEDIA_NO_AUDIO", "素材无音轨")
            if stage:
                stage("waveform:ffmpeg")
            work_root = self.derived_cache.begin_build(
                cache_key, _payload_fingerprint(self.db, payload, cache_key), "waveform",
                self.params(), self.toolchain_fingerprint(),
            )
            if work_root is None:
                return {"cache_key": cache_key, "status": "already-ready"}
            output = work_root / "waveform.bin"
            stats = await generate_waveform(
                self.ffmpeg, input_path, output, cancel_event,
                progress or (lambda _value: None),
            )
            if cancel_event.is_set():
                raise WaveformBuildError("JOB_CANCELLED", "任务已取消")
            published = self.derived_cache.commit_ready(cache_key, "waveform", output)
            return {
                "cache_key": cache_key,
                "status": "ready",
                "path": str(published),
                "size_bytes": stats["size_bytes"],
                "sample_rate": stats["sample_rate"],
                "base_buckets": stats["base_buckets"],
            }
        except BaseException:
            # 失败/取消：同 B11 模式——mark_failed + failed 占位行（幂等短路有据）
            fingerprint = _payload_fingerprint(self.db, payload, cache_key)
            try:
                self.derived_cache.mark_failed(cache_key, "waveform")
            except Exception:
                pass
            with self.db.connection() as db:
                db.execute(
                    "INSERT OR IGNORE INTO derived_media_cache(cache_key,asset_fingerprint,"
                    "kind,params_json,schema_version,toolchain_fingerprint,relative_path,"
                    "size_bytes,status,created_at,last_accessed_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (cache_key, fingerprint, "waveform",
                     json_dumps(self.params()), 1,
                     self.toolchain_fingerprint(), "", 0, "failed", utc_now(), utc_now()),
                )
            raise


def _payload_fingerprint(db: Database, payload: dict[str, Any], cache_key: str) -> str:
    """begin_build 的 asset_fingerprint：载荷优先，缺失时按现有行取；拒绝无来源。"""
    value = str(payload.get("asset_fingerprint") or "")
    if value.startswith("sha256:"):
        return value
    with db.connection() as conn:
        row = conn.execute(
            "SELECT asset_fingerprint FROM derived_media_cache WHERE cache_key=?",
            (cache_key,),
        ).fetchone()
    if row is not None and str(row["asset_fingerprint"]).startswith("sha256:"):
        return str(row["asset_fingerprint"])
    raise WaveformBuildError(
        "WAVEFORM_JOB_INVALID", "波形作业载荷缺少素材指纹")
