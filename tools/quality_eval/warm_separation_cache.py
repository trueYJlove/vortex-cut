r"""并行预热 `separation` 缓存（**只算一次，结果与串行逐值相同**）。

`fit_distance_mixture` 在 n≈1600 窗上约 **290 s/场**（9 起点 × 最多 200 次 EM）。
它只依赖窗 embedding，与 τ / 规则无关，故**天然可缓存**且**可并行** ——
每个进程算一场、写回同一个 JSON（用**逐条合并**避免互相覆盖）。

**语义保证**：使用**同一函数** `sp.fit_distance_mixture`，不改为近似/降精度实现；
并行只改变"谁在何时算"，不改变数值。
"""
from __future__ import annotations

import json
import multiprocessing as mp
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
sys.path.insert(0, str(ROOT / "tools" / "quality_eval"))

CACHE = Path(".tmp/w22-separation-cache.json")


def _one(args) -> tuple[str, float | None]:
    key, vecs_path = args
    import numpy as np
    from aivs_core.media import speaker as sp
    vecs = np.load(vecs_path)["vecs"]
    fit = sp.fit_distance_mixture(sp.pairwise_distances(vecs))
    return key, (float(fit["separation"]) if fit.get("ok") else None)


def main() -> int:
    import numpy as np
    from aivs_core.media import speaker as sp
    from diarization_cache import EmbeddingCache

    cache = EmbeddingCache(".tmp/w22-embedding-cache")
    done = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.is_file() else {}

    jobs = []
    tmp = Path(".tmp/sepvec")
    tmp.mkdir(parents=True, exist_ok=True)
    diags = [".tmp/w22-diag-vc.json", ".tmp/w22-diag-vc-test-lowk.json",
             ".tmp/w22-diag-ami-fixed.json", ".tmp/w22-diag-cn.json"]
    for d in diags:
        p = Path(d)
        if not p.is_file():
            continue
        for m, e in json.loads(p.read_text(encoding="utf-8")).get("meetings", {}).items():
            cond = (e.get("conditions") or {}).get("silero_vad")
            key = cond.get("cache_key") if cond else None
            if not key or key in done:
                continue
            hit = cache.get(key)
            if hit is None:
                continue
            f = tmp / f"{key}.npz"
            if not f.is_file():
                np.savez(f, vecs=hit[0])
            jobs.append((key, str(f)))

    print(f"to compute: {len(jobs)} (already cached: {len(done)})", flush=True)
    if not jobs:
        return 0
    with mp.Pool(processes=8) as pool:
        for i, (key, val) in enumerate(pool.imap_unordered(_one, jobs), 1):
            if val is not None:
                done[key] = val
                CACHE.write_text(json.dumps(done, indent=1), encoding="utf-8")
            print(f"  [{i}/{len(jobs)}] {key[:12]} sep={val}", flush=True)
    print(f"total cached: {len(done)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
