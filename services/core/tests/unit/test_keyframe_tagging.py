"""W3.3 S4：打标执行与落库（A7 词表 / I-1 claim 前置 / I-3 移除帧不外传）。

本文件用假 HTTP client：要验的是「编排与落库」，不是网关行为
（网关行为已由 S3 的 real_provider 用例覆盖）。真实额度不该被单测消耗。
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


def _fresh_env(tmp_path: Path):
    """与 env fixture 同款世界，但可被同步用例直接调用（fixture 只能注入）。"""
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
            # vision 能力六列显式置 supported：create 自 A4 起 fail-closed，
            # 未探测的 Provider 一律拒。照 captions 测试的既有做法，在夹具里
            # 直接置状态，而不是为了让测试变绿去放宽生产门禁。
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


@pytest.fixture
def env(tmp_path: Path):
    return _fresh_env(tmp_path)


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

# ── 生产链路：create 落作业 / runner 可被分派 / 每次调用落审计行 ──


class FakeJobs:
    """实现 insert_keyframe_tagging_job 的最小对象（签名与真实 JobService 一致）。"""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def insert_keyframe_tagging_job(self, db, job_id, now, project_id,
                                    generation_id, asset_id) -> None:
        self.calls.append({
            "db": db, "job_id": job_id, "project_id": project_id,
            "generation_id": generation_id, "asset_id": asset_id,
        })


def _job_row(db: Database, generation_id: str):
    with db.connection() as conn:
        return conn.execute(
            "SELECT * FROM jobs WHERE kind=? AND input_json LIKE ?",
            ("keyframe_tagging", f"%{generation_id}%"),
        ).fetchone()


def _prepare_with_preview(egress: KeyframeEgressService, count: int = 1):
    frames = [_frame(i) for i in range(count)]
    plan = SamplingPlan(
        tuple((i * 1_000_000, "scene_cut") for i in range(count)),
        MODE_SCENE_CUT, count, count, True,
    )
    return egress.prepare(
        "proj_1", {"id": "asset_1", "fingerprint": "fp_1"},
        {"provider_config_id": "prov_1", "model": "vision-model"}, frames, plan,
    )


def test_create_persists_exactly_one_tagging_job(env) -> None:
    """create 必须原子落一条 keyframe_tagging 作业，且载荷指向本次生成。

    此前 create() 接受 jobs 参数却从不使用：生成记录落库后没有任何执行者，
    永远停在 queued（W3.3 收口前生产链路的第一处断点）。
    """
    db, egress = env
    preview = _prepare_with_preview(egress, 1)
    jobs = FakeJobs()

    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"], jobs,
    )

    assert len(jobs.calls) == 1, "create 必须恰好落一条作业"
    call = jobs.calls[0]
    assert call["generation_id"] == created["keyframe_generation_id"]
    assert call["project_id"] == "proj_1"
    assert call["asset_id"] == "asset_1"


def test_create_with_real_job_service_writes_dispatchable_row(tmp_path: Path) -> None:
    """用**真实** JobService：作业行带对的 kind/资源档与 input_json。

    FakeJobs 只证明「有人被调用」；本用例证明真实写入的列值可被 jobs._run
    认出（kind 匹配分派分支、input_json 里有 generation id、resource_class=light）。
    """
    from aivs_core.jobs import JobService

    db, egress = _fresh_env(tmp_path)
    preview = _prepare_with_preview(egress, 1)
    jobs = JobService(
        db, tmp_path, Path("ffmpeg-x"), object(), object(),
        lambda _event: asyncio.sleep(0),
    )

    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"], jobs,
    )

    with db.connection() as conn:
        rows = conn.execute(
            "SELECT project_id,kind,status,resource_class,input_json FROM jobs "
            "WHERE kind=?", ("keyframe_tagging",),
        ).fetchall()
    assert len(rows) == 1, f"应恰好一条 keyframe_tagging 作业，实得 {len(rows)}"
    row = rows[0]
    assert row["project_id"] == "proj_1"
    assert row["status"] == "queued"
    assert row["resource_class"] == "light", "应与其它 light 作业同款资源档"
    payload = json.loads(row["input_json"])
    assert payload["keyframe_generation_id"] == created["keyframe_generation_id"]
    assert payload["project_id"] == "proj_1"
    assert payload["asset_id"] == "asset_1"


def test_create_without_jobs_still_writes_consent_and_generation(env) -> None:
    """jobs=None 的兼容退化：只少作业行，consent+generation 照常落库。"""
    db, egress = env
    preview = _prepare_with_preview(egress, 1)

    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"],
    )

    with db.connection() as conn:
        consent = conn.execute(
            "SELECT COUNT(*) FROM keyframe_egress_consents WHERE id=?",
            (created["consent_id"],),
        ).fetchone()[0]
        generation = conn.execute(
            "SELECT COUNT(*) FROM keyframe_generations WHERE id=?",
            (created["keyframe_generation_id"],),
        ).fetchone()[0]
        jobs = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE kind=?", ("keyframe_tagging",),
        ).fetchone()[0]
    assert consent == 1 and generation == 1
    assert jobs == 0, "未传 jobs 时不得凭空造作业行"


def test_create_is_atomic_when_job_insert_fails(env) -> None:
    """作业插入失败必须整体回滚：不能留下「已签同意书、永远排队」的记录。

    这是「同一事务」与「顺序两句」的唯一可观测差别——若 create 先提交
    consent+generation 再插作业，本例会发现残留行。
    """
    db, egress = env
    preview = _prepare_with_preview(egress, 1)

    class ExplodingJobs:
        def insert_keyframe_tagging_job(self, *args, **kwargs) -> None:
            raise RuntimeError("job insert boom")

    with pytest.raises(RuntimeError):
        egress.create(
            "proj_1", preview["keyframe_egress_preview_id"],
            preview["payload_sha256"], ExplodingJobs(),
        )

    with db.connection() as conn:
        consents = conn.execute("SELECT COUNT(*) FROM keyframe_egress_consents").fetchone()[0]
        generations = conn.execute(
            "SELECT COUNT(*) FROM keyframe_generations"
        ).fetchone()[0]
    assert consents == 0, f"回滚后不得残留同意书，实得 {consents}"
    assert generations == 0, f"回滚后不得残留生成记录，实得 {generations}"
# ── 调度策略登记：不登记 ⇒ unknown ⇒ 保守独占 heavy（挡住导出）──


def test_scheduler_policy_is_registered_as_light() -> None:
    """keyframe_tagging 必须登记为 light/2，而不是落进 unknown 的 heavy 档。

    未登记时 policy_for 返回 cpu_heavy+gpu_heavy+disk_heavy（优先级 5）：
    一次纯粹等 Provider 限流的打标会独占渲染三令牌，用户点一次打标，
    导出就排不进去。这不是「保守」，是把网络等待错当成本地重负载。
    """
    from aivs_core.job_scheduler import JobPolicy, policy_for

    policy = policy_for("keyframe_tagging")
    assert policy == JobPolicy("keyframe_tagging", ("light",), 2)
    # 与同档轻作业对齐：波形/节拍/语义索引/机位同步都是 light。
    assert policy.resources == policy_for("waveform").resources
# ── 执行体：run_tagging_job（jobs.py 的 keyframe_runner 槽位）──


def _service_with_real_jobs(egress, client: FakeClient, tmp_path: Path):
    """装配真实 JobService + 真实 runner（不经任何 fake 作业层）。"""
    from aivs_core.jobs import JobService

    svc = _service(egress, client)
    jobs = JobService(
        egress.db, tmp_path, Path("ffmpeg-x"), object(), object(),
        lambda _event: asyncio.sleep(0),
        keyframe_runner=svc.run_tagging_job,
    )
    return svc, jobs


@pytest.mark.asyncio
async def test_job_service_dispatches_tagging_end_to_end(env, tmp_path: Path) -> None:
    """真实分派：create 产出的作业被 jobs._run 执行并置 succeeded。

    这是「runner 接线是否真的通了」的端到端证据：不经过任何 fake 作业层，
    作业行由真实 create 写出，执行体由真实 JobService 分派。
    """
    db, egress = env
    svc, jobs = _service_with_real_jobs(egress, FakeClient([]), tmp_path)
    preview = _prepare_with_preview(egress, 1)
    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"], jobs,
    )
    generation_id = created["keyframe_generation_id"]
    job = _job_row(db, generation_id)
    assert job is not None, "create 必须写出可被分派的作业行"

    svc._client_factory = lambda **kw: FakeClient([_completion(["人物"], None)])
    await jobs._run(job["id"])

    with db.connection() as conn:
        job_row = conn.execute(
            "SELECT status,result_json FROM jobs WHERE id=?", (job["id"],),
        ).fetchone()
        generation = conn.execute(
            "SELECT status FROM keyframe_generations WHERE id=?", (generation_id,),
        ).fetchone()["status"]
        tags = conn.execute(
            "SELECT COUNT(*) FROM asset_frame_tags WHERE generation_id=?",
            (generation_id,),
        ).fetchone()[0]
    assert job_row["status"] == "succeeded", f"作业未被真实执行: {job_row['status']}"
    assert generation == "succeeded"
    assert tags == 1
    assert json.loads(job_row["result_json"])["frame_count"] == 1


@pytest.mark.asyncio
async def test_job_failure_marks_generation_failed(env, tmp_path: Path) -> None:
    """作业失败必须把 generation 落 failed，否则桌面端永久显示「进行中」。

    只让作业行失败是不够的：状态查询读的是 keyframe_generations。
    """
    db, egress = env
    svc, jobs = _service_with_real_jobs(egress, FakeClient([]), tmp_path)
    preview = _prepare_with_preview(egress, 1)
    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"], jobs,
    )
    generation_id = created["keyframe_generation_id"]
    job = _job_row(db, generation_id)

    # Provider 返回 400 ⇒ DomainError(VISION_PROVIDER_UNSUPPORTED)
    svc._client_factory = lambda **kw: FakeClient([FakeResponse(400, {"error": "bad"})])
    await jobs._run(job["id"])

    with db.connection() as conn:
        job_row = conn.execute(
            "SELECT status,error_code FROM jobs WHERE id=?", (job["id"],),
        ).fetchone()
        generation = conn.execute(
            "SELECT status,finished_at FROM keyframe_generations WHERE id=?",
            (generation_id,),
        ).fetchone()
    assert job_row["status"] == "failed"
    assert job_row["error_code"] == "VISION_PROVIDER_UNSUPPORTED"
    assert generation["status"] == "failed", "generation 必须落失败终态"
    assert generation["finished_at"], "失败也要时间戳，否则无法判断卡住还是已终态"


@pytest.mark.asyncio
async def test_runner_without_wiring_raises_render_failed(env) -> None:
    """负向对照的常驻版本：runner 槽位空着 ⇒ 作业以 RENDER_FAILED 失败。

    这锁住上一条的证据力：JobService 不会静默跳过未接线的 kind，
    因此「端到端用例绿」只可能来自真实接线。
    """
    from aivs_core.jobs import JobService

    db, egress = env
    preview = _prepare_with_preview(egress, 1)
    unbound = JobService(
        db, Path("."), Path("ffmpeg-x"), object(), object(),
        lambda _event: asyncio.sleep(0),
    )
    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"],
        preview["payload_sha256"], unbound,
    )
    job = _job_row(db, created["keyframe_generation_id"])

    await unbound._run(job["id"])

    with db.connection() as conn:
        job_row = conn.execute(
            "SELECT status,error_code FROM jobs WHERE id=?", (job["id"],),
        ).fetchone()
    assert job_row["status"] == "failed"
    assert job_row["error_code"] == "RENDER_FAILED"
# ── provider_invocations：行数 == 真实 HTTP 调用次数（规划门 A10）──


def _invocations(db: Database, generation_id: str) -> list:
    with db.connection() as conn:
        return conn.execute(
            "SELECT provider_config_id,capability,model,input_sha256,status,error_code "
            "FROM provider_invocations WHERE keyframe_generation_id=? "
            "ORDER BY created_at,id",
            (generation_id,),
        ).fetchall()


@pytest.mark.asyncio
async def test_one_invocation_row_per_frame_success(env) -> None:
    """成功路径：N 帧 == N 次调用 == N 行审计。

    此前该表一行都不写：A10 的「行数 == 调用次数」根本无法断言，
    而且外传审计链在这条链路上是断的（出事时无法回答发给了谁几次）。
    """
    db, egress = env
    generation_id = _prepared(egress, 2)
    client = FakeClient([_completion(["人物"], None), _completion(["动物"], None)])
    await _service(egress, client).tag_generation("proj_1", generation_id)

    rows = _invocations(db, generation_id)
    assert len(client.calls) == 2
    assert len(rows) == len(client.calls), (
        f"审计行数必须等于调用次数：调用 {len(client.calls)} 次，实得 {len(rows)} 行"
    )
    assert all(row["status"] == "succeeded" for row in rows)
    assert all(row["capability"] == "keyframe_tagging" for row in rows)
    assert all(row["provider_config_id"] == "prov_1" for row in rows)
    assert all(row["model"] == "vision-model" for row in rows)
    # input_sha256 必须是该帧 payload 的哈希（不同帧 ⇒ 不同哈希）。
    assert len({row["input_sha256"] for row in rows}) == 2
    assert all(len(row["input_sha256"]) == 64 for row in rows)


@pytest.mark.asyncio
async def test_retry_beyond_token_budget_is_a_second_invocation_row(env) -> None:
    """撞顶重试是**第二次真实调用**，因此是第二行（且第一行记 failed）。

    这是 A10 的关键区分力：若按「帧数」计数，重试会被吞掉——而重试正是
    重复烧额度的地方，审计里恰恰不能看不见它。
    """
    db, egress = env
    generation_id = _prepared(egress, 1)
    client = FakeClient([_exhausted(), _completion(["人物"], None)])
    result = await _service(egress, client).tag_generation("proj_1", generation_id)

    rows = _invocations(db, generation_id)
    assert result["frame_count"] == 1, "只处理了 1 帧"
    assert len(client.calls) == 2, "1 帧撞顶重试 ⇒ 2 次真实调用"
    assert len(rows) == 2, f"2 次调用必须落 2 行审计，实得 {len(rows)}"
    assert [row["status"] for row in rows] == ["failed", "succeeded"]
    assert rows[0]["error_code"] == "PROVIDER_TOKEN_BUDGET_EXHAUSTED"
    assert rows[1]["error_code"] is None


@pytest.mark.asyncio
async def test_non_200_invocation_is_failed_with_code(env) -> None:
    """网络/HTTP 失败也要留行：失败调用同样是「可能已外传」。"""
    db, egress = env
    generation_id = _prepared(egress, 1)
    client = FakeClient([FakeResponse(500, {"error": "boom"})])
    with pytest.raises(DomainError):
        await _service(egress, client).tag_generation("proj_1", generation_id)

    rows = _invocations(db, generation_id)
    assert len(rows) == 1
    assert rows[0]["status"] == "failed"
    assert rows[0]["error_code"] == "VISION_PROVIDER_UNSUPPORTED"

# ── 状态查询（S5b）：键集合冻结 + 项目隔离 ──

STATUS_KEYS = {
    "keyframe_generation_id", "status", "frame_count",
    "vocabulary_violations", "vocabulary_version", "error_code",
}


def test_generation_status_key_set_is_frozen(env) -> None:
    """键集合必须**恰好**是契约那六个：Desktop 侧按 onlyKeys 校验，多/少都算破坏。"""
    db, egress = env
    preview = _prepare_with_preview(egress, 1)
    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"],
    )

    status = egress.generation_status("proj_1", created["keyframe_generation_id"])

    assert set(status) == STATUS_KEYS
    assert status["keyframe_generation_id"] == created["keyframe_generation_id"]
    assert status["status"] == "queued"
    # 尚未打标：三项如实为 None（不是 0——0 会被读成「打了 0 帧」）。
    assert status["frame_count"] is None
    assert status["vocabulary_violations"] is None
    assert status["vocabulary_version"] is None
    assert status["error_code"] is None


def test_generation_status_is_project_scoped(env) -> None:
    """跨项目查询必须报「不存在」，且与真不存在**不可区分**（防枚举）。"""
    db, egress = env
    preview = _prepare_with_preview(egress, 1)
    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"],
    )

    with pytest.raises(DomainError) as other_project:
        egress.generation_status("proj_other", created["keyframe_generation_id"])
    with pytest.raises(DomainError) as missing:
        egress.generation_status("proj_1", "keyframe_gen_does_not_exist")

    assert other_project.value.code == "KEYFRAME_GENERATION_NOT_FOUND"
    assert missing.value.code == other_project.value.code


@pytest.mark.asyncio
async def test_generation_status_reports_counts_after_tagging(env) -> None:
    """打标成功后三项计数必须有值，且违规数按 notes 计（词表外改道 notes）。"""
    db, egress = env
    preview = _prepare_with_preview(egress, 2)
    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"],
    )
    client = FakeClient([_completion(["人物"], None), _completion(["坦克"], None)])
    await _service(egress, client).tag_generation(
        "proj_1", created["keyframe_generation_id"],
    )

    status = egress.generation_status("proj_1", created["keyframe_generation_id"])

    assert status["status"] == "succeeded"
    assert status["frame_count"] == 2
    assert status["vocabulary_version"] == VOCAB.vocabulary_version
    assert status["vocabulary_violations"] == 1, "第二帧的词表外标签改道 notes ⇒ 违规 1"


def test_generation_status_counts_go_null_after_asset_delete(env, tmp_path: Path) -> None:
    """素材被删后标签行随 ON DELETE CASCADE 消失：计数如实为 None，而不是编一个 0。

    0 会被读成「这次打标打了 0 帧」（一个可以据以做决定的事实），
    而真实情况是「标签行已随素材消失，无从得知」。两者对 UI 的含义完全相反。

    走**真实** delete_asset：CASCADE 是否真的发生由 FK 决定，不由本用例假设。
    """
    from aivs_core.projects import ProjectAssetService

    db, egress = env
    preview = _prepare_with_preview(egress, 1)
    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"],
    )
    generation_id = created["keyframe_generation_id"]
    now = utc_now()
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO asset_frame_tags(id,asset_id,source_fingerprint,algorithm_version,"
            "vocabulary_id,vocabulary_version,status,frame_index,timestamp_us,labels_json,"
            "generation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("tag_x", "asset_1", "fp_1", 1, VOCAB.vocabulary_id,
             VOCAB.vocabulary_version, "ready", 0, 0, "[]", generation_id, now, now),
        )
    before = egress.generation_status("proj_1", generation_id)
    assert before["frame_count"] == 1
    assert before["vocabulary_violations"] == 0

    async def _probe(*args, **kwargs):  # pragma: no cover - 本用例不探测
        return {}

    projects = ProjectAssetService(
        db, tmp_path, _probe,
        detach_keyframe_previews=lambda conn, aid: egress.detach_asset(aid, conn),
    )
    projects.delete_asset("asset_1")

    after = egress.generation_status("proj_1", generation_id)
    assert after["frame_count"] is None, (
        f"应如实为 None（标签行已随素材 CASCADE 消失），实得 {after['frame_count']!r}"
    )
    assert after["vocabulary_violations"] is None
    assert after["vocabulary_version"] is None
    assert after["status"] == "queued", "生成状态本身不受标签行消失影响"

# ── 状态查询的 HTTP 层：200 / 404 语义（服务层抛码 ≠ 路由给对状态码）──


def _build_app(tmp_path: Path):
    """真实 create_app（**不跑 lifespan**：不启动调度循环，零 ffmpeg 依赖）。"""
    from fastapi.testclient import TestClient

    from aivs_core.app import create_app
    from aivs_core.config import Settings

    app = create_app(
        Settings(
            data_dir=tmp_path / "data",
            ffmpeg=Path("ffmpeg-x"),
            ffprobe=Path("ffprobe-x"),
        )
    )
    state = app.state.core
    state.db.initialize()
    headers = {"Authorization": "Bearer " + state.auth.create_ui_token()}
    return TestClient(app), state, headers


def _seed_app_world(state, tmp_path: Path, project_id: str = "p1") -> tuple[str, str]:
    """建项目 + 素材 + Provider + 真实 preview/consent/generation 链。

    不手写 generation 行：它有两个 NOT NULL 外键（preview / consent），
    手写就得伪造整条链——那等于把要验证的约束绕掉。走 create 才真实。
    """
    now = utc_now()
    asset_id = f"a_{project_id}"
    provider_id = f"prov_{project_id}"
    with state.db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (project_id, "路由测试", "active", "{}", str(tmp_path), "r", now, now, now),
        )
        conn.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (asset_id, project_id, "video", "external", "a.mp4", f"fp_{project_id}",
             10, "available", now, now),
        )
        conn.execute(
            # 同上：create 自 A4 起 fail-closed，夹具显式置 supported。
            "INSERT INTO provider_configs (id,kind,display_name,base_url,model,"
            "enabled,created_at,updated_at,vision_capability_status,"
            "vision_capability_tested_at,vision_response_adapter_id,"
            "vision_probe_protocol_version,vision_capability_failure_code,"
            "vision_capability_probe_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (provider_id, "openai_compatible_text", "P", BASE_URL, "vision-model",
             1, now, now, "supported", now,
             "openai_chat_completions_image_url_v1", "1", None, "sha256:" + "0" * 64),
        )
    frames = [_frame(0)]
    plan = SamplingPlan(((0, "scene_cut"),), MODE_SCENE_CUT, 1, 1, True)
    preview = state.keyframe_egress.prepare(
        project_id, {"id": asset_id, "fingerprint": f"fp_{project_id}"},
        {"provider_config_id": provider_id, "model": "vision-model"}, frames, plan,
    )
    created = state.keyframe_egress.create(
        project_id, preview["keyframe_egress_preview_id"], preview["payload_sha256"],
    )
    return project_id, created["keyframe_generation_id"]


def test_status_route_returns_frozen_key_set(tmp_path: Path) -> None:
    """200 的 body 键集合必须恰好是契约那六个。"""
    client, state, headers = _build_app(tmp_path)
    project_id, generation_id = _seed_app_world(state, tmp_path)

    response = client.get(
        f"/api/v1/projects/{project_id}/keyframe-generations/{generation_id}",
        headers=headers,
    )

    assert response.status_code == 200, response.text
    assert set(response.json()) == STATUS_KEYS
    assert response.json()["status"] == "queued"


def test_status_route_cross_project_is_404_not_500(tmp_path: Path) -> None:
    """不属于该 project 的 generation ⇒ 404（跨项目不是服务器错误）。"""
    client, state, headers = _build_app(tmp_path)
    _project, generation_id = _seed_app_world(state, tmp_path, "p1")
    _seed_app_world(state, tmp_path, "p2")

    other = client.get(
        f"/api/v1/projects/p2/keyframe-generations/{generation_id}", headers=headers,
    )
    missing = client.get(
        "/api/v1/projects/p1/keyframe-generations/gen_missing", headers=headers,
    )

    assert other.status_code == 404, f"跨项目应 404，实得 {other.status_code}"
    assert missing.status_code == 404
    # 两者错误码相同：跨项目探测不得能区分「存在但不是你的」与「不存在」。
    assert other.json()["error"]["code"] == missing.json()["error"]["code"]

# ── 生产装配：CoreState 必须把 runner 与 detach 回调接上 ──


def test_app_state_wires_keyframe_runner_and_detach_callback(tmp_path: Path) -> None:
    """装配断言：create_app 的 CoreState 真的接上了 runner 与 detach 回调。

    其它用例各自证明了组件行为正确，但没有任何用例证明**生产装配**把它们
    连起来了——而 W3.3 收口前的四处断点全部是「组件正确、装配缺失」。
    本用例只断言装配事实，不重复验证组件语义。
    """
    client, state, _headers = _build_app(tmp_path)

    assert state.jobs.keyframe_runner is not None, (
        "keyframe_runner 未接线：keyframe_tagging 作业会以 RENDER_FAILED 失败"
    )
    assert (
        getattr(state.jobs.keyframe_runner, "__self__", None) is state.keyframe_tagging
    ), "runner 必须是 KeyframeTaggingService 的执行体，而不是别的对象"
    assert state.projects.detach_keyframe_previews is not None, (
        "detach 回调未接线：做过关键帧预览的素材将无法删除（P102 原样重演）"
    )
    assert isinstance(state.keyframe_tagging, KeyframeTaggingService), (
        "KeyframeTaggingService 必须被实例化（此前全仓无任何实例化点）"
    )

@pytest.mark.asyncio
async def test_generation_status_surfaces_error_code_after_failure(
    env, tmp_path: Path,
) -> None:
    """失败后 error_code 必须能从状态查询读到——这是 Desktop 唯一能显示的原因。

    error_code 存在作业行而不是 keyframe_generations（后者没有该列，加列要新迁移），
    所以这条用例同时锁住「状态查询确实去作业行取码」这条跨表关联。
    """
    db, egress = env
    svc, jobs = _service_with_real_jobs(egress, FakeClient([]), tmp_path)
    preview = _prepare_with_preview(egress, 1)
    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"], jobs,
    )
    generation_id = created["keyframe_generation_id"]
    job = _job_row(db, generation_id)

    svc._client_factory = lambda **kw: FakeClient([FakeResponse(400, {"error": "bad"})])
    await jobs._run(job["id"])

    status = egress.generation_status("proj_1", generation_id)
    assert status["status"] == "failed"
    assert status["error_code"] == "VISION_PROVIDER_UNSUPPORTED", (
        f"失败原因必须能从状态查询读到，实得 {status['error_code']!r}"
    )
    assert set(status) == STATUS_KEYS, "失败态同样不得增删键"

