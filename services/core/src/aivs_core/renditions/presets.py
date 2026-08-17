from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from ..projects import DomainError

_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*-v1$")
_PLATFORM_IDS = {"generic", "douyin", "wechat-channels", "xiaohongshu"}
_TAG = re.compile(r"^[a-z0-9-]{1,32}$")
_LAYOUTS = {"preserve_timeline", "fit_all", "crop_fill_all", "blurred_background_all"}
_PROFILE_FIELDS = {
    "profile_id",
    "width",
    "height",
    "fps_num",
    "fps_den",
    "video_codec",
    "audio_codec",
    "audio_sample_rate",
    "pixel_format",
    "faststart",
}


def canonical_sha256(value: dict[str, Any], *, exclude: set[str] | None = None) -> str:
    stable = {key: item for key, item in value.items() if key not in (exclude or set())}
    return hashlib.sha256(
        json.dumps(stable, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class RenditionPresetRegistry:
    def __init__(self, resource_root: Path) -> None:
        self.resource_root = resource_root
        self.renditions: dict[str, dict[str, Any]] = {}
        self.platforms: dict[str, dict[str, Any]] = {}
        self.caption_styles: dict[str, Any] = {}

    def load(self) -> None:
        self.renditions = self._load_renditions()
        self.platforms = self._load_platforms()
        self.caption_styles = self._load_caption_styles()

    def _read_manifest(self, directory: Path, key: str, code: str) -> list[str]:
        value = self._read_json(directory / "manifest.json", code)
        if set(value) != {"schema_version", key} or value["schema_version"] != 1:
            raise DomainError(code, "预设清单不合法")
        ids = value[key]
        if (
            not isinstance(ids, list)
            or not ids
            or len(ids) != len(set(ids))
            or not all(isinstance(item, str) for item in ids)
        ):
            raise DomainError(code, "预设清单不合法")
        return ids

    def _load_renditions(self) -> dict[str, dict[str, Any]]:
        directory = self.resource_root / "renditions"
        ids = self._read_manifest(directory, "renditions", "RENDITION_PRESET_INVALID")
        items: dict[str, dict[str, Any]] = {}
        required = {
            "schema_version",
            "rendition_preset_id",
            "display_name",
            "preset_version",
            "aspect_ratio",
            "preview_profile",
            "export_profile",
            "allowed_layout_policies",
            "caption_style_ref",
            "filename_tag",
            "document_sha256",
        }
        for preset_id in ids:
            value = self._read_json(directory / f"{preset_id}.json", "RENDITION_PRESET_INVALID")
            if set(value) != required or value.get("rendition_preset_id") != preset_id:
                raise DomainError("RENDITION_PRESET_INVALID", "画幅预设字段不合法")
            self._validate_common(value, preset_id, "RENDITION_PRESET_INVALID")
            if (
                value["aspect_ratio"] not in {"9:16", "16:9"}
                or value["caption_style_ref"] != "caption-styles-v2.json"
            ):
                raise DomainError("RENDITION_PRESET_INVALID", "画幅预设规格不合法")
            layouts = value["allowed_layout_policies"]
            if not isinstance(layouts, list) or set(layouts) != _LAYOUTS or len(layouts) != 4:
                raise DomainError("RENDITION_PRESET_INVALID", "布局策略不合法")
            for profile_name in ("preview_profile", "export_profile"):
                self._validate_profile(value[profile_name])
            p, e = value["preview_profile"], value["export_profile"]
            expected = (
                (540, 960, 1080, 1920)
                if preset_id == "portrait-9x16-v1"
                else (960, 540, 1920, 1080)
            )
            if (p["width"], p["height"], e["width"], e["height"]) != expected:
                raise DomainError("RENDITION_PRESET_INVALID", "画幅预设尺寸不精确")
            items[preset_id] = value
        return items

    def _load_platforms(self) -> dict[str, dict[str, Any]]:
        directory = self.resource_root / "platform-presets"
        ids = self._read_manifest(directory, "platforms", "PLATFORM_PRESET_INVALID")
        items: dict[str, dict[str, Any]] = {}
        required = {
            "schema_version",
            "platform_preset_id",
            "display_name",
            "preset_version",
            "allowed_rendition_ids",
            "default_rendition_id",
            "filename_tag",
            "document_sha256",
        }
        for preset_id in ids:
            value = self._read_json(directory / f"{preset_id}.json", "PLATFORM_PRESET_INVALID")
            if set(value) != required or value.get("platform_preset_id") != preset_id:
                raise DomainError("PLATFORM_PRESET_INVALID", "平台预设字段不合法")
            self._validate_common(value, preset_id, "PLATFORM_PRESET_INVALID", versioned_id=False)
            allowed = value["allowed_rendition_ids"]
            if (
                not isinstance(allowed, list)
                or not allowed
                or len(allowed) != len(set(allowed))
                or any(item not in self.renditions for item in allowed)
                or value["default_rendition_id"] not in allowed
            ):
                raise DomainError("PLATFORM_PRESET_INVALID", "平台画幅引用不合法")
            items[preset_id] = value
        return items

    def _load_caption_styles(self) -> dict[str, Any]:
        value = self._read_json(
            self.resource_root / "fonts" / "caption-styles-v2.json", "RENDITION_PRESET_INVALID"
        )
        if (
            set(value) != {"schema_version", "caption_style_version", "renditions"}
            or value.get("schema_version") != 1
            or value.get("caption_style_version") != 2
        ):
            raise DomainError("RENDITION_PRESET_INVALID", "字幕样式资源不合法")
        values = value["renditions"]
        if set(values) != set(self.renditions):
            raise DomainError("RENDITION_PRESET_INVALID", "字幕样式画幅不完整")
        for rendition_id, item in values.items():
            if (
                set(item) != {"play_res", "presets"}
                or set(item["play_res"]) != {"width", "height"}
                or set(item["presets"]) != {"default-bottom", "game-safe-bottom", "high-contrast"}
            ):
                raise DomainError("RENDITION_PRESET_INVALID", "字幕样式字段不合法")
            export = self.renditions[rendition_id]["export_profile"]
            if item["play_res"] != {"width": export["width"], "height": export["height"]}:
                raise DomainError("RENDITION_PRESET_INVALID", "字幕样式画布不匹配")
        return value

    def _validate_common(
        self, value: dict[str, Any], expected_id: str, code: str, *, versioned_id: bool = True
    ) -> None:
        id_valid = (
            bool(_ID.fullmatch(expected_id)) if versioned_id else expected_id in _PLATFORM_IDS
        )
        if (
            value.get("schema_version") != 1
            or value.get("preset_version") != 1
            or not id_valid
            or not isinstance(value.get("display_name"), str)
            or not 1 <= len(value["display_name"]) <= 40
            or not isinstance(value.get("filename_tag"), str)
            or not _TAG.fullmatch(value["filename_tag"])
        ):
            raise DomainError(code, "预设字段不合法")
        digest = canonical_sha256(value, exclude={"document_sha256"})
        if value.get("document_sha256") != digest:
            raise DomainError(code, "预设校验和不匹配")

    @staticmethod
    def _validate_profile(value: Any) -> None:
        if (
            not isinstance(value, dict)
            or set(value) != _PROFILE_FIELDS
            or not isinstance(value.get("width"), int)
            or not isinstance(value.get("height"), int)
            or value["width"] % 2
            or value["height"] % 2
            or {
                key: value.get(key)
                for key in (
                    "fps_num",
                    "fps_den",
                    "video_codec",
                    "audio_codec",
                    "audio_sample_rate",
                    "pixel_format",
                    "faststart",
                )
            }
            != {
                "fps_num": 30,
                "fps_den": 1,
                "video_codec": "h264",
                "audio_codec": "aac",
                "audio_sample_rate": 48000,
                "pixel_format": "yuv420p",
                "faststart": True,
            }
        ):
            raise DomainError("RENDITION_PRESET_INVALID", "输出规格不合法")

    @staticmethod
    def _read_json(path: Path, code: str) -> dict[str, Any]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise DomainError(code, "预设资源不可读取") from exc
        if not isinstance(value, dict):
            raise DomainError(code, "预设资源不合法")
        return value

    def platform_dto(self) -> list[dict[str, Any]]:
        return [
            {
                key: value[key]
                for key in (
                    "schema_version",
                    "platform_preset_id",
                    "display_name",
                    "preset_version",
                    "allowed_rendition_ids",
                    "default_rendition_id",
                    "filename_tag",
                    "document_sha256",
                )
            }
            for value in self.platforms.values()
        ]

    def rendition_dto(self) -> list[dict[str, Any]]:
        return [
            {
                "schema_version": value["schema_version"],
                "rendition_preset_id": value["rendition_preset_id"],
                "display_name": value["display_name"],
                "preset_version": value["preset_version"],
                "document_sha256": value["document_sha256"],
                "preview_profile_id": value["preview_profile"]["profile_id"],
                "export_profile_id": value["export_profile"]["profile_id"],
                "preview": {key: value["preview_profile"][key] for key in ("width", "height")},
                "export": {key: value["export_profile"][key] for key in ("width", "height")},
            }
            for value in self.renditions.values()
        ]

    def caption_style(self, rendition_id: str) -> dict[str, Any]:
        return self.caption_styles["renditions"][rendition_id]
