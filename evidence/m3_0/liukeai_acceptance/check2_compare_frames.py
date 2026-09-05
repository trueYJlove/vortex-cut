# LiuKeAi acceptance check 2: frame-by-frame diff of recomputed comparison vs archived
import json
from pathlib import Path

ROOT = Path(r"C:\DataFolder\codes\AI-Vidio")
EV = ROOT / "evidence" / "m3_0"
arch = json.loads((EV / "p2" / "baseline" / "comparison.json").read_text(encoding="utf-8"))
rec = json.loads((EV / "liukeai_acceptance" / "p2_comparison_recompute.json").read_text(encoding="utf-8"))

arch_frames = {f["n"]: f for f in arch["frames"]}
rec_frames = {f["n"]: f for f in rec["frames"]}

assert set(arch_frames) == set(rec_frames), (
    f"frame set mismatch: arch-only={sorted(set(arch_frames)-set(rec_frames))} "
    f"rec-only={sorted(set(rec_frames)-set(arch_frames))}")

diffs = []
for n in sorted(arch_frames):
    a, r = arch_frames[n], rec_frames[n]
    for field in ("psnr_db", "psnr_vs_second_ref_db"):
        av, rv = a.get(field), r.get(field)
        if av is None and rv is None:
            continue
        if av is None or rv is None or abs(av - rv) > 1e-9:
            diffs.append({"n": n, "field": field, "archived": av, "recomputed": rv})
    for field in ("ssim", "psnr_raw"):
        if json.dumps(a.get(field), sort_keys=True) != json.dumps(r.get(field), sort_keys=True):
            diffs.append({"n": n, "field": field, "archived": a.get(field), "recomputed": r.get(field)})
    if a.get("shift") != r.get("shift"):
        diffs.append({"n": n, "field": "shift", "archived": a.get("shift"), "recomputed": r.get("shift")})
    cm_a, cm_r = a.get("caption_metric"), r.get("caption_metric")
    if (cm_a is None) != (cm_r is None):
        diffs.append({"n": n, "field": "caption_metric_presence", "archived": cm_a is not None, "recomputed": cm_r is not None})
    elif cm_a is not None:
        if abs(cm_a["text_mask_iou"] - cm_r["text_mask_iou"]) > 1e-9:
            diffs.append({"n": n, "field": "caption_iou", "archived": cm_a["text_mask_iou"], "recomputed": cm_r["text_mask_iou"]})
        if cm_a.get("center_offset_px") != cm_r.get("center_offset_px"):
            diffs.append({"n": n, "field": "caption_center_offset", "archived": cm_a.get("center_offset_px"), "recomputed": cm_r.get("center_offset_px")})
        if cm_a.get("bbox_gl") != cm_r.get("bbox_gl") or cm_a.get("bbox_ffmpeg") != cm_r.get("bbox_ffmpeg"):
            diffs.append({"n": n, "field": "caption_bbox", "archived": {k: cm_a.get(k) for k in ("bbox_gl", "bbox_ffmpeg")}, "recomputed": {k: cm_r.get(k) for k in ("bbox_gl", "bbox_ffmpeg")}})
        if abs(cm_a.get("fullframe_diff_ratio_gt10", -1) - cm_r.get("fullframe_diff_ratio_gt10", -1)) > 1e-9:
            diffs.append({"n": n, "field": "caption_diff_ratio", "archived": cm_a.get("fullframe_diff_ratio_gt10"), "recomputed": cm_r.get("fullframe_diff_ratio_gt10")})
    if a.get("caption") != r.get("caption"):
        diffs.append({"n": n, "field": "caption_flag", "archived": a.get("caption"), "recomputed": r.get("caption")})

# verdict comparison
va, vr = arch["verdict"], rec["verdict"]
verdict_cmp = {}
for k in ("non_caption_frames", "caption_frames", "psnr_min_db", "psnr_all_pass",
          "misalign_max_px", "misalign_all_pass", "pass"):
    verdict_cmp[k] = {"archived": va.get(k), "recomputed": vr.get(k),
                      "equal": va.get(k) == vr.get(k)}

out = {
    "frames_compared": len(arch_frames),
    "field_diff_count": len(diffs),
    "diffs": diffs,
    "verdict": verdict_cmp,
}
dest = EV / "liukeai_acceptance" / "check2_frame_diff_result.json"
dest.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
print(f"frames_compared={out['frames_compared']} field_diff_count={len(diffs)}")
print(json.dumps(verdict_cmp, indent=1))
if diffs:
    print("DIFFS (first 30):")
    for d in diffs[:30]:
        print(" ", json.dumps(d))
