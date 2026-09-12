"""B11 preview-source 服务：全源代理生成编排 + 预览源选择。

约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B11）：
- 代理生成 = FFmpeg 整段转码（proxy_profiles 白名单参数），产物进 B10
  derived_media_cache（video_proxy kind）：begin_build（single-flight）→
  工作目录转码 → commit_ready 原子发布；失败 mark_failed 清残留。
- 源描述与 IR 逻辑 geometry 分离：响应携带编码/显示几何与时间映射
  （source_origin_us），不改变 PiP/裁切坐标语义（IR geometry 不变）。
- 禁止对每次导入立即编码整段长源：只有显式请求（mode="proxy" 或 auto
  判定代理已 ready）才建作业；pending 期间调用方回退原源预览。
- jobs 表不做 schema 迁移：代理作业 kind="proxy"（与 10 秒 sample 路径
  同 kind 不同载荷——input_json 携带 cache_key/profile/asset），旧 sample
  载荷无 cache_key 字段，_run 侧按载荷分派互不干扰。
- B10 报告已知限制清偿：代理键的工具链指纹混入 FFmpeg build（同 A07
  ffprobe_build 模式）——FFmpeg 更换即键换代，旧条目按 LRU 回收。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from ..database import Database, json_dumps, json_loads, utc_now
from ..ids import new_id
from ..projects import DomainError
from .derived_cache import derived_cache_key
from .encoders import EncoderDetector
from .ffprobe import FFprobe
from .proxy_profiles import (
    PROFILE_IDS,
    choose_profile,
    coded_size,
    display_size,
    normalize_source,
    normalized_codec,
    proxy_args,
)
from .render import render_media

MODES = ("auto", "original", "proxy")
PROXY_ALGORITHM_VERSION = 1


class ProxyBuildError(RuntimeError):
    """代理生成失败（存储层约束/编码失败）。code 进 jobs error_code。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class PreviewSourceService:
    def __init__(
        self,
        db: Database,
        derived_cache: Any,
        ffmpeg: Path,
        ffprobe: FFprobe,
        encoders: EncoderDetector,
        *,
        ffmpeg_build: str | None,
    ) -> None:
        self.db = db
        self.derived_cache = derived_cache
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.encoders = encoders
        self.ffmpeg_build = ffmpeg_build

    # ---- 源描述（无生成副作用） ----

    def describe(
        self,
        asset_row: dict[str, Any],
        mode: str,
        profile_id: str | None = None,
        proxy: dict[str, Any] | None = None,
        duration_us: int | None = None,
    ) -> dict[str, Any]:
        """组装 preview-source 响应（计划 B11 语义接口字段）。

        asset_row：assets 行（含 media_info_json/fingerprint/kind/availability）。
        proxy：proxy_entry() 结果（None = 无代理条目）。
        请求 mode 与生效 source kind 两层：auto 生效代理时 mode 回显 "proxy"
        （生效模式），请求模式不单独回显——调用方据 status/source_id 判断。
        """
        if mode not in MODES:
            raise DomainError("PREVIEW_SOURCE_MODE_INVALID", "预览源模式不合法")
        media_info = (
            json_loads(asset_row["media_info_json"]) if asset_row.get("media_info_json") else None
        )
        streams = (media_info or {}).get("video_streams") or []
        stream = normalize_source(streams[0]) if streams else None
        if stream is None:
            raise DomainError("ASSET_NO_VIDEO_STREAM", "素材无可用的视频流")
        duration = int(
            duration_us if duration_us is not None else (media_info or {}).get("duration_us") or 0
        )
        sar = (stream["sar_num"] / stream["sar_den"]) if stream["sar_den"] else 1.0
        disp_w, disp_h = display_size(
            stream["width"], stream["height"], sar, stream["rotation"],
        )
        resolved_profile = profile_id or choose_profile(disp_w, disp_h)

        def source_id(kind: str) -> str:
            return f"src_{asset_row['id']}_{resolved_profile}_{kind}"

        base: dict[str, Any] = {
            "asset_fingerprint": str(asset_row["fingerprint"]),
            "profile_id": resolved_profile,
            "duration_us": duration,
            "source_origin_us": 0,  # 原源直读：decode-worker 直接吃原容器 PTS
            "fps_num": stream["fps_num"],
            "fps_den": stream["fps_den"] or 1,
            "coded_width": stream["width"],
            "coded_height": stream["height"],
            "display_width": disp_w,
            "display_height": disp_h,
            "rotation": stream["rotation"],
            "codec": normalized_codec(stream["codec"]),
        }
        ready = (proxy or {}).get("status") == "ready"
        use_proxy = mode == "proxy" or (mode == "auto" and ready)
        base["mode"] = "proxy" if use_proxy else "original"  # 生效模式（非请求模式）
        if use_proxy:
            status = "ready" if ready else "pending"
            entry: dict[str, Any] = {
                **base,
                "source_id": source_id("proxy"),
                "status": status,
                "cache_key": (proxy or {}).get("cache_key"),
                "size_bytes": (proxy or {}).get("size_bytes"),
                "codec": "avc" if ready else base["codec"],
                "fps_num": 30 if ready else base["fps_num"],
                "fps_den": 1 if ready else base["fps_den"],
            }
            if ready:
                # 代理几何（归一旋转/SAR 后的编码尺寸；display 即编码显示尺寸）
                w, h = coded_size(
                    resolved_profile, stream["width"], stream["height"],
                    sar=sar, rotation=stream["rotation"],
                )
                entry["coded_width"], entry["coded_height"] = w, h
                entry["display_width"], entry["display_height"] = w, h
                entry["rotation"] = 0  # 旋转已烘焙进编码帧
            return entry
        # original / auto（代理未就绪）：pending 期间保留原源回退（不阻塞 UI）
        available = asset_row["availability"] == "available"
        return {
            **base,
            "source_id": source_id("original"),
            "status": "ready" if available else "unavailable",
            "cache_key": None,
            "size_bytes": None,
        }

    # ---- 缓存查询 ----

    def proxy_params(self, profile_id: str) -> dict[str, str]:
        if profile_id not in PROFILE_IDS:
            raise DomainError("PREVIEW_PROFILE_INVALID", "代理档位不合法")
        return {"profile": profile_id}

    def toolchain_fingerprint(self) -> str:
        build = self.ffmpeg_build or "no-ffmpeg-build"
        return f"aivs-core-proxy-v{PROXY_ALGORITHM_VERSION}|{build}"

    def proxy_cache_key(self, asset_fingerprint: str, profile_id: str) -> str:
        return derived_cache_key(
            "video_proxy", str(asset_fingerprint), PROXY_ALGORITHM_VERSION,
            self.proxy_params(profile_id), self.toolchain_fingerprint(),
        )

    def proxy_entry(self, asset_row: dict[str, Any], profile_id: str) -> dict[str, Any] | None:
        """查询该素材+档位的代理条目（不触发生成；无行返回 None）。"""
        key = self.proxy_cache_key(asset_row["fingerprint"], profile_id)
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

    # ---- 作业登记 ----

    def create_proxy_job(
        self,
        project_id: str,
        asset_row: dict[str, Any],
        profile_id: str,
        path: str,
        encoder_mode: str = "auto",
    ) -> str:
        """登记代理生成作业（queued）。cache_key 入 input_json（不迁移 jobs 表）。

        path 的 stat(size, mtime_ns) 在登记时取（assets.modified_at 是 ISO 串，
        与执行期 st_mtime_ns 校验不同域——以文件系统为准）。
        """
        params = self.proxy_params(profile_id)
        key = derived_cache_key(
            "video_proxy", str(asset_row["fingerprint"]), PROXY_ALGORITHM_VERSION,
            params, self.toolchain_fingerprint(),
        )
        job_id = new_id()
        now = utc_now()
        stat = Path(path).stat()
        payload = {
            "asset_id": asset_row["id"],
            "asset_fingerprint": str(asset_row["fingerprint"]),
            "profile_id": profile_id,
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
                    job_id, project_id, asset_row["id"], "proxy", "proxy",
                    "queued", "queued", 0, json_dumps(payload),
                    encoder_mode, "render", 1, now, now,
                ),
            )
        return job_id

    # ---- 作业执行（jobs.py render 域回调） ----

    async def run_proxy_job(
        self,
        row: Any,
        cancel_event: asyncio.Event,
        progress: Any = None,
        stage: Any = None,
    ) -> dict[str, Any]:
        """代理作业执行体：probe → begin_build → 全源转码 → commit_ready。

        与 10 秒 sample 路径的关键差异：不做 `-t` 截断、产物进 B10 缓存
        （不做 artifacts 行——派生缓存才是消费方）。
        """
        payload = json_loads(row["input_json"])
        if "cache_key" not in payload or "path" not in payload:
            raise ProxyBuildError("PROXY_JOB_INVALID", "非代理生成作业载荷")
        profile_id = payload["profile_id"]
        cache_key = payload["cache_key"]
        input_path = Path(payload["path"])
        if not input_path.is_file():
            raise ProxyBuildError("MEDIA_CHANGED", "素材文件不存在")
        stat = input_path.stat()
        if ("size_bytes" in payload and "modified_at" in payload) and (
            stat.st_size != payload["size_bytes"] or stat.st_mtime_ns != payload["modified_at"]
        ):
            raise ProxyBuildError("MEDIA_CHANGED", "素材文件已变化")
        # 磁盘预算前置检查：空间不足时如实失败（调用方提示，不静默继续生成）
        self.derived_cache.enforce_disk_budget()
        try:
            probe = await self.ffprobe.probe(input_path)
            stream = normalize_source((probe.get("video_streams") or [{}])[0])
            if stream is None:
                raise ProxyBuildError("MEDIA_UNSUPPORTED", "素材无可用的视频流")
            sar = (stream["sar_num"] / stream["sar_den"]) if stream["sar_den"] else 1.0
            work_root = self.derived_cache.begin_build(
                cache_key, _payload_fingerprint(self.db, payload, cache_key), "video_proxy",
                self.proxy_params(profile_id), self.toolchain_fingerprint(),
            )
            if work_root is None:
                return {"cache_key": cache_key, "status": "already-ready"}
            encoder, fallback = await self.encoders.choose(row["encoder_requested"] or "auto")
            if stage:
                stage(f"proxy:{encoder}" + (":fallback" if fallback else ""))
            output = work_root / "proxy.mp4"
            args = proxy_args(
                str(input_path), str(output), profile_id,
                stream["width"], stream["height"], encoder,
                sar=sar, rotation=stream["rotation"],
            )
            result = await render_media(
                self.ffmpeg, self.ffprobe, args, output,
                int(probe["duration_us"]), cancel_event,
                progress or (lambda _value: None),
            )
            if cancel_event.is_set():
                raise ProxyBuildError("JOB_CANCELLED", "任务已取消")
            published = self.derived_cache.commit_ready(cache_key, "video_proxy", output)
            return {
                "cache_key": cache_key,
                "status": "ready",
                "path": str(published),
                "encoder": encoder,
                "fallback_reason": fallback,
                "size_bytes": result["size_bytes"],
                "media_info": result["media_info"],
            }
        except BaseException:
            # 失败/取消：清工作目录残留 + 行标 failed（mark_failed 的 UPDATE
            # 只改已有行——probe 期失败（begin_build 前）无行，此处 INSERT
            # failed 占位（INSERT OR IGNORE 幂等），保证生成幂等短路有据可查）。
            fingerprint = _payload_fingerprint(self.db, payload, cache_key)
            try:
                self.derived_cache.mark_failed(cache_key, "video_proxy")
            except Exception:
                pass
            with self.db.connection() as db:
                db.execute(
                    "INSERT OR IGNORE INTO derived_media_cache(cache_key,asset_fingerprint,"
                    "kind,params_json,schema_version,toolchain_fingerprint,relative_path,"
                    "size_bytes,status,created_at,last_accessed_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (cache_key, fingerprint, "video_proxy",
                     json_dumps(self.proxy_params(profile_id)), 1,
                     self.toolchain_fingerprint(), "", 0, "failed", utc_now(), utc_now()),
                )
            raise


def _payload_fingerprint(db: Database, payload: dict[str, Any], cache_key: str) -> str:
    """begin_build 的 asset_fingerprint：载荷优先，缺失时按 cache_key 从
    derived_media_cache 现有行取（重建残留行场景）；无来源时拒绝（表
    CHECK 强制 sha256: 前缀）。"""
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
    raise ProxyBuildError(
        "PROXY_JOB_INVALID", "代理作业载荷缺少素材指纹")
