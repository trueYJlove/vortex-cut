"""B10 派生媒体缓存存储层：缓存键、目录布局、原子发布、LRU 清理。

约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B10）：
- CacheKey = SHA256(canonicalJSON({kind, assetFingerprint, algorithmVersion,
  params, toolchain}))；不包含绝对路径、短期票据、asset_id（内容寻址，
  跨项目物理去重可行，授权由 refs 表按 project/asset 证明）。
- 目录 data_dir/cache/derived/<kind>/<key前2位>/<key>/；build 写同目录
  临时文件，验证后原子 rename 为 ready；SQL ready 只能在文件发布后写入。
- 启动恢复 building 残留：无 job 认领的 building 行删除（半产物不作命中）。
- 清理：磁盘预算（默认 10GiB）LRU 只清未 pin 派生项；保留至少 2GiB
  可用空间，否则暂停新生成；Windows 递归清理前 resolve 验证路径落在
  专属 cache 根内、拒绝 symlink/reparse 越界。
- 绝不删除原素材、项目、导出文件——只操作 derived cache 根。
"""
from __future__ import annotations

import hashlib
import shutil
import stat
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..database import Database, json_dumps, utc_now

KINDS = ("video_proxy", "waveform", "audio_pcm_chunk", "reverse_chunk", "filmstrip")
DEFAULT_DISK_BUDGET_BYTES = 10 * 1024**3
MIN_FREE_BYTES = 2 * 1024**3
_PIN_TIMEOUT_S = 600.0


