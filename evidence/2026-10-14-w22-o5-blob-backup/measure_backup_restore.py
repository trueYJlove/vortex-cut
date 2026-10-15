
"""P105 (Design Gate O5): size & cost of backup/restore once speaker_diarizations carries BLOBs.

Uses a REAL migrated database and REAL derived rows (36 meetings worth of window embeddings,
re-derived from the archived embedding cache so no audio/ONNX is needed).
"""
import json, pathlib, sqlite3, sys, time, tempfile, shutil, os
sys.path.insert(0, 'services/core/src'); sys.path.insert(0, 'tools/quality_eval')
import numpy as np
from aivs_core.database import Database, MIGRATIONS
from aivs_core.media import speaker as sp
from aivs_core.media.speaker_service import encode_embeddings
from diarization_cache import EmbeddingCache

OUT = pathlib.Path('.tmp/p105')
OUT.mkdir(parents=True, exist_ok=True)
cache = EmbeddingCache('.tmp/w22-embedding-cache')
SOURCES = [('ami', '.tmp/w22-diag-ami-fixed.json'), ('aishell4', '.tmp/w22-diag-cn.json')]

rows = []           # (asset_id, n_windows, blob)
for corpus, diag_p in SOURCES:
    d = json.loads(pathlib.Path(diag_p).read_text(encoding='utf-8'))['meetings']
    for m in sorted(d):
        e = d[m]
        c = (e.get('conditions') or {}).get('silero_vad')
        if not c: continue
        key = c.get('cache_key')
        if not key: continue
        hit = cache.get(key)
        if hit is None: continue
        vecs = np.asarray(hit[0], dtype=np.float32)
        rows.append((f'{corpus}:{m}', vecs.shape[0], encode_embeddings(vecs)))
print(f'derived rows: {len(rows)} (windows {min(r[1] for r in rows)}..{max(r[1] for r in rows)})')
total_blob = sum(len(r[2]) for r in rows)
print(f'总 BLOB 体积: {total_blob/1048576:.2f} MiB  平均 {total_blob/len(rows)/1024:.1f} KiB/行')

# build a real migrated DB and insert the rows
db_dir = OUT / 'db'
if db_dir.exists(): shutil.rmtree(db_dir)
db_dir.mkdir(parents=True, exist_ok=True)
db = Database(db_dir / 'app.db')
db.initialize()
with db.connection() as con:
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
print('migrated tables:', len(tables), '| speaker_diarizations present:', 'speaker_diarizations' in tables)
# ensure a project + assets so FKs hold
with db.connection() as con:
    cols = [r[1] for r in con.execute('PRAGMA table_info(speaker_diarizations)')]
print('speaker_diarizations columns:', cols)
metrics = {'rows': len(rows), 'total_blob_bytes': total_blob, 'columns': cols,
           'n_windows_range': [min(r[1] for r in rows), max(r[1] for r in rows)]}

def db_bytes(p):
    return sum(f.stat().st_size for f in pathlib.Path(p).rglob('*') if f.is_file())

t0 = time.perf_counter()
base_bytes = db_bytes(db_dir)
t_empty = time.perf_counter() - t0

# insert using the REAL v37 shape (assets first, so the FK holds)
with db.connection() as con:
    con.execute("INSERT INTO projects (id,name,status,canvas_json,root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
                    "VALUES ('p1','t','active','{}','.','r','2026-10-14T00:00:00','2026-10-14T00:00:00','2026-10-14T00:00:00')")
    for asset_id, nw, blob in rows:
        con.execute("INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
                    "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
                    "VALUES (?,?,'audio','external','n',?,1,'2026-10-14T00:00:00','available','{}',"
                    "'2026-10-14T00:00:00','2026-10-14T00:00:00')",
                    (asset_id, 'p1', 'fp_' + asset_id))
    for asset_id, nw, blob in rows:
        con.execute(
            "INSERT INTO speaker_diarizations (id,asset_id,source_fingerprint,algorithm_version,status,"
            "speaker_count,turns_json,windows_json,embeddings_blob,embedding_model,model_revision,"
            "vad_model,threshold,threshold_strategy,sample_rate,created_at,updated_at) "
            "VALUES (?,?,'fp',1,'ready',4,'[]','[]',?,'campplus','rev','silero',0.45,'silhouette_capk',16000,"
            "'2026-10-14T00:00:00','2026-10-14T00:00:00')",
            (f'row_{asset_id}', asset_id, blob))
    con.commit()
filled_bytes = db_bytes(db_dir)
print(f'空库 {base_bytes/1048576:.2f} MiB -> 含派生行 {filled_bytes/1048576:.2f} MiB (净增 {(filled_bytes-base_bytes)/1048576:.2f} MiB)')
metrics['db_empty_bytes'] = base_bytes
metrics['db_filled_bytes'] = filled_bytes

# backup (sqlite backup API = what a real backup uses) + restore
backup_path = OUT / 'backup.db'
for p in (backup_path,):
    if p.exists(): p.unlink()
t0 = time.perf_counter()
with db.connection() as con:
    dst = sqlite3.connect(str(backup_path))
    con.backup(dst)
    dst.close()
t_backup = time.perf_counter() - t0
restore_path = OUT / 'restore.db'
if restore_path.exists(): restore_path.unlink()
t0 = time.perf_counter()
with sqlite3.connect(str(backup_path)) as src, sqlite3.connect(str(restore_path)) as dst:
    src.backup(dst)
t_restore = time.perf_counter() - t0
# verify integrity + row count
with sqlite3.connect(str(restore_path)) as con:
    n = con.execute('SELECT COUNT(*) FROM speaker_diarizations').fetchone()[0]
    ok = con.execute('PRAGMA integrity_check').fetchone()[0]
    blob_sum = con.execute('SELECT SUM(LENGTH(embeddings_blob)) FROM speaker_diarizations').fetchone()[0]
print(f'备份 {t_backup*1000:.0f} ms -> {backup_path.stat().st_size/1048576:.2f} MiB ; 恢复 {t_restore*1000:.0f} ms ; 校验 {ok} ; 行 {n} ; BLOB 合计 {blob_sum/1048576:.2f} MiB')
metrics.update({'backup_seconds': round(t_backup, 4), 'restore_seconds': round(t_restore, 4),
                'backup_bytes': backup_path.stat().st_size, 'integrity': ok,
                'restored_rows': n, 'restored_blob_bytes': blob_sum})
(OUT / 'p105-result.json').write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding='utf-8')
print('wrote', OUT / 'p105-result.json')
