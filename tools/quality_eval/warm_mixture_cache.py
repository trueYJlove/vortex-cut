r"""并行预热 **混合统计** 缓存（`separation` + `k_raw`），供 (b) spike 使用。

**为什么需要**：`fit_distance_mixture` 实测 **254–307 s/场**（n≈1600 窗）。
它只依赖窗 embedding，与 τ/规则无关 ⇒ **可缓存且可并行**。

**与 v1 的区别**：v1 只存了 `separation`；(b) 的 B1 候选还需要 `k_raw`
（现役连续 K 估计，`speaker.py:406` 的 `round(1/w_same)` 的**前身**）。
故本脚本存完整混合统计。

**语义保证**：使用**同一函数** `sp.fit_distance_mixture`，不变更数值；
并行只改变"谁在何时算"。

**只需要没有归档的语料**：VC test / AMI 的 `k_raw` 已在
`evidence/2026-10-13-w22-j-k-estimator/e0-*.json` 归档，不重算。
"""
from __future__ import annotations

import json
import multiprocessing as mp
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
sys.path.insert(0, str(ROOT / "tools" / "quality_eval"))

CACHE = Path(".tmp/w22-mixture-cache.json")


def _one(args):
    key, vecs_path = args
    import numpy as np
    from aivs_core.media import speaker as sp
    vecs = np.load(vecs_path)["vecs"]
    fit = sp.fit_distance_mixture(sp.pairwise_distances(vecs))
    if not fit.get("ok"):
        return key, None
    return key, {
        "separation": float(fit["separation"]),
        "w_same": float(fit["weight"][0]),
        "weight": [float(x) for x in fit["weight"]],
        "mu": [float(x) for x in fit["mu"]],
        "crossing": float(fit["crossing"]),
    }


def main() -> int:
    import numpy as np
    from diarization_cache import EmbeddingCache

    cache = EmbeddingCache(".tmp/w22-embedding-cache")
    done = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.is_file() else {}

    jobs = []
    tmp = Path(".tmp/mixvec")
    tmp.mkdir(parents=True, exist_ok=True)
    # ⚠️ 必须包含 **全部四语料**：v1 只热了 dev/AISHELL-4（因为只有它们需要 separation），
    # 但 (b) 的 B2 候选还需要 **crossing**，而归档证据里**没有** crossing
    # ⇒ VC test / AMI 也必须热（否则 B2 在主判定语料上无解，判定失效）。
    for d in (".tmp/w22-diag-vc.json", ".tmp/w22-diag-vc-test-lowk.json",
              ".tmp/w22-diag-ami-fixed.json", ".tmp/w22-diag-cn.json"):
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
            print(f"  [{i}/{len(jobs)}] {key[:12]} "
                  f"sep={None if val is None else round(val['separation'],3)} "
                  f"k_raw={None if val is None else round(1.0/max(val['w_same'],1e-6),3)}", flush=True)
    print(f"total cached: {len(done)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
