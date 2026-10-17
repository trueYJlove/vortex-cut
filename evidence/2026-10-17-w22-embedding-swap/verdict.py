"""换模型对照的判定（诊断级，非立门）。

问题：CAM++ -> ResNet34，在 P136 同一批困难场上是否改善？
分组必报：全部 / K_true=1 子集 / 其他。
"""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
rows = json.loads((HERE / "result.json").read_text(encoding="utf-8"))
ok = [r for r in rows if r["campplus"]["der"] is not None and r["resnet34"]["der"] is not None]
print(f"配对场次 = {len(ok)} / {len(rows)}")

def summ(sub, label):
    a = np.array([r["campplus"]["der"] for r in sub], dtype=float)
    b = np.array([r["resnet34"]["der"] for r in sub], dtype=float)
    d = a - b
    print(f"\n=== {label} (n={len(sub)}) ===")
    print(f"  CAM++   : 均值={a.mean():.4f} 最差={a.max():.4f}")
    print(f"  RESNET34: 均值={b.mean():.4f} 最差={b.max():.4f}")
    print(f"  delta(mean)={a.mean()-b.mean():+.4f} (>0 表示 ResNet34 更好)")
    print(f"  逐场: 改善={(d>1e-9).sum()} 持平={(np.abs(d)<=1e-9).sum()} 退化={(d<-1e-9).sum()}")
    return a, b, d

a_all, b_all, d_all = summ(ok, "全部")
k1 = [r for r in ok if r["k_true"] == 1]
multi = [r for r in ok if r["k_true"] >= 2]
if k1: summ(k1, "K_true=1（过分割重灾区）")
if multi: summ(multi, "K_true>=2")

print("\n=== 关键：K_true=1 场的 K̂ 是否变好？ ===")
for r in k1:
    print(f"  {r['meeting']:<8} CAM++ K̂={r['campplus']['k']:<2} DER={r['campplus']['der']:.4f} "
          f"| RES K̂={r['resnet34']['k']:<2} DER={r['resnet34']['der']:.4f}")

print("\n=== 判别力摘要（若换模型能区分 K=1，应在此体现）===")
wrong_cam = sum(1 for r in k1 if r["campplus"]["k"] is not None and r["campplus"]["k"] > 2)
wrong_res = sum(1 for r in k1 if r["resnet34"]["k"] is not None and r["resnet34"]["k"] > 2)
print(f"  K_true=1 中被过度分割(K̂>2): CAM++ {wrong_cam}/{len(k1)}  RESNET34 {wrong_res}/{len(k1)}")

out = {
  "n_paired": len(ok),
  "all": {"campplus_mean": round(float(a_all.mean()),4), "campplus_worst": round(float(a_all.max()),4),
          "resnet34_mean": round(float(b_all.mean()),4), "resnet34_worst": round(float(b_all.max()),4),
          "delta_mean": round(float(a_all.mean()-b_all.mean()),4),
          "better": int((d_all>1e-9).sum()), "worse": int((d_all<-1e-9).sum()),
          "equal": int((np.abs(d_all)<=1e-9).sum())},
  "k1_overseg_campplus": wrong_cam, "k1_overseg_resnet34": wrong_res, "k1_n": len(k1),
}
if k1:
    a=np.array([r["campplus"]["der"] for r in k1]); b=np.array([r["resnet34"]["der"] for r in k1])
    out["ktrue1"] = {"campplus_mean": round(float(a.mean()),4), "campplus_worst": round(float(a.max()),4),
                     "resnet34_mean": round(float(b.mean()),4), "resnet34_worst": round(float(b.max()),4)}
(HERE / "verdict.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
print("\n落盘 -> verdict.json")
