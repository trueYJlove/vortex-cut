"""W1.2 BeatGridService：PCM 解码 → 检测 → 落库/查询。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import numpy as np

from ..database import Database, json_dumps, json_loads, utc_now
from ..ids import new_id
from ..projects import DomainError
from .beat_grid import BEAT_ALGORITHM_VERSION, DEFAULT_SR, analyze_pcm


def pcm_s16le_args(input_path: str) -> list[str]:
    return [
        "-hide_banner",
        "-nostdin",
        "-i",
        input_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(DEFAULT_SR),
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "pipe:1",
    ]


class BeatGridService:
    def __init__(self, db: Database, ffmpeg: Path) -> None:
        self.db = db
        self.ffmpeg = ffmpeg

    def latest_beat_grid(self, asset_id: str) -> dict[str, Any] | None:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM beat_grids WHERE asset_id=? AND algorithm_version=? "
                "AND status IN ('ready','unavailable') "
                "ORDER BY created_at DESC LIMIT 1",
                (asset_id, BEAT_ALGORITHM_VERSION),
            ).fetchone()
        return dict(row) if row else None

    def analyze_samples(
        self,
        asset_id: str,
        source_fingerprint: str,
        pcm: np.ndarray,
        *,
        sr: int = DEFAULT_SR,
    ) -> dict[str, Any]:
        """纯检测 + 落库（测试与真实解码共用）。"""
        result = analyze_pcm(np.asarray(pcm, dtype=np.float64), sr=sr)
        now = utc_now()
        grid_id = f"beat_grid_{new_id()}"
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO beat_grids(id,asset_id,source_fingerprint,algorithm_version,"
                "status,bpm,lag_s,confidence,beats_json,downbeats_json,candidates_json,"
                "reason,model_revision,sample_rate,created_at,updated_at,finished_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    grid_id,
                    asset_id,
                    source_fingerprint,
                    BEAT_ALGORITHM_VERSION,
                    result["status"],
                    result.get("bpm"),
                    result.get("lag_s"),
                    result.get("confidence"),
                    json_dumps(result.get("beats_us") or []),
                    json_dumps(result.get("downbeats_us") or []),
                    json_dumps(result.get("candidates") or []),
                    result.get("reason"),
                    f"beat-numpy-v{BEAT_ALGORITHM_VERSION}",
                    sr,
                    now,
                    now,
                    now,
                ),
            )
        return {
            "beat_grid_id": grid_id,
            "asset_id": asset_id,
            **result,
        }

    async def analyze_path(
        self,
        asset_id: str,
        source_fingerprint: str,
        input_path: Path,
        cancel_event: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        process = await asyncio.create_subprocess_exec(
            str(self.ffmpeg),
            *pcm_s16le_args(str(input_path)),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
        )
        assert process.stdout is not None
        chunks: list[bytes] = []
        while True:
            if cancel_event is not None and cancel_event.is_set():
                process.kill()
                await process.wait()
                raise DomainError("JOB_CANCELLED", "任务已取消")
            chunk = await process.stdout.read(65536)
            if not chunk:
                break
            chunks.append(chunk)
        await process.wait()
        raw = b"".join(chunks)
        if not raw:
            # 无音轨
            return self.analyze_samples(
                asset_id, source_fingerprint, np.zeros(0, dtype=np.float64)
            )
        pcm = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
        return self.analyze_samples(asset_id, source_fingerprint, pcm, sr=DEFAULT_SR)

    def is_stale(self, grid: dict[str, Any], asset_fingerprint: str) -> bool:
        return grid.get("source_fingerprint") != asset_fingerprint


def parse_grid_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        **row,
        "beats_us": json_loads(row.get("beats_json") or "[]"),
        "downbeats_us": json_loads(row.get("downbeats_json") or "[]"),
        "candidates": json_loads(row.get("candidates_json") or "[]"),
    }
