from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path

import numpy as np

from aivs_core.rendering.ffmpeg import build_timeline_args
from aivs_core.rendering.ir import project_preview_ir

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()
FFPROBE = Path("resources/ffmpeg/win-x64/ffprobe.exe").resolve()

W, H = 320, 180
FPS = 30
US = 1_000_000


def _run_ffmpeg(*args: str, cwd: Path | None = None) -> None:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-y", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=180, check=False, cwd=cwd,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr[-2500:])


def _ffprobe(path: Path) -> dict:
    result = subprocess.run(
        [str(FFPROBE), "-v", "error", "-print_format", "json", "-show_streams", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=60, check=False,
    )
    assert result.returncode == 0, result.stderr[-800:]
    streams = json.loads(result.stdout).get("streams", [])
    return {
        "video_streams": [s for s in streams if s.get("codec_type") == "video"],
        "audio_streams": [s for s in streams if s.get("codec_type") == "audio"],
    }


def _make_lavfi_mp4(path: Path, filter_spec: str) -> Path:
    _run_ffmpeg(
        "-f", "lavfi", "-i", filter_spec,
        "-c:v", "libopenh264", "-b:v", "4M", "-pix_fmt", "yuv420p", "-an", str(path),
    )
    return path


def _make_solid_mp4(path: Path, color: str, duration_s: float = 4.0) -> Path:
    return _make_lavfi_mp4(path, f"color=c={color}:s={W}x{H}:r={FPS}:d={duration_s:.2f}")


def _decode_all_frames(video: Path) -> np.ndarray:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-v", "error", "-i", str(video),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, timeout=120, check=False,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")[-800:]
    frame_bytes = W * H * 3
    count = len(result.stdout) // frame_bytes
    assert count > 0 and len(result.stdout) == count * frame_bytes
    return np.frombuffer(result.stdout, dtype=np.uint8).reshape(count, H, W, 3)


