"""W3.3 S3：vision 能力探测（A4 fail-closed / I-1 三段式 / 六列落库）。

本文件用**假 HTTP client**：要验的是"探测编排 + 六列落库 + 门禁",
不是网关行为。真实网关探测属 S3 的 0.13 实测（另见
`docs/design/W3_3_S3_PROVIDER_PROBE_2026-10-21.md`），不在单测里烧额度。

四条硬约束（每条都有对应断言）：

  1. 探测成功 ⇒ 六列**逐列**正确落库（不是只看 status）。
  2. 探测失败（假 client 返回 400）⇒ `unsupported` + **具体**失败码落库。
  3. 此后 create 被拒 **且假 client 调用计数不变**（零字节外传）。
  4. 不经 claim 就发探测请求必须失败 —— `_call_provider` 无 claim 时
     抛 DomainError，且**调用计数为 0**。

⚠️ 结构可观测性自曝：`KeyframeEgressService.create` 本身不查 vision 能力
（该文件禁改），所以门禁落在 `VisionProbeService.create_generation`。
本文件测的是**那个方法**，不测既有 keyframe create 路由——后者仍可绕过，
已写入报告。
"""
from __future__ import annotations

import base64
import hashlib
import io
from pathlib import Path

import pytest
from PIL import Image as PILImage

from aivs_core.database import Database, utc_now
from aivs_core.keyframe_egress import KeyframeEgressService
from aivs_core.media.keyframe_encode import EncodedFrame, jpeg_dimensions
from aivs_core.media.keyframe_sampling import MODE_SCENE_CUT, SamplingPlan
from aivs_core.planning import ProviderRepository
from aivs_core.projects import DomainError
from aivs_core.providers import ProviderSecretVault
from aivs_core.vision_probe import (
    CAPABILITY_COLUMNS,
    PROBE_JPEG,
    VISION_PROBE_SCHEMA_MISMATCH,
    VISION_PROBE_UNSUPPORTED,
    VisionProbeService,
    probe_frame,
    probe_plan,
)

# 探测 JPEG **从生产模块导入，不在此处复制一份**。
# 复制过的后果是实测到的：本地副本没跟着换，所有探测用例就都在用旧的畸形
# 字节，而断言照样绿——缺陷 (b) 正是这样在测试全绿的情况下进的产线。
# 单一定义源才有区分力；合法性由 test_probe_jpeg_* 三条守着。


class FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None) -> None:
        self.status_code = status_code
        self._payload = payload if payload is not None else {}

    def json(self) -> dict:
        return self._payload


class FakeClient:
    """记录每一次网络调用。**调用计数是本文件的核心断言**。"""

    def __init__(self, response: FakeResponse) -> None:
        self.response = response
        self.calls: list[dict] = []

    def __enter__(self) -> FakeClient:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def post(self, url: str, *, json: dict, headers: dict) -> FakeResponse:
        self.calls.append({"url": url, "body": json, "headers": headers})
        return self.response


def _ok_response() -> FakeResponse:
    message = {"content": '{"labels": [], "notes": "probe"}'}
    return FakeResponse(200, {"choices": [{"finish_reason": "stop", "message": message}]})


@pytest.fixture
def env(tmp_path: Path):
    db = Database(tmp_path / "test.db")
    db.initialize()
    vault = ProviderSecretVault()
    providers = ProviderRepository(db, vault)
    now = utc_now()
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects (id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("proj_1", "P", "active", "{}", None, "C:/tmp/p", "p", now, now, now),
        )
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,"
            "fingerprint,size_bytes,availability,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("asset_1", "proj_1", "video", "external", "a.mp4",
             "fp_1", 100, "available", now, now),
        )
        conn.execute(
            "INSERT INTO provider_configs (id,kind,display_name,base_url,model,"
            "enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            ("prov_1", "openai_compatible_text", "P", "https://provider.test/v1",
             "vision-model", 1, now, now),
        )
    vault.set("prov_1", "secret-token")
    egress = KeyframeEgressService(db, cache_root=tmp_path / "cache")
    asset_row = {"id": "asset_1", "fingerprint": "fp_1", "kind": "video",
                 "availability": "available"}
    return db, egress, providers, vault, asset_row


def _service(env, client: FakeClient) -> VisionProbeService:
    db, egress, providers, vault, _ = env
    return VisionProbeService(
        db, egress, providers, vault, client_factory=lambda **kw: client,
    )


