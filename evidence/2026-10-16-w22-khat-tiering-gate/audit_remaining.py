"""清点「仍然未读」的场次 —— 修正版（消除解析器 bug）。

**上一版 bug（已定位）**：`names_from` 对形如 `{"name": {"k_true":2,"dur":...}}` 的清单
只添加**内层键**（"k_true"/"dur"），**从未添加外层会议名** ⇒ 已消费的场次被误判为未读。

**修正做法**：收集**所有字符串与所有字典键**作为候选，最后与 `audio` 目录**取交集**——
非会议名的垃圾键（"k_true"、"selection_rule"…）不在 audio 里，自动被剔除。
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
V = REPO / ".tmp/voxconverse"
FFPROBE = REPO / "resources/ffmpeg/win-x64/ffprobe.exe"

READ_SOURCES = (
    ".tmp/vc-subset-judge.json",
    "evidence/2026-10-12-w22-f-voxconverse-lowk/subset-lowk.json",
    "evidence/2026-10-12-w22-f-voxconverse-lowk/subset-highk.json",
    "evidence/2026-10-16-w22-separability-recalib/unread-manifest.json",
    "evidence/2026-10-16-w22-lowk-scenario-gate/unread-lowk-manifest.json",
)


def candidates(obj) -> set[str]:
    """所有字符串 + 所有字典键（**不做**"值是标量就加键"的判断——那正是上版 bug）。"""
    out: set[str] = set()

    def walk(o):
        if isinstance(o, str):
            out.add(o.split(".")[0])
        elif isinstance(o, list):
            for x in o:
                walk(x)
        elif isinstance(o, dict):
            for k, v in o.items():
                out.add(str(k).split(".")[0])
                walk(v)
    walk(obj)
    return out


def main() -> int:
    audio = {p.stem for p in (V / "audio").glob("*.wav")}
    read_raw: set[str] = set()
    per_source = {}
    for f in READ_SOURCES:
        p = REPO / f
        if p.is_file():
            c = candidates(json.loads(p.read_text(encoding="utf-8")))
            per_source[f] = len(c & audio)
            read_raw |= c
    read_raw |= {p.stem for p in (V / "test_lowk").glob("*.wav")}
    read_raw |= {p.stem for p in (V / "judge_set").glob("*.wav")}
    read = read_raw & audio      # 关键：非会议名自动剔除

    print("=== 各来源贡献（与 audio 取交集后）===")
    for f, n in per_source.items():
        print(f"  {f}: {n}")
    print(f"  test_lowk 目录: {len({p.stem for p in (V/'test_lowk').glob('*.wav')} & audio)}")
    print(f"  judge_set 目录: {len({p.stem for p in (V/'judge_set').glob('*.wav')} & audio)}")
    print(f"\naudio 全集={len(audio)}  已读(并集∩audio)={len(read)}")

    unread = sorted(audio - read)
    print(f"*** 未读 = {len(unread)} ***")

    rttm = {p.stem: p for p in (V / "rttm").rglob("*.rttm")}
    rows = []
    for nm in unread:
        p = rttm.get(nm)
        if not p:
            continue
        spk = set()
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            f = line.split()
            if len(f) >= 8 and f[0] == "SPEAKER":
                spk.add(f[7])
        r = subprocess.run([str(FFPROBE), "-v", "error", "-show_entries",
                            "format=duration", "-of", "csv=p=0",
                            str(V / "audio" / f"{nm}.wav")],
                           capture_output=True, text=True)
        try:
            dur = float(r.stdout.strip())
        except ValueError:
            dur = 0.0
        rows.append({"name": nm, "k_true": len(spk), "dur": round(dur, 1)})

    print(f"\n{'K_true':>6} | {'总数':>4} | {'>=120s':>7} | {'60-120s':>7} | {'<60s':>5}")
    for k in sorted({r["k_true"] for r in rows}):
        g = [r for r in rows if r["k_true"] == k]
        print(f"{k:>6} | {len(g):>4} | "
              f"{sum(1 for r in g if r['dur'] >= 120):>7} | "
              f"{sum(1 for r in g if 60 <= r['dur'] < 120):>7} | "
              f"{sum(1 for r in g if r['dur'] < 60):>5}")

    lowk = [r for r in rows if r["k_true"] <= 2]
    print(f"\nK_true<=2 未读 = {len(lowk)} "
          f"(>=120s: {sum(1 for r in lowk if r['dur'] >= 120)}; "
          f"K_true=1 总计: {sum(1 for r in rows if r['k_true'] == 1)})")

    out = REPO / ".tmp" / "unread-remaining.json"
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"落盘 -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
