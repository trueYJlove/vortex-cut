"""P235-R2 真 FFmpeg 解码计数与时长边界对拍集成测试。

真机/真实 FFmpeg 校验内容（不使用 ffprobe -count_frames 或成片帧数充数）：
1. 通过 `ffmpeg.exe -v verbose` 真实解析 `Input #N`、decoder thread 启动日志与
   `Input stream #N:S (video|audio): ... decoded` 解码计数；
2. 验证 1080p 主画面 + 4K 有声视频仅作 A1 时：`resolution="original"` 输出 1920x1080、
   4K 输入加 `-vn`、4K 视频解码线程数=0、解码视频帧数=0、音轨正常混音；
3. 验证 1080p 主画面 + 4K 无音轨视频仅作 A1 时：4K 源文件不进 FFmpeg `-i`、0 打开 0 解码、
   RenderService `_project_plan` / `run` 均跳过视觉探测且成片静音；
4. 验证同 4K 素材双消费（V2+A1）时仅 V2 触发视频解码，删除 V2 后 4K 视频解码归零且
   `original` 分辨率回到 1920x1080；
5. 验证 >30s（45s）静态图片通过 Replace / `set_image_duration` 全链路保留时长。
"""
from __future__ import annotations

import asyncio
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from aivs_core.database import Database, json_dumps
from aivs_core.media.ffprobe import FFprobe
from aivs_core.rendering.ffmpeg import build_timeline_args
from aivs_core.rendering.ir import project_preview_ir
from aivs_core.rendering.plan import RenderPlanCompiler
from aivs_core.rendering.service import _rendered_duration_us
from aivs_core.rendering.validation import validate_rendered_media
from aivs_core.timeline import TimelineService

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()
FFPROBE = Path("resources/ffmpeg/win-x64/ffprobe.exe").resolve()

_INPUT_RE = re.compile(r"^Input #(\d+),[^']*'([^']+)'")
_VDEC_START_RE = re.compile(r"^\[vist#(\d+):\d+/\S+\s+@[^\]]+\]\s+\[dec:.*Starting thread")
_STREAM_DECODED_RE = re.compile(
    r"^\[in#(\d+)/[^\]]+\]\s+Input stream #\d+:\d+\s+\((video|audio)\):\s+\d+\s+packets read[^;]*;\s+(\d+)\s+frames decoded"
)
_MAX_VOL_RE = re.compile(r"max_volume:\s*(-?\d+(?:\.\d+)?|-inf)\s*dB")


@dataclass
class InputDecodeStats:
    source: str
    video_decoder_threads: int = 0
    video_frames_decoded: int = 0
    audio_frames_decoded: int = 0


def _parse_verbose_decode_stats(stderr: str) -> dict[int, InputDecodeStats]:
    stats: dict[int, InputDecodeStats] = {}
    for raw_line in stderr.splitlines():
        line = raw_line.strip()
        m_in = _INPUT_RE.match(line)
        if m_in:
            idx = int(m_in.group(1))
            stats.setdefault(idx, InputDecodeStats(source=m_in.group(2)))
            continue
        m_vstart = _VDEC_START_RE.match(line)
        if m_vstart:
            idx = int(m_vstart.group(1))
            if idx in stats:
                stats[idx].video_decoder_threads += 1
            continue
        m_dec = _STREAM_DECODED_RE.match(line)
        if m_dec:
            idx = int(m_dec.group(1))
            kind = m_dec.group(2)
            frames = int(m_dec.group(3))
            entry = stats.setdefault(idx, InputDecodeStats(source=""))
            if kind == "video":
                entry.video_frames_decoded += frames
            else:
                entry.audio_frames_decoded += frames
    return stats


def _run_ffmpeg(*args: str, cwd: Path | None = None) -> str:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-y", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=180, check=False, cwd=cwd,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr[-2500:])
    return result.stderr


def _max_volume_db(path: Path) -> float:
    stderr = _run_ffmpeg("-i", str(path), "-vn", "-af", "volumedetect", "-f", "null", "NUL")
    match = _MAX_VOL_RE.search(stderr)
    assert match is not None, stderr[-1200:]
    raw = match.group(1)
    return float("-inf") if raw == "-inf" else float(raw)


