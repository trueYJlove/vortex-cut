
"""W2.2 S3 gate: DER on the PRODUCTION chain (gate section 6 requires SpeakerDiarizationService,
not the spike harness). AMI test 16 + AISHELL-4 test 20, real audio, real ffmpeg, real ONNX.

Reports BOTH overlap conventions and, per ADR-0006 D1, (a)/(b) separately.
"""
import asyncio, json, pathlib, statistics as st, sys, time
sys.path.insert(0, 'services/core/src'); sys.path.insert(0, 'tools/quality_eval')
import numpy as np
from aivs_core.database import Database
from aivs_core.media.speaker_service import SpeakerDiarizationService
from aivs_core.model_registry import ModelManager, ModelRegistry
from diarization import load_rttm, score

REPO = pathlib.Path('.').resolve()
FFMPEG = REPO / 'resources/ffmpeg/win-x64/ffmpeg.exe'
OUT = pathlib.Path('evidence/2026-10-14-w22-s3-production-gate')
OUT.mkdir(parents=True, exist_ok=True)

CORPORA = {
 'ami': dict(diag='.tmp/w22-diag-ami-fixed.json',
             rttm='.tmp/ami/AMI-diarization-setup-main/only_words/rttms/test',
             audio='.tmp/ami/audio', ext='.Mix-Headset.wav', channel=None),
 'aishell4': dict(diag='.tmp/w22-diag-cn.json', rttm='.tmp/aishell4/rttm',
                  audio='.tmp/aishell4/audio', ext='.flac', channel=0),
}

MANIFESTS = REPO / 'resources/model-manifests'
CACHE = REPO / 'resources/.test-model-cache/speaker'

def build_service(tmp_db: pathlib.Path):
    db = Database(tmp_db)
    db.initialize()
    mm = ModelManager(db, tmp_db.parent, ModelRegistry(MANIFESTS))
    mm.seed_external(CACHE)
    with db.connection() as con:   # real project + asset rows (FK target for the derived row)
        con.execute("INSERT OR IGNORE INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
                    "created_at,updated_at,last_opened_at) VALUES ('p1','P','active','{}','r','r','t','t','t')")
        for aid, path in PATHS.items():
            con.execute("INSERT OR IGNORE INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
                        "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
                        "VALUES (?,?,'audio','external',?,?,1,'0','available','{}','t','t')",
                        (aid, 'p1', aid, FPS[aid]))
    svc = SpeakerDiarizationService(db, FFMPEG, lambda aid: {'path': PATHS[aid], 'fingerprint': FPS[aid]},
                                    model_manager=mm)
    return db, svc

PATHS, FPS = {}, {}

async def run(diag_p, rttm_p, audio_dir, ext):
    diag = json.loads(pathlib.Path(diag_p).read_text(encoding='utf-8'))['meetings']
    rt = {p.stem: p for p in pathlib.Path(rttm_p).rglob('*.rttm')}
    rows = {}
    for m in sorted(diag):
        if m not in rt: continue
        audio = pathlib.Path(audio_dir) / f'{m}{ext}'
        if not audio.exists(): continue
        PATHS['a_' + m] = str(audio); FPS['a_' + m] = 'fp_' + m
        db, svc = build_service(OUT / f'_db_{m}.db')
        t0 = time.perf_counter()
        res = await svc.analyze_path('a_' + m, 'fp_' + m, audio)
        dt = time.perf_counter() - t0
        # read turns back from the DB (production artifact, not in-memory)
        with db.connection() as con:
            row = con.execute("SELECT turns_json,threshold,threshold_strategy,speaker_count FROM speaker_diarizations WHERE id=?",
                              (res['speaker_diarization_id'],)).fetchone()
        turns = json.loads(row[0])
        ref = load_rttm(rt[m])
        total = float(diag[m]['total_s'])
        hyp = [(t['start_us']/1e6, t['end_us']/1e6, 's%d' % t['speaker']) for t in turns]
        rT = score(ref, hyp, total_s=total, ignore_overlap=True)
        rF = score(ref, hyp, total_s=total, ignore_overlap=False)
        rows[m] = {'status': res['status'], 'reason': res['reason'], 'speaker_count': res['speaker_count'],
                   'threshold': res['threshold'], 'strategy': res['threshold_strategy'],
                   'windows': res['window_count'], 'turns': len(turns), 'seconds': round(dt, 1),
                   'k_true': len({t[2] for t in ref}),
                   'der_T': round(rT.der, 4), 'der_F': round(rF.der, 4),
                   'miss_T': round(rT.miss, 4), 'fa_T': round(rT.false_alarm, 4), 'spk_T': round(rT.speaker_error, 4)}
        print(f"  [{m}] {res['status']} K={res['speaker_count']} der_T={rows[m]['der_T']} der_F={rows[m]['der_F']} {dt:.1f}s", flush=True)
    return rows

async def main():
    report = {'purpose': 'S3 gate on the production chain', 'corpora': {}}
    for cname, args in CORPORA.items():
        print(f'=== {cname} ===', flush=True)
        rows = await run(args['diag'], args['rttm'], args['audio'], args['ext'])
        T = [r['der_T'] for r in rows.values()]; F = [r['der_F'] for r in rows.values()]
        S = [r['seconds'] for r in rows.values()]
        tmin = sum(json.loads(pathlib.Path(args['diag']).read_text(encoding='utf-8'))['meetings'][m]['total_s'] for m in rows) / 60
        report['corpora'][cname] = {'n': len(rows), 'per_meeting': rows,
            'mean_T': round(st.mean(T), 4), 'worst_T': round(max(T), 4),
            'mean_F': round(st.mean(F), 4), 'worst_F': round(max(F), 4),
            'worst_T_meeting': max(rows, key=lambda m: rows[m]['der_T']),
            'source_minutes': round(tmin, 1), 'total_seconds': round(sum(S), 1),
            'sec_per_minute': round(sum(S) / tmin, 2)}
        c = report['corpora'][cname]
        print(f"  -> mean_T={c['mean_T']} worst_T={c['worst_T']} | mean_F={c['mean_F']} worst_F={c['worst_F']} | {c['sec_per_minute']} s/min", flush=True)
    # gate verdict (gate section 5: mean <=0.40 both; worst EN<=0.60 CN<=0.55; resource <=10 s/min)
    a, c = report['corpora'].get('ami'), report['corpora'].get('aishell4')
    g = {}
    if a and c:
        g['mean_le_0.40_both'] = bool(a['mean_T'] <= 0.40 and c['mean_T'] <= 0.40)
        g['worst_en_le_0.60'] = bool(a['worst_T'] <= 0.60)
        g['worst_cn_le_0.55'] = bool(c['worst_T'] <= 0.55)
        g['resource_le_10s_per_min'] = bool(a['sec_per_minute'] <= 10 and c['sec_per_minute'] <= 10)
        g['OVERALL'] = bool(all([g['mean_le_0.40_both'], g['worst_en_le_0.60'], g['worst_cn_le_0.55'], g['resource_le_10s_per_min']]))
    report['gate'] = g
    (OUT / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('\nGATE:', json.dumps(g, ensure_ascii=False))
    print('wrote', OUT / 'result.json')

asyncio.run(main())