def _columns(db: Database, provider_id: str = "prov_1") -> dict:
    with db.connection() as conn:
        row = conn.execute(
            "SELECT vision_capability_status,vision_capability_tested_at,"
            "vision_response_adapter_id,vision_probe_protocol_version,"
            "vision_capability_failure_code,vision_capability_probe_sha256 "
            "FROM provider_configs WHERE id=?",
            (provider_id,),
        ).fetchone()
    return dict(row)


def _count(db: Database, table: str, where: str = "", params: tuple = ()) -> int:
    """数行。用 delta 而不是绝对值：探测本身会建一条 consent，
    绝对值断言会在"三段式真的跑了"这个**正确**事实上失败。"""
    sql = f"SELECT COUNT(*) AS n FROM {table}"
    if where:
        sql += f" WHERE {where}"
    with db.connection() as conn:
        return int(conn.execute(sql, params).fetchone()["n"])


def _create_preview(egress: KeyframeEgressService) -> dict:
    """一张合法预览（供 create 门禁用例使用）。零网络。"""
    data = b"payload-bytes-for-gate" * 4
    thumb = b"thumb" * 4
    frame = EncodedFrame(
        timestamp_us=0, source_reason="scene_cut",
        payload_bytes=data, payload_sha256=hashlib.sha256(data).hexdigest(),
        payload_width=768, payload_height=432,
        thumbnail_bytes=thumb, thumbnail_sha256=hashlib.sha256(thumb).hexdigest(),
        thumbnail_width=192, thumbnail_height=108,
    )
    plan = SamplingPlan(frames=((0, "scene_cut"),), sampling_mode=MODE_SCENE_CUT,
                        covered_scene_cuts=0, scene_cut_count=0, had_cv_analysis=True)
    return egress.prepare(
        "proj_1", {"id": "asset_1", "fingerprint": "fp_1"}, 
        {"provider_config_id": "prov_1", "model": "vision-model"},
        [frame], plan,
    )


# ── 1. 探测成功 ⇒ 六列逐列正确 ──


# ── (a) 生产装配：探测必须真的能发请求 ──
#
# 与 `test_app_state_wires_keyframe_runner_and_detach_callback` 同类：组件各自
# 正确、装配处漏传时单测全绿而生产链路一次都跑不通。这里锁的就是那一行装配。


def _build_probed_app(tmp_path: Path):
    """真实 create_app（不跑 lifespan，零 ffmpeg 依赖）。"""
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
    return state


def _seed_provider(state, tmp_path: Path) -> None:
    now = utc_now()
    with state.db.connection() as conn:
        conn.execute(
            "INSERT INTO projects (id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("proj_1", "P", "active", "{}", str(tmp_path), "p", now, now, now),
        )
        conn.execute(
            "INSERT INTO provider_configs (id,kind,display_name,base_url,model,"
            "enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            ("prov_1", "openai_compatible_text", "P", "https://provider.test/v1",
             "vision-model", 1, now, now),
        )
    state.provider_secrets.set("prov_1", "secret-token")


def test_app_state_wires_vision_probe_client_factory(tmp_path: Path) -> None:
    """create_app 装配的 vision_probe 必须带**可用的** client 工厂。

    漏传的后果链是完整的：探测恒抛 VISION_PROBE_UNSUPPORTED ⇒ Provider 永远
    untested ⇒ egress.create 的 fail-closed 永远拒绝 ⇒ 打标在生产里一次都跑不通。
    所以断言不停在「参数不是 None」，而是**真的拿到一个已就绪的 client**。
    """
    state = _build_probed_app(tmp_path)
    factory = state.vision_probe._client_factory
    assert factory is not None, "vision_probe 未接 client 工厂：探测会恒抛 VISION_PROBE_UNSUPPORTED"

    with factory(timeout=5.0, trust_env=False) as client:
        assert hasattr(client, "post"), f"工厂必须产出发得出请求的 client，实得 {client!r}"
        assert client.is_closed is False


