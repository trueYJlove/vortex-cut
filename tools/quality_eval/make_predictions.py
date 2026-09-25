"""W0.4 系统预测导出：对 eval 素材跑真实 CV/节拍输出，写入 predictions/。

**禁止用真值冒充预测**——本脚本只调用生产算法：
- scene_cut：`analyze_video` 采样 + `frame_signals` 镜头边界
- beat_grid：`beat_grid.analyze_pcm`

产出：
- `eval_set/predictions/<asset_id>/scene_cut.json`
- `eval_set/predictions/<asset_id>/beat_grid.json`（music 档）
"""

from __future__ import annotations

import asyncio
import json
import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))

from aivs_core.media.beat_grid import analyze_pcm  # noqa: E402
from aivs_core.media.cv_signals import analyze_video  # noqa: E402

EVAL_SET = ROOT / "eval_set"
MEDIA_DIR = ROOT / "test-assets" / "generated" / "eval"
FFMPEG = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"


def _load_manifest() -> dict:
    return json.loads((EVAL_SET / "manifest.json").read_text(encoding="utf-8"))


def _wav_pcm(path: Path) -> np.ndarray:
    with wave.open(str(path), "r") as wav:
        raw = wav.readframes(wav.getnframes())
        ints = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
        if wav.getnchannels() > 1:
            ints = ints.reshape(-1, wav.getnchannels()).mean(axis=1)
        return ints


def _media_path(asset: dict) -> Path | None:
    media = asset.get("media")
    if not media:
        return None
    path = ROOT / media
    return path if path.is_file() else None


async def _scene_cuts(media: Path) -> tuple[list[int], str]:
    samples = await analyze_video(FFMPEG, media, asyncio.Event(), skip_frame=False)
    cuts = [int(s["timestamp_us"]) for s in samples if s.get("scene_cut")]
    # 与 density_status 判据对齐：最大间隔 > 4s 视为 sparse
    gaps = [
        b["timestamp_us"] - a["timestamp_us"]
        for a, b in zip(samples, samples[1:])
    ]
    max_gap = max(gaps, default=0)
    density = "sparse" if max_gap > 4_000_000 else "full"
    return cuts, density


def _write_pred(asset_id: str, task: str, doc: dict) -> None:
    out_dir = EVAL_SET / "predictions" / asset_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{task}.json"
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT)}")


def main() -> None:
    if not FFMPEG.is_file():
        raise SystemExit(f"bundled ffmpeg missing: {FFMPEG}")
    manifest = _load_manifest()
    for asset in manifest.get("assets", []):
        asset_id = asset["asset_id"]
        media = _media_path(asset)
        if media is None:
            continue
        bucket = asset.get("bucket", "")

        # 切点：所有有媒体的资产都可跑（标注侧有 scene_cuts_us 才计分）
        if media.suffix.lower() in {".mp4", ".mov", ".webm", ".mkv"}:
            try:
                cuts, density = asyncio.run(_scene_cuts(media))
            except Exception as exc:  # noqa: BLE001 — 单素材失败不阻断其余
                print(f"skip scene_cut {asset_id}: {exc}")
            else:
                _write_pred(asset_id, "scene_cut", {
                    "task": "scene_cut",
                    "density_status": density,
                    "cuts_us": cuts,
                })

        # 节拍：music 档（同源 wav）
        if bucket == "music":
            wav_path = media.with_suffix(".wav")
            if not wav_path.is_file():
                print(f"skip beat_grid {asset_id}: missing {wav_path.name}")
                continue
            result = analyze_pcm(_wav_pcm(wav_path))
            _write_pred(asset_id, "beat_grid", {
                "task": "beat_grid",
                "status": result.get("status"),
                "bpm": result.get("bpm"),
                "beats_us": result.get("beats_us") or [],
            })
    print("done")


if __name__ == "__main__":
    main()
