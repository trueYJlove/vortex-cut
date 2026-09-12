# LiuKeAi acceptance check 5: P3 statistics recomputation + mulberry32 uniform target replay
import json
import math
from pathlib import Path

ROOT = Path(r"C:\DataFolder\codes\AI-Vidio")
EV = ROOT / "evidence" / "m3_0"
r = json.loads((EV / "p3" / "m3p3_result.json").read_text(encoding="utf-8"))

SEED = 20260905


def mulberry32(seed):
    a = seed & 0xFFFFFFFF

    def rng():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = ((a ^ (a >> 15)) * (1 | a)) & 0xFFFFFFFF          # Math.imul(a ^ a>>>15, 1|a)
        u = ((t ^ (t >> 7)) * (61 | t)) & 0xFFFFFFFF          # Math.imul(t ^ t>>>7, 61|t)
        t = (((t + u) & 0xFFFFFFFF) ^ t) & 0xFFFFFFFF         # t + imul(...) ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return rng


def percentile(values, p):
    if not values:
        return float("nan")
    s = sorted(values)
    rank = (p / 100) * (len(s) - 1)
    low, high = math.floor(rank), math.ceil(rank)
    if low == high:
        return s[low]
    return s[low] + (s[high] - s[low]) * (rank - low)


def round3(v):
    return math.floor(v * 1000 + 0.5) / 1000 if v >= 0 else -math.floor(-v * 1000 + 0.5) / 1000


def summarize(values):
    return {"count": len(values), "p50": round3(percentile(values, 50)),
            "p95": round3(percentile(values, 95)), "max": round3(max(values)),
            "mean": round3(sum(values) / len(values))}


problems = []
report_rows = []

real = [x for x in r["results"] if len(x.get("samples", [])) > 0]
print(f"result entries: {len(r['results'])} total, {len(real)} with samples")

# --- per-path stat recomputation
for entry in real:
    samples = entry["samples"]
    lat = [s["latency_ms"] for s in samples if s["latency_ms"] >= 0]
    rec_all = summarize(lat)
    rec_cold = summarize(lat[:10])
    rec_hot = summarize(lat[10:])
    fails_recomputed = sum(1 for s in samples if s["latency_ms"] < 0)
    pts_recomputed = sum(1 for s in samples if s.get("media_time_dev_frames") is not None and s["media_time_dev_frames"] > 1.02)
    checks = {
        "latency_ms_all": (rec_all, entry["latency_ms_all"]),
        "latency_ms_cold": (rec_cold, entry["latency_ms_cold"]),
        "latency_ms_hot": (rec_hot, entry["latency_ms_hot"]),
    }
    row = {"material": entry["material"], "path": entry["path"], "n_samples": len(samples)}
    for name, (rec, arch) in checks.items():
        for k in ("count", "p50", "p95", "max", "mean"):
            rv, av = rec.get(k), arch.get(k)
            if rv is None and (av is None or (isinstance(av, float) and math.isnan(av))):
                continue
            if av is None or (isinstance(av, float) and math.isnan(av)) or abs(rv - av) > 0.0011:
                problems.append(f"{entry['material']}/{entry['path']}/{name}.{k}: recomputed={rv} archived={av}")
    row.update(p50=rec_all["p50"], p95=rec_all["p95"], max=rec_all["max"])
    row["failures_field"] = entry["failures"]; row["failures_recomputed"] = fails_recomputed
    if entry["failures"] != fails_recomputed:
        problems.append(f"{entry['material']}/{entry['path']}/failures: field={entry['failures']} recomputed={fails_recomputed}")
    row["pts_field"] = entry["pts_dev_over_1frame"]
    if entry["path"].startswith("webcodecs"):
        row["pts_recomputed"] = pts_recomputed
        if entry["pts_dev_over_1frame"] != pts_recomputed:
            problems.append(f"{entry['material']}/{entry['path']}/pts: field={entry['pts_dev_over_1frame']} recomputed={pts_recomputed}")
        row["black_frames"] = entry["black_frames"]
    else:
        row["pts_recomputed"] = "n/a (dev not recorded in html5 samples)"
    max_dev = max((s.get("media_time_dev_frames", -1) for s in samples if s.get("media_time_dev_frames") is not None), default=None)
    row["max_pts_dev_observed"] = max_dev
    report_rows.append(row)

# --- uniform target replay per material
by_material = {}
for entry in real:
    by_material.setdefault(entry["material"], []).append(entry)

replay_out = {}
for material, entries in by_material.items():
    kind0 = [s["target_frame"] for s in entries[0]["samples"] if s["kind"] == 0]
    first92 = [s for s in entries[0]["samples"][:92]]
    kinds_first92 = {s["kind"] for s in first92}
    match_n = None
    for n in range(60, 4001):
        rng = mulberry32(SEED)
        ok = True
        for s in first92:
            expect = min(n - 1, math.floor(rng() * n))
            if s["target_frame"] != expect:
                ok = False
                break
        if ok:
            match_n = n
            break
    # target set identical across paths?
    sets_equal = all([s["target_frame"] for s in e["samples"]] == [s["target_frame"] for s in entries[0]["samples"]] for e in entries[1:])
    tail = entries[0]["samples"][92:]
    replay_out[material] = {"uniform_count": len(kind0), "first92_all_kind0": kinds_first92 == {0},
                            "matched_duration_frames": match_n, "targets_equal_across_paths": sets_equal,
                            "tail_kind1_frames": [s["target_frame"] for s in tail],
                            "tail_kinds": [s["kind"] for s in tail]}
    if match_n is None:
        problems.append(f"{material}: no durationFrames N reproduces the 92 uniform targets")
    if not sets_equal:
        problems.append(f"{material}: target sets differ across paths")
    if kinds_first92 != {0}:
        problems.append(f"{material}: first 92 samples not all kind=0")

print(json.dumps(report_rows, indent=1, ensure_ascii=False))
print(json.dumps(replay_out, indent=1, ensure_ascii=False))
print("PROBLEMS:", problems if problems else "none")

# --- gate check (frozen criteria): WC & WC+cache p95<=100, failures/pts/black = 0
gate_rows = []
for row in report_rows:
    if row["path"].startswith("webcodecs"):
        gate_rows.append({"material": row["material"], "path": row["path"], "p95": row["p95"],
                          "p95_le_100": row["p95"] <= 100, "failures": row["failures_field"],
                          "pts": row["pts_field"], "black": row.get("black_frames")})
gate_pass = all(g["p95_le_100"] and g["failures"] == 0 and g["pts"] == 0 and g["black"] == 0 for g in gate_rows)
print("GATE:", "PASS" if gate_pass else "FAIL", json.dumps(gate_rows, indent=1))

out = {"rows": report_rows, "replay": replay_out, "problems": problems, "gate": gate_rows, "gate_pass": gate_pass}
(EV / "liukeai_acceptance" / "check5_p3_result.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
