from __future__ import annotations

from typing import Any

from .providers import validate_captions_provider_value

CAPTIONS_PROVIDER_RECIPE_ID = "captions_provider_v1"
CAPTIONS_PROVIDER_OUTPUT_SCHEMA = "caption-text-output-v1"


def build_captions_provider_payload(
    *,
    language: str,
    preset_id: str,
    max_chars_per_caption: int,
    segments: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build the only payload allowed to leave Core for captions text generation."""
    if not isinstance(language, str) or not language.strip() or len(language) > 32:
        raise ValueError("invalid captions language")
    if not isinstance(preset_id, str) or not preset_id.strip() or len(preset_id) > 64:
        raise ValueError("invalid captions preset")
    if not isinstance(max_chars_per_caption, int) or isinstance(max_chars_per_caption, bool) or not 1 <= max_chars_per_caption <= 200:
        raise ValueError("invalid captions max chars")
    if not isinstance(segments, list) or not segments or len(segments) > 2000:
        raise ValueError("captions segments are required or too many")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for ordinal, segment in enumerate(segments):
        if not isinstance(segment, dict) or set(segment) != {"segment_id", "text", "duration_bucket"}:
            raise ValueError("invalid captions segment")
        segment_id, text, bucket = segment["segment_id"], segment["text"], segment["duration_bucket"]
        if not isinstance(segment_id, str) or not segment_id or segment_id in seen:
            raise ValueError("invalid captions segment id")
        if not isinstance(text, str) or not text.strip() or len(text) > 10_000:
            raise ValueError("invalid captions segment text")
        if bucket not in {"short", "medium", "long"}:
            raise ValueError("invalid captions duration bucket")
        seen.add(segment_id)
        result.append({"segment_id": segment_id, "ordinal": ordinal, "text": text, "duration_bucket": bucket})
    if sum(len(item["text"]) for item in result) > 200_000:
        raise ValueError("captions payload is too large")
    return {
        "schema_version": 1,
        "recipe_id": CAPTIONS_PROVIDER_RECIPE_ID,
        "language": language.strip(),
        "preset_id": preset_id.strip(),
        "max_chars_per_caption": max_chars_per_caption,
        "segments": result,
    }


def build_captions_provider_patch(*, document: dict[str, Any], payload: dict[str, Any], provider_value: dict[str, Any]) -> dict[str, Any]:
    """Map validated Provider text to existing transcript captions only.

    Timing and caption IDs come exclusively from the Core document; Provider
    output can change text but cannot invent timing or TimelinePatch fields.
    """
    normalized = validate_captions_provider_value(provider_value, [item["segment_id"] for item in payload["segments"]], payload["max_chars_per_caption"])
    captions = document.get("captions")
    if not isinstance(captions, list):
        raise ValueError("captions document is invalid")
    by_segment: dict[str, dict[str, Any]] = {}
    for caption in captions:
        if not isinstance(caption, dict) or caption.get("origin") != "transcript":
            continue
        for segment_id in caption.get("source_segment_ids", []):
            if segment_id in by_segment and by_segment[segment_id] is not caption:
                raise ValueError("segment maps to multiple captions")
            by_segment[segment_id] = caption
    operations: list[dict[str, Any]] = []
    touched: set[str] = set()
    for item in normalized["items"]:
        targets = [by_segment.get(ref) for ref in item["segment_refs"]]
        if any(target is None for target in targets) or len({target["caption_id"] for target in targets if target is not None}) != 1:
            raise ValueError("Provider segments do not map to one existing caption")
        caption = targets[0]
        assert caption is not None
        caption_id = caption["caption_id"]
        if caption_id in touched:
            raise ValueError("caption mapped more than once")
        touched.add(caption_id)
        if caption.get("text") != item["text"]:
            operations.append({"op": "update_caption", "caption_id": caption_id, "text": item["text"]})
    return {"summary": "Provider 字幕文本提案", "operations": operations}


def captions_provider_preview(*, provider: dict[str, Any], payload: dict[str, Any], payload_sha256: str, expires_at: str) -> dict[str, Any]:
    """Return only the consent summary; never expose payload text or credentials."""
    segments = payload["segments"]
    return {
        "provider": {"display_name": provider["display_name"], "origin": provider["base_url"], "model": provider["model"]},
        "prompt_template_version": CAPTIONS_PROVIDER_RECIPE_ID,
        "output_schema_version": CAPTIONS_PROVIDER_OUTPUT_SCHEMA,
        "sent_fields": ["language", "preset_id", "max_chars_per_caption", "segments.segment_id", "segments.ordinal", "segments.text", "segments.duration_bucket"],
        "payload_sha256": payload_sha256,
        "segment_count": len(segments),
        "character_count": sum(len(item["text"]) for item in segments),
        "expires_at": expires_at,
    }


__all__ = ["CAPTIONS_PROVIDER_RECIPE_ID", "CAPTIONS_PROVIDER_OUTPUT_SCHEMA", "build_captions_provider_payload", "captions_provider_preview", "validate_captions_provider_value"]
