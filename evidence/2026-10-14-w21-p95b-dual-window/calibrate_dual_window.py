
"""P95b calibration (CORRECTED decode): dual-window tolerance on real multi-device audio.

Harness note (recorded honestly): the first version appended extra output args after
window_pcm_args(), which already ends with '-f f32le pipe:1' -> ffmpeg made TWO outputs and
stdout carried mixed streams. The archived case now reproduces bit-for-bit.
"""
import json, pathlib, statistics as st, subprocess, sys
sys.path.insert(0, 'services/core/src')
import numpy as np
from aivs_core.media import angle_sync as asy

OUT = pathlib.Path('evidence/2026-10-14-w21-p95b-dual-window')
OUT.mkdir(parents=True, exist_ok=True)
AUDIO = pathlib.Path('.tmp/ami/audio')
FFMPEG = pathlib.Path('resources/ffmpeg/win-x64/ffmpeg.exe')

def decode(path, start_s, duration_s):
    p = subprocess.run([str(FFMPEG), *asy.window_pcm_args(str(path), start_s, duration_s)],
                       capture_output=True, check=True)
    a = np.frombuffer(p.stdout, dtype='<f4').astype(np.float64)
    want = int(duration_s * asy.SAMPLE_RATE)
    if len(a) == 0:
        raise RuntimeError('empty window (past end of file?)')
    assert abs(len(a) - want) <= asy.SAMPLE_RATE, f'decode length {len(a)} != {want}'
    return a

def pair(pa, pb, s, dur=30.0):
    return asy.measure_offset(decode(AUDIO / pa, s, dur), decode(AUDIO / pb, s, dur))

def sweep(name, pa, pb, starts, note, expect):
    rows = []
    for s in starts:
        try:
            r = pair(pa, pb, s)
        except Exception as exc:
            print(f'{name:22s} start={s} SKIP ({str(exc)[:60]})', flush=True); continue
        rows.append({"start": s, "status": r["status"], "reason": r["reason"],
                     "confidence": round(float(r["confidence"]), 4),
                     "dual_delta_us": None if r["dual_delta_us"] is None else round(float(r["dual_delta_us"]), 1),
                     "offset_us": r["offset_us"]})
    got = [r["dual_delta_us"] for r in rows if r["dual_delta_us"] is not None]
    conf = [r["confidence"] for r in rows]
    ready = sum(1 for r in rows if r["status"] == "ready")
    extra = json.dumps({k: v for k, v in (rows[0] or {}).items() if k in ("status",)})
    summ = {"note": note, "expect": expect, "n": len(rows), "ready": ready,
            "dual_min": min(got) if got else None, "dual_p50": st.median(got) if got else None,
            "dual_max": max(got) if got else None,
            "conf_min": min(conf), "conf_p50": st.median(conf), "conf_max": max(conf),
            "rows": rows}
    print(f"{name:22s} ready {ready:2d}/{len(rows)}  dual min/p50/max = "
          f"{summ['dual_min']}/{summ['dual_p50']}/{summ['dual_max']}  conf {summ['conf_min']:.3f}..{summ['conf_max']:.3f}", flush=True)
    return summ

starts = list(range(60, 960, 80))
have = sorted({p.name.split('.')[0] for p in AUDIO.glob('*.Array1-01.wav')})
print('meetings with both arrays:', have)
res = {"harness_note": "decode via window_pcm_args only (first version double-specified output -> invalid)",
       "starts": starts, "groups": {}}
for m in have:
    if not (AUDIO / f'{m}.Array2-01.wav').exists(): continue
    res["groups"][f'{m}/far-arrays'] = sweep(f'{m} far', f'{m}.Array1-01.wav', f'{m}.Array2-01.wav', starts,
                                             '不同阵列（≈两机位，硬件同步）', 'accept')
    if (AUDIO / f'{m}.Array1-02.wav').exists():
        res["groups"][f'{m}/same-near'] = sweep(f'{m} near', f'{m}.Array1-01.wav', f'{m}.Array1-02.wav', starts,
                                                '同阵列相邻单元', 'accept')
# NEGATIVES ------------------------------------------------------------------
# (a) cross-meeting: different meeting audio -> no common source
if len(have) >= 2:
    res["groups"]['NEG/cross-meeting'] = sweep('cross-meeting', f'{have[0]}.Array1-01.wav',
                                               f'{have[1]}.Array1-01.wav', [60, 140, 220, 300],
                                               '跨会议无关（伪峰）', 'reject')
# (b) mix-headset vs array (different device type, same scene) -- boundary group
if (AUDIO / f'{have[0]}.Mix-Headset.wav').exists():
    res["groups"]['BOUND/diff-device'] = sweep('headset-vs-array', f'{have[0]}.Mix-Headset.wav',
                                               f'{have[0]}.Array1-01.wav', [60, 140, 220, 300],
                                               '头戴混合 vs 阵列（边界）', 'boundary')
# (c) SAME DEVICE, but member window artificially displaced by 6 s -> real signal, wrong alignment
def pair_shift(pa, pb, s, shift_s, dur=30.0):
    return asy.measure_offset(decode(AUDIO / pa, s, dur), decode(AUDIO / pb, s + shift_s, dur))
rows = []
for s in [60, 140, 220, 300]:
    r = pair_shift(f'{have[0]}.Array1-01.wav', f'{have[0]}.Array2-01.wav', s, 6.0)
    rows.append({"start": s, "shift_s": 6.0, "status": r["status"], "reason": r["reason"],
                 "confidence": round(float(r["confidence"]), 4),
                 "dual_delta_us": None if r["dual_delta_us"] is None else round(float(r["dual_delta_us"]), 1),
                 "offset_us": r["offset_us"]})
got = [x["dual_delta_us"] for x in rows if x["dual_delta_us"] is not None]
print(f"{'NEG/6s-displaced':22s} ready {sum(1 for x in rows if x['status']=='ready'):2d}/{len(rows)}  dual = {got}", flush=True)
res["groups"]['NEG/6s-displaced'] = {"note": '真实信号 + 错误对齐（成员窗右移 6 s）', "expect": 'reject',
                                     "n": len(rows), "rows": rows,
                                     "dual_min": min(got) if got else None,
                                     "dual_max": max(got) if got else None}
(OUT / 'dual-window-calibration.json').write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding='utf-8')
print('wrote', OUT / 'dual-window-calibration.json')