async def test_app_wired_probe_reaches_supported_without_extra_wiring(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """装配来的服务必须能**探测成功**，而不只是「参数存在」。

    做法：只替换 app 模块里的 httpx（把网络换成假回复），**不改装配**。
    于是这条用例同时证明两件事：
      1. 装配给的工厂确实被 _call_provider 用到（假 client 收到了请求）；
      2. 漏传工厂时链路会红——因为那时 _client_factory 是 None，
         _call_provider 在发请求之前就抛，六列会落 unsupported。
    """
    import aivs_core.app as app_module

    client = FakeClient(_ok_response())
    monkeypatch.setattr(
        app_module, "httpx",
        type("StubHttpx", (), {"Client": staticmethod(lambda **kw: client)}),
    )
    state = _build_probed_app(tmp_path)
    _seed_provider(state, tmp_path)

    result = await state.vision_probe.probe("proj_1", "prov_1")

    assert result["vision_capability_status"] == "supported", (
        f"装配后的探测应 supported，实得 {result['vision_capability_status']} "
        f"(failure_code={result['vision_capability_failure_code']})"
    )
    assert len(client.calls) == 1, f"探测必须发出且只发出一次请求，实得 {len(client.calls)}"
    # 请求里带的必须是新的合法 JPEG（缺陷 (b) 与 (a) 的交汇点）。
    url = client.calls[0]["body"]["messages"][0]["content"][1]["image_url"]["url"]
    sent = base64.b64decode(url.split(",", 1)[1])
    assert sent == PROBE_JPEG
    assert jpeg_dimensions(sent) == (64, 64)


# ── (b) PROBE_JPEG 必须是**真能解**的 JPEG ──
#
# 旧常量 278 字节、头尾 SOI/EOI 齐全却缺 SOF 段：jpeg_dimensions 抛
# KeyframeEncodeError，PIL 抛 UnidentifiedImageError，网关回 400
# unsupported_content。后果不是「探测失败」而是「错误归因」——图坏了被记成
# 「模型不支持视觉」，用户据此换 Provider。所以合法性必须有用例守着：
# 光看头尾对不对是抓不到这个缺陷的。


def test_probe_jpeg_is_a_decodable_image() -> None:
    """`jpeg_dimensions` 与 PIL **双解**：两条独立解析器都认，才算合法。"""
    from aivs_core.media.keyframe_encode import jpeg_dimensions

    width, height = jpeg_dimensions(PROBE_JPEG)
    assert (width, height) == (64, 64), f"探测图尺寸应为 64x64，实得 {width}x{height}"

    image = PILImage.open(io.BytesIO(PROBE_JPEG))
    image.load()  # 只有 load() 才真正解码；open() 成功不代表像素能解出来
    assert image.size == (width, height), (
        f"PIL 与 jpeg_dimensions 必须给同一尺寸，实得 {image.size} vs {(width, height)}"
    )
    assert image.mode == "RGB"


def test_probe_jpeg_passes_pil_verify() -> None:
    """`verify()` 检查的是段结构完整性（SOI/SOF/DQT/DHT/SOS/EOI 齐全）。

    与上一条不重复：`load()` 对某些缺段文件仍能容忍，`verify()` 不能。
    旧常量正是「头尾对、结构缺」的形态，故两条都要有。
    """
    image = PILImage.open(io.BytesIO(PROBE_JPEG))
    image.verify()  # 结构不合法会抛，不需要断言返回值


def test_probe_jpeg_hash_is_pinned() -> None:
    """字节必须与记录的 sha256 一致——常量被手改时立刻红。

    探测哈希的可比性依赖「同一判据」；顺手改字节而不同步声明，
    会让历史 probe_sha256 失去参考意义。
    """
    assert hashlib.sha256(PROBE_JPEG).hexdigest() == (
        "0f8f822baca4447b44a90ba5bebc7a82e8f6172d6bec6ae26d754786bf675a84"
    )
    assert len(PROBE_JPEG) == 1025


def test_probe_frame_carries_the_legal_bytes_unchanged() -> None:
    """走 prepare 的载荷就是这段字节本身（不是被截断/替换的占位）。"""
    frame = probe_frame(PROBE_JPEG)
    assert frame.payload_bytes == PROBE_JPEG
    assert frame.payload_sha256 == hashlib.sha256(PROBE_JPEG).hexdigest()


async def test_probe_success_persists_all_six_columns(env) -> None:
    db, _, _, _, asset_row = env
    client = FakeClient(_ok_response())
    result = await _service(env, client).probe("proj_1", "prov_1", PROBE_JPEG)

    assert result["vision_capability_status"] == "supported"
    assert result["vision_response_adapter_id"] == "openai_chat_completions_image_url_v1"
    assert result["vision_probe_protocol_version"] == "1"
    assert result["vision_capability_failure_code"] is None
    assert result["vision_capability_tested_at"]  # 非空

    stored = _columns(db)
    # 六列逐列断言：只看 status 会让 adapter/协议版本/哈希任一列写错都逃逸。
    assert stored["vision_capability_status"] == "supported"
    assert stored["vision_response_adapter_id"] == "openai_chat_completions_image_url_v1"
    assert stored["vision_probe_protocol_version"] == "1"
    assert stored["vision_capability_failure_code"] is None
    assert stored["vision_capability_tested_at"] == result["vision_capability_tested_at"]
    assert stored["vision_capability_probe_sha256"] == result["vision_capability_probe_sha256"]

    # 探测确实发了**一次**请求，且请求体真的带图片内容块（不是文本探活）。
    assert len(client.calls) == 1
    content = client.calls[0]["body"]["messages"][0]["content"]
    assert any(part["type"] == "image_url" for part in content)
    assert client.calls[0]["body"]["response_format"]["type"] == "json_schema"
    # 探测预算必须是探测档（256），不是打标档（2000）——否则成本结论被夸大。
    assert client.calls[0]["body"]["max_tokens"] == 256


async def test_probe_sha256_is_stable_across_identical_runs(env) -> None:
    """同一结果 ⇒ 同一探测哈希；否则哈希没有判别力（只是随机盐）。"""
    first = await _service(env, FakeClient(_ok_response())).probe(
        "proj_1", "prov_1", PROBE_JPEG)
    second = await _service(env, FakeClient(_ok_response())).probe(
        "proj_1", "prov_1", PROBE_JPEG)
    assert first["vision_capability_probe_sha256"] == second["vision_capability_probe_sha256"]


# ── 2. 探测失败 ⇒ unsupported + **具体**失败码 ──


async def test_probe_rejection_persists_unsupported_with_specific_code(env) -> None:
    db, _, _, _, asset_row = env
    client = FakeClient(FakeResponse(400))
    result = await _service(env, client).probe("proj_1", "prov_1", PROBE_JPEG)

    assert result["vision_capability_status"] == "unsupported"
    assert result["vision_capability_failure_code"] == VISION_PROBE_UNSUPPORTED
    assert result["vision_response_adapter_id"] is None
    assert result["vision_probe_protocol_version"] is None

    stored = _columns(db)
    assert stored["vision_capability_status"] == "unsupported"
    assert stored["vision_capability_failure_code"] == VISION_PROBE_UNSUPPORTED
    assert stored["vision_capability_tested_at"]  # 失败也要记时间
    assert stored["vision_capability_probe_sha256"]  # 失败也要记哈希


async def test_probe_distinguishes_rejection_from_transport_failure(env) -> None:
    """「网关拒绝能力」与「网关今天挂了」必须落**不同**的码。

    压成一个码会让前者（应永久 fail-closed）与后者（应重试）无法区分。
    """
    db, _, _, _, asset_row = env
    rejected = await _service(env, FakeClient(FakeResponse(400))).probe(
        "proj_1", "prov_1", PROBE_JPEG)
    unavailable = await _service(env, FakeClient(FakeResponse(503))).probe(
        "proj_1", "prov_1", PROBE_JPEG)
    assert rejected["vision_capability_failure_code"] == VISION_PROBE_UNSUPPORTED
    assert unavailable["vision_capability_failure_code"] == "PROVIDER_UNAVAILABLE"
    assert (rejected["vision_capability_failure_code"]
            != unavailable["vision_capability_failure_code"])


async def test_probe_http_200_with_bad_schema_is_unsupported(env) -> None:
    """HTTP 200 但内容不合受控结构 ⇒ 仍判 unsupported（不许假绿）。"""
    db, _, _, _, asset_row = env
    broken = FakeResponse(200, {"choices": [{"finish_reason": "stop",
                                             "message": {"content": "not json"}}]})
    result = await _service(env, FakeClient(broken)).probe(
        "proj_1", "prov_1", PROBE_JPEG)
    assert result["vision_capability_status"] == "unsupported"
    assert result["vision_capability_failure_code"] == VISION_PROBE_SCHEMA_MISMATCH


# ── 3. 此后 create 被拒，且**零字节外传** ──


async def test_create_rejected_after_probe_failure_and_zero_bytes_egress(env) -> None:
    db, egress, providers, vault, asset_row = env
    client = FakeClient(FakeResponse(400))
    service = _service(env, client)
    await service.probe("proj_1", "prov_1", PROBE_JPEG)
    calls_after_probe = len(client.calls)

    preview = _create_preview(egress)
    consents_before = _count(db, "keyframe_egress_consents")
    with pytest.raises(DomainError) as caught:
        service.create_generation(
            "proj_1", preview["keyframe_egress_preview_id"],
            preview["payload_sha256"], provider_config_id="prov_1",
        )
    assert caught.value.code == "VISION_PROVIDER_UNSUPPORTED"
    # 零字节外传的**机器判据**：create 前后调用计数不变。
    assert len(client.calls) == calls_after_probe

    # 且门禁在 egress.create 之前 ⇒ 这张预览既没有 consent，也没有 generation。
    # （探测自己那条 consent 不在此列——它属于另一次外传，用 delta 而不是绝对数
    #   比较，否则断言会在"探测本身建了 consent"这个正确事实上失败。）
    assert _count(db, "keyframe_egress_consents") == consents_before
    assert _count(
        db,
        "keyframe_generations",
        "egress_preview_id=?",
        (preview["keyframe_egress_preview_id"],),
    ) == 0


async def test_create_allowed_after_probe_success(env) -> None:
    """正向前提：探测通过后 create 必须能用——否则上一条用例可能只是恒红。"""
    db, egress, providers, vault, asset_row = env
    service = _service(env, FakeClient(_ok_response()))
    await service.probe("proj_1", "prov_1", PROBE_JPEG)

    preview = _create_preview(egress)
    before = _count(db, "keyframe_egress_consents")
    created = service.create_generation(
        "proj_1", preview["keyframe_egress_preview_id"],
        preview["payload_sha256"], provider_config_id="prov_1",
    )
    assert created["status"] == "queued"
    assert _count(db, "keyframe_egress_consents") == before + 1


def test_create_rejected_when_never_probed(env) -> None:
    """从未探测（默认 untested）⇒ 同样拒绝。防止"没探测就当成能用"。"""
    db, egress, providers, vault, asset_row = env
    service = _service(env, FakeClient(_ok_response()))
    preview = _create_preview(egress)
    with pytest.raises(DomainError) as caught:
        service.create_generation(
            "proj_1", preview["keyframe_egress_preview_id"],
            preview["payload_sha256"], provider_config_id="prov_1",
        )
    assert caught.value.code == "VISION_PROVIDER_UNSUPPORTED"


# ── 4. 不经 claim 就发探测请求必须失败 ──


def test_call_provider_without_claim_raises_and_sends_nothing(env) -> None:
    """无 claim ⇒ DomainError，且**一次网络调用都没发**。"""
    db, egress, providers, vault, asset_row = env
    client = FakeClient(_ok_response())
    service = _service(env, client)
    frame = probe_frame(PROBE_JPEG)
    with pytest.raises(DomainError) as caught:
        service._call_provider(  # noqa: SLF001 直接测内部边界
            {"provider_config_id": "prov_1", "base_url": "https://provider.test/v1",
             "model": "vision-model"},
            "secret-token", frame, None,
        )
    assert caught.value.code == "KEYFRAME_EGRESS_CONSENT_REQUIRED"
    assert client.calls == []


def test_forged_claim_dict_is_rejected_and_sends_nothing(env) -> None:
    """**伪造的 claim 返回值**不得放行——判据必须回库，不能只信这个 dict。

    这条是负向对照逼出来的：把 _claim 换成"返回一个带 generation_id 的 dict"
    后，仅检查 dict 形状时探测**照样发了请求**（实测 calls=1）。也就是说
    那道守卫看起来在、实际可绕过。此处用同一个伪造对象直接打这个边界。
    """
    db, egress, providers, vault, _ = env
    client = FakeClient(_ok_response())
    service = _service(env, client)
    # 造一条真实的 generation，但**不消费**它的 consent。
    # 这里用 allow_unprobed=True 是因为本用例要造的是"未消费的 consent"这一
    # 前置状态，不是在测能力门禁（门禁另有专门用例）；Provider 此时未探测。
    preview = _create_preview(egress)
    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"],
        allow_unprobed=True)
    forged = {"generation_id": created["keyframe_generation_id"]}
    with pytest.raises(DomainError) as caught:
        service._call_provider(  # noqa: SLF001 直接打这道边界
            {"provider_config_id": "prov_1", "base_url": "https://provider.test/v1",
             "model": "vision-model"},
            "secret-token", probe_frame(PROBE_JPEG), forged,
        )
    assert caught.value.code == "KEYFRAME_EGRESS_CONSENT_REQUIRED"
    assert client.calls == []  # 零字节外传


