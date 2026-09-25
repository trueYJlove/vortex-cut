"""W0.4 补素材：生成带真值标注的合成评测媒体（零 egress）。

产出：
- spoken_single ×5（含已知静音/切点，合计 ≥600s）
- music ×3（90/110/140 BPM click，含 beat_grid 真值）
- life_no_voice ×3（硬切真值）
- long_gop ×2（GOP≥5s + 硬切真值）
- spoken_multi ×2（双说话人切换真值）

媒体入 `test-assets/generated/eval/`；标注入 `eval_set/annotations/`；
manifest 同步写 `eval_set/manifest.json`。
"""

from __future__ import annotations

import json
import math
import struct
import subprocess
import wave
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MEDIA_DIR = ROOT / "test-assets" / "generated" / "eval"
EVAL_SET = ROOT / "eval_set"
# 打包 ffmpeg（与 Core 集成测试同源）；无 libx264，视频用 mpeg4。
FFMPEG = str(ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe")


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"cmd failed: {' '.join(cmd)}\n{proc.stderr[-400:]}")


def _write_wav(path: Path, samples: list[float], sr: int = 22050) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "w") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sr)
        frames = bytearray()
        for value in samples:
            frames += struct.pack("<h", max(-32767, min(32767, int(value * 32767))))
        wav.writeframes(frames)


def _tone_segment(duration_s: float, freq: float, amp: float, sr: int = 22050) -> list[float]:
    n = int(duration_s * sr)
    return [amp * math.sin(2 * math.pi * freq * i / sr) for i in range(n)]


def _silence_segment(duration_s: float, sr: int = 22050) -> list[float]:
    return [0.0] * int(duration_s * sr)


