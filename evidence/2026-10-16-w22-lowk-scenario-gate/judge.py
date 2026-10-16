"""产品主场景（1-2 人）达标判定 —— 执行（判据见 PRE_REGISTRATION.md，未做任何调整）。

对 VoxConverse **未读 28 场**（K_true<=2 且 >=120s）走**生产链路**，
按生产落库的 `speaker_count`（K̂）与 DER 报判据 P0/P1/P2 与诊断 D1/D2，
并报负向对照 NC1(K̂ 分布) / NC2(随机标签) / NC3(oracle 天花板)。

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
from aivs_core.media.speaker_service import decode_embeddings, SpeakerDiarizationService  # noqa: E402
from aivs_core.model_registry import ModelManager, ModelRegistry  # noqa: E402
from diarization import load_rttm, score  # noqa: E402

FFMPEG = REPO / "resources/ffmpeg/win-x64/ffmpeg.exe"
FFPROBE = REPO / "resources/ffmpeg/win-x64/ffprobe.exe"
AUDIO = REPO / ".tmp/voxconverse/audio"
RTTM = REPO / ".tmp/voxconverse/rttm"
MANIFESTS = REPO / "resources/model-manifests"
MODEL_CACHE = REPO / "resources/.test-model-cache/speaker"
WORK = REPO / ".tmp" / "_lowk_gate"
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


def der_of(windows, labels, ref, total_s) -> float:
    return float(score(ref, turns_of(windows, labels, total_s), total_s=total_s,
                       ignore_overlap=True).der)


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
            "SELECT embeddings_blob,threshold,windows_json,speaker_count,turns_json "
            "FROM speaker_diarizations WHERE id=?", (res["speaker_diarization_id"],)).fetchone()
    if row is None:
        return None
    windows = json.loads(row[2] or "[]")
    n = len(windows)
    flat = decode_embeddings(row[0])
    dim = flat.size // n if n else 0
    if dim <= 0:
        return None
    vecs = flat.reshape(n, dim)
    ref = load_rttm(rt)
    total_s = probe_duration(audio)
    k_true = len({s for _, _, s in ref})
    k_hat = row[3]

    # 生产 DER：直接对落库结果评分
    hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"s{t['speaker']}")
           for t in json.loads(row[4] or "[]")]
    der_prod = float(score(ref, hyp, total_s=total_s, ignore_overlap=True).der)

    dendro = sp.build_dendrogram(vecs)

    # NC2 随机标签 / NC3 oracle 天花板
    rr = np.random.default_rng(0)
    lab_rand = rr.integers(0, max(k_true, 1), size=n)
    der_rand = der_of(windows, lab_rand, ref, total_s)
    true_all = dominant(windows, ref)
    omap = {s: i for i, s in enumerate(sorted({t for t in true_all.tolist()}))}
    lab_or = np.array([omap[t] for t in true_all.tolist()], dtype=int)
    der_oracle = der_of(windows, lab_or, ref, total_s)

    return {"meeting": m, "k_true": k_true, "k_hat": k_hat, "n_windows": n,
            "duration_s": round(total_s, 2), "der_production": round(der_prod, 4),
            "der_random": round(der_rand, 4), "der_oracle": round(der_oracle, 4)}


async def main() -> int:
    man = json.loads((HERE / "unread-lowk-manifest.json").read_text(encoding="utf-8"))
    names = sorted(man)
    print(f"判定集（未读 K_true<=2, >=120s）: {len(names)} 场", flush=True)
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
            print(f"  [{i}/{len(names)}] {m:<8} K_true={r['k_true']} K_hat={r['k_hat']} "
                  f"DER={r['der_production']:.4f} oracle={r['der_oracle']:.4f} "
                  f"rand={r['der_random']:.4f}", flush=True)
            OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n完成 {len(rows)} 场 -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