def test_claim_guard_reads_consumed_at_from_db(env) -> None:
    """真正的 claim 消费后，同一道守卫必须放行（否则上一条可能只是恒红）。"""
    db, egress, providers, vault, _ = env
    client = FakeClient(_ok_response())
    service = _service(env, client)
    preview = _create_preview(egress)
    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"],
        allow_unprobed=True)  # 同上一用例：造前置状态，不测能力门禁
    claim = egress.claim_for_runner("proj_1", created["keyframe_generation_id"])
    outcome = service._call_provider(  # noqa: SLF001
        {"provider_config_id": "prov_1", "base_url": "https://provider.test/v1",
         "model": "vision-model"},
        "secret-token", probe_frame(PROBE_JPEG), claim,
    )
    assert outcome["failure_code"] is None
    assert len(client.calls) == 1


async def test_probe_consumes_consent_exactly_once(env) -> None:
    """探测确实**消费**了 consent（claim 真的跑了），而不是摆样子。"""
    db, _, _, _, asset_row = env
    await _service(env, FakeClient(_ok_response())).probe(
        "proj_1", "prov_1", PROBE_JPEG)
    with db.connection() as conn:
        rows = conn.execute(
            "SELECT consumed_at FROM keyframe_egress_consents").fetchall()
    assert len(rows) == 1
    assert rows[0]["consumed_at"] is not None


