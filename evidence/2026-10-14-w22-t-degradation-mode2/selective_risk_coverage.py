
"""Mode-2 (selective delivery) decisive check: PER-MEETING selective DER at a fixed coverage.

The gate's binding constraint is the WORST MEETING, not the pooled mean. So for each meeting:
  keep the highest-margin frames until target coverage is reached, then compute DER on kept frames.
Also reports: coverage actually achieved, and what a uniform confidence threshold gives.
"""
import json, pathlib, sys, statistics as st, itertools
sys.path.insert(0, 'tools/quality_eval'); sys.path.insert(0, 'services/core/src')
import numpy as np
from diarization import load_rttm, _max_weight_matching
from diarization_cache import EmbeddingCache
from diarization_robustness import _windows_for
from diarization_single_branch_spike import _A
from aivs_core.media import speaker as sp

cache = EmbeddingCache('.tmp/w22-embedding-cache')
SILERO = '.venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx'
FRAME, COLLAR = 0.01, 0.25

def l2(v):
    v = np.asarray(v, float); return v/np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)
def capk_tau(den, vecs, kmax=8):
    v = l2(vecs); dmat = 1.0 - v @ v.T
    bs, bt = -2.0, None
    for tau in sp.TAU_GRID:
        lab = sp.labels_at(den, tau); k = int(np.unique(lab).size)
        if k < 2 or k > kmax: continue
        s = sp.silhouette(dmat, lab)
        if s > bs: bs, bt = s, tau
    return bt
def margins(vecs, lab):
    v = l2(vecs); u = np.unique(lab)
    cent = {c: v[lab == c].mean(axis=0) for c in u}
    cent = {c: (x/np.linalg.norm(x) if np.linalg.norm(x) > 0 else x) for c, x in cent.items()}
    D = np.stack([1.0 - v @ cent[c] for c in u], axis=1)
    o = np.argsort(D, axis=1)
    d1 = D[np.arange(len(lab)), o[:, 0]]
    d2 = D[np.arange(len(lab)), o[:, 1]] if len(u) > 1 else d1
    return d2 - d1
def frames(ref, hyp, total):
    n = int(round(total/FRAME))
    cnt = np.zeros(n, np.int32); rown = np.full(n, -1, np.int32)
    rid = {s: i for i, s in enumerate(sorted({t[2] for t in ref}))}
    for a, b, s in ref:
        i0, i1 = max(0, int(round(a/FRAME))), min(n, int(round(b/FRAME))); cnt[i0:i1] += 1; rown[i0:i1] = rid[s]
    hid = {s: i for i, s in enumerate(sorted({t[2] for t in hyp}))}
    hown = np.full(n, -1, np.int32)
    for a, b, s in hyp:
        i0, i1 = max(0, int(round(a/FRAME))), min(n, int(round(b/FRAME))); hown[i0:i1] = hid[s]
    collar = np.zeros(n, bool); half = int(round(COLLAR/FRAME))
    for a, b, _s in ref:
        for bd in (a, b):
            c = int(round(bd/FRAME)); collar[max(0,c-half):min(n,c+half+1)] = True
    return cnt, rown, hown, collar
def sel_der(ref, hyp, total, keep):
    n = int(round(total/FRAME)); cnt, rown, hown, collar = frames(ref, hyp, total)
    scored = (cnt == 1) & ~collar & keep
    ns = int(scored.sum())
    if ns == 0: return None, 0, 0
    nr = int(rown.max())+1 if rown.max() >= 0 else 0
    nh = int(hown.max())+1 if hown.max() >= 0 else 0
    cont = np.zeros((max(nr,1), max(nh,1)), np.int64)
    both = scored & (rown >= 0) & (hown >= 0)
    if both.any(): np.add.at(cont, (rown[both], hown[both]), 1)
    best = 0
    if nr and nh:
        if nr <= nh:
            rows_, cols_ = _max_weight_matching(cont.astype(np.float64))
            best = int(sum(cont[r, c] for r, c in zip(rows_, cols_)))
        else:
            rows_, cols_ = _max_weight_matching(cont.T.astype(np.float64))
            # cont.T => rows_ index hyp, cols_ index ref ; index cont as [ref, hyp]
            best = int(sum(cont[c, r] for r, c in zip(rows_, cols_)))
    miss = int(((hown == -1) & scored).sum())
    fa = int(((hown != -1) & (cnt == 0) & ~collar & keep).sum())
    scored_all = int(((cnt == 1) & ~collar).sum())
    return (miss + (ns - miss - best) + fa)/ns, ns, scored_all

