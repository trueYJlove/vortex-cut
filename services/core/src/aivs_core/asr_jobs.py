from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .database import Database, sha256_file, utc_now
from .model_registry import ModelError, ModelManager, ModelRegistry
from .transcription import (
    FasterWhisperProvider,
    SpeechToTextProvider,
    TranscriptionError,
    TranscriptRepository,
)


class AsrCoordinator:
    def __init__(
        self,
        db: Database,
        registry: ModelRegistry,
        models: ModelManager,
        transcripts: TranscriptRepository,
        provider: SpeechToTextProvider | None = None,
    ) -> None:
        self.db = db
        self.registry = registry
        self.models = models
        self.transcripts = transcripts
        self.provider = provider or FasterWhisperProvider()

    async def run(
        self,
        row: Any,
        cancel_event: asyncio.Event,
        progress: Callable[[float], None],
        stage: Callable[[str], None],
    ) -> dict[str, Any]:
        if row["kind"] == "model_download":
            return await self._run_download(row, cancel_event, progress, stage)
        if row["kind"] == "transcription":
            return await self._run_transcription(row, cancel_event, progress, stage)
        raise TranscriptionError("INTERNAL_ERROR", "未知的 ASR 任务类型")

    def validate_retry(self, row: Any) -> None:
        if row["kind"] == "model_download":
            manifest = self.registry.get(row["model_id"])
            if row["model_revision"] != manifest.revision:
                raise ModelError("MODEL_DOWNLOAD_FAILED", "模型下载失败")
            return
        if row["kind"] != "transcription":
            return
        asset_id = row["asset_id"]
        if not asset_id:
            raise TranscriptionError("TRANSCRIPTION_INPUT_CHANGED", "素材指纹已变化，转录结果失效")
        asset = self._current_asset(asset_id)
        fingerprint, _, _ = self._verify_asset(asset)
        if fingerprint != row["input_fingerprint"]:
            self.transcripts.mark_asset_stale(asset_id, fingerprint)
            raise TranscriptionError("TRANSCRIPTION_INPUT_CHANGED", "素材指纹已变化，转录结果失效")
        self.models.ready_path(row["model_id"])

    async def _run_download(
        self,
        row: Any,
        cancel_event: asyncio.Event,
        progress: Callable[[float], None],
        stage: Callable[[str], None],
    ) -> dict[str, Any]:
        manifest = self.registry.get(row["model_id"])
        if row["model_revision"] != manifest.revision:
            raise ModelError("INTERNAL_ERROR", "内部错误")
        result = await self.models.download(manifest, cancel_event, progress, stage)
        return {"model_id": manifest.model_id, "model_revision": manifest.revision, **result}

    async def _run_transcription(
        self,
        row: Any,
        cancel_event: asyncio.Event,
        progress: Callable[[float], None],
        stage: Callable[[str], None],
    ) -> dict[str, Any]:
        asset_id = row["asset_id"]
        if not asset_id:
            raise TranscriptionError("TRANSCRIPTION_FAILED", "素材不可用，无法转录")
        asset = self._current_asset(asset_id)
        source_fingerprint, audio_uri, duration_us = self._verify_asset(asset)
        if source_fingerprint != row["input_fingerprint"]:
            self.transcripts.mark_asset_stale(asset_id, source_fingerprint)
            raise TranscriptionError("TRANSCRIPTION_INPUT_CHANGED", "素材指纹已变化，转录结果失效")
        try:
            model_dir = self.models.ready_path(row["model_id"])
        except ModelError as exc:
            raise TranscriptionError(exc.code, exc.message) from exc
        input_data = json_loads(row["input_json"])
        language = str(input_data.get("language", "auto"))
        word_timestamps = bool(input_data.get("word_timestamps", False))
        stage("transcribing")
        hold_seconds = float(os.environ.get("AIVS_E2E_HOLD_ASR_SECONDS", "0"))
        if hold_seconds > 0:
            await asyncio.sleep(hold_seconds)
        result = await self.provider.transcribe(
            audio_uri,
            language,
            row["model_id"],
            model_dir,
            word_timestamps,
            cancel_event,
            progress,
        )
        if cancel_event.is_set():
            raise TranscriptionError("TRANSCRIPTION_CANCELLED", "转录已取消")
        stage("persisting")
        current_asset = self._current_asset(asset_id)
        current_fingerprint, _, _ = self._verify_asset(current_asset)
        if current_fingerprint != source_fingerprint:
            self.transcripts.mark_asset_stale(asset_id, current_fingerprint)
            raise TranscriptionError("TRANSCRIPTION_INPUT_CHANGED", "素材指纹已变化，转录结果失效")
        transcript = self.transcripts.save_ready(
            asset_id,
            source_fingerprint,
            "faster-whisper",
            row["model_id"],
            row["model_revision"],
            result,
        )
        return {"transcript_id": transcript["transcript_id"], "duration_us": duration_us}

    def _current_asset(self, asset_id: str) -> Any:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT assets.*,asset_locations.uri FROM assets "
                "JOIN asset_locations ON asset_locations.asset_id=assets.id WHERE assets.id=?",
                (asset_id,),
            ).fetchone()
        if not row:
            raise TranscriptionError("ASSET_NOT_FOUND", "素材不存在")
        return row

    def _verify_asset(self, asset: Any) -> tuple[str, str, int]:
        path = _path_from_uri(asset["uri"])
        if not path.is_file():
            self._mark_asset(asset["id"], "missing")
            raise TranscriptionError("TRANSCRIPTION_INPUT_CHANGED", "音频文件不存在")
        try:
            fingerprint = sha256_file(path)
        except OSError as exc:
            raise TranscriptionError("TRANSCRIPTION_INPUT_CHANGED", "无法读取素材指纹") from exc
        if fingerprint != asset["fingerprint"]:
            self._mark_asset(asset["id"], "changed")
            self.transcripts.mark_asset_stale(asset["id"], fingerprint)
            return fingerprint, path.as_uri(), _duration_us(asset["media_info_json"])
        return fingerprint, path.as_uri(), _duration_us(asset["media_info_json"])

    def _mark_asset(self, asset_id: str, availability: str) -> None:
        with self.db.connection() as db:
            db.execute(
                "UPDATE assets SET availability=?,updated_at=? WHERE id=?",
                (availability, utc_now(), asset_id),
            )
        if availability == "missing":
            self.transcripts.mark_asset_stale(asset_id, None)


def _duration_us(value: str | None) -> int:
    if not value:
        return 1
    try:
        return max(1, int(json_loads(value).get("duration_us", 1)))
    except (TypeError, ValueError):
        return 1


def _path_from_uri(uri: str) -> Path:
    if uri.startswith("file:"):
        from urllib.parse import unquote, urlparse

        parsed = urlparse(uri)
        value = unquote(parsed.path)
        if parsed.netloc:
            value = f"//{parsed.netloc}{value}"
        elif len(value) >= 3 and value[0] == "/" and value[2] == ":":
            value = value[1:]
        return Path(value)
    return Path(uri)


def json_loads(value: str) -> Any:
    import json

    return json.loads(value)
