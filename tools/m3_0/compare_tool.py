"""M3-0 P2 逐帧比对工具 + 第 0 步自校准（冻结方案 §7.2，ZhangSan 范围）。

比对口径（先于实现钉死）：
- 帧对齐：CFR 30fps，采样以帧索引 n 定义（n ↔ PTS n/30）；
- 色彩：PNG 提取统一 scale=in_color_matrix=bt709；PSNR 以 ffmpeg psnr 滤镜在
  RGB（gbrp 平面）空间计算；SSIM 同口径记录；
- 几何错位：FFT 相位相关法（±8px 搜索窗）估计整帧平移，逐帧报告偏移值；
- 字幕帧单独口径：文本 bbox 位置/IoU + 全帧 diff 比率，不计入 40dB 硬门；
- 第 0 步自校准：FFV1 两路提取确定性、601/709 失配量化、GL 合成器 vs FFmpeg
  色卡底噪，先于 40dB 门套用（R10 免疫）。

用法：
  python compare_tool.py frames --ir <ir.json> --gl <dir> --base <dir> \
      --gl-nocap <dir> --base-nocap <dir> --ref <dir> --out <comparison.json>
  python compare_tool.py step0 --cal <step0 目录> --gl <dir> --out <step0.json>
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import FFMPEG  # noqa: E402

W, H = 960, 540
PSNR_GATE_DB = 40.0
MISALIGN_GATE_PX = 1.0


def load_png(path: Path) -> np.ndarray:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-v", "error", "-i", str(path),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True)
    raw = result.stdout
    assert len(raw) >= W * H * 3, f"{path}: unexpected size {len(raw)}"
    return np.frombuffer(raw[:W * H * 3], dtype=np.uint8).reshape(H, W, 3)


def ffmpeg_metric(left: Path, right: Path, metric: str) -> dict:
    """psnr / ssim 滤镜在 gbrp（RGB 平面）空间计算。"""
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-v", "info",
         "-i", str(left), "-i", str(right),
         "-filter_complex", f"[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]{metric}",
         "-f", "null", "-"],
        check=False, capture_output=True, text=True)
    import re
    stats: dict = {}
    marker = "PSNR " if metric == "psnr" else "SSIM "
    for line in result.stderr.splitlines():
        if marker not in line or "Parsed_" not in line:
            continue
        body = line.split(marker, 1)[1]
        for key, value in re.findall(r"([A-Za-z]+):([0-9.]+|inf)", body):
            stats[key.lower()] = float("inf") if value == "inf" else float(value)
    return stats


def phase_correlation(a: np.ndarray, b: np.ndarray, window: int = 8) -> dict:
    """FFT 相位相关整帧平移估计（±window px 搜索窗）。"""
    ga = a.mean(axis=2).astype(np.float64)
    gb = b.mean(axis=2).astype(np.float64)
    fa = np.fft.fft2(ga - ga.mean())
    fb = np.fft.fft2(gb - gb.mean())
    cross = fa * np.conj(fb)
    cross /= np.maximum(np.abs(cross), 1e-9)
    corr = np.fft.ifft2(cross).real
    peak_index = np.unravel_index(np.argmax(corr), corr.shape)
    dy, dx = peak_index
    if dy > H // 2:
        dy -= H
    if dx > W // 2:
        dx -= W
    if abs(dy) > window or abs(dx) > window:
        # 峰值落在窗外：限制在窗内重找（报告窗口内峰值及其位置）
        masked = corr.copy()
        for yy in range(H):
            sy = yy - H if yy > H // 2 else yy
            if abs(sy) > window:
                masked[yy, :] = -np.inf
        for xx in range(W):
            sx = xx - W if xx > W // 2 else xx
            if abs(sx) > window:
                masked[:, xx] = -np.inf
        peak_index = np.unravel_index(np.argmax(masked), corr.shape)
        dy, dx = peak_index
        if dy > H // 2:
            dy -= H
        if dx > W // 2:
            dx -= W
    peak = float(corr[peak_index])
    confidence = peak / max(float(corr.mean()), 1e-12)
    return {"dx": int(dx), "dy": int(dy), "peak": round(peak, 6), "confidence": round(confidence, 1)}


def bbox_of(mask: np.ndarray) -> dict | None:
    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        return None
    return {"x0": int(xs.min()), "y0": int(ys.min()), "x1": int(xs.max()), "y1": int(ys.max()),
            "cx": float((xs.min() + xs.max()) / 2), "cy": float((ys.min() + ys.max()) / 2),
            "area": int(len(ys))}


def compare_frames(args) -> None:
    ir = json.loads(Path(args.ir).read_text(encoding="utf-8"))
    frames_meta = {f["n"]: f for f in ir["frames"]}
    gl_dir, base_dir = Path(args.gl), Path(args.base)
    gl_nocap, base_nocap = (Path(args.gl_nocap) if args.gl_nocap else None), (Path(args.base_nocap) if args.base_nocap else None)
    ref_dir = Path(args.ref) if args.ref else None
    results = []
    order_doc = json.loads(Path(args.order).read_text(encoding="utf-8")) if args.order else None
    sample_frames = order_doc["sample_frames"] if order_doc else [f["n"] for f in ir["frames"]][:len(list(gl_dir.glob("frame_*.png")))]
    # 字幕帧清单由 IR 推导（与 harness/m3p2 同源），基线无字幕帧按此顺序命名
    caption_frame_list = [n for n in sample_frames if ir["frames"][n]["captions"]]
    for index, n in enumerate(sample_frames):
        gl_png = gl_dir / f"frame_{n:04d}.png"          # GL 侧按帧号命名
        base_png = base_dir / f"frame_{index + 1:04d}.png"  # 基线按采样顺序命名
        if not gl_png.is_file() or not base_png.is_file():
            results.append({"n": n, "error": "missing_png", "gl": str(gl_png), "base": str(base_png)})
            continue
        meta = frames_meta.get(n, {})
        is_caption = bool(meta.get("captions"))
        psnr = ffmpeg_metric(gl_png, base_png, "psnr")
        ssim = ffmpeg_metric(gl_png, base_png, "ssim")
        gl_img, base_img = load_png(gl_png), load_png(base_png)
        shift = phase_correlation(gl_img, base_img, window=8)
        record = {
            "n": n, "t_s": round(n / 30, 4),
            "kind": meta.get("main", {}).get("kind"),
            "overlays": len(meta.get("overlays", [])),
            "caption": is_caption,
            "psnr_db": psnr.get("average") if isinstance(psnr.get("average"), float) else psnr.get("average"),
            "psnr_raw": psnr,
            "ssim": ssim,
            "shift": shift,
        }
        if ref_dir:
            ref_png = ref_dir / f"frame_{index + 1:04d}.png"
            if ref_png.is_file():
                record["psnr_vs_second_ref_db"] = ffmpeg_metric(gl_png, ref_png, "psnr").get("average")
        if is_caption and gl_nocap and base_nocap:
            gl_cap = load_png(gl_nocap / f"frame_{n:04d}.png")
            caption_index = caption_frame_list.index(n)
            base_cap = load_png(base_nocap / f"frame_{caption_index + 1:04d}.png")
            mask_gl = np.abs(gl_img.astype(int) - gl_cap.astype(int)).max(axis=2) > 8
            mask_ff = np.abs(base_img.astype(int) - base_cap.astype(int)).max(axis=2) > 8
            union = np.logical_or(mask_gl, mask_ff).sum()
            iou = float(np.logical_and(mask_gl, mask_ff).sum() / union) if union else 1.0
            bbox_gl, bbox_ff = bbox_of(mask_gl), bbox_of(mask_ff)
            diff_ratio = float((np.abs(gl_img.astype(int) - base_img.astype(int)).max(axis=2) > 10).mean())
            record["caption_metric"] = {
                "text_mask_iou": round(iou, 4),
                "bbox_gl": bbox_gl, "bbox_ffmpeg": bbox_ff,
                "center_offset_px": (round(bbox_gl["cx"] - bbox_ff["cx"], 1), round(bbox_gl["cy"] - bbox_ff["cy"], 1))
                if bbox_gl and bbox_ff else None,
                "fullframe_diff_ratio_gt10": round(diff_ratio, 5),
            }
        results.append(record)
    non_caption = [r for r in results if not r.get("caption") and "error" not in r]
    caption_rows = [r for r in results if r.get("caption") and "error" not in r]
    psnr_values = [r["psnr_db"] for r in non_caption if isinstance(r.get("psnr_db"), float)]
    misalign_values = [max(abs(r["shift"]["dx"]), abs(r["shift"]["dy"])) for r in non_caption]
    verdict = {
        "gate": f"非字幕采样帧全部 PSNR ≥ {PSNR_GATE_DB}dB 且几何错位 ≤ {MISALIGN_GATE_PX}px（§7.2）",
        "non_caption_frames": len(non_caption),
        "psnr_min_db": min(psnr_values) if psnr_values else None,
        "psnr_all_pass": bool(psnr_values) and min(psnr_values) >= PSNR_GATE_DB,
        "misalign_max_px": max(misalign_values) if misalign_values else None,
        "misalign_all_pass": bool(misalign_values) and max(misalign_values) <= MISALIGN_GATE_PX,
        "caption_frames": len(caption_rows),
        "caption_note": "字幕帧不计入硬门（文本光栅化系统差），IoU/bbox/diff 比率单列",
    }
    verdict["pass"] = verdict["psnr_all_pass"] and verdict["misalign_all_pass"]
    worst = sorted([r for r in results if isinstance(r.get("psnr_db"), float)],
                   key=lambda r: r["psnr_db"])[:5]
    out = {"verdict": verdict, "frames": results, "worst5_by_psnr": worst}
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[ok] comparison → {args.out}")
    print(f"     pass={verdict['pass']} psnr_min={verdict['psnr_min_db']} misalign_max={verdict['misalign_max_px']}")
    for row in worst:
        print(f"     worst n={row['n']} psnr={row['psnr_db']:.2f}dB shift=({row['shift']['dx']},{row['shift']['dy']}) kind={row['kind']}")


def step0(args) -> None:
    cal_dir = Path(args.cal)
    mkv = cal_dir / "baseline.mkv"
    tmp = cal_dir / "step0"
    tmp.mkdir(exist_ok=True)
    # (1) FFV1 提取确定性：同一帧两次提取应逐位一致
    subprocess.run([str(FFMPEG), "-hide_banner", "-nostdin", "-y", "-i", str(mkv),
                    "-vf", "select='eq(n,75)',scale=in_color_matrix=bt709", "-fps_mode", "passthrough",
                    "-frames:v", "1", str(tmp / "det_a.png")], check=True, capture_output=True)
    subprocess.run([str(FFMPEG), "-hide_banner", "-nostdin", "-y", "-i", str(mkv),
                    "-vf", "select='eq(n,75)',scale=in_color_matrix=bt709", "-fps_mode", "passthrough",
                    "-frames:v", "1", str(tmp / "det_b.png")], check=True, capture_output=True)
    deterministic = (tmp / "det_a.png").read_bytes() == (tmp / "det_b.png").read_bytes()
    det_psnr = ffmpeg_metric(tmp / "det_a.png", tmp / "det_b.png", "psnr").get("average")
    # (2) 601/709 失配量化：同帧两矩阵提取的 PSNR
    subprocess.run([str(FFMPEG), "-hide_banner", "-nostdin", "-y", "-i", str(mkv),
                    "-vf", "select='eq(n,75)',scale=in_color_matrix=bt601", "-fps_mode", "passthrough",
                    "-frames:v", "1", str(tmp / "m601.png")], check=True, capture_output=True)
    mismatch_601_709 = ffmpeg_metric(tmp / "det_a.png", tmp / "m601.png", "psnr").get("average")
    # (3) GL 合成器 vs FFmpeg 色卡底噪（m3p2 输出的 GL 帧，如已提供）
    gl_floor = None
    gl_dir = Path(args.gl) if args.gl else None
    if gl_dir and gl_dir.is_dir():
        base_dir = cal_dir / "frames" / "base"
        floors = []
        for index, gl_png in enumerate(sorted(gl_dir.glob("frame_*.png"))):
            base_png = base_dir / f"frame_{index + 1:04d}.png"
            if base_png.is_file():
                value = ffmpeg_metric(gl_png, base_png, "psnr").get("average")
                if isinstance(value, float):
                    floors.append({"frame": index + 1, "psnr_db": value})
        gl_floor = floors
    out = {
        "ffv1_extraction_deterministic": deterministic,
        "ffv1_extraction_psnr_db": det_psnr,
        "color_matrix_mismatch_601_vs_709_psnr_db": mismatch_601_709,
        "gl_vs_ffmpeg_calibration": gl_floor,
        "gl_floor_min_db": min((r["psnr_db"] for r in gl_floor), default=None) if gl_floor else None,
        "note": "40dB 硬门在 gl_floor_min 之上套用（R10 免疫）；矩阵失配量化说明钉死 bt709 的必要性",
    }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[ok] step0 → {args.out}")
    print(f"     deterministic={deterministic} (psnr={det_psnr}) 601/709_mismatch={mismatch_601_709}dB gl_floor_min={out['gl_floor_min_db']}")


def main() -> None:
    mode = sys.argv[1]
    argv = sys.argv[2:]
    def value(flag: str) -> str | None:
        return argv[argv.index(flag) + 1] if flag in argv else None
    if mode == "frames":
        class A: pass
        a = A()
        a.ir, a.gl, a.base = value("--ir"), value("--gl"), value("--base")
        a.gl_nocap, a.base_nocap, a.ref = value("--gl-nocap"), value("--base-nocap"), value("--ref")
        a.order, a.out = value("--order"), value("--out")
        compare_frames(a)
    elif mode == "step0":
        class A: pass
        a = A()
        a.cal, a.gl, a.out = value("--cal"), value("--gl"), value("--out")
        step0(a)
    else:
        raise SystemExit(f"unknown mode {mode}")


if __name__ == "__main__":
    main()
