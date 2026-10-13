"""G1 的残余最差场来自哪里？并检验 `structural_safety` 闸门对**上限型**规则的盲区。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "quality_eval"))
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))

from diarization_param_sweep import structural_safety  # noqa: E402

d = json.loads(Path(".tmp/spike-combined.json").read_text(encoding="utf-8"))
per = d["corpora"]["vc-test-lowk"]["meetings"]

print("=== G1 未改善的场（G1 DER == A0 DER 且都很大）===")
for name, v in sorted(per.items(), key=lambda kv: -kv[1]["G1"]["der"])[:6]:
    print("  %-8s K_true=%d K_hat=%d | A0 K=%d DER=%.4f | G1 K=%d DER=%.4f | G1空窗回退=%s"
          % (name, v["k_true"], v["k_hat_dm"], v["A0"]["k"], v["A0"]["der"],
             v["G1"]["k"], v["G1"]["der"], v.get("g1_fallback")))

print()
print("=== 结构性检验：G1 的上限会不会把正确答案挡在门外？===")
excluded = [n for n, v in per.items() if v["k_hat_dm"] < v["k_true"]]
print("  K_hat_dm < K_true 的场次: %d/%d  => 这些场的真值 K 超出 G1 的候选上限" % (len(excluded), len(per)))
if excluded:
    print("  ", excluded[:10])

print()
print("=== 现有 structural_safety 闸门对「上限型」规则的判定 ===")

def floor_rule(grid, k_hint):
    """B1 型：下限 K >= k_hint。"""
    return [g for g in grid if g["sil"] is not None and g["k"] >= k_hint]

def ceiling_rule(grid, k_hint):
    """G1 型：上限 K <= k_hint（闸门按惯例把真值当 hint 传入）。"""
    return [g for g in grid if g["sil"] is not None and g["k"] <= k_hint]

def unsafe_floor(grid, k_hint):
    """已知不安全的对照：常数下限 K >= 4。"""
    return [g for g in grid if g["sil"] is not None and g["k"] >= 4]

for label, rule in (("B1 下限 K>=hint", floor_rule),
                    ("G1 上限 K<=hint", ceiling_rule),
                    ("B3 常数下限 K>=4（已知不安全）", unsafe_floor)):
    res = structural_safety(rule)
    print("  %-30s safe=%s" % (label, res["safe"]))
