"""W3.3 收口：打标结束后立即清掉 payload 字节（承诺「打标后不存原始 JPEG」）。

规划门 §5 R1 第 ④ 条承诺「打标后拒存原始 JPEG（只存标签与缩略图引用）」，
而此前实现只在**启动期**跑一次 purge_expired：外传过的原始帧在磁盘上至少
多留 15 分钟，跨进程则留到下次启动。本文件锁住收口后的行为。

每条断言都必须有区分力（这条纪律写在文件里，因为「0 字节」这种断言太容易
写成一个永远为真的空断言）：
  · 「字节归零」用 payload_dir_bytes 实测，且**先断言打标前 >0**，否则
    「0」可能只是「从来没写过」；
  · 元数据与哈希用**打标前**的取值逐字段比对，不是只看「非空」；
  · 幂等先断言第一次返回 1，再断言第二次返回 0；
  · 未打标的预览必须**字节数原样不动**——否则「清理」变成了「乱删」。
"""
from __future__ import annotations

import asyncio
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
            ("asset_1", "proj_1", "video", "external", "a.mp4", "fp_1", 1, "available",
             now, now),
        )
        conn.execute(
            # vision 六列显式置 supported：create 自 A4 起 fail-closed。
            "INSERT INTO provider_configs (id,kind,display_name,base_url,model,"
            "enabled,created_at,updated_at,vision_capability_status,"
            "vision_capability_tested_at,vision_response_adapter_id,"
            "vision_probe_protocol_version,vision_capability_failure_code,"
            "vision_capability_probe_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("prov_1", "openai_compatible_text", "P", BASE_URL, "vision-model", 1,
             now, now, "supported", now,
             "openai_chat_completions_image_url_v1", "1", None, "sha256:" + "0" * 64),
        )
    egress = KeyframeEgressService(db, cache_root=tmp_path / "cache")
    return db, egress


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


def _prepare(egress: KeyframeEgressService, count: int = 2, *, jobs=None) -> dict:
    frames = [_frame(i) for i in range(count)]
    plan = SamplingPlan(
        tuple((i * 1_000_000, "scene_cut") for i in range(count)),
        MODE_SCENE_CUT, count, count, True,
    )
    preview = egress.prepare(
        "proj_1", {"id": "asset_1", "fingerprint": "fp_1"},
        {"provider_config_id": "prov_1", "model": "vision-model"}, frames, plan,
    )
    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"], jobs,
    )
    return {
        "generation_id": created["keyframe_generation_id"],
        "preview_id": preview["keyframe_egress_preview_id"],
        "frames": preview["frames"],
    }


def _service(egress, client: FakeClient, *, provider: dict | None = PROVIDER_ROW):
    return KeyframeTaggingService(
        egress.db, egress, FakeProviders(provider), FakeVault(),
        client_factory=lambda **kw: client, vocabulary=VOCAB,
    )


def _job_row(db: Database, generation_id: str):
    with db.connection() as conn:
        return conn.execute(
            "SELECT * FROM jobs WHERE kind=? AND input_json LIKE ?",
            ("keyframe_tagging", f"%{generation_id}%"),
        ).fetchone()


def _row_payload(generation_id: str) -> dict:
    """run_tagging_job 只读这两个字段；用它免去为每条用例搭真实 JobService。"""
    return {
        "input_json": json.dumps(
            {"keyframe_generation_id": generation_id, "project_id": "proj_1"},
        ),
        "project_id": "proj_1",
    }


def _purged_at(db: Database, preview_id: str):
    with db.connection() as conn:
        return conn.execute(
            "SELECT payloads_purged_at FROM keyframe_egress_previews WHERE id=?",
            (preview_id,),
        ).fetchone()["payloads_purged_at"]


# ── 核心承诺：打标成功后字节立刻不在盘上 ──


