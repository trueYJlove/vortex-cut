"""P235-R1 真 FFmpeg 集成测试：无音轨视频替换音轨静音导出 + 未知时长真实 EOF 兜底与校验。"""
from __future__ import annotations

import asyncio
import json
import re
import subprocess
from pathlib import Path

from aivs_core.database import Database, json_dumps
from aivs_core.media.ffprobe import FFprobe
from aivs_core.rendering.ffmpeg import build_timeline_args, run_timeline_render
from aivs_core.rendering.plan import RenderPlanCompiler
from aivs_core.rendering.service import _rendered_duration_us
from aivs_core.rendering.validation import MAX_DURATION_ERROR_US, validate_rendered_media
from aivs_core.timeline import TimelineService

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()
FFPROBE = Path("resources/ffmpeg/win-x64/ffprobe.exe").resolve()

_MAX_VOL_RE = re.compile(r"max_volume:\s*(-?\d+(?:\.\d+)?|-inf)\s*dB")


def _run_ffmpeg(*args: str, cwd: Path | None = None) -> str:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-y", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=180, check=False, cwd=cwd,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr[-2500:])
    return result.stderr


def _max_volume_db(path: Path, *, ss: float | None = None, duration: float | None = None) -> float:
    args: list[str] = []
    if ss is not None:
        args += ["-ss", f"{ss:.3f}"]
    if duration is not None:
        args += ["-t", f"{duration:.3f}"]
    args += ["-i", str(path), "-vn", "-af", "volumedetect", "-f", "null", "NUL"]
    stderr = _run_ffmpeg(*args)
    match = _MAX_VOL_RE.search(stderr)
    assert match is not None, stderr[-1200:]
    raw = match.group(1)
    return float("-inf") if raw == "-inf" else float(raw)