# ── 六列名与 v41 迁移的对应 ──


def test_six_columns_named_exactly_as_the_planning_gate() -> None:
    """六列名是**门里冻结的原文**，不是本实现自创。

    规划门 §2.1 第 3 条逐字列了六列；本断言把它们钉在代码里，改名会让
    文档与代码对不上（而文档才是冻结源）。
    """
    assert CAPABILITY_COLUMNS == (
        "vision_capability_status",
        "vision_response_adapter_id",
        "vision_probe_protocol_version",
        "vision_capability_tested_at",
        "vision_capability_failure_code",
        "vision_capability_probe_sha256",
    )


def test_v41_creates_all_six_columns(env) -> None:
    """迁移真的把六列建出来了（列名 + NOT NULL 默认值）。

    只断言"迁移跑过"没有区分力；这里断言**列集合**，改名或漏列即红。
    """
    db, _, _, _, _ = env
    with db.connection() as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(provider_configs)")}
    assert set(CAPABILITY_COLUMNS) <= columns
    stored = _columns(db)
    assert stored["vision_capability_status"] == "untested"
    assert stored["vision_capability_tested_at"] is None


def test_v41_trigger_rejects_inconsistent_supported_row(env) -> None:
    """裸 UPDATE 写 supported 但缺 adapter ⇒ 被 v41 触发器拒绝。

    这条钉的是「六列必须同时自洽」：没有它，服务可以写出一行
    status=supported 却没有适配器的记录，而放行门禁会因此拿不到可选档位。
    """
    import sqlite3

    db, _, _, _, _ = env
    with pytest.raises(sqlite3.IntegrityError):
        with db.connection() as conn:
            conn.execute(
                "UPDATE provider_configs SET vision_capability_status='supported',"
                "vision_capability_tested_at='2026-10-21T00:00:00Z',"
                "vision_response_adapter_id=NULL,vision_probe_protocol_version='1',"
                "vision_capability_failure_code=NULL,"
                "vision_capability_probe_sha256='abc' WHERE id='prov_1'"
            )


