"""M3-0 探针 CLI：调用生产投影器（aivs_core.rendering.ir）生成 IR 文件。

毕业说明：投影语义已毕业为生产模块 services/core/src/aivs_core/rendering/ir.py
（preview-ir-v1），本 CLI 仅保留文件 IO 与命令行入口——探针回归由此自动
覆盖生产实现（LiuKeAi 独立验收的"重生成 IR 逐位一致"检查同样作用于生产代码）。

用法：python ir_projector.py <plan.json> <ffprobe.json> <输出 ir.json> [caption-presets.json]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "core" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from aivs_core.rendering.ir import project_preview_ir, resolved_caption_styles  # noqa: E402  生产代码


def main() -> None:
    plan_path = Path(sys.argv[1])
    probes_path = Path(sys.argv[2])
    out_path = Path(sys.argv[3])
    presets_path = Path(sys.argv[4]) if len(sys.argv) > 4 else None
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    probes = json.loads(probes_path.read_text(encoding="utf-8"))
    caption_styles = None
    if presets_path and presets_path.is_file():
        caption_styles = resolved_caption_styles(json.loads(presets_path.read_text(encoding="utf-8")))
    ir = project_preview_ir(plan, probes, caption_styles)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(ir, ensure_ascii=False), encoding="utf-8")
    frames = ir["frames"]
    print(f"[ok] ir.json → {out_path}")
    print(f"     schema={ir['schema']} frames={len(frames)} canvas={ir['canvas']['width']}x{ir['canvas']['height']}")
    print(f"     transition_windows={ir['transition_windows']}")
    print(f"     overlay_frames={sum(1 for f in frames if f['overlays'])} "
          f"transition_frames={sum(1 for f in frames if f['main']['kind'] == 'transition')} "
          f"black_frames={sum(1 for f in frames if f['main']['kind'] == 'black')} "
          f"caption_frames={sum(1 for f in frames if f['captions'])}")


if __name__ == "__main__":
    main()
