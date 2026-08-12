from __future__ import annotations

import json
import unicodedata
from pathlib import Path
from typing import Any

from ..projects import DomainError


class CaptionResources:
    def __init__(self, font_dir: Path) -> None:
        self.font_dir = font_dir
        self.bundle_path = font_dir / "bundle.json"
        self.presets_path = font_dir / "caption-presets.json"

    def load(self) -> tuple[dict[str, Any], dict[str, Any], Path]:
        try:
            bundle = json.loads(self.bundle_path.read_text(encoding="utf-8"))
            presets = json.loads(self.presets_path.read_text(encoding="utf-8"))
            font_path = self.font_dir / bundle["file"]
        except (OSError, KeyError, json.JSONDecodeError) as exc:
            raise DomainError("RENDER_FONT_MISSING", "字幕字体资源不完整") from exc
        if (
            bundle.get("font_bundle_version") != 1
            or presets.get("preset_version") != 1
            or not font_path.is_file()
            or not (self.font_dir / bundle.get("license_file", "")).is_file()
        ):
            raise DomainError("RENDER_FONT_MISSING", "字幕字体资源不完整")
        return bundle, presets, font_path


def escape_ass_text(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise DomainError("RENDER_PLAN_INVALID", "字幕文本不合法")
    if any(unicodedata.category(char) in {"Cc", "Cs"} for char in value):
        raise DomainError("RENDER_PLAN_INVALID", "字幕文本包含控制字符")
    return value.replace("\\", "＼").replace("{", "｛").replace("}", "｝")


def build_ass(
    captions: list[dict[str, Any]], bundle: dict[str, Any], presets: dict[str, Any]
) -> str:
    family = str(bundle["family"])
    preset_values = presets.get("presets")
    if not isinstance(preset_values, dict):
        raise DomainError("RENDER_FONT_MISSING", "字幕预设资源不完整")
    styles = []
    for preset_id in ("default-bottom", "game-safe-bottom", "high-contrast"):
        value = preset_values.get(preset_id)
        if not isinstance(value, dict):
            raise DomainError("RENDER_FONT_MISSING", "字幕预设资源不完整")
        styles.append(
            "Style: "
            f"{preset_id},{family},{int(value['font_size'])},"
            f"{value['primary_color']},&H000000FF,{value['outline_color']},"
            f"{value['back_color']},0,0,0,0,100,100,0,0,{int(value['border_style'])},"
            f"{int(value['outline'])},{int(value['shadow'])},2,80,80,"
            f"{int(value['margin_v'])},1"
        )
    events = []
    for caption in captions:
        preset_id = caption.get("preset_id")
        if preset_id not in preset_values:
            raise DomainError("RENDER_PLAN_INVALID", "字幕预设不合法")
        events.append(
            "Dialogue: 0,"
            f"{_ass_time(caption['start_us'])},{_ass_time(caption['end_us'])},"
            f"{preset_id},,0,0,0,,{escape_ass_text(caption['text'])}"
        )
    return "\n".join(
        [
            "[Script Info]",
            "ScriptType: v4.00+",
            "PlayResX: 1080",
            "PlayResY: 1920",
            "WrapStyle: 0",
            "ScaledBorderAndShadow: yes",
            "YCbCr Matrix: TV.709",
            "",
            "[V4+ Styles]",
            "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,"
            "BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,"
            "BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
            *styles,
            "",
            "[Events]",
            "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
            *events,
            "",
        ]
    )


def _ass_time(value_us: int) -> str:
    centiseconds = max(0, (int(value_us) + 5_000) // 10_000)
    hours, remainder = divmod(centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    seconds, fraction = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{fraction:02d}"
