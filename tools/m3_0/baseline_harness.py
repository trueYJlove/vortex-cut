"""M3-0 P2 基准端 harness（冻结方案 §7.2，ZhangSan 范围）。

直调生产链路 compile → ffprobe → build_ass → build_timeline_args（与
rendering/service.py 同序，不经 job 系统），encoder 参数原样传递但替换为
ffv1（mkv 容器，保持 yuv420p 域无损）。禁止以生产 H.264 产物作比对基准；
生产 libopenh264 mp4 仅另存"第二参考口径"。

产出：
  work/baseline.mkv          FFV1 无损基准（含字幕）
  work/baseline_nocap.mkv    FFV1 无损基准（无字幕，字幕 IoU 口径用）
  work/second_ref_h264.mp4   生产编码第二参考（非比对基准）
  frames/base/frame_xxxx.png 采样帧（in_color_matrix=bt709 钉死矩阵）
  baseline_manifest.json     命令行、版本、SHA-256、帧数校验

用法：
  python baseline_harness.py <p2 目录>              # 固定测试时间线
  python baseline_harness.py <p2 目录> --calibration  # 第 0 步色卡校准时间线
"""
from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "core" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import FFPROBE, FONTS_DIR, REPO_ROOT, run_ffmpeg, sha256_file  # noqa: E402

from aivs_core.media.ffprobe import FFprobe  # noqa: E402  生产代码，只读调用
from aivs_core.rendering.ass import CaptionResources, build_ass  # noqa: E402
from aivs_core.rendering.ffmpeg import build_timeline_args, run_timeline_render  # noqa: E402

CALIBRATION_FRAMES = [0, 30, 75, 134, 135, 136, 142, 143, 149, 150, 151, 210, 284]
CALIBRATION_CAPTION_FRAMES: list[int] = []


def calibration_document() -> dict:
    """第 0 步自校准时间线：色卡 A --fade 0.5s--> 色卡 B（同素材不同区间）。"""
    us = 1_000_000
    return {
        "schema_version": 1,
        "project_id": "m3probe0calib",
        "canvas": {"width": 1920, "height": 1080, "fps_num": 30, "fps_den": 1, "background_color": "#000000"},
        "tracks": [
            {"id": "C1", "kind": "text", "locked": False, "hidden": False, "muted": False, "solo": False},
            {"id": "V1", "kind": "video", "locked": False, "hidden": False, "muted": False, "solo": False},
            {"id": "A1", "kind": "audio", "locked": False, "hidden": False, "muted": False, "solo": False},
        ],
        "clips": [
            {"clip_id": "cal_a", "track_id": "V1", "order_index": 0, "asset_id": "asset_card",
             "asset_kind": "video", "source_start_us": 0, "source_end_us": 5 * us,
             "timeline_start_us": 0, "timeline_end_us": 5 * us, "layout": "fit",
             "audio": {"enabled": False, "gain_db": 0.0}},
            {"clip_id": "cal_b", "track_id": "V1", "order_index": 1, "asset_id": "asset_card",
             "asset_kind": "video", "source_start_us": 5 * us, "source_end_us": 10 * us,
             "timeline_start_us": 5 * us, "timeline_end_us": 10 * us, "layout": "fit",
             "audio": {"enabled": False, "gain_db": 0.0}},
        ],
        "captions": [],
        "transitions": [
            {"transition_id": "cal_tr", "after_clip_id": "cal_a", "kind": "fade", "duration_us": 500_000},
        ],
        "provenance": {"created_by": "user", "source_transcript_ids": []},
    }


