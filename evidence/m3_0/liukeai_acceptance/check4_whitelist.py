# LiuKeAi acceptance check 4b: empirically test _validate_whitelist hard-fail behavior
import json
import sys
from pathlib import Path

ROOT = Path(r"C:\DataFolder\codes\AI-Vidio")
sys.path.insert(0, str(ROOT / "tools" / "m3_0"))
import ir_projector  # noqa: E402

BASE_SEGMENT = {
    "clip_id": "c1", "track_id": "V1", "input_id": "I0", "asset_kind": "video",
    "source_start_us": 0, "source_end_us": 3_000_000,
    "timeline_start_us": 0, "timeline_end_us": 3_000_000,
    "layout": "fit", "speed_milli": 1000,
}


def seg(**over):
    s = json.loads(json.dumps(BASE_SEGMENT))
    s.update(over)
    return s


def plan_with(segments):
    return {
        "segments": segments,
        "inputs": [],
        "captions": {"items": []},
    }


cases = {
    "mask": plan_with([seg(mask={"enabled": True})]),
    "keying": plan_with([seg(keying={"kind": "chroma"})]),
    "reframe": plan_with([seg(reframe={"ratio": "9:16"})]),
    "rotate_keyframe": plan_with([seg(keyframes={"rotate": {"frames": [{"t_us": 0, "angle": 8}]}})]),
    "scale_keyframe": plan_with([seg(keyframes={"scale": {"frames": [{"t_us": 0, "scale": 2}]}})]),
    "dissolve_transition": plan_with([seg(transition_in={"kind": "dissolve", "duration_us": 500_000})]),
    "non_v1_keyframes": plan_with([seg(track_id="V2", keyframes={"position": {"frames": [{"t_us": 0, "x": 0.1, "y": 0.1}]}})]),
    "reverse_playback": plan_with([seg(reverse_playback=True)]),
    "caption_style_override": {
        "segments": [BASE_SEGMENT],
        "inputs": [],
        "captions": {"items": [{"caption_id": "cap1", "start_us": 0, "end_us": 1_000_000, "style_override": {"font_size": 42}}]},
    },
    # control: static PiP transform.rotate must NOT be rejected by whitelist (replicated authority behavior)
    "static_pip_rotate_CONTROL_expect_pass": {
        "segments": [
            BASE_SEGMENT,
            {**BASE_SEGMENT, "clip_id": "pip1", "track_id": "V2",
             "transform": {"scale": 0.35, "x": 0.7, "y": 0.3, "rotate": 8}},
        ],
        "inputs": [],
        "captions": {"items": []},
    },
}

results = {}
for name, plan in cases.items():
    try:
        ir_projector._validate_whitelist(plan)
        results[name] = "ACCEPTED"
    except ir_projector.IrProjectionError as exc:
        results[name] = f"REJECTED: {exc}"

for name, res in results.items():
    print(f"{name}: {res.splitlines()[0] if res.startswith('REJECTED') else res}")

# also: confirm known_approximations in archived ir.json carries defect 1 & 2
ir = json.loads((ROOT / "evidence" / "m3_0" / "p2" / "ir.json").read_text(encoding="utf-8"))
ka = ir["known_approximations"]
has_rotate = any("rotate" in k and "弧度" in k for k in ka)
has_position = any("position 关键帧链缺陷" in k for k in ka)
print(f"ir.json known_approximations entries={len(ka)} rotate_defect={has_rotate} position_defect={has_position}")
out = {"whitelist_cases": results, "known_approximations_count": len(ka),
       "rotate_defect_recorded": has_rotate, "position_defect_recorded": has_position}
(ROOT / "evidence" / "m3_0" / "liukeai_acceptance" / "check4_whitelist_result.json").write_text(
    json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
