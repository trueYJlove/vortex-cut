"""W3.3 S3：多模态适配器（A4 能力探测 / 词表约束 / token 预算重试）。

绝大多数用例是**纯函数**，不碰网络——因为真实调用要烧额度，
而这里要验的是「请求形状对不对、响应怎么解释」，与网关无关。

真实端到端放在文件末尾，用 `real_provider` marker 显式开启。
"""
from __future__ import annotations

import base64
import json

import pytest

from aivs_core.media import vision_adapter
from aivs_core.media.vision_adapter import (
    VISION_ADAPTER_ID,
    VISION_ADAPTER_IDS,
    VISION_MAX_TOKENS,
    VISION_RETRY_MAX_TOKENS,
    VisionRequest,
    build_body,
    build_instruction,
    build_messages,
    next_retry_budget,
    parse_tag_response,
    tagging_schema,
    vision_adapter_supported,
)
from aivs_core.media.vision_adapter import _strip_json_fence  # noqa: PLC2701 负向对照要直接观测它

LABELS = ("人物", "动物", "建筑")


def _request(jpeg: bytes = b"\xff\xd8fake\xff\xd9") -> VisionRequest:
    return VisionRequest(
        instruction=build_instruction(LABELS), labels=LABELS, frame_jpeg=jpeg,
    )


# ── 适配器族 ──


def test_adapter_id_is_registered() -> None:
    assert VISION_ADAPTER_ID in VISION_ADAPTER_IDS
    assert vision_adapter_supported(VISION_ADAPTER_ID)


def test_unknown_adapter_rejected() -> None:
    """fail-closed：未登记的适配器不得放行（A4）。"""
    assert not vision_adapter_supported("nope_v1")
    assert not vision_adapter_supported(None)


# ── 请求体形状 ──


def test_messages_carry_text_and_image_blocks() -> None:
    messages = build_messages(_request())
    assert len(messages) == 1
    content = messages[0]["content"]
    assert [block["type"] for block in content] == ["text", "image_url"]
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_image_bytes_are_actually_embedded() -> None:
    """base64 必须来自真实字节——否则发出去的是空图。"""
    jpeg = b"\xff\xd8REALPAYLOAD\xff\xd9"
    url = build_messages(_request(jpeg))[0]["content"][1]["image_url"]["url"]
    encoded = url.split(",", 1)[1]
    assert base64.b64decode(encoded) == jpeg


def test_body_includes_strict_schema() -> None:
    """事实 0.13：图片块 + strict json_schema 可并用 ⇒ 必须真的带上它。"""
    body = build_body(_request(), "some-model")
    fmt = body["response_format"]
    assert fmt["type"] == "json_schema"
    assert fmt["json_schema"]["strict"] is True
    assert body["max_tokens"] == VISION_MAX_TOKENS


def test_schema_requires_labels_and_notes() -> None:
    schema = tagging_schema()["json_schema"]["schema"]
    assert set(schema["required"]) == {"labels", "notes"}
    assert schema["additionalProperties"] is False


def test_instruction_states_allowed_labels_and_key_names() -> None:
    """实测教训：不说 key 名时模型返回过中文 key「标签」。"""
    text = build_instruction(LABELS)
    for label in LABELS:
        assert label in text
    assert "labels" in text
    assert "notes" in text


# ── 响应解析 ──


def _completion(content: str | None, finish: str = "stop") -> dict:
    return {"choices": [{"finish_reason": finish, "message": {"content": content}}]}


def test_parse_keeps_allowed_labels() -> None:
    result = parse_tag_response(
        _completion(json.dumps({"labels": ["人物", "动物"], "notes": None})), LABELS,
    )
    assert result["labels"] == ["人物", "动物"]
    assert result["violations"] == 0
    assert result["exhausted"] is False


def test_out_of_vocabulary_moves_to_notes() -> None:
    """规划门 §3.4：词表外标签**一律改道 notes**，不丢弃、不静默改写。"""
    result = parse_tag_response(
        _completion(json.dumps({"labels": ["人物", "坦克"], "notes": None})), LABELS,
    )
    assert result["labels"] == ["人物"]
    assert result["violations"] == 1
    assert "坦克" in (result["notes"] or "")