class DerivedCacheError(RuntimeError):
    """派生缓存操作失败（磁盘满/路径越界/状态非法）。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def derived_cache_key(kind: str, asset_fingerprint: str, algorithm_version: int,
                      params: dict[str, Any], toolchain: str) -> str:
    """内容寻址缓存键（计划：canonicalJSON SHA256，无路径/票据成分）。"""
    if kind not in KINDS:
        raise ValueError(f"unknown derived kind: {kind}")
    canonical = json_dumps({
        "kind": kind,
        "asset_fingerprint": asset_fingerprint,
        "algorithm_version": algorithm_version,
        "params": params,
        "toolchain": toolchain,
    })
    return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


@dataclass(frozen=True)
class DerivedEntry:
    cache_key: str
    kind: str
    status: str
    relative_path: str
    size_bytes: int


def _path_is_reparse(path: Path) -> bool:
    """Windows symlink/reparse point 检测（与 provider_image_generation 同法）。"""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        return True
    attributes = getattr(info, "st_file_attributes", 0)
    return stat.S_ISLNK(info.st_mode) or bool(
        attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )


class DerivedMediaCache:
    """派生媒体缓存存储：文件 + derived_media_cache 表 + 引用映射。

    - 目录归属校验：所有文件操作先 resolve 并确认落在 cache 根内，
      拒绝 symlink/reparse 中转（防越界删除）。
    - single-flight：同 key 并发 build 只有一个执行者，等待者共享结果。
    - 运行时 pin：LRU 清理跳过持有中的 key（lease 语义，不依赖永久
      refcount——TTL 过期即视为可回收，避免崩溃残留永久 pin）。
    """

    def __init__(self, db: Database, cache_root: Path,
                 disk_budget_bytes: int = DEFAULT_DISK_BUDGET_BYTES) -> None:
        self.db = db
        self.cache_root = cache_root
        self.disk_budget_bytes = disk_budget_bytes
        self._inflight: dict[str, object] = {}
        self._pins: dict[str, float] = {}
        self._lock = threading.Lock()

    # ---- 布局 ----

    def entry_root(self, cache_key: str, kind: str) -> Path:
        if kind not in KINDS:
            raise ValueError(f"unknown derived kind: {kind}")
        digest = cache_key.removeprefix("sha256:")
        return self.cache_root / "derived" / kind / digest[:2] / digest

    def _validated_entry_root(self, cache_key: str, kind: str) -> Path:
        """resolve 校验落点在 cache 根内且无 reparse 中转（删除前必查）。"""
        root = self.entry_root(cache_key, kind)
        # 逐级校验（父目录可能尚不存在，但已存在段不得为 reparse）
        if _path_is_reparse(self.cache_root):
            raise DerivedCacheError(
                "CACHE_PATH_UNSAFE", f"cache root is a reparse point: {self.cache_root}")
        relative = root.relative_to(self.cache_root)
        current = self.cache_root
        for part in relative.parts:
            current = current / part
            if _path_is_reparse(current):
                raise DerivedCacheError(
                    "CACHE_PATH_UNSAFE", f"reparse point inside cache path: {current}")
        return root

    # ---- 查询 ----

    def lookup(self, cache_key: str, *, touch: bool = True) -> DerivedEntry | None:
        """ready 条目查询（building/failed 不作命中）；touch 刷新 LRU 时间。"""
        with self.db.connection() as db:
            row = db.execute(
                "SELECT cache_key,kind,status,relative_path,size_bytes FROM derived_media_cache "
                "WHERE cache_key=?", (cache_key,)
            ).fetchone()
            if row is None:
                return None
            if row["status"] != "ready":
                return None
            if touch:
                db.execute(
                    "UPDATE derived_media_cache SET last_accessed_at=? WHERE cache_key=?",
                    (utc_now(), cache_key),
                )
        return DerivedEntry(row["cache_key"], row["kind"], row["status"],
                            row["relative_path"], row["size_bytes"])

    def resolved_path(self, entry: DerivedEntry) -> Path:
        """ready 条目的绝对路径（Main 内部响应用；Renderer 只见票据 URL）。"""
        if _path_is_reparse(Path(entry.relative_path)):
            raise DerivedCacheError("CACHE_PATH_UNSAFE", "entry relative_path is reparse")
        target = (self.cache_root / entry.relative_path).resolve(strict=False)
        root = self.cache_root.resolve(strict=False)
        if target != root and root not in target.parents:
            raise DerivedCacheError("CACHE_PATH_UNSAFE", "entry path escapes cache root")
        return target

    # ---- 引用授权 ----

    def add_reference(self, cache_key: str, project_id: str, asset_id: str) -> None:
        """project/asset → cache_key 引用（触发器强制资产归属，越权即 IntegrityError）。"""
        now = utc_now()
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO derived_media_cache_refs(cache_key,project_id,asset_id,"
                "created_at,last_accessed_at) VALUES (?,?,?,?,?) "
                "ON CONFLICT(cache_key,project_id,asset_id) DO UPDATE SET "
                "last_accessed_at=excluded.last_accessed_at",
                (cache_key, project_id, asset_id, now, now),
            )

    # ---- 构建（single-flight + 原子发布） ----

    def begin_build(self, cache_key: str, asset_fingerprint: str, kind: str,
                    params: dict[str, Any], toolchain: str) -> Path | None:
        """登记 building 并返回工作目录；已 ready 返回 None（命中）。

        single-flight：同 key 已有在途 build 时抛 DERIVED_BUILD_INFLIGHT
        （调用方等待共享结果而不是重复生成）。持久层以 status=building
        行为凭据；调用方完成 build 后 commit_ready 原子发布。
        """
        import time as _time

        with self._lock:
            holder = self._inflight.get(cache_key)
            if holder is not None:
                raise DerivedCacheError(
                    "DERIVED_BUILD_INFLIGHT", f"build already in flight: {cache_key}")
            self._inflight[cache_key] = _time.monotonic()
        try:
            existing = self.lookup(cache_key, touch=False)
            if existing is not None:
                return None
            root = self._validated_entry_root(cache_key, kind)
            root.mkdir(parents=True, exist_ok=True)
            now = utc_now()
            with self.db.connection() as db:
                # 若存在旧的 building/failed 行（崩溃残留），覆盖为本次构建
                db.execute(
                    "INSERT INTO derived_media_cache(cache_key,asset_fingerprint,kind,"
                    "params_json,schema_version,toolchain_fingerprint,relative_path,"
                    "size_bytes,status,created_at,last_accessed_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(cache_key) DO UPDATE SET status='building', "
                    "created_at=excluded.created_at, last_accessed_at=excluded.last_accessed_at, "
                    "asset_fingerprint=excluded.asset_fingerprint, kind=excluded.kind, "
                    "params_json=excluded.params_json, schema_version=excluded.schema_version, "
                    "toolchain_fingerprint=excluded.toolchain_fingerprint, "
                    "relative_path=excluded.relative_path, size_bytes=excluded.size_bytes",
                    (cache_key, asset_fingerprint, kind, json_dumps(params), 1,
                     toolchain, str(root.relative_to(self.cache_root)), 0,
                     "building", now, now),
                )
            return root
        finally:
            with self._lock:
                self._inflight.pop(cache_key, None)

    def commit_ready(self, cache_key: str, kind: str, final_file: Path) -> Path:
        """临时文件验证后原子 rename 发布；SQL ready 只在文件发布后写入。"""
        root = self._validated_entry_root(cache_key, kind)
        if final_file.parent != root:
            raise DerivedCacheError("CACHE_PATH_UNSAFE", "final file outside entry root")
        target = root / final_file.name
        if final_file != target:
            final_file.replace(target)  # 同目录原子 rename
        size = target.stat().st_size
        relative = target.relative_to(self.cache_root)
        with self.db.connection() as db:
            db.execute(
                "UPDATE derived_media_cache SET status='ready', size_bytes=?, "
                "relative_path=?, last_accessed_at=? WHERE cache_key=?",
                (size, str(relative), utc_now(), cache_key),
            )
        return target

    def mark_failed(self, cache_key: str, kind: str) -> None:
        """失败：清目录内残留临时文件，行标 failed（不删他人 ready 文件）。

        迟到的失败（他进程/迟会话已把同 key 发布为 ready）不得删 ready
        产物或覆盖行状态——先原子认领（building→failed 的条件 UPDATE），
        认领成功者才清目录；single-flight 语义下失败只能由当前持有 build
        的执行者落。
        """
        with self.db.connection() as db:
            claimed = db.execute(
                "UPDATE derived_media_cache SET status='failed', last_accessed_at=? "
                "WHERE cache_key=? AND status='building'",
                (utc_now(), cache_key),
            ).rowcount
        if claimed:
            root = self._validated_entry_root(cache_key, kind)
            shutil.rmtree(root, ignore_errors=True)

    # ---- 启动恢复与清理 ----

    def recover_orphaned_builds(self, *, max_age_s: float = 0.0) -> int:
        """启动恢复：删除无在途认领的 building 残留（半产物不作命中）。

        只处理 building 状态（job 层完成后由 commit/mark_failed 落 ready/
        failed）；调用时机 = CoreState 启动，此时进程内 _inflight 必为空，
        故 max_age_s 默认 0 即全部回收。返回清理条数。
        """
        with self._lock:
            inflight = dict(self._inflight)
        removed = 0
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT cache_key,kind,relative_path FROM derived_media_cache "
                "WHERE status='building'"
            ).fetchall()
        import time as _time

        now = _time.monotonic()
        for row in rows:
            holder = inflight.get(row["cache_key"])
            if holder is not None and now - float(holder) < _PIN_TIMEOUT_S:
                continue  # 在途（同进程）：留给 commit/mark_failed
            try:
                root = self._validated_entry_root(row["cache_key"], row["kind"])
            except DerivedCacheError:
                root = None
            if root is not None and root.exists():
                shutil.rmtree(root, ignore_errors=True)
            with self.db.connection() as db:
                db.execute(
                    "DELETE FROM derived_media_cache WHERE cache_key=? AND status='building'",
                    (row["cache_key"],),
                )
            removed += 1
        return removed

    # ---- pin（运行时 lease） ----

    def pin(self, cache_key: str) -> None:
        import time as _time

        with self._lock:
            self._pins[cache_key] = _time.monotonic()

    def unpin(self, cache_key: str) -> None:
        with self._lock:
            self._pins.pop(cache_key, None)

    def _is_pinned(self, cache_key: str) -> bool:
        import time as _time

        now = _time.monotonic()
        with self._lock:
            held = self._pins.get(cache_key)
        return held is not None and (now - held) < _PIN_TIMEOUT_S

    # ---- 磁盘预算 LRU ----

    def total_ready_bytes(self) -> int:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT COALESCE(SUM(size_bytes),0) FROM derived_media_cache "
                "WHERE status='ready'"
            ).fetchone()
        return int(row[0])

    def enforce_disk_budget(self, *, min_free_bytes: int = MIN_FREE_BYTES,
                            max_reclaim: int = 64) -> dict[str, int]:
        """LRU 清理未 pin 的 ready 条目直到总量 ≤ 预算。

        磁盘可用空间 < min_free_bytes 时同样暂停不清理出的部分并报告
        （调用方提示用户，不静默继续生成）。返回 {removed, reclaimed_bytes}。
        绝不触碰 cache 根之外的任何路径（_validated_entry_root 逐级校验）。
        """
        removed = 0
        reclaimed = 0
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT cache_key,kind,relative_path,size_bytes FROM derived_media_cache "
                "WHERE status='ready' ORDER BY last_accessed_at, cache_key"
            ).fetchall()
        total = self.total_ready_bytes()
        try:
            free = shutil.disk_usage(self.cache_root).free
        except OSError:
            free = min_free_bytes  # 无法读取时保守视为紧张
        for row in rows:
            if total <= self.disk_budget_bytes and free >= min_free_bytes:
                break
            if self._is_pinned(row["cache_key"]):
                continue
            if self._reference_count(row["cache_key"]) > 0 and max_reclaim > 0:
                # 有引用且非极端空间压力：保留（引用仅证明授权，不清活动项）
                continue
            try:
                root = self._validated_entry_root(row["cache_key"], row["kind"])
            except DerivedCacheError:
                continue
            if root.exists():
                shutil.rmtree(root, ignore_errors=True)
            with self.db.connection() as db:
                db.execute("DELETE FROM derived_media_cache WHERE cache_key=?",
                           (row["cache_key"],))
            total -= row["size_bytes"]
            reclaimed += row["size_bytes"]
            removed += 1
            max_reclaim -= 1
            if max_reclaim <= 0:
                break
        return {"removed": removed, "reclaimed_bytes": reclaimed}

    def _reference_count(self, cache_key: str) -> int:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT COUNT(*) FROM derived_media_cache_refs WHERE cache_key=?",
                (cache_key,),
            ).fetchone()
        return int(row[0])
