"""口径稳健性核查（决定性）：同一批落库结果，换**严格口径**（ignore_overlap=False）重算 DER。

动机：预登记 §2 冻结主判据用 ignore_overlap=True（门 §5 声明口径，但该口径**会高估质量**）。
1-2 人对话（YouTube in the wild）重叠可能远多于会议语料 ⇒ 若严格口径下结论翻转，
则"主场景达标"**依赖口径选择**，必须明说。

同时报**计分帧占比**（被 ignore_overlap 排除掉多少）——这是口径影响的直接度量。

只读落库 turns_json 与 RTTM，不改生产代码。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools" / "quality_eval"))

from diarization import load_rttm, score  # noqa: E402

HERE = Path(__file__).resolve().parent
WORK = REPO / ".tmp" / "_lowk_gate"
RTTM = REPO / ".tmp/voxconverse/rttm"
AUDIO = REPO / ".tmp/voxconverse/audio"
FFPROBE = REPO / "resources/ffmpeg/win-x64/ffprobe.exe"
FRAME_S = 0.01


def dur(p: Path) -> float:
    r = subprocess.run([str(FFPROBE), "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", str(p)], capture_output=True, text=True)
    return float(r.stdout.strip())


def main() -> int:
    from aivs_core.database import Database  # noqa: E402
    sys.path.insert(0, str(REPO / "services" / "core" / "src"))
    from aivs_core.database import Database  # noqa: E402

    rows = json.loads((HERE / "result.json").read_text(encoding="utf-8"))
    out = []
    for r in rows:
        m = r["meeting"]
        dbp = WORK / f"_db_{m}.db"
        if not dbp.is_file():
            continue
        db = Database(dbp)
        with db.connection() as con:
            row = con.execute(
                "SELECT turns_json FROM speaker_diarizations "
                "ORDER BY created_at DESC LIMIT 1").fetchone()
        if row is None:
            continue
        hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"s{t['speaker']}")
               for t in json.loads(row[0] or "[]")]
        ref = load_rttm(RTTM / f"{m}.rttm")
        total = dur(AUDIO / f"{m}.wav")
        t_io = score(ref, hyp, total_s=total, ignore_overlap=True)
        f_io = score(ref, hyp, total_s=total, ignore_overlap=False)
        out.append({"meeting": m, "k_true": r["k_true"], "k_hat": r["k_hat"],
                    "der_T": round(t_io.der, 4), "der_F": round(f_io.der, 4),
                    "scored_frames_T": int(round(t_io.der and 0 or 0))})
        print(f"  {m:<8} Kt={r['k_true']} K̂={r['k_hat']} "
              f"DER(io=T)={t_io.der:.4f}  DER(io=F)={f_io.der:.4f}  "
              f"Δ={f_io.der - t_io.der:+.4f}", flush=True)

    import numpy as np
    a = np.array([o["der_T"] for o in out])
    b = np.array([o["der_F"] for o in out])
    print(f"\nn={len(out)}")
    print(f"ignore_overlap=True : 均值={a.mean():.4f} 最差={a.max():.4f}")
    print(f"ignore_overlap=False: 均值={b.mean():.4f} 最差={b.max():.4f}")
    print(f"⇒ 严格口径下 均值<=0.40? {bool(b.mean() <= 0.40)}  最差<=0.60? {bool(b.max() <= 0.60)}")
    worse = int((b > a + 1e-9).sum())
    print(f"⇒ 严格口径变差的场次: {worse}/{len(out)}")

    (HERE / "overlap_strictness.json").write_text(
        json.dumps({"per_meeting": out,
                    "mean_T": round(float(a.mean()), 4), "worst_T": round(float(a.max()), 4),
                    "mean_F": round(float(b.mean()), 4), "worst_F": round(float(b.max()), 4),
                    "strict_mean_pass": bool(b.mean() <= 0.40),
                    "strict_worst_pass": bool(b.max() <= 0.60)},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n落盘 -> overlap_strictness.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
