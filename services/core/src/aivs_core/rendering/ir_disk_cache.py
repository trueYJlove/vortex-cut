"""合成预览 IR 磁盘持久缓存(manifest 投影缓存立项,2026-09-18)。

进程内存缓存(v1 4 条 / v2 2 条)只在 Core 常驻期间有效——app 重启后
Core 新进程,首投影(100 素材级 ≈1.8s)照付。本模块把投影产物持久到
`data_dir/cache/preview-ir/`,冷启动直接装回,收益场景 = 用户重开项目。

键 = manifest_id(content_fingerprint@mode@profile_id,时间线语义/模式/
输出比例天然分区);条目内嵌失效元数据(projector_version + 素材指纹集)。
缓存永远只是加速:任何 OSError/解析失败静默降级为未命中,不成为正确性
依赖。磁盘 LRU 8 条(mtime 最旧淘汰)与内存分池上限对齐。
"""
from __future__ import annotations

import json
import logging
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .ir import IR_PROJECTOR_VERSION

logger = logging.getLogger(__name__)

# v1(4)+v2(2) 分池与内存对齐;单条 1-3MB → 磁盘占用上限 ≈25MB。
MAX_DISK_ENTRIES = 8
CACHE_DIR_NAME = "preview-ir"


class PreviewIrDiskCache:
    def __init__(self, data_dir: Path, max_entries: int = MAX_DISK_ENTRIES) -> None:
        self.root = Path(data_dir) / "cache" / CACHE_DIR_NAME
        self.max_entries = max_entries

    def _path_for(self, manifest_id: str) -> Path:
        return self.root / manifest_id[:2] / f"{_safe_name(manifest_id)}.json"

    def load(self, manifest_id: str, asset_fingerprints: list[str]) -> dict[str, Any] | None:
        """磁盘命中返回条目 payload;未命中/失效/损坏返回 None(读时自愈)。"""
        path = self._path_for(manifest_id)
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            return None
        try:
            entry = json.loads(raw)
            meta = entry["meta"]
            if meta["projector_version"] != IR_PROJECTOR_VERSION:
                self._discard(path)
                return None
            if sorted(meta["asset_fingerprints"]) != sorted(asset_fingerprints):
                self._discard(path)
                return None
            return entry["payload"]
        except (ValueError, KeyError, TypeError):
            self._discard(path)
            return None

    def store(self, manifest_id: str, asset_fingerprints: list[str], payload: dict[str, Any]) -> None:
        entry = {
            "meta": {
                "manifest_id": manifest_id,
                "projector_version": IR_PROJECTOR_VERSION,
                "asset_fingerprints": sorted(asset_fingerprints),
                "created_at": datetime.now(UTC).isoformat(),
            },
            "payload": payload,
        }
        path = self._path_for(manifest_id)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(entry, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, path)
        except OSError:
            logger.debug("preview-ir disk cache write skipped manifest=%s", manifest_id[:24])
            return
        self._evict()

    def _discard(self, path: Path) -> None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    def _evict(self) -> None:
        """>max_entries 时按 mtime 淘汰最旧(OSError 静默)。"""
        try:
            files = [p for p in self.root.rglob("*.json") if p.is_file()]
            if len(files) <= self.max_entries:
                return
            files.sort(key=lambda p: p.stat().st_mtime)
            for path in files[: len(files) - self.max_entries]:
                self._discard(path)
        except OSError:
            return


def asset_fingerprint_list(plan: dict[str, Any]) -> list[str]:
    """失效键的素材指纹集(= 投影消费的 inputs 指纹,排序后稳定)。"""
    return sorted(str(item["fingerprint"]) for item in plan["inputs"])


def _safe_name(manifest_id: str) -> str:
    """manifest_id → 文件名安全串。manifest_id 含 'sha256:' 前缀——冒号在
    Windows 是 NTFS 备用数据流(ADS)分隔符,写盘会静默写入流而非独立文件。
    双向哈希:文件名 = manifest_id 的 sha256(定长、全平台安全、无碰撞风险
    ——键空间本身即 sha256 内容指纹);条目内 meta 保留原 manifest_id 可追溯。"""
    import hashlib

    return hashlib.sha256(manifest_id.encode("utf-8")).hexdigest()
