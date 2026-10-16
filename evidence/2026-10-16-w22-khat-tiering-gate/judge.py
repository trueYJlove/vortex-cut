"""按 K̂ 分档准入的验证 —— 执行（判据见 PRE_REGISTRATION.md，未做任何调整）。

对 VoxConverse **剩余未读 38 场**走生产链路，报：
  逐场：K_true / K̂ / DER（双口径）/ oracle
  分档：K̂<=2 与 K̂>=3 各自的均值与最差场
并给 N1（档内真多人占比）/ N2（越线场次）/ N3（合并最差场）。

零生产代码改动（只调用生产服务 + 纯函数）。
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import traceback
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "services" / "core" / "src"))
sys.path.insert(0, str(REPO / "tools" / "quality_eval"))

import numpy as np  # noqa: E402

from aivs_core.database import Database  # noqa: E402
from aivs_core.media import speaker as sp  # noqa: E402
from aivs_core.media.speaker_service import SpeakerDiarizationService  # noqa: E402
from aivs_core.model_registry import ModelManager, ModelRegistry  # noqa: E402
from diarization import load_rttm, score  # noqa: E402

FFMPEG = REPO / "resources/ffmpeg/win-x64/ffmpeg.exe"
FFPROBE = REPO / "resources/ffmpeg/win-x64/ffprobe.exe"
AUDIO = REPO / ".tmp/voxconverse/audio"
RTTM = REPO / ".tmp/voxconverse/rttm"
MANIFESTS = REPO / "resources/model-manifests"
MODEL_CACHE = REPO / "resources/.test-model-cache/speaker"
WORK = REPO / ".tmp" / "_khat_tier"
HERE = Path(__file__).resolve().parent
OUT = HERE / "result.json"


def probe_duration(audio: Path) -> float:
    r = subprocess.run([str(FFPROBE), "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", str(audio)], capture_output=True, text=True)
    return float(r.stdout.strip())


def dominant(windows, ref):
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


def turns_of(windows, labels, total_s):
    t = sp.windows_to_turns(np.asarray(windows, float), labels, total_s,
                            min_turn_s=sp.MIN_TURN_S)
    return [(x["start_us"] / 1e6, x["end_us"] / 1e6, f"s{x['speaker']}") for x in t]


async def one(m: str) -> dict | None:
    audio, rt = AUDIO / f"{m}.wav", RTTM / f"{m}.rttm"
    if not (audio.is_file() and rt.is_file()):
        return None
    WORK.mkdir(parents=True, exist_ok=True)
    dbp = WORK / f"_db_{m}.db"
    for suf in ("", "-wal", "-shm"):
        p = Path(str(dbp) + suf)
        if p.is_file():
            p.unlink()
    db = Database(dbp)
    db.initialize()
    mm = ModelManager(db, dbp.parent, ModelRegistry(MANIFESTS))
    mm.seed_external(MODEL_CACHE)
    with db.connection() as con:
        con.execute("INSERT OR IGNORE INTO projects(id,name,status,canvas_json,root_dir,"
                    "root_dir_name,created_at,updated_at,last_opened_at) "
                    "VALUES ('p1','P','active','{}','r','r','t','t','t')")
        con.execute("INSERT OR IGNORE INTO assets(id,project_id,kind,storage_mode,display_name,"
                    "fingerprint,size_bytes,modified_at,availability,media_info_json,"
                    "created_at,updated_at) VALUES (?,?,'audio','external',?,?,1,'0',"
                    "'available','{}','t','t')", ("a_" + m, "p1", m, "fp_" + m))
    svc = SpeakerDiarizationService(db, FFMPEG,
                                    lambda aid: {"path": str(audio), "fingerprint": "fp_" + m},
                                    model_manager=mm)
    res = await svc.analyze_path("a_" + m, "fp_" + m, audio)
    with db.connection() as con:
        row = con.execute(
            "SELECT turns_json,speaker_count,threshold,windows_json,embeddings_blob "
            "FROM speaker_diarizations WHERE id=?", (res["speaker_diarization_id"],)).fetchone()
    if row is None:
        return None
    hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"s{t['speaker']}")
           for t in json.loads(row[0] or "[]")]
    ref = load_rttm(rt)
    total_s = probe_duration(audio)
    k_true = len({s for _, _, s in ref})
    k_hat = row[1]

    t_io = score(ref, hyp, total_s=total_s, ignore_overlap=True)
    f_io = score(ref, hyp, total_s=total_s, ignore_overlap=False)

    # oracle 天花板：每窗直给主导真说话人
    der_oracle = None
    try:
        from aivs_core.media.speaker_service import decode_embeddings
        windows = json.loads(row[3] or "[]")
        n = len(windows)
        flat = decode_embeddings(row[4])
        if n and flat.size and flat.size % n == 0:
            true_all = dominant(windows, ref)
            omap = {s: i for i, s in enumerate(sorted({t for t in true_all.tolist()}))}
            lab_or = np.array([omap[t] for t in true_all.tolist()], dtype=int)
            hyp_or = turns_of(windows, lab_or, total_s)
            der_oracle = round(float(score(ref, hyp_or, total_s=total_s,
                                          ignore_overlap=True).der), 4)
    except Exception:
        pass

    return {"meeting": m, "k_true": k_true, "k_hat": k_hat,
            "duration_s": round(total_s, 2), "n_turns": len(hyp),
            "der_T": round(t_io.der, 4), "der_F": round(f_io.der, 4),
            "der_oracle": der_oracle}


async def main() -> int:
    man = json.loads((HERE / "unread-remaining-manifest.json").read_text(encoding="utf-8"))
    names = sorted(r["name"] for r in man)
    print(f"验证集（剩余未读）: {len(names)} 场", flush=True)
    rows = []
    for i, m in enumerate(names, 1):
        try:
            r = await one(m)
        except Exception as exc:
            print(f"  [{i}/{len(names)}] {m}: 失败 {type(exc).__name__}: {exc}", flush=True)
            traceback.print_exc()
            continue
        if r:
            rows.append(r)
            print(f"  [{i}/{len(names)}] {m:<8} K_true={r['k_true']} K̂={r['k_hat']} "
                  f"DER_T={r['der_T']:.4f} DER_F={r['der_F']:.4f} "
                  f"oracle={r['der_oracle']} dur={r['duration_s']:.0f}s", flush=True)
            OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n完成 {len(rows)} 场 -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
