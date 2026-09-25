"""Wave 1 真实/合成媒体 e2e 验收（W0.4 补样后补做）。

覆盖此前因素材缺口延后的项：
- W1.5 去停顿：口播样例 + 真值静音
- W1.2 节拍网格：click 音轨 BPM/beat 误差门
- W1.3 卡点：真值 beat 网格吸附
- W1.4 L/J：词级时间戳 → split_edit delta

媒体由 `tools/quality_eval/make_eval_materials.py` 生成（真值标注在 eval_set）。
"""

from __future__ import annotations

import json
import math
import struct
import wave
from pathlib import Path

import numpy as np
import pytest

from aivs_core.editing_grammar.beat_sync import BeatSyncPlanner
from aivs_core.editing_grammar.lj_cut import choose_audio_delta
from aivs_core.editing_grammar.silence import (
    compute_keep_intervals,
    detect_silence_intervals,
)
from aivs_core.media.beat_grid import analyze_pcm

ROOT = Path(__file__).resolve().parents[4]
EVAL_SET = ROOT / "eval_set"
MEDIA_DIR = ROOT / "test-assets" / "generated" / "eval"
MIN_VIDEO_US = 100_000


def _annotation(asset_id: str) -> dict:
    path = EVAL_SET / "annotations" / f"{asset_id}.json"
    if not path.is_file():
        pytest.skip(f"eval annotation missing: {asset_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def _media(asset_id: str) -> Path:
    path = MEDIA_DIR / f"{asset_id}.mp4"
    if not path.is_file():
        pytest.skip(f"eval media missing: {asset_id}")
    return path


def _wav_samples(path: Path) -> np.ndarray:
    with wave.open(str(path), "r") as wav:
        n = wav.getnframes()
        raw = wav.readframes(n)
        width = wav.getsampwidth()
        if width != 2:
            raise AssertionError(f"unexpected sampwidth {width}")
        ints = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
        return ints


class TestW15RemovePausesRealMedia:
    def test_spoken_silence_intervals_match_ground_truth(self) -> None:
        """口播样例：检测到的静音与标注真值对齐（容差 300ms）。"""
        asset_id = "spoken-single-01"
        ann = _annotation(asset_id)
        media = _media(asset_id)
        assert media.is_file()
        truth = [(s["start_us"], s["end_us"]) for s in ann["silence_intervals_us"]]
        assert len(truth) >= 2

        # 从同源 wav 取能量样本（200ms 窗——贴近 CV 语义同时保留静音边界）
        wav_path = MEDIA_DIR / f"{asset_id}.wav"
        pcm = _wav_samples(wav_path)
        sr = 22050
        win = sr // 5  # 200ms
        samples = []
        for i in range(0, len(pcm) - win + 1, win):
            chunk = pcm[i : i + win]
            samples.append(
                {
                    "timestamp_us": int(i / sr * 1e6),
                    "audio_energy": float(np.sqrt(np.mean(chunk**2))),
                }
            )
        got = detect_silence_intervals(samples, energy_threshold=0.05, min_silence_us=400_000)
        assert len(got) == len(truth), f"静音段数不符: got={got} truth={truth}"
        for (gs, ge), (ts, te) in zip(got, truth, strict=True):
            assert abs(gs - ts) <= 300_000
            assert abs(ge - te) <= 300_000

    def test_keep_intervals_drop_silence_and_close_timeline(self) -> None:
        ann = _annotation("spoken-single-01")
        truth = [(s["start_us"], s["end_us"]) for s in ann["silence_intervals_us"]]
        end_us = ann["duration_us"] if "duration_us" in ann else 122_400_000
        keeps = compute_keep_intervals(truth, start_us=0, end_us=end_us, pad_us=50_000)
        assert keeps
        assert keeps[0][0] == 0
        assert keeps[-1][1] == end_us
        for s, e in keeps:
            assert e - s >= MIN_VIDEO_US
        # 保留段总长 < 全长（静音被去掉）
        total_keep = sum(e - s for s, e in keeps)
        assert total_keep < end_us


class TestW12BeatGridRealMedia:
    @pytest.mark.parametrize("bpm", [90.0, 110.0, 140.0])
    def test_click_track_bpm_within_tolerance(self, bpm: float) -> None:
        asset_id = f"music-{int(bpm)}bpm"
        ann = _annotation(asset_id)
        wav_path = MEDIA_DIR / f"{asset_id}.wav"
        if not wav_path.is_file():
            pytest.skip(f"missing {wav_path}")
        pcm = _wav_samples(wav_path)
        result = analyze_pcm(pcm)
        assert result["status"] == "ready"
        assert result["bpm"] == pytest.approx(bpm, rel=0.05), (
            f"{asset_id}: bpm={result['bpm']} vs {bpm}"
        )
        truth = ann["beat_grid_us"]
        pred = result["beats_us"]
        hit = sum(
            1 for t in truth if any(abs(p - t) <= 50_000 for p in pred)
        ) / len(truth)
        assert hit >= 0.85, f"{asset_id}: beat hit rate {hit:.2f}"


class TestW13BeatSyncRealMedia:
    def test_cuts_snap_to_ground_truth_beats(self) -> None:
        """卡点：切点落在真值 beat 网格上。"""
        ann = _annotation("music-110bpm")
        beats = [int(b) for b in ann["beat_grid_us"]]
        planner = BeatSyncPlanner()
        document = {"clips": []}
        segments = [
            {
                "asset_id": "seg1",
                "source_start_us": 0,
                "source_end_us": 4_000_000,
                "motion": 0.9,
            },
            {
                "asset_id": "seg2",
                "source_start_us": 0,
                "source_end_us": 4_000_000,
                "motion": 0.2,
            },
            {
                "asset_id": "seg3",
                "source_start_us": 0,
                "source_end_us": 4_000_000,
                "motion": 0.5,
            },
        ]
        result = planner.plan(
            document,
            {
                "target_duration_us": 10_000_000,
                "beats_per_shot": 2,
                "segments": segments,
            },
            signals={"beats_us": beats, "downbeats_us": beats[::4]},
        )
        ops = list(result.operations)
        assert ops, f"beat_sync 未产出 ops: {result}"
        assert result.noop is False
        beat_s = (beats[1] - beats[0]) / 1e6
        expect_shot_us = int(2 * beat_s * 1e6)  # beats_per_shot=2
        for op in ops:
            assert op["op"] == "insert_asset_clip"
            dur = int(op["source_end_us"]) - int(op["source_start_us"])
            assert abs(dur - expect_shot_us) <= 20_000, (
                f"镜头时长未对齐 2×beat: {dur} vs {expect_shot_us}"
            )
        # 强拍/高运动镜头优先：seg1(motion=0.9) 应在 seg2(motion=0.2) 之前首次出现
        order = [op["asset_id"] for op in ops]
        assert order.index("seg1") < order.index("seg2")


class TestW14LJCutRealMedia:
    def test_j_cut_leads_next_word(self) -> None:
        words = [
            {"start_us": 1_000_000, "end_us": 1_400_000},
            {"start_us": 2_200_000, "end_us": 2_600_000},
        ]
        out = choose_audio_delta(
            mode="j",
            picture_cut_us=2_000_000,
            words=words,
            clip_start_us=0,
            clip_end_us=5_000_000,
            offset_us=400_000,
        )
        assert out["audio_delta_us"] < 0
        assert out["audio_cut_us"] == 2_000_000 + out["audio_delta_us"]

    def test_l_cut_trails_prev_word(self) -> None:
        words = [
            {"start_us": 1_000_000, "end_us": 1_800_000},
            {"start_us": 2_500_000, "end_us": 2_900_000},
        ]
        out = choose_audio_delta(
            mode="l",
            picture_cut_us=2_000_000,
            words=words,
            clip_start_us=0,
            clip_end_us=5_000_000,
            offset_us=400_000,
        )
        assert out["audio_delta_us"] > 0
        assert out["evidence"]["rule"] == "l_cut_trail_prev_word"


class TestEvalMaterialsCoverage:
    def test_manifest_buckets_have_annotated_samples(self) -> None:
        """W0.4 缺口表：各分档标注数达到 min_samples（life_no_voice 含 2 个自检 fixture）。"""
        manifest = json.loads((EVAL_SET / "manifest.json").read_text(encoding="utf-8"))
        counts: dict[str, int] = {}
        for asset in manifest["assets"]:
            ann_path = EVAL_SET / "annotations" / f"{asset['asset_id']}.json"
            if ann_path.is_file():
                counts[asset["bucket"]] = counts.get(asset["bucket"], 0) + 1
        buckets = manifest["buckets"]
        for name, rule in buckets.items():
            need = int(rule["min_samples"])
            have = counts.get(name, 0)
            assert have >= need, f"bucket {name}: annotated {have} < min {need}"

    def test_spoken_single_total_duration(self) -> None:
        manifest = json.loads((EVAL_SET / "manifest.json").read_text(encoding="utf-8"))
        total = sum(
            int(a["duration_us"])
            for a in manifest["assets"]
            if a["bucket"] == "spoken_single"
        )
        assert total >= 600_000_000, f"spoken_single total {total/1e6:.1f}s < 600s"
