"""M3-0 探针工具公共常量与辅助（一次性验证性质，只读调用生产代码）。"""
from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FFMPEG = REPO_ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
FFPROBE = REPO_ROOT / "resources" / "ffmpeg" / "win-x64" / "ffprobe.exe"
FONTS_DIR = REPO_ROOT / "resources" / "fonts"
FPS = 30
# 素材编码参数：H.264 (libopenh264)、yuv420p、CFR 30fps、GOP 显式 30、faststart。
# 素材为探针自产（冻结方案 §7.1/§7.3），生产渲染管线不做任何改动。
MATERIAL_ENCODER_ARGS = [
    "-c:v", "libopenh264", "-b:v", "20M",
    "-pix_fmt", "yuv420p", "-r", "30", "-fps_mode", "cfr",
    "-g", "30", "-keyint_min", "30",
    "-movflags", "+faststart",
]
# 素材统一携带 BT.709 VUI/colr 标记（冻结方案 §7.2 比对口径：单一矩阵）。
BT709_TAG_ARGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]


def run_ffmpeg(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run([str(FFMPEG), "-hide_banner", "-nostdin", "-y", *args],
                          check=True, capture_output=True, **kwargs)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tag_bt709(source: Path, target: Path) -> None:
    """remux 注入 MP4 colr(nclx) BT.709 标记（openh264 不写 VUI，容器级钉死矩阵）。"""
    run_ffmpeg(["-i", str(source), "-c", "copy", *BT709_TAG_ARGS, "-movflags", "+faststart", str(target)])


def probe_color_space(path: Path) -> str:
    result = subprocess.run(
        [str(FFPROBE), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=color_space,color_transfer,color_primaries,color_range,width,height,r_frame_rate,nb_frames",
         "-of", "default=noprint_wrappers=1", str(path)],
        check=True, capture_output=True, text=True)
    fields = {}
    for line in result.stdout.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            fields[key] = value
    return ",".join(f"{k}={fields.get(k, '?')}" for k in
                    ("width", "height", "r_frame_rate", "color_space", "color_transfer", "color_primaries", "color_range", "nb_frames"))