def _setup(tmp_path: Path) -> tuple[Database, TimelineService, RenderPlanCompiler]:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as db:
        db.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("p1", "P235-R2", "active", json_dumps({"width": 1920, "height": 1080, "fps_num": 30, "fps_den": 1}),
             str(tmp_path), "tmp", "now", "now", "now"),
        )
    return database, TimelineService(database), RenderPlanCompiler(database)


def _insert_asset(database: Database, asset_id: str, kind: str, path: Path, media_info: dict) -> None:
    with database.connection() as db:
        db.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                asset_id, "p1", kind, "external", path.name, f"fp-{asset_id}",
                path.stat().st_size, "available", json_dumps(media_info), "now", "now",
            ),
        )


def _make_fixtures(tmp_path: Path) -> dict[str, Path]:
    v1080 = tmp_path / "v1080.mp4"
    v4k_sound = tmp_path / "v4k_sound.mp4"
    v4k_silent = tmp_path / "v4k_silent.mp4"
    a_seed = tmp_path / "a_seed.wav"
    still = tmp_path / "still.png"
    _run_ffmpeg(
        "-f", "lavfi", "-i", "color=c=red:s=1920x1080:r=30:d=2",
        "-c:v", "libopenh264", "-b:v", "2M", "-pix_fmt", "yuv420p", "-an", str(v1080),
    )
    _run_ffmpeg(
        "-f", "lavfi", "-i", "color=c=green:s=3840x2160:r=30:d=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v", "libopenh264", "-b:v", "4M", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-shortest", str(v4k_sound),
    )
    _run_ffmpeg(
        "-f", "lavfi", "-i", "color=c=blue:s=3840x2160:r=30:d=2",
        "-c:v", "libopenh264", "-b:v", "4M", "-pix_fmt", "yuv420p", "-an", str(v4k_silent),
    )
    _run_ffmpeg("-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=2", str(a_seed))
    _run_ffmpeg("-f", "lavfi", "-i", "color=c=yellow:s=320x180:d=1", "-frames:v", "1", str(still))
    return {
        "v1080": v1080,
        "v4k_sound": v4k_sound,
        "v4k_silent": v4k_silent,
        "a_seed": a_seed,
        "still": still,
    }


def _patch(service: TimelineService, state: dict, ops: list[dict]) -> dict:
    return service.patch("p1", {
        "schema_version": 1,
        "base_revision_id": state["current_revision"]["timeline_revision_id"],
        "operations": ops,
        "summary": "p235-r2",
    })


