"""决定性测量（最后一问）：K=2 巨簇内部，真说话人是否可分？

这决定 B 线候选是否值得提：
  - 若巨簇内**真说话人可分**（只有准则选错）⇒ 换准则类候选有意义（§5.10 的"方向反了"）；
  - 若巨簇内**真说话人不可分**（embedding 地板）⇒ 任何准则都修不了，必须动特征/模型。

方法：用 RTTM 真值给每个**窗**打主导说话人标签，看 K=2 巨簇内部这些真标签的分布：
  - 纯度（py, 主导真说话人占比）：接近 1 ⇒ 巨簇确实单一说话人（模型错）；
    显著 < 1 ⇒ 巨簇混了多人（准则错但可分）。
  - 巨簇内真说话人的**可分性**：用真标签算 silhouette（真标签的簇间分离度）。
零生产代码改动（只读 RTTM + 已落库向量）。
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "services" / "core" / "src"))
sys.path.insert(0, str(REPO / "tools" / "quality_eval"))

import numpy as np  # noqa: E402

from aivs_core.database import Database  # noqa: E402
from aivs_core.media import speaker as sp  # noqa: E402
from aivs_core.media.speaker_service import decode_embeddings  # noqa: E402
from diarization import load_rttm  # noqa: E402

PROBE = REPO / ".tmp" / "_share_probe_all"
RTTM_DIR = REPO / ".tmp/ami/AMI-diarization-setup-main/only_words/rttms/test"
S3 = REPO / "evidence/2026-10-14-w22-s3-production-gate/result.json"


def main() -> int:
    s3 = json.loads(S3.read_text(encoding="utf-8"))
    pm = s3["corpora"]["ami"]["per_meeting"]
    targets = [m for m, v in sorted(pm.items()) if v["speaker_count"] <= v["k_true"] - 2]

    hdr = (f"{'meeting':<10} {'nWin':>5} {'dominSpk':>8} {'domShare':>8} {'giant':>7} "
           f"{'purity':>7} {'#spkInGiant':>11}")
    print(hdr)
    print("-" * len(hdr))

    rows = []
    for m in targets:
        dbp = PROBE / f"_db_{m}.db"
        rt = RTTM_DIR / f"{m}.rttm"
        if not dbp.is_file() or not rt.is_file():
            print(f"{m:<10} 缺库或缺 RTTM")
            continue
        db = Database(dbp)
        with db.connection() as con:
            row = con.execute(
                "SELECT embeddings_blob,threshold,windows_json FROM speaker_diarizations "
                "ORDER BY created_at DESC LIMIT 1").fetchone()
        windows = json.loads(row[2] or "[]")
        n_win = len(windows)
        flat = decode_embeddings(row[0])
        dim = flat.size // n_win if n_win else 0
        vecs = flat.reshape(n_win, dim)

        # 真值：每个窗取时长重叠最大的说话人
        ref = load_rttm(rt)
        true_labels = []
        for w in windows:
            ws, we = float(w[0]), float(w[1])
            ov = Counter()
            for seg in ref:
                s, e, spk = float(seg[0]), float(seg[1]), str(seg[2])
                inter = min(we, e) - max(ws, s)
                if inter > 0:
                    ov[spk] += inter
            true_labels.append(ov.most_common(1)[0][0] if ov else "__none__")
        true_labels = np.array(true_labels, dtype=object)

        # K=2 解：巨簇是谁
        dendro = sp.build_dendrogram(vecs)
        lab2 = sp.labels_at(dendro, float(row[1]))
        cnt = Counter(lab2.tolist())
        big = max(cnt, key=cnt.get)
        idx = np.where(lab2 == big)[0]
        dom = cnt[big] / len(lab2)

        # 巨簇内部的真说话人分布
        in_giant = Counter(true_labels[idx].tolist())
        top_spk, top_n = in_giant.most_common(1)[0]
        purity = top_n / len(idx)
        n_spk_in_giant = sum(1 for k, v in in_giant.items()
                             if k != "__none__" and v / len(idx) >= 0.05)

        print(f"{m:<10} {n_win:>5} {str(top_spk):>8} {purity:>8.4f} {dom:>7.4f} "
              f"{purity:>7.4f} {n_spk_in_giant:>11}")
        rows.append({"meeting": m, "n_windows": n_win, "giant_share": round(dom, 4),
                     "giant_purity": round(purity, 4),
                     "speakers_in_giant_ge5pct": n_spk_in_giant,
                     "giant_spk_dist": {str(k): round(v / len(idx), 4)
                                        for k, v in in_giant.most_common()}})

    out = Path(__file__).resolve().parent / "giant_purity.json"
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n落盘 {len(rows)} 行 -> {out}")

    multi = [r for r in rows if r["speakers_in_giant_ge5pct"] >= 2]
    print(f"\n巨簇内（≥5% 占比）含 ≥2 个真说话人的场次: {len(multi)}/{len(rows)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
