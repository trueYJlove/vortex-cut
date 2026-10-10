"""负向对照：证明 `validate_fbank.py` 的"逐值等价"断言**有区分力**（而非恒真）。

本项目纪律（AGENTS.md / 多轮评审教训）：每条断言都要有"把它弄错就会红"的对照，
否则断言可能因为容差过松、口径错配或分支永不触发而恒真。

做法：对纯 numpy 前端注入 5 组**已知会破坏等价性**的缺陷，断言每一组的 max |Δ|
都超过 `DEFECT_FLOOR`（0.1）。若某组仍然"通过"，说明对拍形同虚设。

判据说明（2026-10-10 评审修正）：**不用"基线的 N 倍"作判据**——基线本身在 1e-3 量级，
比值几乎恒真，单独用等于没有判据。比值只在输出里作可读性参考。

NC4 的语义（**易被误读，特此写明**）：它检验的是「分帧口径取反 ⇒ 帧错位 ⇒ 逐帧对拍失败」，
**不是**"fbank 系数算错"。它与门文档 §2.6「两口径各自自洽时下游指标差异在噪声级」是两件事：
前者说明对拍对帧对齐极敏感，后者说明口径选错对下游不致命。

用法：
    PYTHONPATH=tools .tmp/spike-venv/Scripts/python.exe \
        tools/spikes/w22_speaker/negative_controls.py <媒体> [--seconds 20]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from spikes.w22_speaker import fbank as fb  # noqa: E402
from spikes.w22_speaker.audio import decode_mono16k  # noqa: E402
from spikes.w22_speaker.fbank import compute_fbank  # noqa: E402
from spikes.w22_speaker.validate_fbank import knf_fbank  # noqa: E402

# 阈值：正确实现的 max|Δ| 实测在 1e-3 量级（float32 舍入）；任何真缺陷都应远超它。
DEFECT_FLOOR = 1e-1


def _slaney_mel(freq):
    """Slaney/HTK 之外的另一种 mel 标度——用错即破坏与模型的训练口径。"""
    f = np.asarray(freq, dtype=np.float64)
    linear = f / (200.0 / 3.0)
    log_step = np.log(6.4) / 27.0
    with np.errstate(divide="ignore"):
        log_part = 15.0 + np.log(f / 1000.0) / log_step
    return np.where(f < 1000.0, linear, log_part)


def measure(samples: np.ndarray) -> dict[str, float]:
    ref = knf_fbank(samples, snip_edges=False)
    out: dict[str, float] = {}

    def delta(mine: np.ndarray) -> float:
        n = min(mine.shape[0], ref.shape[0])
        if n == 0 or mine.shape[1] != ref.shape[1]:
            return float("inf")
        return float(np.abs(mine[:n] - ref[:n]).max())

    out["baseline_correct"] = delta(compute_fbank(samples, snip_edges=False))

    # NC1：mel 标度换成 Slaney
    original_scale = fb.mel_scale
    fb.mel_scale = _slaney_mel
    try:
        out["NC1_slaney_mel_scale"] = delta(compute_fbank(samples, snip_edges=False))
    finally:
        fb.mel_scale = original_scale

    # NC2：去掉预加重
    out["NC2_no_preemphasis"] = delta(compute_fbank(samples, snip_edges=False, preemph_coeff=0.0))

    # NC3：窗函数换成 hamming（Kaldi 缺省是 povey）
    out["NC3_hamming_window"] = delta(
        compute_fbank(samples, snip_edges=False, window_type="hamming")
    )

    # NC4：分帧口径错（该用 snip_edges=False 却用 True）
    out["NC4_wrong_snip_edges"] = delta(compute_fbank(samples, snip_edges=True))

    # NC5：不做去直流
    out["NC5_no_dc_removal"] = delta(
        compute_fbank(samples, snip_edges=False, remove_dc_offset=False)
    )

    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("--seconds", type=float, default=20.0)
    args = ap.parse_args()

    samples = decode_mono16k(args.media, 0.0, args.seconds)
    res = measure(samples)

    base = res["baseline_correct"]
    passed = True
    lines = []
    for key, value in res.items():
        if key == "baseline_correct":
            ok = value < 1e-2
            verdict = "✅ 等价" if ok else "❌ 基线就不等价"
            lines.append(f"  {key:26s} max|Δ| = {value:.3e}  {verdict}")
            passed &= ok
            continue
        ratio = value / max(base, 1e-12)
        # 判据**只**由 DEFECT_FLOOR 承担：比值因基线极小（1e-3 量级）而近乎恒真，
        # 单独用它等于没有判据（2026-10-10 评审发现）。比值仅作可读性展示。
        ok = value >= DEFECT_FLOOR
        lines.append(
            f"  {key:26s} max|Δ| = {value:.3e}  （基线的 {ratio:,.0f}×，仅供参考）  "
            f"{'✅ 被抓出' if ok else '❌ 未被抓出——对拍无区分力'}"
        )
        passed &= ok

    report = {
        "media": Path(args.media).name,
        "seconds": args.seconds,
        "defect_floor": DEFECT_FLOOR,
        "results": res,
        "all_defects_detected": bool(passed),
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    print("\n".join(lines), file=sys.stderr)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