def build(diag_p, rttm_p, audio_dir, ext, ch=None):
    diag = json.loads(pathlib.Path(diag_p).read_text(encoding='utf-8'))['meetings']
    rt = {p.stem: p for p in pathlib.Path(rttm_p).rglob('*.rttm')}
    a = _A(audio_dir=audio_dir, channel=ch, audio_ext=ext, silero=SILERO)
    out = {}
    for m in sorted(diag):
        e = diag[m]; c = (e.get('conditions') or {}).get('silero_vad')
        if not c: continue
        key = c.get('cache_key')
        if not key or m not in rt: continue
        ref = load_rttm(rt[m]); a.meeting = m
        wins = _windows_for(e, 'silero_vad', e['total_s'], ref, a)
        if wins is None: continue
        hit = cache.get(key)
        if hit is None or hit[0].shape[0] != len(wins): continue
        out[m] = dict(ref=ref, wins=wins, vecs=hit[0], den=sp.build_dendrogram(hit[0]),
                      total=float(e['total_s']), k_true=int(e['ref_speakers']))
    return out

for target in (0.7, 0.5):
    print(f'\n########## target coverage = {target:.0%} ##########')
    for cname, args in (('ami', ('.tmp/w22-diag-ami-fixed.json', '.tmp/ami/AMI-diarization-setup-main/only_words/rttms/test', '.tmp/ami/audio', '.Mix-Headset.wav', None)),
                        ('aishell4', ('.tmp/w22-diag-cn.json', '.tmp/aishell4/rttm', '.tmp/aishell4/audio', '.flac', 0))):
        D = build(*args)
        rows = []
        for m in sorted(D):
            d = D[m]
            lab = sp.labels_at(d['den'], capk_tau(d['den'], d['vecs']))
            mg = margins(d['vecs'], lab)
            hyp = [(t['start_us']/1e6, t['end_us']/1e6, 's%d' % t['speaker'])
                   for t in sp.windows_to_turns(d['wins'], lab, d['total'], min_turn_s=sp.MIN_TURN_S)]
            n = int(round(d['total']/FRAME))
            fr = np.full(n, -1.0)
            for (a2, b2), mv in zip(d['wins'], mg):
                i0, i1 = max(0, int(round(a2/FRAME))), min(n, int(round(b2/FRAME)))
                if i1 > i0: fr[i0:i1] = np.maximum(fr[i0:i1], mv)
            # threshold on WINDOW margins such that ~target of SCORED frames are kept
            cnt, rown, hown, collar = frames(d['ref'], hyp, d['total'])
            scoredmask = (cnt == 1) & ~collar
            vals = fr[scoredmask]
            if vals.size == 0:
                rows.append((m, None, 0.0, d['k_true'], int(np.unique(lab).size))); continue
            thr = np.quantile(vals, 1 - target) if target < 1 else -1e9
            keep = fr >= thr
            der, ns, nall = sel_der(d['ref'], hyp, d['total'], keep)
            cov = ns / max(nall, 1)
            rows.append((m, der, cov, d['k_true'], int(np.unique(lab).size)))
        vals = [r[1] for r in rows if r[1] is not None]
        covs = [r[2] for r in rows]
        print(f'\n--- {cname} ({len(rows)} meetings) ---')
        print(f'  selective DER: mean={st.mean(vals):.4f} worst={max(vals):.4f}  (target cov {target:.0%})')
        print(f'  achieved coverage: min={min(covs):.3f} p50={st.median(covs):.3f} max={max(covs):.3f}')
        print('  worst 5 meetings:')
        for m, der, cov, kt, k in sorted([r for r in rows if r[1] is not None], key=lambda x: -x[1])[:5]:
            print(f'    {m:<16} selDER={der:.4f} cov={cov:.3f} K={k}/{kt}')
