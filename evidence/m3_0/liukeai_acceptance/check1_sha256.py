# LiuKeAi acceptance check 1: recompute all SHA-256 entries in sha256_manifest.json
import json
import sys
from pathlib import Path

ROOT = Path(r"C:\DataFolder\codes\AI-Vidio")
sys.path.insert(0, str(ROOT / "tools" / "m3_0"))
from common import sha256_file  # noqa: E402

EV = ROOT / "evidence" / "m3_0"
manifest = json.loads((EV / "sha256_manifest.json").read_text(encoding="utf-8"))

results = []
failures = []


def resolve(group: str, key: str) -> Path:
    if group == "materials":
        return EV / "materials" / f"{key}.mp4"
    return EV / key


for group in ("materials", "documents", "baselines"):
    for key, entry in manifest.get(group, {}).items():
        p = resolve(group, key)
        rec = {"group": group, "key": key, "path": str(p)}
        if not p.exists():
            rec.update(status="MISSING_FILE")
            failures.append(key)
            results.append(rec)
            continue
        actual = sha256_file(p)
        size = p.stat().st_size
        ok_hash = actual == entry["sha256"]
        ok_size = size == entry["bytes"]
        rec.update(actual_sha256=actual, expected_sha256=entry["sha256"],
                   actual_bytes=size, expected_bytes=entry["bytes"],
                   status="OK" if (ok_hash and ok_size) else
                          ("HASH_MISMATCH" if not ok_hash else "SIZE_MISMATCH"))
        if rec["status"] != "OK":
            failures.append(key)
        results.append(rec)

out = {"total": len(results), "ok": sum(1 for r in results if r["status"] == "OK"),
       "failures": failures, "results": results}
dest = EV / "liukeai_acceptance" / "check1_sha256_result.json"
dest.write_text(json.dumps(out, indent=1), encoding="utf-8")
print(f"total={out['total']} ok={out['ok']} failures={failures}")
for r in results:
    if r["status"] != "OK":
        print("FAIL:", json.dumps(r))
