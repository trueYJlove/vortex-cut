"""查明：.tmp/voxconverse 下各目录的角色，以及 audio（216）里哪些**已被读过**。

"未读"是本轮新预登记的前提，不能猜。逐个 JSON 提取 selected 名单后做集合运算。
"""
from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
V = REPO / ".tmp/voxconverse"


def names_from(obj) -> set[str]:
    """从各种形状里抽出会议名（列表/字典/嵌套 [[name, dur], ...]）。"""
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


def main() -> int:
    audio = {p.stem for p in (V / "audio").glob("*.wav")}
    lowk_dir = {p.stem for p in (V / "test_lowk").glob("*.wav")}
    judge_dir = {p.stem for p in (V / "judge_set").glob("*.wav")}
    dev_dir = {p.stem for p in (V / "dev_audio").glob("*.wav")}
    rttm = {p.stem for p in (V / "rttm").rglob("*.rttm")}
    print(f"目录：audio={len(audio)} test_lowk={len(lowk_dir)} judge_set={len(judge_dir)} "
          f"dev_audio={len(dev_dir)}")
    print(f"RTTM 总数={len(rttm)}")

    files = [
        ".tmp/vc-subset-judge.json",
        "evidence/2026-10-12-w22-f-voxconverse-lowk/subset-lowk.json",
        "evidence/2026-10-12-w22-f-voxconverse-lowk/subset-highk.json",
        "evidence/2026-10-13-w22-g-voxconverse-test-lowk/subset-lowk.json",
    ]
    read_all: set[str] = set()
    for f in files:
        p = REPO / f
        if not p.is_file():
            print(f"  (缺) {f}")
            continue
        obj = json.loads(p.read_text(encoding="utf-8"))
        nm = names_from(obj)
        # 过滤掉档位标签之类的非会议名
        nm = {n for n in nm if n and not n[0].isdigit() and len(n) >= 4}
        print(f"  {p.name}: {len(nm)} 个名字  样例={sorted(nm)[:5]}")
        read_all |= nm

    print()
    print(f"记录到的已读合计 = {len(read_all)}")
    for label, pool in (("audio(216)", audio), ("test_lowk", lowk_dir), ("judge_set", judge_dir)):
        print(f"  {label}: 池内已读={len(pool & read_all)}  池内未读={len(pool - read_all)}")
    print()
    unread = audio - read_all
    print(f"*** audio 内未读 = {len(unread)} ***")
    print("未读样例:", sorted(unread)[:12])
    print(f"未读且有 RTTM = {len(unread & rttm)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
