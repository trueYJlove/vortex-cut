"""决定性检验：K@tau=0.60 是否能**区分** K_true=1 与 K_true>=2？

若它对多人素材也给出 K=1，则该机制是无区分力的退化阈值，我的发现无意义。
用 P136 已落库的 38 场（K_true 1-5）全部重算 K@tau 曲线。

**这一步只做"机制是否有区分力"的检验，不提出任何规则**（提出规则需要未读语料验证，
而 VoxConverse test 已耗尽）。
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "services" / "core" / "src"))

import numpy as np

from aivs_core.database import Database
from aivs_core.media import speaker as sp
from aivs_core.media.speaker_service import decode_embeddings

WORK = REPO / ".tmp" / "_khat_tier"
RES = REPO / "evidence/2026-10-16-w22-khat-tiering-gate/result.json"
TAUS = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]


def main() -> int:
    rows = json.loads(RES.read_text(encoding="utf-8"))
    out = []
    for r in rows:
        m = r["meeting"]
        dbp = WORK / f"_db_{m}.db"
        if not dbp.is_file():
            continue
        db = Database(dbp)
        with db.connection() as con:
            row = con.execute(
                "SELECT embeddings_blob,threshold,windows_json FROM speaker_diarizations "
                "ORDER BY created_at DESC LIMIT 1").fetchone()
        if row is None or row[0] is None:
            continue
        windows = json.loads(row[2] or "[]")
        n = len(windows)
        flat = decode_embeddings(row[0])
        dim = flat.size // n if n else 0
        if dim <= 0:
            continue
        vecs = flat.reshape(n, dim)
        dendro = sp.build_dendrogram(vecs)
        curve = {f"{t:.2f}": int(np.unique(sp.labels_at(dendro, t)).size) for t in TAUS}
        out.append({"meeting": m, "k_true": r["k_true"], "k_hat": r["k_hat"],
                    "der": r["der_T"], "oracle": r["der_oracle"], "curve": curve})

    print(f"n={len(out)} 场（K_true 1-5）\n")
    print(f"{'meeting':<8} {'Kt':>3} {'Khat':>5} {'DER':>7} | " + " ".join(f"{t:>5.2f}" for t in TAUS))
    print("-" * 82)
    for o in sorted(out, key=lambda x: (x["k_true"], -x["der"])):
        cells = " ".join(f"{o['curve'][f'{t:.2f}']:>5}" for t in TAUS)
        print(f"{o['meeting']:<8} {o['k_true']:>3} {o['k_hat']:>5} {o['der']:>7.4f} | {cells}")

    print("\n=== 区分力检验：各 tau 下 K=1 的命中情况 ===")
    print(f"{'tau':>5} | {'Kt=1 中给出K=1':>14} | {'Kt>=2 中给出K=1(假阳)':>20} | {'可用?':>6}")
    for t in TAUS:
        key = f"{t:.2f}"
        single = [o for o in out if o["k_true"] == 1]
        multi = [o for o in out if o["k_true"] >= 2]
        hit = sum(1 for o in single if o["curve"][key] == 1)
        fp = sum(1 for o in multi if o["curve"][key] == 1)
        usable = "✔" if (hit == len(single) and fp == 0) else ("退化" if fp > 0 else "漏检")
        print(f"{t:>5.2f} | {hit:>10}/{len(single):<3} | {fp:>16}/{len(multi):<3} | {usable:>6}")

    (Path(__file__).resolve().parent / "k_at_tau_all.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n落盘 -> k_at_tau_all.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