def test_probe_frame_thumbnail_differs_from_payload() -> None:
    """探测帧的缩略图与载荷必须不同（A12 判据在探测路径上也要成立）。"""
    frame = probe_frame(PROBE_JPEG)
    assert frame.payload_bytes == PROBE_JPEG
    assert frame.thumbnail_bytes != frame.payload_bytes
    assert frame.payload_sha256 == hashlib.sha256(PROBE_JPEG).hexdigest()


async def test_probe_does_not_require_any_asset(env) -> None:
    """探测不依赖任何素材存在——否则"还没导入视频"就无法验证网关能力。

    这条同时钉住一个易碎前提：prepare 的 asset_id 必须允许 NULL（v40 DDL）。
    若将来有人给该列加 NOT NULL，本用例会立刻红。
    """
    db, _, _, _, _ = env
    with db.connection() as conn:
        conn.execute("DELETE FROM assets WHERE id='asset_1'")
    client = FakeClient(_ok_response())
    service = VisionProbeService(
        db, env[1], env[2], env[3], client_factory=lambda **kw: client,
    )
    result = await service.probe("proj_1", "prov_1", PROBE_JPEG)
    assert result["vision_capability_status"] == "supported"
    with db.connection() as conn:
        row = conn.execute(
            "SELECT asset_id, source_fingerprint FROM keyframe_egress_previews"
        ).fetchone()
    assert row["asset_id"] is None
    assert row["source_fingerprint"] == "vision_probe"


