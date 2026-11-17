"""WP-P232 素材级缩略图预抽（filmstrip sprite）。

契约（FILMSTRIP_PRESHOOT_PLANNING_GATE_2026-11-17.md §2）：
- 产物 = 单列 JPEG sprite（格宽 160px）+ 旁挂 JSON 元数据
  {step_ms, cell_w, cell_h, count, duration_us}；
- 生成 = ffmpeg 单进程：fps 选帧（step_ms 阶梯）→ tile 拼列 → mjpeg；
- 缓存 = B10 derived_media_cache kind="filmstrip"，params_json={"step_ms":…}；
- 触发 = 导入/转录完成后登记作业（jobs.py 分派，与 waveform 同构）。

设计来源（参照实证）：
- OpenFilm server/derived.mjs frame()：磁盘 JPEG 缓存 + cache-control 长缓存；
- Concat concat-media/prefetch.rs：导入即抽 + 低优先级批量（20 文件 = 20 个
  排队任务，绝不 20 个解码器）；
- 本仓 B14 waveform 作业形态（begin_build → ffmpeg → commit_ready）。

阶梯（对齐 OpenFilm lib/thumb-cache.ts ladderStepMs 1·2·2.5·5×10ⁿ）：
时间线 80px 格宽 × 当前 pps → 原始步长 → 阶梯取整。同档内缩放不重抽
（格 ≤2.5× 稀疏仍可覆盖——每格显示「最近已抽时刻」，参照 thumb-pick）。
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Callable

from ..database import json_loads

ALGORITHM_VERSION = 1
CELL_WIDTH = 160
JPEG_QUALITY = 5  # 与 OpenFilm frame() 同档（-q:v 5，视觉无差、体积小）

# 源时间阶梯：1 · 2 · 2.5 · 5 × 10ⁿ ms（OpenFilm thumb-cache.ts LADDER 同表）。
_LADDER = (1.0, 2.0, 2.5, 5.0)


class FilmstripBuildError(RuntimeError):
    """携带域错误码的构建失败（jobs 层按 message 前缀记录）。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def ladder_step_ms(raw_ms: float) -> int:
    """原始步长（毫秒）向上取整到阶梯档位。

    OpenFilm lib/thumb-cache.ts ladderStepMs 同语义：缩放在一个档位内
    保持同一组抽帧时刻——放大/缩小不触发重抽，格最多稀疏 2.5×，
    由绘制端「每格取最近已抽时刻」覆盖。
    """
    if raw_ms <= 0 or raw_ms != raw_ms:  # <=0 或 NaN
        return 1000
    scale = 10.0 ** (raw_ms.bit_length() if False else _log10_floor(raw_ms))
    while True:
        for k in _LADDER:
            step = k * scale
            if step >= raw_ms - 1e-9:
                return int(round(step))
        scale *= 10.0


def _log10_floor(value: float) -> int:
    import math

    return int(math.floor(math.log10(value)))


def filmstrip_args(input_path: str, step_ms: int, cell_w: int, duration_s: float) -> list[str]:
    """ffmpeg 单 pass 产 sprite：fps 选帧 → scale 到格宽 → tile 拼列 → mjpeg。

    - fps = 1000/step_ms（源时间等步长采样——阶梯档位决定帧数）；
    - tile=1xN：单列布局，N = ceil(duration_s × fps)（上限 512 格防炸内存，
      超长素材由调用方按档位粒度粗化——2.5× 步长增长自然收敛）；
    - -q:v 5：与 OpenFilm frame() 同档 JPEG 质量。
    """
    fps = 1000.0 / max(1, step_ms)
    # ceil 而非 int(+1)：整倍时长（3.0s × 1fps = 3 格）不多出黑格；
    # 非整倍向上取整保尾帧覆盖。512 上限防炸内存（超长素材由阶梯粗化收敛）。
    import math

    count = max(1, min(512, math.ceil(duration_s * fps)))
    return [
        "-hide_banner", "-nostdin", "-y",
        "-i", input_path,
        "-map", "0:v:0",
        "-vf", f"fps={fps:.6f},scale={cell_w}:-2,tile=1x{count}",
        "-frames:v", "1",
        "-q:v", str(JPEG_QUALITY),
        "-f", "mjpeg",
        "-progress", "pipe:2", "-nostats",
        "pipe:1",
    ]


