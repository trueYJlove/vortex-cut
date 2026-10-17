"""换 embedding 模型对照（CAM++ vs ResNet34），同一批窗、同一准则、同一评分。

**为什么做**：A 路径（换特征/模型）已被 ADR-0007 D1 解禁；ResNet34 已在磁盘上，
设计门 D2 将其定位为「仅评测对照、不进产品路径」⇒ 从未在困难集上跑过。
P88 已登记「ResNet34 对尺度不敏感、CAM++ 敏感」，而四轮失败的根源集中在短/少窗素材。

**唯一的变量是 embedding 模型**：窗集合、VAD、聚类（silhouette+capK）、评分器全部不动。
窗集合直接复用 P136 已落库的 windows_json（不重跑 VAD）⇒ 严格配对对照。

**这不是预登记实验**：VoxConverse test 已耗尽（未读 0），无盲测集。
本实验**只能产出诊断级证据**，用于决定「是否值得投入一次真实下载」。
"""
from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "services" / "core" / "src"))
sys.path.insert(0, str(REPO / "tools" / "quality_eval"))

import numpy as np

from aivs_core.database import Database
from aivs_core.media import speaker as sp
from aivs_core.media.speaker_embedding import SpeakerEmbedder
from aivs_core.media.speaker_service import decode_embeddings
from diarization import load_rttm, score

MODELS = {
    "campplus": REPO / ".tmp/spike-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
    "resnet34": REPO / ".tmp/spike-models/wespeaker_zh_cnceleb_resnet34.onnx",
}
WORK = REPO / ".tmp" / "_khat_tier"
AUDIO = REPO / ".tmp/voxconverse/audio"
RTTM = REPO / ".tmp/voxconverse/rttm"
FFPROBE = REPO / "resources/ffmpeg/win-x64/ffprobe.exe"
P136 = REPO / "evidence/2026-10-16-w22-khat-tiering-gate/result.json"
SR = 16000


def dur(p: Path) -> float:
    r = subprocess.run([str(FFPROBE), "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", str(p)], capture_output=True, text=True)
    return float(r.stdout.strip())


def read_pcm(p: Path) -> np.ndarray:
    """16k 单声道 s16le（与生产 decode_pcm 同口径，直接 ffmpeg 取）。"""
    r = subprocess.run([str(REPO / "resources/ffmpeg/win-x64/ffmpeg.exe"),
                        "-v", "error", "-i", str(p), "-ac", "1", "-ar", str(SR),
                        "-f", "s16le", "-"],
                       capture_output=True)
    return np.frombuffer(r.stdout, dtype="<i2").astype(np.float64) / 32768.0


def turns_of(windows, labels, total_s):
    t = sp.windows_to_turns(np.asarray(windows, float), labels, total_s,
                            min_turn_s=sp.MIN_TURN_S)
    return [(x["start_us"] / 1e6, x["end_us"] / 1e6, f"s{x['speaker']}") for x in t]


def main() -> int:
    rows = json.loads(P136.read_text(encoding="utf-8"))
    # 只看有 blob 的场
    items = []
    for r in rows:
        dbp = WORK / f"_db_{r['meeting']}.db"
        if not dbp.is_file():
            continue
        db = Database(dbp)
        with db.connection() as con:
            row = con.execute(
                "SELECT windows_json FROM speaker_diarizations "
                "ORDER BY created_at DESC LIMIT 1").fetchone()
        if row is None:
            continue
        wins = json.loads(row[0] or "[]")
        if len(wins) < 4:
            continue
        items.append((r["meeting"], r["k_true"], wins))

    print(f"配对场次: {len(items)}（窗集合直接复用 P136 落库值）", flush=True)
    emb = {k: SpeakerEmbedder(v) for k, v in MODELS.items()}
    for k, e in emb.items():
        print(f"  {k}: dim={e.dim}", flush=True)

    out = []
    for i, (m, k_true, wins) in enumerate(items, 1):
        pcm = read_pcm(AUDIO / f"{m}.wav")
        total_s = dur(AUDIO / f"{m}.wav")
        ref = load_rttm(RTTM / f"{m}.rttm")
        rec = {"meeting": m, "k_true": k_true, "n_windows": len(wins)}
        for name, e in emb.items():
            vecs = np.asarray(
                [e.embed(pcm[int(a * SR):int(b * SR)]) for a, b in wins],
                dtype=np.float64)
            dendro = sp.build_dendrogram(vecs)
            dmat = 1.0 - (vecs / np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-12)) @ \
                   (vecs / np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-12)).T
            best_s, best_t = -2.0, None
            for tau in sp.TAU_GRID:
                lab = sp.labels_at(dendro, tau)
                k = int(np.unique(lab).size)
                if k < 2 or k > sp.DEFAULT_K_MAX:
                    continue
                s = sp.silhouette(dmat, lab)
                if s > best_s:
                    best_s, best_t = s, tau
            if best_t is None:
                rec[name] = {"k": None, "der": None, "tau": None}
            else:
                lab = sp.labels_at(dendro, best_t)
                der = float(score(ref, turns_of(wins, lab, total_s),
                                  total_s=total_s, ignore_overlap=True).der)
                rec[name] = {"k": int(np.unique(lab).size), "der": round(der, 4),
                             "tau": float(best_t)}
        out.append(rec)
        a, b = rec["campplus"], rec["resnet34"]
        print(f"  [{i}/{len(items)}] {m:<8} Kt={k_true} "
              f"CAM++: K̂={a['k']} DER={a['der']} | RES: K̂={b['k']} DER={b['der']}",
              flush=True)
        (Path(__file__).resolve().parent / "result.json").write_text(
            json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    (Path(__file__).resolve().parent / "result.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n完成 {len(out)} 场 -> result.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
