from __future__ import annotations

import json
import re
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


def _ass_rgb_to_bgr_tag(color: str) -> str:
    """&Haabbggrr → 行内 \\c&Hbbggrr&（ASS 本就 BGR 序，直接转发去 alpha）。"""
    body = color[2:]  # aabbggrr
    return f"\\c&H{body[2:]}&"


def caption_override_tags(
    caption: dict[str, Any], preset_values: dict[str, Any], play_res: tuple[int, int]
) -> str:
    """B4：按 style_override 生成 ASS 行内覆盖标签前缀（无覆盖返回空串）。

    标签值全部来自服务端校验的数值/颜色枚举（contracts+core 双重校验），
    正文仍走 escape_ass_text——标签不参与正文转义，注入面不扩大（设计 §2）。
    """
    override = caption.get("style_override")
    if not isinstance(override, dict) or not override:
        return ""
    preset_id = caption.get("preset_id")
    preset = preset_values.get(preset_id, {})
    tags = ""
    font_name = override.get("font_name")
    if font_name is not None:
        # 字体名仅允许安全字符（渲染端二次校验，防线与 core 一致）。
        if not isinstance(font_name, str) or not re.fullmatch(r"[\w @\-]{1,60}", font_name):
            raise DomainError("TIMELINE_INVALID", "字幕字体名称不合法")
        tags += f"\\fn{font_name}"
    font_size = override.get("font_size")
    if font_size is not None:
        tags += f"\\fs{int(font_size)}"
    letter_spacing = override.get("letter_spacing")
    if letter_spacing is not None:
        tags += f"\\spc{round(float(letter_spacing))}"
    for flag_key, tag_name in (("bold", "b"), ("italic", "i"), ("underline", "u")):
        flag = override.get(flag_key)
        if flag is not None:
            tags += f"\\{tag_name}{1 if flag else 0}"
    primary = override.get("primary_color")
    if primary is not None:
        tags += _ass_rgb_to_bgr_tag(primary)
    outline_color = override.get("outline_color")
    if outline_color is not None:
        tags += _ass_rgb_to_bgr_tag(outline_color).replace("\\c", "\\3c", 1)
    outline = override.get("outline")
    if outline is not None:
        tags += f"\\bord{int(outline)}"
    alignment = override.get("alignment")
    margin_v = override.get("margin_v")
    pos_x = override.get("pos_x")
    pos_y = override.get("pos_y")
    if pos_x is not None and pos_y is not None:
        # 自定义坐标：比率 × PlayRes（换算像素）。
        width, height = play_res
        tags += f"\\pos({round(pos_x * width)},{round(pos_y * height)})"
    elif alignment is not None:
        tags += f"\\an{int(alignment)}"
        if margin_v is not None:
            tags += f"\\marginv{int(margin_v)}"
    elif margin_v is not None:
        tags += f"\\marginv{int(margin_v)}"
    return tags


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
        override_tags = caption_override_tags(caption, preset_values, (1080, 1920))
        events.append(
            "Dialogue: 0,"
            f"{_ass_time(caption['start_us'])},{_ass_time(caption['end_us'])},"
            f"{preset_id},,0,0,0,,{override_tags}{escape_ass_text(caption['text'])}"
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


def build_rendition_ass(
    captions: list[dict[str, Any]], bundle: dict[str, Any], rendition_style: dict[str, Any]
) -> str:
    """Build ASS with the immutable style resolved into a rendition snapshot."""
    try:
        play_res = rendition_style["play_res"]
        presets = rendition_style["presets"]
        width, height = int(play_res["width"]), int(play_res["height"])
    except (KeyError, TypeError, ValueError) as exc:
        raise DomainError("RENDITION_SNAPSHOT_INVALID", "字幕样式不合法") from exc
    family = str(bundle["family"])
    styles: list[str] = []
    for preset_id in ("default-bottom", "game-safe-bottom", "high-contrast"):
        value = presets.get(preset_id)
        if not isinstance(value, dict):
            raise DomainError("RENDITION_SNAPSHOT_INVALID", "字幕样式不完整")
        styles.append(
            "Style: "
            f"{preset_id},{family},{int(value['font_size'])},{value['primary_color']},&H000000FF,"
            f"{value['outline_color']},{value['back_color']},0,0,0,0,100,100,0,0,"
            f"{int(value['border_style'])},{int(value['outline'])},{int(value['shadow'])},2,"
            f"{int(value['margin_l'])},{int(value['margin_r'])},{int(value['margin_v'])},1"
        )
    events = []
    for caption in captions:
        preset_id = caption.get("preset_id")
        if preset_id not in presets:
            raise DomainError("RENDITION_SNAPSHOT_INVALID", "字幕预设不合法")
        override_tags = caption_override_tags(caption, presets, (width, height))
        events.append(
            "Dialogue: 0,"
            f"{_ass_time(caption['start_us'])},{_ass_time(caption['end_us'])},{preset_id},,0,0,0,,"
            f"{override_tags}{escape_ass_text(caption['text'])}"
        )
    return "\n".join(
        [
            "[Script Info]",
            "ScriptType: v4.00+",
            f"PlayResX: {width}",
            f"PlayResY: {height}",
            "WrapStyle: 0",
            "ScaledBorderAndShadow: yes",
            "YCbCr Matrix: TV.709",
            "",
            "[V4+ Styles]",
            "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,"
            "BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,"
            "Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
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
