"""W3.3 Layer 2：多模态（图片）适配器与结构化输出（S3）。

设计门 §3.6 / §0 事实 0.13。

本模块**只做请求体构造与响应解析**，不发网络——网络在服务层。
把它独立成纯模块的理由与 keyframe_sampling 相同：
判据（词表约束、schema 合规、token 预算重试）必须能脱离真实网关单测，
否则每条用例都要烧真实额度。

---

事实 0.13 的实测结论（2026-10-21，见 docs/W3_3_S3_PROVIDER_PROBE）：
  图片内容块 + strict json_schema **可以并用**，HTTP 200 且 schema 合规。
  因此只需要一档适配器，不启用「无 response_format + 词表后处理」降级档。
  但阶梯结构保留：其它模型未必如此，新增档位不该改动调用方。

---

为什么 token 预算要「默认 2000 + 撞顶重试 4000」（用户 2026-10-21 裁决）：
  实测同一模型同一张图：max_tokens=300/800 ⇒ reasoning 烧满、content 为空；
  更关键的是 **max_tokens=1500 两次运行一次成功一次 finish=length** ——
  固定预算**不是安全区**。所以撞顶必须能重试，而不是把默认值调高就完事。
  这是 STATUS P43 记录过的同一形态（推理模型 reasoning_content 挤占 max_tokens），
  但 P43 当时「不设下限」的结论针对文本负载，不能外推到视觉负载。
"""
from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Any

# 首档：OpenAI 兼容的 chat completions 图片内容块。
VISION_ADAPTER_IDS = ("openai_chat_completions_image_url_v1",)
VISION_ADAPTER_ID = "openai_chat_completions_image_url_v1"
VISION_PROBE_PROTOCOL_VERSION = "1"

# token 预算（用户 2026-10-21 裁决 A+B 组合）：
# 默认 2000，撞顶则**重试一次** 4000。不设默认 3000 的原因：实测 2000 已足够
# （reasoning 只用 164），更高默认只是浪费；重试才是覆盖「偶发撞顶」的手段。
VISION_MAX_TOKENS = 2000
VISION_RETRY_MAX_TOKENS = 4000

VISION_VOCABULARY_VIOLATION = "VISION_VOCABULARY_VIOLATION"
PROVIDER_TOKEN_BUDGET_EXHAUSTED = "PROVIDER_TOKEN_BUDGET_EXHAUSTED"


@dataclass(frozen=True)
class VisionRequest:
    """一次视觉打标请求的构造参数。"""

    instruction: str
    labels: tuple[str, ...]
    frame_jpeg: bytes
    max_tokens: int = VISION_MAX_TOKENS


def vision_adapter_supported(adapter_id: str | None) -> bool:
    return adapter_id in VISION_ADAPTER_IDS


def tagging_schema() -> dict[str, Any]:
    """受控输出结构。`labels` 只收字符串数组，`notes` 承接词表外信息。

    为什么 `notes` 允许 null 而不要求空串：模型对「无话可说」的自然表达
    就是 null；强制空串会让它编点东西填进去（实测出现过），反而制造噪声。
    """
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "keyframe_tags",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "labels": {"type": "array", "items": {"type": "string"}},
                    "notes": {"type": ["string", "null"]},
                },
                "required": ["labels", "notes"],
                "additionalProperties": False,
            },
        },
    }


def build_instruction(labels: tuple[str, ...]) -> str:
    """把受控词表写进指令。**必须显式给 key 名**。

    实测教训：只说「返回 JSON」时模型返回过 `{"标签":"文字标识"}`（中文 key），
    schema 校验随即失败。把 key 名写进指令后稳定返回 `labels` / `notes`。
    这不是 schema 失效，而是**指令没把契约说清**。
    """
    allowed = ",".join(labels)
    return (
        "You are tagging a single video keyframe.\n"
        f"Allowed labels (choose ONLY from these): {allowed}.\n"
        'Return JSON with exactly two keys: "labels" '
        "(string array, may be empty if none apply) and "
        '"notes" (string or null, one short sentence describing anything '
        "important that the allowed labels cannot express).\n"
        "Do not invent labels outside the allowed set. Do not add other keys."
    )


def build_messages(request: VisionRequest) -> list[dict[str, Any]]:
    """OpenAI 兼容的多模态 content 数组。"""
    encoded = base64.b64encode(request.frame_jpeg).decode("ascii")
    return [{
        "role": "user",
        "content": [
            {"type": "text", "text": request.instruction},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{encoded}"}},
        ],
    }]


def build_body(
    request: VisionRequest, model: str, *, max_tokens: int | None = None,
) -> dict[str, Any]:
    return {
        "model": model,
        "messages": build_messages(request),
        "max_tokens": max_tokens if max_tokens is not None else request.max_tokens,
        "response_format": tagging_schema(),
    }


def parse_tag_response(value: dict[str, Any], allowed: tuple[str, ...]) -> dict[str, Any]:
    """解析一条 chat completion 响应。

    返回 `{"labels": [...], "notes": str|None, "violations": int, "exhausted": bool}`。

    三类结果必须分开，不能混成一个「失败」：
      exhausted=True   ⇒ 预算撞顶（可重试）
      violations>0     ⇒ 模型给了词表外标签（改道 notes，不阻断落库）
      labels=[] 且 notes 有内容 ⇒ **合法的「无匹配」**，不是错误
    """
    choices = value.get("choices") or []
    if not choices:
        raise ValueError("provider response has no choices")
    choice = choices[0]
    finish_reason = choice.get("finish_reason")
    message = choice.get("message") or {}
    content = message.get("content")

    # 撞顶：推理把预算烧完，content 一个字都没有。此时**不得**当普通解析失败，
    # 否则调用方无法区分「模型不会做」与「预算不够」。
    if finish_reason == "length" and not content:
        return {"labels": [], "notes": None, "violations": 0, "exhausted": True}

    if not content:
        raise ValueError("provider returned empty content")
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"provider content is not JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("provider content is not a JSON object")

    raw_labels = parsed.get("labels")
    notes = parsed.get("notes")
    if not isinstance(raw_labels, list):
        raw_labels = []
    if notes is not None and not isinstance(notes, str):
        notes = str(notes)

    allowed_set = set(allowed)
    kept: list[str] = []
    rejected: list[str] = []
    for label in raw_labels:
        text = str(label).strip()
        if not text:
            continue
        if text in allowed_set:
            kept.append(text)
        else:
            rejected.append(text)

    # 词表外标签**一律改道 notes**（规划门 §3.4），不丢弃、不静默改写成最近类。
    if rejected:
        extra = "、".join(rejected)
        notes = f"{notes}（词表外标签：{extra}）" if notes else f"词表外标签：{extra}"

    return {
        "labels": kept,
        "notes": notes,
        "violations": len(rejected),
        "exhausted": False,
    }


def next_retry_budget(current: int) -> int | None:
    """撞顶后应使用的下一档预算；None 表示不再重试。

    只重试**一次**（用户裁决）：无限重试会把单帧成本推成不可控，
    而「一次倍增」已能覆盖实测到的偶发撞顶形态。
    """
    if current >= VISION_RETRY_MAX_TOKENS:
        return None
    return VISION_RETRY_MAX_TOKENS
