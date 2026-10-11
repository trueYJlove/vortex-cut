"""W2.2 派生 embedding 缓存（S0 ③）—— **生产侧此前无此设施**（复核 F6）。

Design Gate §6 S0 ③ 要求：目录 + 以（**素材指纹，模型 id，算法版本**）为键 +
缓存文件 **sha256** + **复算清单**。

为什么需要：本包已确定瓶颈在 τ 选择（§5）。存下窗 embedding 后，换策略/换 τ
**只重跑聚类、不重跑 ONNX**——实测重跑推理 71–79 s/场，而重聚类 0.3–9.4 s/场。
spike 侧的 `.tmp/strat-cache/*.npz` 是临时物、无键、无校验、无清单；本模块把它
提升为可复现设施。

## 键的构成（内容寻址）

```
key = sha256(canonical_json({asset_fingerprint, model_id, algorithm_version, params}))
```

- **不含绝对路径**（换机器/换目录不失效）。
- `params` 纳入窗长/跳长/前端口径 ⇒ 改参数必然换键，不会静默复用旧向量。
- `algorithm_version` 由调用方给（窗选取/前端变更时递增）。

## 校验

每个条目落 `.npz`（向量）+ `.json`（meta：sha256、shape、dtype、模型、指纹）。
**读时校验 sha256**，不符即视为未命中（并保留残件供诊断，不静默返回脏数据）。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

SCHEMA_VERSION = 1
DEFAULT_ALGORITHM_VERSION = 1


def _canonical(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def embedding_cache_key(
    asset_fingerprint: str,
    model_id: str,
    algorithm_version: int = DEFAULT_ALGORITHM_VERSION,
    params: dict[str, Any] | None = None,
) -> str:
    """内容寻址键。`params` 参与哈希 ⇒ 改窗长/跳长即换键。"""
    payload = {
        "asset_fingerprint": asset_fingerprint,
        "model_id": model_id,
        "algorithm_version": int(algorithm_version),
        "params": params or {},
        "schema_version": SCHEMA_VERSION,
    }
    return hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


@dataclass(frozen=True)
class CacheEntry:
    key: str
    npz_path: Path
    meta_path: Path
    meta: dict[str, Any]


class EmbeddingCache:
    """窗 embedding 的内容寻址缓存。**不触碰 cache 根之外的任何路径**。"""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    # ---- 布局 ----
    def entry_dir(self, key: str) -> Path:
        return self.root / key[:2] / key

    def npz_path(self, key: str) -> Path:
        return self.entry_dir(key) / "embeddings.npz"

    def meta_path(self, key: str) -> Path:
        return self.entry_dir(key) / "meta.json"

    # ---- 读 ----
    def get(self, key: str) -> tuple[np.ndarray, dict[str, Any]] | None:
        """命中返回 (vecs, meta)；**sha256 不符视为未命中**（不返回脏数据）。"""
        npz, meta_p = self.npz_path(key), self.meta_path(key)
        if not (npz.is_file() and meta_p.is_file()):
            return None
        try:
            meta = json.loads(meta_p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if meta.get("sha256") != _sha256_file(npz):
            return None
        with np.load(npz) as data:
            vecs = np.asarray(data["vecs"])
        if list(vecs.shape) != meta.get("shape"):
            return None
        return vecs, meta

    def get_or_compute(
        self,
        key: str,
        compute,
        *,
        asset_fingerprint: str,
        model_id: str,
        algorithm_version: int = DEFAULT_ALGORITHM_VERSION,
        params: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, bool]:
        """命中则返回缓存，否则调用 `compute()` 并落盘。返回 (vecs, was_cached)。"""
        hit = self.get(key)
        if hit is not None:
            return hit[0], True
        vecs = np.asarray(compute())
        self.put(
            key,
            vecs,
            asset_fingerprint=asset_fingerprint,
            model_id=model_id,
            algorithm_version=algorithm_version,
            params=params,
        )
        return vecs, False

    # ---- 写（原子发布） ----
    def put(
        self,
        key: str,
        vecs: np.ndarray,
        *,
        asset_fingerprint: str,
        model_id: str,
        algorithm_version: int = DEFAULT_ALGORITHM_VERSION,
        params: dict[str, Any] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> CacheEntry:
        vecs = np.asarray(vecs)
        d = self.entry_dir(key)
        d.mkdir(parents=True, exist_ok=True)
        npz, meta_p = self.npz_path(key), self.meta_path(key)
        # **坑**：np.savez_compressed 在文件名不以 .npz 结尾时会**自行追加 .npz**，
        # 于是 tmp 名与实际落盘名不一致、rename 必失败。故 tmp 名也以 .npz 结尾。
        tmp = npz.with_name(npz.name + ".tmp.npz")
        np.savez_compressed(tmp, vecs=vecs)
        tmp.replace(npz)  # 同目录原子 rename
        meta: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "key": key,
            "asset_fingerprint": asset_fingerprint,
            "model_id": model_id,
            "algorithm_version": int(algorithm_version),
            "params": params or {},
            "shape": list(vecs.shape),
            "dtype": str(vecs.dtype),
            "sha256": _sha256_file(npz),
            "size_bytes": npz.stat().st_size,
        }
        if extra:
            meta.update(extra)
        tmp_meta = meta_p.with_suffix(".json.tmp")
        tmp_meta.write_text(
            json.dumps(meta, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8"
        )
        tmp_meta.replace(meta_p)
        return CacheEntry(key, npz, meta_p, meta)

    # ---- 复算清单 ----
    def manifest(self) -> list[dict[str, Any]]:
        """列出全部条目（按 key 排序）。`verified` 为逐条 sha256 复算结果。

        **这是 S0 要求的"复算清单"**：任何一条 `verified=False` 都说明缓存
        被外部改动或损坏，必须重算而不是使用。
        """
        out: list[dict[str, Any]] = []
        if not self.root.is_dir():
            return out
        for meta_p in sorted(self.root.glob("*/*/meta.json")):
            key = meta_p.parent.name
            try:
                meta = json.loads(meta_p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                out.append({"key": key, "verified": False, "error": "unreadable meta"})
                continue
            npz = meta_p.parent / "embeddings.npz"
            ok = npz.is_file() and meta.get("sha256") == _sha256_file(npz)
            out.append({
                "key": key,
                "verified": bool(ok),
                "asset_fingerprint": meta.get("asset_fingerprint"),
                "model_id": meta.get("model_id"),
                "algorithm_version": meta.get("algorithm_version"),
                "shape": meta.get("shape"),
                "sha256": meta.get("sha256"),
                "size_bytes": meta.get("size_bytes"),
            })
        return out

    def write_manifest(self, path: str | Path) -> dict[str, Any]:
        entries = self.manifest()
        payload = {
            "schema_version": SCHEMA_VERSION,
            "root": self.root.as_posix(),
            "entries": entries,
            "total": len(entries),
            "verified": sum(1 for e in entries if e.get("verified")),
            "unverified": sum(1 for e in entries if not e.get("verified")),
        }
        Path(path).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return payload


def file_fingerprint(path: str | Path, *, chunk: int = 1 << 20) -> str:
    """素材指纹 = 文件内容的 sha256（与派生缓存键同源，不含路径）。"""
    return _sha256_file(Path(path))
