
"""P95b: does dual_delta_us actually predict the estimation error?

AMI arrays are HARDWARE-SYNCED (archived NLCC: lag +0.15 ms) => for far-array pairs the true
offset is ~0, so |coarse+res1| IS the error. That gives a real error label per window, which
lets the 5 ms tolerance be calibrated instead of guessed.

Bypasses the gate: recomputes res1/res2/res_far directly via _fine_residual.
"""
import json, pathlib, subprocess, sys
sys.path.insert(0, 'services/core/src')
import numpy as np
from aivs_core.media import angle_sync as asy

OUT = pathlib.Path('evidence/2026-10-14-w21-p95b-dual-window')
AUDIO = pathlib.Path('.tmp/ami/audio')
FFMPEG = pathlib.Path('resources/ffmpeg/win-x64/ffmpeg.exe')
TRUTH_US = 0.0          # AMI 阵列硬件同步（归档 NLCC 实测滞后 +0.15 ms）

def decode(path, start_s, dur):
    p = subprocess.run([str(FFMPEG), *asy.window_pcm_args(str(path), start_s, dur)],
                       capture_output=True, check=True)
    a = np.frombuffer(p.stdout, dtype='<f4').astype(np.float64)
    if len(a) == 0:
        raise RuntimeError('empty window')
    return a

def raw(ref, mem):
    """recompute the gate inputs without applying the gate"""
    ref_env, mem_env = asy.envelope(ref), asy.envelope(mem)
    cc, cz = asy._xcorr(ref_env, mem_env)
    cp = int(np.argmax(np.abs(cc)))
    coarse_us = -(cp - cz) * asy.ENVELOPE_HOP / asy.SAMPLE_RATE * 1e6
    res1, conf1 = asy._fine_residual(ref, mem, coarse_us, 0.0)
    res2, conf2 = asy._fine_residual(ref, mem, coarse_us, asy.FINE_WINDOW_OFFSET_S)
    resf, conff = asy._fine_residual(ref, mem, coarse_us, asy.DRIFT_WINDOW_SPACING_S)
    return {"coarse_us": coarse_us, "res1": res1, "res2": res2, "res_far": resf,
            "conf1": conf1, "conf2": conf2, "conf_far": conff,
            "dual": abs(res1 - res2), "conf": min(conf1, conf2),
            "offset_us": coarse_us + res1, "error_us": abs(coarse_us + res1 - TRUTH_US)}

have = sorted({p.name.split('.')[0] for p in AUDIO.glob('*.Array1-01.wav')})
rows = []
for m in have:
    if not (AUDIO / f'{m}.Array2-01.wav').exists(): continue
    for s in range(60, 960, 80):
        try:
            ref = decode(AUDIO / f'{m}.Array1-01.wav', s, 30.0)
            mem = decode(AUDIO / f'{m}.Array2-01.wav', s, 30.0)
        except Exception:
            continue
        if len(ref) < 25 * asy.SAMPLE_RATE or len(mem) < 25 * asy.SAMPLE_RATE:
            continue
        r = raw(ref, mem)
        if r["res1"] != r["res1"]:
            continue
        rows.append({"meeting": m, "start": s, **{k: (None if v != v else round(float(v), 1))
                                                  if isinstance(v, float) else v for k, v in r.items()}})
print(f'windows: {len(rows)}')
errs = [r["error_us"] for r in rows]
print(f'|error| distribution: min {min(errs):.0f} p50 {np.median(errs):.0f} max {max(errs):.0f} us')

# --- calibration table: for each tolerance, count accepted-good / accepted-bad
def table(err_tol_us=5000.0):
    print(f"\n=== tolerance calibration (error tolerance {err_tol_us/1000:.0f} ms) ===")
    print(f"{'t_dual(us)':>11} {'accept':>7} {'accept&ok':>10} {'accept&bad':>11} {'reject&ok':>10} {'reject&bad':>11}")
    best = []
    for t in (500, 1000, 2000, 3000, 5000, 8000, 12000, 20000, 50000, 1e9):
        acc = [r for r in rows if r["dual"] <= t]
        rej = [r for r in rows if r["dual"] > t]
        a_ok = [r for r in acc if r["error_us"] <= err_tol_us]
        a_bad = [r for r in acc if r["error_us"] > err_tol_us]
        r_ok = [r for r in rej if r["error_us"] <= err_tol_us]
        r_bad = [r for r in rej if r["error_us"] > err_tol_us]
        print(f"{t:>11.0f} {len(acc):>7} {len(a_ok):>10} {len(a_bad):>11} {len(r_ok):>10} {len(r_bad):>11}")
        best.append((t, len(acc), len(a_bad), len(r_ok)))
    return best

best = table(5000.0)
# how separable are the two populations really?
good = [r["dual"] for r in rows if r["error_us"] <= 5000]
bad = [r["dual"] for r in rows if r["error_us"] > 5000]
print(f"\ngood (|err|<=5ms): n={len(good)} dual p50={np.median(good):.0f} p90={np.percentile(good,90):.0f} max={max(good):.0f}")
print(f"bad  (|err|> 5ms): n={len(bad)} dual p50={np.median(bad):.0f} p10={np.percentile(bad,10):.0f} min={min(bad):.0f}")
allv = [r["dual"] for r in rows]
print(f"ALL: dual p50={np.median(allv):.0f} p90={np.percentile(allv,90):.0f}")
# AUC-like: fraction of (good,bad) pairs where good.dual < bad.dual
import itertools
w = sum(1 for g in good for b in bad if g < b); tot = len(good) * len(bad)
print(f"pairwise AUC(dual: good<bad) = {w/max(tot,1):.3f}  (0.5 = no separation)")
out = {"truth_us": TRUTH_US, "n": len(rows), "rows": rows,
       "error_tol_us": 5000, "good_n": len(good), "bad_n": len(bad),
       "auc_good_lt_bad": round(w / max(tot, 1), 4),
       "good_dual": {"p50": float(np.median(good)), "p90": float(np.percentile(good, 90)), "max": float(max(good))},
       "bad_dual": {"min": float(min(bad)), "p10": float(np.percentile(bad, 10)), "p50": float(np.median(bad))}}
(OUT / 'dual-window-error-calibration.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print('wrote', OUT / 'dual-window-error-calibration.json')
