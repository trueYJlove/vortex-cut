"""语料存量精确清点（为 K_true=1 专项决定"还能用哪些素材"）。"""
from __future__ import annotations
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
V = REPO / ".tmp" / "voxconverse"


def cand(o, out):
    if isinstance(o, str):
        out.add(o.split(".")[0])
    elif isinstance(o, list):
        for x in o:
            cand(x, out)
    elif isinstance(o, dict):
        for k, v in o.items():
            out.add(str(k).split(".")[0])
            cand(v, out)
    return out


def main() -> int:
    audio = {p.stem for p in (V / "audio").glob("*.wav")}
    read: set = set()
    for f in (".tmp/vc-subset-judge.json",
              "evidence/2026-10-12-w22-f-voxconverse-lowk/subset-lowk.json",
              "evidence/2026-10-12-w22-f-voxconverse-lowk/subset-highk.json",
              "evidence/2026-10-16-w22-separability-recalib/unread-manifest.json",
              "evidence/2026-10-16-w22-lowk-scenario-gate/unread-lowk-manifest.json",
              "evidence/2026-10-16-w22-khat-tiering-gate/unread-remaining-manifest.json"):
        p = REPO / f
        if p.is_file():
            read |= cand(json.loads(p.read_text(encoding="utf-8")), set())
    read |= {p.stem for p in (V / "test_lowk").glob("*.wav")}
    read |= {p.stem for p in (V / "judge_set").glob("*.wav")}
    read &= audio
    unread = audio - read
    print(f"VoxConverse test : audio={len(audio)}  read={len(read)}  UNREAD={len(unread)}")

    for d in ("dev_audio", "judge_set", "test_lowk", "audio"):
        dp = V / d
        if dp.is_dir():
            for sub in sorted(dp.iterdir()):
                if sub.is_dir():
                    print(f"  {d}/{sub.name}: {len(list(sub.glob('*.wav')))} wav")
            n = len(list(dp.glob("*.wav")))
            if n:
                print(f"  {d}: {n} wav")

    for z in sorted(V.glob("*.zip")):
        print(f"  zip {z.name}: {z.stat().st_size / 2**30:.1f} GiB")

    ami = REPO / ".tmp/ami/audio"
    if ami.is_dir():
        names = sorted({p.name.split(".")[0] for p in ami.glob("*.wav")})
        print(f"AMI: {len(list(ami.glob('*.wav')))} wav / {len(names)} meetings")
    a4 = REPO / ".tmp/aishell4/audio"
    if a4.is_dir():
        print(f"AISHELL-4: {len(list(a4.glob('*.flac')))} flac (+{len(list(a4.glob('*.wav')))} wav)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