def _mux_av(video_args: list[str], audio_wav: Path | None, out: Path, extra: list[str] | None = None) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [FFMPEG, "-hide_banner", "-nostdin", "-y", *video_args]
    if audio_wav is not None:
        cmd += ["-i", str(audio_wav)]
        cmd += ["-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "96k"]
    else:
        cmd += ["-an"]
    cmd += ["-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-r", "30"]
    if extra:
        cmd += extra
    cmd += [str(out)]
    _run(cmd)


def _color_clip(color: str, duration_s: float) -> list[str]:
    return [
        "-f", "lavfi",
        "-i", f"color=c={color}:s=320x180:d={duration_s}",
    ]


def make_spoken_single(index: int) -> dict:
    """口播单机位：说话段 + 已知静音 + 说话段；画面两色硬切。"""
    asset_id = f"spoken-single-{index:02d}"
    # 20s + 1.2s 静音 + 20s + 1.0s 静音 + 20s = 62.2s；5 条 ≈ 311s——
    # 为满足 min_total_duration_s=600，单条拉到 120s。
    speech_s, silence_s = 39.0, 2.5
    total_s = speech_s * 3 + silence_s * 2  # 116.4
    # 真值静音（源时间）
    silences = [
        {"start_us": int(speech_s * 1e6), "end_us": int((speech_s + silence_s) * 1e6)},
        {
            "start_us": int((speech_s * 2 + silence_s) * 1e6),
            "end_us": int((speech_s * 2 + silence_s * 2) * 1e6),
        },
    ]
    # 硬切真值：三段画面
    cuts = [int(speech_s * 1e6), int((speech_s * 2 + silence_s) * 1e6)]
    samples: list[float] = []
    samples += _tone_segment(speech_s, 220.0 + index * 10, 0.35)
    samples += _silence_segment(silence_s)
    samples += _tone_segment(speech_s, 240.0 + index * 10, 0.35)
    samples += _silence_segment(silence_s)
    samples += _tone_segment(speech_s, 260.0 + index * 10, 0.35)
    wav = MEDIA_DIR / f"{asset_id}.wav"
    _write_wav(wav, samples)
    out = MEDIA_DIR / f"{asset_id}.mp4"
    # 三色拼接硬切
    seg = speech_s
    cmd = [
        FFMPEG, "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", f"color=c=red:s=320x180:d={seg}",
        "-f", "lavfi", "-i", f"color=c=green:s=320x180:d={seg + silence_s}",
        "-f", "lavfi", "-i", f"color=c=blue:s=320x180:d={seg + silence_s}",
        "-i", str(wav),
        "-filter_complex",
        "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
        "-map", "[v]", "-map", "3:a:0",
        "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-r", "30",
        "-c:a", "aac", "-b:a", "96k",
        "-t", str(total_s),
        str(out),
    ]
    _run(cmd)
    return {
        "asset_id": asset_id,
        "bucket": "spoken_single",
        "kind": "synthetic_media",
        "media": str(out.relative_to(ROOT)).replace("\\", "/"),
        "duration_us": int(total_s * 1e6),
        "annotation": {
            "scene_cuts_us": cuts,
            "silence_intervals_us": silences,
        },
    }


def make_music(bpm: float) -> dict:
    asset_id = f"music-{int(bpm)}bpm"
    duration_s = 30.0
    wav = MEDIA_DIR / f"{asset_id}.wav"
    # click 轨：与 beat_grid.synthesize_click_pcm 同构的方波 click
    sr = 22050
    beat_s = 60.0 / bpm
    samples = [0.0] * int(duration_s * sr)
    truth: list[int] = []
    t = 0.0
    while t < duration_s:
        truth.append(int(t * 1e6))
        start = int(t * sr)
        click_n = int(0.03 * sr)
        for i in range(click_n):
            if start + i < len(samples):
                samples[start + i] = 0.6 if i < click_n // 2 else -0.6
        t += beat_s
    _write_wav(wav, samples)
    out = MEDIA_DIR / f"{asset_id}.mp4"
    _mux_av(_color_clip("purple", duration_s), wav, out)
    return {
        "asset_id": asset_id,
        "bucket": "music",
        "kind": "synthetic_media",
        "media": str(out.relative_to(ROOT)).replace("\\", "/"),
        "duration_us": int(duration_s * 1e6),
        "annotation": {
            "beat_grid_us": truth,
        },
    }


def make_life_no_voice(index: int) -> dict:
    asset_id = f"life-no-voice-{index:02d}"
    duration_s = 12.0
    cut_at = 4.0
    out = MEDIA_DIR / f"{asset_id}.mp4"
    cmd = [
        FFMPEG, "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", f"color=c=orange:s=320x180:d={cut_at}",
        "-f", "lavfi", "-i", f"color=c=cyan:s=320x180:d={duration_s - cut_at}",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map", "[v]", "-an",
        "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-r", "30",
        str(out),
    ]
    _run(cmd)
    return {
        "asset_id": asset_id,
        "bucket": "life_no_voice",
        "kind": "synthetic_media",
        "media": str(out.relative_to(ROOT)).replace("\\", "/"),
        "duration_us": int(duration_s * 1e6),
        "annotation": {
            "scene_cuts_us": [int(cut_at * 1e6)],
        },
    }


def make_long_gop(index: int) -> dict:
    asset_id = f"long-gop-{index:02d}"
    duration_s = 12.0
    cut_at = 6.0
    out = MEDIA_DIR / f"{asset_id}.mp4"
    # 强制 GOP 5s（-g 150 @30fps）
    cmd = [
        FFMPEG, "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", f"color=c=yellow:s=320x180:d={cut_at}",
        "-f", "lavfi", "-i", f"color=c=magenta:s=320x180:d={duration_s - cut_at}",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map", "[v]", "-an",
        "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-r", "30",
        "-g", "150", "-keyint_min", "150",
        str(out),
    ]
    _run(cmd)
    return {
        "asset_id": asset_id,
        "bucket": "long_gop",
        "kind": "synthetic_media",
        "media": str(out.relative_to(ROOT)).replace("\\", "/"),
        "duration_us": int(duration_s * 1e6),
        "annotation": {
            "scene_cuts_us": [int(cut_at * 1e6)],
        },
    }


def make_spoken_multi(index: int) -> dict:
    asset_id = f"spoken-multi-{index:02d}"
    # 双说话人各 8s，切换点 + 中间 0.8s 静音
    a_s, gap_s, b_s = 8.0, 0.8, 8.0
    total_s = a_s + gap_s + b_s
    samples = []
    samples += _tone_segment(a_s, 180.0, 0.35)
    samples += _silence_segment(gap_s)
    samples += _tone_segment(b_s, 300.0, 0.35)
    wav = MEDIA_DIR / f"{asset_id}.wav"
    _write_wav(wav, samples)
    out = MEDIA_DIR / f"{asset_id}.mp4"
    cmd = [
        FFMPEG, "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", f"color=c=white:s=320x180:d={a_s}",
        "-f", "lavfi", "-i", f"color=c=black:s=320x180:d={gap_s + b_s}",
        "-i", str(wav),
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map", "[v]", "-map", "2:a:0",
        "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-r", "30",
        "-c:a", "aac", "-b:a", "96k",
        str(out),
    ]
    _run(cmd)
    return {
        "asset_id": asset_id,
        "bucket": "spoken_multi",
        "kind": "synthetic_media",
        "media": str(out.relative_to(ROOT)).replace("\\", "/"),
        "duration_us": int(total_s * 1e6),
        "annotation": {
            "scene_cuts_us": [int(a_s * 1e6)],
            "silence_intervals_us": [
                {"start_us": int(a_s * 1e6), "end_us": int((a_s + gap_s) * 1e6)}
            ],
            "speaker_turns": [
                {"start_us": 0, "end_us": int(a_s * 1e6), "speaker": "A"},
                {
                    "start_us": int((a_s + gap_s) * 1e6),
                    "end_us": int(total_s * 1e6),
                    "speaker": "B",
                },
            ],
        },
    }


def main() -> None:
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    (EVAL_SET / "annotations").mkdir(parents=True, exist_ok=True)
    entries: list[dict] = []

    for i in range(5):
        entries.append(make_spoken_single(i + 1))
    for bpm in (90.0, 110.0, 140.0):
        entries.append(make_music(bpm))
    for i in range(3):
        entries.append(make_life_no_voice(i + 1))
    for i in range(2):
        entries.append(make_long_gop(i + 1))
    for i in range(2):
        entries.append(make_spoken_multi(i + 1))
    entries.append(make_spoken_multi(3))

    # 保留 harness 自检 fixture + 既有 4k60 条目
    manifest_path = EVAL_SET / "manifest.json"
    old = json.loads(manifest_path.read_text(encoding="utf-8"))
    keep = [
        a
        for a in old.get("assets", [])
        if a["asset_id"] in {"syn-cut-basic", "syn-ndcg-basic", "4k60-hevc-gop5s-60s"}
    ]

    assets = []
    for entry in entries:
        ann = entry.pop("annotation")
        asset_id = entry["asset_id"]
        doc = {
            "schema_version": 1,
            "asset_id": asset_id,
            "bucket": entry["bucket"],
            "annotator": "synthetic-ground-truth",
            "annotated_at": _utc_now(),
            "notes": "合成真值标注（make_eval_materials.py）",
            **ann,
        }
        (EVAL_SET / "annotations" / f"{asset_id}.json").write_text(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        assets.append(entry)

    manifest = {
        "schema_version": 1,
        "buckets": old["buckets"],
        "assets": keep + assets,
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {len(assets)} assets -> {MEDIA_DIR}")
    print(f"manifest: {manifest_path}")


if __name__ == "__main__":
    main()
