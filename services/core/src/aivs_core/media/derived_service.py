"""B10 派生媒体服务层：参数校验、素材归属校验、缓存编排。

约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B10 / 6.1 跨进程契约）：
- 请求校验 project/asset 归属、kind 枚举、params 键值白名单与上限——
  拒绝 Renderer 传任意路径/URL/FFmpeg 参数。
- 所有请求按素材 fingerprint 生成内容寻址缓存键（不含 asset_id/project_id
  ——同内容跨项目物理去重，授权由 refs 表按 project/asset 证明）。
- ready 条目在返回前记录引用（add_reference 经 v18 触发器强制归属）。
- 生成执行（FFmpeg 作业）由 B11+ 接入；本层提供 lookup/resolve/stats
  与后续 build 的编排骨架（begin/commit/mark_failed 直通存储层）。
"""
from __future__ import annotations

from typing import Any

from ..database import Database, utc_now
from ..projects import DomainError
from .derived_cache import DerivedCacheError, DerivedMediaCache, derived_cache_key

ALGORITHM_VERSION = 1
KINDS = ("video_proxy", "waveform", "audio_pcm_chunk", "reverse_chunk", "filmstrip")
MAX_PARAMS = 8
PARAM_KEY_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789_")
PARAM_VALUE_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-")


class DerivedMediaService:
    """派生媒体查询/解析/登记服务（Renderer 经 IPC → app.py 端点 → 此层）。"""

    def __init__(self, db: Database, cache: DerivedMediaCache,
                 toolchain_fingerprint: str) -> None:
        self.db = db
        self.cache = cache
        self.toolchain_fingerprint = toolchain_fingerprint

    # ---- 校验 ----

    @staticmethod
    def _validate_params(params: dict[str, Any]) -> dict[str, str]:
        if not isinstance(params, dict) or len(params) > MAX_PARAMS:
            raise DomainError("DERIVED_PARAMS_INVALID", "派生参数不合法")
        clean: dict[str, str] = {}
        for key, value in params.items():
            if not isinstance(key, str) or not key or set(key) - PARAM_KEY_CHARS:
                raise DomainError("DERIVED_PARAMS_INVALID", "派生参数键不合法")
            if not isinstance(value, str) or not value or set(value) - PARAM_VALUE_CHARS:
                raise DomainError("DERIVED_PARAMS_INVALID", "派生参数值不合法")
            clean[key] = value
        return clean

    def _require_asset(self, project_id: str, asset_id: str) -> dict[str, Any]:
        """素材存在、属于该 project 且指纹可用（availability 异常走既有域错误）。"""
        row = self._asset_row(asset_id)
        if row is None:
            raise DomainError("ASSET_NOT_FOUND", "素材不存在")
        if row["project_id"] != project_id:
            raise DomainError("ASSET_NOT_FOUND", "素材不存在")
        if row["availability"] == "changed":
            raise DomainError("ASSET_CHANGED", "素材已变化")
        if row["availability"] == "missing":
            raise DomainError("ASSET_MISSING", "素材文件缺失")
        # unsupported（如探测环境缺失）也可查询已缓存派生项：内容指纹仍
        # 稳定——缓存条目本身不受 availability 影响，生成路径由调用方判断。
        if not row["fingerprint"] or not str(row["fingerprint"]).startswith("sha256:"):
            raise DomainError("ASSET_CHANGED", "素材指纹不可用")
        return row

    def _asset_row(self, asset_id: str) -> dict[str, Any] | None:
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        return dict(row) if row else None

    # ---- 缓存键 ----

    def cache_key_for(self, project_id: str, asset_id: str, kind: str,
                      params: dict[str, Any]) -> tuple[str, dict[str, str]]:
        """校验 + 生成内容寻址键（不含 asset_id/路径——物理去重，授权走 refs）。"""
        if kind not in KINDS:
            raise DomainError("DERIVED_KIND_INVALID", "派生类别不合法")
        row = self._require_asset(project_id, asset_id)
        clean = self._validate_params(params)
        key = derived_cache_key(
            kind, str(row["fingerprint"]), ALGORITHM_VERSION, clean,
            self.toolchain_fingerprint,
        )
        return key, clean

    # ---- 查询/解析 ----

    def lookup(self, project_id: str, asset_id: str, kind: str,
               params: dict[str, Any]) -> dict[str, Any]:
        """查询条目（ready/building/failed 状态均返回；命中 ready 顺带记引用）。"""
        key, _ = self.cache_key_for(project_id, asset_id, kind, params)
        entry = self.cache.lookup(key)
        if entry is not None:
            self.cache.add_reference(key, project_id, asset_id)
            return self._dto(entry)
        # 未命中：查行状态（building/failed 也对 Renderer 可见）
        with self.db.connection() as db:
            row = db.execute(
                "SELECT status,created_at,last_accessed_at,size_bytes FROM derived_media_cache "
                "WHERE cache_key=?", (key,),
            ).fetchone()
        if row is None:
            raise DomainError("DERIVED_NOT_FOUND", "派生缓存条目不存在")
        return {
            "cache_key": key,
            "kind": kind,
            "status": row["status"],
            "size_bytes": row["size_bytes"],
            "created_at": row["created_at"],
            "last_accessed_at": row["last_accessed_at"],
        }

    def resolve_internal(self, project_id: str, asset_id: str, kind: str,
                         params: dict[str, Any]) -> dict[str, Any]:
        """Main 内部解析：ready 条目返回绝对路径（Renderer 永远拿不到 path）。"""
        key, _ = self.cache_key_for(project_id, asset_id, kind, params)
        entry = self.cache.lookup(key)
        if entry is None:
            raise DomainError("DERIVED_NOT_FOUND", "派生缓存条目不存在或未就绪")
        self.cache.add_reference(key, project_id, asset_id)
        try:
            path = self.cache.resolved_path(entry)
        except DerivedCacheError as exc:
            raise DomainError("DERIVED_CACHE_UNSAFE", exc.message) from exc
        return {
            "cache_key": key,
            "kind": kind,
            "status": "ready",
            "path": str(path),
            "size_bytes": entry.size_bytes,
        }

    def stats(self) -> dict[str, Any]:
        return {
            "total_ready_bytes": self.cache.total_ready_bytes(),
            "ready_count": self._ready_count(),
            "disk_budget_bytes": self.cache.disk_budget_bytes,
        }

    def _ready_count(self) -> int:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT COUNT(*) FROM derived_media_cache WHERE status='ready'"
            ).fetchone()
        return int(row[0])

    @staticmethod
    def _dto(entry: Any) -> dict[str, Any]:
        return {
            "cache_key": entry.cache_key,
            "kind": entry.kind,
            "status": entry.status,
            "size_bytes": entry.size_bytes,
            "created_at": utc_now(),  # 存储层条目未带时间戳列值，DTO 以查询时刻替代
            "last_accessed_at": utc_now(),
        }