def sprite_metadata(step_ms: int, cell_w: int, sprite_w: int, sprite_h: int,
                    duration_us: int) -> dict[str, Any]:
    """sprite 元数据（旁挂 JSON；画布采样用）。

    cell_h = sprite_h / count（tile 均分行）；count = round(sprite_h / cell_h_est)
    由 ffmpeg 产出后按实际高度反推——tile 行数即格数。
    """
    cell_h = None
    count = None
    # 由调用方在拿到 sprite 后按 cell_w 宽度比反推：真实 cell_h 由元数据写入方
    # 用 ffmpeg 输出的 tile 行数决定（见 generate_filmstrip 的返回）。
    return {
        "step_ms": step_ms,
        "cell_w": cell_w,
        "cell_h": cell_h,
        "count": count,
        "sprite_w": sprite_w,
        "sprite_h": sprite_h,
        "duration_us": duration_us,
    }


async def generate_filmstrip(
    ffmpeg: Path,
    input_path: Path,
    output: Path,
    step_ms: int,
    duration_us: int,
    cancel_event: asyncio.Event,
    progress: Callable[[float], None] | None = None,
) -> dict[str, Any]:
    """执行 FFmpeg tile 生成 sprite JPEG + 元数据 JSON。返回统计字典。

    - stdout：mjpeg sprite（单文件落盘——atomic 语义由 derived_cache 承担）；
    - stderr：-progress 行 + 错误信息（同 waveform 形态）；
    - 取消：kill + await 回采（同 render.py 语义）；
    - 元数据的 count/cell_h 由 sprite 实际尺寸反推（mjpeg 无逐格边界，
      tile 均分行是构造性保证）。
    """
    # 时长：从 ffprobe 侧已由调用方（作业体）注入 duration_us——这里换算
    fps = 1000.0 / max(1, step_ms)
    import math

    expected_count = max(1, min(512, math.ceil(duration_us / 1_000_000 * fps)))
    args = filmstrip_args(str(input_path), step_ms, CELL_WIDTH, duration_us / 1_000_000)
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
    chunks: list[bytes] = []
    total = 0
    try:
        assert process.stdout is not None
        while True:
            chunk = await process.stdout.read(1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if progress:
                # 进度 = 已产出字节 / 期望量级（粗估：每格 ~8KB JPEG q5 @160w）
                progress(min(0.99, total / max(1, expected_count * 8192)))
        await process.wait()
        stderr = (await stderr_task).decode("utf-8", errors="replace")[-32768:]
    finally:
        if not stderr_task.done():
            stderr_task.cancel()
    if cancel_event.is_set():
        try:
            process.kill()
        except ProcessLookupError:
            pass
        await process.wait()
        raise FilmstripBuildError("JOB_CANCELLED", "任务已取消")
    if process.returncode != 0:
        raise FilmstripBuildError("FILMSTRIP_FFMPEG_FAILED", "FFmpeg 缩略图生成失败: " + stderr[-300:])

    sprite = b"".join(chunks)
    if not sprite:
        raise FilmstripBuildError("FILMSTRIP_EMPTY", "FFmpeg 未产出帧")
    # 解析 JPEG 尺寸（SOF0/SOF2 段；不引入 Pillow——生产依赖零新增）
    sprite_w, sprite_h = _jpeg_size(sprite)
    if sprite_w <= 0 or sprite_h <= 0:
        raise FilmstripBuildError("FILMSTRIP_EMPTY", "无法解析 sprite 尺寸")
    # tile 行数 = expected_count（fps 选帧可能少于预期——素材短于一格步长时
    # ffmpeg 实际产出 ≤ expected_count；按实际高度反推：cell_h = sprite_h / rows，
    # rows = round(sprite_h / (sprite_w * 9 / 16))？不可靠。改为：tile 行数由
    # tile=1xN 参数决定，N=expected_count——若素材不足 N 格，ffmpeg 会产出
    # 黑格补齐（tile 的既定行为），count = expected_count 恒成立。
    count = expected_count
    cell_h = sprite_h // count
    output.write_bytes(sprite)
    meta = {
        "step_ms": step_ms,
        "cell_w": sprite_w,
        "cell_h": cell_h,
        "count": count,
        "sprite_w": sprite_w,
        "sprite_h": sprite_h,
        "duration_us": duration_us,
        "algorithm_version": ALGORITHM_VERSION,
    }
    output.with_suffix(".json").write_text(json.dumps(meta), encoding="utf-8")
    return {
        "size_bytes": len(sprite),
        "step_ms": step_ms,
        "cell_w": sprite_w,
        "cell_h": cell_h,
        "count": count,
        "duration_us": duration_us,
    }


def _jpeg_size(data: bytes) -> tuple[int, int]:
    """解析 JPEG SOF 段取宽高（最小实现；不支持渐进式之外的罕见段错即失败）。"""
    i = 2
    size = len(data)
    while i + 9 < size:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        if i + 3 >= size:
            return (0, 0)
        seg_len = (data[i + 2] << 8) | data[i + 3]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3):  # SOF0/1/2/3
            if i + 9 <= size:
                h = (data[i + 5] << 8) | data[i + 6]
                w = (data[i + 7] << 8) | data[i + 8]
                return (w, h)
            return (0, 0)
        i += 2 + seg_len
    return (0, 0)