@pytest.mark.asyncio
async def test_successful_tagging_purges_payload_bytes(env) -> None:
    """成功后 payload 目录必须归零——不是「15 分钟后会清」。"""
    db, egress = env
    item = _prepare(egress, 2)
    generation_id, preview_id = item["generation_id"], item["preview_id"]
    assert egress.payload_dir_bytes(preview_id) > 0, "前提：打标前载荷确实在盘上"

    client = FakeClient([_completion(["人物"], None), _completion(["动物"], "小猫")])
    await _service(egress, client).run_tagging_job(_row_payload(generation_id), None)

    assert egress.payload_dir_bytes(preview_id) == 0, "打标成功后不得留载荷字节"
    assert _purged_at(db, preview_id) is not None, "payloads_purged_at 必须落值"

    # 元数据与哈希逐字段不变（清理的是字节，不是审计）。
    kept = egress.get_preview("proj_1", preview_id)
    assert len(kept["frames"]) == len(item["frames"])
    assert [m["payload_sha256"] for m in kept["frames"]] == [
        m["payload_sha256"] for m in item["frames"]
    ]
    assert [m["payload_bytes"] for m in kept["frames"]] == [
        m["payload_bytes"] for m in item["frames"]
    ]
    # 缩略图元数据同样保留（A12 靠它证明「呈现 ≠ 外传」）。
    assert [m["thumbnail_sha256"] for m in kept["frames"]] == [
        m["thumbnail_sha256"] for m in item["frames"]
    ]
    # 标签真的落库了——否则「清完就完事」的空实现也能让上面全绿。
    with db.connection() as conn:
        tags = conn.execute(
            "SELECT COUNT(*) FROM asset_frame_tags WHERE generation_id=?",
            (generation_id,),
        ).fetchone()[0]
    assert tags == 2


@pytest.mark.asyncio
async def test_real_job_service_dispatch_purges(env, tmp_path: Path) -> None:
    """生产分派链路（create 落作业 → JobService._run → runner）同样清理。

    上面那条用例直接调 runner；这条证明清理点在**真实分派**下也生效，
    不是只有测试自己捏的调用顺序才会走到。
    """
    from aivs_core.jobs import JobService

    db, egress = env
    svc = _service(egress, FakeClient([_completion(["人物"], None)]))
    jobs = JobService(
        db, tmp_path, Path("ffmpeg-x"), object(), object(),
        lambda _event: asyncio.sleep(0),
        keyframe_runner=svc.run_tagging_job,
    )
    item = _prepare(egress, 1, jobs=jobs)
    preview_id = item["preview_id"]
    job = _job_row(db, item["generation_id"])
    assert job is not None, "create 必须写出作业行"
    assert egress.payload_dir_bytes(preview_id) > 0

    await jobs._run(job["id"])

    with db.connection() as conn:
        job_status = conn.execute(
            "SELECT status FROM jobs WHERE id=?", (job["id"],),
        ).fetchone()["status"]
    assert job_status == "succeeded"
    assert egress.payload_dir_bytes(preview_id) == 0


@pytest.mark.asyncio
async def test_generation_status_survives_purge(env) -> None:
    """清理不得影响状态查询：generation_status 读库，不读磁盘。"""
    db, egress = env
    item = _prepare(egress, 1)
    generation_id, preview_id = item["generation_id"], item["preview_id"]
    client = FakeClient([_completion(["人物"], None)])
    await _service(egress, client).run_tagging_job(_row_payload(generation_id), None)
    assert egress.payload_dir_bytes(preview_id) == 0

    status = egress.generation_status("proj_1", generation_id)
    assert status["status"] == "succeeded"
    assert status["frame_count"] == 1


# ── 幂等 ──


def test_purge_preview_is_idempotent(env) -> None:
    """第二次调用返回 0 且不抛；未知 id 也返回 0。

    区分力：先断言第一次返回 1——否则「两次都返回 0」也可能是因为它
    从来没清过任何东西。
    """
    _db, egress = env
    frames = [_frame(0)]
    preview = egress.prepare(
        "proj_1", {"id": "asset_1", "fingerprint": "fp_1"},
        {"provider_config_id": "prov_1", "model": "vision-model"}, frames,
        SamplingPlan(((0, "scene_cut"),), MODE_SCENE_CUT, 1, 1, True),
    )
    preview_id = preview["keyframe_egress_preview_id"]
    assert egress.payload_dir_bytes(preview_id) > 0
    assert egress.purge_preview(preview_id) == 1
    assert egress.payload_dir_bytes(preview_id) == 0
    assert egress.purge_preview(preview_id) == 0
    assert egress.purge_preview("kp_does_not_exist") == 0


# ── 隔离：别把别人的字节删了 ──


