"""W0.4 系统预测导出：对 eval 素材跑真实 CV/节拍/L-J 输出，写入 predictions/。

**禁止用真值冒充预测**——本脚本只调用生产算法：
- scene_cut：`analyze_video` 采样 + `frame_signals` 镜头边界
- beat_grid：`beat_grid.analyze_pcm`
- lj_cut：`asr_words.resolve_lj_words`（faster-whisper 词戳，失败回退能量伪词）
  + `auto_lj_mode` / `choose_audio_delta`

产出：
- `eval_set/predictions/<asset_id>/scene_cut.json`
- `eval_set/predictions/<asset_id>/beat_grid.json`（music 档）
- `eval_set/predictions/<asset_id>/lj_cut.json`（有 `lj_offsets` 标注时）
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

from aivs_core.editing_grammar.lj_cut import auto_lj_mode, choose_audio_delta  # noqa: E402
from aivs_core.media.beat_grid import analyze_pcm  # noqa: E402
from aivs_core.media.cv_signals import analyze_video  # noqa: E402

from asr_words import resolve_lj_words  # noqa: E402

EVAL_SET = ROOT / "eval_set"
MEDIA_DIR = ROOT / "test-assets" / "generated" / "eval"
FFMPEG = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
WORD_CHUNK_US = 400_000


def _load_manifest() -> dict:
    return json.loads((EVAL_SET / "manifest.json").read_text(encoding="utf-8"))


def _load_annotation(asset_id: str) -> dict | None:
    path = EVAL_SET / "annotations" / f"{asset_id}.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _wav_pcm(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "r") as wav:
        raw = wav.readframes(wav.getnframes())
        ints = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
        if wav.getnchannels() > 1:
            ints = ints.reshape(-1, wav.getnchannels()).mean(axis=1)
        return ints, wav.getframerate()


def _media_path(asset: dict) -> Path | None:
    media = asset.get("media")
    if not media:
        return None
    path = ROOT / media
    return path if path.is_file() else None


async def _scene_cuts(media: Path) -> tuple[list[int], str]:
    samples = await analyze_video(FFMPEG, media, asyncio.Event(), skip_frame=False)
    cuts = [int(s["timestamp_us"]) for s in samples if s.get("scene_cut")]
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
        ann = _load_annotation(asset_id) or {}

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
            pcm, _sr = _wav_pcm(wav_path)
            result = analyze_pcm(pcm)
            _write_pred(asset_id, "beat_grid", {
                "task": "beat_grid",
                "status": result.get("status"),
                "bpm": result.get("bpm"),
                "beats_us": result.get("beats_us") or [],
            })

        # L/J：有 lj_offsets 标注时，给定画面切点评估偏移规则
        #（词戳 = 能量伪词代理；规则 = 生产 auto_lj_mode + choose_audio_delta）。
        lj_labels = ann.get("lj_offsets") or []
        if lj_labels:
            wav_path = media.with_suffix(".wav")
            if not wav_path.is_file():
                print(f"skip lj_cut {asset_id}: missing {wav_path.name}")
                continue
            words, word_source = resolve_lj_words(media)
            pcm, sr = _wav_pcm(wav_path)
            clip_end_us = int(len(pcm) / sr * 1_000_000) if sr else 0
            items = []
            for lab in lj_labels:
                at = int(lab["at_us"])
                try:
                    mode = auto_lj_mode(words, at)
                    decision = choose_audio_delta(
                        mode=mode,
                        picture_cut_us=at,
                        words=words,
                        clip_start_us=0,
                        clip_end_us=clip_end_us,
                        offset_us=400_000,
                    )
                except Exception as exc:  # noqa: BLE001
                    print(f"skip lj item {asset_id}@{at}: {exc}")
                    continue
                items.append({
                    "at_us": at,
                    "direction": "J" if mode == "j" else "L",
                    "delta_us": int(decision["audio_delta_us"]),
                })
            _write_pred(asset_id, "lj_cut", {
                "task": "lj_cut",
                "word_source": word_source,
                "items": items,
            })

        # 召回排序：有 recall 标注时，按窗口音频能量排序（对齐 _cv_scenes 特征排序精神）。
        # 窗口 id 形如 `t{start_us}`，窗宽由相邻 id 差或末窗时长推断。
        recall_ann = ann.get("recall") or {}
        queries = recall_ann.get("queries") or []
        if queries:
            wav_path = media.with_suffix(".wav")
            if not wav_path.is_file():
                print(f"skip recall {asset_id}: missing {wav_path.name}")
                continue
            pcm, sr = _wav_pcm(wav_path)
            duration_us = int(len(pcm) / sr * 1_000_000) if sr else 0
            pred_queries = []
            for q in queries:
                qid = q.get("query_id") or "q"
                rel = q.get("relevance") or {}
                starts = []
                for key in rel:
                    text = str(key)
                    if text.startswith("t") and text[1:].isdigit():
                        starts.append(int(text[1:]))
                if not starts:
                    continue
                starts.sort()
                if len(starts) >= 2:
                    win_us = starts[1] - starts[0]
                else:
                    win_us = max(duration_us, 1)
                scores = []
                for start in starts:
                    end = min(start + win_us, duration_us) if duration_us else start + win_us
                    a = int(start * sr / 1_000_000) if sr else 0
                    b = int(end * sr / 1_000_000) if sr else 0
                    chunk = pcm[a:b] if b > a else pcm[:1]
                    energy = float(np.sqrt(np.mean(chunk**2))) if chunk.size else 0.0
                    scores.append((energy, f"t{start}"))
                scores.sort(key=lambda t: (-t[0], t[1]))
                pred_queries.append({
                    "query_id": qid,
                    "ranking": [wid for _, wid in scores],
                })
            _write_pred(asset_id, "recall", {"task": "recall_rank", "queries": pred_queries})
    print("done")


if __name__ == "__main__":
    main()
