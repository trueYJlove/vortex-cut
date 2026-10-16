"""未读语料清点：VoxConverse test 池里哪些场次从未被任何实验读过，及其 K 分布。

"未读"是本轮新预登记的前提，必须由集合运算得出，不得估计。
抽样核查：从证据文档里 grep 候选未读名，确认无命中。
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
V = REPO / ".tmp/voxconverse"


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
                if isinstance(v, (list, dict)):
                    walk(v)
                else:
                    out.add(str(k).split(".")[0])
    walk(obj)
    return out


def k_true(stem: str) -> int | None:
    for p in (V / "rttm").rglob(f"{stem}.rttm"):
        spk = set()
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            f = line.split()
            if len(f) >= 8 and f[0] == "SPEAKER":
                spk.add(f[7])
        return len(spk) or None
    return None


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
    print(f"audio 全集={len(audio)}  已读(并集)={len(read & audio) if False else len(read)}  "
          f"audio 内未读={len(unread)}")

    # 抽样核查：未读名不得出现在证据/文档中
    print("\n=== 未读抽样核查（在 evidence/ 与 docs/ 中 grep，应 0 命中）===")
    sample = unread[::max(1, len(unread) // 8)][:8]
    for nm in sample:
        r = subprocess.run(["grep", "-rl", nm, "evidence/", "docs/"],
                           cwd=REPO, capture_output=True, text=True)
        hits = [x for x in r.stdout.strip().splitlines() if x]
        print(f"  {nm}: {'命中 ' + str(hits[:2]) if hits else '0 命中 ✓'}")

    # K 分布
    ks = {}
    for nm in unread:
        k = k_true(nm)
        if k:
            ks[nm] = k
    dist: dict[int, int] = {}
    for k in ks.values():
        dist[k] = dist.get(k, 0) + 1
    print(f"\n=== 未读且可解析 K 的场次: {len(ks)}/{len(unread)} ===")
    print("K 分布:", dict(sorted(dist.items())))
    multi = [n for n, k in ks.items() if k >= 4]
    print(f"K>=4 的未读场次: {len(multi)}  样例={sorted(multi)[:8]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