def test_probe_plan_is_single_frame_and_interval_only() -> None:
    """探测计划只有一个点，且如实标 interval_only（没做切点分析）。"""
    plan = probe_plan()
    assert plan.frame_count == 1
    assert plan.sampling_mode == "interval_only"
    assert plan.had_cv_analysis is False

# ── 5. create 的 fail-closed 门禁（A4 的实质，下沉到 egress.create） ──


def test_egress_create_rejects_untested_provider_and_writes_nothing(env) -> None:
    """untested ⇒ egress.create 直接拒绝，且**零网络、零 consent 行**。

    「零字节外传」在这里的机器判据有三条：网络调用计数不变、consent 行数不变、
    generation 行数不变。少任何一条，拒绝都可能发生在「已经签了同意书」之后。
    """
    db, egress, providers, vault, asset_row = env
    client = FakeClient(_ok_response())
    preview = _create_preview(egress)
    consents_before = _count(db, "keyframe_egress_consents")
    generations_before = _count(db, "keyframe_generations")
    with pytest.raises(DomainError) as caught:
        egress.create(
            "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"])
    assert caught.value.code == "VISION_PROVIDER_UNSUPPORTED"
    # 错误消息必须给可操作出路（P67/P102 的教训：原因错、无出路）。
    assert "vision 能力探测" in caught.value.message
    assert client.calls == []
    assert _count(db, "keyframe_egress_consents") == consents_before
    assert _count(db, "keyframe_generations") == generations_before


def test_egress_create_rejects_unsupported_provider(env) -> None:
    """unsupported（探测过但失败）⇒ 同样拒绝。"""
    db, egress, providers, vault, asset_row = env
    with db.connection() as conn:
        conn.execute(
            "UPDATE provider_configs SET vision_capability_status='unsupported',"
            "vision_capability_tested_at=?,vision_response_adapter_id=NULL,"
            "vision_probe_protocol_version=NULL,"
            "vision_capability_failure_code='VISION_PROBE_UNSUPPORTED',"
            "vision_capability_probe_sha256='sha256:" + "1" * 64 + "' "
            "WHERE id='prov_1'", (utc_now(),),
        )
    preview = _create_preview(egress)
    consents_before = _count(db, "keyframe_egress_consents")
    with pytest.raises(DomainError) as caught:
        egress.create(
            "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"])
    assert caught.value.code == "VISION_PROVIDER_UNSUPPORTED"
    assert _count(db, "keyframe_egress_consents") == consents_before


def test_egress_create_allows_supported_provider(env) -> None:
    """supported ⇒ 放行。正向前提：否则上面两条可能只是恒红。"""
    db, egress, providers, vault, asset_row = env
    with db.connection() as conn:
        conn.execute(
            "UPDATE provider_configs SET vision_capability_status='supported',"
            "vision_capability_tested_at=?,"
            "vision_response_adapter_id='openai_chat_completions_image_url_v1',"
            "vision_probe_protocol_version='1',"
            "vision_capability_failure_code=NULL,"
            "vision_capability_probe_sha256='sha256:" + "2" * 64 + "' "
            "WHERE id='prov_1'", (utc_now(),),
        )
    preview = _create_preview(egress)
    created = egress.create(
        "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"])
    assert created["status"] == "queued"

