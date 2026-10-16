"""前置实验：K̂=2 解的巨簇内部，真说话人是否可分？

**判据已冻结**：见本目录 `PRE_REGISTRATION.md`（看数之前写定）。
主判据 S1（巨簇内 ARI 中位 ≥0.50）、S2（DER 中位改善 ≥0.10）、S3（打乱标签 ARI ≤0.05）。
若 S1 ❌ ⇒ **整条 B 线（改准则方向）否决**，候选 A/B/C 不得登记。

用生产 probe 库里的真实 CAM++ 窗向量 + RTTM 真值；聚类用对照实现 kmeans_cosine。
零生产代码改动（只读 + 调用纯函数）。
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
from diarization import load_rttm, score  # noqa: E402
from diarization_cluster_routes import kmeans_cosine  # noqa: E402

PROBE = REPO / ".tmp" / "_share_probe_all"
RTTM_DIR = REPO / ".tmp/ami/AMI-diarization-setup-main/only_words/rttms/test"
DIAG = REPO / ".tmp/w22-diag-ami.json"
S3 = REPO / "evidence/2026-10-14-w22-s3-production-gate/result.json"
SEEDS = (0, 1, 2, 3, 4)
DEFAULT_SEED = 0


def ari(a: np.ndarray, b: np.ndarray) -> float:
    """调整兰德指数（无 sklearn ⇒ 自实现；已做机会校正）。"""
    a = np.asarray(a)
    b = np.asarray(b)
    _, ai = np.unique(a, return_inverse=True)
    _, bi = np.unique(b, return_inverse=True)
    cont = np.zeros((ai.max() + 1, bi.max() + 1), dtype=np.int64)
    np.add.at(cont, (ai, bi), 1)
    comb2 = lambda x: x * (x - 1) / 2.0  # noqa: E731
    sum_ij = comb2(cont).sum()
    sum_i = comb2(cont.sum(axis=1)).sum()
    sum_j = comb2(cont.sum(axis=0)).sum()
    n = a.size
    total = comb2(n)
    expected = sum_i * sum_j / total if total > 0 else 0.0
    maximum = (sum_i + sum_j) / 2.0
    return float((sum_ij - expected) / (maximum - expected)) if maximum != expected else 0.0


def windows_from_blob(dbp: Path) -> tuple[np.ndarray, list, float] | None:
    db = Database(dbp)
    with db.connection() as con:
        row = con.execute(
            "SELECT embeddings_blob,threshold,windows_json FROM speaker_diarizations "
            "ORDER BY created_at DESC LIMIT 1").fetchone()
    if row is None or row[0] is None:
        return None
    windows = json.loads(row[2] or "[]")
    n = len(windows)
    flat = decode_embeddings(row[0])
    dim = flat.size // n if n else 0
    if dim <= 0:
        return None
    return flat.reshape(n, dim), windows, float(row[1])


def dominant_labels(windows: list, ref: list) -> np.ndarray:
    """每窗取重叠时长最大的真说话人（与 giant_purity 同口径）。"""
    out = []
    for w in windows:
        ws, we = float(w[0]), float(w[1])
        ov: Counter = Counter()
        for s, e, spk in ref:
            inter = min(we, e) - max(ws, s)
            if inter > 0:
                ov[str(spk)] += inter
        out.append(ov.most_common(1)[0][0] if ov else "__none__")
    return np.array(out, dtype=object)


def _n_ref_speakers(w, ref: list) -> int:
    """该窗内**真说话人个数**（>1 即"重叠窗"，用于 §2.2 的排除版读数）。"""
    ws, we = float(w[0]), float(w[1])
    n = 0
    for s, e, _spk in ref:
        if min(we, e) - max(ws, s) > 0:
            n += 1
    return n


def turns_of(windows: list, labels, total_s: float) -> list[tuple[float, float, str]]:
    return [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"s{t['speaker']}")
            for t in sp.windows_to_turns(np.asarray(windows, dtype=float), labels, total_s)]


def main() -> int:
    s3 = json.loads(S3.read_text(encoding="utf-8"))
    pm = s3["corpora"]["ami"]["per_meeting"]
    targets = [m for m, v in sorted(pm.items()) if v["speaker_count"] <= v["k_true"] - 2]
    diag = json.loads(DIAG.read_text(encoding="utf-8"))["meetings"]

    rows = []
    for m in targets:
        dbp = PROBE / f"_db_{m}.db"
        rt = RTTM_DIR / f"{m}.rttm"
        if not dbp.is_file() or not rt.is_file() or m not in diag:
            print(f"{m}: 缺输入，跳过")
            continue
        loaded = windows_from_blob(dbp)
        if loaded is None:
            print(f"{m}: 无 blob，跳过")
            continue
        vecs, windows, tau = loaded
        total_s = float(diag[m]["total_s"])
        ref = load_rttm(rt)
        true_all = dominant_labels(windows, ref)

        # 现行解 = K̂=2，取巨簇
        dendro = sp.build_dendrogram(vecs)
        lab2 = sp.labels_at(dendro, tau)
        cnt = Counter(lab2.tolist())
        big = max(cnt, key=cnt.get)
        idx = np.where(lab2 == big)[0]
        sub = vecs[idx]
        true_sub = true_all[idx]
        k_giant = len({t for t in true_sub.tolist() if t != "__none__"})

        # 现行 DER（含重叠口径，与门 §5 一致）
        hyp_now = turns_of(windows, lab2, total_s)
        der_now = score(ref, hyp_now, total_s=total_s, ignore_overlap=True).der

        # --- 主判据 S1：只给定簇数 K，无监督聚类能否恢复真标签 ---
        if k_giant < 2 or sub.shape[0] < k_giant:
            print(f"{m}: 巨簇内真标签数={k_giant}，不可测 S1（记 None）")
            continue
        aris = []
        for sd in SEEDS:
            lab_sub, _ = kmeans_cosine(sub, k_giant, seed=sd)
            aris.append(ari(lab_sub, true_sub))
        ari_med = float(np.median(aris))

        # --- S3 反平凡性：打乱真标签 ---
        rng = np.random.default_rng(DEFAULT_SEED)
        shuffled = true_sub.copy()
        rng.shuffle(shuffled)
        lab_sh, _ = kmeans_cosine(sub, k_giant, seed=DEFAULT_SEED)
        ari_shuf = ari(lab_sh, shuffled)

        # --- S2：把巨簇按聚类拆开后的 DER ---
        lab_sub0, _ = kmeans_cosine(sub, k_giant, seed=DEFAULT_SEED)
        hyp_split = lab2.copy()
        # 巨簇内的窗按聚类结果重新编号（接到现有标签之后）
        base = int(max(lab2)) + 1
        hyp_split[idx] = lab_sub0 + base
        der_split = score(ref, turns_of(windows, hyp_split, total_s),
                          total_s=total_s, ignore_overlap=True).der

        # --- 预登记 §2.2 要求：**排除重叠窗**的 ARI（只作参考，不替换主判据）---
        clean_mask = np.array([_n_ref_speakers(w, ref) == 1 for w in windows])
        sub_clean_mask = clean_mask[idx]
        ari_clean = None
        if sub_clean_mask.sum() >= k_giant:
            sub_c = sub[sub_clean_mask]
            true_c = true_sub[sub_clean_mask]
            k_c = len({t for t in true_c.tolist() if t != "__none__"})
            if k_c >= 2:
                lab_c, _ = kmeans_cosine(sub_c, k_c, seed=DEFAULT_SEED)
                ari_clean = float(ari(lab_c, true_c))

        # --- 对照：oracle 天花板（每窗直给主导真说话人）---
        oracle_map = {s: i for i, s in enumerate(sorted({t for t in true_all.tolist()}))}
        lab_oracle = np.array([oracle_map[t] for t in true_all.tolist()], dtype=int)
        der_oracle = score(ref, turns_of(windows, lab_oracle, total_s),
                           total_s=total_s, ignore_overlap=True).der

        # --- 对照：随机分配下界（巨簇内随机切 k_giant 份）---
        lab_rand = lab2.copy()
        rr = np.random.default_rng(DEFAULT_SEED)
        lab_rand[idx] = rr.integers(0, k_giant, size=idx.size) + base
        der_rand = score(ref, turns_of(windows, lab_rand, total_s),
                         total_s=total_s, ignore_overlap=True).der

        # --- NC2：K=1（不拆巨簇）---
        der_k1 = der_now

        print(f"{m:<10} nWin={len(windows):>5} giant={idx.size:>5} K_giant={k_giant} "
              f"ARI={ari_med:>6.3f} ARI_shuf={ari_shuf:>6.3f} "
              f"ARI_cleanOnly={'-' if ari_clean is None else format(ari_clean, '.3f')} "
              f"DER_now={der_now:.4f} DER_split={der_split:.4f} "
              f"DER_oracle={der_oracle:.4f} DER_rand={der_rand:.4f} DER_K1={der_k1:.4f}",
              flush=True)
        rows.append({"meeting": m, "n_windows": len(windows), "giant_windows": int(idx.size),
                     "k_giant": k_giant, "ari_median": round(ari_med, 4),
                     "ari_seeds": [round(a, 4) for a in aris],
                     "ari_clean_windows_only": None if ari_clean is None else round(ari_clean, 4),
                     "ari_shuffled": round(ari_shuf, 4),
                     "der_current": round(der_now, 4), "der_split": round(der_split, 4),
                     "der_oracle": round(der_oracle, 4), "der_random": round(der_rand, 4),
                     "der_k1": round(der_k1, 4)})

    out = Path(__file__).resolve().parent / "result.json"
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    if not rows:
        print("\n无有效读数")
        return 1

    ari_med = float(np.median([r["ari_median"] for r in rows]))
    imp = float(np.median([r["der_current"] - r["der_split"] for r in rows]))
    shuf_max = max(r["ari_shuffled"] for r in rows)
    clean = [r["ari_clean_windows_only"] for r in rows
             if r["ari_clean_windows_only"] is not None]
    print(f"\n  [参考] 仅非重叠窗的 ARI 中位 = "
          f"{np.median(clean):.4f} (n={len(clean)} 场, 不替换主判据)" if clean else "")
    # 边界敏感性：S1 恰好卡在门槛附近时必须显式报距离
    print(f"  S1 距门槛 = {ari_med - 0.50:+.4f}")

    print(f"\n=== 判据（n={len(rows)} 场）===")
    print(f"  S1 巨簇内 ARI 中位 = {ari_med:.4f}  (门槛 >=0.50) -> "
          f"{'PASS' if ari_med >= 0.50 else 'FAIL'}")
    print(f"  S2 DER 中位改善   = {imp:.4f}  (门槛 >=0.10) -> "
          f"{'PASS' if imp >= 0.10 else 'FAIL'}")
    print(f"  S3 打乱后 ARI 最大 = {shuf_max:.4f}  (门槛 <=0.05) -> "
          f"{'PASS' if shuf_max <= 0.05 else 'FAIL'}")
    verdict = "可分且可变现" if (ari_med >= 0.5 and imp >= 0.1) else (
        "可分但不可变现" if ari_med >= 0.5 else "不可分 => B 线（改准则方向）否决")
    print(f"\n  判定（按预登记 §2.3 规则）= {verdict}")
    print(f"\n落盘 -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