def test_empty_labels_is_legal_result() -> None:
    """无匹配是**合法结果**，不是失败（实测：纯色帧正确返回空）。"""
    result = parse_tag_response(
        _completion(json.dumps({"labels": [], "notes": "无可用标签"})), LABELS,
    )
    assert result["labels"] == []
    assert result["violations"] == 0
    assert result["exhausted"] is False


def test_length_without_content_flags_exhausted() -> None:
    """撞顶必须能与「模型不会做」区分开，否则重试逻辑无从触发。"""
    result = parse_tag_response(_completion(None, finish="length"), LABELS)
    assert result["exhausted"] is True


def test_empty_content_without_length_raises() -> None:
    with pytest.raises(ValueError):
        parse_tag_response(_completion(None, finish="stop"), LABELS)


def test_non_json_content_raises() -> None:
    """模型返回散文时必须显式失败，不得当空标签混过去。"""
    with pytest.raises(ValueError):
        parse_tag_response(_completion("这不是 JSON"), LABELS)



# ── (c) 网关围栏：先原样解析，失败才剥围栏 ──
#
# 实测：`response_format={"type":"json_schema"}` strict **已发**，网关仍把
# JSON 包进 Markdown 围栏（```json ... ```），`json.loads` 直接失败。围栏是
# **适配器层**的编码噪声，不是调用方要处理的错误，所以剥离只发生在这里。


FENCED_PROBE_OUT = "```json\n{\"labels\": [], \"notes\": \"probe\"}\n```"


def test_fenced_json_content_is_parsed() -> None:
    """带 ```json 围栏的响应必须能解析——否则真实网关下打标恒失败。"""
    assert "```" in FENCED_PROBE_OUT  # 前提：本例内容真被围栏包裹
    result = parse_tag_response(_completion(FENCED_PROBE_OUT), LABELS)
    assert result["labels"] == []
    assert result["notes"] == "probe"
    assert result["exhausted"] is False


def test_bare_fence_without_json_tag_is_parsed() -> None:
    """两种包裹都要认：``` 与 ```json（网关实现不统一，实测两种都出现过）。"""
    fenced = "```\n" + json.dumps({"labels": ["人物"], "notes": None}) + "\n```"
    result = parse_tag_response(_completion(fenced), LABELS)
    assert result["labels"] == ["人物"]


def test_unfenced_content_is_not_touched_by_the_fence_path() -> None:
    """**负向证明的一半**：合规响应不经过剥离路径，解析结果与内容逐字一致。

    只断言「能解析」是没区分力的——把剥离改成无条件 re.sub 也照样绿。
    所以这里直接证明未加围栏的内容 `_strip_json_fence` 返回 None，即那条
    路径根本没被走到；再用 monkeypatch 把剥离函数换成「一定会抛」的版本，
    确认不带围栏的响应**完全不受影响**（带围栏的对照见
    `test_stripping_is_the_only_reason_the_fenced_case_passes`）。
    """
    content = json.dumps({"labels": ["人物"], "notes": "无围栏"}, ensure_ascii=False)
    assert _strip_json_fence(content) is None, "无围栏内容不得被当成有围栏"
    result = parse_tag_response(_completion(content), LABELS)
    assert result["labels"] == ["人物"]
    assert result["notes"] == "无围栏"


def test_stripping_is_the_only_reason_the_fenced_case_passes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """**负向对照**：把剥离摘掉（恒返回 None）⇒ 带围栏那条必须红。

    这条同时是「先原样后剥离」的秩序证明：剥离去掉后，不带围栏的解析
    一格不动（同文件其余用例全绿），只有带围栏的输入失败。
    """
    monkeypatch.setattr(vision_adapter, "_strip_json_fence", lambda _c: None)
    with pytest.raises(ValueError, match="is not JSON"):
        parse_tag_response(_completion(FENCED_PROBE_OUT), LABELS)
    # 同一 monkeypatch 下，不带围栏的响应照旧成功——证明剥离不是解析的前提。
    bare = json.dumps({"labels": [], "notes": None})
    assert parse_tag_response(_completion(bare), LABELS)["labels"] == []


def test_fence_wrapped_broken_json_still_raises() -> None:
    """围栏里是坏 JSON ⇒ 仍抛，且消息**区分**两种失败（诊断需要）。"""
    fenced = "```json\n{\"labels\": [oops\n```"
    with pytest.raises(ValueError) as excinfo:
        parse_tag_response(_completion(fenced), LABELS)
    message = str(excinfo.value)
    assert "after stripping" in message, f"围栏内坏 JSON 的消息应可区分，实得 {message!r}"


