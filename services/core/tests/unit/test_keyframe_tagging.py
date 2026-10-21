"""W3.3 S4：打标执行与落库（A7 词表 / I-1 claim 前置 / I-3 移除帧不外传）。

本文件用假 HTTP client：要验的是「编排与落库」，不是网关行为
（网关行为已由 S3 的 real_provider 用例覆盖）。真实额度不该被单测消耗。
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from aivs_core.database import Database, utc_now
from aivs_core.keyframe_egress import KeyframeEgressService
from aivs_core.keyframe_tagging import KeyframeTaggingService
from aivs_core.media.keyframe_encode import EncodedFrame
from aivs_core.media.keyframe_sampling import MODE_SCENE_CUT, SamplingPlan
from aivs_core.media.keyframe_vocab import load_vocabulary
from aivs_core.projects import DomainError

VOCAB = load_vocabulary()
BASE_URL = "http://127.0.0.1:8326/v1"


class FakeResponse:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class FakeClient:
    def __init__(self, responses: list[FakeResponse]) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    def __enter__(self) -> FakeClient:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def post(self, url: str, *, json: dict, headers: dict) -> FakeResponse:
        self.calls.append({"url": url, "body": json, "headers": headers})
        if not self.responses:
            raise AssertionError("no scripted response left")
        return self.responses.pop(0)


def _completion(labels: list[str], notes: str | None) -> FakeResponse:
    content = json.dumps({"labels": labels, "notes": notes})
    message = {"content": content}
    return FakeResponse(200, {"choices": [{"finish_reason": "stop", "message": message}]})


def _exhausted() -> FakeResponse:
    choice = {"finish_reason": "length", "message": {"content": None}}
    return FakeResponse(200, {"choices": [choice]})


class FakeVault:
    def for_request(self, provider_config_id: str) -> str:
        return "secret-value"


class FakeProviders:
    def __init__(self, row: dict | None) -> None:
        self.row = row

    def get(self, provider_config_id: str) -> dict | None:
        return self.row


PROVIDER_ROW = {
    "id": "prov_1", "enabled": 1, "model": "vision-model", "base_url": BASE_URL,
}


@pytest.fixture
def env(tmp_path: Path):
    db = Database(tmp_path / "t.db")
    db.initialize()
    now = utc_now()
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects (id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("proj_1", "P", "active", "{}", None, "C:/t", "t", now, now, now),
        )
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,"
            "fingerprint,size_bytes,availability,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("asset_1", "proj_1", "video", "external", "a.mp4", "fp_1", 1, "available", now, now),
        )
        conn.execute(
            "INSERT INTO provider_configs (id,kind,display_name,base_url,model,"
            "enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            ("prov_1", "openai_compatible_text", "P", BASE_URL, "vision-model", 1, now, now),
        )
    egress = KeyframeEgressService(db, cache_root=tmp_path / "cache")
    yield db, egress


def _frame(index: int) -> EncodedFrame:
    data = f"jpeg-{index}".encode() * 8
    thumb = f"t-{index}".encode()
    return EncodedFrame(
        timestamp_us=index * 1_000_000, source_reason="scene_cut",
        payload_bytes=data, payload_sha256=hashlib.sha256(data).hexdigest(),
        payload_width=768, payload_height=432,
        thumbnail_bytes=thumb, thumbnail_sha256=hashlib.sha256(thumb).hexdigest(),
        thumbnail_width=192, thumbnail_height=108,
    )


def _prepared(egress: KeyframeEgressService, count: int = 2) -> str:
    frames = [_frame(i) for i in range(count)]
    plan = SamplingPlan(tuple((i * 1_000_000, "scene_cut") for i in range(count)),
                        MODE_SCENE_CUT, count, count, True)
    preview = egress.prepare(
        "proj_1", {"id": "asset_1", "fingerprint": "fp_1"},
        {"provider_config_id": "prov_1", "model": "vision-model"}, frames, plan,
    )
    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"],
    )
    return created["keyframe_generation_id"]


def _service(egress, client: FakeClient, *, provider: dict | None = PROVIDER_ROW):
    return KeyframeTaggingService(
        egress.db, egress, FakeProviders(provider), FakeVault(),
        client_factory=lambda **kw: client, vocabulary=VOCAB,
    )


@pytest.mark.asyncio
async def test_tags_persist_and_generation_succeeds(env) -> None:
    db, egress = env
    generation_id = _prepared(egress, 2)
    client = FakeClient([_completion(["人物"], None), _completion(["动物"], "小猫")])
    result = await _service(egress, client).tag_generation("proj_1", generation_id)

    assert result["frame_count"] == 2
    assert result["vocabulary_version"] == VOCAB.vocabulary_version
    with db.connection() as conn:
        rows = conn.execute(
            "SELECT frame_index,labels_json,notes FROM asset_frame_tags "
            "WHERE asset_id=? ORDER BY frame_index", ("asset_1",),
        ).fetchall()
        status = conn.execute(
            "SELECT status FROM keyframe_generations WHERE id=?", (generation_id,),
        ).fetchone()["status"]
    assert [r["frame_index"] for r in rows] == [0, 1]
    assert json.loads(rows[0]["labels_json"]) == ["人物"]
    assert rows[1]["notes"] == "小猫"
    assert status == "succeeded"


@pytest.mark.asyncio
async def test_request_carries_strict_schema_and_budget(env) -> None:
    _db, egress = env
    generation_id = _prepared(egress, 1)
    client = FakeClient([_completion(["人物"], None)])
    await _service(egress, client).tag_generation("proj_1", generation_id)

    body = client.calls[0]["body"]
    assert body["response_format"]["type"] == "json_schema"
    assert body["max_tokens"] == 2000
    assert client.calls[0]["headers"]["Authorization"] == "Bearer secret-value"
    assert client.calls[0]["url"] == BASE_URL + "/chat/completions"


@pytest.mark.asyncio
async def test_second_call_fails_because_consent_consumed(env) -> None:
    """claim 只能消费一次 ⇒ 同一 generation 不得被打标两次（I-1）。"""
    _db, egress = env
    generation_id = _prepared(egress, 1)
    client = FakeClient([_completion(["人物"], None)])
    service = _service(egress, client)
    await service.tag_generation("proj_1", generation_id)
    with pytest.raises(DomainError):
        await service.tag_generation("proj_1", generation_id)


@pytest.mark.asyncio
async def test_out_of_vocabulary_label_moves_to_notes(env) -> None:
    db, egress = env
    generation_id = _prepared(egress, 1)
    client = FakeClient([_completion(["人物", "坦克"], None)])
    result = await _service(egress, client).tag_generation("proj_1", generation_id)

    assert result["vocabulary_violations"] == 1
    with db.connection() as conn:
        row = conn.execute(
            "SELECT labels_json,notes FROM asset_frame_tags WHERE asset_id=?",
            ("asset_1",),
        ).fetchone()
    assert json.loads(row["labels_json"]) == ["人物"]
    assert "坦克" in row["notes"]


@pytest.mark.asyncio
async def test_vocabulary_violation_does_not_block_persist(env) -> None:
    """违规不阻断落库：丢整帧的代价远大于多留一句描述。"""
    db, egress = env
    generation_id = _prepared(egress, 1)
    client = FakeClient([_completion(["完全不存在的标签"], None)])
    await _service(egress, client).tag_generation("proj_1", generation_id)
    with db.connection() as conn:
        count = conn.execute(
            "SELECT COUNT(*) AS c FROM asset_frame_tags WHERE asset_id=?", ("asset_1",),
        ).fetchone()["c"]
    assert count == 1


@pytest.mark.asyncio
async def test_retries_once_with_doubled_budget(env) -> None:
    _db, egress = env
    generation_id = _prepared(egress, 1)
    client = FakeClient([_exhausted(), _completion(["人物"], None)])
    result = await _service(egress, client).tag_generation("proj_1", generation_id)

    assert result["frame_count"] == 1
    assert [c["body"]["max_tokens"] for c in client.calls] == [2000, 4000]


@pytest.mark.asyncio
async def test_fails_after_second_exhaustion(env) -> None:
    """只重试一次：再撞顶就如实失败，不无限烧额度。"""
    _db, egress = env
    generation_id = _prepared(egress, 1)
    client = FakeClient([_exhausted(), _exhausted()])
    with pytest.raises(DomainError) as exc:
        await _service(egress, client).tag_generation("proj_1", generation_id)
    # 断言**错误码**而不是消息文本：消息是中文，且措辞可改而码是契约。
    assert exc.value.code == "PROVIDER_TOKEN_BUDGET_EXHAUSTED"
    assert len(client.calls) == 2


@pytest.mark.asyncio
async def test_excluded_frames_are_not_sent(env) -> None:
    """I-3：用户移除的帧不得外传。"""
    db, egress = env
    frames = [_frame(i) for i in range(3)]
    plan = SamplingPlan(tuple((i * 1_000_000, "scene_cut") for i in range(3)),
                        MODE_SCENE_CUT, 3, 3, True)
    preview = egress.prepare(
        "proj_1", {"id": "asset_1", "fingerprint": "fp_1"},
        {"provider_config_id": "prov_1", "model": "vision-model"}, frames, plan,
    )
    pvid = preview["keyframe_egress_preview_id"]
    after = egress.exclude_frames("proj_1", pvid, [1])
    created = egress.create("proj_1", pvid, after["payload_sha256"])

    client = FakeClient([_completion(["人物"], None), _completion(["动物"], None)])
    result = await _service(egress, client).tag_generation(
        "proj_1", created["keyframe_generation_id"],
    )
    assert result["frame_count"] == 2
    assert len(client.calls) == 2
    with db.connection() as conn:
        indices = [r["frame_index"] for r in conn.execute(
            "SELECT frame_index FROM asset_frame_tags WHERE asset_id=? ORDER BY frame_index",
            ("asset_1",),
        ).fetchall()]
    assert indices == [0, 2]


@pytest.mark.asyncio
async def test_non_200_raises(env) -> None:
    _db, egress = env
    generation_id = _prepared(egress, 1)
    client = FakeClient([FakeResponse(400, {"error": "bad"})])
    with pytest.raises(DomainError):
        await _service(egress, client).tag_generation("proj_1", generation_id)


@pytest.mark.asyncio
async def test_missing_provider_raises(env) -> None:
    _db, egress = env
    generation_id = _prepared(egress, 1)
    client = FakeClient([])
    with pytest.raises(DomainError):
        await _service(egress, client, provider=None).tag_generation("proj_1", generation_id)
