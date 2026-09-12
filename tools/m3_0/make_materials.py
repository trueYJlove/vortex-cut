"""M3-0 探针自产固定参数测试素材脚本（冻结方案 §7.1/§7.3）。

产出（全部 H.264 yuv420p CFR 30fps、GOP=30 显式、faststart、BT.709 colr 标记，
分辨率与参数写入报告；内容含持续运动，并叠加帧计数与空间参考网格）：
  m3mat_{a,b,c,p1,p2}_1080.mp4   1920x1080 主素材与画中画素材
  m3card_1080.mp4                1920x1080 色卡/渐变校准素材（P2 第 0 步）
  m3mat_{a,b,c,p1,p2}_540.mp4    960x540 回退/对照素材（同一脚本产出）
  m3card_540.mp4

用法：.venv/Scripts/python.exe tools/m3_0/make_materials.py <输出目录>
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import FFMPEG, FPS, MATERIAL_ENCODER_ARGS, BT709_TAG_ARGS, probe_color_space, tag_bt709  # noqa: E402

W, H = 1920, 1080


def _grid(image: np.ndarray, step: int) -> None:
    for x in range(0, W, step):
        image[:, x] *= 0.82
    for y in range(0, H, step):
        image[y, :] *= 0.82


def _rect(image: np.ndarray, x0: int, y0: int, x1: int, y1: int, color, alpha: float = 1.0) -> None:
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(W, x1), min(H, y1)
    if x1 <= x0 or y1 <= y0:
        return
    region = image[y0:y1, x0:x1]
    region *= (1.0 - alpha)
    region += alpha * np.asarray(color, dtype=np.float64)


_SEGMENTS = {  # 七段数码管
    "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc", "5": "afgcd",
    "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcfgd",
}
_SEG_POLY = {  # 每段的世界坐标（0..1 归一化于单个数字盒）
    "a": (0.15, 0.02, 0.85, 0.14), "b": (0.87, 0.05, 0.97, 0.46), "c": (0.87, 0.54, 0.97, 0.95),
    "d": (0.15, 0.86, 0.85, 0.98), "e": (0.03, 0.54, 0.13, 0.95), "f": (0.03, 0.05, 0.13, 0.46),
    "g": (0.15, 0.44, 0.85, 0.56),
}


def _counter(image: np.ndarray, value: int, origin_x: int, origin_y: int, digit: int, scale: int) -> None:
    text = str(value % (10 ** digit)).rjust(digit, "0")
    for index, char in enumerate(text):
        bx = origin_x + index * scale * 1.2
        _rect(image, int(bx) - 4, origin_y - 4, int(bx) + scale + 4, origin_y + int(scale * 1.05) + 4, (10, 10, 10), 0.85)
        for seg in _SEGMENTS[char]:
            x0, y0, x1, y1 = _SEG_POLY[seg]
            _rect(image, int(bx + x0 * scale), int(origin_y + y0 * scale),
                  int(bx + x1 * scale), int(origin_y + y1 * scale), (255, 255, 255), 1.0)


def _disc(image: np.ndarray, cx: float, cy: float, radius: float, color) -> None:
    soft = max(2.0, radius * 0.08)
    x0, x1 = int(cx - radius - soft), int(cx + radius + soft) + 1
    y0, y1 = int(cy - radius - soft), int(cy + radius + soft) + 1
    if x1 <= 0 or y1 <= 0 or x0 >= W or y0 >= H:
        return
    xs = np.arange(max(0, x0), min(W, x1), dtype=np.float64)
    ys = np.arange(max(0, y0), min(H, y1), dtype=np.float64)
    dist = np.sqrt((xs[None, :] - cx) ** 2 + (ys[:, None] - cy) ** 2)
    alpha = np.clip((radius - dist) / soft, 0.0, 1.0)[..., None]
    region = image[max(0, y0):min(H, y1), max(0, x0):min(W, x1)]
    region *= (1.0 - alpha)
    region += alpha * np.asarray(color, dtype=np.float64)


def frame_aurora(n: int, total: int) -> np.ndarray:  # m3mat_a
    t = n / FPS
    image = np.empty((H, W, 3), dtype=np.float64)
    phase = 0.5 + 0.5 * np.sin(2 * np.pi * t / 12.0)
    top = np.array([30 + 60 * phase, 40 + 90 * (1 - phase), 120 + 80 * phase])
    bottom = np.array([10 + 20 * (1 - phase), 15 + 30 * phase, 40 + 50 * (1 - phase)])
    ramp = (np.linspace(0, 1, H) ** 1.2)[:, None, None]
    image[:] = top[None, None, :] * (1 - ramp) + bottom[None, None, :] * ramp
    for index, speed in enumerate((0.9, 1.3, 1.7)):
        cx = W * (0.5 + 0.36 * np.sin(2 * np.pi * (t / (9.0 + index * 3)) + index * 2.1))
        cy = H * (0.5 + 0.34 * np.cos(2 * np.pi * (t / (7.0 + index * 2.5)) + index * 1.3))
        color = [(240, 90, 90), (90, 230, 120), (240, 220, 90)][index]
        _disc(image, cx, cy, 120 + 30 * np.sin(2 * np.pi * t / 5 + index), color)
    bar_x = int((t * W * 0.22) % (W + 90)) - 90
    _rect(image, bar_x, 0, bar_x + 56, H, (250, 250, 255), 0.65)
    bar_y = int((t * H * 0.3) % (H + 90)) - 90
    _rect(image, 0, bar_y, W, bar_y + 44, (60, 255, 240), 0.55)
    _grid(image, 96)
    _counter(image, n, 30, 40, 6, 64)
    return image


def frame_ember(n: int, total: int) -> np.ndarray:  # m3mat_b
    t = n / FPS
    image = np.empty((H, W, 3), dtype=np.float64)
    image[:] = (24, 22, 34)
    stripe = (np.arange(W)[None, :] + np.arange(H)[:, None] + t * FPS * 2.0) // 120 % 2
    image += stripe[..., None] * np.array([70, 26, 10])[None, None, :]
    pulse = 0.5 + 0.5 * np.sin(2 * np.pi * t / 4.0)
    _disc(image, W * 0.62, H * 0.4, 200 + 60 * pulse, (235, 130, 40))
    _disc(image, W * 0.3 + 40 * np.sin(2 * np.pi * t / 6), H * 0.7, 130, (40, 160, 170))
    _grid(image, 96)
    _counter(image, n, 30, 40, 6, 64)
    return image


def frame_cyan(n: int, total: int) -> np.ndarray:  # m3mat_c
    t = n / FPS
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float64)
    r = np.sqrt((xs - W / 2) ** 2 + (ys - H / 2) ** 2)
    wave = 0.5 + 0.5 * np.sin((r / 46.0) - t * 2 * np.pi / 3.0)
    image = np.empty((H, W, 3), dtype=np.float64)
    image[:] = 18
    image += wave[..., None] * np.array([10, 120, 150])[None, None, :]
    _disc(image, W * (0.35 + 0.1 * np.sin(2 * np.pi * t / 8)), H * 0.5, 90, (255, 240, 200))
    _grid(image, 96)
    _counter(image, n, 30, 40, 6, 64)
    return image


def frame_pip_amber(n: int, total: int) -> np.ndarray:  # m3mat_p1
    t = n / FPS
    image = np.empty((H, W, 3), dtype=np.float64)
    image[:] = (46, 30, 8)
    for index in range(4):
        cx = W * (0.2 + 0.16 * index) + 60 * np.sin(2 * np.pi * (t / 5.0) + index)
        cy = H * (0.5 + 0.3 * np.cos(2 * np.pi * (t / (6.0 + index)) + index * 1.7))
        _disc(image, cx, cy, 95 + 25 * np.sin(2 * np.pi * t / 3 + index * 2), (250, 170 + 20 * index, 60))
    for patch in range(5):
        px = int((t * 140 + patch * 430) % (W + 200)) - 100
        _rect(image, px, 120 + patch * 170, px + 150, 120 + patch * 170 + 110, (30, 30, 34), 0.9)
    _grid(image, 96)
    _counter(image, n, 30, 40, 6, 64)
    return image


def frame_pip_violet(n: int, total: int) -> np.ndarray:  # m3mat_p2
    t = n / FPS
    image = np.empty((H, W, 3), dtype=np.float64)
    image[:] = (20, 12, 40)
    for index in range(6):
        x = int(W * index / 6 + (t * 90) % (W / 6))
        _rect(image, x, 0, x + 42, H, (120 + index * 14, 60, 200), 0.75)
    _disc(image, W * 0.5, H * 0.5, 170 + 40 * np.sin(2 * np.pi * t / 4.0), (230, 90, 220))
    _grid(image, 96)
    _counter(image, n, 30, 40, 6, 64)
    return image


def frame_card(n: int, total: int) -> np.ndarray:  # m3card：色卡/渐变校准
    image = np.empty((H, W, 3), dtype=np.float64)
    scene = (n // 100) % 3
    if scene == 0:  # SMPTE 风格色条
        bars = [(192, 192, 192), (176, 176, 16), (16, 176, 176), (16, 176, 16),
                (176, 16, 176), (176, 16, 16), (16, 16, 176), (20, 20, 20)]
        width = W // len(bars)
        for index, color in enumerate(bars):
            _rect(image, index * width, 0, (index + 1) * width, H, color, 1.0)
        _rect(image, 0, H // 2, W, H // 2 + 8, (255, 255, 255), 1.0)
    elif scene == 1:  # 水平 RGB 渐变扫动
        xs = np.linspace(0.0, 1.0, W)[None, :, None]
        drift = (n % 100) / 100.0
        image[:] = 255 * np.concatenate([
            np.abs(xs - drift), np.abs(1 - xs - drift), np.full_like(xs, 0.5 + 0.45 * np.sin(drift * 6.28))
        ], axis=2).repeat(H, axis=0)
    else:  # 16 级灰阶 + 软圆
        steps = 16
        width = W // steps
        for index in range(steps):
            value = round(255 * index / (steps - 1))
            _rect(image, index * width, 0, (index + 1) * width, H, (value, value, value), 1.0)
        _disc(image, W * (0.3 + 0.4 * (n % 100) / 100.0), H * 0.5, 220, (128, 128, 128))
    _counter(image, n, 30, 40, 6, 64)
    return image


MATERIALS = {
    "m3mat_a": (25, frame_aurora),
    "m3mat_b": (25, frame_ember),
    "m3mat_c": (15, frame_cyan),
    "m3mat_p1": (20, frame_pip_amber),
    "m3mat_p2": (20, frame_pip_violet),
    "m3card": (10, frame_card),
}


def encode_frames(name: str, seconds: int, painter, out_dir: Path) -> Path:
    """numpy 帧绘制 → rawvideo 管道 → libopenh264 → BT.709 colr remux。"""
    raw = out_dir / f"{name}_raw.mp4"
    total = seconds * FPS
    process = subprocess.Popen(
        [str(FFMPEG), "-hide_banner", "-nostdin", "-y",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
         *MATERIAL_ENCODER_ARGS, str(raw)],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for n in range(total):
        frame = np.clip(painter(n, total), 0, 255).astype(np.uint8)
        process.stdin.write(frame.tobytes())
    process.stdin.close()
    stderr = process.stderr.read().decode("utf-8", "replace")
    if process.wait() != 0:
        raise RuntimeError(f"{name} encode failed:\n{stderr[-2000:]}")
    final = out_dir / f"{name}_1080.mp4"
    tag_bt709(raw, final)
    raw.unlink()
    return final


def make_variant(source_1080: Path, out_dir: Path, name: str) -> Path:
    target = out_dir / f"{name}_540.mp4"
    subprocess.run(
        [str(FFMPEG), "-hide_banner", "-nostdin", "-y", "-i", str(source_1080),
         "-vf", "scale=960:540:flags=lanczos", "-an",
         "-c:v", "libopenh264", "-b:v", "6M",
         "-pix_fmt", "yuv420p", "-r", "30", "-fps_mode", "cfr",
         "-g", "30", "-keyint_min", "30", "-movflags", "+faststart",
         *BT709_TAG_ARGS, str(target)],
        check=True, capture_output=True)
    return target


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("evidence/m3_0/materials")
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name, (seconds, painter) in MATERIALS.items():
        final = encode_frames(name, seconds, painter, out_dir)
        manifest[f"{name}_1080"] = probe_color_space(final)
        print(f"[ok] {final.name}: {probe_color_space(final)} sha256待归档")
        variant = make_variant(final, out_dir, name)
        manifest[f"{name}_540"] = probe_color_space(variant)
        print(f"[ok] {variant.name}: {probe_color_space(variant)}")
    (out_dir / "materials_manifest.txt").write_text(
        "\n".join(f"{k}: {v}" for k, v in manifest.items()) + "\n", encoding="utf-8")
    print(f"[done] materials → {out_dir}")


if __name__ == "__main__":
    main()
