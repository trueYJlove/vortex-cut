"""P3 素材：以生产 proxy 滤镜口径（media/render.py proxy_filter，只读复用）
把 test-assets 的 VFR 源转出 ≤960p CFR30 代理参考文件（模拟"现有 proxy.mp4（含 VFR 源转出）"）。

用法：.venv/Scripts/python.exe tools/m3_0/make_proxy_reference.py <输出目录>
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "core" / "src"))
from common import FFMPEG, sha256_file  # noqa: E402
from aivs_core.media.render import proxy_filter  # noqa: E402  生产代码，只读调用

REPO = Path(__file__).resolve().parents[2]
SOURCES = [
    REPO / "test-assets" / "generated" / "vfr-landscape-av.mp4",
    REPO / "test-assets" / "generated" / "cfr-landscape-av.mp4",
]


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("evidence/m3_0/materials")
    out_dir.mkdir(parents=True, exist_ok=True)
    for source in SOURCES:
        target = out_dir / f"m3proxy_ref_{source.stem}.mp4"
        args = [
            "-i", str(source), "-t", "10.000000",
            "-vf", proxy_filter(),
            "-c:v", "libopenh264", "-preset", "veryfast", "-b:v", "4M",
            "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart",
            "-an", str(target),
        ]
        subprocess.run([str(FFMPEG), "-hide_banner", "-nostdin", "-y", *args],
                       check=True, capture_output=True)
        print(f"[ok] {target.name} sha256={sha256_file(target)}")


if __name__ == "__main__":
    main()
