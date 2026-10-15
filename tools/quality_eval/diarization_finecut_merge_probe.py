"""W2.2 next-step feasibility probe (EXPLORATORY, NOT pre-registered) - the 'fine cut + share merge'
clustering form.

Evidence status (must be read together with any citation):
  - This is NOT a pre-registered experiment. Its readings are NOT evidence that a rule is better;
    the only sanctioned use is: decide what experiment to design next.
  - To decide whether it was worth running, the design stage ALREADY looked at a few AMI and
    VoxConverse readings => neither corpus is blind here; AISHELL-4 was not inspected before this run.
  - No production code is modified; zero migration / zero contract / zero egress; cached embeddings only.

The form under test (two stages, neither sufficient alone):
  1) FINE CUT: among tau on the grid, take the LARGEST cluster count <= Kf.
  2) SHARE MERGE: fold clusters with share < s into the nearest remaining big cluster
     (centroid cosine). If NO cluster reaches s, anchor the largest cluster instead of
     returning the raw cut - without that guard a fixed Kf over-splits short recordings.

Usage:
  python tools/quality_eval/diarization_finecut_merge_probe.py --corpus ami --s 0.10
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'services' / 'core' / 'src'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / 'tools'))

from diarization import load_rttm, score  # noqa: E402
from diarization_cache import EmbeddingCache  # noqa: E402
from diarization_robustness import _windows_for  # noqa: E402
from diarization_single_branch_spike import _A  # noqa: E402

from aivs_core.media import speaker as sp  # noqa: E402

SILERO = '.venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx'
CORPORA = {
    'ami': dict(diag='.tmp/w22-diag-ami-fixed.json',
                rttm='.tmp/ami/AMI-diarization-setup-main/only_words/rttms/test',
                audio_dir='.tmp/ami/audio', ext='.Mix-Headset.wav', channel=None),
    'aishell4': dict(diag='.tmp/w22-diag-cn.json', rttm='.tmp/aishell4/rttm',
                     audio_dir='.tmp/aishell4/audio', ext='.flac', channel=0),
    'vc_lowk': dict(diag='.tmp/w22-diag-vc-test-lowk.json', rttm='.tmp/voxconverse/rttm',
                    audio_dir=None, ext='.wav', channel=None),
}


def _l2(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)


def der_of(wins, labels, total_s, ref, ignore_overlap=True):
    turns = sp.windows_to_turns(wins, labels, total_s, min_turn_s=sp.MIN_TURN_S)
    hyp = [(t['start_us'] / 1e6, t['end_us'] / 1e6, 's%d' % t['speaker']) for t in turns]
    return float(score(ref, hyp, total_s=total_s, ignore_overlap=ignore_overlap).der)


def merge_by_share(labels, vecs, thr):
    """Fold clusters with share < thr into the nearest big cluster (centroid cosine).

    Guard: when NO cluster reaches thr, anchor the largest cluster instead of returning
    the raw cut. The guard is not cosmetic - on short low-K recordings a fixed Kf lands in
    the over-split region and the unguarded version emits K~40 with DER 0.98.
    """
    u, cnt = np.unique(labels, return_counts=True)
    share = cnt / labels.size
    big = [u[i] for i in range(len(u)) if share[i] >= thr]
    if len(big) == len(u):
        return labels
    if not big:
        big = [u[int(np.argmax(cnt))]]
    v = _l2(vecs)
    cent = {c: v[labels == c].mean(axis=0) for c in u}
    cent = {c: (x / np.linalg.norm(x) if np.linalg.norm(x) > 0 else x) for c, x in cent.items()}
    out = labels.copy()
    for c in u:
        if c in big:
            continue
        out[labels == c] = max((float(cent[c] @ cent[b]), b) for b in big)[1]
    return out


def tau_for_kmax(dendro, kf):
    """Fine cut: the LARGEST cluster count <= kf (never looks at ground truth or DER)."""
    best_tau, best_k = None, None
    for tau in sp.TAU_GRID:
        k = int(np.unique(sp.labels_at(dendro, tau)).size)
        if k <= kf and (best_k is None or k > best_k):
            best_k, best_tau = k, float(tau)
    return best_tau


def capk_tau(dendro, vecs, kmax=8):
    """Incumbent form (control): max silhouette within the candidate window [2, kmax]."""
    v = _l2(vecs)
    dmat = 1.0 - v @ v.T
    best_sil, best_tau = -2.0, None
    for tau in sp.TAU_GRID:
        lab = sp.labels_at(dendro, tau)
        k = int(np.unique(lab).size)
        if k < 2 or k > kmax:
            continue
        s = sp.silhouette(dmat, lab)
        if s > best_sil:
            best_sil, best_tau = s, tau
    return best_tau


def load(cfg, cache, condition='silero_vad'):
    diag = json.loads(Path(cfg['diag']).read_text(encoding='utf-8'))['meetings']
    rttm = {p.stem: p for p in Path(cfg['rttm']).rglob('*.rttm')}
    audio = _A(audio_dir=cfg['audio_dir'], channel=cfg['channel'], audio_ext=cfg['ext'],
               silero=SILERO)
    out = {}
    for m in sorted(diag):
        e = diag[m]
        cond = (e.get('conditions') or {}).get(condition)
        if not cond or m not in rttm:
            continue
        key = cond.get('cache_key')
        if not key:
            continue
        ref = load_rttm(rttm[m])
        audio.meeting = m
        wins = _windows_for(e, condition, e['total_s'], ref, audio)
        if wins is None:
            continue
        hit = cache.get(key)
        if hit is None or hit[0].shape[0] != len(wins):
            continue
        out[m] = dict(ref=ref, wins=wins, vecs=hit[0], den=sp.build_dendrogram(hit[0]),
                      total=float(e['total_s']), k_true=int(e['ref_speakers']), nw=len(wins))
    return out


RULES = {
    'base': None,                                                  # incumbent silhouette + k_max=8
    'abs40': lambda n: 40,                                         # absolute fine cut
    'rel1n': lambda n: max(2, min(40, int(round(0.10 * n)))),       # 10% of available windows
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--corpus', default='ami', choices=sorted(CORPORA))
    ap.add_argument('--cache-dir', default='.tmp/w22-embedding-cache')
    ap.add_argument('--condition', default='silero_vad')
    ap.add_argument('--s', type=float, default=0.10, help='minimum cluster share')
    ap.add_argument('--rules', default='base,abs40,rel1n')
    ap.add_argument('--json', default=None)
    args = ap.parse_args()

    cache = EmbeddingCache(args.cache_dir)
    D = load(CORPORA[args.corpus], cache, args.condition)
    if not D:
        print('no meetings loaded', file=sys.stderr)
        return 2
    print('corpus=%s condition=%s n=%d windows=%d..%d' % (
        args.corpus, args.condition, len(D), min(d['nw'] for d in D.values()),
        max(d['nw'] for d in D.values())))

    report = {'corpus': args.corpus, 'condition': args.condition, 'share': args.s, 'rules': {}}
    for tag in args.rules.split(','):
        kf_of = RULES[tag]
        for io in (True, False):
            ders, ks, per = [], [], {}
            for m in sorted(D):
                d = D[m]
                if kf_of is None:
                    lab = sp.labels_at(d['den'], capk_tau(d['den'], d['vecs']))
                else:
                    lab = merge_by_share(
                        sp.labels_at(d['den'], tau_for_kmax(d['den'], kf_of(d['nw']))),
                        d['vecs'], args.s)
                k = int(np.unique(lab).size)
                der = der_of(d['wins'], lab, d['total'], d['ref'], io)
                ders.append(der)
                ks.append(k)
                per[m] = {'der': round(der, 4), 'k': k, 'k_true': d['k_true']}
            mean, worst = float(np.mean(ders)), float(np.max(ders))
            key = '%s|io=%s' % (tag, io)
            report['rules'][key] = {
                'mean': round(mean, 4), 'worst': round(worst, 4),
                'passes_gate_0.40_0.60': bool(mean <= 0.40 and worst <= 0.60),
                'k_dist': {str(k): ks.count(k) for k in sorted(set(ks))},
                'collapse_k_le_true_minus_2': sum(
                    1 for mm, k in zip(sorted(D), ks) if k <= D[mm]['k_true'] - 2),
                'per_meeting': per,
            }
            print('  %-12s mean=%.4f worst=%.4f %s K=%s' % (
                key, mean, worst, 'PASS' if mean <= 0.40 and worst <= 0.60 else '----',
                {k: ks.count(k) for k in sorted(set(ks))[:12]}))
    if args.json == '-':
        print('JSON=' + json.dumps(report, ensure_ascii=False))
    elif args.json:
        Path(args.json).write_text(json.dumps(report, ensure_ascii=False, indent=2),
                                   encoding='utf-8')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
