# LiuKeAi acceptance check 3: verify ADR-1 five criteria directly from comparison.json
import json
from pathlib import Path

ROOT = Path(r"C:\DataFolder\codes\AI-Vidio")
EV = ROOT / "evidence" / "m3_0"
comp = json.loads((EV / "p2" / "baseline" / "comparison.json").read_text(encoding="utf-8"))
frames = comp["frames"]

non_cap = [f for f in frames if not f.get("caption") and "error" not in f]
caps = [f for f in frames if f.get("caption") and "error" not in f]

# --- Criterion 1: geometry misalignment = 0px on all non-caption frames (±8px window)
misalign = [(f["n"], f["shift"]["dx"], f["shift"]["dy"]) for f in non_cap]
c1_bad = [m for m in misalign if m[1] != 0 or m[2] != 0]
c1 = {"non_caption_count": len(non_cap), "all_zero": not c1_bad, "violations": c1_bad,
      "caption_frame_shifts_nonzero": [(f["n"], f["shift"]) for f in caps if (f["shift"]["dx"], f["shift"]["dy"]) != (0, 0)]}

# --- Criterion 3: PSNR regression baseline >=19dB non-caption; buckets
psnrs = [(f["n"], f["psnr_db"], f.get("overlays", 0)) for f in non_cap]
psnr_vals = [p for _, p, _ in psnrs]
no_pip = [p for n, p, ov in psnrs if ov == 0]
with_pip = [(n, p) for n, p, ov in psnrs if ov > 0]
c3 = {
    "non_caption_psnr_min": min(psnr_vals), "non_caption_psnr_max": max(psnr_vals),
    "min_frame": min(psnrs, key=lambda x: x[1]),
    "ge19_all": all(p >= 19.0 for p in psnr_vals),
    "no_pip_bucket_min": min(no_pip) if no_pip else None,
    "no_pip_ge31": all(p >= 31.0 for p in no_pip),
    "pip_bucket": sorted(with_pip, key=lambda x: x[1])[:6],
}
# frames with speed!=1 or overlays -> pip/fast bucket >=19 (checked via ge19_all)

# --- Criterion 4: captions IoU >=0.35, center offset <=8px
cm = [(f["n"], f["caption_metric"]) for f in caps]
ious = [v["text_mask_iou"] for _, v in cm]
offs = []
for n, v in cm:
    o = v.get("center_offset_px")
    offs.append((n, o, max(abs(o[0]), abs(o[1])) if o else None))
c4 = {
    "caption_count": len(cm), "iou_min": min(ious), "iou_max": max(ious), "iou_ge_035": all(i >= 0.35 for i in ious),
    "center_offset_max": max(o for _, _, o in offs if o is not None),
    "offset_le_8": all((o is None) or (abs(o[0]) <= 8 and abs(o[1]) <= 8) for _, o, _ in offs),
    "offsets": offs,
}

# --- the 15.1dB question: which frame has 15.13 and is it caption?
f1590 = next(f for f in frames if f["n"] == 1590)
n1590 = {"n": 1590, "caption": f1590.get("caption"), "psnr_db": f1590.get("psnr_db"),
         "iou": f1590.get("caption_metric", {}).get("text_mask_iou") if f1590.get("caption_metric") else None}

# caption-frame psnr range (not counted in gate)
cap_psnrs = [f["psnr_db"] for f in caps]
out = {
    "c1": c1, "c3": c3, "c4": c4, "caption_psnr_min": min(cap_psnrs), "caption_psnr_max": max(cap_psnrs),
    "n1590": n1590,
}
dest = EV / "liukeai_acceptance" / "check3_adr1_result.json"
dest.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
print(json.dumps(out, indent=1, ensure_ascii=False))
