r"""ADR-0007 的证据核查：A 路径否决的三条理由是否成立。

**回答三个问题**（对应 ADR-0007 的"发现一/二/三"）：

  发现一：ADR-0006 D2 的理由① ("(a) 类失败不是特征问题") 是否覆盖全部欠账？
  发现二：D2 的理由② 引用的"oracle 已过双门"，其假设空间是否在产品可达域内？
  发现三：**AMI 的最差场门限在 K <= 8（k_max，产品边界）内是否可达？**

**输入分两类（如实标注）**：
  · **纯归档读取**（`baseline-routes-ami.json`、`ceiling-kmeans-separability-ami.json`、
    `lowk-test-report.json`）——任何机器可复算；
  · **需窗 embedding 缓存**（`.tmp/w22-embedding-cache`）——用于**精确控制 K** 重算 K*。
    该缓存是**公开语料的派生数据**，由 `diarization_diagnose.py` 产生（可重建）。

⚠️ 发现三的 K* **不经 τ 网格**：直接按**合并距离**定位每个 K 的 τ 区间中点
⇒ **不受 §5.14 那种"网格太粗"缺陷影响**（这是本核查相对既有读数的方法优势）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
sys.path.insert(0, str(ROOT / "tools" / "quality_eval"))
sys.path.insert(0, str(ROOT / "tools"))

EV = ROOT / "evidence"
AMI_BASE = EV / "2026-10-12-w22-d-planA-recheck/baseline-routes-ami.json"
AMI_CEIL = EV / "2026-10-12-w22-d-planA-recheck/ceiling-kmeans-separability-ami.json"
LOWK = EV / "2026-10-13-w22-g-voxconverse-test-lowk/lowk-test-report.json"


def _load(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def exact_kstar(diag_path, rttm_dir, cache_dir, *, channel=None,
                audio_dir=None, audio_ext=".wav", silero=None, k_range=range(2, 9)):
    """**精确** K* oracle：对候选窗内每个 K 直接定位其 τ，不依赖 τ 网格分辨率。

    对固定 dendrogram，K 簇 ⇔ 恰好合并 n-K 次 ⇒ 其 τ 区间为
    `[merge_dist[n-K-1], merge_dist[n-K])`；取区间中点即保证落在该 K 上。
    """
    from diarization import load_rttm, score
    from diarization_cache import EmbeddingCache
    from diarization_robustness import _windows_for
    from diarization_single_branch_spike import _A

    from aivs_core.media import speaker as sp

    diag = _load(Path(diag_path))["meetings"]
    rttm_of: dict = {}
    for p in Path(rttm_dir).rglob("*.rttm"):
        rttm_of.setdefault(p.stem, p)
    cache = EmbeddingCache(cache_dir)
    out = []
    for m in sorted(diag):
        e = diag[m]
        cond = (e.get("conditions") or {}).get("silero_vad")
        ck = cond.get("cache_key") if cond else None
        if not ck or m not in rttm_of:
            continue
        ref = load_rttm(rttm_of[m])
        a = _A(audio_dir=audio_dir, channel=channel, audio_ext=audio_ext, silero=silero)
        a.meeting = m
        wins = _windows_for(e, "silero_vad", e["total_s"], ref, a)
        if wins is None:
            continue
        hit = cache.get(ck)
        if hit is None or hit[0].shape[0] != len(wins):
            continue
        vecs = hit[0]
        dendro = sp.build_dendrogram(vecs)
        ds = sorted({d for _, _, d in dendro.merges})
        n = dendro.n
        best = None
        for K in k_range:
            idx = n - K
            if idx <= 0 or idx > len(ds):
                continue
            lo = ds[idx - 1] if idx - 1 >= 0 else 0.0
            hi = ds[idx] if idx < len(ds) else 1.0
            tau = (lo + hi) / 2 if hi > lo else lo
            lab = sp.labels_at(dendro, tau)
            if int(np.unique(lab).size) != K:
                continue
            turns = sp.windows_to_turns(wins, lab, e["total_s"], min_turn_s=sp.MIN_TURN_S)
            hyp = [(x["start_us"] / 1e6, x["end_us"] / 1e6, f"spk{x['speaker']}")
                   for x in turns]
            der = float(score(ref, hyp, total_s=e["total_s"], ignore_overlap=True).der)
            if best is None or der < best[1]:
                best = (K, der)
        if best:
            out.append({"meeting": m, "k_true": int(e["ref_speakers"]),
                        "kstar": best[0], "der": round(best[1], 4)})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--silero",
                    default=".venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx")
    ap.add_argument("--skip-recompute", action="store_true",
                    help="只做纯归档读取部分（无需 embedding 缓存）")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    rep: dict = {"inputs": {
        "ami_baseline": str(AMI_BASE.relative_to(ROOT)),
        "ami_ceiling": str(AMI_CEIL.relative_to(ROOT)),
        "vc_lowk": str(LOWK.relative_to(ROOT)),
    }}

    # ---- 发现二：oracle 的假设空间 ----
    base = _load(AMI_BASE)
    ks = [v["strategies"]["oracle"]["n_speakers"] for v in base["meetings"].values()]
    rep["finding2_oracle_hypothesis_space"] = {
        "n": len(ks),
        "k_gt_8": int(sum(1 for k in ks if k > 8)),
        "k_eq_1": int(sum(1 for k in ks if k == 1)),
        "k_within_2_8": int(sum(1 for k in ks if 2 <= k <= 8)),
        "oracle_k_list": sorted(ks),
        "note": "门槛 k_max=8 是产品边界；oracle 多数场在其外 ⇒ "
                "「oracle 过双门」不等于「产品可达域内有余量」",
    }

    # ---- 发现三（归档部分）：三层次对照 ----
    ceil = _load(AMI_CEIL)
    ce = [v["der"] for v in ceil["ceiling"].values()]
    km = [v["kmeans_true_k"] for v in ceil["kmeans"].values()]
    se = [v["overlap"] for v in ceil["separability"].values()]
    st = base["summary"]["strategies"]
    rep["finding3_three_levels_ami"] = {
        "n": len(ce),
        "ceiling_perfect_labels": {"mean": round(float(np.mean(ce)), 4),
                                   "worst": round(float(np.max(ce)), 4)},
        "kmeans_true_k": {"mean": round(float(np.mean(km)), 4),
                          "worst": round(float(np.max(km)), 4)},
        "ahc_silhouette_capk": {"mean": st["silhouette_capK"]["mean_der"],
                                "worst": st["silhouette_capK"]["worst_der"]},
        "ahc_oracle_unrestricted": {"mean": st["oracle"]["mean_der"],
                                    "worst": st["oracle"]["worst_der"]},
        "separability_overlap_mean": round(float(np.mean(se)), 4),
        "gate": {"mean_max": 0.40, "worst_max": 0.60},
    }

    # ---- 发现三（核心）：精确 K* ----
    if not args.skip_recompute:
        ce_ami = exact_kstar(".tmp/w22-diag-ami-fixed.json",
                             ".tmp/ami/AMI-diarization-setup-main/only_words/rttms/test",
                             args.cache_dir)
        d = [r["der"] for r in ce_ami]
        rep["finding3_exact_kstar_ami"] = {
            "n": len(ce_ami),
            "mean": round(float(np.mean(d)), 4), "worst": round(float(np.max(d)), 4),
            "meets_ami_gate": bool(np.mean(d) <= 0.40 and np.max(d) <= 0.60),
            "per_meeting": ce_ami,
            "note": "K 限定在 [2,8]（产品可达域）；不经 τ 网格 ⇒ 不受网格分辨率影响",
        }
        ce_asr = exact_kstar(".tmp/w22-diag-cn.json", ".tmp/aishell4/rttm",
                             args.cache_dir, channel=0, audio_dir=".tmp/aishell4/audio",
                             audio_ext=".flac", silero=args.silero)
        d2 = [r["der"] for r in ce_asr]
        rep["finding3_exact_kstar_aishell4"] = {
            "n": len(ce_asr),
            "mean": round(float(np.mean(d2)), 4), "worst": round(float(np.max(d2)), 4),
            "meets_gate": bool(np.mean(d2) <= 0.40 and np.max(d2) <= 0.55),
            "per_meeting": ce_asr,
        }

    Path(args.out).write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in rep.items() if k != "finding3_exact_kstar_ami"},
                     ensure_ascii=False, indent=1)[:2500])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