def test_plain_non_json_message_stays_distinguishable() -> None:
    """不带围栏的散文 ⇒ 仍是原来那条消息（不冒充「剥了还是坏」）。"""
    with pytest.raises(ValueError) as excinfo:
        parse_tag_response(_completion("这不是 JSON"), LABELS)
    message = str(excinfo.value)
    assert "is not JSON" in message
    assert "after stripping" not in message


def test_prose_around_a_fence_is_rejected() -> None:
    """只有**整体**被围栏包裹才算；「说明 + 围栏 + 说明」不得被猜成合法。

    放宽成全文搜围栏子串会让模型可以在 JSON 前后随意夹带任意文字，
    那已经不是修编码，而是引入一个没有契约的容错。
    """
    padded = "Here you go:\n```json\n" + json.dumps({"labels": [], "notes": None}) + "\n```\nHope this helps."
    with pytest.raises(ValueError):
        parse_tag_response(_completion(padded), LABELS)


def test_missing_choices_raises() -> None:
    with pytest.raises(ValueError):
        parse_tag_response({"choices": []}, LABELS)


# ── token 预算重试（用户 2026-10-21 裁决 A+B）──


def test_retry_budget_doubles_once() -> None:
    assert next_retry_budget(VISION_MAX_TOKENS) == VISION_RETRY_MAX_TOKENS


def test_no_second_retry() -> None:
    """只重试**一次**：无限重试会把单帧成本推成不可控。"""
    assert next_retry_budget(VISION_RETRY_MAX_TOKENS) is None


def test_default_budget_matches_user_ruling() -> None:
    assert VISION_MAX_TOKENS == 2000
    assert VISION_RETRY_MAX_TOKENS == 4000


# ── 真实网关（显式开启才跑）──


@pytest.mark.real_provider
@pytest.mark.asyncio
async def test_real_gateway_tags_a_real_frame(tmp_path) -> None:
    """真实端到端：生产编码器出的帧 → 真实网关 → 合规标签。

    只在 AIVS_RUN_REAL_PROVIDER_TESTS=1 且网关可达时运行（见 conftest）。
    """
    import asyncio
    import os
    from pathlib import Path

    if os.environ.get("AIVS_RUN_REAL_PROVIDER_TESTS") != "1":
        pytest.skip("real provider tests not enabled")
    base = os.environ.get("AIVS_REAL_PROVIDER_BASE_URL")
    key = os.environ.get("AIVS_REAL_PROVIDER_API_KEY")
    model = os.environ.get("AIVS_REAL_PROVIDER_MODEL")
    if not (base and key and model):
        pytest.skip("provider env not configured")

    import httpx

    from aivs_core.media.keyframe_encode import encode_frame

    ffmpeg = Path(__file__).resolve().parents[4] / "resources/ffmpeg/win-x64/ffmpeg.exe"
    if not ffmpeg.exists():
        pytest.skip("bundled ffmpeg missing")
    video = tmp_path / "src.mp4"
    process = await asyncio.create_subprocess_exec(
        str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=640x360:duration=2:rate=2",
        "-c:v", "libopenh264", "-pix_fmt", "yuv420p", str(video),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    await process.communicate()
    frame = await encode_frame(ffmpeg, video, 500_000, source_reason="interval")

    request = VisionRequest(
        instruction=build_instruction(LABELS), labels=LABELS,
        frame_jpeg=frame.payload_bytes,
    )
    budget = VISION_MAX_TOKENS
    result = None
    attempts = 0
    while attempts < 2:
        attempts += 1
        body = build_body(request, model, max_tokens=budget)
        with httpx.Client(timeout=240.0, trust_env=False) as client:
            response = client.post(
                f"{base.rstrip(chr(47))}/chat/completions", json=body,
                headers={"Authorization": f"Bearer {key}"},
            )
        assert response.status_code == 200, response.text[:300]
        result = parse_tag_response(response.json(), LABELS)
        if not result["exhausted"]:
            break
        following = next_retry_budget(budget)
        if following is None:
            break
        budget = following

    assert result is not None
    assert result["exhausted"] is False, "重试后仍撞顶"
    assert isinstance(result["labels"], list)
    # 标签必须全部在词表内（解析已保证，这里再断言一次作为回归锁）
    assert set(result["labels"]) <= set(LABELS)