def _psnr_db(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    if mse <= 1e-12:
        return 99.0
    return 10.0 * math.log10((255.0 ** 2) / mse)


def _phase_shift(a: np.ndarray, b: np.ndarray, window: int = 8) -> tuple[int, int]:
    ga = a.mean(axis=2).astype(np.float64)
    gb = b.mean(axis=2).astype(np.float64)
    if float(ga.std()) < 1e-6 and float(gb.std()) < 1e-6:
        return 0, 0
    fa = np.fft.fft2(ga - ga.mean())
    fb = np.fft.fft2(gb - gb.mean())
    cross = fa * np.conj(fb)
    cross /= np.maximum(np.abs(cross), 1e-9)
    corr = np.fft.ifft2(cross).real
    masked = np.full_like(corr, -np.inf)
    for yy in range(-window, window + 1):
        for xx in range(-window, window + 1):
            masked[yy % H, xx % W] = corr[yy % H, xx % W]
    py, px = np.unravel_index(np.argmax(masked), masked.shape)
    dy = int(py - H if py > H // 2 else py)
    dx = int(px - W if px > W // 2 else px)
    return dx, dy


def _mask_alpha_grid(mask: dict, sx: np.ndarray, sy: np.ndarray, bw: float, bh: float) -> np.ndarray:
    mx = sx / bw
    my = sy / bh
    cx = float(mask.get("x", 0.5))
    cy = float(mask.get("y", 0.5))
    mw = max(float(mask.get("width", 0.5)), 1e-4)
    mh = max(float(mask.get("height", 0.5)), 1e-4)
    rot = math.radians(float(mask.get("rotation", 0.0)))
    dx = mx - cx
    dy = my - cy
    ux = dx * math.cos(rot) + dy * math.sin(rot)
    uy = -dx * math.sin(rot) + dy * math.cos(rot)
    feather = min(max(float(mask.get("feather", 0.0)), 0.0), 1.0)
    kind = mask.get("kind", "rect")
    if kind == "ellipse":
        dist = np.sqrt((ux / (mw / 2.0)) ** 2 + (uy / (mh / 2.0)) ** 2)
    elif kind == "linear":
        val = 0.5 + ux / max(feather * mw, 1e-4) if feather > 0 else (ux >= 0).astype(np.float64)
        alpha = np.clip(val, 0.0, 1.0)
        return 1.0 - alpha if mask.get("invert") else alpha
    else:
        dist = np.maximum(np.abs(ux) / (mw / 2.0), np.abs(uy) / (mh / 2.0))
    if feather <= 1e-6:
        alpha = (dist <= 1.0).astype(np.float64)
    else:
        inner = 1.0 - feather
        alpha = np.clip((1.0 - dist) / max(feather, 1e-6), 0.0, 1.0)
        alpha = np.where(dist <= inner, 1.0, np.where(dist >= 1.0, 0.0, alpha))
    return 1.0 - alpha if mask.get("invert") else alpha


def _render_ir_frame(layers: list[dict], src_frames_by_input: dict[str, np.ndarray]) -> np.ndarray:
    canvas = np.zeros((H, W, 3), dtype=np.float64)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
    for layer in layers:
        bx = int(float(layer["box"]["x"]) + float(layer["shift"]["dx"]))
        by = int(float(layer["box"]["y"]) + float(layer["shift"]["dy"]))
        bw = float(layer["box"]["w"])
        bh = float(layer["box"]["h"])
        # 与 FFmpeg rotate(ow=iw:oh=ih) 及 compositor.ts v_box 一致：旋转在固定输出盒内裁剪。
        in_box = (xx >= bx) & (xx < bx + bw) & (yy >= by) & (yy < by + bh)
        cx = bx + bw / 2.0
        cy = by + bh / 2.0
        rot = math.radians(float(layer.get("rotation_deg", 0.0)))
        if abs(rot) > 1e-9:
            ux = xx - cx
            uy = yy - cy
            sx = ux * math.cos(rot) + uy * math.sin(rot) + bw / 2.0
            sy = -ux * math.sin(rot) + uy * math.cos(rot) + bh / 2.0
        else:
            sx = xx - bx
            sy = yy - by
        inside = in_box & (sx >= 0.0) & (sx < bw) & (sy >= 0.0) & (sy < bh)
        alpha = inside.astype(np.float64)
        src_frames = src_frames_by_input[layer["input_id"]]
        src_idx = min(max(int(layer.get("src_n", 0)), 0), len(src_frames) - 1)
        src_frame = src_frames[src_idx].astype(np.float64)
        ix = np.clip(np.round(sx * (src_frame.shape[1] / bw)).astype(int), 0, src_frame.shape[1] - 1)
        iy = np.clip(np.round(sy * (src_frame.shape[0] / bh)).astype(int), 0, src_frame.shape[0] - 1)
        src_rgb = src_frame[iy, ix]
        effects = layer.get("effects") or {}
        if "mask" in effects:
            alpha *= _mask_alpha_grid(effects["mask"], sx, sy, bw, bh)
        if "keying" in effects:
            key = effects["keying"]
            hex_c = str(key.get("color", "00FF00"))
            kr, kg, kb = int(hex_c[0:2], 16), int(hex_c[2:4], 16), int(hex_c[4:6], 16)
            sim = float(key.get("similarity", 0.3))
            blend = float(key.get("blend", 0.1))
            dist01 = np.sqrt((src_rgb[..., 0] - kr) ** 2 + (src_rgb[..., 1] - kg) ** 2 + (src_rgb[..., 2] - kb) ** 2) / (255.0 * math.sqrt(3.0))
            alpha *= np.clip((dist01 - sim) / max(blend, 1e-6), 0.0, 1.0)
        alpha *= float(layer.get("alpha", 1.0))
        canvas = src_rgb * alpha[..., None] + canvas * (1.0 - alpha[..., None])
    return np.clip(np.round(canvas), 0, 255).astype(np.uint8)


def _ir_plan(segments: list[dict], inputs: list[dict]) -> dict:
    return {
        "schema_version": 1, "compiler_version": "render-plan-v1",
        "content_fingerprint": "sha256:p231-a2", "mode": "authoritative_preview",
        "timeline_revision_id": "rev1", "canvas_background_color": "#000000",
        "output": {"profile_id": "preview-169-v1", "width": W, "height": H,
                   "fps_num": FPS, "fps_den": 1, "video_codec": "h264",
                   "audio_codec": "aac", "audio_sample_rate": 48000, "pixel_format": "yuv420p"},
        "inputs": inputs,
        "segments": segments,
        "active_transitions": [],
        "compatibility_transitions": [],
        "captions": {"format": "ass", "preset_version": 1, "font_bundle_version": 1, "items": []},
        "transitions": [],
    }


def _render_both(tmp_path: Path, name: str, segments: list[dict], asset_paths: list[Path]):
    probes_by_asset = {f"a{i}": _ffprobe(p) for i, p in enumerate(asset_paths)}
    inputs = [
        {"input_id": f"I{i}", "asset_id": f"a{i}", "asset_kind": "video",
         "fingerprint": f"fp{i}", "duration_us": 4 * US, "has_audio": False}
        for i in range(len(asset_paths))
    ]
    plan = _ir_plan(segments, inputs)
    ir = project_preview_ir(plan, probes_by_asset)
    out = tmp_path / f"{name}.mp4"
    seg_paths = [asset_paths[int(s["asset_id"][1:])] for s in segments]
    seg_probes = [probes_by_asset[s["asset_id"]] for s in segments]
    args = build_timeline_args(plan, seg_paths, seg_probes, "libopenh264", str(out), captions=False)
    _run_ffmpeg(*args, cwd=tmp_path)
    ff_frames = _decode_all_frames(out)
    src_frames = {f"I{i}": _decode_all_frames(p) for i, p in enumerate(asset_paths)}
    return ir, ff_frames, src_frames


def test_a2_blank_gap_and_v2_tail_beyond_v1(tmp_path: Path) -> None:
    """场景 1：黑底空档 + V2-only + 上层轨超出底层轨终点不截断。"""
    blue = _make_solid_mp4(tmp_path / "blue.mp4", "blue")
    red = _make_solid_mp4(tmp_path / "red.mp4", "red")
    segments = [
        {"clip_id": "v1", "asset_id": "a0", "input_id": "I0", "track_id": "V1", "track_index": 1,
         "asset_kind": "video", "source_start_us": 0, "source_end_us": 1 * US,
         "timeline_start_us": 0, "timeline_end_us": 1 * US,
         "layout": "fit", "audio_enabled": False, "gain_db": 0.0},
        {"clip_id": "v2", "asset_id": "a1", "input_id": "I1", "track_id": "V2", "track_index": 0,
         "asset_kind": "video", "source_start_us": 0, "source_end_us": int(1.5 * US),
         "timeline_start_us": 2 * US, "timeline_end_us": int(3.5 * US),
         "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
         "transform": {"x": 0.35, "y": 0.65, "scale": 0.5}},
    ]
    ir, ff_frames, src_frames = _render_both(tmp_path, "s1", segments, [blue, red])
    assert len(ff_frames) == ir["canvas"]["duration_frames"] == 105
    # t=1.5s 空档（frame 45）纯黑
    assert ff_frames[45].max() < 20
    # t=2.75s（frame 82）V2 盒四边 ±2px 边界与几何对拍
    n = 82
    ir_img = _render_ir_frame(ir["frames"][n]["layers"], src_frames)
    dx, dy = _phase_shift(ff_frames[n], ir_img)
    psnr = _psnr_db(ff_frames[n], ir_img)
    print(f"[a2-parity] s1 frames={len(ff_frames)} n={n} dx={dx} dy={dy} psnr={psnr:.2f}dB")
    assert dx == 0 and dy == 0
    assert psnr >= 31.0
    box = ir["frames"][n]["layers"][0]["box"]
    x0, y0, x1, y1 = int(box["x"]), int(box["y"]), int(box["x"] + box["w"]), int(box["y"] + box["h"])
    for px, py in [(x0 + 2, (y0 + y1) // 2), (x1 - 3, (y0 + y1) // 2), ((x0 + x1) // 2, y0 + 2), ((x0 + x1) // 2, y1 - 3)]:
        assert ff_frames[n, py, px, 0] > 180 and ff_frames[n, py, px, 2] < 40
    for px, py in [(x0 - 3, (y0 + y1) // 2), (x1 + 2, (y0 + y1) // 2), ((x0 + x1) // 2, y0 - 3), ((x0 + x1) // 2, y1 + 2)]:
        assert ff_frames[n, py, px].max() < 25


def test_a2_multitrack_zorder_insertion_order_invariant(tmp_path: Path) -> None:
    """场景 2：多轨叠层 + 反转 clips 插入序 z 序负向对照。"""
    blue = _make_solid_mp4(tmp_path / "blue.mp4", "blue")
    red = _make_solid_mp4(tmp_path / "red.mp4", "red")
    v1 = {"clip_id": "v1", "asset_id": "a0", "input_id": "I0", "track_id": "V1", "track_index": 1,
          "asset_kind": "video", "source_start_us": 0, "source_end_us": 2 * US,
          "timeline_start_us": 0, "timeline_end_us": 2 * US,
          "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
          "transform": {"x": 0.5, "y": 0.5, "scale": 0.8}}
    v2 = {"clip_id": "v2", "asset_id": "a1", "input_id": "I1", "track_id": "V2", "track_index": 0,
          "asset_kind": "video", "source_start_us": 0, "source_end_us": 2 * US,
          "timeline_start_us": int(0.5 * US), "timeline_end_us": int(2.5 * US),
          "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
          "transform": {"x": 0.62, "y": 0.4, "scale": 0.45}}
    ir_a, ff_a, src_a = _render_both(tmp_path, "s2_a", [v1, v2], [blue, red])
    ir_b, ff_b, src_b = _render_both(tmp_path, "s2_b", [v2, v1], [blue, red])
    assert len(ff_a) == len(ff_b) == ir_a["canvas"]["duration_frames"] == 75
    n = 36  # t=1.2s
    for label, ir, ff, src in [("a", ir_a, ff_a, src_a), ("b", ir_b, ff_b, src_b)]:
        ir_img = _render_ir_frame(ir["frames"][n]["layers"], src)
        dx, dy = _phase_shift(ff[n], ir_img)
        psnr = _psnr_db(ff[n], ir_img)
        print(f"[a2-parity] s2_{label} frames={len(ff)} n={n} dx={dx} dy={dy} psnr={psnr:.2f}dB")
        assert dx == 0 and dy == 0
        assert psnr >= 31.0
    cross_psnr = _psnr_db(ff_a[n], ff_b[n])
    assert cross_psnr >= 40.0
    # 重叠区（V2 中心）为红，V1 左侧露出区为蓝，左上角盒外为黑
    assert ff_a[n, int(0.4 * H), int(0.62 * W), 0] > 180
    assert ff_a[n, int(0.5 * H), int(0.18 * W), 2] > 180
    assert ff_a[n, 4, 4].max() < 20


def test_a2_base_mask_opacity_and_upper_keyframes_no_double_draw(tmp_path: Path) -> None:
    """场景 3：基底轨 V1 蒙版 + opacity + 上层轨 V2 opacity + 位置关键帧（A2/A4/A5 联合对拍）。"""
    green = _make_solid_mp4(tmp_path / "green.mp4", "green")
    magenta = _make_solid_mp4(tmp_path / "magenta.mp4", "magenta")
    segments = [
        {"clip_id": "v1", "asset_id": "a0", "input_id": "I0", "track_id": "V1", "track_index": 1,
         "asset_kind": "video", "source_start_us": 0, "source_end_us": 2 * US,
         "timeline_start_us": 0, "timeline_end_us": 2 * US,
         "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
         "transform": {"x": 0.35, "y": 0.5, "scale": 0.6, "opacity": 0.7},
         "mask": {"kind": "rect", "x": 0.5, "y": 0.5, "width": 0.6, "height": 0.6, "feather": 0.0}},
        {"clip_id": "v2", "asset_id": "a1", "input_id": "I1", "track_id": "V2", "track_index": 0,
         "asset_kind": "video", "source_start_us": 0, "source_end_us": 2 * US,
         "timeline_start_us": 0, "timeline_end_us": 2 * US,
         "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
         "transform": {"x": 0.65, "y": 0.5, "scale": 0.4, "opacity": 0.6},
         "keyframes": {"position": {"frames": [
             {"t_us": 0, "x": -0.2, "y": 0.0}, {"t_us": 2 * US, "x": 0.2, "y": 0.0},
         ]}}},
    ]
    ir, ff_frames, src_frames = _render_both(tmp_path, "s3", segments, [green, magenta])
    assert len(ff_frames) == ir["canvas"]["duration_frames"] == 60
    for n in (9, 51):  # t=0.3s, t=1.7s
        ir_img = _render_ir_frame(ir["frames"][n]["layers"], src_frames)
        dx, dy = _phase_shift(ff_frames[n], ir_img)
        psnr = _psnr_db(ff_frames[n], ir_img)
        print(f"[a2-parity] s3 frames={len(ff_frames)} n={n} dx={dx} dy={dy} psnr={psnr:.2f}dB")
        assert dx == 0 and dy == 0
        assert psnr >= 25.0
    # V1 盒内但蒙版外（x=0.35 - 0.25*0.6 = 0.20, y=0.5）必须纯黑（无双绘）
    assert ff_frames[9, H // 2, int(0.11 * W)].max() < 20
    # V1 蒙版中心区绿色亮度应受 opacity=0.7 衰减，不得饱和回满绿（无双绘叠加）
    v1_sample_g = float(ff_frames[9, H // 2, int(0.35 * W), 1])
    expected_g = float(src_frames["I0"][9, H // 2, W // 2, 1]) * 0.7
    assert abs(v1_sample_g - expected_g) < 25.0


def test_a2_upper_chroma_keying_and_rotation_parity(tmp_path: Path) -> None:
    """场景 4：上层轨 V2 绿幕抠像与 V3 旋转透明度对拍。"""
    blue = _make_solid_mp4(tmp_path / "blue.mp4", "blue")
    green = _make_solid_mp4(tmp_path / "green.mp4", "green")
    textured = _make_lavfi_mp4(tmp_path / "testsrc2.mp4", f"testsrc2=s={W}x{H}:r={FPS}:d=4.00")
    segments = [
        {"clip_id": "v1", "asset_id": "a0", "input_id": "I0", "track_id": "V1", "track_index": 2,
         "asset_kind": "video", "source_start_us": 0, "source_end_us": 2 * US,
         "timeline_start_us": 0, "timeline_end_us": 2 * US,
         "layout": "fit", "audio_enabled": False, "gain_db": 0.0},
        {"clip_id": "v2_key", "asset_id": "a1", "input_id": "I1", "track_id": "V2", "track_index": 1,
         "asset_kind": "video", "source_start_us": 0, "source_end_us": 2 * US,
         "timeline_start_us": 0, "timeline_end_us": 2 * US,
         "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
         "transform": {"x": 0.3, "y": 0.5, "scale": 0.5},
         "keying": {"color": "00FF00", "similarity": 0.35, "blend": 0.1}},
        {"clip_id": "v3_rot", "asset_id": "a2", "input_id": "I2", "track_id": "V3", "track_index": 0,
         "asset_kind": "video", "source_start_us": 0, "source_end_us": 2 * US,
         "timeline_start_us": 0, "timeline_end_us": 2 * US,
         "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
         "transform": {"x": 0.72, "y": 0.5, "scale": 0.4, "rotate": 15.0}},
    ]
    ir, ff_frames, src_frames = _render_both(tmp_path, "s4", segments, [blue, green, textured])
    n = 30
    ir_img = _render_ir_frame(ir["frames"][n]["layers"], src_frames)
    dx, dy = _phase_shift(ff_frames[n], ir_img)
    psnr = _psnr_db(ff_frames[n], ir_img)
    print(f"[a2-parity] s4 frames={len(ff_frames)} n={n} dx={dx} dy={dy} psnr={psnr:.2f}dB")
    assert dx == 0 and dy == 0
    assert psnr >= 22.0
    # 绿幕区域应完全透明露出 V1 蓝底
    assert ff_frames[n, H // 2, int(0.3 * W), 2] > 180
    assert ff_frames[n, H // 2, int(0.3 * W), 1] < 40
    # 旋转后盒外角（未旋转盒左上角内部 2px）应露出 V1 蓝底而非黑角
    rot_layer = ir["frames"][n]["layers"][2]
    rx0, ry0 = int(rot_layer["box"]["x"]) + 2, int(rot_layer["box"]["y"]) + 2
    assert ff_frames[n, ry0, rx0, 2] > 180 and ff_frames[n, ry0, rx0, 0] < 40