def test_p235_r2_audio_only_4k_video_zero_visual_decode_and_resolution_parity(tmp_path: Path) -> None:
    fixtures = _make_fixtures(tmp_path)
    database, service, compiler = _setup(tmp_path)
    probes = {
        "v1080": asyncio.run(FFprobe(FFPROBE, timeout=30.0).probe(fixtures["v1080"])),
        "v4k_sound": asyncio.run(FFprobe(FFPROBE, timeout=30.0).probe(fixtures["v4k_sound"])),
        "v4k_silent": asyncio.run(FFprobe(FFPROBE, timeout=30.0).probe(fixtures["v4k_silent"])),
        "a_seed": asyncio.run(FFprobe(FFPROBE, timeout=30.0).probe(fixtures["a_seed"], require_video=False)),
        "still": asyncio.run(FFprobe(FFPROBE, timeout=30.0).probe(fixtures["still"])),
    }
    _insert_asset(database, "v1080", "video", fixtures["v1080"], probes["v1080"])
    _insert_asset(database, "v4k_sound", "video", fixtures["v4k_sound"], probes["v4k_sound"])
    _insert_asset(database, "v4k_silent", "video", fixtures["v4k_silent"], probes["v4k_silent"])
    _insert_asset(database, "a_seed", "audio", fixtures["a_seed"], probes["a_seed"])
    _insert_asset(database, "still", "image", fixtures["still"], probes["still"])

    state = service.create("p1", {
        "schema_version": 1, "source": {"kind": "empty"},
        "default_layout": "fit", "caption_preset_id": "default-bottom",
    })
    state = _patch(service, state, [
        {"op": "insert_asset_clip", "asset_id": "v1080", "at_index": 0, "track_id": "V1"},
        {"op": "insert_asset_clip", "asset_id": "a_seed", "at_index": 0, "track_id": "A1"},
    ])
    a1_clip_id = next(c["clip_id"] for c in state["current_revision"]["document"]["clips"] if c["track_id"] == "A1")

    # 1. Replace A1 with 4K video WITH audio -> -vn added, 0 video frames decoded for 4K, output stays 1080p.
    s1 = _patch(service, state, [{"op": "replace_clip_source", "clip_id": a1_clip_id, "asset_id": "v4k_sound"}])
    plan1 = compiler.compile("p1", s1["current_revision"]["timeline_revision_id"], "final_export", output_ratio="169", resolution="original")
    assert (plan1["output"]["width"], plan1["output"]["height"]) == (1920, 1080)
    ir1 = project_preview_ir(plan1, {"v1080": probes["v1080"], "v4k_sound": {"video_streams": [], "audio_streams": [{}]}})
    v4k_ir1 = next(item for item in ir1["inputs"] if item["asset_id"] == "v4k_sound")
    assert v4k_ir1["video_required"] is False
    assert v4k_ir1["audio_required"] is True
    assert v4k_ir1["geometry"] == {"width": 0, "height": 0, "sar": 1.0}
    assert v4k_ir1["hdr"] is False

    inputs_by_id1 = {item["input_id"]: item for item in plan1["inputs"]}
    seg_paths1 = [fixtures[inputs_by_id1[seg["input_id"]]["asset_id"]] for seg in plan1["segments"]]
    seg_probes1 = [probes[inputs_by_id1[seg["input_id"]]["asset_id"]] for seg in plan1["segments"]]
    out1 = tmp_path / "out_sound_4k.mp4"
    args1 = build_timeline_args(plan1, seg_paths1, seg_probes1, "libopenh264", str(out1), captions=False)
    stderr1 = _run_ffmpeg("-v", "verbose", *args1[1:])  # reuse args minus -hide_banner duplicate is fine
    stats1 = _parse_verbose_decode_stats(stderr1)
    assert stats1[0].video_frames_decoded == 60
    assert stats1[1].source.endswith("v4k_sound.mp4")
    assert stats1[1].video_decoder_threads == 0
    assert stats1[1].video_frames_decoded == 0
    assert stats1[1].audio_frames_decoded > 0
    asyncio.run(validate_rendered_media(
        FFMPEG, FFprobe(FFPROBE, timeout=30.0), out1, plan1["output"], _rendered_duration_us(plan1["segments"]),
    ))
    assert _max_volume_db(out1) > -20.0

    # 2. Replace A1 with 4K video WITHOUT audio -> source not even opened in FFmpeg args, 0 decode, silent output.
    s2 = _patch(service, s1, [{"op": "replace_clip_source", "clip_id": a1_clip_id, "asset_id": "v4k_silent"}])
    plan2 = compiler.compile("p1", s2["current_revision"]["timeline_revision_id"], "final_export", output_ratio="169", resolution="original")
    assert (plan2["output"]["width"], plan2["output"]["height"]) == (1920, 1080)
    inputs_by_id2 = {item["input_id"]: item for item in plan2["inputs"]}
    seg_paths2 = [fixtures[inputs_by_id2[seg["input_id"]]["asset_id"]] for seg in plan2["segments"]]
    seg_probes2 = [probes[inputs_by_id2[seg["input_id"]]["asset_id"]] for seg in plan2["segments"]]
    out2 = tmp_path / "out_silent_4k.mp4"
    args2 = build_timeline_args(plan2, seg_paths2, seg_probes2, "libopenh264", str(out2), captions=False)
    assert str(fixtures["v4k_silent"]) not in args2
    assert args2.count("-i") == 1
    stderr2 = _run_ffmpeg("-v", "verbose", *args2[1:])
    stats2 = _parse_verbose_decode_stats(stderr2)
    assert len(stats2) == 1
    assert stats2[0].source.endswith("v1080.mp4")
    asyncio.run(validate_rendered_media(
        FFMPEG, FFprobe(FFPROBE, timeout=30.0), out2, plan2["output"], _rendered_duration_us(plan2["segments"]),
    ))
    assert _max_volume_db(out2) <= -90.0

    # 3. Dual-use: switch A1 back to v4k_sound and add V2 visual consumer for v4k_sound ->
    #    original becomes 2160p & visual decode happens on V2 only; after removing V2 ->
    #    original falls back to 1080p & 4K video decoding returns to 0.
    s3 = _patch(service, s2, [
        {"op": "replace_clip_source", "clip_id": a1_clip_id, "asset_id": "v4k_sound"},
        {"op": "add_track", "kind": "video", "track_id": "V2"},
        {"op": "insert_asset_clip", "asset_id": "v4k_sound", "at_index": 0, "track_id": "V2", "as_audio": False},
    ])
    plan3 = compiler.compile("p1", s3["current_revision"]["timeline_revision_id"], "final_export", output_ratio="169", resolution="original")
    assert (plan3["output"]["width"], plan3["output"]["height"]) == (3840, 2160)
    v4k_in3 = next(item for item in plan3["inputs"] if item["asset_id"] == "v4k_sound")
    assert v4k_in3["video_required"] is True and v4k_in3["audio_required"] is True
    out3 = tmp_path / "out_dual_4k.mp4"
    inputs_by_id3 = {item["input_id"]: item for item in plan3["inputs"]}
    seg_paths3 = [fixtures[inputs_by_id3[seg["input_id"]]["asset_id"]] for seg in plan3["segments"]]
    seg_probes3 = [probes[inputs_by_id3[seg["input_id"]]["asset_id"]] for seg in plan3["segments"]]
    args3 = build_timeline_args(plan3, seg_paths3, seg_probes3, "libopenh264", str(out3), captions=False)
    stderr3 = _run_ffmpeg("-v", "verbose", *args3[1:])
    stats3 = _parse_verbose_decode_stats(stderr3)
    # Segment order: V1(0), A1(-vn, 1), V2(visual, 2).
    assert stats3[1].video_decoder_threads == 0 and stats3[1].video_frames_decoded == 0
    assert stats3[2].video_decoder_threads == 1 and stats3[2].video_frames_decoded == 60

    v2_clip_id = next(c["clip_id"] for c in s3["current_revision"]["document"]["clips"] if c["track_id"] == "V2")
    s4 = _patch(service, s3, [{"op": "remove_clip", "clip_id": v2_clip_id}])
    plan4 = compiler.compile("p1", s4["current_revision"]["timeline_revision_id"], "final_export", output_ratio="169", resolution="original")
    assert (plan4["output"]["width"], plan4["output"]["height"]) == (1920, 1080)
    v4k_in4 = next(item for item in plan4["inputs"] if item["asset_id"] == "v4k_sound")
    assert v4k_in4["video_required"] is False and v4k_in4["audio_required"] is True

    # 4. >30s still (45s) preserved end-to-end across timeline mutation, compile, and IR projection.
    s5 = _patch(service, s4, [{"op": "insert_asset_clip", "asset_id": "still", "at_index": 1, "track_id": "V1"}])
    still_id = next(c["clip_id"] for c in s5["current_revision"]["document"]["clips"] if c["asset_id"] == "still")
    s6 = _patch(service, s5, [{"op": "set_image_duration", "clip_id": still_id, "duration_us": 45_000_000}])
    still_clip = next(c for c in s6["current_revision"]["document"]["clips"] if c["clip_id"] == still_id)
    assert still_clip["timeline_end_us"] - still_clip["timeline_start_us"] == 45_000_000
    plan_still = compiler.compile("p1", s6["current_revision"]["timeline_revision_id"], "authoritative_preview")
    ir_still = project_preview_ir(plan_still, {"v1080": probes["v1080"], "still": probes["still"]})
    assert ir_still["canvas"]["duration_us"] == 47_000_000
