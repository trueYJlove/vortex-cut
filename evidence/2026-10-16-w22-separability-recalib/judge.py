"""判定集执行：VoxConverse **未读 45 场**上的巨簇拆分实验（判据见 PRE_REGISTRATION.md）。

流程（每场，走**生产服务**以便取得真实窗向量与生产 τ）：
  analyze_path → 读回 embeddings_blob / turns / threshold
  → K̂=2 解 → 取巨簇 → 在巨簇内用真 K 做无监督聚类（oracle K，上界式）
  → 重新拼标签 → 算 DER（ignore_overlap=True）
并报：ARI(巨簇内)、DER(不拆)、DER(拆分)、DER(打乱标签对照)、DER(oracle 天花板)。

零生产代码改动（只调用生产服务 + 纯函数）。
"""
from __future__ import annotations

import asyncio
import json
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
from diarization_cluster_routes import kmeans_cosine  # noqa: E402

FFMPEG = REPO / "resources/ffmpeg/win-x64/ffmpeg.exe"
FFPROBE = REPO / "resources/ffmpeg/win-x64/ffprobe.exe"
AUDIO = REPO / ".tmp/voxconverse/audio"
RTTM = REPO / ".tmp/voxconverse/rttm"
MANIFESTS = REPO / "resources/model-manifests"
MODEL_CACHE = REPO / "resources/.test-model-cache/speaker"
WORK = REPO / ".tmp" / "_recalib"
OUT = Path(__file__).resolve().parent / "result.json"
SEED = 0


def probe_duration(audio: Path) -> float:
    """**预登记 §3 冻结口径**：ffprobe format=duration（已核：与既有 diag 逐场 0.00 差）。"""
    import subprocess
    r = subprocess.run([str(FFPROBE), "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", str(audio)], capture_output=True, text=True)
    return float(r.stdout.strip())


def ari(a, b) -> float:
    a, b = np.asarray(a), np.asarray(b)
    _, ai = np.unique(a, return_inverse=True)
    _, bi = np.unique(b, return_inverse=True)
    cont = np.zeros((ai.max() + 1, bi.max() + 1), dtype=np.int64)
    np.add.at(cont, (ai, bi), 1)
    c2 = lambda x: x * (x - 1) / 2.0  # noqa: E731
    sij, si, sj = c2(cont).sum(), c2(cont.sum(1)).sum(), c2(cont.sum(0)).sum()
    n = a.size
    tot = c2(n)
    exp = si * sj / tot if tot > 0 else 0.0
    mx = (si + sj) / 2.0
    return float((sij - exp) / (mx - exp)) if mx != exp else 0.0


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


def der_of(windows, labels, ref, total_s, io=True) -> float:
    return float(score(ref, turns_of(windows, labels, total_s),
                       total_s=total_s, ignore_overlap=io).der)


async def one(m: str, k_hint: int | None) -> dict | None:
    audio = AUDIO / f"{m}.wav"
    rt = RTTM / f"{m}.rttm"
    if not audio.is_file() or not rt.is_file():
        return None
    WORK.mkdir(parents=True, exist_ok=True)
    dbp = WORK / f"_db_{m}.db"
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(dbp) + suffix)
        if p.is_file():
            p.unlink()
    db = Database(dbp)
    db.initialize()
    mm = ModelManager(db, dbp.parent, ModelRegistry(MANIFESTS))
    mm.seed_external(MODEL_CACHE)
    with db.connection() as con:
        con.execute(
            "INSERT OR IGNORE INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES ('p1','P','active','{}','r','r','t','t','t')")
        con.execute(
            "INSERT OR IGNORE INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?,'audio','external',?,?,1,'0','available','{}','t','t')",
            ("a_" + m, "p1", m, "fp_" + m))
    svc = SpeakerDiarizationService(db, FFMPEG,
                                    lambda aid: {"path": str(audio), "fingerprint": "fp_" + m},
                                    model_manager=mm)
    res = await svc.analyze_path("a_" + m, "fp_" + m, audio)
    with db.connection() as con:
        row = con.execute(
            "SELECT embeddings_blob,threshold,windows_json,speaker_count "
            "FROM speaker_diarizations WHERE id=?", (res["speaker_diarization_id"],)).fetchone()
    if row is None or row[0] is None:
        return None
    windows = json.loads(row[2] or "[]")
    n = len(windows)
    flat = decode_embeddings(row[0])
    dim = flat.size // n if n else 0
    if dim <= 0:
        return None
    vecs = flat.reshape(n, dim)
    tau = float(row[1])
    ref = load_rttm(rt)
    total_s = probe_duration(audio)          # 预登记 §3 冻结口径
    k_true = len({s for _, _, s in ref})

    dendro = sp.build_dendrogram(vecs)
    lab_now = sp.labels_at(dendro, tau)
    cnt = Counter(lab_now.tolist())
    big = max(cnt, key=cnt.get)
    idx = np.where(lab_now == big)[0]
    true_all = dominant(windows, ref)
    true_sub = true_all[idx]
    k_giant = len({t for t in true_sub.tolist() if t != "__none__"})

    out = {"meeting": m, "k_true": k_true, "k_now": int(len(cnt)), "tau": tau,
           "n_windows": n, "giant_windows": int(idx.size), "k_giant": k_giant,
           "der_not_split": round(der_of(windows, lab_now, ref, total_s), 4)}

    if k_giant < 2 or idx.size < k_giant:
        out["skipped_reason"] = "k_giant<2"
        return out

    base = int(max(lab_now)) + 1
    sub = vecs[idx]
    lab_sub, _ = kmeans_cosine(sub, k_giant, seed=SEED)
    lab_split = lab_now.copy()
    lab_split[idx] = lab_sub + base
    out["ari_giant"] = round(ari(lab_sub, true_sub), 4)
    out["der_split"] = round(der_of(windows, lab_split, ref, total_s), 4)

    # NC2：打乱真标签（判据不恒真的对照）
    rr = np.random.default_rng(SEED)
    sh = true_sub.copy()
    rr.shuffle(sh)
    out["ari_shuffled"] = round(ari(lab_sub, sh), 4)

    # 对照：oracle 天花板（每窗直给主导真说话人）
    omap = {s: i for i, s in enumerate(sorted({t for t in true_all.tolist()}))}
    lab_or = np.array([omap[t] for t in true_all.tolist()], dtype=int)
    out["der_oracle"] = round(der_of(windows, lab_or, ref, total_s), 4)
    return out


async def main() -> int:
    man = json.loads((Path(__file__).resolve().parent / "unread-manifest.json")
                     .read_text(encoding="utf-8"))
    names = sorted(man)
    print(f"判定集未读场次: {len(names)}", flush=True)
    rows = []
    for i, m in enumerate(names, 1):
        try:
            r = await one(m, man[m].get("k_true"))
        except Exception as exc:
            print(f"  [{i}/{len(names)}] {m}: 失败 {type(exc).__name__}: {exc}", flush=True)
            traceback.print_exc()
            continue
        if r:
            rows.append(r)
            d = (f"ARI={r.get('ari_giant')} DER_now={r['der_not_split']} "
                 f"DER_split={r.get('der_split')} DER_oracle={r.get('der_oracle')}")
            print(f"  [{i}/{len(names)}] {m:<8} K={r['k_now']} Kt={r['k_true']} "
                  f"giant={r['giant_windows']} {d}", flush=True)
            OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n完成 {len(rows)} 场 -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
