"""全量测量：AMI 10 个欠分割场（K_hat=2 全部）的 K=2 解簇份额。

门 §5.6② 称该解"退化"（巨簇+极小远簇），§5.17 判定三称"没有小簇可剔"。
两处口径冲突 ⇒ 用全量测量裁决，为 B 线候选清单提供事实。
"""
from __future__ import annotations

import asyncio
import json
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "services" / "core" / "src"))

from aivs_core.database import Database  # noqa: E402
from aivs_core.media.speaker_service import SpeakerDiarizationService  # noqa: E402
from aivs_core.model_registry import ModelManager, ModelRegistry  # noqa: E402

FFMPEG = REPO / "resources/ffmpeg/win-x64/ffmpeg.exe"
AUDIO = REPO / ".tmp/ami/audio"
EXT = ".Mix-Headset.wav"
MANIFESTS = REPO / "resources/model-manifests"
CACHE = REPO / "resources/.test-model-cache/speaker"
OUT = REPO / ".tmp/_share_probe_all"

S3 = REPO / "evidence/2026-10-14-w22-s3-production-gate/result.json"


async def one(m: str) -> dict | None:
    audio = AUDIO / f"{m}{EXT}"
    if not audio.exists():
        return None
    tmp_db = OUT / f"_db_{m}.db"
    OUT.mkdir(parents=True, exist_ok=True)
    db = Database(tmp_db)
    db.initialize()
    mm = ModelManager(db, tmp_db.parent, ModelRegistry(MANIFESTS))
    mm.seed_external(CACHE)
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
            "SELECT turns_json,speaker_count,threshold FROM speaker_diarizations WHERE id=?",
            (res["speaker_diarization_id"],)).fetchone()
    turns = json.loads(row[0])
    secs = Counter()
    for t in turns:
        secs[int(t["speaker"])] += (t["end_us"] - t["start_us"]) / 1e6
    total = sum(secs.values()) or 1.0
    shares = sorted((s / total for s in secs.values()), reverse=True)
    return {"meeting": m, "K": row[1], "tau": row[2], "n_turns": len(turns),
            "shares": [round(s, 4) for s in shares]}


async def main() -> int:
    s3 = json.loads(S3.read_text(encoding="utf-8"))
    pm = s3["corpora"]["ami"]["per_meeting"]
    targets = [m for m, v in sorted(pm.items())
               if v["speaker_count"] <= v["k_true"] - 2]
    print(f"AMI 欠分割场次: {len(targets)} -> {targets}", flush=True)
    out = []
    for m in targets:
        try:
            r = await one(m)
        except Exception as exc:
            print(f"  {m}: 失败 {type(exc).__name__}: {exc}", flush=True)
            continue
        if r:
            dom = r["shares"][0] if r["shares"] else 0
            print(f"  {m}: K={r['K']} tau={r['tau']} 份额={r['shares']} 主导={dom:.4f}", flush=True)
            out.append(r)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "shares_all.json").write_text(json.dumps(out, ensure_ascii=False, indent=2),
                                         encoding="utf-8")
    print(f"\n落盘 {len(out)} 场 -> {OUT/'shares_all.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