def test_egress_create_rejects_supported_row_with_bad_adapter(env) -> None:
    """status=supported 但适配器不可用 ⇒ 仍拒绝（不能只看 status 一列）。

    说明：v41 触发器已从写入侧禁止这种行存在，所以这里必须**绕过触发器**
    先把行写坏（DROP TRIGGER），否则用例根本造不出前置状态——这也反过来
    证明触发器与门禁是两道独立的防线，而不是同一道的两种写法。
    """
    db, egress, providers, vault, asset_row = env
    with db.connection() as conn:
        conn.execute("DROP TRIGGER provider_vision_capability_valid_update")
        conn.execute(
            "UPDATE provider_configs SET vision_capability_status='supported',"
            "vision_capability_tested_at=?,"
            "vision_response_adapter_id='some_other_adapter',"
            "vision_probe_protocol_version='1',"
            "vision_capability_failure_code=NULL,"
            "vision_capability_probe_sha256='sha256:" + "3" * 64 + "' "
            "WHERE id='prov_1'", (utc_now(),),
        )
    preview = _create_preview(egress)
    with pytest.raises(DomainError) as caught:
        egress.create(
            "proj_1", preview["keyframe_egress_preview_id"], preview["payload_sha256"])
    assert caught.value.code == "VISION_PROVIDER_UNSUPPORTED"


def test_create_route_does_not_accept_allow_unprobed() -> None:
    """**探测自举不可外部触发**：HTTP 路由的请求体模型里没有这个字段。

    这是 allow_unprobed 之所以是「自举」而非「通用旁路」的机器判据：
      - 请求模型 extra=forbid ⇒ 客户端带该字段会被 422 拒绝；
      - 路由源码里没有以 allow_unprobed 传参的调用点。
    """
    import inspect

    from aivs_core import app as app_module

    model = app_module.KeyframeCreateRequest
    assert set(model.model_fields) == {"payload_sha256"}, (
        "KeyframeCreateRequest 多出了字段：allow_unprobed 若在此出现即为外部旁路"
    )
    assert model.model_config.get("extra") == "forbid"

    source = inspect.getsource(app_module.create_app)
    route_body = source.split("post_keyframe_create", 1)[1].split("@app.", 1)[0]
    assert "allow_unprobed" not in route_body, (
        "既有 create 路由不得传 allow_unprobed——那会把自举变成外部旁路"
    )


def test_only_probe_path_passes_allow_unprobed() -> None:
    """allow_unprobed=True 在**生产代码**里只出现一次，且就在 probe 里。

    用 AST 遍历而非字符串搜索：注释/文档里的同名文字不会造成假绿或假红。
    """
    import ast
    from pathlib import Path

    src = Path(__file__).resolve().parents[2] / "src"
    sites: list[str] = []
    for path in src.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            for keyword in node.keywords:
                if keyword.arg == "allow_unprobed" and isinstance(
                    keyword.value, ast.Constant) and keyword.value.value is True:
                    sites.append(f"{path.name}:{node.lineno}")
    assert len(sites) == 1, f"allow_unprobed=True 的调用点应唯一，实际：{sites}"
    assert sites[0].startswith("vision_probe.py"), sites

async def test_repo_get_exposes_vision_six_columns_after_probe(env) -> None:
    """探测后 ProviderRepository.get() 必须能读到六列（API 可见面）。

    这条钉的是「探测结果只有测试看得见、界面看不见」这种失败形态：
    _dto 不投影六列时，Desktop 永远显示不出适配器与失败码。
    """
    db, egress, providers, vault, asset_row = env
    client = FakeClient(_ok_response())
    service = _service(env, client)
    probed = await service.probe("proj_1", "prov_1", PROBE_JPEG)

    dto = providers.get("prov_1")
    for name in CAPABILITY_COLUMNS:
        assert name in dto
        assert dto[name] == probed[name]


def test_repo_create_does_not_accept_vision_columns(env) -> None:
    """create() 的字段白名单**不得**接受 vision 六列（否则是旁路）。

    与上一条互补：_dto 让它可见，白名单挡住它可写。二者缺一，
    「探测结果只能由探测写入」这条就不成立。
    """
    db, egress, providers, vault, asset_row = env
    with pytest.raises(DomainError) as caught:
        providers.create({
            "kind": "openai_compatible_text",
            "display_name": "x",
            "base_url": "https://provider.test/v1",
            "model": "m",
            "vision_capability_status": "supported",
        })
    assert caught.value.code == "PROVIDER_INVALID_CONFIG"
