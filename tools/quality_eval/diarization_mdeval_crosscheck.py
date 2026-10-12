r"""W2.2 §5.3 —— **独立仪器交叉校验**：本仓 DER 评分器 vs NIST md-eval-22.pl。

**为什么需要它**：门 §5 的判定（尤其是"AMI 的过门依赖忽略重叠口径"这条反证）
全部建立在本仓自实现的评分器 `tools/quality_eval/diarization.py` 上。
自实现口径若与社区口径系统性偏离，则**所有门限数字都不可比**，
"放宽英文最差场"这个裁决也就是建立在一个私有口径上。

本脚本用**参考实现**（NIST md-eval-22.pl，经 nryant/dscore 的 scorelib 取得）
在同一批 ref/hyp 上复算，验证两件事：

  ① **口径映射成立**：本仓 \`ignore_overlap=True\` ⇔ md-eval \`-1\`（只评单说话人区段）；
     本仓 \`ignore_overlap=False\` ⇔ md-eval 默认（含重叠，\`-o\` 为逐说话人识别口径，
     与 DER 的"含重叠"不是一回事，故本脚本对含重叠只做**趋势**比对，不做逐值断言）。
  ② **数值一致**：同一 collar（0.25 s）下两实现的 DER 差异在可解释范围内。

**边界（必须与结论同读）**：md-eval 的 UEM / collar 施加方式与本仓不同
（本仓把 collar 直接从计分帧里剔除，md-eval 用 UEM 分区），
故两实现**不追求逐位相等**，本脚本报的是**偏差量级**与**排序是否一致**。
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "tools"))

from diarization import load_rttm, score  # noqa: E402
from diarization_cache import EmbeddingCache  # noqa: E402
from diarization_cluster_routes import kmeans_cosine, pick_k_silhouette  # noqa: E402
from diarization_robustness import _windows_for  # noqa: E402

from aivs_core.media import speaker as sp  # noqa: E402

_COLLAR = 0.25


def write_rttm(path: Path, turns, *, uri: str) -> None:
    lines = []
    for start, end, spk in turns:
        dur = max(0.0, end - start)
        if dur <= 0:
            continue
        lines.append(f"SPEAKER {uri} 1 {start:.3f} {dur:.3f} <NA> <NA> {spk} <NA> <NA>")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _parse_der(txt: str) -> float:
    """从 md-eval 输出里解析 DER（返回 0–1）。**解析失败必须抛错，绝不返回 0**。

    输出形态（md-eval-22.pl 实测）::

        OVERALL SPEAKER DIARIZATION ERROR = 49.68 percent of scored speaker time  (ALL)

    带 UEM 的场景另有 `Percent Total Error       =  12.34`。两种都收，但**优先取
    `OVERALL ... (ALL)`** —— 那是全说话人合计口径，与本仓 DER 同义。
    """
    patterns = (
        r"OVERALL SPEAKER DIARIZATION ERROR\s*=\s*([\d.]+)\s*percent",
        r"Percent Total Error\s*=\s*([\d.]+)",
        r"SPEAKER DIARIZATION ERROR\s*=\s*([\d.]+)",
    )
    for pat in patterns:
        m = re.search(pat, txt)
        if m is not None:
            return float(m.group(1)) / 100.0
    raise RuntimeError(f"could not parse md-eval output:\n{txt[-2000:]}")


def run_md_eval(pl: Path, ref: Path, hyp: Path, *, extra: list[str]) -> float:
    """跑参考评分器并解析 DER（%）。"""
    with tempfile.TemporaryDirectory() as td:
        out = subprocess.run(
            ["perl", str(pl), "-r", str(ref), "-s", str(hyp), "-c", str(_COLLAR), *extra],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=td,
        )
    return _parse_der((out.stdout or "") + (out.stderr or ""))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--md-eval", default=".tmp/md-eval/md-eval-22.pl")
    ap.add_argument("--diag-json", required=True)
    ap.add_argument("--rttm-dir", required=True)
    ap.add_argument("--audio-dir", required=True)
    ap.add_argument("--audio-ext", default=".Mix-Headset.wav")
    ap.add_argument("--channel", type=int, default=None)
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--condition", default="silero_vad")
    ap.add_argument(
        "--silero", default=".venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx"
    )
    ap.add_argument("--meetings", nargs="*", default=None)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    # **必须转绝对路径**：run_md_eval 在临时目录里执行 perl，相对路径会找不到脚本。
    pl = Path(args.md_eval).resolve()
    if not pl.is_file():
        print(f"md-eval not found at {pl}; cannot cross-check", file=sys.stderr)
        return 2
    if shutil.which("perl") is None:
        print("perl not available; cannot cross-check", file=sys.stderr)
        return 2

    diag = json.loads(Path(args.diag_json).read_text(encoding="utf-8"))
    cache = EmbeddingCache(args.cache_dir)
    rttm_of: dict = {}
    for p in Path(args.rttm_dir).rglob("*.rttm"):
        rttm_of.setdefault(p.stem, p)

    names = args.meetings or sorted(diag.get("meetings", {}))
    report: dict = {
        "md_eval": str(pl),
        "condition": args.condition,
        "collar_s": _COLLAR,
        "meetings": {},
    }
    for m in names:
        e = diag["meetings"].get(m)
        if not e:
            continue
        cond = e["conditions"].get(args.condition)
        if not cond or "best" not in cond or m not in rttm_of:
            continue
        ref_turns = load_rttm(rttm_of[m])
        args.meeting = m
        wins = _windows_for(e, args.condition, e["total_s"], ref_turns, args)
        if wins is None:
            continue
        hit = cache.get(cond["cache_key"])
        if hit is None or hit[0].shape[0] != len(wins):
            continue
        vecs = hit[0]
        k, _ = pick_k_silhouette(vecs)
        lab, _ = kmeans_cosine(vecs, k)
        turns = sp.windows_to_turns(wins, lab, e["total_s"], min_turn_s=sp.MIN_TURN_S)
        hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"spk{t['speaker']}") for t in turns]

        with tempfile.TemporaryDirectory() as td:
            rp, hp = Path(td) / "ref.rttm", Path(td) / "hyp.rttm"
            write_rttm(rp, ref_turns, uri=m)
            write_rttm(hp, hyp, uri=m)
            md_ignore = run_md_eval(pl, rp, hp, extra=["-1"])
            md_default = run_md_eval(pl, rp, hp, extra=[])

        ours_ignore = score(ref_turns, hyp, total_s=e["total_s"], ignore_overlap=True).der
        ours_count = score(ref_turns, hyp, total_s=e["total_s"], ignore_overlap=False).der
        report["meetings"][m] = {
            "k": int(k),
            "n_windows": int(vecs.shape[0]),
            "ignore_overlap": {
                "ours": round(float(ours_ignore), 4),
                "md_eval_minus1": round(md_ignore, 4),
                "delta": round(md_ignore - float(ours_ignore), 4),
            },
            "count_overlap": {
                "ours": round(float(ours_count), 4),
                "md_eval_default": round(md_default, 4),
                "delta": round(md_default - float(ours_count), 4),
            },
        }
        print(
            f"[{m}] ignore ours={ours_ignore:.4f} md={md_ignore:.4f} "
            f"(d={md_ignore - ours_ignore:+.4f}) | count ours={ours_count:.4f} "
            f"md={md_default:.4f} (d={md_default - ours_count:+.4f})",
            flush=True,
        )
        Path(args.out).write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    rows = list(report["meetings"].values())
    if rows:
        di = np.array([r["ignore_overlap"]["delta"] for r in rows])
        dc = np.array([r["count_overlap"]["delta"] for r in rows])
        oi = np.array([r["ignore_overlap"]["ours"] for r in rows])
        mi = np.array([r["ignore_overlap"]["md_eval_minus1"] for r in rows])
        report["summary"] = {
            "n": len(rows),
            "ignore": {
                "mean_delta": round(float(di.mean()), 4),
                "max_abs_delta": round(float(np.abs(di).max()), 4),
                "pearson_r": round(float(np.corrcoef(oi, mi)[0, 1]), 4),
            },
            "count": {
                "mean_delta": round(float(dc.mean()), 4),
                "max_abs_delta": round(float(np.abs(dc).max()), 4),
            },
            "same_ordering": bool(
                sorted(range(len(rows)), key=lambda i: oi[i])
                == sorted(range(len(rows)), key=lambda i: mi[i])
            ),
        }
        print(f"\n=== SUMMARY n={report['summary']['n']} ===")
        print(
            f"  ignore: mean_delta={report['summary']['ignore']['mean_delta']:+.4f} "
            f"max|d|={report['summary']['ignore']['max_abs_delta']:.4f} "
            f"r={report['summary']['ignore']['pearson_r']:.3f}"
        )
        print(
            f"  count : mean_delta={report['summary']['count']['mean_delta']:+.4f} "
            f"max|d|={report['summary']['count']['max_abs_delta']:.4f}"
        )
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