@pytest.mark.asyncio
async def test_untagged_preview_keeps_its_bytes(env) -> None:
    """打标 A 之后，尚未打标的 B 必须原封不动。

    区分力：B 的字节数在前后各测一次并断言**相等且 >0**。若清理写成了
    「清整个 cache_root」或「清所有预览」，本断言当场变红。
    """
    _db, egress = env
    a = _prepare(egress, 2)
    b = _prepare(egress, 2)
    bytes_b_before = egress.payload_dir_bytes(b["preview_id"])
    assert bytes_b_before > 0

    client = FakeClient([_completion(["人物"], None), _completion(["人物"], None)])
    await _service(egress, client).run_tagging_job(
        _row_payload(a["generation_id"]), None,
    )

    assert egress.payload_dir_bytes(a["preview_id"]) == 0
    assert egress.payload_dir_bytes(b["preview_id"]) == bytes_b_before
    assert _purged_at(egress.db, b["preview_id"]) is None


# ── 失败路径：同样清理 ──


@pytest.mark.asyncio
async def test_failed_tagging_also_purges_payload_bytes(env) -> None:
    """失败路径也必须清：字节的用途只有外传，而外传已经发生过（claim 完成）。

    区分力：先断言 job 与 generation 确实 failed，再断言字节为 0——否则
    「0」可能来自一个根本没跑起来的用例。
    """
    db, egress = env
    item = _prepare(egress, 1)
    generation_id, preview_id = item["generation_id"], item["preview_id"]
    assert egress.payload_dir_bytes(preview_id) > 0

    # Provider 返回 400 ⇒ DomainError(VISION_PROVIDER_UNSUPPORTED)
    client = FakeClient([FakeResponse(400, {"error": "bad"})])
    with pytest.raises(Exception):
        await _service(egress, client).run_tagging_job(
            _row_payload(generation_id), None,
        )

    with db.connection() as conn:
        job_status = conn.execute(
            "SELECT status FROM jobs WHERE kind='keyframe_tagging' "
            "AND input_json LIKE ?", (f"%{generation_id}%",),
        ).fetchone()
        generation = conn.execute(
            "SELECT status FROM keyframe_generations WHERE id=?", (generation_id,),
        ).fetchone()["status"]
    assert job_status is None or job_status["status"] in {"failed", "queued"}
    assert generation == "failed"
    assert egress.payload_dir_bytes(preview_id) == 0, "失败路径同样不得留载荷字节"
    assert _purged_at(db, preview_id) is not None


@pytest.mark.asyncio
async def test_direct_tag_generation_call_bypasses_purge(env) -> None:
    """**自曝的结构缺口**：直接调 tag_generation 不会清理。

    清理点刻意只设在作业入口 run_tagging_job（它是唯一的生产调用方：
    app.py:968 把它接到 JobService 的 keyframe_runner 槽位）。任何绕过作业
    层直接调 tag_generation 的代码都会拿到未清理的载荷字节。

    这条用例记录该缺口，而不是假装有守卫：若将来把清理下沉到 tag_generation
    内部，本用例会变红，届时应当删掉它（缺口已被填上），而不是放宽它。
    """
    _db, egress = env
    item = _prepare(egress, 1)
    client = FakeClient([_completion(["人物"], None)])
    await _service(egress, client).tag_generation("proj_1", item["generation_id"])
    assert egress.payload_dir_bytes(item["preview_id"]) > 0


# ── 缩略图不再落盘（无人读 ⇒ 不写） ──


def test_prepare_writes_no_thumbnail_files(env, tmp_path: Path) -> None:
    """缩略图**不落盘**，但它的元数据照留。

    这条锁住收口时的判断：全仓没有 thumb_*.jpg 的读取方。若将来有人加了
    读取方，本用例会先红——那是提醒，不是噪声。
    """
    _db, egress = env
    frames = [_frame(0), _frame(1)]
    preview = egress.prepare(
        "proj_1", {"id": "asset_1", "fingerprint": "fp_1"},
        {"provider_config_id": "prov_1", "model": "vision-model"}, frames,
        SamplingPlan(((0, "scene_cut"), (1_000_000, "scene_cut")),
                     MODE_SCENE_CUT, 2, 2, True),
    )
    directory = tmp_path / "cache" / preview["keyframe_egress_preview_id"]
    names = sorted(p.name for p in directory.iterdir())
    assert names == ["payload_000.jpg", "payload_001.jpg"], names
    # 落盘字节 == 载荷字节之和（不多也不少：多出来的就是泄露面）。
    assert egress.payload_dir_bytes(preview["keyframe_egress_preview_id"]) == sum(
        len(f.payload_bytes) for f in frames
    )
    # 元数据仍在。
    assert preview["frames"][0]["thumbnail_sha256"] == frames[0].thumbnail_sha256
    assert preview["frames"][0]["thumbnail_width"] == 192
