"""W3.3 Layer 2：vision 能力探测（S3，**唯一一处会发网络的探测**）。

规划门 §4 A4 / Design Gate §3.2 I-1 + §5.1 / 评审 #4。

**I-1 的落点**：探测本身也是网络调用，所以它必须与正式打标走同一条放行链
`prepare → create → claim_for_runner`，不得绕过 claim 直接发请求。本模块
因此**只调用 `KeyframeEgressService` 的既有方法，绝不自己发第一个字节**
（不改 keyframe_egress.py，也不用它没有的接口）。

---

## 三段式是怎么接上的（一条调用链）

```
VisionProbeService.probe(project_id, asset_row, provider, jpeg)
  └─ egress.prepare(project_id, asset_row, provider, [probe_frame], probe_plan)  # 零网络
  └─ egress.create(project_id, preview_id, payload_sha256, jobs)                 # 零网络
  └─ self._claim(project_id, generation_id)                                       # 唯一放行点
       └─ egress.claim_for_runner(project_id, generation_id)                      # 消费 consent
  └─ self._call_provider(...)                                                     # ← 网络在这里
```

**为什么探测帧走 prepare 而不是"小载荷特例"**：`prepare` 接受任意
`list[EncodedFrame]` + `SamplingPlan`，探测只需要 1 帧，传长度 1 的帧列表
即可——**既有接口无需任何扩展**。这是「不改 keyframe_egress.py」仍然能做
三段式的关键事实（已实跑验证）。

---

## fail-closed（A4 的后半）

门禁**本体在 `KeyframeEgressService.create`**（收口后下沉）：状态非 `supported`、
缺 `tested_at`、适配器不可用、或 Provider 停用 ⇒ 抛 `VISION_PROVIDER_UNSUPPORTED`，
**在任何 consent/generation 行写入之前**，所以「零字节外传」里连同意书都不签。
判据直读 provider_configs 的六列（不经 Provider DTO）。

**探测自举**：`create(..., allow_unprobed=True)` 供本模块 `probe()` 使用——
探测启动时 Provider 仍是 untested，不放开则永远无法开始。它是 keyword-only
且**只有这一处调用点**；HTTP 路由不传该参数（有测试锁住不可外部触发）。

`create_generation()` 保留为薄封装：额外校验凭据状态，门禁本身已由 egress 提供。

---

## 为什么能力判据直接读库而不是用 ProviderRepository.get()

`planning.ProviderRepository._dto` 只投影 captions/candidate 的十二列，
**不含 vision 六列**（`planning.py:299-324`），而 `planning.py` 不在本切片的
可改范围。若能力判据依赖该 DTO，`vision_capability_status` 会恒为 `None`、
门禁恒拒——那是"看起来有守卫、实际恒假"的另一种恒真，比没有守卫更糟。
故此处直接读 `provider_configs` 的六列。
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from .database import Database, utc_now
from .media.keyframe_encode import EncodedFrame
from .media.keyframe_sampling import MODE_INTERVAL_ONLY, SamplingPlan
from .media.vision_adapter import (
    VISION_ADAPTER_IDS,
    VISION_PROBE_PROTOCOL_VERSION,
    VisionRequest,
    build_body,
    parse_tag_response,
    vision_adapter_supported,
)
from .projects import DomainError

# 探测用固定 JPEG：64x64 彩条，**1025 字节**，由生产编码路径生成，
# `jpeg_dimensions()` 与 PIL 双解（`test_probe_jpeg_is_a_decodable_image` 锁住）。
#
# 为什么用**常量**而不是从素材里解一帧：
#   1. 探测要回答的是「网关收不收图片内容块 + strict json_schema」，与画面内容
#      无关；解一帧要起 ffmpeg、要素材可用，把一次能力探测绑死在媒体链上。
#   2. 常量让 vision_capability_probe_sha256 在不同机器/不同素材间**可比**：
#      若每次探测的字节不同，哈希就只能证明「跑过」，不能证明「同一判据」。
#
# 生成方式（可复现，不是手抄）：
#   ffmpeg -f lavfi -i smptebars=size=96x96:duration=1:rate=1 \\
#          -c:v libopenh264 -pix_fmt yuv420p bars.mp4
#   ffmpeg $(jpeg_args('bars.mp4', 0, long_edge=64)) > probe.jpg
#   即走 `media/keyframe_encode` 的同一条 mjpeg 编码 argv，只把长边缩到 64；
#   源视频 96x96 ⇒ `_scale_filter(64)` 出 64x64，字节完全确定，sha256 稳定。
#
# 旧常量（278 字节）缺 SOF 段：`jpeg_dimensions` 抛 KeyframeEncodeError、
# PIL 抛 UnidentifiedImageError，网关回 400 unsupported_content。它的后果不是
# 「探测失败」而是「**错误归因**」——图上坏掉被记成「模型不支持视觉」，用户会
# 据此换 Provider。所以合法性本身必须有用例守着，不能靠常量看起来对。
#
# ⚠️ 如实：常量只证明网关接受请求形状，**不证明模型看得见图**——后者属 A10
#    （真实打标端到端），不在本探测的判据内。
PROBE_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010200000100010000fffe00104c61766336322e31312e3130"
    "3000ffdb0043000806060706070808080808080909090a0a0a090909090a0a0a0a0a0a0c"
    "0c0c0a0a0a0a0a0a0a0c0c0c0c0d0e0d0d0d0c0d0e0e0f0f0f1212111115151519191fff"
    "c400a6000101010101010101000000000000000005060708020401030100030101010100"
    "000000000000000000060504070301021000000304060705030d01000000000000000201"
    "050304c13371821211210613423481321422073141d35143b1c484917494e26165462317"
    "54155211000003040508080505010000000000000104020003110506211213147434c307"
    "36b332457181b22382c1337384433135c262b161425153ffc00011080040004003012200"
    "021100031100ffda000c03010002110311003f00bf07bea43d61007bea43d605e9be6457"
    "281dda9bb16e21e8f3609a7bc582cc111bb1c641769ef160b30446ec7190763b1457242b"
    "bd436613bfbe9fca5eb12d1a0b659815fd11ea0d34682d966057f447a83aa17b2e67dc39"
    "ba06d93555b3a19798d131a2705189c0cb565ccfa0ae99add6172ef88d1375483df521eb"
    "0803df521eb19c537cc8ae503bb530e96e21e8f3609a7bc582cc111bb1c641769ef160b3"
    "0446ec7190763b1457242bbd436613bfbe9fca5eb12d1a0b659815fd11ea0d34682d9660"
    "57f447a83aa15b2e67dc39ba06d93555b3a19798d131a2705189c0cb565ccfa0ae99add6"
    "172ef88d1375483df521eb18ff00f2be937e5ff655f547c0f7bd7d265787ca0173f28537"
    "a80629bd0d9ae08ae6d9c0fce1ff009abf430c1630eed0fd7e9fe7f2da934f78b0598223"
    "7638c84cb334bdacd687ea620ae3597cc4ec3952a5d2e18657973cc1da45a56d283e9f57"
    "d3f6f598de74abcb770dafc456b929b4d12705c6eada0b1748c175452f131ae0c3935a03"
    "3b7efcccdd183c2be782f9117e37b61e0c13145dd4311ac22d42d1a0b659815fd11ea1f2"
    "e8c3722f485a1d1c6eab55a978f7f689ab35e25dc3b4aa6cb3144db66c341b2e3a21d29f"
    "58ea1ce725e3a2a5e2a658a6098a0b28c2465f217e55f7a8a59910b35a7bc760015d5d75"
    "311512a572da1e4ddca66588c528d0bd0c3babd7761f8a1288ac548ae2918842a6951383"
    "f51b716aa945e3ff001f786dc9dd4e8baa2671fe1fdb2fa43ad0c983890e33176fbeb8b1"
    "749b7e9de5a8d698710419dd2d9a969ce130b79dcdf5bbc4d8e3b1085631e116ca701b3f"
    "70688bfefe288bb8797d68632367ee0ff507cc3e543ecf66ebeaed030490ce5df8bb22db"
    "318a975724f05f21c4865ed2d6bf11db86e55a947111b98d5afc47b22f9fe0fc98949ff7"
    "eaf363da7eeed481f8afb5420d3f756a40e11cd73c7be1ec037133eb2babf66f64e53543"
    "cde5f6afd23dbbe53d43f9889b937fffd9"
)

# 探测没有素材归属：prepare 的 asset_id 允许 NULL（v40 DDL），故传一个
# 只有指纹的占位行。指纹取值固定为 vision_probe，使预览行的来源可读且
# 不与任何真实素材指纹撞车（真实指纹是内容散列，不会是这个词）。
PROBE_ASSET_ROW: dict[str, Any] = {"id": None, "fingerprint": "vision_probe"}

# 探测载荷的固定指令。**必须与打标指令不同**：探测要回答"网关收不收图片内容块
# + strict json_schema"，不是"你标得准不准"。用打标指令会让一次探测顺带烧掉
# 一次完整推理预算。
PROBE_INSTRUCTION = (
    "This is a capability probe, not a tagging task. "
    'Return JSON with exactly two keys: "labels" (an empty array) and '
    '"notes" (the single word: probe).'
)

# 探测预算不设 2000：探测不要求语义质量，只要网关接受请求形状。若按打标预算
# 走，每次探测成本与一次真实打标相同，成本结论会被夸大。
PROBE_MAX_TOKENS = 256

# 探测失败码。刻意**不用** `VISION_PROVIDER_UNSUPPORTED`：那是"已被判定不支持"
# 的领域错误（create 的拒绝码），而探测结果要落库到 `failure_code` 列，需要
# 能区分"网关拒绝能力"与"网络/凭据/限流"，否则重演 2026-10-03 的 captions
# 误诊（"网络不可达"与"网关拒绝"在库里长得一样）。
VISION_PROBE_UNSUPPORTED = "VISION_PROBE_UNSUPPORTED"
VISION_PROBE_SCHEMA_MISMATCH = "VISION_PROBE_SCHEMA_MISMATCH"

# 六列列名——逐字取自规划门 §2.1 第 3 条（不是本模块自创）。
CAPABILITY_COLUMNS: tuple[str, ...] = (
    "vision_capability_status",
    "vision_response_adapter_id",
    "vision_probe_protocol_version",
    "vision_capability_tested_at",
    "vision_capability_failure_code",
    "vision_capability_probe_sha256",
)


def probe_frame(jpeg: bytes) -> EncodedFrame:
    """把给定 JPEG 包成一帧 EncodedFrame（探测用，长度恒为 1）。

    缩略图与载荷**必须不同**（A12 的判据在探测路径上同样成立）：这里用同一
    JPEG 的 1/4 截断当占位缩略图。它必然与载荷不等——注意这**不是**真缩略图，
    探测路径不呈现给用户，因此不冒充生产缩略图语义。
    """
    if not jpeg:
        raise DomainError("VISION_FRAMES_UNMAPPED", "探测帧为空")
    thumb = jpeg[: max(1, len(jpeg) // 4)]
    return EncodedFrame(
        timestamp_us=0,
        source_reason="probe",
        payload_bytes=jpeg,
        payload_sha256=hashlib.sha256(jpeg).hexdigest(),
        payload_width=0,
        payload_height=0,
        thumbnail_bytes=thumb,
        thumbnail_sha256=hashlib.sha256(thumb).hexdigest(),
        thumbnail_width=0,
        thumbnail_height=0,
    )


def probe_plan() -> SamplingPlan:
    """1 帧计划。`had_cv_analysis=False` ⇒ `interval_only`（如实上报降级）。"""
    return SamplingPlan(
        frames=((0, "probe"),),
        sampling_mode=MODE_INTERVAL_ONLY,
        covered_scene_cuts=0,
        scene_cut_count=0,
        had_cv_analysis=False,
    )


def _failure_code_for(status_code: int) -> str:
    """HTTP 状态 → 具体失败码。

    四类必须分开（A4 要求「具体失败码」）：
      400/404/415/422 ⇒ 网关不接受该请求形状（含"不支持图片内容块"）
      401/403         ⇒ 凭据
      429             ⇒ 限流（可重试）
      >=500           ⇒ 网关不可用（可重试）
    压成一个码会让"网关不支持 vision"与"网关今天挂了"无法区分，而前者应
    **永久** fail-closed、后者应重试。
    """
    if status_code in {400, 404, 415, 422}:
        return VISION_PROBE_UNSUPPORTED
    if status_code in {401, 403}:
        return "PROVIDER_AUTH_FAILED"
    if status_code == 429:
        return "PROVIDER_RATE_LIMITED"
    if status_code >= 500:
        return "PROVIDER_UNAVAILABLE"
    return VISION_PROBE_SCHEMA_MISMATCH


class VisionProbeService:
    def __init__(
        self,
        db: Database,
        egress: Any,
        providers: Any,
        vault: Any,
        *,
        client_factory: Any = None,
    ) -> None:
        self.db = db
        self.egress = egress
        self.providers = providers
        self.vault = vault
        self._client_factory = client_factory

    # ── 六列读取与门禁 ──

    def capability(self, provider_config_id: str) -> dict[str, Any]:
        """读六列（直接读库，理由见模块头）。行不存在 ⇒ PROVIDER_NOT_FOUND。"""
        with self.db.connection() as db:
            row = db.execute(
                "SELECT enabled,vision_capability_status,vision_capability_tested_at,"
                "vision_response_adapter_id,vision_probe_protocol_version,"
                "vision_capability_failure_code,vision_capability_probe_sha256 "
                "FROM provider_configs WHERE id=?",
                (provider_config_id,),
            ).fetchone()
        if row is None:
            raise DomainError("PROVIDER_NOT_FOUND", "Provider 不存在")
        return {
            "provider_config_id": provider_config_id,
            "enabled": bool(row["enabled"]),
            "credential_status": self.vault.status(provider_config_id),
            **{name: row[name] for name in CAPABILITY_COLUMNS},
        }

    def require_capable(self, provider_config_id: str) -> dict[str, Any]:
        """状态非 supported 一律拒绝。判据全部来自库里的六列，不来自入参。

        四条都查而不是只查 status：`status='supported'` 但缺 tested_at 或适配器
        不可用时，放行方拿不到可选档位（下一步就会用未探测的适配器发请求），
        所以它们与 status 同等必要。v41 的触发器已从写入侧禁止这种行存在，
        这里再查一次是纵深防御。
        """
        provider = self.capability(provider_config_id)
        if (
            not provider["enabled"]
            or provider["credential_status"] != "configured"
            or provider["vision_capability_status"] != "supported"
            or not provider["vision_capability_tested_at"]
            or not vision_adapter_supported(provider["vision_response_adapter_id"])
        ):
            raise DomainError("VISION_PROVIDER_UNSUPPORTED", "Provider 未通过 vision 能力探测")
        return provider

    def create_generation(
        self, project_id: str, preview_id: str, payload_sha256: str, *,
        provider_config_id: str, jobs: Any = None,
    ) -> dict[str, Any]:
        """vision 外传的 create 入口（薄封装，**门禁已下沉到 egress.create**）。

        门禁本体现在在 `KeyframeEgressService.create`（fail-closed），因为
        既有路由直调 egress.create，只在服务层设防会留下旁路。本方法保留是
        为了同时校验凭据状态（credential_status），并在 egress 之前给出
        与探测一致的领域错误。
        """
        self.require_capable(provider_config_id)
        return self.egress.create(project_id, preview_id, payload_sha256, jobs)

    # ── 三段式探测 ──

    async def probe(
        self,
        project_id: str,
        provider_config_id: str,
        jpeg: bytes = PROBE_JPEG,
        *,
        jobs: Any = None,
    ) -> dict[str, Any]:
        """走完 prepare → create → claim 后才发那一次探测请求，然后落六列。

        **没有 asset 参数**：探测载荷是常量（见 PROBE_JPEG），与任何素材无关。
        prepare 的 asset_id 允许 NULL（v40 DDL），实测通过——所以探测不需要
        素材存在，也就不会因为"用户还没导入视频"而无法验证网关能力。
        """
        status, adapter, protocol = "unsupported", None, None
        failure = VISION_PROBE_UNSUPPORTED
        now = utc_now()
        failures: list[dict[str, str]] = []
        preview_id: str | None = None
        try:
            provider = self.providers.get(provider_config_id)
            if not provider.get("enabled"):
                raise DomainError("PROVIDER_DISABLED", "Provider 未启用")
            secret = self.vault.for_request(provider_config_id)
            frame = probe_frame(jpeg)
            preview = self.egress.prepare(
                project_id, PROBE_ASSET_ROW, provider, [frame], probe_plan()
            )
            preview_id = preview["keyframe_egress_preview_id"]
            # allow_unprobed=True 是**探测自举**：此刻 Provider 还是 untested，
            # 不放开就永远无法开始探测。该参数只在这里出现。
            created = self.egress.create(
                project_id, preview_id, preview["payload_sha256"], jobs,
                allow_unprobed=True,
            )
            claim = self._claim(project_id, created["keyframe_generation_id"])
            outcome = self._call_provider(provider, secret, frame, claim)
            failure = outcome["failure_code"]
            if failure is None:
                adapter = VISION_ADAPTER_IDS[0]
                protocol = VISION_PROBE_PROTOCOL_VERSION
                status, failure = "supported", None
            else:
                failures.append(
                    {"adapter_id": VISION_ADAPTER_IDS[0], "safe_error_code": failure}
                )
        except DomainError as exc:
            failure = exc.code
        except Exception as exc:  # noqa: BLE001 探测失败必须落库，不得穿透
            failure = getattr(exc, "code", VISION_PROBE_UNSUPPORTED)
        finally:
            if preview_id is not None:
                self._close_generation(preview_id, status)
        digest = hashlib.sha256(
            json.dumps(
                {"protocol": VISION_PROBE_PROTOCOL_VERSION, "results": failures},
                ensure_ascii=False, separators=(",", ":"), sort_keys=True,
            ).encode()
        ).hexdigest()
        with self.db.connection() as db:
            db.execute(
                "UPDATE provider_configs SET vision_capability_status=?,"
                "vision_capability_tested_at=?,vision_response_adapter_id=?,"
                "vision_probe_protocol_version=?,vision_capability_failure_code=?,"
                "vision_capability_probe_sha256=? WHERE id=?",
                (status, now, adapter, protocol, failure, digest, provider_config_id),
            )
        return {
            "vision_capability_status": status,
            "vision_response_adapter_id": adapter,
            "vision_probe_protocol_version": protocol,
            "vision_capability_tested_at": now,
            "vision_capability_failure_code": failure,
            "vision_capability_probe_sha256": digest,
        }

    def _claim(self, project_id: str, generation_id: str) -> dict[str, Any]:
        """唯一放行点（I-1）。**单独成型是为了能被负向对照精确摘掉**。

        若把它内联进 `probe`，负向对照（"去掉 claim ⇒ 红"）就只能 monkeypatch
        掉整个 egress，那样会连带跳过 prepare/create，测不出"claim 前置"本身。
        单独成型后，对照只需把这一处替换成空操作。
        """
        return self.egress.claim_for_runner(project_id, generation_id)

    def _call_provider(
        self, provider: dict[str, Any], secret: str, frame: EncodedFrame,
        claim: dict[str, Any],
    ) -> dict[str, Any]:
        """真正的那一次网络调用。**调用方必须已经 claim**。

        `claim` 参数不是装饰——没有它本方法直接拒绝工作。这是"不经 claim 就
        发探测请求必须失败"的结构落点：把 `_claim` 摘掉后传进来的是 None，
        这里立刻抛 DomainError，所以对照变红的原因可归因。
        """
        if not claim or "generation_id" not in claim:
            raise DomainError(
                "KEYFRAME_EGRESS_CONSENT_REQUIRED", "探测请求缺少 claim，拒绝外传"
            )
        # ★ 判据必须**回库查证**，不能只信 claim 这个返回值。
        # 反例当场抓到过：负向对照把 _claim 换成「返回一个带 generation_id 的
        # 字典」后，仅靠上面那句值检查时**探测照样发了请求**（实测 calls=1）——
        # 即"看起来有守卫、实际可绕过"。改成读库后，伪造的返回值不再有用：
        # consent 的 consumed_at 只有真正的 claim_for_runner 会写。
        self._require_consent_consumed(claim["generation_id"])
        if self._client_factory is None:
            raise DomainError(VISION_PROBE_UNSUPPORTED, "探测 client 未配置")
        request = VisionRequest(
            instruction=PROBE_INSTRUCTION,
            labels=(),
            frame_jpeg=frame.payload_bytes,
            max_tokens=PROBE_MAX_TOKENS,
        )
        body = build_body(request, provider["model"], max_tokens=PROBE_MAX_TOKENS)
        url = provider["base_url"].rstrip("/") + "/chat/completions"
        with self._client_factory(timeout=60.0, trust_env=False) as client:
            response = client.post(
                url, json=body, headers={"Authorization": f"Bearer {secret}"}
            )
        if response.status_code != 200:
            return {"status_code": response.status_code,
                    "failure_code": _failure_code_for(response.status_code)}
        # HTTP 200 不等于「vision 能力可用」：内容不合受控结构时仍然是失败。
        # 把 200 一律当 supported 会让"网关收下了请求但模型不会用图片"假绿。
        try:
            parsed = parse_tag_response(response.json(), ())
        except (ValueError, KeyError, TypeError):
            return {"status_code": 200, "failure_code": VISION_PROBE_SCHEMA_MISMATCH}
        if parsed["exhausted"]:
            return {"status_code": 200, "failure_code": "PROVIDER_TOKEN_BUDGET_EXHAUSTED"}
        return {"status_code": 200, "failure_code": None}

    def _require_consent_consumed(self, generation_id: str) -> None:
        """回库确认 consent 真的被消费了（I-1 的可证判据）。

        **为什么不信任 claim 的返回值**：返回值只是 dict，任何空操作都能伪造
        出形状相同的对象。库里的 consumed_at 不能——它只由
        claim_for_runner 那条条件 UPDATE 写入（rowcount==1 才不抛）。
        这条检查把「claim 前置」从**约定**变成**可观测事实**。
        """
        with self.db.connection() as db:
            row = db.execute(
                "SELECT c.consumed_at FROM keyframe_generations g "
                "JOIN keyframe_egress_consents c ON c.id=g.egress_consent_id "
                "WHERE g.id=?",
                (generation_id,),
            ).fetchone()
        if row is None or row["consumed_at"] is None:
            raise DomainError(
                "KEYFRAME_EGRESS_CONSENT_REQUIRED",
                "探测请求缺少已消费的 consent，拒绝外传",
            )

    def _close_generation(self, preview_id: str, status: str) -> None:
        """把探测用的 generation 收尾，避免留下永远 `running` 的行。"""
        now = utc_now()
        with self.db.connection() as db:
            db.execute(
                "UPDATE keyframe_generations SET status=?,finished_at=? "
                "WHERE egress_preview_id=? AND status='running'",
                ("succeeded" if status == "supported" else "failed", now, preview_id),
            )