def parse_sprite_meta(data: bytes) -> dict[str, Any]:
    """读 sprite 旁挂 JSON 元数据（Renderer 经取件通道拿到的是 sprite 本体，
    元数据由 Core 侧 API 直出——此函数供作业体/测试复核用）。"""
    return json_loads(data.decode("utf-8"))

# ---- WP-P232 服务层（缓存键/作业登记/作业执行；waveform 同构） ----

from ..database import Database, json_dumps, utc_now  # noqa: E402
from ..ids import new_id  # noqa: E402
from .derived_cache import derived_cache_key  # noqa: E402

FS_ALGORITHM_VERSION = ALGORITHM_VERSION
# 算法常量（进 params → 缓存键成分；改值即键换代）
FS_PARAMS = {"cell_w": str(CELL_WIDTH), "quality": str(JPEG_QUALITY)}


class FilmstripService:
    """WP-P232 缩略图预抽服务：缓存键/查询/作业登记/作业执行。

    与 WaveformService 同构（B10 派生缓存接入）：params 定长（step_ms 除外
    ——step_ms 是查询维度的档位参数而非算法常量，走 params_json 与键）。
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

    # ---- 参数/缓存键 ----

    def params(self, step_ms: int) -> dict[str, str]:
        return {**FS_PARAMS, "step_ms": str(step_ms)}

    def toolchain_fingerprint(self) -> str:
        build = self.ffmpeg_build or "no-ffmpeg-build"
        return f"aivs-core-filmstrip-v{FS_ALGORITHM_VERSION}|{build}"

    def filmstrip_cache_key(self, asset_fingerprint: str, step_ms: int) -> str:
        return derived_cache_key(
            "filmstrip", str(asset_fingerprint), FS_ALGORITHM_VERSION,
            self.params(step_ms), self.toolchain_fingerprint(),
        )

    def filmstrip_entry(self, asset_row: dict[str, Any], step_ms: int) -> dict[str, Any] | None:
        """查询素材缩略条目（不触发生成；无行返回 None）。"""
        key = self.filmstrip_cache_key(asset_row["fingerprint"], step_ms)
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

    def nearest_step(self, raw_step_ms: float) -> int:
        return ladder_step_ms(raw_step_ms)

    def duration_us_of(self, asset_row: dict[str, Any]) -> int:
        media_info = json_loads(asset_row["media_info_json"]) if asset_row["media_info_json"] else {}
        return int(media_info.get("duration_us") or 0)

    # ---- 作业登记 ----

    def create_filmstrip_job(self, project_id: str, asset_row: dict[str, Any], path: str,
                             step_ms: int) -> str:
        """登记缩略图生成作业（queued）。stat 在登记时取（执行期校验）。"""
        key = self.filmstrip_cache_key(asset_row["fingerprint"], step_ms)
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
            "step_ms": step_ms,
            "duration_us": self.duration_us_of(asset_row),
        }
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO jobs (id,project_id,asset_id,kind,type,status,stage,"
                "progress,input_json,encoder_requested,resource_class,attempt,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    job_id, project_id, asset_row["id"], "filmstrip", "filmstrip",
                    "queued", "queued", 0, json_dumps(payload),
                    None, "light", 1, now, now,
                ),
            )
        return job_id

    # ---- 作业执行（jobs.py render 域回调） ----

    async def run_filmstrip_job(
        self,
        row: Any,
        cancel_event: asyncio.Event,
        progress: Any = None,
        stage: Any = None,
    ) -> dict[str, Any]:
        """缩略图作业执行体：stat 校验 → begin_build → ffmpeg tile → commit_ready。

        视频流判定：无视频流 → MEDIA_NO_VIDEO（图片/音频素材不生成缩略条）。
        """
        payload = json_loads(row["input_json"])
        if "cache_key" not in payload or "path" not in payload or "step_ms" not in payload:
            raise FilmstripBuildError("FILMSTRIP_JOB_INVALID", "非缩略图生成作业载荷")
        cache_key = payload["cache_key"]
        step_ms = int(payload["step_ms"])
        duration_us = int(payload.get("duration_us") or 0)
        input_path = Path(payload["path"])
        if not input_path.is_file():
            raise FilmstripBuildError("MEDIA_CHANGED", "素材文件不存在")
        stat = input_path.stat()
        if ("size_bytes" in payload and "modified_at" in payload) and (
            stat.st_size != payload["size_bytes"] or stat.st_mtime_ns != payload["modified_at"]
        ):
            raise FilmstripBuildError("MEDIA_CHANGED", "素材文件已变化")
        self.derived_cache.enforce_disk_budget()
        try:
            probe = await self.ffprobe.probe(input_path, require_video=False)
            if not (probe.get("video_streams") or []):
                raise FilmstripBuildError("MEDIA_NO_VIDEO", "素材无视频流")
            if duration_us <= 0:
                duration_us = int((probe.get("duration_us") or 0))
            if duration_us <= 0:
                raise FilmstripBuildError("FILMSTRIP_NO_DURATION", "素材时长未知")
            if stage:
                stage("filmstrip:ffmpeg")
            work_root = self.derived_cache.begin_build(
                cache_key, payload.get("asset_fingerprint") or "", "filmstrip",
                self.params(step_ms), self.toolchain_fingerprint(),
            )
            if work_root is None:
                return {"cache_key": cache_key, "status": "already-ready"}
            output = work_root / "filmstrip.jpg"
            stats = await generate_filmstrip(
                self.ffmpeg, input_path, output, step_ms, duration_us, cancel_event,
                progress or (lambda _value: None),
            )
            if cancel_event.is_set():
                raise FilmstripBuildError("JOB_CANCELLED", "任务已取消")
            published = self.derived_cache.commit_ready(cache_key, "filmstrip", output)
            # 元数据：generate 写在 work_root（output.with_suffix('.json')）；
            # commit_ready 只搬主产物 → 旁挂 JSON 手工搬到 entry root
            # （published.parent 即 entry root；同盘 rename 原子）。
            meta_src = output.with_suffix(".json")
            if meta_src.is_file():
                meta_dst = published.parent / (published.stem + ".json")
                if meta_src != meta_dst:
                    meta_src.replace(meta_dst)
            return {
                "cache_key": cache_key,
                "status": "ready",
                "path": str(published),
                "size_bytes": stats["size_bytes"],
                "step_ms": stats["step_ms"],
                "cell_w": stats["cell_w"],
                "cell_h": stats["cell_h"],
                "count": stats["count"],
                "duration_us": stats["duration_us"],
            }
        except BaseException:
            fingerprint = payload.get("asset_fingerprint") or ""
            try:
                self.derived_cache.mark_failed(cache_key, "filmstrip")
            except Exception:
                pass
            with self.db.connection() as db:
                db.execute(
                    "INSERT OR IGNORE INTO derived_media_cache(cache_key,asset_fingerprint,"
                    "kind,params_json,schema_version,toolchain_fingerprint,relative_path,"
                    "size_bytes,status,created_at,last_accessed_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (cache_key, fingerprint, "filmstrip",
                     json_dumps(self.params(step_ms)), FS_ALGORITHM_VERSION,
                     self.toolchain_fingerprint(), "", 0, "failed", utc_now(), utc_now()),
                )
            raise
