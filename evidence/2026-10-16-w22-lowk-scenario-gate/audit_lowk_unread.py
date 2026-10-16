"""清点：VoxConverse test 池里 **未读且 K_true<=2**（产品主场景：口播/对谈）的场次。

"未读"必须由集合运算得出，不得估计：
  已读 = P115(dev-48 + highk-49) ∪ P117(test-lowk 63) ∪ P127(judge 56)
 未读 = audio(216) - 已读
另对每个候选名在 evidence/ 与 docs/ 内 grep（排除本轮新建目录）作抽查。
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
V = REPO / ".tmp/voxconverse"
OUT = Path(__file__).resolve().parent / "unread-lowk-manifest.json"
SELF_DIR = "2026-10-16-w22-separability-recalib"


def names_from(obj) -> set[str]:
    out: set[str] = set()

    def walk(o):
        if isinstance(o, str):
            out.add(o.split(".")[0])
        elif isinstance(o, list):
            for x in o:
                walk(x)
        elif isinstance(o, dict):
            for k, v in o.items():
                walk(v) if isinstance(v, (list, dict)) else out.add(str(k).split(".")[0])
    walk(obj)
    return out


def rttm_stats(p: Path) -> tuple[int, float]:
    spk, mx = set(), 0.0
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        f = line.split()
        if len(f) >= 8 and f[0] == "SPEAKER":
            spk.add(f[7])
            mx = max(mx, float(f[3]) + float(f[4]))
    return len(spk), mx


def main() -> int:
    audio = {p.stem for p in (V / "audio").glob("*.wav")}
    read: set[str] = set()
    for f in (".tmp/vc-subset-judge.json",
              "evidence/2026-10-12-w22-f-voxconverse-lowk/subset-lowk.json",
              "evidence/2026-10-12-w22-f-voxconverse-lowk/subset-highk.json"):
        p = REPO / f
        if p.is_file():
            read |= {n for n in names_from(json.loads(p.read_text(encoding="utf-8")))
                     if n and not n[0].isdigit() and len(n) >= 4}
    read |= {p.stem for p in (V / "test_lowk").glob("*.wav")}
    read |= {p.stem for p in (V / "judge_set").glob("*.wav")}

    unread = sorted(audio - read)
    rttm = {p.stem: p for p in (V / "rttm").rglob("*.rttm")}
    stats = {}
    for nm in unread:
        if nm in rttm:
            stats[nm] = rttm_stats(rttm[nm])
    print(f"audio={len(audio)}  已读(并集)={len(read)}  audio 内未读={len(unread)}")

    lowk = {n: v for n, v in stats.items() if v[0] <= 2}
    elig = {n: v for n, v in lowk.items() if v[1] >= 120.0}
    print(f"未读中 K_true<=2 的 = {len(lowk)}；其中 >=120s 的 = {len(elig)}")
    dist = {}
    for k, _ in lowk.values():
        dist[k] = dist.get(k, 0) + 1
    print(f"未读 K<=2 的 K 分布: {dict(sorted(dist.items()))}")

    # 抽查：这些名字不得出现在既有 records 中
    print("\n=== 抽查（排除本轮目录，grep evidence/ 与 docs/，应 0 命中）===")
    hits_total = 0
    sample = sorted(elig)[:: max(1, len(elig) // 6)][:6]
    for nm in sample:
        r = subprocess.run(["grep", "-rl", nm, "evidence/", "docs/"],
                           cwd=REPO, capture_output=True, text=True)
        files = [x for x in r.stdout.strip().splitlines() if x and SELF_DIR not in x]
        hits_total += len(files)
        print(f"  {nm}: {'命中 ' + str(files[:2]) if files else '0 命中'}")
    print(f"抽查总命中（排除本轮目录）= {hits_total}")

    OUT.write_text(json.dumps(
        {n: {"k_true": v[0], "dur": round(v[1], 1)} for n, v in sorted(elig.items())},
        ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n清单 -> {OUT.name}  场次={len(elig)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
