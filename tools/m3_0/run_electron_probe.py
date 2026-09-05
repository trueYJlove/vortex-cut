"""M3-0 探针运行器：注入 AIVS_M3_PROBE 环境变量组并启动 Electron dev。

用法：
  python run_electron_probe.py m3p2 --ir <ir.json> --sample <sample.json> --evidence <dir> [--assets <manifest.json>]
  python run_electron_probe.py m3p1 --evidence <dir>
  python run_electron_probe.py m3p3 --evidence <dir>
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DESKTOP = REPO / "apps" / "desktop"
MATERIALS = REPO / "evidence" / "m3_0" / "materials"
FONTS = REPO / "resources" / "fonts"


def build_manifest(path: Path) -> None:
    assets = []
    for entity in ["asset_m3_a", "asset_m3_b", "asset_m3_c", "asset_m3_p1", "asset_m3_p2"]:
        name = entity.replace("asset_m3_", "m3mat_") + "_1080.mp4"
        assets.append({"entity_id": entity, "path": str(MATERIALS / name), "display_name": name})
    assets.append({"entity_id": "m3font", "path": str(FONTS / "noto-sans-sc" / "NotoSansCJKsc-VF.ttf"), "display_name": "Noto Sans CJK SC"})
    assets.append({"entity_id": "m3mat_a_540", "path": str(MATERIALS / "m3mat_a_540.mp4"), "display_name": "m3mat_a_540"})
    assets.append({"entity_id": "m3mat_a_1080", "path": str(MATERIALS / "m3mat_a_1080.mp4"), "display_name": "m3mat_a_1080"})
    assets.append({"entity_id": "m3proxy_ref_vfr", "path": str(MATERIALS / "m3proxy_ref_vfr-landscape-av.mp4"), "display_name": "m3proxy_ref_vfr"})
    assets.append({"entity_id": "m3proxy_ref_cfr", "path": str(MATERIALS / "m3proxy_ref_cfr-landscape-av.mp4"), "display_name": "m3proxy_ref_cfr"})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"assets": assets}, ensure_ascii=False, indent=1), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("probe", choices=["m3p1", "m3p2", "m3p3"])
    parser.add_argument("--ir", default=None)
    parser.add_argument("--sample", default=None)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--assets", default=None)
    parser.add_argument("--calibration", action="store_true", help="m3p2 校准运行：跳过字体")
    args = parser.parse_args()

    manifest_path = Path(args.assets) if args.assets else Path(args.evidence) / "assets.manifest.json"
    if not manifest_path.is_file():
        build_manifest(manifest_path)
    env = os.environ | {
        "AIVS_M3_PROBE": args.probe,
        "AIVS_M3_PROBE_ASSETS": str(manifest_path.resolve()),
        "AIVS_M3_PROBE_EVIDENCE": str(Path(args.evidence).resolve()),
    }
    if args.ir:
        env["AIVS_M3_PROBE_IR"] = str(Path(args.ir).resolve())
    if os.environ.get("AIVS_M3_PROBE_MIPMAP") is not None:
        # 性能 A/B：mipmap=0 时主进程在注入 ?probe= 的同时追加 &mipmap=0
        env["AIVS_M3_PROBE_MIPMAP"] = os.environ["AIVS_M3_PROBE_MIPMAP"]
    if args.sample:
        env["AIVS_M3_PROBE_SAMPLE"] = str(Path(args.sample).resolve())
    if args.calibration:
        # 校准运行：仅需色卡素材（无字幕 → 不需要字体）
        assets = [{"entity_id": "asset_card", "path": str((MATERIALS / "m3card_1080.mp4").resolve()), "display_name": "m3card_1080"}]
        calibration_manifest = manifest_path.parent / "assets.manifest.calibration.json"
        calibration_manifest.parent.mkdir(parents=True, exist_ok=True)
        calibration_manifest.write_text(json.dumps({"assets": assets}, ensure_ascii=False, indent=1), encoding="utf-8")
        env["AIVS_M3_PROBE_ASSETS"] = str(calibration_manifest.resolve())
    print(f"[run] probe={args.probe} evidence={args.evidence}")
    result = subprocess.run(["node", "scripts/dev.mjs"], cwd=str(DESKTOP), env=env)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