def _ffprobe_all(paths: list[Path]) -> dict[str, dict]:
    probes = {}
    for path in paths:
        result = subprocess.run(
            [str(FFPROBE), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
            check=True, capture_output=True, text=True)
        probes[str(path)] = json.loads(result.stdout)
    return probes


def _to_ffv1_mkv(args: list[str], output_mkv: Path) -> list[str]:
    """encoder 参数原样传递但替换为 ffv1；去掉 mp4 专属项（-b:v、-movflags）。"""
    transformed: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "-c:v" and index + 1 < len(args):
            transformed += ["-c:v", "ffv1"]
            index += 2
            continue
        if arg == "-b:v" and index + 1 < len(args) and args[index + 1].endswith(("M", "k")):
            index += 2  # 丢弃生产码率项（ffv1 无损不适用）
            continue
        if arg == "-movflags":
            index += 2  # mkv 不适用
            continue
        transformed.append(arg)
        index += 1
    transformed[-1] = str(output_mkv)
    return transformed


async def run_harness(work_dir: Path, document: dict, material_paths: dict[str, Path],
                      sample_frames: list[int], caption_frames: list[int]) -> dict:
    work_dir = work_dir.resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    (work_dir / "document.json").write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")

    # 1) compile（生产 RenderPlanCompiler，经临时 DB 播种）
    from test_project import seed_and_compile
    plan = seed_and_compile(material_paths, document)
    (work_dir / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")

    # 2) ffprobe（与 service.py 同序）
    ffprobe = FFprobe(FFPROBE)
    input_paths = {item["input_id"]: material_paths[item["asset_id"]] for item in plan["inputs"]}
    segment_paths = [input_paths[item["input_id"]] for item in plan["segments"]]
    segment_probes = [await ffprobe.probe(path) for path in segment_paths]

    # 3) build_ass（字幕样式解析收敛到 Core 单点）
    bundle, presets, font_path = CaptionResources(FONTS_DIR).load()
    fonts = work_dir / "fonts"
    fonts.mkdir(exist_ok=True)
    shutil.copy2(font_path, fonts / font_path.name)
    has_captions = bool(plan["captions"]["items"])
    if has_captions:
        (work_dir / "captions.ass").write_text(
            build_ass(plan["captions"]["items"], bundle, presets,
                      (int(plan["output"]["width"]), int(plan["output"]["height"]))),
            encoding="utf-8-sig")

    # 4) build_timeline_args → FFV1 mkv（含字幕 / 无字幕）+ 生产编码第二参考
    width, height = int(plan["output"]["width"]), int(plan["output"]["height"])
    baseline_mkv = work_dir / "baseline.mkv"
    baseline_nocap_mkv = work_dir / "baseline_nocap.mkv"
    second_ref_mp4 = work_dir / "second_ref_h264.mp4"
    args_cap = build_timeline_args(plan, segment_paths, segment_probes, "libopenh264",
                                   str(work_dir / "tmp.mp4"), captions=has_captions)
    args_ffv1 = _to_ffv1_mkv(args_cap, baseline_mkv)
    expected_us = plan["segments"][-1]["timeline_end_us"]
    cancel = asyncio.Event()
    await run_timeline_render(REPO_ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe",
                              args_ffv1, work_dir, expected_us, cancel,
                              lambda p: None, lambda pid: None)
    tasks = [asyncio.to_thread(
        run_ffmpeg, _to_ffv1_mkv(build_timeline_args(
            plan, segment_paths, segment_probes, "libopenh264", str(work_dir / "tmp.mp4"), captions=False),
            baseline_nocap_mkv), cwd=work_dir),
        asyncio.to_thread(
        run_ffmpeg, build_timeline_args(plan, segment_paths, segment_probes, "libopenh264",
                                        str(second_ref_mp4), captions=has_captions), cwd=work_dir)]
    await asyncio.gather(*tasks)

    # 5) 帧数/帧率校验
    manifest = {
        "baseline_mkv": {"path": str(baseline_mkv), "sha256": sha256_file(baseline_mkv), "size_bytes": baseline_mkv.stat().st_size},
        "baseline_nocap_mkv": {"path": str(baseline_nocap_mkv), "sha256": sha256_file(baseline_nocap_mkv)},
        "second_ref_h264_mp4": {"path": str(second_ref_mp4), "sha256": sha256_file(second_ref_mp4)},
        "plan_content_fingerprint": plan["content_fingerprint"],
        "expected_duration_us": expected_us,
        "sample_frames": sample_frames,
        "caption_frames": caption_frames,
    }

    async def probe_media(path: Path) -> dict:
        info = await ffprobe.probe(path, require_video=False)
        stream = (info.get("video_streams") or [{}])[0]
        return {"nb_frames": stream.get("nb_frames"), "avg_frame_rate": stream.get("avg_frame_rate"),
                "width": stream.get("width"), "height": stream.get("height"),
                "duration_us": info.get("duration_us")}

    manifest["baseline_media"] = await probe_media(baseline_mkv)
    manifest["baseline_nocap_media"] = await probe_media(baseline_nocap_mkv)

    # 6) 采样帧 PNG 提取（单遍 select；in_color_matrix=bt709 钉死矩阵）
    def select_expr(frames: list[int]) -> str:
        return "select='" + "+".join(f"eq(n,{n})" for n in frames) + "'"

    color_matrix_args = ["-vf", f"{select_expr(sample_frames)},scale=in_color_matrix=bt709",
                         "-fps_mode", "passthrough"]
    base_dir = work_dir / "frames" / "base"
    base_dir.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(["-i", str(baseline_mkv), *color_matrix_args, str(base_dir / "frame_%04d.png")], cwd=work_dir)
    if caption_frames:
        nocap_dir = work_dir / "frames" / "base_nocap"
        nocap_dir.mkdir(parents=True, exist_ok=True)
        run_ffmpeg(["-i", str(baseline_nocap_mkv),
                    "-vf", f"{select_expr(caption_frames)},scale=in_color_matrix=bt709",
                    "-fps_mode", "passthrough", str(nocap_dir / "frame_%04d.png")], cwd=work_dir)
    # 第二参考采样（bonus 口径，非比对基准）
    ref_dir = work_dir / "frames" / "second_ref"
    ref_dir.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(["-i", str(second_ref_mp4), *color_matrix_args, str(ref_dir / "frame_%04d.png")], cwd=work_dir)
    manifest["extraction_command"] = (
        "ffmpeg -i baseline.mkv -vf \"select='eq(n,<n>)+…',scale=in_color_matrix=bt709\" "
        "-fps_mode passthrough frame_%04d.png")
    manifest["ffmpeg_version"] = subprocess.run(
        [str(REPO_ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"), "-version"],
        capture_output=True, text=True).stdout.splitlines()[0]
    (work_dir / "baseline_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    p2_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("evidence/m3_0/p2")
    calibration = "--calibration" in sys.argv
    material_dir = Path(sys.argv[sys.argv.index("--materials") + 1]) if "--materials" in sys.argv else p2_dir.parent / "materials"
    if calibration:
        document = calibration_document()
        material_paths = {"asset_card": (material_dir / "m3card_1080.mp4").resolve()}
        work = p2_dir / "step0_calibration"
        sample_frames, caption_frames = CALIBRATION_FRAMES, CALIBRATION_CAPTION_FRAMES
    else:
        document = json.loads((p2_dir / "document.json").read_text(encoding="utf-8"))
        material_paths = {
            "asset_m3_a": (material_dir / "m3mat_a_1080.mp4").resolve(),
            "asset_m3_b": (material_dir / "m3mat_b_1080.mp4").resolve(),
            "asset_m3_c": (material_dir / "m3mat_c_1080.mp4").resolve(),
            "asset_m3_p1": (material_dir / "m3mat_p1_1080.mp4").resolve(),
            "asset_m3_p2": (material_dir / "m3mat_p2_1080.mp4").resolve(),
        }
        from test_project import SAMPLE_FRAMES
        ir = json.loads((p2_dir / "ir.json").read_text(encoding="utf-8"))
        active = {f["n"]: bool(f["captions"]) for f in ir["frames"]}
        work = p2_dir / "baseline"
        sample_frames = SAMPLE_FRAMES
        caption_frames = [n for n in sample_frames if active.get(n)]
    manifest = asyncio.run(run_harness(work, document, material_paths, sample_frames, caption_frames))
    print(f"[ok] baseline → {work}")
    print(f"     baseline_media={manifest['baseline_media']}")
    print(f"     frames: base={len(list((work / 'frames' / 'base').glob('*.png')))}")


if __name__ == "__main__":
    main()