def _sample_rgb_at(path: Path, t_sec: float, width: int = 320, height: int = 180) -> tuple[int, int, int]:
    result = subprocess.run(
        [
            str(FFMPEG), "-hide_banner", "-v", "error",
            "-ss", f"{t_sec:.3f}", "-i", str(path),
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ],
        capture_output=True, timeout=60, check=False,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")[-800:]
    assert len(result.stdout) >= width * height * 3
    offset = ((height // 2) * width + (width // 2)) * 3
    return result.stdout[offset], result.stdout[offset + 1], result.stdout[offset + 2]


def _setup_project(tmp_path: Path) -> tuple[Database, TimelineService, RenderPlanCompiler]:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as db:
        db.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("p1", "P235-R1", "active", json_dumps({"width": 320, "height": 180, "fps_num": 30, "fps_den": 1}),
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


def _create_empty_with_video(service: TimelineService, asset_id: str) -> dict:
    state = service.create("p1", {
        "schema_version": 1, "source": {"kind": "empty"},
        "default_layout": "fit", "caption_preset_id": "default-bottom",
    })
    return _patch(service, state, [{"op": "insert_asset_clip", "asset_id": asset_id, "at_index": 0, "track_id": "V1"}])


def _patch(service: TimelineService, state: dict, operations: list[dict]) -> dict:
    return service.patch("p1", {
        "schema_version": 1,
        "base_revision_id": state["current_revision"]["timeline_revision_id"],
        "operations": operations,
        "summary": "p235-r1",
    })


async def _render_and_validate(
    plan: dict,
    segment_paths: list[Path],
    segment_probes: list[dict],
    output: Path,
    work_dir: Path,
) -> dict:
    plan["output"]["width"] = 320
    plan["output"]["height"] = 180
    expected_duration = _rendered_duration_us(plan["segments"])
    args = build_timeline_args(
        plan,
        segment_paths,
        segment_probes,
        "libopenh264",
        str(output),
        captions=False,
    )
    await run_timeline_render(
        FFMPEG, args, work_dir, expected_duration,
        asyncio.Event(), lambda _progress: None, lambda _pid: None,
    )
    media_info, _size, _digest = await validate_rendered_media(
        FFMPEG, FFprobe(FFPROBE, timeout=30.0), output, plan["output"], expected_duration,
    )
    return media_info


def test_p235_r1_silent_video_replaces_audio_clip_and_renders_valid_silence(tmp_path: Path) -> None:
    silent_vid = tmp_path / "silent.mp4"
    tone_wav = tmp_path / "tone.wav"
    _run_ffmpeg(
        "-f", "lavfi", "-i", "color=c=green:s=320x180:r=30:d=2",
        "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-an", str(silent_vid),
    )
    _run_ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", str(tone_wav))

    database, service, compiler = _setup_project(tmp_path)
    _insert_asset(database, "v-silent", "video", silent_vid, {
        "duration_us": 2_000_000, "video_streams": [{"width": 320, "height": 180}], "audio_streams": [],
    })
    _insert_asset(database, "a-tone", "audio", tone_wav, {
        "duration_us": 2_000_000, "video_streams": [], "audio_streams": [{"codec": "pcm_s16le", "sample_rate": 48000, "channels": 1}],
    })

    state = _create_empty_with_video(service, "v-silent")
    state = _patch(service, state, [{"op": "insert_asset_clip", "asset_id": "a-tone", "at_index": 0, "track_id": "A1"}])
    audio_clip = next(c for c in state["current_revision"]["document"]["clips"] if c["track_id"] == "A1")

    replaced = _patch(service, state, [
        {"op": "replace_clip_source", "clip_id": audio_clip["clip_id"], "asset_id": "v-silent"},
        {"op": "set_audio", "clip_id": audio_clip["clip_id"], "enabled": True, "gain_db": 3.0, "fade_in_us": 200_000},
    ])
    rev_id = replaced["current_revision"]["timeline_revision_id"]
    path_map = {"v-silent": silent_vid, "a-tone": tone_wav}
    probe_map = {
        "v-silent": asyncio.run(FFprobe(FFPROBE, timeout=30.0).probe(silent_vid)),
        "a-tone": asyncio.run(FFprobe(FFPROBE, timeout=30.0).probe(tone_wav, require_video=False)),
    }

    for mode, name in (("authoritative_preview", "preview.mp4"), ("final_export", "export.mp4")):
        plan = compiler.compile("p1", rev_id, mode)
        inputs_by_id = {item["input_id"]: item for item in plan["inputs"]}
        seg_paths = [path_map[inputs_by_id[seg["input_id"]]["asset_id"]] for seg in plan["segments"]]
        seg_probes = [probe_map[inputs_by_id[seg["input_id"]]["asset_id"]] for seg in plan["segments"]]
        out = tmp_path / name
        media = asyncio.run(_render_and_validate(plan, seg_paths, seg_probes, out, tmp_path))
        assert abs(media["duration_us"] - 2_000_000) <= MAX_DURATION_ERROR_US
        assert _max_volume_db(out) <= -90.0

    undone = service.undo("p1", rev_id)
    restored = next(c for c in undone["current_revision"]["document"]["clips"] if c["clip_id"] == audio_clip["clip_id"])
    assert restored["asset_id"] == "a-tone"


def test_p235_r1_unknown_duration_short_video_eof_pads_to_target_and_slips_past_eof(tmp_path: Path) -> None:
    target_vid = tmp_path / "target3s.mp4"
    short_vid = tmp_path / "short1s.mp4"
    _run_ffmpeg(
        "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=3",
        "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-an", str(target_vid),
    )
    _run_ffmpeg(
        "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=1",
        "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-an", str(short_vid),
    )

    database, service, compiler = _setup_project(tmp_path)
    _insert_asset(database, "v-target", "video", target_vid, {
        "duration_us": 3_000_000, "video_streams": [{"width": 320, "height": 180}], "audio_streams": [],
    })
    # Deliberately store unknown duration_us=0 for a physical 1s video file.
    _insert_asset(database, "v-short-unknown", "video", short_vid, {
        "duration_us": 0, "video_streams": [{"width": 320, "height": 180}], "audio_streams": [],
    })

    state = _create_empty_with_video(service, "v-target")
    clip = state["current_revision"]["document"]["clips"][0]
    replaced = _patch(service, state, [{"op": "replace_clip_source", "clip_id": clip["clip_id"], "asset_id": "v-short-unknown"}])
    replaced_clip = replaced["current_revision"]["document"]["clips"][0]
    assert (replaced_clip["source_start_us"], replaced_clip["source_end_us"]) == (0, 3_000_000)
    assert (replaced_clip["timeline_start_us"], replaced_clip["timeline_end_us"]) == (0, 3_000_000)

    real_probe = asyncio.run(FFprobe(FFPROBE, timeout=30.0).probe(short_vid))
    unprobed_probe = {"duration_us": 0, "video_streams": [{"width": 320, "height": 180}], "audio_streams": []}
    for label, seg_probe in (("real_probe", real_probe), ("unknown_probe", unprobed_probe)):
        plan = compiler.compile("p1", replaced["current_revision"]["timeline_revision_id"], "final_export")
        out = tmp_path / f"eof-{label}.mp4"
        media = asyncio.run(_render_and_validate(plan, [short_vid], [seg_probe], out, tmp_path))
        assert abs(media["duration_us"] - 3_000_000) <= MAX_DURATION_ERROR_US
        r0, g0, b0 = _sample_rgb_at(out, 0.4)
        assert b0 > 180 and r0 < 50 and g0 < 50
        r1, g1, b1 = _sample_rgb_at(out, 2.2)
        assert max(r1, g1, b1) < 25

    slipped = _patch(service, replaced, [{
        "op": "set_clip_source_window",
        "clip_id": clip["clip_id"],
        "source_start_us": 1_500_000,
        "source_end_us": 3_000_000,
        "anchor": "start",
    }])
    slipped_plan = compiler.compile("p1", slipped["current_revision"]["timeline_revision_id"], "final_export")
    slipped_out = tmp_path / "eof-slipped.mp4"
    slipped_media = asyncio.run(_render_and_validate(slipped_plan, [short_vid], [real_probe], slipped_out, tmp_path))
    assert abs(slipped_media["duration_us"] - 1_500_000) <= MAX_DURATION_ERROR_US
    rs, gs, bs = _sample_rgb_at(slipped_out, 0.5)
    assert max(rs, gs, bs) < 25


def test_p235_r1_unknown_duration_short_audio_eof_pads_silence(tmp_path: Path) -> None:
    vid3s = tmp_path / "v3s.mp4"
    wav3s = tmp_path / "a3s.wav"
    short_wav = tmp_path / "a1s.wav"
    _run_ffmpeg(
        "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=3",
        "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-an", str(vid3s),
    )
    _run_ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", str(wav3s))
    _run_ffmpeg("-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=1", str(short_wav))

    database, service, compiler = _setup_project(tmp_path)
    _insert_asset(database, "v3", "video", vid3s, {
        "duration_us": 3_000_000, "video_streams": [{"width": 320, "height": 180}], "audio_streams": [],
    })
    _insert_asset(database, "a3", "audio", wav3s, {
        "duration_us": 3_000_000, "video_streams": [], "audio_streams": [{"codec": "pcm_s16le", "sample_rate": 48000, "channels": 1}],
    })
    # Physical 1s audio stored with unknown duration_us=None.
    _insert_asset(database, "a-short-unknown", "audio", short_wav, {
        "duration_us": None, "video_streams": [], "audio_streams": [{"codec": "pcm_s16le", "sample_rate": 48000, "channels": 1}],
    })

    state = _create_empty_with_video(service, "v3")
    state = _patch(service, state, [{"op": "insert_asset_clip", "asset_id": "a3", "at_index": 0, "track_id": "A1"}])
    audio_clip = next(c for c in state["current_revision"]["document"]["clips"] if c["track_id"] == "A1")
    replaced = _patch(service, state, [{"op": "replace_clip_source", "clip_id": audio_clip["clip_id"], "asset_id": "a-short-unknown"}])

    plan = compiler.compile("p1", replaced["current_revision"]["timeline_revision_id"], "final_export")
    inputs_by_id = {item["input_id"]: item for item in plan["inputs"]}
    probes_by_asset = {
        "v3": asyncio.run(FFprobe(FFPROBE, timeout=30.0).probe(vid3s)),
        "a-short-unknown": asyncio.run(FFprobe(FFPROBE, timeout=30.0).probe(short_wav, require_video=False)),
    }
    paths_by_asset = {"v3": vid3s, "a-short-unknown": short_wav}
    seg_paths = [paths_by_asset[inputs_by_id[seg["input_id"]]["asset_id"]] for seg in plan["segments"]]
    seg_probes = [probes_by_asset[inputs_by_id[seg["input_id"]]["asset_id"]] for seg in plan["segments"]]

    out = tmp_path / "audio-eof.mp4"
    media = asyncio.run(_render_and_validate(plan, seg_paths, seg_probes, out, tmp_path))
    assert abs(media["duration_us"] - 3_000_000) <= MAX_DURATION_ERROR_US
    assert _max_volume_db(out, ss=0.0, duration=0.8) > -20.0
    assert _max_volume_db(out, ss=1.3, duration=1.5) <= -90.0
